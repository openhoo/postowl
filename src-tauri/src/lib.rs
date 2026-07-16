mod commands;
mod db;
mod error;
mod model;
mod script;

#[cfg(feature = "e2e")]
use std::path::PathBuf;
use std::{fs, sync::Mutex, time::Duration};

use commands::AppState;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .setup(|app| {
            #[cfg(feature = "e2e")]
            let app_data = std::env::var_os("POSTOWL_DATA_DIR")
                .map(PathBuf::from)
                .ok_or_else(|| {
                    std::io::Error::other("POSTOWL_DATA_DIR is required for e2e builds")
                })?;
            #[cfg(not(feature = "e2e"))]
            let app_data = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data)?;
            let (connection, recovery_path) =
                db::open_recover(&app_data.join("postowl.sqlite3"))?;
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .user_agent(concat!("PostOwl/", env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage(AppState {
                db: Mutex::new(connection),
                client,
            });
            if let Some(recovery_path) = recovery_path {
                app.dialog()
                    .message(format!(
                        "PostOwl recovered from an incompatible or corrupt local database. The original files were preserved at:\n{recovery_path}"
                    ))
                    .title("Workspace recovered")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
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
