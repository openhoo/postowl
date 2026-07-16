use std::{
    collections::HashSet,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use reqwest::{
    Client, Method, Url,
    header::{CONTENT_TYPE, HeaderName, HeaderValue as ReqHeaderValue},
};
use serde_json::{Map, Value};
use tauri::State;
use uuid::Uuid;

use crate::{
    db,
    error::{AppError, AppResult},
    model::*,
    script,
};

const RESPONSE_LIMIT: usize = 16 * 1024 * 1024;
const REQUEST_BODY_LIMIT: usize = 20 * 1024 * 1024;
const SCRIPT_RESPONSE_LIMIT: usize = 1024 * 1024;
const ITEM_LIMIT: usize = 1_000;
const VARIABLE_NAME_LIMIT: usize = 1_024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub client: Client,
}

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::State("database lock was poisoned".into()))
}

#[tauri::command]
pub fn get_workspace(state: State<'_, AppState>) -> AppResult<Workspace> {
    db::workspace(&*lock_db(&state)?)
}

#[tauri::command]
pub fn save_collection(
    state: State<'_, AppState>,
    collection: Collection,
) -> AppResult<Collection> {
    db::save_collection(&*lock_db(&state)?, collection)
}

#[tauri::command]
pub fn delete_collection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    db::delete(&*lock_db(&state)?, "collections", &id)
}

#[tauri::command]
pub fn save_request(state: State<'_, AppState>, request: Request) -> AppResult<Request> {
    db::save_request(&*lock_db(&state)?, request)
}

#[tauri::command]
pub fn delete_request(state: State<'_, AppState>, id: String) -> AppResult<()> {
    db::delete(&*lock_db(&state)?, "requests", &id)
}

#[tauri::command]
pub fn save_environment(
    state: State<'_, AppState>,
    environment: Environment,
) -> AppResult<Environment> {
    db::save_environment(&*lock_db(&state)?, environment)
}

#[tauri::command]
pub fn delete_environment(state: State<'_, AppState>, id: String) -> AppResult<()> {
    db::delete(&*lock_db(&state)?, "environments", &id)
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> AppResult<()> {
    db::clear_history(&*lock_db(&state)?)
}

#[tauri::command]
pub fn export_workspace(state: State<'_, AppState>, path: String) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::Invalid("export path is empty".into()));
    }
    db::export(&*lock_db(&state)?, &PathBuf::from(path))
}

#[tauri::command]
pub fn import_workspace(state: State<'_, AppState>, path: String) -> AppResult<Workspace> {
    if path.trim().is_empty() {
        return Err(AppError::Invalid("import path is empty".into()));
    }
    db::import(&mut *lock_db(&state)?, &PathBuf::from(path))
}

pub fn interpolate(input: &str, variables: &Map<String, Value>) -> AppResult<String> {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            return Err(AppError::Invalid("unterminated variable expression".into()));
        };
        let name = after[..end].trim();
        if name.is_empty() {
            return Err(AppError::Invalid("empty variable expression".into()));
        }
        let value = variables
            .get(name)
            .ok_or_else(|| AppError::Invalid(format!("unknown variable: {name}")))?;
        match value {
            Value::String(value) => output.push_str(value),
            Value::Null => {}
            Value::Bool(_) | Value::Number(_) => output.push_str(&value.to_string()),
            _ => {
                return Err(AppError::Invalid(format!(
                    "variable {name} is not a scalar"
                )));
            }
        }
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    Ok(output)
}

fn variables(environment: Option<&Environment>) -> Map<String, Value> {
    environment
        .into_iter()
        .flat_map(|env| &env.variables)
        .filter(|item| item.enabled)
        .map(|item| (item.name.clone(), Value::String(item.value.clone())))
        .collect()
}

