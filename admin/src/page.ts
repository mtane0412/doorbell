/**
 * 管理ページの HTML の生成
 *
 * フレームワークを使わず、サーバーで生成する HTML とフォームで構成する。
 * すべての操作はフォームの POST で完結し、ダイアログはブラウザ標準の command 属性で開く。
 * スクリプトが担当するのは、キーボード操作とクリップボードへのコピーだけである。
 * 埋め込む値はすべて escapeHtml を通すこと。
 */
import type { AdminTopic, NewPollSource, SourceType } from "../../src/event-bridge.ts";

/** 一覧の上に表示する操作の結果。draft は監視対象の追加に失敗したときの入力で、ダイアログに復元する */
export type Notice =
	| { kind: "error"; message: string; draft?: NewPollSource }
	| { kind: "issued-secret"; topic: string; writeSecret: string };

type AdminSource = NonNullable<AdminTopic["source"]>;

const MS_PER_MINUTE = 60 * 1000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** 追加ダイアログの種類ごとの文言 */
const SOURCE_TYPE_FORMS: readonly {
	type: SourceType;
	label: string;
	targetLabel: string;
	targetAttributes: string;
	excludedUserHint: string;
	topicPlaceholder: string;
}[] = [
	{
		type: "discord",
		label: "Discord",
		targetLabel: "チャンネルID",
		targetAttributes: 'inputmode="numeric" pattern="\\d+"',
		excludedUserHint: "このユーザーの投稿では通知しません。",
		topicPlaceholder: "discord-general",
	},
	{
		type: "cosense",
		label: "Cosense",
		targetLabel: "プロジェクト名",
		targetAttributes: "",
		excludedUserHint: "このユーザーの更新では通知しません。",
		topicPlaceholder: "cosense-notes",
	},
];

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** 値があるときだけ value 属性を出す。空の入力欄に value="" を残さないためである */
function valueAttribute(value: string | undefined): string {
	return value ? ` value="${escapeHtml(value)}"` : "";
}

/** ISO 8601 の時刻を「3時間前」の形にする。未来の時刻は時計のずれとして「たった今」とする */
function formatRelativeTime(isoTime: string): string {
	const minutes = Math.floor((Date.now() - new Date(isoTime).getTime()) / MS_PER_MINUTE);
	if (minutes < 1) {
		return "たった今";
	}
	if (minutes < MINUTES_PER_HOUR) {
		return `${minutes}分前`;
	}
	const hours = Math.floor(minutes / MINUTES_PER_HOUR);
	return hours < HOURS_PER_DAY ? `${hours}時間前` : `${Math.floor(hours / HOURS_PER_DAY)}日前`;
}

function renderUpdatedAt(updatedAt: string | null): string {
	if (updatedAt === null) {
		return `<span class="time">更新なし</span>`;
	}
	const iso = escapeHtml(updatedAt);
	return `<time class="time" datetime="${iso}" title="${iso}">${escapeHtml(formatRelativeTime(updatedAt))}</time>`;
}

function renderCopyableId(opaqueId: string): string {
	const id = escapeHtml(opaqueId);
	return `<span class="id"><code class="copyable" title="opaque ID">${id}</code><button type="button" class="ghost tiny" data-copy="${id}" data-key="y" title="opaque ID をコピー（Y）">コピー</button></span>`;
}

/** 1つのボタンだけのフォーム。元に戻せる操作に使う */
function actionForm(path: string, label: string, key: string): string {
	return `<form method="post" action="${escapeHtml(path)}"><button type="submit" class="ghost" data-key="${key}" title="${escapeHtml(label)}（${key.toUpperCase()}）">${escapeHtml(label)}</button></form>`;
}

