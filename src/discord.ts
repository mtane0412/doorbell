/**
 * Discord チャンネルの新着を REST で確認し、イベントとして記録する producer
 *
 * イベントには件数と最新メッセージIDだけを載せ、本文は載せない。
 * 自分のボットの投稿を除外し、エージェントの返信で起床が連鎖することを防ぐ。
 */
import type { EventBridge, EventInput, PollSource } from "./event-bridge.ts";
import { PollError } from "./poll-error.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";
/** Discord API が1回で返せる最大件数。超えた分は次回の Cron で取得する */
const DISCORD_PAGE_SIZE = 100;

type DiscordMessage = { id: string; author: { id: string } };

function isDiscordMessage(value: unknown): value is DiscordMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"author" in value &&
		typeof value.author === "object" &&
		value.author !== null &&
		"id" in value.author &&
		typeof value.author.id === "string"
	);
}

async function fetchMessages(env: Env, channelId: string, query: string): Promise<DiscordMessage[]> {
	const channel = encodeURIComponent(channelId);
	const response = await fetch(`${DISCORD_API_BASE}/channels/${channel}/messages?${query}`, {
		headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
	});
	if (!response.ok) {
		throw new PollError(`Discord API がステータス ${response.status} を返しました`);
	}
	const body: unknown = await response.json();
	if (!Array.isArray(body) || !body.every(isDiscordMessage)) {
		throw new PollError("Discord API の応答の形式が不正です");
	}
	return body;
}

/** スノーフレークIDは文字列のままだと桁数の違いで順序を誤るため、数値として比較する */
function newestMessage(messages: DiscordMessage[]): DiscordMessage | undefined {
	return messages.reduce<DiscordMessage | undefined>(
		(newest, message) => (!newest || BigInt(message.id) > BigInt(newest.id) ? message : newest),
		undefined,
	);
}

/**
 * チャンネルを読めることを API を1回呼んで確認する
 *
 * @throws チャンネルの指定の誤りや権限不足で API が失敗した場合
 */
export async function verifyDiscordChannel(env: Env, channelId: string): Promise<void> {
	await fetchMessages(env, channelId, "limit=1");
}

/**
 * 新着を確認し、確認位置とイベントを記録する
 *
 * 初回は過去の投稿を通知せず、最新メッセージIDだけを記録する。
 *
 * @param env Worker のバインディング
 * @param bridge イベントを保管する Durable Object
 * @param source 確認する監視対象。target はチャンネルIDである
 * @throws Discord API が失敗した場合。確認位置は進まないため、次回の Cron で再確認される
 */
export async function pollDiscord(
	env: Env,
	bridge: DurableObjectStub<EventBridge>,
	source: PollSource,
): Promise<void> {
	if (source.cursor === null) {
		const [latest] = await fetchMessages(env, source.target, "limit=1");
		if (latest) {
			await bridge.commitProducerPoll(source.id, latest.id, null);
		}
		return;
	}

	const messages = await fetchMessages(env, source.target, `limit=${DISCORD_PAGE_SIZE}&after=${source.cursor}`);
	const newest = newestMessage(messages);
	if (!newest) {
		return;
	}
	const fromOthers = messages.filter((message) => message.author.id !== source.excludedUserId);
	const newestFromOthers = newestMessage(fromOthers);
	const input: EventInput | null = newestFromOthers
		? {
				kind: "discord.message",
				summary: `新着${fromOthers.length}件`,
				ref: newestFromOthers.id,
				data: { count: fromOthers.length, channel_id: source.target },
			}
		: null;
	await bridge.commitProducerPoll(source.id, newest.id, input ? { topic: source.topic, input } : null);
}