fn resolve_request(request: &ScriptRequest, vars: &Map<String, Value>) -> AppResult<ScriptRequest> {
    Ok(ScriptRequest {
        method: interpolate(&request.method, vars)?,
        url: interpolate(&request.url, vars)?,
        headers: request
            .headers
            .iter()
            .map(|item| {
                if !item.enabled {
                    return Ok(item.clone());
                }
                Ok(NamedValue {
                    id: item.id.clone(),
                    name: interpolate(&item.name, vars)?,
                    value: interpolate(&item.value, vars)?,
                    enabled: true,
                })
            })
            .collect::<AppResult<_>>()?,
        query: request
            .query
            .iter()
            .map(|item| {
                if !item.enabled {
                    return Ok(item.clone());
                }
                Ok(NamedValue {
                    id: item.id.clone(),
                    name: interpolate(&item.name, vars)?,
                    value: interpolate(&item.value, vars)?,
                    enabled: true,
                })
            })
            .collect::<AppResult<_>>()?,
        body_mode: request.body_mode,
        body: match request.body_mode {
            BodyMode::None => request.body.clone(),
            BodyMode::Text | BodyMode::Json | BodyMode::Form => interpolate(&request.body, vars)?,
        },
    })
}

fn effective_request_url(request: &ScriptRequest) -> String {
    let Ok(mut url) = Url::parse(&request.url) else {
        return request.url.clone();
    };
    {
        let mut query = url.query_pairs_mut();
        for item in request.query.iter().filter(|item| item.enabled) {
            query.append_pair(&item.name, &item.value);
        }
    }
    url.into()
}

fn normalize_variable_changes(changes: Map<String, Value>) -> AppResult<Map<String, Value>> {
    let mut normalized = Map::new();
    for (name, value) in changes {
        let name = name.trim();
        if name.is_empty() || name.len() > VARIABLE_NAME_LIMIT {
            return Err(AppError::Invalid(format!(
                "environment variables name must contain 1 to {VARIABLE_NAME_LIMIT} characters"
            )));
        }
        if !matches!(
            value,
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
        ) {
            return Err(AppError::Invalid(format!(
                "variable {name} is not a scalar"
            )));
        }
        if normalized.insert(name.to_owned(), value).is_some() {
            return Err(AppError::Invalid(format!(
                "duplicate enabled environment variable name {name}"
            )));
        }
    }
    Ok(normalized)
}

fn merge_variables(
    target: &mut Map<String, Value>,
    changes: Map<String, Value>,
) -> AppResult<HashSet<String>> {
    let changes = normalize_variable_changes(changes)?;
    let names = changes.keys().cloned().collect();
    target.extend(changes);
    Ok(names)
}

fn apply_variable_changes(environment: &mut Environment, changes: &Map<String, Value>) {
    let mut additions = Vec::new();
    for (name, value) in changes {
        let text = match value {
            Value::String(value) => value.clone(),
            Value::Null => String::new(),
            _ => value.to_string(),
        };
        if let Some(variable) = environment
            .variables
            .iter_mut()
            .find(|item| item.enabled && item.name == *name)
        {
            variable.value = text;
        } else {
            additions.push(NamedValue {
                id: Uuid::new_v4().to_string(),
                name: name.clone(),
                value: text,
                enabled: true,
            });
        }
    }
    environment.variables.extend(additions);
}

fn persist_variables(
    state: &AppState,
    environment_id: &str,
    changes: &Map<String, Value>,
) -> AppResult<()> {
    let conn = lock_db(state)?;
    let mut environment = db::environment(&conn, environment_id)?;
    apply_variable_changes(&mut environment, changes);
    db::save_environment(&conn, environment)?;
    Ok(())
}

fn retain_newest<T>(items: &mut Vec<T>, limit: usize) {
    if items.len() > limit {
        items.drain(..items.len() - limit);
    }
}

fn encode_bytes(bytes: &[u8]) -> (String, String) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_owned(), UTF8_ENCODING.into()),
        Err(_) => (BASE64.encode(bytes), BASE64_ENCODING.into()),
    }
}

fn append_ancillary_warning(response: &mut ResponseData, name: &str, message: String) {
    response.assertions.push(AssertionResult {
        name: name.into(),
        passed: false,
        message: message.clone(),
    });
    response.logs.push(message);
    retain_newest(&mut response.assertions, 100);
    retain_newest(&mut response.logs, 100);
}