/** 元に戻せない操作の、ダイアログを開くボタンと確認ダイアログ */
function confirmAction(options: {
	dialogId: string;
	path: string;
	buttonLabel: string;
	key: string;
	keyHint: string;
	title: string;
	description: string;
	danger: boolean;
}): string {
	const dialogId = escapeHtml(options.dialogId);
	const buttonLabel = escapeHtml(options.buttonLabel);
	return `<button type="button" class="ghost" commandfor="${dialogId}" command="show-modal" data-key="${options.key}" title="${buttonLabel}（${options.keyHint}）">${buttonLabel}</button>
	<dialog id="${dialogId}" closedby="any" aria-labelledby="${dialogId}-title">
		<h2 id="${dialogId}-title">${escapeHtml(options.title)}</h2>
		<p class="dialog-text">${escapeHtml(options.description)}</p>
		<form method="post" action="${escapeHtml(options.path)}" class="dialog-actions">
			<button type="button" commandfor="${dialogId}" command="close">キャンセル</button>
			<button type="submit" class="${options.danger ? "danger" : "primary"}" autofocus>${buttonLabel}</button>
		</form>
	</dialog>`;
}

function statusOf(source: AdminSource): { className: string; label: string } {
	if (!source.enabled) {
		return { className: "paused", label: "無効" };
	}
	return source.lastError === null ? { className: "active", label: "有効" } : { className: "failing", label: "エラーあり" };
}

function renderSourceRow(topic: AdminTopic, source: AdminSource): string {
	const id = encodeURIComponent(source.id);
	const status = statusOf(source);
	const toggle = source.enabled
		? actionForm(`/sources/${id}/disable`, "無効化", "e")
		: actionForm(`/sources/${id}/resume`, "再開", "e");
	const error = source.lastError
		? `<p class="row-error">${escapeHtml(source.lastError)}</p>`
		: "";
	return `<li class="row${source.enabled ? "" : " is-paused"}" tabindex="0">
		<span class="status ${status.className}" role="img" aria-label="${status.label}" title="${status.label}"></span>
		<div class="cell">
			<span class="name">${escapeHtml(topic.name)}</span>
			${renderCopyableId(topic.opaqueId)}
		</div>
		<div class="cell">
			<span class="target"><span class="chip">${escapeHtml(source.type)}</span> ${escapeHtml(source.target)}</span>
			<span class="meta">除外するユーザー ${escapeHtml(source.excludedUserId)}</span>
		</div>
		<span class="seq" title="連番">#${topic.seq}</span>
		${renderUpdatedAt(topic.updatedAt)}
		${error}
		<div class="actions">${toggle}${confirmAction({
			dialogId: `delete-source-${source.id}`,
			path: `/sources/${id}/delete`,
			buttonLabel: "削除",
			key: "Backspace",
			keyHint: "Backspace",
			title: `${topic.name} を削除しますか`,
			description: "監視を止めてトピックも削除します。同じトピック名は再利用できません。",
			danger: true,
		})}</div>
	</li>`;
}

function renderExternalRow(topic: AdminTopic): string {
	const name = encodeURIComponent(topic.name);
	return `<li class="row" tabindex="0">
		<span class="status ${topic.hasWriteSecret ? "active" : "paused"}" role="img" aria-label="シークレット${topic.hasWriteSecret ? "あり" : "なし"}" title="シークレット${topic.hasWriteSecret ? "あり" : "なし"}"></span>
		<div class="cell">
			<span class="name">${escapeHtml(topic.name)}</span>
			${renderCopyableId(topic.opaqueId)}
		</div>
		<div class="cell"><span class="meta">書き込みシークレット ${topic.hasWriteSecret ? "あり" : "なし"}</span></div>
		<span class="seq" title="連番">#${topic.seq}</span>
		${renderUpdatedAt(topic.updatedAt)}
		<div class="actions">${confirmAction({
			dialogId: `rotate-topic-${topic.name}`,
			path: `/topics/${name}/rotate`,
			buttonLabel: "シークレットを再発行",
			key: "r",
			keyHint: "R",
			title: `${topic.name} のシークレットを再発行しますか`,
			description: "今のシークレットはすぐに使えなくなります。producer の設定を新しい値に更新してください。",
			danger: false,
		})}${confirmAction({
			dialogId: `delete-topic-${topic.name}`,
			path: `/topics/${name}/delete`,
			buttonLabel: "削除",
			key: "Backspace",
			keyHint: "Backspace",
			title: `${topic.name} を削除しますか`,
			description: "同じトピック名は再利用できません。",
			danger: true,
		})}</div>
	</li>`;
}

