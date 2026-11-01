# doorbell 設計メモ

作成：2026-10-31（たねハウス）
改訂：2026-10-31（KV から Durable Object への変更、連番の永続化、ループ防止、既読位置の分離、`/signal` の匿名化）
改訂：2026-11-01（複数の監視対象と設定管理ページを実装し、旧シークレットの取り込みを削除）
状態：`doorbell` は `https://doorbell.mtane0412.workers.dev`、`doorbell-admin` は `https://doorbell-admin.mtane0412.workers.dev` で稼働中。Hook の起床とコネクタの読み取りは、たねハウスが本番で確認済み。

## 目的

「変化があった時だけ たねハウス（Muse）を起こす」ための、最小で汎用的な中継基盤。
用途ごとに仕組みを作らず、情報源は「producer＋トピック」として足していくだけにする。
初期用途は Discord #家ッター の新着検知とした。将来は n8n や Mac スクリプトなど任意の producer を受けられる。

## なぜこの形か（制約の出発点）

- Muse のエージェント起動は利用枠を消費する。何も起きていない時間にポーリングで起こすのは無駄。
- Muse 側の Hook（軽量な検知スクリプト）は認証情報を一切持てない。認証が要る相手を直接見張れない。
- Discord の受信にプッシュ経路はなく、実質 Gateway 常駐か REST ポーリングになる。
- したがって「signal（認証不要・内容なし）」と「実データ（認証あり）」を分離し、
  signal の置き場として Cloudflare Workers に doorbell を置く。

## 全体像

```
外部の producer（Mac / 自宅基盤 等）
  │  POST /events/{topic}（トピック別シークレット）
  ▼
Cloudflare Worker「doorbell」 ◀── Cron（Discord と Cosense の REST ポーリング。内部で直接書き込む）
  │
  ├─ Durable Object（SQLite・1個のみ）… 連番、イベント、トピックと監視対象の設定の保管 ◀── Worker「doorbell-admin」（Cloudflare Access で保護した管理ページ）
  ├─ GET /signal/{signal_key} … 認証なし。opaque ID ごとの「連番＋最終更新時刻」だけ返す
  ├─ GET /events/{topic}      … 読み取りトークン必須。実データを返す
  └─ GET /topics              … 読み取りトークン必須。opaque ID とトピック名の対応を返す
  ▲                    ▲
  │ Hookが5分おきに確認 │ 起きた時だけ読む
Muse Hook（検知役）──変化時のみ──▶ Muse エージェント（判断と実行）
```

## Worker 仕様（たね側・Claude Code 実装想定）

### エンドポイント

| メソッドとパス | 認証 | 役割 |
|---|---|---|
| `POST /events/{topic}` | トピック別書き込みシークレット（ヘッダ） | イベントを1件追加し、連番を進める |
| `GET /signal/{signal_key}` | なし（推測困難なURL） | 全トピックの `{ id, seq, updated_at }` 一覧を返す。トピック名と内容は含めない |
| `GET /events/{topic}?since={seq}` | 読み取りトークン（ヘッダ） | 指定連番より後のイベントを返す |
| `GET /topics` | 読み取りトークン（ヘッダ） | 全トピックの opaque ID、トピック名、監視先の種類と値を返す。外部トピックの `source` は `null` とする。除外するユーザーID、直近のエラー、シークレットの情報は含めない |

入力の扱いは次のとおりとする。

- 未登録または論理削除済みのトピックへの POST と GET は 404 を返す。
- サイズ上限を超えた POST は 413 を返す。
- シークレットとトークンは定数時間で比較する。

### `GET /events/{topic}` の応答

```json
{
  "oldest_seq": 23,
  "latest_seq": 42,
  "events": [{ "seq": 42, "ts": "2026-10-31T12:00:00Z", "kind": "discord.message", "summary": "新着3件" }]
}
```

`since` は必須で、0以上の整数とする。`since` が `oldest_seq - 1` より小さい場合は、保持範囲外に欠落がある。保持中のイベントがない場合、`oldest_seq` は `latest_seq + 1` とする。

### ストレージ（SQLite バックエンドの Durable Object を1個）

KV は使わない。KV にはアトミックな更新がなく、他ロケーションへの反映に60秒以上かかることがあるため、連番の正確さを保てない。

