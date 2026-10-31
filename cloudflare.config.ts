/**
 * doorbell Worker の Cloudflare 設定
 *
 * 値はすべてシークレットとして登録し、リポジトリに置かない。
 * TOPICS はトピック名と不透明IDの対応の唯一の定義であり、対応をリポジトリから読めないようシークレットとする。
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
			TOPICS: bindings.secret(),
			TOPIC_WRITE_SECRETS: bindings.secret(),
			READ_TOKEN: bindings.secret(),
			SIGNAL_KEY: bindings.secret(),
			DISCORD_BOT_TOKEN: bindings.secret(),
			DISCORD_CHANNEL_ID: bindings.secret(),
			DISCORD_BOT_USER_ID: bindings.secret(),
			COSENSE_PAT: bindings.secret(),
			COSENSE_PROJECT: bindings.secret(),
			COSENSE_BOT_USER_ID: bindings.secret(),
		},
	},
});
