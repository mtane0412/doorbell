/**
 * Durable Object のスキーマ作成を検証するテスト
 *
 * 新しい環境では空のテーブルを作り、稼働中の環境ではデータを変更しないことを確かめる。
 */
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSchema } from "../src/schema.ts";
import { dropAllTables, getBridge, request, resetBridge, SIGNAL_PATH } from "./helpers.ts";

beforeEach(resetBridge);

describe("スキーマの作成", () => {
	it("空のデータベースに、トピックも監視対象もない状態のテーブルを作る", async () => {
		await runInDurableObject(getBridge(), (_instance, state) => {
			dropAllTables(state.storage.sql);

			createSchema(state.storage.sql);

			const { sql } = state.storage;
			expect(sql.exec("SELECT * FROM topics").toArray()).toEqual([]);
			expect(sql.exec("SELECT * FROM sources").toArray()).toEqual([]);
			expect(sql.exec("SELECT * FROM events").toArray()).toEqual([]);
			expect(sql.exec("SELECT * FROM producer_state").toArray()).toEqual([]);
		});
	});

	it("稼働中のデータベースでは、データを変更しない", async () => {
		await runInDurableObject(getBridge(), (_instance, state) => {
			const { sql } = state.storage;
			sql.exec("INSERT INTO producer_state (producer, cursor) VALUES ('discord', '555')");
			const readAll = () => ({
				topics: sql.exec("SELECT * FROM topics").toArray(),
				sources: sql.exec("SELECT * FROM sources").toArray(),
				producerState: sql.exec("SELECT * FROM producer_state").toArray(),
			});
			const before = readAll();

			createSchema(sql);

			expect(readAll()).toEqual(before);
		});
	});

	it("トピックのない環境でも /signal は空の一覧を返す", async () => {
		await runInDurableObject(getBridge(), (_instance, state) => {
			dropAllTables(state.storage.sql);
			createSchema(state.storage.sql);
		});

		const response = await request(SIGNAL_PATH);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ topics: [] });
	});
});
