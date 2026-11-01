/**
 * Workers ランタイム上でテストを実行する Vitest 設定
 *
 * Vitest プラグインは cloudflare.config.ts を読めないため、テストに必要なバインディングをここで定義する。
 * 値はすべてテスト専用のダミーであり、本番のシークレットではない。
 */
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			miniflare: {
				compatibilityDate: "2026-10-06",
				durableObjects: {
					EVENT_BRIDGE: { className: "EventBridge", useSQLite: true },
				},
				bindings: {
					READ_TOKEN: "test-read-token",
					SIGNAL_KEY: "test-signal-key",
					DISCORD_BOT_TOKEN: "test-discord-bot-token",
					COSENSE_PAT: "test-cosense-pat",
				},
			},
		}),
	],
});
