# doorbell

変化があった時だけエージェント（Muse）を起こすための、Cloudflare Workers 製のイベント中継基盤です。

doorbell は「signal（認証なし・内容なし）」と「実データ（認証あり）」を分離します。認証情報を持てない軽量な Hook は signal だけを見張り、連番が進んだ時だけエージェントを起こします。起きたエージェントは、読み取りトークンを使って実データを取得します。

```
外部の producer ── POST /events/{topic} ──▶ doorbell ◀── Cron（Discord と Cosense の REST を5分おきに確認）
                                          │
                                          ├─ Durable Object（連番とイベントの保管）
                                          ├─ GET /signal/{signal_key} ◀── Hook（変化の検知）
                                          └─ GET /events/{topic}      ◀── エージェント（実データの取得）
```

設計の背景と Muse 側の仕様は [docs/design.md](docs/design.md) に記載しています。

## エンドポイント

| メソッドとパス | 認証 | 役割 |
|---|---|---|
| `POST /events/{topic}` | `Authorization: Bearer <トピック別シークレット>` | イベントを1件追加し、連番を進めます |
| `GET /signal/{signal_key}` | なし（推測困難な URL） | 全トピックの opaque ID と連番、最終更新時刻を返します |
| `GET /events/{topic}?since={seq}` | `Authorization: Bearer <READ_TOKEN>` | 指定した連番より後のイベントを返します |

### イベントを追加する

```bash
curl -X POST "https://<Worker のホスト>/events/<トピック名>" \
  -H "Authorization: Bearer <トピック別シークレット>" \
  -H "Content-Type: application/json" \
  -d '{"kind":"example.event","summary":"要約","ref":"参照先ID","data":{"count":1}}'
```

`kind` と `summary` は必須の空でない文字列です。`ref`（文字列）と `data`（オブジェクト）は任意です。`seq` と `ts` は doorbell が付与します。成功すると `201` と `{"seq":1}` を返します。

body の上限は 4 KB です。トークンや個人情報は載せないでください。メッセージ本文のような大きなデータは載せず、ID や URL の参照だけを渡してください。

| ステータス | 条件 |
|---|---|
| `400` | body の JSON または項目が不正である |
| `401` | シークレットが誤っている、またはトピックに書き込みシークレットが登録されていない |
| `404` | トピックが未登録、または論理削除済みである |
| `413` | body が 4 KB を超えている |

### signal を確認する

`GET /signal/{signal_key}` の応答です。トピック名と内容は含みません。イベントが一度もないトピックは `seq` が `0`、`updated_at` が `null` になります。`signal_key` が誤っている場合は `404` を返します。

```json
{
  "topics": [{ "id": "opaque ID", "seq": 42, "updated_at": "2026-10-31T12:00:00.000Z" }]
}
```

### イベントを読む

`GET /events/{topic}?since={seq}` の応答です。`since` は必須で、0以上の整数です。

```json
{
  "oldest_seq": 23,
  "latest_seq": 42,
  "events": [
    {
      "seq": 42,
      "ts": "2026-10-31T12:00:00.000Z",
      "kind": "discord.message",
      "summary": "新着3件",
      "ref": "最新メッセージID",
      "data": { "count": 3 }
    }
  ]
}
```

イベントはトピックごとに最新20件までを、最長7日間保持します。連番は削除されません。`since < oldest_seq - 1` の場合は、保持範囲外に欠落があります。

## 監視対象

Worker は Cron で5分おきに、管理ページで登録した監視対象を確認し、更新を監視対象ごとのトピックのイベントとして記録します。1件の失敗で他の監視対象の確認を止めません。

**Discord の新着検知**: イベントには件数と最新メッセージID、チャンネルIDだけを載せ、本文は載せません。

**Cosense の更新検知**: イベントには件数と最新のページID、プロジェクト名だけを載せ、タイトルと本文は載せません。API は最終更新者しか返さないため、人の更新の直後にボットが同じページを更新すると、人の更新は検知できません。ページの削除も検知しません。

共通の動作は次のとおりです。

- 監視対象の「除外するユーザーID」の投稿や更新は除外します。エージェントの動作で起床が連鎖することを防ぐためです。
- 初回は既存の内容を通知せず、確認位置だけを記録します。
- API が失敗した場合は確認位置を進めないため、次回の Cron で再確認します。

