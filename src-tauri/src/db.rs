use std::{
    collections::HashSet,
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Serialize, de::DeserializeOwned};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    model::*,
};

pub const HISTORY_LIMIT: usize = 500;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

pub fn open(path: &Path) -> AppResult<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, data TEXT NOT NULL, executed_at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS history_executed_at ON history(executed_at DESC);"
    )?;
    Ok(conn)
}

fn decode<T: DeserializeOwned>(raw: String) -> AppResult<T> {
    Ok(serde_json::from_str(&raw)?)
}
fn encode<T: Serialize>(value: &T) -> AppResult<String> {
    Ok(serde_json::to_string(value)?)
}

fn list<T: DeserializeOwned>(conn: &Connection, sql: &str) -> AppResult<Vec<T>> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    rows.map(|row| decode(row.map_err(AppError::from)?))
        .collect()
}

pub fn workspace(conn: &Connection) -> AppResult<Workspace> {
    Ok(Workspace {
        collections: list(conn, "SELECT data FROM collections ORDER BY updated_at, id")?,
        requests: list(conn, "SELECT data FROM requests ORDER BY updated_at, id")?,
        environments: list(
            conn,
            "SELECT data FROM environments ORDER BY updated_at, id",
        )?,
        history: list(
            conn,
            "SELECT data FROM history ORDER BY executed_at DESC, id DESC LIMIT 500",
        )?,
    })
}

fn validate_id(id: &str) -> AppResult<()> {
    if id.trim().is_empty() || id.len() > 256 {
        return Err(AppError::Invalid(
            "id must contain 1 to 256 characters".into(),
        ));
    }
    Ok(())
}

pub fn save_collection(conn: &Connection, mut value: Collection) -> AppResult<Collection> {
    validate_id(&value.id)?;
    let now = now_ms();
    if value.created_at == 0 {
        value.created_at = now;
    }
    value.updated_at = now;
    conn.execute("INSERT INTO collections(id,data,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at", params![value.id, encode(&value)?, now])?;
    Ok(value)
}

pub fn save_request(conn: &Connection, mut value: Request) -> AppResult<Request> {
    validate_id(&value.id)?;
    if value.url.len() > 32_768 {
        return Err(AppError::Invalid("request URL is too long".into()));
    }
    let now = now_ms();
    if value.created_at == 0 {
        value.created_at = now;
    }
    value.updated_at = now;
    conn.execute("INSERT INTO requests(id,data,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at", params![value.id, encode(&value)?, now])?;
    Ok(value)
}

pub fn save_environment(conn: &Connection, mut value: Environment) -> AppResult<Environment> {
    validate_id(&value.id)?;
    let now = now_ms();
    if value.created_at == 0 {
        value.created_at = now;
    }
    value.updated_at = now;
    conn.execute("INSERT INTO environments(id,data,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at", params![value.id, encode(&value)?, now])?;
    Ok(value)
}

pub fn delete(conn: &Connection, table: &str, id: &str) -> AppResult<()> {
    validate_id(id)?;
    let sql = match table {
        "collections" => "DELETE FROM collections WHERE id=?1",
        "requests" => "DELETE FROM requests WHERE id=?1",
        "environments" => "DELETE FROM environments WHERE id=?1",
        _ => return Err(AppError::State("invalid table".into())),
    };
    conn.execute(sql, [id])?;
    Ok(())
}

