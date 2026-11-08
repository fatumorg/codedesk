use crate::accounts::{system_files, Accounts};
use crate::claude::{saver_options, Event, Launch, Proc};
use crate::core::core;
use crate::gemini::{self, is_gemini, Turn};
use crate::hub::{Client, Entry};
use crate::local::{self, is_local, local_auto_allows, local_env, local_id, local_mode, local_overrides};
use crate::util::{now_ms, read_json, uuid, write_json};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Notify};

pub struct Session {
    pub key: String,
    pub entry: Arc<Entry>,
    pub account: String,
    closed: AtomicBool,
    pending: Mutex<HashMap<String, (String, Value)>>,
    engine: Engine,
}

enum Engine {
    Claude { proc: OnceLock<Arc<Proc>>, local: bool, init: Mutex<Option<Value>> },
    Gemini(Arc<Gem>),
}

struct Gem {
    session_id: String,
    cwd: String,
    state: Mutex<GemState>,
    queue: mpsc::UnboundedSender<Value>,
    kill: Notify,
    aborted: AtomicBool,
}

struct GemState {
    model: String,
    mode: String,
    conversation: Option<String>,
    history: Vec<Value>,
    tokens: i64,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(Default::default);
static STORE: Mutex<()> = Mutex::new(());
static AGY_MODELS: tokio::sync::Mutex<Option<Vec<Value>>> = tokio::sync::Mutex::const_new(None);

const GEMINI_CTX: i64 = 1048576;
const LOCAL_BLOCKED: [&str; 4] = ["Workflow", "ScheduleWakeup", "ReportFindings", "ListAgents"];

pub fn accounts() -> &'static Accounts {
    static A: LazyLock<Accounts> = LazyLock::new(|| Accounts::new(system_files(), core().data.join("accounts")));
    &A
}

fn engine_of(m: &str) -> &'static str {
    if is_gemini(m) {
        "gemini"
    } else if is_local(m) {
        "local"
    } else {
        "claude"
    }
}

fn get(key: &str) -> Option<Arc<Session>> {
    SESSIONS.lock().unwrap().get(key).cloned()
}

