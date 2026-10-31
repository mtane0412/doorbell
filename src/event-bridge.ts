/**
 * イベントと連番を保管する Durable Object（SQLite バックエンド・全体で1個）
 *
 * 連番は永続化し TTL の対象にしない。消えるのはイベント本体だけである。
 * 連番が巻き戻ると Hook が「進んでいない」と判定し、通知が止まるためである。
 */
import { DurableObject } from "cloudflare:workers";
import { generateSecret, hashSecret } from "./auth.ts";
import { verifyCosenseProject } from "./cosense.ts";
import { verifyDiscordChannel } from "./discord.ts";
import { migrateSchema } from "./migration.ts";
import { describePollError } from "./poll-error.ts";

/** トピックごとの保持件数 */
const MAX_EVENTS_PER_TOPIC = 20;
/** 監視対象の暫定の上限。Workers Free の Cron の CPU 時間に収めるため（docs/design.md の「Cron」） */
const MAX_SOURCES = 10;
/** トピック名は URL のパスに使うため、そのまま書ける文字に限る */
const TOPIC_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DISCORD_CHANNEL_ID_PATTERN = /^\d+$/;
const INVALID_TOPIC_NAME = "トピック名は英小文字・数字・ハイフンの64文字以内で入力してください";
const TOPIC_NAME_TAKEN = "このトピック名は使えません。削除済みの名前も再利用できません";
/** イベントの保持期間 */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** producer が渡すイベント。ts と seq は Durable Object が付与する */
export type EventInput = {
	kind: string;
	summary: string;
	ref?: string;
	data?: Record<string, unknown>;
};

export type StoredEvent = EventInput & { seq: number; ts: string };

export type EventsPage = {
	oldest_seq: number;
	latest_seq: number;
	events: StoredEvent[];
};

export type SignalTopic = { id: string; seq: number; updated_at: string | null };

/** 監視対象の種類 */
export type SourceType = "discord" | "cosense";

/** Cron が確認する監視対象。cursor は最後に確認した位置で、未記録なら null */
export type PollSource = {
	id: string;
	type: SourceType;
	target: string;
	excludedUserId: string;
	topic: string;
	cursor: string | null;
	lastError: string | null;
};

/** 追加する監視対象。id と確認位置は Durable Object が管理する */
export type NewPollSource = Pick<PollSource, "type" | "target" | "excludedUserId" | "topic">;

/** 操作の結果。失敗の理由は画面に表示してよい内容だけを持つ */
export type OperationResult = { ok: true } | { ok: false; error: string };

/** 書き込みシークレットを発行する操作の結果。writeSecret はこの戻り値にしか現れない */
export type WriteSecretResult = { ok: true; writeSecret: string } | { ok: false; error: string };

/** 管理ページの一覧の1行。source が null のトピックは外部トピックである */
export type AdminTopic = {
	name: string;
	opaqueId: string;
	seq: number;
	updatedAt: string | null;
	hasWriteSecret: boolean;
	source: {
		id: string;
		type: SourceType;
		target: string;
		excludedUserId: string;
		enabled: boolean;
		lastError: string | null;
	} | null;
};

/** LEFT JOIN のため、監視対象の列は source_id が null の行では null になるが、その場合は読まない */
type AdminTopicRow = {
	name: string;
	opaque_id: string;
	seq: number;
	updated_at_ms: number | null;
	has_write_secret: number;
	source_id: string | null;
	type: SourceType;
	target: string;
	excluded_user_id: string;
	enabled: number;
	last_error: string | null;
};

type PollSourceRow = {
	id: string;
	type: SourceType;
	target: string;
	excluded_user_id: string;
	topic: string;
	cursor: string | null;
	last_error: string | null;
};

type EventRow = {
	seq: number;
	created_at_ms: number;
	kind: string;
	summary: string;
	ref: string | null;
	data: string | null;
};

