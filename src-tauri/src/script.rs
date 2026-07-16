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
    use crate::model::{BodyMode, ScriptRequest};
    use serde_json::{Map, Value};

    fn context() -> PreScriptContext {
        PreScriptContext {
            request: ScriptRequest {
                method: "GET".into(),
                url: "https://example.test".into(),
                headers: vec![],
                query: vec![],
                body_mode: BodyMode::None,
                body: String::new(),
            },
            variables: Map::new(),
        }
    }

    #[test]
    fn script_returns_json_result() {
        let result = run_pre(
            "return { variables: { token: 'ok' }, logs: ['ran'] };",
            &context(),
        )
        .unwrap();
        assert_eq!(
            result.variables.unwrap().get("token"),
            Some(&Value::String("ok".into()))
        );
        assert_eq!(result.logs, ["ran"]);
    }

    #[test]
    fn script_cannot_return_promise() {
        let error = run_pre("return Promise.resolve({});", &context()).unwrap_err();
        assert!(error.to_string().contains("script"));
    }

    #[test]
    fn script_interrupts_infinite_loop() {
        let error = run_pre("for (;;) {}", &context()).unwrap_err();
        assert!(error.to_string().contains("script"));
    }
}
