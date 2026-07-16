use std::{
    collections::HashSet,
    fs,
    io::{self, BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Serialize, de::DeserializeOwned};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    model::*,
};

pub const HISTORY_LIMIT: usize = 500;
pub const WORKSPACE_FILE_LIMIT: u64 = 64 * 1024 * 1024;
const SCHEMA_VERSION: i64 = 1;

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
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    initialize_schema(&mut conn)?;
    Ok(conn)
}

fn initialize_schema(conn: &mut Connection) -> AppResult<()> {
    let tx = conn.transaction()?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(invalid(format!(
            "database schema version {version} is newer than supported version {SCHEMA_VERSION}"
        )));
    }
    if version == 0 {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, data TEXT NOT NULL, executed_at INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS history_executed_at ON history(executed_at DESC);",
        )?;
        verify_schema(&tx)?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    } else {
        verify_schema(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

fn verify_schema(conn: &Connection) -> AppResult<()> {
    for (table, required) in [
        ("collections", &["id", "data", "updated_at"][..]),
        ("requests", &["id", "data", "updated_at"][..]),
        ("environments", &["id", "data", "updated_at"][..]),
        ("history", &["id", "data", "executed_at"][..]),
    ] {
        let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns: HashSet<String> = statement
            .query_map([], |row| row.get(1))?
            .collect::<Result<_, _>>()?;
        for column in required {
            if !columns.contains(*column) {
                return Err(invalid(format!(
                    "database table {table} is missing required column {column}"
                )));
            }
        }
    }
    let mut statement = conn.prepare("PRAGMA index_info(history_executed_at)")?;
    let columns: Vec<String> = statement
        .query_map([], |row| row.get(2))?
        .collect::<Result<_, _>>()?;
    if columns != ["executed_at"] {
        return Err(invalid(
            "database index history_executed_at is missing or incompatible",
        ));
    }
    Ok(())
}
fn validate_database(conn: &Connection) -> AppResult<()> {
    let mut statement = conn.prepare("PRAGMA quick_check")?;
    let checks: Vec<String> = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    if checks.as_slice() != ["ok"] {
        return Err(invalid(format!(
            "SQLite quick_check failed: {}",
            checks.join("; ")
        )));
    }
    validate_native(native_workspace(conn)?)?;
    Ok(())
}

pub fn open_recover(path: &Path) -> AppResult<(Connection, Option<String>)> {
    let existed = path.exists();
    match open(path).and_then(|conn| {
        validate_database(&conn)?;
        Ok(conn)
    }) {
        Ok(conn) => Ok((conn, None)),
        Err(error)
            if existed
                && matches!(
                    error,
                    AppError::Database(_) | AppError::Json(_) | AppError::Invalid(_)
                ) =>
        {
            let recovery = quarantine_database(path)?;
            let conn = open(path)?;
            validate_database(&conn)?;
            Ok((conn, Some(recovery.display().to_string())))
        }
        Err(error) => Err(error),
    }
}
fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn quarantine_database(path: &Path) -> AppResult<PathBuf> {
    let stamp = now_ms();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("postowl.sqlite3");
    let recovery = path.with_file_name(format!("{file_name}.recovery-{stamp}"));
    if recovery.exists() {
        return Err(invalid("database recovery destination already exists"));
    }
    let sources = [
        path.to_path_buf(),
        sidecar_path(path, "-wal"),
        sidecar_path(path, "-shm"),
    ];
    let destinations = [
        recovery.clone(),
        sidecar_path(&recovery, "-wal"),
        sidecar_path(&recovery, "-shm"),
    ];
    let mut moved = Vec::new();
    for (source, destination) in sources.iter().zip(&destinations) {
        if !source.exists() {
            continue;
        }
        if let Err(error) = fs::rename(source, destination) {
            for (old, new) in moved.into_iter().rev() {
                let _ = fs::rename(new, old);
            }
            return Err(error.into());
        }
        moved.push((source, destination));
    }
    Ok(recovery)
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

const MAX_ITEMS: usize = 10_000;
const MAX_NESTED_ITEMS: usize = 10_000;
const MAX_NAME: usize = 1_024;
const MAX_URL: usize = 32_768;
const MAX_TEXT: usize = 1_048_576;
const MAX_BODY: usize = 16 * 1_048_576;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

fn validate_id(id: &str) -> AppResult<()> {
    if id.is_empty() || id.len() > 256 || id.trim() != id {
        return Err(invalid(
            "id must be trimmed and contain 1 to 256 characters",
        ));
    }
    Ok(())
}

fn trim_name(value: &mut String, field: &str) -> AppResult<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_NAME {
        return Err(invalid(format!(
            "{field} must contain 1 to {MAX_NAME} characters"
        )));
    }
    if trimmed.len() != value.len() {
        *value = trimmed.to_owned();
    }
    Ok(())
}

fn bounded(value: &str, limit: usize, field: &str) -> AppResult<()> {
    if value.len() > limit {
        return Err(invalid(format!("{field} exceeds {limit} bytes")));
    }
    Ok(())
}

fn bounded_count(len: usize, limit: usize, field: &str) -> AppResult<()> {
    if len > limit {
        return Err(invalid(format!("{field} contains more than {limit} items")));
    }
    Ok(())
}

fn validate_named_values(values: &mut [NamedValue], field: &str) -> AppResult<()> {
    bounded_count(values.len(), MAX_NESTED_ITEMS, field)?;
    let mut ids = HashSet::with_capacity(values.len());
    for value in values {
        validate_id(&value.id)?;
        if !ids.insert(value.id.as_str()) {
            return Err(invalid(format!("duplicate {field} id {}", value.id)));
        }
        if value.enabled {
            trim_name(&mut value.name, &format!("{field} name"))?;
        } else {
            value.name = value.name.trim().to_owned();
            bounded(&value.name, MAX_NAME, &format!("{field} name"))?;
        }
        bounded(&value.value, MAX_TEXT, &format!("{field} value"))?;
    }
    Ok(())
}

fn validate_collection(value: &mut Collection) -> AppResult<()> {
    validate_id(&value.id)?;
    trim_name(&mut value.name, "collection name")?;
    bounded(&value.description, MAX_TEXT, "collection description")
}

fn validate_request(value: &mut Request) -> AppResult<()> {
    validate_id(&value.id)?;
    trim_name(&mut value.name, "request name")?;
    if let Some(collection_id) = &value.collection_id {
        validate_id(collection_id)?;
    }
    bounded(&value.method, 32, "request method")?;
    if value.method.trim().is_empty() || value.method.trim() != value.method {
        return Err(invalid("request method must be trimmed and nonempty"));
    }
    bounded(&value.url, MAX_URL, "request URL")?;
    validate_named_values(&mut value.headers, "request headers")?;
    validate_named_values(&mut value.query, "request query parameters")?;
    bounded(&value.body, MAX_BODY, "request body")?;
    bounded(&value.pre_request_script, MAX_TEXT, "pre-request script")?;
    bounded(
        &value.post_response_script,
        MAX_TEXT,
        "post-response script",
    )
}

fn validate_environment(value: &mut Environment) -> AppResult<()> {
    validate_id(&value.id)?;
    trim_name(&mut value.name, "environment name")?;
    validate_named_values(&mut value.variables, "environment variables")?;
    let mut enabled_names = HashSet::new();
    for variable in &value.variables {
        if variable.enabled && !enabled_names.insert(variable.name.as_str()) {
            return Err(invalid(format!(
                "duplicate enabled environment variable name {}",
                variable.name
            )));
        }
    }
    Ok(())
}

fn collection_exists(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1)",
        [id],
        |row| row.get(0),
    )?)
}

