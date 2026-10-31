/**
 * Cron が複数の監視対象を確認する振る舞いを検証するテスト
 *
 * docs/design.md の「Cron」の仕様に対応する。外部 API の fetch だけをモックする。
 */
import { env } from "cloudflare:workers";
import { createScheduledController, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewPollSource } from "../src/event-bridge.ts";
import worker from "../src/index.ts";
import { getBridge, readEvents, resetBridge } from "./helpers.ts";

const SECOND_CHANNEL_ID = "2000";
const SECOND_CHANNEL_TOPIC = "discord-garden";
const SECOND_PROJECT = "tane-garden";
const SECOND_PROJECT_TOPIC = "cosense-garden";
const HUMAN_USER_ID = "1234";

function runCron(): Promise<void> {
	return worker.scheduled(createScheduledController(), env);
}

/** 指定した URL を含むリクエストだけ失敗させ、それ以外は空の一覧を返すモックを設定する */
function mockApis(failingUrlPart: string | null, failureStatus = 500) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		if (failingUrlPart !== null && url.includes(failingUrlPart)) {
			return new Response("応答本文の秘密", { status: failureStatus });
		}
		return url.startsWith("https://discord.com/") ? Response.json([]) : Response.json({ pages: [] });
	});
}

/** 追加時の API の確認だけ成功させて、監視対象を追加する */
async function addSource(source: NewPollSource): Promise<void> {
	const fetchMock = mockApis(null);
	const result = await getBridge().addSource(source);
	fetchMock.mockRestore();
	if (!result.ok) {
		throw new Error(result.error);
	}
}

/** 2つ目のチャンネルを、既定の監視対象とは別のトピックで追加する */
function addSecondChannel(): Promise<void> {
	return addSource({
		type: "discord",
		target: SECOND_CHANNEL_ID,
		excludedUserId: "9999",
		topic: SECOND_CHANNEL_TOPIC,
	});
}

async function lastErrorOf(target: string): Promise<string | null | undefined> {
	return (await getBridge().getPollSources()).find((source) => source.target === target)?.lastError;
}

beforeEach(resetBridge);
afterEach(() => {
	vi.restoreAllMocks();
});

describe("複数の監視対象", () => {
	it("Discord の複数チャンネルと Cosense の複数プロジェクトをすべて確認する", async () => {
		await addSecondChannel();
		await addSource({
			type: "cosense",
			target: SECOND_PROJECT,
			excludedUserId: "user-id-tanehouse",
			topic: SECOND_PROJECT_TOPIC,
		});
		const fetchMock = mockApis(null);

		await runCron();

		const calledUrls = fetchMock.mock.calls.map(([input]) => String(input));
		expect(calledUrls).toHaveLength(4);
		expect(calledUrls).toContainEqual(expect.stringContaining("/channels/1000/"));
		expect(calledUrls).toContainEqual(expect.stringContaining(`/channels/${SECOND_CHANNEL_ID}/`));
		expect(calledUrls).toContainEqual(expect.stringContaining("/pages/test-project?"));
		expect(calledUrls).toContainEqual(expect.stringContaining(`/pages/${SECOND_PROJECT}?`));
	});

	it("新着は監視対象ごとのトピックに記録し、確認位置も監視対象ごとに持つ", async () => {
		await addSecondChannel();
		// 前提: 両方のチャンネルの確認位置が 100 に記録されている
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
			String(input).startsWith("https://discord.com/")
				? Response.json([{ id: "100", author: { id: HUMAN_USER_ID } }])
				: Response.json({ pages: [] }),
		);
		await runCron();
		vi.restoreAllMocks();

		// 2つ目のチャンネルにだけ新着がある
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
			String(input).includes(`/channels/${SECOND_CHANNEL_ID}/`)
				? Response.json([{ id: "101", author: { id: HUMAN_USER_ID } }])
				: String(input).startsWith("https://discord.com/")
					? Response.json([])
					: Response.json({ pages: [] }),
		);
		await runCron();

		// 読み取り経路は、追加したトピックのイベントを返す
		const secondEvents = (await (await readEvents(0, SECOND_CHANNEL_TOPIC)).json()) as {
			events: { ref?: string; data?: unknown }[];
		};
		expect(secondEvents.events).toEqual([
			expect.objectContaining({ ref: "101", data: { count: 1, channel_id: SECOND_CHANNEL_ID } }),
		]);
		const firstEvents = (await (await readEvents(0, "discord-ietter")).json()) as { latest_seq: number };
		expect(firstEvents.latest_seq).toBe(0);
	});

	it("無効の監視対象は確認しない", async () => {
		await addSecondChannel();
		await runInDurableObject(getBridge(), (_instance, state) => {
			state.storage.sql.exec("UPDATE sources SET enabled = 0 WHERE target = ?", SECOND_CHANNEL_ID);
		});
		const fetchMock = mockApis(null);

		await runCron();

		const calledUrls = fetchMock.mock.calls.map(([input]) => String(input));
		expect(calledUrls).toHaveLength(2);
		expect(calledUrls.some((url) => url.includes(`/channels/${SECOND_CHANNEL_ID}/`))).toBe(false);
	});

	it("1件が失敗しても他の監視対象を確認し、最後に例外を投げる", async () => {
		await addSecondChannel();
		const fetchMock = mockApis("/channels/1000/");

		await expect(runCron()).rejects.toThrow();

		const calledUrls = fetchMock.mock.calls.map(([input]) => String(input));
		expect(calledUrls).toContainEqual(expect.stringContaining(`/channels/${SECOND_CHANNEL_ID}/`));
		expect(calledUrls).toContainEqual(expect.stringContaining("/pages/test-project?"));
	});

	it("通信自体の失敗の詳細も last_error に残さず、他の監視対象を止めない", async () => {
		await addSecondChannel();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input).includes("/channels/1000/")) {
				throw new TypeError("接続先の秘密の詳細");
			}
			return String(input).startsWith("https://discord.com/") ? Response.json([]) : Response.json({ pages: [] });
		});

		await expect(runCron()).rejects.toThrow();

		const lastError = await lastErrorOf("1000");
		expect(lastError).toEqual(expect.any(String));
		expect(lastError).not.toContain("秘密");
		expect(await lastErrorOf(SECOND_CHANNEL_ID)).toBeNull();
	});
});

