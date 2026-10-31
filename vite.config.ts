/**
 * cf dev / cf build が使う Vite 設定
 */
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
});
