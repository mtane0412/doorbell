/**
 * doorbell-admin Worker の振る舞いを検証するテスト
 *
 * docs/design.md の「管理ページ」の仕様に対応する。doorbell-admin は別の Worker だが、
 * バインディング名が同じであるため、テスト環境の本物の EventBridge に接続して検証する。
 * 外部 API と Cloudflare Access の公開鍵の fetch だけをモックする。
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../admin/src/index.ts";
import { renderPage } from "../admin/src/page.ts";
import adminConfigSource from "../admin/cloudflare.config.ts?raw";
import { getBridge, resetBridge } from "./helpers.ts";

const TEAM_DOMAIN = "https://tane-team.cloudflareaccess.com";
const AUDIENCE = "access-audience-tag";
const KEY_ID = "tane-key";
const ADMIN_ORIGIN = "https://doorbell-admin.test";
const adminEnv = { EVENT_BRIDGE: env.EVENT_BRIDGE, ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUDIENCE };

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let signingKey: SigningKey;
let unknownKey: SigningKey;
let publicJwk: Record<string, unknown>;

/** 正しい鍵・発行者・対象で署名した、有効な Access の JWT を作る */
function signToken(
	overrides: { key?: SigningKey; issuer?: string; audience?: string; expiresAt?: string } = {},
): Promise<string> {
	return new SignJWT({ email: "tane@example.jp" })
		.setProtectedHeader({ alg: "RS256", kid: KEY_ID })
		.setIssuer(overrides.issuer ?? TEAM_DOMAIN)
		.setAudience(overrides.audience ?? AUDIENCE)
		.setIssuedAt("-1h")
		.setExpirationTime(overrides.expiresAt ?? "1h")
		.sign(overrides.key ?? signingKey);
}

/** Access の公開鍵と外部 API に応答するモックを設定する */
function mockExternal(apiStatus = 200) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
			return Response.json({ keys: [publicJwk] });
		}
		if (apiStatus !== 200) {
			return new Response("応答本文の秘密", { status: apiStatus });
		}
		return url.startsWith("https://discord.com/") ? Response.json([]) : Response.json({ pages: [] });
	});
}

async function get(token?: string): Promise<Response> {
	return admin.fetch(
		new Request(`${ADMIN_ORIGIN}/`, { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} }),
		adminEnv,
	);
}

/** 正しい JWT と Origin でフォームを送信する */
async function post(path: string, fields: Record<string, string> = {}, origin: string | null = ADMIN_ORIGIN) {
	const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await signToken() };
	if (origin !== null) {
		headers["Origin"] = origin;
	}
	return admin.fetch(
		new Request(`${ADMIN_ORIGIN}${path}`, { method: "POST", headers, body: new URLSearchParams(fields) }),
		adminEnv,
	);
}

/** 発行された書き込みシークレットを HTML から取り出す */
function issuedSecret(html: string): string {
	const match = /<code id="issued-secret"[^>]*>([^<]+)<\/code>/.exec(html);
	if (!match?.[1]) {
		throw new Error("発行されたシークレットが画面にありません");
	}
	return match[1];
}

