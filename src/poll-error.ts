/**
 * 監視対象の確認で起きた、記録してよい内容だけを持つエラー
 *
 * メッセージは sources.last_error に保存して管理ページに表示するため、
 * ステータスコード程度に留め、認証情報と応答本文を含めないこと。
 */
export class PollError extends Error {}

/** 内容を保証できないエラーの代わりに使う文言 */
const UNKNOWN_POLL_ERROR = "確認に失敗しました";

/** 記録・表示してよい文言を返す。PollError 以外のメッセージは内容を保証できないため使わない */
export function describePollError(error: unknown): string {
	return error instanceof PollError ? error.message : UNKNOWN_POLL_ERROR;
}
