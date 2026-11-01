/**
 * EventBridge の管理用 RPC の振る舞いを検証するテスト
 *
 * docs/design.md の「操作の規則」の仕様に対応する。外部 API の fetch だけをモックする。
 */
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewPollSource } from "../src/event-bridge.ts";
import { bearer, getBridge, postEvent, readEvents, request, resetBridge, SIGNAL_PATH } from "./helpers.ts";

const GARDEN_CHANNEL: NewPollSource = {
	type: "discord",
	target: "2000",
	excludedUserId: "9999",
	topic: "discord-garden",
};
const GARDEN_PROJECT: NewPollSource = {
	type: "cosense",
	target: "tane-garden",
	excludedUserId: "user-id-muse",
	topic: "cosense-garden",
};
const SEEDED_SOURCE_COUNT = 2;
const MAX_SOURCES = 10;

/** 外部 API がすべて成功するモックを設定する */
function mockApisOk() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
		String(input).startsWith("https://discord.com/") ? Response.json([]) : Response.json({ pages: [] }),
	);
}

async function findSource(topic: string) {
	const entries = await getBridge().getAdminOverview();
	return entries.find((entry) => entry.name === topic)?.source;
}

/** 監視対象を追加し、その ID を返す */
async function addSourceAndGetId(source: NewPollSource): Promise<string> {
	await getBridge().addSource(source);
	const added = await findSource(source.topic);
	if (!added) {
		throw new Error("前提となる監視対象を追加できませんでした");
	}
	return added.id;
}

/** 確認位置を読む */
function readCursor(sourceId: string): Promise<string | null> {
	return runInDurableObject(getBridge(), (_instance, state) => {
		const row = state.storage.sql
			.exec<{ cursor: string }>("SELECT cursor FROM producer_state WHERE producer = ?", sourceId)
			.toArray()[0];
		return row?.cursor ?? null;
	});
}

function writeCursor(sourceId: string, cursor: string): Promise<void> {
	return runInDurableObject(getBridge(), (_instance, state) => {
		state.storage.sql.exec("INSERT INTO producer_state (producer, cursor) VALUES (?, ?)", sourceId, cursor);
	});
}

beforeEach(resetBridge);
afterEach(() => {
	vi.restoreAllMocks();
});