beforeAll(async () => {
	const pair = await generateKeyPair("RS256", { extractable: true });
	signingKey = pair.privateKey;
	publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" };
	unknownKey = (await generateKeyPair("RS256")).privateKey;
});
beforeEach(async () => {
	await resetBridge();
	mockExternal();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("Cloudflare Access の JWT の検証", () => {
	it("正しい JWT なら一覧を返す", async () => {
		const response = await get(await signToken());

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("discord-ietter");
	});

	it("JWT がなければ拒否し、内容を返さない", async () => {
		const response = await get();

		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain("discord-ietter");
	});

	it.each([
		["JWT の形式でない値", () => Promise.resolve("これはJWTではありません")],
		["未知の鍵で署名された JWT", () => signToken({ key: unknownKey })],
		["別の発行者の JWT", () => signToken({ issuer: "https://other-team.cloudflareaccess.com" })],
		["別のアプリケーション向けの JWT", () => signToken({ audience: "other-application" })],
		["期限切れの JWT", () => signToken({ expiresAt: "-1m" })],
		[
			"署名のない JWT",
			() => {
				const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
				const claims = { iss: TEAM_DOMAIN, aud: AUDIENCE, exp: 4_000_000_000 };
				return Promise.resolve(`${encode({ alg: "none", kid: KEY_ID })}.${encode(claims)}.`);
			},
		],
	])("%s なら拒否する", async (_label, makeToken) => {
		const response = await get(await makeToken());

		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain("discord-ietter");
	});

	it("POST でも JWT がなければ拒否し、変更しない", async () => {
		const response = await admin.fetch(
			new Request(`${ADMIN_ORIGIN}/topics`, {
				method: "POST",
				headers: { Origin: ADMIN_ORIGIN },
				body: new URLSearchParams({ name: "garden-sensor" }),
			}),
			adminEnv,
		);

		expect(response.status).toBe(403);
		const names = (await getBridge().getAdminOverview()).map((entry) => entry.name);
		expect(names).not.toContain("garden-sensor");
	});

	it("公開鍵を取得できないなら通さず、失敗にする", async () => {
		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("接続できません"));

		await expect(get(await signToken())).rejects.toThrow();
	});

	it.each([
		["HTTP エラーを返す", () => new Response("server error", { status: 500 })],
		["JSON でない応答を返す", () => new Response("これはJSONではありません")],
		["鍵の一覧の形をしていない応答を返す", () => Response.json({ keys: "鍵なし" })],
	])("公開鍵の取得先が %s なら、不正な JWT として扱わず失敗にする", async (_label, makeResponse) => {
		// 前提: JWT は正しいが、公開鍵の取得先に障害が起きている
		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => makeResponse());

		await expect(get(await signToken())).rejects.toThrow();
	});

	it.each([
		["ACCESS_TEAM_DOMAIN", { ...adminEnv, ACCESS_TEAM_DOMAIN: "" }],
		["ACCESS_AUD", { ...adminEnv, ACCESS_AUD: "" }],
	])("%s が未設定なら通さず、失敗にする", async (_label, misconfiguredEnv) => {
		const request = new Request(`${ADMIN_ORIGIN}/`, {
			headers: { "Cf-Access-Jwt-Assertion": await signToken() },
		});

		await expect(admin.fetch(request, misconfiguredEnv)).rejects.toThrow();
	});
});

describe("POST の Origin の検証", () => {
	it.each([
		["別のオリジン", "https://evil.example.com"],
		["Origin なし", null],
	])("%s からの POST は拒否し、変更しない", async (_label, origin) => {
		const response = await post("/topics", { name: "garden-sensor" }, origin);

		expect(response.status).toBe(403);
		const names = (await getBridge().getAdminOverview()).map((entry) => entry.name);
		expect(names).not.toContain("garden-sensor");
	});
});

