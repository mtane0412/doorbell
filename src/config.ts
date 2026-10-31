/**
 * シークレットに JSON で登録するトピック設定の解析
 *
 * 不正な設定は即座に例外とし、暗黙の既定値を使わない。
 */

/** 登録済みトピック。name は認証付きの経路だけで使い、id だけを公開の /signal に出す */
export type Topic = { name: string; id: string };

function isTopic(value: unknown): value is Topic {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		value.name !== "" &&
		"id" in value &&
		typeof value.id === "string" &&
		value.id !== ""
	);
}

/**
 * TOPICS シークレットを解析する
 *
 * @param raw `[{"name":"discord-ietter","id":"推測困難なID"}]` 形式の JSON 文字列
 * @throws 形式が不正な場合
 */
export function parseTopics(raw: string): Topic[] {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed) || !parsed.every(isTopic)) {
		throw new Error("TOPICS の形式が不正です");
	}
	return parsed;
}

/**
 * TOPIC_WRITE_SECRETS シークレットを解析する
 *
 * Worker 内蔵の生産者しか使わないトピックは登録しない。登録がなければ外部から書き込めない。
 *
 * @param raw `{"トピック名":"シークレット"}` 形式の JSON 文字列
 * @throws 形式が不正な場合
 */
export function parseWriteSecrets(raw: string): Map<string, string> {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("TOPIC_WRITE_SECRETS の形式が不正です");
	}
	const entries = Object.entries(parsed);
	const secrets = new Map<string, string>();
	for (const [topic, secret] of entries) {
		if (typeof secret !== "string" || secret === "") {
			throw new Error("TOPIC_WRITE_SECRETS の形式が不正です");
		}
		secrets.set(topic, secret);
	}
	return secrets;
}
