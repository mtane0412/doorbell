/**
 * シークレットとトークンの定数時間比較
 */

const BEARER_PREFIX = "Bearer ";
const encoder = new TextEncoder();

/**
 * 2つの文字列が等しいかを定数時間で判定する
 *
 * 長さの違いが処理時間に表れないよう、SHA-256 のハッシュ同士を比較する。
 *
 * @param actual リクエストから受け取った値
 * @param expected 設定されている正しい値
 * @throws expected が空の場合。設定漏れを「全員拒否」や「空文字で一致」として隠さず、設定不備として失敗させる
 */
export async function secretsMatch(actual: string, expected: string): Promise<boolean> {
	if (!expected) {
		throw new Error("比較対象のシークレットが設定されていません");
	}
	const [actualDigest, expectedDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(actual)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	return crypto.subtle.timingSafeEqual(actualDigest, expectedDigest);
}

/**
 * リクエストの Authorization: Bearer ヘッダーが正しい値かを判定する
 *
 * @param request 受け取ったリクエスト
 * @param expected 設定されている正しい値
 */
export async function hasValidBearer(request: Request, expected: string): Promise<boolean> {
	const header = request.headers.get("Authorization") ?? "";
	if (!header.startsWith(BEARER_PREFIX)) {
		return false;
	}
	return secretsMatch(header.slice(BEARER_PREFIX.length), expected);
}
