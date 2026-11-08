use serde_json::{json, Value};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
async fn call(ch: String, args: Vec<Value>) -> Result<Value, String> {
    let _ = args;
    match ch.as_str() {
        "info" => Ok(json!({ "platform": std::env::consts::OS })),
        _ => Ok(Value::Null),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![call])
        .setup(|app| {
            let boot = json!({ "shared": null });
            WebviewWindowBuilder::new(app, "w1", WebviewUrl::App("index.html".into()))
                .title("Codedesk")
                .inner_size(1400.0, 900.0)
                .min_inner_size(420.0, 320.0)
                .initialization_script(&format!("window.__codedesk={}", boot))
                .build()?;
            let _ = app.get_webview_window("w1");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Codedesk");
}
