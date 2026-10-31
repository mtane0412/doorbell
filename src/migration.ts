/**
 * Durable Object のスキーマ移行と、旧シークレットの一度だけの取り込み
 *
 * トピックと監視対象の設定を、シークレットから Durable Object の topics と sources へ移す。
 * opaque ID・トピック名・連番・確認位置をすべて引き継ぎ、Hook とエージェントの設定変更を不要にする。
 * sources テーブルの有無を移行済みの目印とし、移行後はシークレットを二度と読まない。
 *
 * 注意: 本番の動作確認後に、取り込み処理は旧シークレットとともに削除する（docs/design.md の「移行」）。
 */
import { hashSecret } from "./auth.ts";
import { parseTopics, parseWriteSecrets } from "./config.ts";

/** 取り込みに使う旧シークレット */
export type LegacySecrets = Pick<
	Env,
	| "TOPICS"
	| "TOPIC_WRITE_SECRETS"
	| "DISCORD_CHANNEL_ID"
	| "DISCORD_BOT_USER_ID"
	| "COSENSE_PROJECT"
	| "COSENSE_BOT_USER_ID"
>;

/** 既存の内蔵 producer が使っていたトピック名。sources.id は producer_state.producer と揃える */
const LEGACY_DISCORD_TOPIC = "discord-ietter";
const LEGACY_COSENSE_TOPIC = "cosense";

/** 必須の設定値が空なら例外を投げる。設定漏れのまま監視対象を作らないためである */
function requireValue(name: string, value: string): string {
	if (!value) {
		throw new Error(`${name} が設定されていません`);
	}
	return value;
}

/**
 * スキーマを最新にする。移行済みなら何もしない
 *
 * 旧シークレットの検証とハッシュ計算を先に済ませ、データベースの変更は1つのトランザクションで行う。
 * TOPIC_WRITE_SECRETS のうち TOPICS にない名前の値は、現在の実装でも使われないため取り込まない。
 *
 * @param storage Durable Object のストレージ
 * @param secrets 取り込む旧シークレット
 * @throws 旧シークレットの値が不正な場合。トランザクションは取り消され、次回の起動で再度実行される
 */
export async function migrateSchema(storage: DurableObjectStorage, secrets: LegacySecrets): Promise<void> {
	const { sql } = storage;
	if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sources'").toArray().length > 0) {
		return;
	}

	const writeSecrets = parseWriteSecrets(secrets.TOPIC_WRITE_SECRETS);
	const topics = await Promise.all(
		parseTopics(secrets.TOPICS).map(async ({ name, id }) => {
			const writeSecret = writeSecrets.get(name);
			return { name, id, writeSecretHash: writeSecret === undefined ? null : await hashSecret(writeSecret) };
		}),
	);
	for (const requiredTopic of [LEGACY_DISCORD_TOPIC, LEGACY_COSENSE_TOPIC]) {
		if (!topics.some((topic) => topic.name === requiredTopic)) {
			throw new Error(`TOPICS に ${requiredTopic} がありません`);
		}
	}
	const legacySources = [
		{
			id: "discord",
			target: requireValue("DISCORD_CHANNEL_ID", secrets.DISCORD_CHANNEL_ID),
			excludedUserId: requireValue("DISCORD_BOT_USER_ID", secrets.DISCORD_BOT_USER_ID),
			topic: LEGACY_DISCORD_TOPIC,
		},
		{
			id: "cosense",
			target: requireValue("COSENSE_PROJECT", secrets.COSENSE_PROJECT),
			excludedUserId: requireValue("COSENSE_BOT_USER_ID", secrets.COSENSE_BOT_USER_ID),
			topic: LEGACY_COSENSE_TOPIC,
		},
	];

	storage.transactionSync(() => {
		sql.exec(`
			CREATE TABLE IF NOT EXISTS topics (
				name TEXT PRIMARY KEY,
				seq INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS events (
				topic TEXT NOT NULL,
				seq INTEGER NOT NULL,
				created_at_ms INTEGER NOT NULL,
				kind TEXT NOT NULL,
				summary TEXT NOT NULL,
				ref TEXT,
				data TEXT,
				PRIMARY KEY (topic, seq)
			);
			CREATE TABLE IF NOT EXISTS producer_state (
				producer TEXT PRIMARY KEY,
				cursor TEXT NOT NULL
			);
			CREATE TABLE topics_migrated (
				name TEXT PRIMARY KEY,
				opaque_id TEXT NOT NULL UNIQUE,
				seq INTEGER NOT NULL,
				updated_at_ms INTEGER,
				write_secret_hash TEXT,
				deleted_at_ms INTEGER
			);
		`);

		// /signal の順序が TOPICS のままになるよう、登録順に挿入する
		for (const topic of topics) {
			sql.exec(
				`INSERT INTO topics_migrated (name, opaque_id, seq, updated_at_ms, write_secret_hash)
				 VALUES (
					?, ?,
					COALESCE((SELECT seq FROM topics WHERE name = ?), 0),
					(SELECT updated_at_ms FROM topics WHERE name = ?),
					?
				 )`,
				topic.name,
				topic.id,
				topic.name,
				topic.name,
				topic.writeSecretHash,
			);
		}

		// TOPICS から外されたトピックは現在も 404 を返す。opaque ID が失われているため新しく振り、
		// 論理削除として残すことで、同じ名前の再利用による連番の巻き戻りを防ぐ
		const retiredTopics = sql
			.exec<{ name: string; seq: number; updated_at_ms: number }>(
				"SELECT name, seq, updated_at_ms FROM topics WHERE name NOT IN (SELECT name FROM topics_migrated)",
			)
			.toArray();
		for (const retired of retiredTopics) {
			sql.exec(
				"INSERT INTO topics_migrated (name, opaque_id, seq, updated_at_ms, deleted_at_ms) VALUES (?, ?, ?, ?, ?)",
				retired.name,
				crypto.randomUUID(),
				retired.seq,
				retired.updated_at_ms,
				Date.now(),
			);
		}

		// SQLite の ALTER TABLE では UNIQUE 列の追加と NOT NULL の解除ができないため、テーブルを置き換える
		sql.exec(`
			DROP TABLE topics;
			ALTER TABLE topics_migrated RENAME TO topics;
			CREATE TABLE sources (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL CHECK (type IN ('discord', 'cosense')),
				target TEXT NOT NULL,
				excluded_user_id TEXT NOT NULL,
				topic TEXT NOT NULL UNIQUE REFERENCES topics(name),
				enabled INTEGER NOT NULL,
				last_error TEXT,
				UNIQUE (type, target)
			);
		`);
		for (const source of legacySources) {
			sql.exec(
				"INSERT INTO sources (id, type, target, excluded_user_id, topic, enabled) VALUES (?, ?, ?, ?, ?, 1)",
				source.id,
				source.id,
				source.target,
				source.excludedUserId,
				source.topic,
			);
		}
	});
}