async fn perform(client: &Client, request: &ScriptRequest) -> AppResult<ResponseData> {
    if request.url.len() > 32_768 {
        return Err(AppError::Invalid("request URL exceeds 32 KiB".into()));
    }
    if request.body.len() > REQUEST_BODY_LIMIT {
        return Err(AppError::Invalid("request body exceeds 20 MiB".into()));
    }
    let enabled_headers = request.headers.iter().filter(|item| item.enabled).count();
    if enabled_headers > ITEM_LIMIT {
        return Err(AppError::Invalid(
            "request exceeds 1,000 enabled headers".into(),
        ));
    }
    let enabled_query = request.query.iter().filter(|item| item.enabled).count();
    if enabled_query > ITEM_LIMIT {
        return Err(AppError::Invalid(
            "request exceeds 1,000 enabled query items".into(),
        ));
    }
    let method = Method::from_bytes(request.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|e| AppError::Invalid(format!("invalid HTTP method: {e}")))?;
    let mut builder = client
        .request(method, &request.url)
        .timeout(REQUEST_TIMEOUT);
    let has_content_type = request
        .headers
        .iter()
        .any(|item| item.enabled && item.name.eq_ignore_ascii_case("content-type"));
    for header in request.headers.iter().filter(|item| item.enabled) {
        let name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|e| AppError::Invalid(format!("invalid header name {}: {e}", header.name)))?;
        let value = ReqHeaderValue::from_str(&header.value).map_err(|e| {
            AppError::Invalid(format!("invalid header value for {}: {e}", header.name))
        })?;
        builder = builder.header(name, value);
    }
    let query: Vec<(&str, &str)> = request
        .query
        .iter()
        .filter(|item| item.enabled)
        .map(|item| (item.name.as_str(), item.value.as_str()))
        .collect();
    builder = builder.query(&query);
    builder = match request.body_mode {
        BodyMode::None => builder,
        BodyMode::Text => builder.body(request.body.clone()),
        BodyMode::Json => {
            let body: Value = serde_json::from_str(&request.body)
                .map_err(|e| AppError::Invalid(format!("invalid JSON request body: {e}")))?;
            builder.json(&body)
        }
        BodyMode::Form => {
            if !has_content_type {
                builder = builder.header(CONTENT_TYPE, "application/x-www-form-urlencoded");
            }
            builder.body(request.body.clone())
        }
    };

    let started = Instant::now();
    let mut response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            return Ok(ResponseData {
                status: None,
                headers: vec![],
                body: String::new(),
                body_encoding: UTF8_ENCODING.into(),
                elapsed: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                size: 0,
                total_size: None,
                truncated: false,
                assertions: vec![],
                logs: vec![],
                error: Some(error.to_string()),
            });
        }
    };
    let status = response.status().as_u16();
    let total_size = response.content_length();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            let (value, encoding) = encode_bytes(value.as_bytes());
            HeaderValue {
                name: name.to_string(),
                value,
                encoding,
            }
        })
        .collect();
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(RESPONSE_LIMIT as u64) as usize,
    );
    let mut truncated = false;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let remaining = RESPONSE_LIMIT.saturating_sub(bytes.len());
                let captured = chunk.len().min(remaining);
                bytes.extend_from_slice(&chunk[..captured]);
                if captured < chunk.len() {
                    truncated = true;
                    break;
                }
            }
            Ok(None) => break,
            Err(error) => {
                truncated = true;
                let message = format!(
                    "response body read failed after {} captured bytes: {error}",
                    bytes.len()
                );
                let (body, body_encoding) = encode_bytes(&bytes);
                return Ok(ResponseData {
                    status: Some(status),
                    headers,
                    body,
                    body_encoding,
                    elapsed: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    size: bytes.len() as u64,
                    total_size,
                    truncated,
                    assertions: vec![],
                    logs: vec![message.clone()],
                    error: Some(message),
                });
            }
        }
    }
    let (body, body_encoding) = encode_bytes(&bytes);
    Ok(ResponseData {
        status: Some(status),
        headers,
        body,
        body_encoding,
        elapsed: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        size: bytes.len() as u64,
        total_size,
        truncated,
        assertions: vec![],
        logs: vec![],
        error: None,
    })
}

fn script_response_view(response: &ResponseData) -> ResponseData {
    let mut view = response.clone();
    if view.body.len() > SCRIPT_RESPONSE_LIMIT {
        let mut boundary = SCRIPT_RESPONSE_LIMIT;
        if view.body_encoding == BASE64_ENCODING {
            boundary -= boundary % 4;
        } else {
            while !view.body.is_char_boundary(boundary) {
                boundary -= 1;
            }
        }
        view.body.truncate(boundary);
        view.truncated = true;
    }
    view
}