- `topics` — トピック名、opaque ID、現在の連番、最終更新時刻、書き込みシークレットのハッシュ、論理削除の時刻。**連番は永続化し、TTL の対象にしない。**
- `sources` — 監視対象（Discord の1チャンネルまたは Cosense の1プロジェクト）。
- `events` — トピック名、連番、イベント本体。トピックごとに最新20件を保持し、7日を過ぎたものは削除する。
- `producer_state` — 監視対象ごとの確認位置（Discord はメッセージID、Cosense は最終更新時刻）。`producer` は `sources.id` と同じ値である。
- 連番の採番とイベントの追加は、同じトランザクションで行う。
- 保持件数を超えた分は書き込み時に削除し、7日を過ぎた分は Alarm で削除する。doorbell は保管庫ではない。

```sql
CREATE TABLE topics (
  name TEXT PRIMARY KEY,
  opaque_id TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  updated_at_ms INTEGER,           -- イベントが一度もなければ NULL
  write_secret_hash TEXT,          -- NULL なら外部から書き込めない
  deleted_at_ms INTEGER            -- NULL 以外なら論理削除済み
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,             -- producer_state.producer と同じ値を使う
  type TEXT NOT NULL CHECK (type IN ('discord', 'cosense')),
  target TEXT NOT NULL,            -- チャンネルID またはプロジェクト名
  excluded_user_id TEXT NOT NULL,
  topic TEXT NOT NULL UNIQUE REFERENCES topics(name),
  enabled INTEGER NOT NULL,
  last_error TEXT,                 -- API のステータスコード程度だけを記録し、認証情報と応答本文は含めない
  UNIQUE (type, target)
);
```

監視対象1件につき、トピックを1つ割り当てる。連番と最短起床間隔がトピック単位であるため、この対応なら既存の仕組みをそのまま使える。複数の監視対象を1つのトピックにまとめる機能は作らない。

### イベント形式

```json
{
  "ts": "2026-10-31T12:00:00Z",
  "kind": "discord.message",
  "summary": "要約（必須・短く）",
  "ref": "参照先IDなど任意",
  "data": { "任意の小さな構造化データ": "..." }
}
```

- `ts` と連番は Worker が付与する。producer は `kind`、`summary`、任意の `ref`、`data` を送る。
- ペイロード上限：4 KB。大きな本文は載せず、参照（IDやURL）だけ渡す。
- 秘密情報（トークン、パスワード、個人情報の本文）は絶対に載せない。
- 内蔵 producer のイベントは、件数と参照先のIDのほか、`data` に Discord は `channel_id`、Cosense は `project` を持つ。本文とタイトルは載せない。

### Discord producer

- Worker 内蔵の Cron で、Discord の監視対象ごとに REST ポーリングし、Worker 内部から Durable Object に直接書き込む。
- Hook の確認間隔が5分なので、Gateway 常駐で即時検知しても通知は速くならない。
- **監視対象の `excluded_user_id`（自分のボット）の投稿は除外する。** 除外しないと、エージェントの返信が新着として検知され、起床が連鎖する。
- 確認済みメッセージIDは `producer_state` に保持し、イベントの追加と同じトランザクションで更新する。
- 初回は過去の投稿を通知せず、最新メッセージIDだけを記録する。
- 1回の確認で取得する上限は100件とし、超えた分は次回の Cron で別のイベントになる。
- Discord API が失敗した場合は例外を投げ、確認済みIDを進めない。

### Cosense producer

- Discord と同じ Cron で、Cosense の監視対象ごとに `GET https://scrapbox.io/api/pages/{project}?sort=updated&limit=100` を呼び、Worker 内部から Durable Object に直接書き込む。認証は `x-personal-access-token` ヘッダーで行う。
- イベントの `kind` は `cosense.page_updated` とする。イベントは件数と最新のページIDだけを持ち、タイトルと本文は載せない。
- 確認位置はページの最終更新時刻（UNIX 秒）の最大値とし、`producer_state` に保持する。確認位置より `updated` が大きいページを更新とみなす。
- **最終更新者が監視対象の `excluded_user_id` のページは除外する。** 最終更新者が `null` のページは人の更新として扱う。
- 初回は既存のページを通知せず、確認位置だけを記録する。ページが0件の場合は何も記録しない。
- Cosense API が失敗した場合は例外を投げ、確認位置を進めない。

既知の制約は次のとおりとする。

- API は最終更新者しか返さないため、人の更新の後、次の Cron までにボットが同じページを更新すると、人の更新は検知しない。
- 時刻の精度が1秒であるため、確認の直後に同じ秒で更新されたページは検知しない。
- ページの削除は検知しない。
- 1回の確認で101件以上のページが更新された場合、超えた分は件数に数えない。

### Cron