function renderGroup(title: string, rows: string[], emptyMessage: string): string {
	const body = rows.length > 0 ? `<ul class="rows">${rows.join("")}</ul>` : `<p class="empty">${emptyMessage}</p>`;
	return `<section class="group">
		<h2 class="group-title">${title}<span class="count">${rows.length}</span></h2>
		${body}
	</section>`;
}

/**
 * 種類ごとの除外するユーザーIDの既定値を、登録済みの監視対象から導く
 *
 * 一覧は登録順のため、後の行で上書きすれば最後に追加した監視対象の値が残る。
 * トークンの持ち主から自動で導かないのは、読み取り用のボットと返信するボットが同じとは限らないためである。
 */
function latestExcludedUserIds(topics: AdminTopic[]): Map<SourceType, string> {
	const latest = new Map<SourceType, string>();
	for (const { source } of topics) {
		if (source) {
			latest.set(source.type, source.excludedUserId);
		}
	}
	return latest;
}

function renderAddSourceDialog(topics: AdminTopic[], notice: Notice | undefined): string {
	const latest = latestExcludedUserIds(topics);
	const failure = notice?.kind === "error" && notice.draft ? { message: notice.message, draft: notice.draft } : null;
	const selectedType = failure?.draft.type ?? "discord";
	const tabs = SOURCE_TYPE_FORMS.map(
		({ type, label }) =>
			`<input type="radio" class="tab-input" name="source-type-tab" id="tab-${type}"${type === selectedType ? " checked" : ""}><label class="tab" for="tab-${type}">${label}</label>`,
	).join("");
	const forms = SOURCE_TYPE_FORMS.map((form) => {
		const draft = failure?.draft.type === form.type ? failure.draft : undefined;
		const remembered = latest.get(form.type);
		const excludedUserId = draft ? draft.excludedUserId : remembered;
		const hint = !draft && remembered ? "登録済みの監視対象と同じ値を入力しました。" : form.excludedUserHint;
		return `<form method="post" action="/sources" class="field-form form-${form.type}">
			<input type="hidden" name="type" value="${form.type}">
			<label class="field">${form.targetLabel}<input name="target" required autofocus ${form.targetAttributes}${valueAttribute(draft?.target)}></label>
			<label class="field">トピック名<input name="topic" required pattern="[a-z0-9][a-z0-9\\-]{0,63}" placeholder="${form.topicPlaceholder}"${valueAttribute(draft?.topic)}></label>
			<label class="field">除外するユーザーID<input name="excludedUserId" required${valueAttribute(excludedUserId)}><span class="hint">${hint}</span></label>
			<div class="dialog-actions">
				<button type="button" commandfor="add-source" command="close">キャンセル</button>
				<button type="submit" class="primary">監視対象を追加</button>
			</div>
		</form>`;
	}).join("");
	const error = failure ? `<p class="dialog-error" role="alert">${escapeHtml(failure.message)}</p>` : "";
	return `<dialog id="add-source" closedby="any" aria-labelledby="add-source-title"${failure ? " open" : ""}>
		<h2 id="add-source-title">監視対象を追加</h2>
		${error}
		<div class="tabs">${tabs}</div>
		${forms}
	</dialog>`;
}

function renderCreateTopicDialog(): string {
	return `<dialog id="create-topic" closedby="any" aria-labelledby="create-topic-title">
		<h2 id="create-topic-title">外部トピックを作成</h2>
		<form method="post" action="/topics" class="field-form">
			<label class="field">トピック名<input name="name" required autofocus pattern="[a-z0-9][a-z0-9\\-]{0,63}" placeholder="mac-script"><span class="hint">英小文字・数字・ハイフンの64文字以内です。削除しても同じ名前は再利用できません。</span></label>
			<div class="dialog-actions">
				<button type="button" commandfor="create-topic" command="close">キャンセル</button>
				<button type="submit" class="primary">外部トピックを作成</button>
			</div>
		</form>
	</dialog>`;
}