#[tauri::command]
pub async fn execute_request(
    state: State<'_, AppState>,
    request_id: String,
    environment_id: Option<String>,
) -> AppResult<ResponseData> {
    let (request, environment) = {
        let conn = lock_db(&state)?;
        let request = db::request(&conn, &request_id)?;
        let environment = environment_id
            .as_deref()
            .map(|id| db::environment(&conn, id))
            .transpose()?;
        (request, environment)
    };
    let mut vars = variables(environment.as_ref());
    let initial_vars = vars.clone();
    let mut changed_names = HashSet::new();
    let original = ScriptRequest {
        method: request.method.clone(),
        url: request.url.clone(),
        headers: request.headers.clone(),
        query: request.query.clone(),
        body_mode: request.body_mode,
        body: request.body.clone(),
    };
    let pre = script::run_pre(
        &request.pre_request_script,
        &PreScriptContext {
            request: original.clone(),
            variables: vars.clone(),
        },
    )?;
    if let Some(changes) = pre.variables {
        changed_names.extend(merge_variables(&mut vars, changes)?);
    }
    let scripted = pre.request.unwrap_or(original);
    let resolved = resolve_request(&scripted, &vars)?;
    let mut response = perform(&state.client, &resolved).await?;
    let response_logs = std::mem::take(&mut response.logs);
    response.assertions = pre.assertions;
    response.logs = pre.logs;
    response.logs.extend(response_logs);
    match script::run_post(
        &request.post_response_script,
        &PostScriptContext {
            request: resolved.clone(),
            response: script_response_view(&response),
            variables: vars.clone(),
        },
    ) {
        Ok(post) => {
            response.assertions.extend(post.assertions);
            response.logs.extend(post.logs);
            if let Some(changes) = post.variables {
                match merge_variables(&mut vars, changes) {
                    Ok(names) => changed_names.extend(names),
                    Err(error) => {
                        append_ancillary_warning(
                            &mut response,
                            "Post-response variables",
                            error.to_string(),
                        );
                    }
                }
            }
        }
        Err(error) => {
            append_ancillary_warning(&mut response, "Post-response script", error.to_string());
        }
    }
    let changes: Map<String, Value> = changed_names
        .into_iter()
        .filter(|name| initial_vars.get(name) != vars.get(name))
        .filter_map(|name| vars.get(&name).cloned().map(|value| (name, value)))
        .collect();
    if !changes.is_empty() {
        if let Some(environment_id) = environment_id.as_deref() {
            if let Err(error) = persist_variables(&state, environment_id, &changes) {
                append_ancillary_warning(
                    &mut response,
                    "Environment persistence",
                    format!("Response completed, but script variables were not persisted: {error}"),
                );
            }
        } else {
            response.logs.push(
                "Script variables were not persisted because no environment is active.".into(),
            );
            retain_newest(&mut response.logs, 100);
        }
    }
    retain_newest(&mut response.assertions, 100);
    retain_newest(&mut response.logs, 100);
    let effective_url = effective_request_url(&resolved);
    let history = HistoryEntry {
        id: Uuid::new_v4().to_string(),
        request_id: request.id,
        request_name: request.name,
        method: resolved.method,
        url: effective_url,
        executed_at: db::now_ms(),
        response: response.clone(),
    };
    let history_result = lock_db(&state).and_then(|conn| db::add_history(&conn, &history));
    if let Err(error) = history_result {
        append_ancillary_warning(
            &mut response,
            "History persistence",
            format!("Response completed, but history was not recorded: {error}"),
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::mpsc,
        thread,
    };

    fn item(name: &str, value: &str, enabled: bool) -> NamedValue {
        NamedValue {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            value: value.into(),
            enabled,
        }
    }

    fn script_request(url: String) -> ScriptRequest {
        ScriptRequest {
            method: "GET".into(),
            url,
            headers: vec![],
            query: vec![],
            body_mode: BodyMode::None,
            body: String::new(),
        }
    }

    fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut received = Vec::new();
        let mut buffer = [0_u8; 4096];
        let mut expected = None;
        loop {
            let count = stream.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            received.extend_from_slice(&buffer[..count]);
            if expected.is_none() {
                if let Some(header_end) = received.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    expected = Some(header_end + 4 + content_length);
                }
            }
            if expected.is_some_and(|length| received.len() >= length) {
                break;
            }
        }
        received
    }

    #[test]
    fn interpolation_handles_adjacent_scalar_and_null_values() {
        let vars = Map::from_iter([
            ("host".into(), Value::String("example.test".into())),
            ("port".into(), Value::from(443)),
            ("enabled".into(), Value::Bool(true)),
            ("empty".into(), Value::Null),
        ]);
        assert_eq!(
            interpolate("https://{{host}}:{{ port }}/{{enabled}}{{empty}}", &vars).unwrap(),
            "https://example.test:443/true"
        );
    }

    #[test]
    fn interpolation_rejects_missing_unclosed_empty_and_composite_variables() {
        assert!(interpolate("{{missing}}", &Map::new()).is_err());
        assert!(interpolate("{{missing", &Map::new()).is_err());
        assert!(interpolate("{{ }}", &Map::new()).is_err());
        let vars = Map::from_iter([("object".into(), Value::Object(Map::new()))]);
        assert!(interpolate("{{object}}", &vars).is_err());
    }

    #[test]
    fn performs_http_query_headers_and_json_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, received) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            sent.send(read_http_request(&mut stream)).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 201 Created\r\nX-Reply: yes\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                )
                .unwrap();
        });
        let request = ScriptRequest {
            method: "post".into(),
            url: format!("http://{address}/items"),
            headers: vec![
                item("X-Test", "present", true),
                item("X-Disabled", "absent", false),
            ],
            query: vec![
                item("search", "owl space", true),
                item("disabled", "no", false),
            ],
            body_mode: BodyMode::Json,
            body: r#"{"name":"postowl"}"#.into(),
        };
        let client = Client::builder().build().unwrap();
        let response = tauri::async_runtime::block_on(perform(&client, &request)).unwrap();
        let wire = String::from_utf8(received.recv().unwrap()).unwrap();
        server.join().unwrap();
        assert!(wire.starts_with("POST /items?search=owl+space HTTP/1.1\r\n"));
        assert_eq!(
            effective_request_url(&request),
            format!("http://{address}/items?search=owl+space")
        );
        assert!(
            wire.to_ascii_lowercase()
                .contains("\r\nx-test: present\r\n")
        );
        assert!(!wire.to_ascii_lowercase().contains("x-disabled"));
        assert!(wire.ends_with(r#"{"name":"postowl"}"#));
        assert_eq!(response.status, Some(201));
        assert_eq!(response.body, r#"{"ok":true}"#);
        assert_eq!(response.size, 11);
        assert_eq!(response.body_encoding, UTF8_ENCODING);
        assert_eq!(response.total_size, Some(11));
        assert!(
            response
                .headers
                .iter()
                .any(|header| header.name == "x-reply" && header.value == "yes")
        );
    }

    #[test]
    fn form_body_is_sent_verbatim_with_default_content_type() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, received) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            sent.send(read_http_request(&mut stream)).unwrap();
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        let mut request = script_request(format!("http://{address}/form"));
        request.method = "POST".into();
        request.body_mode = BodyMode::Form;
        request.body = "encoded=%25+%2B%26%3D&literal=a+b&empty=".into();
        let client = Client::new();
        let response = tauri::async_runtime::block_on(perform(&client, &request)).unwrap();
        let wire = received.recv().unwrap();
        server.join().unwrap();
        let header_end = wire
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap()
            + 4;
        assert_eq!(response.status, Some(204));
        assert_eq!(
            &wire[header_end..],
            b"encoded=%25+%2B%26%3D&literal=a+b&empty="
        );
        assert!(
            String::from_utf8_lossy(&wire[..header_end])
                .to_ascii_lowercase()
                .contains("content-type: application/x-www-form-urlencoded")
        );
    }

    #[test]
    fn resolve_request_ignores_disabled_templates_and_none_body() {
        let mut request = script_request("http://example.test".into());
        request
            .headers
            .push(item("{{missing}}", "{{missing}}", false));
        request
            .query
            .push(item("{{missing}}", "{{missing}}", false));
        request.body = "{{missing}}".into();

        let resolved = resolve_request(&request, &Map::new()).unwrap();
        assert_eq!(resolved.headers[0].name, "{{missing}}");
        assert_eq!(resolved.query[0].value, "{{missing}}");
        assert_eq!(resolved.body, "{{missing}}");

        request.headers[0].enabled = true;
        assert!(resolve_request(&request, &Map::new()).is_err());
    }

    #[test]
    fn script_variable_names_follow_environment_persistence_rules() {
        let mut target = Map::new();
        let names = merge_variables(
            &mut target,
            Map::from_iter([(" token ".into(), Value::String("value".into()))]),
        )
        .unwrap();
        assert!(names.contains("token"));
        assert_eq!(target.get("token"), Some(&Value::String("value".into())));

        for invalid in ["", " \t ", &"x".repeat(VARIABLE_NAME_LIMIT + 1)] {
            assert!(
                merge_variables(
                    &mut target,
                    Map::from_iter([(invalid.into(), Value::String("value".into()))]),
                )
                .is_err()
            );
        }
    }

    fn item_limits_count_only_enabled_headers_and_query_rows() {
        let mut request = script_request("http://127.0.0.1:1/unused".into());
        request.headers = (0..=ITEM_LIMIT)
            .map(|index| item(&format!("x-disabled-{index}"), "", false))
            .collect();
        request.query = (0..=ITEM_LIMIT)
            .map(|index| item(&format!("disabled-{index}"), "", false))
            .collect();
        let response = tauri::async_runtime::block_on(perform(&Client::new(), &request)).unwrap();
        assert!(response.error.is_some());

        request
            .headers
            .iter_mut()
            .for_each(|item| item.enabled = true);
        let error = tauri::async_runtime::block_on(perform(&Client::new(), &request)).unwrap_err();
        assert!(error.to_string().contains("1,000 enabled headers"));

        request
            .headers
            .iter_mut()
            .for_each(|item| item.enabled = false);
        request
            .query
            .iter_mut()
            .for_each(|item| item.enabled = true);
        let error = tauri::async_runtime::block_on(perform(&Client::new(), &request)).unwrap_err();
        assert!(error.to_string().contains("1,000 enabled query items"));
    }

    #[test]
    fn variable_merge_is_atomic_when_any_change_is_invalid() {
        let mut target = Map::from_iter([("existing".into(), Value::String("value".into()))]);
        let original = target.clone();
        let changes = Map::from_iter([
            ("a-valid".into(), Value::String("changed".into())),
            ("z-invalid".into(), Value::Object(Map::new())),
        ]);

        assert!(merge_variables(&mut target, changes).is_err());
        assert_eq!(target, original);
    }

    #[test]
    fn variable_changes_merge_into_latest_environment_without_overwriting_other_values() {
        let mut latest = Environment {
            id: "environment".into(),
            name: "Latest name".into(),
            variables: vec![
                item("token", "concurrently-updated", true),
                item("token", "disabled-shadow", false),
                item("untouched", "latest", false),
            ],
            created_at: 10,
            updated_at: 20,
        };
        let changes = Map::from_iter([
            ("token".into(), Value::String("script-value".into())),
            ("added".into(), Value::from(42)),
        ]);
        apply_variable_changes(&mut latest, &changes);
        assert_eq!(latest.name, "Latest name");
        assert_eq!(latest.variables[0].value, "script-value");
        assert_eq!(latest.variables[1].value, "disabled-shadow");
        assert!(!latest.variables[1].enabled);
        assert_eq!(latest.variables[2].value, "latest");
        assert!(!latest.variables[2].enabled);
        assert!(
            latest
                .variables
                .iter()
                .any(|item| item.name == "added" && item.value == "42" && item.enabled)
        );
    }

    #[test]
    fn request_body_over_twenty_mib_is_rejected_before_network_io() {
        let mut request = script_request("http://127.0.0.1:1/unused".into());
        request.method = "POST".into();
        request.body_mode = BodyMode::Text;
        request.body = "x".repeat(REQUEST_BODY_LIMIT + 1);
        let error = tauri::async_runtime::block_on(perform(&Client::new(), &request)).unwrap_err();
        assert!(error.to_string().contains("20 MiB"));
    }

    #[test]
    fn response_body_is_truncated_at_sixteen_mib_without_server_buffering() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_http_request(&mut stream);
            let total = RESPONSE_LIMIT + 8192;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let chunk = [b'x'; 8192];
            for _ in 0..total / chunk.len() {
                if stream.write_all(&chunk).is_err() {
                    return;
                }
            }
            let remainder = total % chunk.len();
            let _ = stream.write_all(&chunk[..remainder]);
        });
        let request = script_request(format!("http://{address}/large"));
        let response = tauri::async_runtime::block_on(perform(&Client::new(), &request)).unwrap();
        server.join().unwrap();
        assert_eq!(response.body.len(), RESPONSE_LIMIT);
        assert!(response.truncated);
        assert_eq!(response.size, RESPONSE_LIMIT as u64);
        assert_eq!(response.total_size, Some((RESPONSE_LIMIT + 8192) as u64));
    }

    #[test]
    fn incomplete_response_keeps_captured_status_body_and_reports_truncation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_http_request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nowl")
                .unwrap();
        });
        let request = script_request(format!("http://{address}/incomplete"));
        let response = tauri::async_runtime::block_on(perform(&Client::new(), &request)).unwrap();
        server.join().unwrap();
        assert_eq!(response.status, Some(200));
        assert_eq!(response.body, "owl");
        assert_eq!(response.size, 3);
        assert_eq!(response.total_size, Some(10));
        assert!(response.truncated);
        assert!(
            response
                .error
                .as_deref()
                .is_some_and(|error| error.contains("3 captured bytes"))
        );
        assert_eq!(response.logs, vec![response.error.clone().unwrap()]);
    }

    #[test]
    fn binary_response_and_header_bytes_are_preserved_as_base64() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_http_request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nX-Binary: \xff\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\0\xffAB")
                .unwrap();
        });
        let response = tauri::async_runtime::block_on(perform(
            &Client::new(),
            &script_request(format!("http://{address}/binary")),
        ))
        .unwrap();
        server.join().unwrap();

        assert_eq!(response.body_encoding, BASE64_ENCODING);
        assert_eq!(BASE64.decode(&response.body).unwrap(), b"\0\xffAB");
        assert_eq!(response.size, 4);
        assert_eq!(response.total_size, Some(4));
        let header = response
            .headers
            .iter()
            .find(|header| header.name == "x-binary")
            .unwrap();
        assert_eq!(header.encoding, BASE64_ENCODING);
        assert_eq!(BASE64.decode(&header.value).unwrap(), b"\xff");
        let json = serde_json::to_string(&response).unwrap();
        let restored: ResponseData = serde_json::from_str(&json).unwrap();
        assert_eq!(BASE64.decode(restored.body).unwrap(), b"\0\xffAB");
    }

    #[test]
    fn ancillary_warnings_keep_the_newest_hundred_entries() {
        let mut response = ResponseData {
            status: Some(200),
            headers: vec![],
            body: String::new(),
            body_encoding: UTF8_ENCODING.into(),
            elapsed: 0,
            size: 0,
            total_size: None,
            truncated: false,
            assertions: vec![],
            logs: vec![],
            error: None,
        };
        for index in 0..105 {
            append_ancillary_warning(&mut response, &index.to_string(), index.to_string());
        }
        assert_eq!(response.assertions.len(), 100);
        assert_eq!(response.assertions[0].name, "5");
        assert_eq!(response.logs[0], "5");
        assert_eq!(response.logs[99], "104");
    }

    #[test]
    fn script_response_view_truncates_unicode_on_a_character_boundary() {
        let body = format!("{}é", "x".repeat(SCRIPT_RESPONSE_LIMIT - 1));
        let response = ResponseData {
            status: Some(200),
            headers: vec![],
            body_encoding: UTF8_ENCODING.into(),
            size: body.len() as u64,
            total_size: Some(body.len() as u64),
            body,
            elapsed: 0,
            truncated: false,
            assertions: vec![],
            logs: vec![],
            error: None,
        };
        let view = script_response_view(&response);
        assert_eq!(view.body.len(), SCRIPT_RESPONSE_LIMIT - 1);
        assert!(view.truncated);
        assert!(!response.truncated);
    }
}
