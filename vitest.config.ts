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
					TOPICS: JSON.stringify([
						{ name: "discord-ietter", id: "topic-id-discord" },
						{ name: "mac-script", id: "topic-id-mac" },
					]),
					TOPIC_WRITE_SECRETS: JSON.stringify({ "mac-script": "test-write-secret" }),
					READ_TOKEN: "test-read-token",
					SIGNAL_KEY: "test-signal-key",
					DISCORD_BOT_TOKEN: "test-discord-bot-token",
					DISCORD_CHANNEL_ID: "1000",
					DISCORD_BOT_USER_ID: "9999",
				},
			},
		}),
	],
});
