use crate::util::write_json;
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;

pub const DEVICE_KEYS: &[&str] = &[
    "theme", "palette", "accent", "accentCustom", "uiFont", "proseFont", "monoFont", "density", "radius", "fontSize", "chatWidth", "motion", "customCss",
    "panelWidth", "sidebar", "panel", "panelTab", "sounds", "notifications", "enterSends",
];

pub fn pick_shared(v: &Value) -> Map<String, Value> {
    v.as_object()
        .map(|o| o.iter().filter(|(k, _)| !DEVICE_KEYS.contains(&k.as_str()) && *k != "v").map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

pub struct Shared {
    file: PathBuf,
    data: Mutex<Option<Map<String, Value>>>,
    write: tokio::sync::Mutex<()>,
}

impl Shared {
    pub fn load(file: PathBuf) -> Self {
        let data = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.as_object().cloned());
        Shared { file, data: Mutex::new(data), write: Default::default() }
    }
    pub fn get(&self) -> Value {
        self.data.lock().unwrap().clone().map(Value::Object).unwrap_or(Value::Null)
    }
    pub async fn save(&self, patch: &Value) -> std::io::Result<Value> {
        let snapshot = {
            let mut d = self.data.lock().unwrap();
            let m = d.get_or_insert_with(Map::new);
            m.extend(pick_shared(patch));
            Value::Object(m.clone())
        };
        let _g = self.write.lock().await;
        write_json(&self.file, &self.get())?;
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn device_keys_never_get_shared() {
        let p = pick_shared(&json!({ "theme": "dark", "sidebar": false, "workspaces": { "/a": ["/b"] }, "v": 2 }));
        assert_eq!(Value::Object(p), json!({ "workspaces": { "/a": ["/b"] } }));
    }

    #[test]
    fn missing_shared_file_reads_as_null() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(Shared::load(d.path().join("none.json")).get(), Value::Null);
    }

    #[test]
    fn corrupt_shared_file_reads_as_null_and_is_not_overwritten_on_load() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("shared.json");
        std::fs::write(&f, "{\"work").unwrap();
        assert_eq!(Shared::load(f.clone()).get(), Value::Null);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\"work");
    }

    #[tokio::test]
    async fn shared_save_merges_skips_device_keys_and_persists() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("shared.json");
        let s = Shared::load(f.clone());
        s.save(&json!({ "pinned": ["x"], "theme": "dark" })).await.unwrap();
        let merged = s.save(&json!({ "account": "a1" })).await.unwrap();
        assert_eq!(merged, json!({ "pinned": ["x"], "account": "a1" }));
        assert_eq!(Shared::load(f).get(), json!({ "pinned": ["x"], "account": "a1" }));
    }
}