describe("画面", () => {
	it("CSP などのセキュリティヘッダーを設定し、キャッシュさせない", async () => {
		const response = await get(await signToken());

		const csp = response.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("form-action 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		// no-referrer にするとブラウザはフォームの POST で Origin: null を送り、Origin の検証で自分の操作を拒否してしまう
		expect(response.headers.get("referrer-policy")).toBe("same-origin");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("名前・種類・監視先・opaque ID・連番・直近のエラーを表示する", async () => {
		await getBridge().recordSourceError("discord", "Discord API がステータス 429 を返しました");

		const html = await (await get(await signToken())).text();

		expect(html).toContain("discord-ietter");
		expect(html).toContain("discord");
		expect(html).toContain("1000");
		expect(html).toContain("topic-id-discord");
		expect(html).toContain("ステータス 429");
	});

	it("保存された値を HTML エスケープして表示する", async () => {
		await getBridge().recordSourceError("discord", `<script>alert("侵入")</script>`);

		const html = await (await get(await signToken())).text();

		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("書き込みシークレットのハッシュを表示しない", async () => {
		const hash = await runInDurableObject(getBridge(), (_instance, state) =>
			state.storage.sql
				.exec<{ write_secret_hash: string }>("SELECT write_secret_hash FROM topics WHERE name = 'mac-script'")
				.one().write_secret_hash,
		);

		expect(await (await get(await signToken())).text()).not.toContain(hash);
	});

	it("スクリプトは応答ごとの nonce でだけ許可する", async () => {
		const response = await get(await signToken());

		const csp = response.headers.get("content-security-policy") ?? "";
		const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
		expect(nonce).toBeDefined();
		expect(csp).not.toContain("unsafe-inline");
		expect(await response.text()).toContain(`<script nonce="${nonce}">`);
	});

	it("最終更新を相対時刻で表示し、元の時刻を属性に残す", () => {
		const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
		const topic = {
			name: "mac-script",
			opaqueId: "topic-id-mac",
			seq: 4,
			updatedAt: threeHoursAgo,
			hasWriteSecret: true,
			source: null,
		};

		const html = renderPage([topic], "test-nonce");

		expect(html).toContain("3時間前");
		expect(html).toContain(`datetime="${threeHoursAgo}"`);
	});

	it("監視対象ごとに除外するユーザーIDを表示する", async () => {
		const html = await (await get(await signToken())).text();

		expect(html).toContain("user-id-tanehouse");
	});

	it("監視対象がなければ、空であることを表示する", async () => {
		await post("/sources/discord/delete");
		await post("/sources/cosense/delete");

		const html = await (await get(await signToken())).text();

		expect(html).toContain("監視対象はまだありません");
	});
});

describe("除外するユーザーIDの自動入力", () => {
	/** 指定した種類の追加フォームの HTML を取り出す */
	function addForm(html: string, type: string): string {
		const forms = html.match(/<form[^>]*action="\/sources".*?<\/form>/gs) ?? [];
		const form = forms.find((candidate) => candidate.includes(`name="type" value="${type}"`));
		if (!form) {
			throw new Error(`${type} の追加フォームが画面にありません`);
		}
		return form;
	}

	/** 除外するユーザーIDの入力欄の HTML を取り出す */
	function excludedUserInput(form: string): string {
		const input = /<input[^>]*name="excludedUserId"[^>]*>/.exec(form)?.[0];
		if (!input) {
			throw new Error("除外するユーザーIDの入力欄がありません");
		}
		return input;
	}

	it("種類ごとに、登録済みの監視対象の値を入力済みにする", async () => {
		// 前提: Discord は 9999、Cosense は user-id-tanehouse を除外している
		const html = await (await get(await signToken())).text();

		expect(excludedUserInput(addForm(html, "discord"))).toContain('value="9999"');
		expect(excludedUserInput(addForm(html, "cosense"))).toContain('value="user-id-tanehouse"');
	});

	it("同じ種類が複数あれば、最後に追加した監視対象の値を使う", async () => {
		await post("/sources", { type: "discord", target: "2000", excludedUserId: "8888", topic: "discord-garden" });

		const html = await (await get(await signToken())).text();

		expect(excludedUserInput(addForm(html, "discord"))).toContain('value="8888"');
		expect(excludedUserInput(addForm(html, "cosense"))).toContain('value="user-id-tanehouse"');
	});

	it("その種類の監視対象がなければ、空のままにする", async () => {
		await post("/sources/discord/delete");

		const html = await (await get(await signToken())).text();

		expect(excludedUserInput(addForm(html, "discord"))).not.toContain("value=");
		expect(excludedUserInput(addForm(html, "cosense"))).toContain('value="user-id-tanehouse"');
	});

	it("入力済みの値を HTML エスケープする", async () => {
		await post("/sources", {
			type: "discord",
			target: "2000",
			excludedUserId: `"><script>alert("侵入")</script>`,
			topic: "discord-garden",
		});

		const html = await (await get(await signToken())).text();

		expect(html).not.toContain(`<script>alert`);
	});

	it("追加に失敗したら、入力を残したままダイアログを開いて理由を表示する", async () => {
		vi.restoreAllMocks();
		mockExternal(403);

		const response = await post("/sources", {
			type: "cosense",
			target: "tanehouse-garden",
			excludedUserId: "user-id-garden",
			topic: "cosense-garden",
		});

		const html = await response.text();
		const form = addForm(html, "cosense");
		expect(response.status).toBe(400);
		expect(form).toContain('value="tanehouse-garden"');
		expect(form).toContain('value="user-id-garden"');
		expect(form).toContain('value="cosense-garden"');
		expect(html).toMatch(/<dialog[^>]*id="add-source"[^>]*\sopen/);
		expect(/<dialog[^>]*id="add-source".*?<\/dialog>/s.exec(html)?.[0]).toContain("403");
	});
});

describe("設定", () => {
	it("doorbell-admin の設定に Discord と Cosense のトークンがない", () => {
		expect(adminConfigSource).toContain("EVENT_BRIDGE:");
		expect(adminConfigSource).not.toMatch(/^\s*DISCORD_BOT_TOKEN:/m);
		expect(adminConfigSource).not.toMatch(/^\s*COSENSE_PAT:/m);
	});
});

describe("操作", () => {
	it("監視対象を追加すると一覧へ戻り、一覧に現れる", async () => {
		const response = await post("/sources", {
			type: "discord",
			target: "2000",
			excludedUserId: "9999",
			topic: "discord-garden",
		});

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/");
		expect(await (await get(await signToken())).text()).toContain("discord-garden");
	});

	it("API の確認に失敗したら理由を表示し、保存しない", async () => {
		vi.restoreAllMocks();
		mockExternal(403);

		const response = await post("/sources", {
			type: "discord",
			target: "2000",
			excludedUserId: "9999",
			topic: "discord-garden",
		});

		const html = await response.text();
		expect(response.status).toBe(400);
		expect(html).toContain("403");
		expect(html).not.toContain("応答本文の秘密");
		const names = (await getBridge().getAdminOverview()).map((entry) => entry.name);
		expect(names).not.toContain("discord-garden");
	});

	it.each([
		["未対応の種類", { type: "slack", target: "2000", excludedUserId: "9999", topic: "slack-garden" }],
		["必須項目の欠け", { type: "discord", target: "2000" }],
	])("%s の追加は 400 を返す", async (_label, fields: Record<string, string>) => {
		expect((await post("/sources", fields)).status).toBe(400);
	});

	it("監視対象を無効化し、再開できる", async () => {
		expect((await post("/sources/discord/disable")).status).toBe(303);
		let sources = await getBridge().getPollSources();
		expect(sources.map((source) => source.id)).toEqual(["cosense"]);

		expect((await post("/sources/discord/resume")).status).toBe(303);
		sources = await getBridge().getPollSources();
		// 再開すると ID は振り直されるため、トピック名で確認対象に戻ったことを確かめる
		expect(sources.map((source) => source.topic)).toContain("discord-ietter");
	});

	it("監視対象を削除できる", async () => {
		expect((await post("/sources/discord/delete")).status).toBe(303);

		const names = (await getBridge().getAdminOverview()).map((entry) => entry.name);
		expect(names).not.toContain("discord-ietter");
	});

	it("外部トピックを作成すると発行時だけシークレットを表示する", async () => {
		const response = await post("/topics", { name: "garden-sensor" });

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const secret = issuedSecret(await response.text());
		expect(await (await get(await signToken())).text()).not.toContain(secret);
	});

	it("シークレットを再発行すると新しい値を表示する", async () => {
		const first = issuedSecret(await (await post("/topics", { name: "garden-sensor" })).text());

		const second = issuedSecret(await (await post("/topics/garden-sensor/rotate")).text());

		expect(second).not.toBe(first);
	});

	it("外部トピックを削除できるが、監視対象のトピックは削除できない", async () => {
		expect((await post("/topics/mac-script/delete")).status).toBe(303);
		expect((await post("/topics/discord-ietter/delete")).status).toBe(400);

		const names = (await getBridge().getAdminOverview()).map((entry) => entry.name);
		expect(names).toEqual(["discord-ietter", "cosense"]);
	});

	it.each([
		["監視対象の削除", "/sources/discord/delete"],
		["外部トピックの削除", "/topics/mac-script/delete"],
		["シークレットの再発行", "/topics/mac-script/rotate"],
	])("%s のフォームは確認ダイアログの中にだけある", async (_label, path) => {
		const html = await (await get(await signToken())).text();

		// 前提: 一覧の行のボタンはダイアログを開くだけで、送信はダイアログの中で行う
		const dialogs = html.match(/<dialog.*?<\/dialog>/gs) ?? [];
		expect(dialogs.some((dialog) => dialog.includes(`action="${path}"`))).toBe(true);
		const outsideDialogs = html.replace(/<dialog.*?<\/dialog>/gs, "");
		expect(outsideDialogs).not.toContain(`action="${path}"`);
	});

	it.each([
		["GET", "/sources"],
		["POST", "/unknown"],
		["POST", "/sources/discord/unknown"],
		["POST", "/topics/mac-script/unknown"],
	])("%s %s は 404 を返す", async (method, path) => {
		const headers = { "Cf-Access-Jwt-Assertion": await signToken(), Origin: ADMIN_ORIGIN };
		const response = await admin.fetch(new Request(`${ADMIN_ORIGIN}${path}`, { method, headers }), adminEnv);

		expect(response.status).toBe(404);
	});
});
