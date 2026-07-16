use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use reqwest::{
    Client, Method,
    header::{HeaderName, HeaderValue as ReqHeaderValue},
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

const RESPONSE_LIMIT: usize = 20 * 1024 * 1024;
const REQUEST_BODY_LIMIT: usize = 20 * 1024 * 1024;
const SCRIPT_RESPONSE_LIMIT: usize = 1024 * 1024;
const ITEM_LIMIT: usize = 1_000;
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
                Ok(NamedValue {
                    id: item.id.clone(),
                    name: interpolate(&item.name, vars)?,
                    value: interpolate(&item.value, vars)?,
                    enabled: item.enabled,
                })
            })
            .collect::<AppResult<_>>()?,
        query: request
            .query
            .iter()
            .map(|item| {
                Ok(NamedValue {
                    id: item.id.clone(),
                    name: interpolate(&item.name, vars)?,
                    value: interpolate(&item.value, vars)?,
                    enabled: item.enabled,
                })
            })
            .collect::<AppResult<_>>()?,
        body_mode: request.body_mode,
        body: interpolate(&request.body, vars)?,
    })
}

fn merge_variables(target: &mut Map<String, Value>, changes: Map<String, Value>) -> AppResult<()> {
    for (name, value) in changes {
        if name.len() > 256 {
            return Err(AppError::Invalid(
                "variable name exceeds 256 characters".into(),
            ));
        }
        if !matches!(
            value,
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
        ) {
            return Err(AppError::Invalid(format!(
                "variable {name} is not a scalar"
            )));
        }
        target.insert(name, value);
    }
    Ok(())
}

