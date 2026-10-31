/**
 * Durable Object のスキーマ移行を検証するテスト
 *
 * docs/design.md の「移行」の仕様に対応する。旧スキーマのデータベースを実際に作り、
 * opaque ID・トピック名・連番・確認位置が移行の前後で変わらないことを確かめる。
 */
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateSchema } from "../src/migration.ts";
import { dropAllTables, getBridge, resetBridge } from "./helpers.ts";

/** 本番の旧シークレットに相当する値 */
const LEGACY_SECRETS = {
	TOPICS: JSON.stringify([
		{ name: "discord-ietter", id: "opaque-discord" },
		{ name: "cosense", id: "opaque-cosense" },
		{ name: "mac-script", id: "opaque-mac" },
	]),
	TOPIC_WRITE_SECRETS: JSON.stringify({ "mac-script": "mac-write-secret" }),
	DISCORD_CHANNEL_ID: "2000",
	DISCORD_BOT_USER_ID: "8888",
	COSENSE_PROJECT: "tane-house",
	COSENSE_BOT_USER_ID: "user-id-muse",
};
/** `printf mac-write-secret | shasum -a 256` の結果 */
const MAC_WRITE_SECRET_SHA256 = "48f945f54d2f9a7f5456b92b7b96eccdb03c919d7838548e07078514fcaad7ce";
const UPDATED_AT_MS = 1_790_000_000_000;

type DatabaseSnapshot = {
	topics: Record<string, SqlStorageValue>[];
	sources: Record<string, SqlStorageValue>[];
	events: Record<string, SqlStorageValue>[];
	producerState: Record<string, SqlStorageValue>[];
};

/** 旧スキーマのテーブルを作り、運用中のデータに相当する行を入れる */
function createLegacyDatabase(sql: SqlStorage): void {
	sql.exec(`
		CREATE TABLE topics (name TEXT PRIMARY KEY, seq INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
		CREATE TABLE events (
			topic TEXT NOT NULL, seq INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
			kind TEXT NOT NULL, summary TEXT NOT NULL, ref TEXT, data TEXT,
			PRIMARY KEY (topic, seq)
		);
		CREATE TABLE producer_state (producer TEXT PRIMARY KEY, cursor TEXT NOT NULL);
	`);
	sql.exec("INSERT INTO topics VALUES ('discord-ietter', 42, ?)", UPDATED_AT_MS);
	sql.exec(
		"INSERT INTO events VALUES ('discord-ietter', 42, ?, 'discord.message', '新着3件', '555', NULL)",
		UPDATED_AT_MS,
	);
	sql.exec("INSERT INTO producer_state VALUES ('discord', '555'), ('cosense', '1700000000')");
}

function snapshot(sql: SqlStorage): DatabaseSnapshot {
	return {
		topics: sql.exec("SELECT * FROM topics ORDER BY name").toArray(),
		sources: sql.exec("SELECT * FROM sources ORDER BY id").toArray(),
		events: sql.exec("SELECT * FROM events ORDER BY topic, seq").toArray(),
		producerState: sql.exec("SELECT * FROM producer_state ORDER BY producer").toArray(),
	};
}

beforeEach(resetBridge);

