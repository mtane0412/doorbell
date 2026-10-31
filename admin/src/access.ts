/**
 * Cloudflare Access が付与する JWT の検証
 *
 * Worker 全体を Access で保護した上で、Access を経由しないリクエストを Worker 側でも拒否する。
 */
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

export type AccessConfig = { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string };

const JWT_HEADER = "Cf-Access-Jwt-Assertion";
const CERTS_PATH = "/cdn-cgi/access/certs";
/** Access の JWT の署名アルゴリズム。指定しないと alg の差し替えを受け入れる余地が残る */
const ACCESS_ALGORITHM = "RS256";
/** JWT 自体に原因がある jose のエラー。これ以外は公開鍵の取得先の障害などとして扱う */
const INVALID_JWT_ERRORS = [
	errors.JOSEAlgNotAllowed,
	errors.JOSENotSupported,
	errors.JWKSNoMatchingKey,
	errors.JWSInvalid,
	errors.JWSSignatureVerificationFailed,
	errors.JWTClaimValidationFailed,
	errors.JWTExpired,
	errors.JWTInvalid,
];

/**
 * リクエストの JWT が、このアプリケーション向けの有効なものかを判定する
 *
 * 公開鍵の取得結果はリクエストをまたいで再利用しない。Workers では別のリクエストの I/O を待てないためである。
 *
 * @returns JWT がない、または不正なら false
 * @throws 設定が空の場合、または公開鍵を取得できない場合。どちらも JWT の誤りではなく障害として扱い、通さない
 */
export async function hasValidAccessJwt(request: Request, config: AccessConfig): Promise<boolean> {
	if (!config.ACCESS_TEAM_DOMAIN || !config.ACCESS_AUD) {
		throw new Error("ACCESS_TEAM_DOMAIN と ACCESS_AUD を設定してください");
	}
	const token = request.headers.get(JWT_HEADER);
	if (!token) {
		return false;
	}
	const keys = createRemoteJWKSet(new URL(CERTS_PATH, config.ACCESS_TEAM_DOMAIN));
	try {
		await jwtVerify(token, keys, {
			issuer: config.ACCESS_TEAM_DOMAIN,
			audience: config.ACCESS_AUD,
			algorithms: [ACCESS_ALGORITHM],
		});
		return true;
	} catch (error) {
		// JWT 自体の誤りだけを「不正な JWT」とする。JOSEError には公開鍵の取得の失敗も含まれるため、基底クラスでは判定しない
		if (INVALID_JWT_ERRORS.some((errorClass) => error instanceof errorClass)) {
			return false;
		}
		throw error;
	}
}
