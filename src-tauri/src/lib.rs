mod commands;
mod db;
mod error;
mod model;
mod script;

use std::{fs, sync::Mutex, time::Duration};

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data)?;
            let connection = db::open(&app_data.join("postowl.sqlite3"))?;
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .user_agent(concat!("PostOwl/", env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage(AppState {
                db: Mutex::new(connection),
                client,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_workspace,
            commands::save_collection,
            commands::delete_collection,
            commands::save_request,
            commands::delete_request,
            commands::save_environment,
            commands::delete_environment,
            commands::execute_request,
            commands::clear_history,
            commands::export_workspace,
            commands::import_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PostOwl");
}
