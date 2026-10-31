/**
 * doorbell Worker のエントリーポイント
 *
 * 「signal（認証なし・内容なし）」と「実データ（認証あり）」を分離して中継する。
 * 仕様は docs/design.md を参照すること。
 */
import { hasValidBearer, secretsMatch } from "./auth.ts";
import { parseTopics, parseWriteSecrets } from "./config.ts";
import { pollCosense } from "./cosense.ts";
import { pollDiscord } from "./discord.ts";
import { EventBridge, type EventInput } from "./event-bridge.ts";

export { EventBridge };

/** POST body のサイズ上限 */
const MAX_EVENT_BYTES = 4 * 1024;
/** Durable Object は全体で1個だけ使う */
const BRIDGE_NAME = "main";

function getBridge(env: Env) {
	// 同じ Worker の Durable Object を名前で参照する設定では、cf の型生成がクラスの型を推論できない
	const namespace = env.EVENT_BRIDGE as DurableObjectNamespace<EventBridge>;
	return namespace.getByName(BRIDGE_NAME);
}

function isTopicRegistered(env: Env, name: string): boolean {
	return parseTopics(env.TOPICS).some((topic) => topic.name === name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POST body をイベントへ解析する。不正なら null */
function parseEventInput(body: ArrayBuffer): EventInput | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body));
	} catch {
		// body の JSON 不正は呼び出し側の誤りであり、400 として返すため例外を伝播しない
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}
	const { kind, summary, ref, data } = parsed;
	if (typeof kind !== "string" || kind === "" || typeof summary !== "string" || summary === "") {
		return null;
	}
	if ((ref !== undefined && typeof ref !== "string") || (data !== undefined && !isRecord(data))) {
		return null;
	}
	return { kind, summary, ...(ref === undefined ? {} : { ref }), ...(data === undefined ? {} : { data }) };
}

async function handlePostEvent(request: Request, env: Env, topic: string): Promise<Response> {
	if (!isTopicRegistered(env, topic)) {
		return new Response("Not Found", { status: 404 });
	}
	const secret = parseWriteSecrets(env.TOPIC_WRITE_SECRETS).get(topic);
	if (!secret || !(await hasValidBearer(request, secret))) {
		return new Response("Unauthorized", { status: 401 });
	}
	const body = await request.arrayBuffer();
	if (body.byteLength > MAX_EVENT_BYTES) {
		return new Response("Payload Too Large", { status: 413 });
	}
	const input = parseEventInput(body);
	if (!input) {
		return new Response("Bad Request", { status: 400 });
	}
	const seq = await getBridge(env).appendEvent(topic, input);
	return Response.json({ seq }, { status: 201 });
}

async function handleGetEvents(request: Request, env: Env, topic: string, url: URL): Promise<Response> {
	if (!(await hasValidBearer(request, env.READ_TOKEN))) {
		return new Response("Unauthorized", { status: 401 });
	}
	if (!isTopicRegistered(env, topic)) {
		return new Response("Not Found", { status: 404 });
	}
	const since = url.searchParams.get("since") ?? "";
	if (!/^\d+$/.test(since)) {
		return new Response("Bad Request", { status: 400 });
	}
	return Response.json(await getBridge(env).readEvents(topic, Number(since)));
}

async function handleGetSignal(env: Env, signalKey: string): Promise<Response> {
	if (!(await secretsMatch(signalKey, env.SIGNAL_KEY))) {
		return new Response("Not Found", { status: 404 });
	}
	const states = new Map(
		(await getBridge(env).getTopicStates()).map((state) => [state.topic, state]),
	);
	// トピック名は公開しない。イベントが一度もないトピックも連番0として返す
	const topics = parseTopics(env.TOPICS).map(({ name, id }) => {
		const state = states.get(name);
		return { id, seq: state?.seq ?? 0, updated_at: state?.updatedAt ?? null };
	});
	return Response.json({ topics }, { headers: { "Cache-Control": "no-store" } });
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const [, resource, key, ...rest] = url.pathname.split("/");
		if (key && rest.length === 0) {
			if (resource === "events" && request.method === "POST") {
				return handlePostEvent(request, env, key);
			}
			if (resource === "events" && request.method === "GET") {
				return handleGetEvents(request, env, key, url);
			}
			if (resource === "signal" && request.method === "GET") {
				return handleGetSignal(env, key);
			}
		}
		return new Response("Not Found", { status: 404 });
	},

	async scheduled(_controller, env) {
		// 片方の API 障害でもう片方の検知を止めないよう、両方を最後まで実行してから失敗を報告する
		const bridge = getBridge(env);
		const results = await Promise.allSettled([pollDiscord(env, bridge), pollCosense(env, bridge)]);
		const reasons = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (reasons.length > 0) {
			throw new AggregateError(reasons, "producer の確認に失敗しました");
		}
	},
} satisfies ExportedHandler<Env>;