fn route(client: &Client, tab: &Value) -> Option<Arc<Session>> {
    core().hub.get(&client.id, tab).and_then(|e| get(&e.key))
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn restart_tab(client: &Client, tab: &Value) {
    if let Some(prev) = core().hub.get(&client.id, tab) {
        core().hub.detach(&client.id, tab);
        stop(&prev.key);
    }
}

fn leave_tab(client: &Client, tab: &Value) {
    if let Some(e) = core().hub.get(&client.id, tab) {
        if core().hub.detach(&client.id, tab) == 0 {
            stop(&e.key);
        }
    }
}

fn register(key: &str, client: &Client, tab: &Value, account: &str, engine: Engine) -> Arc<Session> {
    let k = key.to_string();
    let entry = core().hub.add(key, client, tab.clone(), Box::new(move || stop(&k)));
    let s = Arc::new(Session { key: key.into(), entry, account: account.into(), closed: AtomicBool::new(false), pending: Mutex::default(), engine });
    SESSIONS.lock().unwrap().insert(key.into(), s.clone());
    s
}

pub fn stop(key: &str) {
    let Some(s) = SESSIONS.lock().unwrap().remove(key) else { return };
    s.closed.store(true, Ordering::SeqCst);
    let pending: Vec<_> = s.pending.lock().unwrap().drain().collect();
    match &s.engine {
        Engine::Claude { proc, .. } => {
            if let Some(p) = proc.get().cloned() {
                for (_, (rid, tu)) in pending {
                    p.respond(&rid, json!({ "behavior": "deny", "message": "Session closed", "toolUseID": tu }));
                }
                tauri::async_runtime::spawn(async move { p.close().await });
            }
        }
        Engine::Gemini(g) => {
            g.aborted.store(true, Ordering::SeqCst);
            g.kill.notify_waiters();
        }
    }
    s.entry.emit("claude:ended", json!({}));
    core().hub.remove(key);
}

async fn agy_models(fresh: bool) -> Vec<Value> {
    let mut g = AGY_MODELS.lock().await;
    if fresh || g.is_none() {
        *g = Some(match core().agy.clone() {
            Some(b) => {
                let r = crate::util::run(b, &["models".into()], crate::util::RunOpts { timeout: Some(Duration::from_secs(20)), ..Default::default() }).await;
                if r["code"] == 0 { gemini::parse_agy_models(r["stdout"].as_str().unwrap_or_default()) } else { vec![] }
            }
            None => vec![],
        });
    }
    g.clone().unwrap()
}

pub async fn google_status() -> Value {
    let models = agy_models(true).await;
    json!({ "installed": core().agy.is_some(), "loggedIn": !models.is_empty(), "models": models })
}

pub async fn start(client: &Client, tab: Value, opts: Value) -> Result<Value, String> {
    let cwd = s(&opts["cwd"]);
    if !Path::new(&cwd).is_dir() {
        client.send("claude:error", json!({ "tab": tab, "error": format!("Project folder not found: {cwd}") }));
        return Ok(Value::Null);
    }
    let model = s(&opts["model"]);
    if is_gemini(&model) {
        return Ok(json!(start_gemini(client, &tab, &opts)));
    }
    let local = is_local(&model);
    let mode = opts["permissionMode"].as_str().filter(|m| !m.is_empty()).unwrap_or("default").to_string();
    let account = s(&opts["account"]);
    let account_env = if local {
        let t = local::prepare(&opts["local"], local_id(&model)).await?;
        local_env(&t.url, &t.key, local_id(&model), t.ctx)
    } else {
        accounts().env(&account)?
    };
    restart_tab(client, &tab);
    let key = uuid();
    let resume = opts["resume"].as_str().filter(|r| !r.is_empty()).map(String::from);
    let fork = opts["forkSession"] == true;
    let sess = register(&key, client, &tab, &account, Engine::Claude { proc: OnceLock::new(), local, init: Mutex::new(None) });
    let entry = sess.entry.clone();
    entry.set_info(|i| *i = json!({ "cwd": cwd, "model": model, "permissionMode": mode, "account": opts["account"], "effort": opts["effort"], "local": opts["local"] }));
    if let (Some(r), false) = (&resume, fork) {
        entry.set_session_id(Some(r.clone()));
        core().hub.broadcast("sessions:changed", json!({}), None);
    }
    let (mut env, max_turns, mut disallowed) = saver_options(&opts["saver"]);
    env.extend(account_env.clone());
    if local {
        disallowed.extend(LOCAL_BLOCKED.map(String::from));
    }
    let computer = opts["computerUse"] == true && !local;
    let settings = if local {
        let mut o = local_overrides(&opts["local"]["off"]);
        o["env"] = json!(account_env);
        Some(o)
    } else {
        computer.then(|| json!({ "permissions": { "ask": ["mcp__computer"] } }))
    };
    let launch = Launch {
        model: Some(if local { local_id(&model).to_string() } else { model.clone() }).filter(|m| !m.is_empty()),
        effort: opts["effort"].as_str().filter(|e| !local && !e.is_empty()).map(String::from),
        max_turns,
        resume,
        disallowed,
        mcp_config: computer.then(crate::computer::mcp_config),
        permission_mode: if local { local_mode(&mode).to_string() } else { mode.clone() },
        add_dirs: opts["additionalDirectories"].as_array().into_iter().flatten().filter_map(|d| d.as_str().map(String::from)).collect(),
        fork,
        resume_at: opts["resumeSessionAt"].as_str().filter(|r| !r.is_empty()).map(String::from),
        settings,
    };
    let k = key.clone();
    let proc = match Proc::spawn(&core().claude_bin(), launch.args(), &cwd, env, move |ev| on_event(&k, ev)) {
        Ok(p) => p,
        Err(e) => {
            SESSIONS.lock().unwrap().remove(&key);
            entry.emit("claude:error", json!({ "error": e }));
            entry.emit("claude:ended", json!({}));
            core().hub.remove(&key);
            return Ok(Value::Null);
        }
    };
    let init = proc.request(json!({ "subtype": "initialize", "promptSuggestions": true }));
    if let Engine::Claude { proc: slot, .. } = &sess.engine {
        let _ = slot.set(proc);
    }
    tokio::spawn(async move {
        let meta = match init.await {
            Ok(r) => {
                if let Engine::Claude { init, .. } = &sess.engine {
                    *init.lock().unwrap() = Some(r.clone());
                }
                let mut m = json!({ "commands": r["commands"], "agents": if r["agents"].is_array() { r["agents"].clone() } else { json!([]) } });
                if !local {
                    let mut models = agy_models(false).await;
                    models.extend(r["models"].as_array().cloned().unwrap_or_default());
                    m["models"] = json!(models);
                }
                m
            }
            Err(_) => json!({ "commands": [], "models": [], "agents": [] }),
        };
        if !sess.closed.load(Ordering::SeqCst) {
            sess.entry.emit("claude:meta", meta);
        }
    });
    Ok(json!(key))
}

fn on_event(key: &str, ev: Event) {
    let Some(s) = get(key) else { return };
    let Engine::Claude { proc, local, .. } = &s.engine else { return };
    let Some(p) = proc.get() else { return };
    match ev {
        Event::Message(mut msg) => {
            if *local && msg["type"] == "system" && msg["subtype"] == "init" {
                msg["permissionMode"] = s.entry.info()["permissionMode"].clone();
            }
            if msg["type"] == "system" && msg["subtype"] == "commands_changed" && msg["commands"].is_array() {
                let meta = s.entry.state.lock().unwrap().meta.clone();
                if let Some(mut m) = meta {
                    m["commands"] = msg["commands"].clone();
                    s.entry.emit("claude:meta", m);
                }
            }
            s.entry.emit("claude:message", json!({ "msg": msg }));
        }
        Event::Permission { request_id, request } => {
            if request["subtype"] != "can_use_tool" {
                p.respond_error(&request_id, &format!("Unsupported control request: {}", request["subtype"]));
                return;
            }
            let tool = s_str(&request["tool_name"]);
            let tu = request["tool_use_id"].clone();
            if *local && local_auto_allows(s.entry.info()["permissionMode"].as_str().unwrap_or_default(), &tool) {
                p.respond(&request_id, json!({ "behavior": "allow", "updatedInput": request["input"], "toolUseID": tu }));
                return;
            }
            let id = uuid();
            s.pending.lock().unwrap().insert(id.clone(), (request_id, tu));
            s.entry.emit(
                "claude:permission",
                json!({ "id": id, "toolName": tool, "input": request["input"], "suggestions": request["permission_suggestions"], "decisionReason": request["decision_reason"], "title": request["title"] }),
            );
        }
        Event::Cancel(rid) => {
            let id = s.pending.lock().unwrap().iter().find(|(_, (r, _))| *r == rid).map(|(k, _)| k.clone());
            if let Some(id) = id {
                s.pending.lock().unwrap().remove(&id);
                s.entry.answered(&id, "", None);
            }
        }
        Event::Stderr(line) => s.entry.emit("claude:stderr", json!({ "line": line })),
        Event::Exit { code, stderr } => {
            if s.closed.load(Ordering::SeqCst) {
                return;
            }
            SESSIONS.lock().unwrap().remove(key);
            if code != Some(0) {
                let tail: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
                let tail = tail[tail.len().saturating_sub(3)..].join("\n");
                let why = code.map(|c| format!("Claude Code process exited with code {c}")).unwrap_or("Claude Code process was terminated".into());
                s.entry.emit("claude:error", json!({ "error": if tail.is_empty() { why } else { format!("{why}\n{tail}") } }));
            }
            s.entry.emit("claude:ended", json!({}));
            core().hub.remove(key);
        }
    }
}

fn store_path() -> std::path::PathBuf {
    core().data.join("agy-sessions.json")
}

pub fn gemini_store() -> Map<String, Value> {
    let _g = STORE.lock().unwrap();
    read_json(&store_path()).as_object().cloned().unwrap_or_default()
}

pub fn update_gemini_store<T>(f: impl FnOnce(&mut Map<String, Value>) -> T) -> T {
    let _g = STORE.lock().unwrap();
    let mut all = read_json(&store_path()).as_object().cloned().unwrap_or_default();
    let r = f(&mut all);
    let _ = write_json(&store_path(), &Value::Object(all));
    r
}

pub fn live_gemini_history(id: &str) -> Option<Value> {
    SESSIONS.lock().unwrap().values().find_map(|s| match &s.engine {
        Engine::Gemini(g) if g.session_id == id => Some(json!(g.state.lock().unwrap().history)),
        _ => None,
    })
}

fn start_gemini(client: &Client, tab: &Value, opts: &Value) -> String {
    restart_tab(client, tab);
    let resume = s(&opts["resume"]);
    let existing = gemini_store().get(&resume).cloned().filter(|_| !resume.is_empty());
    let key = uuid();
    let mode = opts["permissionMode"].as_str().filter(|m| !m.is_empty()).unwrap_or("default").to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let g = Arc::new(Gem {
        session_id: if existing.is_some() { resume } else { uuid() },
        cwd: s(&opts["cwd"]),
        state: Mutex::new(GemState {
            model: s(&opts["model"]),
            mode: mode.clone(),
            conversation: existing.as_ref().and_then(|e| e["conversationId"].as_str().map(String::from)),
            history: existing.as_ref().and_then(|e| e["messages"].as_array().cloned()).unwrap_or_default(),
            tokens: existing.as_ref().and_then(|e| e["tokensUsed"].as_i64()).unwrap_or(0),
        }),
        queue: tx,
        kill: Notify::new(),
        aborted: AtomicBool::new(false),
    });
    let sess = register(&key, client, tab, &s(&opts["account"]), Engine::Gemini(g.clone()));
    sess.entry.set_info(|i| *i = json!({ "cwd": opts["cwd"], "model": opts["model"], "permissionMode": mode, "account": opts["account"] }));
    tokio::spawn(async move {
        sess.entry.emit("claude:meta", json!({ "commands": [], "models": agy_models(false).await, "agents": [] }));
        let (model, mode) = {
            let st = g.state.lock().unwrap();
            (st.model.clone(), st.mode.clone())
        };
        sess.entry.emit(
            "claude:message",
            json!({ "msg": { "type": "system", "subtype": "init", "session_id": g.session_id, "mcp_servers": [], "skills": [], "model": model,
                "claude_code_version": "Antigravity CLI", "output_style": "default", "permissionMode": mode, "slash_commands": [] } }),
        );
        while let Some(msg) = rx.recv().await {
            if sess.closed.load(Ordering::SeqCst) {
                break;
            }
            gemini_turn(&sess, &g, msg).await;
        }
    });
    key
}

async fn gemini_turn(sess: &Session, g: &Gem, msg: Value) {
    let content = &msg["message"]["content"];
    let blocks: Vec<Value> = match content {
        Value::String(t) => vec![json!({ "type": "text", "text": t })],
        Value::Array(a) => a.clone(),
        _ => vec![],
    };
    let uid = msg["uuid"].as_str().map(String::from).unwrap_or_else(uuid);
    g.state.lock().unwrap().history.push(json!({ "type": "user", "uuid": uid, "message": { "role": "user", "content": blocks } }));
    if msg["shouldQuery"] == false {
        return;
    }
    let started = now_ms();
    let (model, mode, conv, tokens) = {
        let st = g.state.lock().unwrap();
        (st.model.clone(), st.mode.clone(), st.conversation.clone(), st.tokens)
    };
    let mut st = Turn::new(conv, tokens);
    let emit = |m: Value| {
        if m["type"] == "assistant" || m["type"] == "user" {
            g.state.lock().unwrap().history.push(m.clone());
        }
        sess.entry.emit("claude:message", json!({ "msg": m }));
    };
    g.aborted.store(false, Ordering::SeqCst);
    let prompt = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n");
    let mut code = 0;
    match core().agy.clone() {
        None => st.error = Some("Antigravity CLI (agy) is not installed. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash".into()),
        Some(bin) => {
            let spawned = tokio::process::Command::new(bin)
                .args(gemini::agy_args(&prompt, &model, &mode, st.conversation_id.clone().as_deref()))
                .current_dir(&g.cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn();
            match spawned {
                Err(e) => st.error = Some(e.to_string()),
                Ok(mut child) => {
                    let stderr = child.stderr.take().unwrap();
                    let entry = sess.entry.clone();
                    tokio::spawn(async move {
                        let mut l = BufReader::new(stderr).lines();
                        while let Ok(Some(line)) = l.next_line().await {
                            entry.emit("claude:stderr", json!({ "line": line }));
                        }
                    });
                    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
                    let killed = g.kill.notified();
                    tokio::pin!(killed);
                    loop {
                        tokio::select! {
                            l = lines.next_line() => match l {
                                Ok(Some(l)) => st.translate(&serde_json::from_str(&l).unwrap_or(Value::Null)).into_iter().for_each(emit),
                                _ => break,
                            },
                            _ = &mut killed => {
                                let _ = child.start_kill();
                                break;
                            }
                        }
                    }
                    code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
                }
            }
        }
    }
    st.finish().into_iter().for_each(emit);
    let aborted = g.aborted.load(Ordering::SeqCst);
    if st.error.is_none() && code != 0 && !aborted {
        st.error = Some(format!("agy exited with code {code}"));
    }
    let failed = st.error.is_some() && !aborted;
    let first: String = blocks.iter().find(|b| b["type"] == "text").and_then(|b| b["text"].as_str()).unwrap_or("Gemini").chars().take(80).collect();
    let record = {
        let mut s = g.state.lock().unwrap();
        s.conversation = st.conversation_id.clone();
        s.tokens = st.tokens;
        json!({ "model": s.model, "conversationId": s.conversation, "messages": s.history, "tokensUsed": s.tokens })
    };
    update_gemini_store(|all| {
        let prev = all.get(&g.session_id).cloned().unwrap_or_default();
        let or = |k: &str| if prev[k].is_null() { json!(first) } else { prev[k].clone() };
        all.insert(
            g.session_id.clone(),
            json!({ "sessionId": g.session_id, "cwd": g.cwd, "model": record["model"], "conversationId": record["conversationId"], "customTitle": prev["customTitle"],
                "summary": or("summary"), "firstPrompt": or("firstPrompt"), "lastModified": now_ms(), "messages": record["messages"], "tokensUsed": record["tokensUsed"] }),
        );
    });
    if failed {
        sess.entry.emit("claude:error", json!({ "error": st.error }));
    }
    sess.entry.emit(
        "claude:message",
        json!({ "msg": { "type": "result", "subtype": if failed { "error" } else { "success" }, "is_error": failed, "result": if failed { json!(st.error) } else { Value::Null },
            "duration_ms": now_ms() - started, "num_turns": 1, "total_cost_usd": 0 } }),
    );
}

pub fn send(client: &Client, tab: &Value, msg: Value) {
    let Some(s) = route(client, tab) else { return };
    if msg["shouldQuery"] != false {
        s.entry.mark_busy();
    }
    let mut m = json!({ "type": "user", "parent_tool_use_id": null });
    if let (Some(o), Some(src)) = (m.as_object_mut(), msg.as_object()) {
        o.extend(src.clone());
    }
    match &s.engine {
        Engine::Claude { proc, .. } => {
            if let Some(p) = proc.get() {
                p.write(&m);
            }
        }
        Engine::Gemini(g) => {
            if m["message"].is_object() {
                let _ = g.queue.send(m);
            }
        }
    }
}

fn request_for(method: &str, a: &[Value]) -> Option<Value> {
    let a0 = a.first().cloned().unwrap_or(Value::Null);
    Some(match method {
        "interrupt" => json!({ "subtype": "interrupt" }),
        "setModel" => json!({ "subtype": "set_model", "model": a0 }),
        "setPermissionMode" => json!({ "subtype": "set_permission_mode", "mode": a0 }),
        "setMaxThinkingTokens" => json!({ "subtype": "set_max_thinking_tokens", "max_thinking_tokens": a0 }),
        "applyFlagSettings" => json!({ "subtype": "apply_flag_settings", "settings": a0 }),
        "mcpServerStatus" => json!({ "subtype": "mcp_status" }),
        "reconnectMcpServer" => json!({ "subtype": "mcp_reconnect", "serverName": a0 }),
        "toggleMcpServer" => json!({ "subtype": "mcp_toggle", "serverName": a0, "enabled": a.get(1).cloned().unwrap_or(json!(true)) }),
        "getContextUsage" => json!({ "subtype": "get_context_usage" }),
        "rewindFiles" => json!({ "subtype": "rewind_files", "user_message_id": a0, "dry_run": a.get(1).map(|o| o["dryRun"].clone()).unwrap_or(Value::Null) }),
        "stopTask" => json!({ "subtype": "stop_task", "task_id": a0 }),
        "reloadSkills" => json!({ "subtype": "reload_skills" }),
        "reloadPlugins" => json!({ "subtype": "reload_plugins" }),
        _ => return None,
    })
}

pub async fn control(client: &Client, tab: &Value, method: &str, mut args: Vec<Value>) -> Result<Value, String> {
    let Some(s) = route(client, tab) else { return Ok(Value::Null) };
    if method != "accountInfo" && request_for(method, &args).is_none() {
        return Ok(Value::Null);
    }
    let a0 = args.first().map(|v| s_str(v)).unwrap_or_default();
    let info = s.entry.info();
    let current = info["model"].as_str().unwrap_or_default().to_string();
    if method == "setModel" && engine_of(&a0) != engine_of(&current) {
        let mut opts = info.clone();
        opts["model"] = json!(a0);
        opts["resume"] = if is_gemini(&a0) || is_gemini(&current) { Value::Null } else { json!(s.entry.session_id()) };
        start(client, tab.clone(), opts).await?;
        return Ok(Value::Null);
    }
    if method == "setModel" {
        s.entry.set_info(|i| i["model"] = json!(a0));
    }
    if method == "setPermissionMode" {
        s.entry.set_info(|i| i["permissionMode"] = json!(a0));
    }
    match &s.engine {
        Engine::Gemini(g) => Ok(match method {
            "interrupt" => {
                g.aborted.store(true, Ordering::SeqCst);
                g.kill.notify_waiters();
                Value::Null
            }
            "setModel" => {
                g.state.lock().unwrap().model = a0;
                Value::Null
            }
            "setPermissionMode" => {
                g.state.lock().unwrap().mode = a0;
                Value::Null
            }
            "getContextUsage" => {
                let st = g.state.lock().unwrap();
                json!({ "percentage": (st.tokens as f64 / GEMINI_CTX as f64 * 100.0).min(100.0), "maxTokens": GEMINI_CTX, "model": st.model,
                    "categories": [{ "name": "Conversation", "kind": "messages", "tokens": st.tokens }, { "name": "Free", "kind": "free", "tokens": (GEMINI_CTX - st.tokens).max(0) }] })
            }
            "mcpServerStatus" => json!([]),
            _ => Value::Null,
        }),
        Engine::Claude { proc, local, init } => {
            if method == "accountInfo" {
                return Ok(init.lock().unwrap().as_ref().map(|i| i["account"].clone()).unwrap_or(Value::Null));
            }
            if *local && method == "setModel" {
                args[0] = json!(local_id(&a0));
            }
            if *local && method == "setPermissionMode" {
                args[0] = json!(local_mode(&a0));
            }
            let Some(p) = proc.get().cloned() else { return Ok(Value::Null) };
            let r = p.request(request_for(method, &args).unwrap()).await?;
            Ok(match method {
                "mcpServerStatus" => r["mcpServers"].clone(),
                "interrupt" | "setModel" | "setPermissionMode" | "setMaxThinkingTokens" | "applyFlagSettings" | "reconnectMcpServer" | "toggleMcpServer" | "stopTask" => Value::Null,
                _ => r,
            })
        }
    }
}

fn s_str(v: &Value) -> String {
    v.as_str().map(String::from).unwrap_or_default()
}

pub fn permit(client: &Client, tab: &Value, id: &str, result: Value) {
    let Some(s) = route(client, tab) else { return };
    if !s.pending.lock().unwrap().contains_key(id) || !s.entry.answered(id, &client.id, Some(tab)) {
        return;
    }
    let Some((rid, tu)) = s.pending.lock().unwrap().remove(id) else { return };
    if let Engine::Claude { proc, .. } = &s.engine {
        if let Some(p) = proc.get() {
            let mut r = if result.is_object() { result } else { json!({ "behavior": "deny", "message": "Denied" }) };
            r["toolUseID"] = tu;
            p.respond(&rid, r);
        }
    }
}

pub fn attach(client: &Client, tab: Value, key: &str) -> Value {
    if let Some(e) = core().hub.get(&client.id, &tab) {
        if e.key != key {
            leave_tab(client, &tab);
        }
    }
    core().hub.attach(client, tab, key).unwrap_or(Value::Null)
}

pub fn detach(client: &Client, tab: &Value) {
    leave_tab(client, tab)
}

pub fn live(client: &Client) -> Value {
    json!(core().hub.list(&client.id))
}

pub fn busy_session(session_id: &str) -> bool {
    SESSIONS.lock().unwrap().values().any(|s| s.entry.session_id().as_deref() == Some(session_id) && s.entry.busy())
}

static PROBES: tokio::sync::Mutex<Option<HashMap<String, (Value, i64)>>> = tokio::sync::Mutex::const_new(None);

pub async fn probe_usage(account: &str, full: bool) -> Value {
    let k = format!("{}:{full}", if account.is_empty() { "system" } else { account });
    let mut cache = PROBES.lock().await;
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some((u, at)) = cache.get(&k) {
        if now_ms() - at < 60000 {
            return u.clone();
        }
    }
    let Ok(env) = accounts().env(account) else { return Value::Null };
    let home = crate::util::home().to_string_lossy().into_owned();
    let launch = Launch { permission_mode: "default".into(), ..Default::default() };
    let Ok(p) = Proc::spawn(&core().claude_bin(), launch.args(), &home, env, |_| {}) else { return Value::Null };
    let _ = p.request(json!({ "subtype": "initialize" }));
    let u = tokio::time::timeout(Duration::from_secs(30), p.request(json!({ "subtype": "get_usage", "skip_behaviors": !full }))).await.ok().and_then(|r| r.ok()).unwrap_or(Value::Null);
    p.close().await;
    if !u.is_null() {
        cache.insert(k, (u.clone(), now_ms()));
    }
    u
}

pub async fn usage(client: &Client, tab: &Value, full: bool, account: &str) -> Value {
    let own = route(client, tab).filter(|s| full && !s.closed.load(Ordering::SeqCst) && (if s.account.is_empty() { "system" } else { &s.account }) == (if account.is_empty() { "system" } else { account }));
    let mine = async {
        let p = own.as_ref().and_then(|s| match &s.engine {
            Engine::Claude { proc, .. } => proc.get().cloned(),
            _ => None,
        })?;
        p.request(json!({ "subtype": "get_usage", "skip_behaviors": false })).await.ok()
    };
    let (mut u, mine) = tokio::join!(probe_usage(account, full), mine);
    if let Some(sess) = mine.as_ref().map(|m| m["session"].clone()).filter(|s| !s.is_null()) {
        if u.is_object() {
            u["session"] = sess;
        }
    }
    u
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_client(tx: mpsc::UnboundedSender<(String, Value)>) -> Client {
        Client::new("wtest", move |ch, d| {
            let _ = tx.send((ch.to_string(), d));
        }, || true)
    }

    async fn wait_for(rx: &mut mpsc::UnboundedReceiver<(String, Value)>, ch: &str) -> Value {
        loop {
            let (c, d) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect(ch).unwrap();
            if c == ch {
                return d;
            }
        }
    }

    #[tokio::test]
    async fn claude_session_streams_permissions_and_meta_through_the_hub() {
        std::env::set_var("CLAUDE_PATH", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fake_claude.sh"));
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out");
        std::env::set_var("FAKE_OUT", &out);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let c = fake_client(tx);
        let tab = json!(1);
        assert!(core().claude_bin().ends_with("fake_claude.sh"));
        let key = start(&c, tab.clone(), json!({ "cwd": dir.path(), "model": "opus" })).await.unwrap();
        assert!(key.is_string());
        let meta = wait_for(&mut rx, "claude:meta").await;
        assert_eq!(meta["commands"][0]["name"], "compact");
        assert_eq!(meta["tab"], 1);
        assert_eq!(control(&c, &tab, "accountInfo", vec![]).await.unwrap()["email"], "a@b");
        assert_eq!(control(&c, &tab, "getContextUsage", vec![]).await.unwrap()["percentage"], 12);
        assert!(control(&c, &tab, "setModel", vec![json!("sonnet")]).await.is_err());
        send(&c, &tab, json!({ "message": { "role": "user", "content": "hi" } }));
        let init = wait_for(&mut rx, "claude:message").await;
        assert_eq!(init["msg"]["session_id"], "S1");
        let perm = wait_for(&mut rx, "claude:permission").await;
        assert_eq!(perm["toolName"], "Bash");
        permit(&c, &tab, perm["id"].as_str().unwrap(), json!({ "behavior": "allow", "updatedInput": { "command": "ls" } }));
        let result = wait_for(&mut rx, "claude:message").await;
        assert_eq!(result["msg"]["type"], "result");
        let written = std::fs::read_to_string(&out).unwrap();
        assert!(written.contains(r#""request_id":"perm1""#) && written.contains(r#""toolUseID":"tu1""#) && written.contains(r#""behavior":"allow""#));
        detach(&c, &tab);
        assert!(get(key.as_str().unwrap()).is_none());
    }
}