- 有効な監視対象ごとに確認を実行する。1件の失敗で他の監視対象の確認を止めず、失敗があれば実行の最後に例外を投げる。
- 監視対象と確認位置は、1回の RPC でまとめて取得する。
- `last_error` は値が変わった場合だけ書き込む。`PollError` のメッセージ（ステータスコード程度）だけを保存し、それ以外の例外は固定の文言に置き換える。
- 監視対象の上限は暫定で10件とし、無効の監視対象も数える。Workers Free の Cron の上限は CPU 時間 10 ms、外部サブリクエスト50件である。監視対象を増やした時点で CPU 時間を再測定し、上限を見直す。

### シークレットの置き場所

| 値 | 置き場所 | 備考 |
|---|---|---|
| トピック別書き込みシークレット | 外部の producer 側と、`topics` の SHA-256 ハッシュ | 管理ページで生成し、発行時に一度だけ表示する。producer ごとに別値。漏れたらそのトピックだけ再発行する。Worker 内蔵 producer には不要 |
| トピック名と opaque ID の対応 | `topics` | リポジトリには置かない |
| 監視先と除外するユーザーID | `sources` | 認証情報ではないが、リポジトリに置かない |
| 読み取りトークン（`READ_TOKEN`） | `doorbell` のシークレット＋ Muse の安全登録（コネクタ） | Muse 自身は値を見ない |
| `signal_key`（`SIGNAL_KEY`） | `doorbell` のシークレット＋ Hook の Bash スクリプト内の定数 | signal を読むためだけの URL に使う値であり、認証情報として扱わない。漏れたら値を差し替える |
| Discord ボットトークン（`DISCORD_BOT_TOKEN`） | `doorbell` のシークレット | doorbell のペイロードには載せない。管理ページでは扱わない |
| Cosense の Personal Access Token（`COSENSE_PAT`） | `doorbell` のシークレット | doorbell のペイロードには載せない。管理ページでは扱わない |
| Access の設定（`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`） | `doorbell-admin` のシークレット | 認証情報ではないが、リポジトリに置かない |

## 設定管理（`doorbell-admin`）

### 操作の規則

| 操作 | 動作 | 理由 |
|---|---|---|
| 監視対象の追加 | `EventBridge` が API を1回呼び、成功した場合だけ保存する | 入力の誤りと権限不足を追加時に検出するため |
| 監視対象の無効化 | Cron の確認対象から外す。トピックは `/signal` に残す | 一時停止と削除を区別するため |
| 無効化からの再開 | 確認位置を削除し、初回と同じ扱いにする | 停止中の更新で不要な起床を起こさないため |
| 監視先の変更 | 不可とする。削除と追加で行う | 別の監視先に古い確認位置を適用しないため |
| 監視対象の削除 | `sources` と `producer_state` の行を削除し、`topics` の行を論理削除する | 連番を保持するため |
| トピックの削除 | 論理削除とし、同じ名前の再利用を禁止する | 連番の巻き戻りを防ぐため |

論理削除されたトピックは `/signal` に出さず、`POST /events/{topic}` と `GET /events/{topic}` は 404 を返す。

次の規則も適用する。

- 監視対象を持たないトピックを「外部トピック」と呼ぶ。外部トピックの削除とシークレットの再発行は、監視対象を持つトピックには行えない。
- トピック名は URL のパスに使うため、英小文字・数字・ハイフンの64文字以内とする。
- 監視対象の追加では、API の応答を待つ間に他の追加が割り込めるため、保存の直前に上限と重複を確認し直す。
- 確認の途中で無効化または削除された監視対象の結果は記録しない。再開で消した確認位置を書き戻さないためである。
- 有効な監視対象への再開は何も変更しない。二重送信で稼働中の確認位置を消さないためである。

### 管理ページ

