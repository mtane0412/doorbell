/**
 * HTTP エンドポイントの振る舞いを検証するテスト
 *
 * docs/design.md の「エンドポイント」「`GET /events/{topic}` の応答」の仕様に対応する。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
	INTERNAL_TOPIC,
	READ_TOKEN,
	SIGNAL_PATH,
	WRITABLE_TOPIC,
	WRITE_SECRET,
	bearer,
	getBridge,
	postEvent,
	readEvents,
	request,
	resetBridge,
} from "./helpers.ts";

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

type EventsBody = {
	oldest_seq: number;
	latest_seq: number;
	events: { seq: number; ts: string; kind: string; summary: string; ref?: string; data?: unknown }[];
};
type SignalBody = { topics: { id: string; seq: number; updated_at: string | null }[] };

beforeEach(resetBridge);

describe("POST /events/{topic}", () => {
	it("正しいシークレットならイベントを追加し、連番を1ずつ進める", async () => {
		const first = await postEvent("1件目のお知らせ");
		const second = await postEvent("2件目のお知らせ");

		expect(first.status).toBe(201);
		expect(await first.json()).toEqual({ seq: 1 });
		expect(await second.json()).toEqual({ seq: 2 });
	});

	it("同時に投稿されても連番が欠けず、イベントも失われない", async () => {
		const responses = await Promise.all(
			Array.from({ length: 10 }, (_, index) => postEvent(`同時投稿${index}`)),
		);
		const seqs = await Promise.all(
			responses.map(async (response) => ((await response.json()) as { seq: number }).seq),
		);

		expect(seqs.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const body = (await (await readEvents(0)).json()) as EventsBody;
		expect(body.events).toHaveLength(10);
	});

	it.each([
		["シークレットなし", undefined],
		["誤ったシークレット", bearer("wrong-secret")],
		["Bearer の付かないシークレット", { Authorization: WRITE_SECRET }],
	])("%s なら 401 を返す", async (_label, headers) => {
		const response = await request(`/events/${WRITABLE_TOPIC}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ kind: "test.event", summary: "不正な投稿" }),
		});

		expect(response.status).toBe(401);
	});

	it("書き込みシークレットのない Worker 内蔵トピックには、外部から投稿できない", async () => {
		const response = await postEvent("外部からの投稿", INTERNAL_TOPIC);

		expect(response.status).toBe(401);
	});

	it("未登録のトピックなら 404 を返す", async () => {
		const response = await postEvent("宛先のない投稿", "unknown-topic");

		expect(response.status).toBe(404);
	});

	it("本文が 4 KB を超えるなら 413 を返す", async () => {
		const response = await postEvent("あ".repeat(2000));

		expect(response.status).toBe(413);
	});

	it.each([
		["JSON でない本文", "これはJSONではありません"],
		["summary がない本文", JSON.stringify({ kind: "test.event" })],
		["summary が空の本文", JSON.stringify({ kind: "test.event", summary: "" })],
		["kind がない本文", JSON.stringify({ summary: "種別なし" })],
		["ref が文字列でない本文", JSON.stringify({ kind: "test.event", summary: "参照不正", ref: 1 })],
		["data がオブジェクトでない本文", JSON.stringify({ kind: "test.event", summary: "不正", data: [1] })],
	])("%s なら 400 を返す", async (_label, body) => {
		const response = await request(`/events/${WRITABLE_TOPIC}`, {
			method: "POST",
			headers: bearer(WRITE_SECRET),
			body,
		});

		expect(response.status).toBe(400);
	});
});

describe("GET /signal/{signal_key}", () => {
	it("全トピックの不透明ID・連番・更新時刻だけを返し、トピック名と内容を含まない", async () => {
		await postEvent("秘密にしたい要約");

		const response = await request(SIGNAL_PATH);
		const text = await response.text();
		const body = JSON.parse(text) as SignalBody;

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(body.topics).toEqual([
			{ id: "topic-id-discord", seq: 0, updated_at: null },
			{ id: "topic-id-mac", seq: 1, updated_at: expect.any(String) },
			{ id: "topic-id-cosense", seq: 0, updated_at: null },
		]);
		expect(text).not.toContain(WRITABLE_TOPIC);
		expect(text).not.toContain("秘密にしたい要約");
	});

	it("signal_key が誤っているなら 404 を返す", async () => {
		const response = await request("/signal/wrong-key");

		expect(response.status).toBe(404);
	});
});

describe("GET /events/{topic}", () => {
	it("トークンがないなら 401 を返す", async () => {
		const response = await request(`/events/${WRITABLE_TOPIC}?since=0`);

		expect(response.status).toBe(401);
	});

	it("書き込みシークレットでは読み取れない", async () => {
		const response = await request(`/events/${WRITABLE_TOPIC}?since=0`, {
			headers: bearer(WRITE_SECRET),
		});

		expect(response.status).toBe(401);
	});

	it("未登録のトピックなら 404 を返す", async () => {
		const response = await readEvents(0, "unknown-topic");

		expect(response.status).toBe(404);
	});

	it.each(["", "?since=", "?since=-1", "?since=abc", "?since=1.5"])(
		"since が不正（%s）なら 400 を返す",
		async (query) => {
			const response = await request(`/events/${WRITABLE_TOPIC}${query}`, {
				headers: bearer(READ_TOKEN),
			});

			expect(response.status).toBe(400);
		},
	);

	it("指定した連番より後のイベントだけを、形式どおり返す", async () => {
		await postEvent("読み飛ばされるイベント");
		await request(`/events/${WRITABLE_TOPIC}`, {
			method: "POST",
			headers: bearer(WRITE_SECRET),
			body: JSON.stringify({
				kind: "test.event",
				summary: "読み取るイベント",
				ref: "参照先ID",
				data: { count: 3 },
			}),
		});

		const body = (await (await readEvents(1)).json()) as EventsBody;

		expect(body.oldest_seq).toBe(1);
		expect(body.latest_seq).toBe(2);
		expect(body.events).toEqual([
			{
				seq: 2,
				ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
				kind: "test.event",
				summary: "読み取るイベント",
				ref: "参照先ID",
				data: { count: 3 },
			},
		]);
	});

	it("イベントのないトピックでは、since=0 が欠落にならない値を返す", async () => {
		const body = (await (await readEvents(0)).json()) as EventsBody;

		expect(body).toEqual({ oldest_seq: 1, latest_seq: 0, events: [] });
	});

	it("トピックごとに最新20件だけを保持する", async () => {
		for (let index = 1; index <= 21; index += 1) {
			await postEvent(`${index}件目`);
		}

		const body = (await (await readEvents(0)).json()) as EventsBody;

		expect(body.oldest_seq).toBe(2);
		expect(body.latest_seq).toBe(21);
		expect(body.events).toHaveLength(20);
	});
});

describe("保持期間", () => {
	/** 全イベントを8日前の投稿に書き換える */
	async function ageAllEvents(): Promise<void> {
		await runInDurableObject(getBridge(), (_instance, state) => {
			state.storage.sql.exec("UPDATE events SET created_at_ms = created_at_ms - ?", EIGHT_DAYS_MS);
		});
	}

	it("7日を過ぎたイベントはアラームで消えるが、連番は消えずに続く", async () => {
		await postEvent("古いイベント");
		await postEvent("古いイベント2");
		await ageAllEvents();

		expect(await runDurableObjectAlarm(getBridge())).toBe(true);

		const body = (await (await readEvents(0)).json()) as EventsBody;
		expect(body).toEqual({ oldest_seq: 3, latest_seq: 2, events: [] });

		const signal = (await (await request(SIGNAL_PATH)).json()) as SignalBody;
		expect(signal.topics.find((topic) => topic.id === "topic-id-mac")?.seq).toBe(2);
		expect(await (await postEvent("新しいイベント")).json()).toEqual({ seq: 3 });
	});

	it("期限内のイベントが残るなら、アラームを次の期限へ予約し直す", async () => {
		await postEvent("古いイベント");
		await ageAllEvents();
		await postEvent("新しいイベント");

		await runInDurableObject(getBridge(), async (_instance, state) => {
			await state.storage.setAlarm(Date.now());
		});
		await runDurableObjectAlarm(getBridge());

		const body = (await (await readEvents(0)).json()) as EventsBody;
		expect(body.events.map((event) => event.summary)).toEqual(["新しいイベント"]);
		await runInDurableObject(getBridge(), async (_instance, state) => {
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
	});

	it("インスタンスが破棄されても連番とイベントが残る", async () => {
		await postEvent("永続化を確認するイベント");

		await evictDurableObject(getBridge());

		const body = (await (await readEvents(0)).json()) as EventsBody;
		expect(body.latest_seq).toBe(1);
		expect(body.events).toHaveLength(1);
	});
});

describe("ルーティング", () => {
	it.each([
		["GET", "/"],
		["DELETE", `/events/${WRITABLE_TOPIC}`],
		["POST", SIGNAL_PATH],
		["GET", `/events/${WRITABLE_TOPIC}/extra`],
	])("%s %s は 404 を返す", async (method, path) => {
		const response = await request(path, { method });

		expect(response.status).toBe(404);
	});
});
