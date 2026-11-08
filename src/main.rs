#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod core;
mod files;
mod hub;
mod shared;
mod util;

use crate::core::core;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

static WINDOWS: AtomicU32 = AtomicU32::new(0);

#[tauri::command]
async fn call(window: WebviewWindow, ch: String, args: Vec<Value>) -> Result<Value, String> {
    match ch.as_str() {
        "newWindow" => {
            open_window(window.app_handle(), None).map_err(|e| e.to_string())?;
            return Ok(Value::Null);
        }
        "zoom" => {
            let _ = window.set_zoom(args.first().and_then(|v| v.as_f64()).unwrap_or(1.0));
            return Ok(Value::Null);
        }
        "devtools" => {
            if window.is_devtools_open() { window.close_devtools() } else { window.open_devtools() }
            return Ok(Value::Null);
        }
        "fullscreen" => {
            let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
            return Ok(Value::Null);
        }
        "quit" => {
            window.app_handle().exit(0);
            return Ok(Value::Null);
        }
        _ => {}
    }
    let client = core().window_client(window.label());
    api::dispatch(&ch, &client, args).await
}

fn dir_from(args: &[String]) -> Option<String> {
    args.iter().skip(1).filter(|a| !a.starts_with('-')).map(Path::new).find(|p| p.is_dir()).and_then(|p| std::path::absolute(p).ok()).map(|p| p.to_string_lossy().into_owned())
}

fn open_window(app: &AppHandle, cwd: Option<String>) -> tauri::Result<WebviewWindow> {
    let label = format!("w{}", WINDOWS.fetch_add(1, Ordering::SeqCst) + 1);
    let boot = json!({ "shared": core().shared.get(), "info": core().info() });
    let url = match &cwd {
        Some(d) => format!("index.html?cwd={}", percent_encoding::utf8_percent_encode(d, percent_encoding::NON_ALPHANUMERIC)),
        None => "index.html".into(),
    };
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("Codedesk")
        .inner_size(1400.0, 900.0)
        .min_inner_size(420.0, 320.0)
        .background_color(tauri::window::Color(0x1c, 0x1b, 0x19, 0xff))
        .initialization_script(&format!("window.__codedesk={}", boot.to_string().replace('<', "\\u003c")))
        .on_navigation(|url| matches!(url.scheme(), "tauri" | "cdfile") || url.host_str() == Some("tauri.localhost"))
        .build()?;
    let l = label.clone();
    win.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            core().window_closed(&l);
        }
    });
    Ok(win)
}

fn serve_cdfile(path: &str) -> Response<Vec<u8>> {
    let sandbox = |r: tauri::http::response::Builder| r.header("Content-Security-Policy", "sandbox allow-scripts").header("Cache-Control", "no-store");
    let deny = || Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap();
    let path = path.trim_start_matches('/');
    if let Some(id) = path.strip_prefix("h/") {
        return match core().previews.lock().unwrap().get(id) {
            Some(html) => sandbox(Response::builder()).header("Content-Type", "text/html; charset=utf-8").body(html.clone().into_bytes()).unwrap(),
            None => deny(),
        };
    }
    let Some(enc) = path.strip_prefix("f/") else { return deny() };
    let file = percent_encoding::percent_decode_str(enc).decode_utf8_lossy().into_owned();
    if !Path::new(&file).is_absolute() {
        return deny();
    }
    match std::fs::read(&file) {
        Ok(bytes) => sandbox(Response::builder()).header("Content-Type", util::mime(&file)).body(bytes).unwrap(),
        Err(_) => deny(),
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let background = argv.iter().any(|a| a == "--background");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            let _ = open_window(app, dir_from(&argv));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("cdfile", |_ctx, req, responder| {
            let path = req.uri().path().to_string();
            std::thread::spawn(move || responder.respond(serve_cdfile(&path)));
        })
        .invoke_handler(tauri::generate_handler![call])
        .setup(move |app| {
            let _ = core().handle.set(app.handle().clone());
            if !background {
                open_window(app.handle(), dir_from(&argv))?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Codedesk")
        .run(move |_, e| {
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = e {
                if background {
                    api.prevent_exit();
                }
            }
        });
}
