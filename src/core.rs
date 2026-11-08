use crate::hub::{Client, Hub};
use crate::shared::Shared;
use crate::util::{data_dir, find_bin, now_ms};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

pub struct Core {
    pub hub: Arc<Hub>,
    pub data: PathBuf,
    pub shared: Shared,
    pub claude: Option<PathBuf>,
    pub agy: Option<PathBuf>,
    pub llama: Option<PathBuf>,
    pub tailscale: Option<PathBuf>,
    pub handle: OnceLock<AppHandle>,
    pub previews: Mutex<HashMap<String, String>>,
    windows: Mutex<HashMap<String, Client>>,
}

static CORE: OnceLock<Core> = OnceLock::new();

pub fn core() -> &'static Core {
    CORE.get_or_init(|| {
        let data = data_dir();
        Core {
            hub: Hub::new(Box::new(now_ms), 900000),
            shared: Shared::load(data.join("shared.json")),
            data,
            claude: find_bin("claude"),
            agy: find_bin("agy"),
            llama: find_bin("llama-server"),
            tailscale: find_bin("tailscale"),
            handle: OnceLock::new(),
            previews: Mutex::default(),
            windows: Mutex::default(),
        }
    })
}

impl Core {
    pub fn app(&self) -> &AppHandle {
        self.handle.get().expect("app handle")
    }

    pub fn claude_bin(&self) -> PathBuf {
        self.claude.clone().unwrap_or_else(|| PathBuf::from("claude"))
    }

    pub fn window_client(&self, label: &str) -> Client {
        let mut w = self.windows.lock().unwrap();
        if let Some(c) = w.get(label) {
            return c.clone();
        }
        let (l1, l2) = (label.to_string(), label.to_string());
        let c = Client::new(
            &format!("w{label}"),
            move |ch, d| {
                if let Some(app) = core().handle.get() {
                    let _ = app.emit_to(tauri::EventTarget::webview_window(&l1), "cd", json!({ "ch": ch, "d": d }));
                }
            },
            move || core().handle.get().is_some_and(|a| a.get_webview_window(&l2).is_some()),
        );
        w.insert(label.to_string(), c.clone());
        self.hub.connect(c.clone());
        c
    }

    pub fn window_closed(&self, label: &str) {
        if let Some(c) = self.windows.lock().unwrap().remove(label) {
            self.hub.drop_client(&c.id);
            crate::term::kill_where(|t| t.id == c.id);
        }
    }

    pub fn window_clients(&self) -> Vec<Client> {
        self.windows.lock().unwrap().values().cloned().collect()
    }

    pub fn info(&self) -> Value {
        let s = |p: &Option<PathBuf>| p.as_ref().map(|p| p.to_string_lossy().into_owned());
        json!({
            "claudePath": s(&self.claude).unwrap_or_else(|| "not found".into()), "agyPath": s(&self.agy), "llamaPath": s(&self.llama),
            "home": crate::util::home(), "platform": crate::util::platform(), "version": env!("CARGO_PKG_VERSION"),
        })
    }

    pub fn preview_html(&self, html: String) -> String {
        let id = crate::util::uuid();
        let mut p = self.previews.lock().unwrap();
        if p.len() >= 50 {
            if let Some(k) = p.keys().next().cloned() {
                p.remove(&k);
            }
        }
        p.insert(id.clone(), html);
        id
    }
}

pub fn scheme_url(path: &str) -> String {
    if cfg!(windows) {
        format!("http://cdfile.localhost/{path}")
    } else {
        format!("cdfile://localhost/{path}")
    }
}
