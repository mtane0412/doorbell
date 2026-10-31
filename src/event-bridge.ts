/**
 * イベントと連番を保管する Durable Object（SQLite バックエンド・全体で1個）
 *
 * 連番は永続化し TTL の対象にしない。消えるのはイベント本体だけである。
 * 連番が巻き戻ると Hook が「進んでいない」と判定し、通知が止まるためである。
 */
import { DurableObject } from "cloudflare:workers";

/** トピックごとの保持件数 */
const MAX_EVENTS_PER_TOPIC = 20;
/** イベントの保持期間 */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 生産者が渡すイベント。ts と seq は Durable Object が付与する */
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

export type TopicState = { topic: string; seq: number; updatedAt: string };

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
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS topics (
					name TEXT PRIMARY KEY,
					seq INTEGER NOT NULL,
					updated_at_ms INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS events (
					topic TEXT NOT NULL,
					seq INTEGER NOT NULL,
					created_at_ms INTEGER NOT NULL,
					kind TEXT NOT NULL,
					summary TEXT NOT NULL,
					ref TEXT,
					data TEXT,
					PRIMARY KEY (topic, seq)
				);
				CREATE TABLE IF NOT EXISTS producer_state (
					producer TEXT PRIMARY KEY,
					cursor TEXT NOT NULL
				);
			`);
		});
	}

	/**
	 * イベントを1件追加し、割り当てた連番を返す
	 *
	 * @param topic 登録済みのトピック名（呼び出し側で確認済みであること）
	 * @param event 追加するイベント
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
	 */
	async readEvents(topic: string, since: number): Promise<EventsPage> {
		const latestSeq =
			this.ctx.storage.sql
				.exec<{ seq: number }>("SELECT seq FROM topics WHERE name = ?", topic)
				.toArray()[0]?.seq ?? 0;
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

	/** イベントが1件以上あったトピックの連番と最終更新時刻を返す */
	async getTopicStates(): Promise<TopicState[]> {
		return this.ctx.storage.sql
			.exec<{ name: string; seq: number; updated_at_ms: number }>(
				"SELECT name, seq, updated_at_ms FROM topics",
			)
			.toArray()
			.map((row) => ({
				topic: row.name,
				seq: row.seq,
				updatedAt: new Date(row.updated_at_ms).toISOString(),
			}));
	}

	/** Worker 内蔵の生産者が最後に確認した位置を返す。未記録なら null */
	async getProducerCursor(producer: string): Promise<string | null> {
		return (
			this.ctx.storage.sql
				.exec<{ cursor: string }>("SELECT cursor FROM producer_state WHERE producer = ?", producer)
				.toArray()[0]?.cursor ?? null
		);
	}

	/**
	 * 生産者の確認位置の更新とイベントの追加を、1つのトランザクションで行う
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
				`INSERT INTO topics (name, seq, updated_at_ms) VALUES (?, 1, ?)
				 ON CONFLICT (name) DO UPDATE SET seq = seq + 1, updated_at_ms = excluded.updated_at_ms
				 RETURNING seq`,
				topic,
				now,
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