pub fn save_collection(conn: &Connection, mut value: Collection) -> AppResult<Collection> {
    validate_collection(&mut value)?;
    let now = now_ms();
    if value.created_at == 0 {
        value.created_at = now;
    }
    value.updated_at = now;
    conn.execute("INSERT INTO collections(id,data,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at", params![value.id, encode(&value)?, now])?;
    Ok(value)
}

pub fn save_request(conn: &Connection, mut value: Request) -> AppResult<Request> {
    validate_request(&mut value)?;
    if let Some(collection_id) = value.collection_id.as_deref()
        && !collection_exists(conn, collection_id)?
    {
        return Err(invalid(format!(
            "request {} references an unknown collection",
            value.id
        )));
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
    validate_environment(&mut value)?;
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
    if table == "collections" {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM requests WHERE json_extract(data, '$.collectionId')=?1",
            [id],
        )?;
        tx.execute("DELETE FROM collections WHERE id=?1", [id])?;
        tx.commit()?;
        return Ok(());
    }
    let sql = match table {
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

fn validate_history(entry: &mut HistoryEntry) -> AppResult<()> {
    validate_id(&entry.id)?;
    validate_id(&entry.request_id)?;
    trim_name(&mut entry.request_name, "history request name")?;
    bounded(&entry.method, 32, "history method")?;
    if entry.method.trim().is_empty() || entry.method.trim() != entry.method {
        return Err(invalid("history method must be trimmed and nonempty"));
    }
    bounded(&entry.url, MAX_URL, "history URL")?;
    bounded_count(
        entry.response.headers.len(),
        MAX_NESTED_ITEMS,
        "response headers",
    )?;
    for header in &mut entry.response.headers {
        trim_name(&mut header.name, "response header name")?;
        bounded(&header.value, MAX_TEXT, "response header value")?;
    }
    match entry.response.body_encoding.as_str() {
        UTF8_ENCODING => bounded(&entry.response.body, MAX_BODY, "response body")?,
        BASE64_ENCODING => {
            let decoded = BASE64
                .decode(&entry.response.body)
                .map_err(|error| invalid(format!("response body is not valid base64: {error}")))?;
            if decoded.len() > MAX_BODY {
                return Err(invalid(format!("response body exceeds {MAX_BODY} bytes")));
            }
        }
        encoding => {
            return Err(invalid(format!(
                "unsupported response body encoding {encoding}"
            )));
        }
    }
    bounded_count(
        entry.response.assertions.len(),
        MAX_NESTED_ITEMS,
        "response assertions",
    )?;
    for assertion in &mut entry.response.assertions {
        trim_name(&mut assertion.name, "assertion name")?;
        bounded(&assertion.message, MAX_TEXT, "assertion message")?;
    }
    bounded_count(entry.response.logs.len(), MAX_NESTED_ITEMS, "response logs")?;
    for log in &entry.response.logs {
        bounded(log, MAX_TEXT, "response log")?;
    }
    if let Some(error) = &entry.response.error {
        bounded(error, MAX_TEXT, "response error")?;
    }
    Ok(())
}

pub fn add_history(conn: &Connection, mut entry: HistoryEntry) -> AppResult<()> {
    validate_history(&mut entry)?;
    conn.execute(
        "INSERT INTO history(id,data,executed_at) VALUES(?1,?2,?3)",
        params![entry.id, encode(&entry)?, entry.executed_at],
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
    if value.schema != "postowl.workspace" {
        return Err(invalid("unsupported workspace schema"));
    }
    if value.version != 1 {
        return Err(invalid(format!(
            "unsupported workspace version {}",
            value.version
        )));
    }
    let mut workspace = value.workspace;
    bounded_count(workspace.collections.len(), MAX_ITEMS, "collections")?;
    bounded_count(workspace.requests.len(), MAX_ITEMS, "requests")?;
    bounded_count(workspace.environments.len(), MAX_ITEMS, "environments")?;
    bounded_count(workspace.history.len(), MAX_ITEMS, "history")?;

    let mut collection_ids = HashSet::with_capacity(workspace.collections.len());
    for collection in &mut workspace.collections {
        validate_collection(collection)?;
        if !collection_ids.insert(collection.id.as_str()) {
            return Err(invalid(format!(
                "duplicate collection id {}",
                collection.id
            )));
        }
    }
    let mut request_ids = HashSet::with_capacity(workspace.requests.len());
    for request in &mut workspace.requests {
        validate_request(request)?;
        if !request_ids.insert(request.id.as_str()) {
            return Err(invalid(format!("duplicate request id {}", request.id)));
        }
        if let Some(collection_id) = request.collection_id.as_deref()
            && !collection_ids.contains(collection_id)
        {
            return Err(invalid(format!(
                "request {} references an unknown collection",
                request.id
            )));
        }
    }
    let mut environment_ids = HashSet::with_capacity(workspace.environments.len());
    for environment in &mut workspace.environments {
        validate_environment(environment)?;
        if !environment_ids.insert(environment.id.as_str()) {
            return Err(invalid(format!(
                "duplicate environment id {}",
                environment.id
            )));
        }
    }
    let mut history_ids = HashSet::with_capacity(workspace.history.len());
    for entry in &mut workspace.history {
        validate_history(entry)?;
        if !history_ids.insert(entry.id.as_str()) {
            return Err(invalid(format!("duplicate history id {}", entry.id)));
        }
    }
    workspace.history.sort_by(|left, right| {
        right
            .executed_at
            .cmp(&left.executed_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    workspace.history.truncate(HISTORY_LIMIT);
    Ok(workspace)
}

fn insert_all(tx: &Transaction<'_>, workspace: &Workspace) -> AppResult<()> {
    tx.execute_batch("DELETE FROM history; DELETE FROM requests; DELETE FROM collections; DELETE FROM environments;")?;
    {
        let mut statement =
            tx.prepare("INSERT INTO collections(id,data,updated_at) VALUES(?1,?2,?3)")?;
        for value in &workspace.collections {
            statement.execute(params![value.id, encode(value)?, value.updated_at])?;
        }
    }
    {
        let mut statement =
            tx.prepare("INSERT INTO requests(id,data,updated_at) VALUES(?1,?2,?3)")?;
        for value in &workspace.requests {
            statement.execute(params![value.id, encode(value)?, value.updated_at])?;
        }
    }
    {
        let mut statement =
            tx.prepare("INSERT INTO environments(id,data,updated_at) VALUES(?1,?2,?3)")?;
        for value in &workspace.environments {
            statement.execute(params![value.id, encode(value)?, value.updated_at])?;
        }
    }
    {
        let mut statement =
            tx.prepare("INSERT INTO history(id,data,executed_at) VALUES(?1,?2,?3)")?;
        for value in workspace.history.iter().take(HISTORY_LIMIT) {
            statement.execute(params![value.id, encode(value)?, value.executed_at])?;
        }
    }
    Ok(())
}

pub fn import(conn: &mut Connection, path: &Path) -> AppResult<Workspace> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(WORKSPACE_FILE_LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > WORKSPACE_FILE_LIMIT {
        return Err(invalid("workspace file exceeds 64 MiB"));
    }
    let imported = validate_native(serde_json::from_slice(&bytes)?)?;
    let tx = conn.transaction()?;
    insert_all(&tx, &imported)?;
    tx.commit()?;
    workspace(conn)
}

struct CountingWriter<W> {
    inner: W,
    written: u64,
}

impl<W: Write> Write for CountingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.written.saturating_add(bytes.len() as u64) > WORKSPACE_FILE_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "workspace file exceeds 64 MiB",
            ));
        }
        let count = self.inner.write(bytes)?;
        self.written += count as u64;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both pointers reference NUL-terminated UTF-16 buffers for this call.
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub fn export(conn: &Connection, path: &Path) -> AppResult<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".postowl-{}.tmp", Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)?;
        let mut writer = CountingWriter {
            inner: BufWriter::new(file),
            written: 0,
        };
        serde_json::to_writer_pretty(&mut writer, &native_workspace(conn)?)?;
        writer.flush()?;
        writer.inner.get_ref().sync_all()?;
        drop(writer);
        replace_file(&tmp, path)?;
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
    use std::{fs, path::PathBuf};

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("postowl-{name}-{}.sqlite", Uuid::new_v4()))
    }

    fn collection(id: &str) -> Collection {
        Collection {
            id: id.into(),
            name: format!("Collection {id}"),
            description: "description".into(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn request_value(id: &str, collection_id: Option<&str>) -> Request {
        Request {
            id: id.into(),
            name: format!("Request {id}"),
            collection_id: collection_id.map(str::to_owned),
            method: "POST".into(),
            url: "https://example.test/resource".into(),
            headers: vec![],
            query: vec![],
            body_mode: BodyMode::Json,
            body: r#"{"ok":true}"#.into(),
            pre_request_script: String::new(),
            post_response_script: String::new(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn environment_value(id: &str) -> Environment {
        Environment {
            id: id.into(),
            name: format!("Environment {id}"),
            variables: vec![NamedValue {
                id: "variable".into(),
                name: "token".into(),
                value: "secret".into(),
                enabled: true,
            }],
            created_at: 0,
            updated_at: 0,
        }
    }

    fn history(id: &str, executed_at: i64) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            request_id: "request".into(),
            request_name: "Request".into(),
            method: "GET".into(),
            url: "https://example.test".into(),
            executed_at,
            response: ResponseData {
                status: Some(200),
                headers: vec![],
                body: id.into(),
                body_encoding: "utf8".into(),
                elapsed: 1,
                size: id.len() as u64,
                total_size: None,
                truncated: false,
                assertions: vec![],
                logs: vec![],
                error: None,
            },
        }
    }

    #[test]
    fn binary_history_body_limit_uses_decoded_size() {
        let mut entry = history("binary", 1);
        let bytes = vec![0xff; MAX_BODY];
        entry.response.body = BASE64.encode(&bytes);
        entry.response.body_encoding = BASE64_ENCODING.into();
        entry.response.size = bytes.len() as u64;

        validate_history(&mut entry).unwrap();
    }

    #[test]
    fn sqlite_crud_and_history_clear_are_observable() {
        let conn = open(Path::new(":memory:")).unwrap();
        let saved_collection = save_collection(&conn, collection("collection")).unwrap();
        let saved_request =
            save_request(&conn, request_value("request", Some("collection"))).unwrap();
        let saved_environment = save_environment(&conn, environment_value("environment")).unwrap();
        add_history(&conn, history("history", 10)).unwrap();

        assert!(saved_collection.created_at > 0);
        assert!(saved_request.updated_at > 0);
        assert!(saved_environment.created_at > 0);
        assert_eq!(request(&conn, "request").unwrap().body, r#"{"ok":true}"#);
        assert_eq!(
            environment(&conn, "environment").unwrap().variables[0].value,
            "secret"
        );
        let snapshot = workspace(&conn).unwrap();
        assert_eq!(snapshot.collections.len(), 1);
        assert_eq!(snapshot.requests.len(), 1);
        assert_eq!(snapshot.environments.len(), 1);
        assert_eq!(snapshot.history.len(), 1);

        delete(&conn, "requests", "request").unwrap();
        delete(&conn, "collections", "collection").unwrap();
        delete(&conn, "environments", "environment").unwrap();
        clear_history(&conn).unwrap();
        let snapshot = workspace(&conn).unwrap();
        assert!(snapshot.collections.is_empty());
        assert!(snapshot.requests.is_empty());
        assert!(snapshot.environments.is_empty());
        assert!(snapshot.history.is_empty());
        assert!(request(&conn, "request").is_err());
        assert!(environment(&conn, "environment").is_err());
    }

    #[test]
    fn deleting_collection_cascades_to_its_requests() {
        let conn = open(Path::new(":memory:")).unwrap();
        save_collection(&conn, collection("collection")).unwrap();
        save_request(&conn, request_value("child", Some("collection"))).unwrap();
        save_request(&conn, request_value("unrelated", None)).unwrap();

        delete(&conn, "collections", "collection").unwrap();

        let requests = workspace(&conn).unwrap().requests;
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].id, "unrelated");
    }

    #[test]
    fn live_saves_reject_orphans_blank_names_and_duplicate_enabled_variables() {
        let conn = open(Path::new(":memory:")).unwrap();

        assert!(save_request(&conn, request_value("orphan", Some("missing"))).is_err());
        assert!(workspace(&conn).unwrap().requests.is_empty());

        let mut blank = collection("blank");
        blank.name = " \t ".into();
        assert!(save_collection(&conn, blank).is_err());

        let mut environment = environment_value("duplicates");
        environment.variables.push(NamedValue {
            id: "other-variable".into(),
            name: " token ".into(),
            value: "other".into(),
            enabled: true,
        });
        assert!(save_environment(&conn, environment).is_err());
        assert!(workspace(&conn).unwrap().environments.is_empty());

        let mut disabled = environment_value("disabled-blank");
        disabled.variables.push(NamedValue {
            id: "disabled-variable".into(),
            name: " \t ".into(),
            value: String::new(),
            enabled: false,
        });
        let saved = save_environment(&conn, disabled).unwrap();
        assert_eq!(saved.variables.last().unwrap().name, "");
    }

    #[test]
    fn history_is_newest_first_and_capped() {
        let conn = open(Path::new(":memory:")).unwrap();
        for index in 0..HISTORY_LIMIT + 7 {
            add_history(&conn, history(&format!("history-{index:04}"), index as i64)).unwrap();
        }
        let entries = workspace(&conn).unwrap().history;
        assert_eq!(entries.len(), HISTORY_LIMIT);
        assert_eq!(entries.first().unwrap().executed_at, 506);
        assert_eq!(entries.last().unwrap().executed_at, 7);
    }

    #[test]
    fn file_database_survives_reopen() {
        let path = temp_path("reopen");
        {
            let conn = open(&path).unwrap();
            save_collection(&conn, collection("persisted")).unwrap();
            save_request(&conn, request_value("request", Some("persisted"))).unwrap();
            save_environment(&conn, environment_value("environment")).unwrap();
            add_history(&conn, history("history", 1)).unwrap();
        }
        let reopened = open(&path).unwrap();
        let snapshot = workspace(&reopened).unwrap();
        assert_eq!(snapshot.collections[0].id, "persisted");
        assert_eq!(snapshot.requests[0].id, "request");
        assert_eq!(snapshot.environments[0].id, "environment");
        assert_eq!(snapshot.history[0].id, "history");
        drop(reopened);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn native_export_import_roundtrip_replaces_workspace() {
        let source_path = temp_path("export-source");
        let target_path = temp_path("export-target");
        let export_path = temp_path("workspace-json");
        {
            let source = open(&source_path).unwrap();
            save_collection(&source, collection("collection")).unwrap();
            save_request(&source, request_value("request", Some("collection"))).unwrap();
            save_environment(&source, environment_value("environment")).unwrap();
            add_history(&source, history("history", 42)).unwrap();
            export(&source, &export_path).unwrap();
        }
        let encoded: NativeWorkspace =
            serde_json::from_slice(&fs::read(&export_path).unwrap()).unwrap();
        assert_eq!(encoded.schema, "postowl.workspace");
        assert_eq!(encoded.version, 1);

        let mut target = open(&target_path).unwrap();
        save_collection(&target, collection("old")).unwrap();
        let imported = import(&mut target, &export_path).unwrap();
        assert_eq!(imported.collections[0].id, "collection");
        let snapshot = workspace(&target).unwrap();
        assert_eq!(snapshot.collections.len(), 1);
        assert_eq!(snapshot.collections[0].id, "collection");
        assert_eq!(
            snapshot.requests[0].collection_id.as_deref(),
            Some("collection")
        );
        assert_eq!(snapshot.environments[0].variables[0].value, "secret");
        assert_eq!(snapshot.history[0].response.body, "history");
        drop(target);
        for path in [source_path, target_path, export_path] {
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn import_returns_persisted_canonical_history() {
        let db_path = temp_path("canonical-db");
        let import_path = temp_path("canonical-import");
        let mut entries: Vec<_> = (0..HISTORY_LIMIT + 7)
            .map(|index| history(&format!("history-{index:04}"), (index / 2) as i64))
            .collect();
        entries.reverse();
        let mut imported_collection = collection("collection");
        imported_collection.name = "  Canonical collection  ".into();
        let payload = NativeWorkspace {
            schema: "postowl.workspace".into(),
            version: 1,
            workspace: Workspace {
                collections: vec![imported_collection],
                history: entries,
                ..Workspace::default()
            },
        };
        fs::write(&import_path, serde_json::to_vec(&payload).unwrap()).unwrap();

        let mut conn = open(&db_path).unwrap();
        let imported = import(&mut conn, &import_path).unwrap();
        let persisted = workspace(&conn).unwrap();

        assert_eq!(imported.history.len(), HISTORY_LIMIT);
        assert_eq!(imported.history[0].id, "history-0506");
        assert_eq!(imported.history[1].id, "history-0505");
        assert_eq!(imported.history.last().unwrap().id, "history-0007");
        assert_eq!(imported.collections[0].name, "Canonical collection");
        assert_eq!(
            serde_json::to_value(&imported).unwrap(),
            serde_json::to_value(&persisted).unwrap()
        );
        drop(conn);
        let _ = fs::remove_file(db_path);
        let _ = fs::remove_file(import_path);
    }

    #[test]
    fn failed_import_write_rolls_back_the_replacement() {
        let import_path = temp_path("write-failure-import");
        let mut conn = open(Path::new(":memory:")).unwrap();
        save_collection(&conn, collection("existing")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER reject_imported_request
             BEFORE INSERT ON requests
             BEGIN
               SELECT RAISE(ABORT, 'forced import failure');
             END;",
        )
        .unwrap();
        let payload = NativeWorkspace {
            schema: "postowl.workspace".into(),
            version: 1,
            workspace: Workspace {
                collections: vec![collection("replacement")],
                requests: vec![request_value("request", Some("replacement"))],
                ..Workspace::default()
            },
        };
        fs::write(&import_path, serde_json::to_vec(&payload).unwrap()).unwrap();

        assert!(import(&mut conn, &import_path).is_err());
        let persisted = workspace(&conn).unwrap();
        assert_eq!(persisted.collections.len(), 1);
        assert_eq!(persisted.collections[0].id, "existing");
        assert!(persisted.requests.is_empty());
        let _ = fs::remove_file(import_path);
    }

    #[test]
    fn malformed_or_invalid_import_leaves_existing_workspace_intact() {
        let db_path = temp_path("rollback");
        let import_path = temp_path("invalid-import");
        let mut conn = open(&db_path).unwrap();
        save_collection(&conn, collection("existing")).unwrap();

        fs::write(&import_path, b"{not json").unwrap();
        assert!(import(&mut conn, &import_path).is_err());
        assert_eq!(workspace(&conn).unwrap().collections[0].id, "existing");

        let invalid = NativeWorkspace {
            schema: "postowl.workspace".into(),
            version: 1,
            workspace: Workspace {
                requests: vec![request_value("orphan", Some("missing"))],
                ..Workspace::default()
            },
        };
        fs::write(&import_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(import(&mut conn, &import_path).is_err());
        assert_eq!(workspace(&conn).unwrap().collections[0].id, "existing");
        drop(conn);
        let _ = fs::remove_file(db_path);
        let _ = fs::remove_file(import_path);
    }

    #[test]
    fn native_validation_rejects_wrong_schema_version_duplicates_and_orphans() {
        let mut value = NativeWorkspace {
            schema: "other".into(),
            version: 1,
            workspace: Workspace::default(),
        };
        assert!(validate_native(value.clone()).is_err());
        value.schema = "postowl.workspace".into();
        value.version = 2;
        assert!(validate_native(value).is_err());

        let duplicate = NativeWorkspace {
            schema: "postowl.workspace".into(),
            version: 1,
            workspace: Workspace {
                collections: vec![collection("duplicate"), collection("duplicate")],
                ..Workspace::default()
            },
        };
        assert!(validate_native(duplicate).is_err());
        let orphan = NativeWorkspace {
            schema: "postowl.workspace".into(),
            version: 1,
            workspace: Workspace {
                requests: vec![request_value("request", Some("missing"))],
                ..Workspace::default()
            },
        };
        assert!(validate_native(orphan).is_err());
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
    fn schema_rejects_future_versions_and_incomplete_current_schema() {
        let future = temp_path("future-schema");
        let conn = Connection::open(&future).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);
        assert!(open(&future).is_err());

        let stale = temp_path("stale-schema");
        let conn = Connection::open(&stale).unwrap();
        conn.execute_batch(
            "CREATE TABLE collections (id TEXT PRIMARY KEY, data TEXT NOT NULL);
             PRAGMA user_version=1;",
        )
        .unwrap();
        drop(conn);
        assert!(open(&stale).is_err());
        let _ = fs::remove_file(future);
        let _ = fs::remove_file(stale);
    }

    #[test]
    fn oversized_import_is_bounded_and_preserves_workspace() {
        let import_path = temp_path("oversized-import");
        let file = fs::File::create(&import_path).unwrap();
        file.set_len(WORKSPACE_FILE_LIMIT + 1).unwrap();
        let mut conn = open(Path::new(":memory:")).unwrap();
        save_collection(&conn, collection("existing")).unwrap();

        assert!(import(&mut conn, &import_path).is_err());
        assert_eq!(workspace(&conn).unwrap().collections[0].id, "existing");
        let _ = fs::remove_file(import_path);
    }

    #[test]
    fn corrupt_database_is_quarantined_and_replaced_with_a_valid_database() {
        let path = temp_path("corrupt-recovery");
        fs::write(&path, b"not a sqlite database").unwrap();

        let (conn, warning) = open_recover(&path).unwrap();
        let recovery = PathBuf::from(warning.expect("recovery path"));
        assert_eq!(fs::read(&recovery).unwrap(), b"not a sqlite database");
        assert!(workspace(&conn).unwrap().collections.is_empty());
        drop(conn);
        let reopened = open(&path).unwrap();
        assert!(workspace(&reopened).unwrap().collections.is_empty());
        drop(reopened);
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(recovery);
    }

    #[test]
    fn export_overwrites_existing_destination_and_failed_replace_preserves_it() {
        let path = temp_path("overwrite-export");
        fs::write(&path, b"old destination").unwrap();
        let conn = open(Path::new(":memory:")).unwrap();
        save_collection(&conn, collection("exported")).unwrap();
        export(&conn, &path).unwrap();
        let exported: NativeWorkspace = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(exported.workspace.collections[0].id, "exported");

        fs::write(&path, b"preserve me").unwrap();
        let missing = temp_path("missing-source");
        assert!(replace_file(&missing, &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"preserve me");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn counting_writer_rejects_aggregate_output_over_budget() {
        let mut writer = CountingWriter {
            inner: Vec::new(),
            written: WORKSPACE_FILE_LIMIT,
        };
        assert!(writer.write_all(b"x").is_err());
        assert!(writer.inner.is_empty());
    }
}
