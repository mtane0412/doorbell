/**
 * doorbell-admin Worker の Cloudflare 設定
 *
 * 別の Worker である doorbell の EventBridge だけをバインディングとして持つ。
 * DISCORD_BOT_TOKEN と COSENSE_PAT は持たない。管理ページの侵害時にトークンが漏れないようにするためである。
 * ACCESS_* は認証情報ではないが、リポジトリに置かないようシークレットとする。
 */
import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "doorbell-admin",
		compatibilityDate: "2026-10-06",
		entrypoint,
		env: {
			EVENT_BRIDGE: bindings.durableObject({ worker: "doorbell", exportName: "EventBridge" }),
			ACCESS_TEAM_DOMAIN: bindings.secret(),
			ACCESS_AUD: bindings.secret(),
		},
	},
});
