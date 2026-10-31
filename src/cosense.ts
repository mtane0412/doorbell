/**
 * Cosense プロジェクトのページ更新を REST で確認し、イベントとして記録する生産者
 *
 * イベントには件数と最新のページIDだけを載せ、タイトルや本文は載せない。
 * 自分のボットの更新を除外し、エージェントの編集で起床が連鎖することを防ぐ。
 *
 * 注意: API は各ページの最終更新者しか返さない。人の更新の直後にボットが同じページを更新すると、
 * その人の更新は検知できない。
 */
import type { EventBridge, EventInput } from "./event-bridge.ts";

const COSENSE_API_BASE = "https://scrapbox.io/api/pages";
const COSENSE_PRODUCER = "cosense";
const COSENSE_TOPIC = "cosense";
/** 1回で取得するページ数。超えた分は件数に数えないが、確認位置が進むため次回も通知しない */
const COSENSE_PAGE_SIZE = 100;

type CosensePage = { id: string; updated: number; lastUpdateUser: { id: string } | null };

function isCosensePage(value: unknown): value is CosensePage {
	if (
		typeof value !== "object" ||
		value === null ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!("updated" in value) ||
		typeof value.updated !== "number" ||
		!("lastUpdateUser" in value)
	) {
		return false;
	}
	const { lastUpdateUser } = value;
	return (
		lastUpdateUser === null ||
		(typeof lastUpdateUser === "object" &&
			"id" in lastUpdateUser &&
			typeof lastUpdateUser.id === "string")
	);
}

async function fetchPages(env: Env): Promise<CosensePage[]> {
	const project = encodeURIComponent(env.COSENSE_PROJECT);
	const response = await fetch(`${COSENSE_API_BASE}/${project}?sort=updated&limit=${COSENSE_PAGE_SIZE}`, {
		headers: { "x-personal-access-token": env.COSENSE_PAT },
	});
	if (!response.ok) {
		throw new Error(`Cosense API がステータス ${response.status} を返しました`);
	}
	const body: unknown = await response.json();
	if (
		typeof body !== "object" ||
		body === null ||
		!("pages" in body) ||
		!Array.isArray(body.pages) ||
		!body.pages.every(isCosensePage)
	) {
		throw new Error("Cosense API の応答の形式が不正です");
	}
	return body.pages;
}

/** ピン留めされたページは更新時刻に関係なく先頭に来るため、並び順に頼らず最大値を探す */
function newestPage(pages: CosensePage[]): CosensePage | undefined {
	return pages.reduce<CosensePage | undefined>(
		(newest, page) => (!newest || page.updated > newest.updated ? page : newest),
		undefined,
	);
}

/**
 * ページの更新を確認し、確認位置とイベントを記録する
 *
 * 確認位置は最終更新時刻（UNIX 秒）である。初回は既存のページを通知せず、確認位置だけを記録する。
 *
 * @param env Worker のバインディング
 * @param bridge イベントを保管する Durable Object
 * @throws Cosense API が失敗した場合。確認位置は進まないため、次回の Cron で再確認される
 */
export async function pollCosense(env: Env, bridge: DurableObjectStub<EventBridge>): Promise<void> {
	const cursor = await bridge.getProducerCursor(COSENSE_PRODUCER);
	const pages = await fetchPages(env);
	const newest = newestPage(pages);
	if (!newest) {
		return;
	}
	if (cursor === null) {
		await bridge.commitProducerPoll(COSENSE_PRODUCER, String(newest.updated), null);
		return;
	}

	const updatedPages = pages.filter((page) => page.updated > Number(cursor));
	if (updatedPages.length === 0) {
		return;
	}
	const fromOthers = updatedPages.filter((page) => page.lastUpdateUser?.id !== env.COSENSE_BOT_USER_ID);
	const newestFromOthers = newestPage(fromOthers);
	const input: EventInput | null = newestFromOthers
		? {
				kind: "cosense.page_updated",
				summary: `更新${fromOthers.length}件`,
				ref: newestFromOthers.id,
				data: { count: fromOthers.length },
			}
		: null;
	await bridge.commitProducerPoll(
		COSENSE_PRODUCER,
		String(newest.updated),
		input ? { topic: COSENSE_TOPIC, input } : null,
	);
}
