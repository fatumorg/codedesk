use crate::util::{now_ms, read_json, read_json_or_null, uuid, write_json};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct ClaudeFiles {
    pub dir: PathBuf,
    pub creds: PathBuf,
    pub config: PathBuf,
}

pub fn claude_files(home: &Path, config_dir: Option<&Path>) -> ClaudeFiles {
    match config_dir {
        Some(d) => ClaudeFiles { dir: d.into(), creds: d.join(".credentials.json"), config: d.join(".claude.json") },
        None => {
            let dir = home.join(".claude");
            ClaudeFiles { creds: dir.join(".credentials.json"), config: home.join(".claude.json"), dir }
        }
    }
}

pub fn system_files() -> ClaudeFiles {
    let cfg = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    claude_files(&crate::util::home(), cfg.as_deref())
}

fn shared_skip(name: &str) -> bool {
    matches!(name, ".credentials.json" | ".claude.json" | "codedesk.json") || name.starts_with("daemon") || name.ends_with(".lock")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn profile(f: &ClaudeFiles) -> Option<Map<String, Value>> {
    let (creds, config) = (read_json(&f.creds), read_json(&f.config));
    let (oauth, a) = (&creds["claudeAiOauth"], &config["oauthAccount"]);
    if !oauth["refreshToken"].as_str().is_some_and(|s| !s.is_empty()) || !a["accountUuid"].as_str().is_some_and(|s| !s.is_empty()) {
        return None;
    }
    let mut m = Map::new();
    m.insert("key".into(), json!(format!("{}/{}", a["accountUuid"].as_str().unwrap(), a["organizationUuid"].as_str().unwrap_or("undefined"))));
    for (k, v) in [("email", &a["emailAddress"]), ("org", &a["organizationName"]), ("plan", &oauth["subscriptionType"])] {
        if !v.is_null() {
            m.insert(k.into(), v.clone());
        }
    }
    Some(m)
}

fn signed_in(f: &ClaudeFiles) -> bool {
    match read_json_or_null(&f.creds) {
        None => true,
        Some(c) => c["claudeAiOauth"]["refreshToken"].as_str().is_some_and(|s| !s.is_empty()),
    }
}

#[cfg(unix)]
fn link(src: &Path, dst: &Path, _dir: bool) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(windows)]
fn link(src: &Path, dst: &Path, dir: bool) -> std::io::Result<()> {
    if dir {
        std::os::windows::fs::symlink_dir(src, dst)
    } else {
        std::os::windows::fs::symlink_file(src, dst)
    }
}

pub struct Accounts {
    main: ClaudeFiles,
    root: PathBuf,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Accounts {
    pub fn new(main: ClaudeFiles, root: PathBuf) -> Self {
        Accounts { main, root, locks: Mutex::default() }
    }

    fn files_of(&self, id: &str) -> Result<ClaudeFiles, String> {
        if !valid_id(id) {
            return Err("Invalid account id".into());
        }
        Ok(claude_files(Path::new("/"), Some(&self.root.join(id))))
    }

    fn lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.locks.lock().unwrap().entry(id.into()).or_default().clone()
    }

    fn record(&self, id: &str) -> Option<Map<String, Value>> {
        let f = self.files_of(id).ok()?;
        read_json_or_null(&f.dir.join("codedesk.json")).and_then(|v| v.as_object().cloned()).filter(|r| r.get("key").is_some_and(|k| !k.is_null() && k != ""))
    }

    fn entry(&self, id: &str) -> Result<Option<Value>, String> {
        let l = self.lock(id);
        let _g = l.lock().unwrap();
        let files = self.files_of(id)?;
        let (p, on) = (profile(&files), signed_in(&files));
        let rec = self.record(id);
        if rec.is_none() && p.is_none() {
            return Ok(None);
        }
        let mut next = rec.clone().unwrap_or_default();
        if let Some(p) = p {
            for k in ["key", "email", "org", "plan"] {
                match p.get(k) {
                    Some(v) => next.insert(k.into(), v.clone()),
                    None => next.remove(k),
                };
            }
        }
        if on {
            next.remove("signedOutAt");
        } else if next.get("signedOutAt").is_none_or(|v| v.is_null()) {
            next.insert("signedOutAt".into(), json!(now_ms()));
        }
        if Some(&next) != rec.as_ref() {
            write_json(&files.dir.join("codedesk.json"), &Value::Object(next.clone())).map_err(|e| e.to_string())?;
        }
        let mut out = Map::new();
        out.insert("id".into(), json!(id));
        out.extend(next);
        out.insert("signedIn".into(), json!(on));
        Ok(Some(Value::Object(out)))
    }

