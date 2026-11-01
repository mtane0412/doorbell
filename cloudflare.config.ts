/**
 * doorbell Worker の Cloudflare 設定
 *
 * 認証情報はシークレットとして登録し、リポジトリに置かない。
 * トピックと監視対象の設定は Durable Object に保管し、管理ページ doorbell-admin から変更する。
 */
import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const WORKER_NAME = "doorbell";
/** Discord と Cosense を確認する Cron の実行間隔（docs/design.md の決定事項） */
const POLL_SCHEDULE = "*/5 * * * *";

export default defineConfig({
	worker: {
		name: WORKER_NAME,
		compatibilityDate: "2026-10-06",
		entrypoint,
		exports: {
			EventBridge: exports.durableObject({ storage: "sqlite" }),
		},
		triggers: [triggers.scheduled({ schedule: POLL_SCHEDULE })],
		env: {
			EVENT_BRIDGE: bindings.durableObject({ worker: WORKER_NAME, exportName: "EventBridge" }),
			READ_TOKEN: bindings.secret(),
			SIGNAL_KEY: bindings.secret(),
			DISCORD_BOT_TOKEN: bindings.secret(),
			COSENSE_PAT: bindings.secret(),
		},
	},
});
