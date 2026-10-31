/**
 * イベントと連番を保管する Durable Object（SQLite バックエンド・全体で1個）
 *
 * 連番は永続化し TTL の対象にしない。消えるのはイベント本体だけである。
 * 連番が巻き戻ると Hook が「進んでいない」と判定し、通知が止まるためである。
 */
import { DurableObject } from "cloudflare:workers";
import { migrateSchema } from "./migration.ts";

/** トピックごとの保持件数 */
const MAX_EVENTS_PER_TOPIC = 20;
/** 監視対象の暫定の上限。Workers Free の Cron の CPU 時間に収めるため（docs/design.md の「Cron」） */
const MAX_SOURCES = 10;
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
	 * トピック名は論理削除済みのものを含めて再利用できず、主キーの制約で例外になる。
	 *
	 * @throws 監視対象が上限に達している場合、またはトピック名や監視先が重複している場合
	 */
	async addSource(source: NewPollSource): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			const { total } = this.ctx.storage.sql
				.exec<{ total: number }>("SELECT COUNT(*) AS total FROM sources")
				.one();
			if (total >= MAX_SOURCES) {
				throw new Error(`監視対象は${MAX_SOURCES}件までです`);
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
		});
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