    pub fn list(&self) -> Vec<Value> {
        let mut ids: Vec<String> = std::fs::read_dir(&self.root).map(|rd| rd.flatten().map(|d| d.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        ids.sort();
        let added: Vec<Value> = ids
            .iter()
            .filter(|id| valid_id(id))
            .filter_map(|id| match self.entry(id) {
                Ok(v) => v,
                Err(_) => self.record(id).map(|r| {
                    let mut m = Map::new();
                    m.insert("id".into(), json!(id));
                    m.extend(r);
                    m.insert("signedIn".into(), json!(true));
                    Value::Object(m)
                }),
            })
            .collect();
        let mut system = Map::new();
        system.insert("id".into(), json!("system"));
        if let Some(p) = profile(&self.main) {
            system.extend(p);
        }
        system.insert("signedIn".into(), json!(signed_in(&self.main)));
        let key = system.get("key").cloned();
        let mut out = vec![Value::Object(system)];
        out.extend(added.into_iter().filter(|a| key.is_none() || a.get("key") != key.as_ref()));
        out
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        if id == "system" {
            return Err("The system account is managed by `claude auth`".into());
        }
        let dir = self.files_of(id)?.dir;
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for d in rd.flatten() {
                if d.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
                    let _ = std::fs::remove_file(d.path()).or_else(|_| std::fs::remove_dir(d.path()));
                }
            }
        }
        match std::fs::remove_dir_all(&dir) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    pub async fn add<F, Fut>(&self, login: F) -> Value
    where
        F: FnOnce(HashMap<String, String>) -> Fut,
        Fut: Future<Output = Value>,
    {
        let before = self.list();
        let id = uuid();
        let Ok(files) = self.files_of(&id) else { return json!({ "error": "Invalid account id" }) };
        if let Err(e) = std::fs::create_dir_all(&files.dir) {
            return json!({ "error": e.to_string() });
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&files.dir, std::fs::Permissions::from_mode(0o700));
        }
        let r = login(HashMap::from([("CLAUDE_CONFIG_DIR".to_string(), files.dir.to_string_lossy().into_owned())])).await;
        let p = profile(&files);
        let same = p.as_ref().and_then(|p| before.iter().find(|a| a.get("key") == p.get("key")).cloned());
        let email = p.as_ref().and_then(|p| p.get("email").cloned()).unwrap_or(Value::Null);
        if let Some(s) = same.as_ref().filter(|s| s["signedIn"] == false && s["id"] != "system") {
            let sid = s["id"].as_str().unwrap_or_default().to_string();
            if let Ok(old) = self.files_of(&sid) {
                {
                    let l = self.lock(&sid);
                    let _g = l.lock().unwrap();
                    let _ = std::fs::rename(&files.creds, &old.creds);
                    let _ = std::fs::rename(&files.config, &old.config);
                }
                let _ = self.remove(&id);
                let _ = self.entry(&sid);
                return json!({ "id": sid, "email": email, "revived": true });
            }
        }
        if let (Some(p), None) = (&p, &same) {
            let rec = json!({ "key": p.get("key"), "email": p.get("email"), "org": p.get("org"), "plan": p.get("plan") });
            let rec: Map<String, Value> = rec.as_object().unwrap().iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect();
            if write_json(&files.dir.join("codedesk.json"), &Value::Object(rec)).is_ok() {
                return json!({ "id": id, "email": email });
            }
        }
        let _ = self.remove(&id);
        let err = match same {
            Some(_) => format!("{} is already added", email.as_str().unwrap_or_default()),
            None => r["stderr"].as_str().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("Sign-in did not finish").to_string(),
        };
        json!({ "error": err })
    }

