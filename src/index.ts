/**
 * doorbell Worker のエントリーポイント
 *
 * 「signal（認証なし・内容なし）」と「実データ（認証あり）」を分離して中継する。
 * 仕様は docs/design.md を参照すること。
 */
import { BRIDGE_NAME } from "./bridge-name.ts";
import { hasValidBearer, hasValidBearerHash, secretsMatch } from "./auth.ts";
import { pollCosense } from "./cosense.ts";
import { pollDiscord } from "./discord.ts";
import { EventBridge, type EventInput, type PollSource } from "./event-bridge.ts";
import { describePollError } from "./poll-error.ts";

export { EventBridge };

/** POST body のサイズ上限 */
const MAX_EVENT_BYTES = 4 * 1024;

type Bridge = DurableObjectStub<EventBridge>;

function getBridge(env: Env): Bridge {
	// 同じ Worker の Durable Object を名前で参照する設定では、cf の型生成がクラスの型を推論できない
	const namespace = env.EVENT_BRIDGE as DurableObjectNamespace<EventBridge>;
	return namespace.getByName(BRIDGE_NAME);
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
	const writeConfig = await getBridge(env).getTopicWriteConfig(topic);
	if (!writeConfig) {
		return new Response("Not Found", { status: 404 });
	}
	if (writeConfig.writeSecretHash === null || !(await hasValidBearerHash(request, writeConfig.writeSecretHash))) {
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
	const since = url.searchParams.get("since") ?? "";
	if (!/^\d+$/.test(since)) {
		return new Response("Bad Request", { status: 400 });
	}
	const page = await getBridge(env).readEvents(topic, Number(since));
	return page ? Response.json(page) : new Response("Not Found", { status: 404 });
}

async function handleGetSignal(env: Env, signalKey: string): Promise<Response> {
	if (!(await secretsMatch(signalKey, env.SIGNAL_KEY))) {
		return new Response("Not Found", { status: 404 });
	}
	const topics = await getBridge(env).getSignalTopics();
	return Response.json({ topics }, { headers: { "Cache-Control": "no-store" } });
}

/** 監視対象の種類に応じた producer で確認する */
function pollByType(env: Env, bridge: Bridge, source: PollSource): Promise<void> {
	switch (source.type) {
		case "discord":
			return pollDiscord(env, bridge, source);
		case "cosense":
			return pollCosense(env, bridge, source);
		default: {
			const exhaustive: never = source.type;
			throw new Error(`未対応の監視対象です: ${String(exhaustive)}`);
		}
	}
}

/**
 * 監視対象を1件確認し、結果を last_error へ反映する
 *
 * 書き込みの回数を抑えるため、last_error は値が変わった場合だけ書き込む。
 *
 * @throws 確認に失敗した場合。呼び出し側で他の監視対象の結果と集約する
 */
async function pollSource(env: Env, bridge: Bridge, source: PollSource): Promise<void> {
	const saveLastError = async (lastError: string | null): Promise<void> => {
		if (lastError !== source.lastError) {
			await bridge.recordSourceError(source.id, lastError);
		}
	};
	try {
		await pollByType(env, bridge, source);
	} catch (error) {
		await saveLastError(describePollError(error));
		throw error;
	}
	await saveLastError(null);
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
		// 1件の API 障害で他の監視対象の検知を止めないよう、すべて最後まで実行してから失敗を報告する
		const bridge = getBridge(env);
		const sources = await bridge.getPollSources();
		const results = await Promise.allSettled(sources.map((source) => pollSource(env, bridge, source)));
		const reasons = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (reasons.length > 0) {
			throw new AggregateError(reasons, "producer の確認に失敗しました");
		}
	},
} satisfies ExportedHandler<Env>;