fn persist_variables(
    state: &AppState,
    environment: &mut Environment,
    vars: &Map<String, Value>,
) -> AppResult<()> {
    let by_name: HashMap<String, usize> = environment
        .variables
        .iter()
        .enumerate()
        .map(|(index, item)| (item.name.clone(), index))
        .collect();
    let mut additions = Vec::new();
    for (name, value) in vars {
        let text = match value {
            Value::String(v) => v.clone(),
            Value::Null => String::new(),
            _ => value.to_string(),
        };
        if let Some(index) = by_name.get(name.as_str()) {
            environment.variables[*index].value = text;
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
    db::save_environment(&*lock_db(state)?, environment.clone())?;
    Ok(())
}

async fn perform(client: &Client, request: &ScriptRequest) -> AppResult<ResponseData> {
    if request.url.len() > 32_768 {
        return Err(AppError::Invalid("request URL exceeds 32 KiB".into()));
    }
    if request.body.len() > REQUEST_BODY_LIMIT {
        return Err(AppError::Invalid("request body exceeds 20 MiB".into()));
    }
    if request.headers.len() > ITEM_LIMIT || request.query.len() > ITEM_LIMIT {
        return Err(AppError::Invalid(
            "request exceeds 1,000 headers or query items".into(),
        ));
    }
    let method = Method::from_bytes(request.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|e| AppError::Invalid(format!("invalid HTTP method: {e}")))?;
    let mut builder = client
        .request(method, &request.url)
        .timeout(REQUEST_TIMEOUT);
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
            let pairs: Vec<(String, String)> = request
                .body
                .split('&')
                .filter(|part| !part.is_empty())
                .map(|part| {
                    part.split_once('=').map_or_else(
                        || (part.to_owned(), String::new()),
                        |(key, value)| (key.to_owned(), value.to_owned()),
                    )
                })
                .collect();
            builder.form(&pairs)
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
                elapsed: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                size: 0,
                truncated: false,
                assertions: vec![],
                logs: vec![],
                error: Some(error.to_string()),
            });
        }
    };
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| HeaderValue {
            name: name.to_string(),
            value: value.to_str().unwrap_or("<non-UTF-8>").to_owned(),
        })
        .collect();
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(RESPONSE_LIMIT as u64) as usize,
    );
    let mut size = 0_u64;
    let mut truncated = false;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                size = size.saturating_add(chunk.len() as u64);
                let remaining = RESPONSE_LIMIT.saturating_sub(bytes.len());
                bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                if chunk.len() > remaining {
                    truncated = true;
                    break;
                }
            }
            Ok(None) => break,
            Err(error) => {
                return Ok(ResponseData {
                    status: Some(status),
                    headers,
                    body: String::from_utf8_lossy(&bytes).into_owned(),
                    elapsed: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    size,
                    truncated,
                    assertions: vec![],
                    logs: vec![],
                    error: Some(error.to_string()),
                });
            }
        }
    }
    Ok(ResponseData {
        status: Some(status),
        headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
        elapsed: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        size,
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
        while !view.body.is_char_boundary(boundary) {
            boundary -= 1;
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
    let (request, mut environment) = {
        let conn = lock_db(&state)?;
        let request = db::request(&conn, &request_id)?;
        let environment = environment_id
            .as_deref()
            .map(|id| db::environment(&conn, id))
            .transpose()?;
        (request, environment)
    };
    let mut vars = variables(environment.as_ref());
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
        merge_variables(&mut vars, changes)?;
    }
    let scripted = pre.request.unwrap_or(original);
    let resolved = resolve_request(&scripted, &vars)?;
    let mut response = perform(&state.client, &resolved).await?;
    response.logs.extend(pre.logs);
    match script::run_post(
        &request.post_response_script,
        &PostScriptContext {
            request: resolved.clone(),
            response: script_response_view(&response),
            variables: vars.clone(),
        },
    ) {
        Ok(post) => {
            response.assertions = post.assertions;
            response.logs.extend(post.logs);
            if let Some(changes) = post.variables {
                if let Err(error) = merge_variables(&mut vars, changes) {
                    let message = error.to_string();
                    response.assertions.push(AssertionResult {
                        name: "Post-response variables".into(),
                        passed: false,
                        message: message.clone(),
                    });
                    response.logs.push(message);
                }
            }
        }
        Err(error) => {
            let message = error.to_string();
            response.assertions.push(AssertionResult {
                name: "Post-response script".into(),
                passed: false,
                message: message.clone(),
            });
            response.logs.push(message);
        }
    }
    response.logs.truncate(100);
    if let Some(environment) = &mut environment {
        persist_variables(&state, environment, &vars)?;
    }
    let history = HistoryEntry {
        id: Uuid::new_v4().to_string(),
        request_id: request.id,
        request_name: request.name,
        method: resolved.method,
        url: resolved.url,
        executed_at: db::now_ms(),
        response: response.clone(),
    };
    db::add_history(&*lock_db(&state)?, &history)?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn interpolation_handles_adjacent_and_scalar_values() {
        let vars = Map::from_iter([
            ("host".into(), Value::String("example.test".into())),
            ("port".into(), Value::from(443)),
        ]);
        assert_eq!(
            interpolate("https://{{host}}:{{ port }}/", &vars).unwrap(),
            "https://example.test:443/"
        );
    }

    #[test]
    fn interpolation_rejects_missing_and_unclosed_variables() {
        assert!(interpolate("{{missing}}", &Map::new()).is_err());
        assert!(interpolate("{{missing", &Map::new()).is_err());
    }
    #[test]
    fn performs_http_request_and_captures_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").unwrap();
        });
        let request = ScriptRequest {
            method: "GET".into(),
            url: format!("http://{address}/health"),
            headers: vec![],
            query: vec![],
            body_mode: BodyMode::None,
            body: String::new(),
        };
        let client = Client::builder().build().unwrap();
        let response = tauri::async_runtime::block_on(perform(&client, &request)).unwrap();
        server.join().unwrap();
        assert_eq!(response.status, Some(200));
        assert_eq!(response.body, "{\"ok\":true}");
        assert_eq!(response.size, 11);
    }
}