function renderNotice(notice: Notice | undefined): string {
	if (!notice || (notice.kind === "error" && notice.draft)) {
		return "";
	}
	if (notice.kind === "error") {
		return `<p class="banner banner-error" role="alert">${escapeHtml(notice.message)}</p>`;
	}
	const secret = escapeHtml(notice.writeSecret);
	return `<section class="banner" role="status">
		<h2>${escapeHtml(notice.topic)} の書き込みシークレット</h2>
		<p>この値は今だけ表示され、再表示できません。producer に設定してください。</p>
		<div class="secret"><code id="issued-secret" class="copyable">${secret}</code><button type="button" data-copy="${secret}">コピー</button></div>
	</section>`;
}

/** 色のトークン。ライトとダークの差はすべて変数で切り替える */
const STYLES = `
:root {
	color-scheme: light dark;
	--bg: #fbfbfc; --surface: #ffffff; --hover: #f3f4f6; --border: #e6e7ea; --border-strong: #d3d5da;
	--text: #1c1e22; --muted: #6b6f76; --accent: #5e6ad2; --accent-hover: #4f5bc4; --on-accent: #ffffff;
	--green: #2e9e6b; --red: #d6453d; --red-bg: #d6453d14; --gray: #a0a4ab;
	--shadow: 0 16px 48px #0f111a2e, 0 2px 8px #0f111a14;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #101113; --surface: #1a1b1f; --hover: #1d1e22; --border: #26282d; --border-strong: #363a40;
		--text: #eceef0; --muted: #8a8f98; --accent: #5e6ad2; --accent-hover: #7079dc;
		--green: #4cb782; --red: #eb5757; --red-bg: #eb57571a; --gray: #62666d;
		--shadow: 0 16px 48px #0009, 0 2px 8px #0006;
	}
}
@view-transition { navigation: auto; }
* { box-sizing: border-box; }
body {
	background: var(--bg); color: var(--text); margin: 0;
	font: 13px/1.5 Inter, "SF Pro Text", -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
	-webkit-font-smoothing: antialiased;
}
h1, h2, p { margin: 0; }
code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

button {
	background: var(--surface); border: 1px solid var(--border-strong); border-radius: 6px;
	cursor: pointer; font-weight: 500; min-height: 28px; padding: 0 10px; white-space: nowrap;
	transition: background-color 80ms, border-color 80ms;
}
button:hover { background: var(--hover); }
button.primary { background: var(--accent); border-color: transparent; color: var(--on-accent); }
button.primary:hover { background: var(--accent-hover); }
button.danger { background: var(--red); border-color: transparent; color: #ffffff; }
button.danger:hover { filter: brightness(1.08); }
button.ghost { background: transparent; border-color: transparent; color: var(--muted); }
button.ghost:hover { background: var(--border); color: var(--text); }
button.tiny { font-size: 11px; min-height: 20px; padding: 0 6px; }
kbd {
	background: #ffffff26; border-radius: 3px; font: inherit; font-size: 11px;
	margin-left: 6px; padding: 0 4px;
}
button:not(.primary) kbd, .shortcuts kbd { background: var(--border); color: var(--muted); }

.topbar {
	align-items: center; background: var(--bg); border-bottom: 1px solid var(--border);
	display: flex; gap: 8px; min-height: 48px; padding: 8px 16px; position: sticky; top: 0; z-index: 1;
}
.brand { align-items: center; display: flex; flex: 1; font-size: 13px; font-weight: 600; gap: 8px; }
.brand svg { color: var(--accent); }

main { margin: 0 auto; max-width: 72rem; padding-bottom: 48px; }
.banner { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; display: grid; gap: 6px; margin: 16px; padding: 12px 16px; }
.banner h2 { font-size: 13px; font-weight: 600; }
.banner-error { background: var(--red-bg); border-color: var(--red); }
.secret { align-items: center; display: flex; gap: 8px; }
.copyable { user-select: all; word-break: break-all; }

.group-title {
	align-items: center; background: var(--surface); border-bottom: 1px solid var(--border);
	display: flex; font-size: 13px; font-weight: 500; gap: 8px; padding: 8px 16px;
}
.count { color: var(--muted); font-weight: 400; }
.rows { list-style: none; margin: 0; padding: 0; }
.row {
	align-items: center; border-bottom: 1px solid var(--border);
	display: grid; gap: 2px 12px; grid-template-columns: 16px minmax(0, 1.2fr) minmax(0, 1fr) 48px 72px;
	padding: 8px 16px; position: relative;
}
.row:hover, .row:focus-within { background: var(--hover); }
.row:focus-visible { outline-offset: -2px; }
.cell { display: grid; gap: 1px; min-width: 0; }
.name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.is-paused .name, .is-paused .target { color: var(--muted); }
.target { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { border: 1px solid var(--border-strong); border-radius: 10px; color: var(--muted); font-size: 11px; margin-right: 2px; padding: 0 6px; }
.meta, .id code { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.id { align-items: center; display: flex; gap: 4px; min-width: 0; min-height: 20px; }
.id code { word-break: normal; }
.id button { opacity: 0; }
.row:hover .id button, .row:focus-within .id button { opacity: 1; }
.seq, .time { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }

.status { border-radius: 50%; display: block; height: 9px; width: 9px; }
.status.active { background: var(--green); }
.status.failing { background: var(--red); }
.status.paused { border: 2px solid var(--gray); }
.row-error { color: var(--red); font-size: 12px; grid-column: 2 / -1; }

.actions {
	align-items: center; background: var(--hover); border-radius: 6px; display: none; gap: 2px;
	position: absolute; right: 12px; top: 8px;
}
.row:hover .actions, .row:focus-within .actions { display: flex; }
.empty { border-bottom: 1px solid var(--border); color: var(--muted); padding: 16px; }
.shortcuts { color: var(--muted); font-size: 12px; padding: 16px; }
.shortcuts kbd { margin: 0 2px 0 8px; }

dialog {
	background: var(--surface); border: 1px solid var(--border-strong); border-radius: 12px;
	box-shadow: var(--shadow); color: var(--text); max-width: calc(100vw - 32px);
	padding: 20px; width: 440px;
}
dialog[open] { display: grid; gap: 12px; animation: dialog-in 120ms ease-out; }
dialog::backdrop { background: #0a0b0d66; }
@keyframes dialog-in { from { opacity: 0; transform: translateY(4px) scale(.985); } }
dialog h2 { font-size: 15px; font-weight: 600; }
.dialog-text { color: var(--muted); }
.dialog-error { background: var(--red-bg); border-radius: 6px; color: var(--red); padding: 8px 10px; }
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }
.field-form { display: grid; gap: 12px; }
.field { color: var(--muted); display: grid; font-size: 12px; font-weight: 500; gap: 4px; }
.field input {
	background: var(--bg); border: 1px solid var(--border-strong); border-radius: 6px; color: var(--text);
	font-size: 13px; font-weight: 400; min-height: 32px; padding: 0 10px; width: 100%;
}
.field input:focus { border-color: var(--accent); outline: 1px solid var(--accent); }
.field input::placeholder { color: var(--gray); }
.hint { font-weight: 400; }

.tabs { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; gap: 2px; padding: 2px; width: fit-content; }
.tab-input { opacity: 0; position: absolute; }
.tab { border-radius: 6px; color: var(--muted); cursor: pointer; font-weight: 500; padding: 3px 12px; }
.tab-input:checked + .tab { background: var(--surface); box-shadow: 0 0 0 1px var(--border-strong); color: var(--text); }
.tab-input:focus-visible + .tab { outline: 2px solid var(--accent); }
#add-source:has(#tab-discord:checked) .form-cosense,
#add-source:has(#tab-cosense:checked) .form-discord { display: none; }

@media (hover: none), (max-width: 720px) {
	.actions { background: none; display: flex; flex-wrap: wrap; grid-column: 2 / -1; position: static; }
	.id button { opacity: 1; }
}
@media (max-width: 720px) {
	.row { grid-template-columns: 16px minmax(0, 1fr) auto; }
	.row .cell:nth-of-type(2) { grid-column: 2 / -1; grid-row: 2; }
	.row .seq { display: none; }
	.shortcuts { display: none; }
	.brand span { display: none; }
}
@media (prefers-reduced-motion: reduce) {
	* { animation: none !important; transition: none !important; }
	@view-transition { navigation: none; }
}
`;