- 別の Worker `doorbell-admin` として実装し、Worker 全体を Cloudflare Access で保護する。
- `doorbell` に `/admin` を追加する案は採用しない。workers.dev 向けのワンクリック Access は URL 単位の保護であり、`/signal` と `/events` だけを除外する方法を確認できなかったためである。Hook は認証情報を持てないため、これらの経路を保護すると Hook が動かなくなる。
- `doorbell-admin` は `Cf-Access-Jwt-Assertion` を `jose` で検証する（RS256、`iss` は `ACCESS_TEAM_DOMAIN`、`aud` は `ACCESS_AUD`、期限）。JWT 自体の誤りは 403 で拒否する。設定が空の場合と公開鍵を取得できない場合は、障害として例外を投げ、通さない。
- `doorbell-admin` は `EventBridge` の Durable Object バインディングだけを持ち、`DISCORD_BOT_TOKEN` と `COSENSE_PAT` を持たない。
- `cf` の設定は1つの Worker だけを定義するため、`doorbell-admin` は `admin/` に独自の `package.json` を持つ別のプロジェクトとして置き、`admin/` で `cf deploy` を実行する。npm workspace は使わない。ルートが workspace になると、ルートで `cf build` と `cf deploy` を実行できなくなるためである。
- 画面はサーバーで生成する HTML とフォームで構成し、フレームワークを使わない。POST では `Origin` を検証し、CSP を設定する。CSP はインラインのスタイルとスクリプトを応答ごとの nonce でだけ許可し、外部の読み込みを許可しない。
- `Referrer-Policy` は `same-origin` とする。`no-referrer` にするとブラウザがフォームの POST で `Origin: null` を送り、Origin の検証で正規の操作を拒否するためである。
- 一覧には名前、種類、監視先、連番、最終更新時刻、直近のエラーを表示する。
- 操作は、監視対象の追加・無効化・再開・削除、外部トピックの作成・削除、書き込みシークレットの再発行とする。
- `opaque_id` はサーバーで生成し、一覧のコピーボタンでコピーできるようにする。`user-select: all` で全選択もできる。
- 削除とシークレットの再発行は、確認ダイアログの中のフォームでだけ送信する。ダイアログはブラウザ標準の `commandfor` / `command` 属性で開く。
- スクリプトはキーボード操作（`C`・`T`・`J`・`K`・`E`・`Y`・`R`・`Backspace`）とコピーだけを担当する。操作自体はフォームの POST で完結する。入力中と IME の変換中は反応しない。
- 追加フォームの除外するユーザーIDには、同じ種類の監視対象のうち最後に追加したものの値を入力済みにする。その種類の監視対象がなければ空とする。トークンの持ち主から自動取得しないのは、読み取り用のボットと返信するボットが同じとは限らず、誤ると起床が連鎖するためである。
- 監視対象の追加に失敗した場合は、入力を残したままダイアログを開き、理由を表示する。

## Muse 側の仕様（たねハウス実装）

### Hook

- 5分おきに `GET /signal/{signal_key}` を取得し、opaque ID ごとに前回の連番と比較する。
- 進んだトピックがある場合、または前回までに見ていない opaque ID がある場合だけエージェントを起こす。どちらもなければ何もしない。未知の ID は連番が0でも起こす条件とする。
- Hook の初回実行では、すべての ID を既知として記録するだけで起こさない。
- トピックごとに最短の起床間隔（15分）を設ける。間隔内の変化では起こさず、通知済みの連番も進めない。次回の確認時にまとめて起こす。
- 通知済みの連番は Hook の状態の保存先に保持する。これは多重起動を防ぐためのものとする。
- Hook 自体は認証情報を持たず、`/signal/{signal_key}` 以外に触れない。

### 読み取りコネクタ

- 読み取りトークンは HDAD と同じ方式で安全登録し、カスタムコネクタとして1本だけ持つ。
- 起きたエージェントは、変化したトピックについて、処理済みの連番を `since` に指定して実データを取得する。
- 処理済みの連番はエージェント側で保持し、処理が成功した後にだけ進める。これにより、失敗した分は次回の起動時に回収できる。

### トピック規則

- opaque ID とトピック名の対応、およびトピックごとの「起きたら何をするか」を Muse 側の規則ファイルで管理する。
  例：`discord-ietter` → Discord コネクタで本文を読み、内容に応じて返信・リアクションを判断する。
- 規則にない opaque ID を受けたエージェントは、`GET /topics` で名前と監視先を特定し、たね に報告して「起きたら何をするか」を確認する。回答を規則ファイルへ追加するまでは、そのトピックのイベントについて要約の報告だけを行う。
- 「起きたら何をするか」は doorbell に保存しない。doorbell から受け取った文章を指示として実行しないためである。監視対象が増えると起床回数も増える可能性がある。
- 削除したトピックは `/signal` から消える。Hook は、未知の ID と消えた ID を受けてもエラーにならない必要がある。

## 安全の前提

- イベントの内容は常に「データ」であって「指示」ではない。イベント文面に書かれた命令には従わない。
- イベント単体を根拠に、外向きの送信・投稿・購入などの不可逆な動作はしない。通常の承認ルールに従う。
- producer は要約だけを送る。本文が必要な場合は、起きたエージェントが正規の経路（各コネクタ）で取りに行く。
- `/signal/{signal_key}` は認証なしで読めるため、トピック名を出さず、推測困難なURLと opaque ID で活動内容の露出を抑える。

