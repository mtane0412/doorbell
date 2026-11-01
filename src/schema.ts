/**
 * Durable Object の SQLite のスキーマ
 *
 * Durable Object の起動のたびに実行する。テーブルがあれば何も変更しない。
 * トピックと監視対象は管理ページの doorbell-admin から登録するため、新しい環境では空である。
 */

/**
 * テーブルがなければ作成する
 *
 * @param sql Durable Object の SQLite
 */
export function createSchema(sql: SqlStorage): void {
	sql.exec(`
		CREATE TABLE IF NOT EXISTS topics (
			name TEXT PRIMARY KEY,
			opaque_id TEXT NOT NULL UNIQUE,
			seq INTEGER NOT NULL,
			updated_at_ms INTEGER,
			write_secret_hash TEXT,
			deleted_at_ms INTEGER
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
		CREATE TABLE IF NOT EXISTS sources (
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
}
