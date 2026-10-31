/**
 * 管理ページの HTML の生成
 *
 * フレームワークと JavaScript を使わず、サーバーで生成する HTML とフォームだけで構成する。
 * 埋め込む値はすべて escapeHtml を通すこと。
 */
import type { AdminTopic } from "../../src/event-bridge.ts";

/** 一覧の上に表示する操作の結果 */
export type Notice =
	| { kind: "error"; message: string }
	| { kind: "issued-secret"; topic: string; writeSecret: string };

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** 1つのボタンだけのフォーム。confirmLabel を渡すと、チェックを入れるまで送信できない */
function actionForm(path: string, buttonLabel: string, confirmLabel?: string): string {
	const confirmation = confirmLabel
		? `<label class="confirm"><input type="checkbox" required> ${escapeHtml(confirmLabel)}</label>`
		: "";
	return `<form method="post" action="${escapeHtml(path)}">${confirmation}<button type="submit">${escapeHtml(buttonLabel)}</button></form>`;
}

function renderNotice(notice: Notice | undefined): string {
	if (!notice) {
		return "";
	}
	if (notice.kind === "error") {
		return `<p class="notice error" role="alert">${escapeHtml(notice.message)}</p>`;
	}
	return `<section class="notice" role="status">
		<h2>${escapeHtml(notice.topic)} の書き込みシークレット</h2>
		<p>この値は今だけ表示され、再表示できません。producer に設定してください。</p>
		<code id="issued-secret" class="copyable">${escapeHtml(notice.writeSecret)}</code>
	</section>`;
}

function renderSourceRow(topic: AdminTopic, source: NonNullable<AdminTopic["source"]>): string {
	const id = encodeURIComponent(source.id);
	const toggle = source.enabled
		? actionForm(`/sources/${id}/disable`, "無効化")
		: actionForm(`/sources/${id}/resume`, "再開");
	return `<tr>
		<td>${escapeHtml(topic.name)}</td>
		<td>${escapeHtml(source.type)}</td>
		<td>${escapeHtml(source.target)}</td>
		<td><code class="copyable">${escapeHtml(topic.opaqueId)}</code></td>
		<td>${topic.seq}</td>
		<td>${escapeHtml(topic.updatedAt ?? "なし")}</td>
		<td>${source.enabled ? "有効" : "無効"}</td>
		<td>${escapeHtml(source.lastError ?? "なし")}</td>
		<td class="actions">${toggle}${actionForm(`/sources/${id}/delete`, "削除", "削除を確認しました")}</td>
	</tr>`;
}

function renderExternalRow(topic: AdminTopic): string {
	const name = encodeURIComponent(topic.name);
	return `<tr>
		<td>${escapeHtml(topic.name)}</td>
		<td><code class="copyable">${escapeHtml(topic.opaqueId)}</code></td>
		<td>${topic.seq}</td>
		<td>${escapeHtml(topic.updatedAt ?? "なし")}</td>
		<td>${topic.hasWriteSecret ? "あり" : "なし"}</td>
		<td class="actions">${actionForm(`/topics/${name}/rotate`, "シークレットを再発行", "古い値の失効を確認しました")}${actionForm(`/topics/${name}/delete`, "削除", "削除を確認しました")}</td>
	</tr>`;
}

/**
 * 管理ページ全体を生成する
 *
 * @param topics 一覧に表示するトピック
 * @param nonce CSP で許可するインラインスタイルの nonce
 * @param notice 一覧の上に表示する操作の結果
 */
export function renderPage(topics: AdminTopic[], nonce: string, notice?: Notice): string {
	const sourceRows = topics.flatMap((topic) => (topic.source ? [renderSourceRow(topic, topic.source)] : []));
	const externalRows = topics.flatMap((topic) => (topic.source ? [] : [renderExternalRow(topic)]));
	return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>doorbell 管理</title>
<style nonce="${escapeHtml(nonce)}">
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0 auto; max-width: 72rem; padding: 1rem; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #8884; padding: .5rem; text-align: left; vertical-align: top; }
.copyable { user-select: all; word-break: break-all; }
.actions form { margin-bottom: .5rem; }
.confirm { display: block; font-size: .875rem; margin-bottom: .25rem; }
.notice { border: 1px solid #888; border-radius: .25rem; padding: .75rem; }
.error { border-color: #c33; }
.add-form { display: grid; gap: .5rem; max-width: 24rem; }
.add-form label { display: grid; gap: .125rem; }
</style>
</head>
<body>
<h1>doorbell 管理</h1>
${renderNotice(notice)}
<h2>監視対象</h2>
<div class="table-wrap"><table>
<thead><tr><th>トピック</th><th>種類</th><th>監視先</th><th>opaque ID</th><th>連番</th><th>最終更新</th><th>状態</th><th>直近のエラー</th><th>操作</th></tr></thead>
<tbody>${sourceRows.join("")}</tbody>
</table></div>
<h3>監視対象を追加</h3>
<form class="add-form" method="post" action="/sources">
<label>種類 <select name="type" required><option value="discord">Discord</option><option value="cosense">Cosense</option></select></label>
<label>監視先（チャンネルID またはプロジェクト名）<input name="target" required></label>
<label>除外するユーザーID（自分のボット）<input name="excludedUserId" required></label>
<label>トピック名 <input name="topic" required pattern="[a-z0-9][a-z0-9\\-]{0,63}"></label>
<button type="submit">追加</button>
</form>
<h2>外部トピック</h2>
<div class="table-wrap"><table>
<thead><tr><th>トピック</th><th>opaque ID</th><th>連番</th><th>最終更新</th><th>シークレット</th><th>操作</th></tr></thead>
<tbody>${externalRows.join("")}</tbody>
</table></div>
<h3>外部トピックを作成</h3>
<form class="add-form" method="post" action="/topics">
<label>トピック名 <input name="name" required pattern="[a-z0-9][a-z0-9\\-]{0,63}"></label>
<button type="submit">作成</button>
</form>
</body>
</html>`;
}
