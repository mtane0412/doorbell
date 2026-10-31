/**
 * 監視対象の確認で起きた、記録してよい内容だけを持つエラー
 *
 * メッセージは sources.last_error に保存して管理ページに表示するため、
 * ステータスコード程度に留め、認証情報と応答本文を含めないこと。
 */
export class PollError extends Error {}