## セットアップ

```bash
npm install
```

開発には次のコマンドを使います。テストは `vitest.config.ts` のダミー値で動くため、シークレットの登録は不要です。

| コマンド | 内容 |
|---|---|
| `npm run dev` | ローカルで起動します |
| `npm test` | Workers ランタイム上でテストを実行します |
| `npm run lint` | ESLint を実行します（警告ゼロ必須） |
| `npm run type-check` | 型を生成し、型チェックを実行します |
| `npm run build` | ビルドします |
| `npm run deploy` | デプロイします |

## シークレット

認証情報は Worker のシークレットとして登録し、リポジトリには置きません。登録には `cf workers secrets update <名前> --worker doorbell` を使い、値は対話の入力で渡します。`--text` に値を書くと、シェルの履歴に残るためです。

| 名前 | 内容 |
|---|---|
| `READ_TOKEN` | `GET /events/{topic}` の読み取りトークン |
| `SIGNAL_KEY` | `GET /signal/{signal_key}` の URL に使う推測困難な値 |
| `DISCORD_BOT_TOKEN` | Discord ボットのトークン |
| `COSENSE_PAT` | Cosense の Personal Access Token |

トピックと監視対象の設定は Durable Object に保管し、管理ページで変更します。新しい環境では、どちらも空の状態から始まります。

## 管理ページ `doorbell-admin`

監視対象の追加・無効化・再開・削除、外部トピックの作成・削除、書き込みシークレットの再発行を行う別の Worker です。コードは `admin/` にあります。Discord と Cosense のトークンは持ちません。

追加ダイアログの除外するユーザーIDには、同じ種類の監視対象のうち最後に追加したものの値が入力済みになります。画面下部に表示されるキーボードショートカットでも操作できます。

デプロイの手順は次のとおりです。

1. リポジトリのルートで `npm run deploy` を実行し、`doorbell` を先にデプロイします。
2. `admin/` で `npm install` と `npx cf deploy` を実行します。Worker がまだない初回は、シークレットを先に登録できないため `npx cf deploy --secrets-file <ファイル>` を使います。`ACCESS_*` の値は手順3の後でないと分からないので、ファイルには `ACCESS_TEAM_DOMAIN` を `https://access-not-configured.invalid` のような解決できない URL、`ACCESS_AUD` を仮の文字列として書きます。この値の間は、すべてのリクエストが拒否または失敗し、画面は開けません。
3. ダッシュボードの **Workers & Pages** で `doorbell-admin` を開き、**Settings** > **Domains & Routes** で `workers.dev` の **Enable Cloudflare Access** を有効にします。Preview URL が有効な場合は、同様に保護するか無効にします。
4. 表示された値を、`admin/` でシークレットとして登録します。

| 名前 | 内容 |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `TEAM_DOMAIN` の値（`https://<チーム名>.cloudflareaccess.com`） |
| `ACCESS_AUD` | `POLICY_AUD` の値 |

監視対象を追加した後は、たねハウスの規則ファイルにもトピックを追加します。

## 構成

| パス | 内容 |
|---|---|
| `src/index.ts` | HTTP ルーティングと Cron の入口 |
| `src/event-bridge.ts` | イベントと連番を保管する Durable Object |
| `src/discord.ts` | Discord の新着を確認する producer |
| `src/cosense.ts` | Cosense のページ更新を確認する producer |
| `src/auth.ts` | シークレットの定数時間比較 |
| `src/schema.ts` | Durable Object のスキーマ |
| `src/poll-error.ts` | `last_error` に記録してよいエラー |
| `src/bridge-name.ts` | `doorbell` と `doorbell-admin` で共有する Durable Object の名前 |
| `admin/src/index.ts` | 管理ページのルーティングと操作 |
| `admin/src/access.ts` | Cloudflare Access の JWT の検証 |
| `admin/src/page.ts` | 管理ページの HTML の生成 |
| `admin/cloudflare.config.ts` | `doorbell-admin` の設定 |
| `cloudflare.config.ts` | Worker、Cron、バインディングの設定 |
| `docs/design.md` | 設計メモ |
