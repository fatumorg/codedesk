use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, watch};

#[derive(Default, Clone)]
pub struct Launch {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub max_turns: Option<u32>,
    pub resume: Option<String>,
    pub disallowed: Vec<String>,
    pub mcp_config: Option<Value>,
    pub permission_mode: String,
    pub add_dirs: Vec<String>,
    pub fork: bool,
    pub resume_at: Option<String>,
    pub settings: Option<Value>,
}

impl Launch {
    pub fn args(&self) -> Vec<String> {
        let mut a: Vec<String> = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"].map(String::from).to_vec();
        if let Some(e) = &self.effort {
            a.push(format!("--effort={e}"));
        }
        if let Some(n) = self.max_turns {
            a.push(format!("--max-turns={n}"));
        }
        if let Some(m) = &self.model {
            a.push(format!("--model={m}"));
        }
        a.push("--permission-prompt-tool=stdio".into());
        if let Some(r) = &self.resume {
            a.push(format!("--resume={r}"));
        }
        if !self.disallowed.is_empty() {
            a.push(format!("--disallowedTools={}", self.disallowed.join(",")));
        }
        a.push("--tools=default".into());
        if let Some(m) = &self.mcp_config {
            a.extend(["--mcp-config".into(), m.to_string()]);
        }
        a.push("--setting-sources=user,project,local".into());
        a.push(format!("--permission-mode={}", self.permission_mode));
        a.push("--include-partial-messages".into());
        for d in &self.add_dirs {
            a.push(format!("--add-dir={d}"));
        }
        if self.fork {
            a.push("--fork-session".into());
        }
        if let Some(u) = &self.resume_at {
            a.push(format!("--resume-session-at={u}"));
        }
        if let Some(s) = &self.settings {
            a.extend(["--settings".into(), s.to_string()]);
        }
        a
    }
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().filter(|_| n.as_f64().is_some_and(|f| f.fract() == 0.0)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

pub fn saver_options(saver: &Value) -> (HashMap<String, String>, Option<u32>, Vec<String>) {
    let mut env = HashMap::from([("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD".to_string(), "1".to_string())]);
    if let Some(m) = saver["subagentModel"].as_str().filter(|m| ["sonnet", "haiku"].contains(m)) {
        env.insert("CLAUDE_CODE_SUBAGENT_MODEL".into(), m.into());
    }
    if let Some(p) = int(&saver["compactAt"]).filter(|p| (1..=100).contains(p)) {
        env.insert("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), p.to_string());
    }
    let turns = int(&saver["maxTurns"]).filter(|t| *t > 0).map(|t| t as u32);
    let tools = if saver["noSubagents"] == true { vec!["Agent".to_string(), "Task".to_string()] } else { vec![] };
    (env, turns, tools)
}

pub enum Event {
    Message(Value),
    Permission { request_id: String, request: Value },
    Cancel(String),
    Stderr(String),
    Exit { code: Option<i32>, stderr: String },
}

enum Out {
    Line(String),
    Close,
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

pub struct Proc {
    out: mpsc::UnboundedSender<Out>,
    pending: Pending,
    exited: watch::Receiver<bool>,
    kill: Mutex<Option<oneshot::Sender<()>>>,
}

pub fn sdk_env(extra: HashMap<String, String>) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().filter(|(k, _)| k != "NODE_OPTIONS" && k != "DEBUG").collect();
    env.extend(extra);
    env.entry("CLAUDE_CODE_ENTRYPOINT".into()).or_insert_with(|| "sdk-ts".into());
    env.insert("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING".into(), "true".into());
    env
}

impl Proc {
    pub fn spawn(bin: &Path, args: Vec<String>, cwd: &str, env: HashMap<String, String>, events: impl Fn(Event) + Send + Sync + 'static) -> Result<Arc<Proc>, String> {
        let mut child = Command::new(bin)
            .args(&args)
            .current_dir(cwd)
            .env_clear()
            .envs(sdk_env(env))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start Claude Code ({}): {e}", bin.display()))?;
        let events = Arc::new(events);
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
        let mut stdin = child.stdin.take();
        tokio::spawn(async move {
            while let Some(o) = out_rx.recv().await {
                match o {
                    Out::Line(l) => {
                        let ok = match stdin.as_mut() {
                            Some(s) => s.write_all(l.as_bytes()).await.is_ok() && s.flush().await.is_ok(),
                            None => false,
                        };
                        if !ok {
                            stdin = None;
                        }
                    }
                    Out::Close => stdin = None,
                }
            }
        });
        let pending: Pending = Arc::default();
        let tail = Arc::new(Mutex::new(String::new()));
        let stderr = child.stderr.take().unwrap();
        let (ev, t) = (events.clone(), tail.clone());
        let err_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                {
                    let mut t = t.lock().unwrap();
                    t.push_str(&line);
                    t.push('\n');
                    if t.len() > 4096 {
                        let cut = t.len() - 2048;
                        let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(t.len());
                        t.drain(..cut);
                    }
                }
                ev(Event::Stderr(line));
            }
        });
        let stdout = child.stdout.take().unwrap();
        let (ev, pend) = (events.clone(), pending.clone());
        let read_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                match msg["type"].as_str() {
                    Some("control_response") => {
                        let r = &msg["response"];
                        let id = r["request_id"].as_str().unwrap_or_default();
                        if let Some(tx) = pend.lock().unwrap().remove(id) {
                            let _ = tx.send(if r["subtype"] == "success" {
                                Ok(r["response"].clone())
                            } else {
                                Err(r["error"].as_str().map(String::from).unwrap_or_else(|| r["error"].to_string()))
                            });
                        }
                    }
                    Some("control_request") => ev(Event::Permission { request_id: msg["request_id"].as_str().unwrap_or_default().into(), request: msg["request"].clone() }),
                    Some("control_cancel_request") => ev(Event::Cancel(msg["request_id"].as_str().unwrap_or_default().into())),
                    Some("keep_alive") | Some("transcript_mirror") => {}
                    _ => ev(Event::Message(msg)),
                }
            }
        });
        let (exit_tx, exit_rx) = watch::channel(false);
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let pend = pending.clone();
        tokio::spawn(async move {
            let status = tokio::select! {
                s = child.wait() => s.ok(),
                _ = kill_rx => { let _ = child.kill().await; child.wait().await.ok() }
            };
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                let _ = read_task.await;
                let _ = err_task.await;
            })
            .await;
            for (_, tx) in pend.lock().unwrap().drain() {
                let _ = tx.send(Err("Claude Code process exited".into()));
            }
            let stderr = tail.lock().unwrap().clone();
            events(Event::Exit { code: status.and_then(|s| s.code()), stderr });
            let _ = exit_tx.send(true);
        });
        Ok(Arc::new(Proc { out: out_tx, pending, exited: exit_rx, kill: Mutex::new(Some(kill_tx)) }))
    }

    pub fn write(&self, v: &Value) {
        let _ = self.out.send(Out::Line(format!("{v}\n")));
    }

    pub fn respond(&self, request_id: &str, response: Value) {
        self.write(&json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } }));
    }

    pub fn respond_error(&self, request_id: &str, error: &str) {
        self.write(&json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": error } }));
    }

    pub fn end_input(&self) {
        let _ = self.out.send(Out::Close);
    }

    pub fn exited(&self) -> bool {
        *self.exited.borrow()
    }

    pub fn request(&self, req: Value) -> impl std::future::Future<Output = Result<Value, String>> + Send + 'static {
        let rx = (!self.exited()).then(|| {
            let id = crate::util::uuid().replace('-', "")[..13].to_string();
            let (tx, rx) = oneshot::channel();
            self.pending.lock().unwrap().insert(id.clone(), tx);
            self.write(&json!({ "request_id": id, "type": "control_request", "request": req }));
            rx
        });
        async move {
            match rx {
                Some(rx) => rx.await.unwrap_or_else(|_| Err("Claude Code process exited".into())),
                None => Err("Claude Code process exited".into()),
            }
        }
    }

    pub async fn close(&self) {
        self.end_input();
        let mut rx = self.exited.clone();
        if tokio::time::timeout(Duration::from_secs(2), rx.wait_for(|e| *e)).await.is_err() {
            if let Some(k) = self.kill.lock().unwrap().take() {
                let _ = k.send(());
            }
            let _ = tokio::time::timeout(Duration::from_secs(5), rx.wait_for(|e| *e)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tokio::sync::mpsc;

    fn fake() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake_claude.sh")
    }

    #[test]
    fn cli_args_match_sdk() {
        let l = Launch {
            model: Some("opus".into()),
            effort: Some("high".into()),
            max_turns: Some(5),
            resume: Some("R".into()),
            disallowed: vec!["Agent".into(), "Task".into()],
            mcp_config: Some(json!({ "mcpServers": {} })),
            permission_mode: "plan".into(),
            add_dirs: vec!["/a".into()],
            fork: true,
            resume_at: Some("U".into()),
            settings: Some(json!({ "env": {} })),
        };
        assert_eq!(
            l.args(),
            [
                "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--effort=high", "--max-turns=5", "--model=opus",
                "--permission-prompt-tool=stdio", "--resume=R", "--disallowedTools=Agent,Task", "--tools=default", "--mcp-config", "{\"mcpServers\":{}}",
                "--setting-sources=user,project,local", "--permission-mode=plan", "--include-partial-messages", "--add-dir=/a", "--fork-session",
                "--resume-session-at=U", "--settings", "{\"env\":{}}",
            ]
        );
    }

    #[test]
    fn minimal_args_skip_unset_options() {
        let l = Launch { permission_mode: "default".into(), ..Default::default() };
        assert_eq!(
            l.args(),
            [
                "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--permission-prompt-tool=stdio", "--tools=default",
                "--setting-sources=user,project,local", "--permission-mode=default", "--include-partial-messages",
            ]
        );
    }

    #[test]
    fn saver_options_map_to_env_turns_and_tools() {
        let (env, turns, tools) = saver_options(&json!({ "subagentModel": "haiku", "compactAt": "80", "maxTurns": "12", "noSubagents": true }));
        assert_eq!(env["CLAUDE_CODE_SUBAGENT_MODEL"], "haiku");
        assert_eq!(env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"], "80");
        assert_eq!(env["CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"], "1");
        assert_eq!(turns, Some(12));
        assert_eq!(tools, ["Agent", "Task"]);
        let (env, turns, tools) = saver_options(&json!({ "subagentModel": "opus", "compactAt": "101", "maxTurns": "0", "noSubagents": "yes" }));
        assert!(!env.contains_key("CLAUDE_CODE_SUBAGENT_MODEL"));
        assert!(!env.contains_key("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"));
        assert_eq!(turns, None);
        assert!(tools.is_empty());
    }

    async fn spawn_fake(mode: &str, out: &std::path::Path) -> (Arc<Proc>, mpsc::UnboundedReceiver<Event>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let env = HashMap::from([("FAKE_MODE".to_string(), mode.to_string()), ("FAKE_OUT".to_string(), out.to_string_lossy().into_owned())]);
        let p = Proc::spawn(&fake(), vec![], "/", env, move |e| {
            let _ = tx.send(e);
        })
        .unwrap();
        (p, rx)
    }

    async fn next_permission(rx: &mut mpsc::UnboundedReceiver<Event>) -> (String, Value) {
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() {
                Event::Permission { request_id, request } => return (request_id, request),
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn initialize_then_permission_round_trip() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("out");
        let (p, mut rx) = spawn_fake("", &out).await;
        let init = p.request(json!({ "subtype": "initialize", "promptSuggestions": true })).await.unwrap();
        assert_eq!(init["commands"][0]["name"], "compact");
        p.write(&json!({ "type": "user", "message": { "role": "user", "content": "hi" }, "parent_tool_use_id": null }));
        let (rid, req) = next_permission(&mut rx).await;
        assert_eq!(rid, "perm1");
        assert_eq!(req["tool_name"], "Bash");
        p.respond(&rid, json!({ "behavior": "allow", "updatedInput": { "command": "ls" }, "toolUseID": "tu1" }));
        p.close().await;
        let written = std::fs::read_to_string(&out).unwrap();
        assert!(written.contains("\"behavior\":\"allow\""));
        assert!(written.contains("\"toolUseID\":\"tu1\""));
        assert!(written.contains("\"request_id\":\"perm1\""));
    }

    #[tokio::test]
    async fn control_errors_come_back_as_err() {
        let d = tempfile::tempdir().unwrap();
        let (p, _rx) = spawn_fake("", &d.path().join("out")).await;
        assert_eq!(p.request(json!({ "subtype": "set_model", "model": "x" })).await.unwrap_err(), "no such model");
        assert_eq!(p.request(json!({ "subtype": "get_context_usage" })).await.unwrap()["percentage"], 12);
        p.close().await;
    }

    #[tokio::test]
    async fn deny_written_before_close_reaches_the_cli() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("out");
        let (p, mut rx) = spawn_fake("", &out).await;
        p.write(&json!({ "type": "user", "message": { "role": "user", "content": "hi" } }));
        let (rid, _) = next_permission(&mut rx).await;
        p.respond(&rid, json!({ "behavior": "deny", "message": "Session closed" }));
        p.close().await;
        let written = std::fs::read_to_string(&out).unwrap();
        assert!(written.contains("\"behavior\":\"deny\""));
        assert!(written.trim_end().ends_with("EOF"));
    }

    #[tokio::test]
    async fn early_exit_reports_code_and_stderr() {
        let d = tempfile::tempdir().unwrap();
        let (p, mut rx) = spawn_fake("exit", &d.path().join("out")).await;
        let pending = p.request(json!({ "subtype": "initialize" }));
        assert!(pending.await.is_err());
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() {
                Event::Exit { code, stderr } => {
                    assert_eq!(code, Some(1));
                    assert!(stderr.contains("boom"));
                    break;
                }
                _ => {}
            }
        }
    }
}
