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
 * シークレットの SHA-256 ハッシュを16進文字列で返す
 *
 * 書き込みシークレットは Durable Object にこの値だけを保存する。
 */
export async function hashSecret(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Authorization: Bearer ヘッダーの値を返す。形式が違えば null */
function readBearer(request: Request): string | null {
	const header = request.headers.get("Authorization") ?? "";
	return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : null;
}

/**
 * リクエストの Authorization: Bearer ヘッダーが正しい値かを判定する
 *
 * @param request 受け取ったリクエスト
 * @param expected 設定されている正しい値
 */
export async function hasValidBearer(request: Request, expected: string): Promise<boolean> {
	const token = readBearer(request);
	return token !== null && secretsMatch(token, expected);
}

/**
 * リクエストの Authorization: Bearer ヘッダーの値が、保存済みのハッシュと一致するかを判定する
 *
 * @param request 受け取ったリクエスト
 * @param expectedHash hashSecret で計算して保存した値
 */
export async function hasValidBearerHash(request: Request, expectedHash: string): Promise<boolean> {
	const token = readBearer(request);
	return token !== null && secretsMatch(await hashSecret(token), expectedHash);
}
