/**
 * Cosense producer の振る舞いを検証するテスト
 *
 * docs/design.md の「Cosense producer」の仕様に対応する。外部 API である Cosense の fetch だけをモックする。
 */
import { env } from "cloudflare:workers";
import { createScheduledController } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollCosense } from "../src/cosense.ts";
import worker from "../src/index.ts";
import { getBridge, readEvents, resetBridge } from "./helpers.ts";

const COSENSE_TOPIC = "cosense";
const BOT_USER_ID = "user-id-tanehouse";
const HUMAN_USER_ID = "user-id-tanenobu";

type CosensePage = { id: string; updated: number; lastUpdateUser: { id: string } | null };

function page(id: string, updated: number, lastUpdateUserId: string = HUMAN_USER_ID): CosensePage {
	return { id, updated, lastUpdateUser: { id: lastUpdateUserId } };
}

/** Cosense のページ一覧 API の応答を返すモックを設定する */
function mockCosensePages(pages: CosensePage[]) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ pages }));
}

/** 移行で作られた監視対象を、最新の確認位置とともに取得して確認する */
async function poll(): Promise<void> {
	const bridge = getBridge();
	const source = (await bridge.getPollSources()).find((candidate) => candidate.type === "cosense");
	if (!source) {
		throw new Error("前提となる Cosense の監視対象がありません");
	}
	await pollCosense(env, bridge, source);
}

/** 既存のページを1件だけ確認済みにして、初回の記録を終えた状態にする */
async function recordInitialCursor(updated: number): Promise<void> {
	mockCosensePages([page("既存ページ", updated)]);
	await poll();
	vi.restoreAllMocks();
}

async function readCosenseEvents() {
	const response = await readEvents(0, COSENSE_TOPIC);
	return (await response.json()) as {
		latest_seq: number;
		events: { kind: string; summary: string; ref?: string; data?: unknown }[];
	};
}

beforeEach(resetBridge);
afterEach(() => {
	vi.restoreAllMocks();
});

describe("Cosense producer", () => {
	it("Personal Access Token を付けて、対象プロジェクトのページ一覧を更新順で取得する", async () => {
		const fetchMock = mockCosensePages([]);

		await poll();

		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://scrapbox.io/api/pages/test-project?sort=updated&limit=100",
		);
		expect(fetchMock.mock.calls[0]?.[1]).toEqual({
			headers: { "x-personal-access-token": "test-cosense-pat" },
		});
	});

	it("初回は既存のページを通知せず、確認位置だけを記録する", async () => {
		await recordInitialCursor(1000);

		expect((await readCosenseEvents()).latest_seq).toBe(0);

		// 確認位置が記録されていれば、同じ時刻のページは次回も新着にならない
		mockCosensePages([page("既存ページ", 1000)]);
		await poll();
		expect((await readCosenseEvents()).latest_seq).toBe(0);
	});

	it("確認位置より新しい更新があれば、件数と最新のページIDだけのイベントを追加する", async () => {
		await recordInitialCursor(1000);
		mockCosensePages([page("買い物メモ", 1002), page("週次ふりかえり", 1001), page("既存ページ", 1000)]);

		await poll();

		const { latest_seq: latestSeq, events } = await readCosenseEvents();
		expect(latestSeq).toBe(1);
		expect(events[0]).toMatchObject({
			kind: "cosense.page_updated",
			summary: "更新2件",
			ref: "買い物メモ",
			data: { count: 2, project: "test-project" },
		});
	});

	it("更新がなければイベントを追加しない", async () => {
		await recordInitialCursor(1000);
		mockCosensePages([page("既存ページ", 1000)]);

		await poll();

		expect((await readCosenseEvents()).latest_seq).toBe(0);
	});

	it("一度通知した更新は、次回の確認で再び通知しない", async () => {
		await recordInitialCursor(1000);
		mockCosensePages([page("買い物メモ", 1001)]);
		await poll();

		await poll();

		expect((await readCosenseEvents()).latest_seq).toBe(1);
	});

	it("自分のボットの更新は除外し、イベントの件数と参照先に含めない", async () => {
		await recordInitialCursor(1000);
		mockCosensePages([page("Museの日記", 1002, BOT_USER_ID), page("買い物メモ", 1001)]);

		await poll();

		const { events } = await readCosenseEvents();
		expect(events[0]).toMatchObject({ summary: "更新1件", ref: "買い物メモ", data: { count: 1, project: "test-project" } });
	});

	it("自分のボットの更新だけならイベントを作らず、確認位置だけ進める", async () => {
		await recordInitialCursor(1000);
		mockCosensePages([page("Museの日記", 1001, BOT_USER_ID)]);
		await poll();
		expect((await readCosenseEvents()).latest_seq).toBe(0);

		// 確認位置が 1001 まで進んでいれば、同じ時刻のページは新着にならない
		mockCosensePages([page("買い物メモ", 1001)]);
		await poll();

		expect((await readCosenseEvents()).latest_seq).toBe(0);
	});

	it("最終更新者が不明なページは、人の更新として通知する", async () => {
		await recordInitialCursor(1000);
		mockCosensePages([{ id: "更新者不明のページ", updated: 1001, lastUpdateUser: null }]);

		await poll();

		expect((await readCosenseEvents()).events[0]).toMatchObject({ ref: "更新者不明のページ" });
	});

	it("ページが1件もない初回は何も記録せず、次回も初回として扱う", async () => {
		mockCosensePages([]);
		await poll();

		// 確認位置が未記録なら、次回に見つけたページも初回扱いで通知されない
		await recordInitialCursor(1000);

		expect((await readCosenseEvents()).latest_seq).toBe(0);
	});

	it("Cosense API が失敗したら例外を投げ、確認位置を進めない", async () => {
		await recordInitialCursor(1000);
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response("unauthorized", { status: 401 }),
		);

		await expect(poll()).rejects.toThrow();

		vi.restoreAllMocks();
		mockCosensePages([page("買い物メモ", 1001)]);
		await poll();
		expect((await readCosenseEvents()).latest_seq).toBe(1);
	});

	it("Cosense API の応答が想定と違う形なら例外を投げる", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json({ pages: [{ id: "時刻がないページ" }] }),
		);

		await expect(poll()).rejects.toThrow();
	});
});

describe("Cron", () => {
	it("Cosense が失敗しても Discord の確認は行い、失敗を例外として報告する", async () => {
		// 前提: Discord は正常に応答し、Cosense だけが 500 を返す
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
			String(input).startsWith("https://discord.com/")
				? Response.json([])
				: new Response("server error", { status: 500 }),
		);

		await expect(worker.scheduled(createScheduledController(), env)).rejects.toThrow();

		const calledUrls = fetchMock.mock.calls.map(([input]) => String(input));
		expect(calledUrls.some((url) => url.startsWith("https://discord.com/"))).toBe(true);
	});

	it("Discord が失敗しても Cosense の確認は行い、失敗を例外として報告する", async () => {
		// 前提: Cosense は正常に応答し、Discord だけが 500 を返す
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
			String(input).startsWith("https://scrapbox.io/")
				? Response.json({ pages: [] })
				: new Response("server error", { status: 500 }),
		);

		await expect(worker.scheduled(createScheduledController(), env)).rejects.toThrow();

		const calledUrls = fetchMock.mock.calls.map(([input]) => String(input));
		expect(calledUrls.some((url) => url.startsWith("https://scrapbox.io/"))).toBe(true);
	});
});
