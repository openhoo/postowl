use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use rquickjs::{Context, Ctx, Error as JsError, Function, Runtime, Value, context::intrinsic};
use serde::{Serialize, de::DeserializeOwned};

use crate::{
    error::{AppError, AppResult},
    model::{PostScriptContext, PostScriptResult, PreScriptContext, PreScriptResult},
};

const HEAP_LIMIT: usize = 16 * 1024 * 1024;
const STACK_LIMIT: usize = 256 * 1024;
const SCRIPT_LIMIT: usize = 256 * 1024;
const JSON_LIMIT: usize = 2 * 1024 * 1024;
const HOOK_DEADLINE: Duration = Duration::from_millis(250);
const MAX_LOGS: usize = 100;
const MAX_ASSERTIONS: usize = 100;
const MAX_TEXT: usize = 4096;

fn js_error(ctx: &Ctx<'_>, error: JsError) -> AppError {
    if matches!(error, JsError::Exception) {
        let thrown = ctx.catch();
        if let Some(object) = thrown.as_object() {
            if let Ok(message) = object.get::<_, String>("message") {
                return AppError::Script(trim_text(message));
            }
        }
        if let Ok(Some(text)) = ctx.json_stringify(thrown) {
            if let Ok(text) = text.to_string() {
                return AppError::Script(trim_text(text));
            }
        }
    }
    AppError::Script(error.to_string())
}

fn trim_text(mut value: String) -> String {
    if value.len() > MAX_TEXT {
        let mut boundary = MAX_TEXT;
        while !value.is_char_boundary(boundary) {
            boundary -= 1;
        }
        value.truncate(boundary);
    }
    value
}

fn run<I: Serialize, O: DeserializeOwned>(script: &str, input: &I) -> AppResult<O> {
    if script.len() > SCRIPT_LIMIT {
        return Err(AppError::Invalid("script exceeds 256 KiB".into()));
    }
    let input_json = serde_json::to_vec(input)?;
    if input_json.len() > JSON_LIMIT {
        return Err(AppError::Invalid("script input exceeds 2 MiB".into()));
    }

    let runtime = Runtime::new().map_err(|e| AppError::Script(e.to_string()))?;
    runtime.set_memory_limit(HEAP_LIMIT);
    runtime.set_max_stack_size(STACK_LIMIT);
    let cancelled = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + HOOK_DEADLINE;
    let interrupt = Arc::clone(&cancelled);
    runtime.set_interrupt_handler(Some(Box::new(move || {
        interrupt.load(Ordering::Relaxed) || Instant::now() >= deadline
    })));
    let context = Context::custom::<(intrinsic::Eval, intrinsic::Json)>(&runtime)
        .map_err(|e| AppError::Script(e.to_string()))?;

    let result = context.with(|ctx| -> AppResult<O> {
        let wrapper =
            format!("'use strict';\nglobalThis.main = function main(ctx) {{\n{script}\n}};");
        ctx.eval::<(), _>(wrapper.as_bytes())
            .map_err(|e| js_error(&ctx, e))?;
        let input: Value<'_> = ctx.json_parse(input_json).map_err(|e| js_error(&ctx, e))?;
        let main: Function<'_> = ctx.globals().get("main").map_err(|e| js_error(&ctx, e))?;
        let output: Value<'_> = main.call((input,)).map_err(|e| js_error(&ctx, e))?;
        if output.is_promise() {
            return Err(AppError::Script("scripts must return synchronously".into()));
        }
        let encoded = ctx
            .json_stringify(output)
            .map_err(|e| js_error(&ctx, e))?
            .ok_or_else(|| AppError::Script("script result must be JSON-serializable".into()))?
            .to_string()
            .map_err(|e| AppError::Script(e.to_string()))?;
        if encoded.len() > JSON_LIMIT {
            return Err(AppError::Script("script output exceeds 2 MiB".into()));
        }
        Ok(serde_json::from_str(&encoded)?)
    });
    cancelled.store(true, Ordering::Relaxed);
    result
}

fn bound_logs(logs: &mut Vec<String>) {
    logs.truncate(MAX_LOGS);
    for log in logs {
        *log = trim_text(std::mem::take(log));
    }
}

pub fn run_pre(script: &str, input: &PreScriptContext) -> AppResult<PreScriptResult> {
    if script.trim().is_empty() {
        return Ok(PreScriptResult::default());
    }
    let mut result: PreScriptResult = run(script, input)?;
    bound_logs(&mut result.logs);
    Ok(result)
}

