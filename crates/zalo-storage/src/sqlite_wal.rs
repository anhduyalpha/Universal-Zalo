use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Arc;
use zalo_crypto::RatchetState;

pub struct SqliteWalStorage {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteWalStorage {
    pub fn open<P: AsRef<Path>>(db_path: P) -> Result<Self> {
        let conn = Connection::open(db_path)?;

        // Thiết lập chế độ WAL và Synchronous NORMAL cho độ trễ < 0.2ms
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA temp_store = MEMORY;
            PRAGMA cache_size = -64000;

            CREATE TABLE IF NOT EXISTS ratchet_sessions (
                conversation_id TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            ",
        )?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn save_ratchet_state(&self, conversation_id: &str, state: &RatchetState) -> Result<()> {
        let json_str = serde_json::to_string(state)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;

        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO ratchet_sessions (conversation_id, state_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(conversation_id) DO UPDATE SET
                state_json = excluded.state_json,
                updated_at = excluded.updated_at;",
            params![conversation_id, json_str, now],
        )?;

        Ok(())
    }

    pub fn load_ratchet_state(&self, conversation_id: &str) -> Result<Option<RatchetState>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT state_json FROM ratchet_sessions WHERE conversation_id = ?1;",
        )?;

        let mut rows = stmt.query(params![conversation_id])?;
        if let Some(row) = rows.next()? {
            let json_str: String = row.get(0)?;
            let state: RatchetState = serde_json::from_str(&json_str)?;
            Ok(Some(state))
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn test_sqlite_wal_persistence() {
        let temp_file = NamedTempFile::new().unwrap();
        let storage = SqliteWalStorage::open(temp_file.path()).unwrap();

        let state = RatchetState::new([99u8; 32]);
        storage.save_ratchet_state("conv_alice_123", &state).unwrap();

        let loaded = storage.load_ratchet_state("conv_alice_123").unwrap().unwrap();
        assert_eq!(loaded.root_key, [99u8; 32]);
        assert_eq!(loaded.send_msg_index, 0);
    }
}