describe("last_error", () => {
	/** sources の更新回数を数えるトリガーを作り、回数を読む関数を返す */
	async function countSourceWrites(): Promise<() => Promise<number>> {
		await runInDurableObject(getBridge(), (_instance, state) => {
			state.storage.sql.exec(`
				DROP TABLE IF EXISTS source_writes;
				CREATE TABLE source_writes (id INTEGER PRIMARY KEY);
				DROP TRIGGER IF EXISTS count_source_writes;
				CREATE TRIGGER count_source_writes AFTER UPDATE ON sources
				BEGIN INSERT INTO source_writes (id) VALUES (NULL); END;
			`);
		});
		return () =>
			runInDurableObject(getBridge(), (_instance, state) =>
				state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM source_writes").one().total,
			);
	}

	it("ステータスコードだけを記録し、応答本文とトークンを含めない", async () => {
		mockApis("/channels/1000/", 429);

		await expect(runCron()).rejects.toThrow();

		const lastError = await lastErrorOf("1000");
		expect(lastError).toContain("429");
		expect(lastError).not.toContain("応答本文の秘密");
		expect(lastError).not.toContain("test-discord-bot-token");
		expect(await lastErrorOf("test-project")).toBeNull();
	});

	it("成功したら消す", async () => {
		mockApis("/channels/1000/");
		await expect(runCron()).rejects.toThrow();
		vi.restoreAllMocks();
		mockApis(null);

		await runCron();

		expect(await lastErrorOf("1000")).toBeNull();
	});

	it("値が変わった場合だけ書き込む", async () => {
		const readWriteCount = await countSourceWrites();

		// 成功が続く間は書き込まない
		mockApis(null);
		await runCron();
		expect(await readWriteCount()).toBe(0);
		vi.restoreAllMocks();

		// 初めての失敗で1回書き込み、同じ失敗の繰り返しでは書き込まない
		mockApis("/channels/1000/", 500);
		await expect(runCron()).rejects.toThrow();
		expect(await readWriteCount()).toBe(1);
		await expect(runCron()).rejects.toThrow();
		expect(await readWriteCount()).toBe(1);
		vi.restoreAllMocks();

		// 失敗の内容が変われば書き込む
		mockApis("/channels/1000/", 403);
		await expect(runCron()).rejects.toThrow();
		expect(await readWriteCount()).toBe(2);
		vi.restoreAllMocks();

		// 復旧で1回書き込む
		mockApis(null);
		await runCron();
		expect(await readWriteCount()).toBe(3);
	});
});
