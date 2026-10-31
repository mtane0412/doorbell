/**
 * 管理 Worker doorbell-admin のエントリーポイント
 *
 * 監視対象とトピックの設定を画面から変更する。設定と外部 API の確認は EventBridge が担い、
 * この Worker は認証と画面だけを担当する。Discord と Cosense のトークンは持たない。
 * すべてのリクエストで Cloudflare Access の JWT を、POST では Origin を検証する。
 * 仕様は docs/design.md の「管理ページ」を参照すること。
 */
import type { EventBridge, NewPollSource, OperationResult, SourceType, WriteSecretResult } from "../../src/event-bridge.ts";
import { BRIDGE_NAME } from "../../src/bridge-name.ts";
import { type AccessConfig, hasValidAccessJwt } from "./access.ts";
import { type Notice, renderPage } from "./page.ts";

type AdminEnv = AccessConfig & { EVENT_BRIDGE: DurableObjectNamespace };
type Bridge = DurableObjectStub<EventBridge>;

const SOURCE_TYPES: readonly SourceType[] = ["discord", "cosense"];

function getBridge(env: AdminEnv): Bridge {
	// 別の Worker の Durable Object は、バインディングの型からクラスを推論できない
	const namespace = env.EVENT_BRIDGE as DurableObjectNamespace<EventBridge>;
	return namespace.getByName(BRIDGE_NAME);
}

function plainResponse(body: string, status: number): Response {
	return new Response(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** 一覧の画面を返す。インラインスタイルだけを nonce で許可し、スクリプトは一切許可しない */
async function pageResponse(bridge: Bridge, status: number, notice?: Notice): Promise<Response> {
	const nonce = crypto.randomUUID();
	const html = renderPage(await bridge.getAdminOverview(), nonce, notice);
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Cache-Control": "no-store",
		},
	});
}

/** 操作の後は一覧へ戻す。再読み込みで同じ操作を再送しないためである */
function redirectToList(): Response {
	return new Response(null, { status: 303, headers: { Location: "/" } });
}

function operationResponse(bridge: Bridge, result: OperationResult): Promise<Response> | Response {
	return result.ok ? redirectToList() : pageResponse(bridge, 400, { kind: "error", message: result.error });
}

/** 発行したシークレットはこの応答にだけ載せる */
function secretResponse(bridge: Bridge, topic: string, result: WriteSecretResult): Promise<Response> {
	return result.ok
		? pageResponse(bridge, 200, { kind: "issued-secret", topic, writeSecret: result.writeSecret })
		: pageResponse(bridge, 400, { kind: "error", message: result.error });
}

function isSourceType(value: unknown): value is SourceType {
	return SOURCE_TYPES.some((type) => type === value);
}

/** 追加フォームの入力を解析する。不正なら null */
function parseNewSource(form: FormData): NewPollSource | null {
	const type = form.get("type");
	const target = form.get("target");
	const excludedUserId = form.get("excludedUserId");
	const topic = form.get("topic");
	if (
		!isSourceType(type) ||
		typeof target !== "string" ||
		typeof excludedUserId !== "string" ||
		typeof topic !== "string"
	) {
		return null;
	}
	return { type, target: target.trim(), excludedUserId: excludedUserId.trim(), topic: topic.trim() };
}

async function handleAddSource(request: Request, bridge: Bridge): Promise<Response> {
	const source = parseNewSource(await request.formData());
	if (!source) {
		return pageResponse(bridge, 400, { kind: "error", message: "入力項目が不足しています" });
	}
	return operationResponse(bridge, await bridge.addSource(source));
}

async function handleCreateTopic(request: Request, bridge: Bridge): Promise<Response> {
	const name = (await request.formData()).get("name");
	if (typeof name !== "string") {
		return pageResponse(bridge, 400, { kind: "error", message: "トピック名を入力してください" });
	}
	const topic = name.trim();
	return secretResponse(bridge, topic, await bridge.createExternalTopic(topic));
}

async function handleSourceAction(bridge: Bridge, sourceId: string, action: string): Promise<Response> {
	switch (action) {
		case "disable":
			await bridge.disableSource(sourceId);
			return redirectToList();
		case "resume":
			await bridge.resumeSource(sourceId);
			return redirectToList();
		case "delete":
			await bridge.removeSource(sourceId);
			return redirectToList();
		default:
			return plainResponse("Not Found", 404);
	}
}

async function handleTopicAction(bridge: Bridge, topic: string, action: string): Promise<Response> {
	switch (action) {
		case "rotate":
			return secretResponse(bridge, topic, await bridge.rotateWriteSecret(topic));
		case "delete":
			return operationResponse(bridge, await bridge.deleteExternalTopic(topic));
		default:
			return plainResponse("Not Found", 404);
	}
}

async function handlePost(request: Request, bridge: Bridge, url: URL): Promise<Response> {
	// Origin のない POST も拒否する。別のサイトのフォームから操作されないようにするためである
	if (request.headers.get("Origin") !== url.origin) {
		return plainResponse("Forbidden", 403);
	}
	const [, resource, key, action, ...rest] = url.pathname.split("/");
	if (rest.length > 0) {
		return plainResponse("Not Found", 404);
	}
	if (key === undefined && resource === "sources") {
		return handleAddSource(request, bridge);
	}
	if (key === undefined && resource === "topics") {
		return handleCreateTopic(request, bridge);
	}
	if (key && action && resource === "sources") {
		return handleSourceAction(bridge, decodeURIComponent(key), action);
	}
	if (key && action && resource === "topics") {
		return handleTopicAction(bridge, decodeURIComponent(key), action);
	}
	return plainResponse("Not Found", 404);
}

export default {
	async fetch(request: Request, env: AdminEnv): Promise<Response> {
		if (!(await hasValidAccessJwt(request, env))) {
			return plainResponse("Forbidden", 403);
		}
		const url = new URL(request.url);
		const bridge = getBridge(env);
		if (request.method === "POST") {
			return handlePost(request, bridge, url);
		}
		if (request.method === "GET" && url.pathname === "/") {
			return pageResponse(bridge, 200);
		}
		return plainResponse("Not Found", 404);
	},
} satisfies ExportedHandler<AdminEnv>;