describe("監視対象の追加", () => {
	it("Discord は API を1回呼んで確認し、成功した場合だけ保存する", async () => {
		const fetchMock = mockApisOk();

		const result = await getBridge().addSource(GARDEN_CHANNEL);

		expect(result).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/channels/2000/messages?limit=1");
		expect(await findSource(GARDEN_CHANNEL.topic)).toMatchObject({ type: "discord", target: "2000", enabled: true });
	});

	it("Cosense は API を1回呼んで確認し、成功した場合だけ保存する", async () => {
		const fetchMock = mockApisOk();

		const result = await getBridge().addSource(GARDEN_PROJECT);

		expect(result).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/pages/tane-garden?");
		expect(await findSource(GARDEN_PROJECT.topic)).toMatchObject({ type: "cosense", target: "tane-garden" });
	});

	it("API が失敗したら保存せず、ステータスコードだけを理由として返す", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response("応答本文の秘密", { status: 403 }),
		);

		const result = await getBridge().addSource(GARDEN_CHANNEL);

		expect(result).toEqual({ ok: false, error: expect.stringContaining("403") });
		expect(JSON.stringify(result)).not.toContain("応答本文の秘密");
		expect((await getBridge().getAdminOverview()).map((entry) => entry.name)).not.toContain(GARDEN_CHANNEL.topic);
	});

	it("通信自体の失敗でも保存せず、例外の詳細を返さない", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("接続先の秘密の詳細"));

		const result = await getBridge().addSource(GARDEN_CHANNEL);

		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("秘密");
		expect(await findSource(GARDEN_CHANNEL.topic)).toBeUndefined();
	});

	it.each([
		["トピック名に大文字が含まれる", { topic: "Discord-Garden" }],
		["トピック名にスラッシュが含まれる", { topic: "discord/garden" }],
		["トピック名が空", { topic: "" }],
		["チャンネルIDが数字でない", { target: "庭のチャンネル" }],
		["除外するユーザーIDが空", { excludedUserId: "" }],
	])("%s なら API を呼ばずに拒否する", async (_label, override) => {
		const fetchMock = mockApisOk();

		const result = await getBridge().addSource({ ...GARDEN_CHANNEL, ...override });

		expect(result.ok).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("同じ種類と監視先の重複は API を呼ばずに拒否する", async () => {
		mockApisOk();
		await getBridge().addSource(GARDEN_CHANNEL);
		vi.restoreAllMocks();
		const fetchMock = mockApisOk();

		const result = await getBridge().addSource({ ...GARDEN_CHANNEL, topic: "discord-garden-2" });

		expect(result.ok).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("上限を超える追加は API を呼ばずに拒否し、トピックも作らない", async () => {
		mockApisOk();
		for (let index = 0; index < MAX_SOURCES - SEEDED_SOURCE_COUNT; index += 1) {
			await getBridge().addSource({ ...GARDEN_CHANNEL, target: `30${index}`, topic: `discord-channel-${index}` });
		}
		vi.restoreAllMocks();
		const fetchMock = mockApisOk();

		const result = await getBridge().addSource(GARDEN_CHANNEL);

		expect(result.ok).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect((await readEvents(0, GARDEN_CHANNEL.topic)).status).toBe(404);
		expect(await getBridge().getPollSources()).toHaveLength(MAX_SOURCES);
	});

	it("API の確認中に同じ監視先が追加されても、重複を保存しない", async () => {
		// 前提: 同時に2件の追加が API の応答を待っている
		mockApisOk();

		const results = await Promise.all([
			getBridge().addSource(GARDEN_CHANNEL),
			getBridge().addSource({ ...GARDEN_CHANNEL, topic: "discord-garden-2" }),
		]);

		expect(results.filter((result) => result.ok)).toHaveLength(1);
		const sources = await getBridge().getPollSources();
		expect(sources.filter((source) => source.target === GARDEN_CHANNEL.target)).toHaveLength(1);
	});
});

describe("監視対象の無効化と再開", () => {
	it("無効化すると Cron の確認対象から外れるが、トピックは /signal に残る", async () => {
		mockApisOk();
		const sourceId = await addSourceAndGetId(GARDEN_CHANNEL);

		await getBridge().disableSource(sourceId);

		expect((await getBridge().getPollSources()).map((source) => source.id)).not.toContain(sourceId);
		const signal = (await (await request(SIGNAL_PATH)).json()) as { topics: unknown[] };
		expect(signal.topics).toHaveLength(4);
		expect(await findSource(GARDEN_CHANNEL.topic)).toMatchObject({ enabled: false });
	});

	it("再開すると確認対象に戻り、確認位置と直近のエラーを消す", async () => {
		mockApisOk();
		const sourceId = await addSourceAndGetId(GARDEN_CHANNEL);
		await writeCursor(sourceId, "500");
		await getBridge().recordSourceError(sourceId, "Discord API がステータス 500 を返しました");
		await getBridge().disableSource(sourceId);

		await getBridge().resumeSource(sourceId);

		const resumed = (await getBridge().getPollSources()).find((source) => source.id === sourceId);
		expect(resumed).toMatchObject({ cursor: null, lastError: null });
	});

	it("有効な監視対象への再開は何も変えず、確認位置を保持する", async () => {
		// 前提: 再開の二重送信で、稼働中の監視対象に再開の操作が届く
		mockApisOk();
		const sourceId = await addSourceAndGetId(GARDEN_CHANNEL);
		await writeCursor(sourceId, "500");

		await getBridge().resumeSource(sourceId);

		expect(await readCursor(sourceId)).toBe("500");
	});

	it("確認の途中で無効化された監視対象の結果は記録しない", async () => {
		mockApisOk();
		const sourceId = await addSourceAndGetId(GARDEN_CHANNEL);
		await getBridge().disableSource(sourceId);

		await getBridge().commitProducerPoll(sourceId, null, "600", {
			topic: GARDEN_CHANNEL.topic,
			input: { kind: "discord.message", summary: "新着1件" },
		});

		expect(await readCursor(sourceId)).toBeNull();
		expect((await (await readEvents(0, GARDEN_CHANNEL.topic)).json()) as object).toMatchObject({ latest_seq: 0 });
	});

	it("確認の途中で無効化と再開が行われた場合は、古い確認の結果を記録しない", async () => {
		// 前提: 確認位置 500 で確認を始めた後、API の応答を待つ間に無効化と再開が行われた
		mockApisOk();
		const sourceId = await addSourceAndGetId(GARDEN_CHANNEL);
		await writeCursor(sourceId, "500");
		await getBridge().disableSource(sourceId);
		await getBridge().resumeSource(sourceId);

		await getBridge().commitProducerPoll(sourceId, "500", "600", {
			topic: GARDEN_CHANNEL.topic,
			input: { kind: "discord.message", summary: "新着1件" },
		});

		// 検証: 再開で消した確認位置は書き戻されず、停止前の更新を通知しない
		expect(await readCursor(sourceId)).toBeNull();
		expect((await (await readEvents(0, GARDEN_CHANNEL.topic)).json()) as object).toMatchObject({ latest_seq: 0 });
	});

	it("確認を始めた時点から確認位置が変わっていなければ、結果を記録する", async () => {
		// 前提: 確認位置 500 で確認を始め、その間に操作はなかった
		mockApisOk();
		const sourceId = await addSourceAndGetId(GARDEN_CHANNEL);
		await writeCursor(sourceId, "500");

		await getBridge().commitProducerPoll(sourceId, "500", "600", {
			topic: GARDEN_CHANNEL.topic,
			input: { kind: "discord.message", summary: "新着1件" },
		});

		// 検証: 確認位置が進み、イベントが1件追加される
		expect(await readCursor(sourceId)).toBe("600");
		expect((await (await readEvents(0, GARDEN_CHANNEL.topic)).json()) as object).toMatchObject({ latest_seq: 1 });
	});
});

describe("監視対象の削除", () => {
	it("監視対象と確認位置を消し、トピックは連番を保持して論理削除する", async () => {
		mockApisOk();
		const sourceId = await addSourceAndGetId(GARDEN_CHANNEL);
		await writeCursor(sourceId, "500");
		await getBridge().commitProducerPoll(sourceId, "500", "501", {
			topic: GARDEN_CHANNEL.topic,
			input: { kind: "discord.message", summary: "新着1件" },
		});

		await getBridge().removeSource(sourceId);

		expect((await getBridge().getPollSources()).map((source) => source.id)).not.toContain(sourceId);
		expect(await readCursor(sourceId)).toBeNull();
		expect((await readEvents(0, GARDEN_CHANNEL.topic)).status).toBe(404);
		const seq = await runInDurableObject(getBridge(), (_instance, state) =>
			state.storage.sql
				.exec<{ seq: number }>("SELECT seq FROM topics WHERE name = ?", GARDEN_CHANNEL.topic)
				.one().seq,
		);
		expect(seq).toBe(1);
	});

	it("削除した監視対象のトピック名は再利用できない", async () => {
		mockApisOk();
		const sourceId = await addSourceAndGetId(GARDEN_CHANNEL);
		await getBridge().removeSource(sourceId);

		const result = await getBridge().addSource(GARDEN_CHANNEL);

		expect(result.ok).toBe(false);
	});
});

describe("外部トピック", () => {
	it("作成すると書き込みシークレットを一度だけ返し、ハッシュだけを保存する", async () => {
		const result = await getBridge().createExternalTopic("garden-sensor");
		if (!result.ok) {
			throw new Error(result.error);
		}

		const post = await request("/events/garden-sensor", {
			method: "POST",
			headers: bearer(result.writeSecret),
			body: JSON.stringify({ kind: "test.event", summary: "土が乾いています" }),
		});
		expect(post.status).toBe(201);
		const stored = await runInDurableObject(getBridge(), (_instance, state) =>
			state.storage.sql.exec("SELECT * FROM topics WHERE name = 'garden-sensor'").one(),
		);
		expect(JSON.stringify(stored)).not.toContain(result.writeSecret);
		expect(JSON.stringify(await getBridge().getAdminOverview())).not.toContain(String(stored["write_secret_hash"]));
	});

	it("/signal に推測困難な opaque ID で連番0として現れる", async () => {
		await getBridge().createExternalTopic("garden-sensor");

		const signal = (await (await request(SIGNAL_PATH)).json()) as {
			topics: { id: string; seq: number; updated_at: string | null }[];
		};

		const entry = signal.topics.at(-1);
		expect(entry).toMatchObject({ seq: 0, updated_at: null });
		expect(entry?.id).not.toContain("garden-sensor");
		expect(entry?.id.length).toBeGreaterThanOrEqual(32);
	});

	it.each(["既存のトピック名", "不正な名前"])("%s では作成できない", async (label) => {
		const name = label === "既存のトピック名" ? "mac-script" : "Garden Sensor";

		const result = await getBridge().createExternalTopic(name);

		expect(result.ok).toBe(false);
	});

	it("再発行すると古いシークレットは失効し、新しいシークレットで書き込める", async () => {
		const created = await getBridge().createExternalTopic("garden-sensor");
		if (!created.ok) {
			throw new Error(created.error);
		}

		const rotated = await getBridge().rotateWriteSecret("garden-sensor");
		if (!rotated.ok) {
			throw new Error(rotated.error);
		}

		const body = JSON.stringify({ kind: "test.event", summary: "土が乾いています" });
		const path = "/events/garden-sensor";
		expect((await request(path, { method: "POST", headers: bearer(created.writeSecret), body })).status).toBe(401);
		expect((await request(path, { method: "POST", headers: bearer(rotated.writeSecret), body })).status).toBe(201);
	});

	it("論理削除すると /signal から消え、読み書きは 404 になり、名前も再利用できない", async () => {
		await postEvent("削除前のイベント");

		expect(await getBridge().deleteExternalTopic("mac-script")).toEqual({ ok: true });

		const signal = await (await request(SIGNAL_PATH)).text();
		expect(signal).not.toContain("topic-id-mac");
		expect((await postEvent("削除後の投稿")).status).toBe(404);
		expect((await readEvents(0)).status).toBe(404);
		expect((await getBridge().createExternalTopic("mac-script")).ok).toBe(false);
	});

	it.each([
		["削除", "deleteExternalTopic"],
		["シークレットの再発行", "rotateWriteSecret"],
	] as const)("監視対象のトピックには %s を行えない", async (_label, method) => {
		const result = await getBridge()[method]("discord-ietter");

		expect(result.ok).toBe(false);
		expect((await getBridge().getAdminOverview()).map((entry) => entry.name)).toContain("discord-ietter");
	});

	it.each([
		["削除", "deleteExternalTopic"],
		["シークレットの再発行", "rotateWriteSecret"],
	] as const)("存在しないトピックには %s を行えない", async (_label, method) => {
		expect((await getBridge()[method]("unknown-topic")).ok).toBe(false);
	});
});

describe("一覧", () => {
	it("論理削除を除く全トピックを、監視対象の情報とともに返す", async () => {
		await postEvent("一覧に出るイベント");

		const entries = await getBridge().getAdminOverview();

		expect(entries.map((entry) => entry.name)).toEqual(["discord-ietter", "mac-script", "cosense"]);
		expect(entries[1]).toMatchObject({
			opaqueId: "topic-id-mac",
			seq: 1,
			updatedAt: expect.any(String),
			hasWriteSecret: true,
			source: null,
		});
		expect(entries[0]).toMatchObject({
			hasWriteSecret: false,
			updatedAt: null,
			source: { type: "discord", target: "1000", excludedUserId: "9999", enabled: true, lastError: null },
		});
	});
});