/**
 * キーボード操作とコピーのスクリプト
 *
 * ショートカットは data-key を持つボタンのクリックに置き換える。処理を二重に持たないためである。
 * 行にフォーカスがあればその行のボタンを、なければ上部のボタンを押す。
 * 入力中・IME の変換中・ダイアログの表示中は反応しない。
 */
const SCRIPT = `
const COPIED_LABEL_MS = 1500;
for (const dialog of document.querySelectorAll("dialog[open]")) {
	dialog.close();
	dialog.showModal();
}
document.addEventListener("click", async (event) => {
	const button = event.target.closest("[data-copy]");
	if (!button) return;
	const label = button.dataset.label ?? button.textContent;
	button.dataset.label = label;
	try {
		await navigator.clipboard.writeText(button.dataset.copy);
		button.textContent = "コピーしました";
	} catch (error) {
		console.error("クリップボードへのコピーに失敗しました", error);
		button.textContent = "コピーできません";
	}
	setTimeout(() => { button.textContent = label; }, COPIED_LABEL_MS);
});
function findButton(scope, key) {
	return [...scope.querySelectorAll("[data-key]")].find((element) => element.dataset.key === key);
}
function moveFocus(step) {
	const rows = [...document.querySelectorAll(".row")];
	if (rows.length === 0) return;
	const current = rows.indexOf(document.activeElement?.closest(".row"));
	const next = current === -1 ? (step > 0 ? 0 : rows.length - 1) : Math.min(Math.max(current + step, 0), rows.length - 1);
	rows[next].focus();
}
document.addEventListener("keydown", (event) => {
	if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
	if (event.target.closest("input, select, textarea") || document.querySelector("dialog[open]")) return;
	if (event.key === "j" || event.key === "k") {
		event.preventDefault();
		moveFocus(event.key === "j" ? 1 : -1);
		return;
	}
	const row = document.activeElement?.closest(".row");
	const button = (row && findButton(row, event.key)) ?? findButton(document.querySelector(".topbar"), event.key);
	if (button) {
		event.preventDefault();
		button.click();
	}
});
`;

