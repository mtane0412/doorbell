/**
 * ESLint 設定（TypeScript の推奨ルールを適用する）
 */
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["node_modules/", "dist/", ".cloudflare/", ".wrangler/"] },
	tseslint.configs.recommended,
	{
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		},
	},
);