pub fn request(conn: &Connection, id: &str) -> AppResult<Request> {
    let raw = conn
        .query_row("SELECT data FROM requests WHERE id=?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("request {id}")))?;
    decode(raw)
}

pub fn environment(conn: &Connection, id: &str) -> AppResult<Environment> {
    let raw = conn
        .query_row("SELECT data FROM environments WHERE id=?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("environment {id}")))?;
    decode(raw)
}

pub fn add_history(conn: &Connection, entry: &HistoryEntry) -> AppResult<()> {
    conn.execute(
        "INSERT INTO history(id,data,executed_at) VALUES(?1,?2,?3)",
        params![entry.id, encode(entry)?, entry.executed_at],
    )?;
    conn.execute("DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY executed_at DESC, id DESC LIMIT -1 OFFSET ?1)", [HISTORY_LIMIT as i64])?;
    Ok(())
}

pub fn clear_history(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM history", [])?;
    Ok(())
}

pub fn native_workspace(conn: &Connection) -> AppResult<NativeWorkspace> {
    Ok(NativeWorkspace {
        schema: "postowl.workspace".into(),
        version: 1,
        workspace: workspace(conn)?,
    })
}

pub fn validate_native(value: NativeWorkspace) -> AppResult<Workspace> {
    const MAX_ITEMS: usize = 10_000;
    if value.schema != "postowl.workspace" {
        return Err(AppError::Invalid("unsupported workspace schema".into()));
    }
    if value.version != 1 {
        return Err(AppError::Invalid(format!(
            "unsupported workspace version {}",
            value.version
        )));
    }
    let workspace = value.workspace;
    if workspace.collections.len() > MAX_ITEMS
        || workspace.requests.len() > MAX_ITEMS
        || workspace.environments.len() > MAX_ITEMS
        || workspace.history.len() > MAX_ITEMS
    {
        return Err(AppError::Invalid(
            "workspace contains more than 10,000 items in a section".into(),
        ));
    }

    let mut collection_ids = HashSet::with_capacity(workspace.collections.len());
    for collection in &workspace.collections {
        validate_id(&collection.id)?;
        if !collection_ids.insert(collection.id.as_str()) {
            return Err(AppError::Invalid(format!(
                "duplicate collection id {}",
                collection.id
            )));
        }
    }
    let mut request_ids = HashSet::with_capacity(workspace.requests.len());
    for request in &workspace.requests {
        validate_id(&request.id)?;
        if !request_ids.insert(request.id.as_str()) {
            return Err(AppError::Invalid(format!(
                "duplicate request id {}",
                request.id
            )));
        }
        if let Some(collection_id) = request.collection_id.as_deref() {
            if !collection_ids.contains(collection_id) {
                return Err(AppError::Invalid(format!(
                    "request {} references an unknown collection",
                    request.id
                )));
            }
        }
    }
    let mut environment_ids = HashSet::with_capacity(workspace.environments.len());
    for environment in &workspace.environments {
        validate_id(&environment.id)?;
        if !environment_ids.insert(environment.id.as_str()) {
            return Err(AppError::Invalid(format!(
                "duplicate environment id {}",
                environment.id
            )));
        }
    }
    let mut history_ids = HashSet::with_capacity(workspace.history.len());
    for entry in &workspace.history {
        validate_id(&entry.id)?;
        if !history_ids.insert(entry.id.as_str()) {
            return Err(AppError::Invalid(format!(
                "duplicate history id {}",
                entry.id
            )));
        }
    }
    Ok(workspace)
}

fn insert_all(tx: &Transaction<'_>, workspace: &Workspace) -> AppResult<()> {
    tx.execute_batch("DELETE FROM history; DELETE FROM requests; DELETE FROM collections; DELETE FROM environments;")?;
    for value in &workspace.collections {
        tx.execute(
            "INSERT INTO collections(id,data,updated_at) VALUES(?1,?2,?3)",
            params![value.id, encode(value)?, value.updated_at],
        )?;
    }
    for value in &workspace.requests {
        tx.execute(
            "INSERT INTO requests(id,data,updated_at) VALUES(?1,?2,?3)",
            params![value.id, encode(value)?, value.updated_at],
        )?;
    }
    for value in &workspace.environments {
        tx.execute(
            "INSERT INTO environments(id,data,updated_at) VALUES(?1,?2,?3)",
            params![value.id, encode(value)?, value.updated_at],
        )?;
    }
    for value in workspace.history.iter().take(HISTORY_LIMIT) {
        tx.execute(
            "INSERT INTO history(id,data,executed_at) VALUES(?1,?2,?3)",
            params![value.id, encode(value)?, value.executed_at],
        )?;
    }
    Ok(())
}

pub fn import(conn: &mut Connection, path: &Path) -> AppResult<Workspace> {
    const MAX_IMPORT: u64 = 64 * 1024 * 1024;
    if fs::metadata(path)?.len() > MAX_IMPORT {
        return Err(AppError::Invalid("workspace file exceeds 64 MiB".into()));
    }
    let workspace = validate_native(serde_json::from_slice(&fs::read(path)?)?)?;
    let tx = conn.transaction()?;
    insert_all(&tx, &workspace)?;
    tx.commit()?;
    Ok(workspace)
}

pub fn export(conn: &Connection, path: &Path) -> AppResult<()> {
    let payload = serde_json::to_vec_pretty(&native_workspace(conn)?)?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".postowl-{}.tmp", Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)?;
        file.write_all(&payload)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_validation_rejects_wrong_schema_and_version() {
        let mut value = NativeWorkspace {
            schema: "other".into(),
            version: 1,
            workspace: Workspace::default(),
        };
        assert!(validate_native(value.clone()).is_err());
        value.schema = "postowl.workspace".into();
        value.version = 2;
        assert!(validate_native(value).is_err());
    }

    #[test]
    fn native_validation_accepts_v1() {
        let value = NativeWorkspace {
            schema: "postowl.workspace".into(),
            version: 1,
            workspace: Workspace::default(),
        };
        assert!(validate_native(value).is_ok());
    }
    #[test]
    fn native_validation_rejects_duplicate_ids() {
        let collection = Collection {
            id: "duplicate".into(),
            name: "One".into(),
            description: String::new(),
            created_at: 0,
            updated_at: 0,
        };
        let workspace = Workspace {
            collections: vec![collection.clone(), collection],
            ..Workspace::default()
        };
        let value = NativeWorkspace {
            schema: "postowl.workspace".into(),
            version: 1,
            workspace,
        };
        assert!(validate_native(value).is_err());
    }
}