describe("スキーマ移行", () => {
	it("既存トピックの opaque ID・名前・連番・更新時刻と確認位置を引き継ぐ", async () => {
		await runInDurableObject(getBridge(), async (_instance, state) => {
			dropAllTables(state.storage.sql);
			createLegacyDatabase(state.storage.sql);

			await migrateSchema(state.storage, LEGACY_SECRETS);

			const { topics, events, producerState } = snapshot(state.storage.sql);
			expect(topics).toContainEqual({
				name: "discord-ietter",
				opaque_id: "opaque-discord",
				seq: 42,
				updated_at_ms: UPDATED_AT_MS,
				write_secret_hash: null,
				deleted_at_ms: null,
			});
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ topic: "discord-ietter", seq: 42, ref: "555" });
			expect(producerState).toEqual([
				{ producer: "cosense", cursor: "1700000000" },
				{ producer: "discord", cursor: "555" },
			]);
		});
	});

	it("イベントのないトピックは連番0・更新時刻なしで作成する", async () => {
		await runInDurableObject(getBridge(), async (_instance, state) => {
			dropAllTables(state.storage.sql);
			createLegacyDatabase(state.storage.sql);

			await migrateSchema(state.storage, LEGACY_SECRETS);

			expect(snapshot(state.storage.sql).topics).toContainEqual(
				expect.objectContaining({ name: "cosense", opaque_id: "opaque-cosense", seq: 0, updated_at_ms: null }),
			);
		});
	});

	it("書き込みシークレットは平文を保存せず、SHA-256 のハッシュだけを保存する", async () => {
		await runInDurableObject(getBridge(), async (_instance, state) => {
			dropAllTables(state.storage.sql);
			createLegacyDatabase(state.storage.sql);

			await migrateSchema(state.storage, LEGACY_SECRETS);

			const { topics } = snapshot(state.storage.sql);
			expect(topics.find((topic) => topic["name"] === "mac-script")?.["write_secret_hash"]).toBe(
				MAC_WRITE_SECRET_SHA256,
			);
			expect(JSON.stringify(topics)).not.toContain("mac-write-secret");
		});
	});

	it("シークレットの値から sources を作り、id を確認位置の producer と一致させる", async () => {
		await runInDurableObject(getBridge(), async (_instance, state) => {
			dropAllTables(state.storage.sql);
			createLegacyDatabase(state.storage.sql);

			await migrateSchema(state.storage, LEGACY_SECRETS);

			expect(snapshot(state.storage.sql).sources).toEqual([
				{
					id: "cosense",
					type: "cosense",
					target: "tane-house",
					excluded_user_id: "user-id-muse",
					topic: "cosense",
					enabled: 1,
					last_error: null,
				},
				{
					id: "discord",
					type: "discord",
					target: "2000",
					excluded_user_id: "8888",
					topic: "discord-ietter",
					enabled: 1,
					last_error: null,
				},
			]);
		});
	});

	it("TOPICS から外された既存トピックは、連番を保持したまま論理削除にする", async () => {
		await runInDurableObject(getBridge(), async (_instance, state) => {
			dropAllTables(state.storage.sql);
			createLegacyDatabase(state.storage.sql);
			state.storage.sql.exec("INSERT INTO topics VALUES ('retired-topic', 7, ?)", UPDATED_AT_MS);

			await migrateSchema(state.storage, LEGACY_SECRETS);

			expect(snapshot(state.storage.sql).topics).toContainEqual(
				expect.objectContaining({
					name: "retired-topic",
					seq: 7,
					opaque_id: expect.any(String),
					deleted_at_ms: expect.any(Number),
				}),
			);
		});
	});

	it("2回実行してもデータが重複・変更されず、シークレットの変更も取り込まない", async () => {
		await runInDurableObject(getBridge(), async (_instance, state) => {
			dropAllTables(state.storage.sql);
			createLegacyDatabase(state.storage.sql);
			await migrateSchema(state.storage, LEGACY_SECRETS);
			const firstResult = snapshot(state.storage.sql);

			// 取り込みは一度だけなので、シークレットを変えても読み直さない
			await migrateSchema(state.storage, {
				...LEGACY_SECRETS,
				DISCORD_CHANNEL_ID: "3000",
				TOPICS: JSON.stringify([{ name: "new-topic", id: "opaque-new" }]),
			});

			expect(snapshot(state.storage.sql)).toEqual(firstResult);
		});
	});

	it("空のデータベースでも新しいスキーマを作成する", async () => {
		await runInDurableObject(getBridge(), async (_instance, state) => {
			dropAllTables(state.storage.sql);

			await migrateSchema(state.storage, LEGACY_SECRETS);

			const { topics, sources } = snapshot(state.storage.sql);
			expect(topics).toHaveLength(3);
			expect(sources).toHaveLength(2);
		});
	});

	it.each([
		["TOPICS が JSON でない", { TOPICS: "これはJSONではありません" }],
		["TOPICS の形式が不正", { TOPICS: JSON.stringify([{ name: "名前だけ" }]) }],
		["TOPICS の opaque ID が重複している", {
			TOPICS: JSON.stringify([
				{ name: "discord-ietter", id: "同じID" },
				{ name: "cosense", id: "同じID" },
			]),
		}],
		["discord のトピックが TOPICS にない", { TOPICS: JSON.stringify([{ name: "cosense", id: "opaque-cosense" }]) }],
		["cosense のトピックが TOPICS にない", {
			TOPICS: JSON.stringify([{ name: "discord-ietter", id: "opaque-discord" }]),
		}],
		["TOPIC_WRITE_SECRETS の形式が不正", { TOPIC_WRITE_SECRETS: "[]" }],
		["DISCORD_CHANNEL_ID が空", { DISCORD_CHANNEL_ID: "" }],
		["DISCORD_BOT_USER_ID が空", { DISCORD_BOT_USER_ID: "" }],
		["COSENSE_PROJECT が空", { COSENSE_PROJECT: "" }],
		["COSENSE_BOT_USER_ID が空", { COSENSE_BOT_USER_ID: "" }],
	])("%s なら例外を投げ、旧スキーマのまま移行を完了させない", async (_label, override) => {
		await runInDurableObject(getBridge(), async (_instance, state) => {
			dropAllTables(state.storage.sql);
			createLegacyDatabase(state.storage.sql);

			await expect(migrateSchema(state.storage, { ...LEGACY_SECRETS, ...override })).rejects.toThrow();

			const sql = state.storage.sql;
			expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'sources'").toArray()).toEqual([]);
			expect(sql.exec("SELECT * FROM topics").toArray()).toEqual([
				{ name: "discord-ietter", seq: 42, updated_at_ms: UPDATED_AT_MS },
			]);
		});
	});
});
