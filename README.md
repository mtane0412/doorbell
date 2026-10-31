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
| `404` | トピックが `TOPICS` に登録されていない |
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

## Discord の新着検知

Worker は Cron で5分おきに監視チャンネルを確認し、新着をトピック `discord-ietter` のイベントとして記録します。イベントには件数と最新メッセージIDだけを載せ、本文は載せません。

- `DISCORD_BOT_USER_ID` のボットの投稿は除外します。エージェントの返信で起床が連鎖することを防ぐためです。
- 初回は過去の投稿を通知せず、最新メッセージIDだけを記録します。
- Discord API が失敗した場合は確認位置を進めないため、次回の Cron で再確認します。

## Cosense の更新検知

Worker は同じ Cron で `COSENSE_PROJECT` のページ一覧を確認し、更新をトピック `cosense` のイベントとして記録します。イベントには件数と最新のページIDだけを載せ、タイトルと本文は載せません。

- `COSENSE_BOT_USER_ID` のユーザーが最後に更新したページは除外します。エージェントの編集で起床が連鎖することを防ぐためです。
- 初回は既存のページを通知せず、最終更新時刻だけを記録します。
- Cosense API が失敗した場合は確認位置を進めないため、次回の Cron で再確認します。Discord と Cosense は互いの失敗の影響を受けません。
- API は最終更新者しか返さないため、人の更新の直後にボットが同じページを更新すると、人の更新は検知できません。ページの削除も検知しません。

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

設定値はすべて Worker のシークレットとして登録し、リポジトリには置きません。登録には `cf workers secrets update <名前> --worker doorbell` を使います。

| 名前 | 内容 |
|---|---|
| `TOPICS` | トピック名と opaque ID の対応。`[{"name":"discord-ietter","id":"推測困難なID"}]` 形式の JSON |
| `TOPIC_WRITE_SECRETS` | 外部の producer 用の書き込みシークレット。`{"トピック名":"シークレット"}` 形式の JSON |
| `READ_TOKEN` | `GET /events/{topic}` の読み取りトークン |
| `SIGNAL_KEY` | `GET /signal/{signal_key}` の URL に使う推測困難な値 |
| `DISCORD_BOT_TOKEN` | Discord ボットのトークン |
| `DISCORD_CHANNEL_ID` | 監視するチャンネルのID |
| `DISCORD_BOT_USER_ID` | 除外する自分のボットのユーザーID |
| `COSENSE_PAT` | Cosense の Personal Access Token |
| `COSENSE_PROJECT` | 監視する Cosense のプロジェクト名 |
| `COSENSE_BOT_USER_ID` | 除外する自分のボットの Cosense ユーザーID |

Worker 内蔵 producer しか使わないトピックは、`TOPIC_WRITE_SECRETS` に登録しません。登録がなければ外部から書き込めません。外部の producer がいない場合の値は `{}` です。

## トピックを追加する

1. `TOPICS` にトピック名と opaque ID を追加します。
2. `TOPIC_WRITE_SECRETS` にトピック名と書き込みシークレットを追加し、producer に同じシークレットを渡します。
3. producer から `POST /events/{topic}` を送ります。

## 構成

| パス | 内容 |
|---|---|
| `src/index.ts` | HTTP ルーティングと Cron の入口 |
| `src/event-bridge.ts` | イベントと連番を保管する Durable Object |
| `src/discord.ts` | Discord の新着を確認する producer |
| `src/cosense.ts` | Cosense のページ更新を確認する producer |
| `src/auth.ts` | シークレットの定数時間比較 |
| `src/config.ts` | `TOPICS` と `TOPIC_WRITE_SECRETS` の解析 |
| `cloudflare.config.ts` | Worker、Cron、バインディングの設定 |
| `docs/design.md` | 設計メモ |