pub fn run_post(script: &str, input: &PostScriptContext) -> AppResult<PostScriptResult> {
    if script.trim().is_empty() {
        return Ok(PostScriptResult::default());
    }
    let mut result: PostScriptResult = run(script, input)?;
    bound_logs(&mut result.logs);
    result.assertions.truncate(MAX_ASSERTIONS);
    for assertion in &mut result.assertions {
        assertion.name = trim_text(std::mem::take(&mut assertion.name));
        assertion.message = trim_text(std::mem::take(&mut assertion.message));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        AssertionResult, BodyMode, HeaderValue, PostScriptContext, ResponseData, ScriptRequest,
    };
    use serde_json::{Map, Value};
    use std::time::{Duration, Instant};

    fn request() -> ScriptRequest {
        ScriptRequest {
            method: "GET".into(),
            url: "https://example.test".into(),
            headers: vec![],
            query: vec![],
            body_mode: BodyMode::None,
            body: String::new(),
        }
    }

    fn pre_context() -> PreScriptContext {
        PreScriptContext {
            request: request(),
            variables: Map::from_iter([("seed".into(), Value::from(7))]),
        }
    }

    fn post_context() -> PostScriptContext {
        PostScriptContext {
            request: request(),
            response: ResponseData {
                status: Some(201),
                headers: vec![HeaderValue {
                    name: "content-type".into(),
                    value: "application/json".into(),
                }],
                body: r#"{"token":"abc"}"#.into(),
                elapsed: 3,
                size: 15,
                truncated: false,
                assertions: vec![],
                logs: vec![],
                error: None,
            },
            variables: Map::new(),
        }
    }

    #[test]
    fn pre_script_mutates_request_outputs_variables_and_logs() {
        let result = run_pre(
            r#"
ctx.request.method = "POST";
ctx.request.url += "/created";
ctx.request.headers.push({ id: "header", name: "x-seed", value: String(ctx.variables.seed), enabled: true });
ctx.request.bodyMode = "json";
ctx.request.body = '{"ok":true}';
return { request: ctx.request, variables: { token: "abc", count: 2 }, logs: ["prepared"] };
"#,
            &pre_context(),
        )
        .unwrap();
        let mutated = result.request.unwrap();
        assert_eq!(mutated.method, "POST");
        assert_eq!(mutated.url, "https://example.test/created");
        assert_eq!(mutated.headers[0].value, "7");
        assert!(matches!(mutated.body_mode, BodyMode::Json));
        assert_eq!(mutated.body, r#"{"ok":true}"#);
        let variables = result.variables.unwrap();
        assert_eq!(variables.get("token"), Some(&Value::String("abc".into())));
        assert_eq!(variables.get("count"), Some(&Value::from(2)));
        assert_eq!(result.logs, ["prepared"]);
    }

    #[test]
    fn post_script_returns_assertions_logs_and_variables() {
        let result = run_post(
            r#"
const payload = JSON.parse(ctx.response.body);
return {
  assertions: [
    { name: "created", passed: ctx.response.status === 201, message: "" },
    { name: "token", passed: payload.token === "abc", message: payload.token }
  ],
  logs: ["checked"],
  variables: { token: payload.token }
};
"#,
            &post_context(),
        )
        .unwrap();
        assert_eq!(result.assertions.len(), 2);
        assert!(result.assertions.iter().all(|assertion| assertion.passed));
        assert_eq!(result.assertions[1].message, "abc");
        assert_eq!(result.logs, ["checked"]);
        assert_eq!(
            result.variables.unwrap().get("token"),
            Some(&Value::String("abc".into()))
        );
    }

    #[test]
    fn result_collections_and_text_are_bounded_at_utf8_boundaries() {
        let script = r#"
const long = "é".repeat(3000);
return {
  assertions: Array.from({ length: 105 }, (_, i) => ({ name: long, passed: i === 0, message: long })),
  logs: Array.from({ length: 105 }, () => long),
  variables: null
};
"#;
        let result = run_post(script, &post_context()).unwrap();
        assert_eq!(result.logs.len(), MAX_LOGS);
        assert_eq!(result.assertions.len(), MAX_ASSERTIONS);
        assert_eq!(result.logs[0].len(), MAX_TEXT);
        assert_eq!(result.assertions[0].name.len(), MAX_TEXT);
        assert_eq!(result.assertions[0].message.len(), MAX_TEXT);
        assert!(result.logs[0].is_char_boundary(result.logs[0].len()));
    }

    #[test]
    fn invalid_output_and_syntax_errors_are_rejected() {
        for script in [
            "return undefined;",
            "return { logs: 'not-an-array' };",
            "return {",
        ] {
            assert!(run_pre(script, &pre_context()).is_err(), "{script}");
        }
        assert!(run_pre("return Promise.resolve({});", &pre_context()).is_err());
    }

    #[test]
    fn script_size_input_and_output_limits_are_enforced() {
        let oversized_script = format!("return {{}};{}", " ".repeat(SCRIPT_LIMIT));
        assert!(run_pre(&oversized_script, &pre_context()).is_err());

        let mut large_input = pre_context();
        large_input
            .variables
            .insert("large".into(), Value::String("x".repeat(JSON_LIMIT)));
        assert!(run_pre("return {};", &large_input).is_err());

        let output_error = run_pre(
            "return { logs: ['x'.repeat(2 * 1024 * 1024)] };",
            &pre_context(),
        )
        .unwrap_err();
        assert!(output_error.to_string().contains("output"));
    }

    #[test]
    fn heap_limit_rejects_unbounded_allocation() {
        let error = run_pre(
            "const values = []; for (;;) values.push('0123456789'.repeat(1024));",
            &pre_context(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("script"));
    }

    #[test]
    fn deadline_interrupts_non_terminating_script_promptly() {
        let started = Instant::now();
        let error = run_pre("for (;;) {}", &pre_context()).unwrap_err();
        assert!(error.to_string().contains("script"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn empty_scripts_return_empty_results() {
        let pre = run_pre(" \n ", &pre_context()).unwrap();
        assert!(pre.request.is_none());
        assert!(pre.variables.is_none());
        assert!(pre.logs.is_empty());
        let post = run_post("", &post_context()).unwrap();
        assert_eq!(post.assertions.len(), 0);
        assert!(post.variables.is_none());
    }

    #[test]
    fn assertion_result_shape_is_deserialized() {
        let result = run_post(
            "return { assertions: [{ name: 'failure', passed: false, message: 'reason' }] };",
            &post_context(),
        )
        .unwrap();
        let AssertionResult {
            name,
            passed,
            message,
        } = &result.assertions[0];
        assert_eq!(name, "failure");
        assert!(!passed);
        assert_eq!(message, "reason");
    }
}
