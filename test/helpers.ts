/**
 * テスト共通の定数と操作
 *
 * Worker の HTTP 経由で操作する関数と、テスト間で Durable Object の状態を消す関数をまとめる。
 */
import { exports, env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { EventBridge } from "../src/event-bridge.ts";
import { hashSecret } from "../src/auth.ts";
import { createSchema } from "../src/schema.ts";

export const WRITABLE_TOPIC = "mac-script";
export const INTERNAL_TOPIC = "discord-ietter";
export const WRITE_SECRET = "test-write-secret";
export const READ_TOKEN = "test-read-token";
export const SIGNAL_PATH = "/signal/test-signal-key";

const BASE_URL = "https://doorbell.test";

/** Durable Object の取得（本番と同じ1個のインスタンス） */
export function getBridge() {
	// 同じ Worker の Durable Object を名前で参照する設定では、cf の型生成がクラスの型を推論できない
	const namespace = env.EVENT_BRIDGE as DurableObjectNamespace<EventBridge>;
	return namespace.getByName("main");
}

/** Bearer 認証のヘッダーを作る */
export function bearer(secret: string): HeadersInit {
	return { Authorization: `Bearer ${secret}` };
}

/** Worker へ HTTP リクエストを送る */
export function request(path: string, init?: RequestInit): Promise<Response> {
	return exports.default.fetch(new Request(`${BASE_URL}${path}`, init));
}

/** 正しいシークレットでイベントを1件投稿する */
export function postEvent(summary: string, topic: string = WRITABLE_TOPIC): Promise<Response> {
	return request(`/events/${topic}`, {
		method: "POST",
		headers: bearer(WRITE_SECRET),
		body: JSON.stringify({ kind: "test.event", summary }),
	});
}

/** 正しいトークンでイベントを読み取る */
export function readEvents(since: number, topic: string = WRITABLE_TOPIC): Promise<Response> {
	return request(`/events/${topic}?since=${since}`, { headers: bearer(READ_TOKEN) });
}

/** 全テーブルを削除する。sources が topics を参照するため、sources から順に消す */
export function dropAllTables(sql: SqlStorage): void {
	sql.exec(`
		DROP TABLE IF EXISTS sources;
		DROP TABLE IF EXISTS topics;
		DROP TABLE IF EXISTS events;
		DROP TABLE IF EXISTS producer_state;
	`);
}

/**
 * テスト間で状態が残らないよう全テーブルを作り直し、共通の前提となるデータを入れ直す
 *
 * 前提: 内蔵 producer のトピックが2つ（監視対象あり）と、外部トピックが1つある。
 */
export async function resetBridge(): Promise<void> {
	const writeSecretHash = await hashSecret(WRITE_SECRET);
	await runInDurableObject(getBridge(), async (_instance, state) => {
		const { sql } = state.storage;
		dropAllTables(sql);
		createSchema(sql);
		sql.exec(
			`INSERT INTO topics (name, opaque_id, seq, write_secret_hash) VALUES
				('discord-ietter', 'topic-id-discord', 0, NULL),
				('mac-script', 'topic-id-mac', 0, ?),
				('cosense', 'topic-id-cosense', 0, NULL)`,
			writeSecretHash,
		);
		sql.exec(`INSERT INTO sources (id, type, target, excluded_user_id, topic, enabled) VALUES
			('discord', 'discord', '1000', '9999', 'discord-ietter', 1),
			('cosense', 'cosense', 'test-project', 'user-id-tanehouse', 'cosense', 1)`);
		await state.storage.deleteAlarm();
	});
}