    pub fn env(&self, id: &str) -> Result<HashMap<String, String>, String> {
        if id.is_empty() || id == "system" {
            return Ok(HashMap::new());
        }
        let files = self.files_of(id)?;
        let rec = match self.record(id) {
            Some(r) => Some(Value::Object(r)),
            None => self.entry(id).ok().flatten(),
        }
        .ok_or("Account not found")?;
        if !signed_in(&files) {
            return Err(format!("{} is signed out. Sign in again from the account menu.", rec["email"].as_str().unwrap_or("This account")));
        }
        let l = self.lock(id);
        let _g = l.lock().unwrap();
        if let Ok(rd) = std::fs::read_dir(&self.main.dir) {
            for d in rd.flatten() {
                let name = d.file_name().to_string_lossy().into_owned();
                if shared_skip(&name) {
                    continue;
                }
                let _ = link(&d.path(), &files.dir.join(&name), d.path().is_dir());
            }
        }
        let shared = read_json(&self.main.config);
        if let Some(Value::Object(mut own)) = read_json_or_null(&files.config) {
            let n = Value::Null;
            let differs = own.get("mcpServers").unwrap_or(&n) != &shared["mcpServers"] || own.get("projects").unwrap_or(&n) != &shared["projects"];
            if differs {
                for k in ["mcpServers", "projects"] {
                    match &shared[k] {
                        Value::Null => own.remove(k),
                        v => own.insert(k.into(), v.clone()),
                    };
                }
                write_json(&files.config, &Value::Object(own)).map_err(|e| e.to_string())?;
            }
        }
        Ok(HashMap::from([("CLAUDE_CONFIG_DIR".to_string(), files.dir.to_string_lossy().into_owned())]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn login_as(n: u32, env: &HashMap<String, String>) {
        let f = claude_files(Path::new("/nonexistent"), Some(Path::new(&env["CLAUDE_CONFIG_DIR"])));
        fs::write(&f.creds, json!({ "claudeAiOauth": { "refreshToken": format!("r{n}"), "subscriptionType": "max" } }).to_string()).unwrap();
        fs::write(&f.config, json!({ "oauthAccount": { "accountUuid": format!("u{n}"), "organizationUuid": "o", "emailAddress": format!("a{n}@x") } }).to_string()).unwrap();
    }

    fn login(n: u32) -> impl FnOnce(HashMap<String, String>) -> std::future::Ready<Value> {
        move |env| {
            login_as(n, &env);
            std::future::ready(json!({}))
        }
    }

    struct Setup {
        _tmp: tempfile::TempDir,
        main: ClaudeFiles,
        acc: Accounts,
        id: String,
        dir: PathBuf,
    }

    async fn setup() -> Setup {
        let tmp = tempfile::tempdir().unwrap();
        let main = claude_files(tmp.path(), None);
        fs::create_dir_all(&main.dir).unwrap();
        login_as(1, &HashMap::from([("CLAUDE_CONFIG_DIR".into(), main.dir.to_string_lossy().into_owned())]));
        fs::write(&main.config, json!({ "oauthAccount": { "accountUuid": "u1", "organizationUuid": "o", "emailAddress": "a1@x" }, "mcpServers": { "m": {} }, "projects": { "p": {} } }).to_string()).unwrap();
        let acc = Accounts::new(main.clone(), tmp.path().join("accounts"));
        let id = acc.add(login(2)).await["id"].as_str().unwrap().to_string();
        let dir = tmp.path().join("accounts").join(&id);
        Setup { _tmp: tmp, main, acc, id, dir }
    }

    fn emails(list: &[Value]) -> Vec<String> {
        list.iter().map(|a| a["email"].as_str().unwrap_or_default().to_string()).collect()
    }

    #[tokio::test]
    async fn accounts_get_their_own_login_and_share_everything_else() {
        let tmp = tempfile::tempdir().unwrap();
        let main = claude_files(tmp.path(), None);
        fs::create_dir_all(main.dir.join("projects")).unwrap();
        fs::write(main.dir.join("projects/chat.jsonl"), "{}").unwrap();
        fs::write(main.dir.join("settings.json"), "{}").unwrap();
        fs::write(main.dir.join("daemon.lock"), "").unwrap();
        login_as(1, &HashMap::from([("CLAUDE_CONFIG_DIR".into(), main.dir.to_string_lossy().into_owned())]));
        fs::write(&main.config, json!({ "oauthAccount": { "accountUuid": "u1", "organizationUuid": "o", "emailAddress": "a1@x" }, "mcpServers": { "m": {} }, "projects": { "p": {} } }).to_string()).unwrap();
        let acc = Accounts::new(main.clone(), tmp.path().join("accounts"));
        let l = acc.list();
        assert_eq!((l[0]["id"].as_str(), emails(&l)), (Some("system"), vec!["a1@x".to_string()]));
        assert!(acc.add(login(1)).await["error"].as_str().unwrap().contains("already added"));
        assert!(acc.add(|_| std::future::ready(json!({ "stderr": "cancelled" }))).await["error"].as_str().unwrap().contains("cancelled"));
        let r = acc.add(login(2)).await;
        assert_eq!(r["email"], "a2@x");
        let id = r["id"].as_str().unwrap().to_string();
        assert_eq!(emails(&acc.list()), ["a1@x", "a2@x"]);
        assert!(acc.env("system").unwrap().is_empty());
        assert!(acc.env("nope").unwrap_err().contains("Account not found"));
        assert!(acc.env("../x").is_err());
        let dir = PathBuf::from(&acc.env(&id).unwrap()["CLAUDE_CONFIG_DIR"]);
        assert!(fs::symlink_metadata(dir.join("projects")).unwrap().file_type().is_symlink());
        assert!(fs::symlink_metadata(dir.join("settings.json")).unwrap().file_type().is_symlink());
        assert!(!dir.join("daemon.lock").exists());
        assert_eq!(read_json(&dir.join(".credentials.json"))["claudeAiOauth"]["refreshToken"], "r2");
        let cfg = read_json(&dir.join(".claude.json"));
        assert_eq!(cfg["oauthAccount"]["emailAddress"], "a2@x");
        assert_eq!(cfg["mcpServers"], json!({ "m": {} }));
        acc.remove(&id).unwrap();
        assert!(!dir.exists());
        assert!(main.dir.join("projects/chat.jsonl").exists());
        assert!(main.dir.join("settings.json").exists());
        assert!(acc.remove("system").is_err());
    }

    #[test]
    fn default_paths_follow_claude_code() {
        let f = claude_files(Path::new("/h"), None);
        assert_eq!((f.dir, f.creds, f.config), (PathBuf::from("/h/.claude"), PathBuf::from("/h/.claude/.credentials.json"), PathBuf::from("/h/.claude.json")));
    }

    #[tokio::test]
    async fn accounts_keep_their_record_when_claude_code_config_breaks() {
        let s = setup().await;
        fs::write(s.dir.join(".claude.json"), "{\"oauthAcc").unwrap();
        assert_eq!(s.acc.list().iter().find(|a| a["email"] == "a2@x").unwrap()["signedIn"], true);
        fs::write(s.dir.join(".claude.json"), "{}").unwrap();
        assert_eq!(s.acc.list().iter().find(|a| a["email"] == "a2@x").unwrap()["signedIn"], true);
    }

    #[tokio::test]
    async fn signed_out_accounts_stay_listed_and_refuse_to_run() {
        let s = setup().await;
        fs::remove_file(s.dir.join(".credentials.json")).unwrap();
        let l = s.acc.list();
        let a2 = l.iter().find(|a| a["id"] == s.id.as_str()).unwrap();
        assert_eq!(a2["signedIn"], false);
        assert!(a2["signedOutAt"].is_number());
        assert_eq!(s.acc.env(&s.id).unwrap_err(), "a2@x is signed out. Sign in again from the account menu.");
        assert!(s.acc.env("nope").unwrap_err().contains("Account not found"));
    }

    #[tokio::test]
    async fn env_leaves_an_unreadable_config_alone() {
        let s = setup().await;
        fs::write(s.dir.join(".claude.json"), "{\"oauthAcc").unwrap();
        s.acc.env(&s.id).unwrap();
        assert_eq!(fs::read_to_string(s.dir.join(".claude.json")).unwrap(), "{\"oauthAcc");
    }

    #[tokio::test]
    async fn concurrent_env_calls_keep_the_login() {
        let s = Arc::new(setup().await);
        let hs: Vec<_> = (0..4)
            .map(|i| {
                let s = s.clone();
                std::thread::spawn(move || {
                    if i == 3 {
                        s.acc.list();
                    } else {
                        s.acc.env(&s.id).unwrap();
                    }
                })
            })
            .collect();
        hs.into_iter().for_each(|h| h.join().unwrap());
        assert_eq!(read_json(&s.dir.join(".claude.json"))["oauthAccount"]["emailAddress"], "a2@x");
    }

    #[tokio::test]
    async fn signing_in_again_revives_the_signed_out_slot() {
        let s = setup().await;
        fs::remove_file(s.dir.join(".credentials.json")).unwrap();
        s.acc.list();
        assert_eq!(s.acc.add(login(2)).await, json!({ "id": s.id, "email": "a2@x", "revived": true }));
        let l = s.acc.list();
        assert_eq!(l.iter().filter(|a| a["email"] == "a2@x").count(), 1);
        let a = l.iter().find(|a| a["id"] == s.id.as_str()).unwrap();
        assert_eq!(a["signedIn"], true);
        assert!(a.get("signedOutAt").is_none());
        assert_eq!(PathBuf::from(&s.acc.env(&s.id).unwrap()["CLAUDE_CONFIG_DIR"]), s.dir);
    }

    #[tokio::test]
    async fn migrates_accounts_added_before_records_existed() {
        let s = setup().await;
        let old = s.main.dir.parent().unwrap().join("accounts/legacy");
        fs::create_dir_all(&old).unwrap();
        login_as(3, &HashMap::from([("CLAUDE_CONFIG_DIR".into(), old.to_string_lossy().into_owned())]));
        assert!(s.acc.list().iter().any(|a| a["id"] == "legacy" && a["email"] == "a3@x"));
        assert_eq!(read_json(&old.join("codedesk.json"))["email"], "a3@x");
    }

    #[tokio::test]
    async fn a_torn_credentials_read_is_not_a_sign_out() {
        let s = setup().await;
        fs::write(s.dir.join(".credentials.json"), "{\"claudeAiOa").unwrap();
        assert_eq!(s.acc.list().iter().find(|a| a["id"] == s.id.as_str()).unwrap()["signedIn"], true);
        assert_eq!(PathBuf::from(&s.acc.env(&s.id).unwrap()["CLAUDE_CONFIG_DIR"]), s.dir);
    }

    #[tokio::test]
    async fn one_broken_account_folder_does_not_hide_the_others() {
        let s = setup().await;
        let bad = s.main.dir.parent().unwrap().join("accounts/broken");
        fs::create_dir_all(bad.join("codedesk.json")).unwrap();
        login_as(4, &HashMap::from([("CLAUDE_CONFIG_DIR".into(), bad.to_string_lossy().into_owned())]));
        assert!(s.acc.list().iter().any(|a| a["id"] == s.id.as_str()));
    }

    #[tokio::test]
    async fn accounts_from_before_records_existed_can_start_before_the_first_list() {
        let s = setup().await;
        let old = s.main.dir.parent().unwrap().join("accounts/legacy");
        fs::create_dir_all(&old).unwrap();
        login_as(3, &HashMap::from([("CLAUDE_CONFIG_DIR".into(), old.to_string_lossy().into_owned())]));
        assert_eq!(PathBuf::from(&s.acc.env("legacy").unwrap()["CLAUDE_CONFIG_DIR"]), old);
    }

    #[tokio::test]
    async fn an_added_account_the_system_login_switches_to_is_listed_once() {
        let s = setup().await;
        login_as(2, &HashMap::from([("CLAUDE_CONFIG_DIR".into(), s.main.dir.to_string_lossy().into_owned())]));
        fs::write(&s.main.config, json!({ "oauthAccount": { "accountUuid": "u2", "organizationUuid": "o", "emailAddress": "a2@x" } }).to_string()).unwrap();
        let l = s.acc.list();
        assert_eq!(l.len(), 1);
        assert_eq!((l[0]["id"].as_str(), l[0]["email"].as_str()), (Some("system"), Some("a2@x")));
    }
}