export class EventBridge extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => migrateSchema(ctx.storage, env));
	}

	/**
	 * 外部からの書き込みの認証に必要なトピックの設定を返す
	 *
	 * @returns 未登録または論理削除済みなら null。writeSecretHash が null なら外部から書き込めない
	 */
	async getTopicWriteConfig(topic: string): Promise<{ writeSecretHash: string | null } | null> {
		const row = this.ctx.storage.sql
			.exec<{ write_secret_hash: string | null }>(
				"SELECT write_secret_hash FROM topics WHERE name = ? AND deleted_at_ms IS NULL",
				topic,
			)
			.toArray()[0];
		return row ? { writeSecretHash: row.write_secret_hash } : null;
	}

	/**
	 * 有効な監視対象を、確認位置とともに1回の RPC で返す
	 *
	 * Cron の RPC の回数を監視対象の数に比例させないためである。
	 */
	async getPollSources(): Promise<PollSource[]> {
		return this.ctx.storage.sql
			.exec<PollSourceRow>(
				`SELECT s.id, s.type, s.target, s.excluded_user_id, s.topic, s.last_error, p.cursor
				 FROM sources s LEFT JOIN producer_state p ON p.producer = s.id
				 WHERE s.enabled = 1
				 ORDER BY s.rowid`,
			)
			.toArray()
			.map((row) => ({
				id: row.id,
				type: row.type,
				target: row.target,
				excludedUserId: row.excluded_user_id,
				topic: row.topic,
				cursor: row.cursor,
				lastError: row.last_error,
			}));
	}

	/**
	 * 監視対象とそのトピックを追加する
	 *
	 * 入力の誤りと権限不足を追加時に検出するため API を1回呼び、成功した場合だけ保存する。
	 * API の応答を待つ間に他の追加が割り込めるため、保存の直前に条件を確認し直す。
	 */
	async addSource(source: NewPollSource): Promise<OperationResult> {
		const rejection = this.findAddSourceRejection(source);
		if (rejection !== null) {
			return { ok: false, error: rejection };
		}
		try {
			await this.verifySource(source);
		} catch (error) {
			return { ok: false, error: describePollError(error) };
		}
		return this.ctx.storage.transactionSync((): OperationResult => {
			const lateRejection = this.findAddSourceRejection(source);
			if (lateRejection !== null) {
				return { ok: false, error: lateRejection };
			}
			this.ctx.storage.sql.exec(
				"INSERT INTO topics (name, opaque_id, seq) VALUES (?, ?, 0)",
				source.topic,
				crypto.randomUUID(),
			);
			this.ctx.storage.sql.exec(
				"INSERT INTO sources (id, type, target, excluded_user_id, topic, enabled) VALUES (?, ?, ?, ?, ?, 1)",
				crypto.randomUUID(),
				source.type,
				source.target,
				source.excludedUserId,
				source.topic,
			);
			return { ok: true };
		});
	}

	/** 監視対象を Cron の確認対象から外す。トピックは /signal に残す */
	async disableSource(sourceId: string): Promise<void> {
		this.ctx.storage.sql.exec("UPDATE sources SET enabled = 0 WHERE id = ?", sourceId);
	}

	/**
	 * 無効の監視対象を再開する
	 *
	 * 停止中の更新で不要な起床を起こさないよう、確認位置を消して初回と同じ扱いにする。
	 * 有効な監視対象には何もしない。二重送信で稼働中の確認位置を消さないためである。
	 */
	async resumeSource(sourceId: string): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			const resumed = this.ctx.storage.sql
				.exec("UPDATE sources SET enabled = 1, last_error = NULL WHERE id = ? AND enabled = 0 RETURNING id", sourceId)
				.toArray();
			if (resumed.length > 0) {
				this.ctx.storage.sql.exec("DELETE FROM producer_state WHERE producer = ?", sourceId);
			}
		});
	}

	/** 監視対象と確認位置を削除し、連番を保持するためトピックは論理削除する */
	async removeSource(sourceId: string): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			const removed = this.ctx.storage.sql
				.exec<{ topic: string }>("DELETE FROM sources WHERE id = ? RETURNING topic", sourceId)
				.toArray()[0];
			if (!removed) {
				return;
			}
			this.ctx.storage.sql.exec("DELETE FROM producer_state WHERE producer = ?", sourceId);
			this.softDeleteTopic(removed.topic);
		});
	}

	/**
	 * 外部の producer 用のトピックを作成し、書き込みシークレットを返す
	 *
	 * シークレットの平文はこの戻り値だけに現れ、Durable Object にはハッシュだけを保存する。
	 * 名前は論理削除済みのものを含めて再利用できない。連番の巻き戻りを防ぐためである。
	 */
	async createExternalTopic(name: string): Promise<WriteSecretResult> {
		if (!TOPIC_NAME_PATTERN.test(name)) {
			return { ok: false, error: INVALID_TOPIC_NAME };
		}
		const writeSecret = generateSecret();
		const hash = await hashSecret(writeSecret);
		return this.ctx.storage.transactionSync((): WriteSecretResult => {
			if (this.topicNameExists(name)) {
				return { ok: false, error: TOPIC_NAME_TAKEN };
			}
			this.ctx.storage.sql.exec(
				"INSERT INTO topics (name, opaque_id, seq, write_secret_hash) VALUES (?, ?, 0, ?)",
				name,
				crypto.randomUUID(),
				hash,
			);
			return { ok: true, writeSecret };
		});
	}

	/** 外部トピックを論理削除する。監視対象のトピックは監視対象の削除で消す */
	async deleteExternalTopic(name: string): Promise<OperationResult> {
		const rejection = this.findExternalTopicRejection(name);
		if (rejection !== null) {
			return { ok: false, error: rejection };
		}
		this.softDeleteTopic(name);
		return { ok: true };
	}

	/** 外部トピックの書き込みシークレットを再発行する。古い値は直ちに失効する */
	async rotateWriteSecret(name: string): Promise<WriteSecretResult> {
		const writeSecret = generateSecret();
		const hash = await hashSecret(writeSecret);
		const rejection = this.findExternalTopicRejection(name);
		if (rejection !== null) {
			return { ok: false, error: rejection };
		}
		this.ctx.storage.sql.exec("UPDATE topics SET write_secret_hash = ? WHERE name = ?", hash, name);
		return { ok: true, writeSecret };
	}

	/**
	 * 管理ページの一覧を返す
	 *
	 * 論理削除済みのトピックを除く。書き込みシークレットのハッシュは有無だけを返す。
	 */
	async getAdminOverview(): Promise<AdminTopic[]> {
		return this.ctx.storage.sql
			.exec<AdminTopicRow>(
				`SELECT t.name, t.opaque_id, t.seq, t.updated_at_ms, t.write_secret_hash IS NOT NULL AS has_write_secret,
					s.id AS source_id, s.type, s.target, s.excluded_user_id, s.enabled, s.last_error
				 FROM topics t LEFT JOIN sources s ON s.topic = t.name
				 WHERE t.deleted_at_ms IS NULL
				 ORDER BY t.rowid`,
			)
			.toArray()
			.map(toAdminTopic);
	}

	/** 監視対象の直近のエラーを記録する。null なら消す */
	async recordSourceError(sourceId: string, lastError: string | null): Promise<void> {
		this.ctx.storage.sql.exec("UPDATE sources SET last_error = ? WHERE id = ?", lastError, sourceId);
	}

	/**
	 * イベントを1件追加し、割り当てた連番を返す
	 *
	 * @param topic 登録済みのトピック名（呼び出し側で確認済みであること）
	 * @param event 追加するイベント
	 * @throws トピックが未登録または論理削除済みの場合
	 */
	async appendEvent(topic: string, event: EventInput): Promise<number> {
		const seq = this.ctx.storage.transactionSync(() => this.insertEvent(topic, event));
		await this.ensureAlarm();
		return seq;
	}

	/**
	 * 指定した連番より後のイベントを返す
	 *
	 * oldest_seq は保持中で最も古い連番で、保持中のイベントがなければ latest_seq + 1 とする。
	 * このため `since < oldest_seq - 1` だけで欠落を判定できる。
	 *
	 * @returns トピックが未登録または論理削除済みなら null
	 */
	async readEvents(topic: string, since: number): Promise<EventsPage | null> {
		const latestSeq = this.ctx.storage.sql
			.exec<{ seq: number }>("SELECT seq FROM topics WHERE name = ? AND deleted_at_ms IS NULL", topic)
			.toArray()[0]?.seq;
		if (latestSeq === undefined) {
			return null;
		}
		const oldestSeq = this.ctx.storage.sql
			.exec<{ oldest: number | null }>("SELECT MIN(seq) AS oldest FROM events WHERE topic = ?", topic)
			.one().oldest;
		const rows = this.ctx.storage.sql
			.exec<EventRow>(
				"SELECT seq, created_at_ms, kind, summary, ref, data FROM events WHERE topic = ? AND seq > ? ORDER BY seq",
				topic,
				since,
			)
			.toArray();
		return {
			oldest_seq: oldestSeq ?? latestSeq + 1,
			latest_seq: latestSeq,
			events: rows.map(toStoredEvent),
		};
	}

	/**
	 * 公開の /signal に出す内容を返す
	 *
	 * トピック名は公開しない。論理削除済みのトピックは含めない。順序は登録順とする。
	 */
	async getSignalTopics(): Promise<SignalTopic[]> {
		return this.ctx.storage.sql
			.exec<{ opaque_id: string; seq: number; updated_at_ms: number | null }>(
				"SELECT opaque_id, seq, updated_at_ms FROM topics WHERE deleted_at_ms IS NULL ORDER BY rowid",
			)
			.toArray()
			.map((row) => ({
				id: row.opaque_id,
				seq: row.seq,
				updated_at: row.updated_at_ms === null ? null : new Date(row.updated_at_ms).toISOString(),
			}));
	}

	/**
	 * producer の確認位置の更新とイベントの追加を、1つのトランザクションで行う
	 *
	 * 片方だけが成功すると、イベントの重複や取りこぼしになるためである。
	 *
	 * @param event 追加するイベント。新着がなければ null
	 */
	async commitProducerPoll(
		producer: string,
		cursor: string,
		event: { topic: string; input: EventInput } | null,
	): Promise<void> {
		// API の応答を待つ間に無効化・削除された監視対象の結果は捨てる。確認位置の残骸を作らないためである
		const isActive =
			this.ctx.storage.sql.exec("SELECT 1 FROM sources WHERE id = ? AND enabled = 1", producer).toArray().length > 0;
		if (!isActive) {
			return;
		}
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				"INSERT INTO producer_state (producer, cursor) VALUES (?, ?) ON CONFLICT (producer) DO UPDATE SET cursor = excluded.cursor",
				producer,
				cursor,
			);
			if (event) {
				this.insertEvent(event.topic, event.input);
			}
		});
		if (event) {
			await this.ensureAlarm();
		}
	}

	/** 保持期間を過ぎたイベントを削除し、残りがあれば次の期限でアラームを予約する */
	override async alarm(): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM events WHERE created_at_ms <= ?", Date.now() - EVENT_RETENTION_MS);
		const oldest = this.ctx.storage.sql
			.exec<{ oldest: number | null }>("SELECT MIN(created_at_ms) AS oldest FROM events")
			.one().oldest;
		if (oldest !== null) {
			await this.ctx.storage.setAlarm(oldest + EVENT_RETENTION_MS);
		}
	}

	/** 追加できない理由を返す。追加できるなら null */
	private findAddSourceRejection(source: NewPollSource): string | null {
		if (!TOPIC_NAME_PATTERN.test(source.topic)) {
			return INVALID_TOPIC_NAME;
		}
		if (source.excludedUserId === "" || source.target === "") {
			return "監視先と除外するユーザーIDを入力してください";
		}
		if (source.type === "discord" && !DISCORD_CHANNEL_ID_PATTERN.test(source.target)) {
			return "チャンネルIDは数字で入力してください";
		}
		const { total } = this.ctx.storage.sql
			.exec<{ total: number }>("SELECT COUNT(*) AS total FROM sources")
			.one();
		if (total >= MAX_SOURCES) {
			return `監視対象は${MAX_SOURCES}件までです`;
		}
		if (this.topicNameExists(source.topic)) {
			return TOPIC_NAME_TAKEN;
		}
		const isDuplicate =
			this.ctx.storage.sql
				.exec("SELECT 1 FROM sources WHERE type = ? AND target = ?", source.type, source.target)
				.toArray().length > 0;
		return isDuplicate ? "この監視先はすでに登録されています" : null;
	}

	/** 監視先を読めることを、種類に応じた API で確認する */
	private verifySource(source: NewPollSource): Promise<void> {
		switch (source.type) {
			case "discord":
				return verifyDiscordChannel(this.env, source.target);
			case "cosense":
				return verifyCosenseProject(this.env, source.target);
			default: {
				const exhaustive: never = source.type;
				throw new Error(`未対応の監視対象です: ${String(exhaustive)}`);
			}
		}
	}

	/** 論理削除済みを含めて、名前が使われているかを返す */
	private topicNameExists(name: string): boolean {
		return this.ctx.storage.sql.exec("SELECT 1 FROM topics WHERE name = ?", name).toArray().length > 0;
	}

	/** 外部トピックとして操作できない理由を返す。操作できるなら null */
	private findExternalTopicRejection(name: string): string | null {
		const row = this.ctx.storage.sql
			.exec<{ source_id: string | null }>(
				`SELECT s.id AS source_id FROM topics t LEFT JOIN sources s ON s.topic = t.name
				 WHERE t.name = ? AND t.deleted_at_ms IS NULL`,
				name,
			)
			.toArray()[0];
		if (!row) {
			return "トピックが見つかりません";
		}
		return row.source_id === null ? null : "監視対象のトピックは操作できません。監視対象の画面の操作を使ってください";
	}

	private softDeleteTopic(name: string): void {
		this.ctx.storage.sql.exec("UPDATE topics SET deleted_at_ms = ? WHERE name = ?", Date.now(), name);
	}

	/** 連番を進めてイベントを挿入し、保持件数を超えた分を削除する。トランザクション内で呼ぶこと */
	private insertEvent(topic: string, event: EventInput): number {
		const now = Date.now();
		const { seq } = this.ctx.storage.sql
			.exec<{ seq: number }>(
				"UPDATE topics SET seq = seq + 1, updated_at_ms = ? WHERE name = ? AND deleted_at_ms IS NULL RETURNING seq",
				now,
				topic,
			)
			.one();
		this.ctx.storage.sql.exec(
			"INSERT INTO events (topic, seq, created_at_ms, kind, summary, ref, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
			topic,
			seq,
			now,
			event.kind,
			event.summary,
			event.ref ?? null,
			event.data ? JSON.stringify(event.data) : null,
		);
		this.ctx.storage.sql.exec(
			"DELETE FROM events WHERE topic = ? AND seq <= ?",
			topic,
			seq - MAX_EVENTS_PER_TOPIC,
		);
		return seq;
	}

	/** 削除用のアラームが未予約なら予約する。予約済みなら alarm() が次の期限へ予約し直す */
	private async ensureAlarm(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + EVENT_RETENTION_MS);
		}
	}
}

function toAdminTopic(row: AdminTopicRow): AdminTopic {
	return {
		name: row.name,
		opaqueId: row.opaque_id,
		seq: row.seq,
		updatedAt: row.updated_at_ms === null ? null : new Date(row.updated_at_ms).toISOString(),
		hasWriteSecret: row.has_write_secret === 1,
		source:
			row.source_id === null
				? null
				: {
						id: row.source_id,
						type: row.type,
						target: row.target,
						excludedUserId: row.excluded_user_id,
						enabled: row.enabled === 1,
						lastError: row.last_error,
					},
	};
}

function toStoredEvent(row: EventRow): StoredEvent {
	return {
		seq: row.seq,
		ts: new Date(row.created_at_ms).toISOString(),
		kind: row.kind,
		summary: row.summary,
		...(row.ref === null ? {} : { ref: row.ref }),
		...(row.data === null ? {} : { data: JSON.parse(row.data) as Record<string, unknown> }),
	};
}