/**
 * 管理ページ全体を生成する
 *
 * @param topics 一覧に表示するトピック
 * @param nonce CSP で許可するインラインのスタイルとスクリプトの nonce
 * @param notice 一覧の上に表示する操作の結果
 */
export function renderPage(topics: AdminTopic[], nonce: string, notice?: Notice): string {
	const sourceRows = topics.flatMap((topic) => (topic.source ? [renderSourceRow(topic, topic.source)] : []));
	const externalRows = topics.flatMap((topic) => (topic.source ? [] : [renderExternalRow(topic)]));
	const safeNonce = escapeHtml(nonce);
	return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>doorbell 管理</title>
<style nonce="${safeNonce}">${STYLES}</style>
</head>
<body>
<header class="topbar">
	<h1 class="brand"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a1 1 0 0 1 1 1v.6A4.5 4.5 0 0 1 12.5 7v3l1.3 1.7a.5.5 0 0 1-.4.8H2.6a.5.5 0 0 1-.4-.8L3.5 10V7A4.5 4.5 0 0 1 7 2.6V2a1 1 0 0 1 1-1Zm-1.8 12.5h3.6a1.9 1.9 0 0 1-3.6 0Z"/></svg><span>doorbell 管理</span></h1>
	<button type="button" commandfor="create-topic" command="show-modal" data-key="t">外部トピックを作成<kbd>T</kbd></button>
	<button type="button" class="primary" commandfor="add-source" command="show-modal" data-key="c">監視対象を追加<kbd>C</kbd></button>
</header>
<main>
${renderNotice(notice)}
${renderGroup("監視対象", sourceRows, "監視対象はまだありません。「監視対象を追加」から Discord のチャンネルか Cosense のプロジェクトを登録してください。")}
${renderGroup("外部トピック", externalRows, "外部トピックはまだありません。外部のスクリプトから通知するときに作成してください。")}
<p class="shortcuts"><kbd>J</kbd><kbd>K</kbd> 行を移動 <kbd>E</kbd> 無効化・再開 <kbd>Y</kbd> ID をコピー <kbd>R</kbd> 再発行 <kbd>Backspace</kbd> 削除</p>
</main>
${renderAddSourceDialog(topics, notice)}
${renderCreateTopicDialog()}
<script nonce="${safeNonce}">${SCRIPT}</script>
</body>
</html>`;
}
