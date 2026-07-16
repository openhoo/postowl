use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedValue {
    pub id: String,
    pub name: String,
    pub value: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub collection_id: Option<String>,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<NamedValue>,
    #[serde(default)]
    pub query: Vec<NamedValue>,
    #[serde(default)]
    pub body_mode: BodyMode,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub pre_request_script: String,
    #[serde(default)]
    pub post_response_script: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BodyMode {
    #[default]
    None,
    Text,
    Json,
    Form,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub variables: Vec<NamedValue>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderValue {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertionResult {
    pub name: String,
    pub passed: bool,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseData {
    pub status: Option<u16>,
    pub headers: Vec<HeaderValue>,
    pub body: String,
    pub elapsed: u64,
    pub size: u64,
    pub truncated: bool,
    #[serde(default)]
    pub assertions: Vec<AssertionResult>,
    #[serde(default)]
    pub logs: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub request_id: String,
    pub request_name: String,
    pub method: String,
    pub url: String,
    pub executed_at: i64,
    pub response: ResponseData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub collections: Vec<Collection>,
    pub requests: Vec<Request>,
    pub environments: Vec<Environment>,
    pub history: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWorkspace {
    pub schema: String,
    pub version: u32,
    pub workspace: Workspace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<NamedValue>,
    pub query: Vec<NamedValue>,
    pub body_mode: BodyMode,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreScriptContext {
    pub request: ScriptRequest,
    pub variables: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreScriptResult {
    pub request: Option<ScriptRequest>,
    pub variables: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub logs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostScriptContext {
    pub request: ScriptRequest,
    pub response: ResponseData,
    pub variables: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostScriptResult {
    #[serde(default)]
    pub assertions: Vec<AssertionResult>,
    #[serde(default)]
    pub logs: Vec<String>,
    pub variables: Option<serde_json::Map<String, Value>>,
}