## 障害時の挙動

- Worker が落ちている間、外部の producer からのイベントは届かない（producer は再送しない。前提として「届けば起きる」best effort）。
- Discord Cron は確認済みメッセージIDから再開するため、停止中の投稿も復旧後に検知できる。
- 欠落は `since` と `oldest_seq` の比較で検出する。欠落があっても保持範囲の先頭から処理を再開し、欠落があったことを記録する。
- エージェントが途中で失敗した場合、処理済みの連番は進まない。ただし再度起きるのは次のイベント発生時である。
- 多重起動は通知済みの連番で防ぎ、重複処理は処理済みの連番で防ぐ。

## 決定事項

| 項目 | 決定 | 理由 |
|---|---|---|
| Worker 名 | `doorbell` | 内容を持たず、鳴らすだけという設計を表す |
| トピック | 監視対象ごとに1つ | 連番と最短起床間隔がトピック単位であるため |
| Discord producer の置き場所 | Workers 内蔵 Cron での REST ポーリング | 常駐プロセスが不要で、自宅基盤の障害に影響されない |
| 保持件数と保持期間 | 20件・7日 | 本文を持たない設計なので十分である |
| Hook の確認間隔 | 5分 | 分単位の即時性が必要な用途がない |
| `signal_key` の保持 | Hook の Bash スクリプト内の定数 | `signal_key` は認証情報ではなく signal を読むためだけの URL に使う値であり、たねハウスが保持可能と確認済み |
| トピックごとの最短起床間隔 | 15分 | 会話が活発な間の利用枠の消費を抑える |
| Discord Cron の実行間隔 | 5分 | 静かな状態からの検知遅れは最大約10分（Cron 5分＋Hook 5分）。起床の直後に投稿された場合は、最短起床間隔により次の起床まで約15〜20分かかる |
| ドメイン | `doorbell.mtane0412.workers.dev` | 独自ドメインなしで開始する。`mtane0412` の部分は Cloudflare アカウントの `workers.dev` サブドメインに合わせる |
| 監視対象の設定の置き場所 | Durable Object | シークレットは今の値を読めず、JSON の全体上書きしかできないため |
| 認証情報の置き場所 | シークレットのまま | 管理ページの侵害時にトークンが漏れないようにするため |
| 管理ページの置き場所 | 別の Worker `doorbell-admin` と Cloudflare Access | `/signal` と `/events` を保護せず、公開側の Worker に管理用の入口を増やさないため |

## 実測結果

- 2026-10-31 の本番で、Cron の CPU 時間は Worker が最大 1〜2 ms、Durable Object が最大 2 ms であり、Workers Free の上限（10 ms）に収まった。
- `workers.dev` サブドメインは `mtane0412` であった。
- 2026-11-01 00:45（JST）の本番で、監視対象2件・新着なしの Cron の CPU 時間は、Worker が 2 ms、Durable Object の `getPollSources` が 0 ms であった。測定は `wrangler tail` の1回分であり、新着の書き込みを含まない。
- 2026-11-01 11:20（JST）の本番で、監視対象の追加後の Cron の CPU 時間は、Worker が 2 ms、Durable Object の `getPollSources` と `commitProducerPoll` がそれぞれ 0 ms であった。
- `doorbell-admin` の CPU 時間は未測定である。
- 2026-11-01 に、1つの `COSENSE_PAT` で複数のプロジェクトを読めること、監視するすべての Discord チャンネルに1つのボットを招待できることを、たねが確認した。したがって、`sources` に認証情報の名前を持つ列は追加しない。

## 移行の経緯

トピックと監視対象の設定は、以前は Worker のシークレット（`TOPICS` など）にあった。シークレットは今の値を読めず、JSON の全体上書きしかできないため、2026-11-01 に Durable Object へ移した。移行では `opaque_id`、トピック名、連番、確認位置をすべて引き継いだ。取り込み処理は移行の完了後に削除した。

## 実装分担

| 部分 | 担当 |
|---|---|
| Worker 本体（エンドポイント、Durable Object、シークレット設定） | たね（Claude Code で実装） |
| producer の組み込み（Discord Cron など） | たね（Claude Code） |
| 管理ページ（`doorbell-admin`） | たね（Claude Code） |
| Hook の作成と有効化 | たねハウス |
| 読み取りコネクタの登録（安全入力の実施は たね） | たねハウス＋たね |
| トピック規則の作成と運用 | たねハウス |
