/**
 * Discord Cron の振る舞いを検証するテスト
 *
 * docs/design.md の「Discord producer」の仕様に対応する。外部 API である Discord の fetch だけをモックする。
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollDiscord } from "../src/discord.ts";
import { getBridge, INTERNAL_TOPIC, readEvents, resetBridge } from "./helpers.ts";

const BOT_USER_ID = "9999";
const OTHER_USER_ID = "1234";

type DiscordMessage = { id: string; author: { id: string } };

/** Discord と同じく新しい順に並ぶメッセージ一覧を返すモックを設定する */
function mockDiscordMessages(messages: DiscordMessage[]) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(messages));
}

/** 移行で作られた監視対象を、最新の確認位置とともに取得して確認する */
async function runCron(): Promise<void> {
	const bridge = getBridge();
	const source = (await bridge.getPollSources()).find((candidate) => candidate.type === "discord");
	if (!source) {
		throw new Error("前提となる Discord の監視対象がありません");
	}
	await pollDiscord(env, bridge, source);
}

async function readDiscordEvents() {
	const response = await readEvents(0, INTERNAL_TOPIC);
	return (await response.json()) as {
		latest_seq: number;
		events: { kind: string; summary: string; ref?: string; data?: unknown }[];
	};
}

beforeEach(resetBridge);
afterEach(() => {
	vi.restoreAllMocks();
});

describe("Discord Cron", () => {
	it("初回は既存の投稿を通知せず、最新メッセージIDだけを記録する", async () => {
		const fetchMock = mockDiscordMessages([{ id: "100", author: { id: OTHER_USER_ID } }]);

		await runCron();

		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://discord.com/api/v10/channels/1000/messages?limit=1",
		);
		expect((await readDiscordEvents()).latest_seq).toBe(0);
	});

	it("新着があれば件数と最新メッセージIDだけのイベントを追加する", async () => {
		mockDiscordMessages([{ id: "100", author: { id: OTHER_USER_ID } }]);
		await runCron();
		vi.restoreAllMocks();
		const fetchMock = mockDiscordMessages([
			{ id: "102", author: { id: OTHER_USER_ID } },
			{ id: "101", author: { id: OTHER_USER_ID } },
		]);

		await runCron();

		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://discord.com/api/v10/channels/1000/messages?limit=100&after=100",
		);
		expect(fetchMock.mock.calls[0]?.[1]).toEqual({
			headers: { Authorization: "Bot test-discord-bot-token" },
		});
		const { latest_seq: latestSeq, events } = await readDiscordEvents();
		expect(latestSeq).toBe(1);
		expect(events[0]).toMatchObject({
			kind: "discord.message",
			summary: "新着2件",
			ref: "102",
			data: { count: 2, channel_id: "1000" },
		});
	});

	it("自分のボットの投稿は除外し、イベントの件数と参照先に含めない", async () => {
		mockDiscordMessages([{ id: "100", author: { id: OTHER_USER_ID } }]);
		await runCron();
		vi.restoreAllMocks();
		mockDiscordMessages([
			{ id: "102", author: { id: BOT_USER_ID } },
			{ id: "101", author: { id: OTHER_USER_ID } },
		]);

		await runCron();

		const { events } = await readDiscordEvents();
		expect(events[0]).toMatchObject({ summary: "新着1件", ref: "101", data: { count: 1, channel_id: "1000" } });
	});

	it("自分のボットの投稿だけならイベントを作らず、確認済みIDだけ進める", async () => {
		mockDiscordMessages([{ id: "100", author: { id: OTHER_USER_ID } }]);
		await runCron();
		vi.restoreAllMocks();
		mockDiscordMessages([{ id: "101", author: { id: BOT_USER_ID } }]);
		await runCron();
		vi.restoreAllMocks();
		const fetchMock = mockDiscordMessages([]);

		await runCron();

		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("after=101");
		expect((await readDiscordEvents()).latest_seq).toBe(0);
	});

	it("桁数の違うメッセージIDでも、数値として最大のIDまで確認済みにする", async () => {
		mockDiscordMessages([{ id: "99", author: { id: OTHER_USER_ID } }]);
		await runCron();
		vi.restoreAllMocks();
		mockDiscordMessages([
			{ id: "100", author: { id: OTHER_USER_ID } },
			{ id: "99", author: { id: OTHER_USER_ID } },
		]);
		await runCron();
		vi.restoreAllMocks();
		const fetchMock = mockDiscordMessages([]);

		await runCron();

		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("after=100");
	});

	it("チャンネルが空の初回は何も記録せず、次回も初回として扱う", async () => {
		mockDiscordMessages([]);
		await runCron();
		vi.restoreAllMocks();
		const fetchMock = mockDiscordMessages([]);

		await runCron();

		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=1");
	});

	it("Discord API が失敗したら例外を投げ、確認済みIDを進めない", async () => {
		mockDiscordMessages([{ id: "100", author: { id: OTHER_USER_ID } }]);
		await runCron();
		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response("rate limited", { status: 429 }),
		);

		await expect(runCron()).rejects.toThrow();

		vi.restoreAllMocks();
		const fetchMock = mockDiscordMessages([]);
		await runCron();
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("after=100");
	});

	it("Discord API の応答が想定と違う形なら例外を投げる", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json([{ id: 100 }]),
		);

		await expect(runCron()).rejects.toThrow();
	});
});
