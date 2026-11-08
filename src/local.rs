use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{oneshot, watch};

pub const LOCAL_PORT: u16 = 8931;

#[derive(Debug, PartialEq)]
pub struct ModelSource {
    pub args: Vec<String>,
    pub alias: String,
}

static GGUF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.gguf$").unwrap());
static HF_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^([\w.-]+/[\w.-]+)/([^:]+\.gguf)$").unwrap());
static HF_REPO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w.-]+/[\w.-]+(:[\w.-]+)?$").unwrap());
static MTP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)mtp|UD-IQ3_XXS|UD-IQ3_S|UD-IQ2_S|UD-Q2_K_XL").unwrap());
static DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z]:\\").unwrap());

fn stem(file: &str) -> String {
    let base = Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    GGUF.replace(&base, "").into_owned()
}

pub fn model_source(src: &str) -> Result<ModelSource, String> {
    let s = src.trim();
    if s.is_empty() {
        return Err("Choose a model to host in Settings → Local model".into());
    }
    if s.starts_with(['~', '/', '.']) || DRIVE.is_match(s) {
        let file = match s.strip_prefix('~') {
            Some(rest) => crate::util::home().join(rest.trim_start_matches(['/', '\\'])),
            None => std::path::absolute(s).map_err(|e| e.to_string())?,
        };
        let file = file.to_string_lossy().into_owned();
        return Ok(ModelSource { alias: stem(&file), args: vec!["-m".into(), file] });
    }
    if let Some(c) = HF_FILE.captures(s) {
        return Ok(ModelSource { args: vec!["-hf".into(), c[1].into(), "-hff".into(), c[2].into()], alias: stem(&c[2]) });
    }
    if !HF_REPO.is_match(s) {
        return Err(format!("Not a model file or Hugging Face repo: {s}"));
    }
    let (repo, quant) = s.split_once(':').map(|(r, q)| (r, Some(q))).unwrap_or((s, None));
    let name = repo.split('/').nth(1).unwrap_or_default();
    let name = Regex::new(r"(?i)-GGUF$").unwrap().replace(name, "").into_owned();
    Ok(ModelSource { args: vec!["-hf".into(), s.into()], alias: quant.map(|q| format!("{name}-{q}")).unwrap_or(name) })
}

fn positive(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|n| *n > 0)
}

pub fn server_args(cfg: &Value, port: u16, key: &str) -> Result<Vec<String>, String> {
    let source = cfg["source"].as_str().unwrap_or_default();
    let ModelSource { mut args, alias } = model_source(source)?;
    args.extend(["--alias".into(), alias, "--host".into(), "127.0.0.1".into(), "--port".into(), port.to_string(), "--api-key".into(), key.into()]);
    match positive(&cfg["ctx"]) {
        Some(c) => args.extend(["-c".into(), c.to_string()]),
        None => args.extend(["-fitc".into(), "32768".into()]),
    }
    args.extend(["-np", "1", "--no-mmproj-offload", "-fa", "on", "-ctk", "q4_0", "-ctv", "q4_0", "--jinja", "--cache-reuse", "256"].map(String::from));
    if MTP.is_match(source) {
        args.extend(["--spec-type", "draft-mtp", "-ctkd", "q4_0", "-ctvd", "q4_0"].map(String::from));
    }
    args.extend(cfg["args"].as_str().unwrap_or_default().split_whitespace().map(String::from));
    Ok(args)
}

pub fn alias_of(src: &str) -> Option<String> {
    model_source(src).ok().map(|m| m.alias)
}

pub fn pick_hosted(hosted: &Value, id: &str) -> Option<Value> {
    let list = hosted.as_array()?;
    list.iter().find(|h| alias_of(h["source"].as_str().unwrap_or_default()).as_deref() == Some(id)).or(list.first()).cloned()
}

fn names(v: &Value) -> impl Iterator<Item = String> + '_ {
    v.as_array().into_iter().flatten().filter_map(|x| x.as_str().map(String::from))
}

pub fn local_overrides(off: &Value) -> Value {
    json!({
        "enabledPlugins": names(&off["plugins"]).map(|id| (id, json!(false))).collect::<Map<_, _>>(),
        "skillOverrides": names(&off["skills"]).map(|n| (n, json!("off"))).collect::<Map<_, _>>(),
        "deniedMcpServers": names(&off["mcp"]).map(|n| json!({ "serverName": n })).collect::<Vec<_>>(),
    })
}

pub fn local_env(url: &str, key: &str, model: &str, ctx: i64) -> HashMap<String, String> {
    let mut e: HashMap<String, String> = [
        ("ANTHROPIC_BASE_URL", url.trim_end_matches('/')),
        ("ANTHROPIC_AUTH_TOKEN", if key.is_empty() { "local" } else { key }),
        ("ANTHROPIC_API_KEY", ""),
        ("ANTHROPIC_MODEL", model),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", model),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", model),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", model),
        ("ANTHROPIC_SMALL_FAST_MODEL", model),
        ("CLAUDE_CODE_SUBAGENT_MODEL", model),
        ("_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL", "0"),
        ("CLAUDE_CODE_ATTRIBUTION_HEADER", "0"),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
        ("ENABLE_TOOL_SEARCH", "true"),
        ("API_TIMEOUT_MS", "1800000"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    if ctx > 0 {
        e.insert("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), ctx.to_string());
        e.insert("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), (ctx / 8).clamp(4096, 16384).to_string());
    }
    e
}

pub fn parse_models(data: &Value, place: &str) -> Vec<Value> {
    let list = data["data"].as_array().or(data["models"].as_array());
    list.into_iter()
        .flatten()
        .filter_map(|m| ["id", "name", "model"].iter().find_map(|k| m[k].as_str().filter(|s| !s.is_empty())))
        .map(|id| json!({ "value": format!("local:{id}"), "displayName": id, "description": format!("{id} · {place}"), "supportsEffort": false }))
        .collect()
}

pub fn is_local(m: &str) -> bool {
    m.starts_with("local:")
}

pub fn local_id(m: &str) -> &str {
    m.get(6..).unwrap_or_default()
}

pub fn local_mode(m: &str) -> &str {
    match m {
        "auto" => "acceptEdits",
        "" => "default",
        _ => m,
    }
}

pub fn local_auto_allows(mode: &str, tool: &str) -> bool {
    mode == "auto" && !["AskUserQuestion", "ExitPlanMode"].contains(&tool)
}

fn blocks(c: &Value) -> Vec<Value> {
    match c {
        Value::String(s) => vec![json!({ "type": "text", "text": s })],
        Value::Array(a) => a.clone(),
        _ => vec![],
    }
}

pub fn for_llama(messages: &Value, blind: bool) -> Value {
    let plain = |b: &Value| match b["type"].as_str() {
        Some("tool_reference") => json!({ "type": "text", "text": format!("Tool loaded: {}", b["tool_name"].as_str().unwrap_or_default()) }),
        Some("image") if blind => json!({ "type": "text", "text": "[Image left out: this local model cannot see images]" }),
        _ => b.clone(),
    };
    let fix = |b: &Value| match (&b["type"], &b["content"]) {
        (t, Value::Array(c)) if t == "tool_result" => {
            let mut b = b.clone();
            b["content"] = Value::Array(c.iter().map(plain).collect());
            b
        }
        _ => plain(b),
    };
    let mut out: Vec<Value> = vec![];
    let mut pending: Vec<Value> = vec![];
    for m in messages.as_array().into_iter().flatten() {
        let mut m = m.clone();
        if let Value::Array(c) = &m["content"] {
            m["content"] = Value::Array(c.iter().map(fix).collect());
        }
        if m["role"] == "system" {
            let text = blocks(&m["content"]).iter().map(|b| b["text"].as_str().unwrap_or_default().to_string()).collect::<Vec<_>>().join("\n");
            let block = json!({ "type": "text", "text": format!("<system-reminder>\n{text}\n</system-reminder>") });
            match out.last_mut().filter(|l| l["role"] == "user") {
                Some(last) => {
                    let mut c = blocks(&last["content"]);
                    c.push(block);
                    last["content"] = Value::Array(c);
                }
                None => pending.push(block),
            }
            continue;
        }
        if m["role"] == "user" && !pending.is_empty() {
            let mut c = blocks(&m["content"]);
            c.append(&mut pending);
            m["content"] = Value::Array(c);
        }
        out.push(m);
    }
    if !pending.is_empty() {
        out.push(json!({ "role": "user", "content": pending }));
    }
    Value::Array(out)
}

pub static LOCAL_KEY: LazyLock<String> = LazyLock::new(crate::util::uuid);
static LOG: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static LLAMA: Mutex<Option<Llama>> = Mutex::new(None);
static PROXY: tokio::sync::Mutex<Option<String>> = tokio::sync::Mutex::const_new(None);
static PROXY_TARGET: Mutex<String> = Mutex::new(String::new());
static DEVICES: tokio::sync::OnceCell<Vec<String>> = tokio::sync::OnceCell::const_new();
static SCOPES: tokio::sync::OnceCell<bool> = tokio::sync::OnceCell::const_new();

#[derive(Clone, Default)]
struct Ready {
    done: Option<Result<(), String>>,
    ctx: Option<i64>,
    vision: Option<bool>,
}

struct Llama {
    sig: String,
    alias: String,
    ready: watch::Receiver<Ready>,
    kill: Option<oneshot::Sender<()>>,
    gone: watch::Receiver<bool>,
}

fn llama_url() -> String {
    format!("http://127.0.0.1:{LOCAL_PORT}")
}

fn log_line(l: String) {
    let mut g = LOG.lock().unwrap();
    g.push_back(l);
    if g.len() > 40 {
        g.pop_front();
    }
}

fn changed() {
    crate::core::core().hub.broadcast("local:changed", json!({}), None);
}

fn http() -> &'static reqwest::Client {
    static C: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);
    &C
}

fn free_memory() -> u64 {
    let info = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let kb = info.lines().find(|l| l.starts_with("MemAvailable:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
    kb * 1024
}

async fn can_scope() -> bool {
    *SCOPES
        .get_or_init(|| async {
            match crate::util::find_bin("systemd-run").filter(|_| cfg!(target_os = "linux")) {
                Some(b) => {
                    let a: Vec<String> = ["--user", "--scope", "--quiet", "--collect", "true"].map(String::from).to_vec();
                    crate::util::run(b, &a, crate::util::RunOpts { timeout: Some(Duration::from_secs(10)), ..Default::default() }).await["code"] == 0
                }
                None => false,
            }
        })
        .await
}

pub fn stop_llama() {
    if let Some(mut l) = LLAMA.lock().unwrap().take() {
        if let Some(k) = l.kill.take() {
            let _ = k.send(());
        }
    }
}

async fn ensure_llama(cfg: &Value) -> Result<Ready, String> {
    let bin = crate::core::core().llama.clone().ok_or("llama-server (llama.cpp) is not installed")?;
    let args = server_args(cfg, LOCAL_PORT, &LOCAL_KEY)?;
    let sig = serde_json::to_string(&args).unwrap();
    let mut ready = {
        let mut g = LLAMA.lock().unwrap();
        match g.as_ref().filter(|l| l.sig == sig) {
            Some(l) => l.ready.clone(),
            None => {
                let prev = g.take().map(|mut l| {
                    if let Some(k) = l.kill.take() {
                        let _ = k.send(());
                    }
                    l.gone
                });
                let (ready_tx, ready_rx) = watch::channel(Ready::default());
                let (kill_tx, kill_rx) = oneshot::channel();
                let (gone_tx, gone_rx) = watch::channel(false);
                *g = Some(Llama { sig: sig.clone(), alias: model_source(cfg["source"].as_str().unwrap_or_default())?.alias, ready: ready_rx.clone(), kill: Some(kill_tx), gone: gone_rx });
                tokio::spawn(run_llama(bin, args, sig, prev, ready_tx, kill_rx, gone_tx));
                changed();
                ready_rx
            }
        }
    };
    let r = ready.wait_for(|r| r.done.is_some()).await.map_err(|_| "Local model server was stopped".to_string())?.clone();
    r.done.clone().unwrap().map(|_| r)
}

async fn run_llama(bin: PathBuf, args: Vec<String>, sig: String, prev: Option<watch::Receiver<bool>>, ready: watch::Sender<Ready>, mut kill: oneshot::Receiver<()>, gone: watch::Sender<bool>) {
    let fail = |e: String| ready.send_modify(|r| r.done = Some(Err(e)));
    if let Some(mut p) = prev {
        let _ = p.wait_for(|g| *g).await;
    }
    let scoped = can_scope().await;
    if kill.try_recv().is_ok() || LLAMA.lock().unwrap().as_ref().is_none_or(|l| l.sig != sig) {
        fail("Local model server was stopped".into());
        let _ = gone.send(true);
        return;
    }
    LOG.lock().unwrap().clear();
    let mut cmd = if scoped {
        let mut c = tokio::process::Command::new("systemd-run");
        let max = free_memory().saturating_sub(1 << 30).max(1 << 31);
        c.args(["--user", "--scope", "--quiet", "--collect", "-p", &format!("MemoryMax={max}"), "-p", "MemorySwapMax=0", "--"]).arg(&bin).args(&args);
        c
    } else {
        let mut c = tokio::process::Command::new(&bin);
        c.args(&args);
        c
    };
    let child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            log_line(e.to_string());
            fail(format!("Local model server stopped: {e}"));
            let _ = gone.send(true);
            changed();
            return;
        }
    };
    for s in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as _)].into_iter().flatten() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(s).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                log_line(l);
            }
        });
    }
    let health = async {
        loop {
            let ok = http().get(format!("{}/v1/models", llama_url())).bearer_auth(&*LOCAL_KEY).send().await.is_ok_and(|r| r.status().is_success());
            if ok {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        let props: Value = match http().get(format!("{}/props", llama_url())).bearer_auth(&*LOCAL_KEY).send().await {
            Ok(r) => r.json().await.unwrap_or_default(),
            Err(_) => Value::Null,
        };
        ready.send_modify(|r| {
            r.ctx = props["default_generation_settings"]["n_ctx"].as_i64();
            r.vision = props["modalities"]["vision"].as_bool();
            r.done = Some(Ok(()));
        });
        changed();
        std::future::pending::<()>().await
    };
    let status = tokio::select! {
        s = child.wait() => s.ok(),
        _ = &mut kill => { let _ = child.kill().await; child.wait().await.ok() }
        _ = health => None,
    };
    if ready.borrow().done.is_none() {
        let killed = status.and_then(|s| std::os::unix::process::ExitStatusExt::signal(&s)) == Some(9);
        let tail = LOG.lock().unwrap().iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" ");
        fail(if killed {
            "The local model ran out of memory. Lower the context size in Settings → Local model, or set it to Auto.".into()
        } else if tail.is_empty() {
            format!("Local model server stopped: exit code {}", status.and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or("?".into()))
        } else {
            format!("Local model server stopped: {tail}")
        });
    }
    {
        let mut g = LLAMA.lock().unwrap();
        if g.as_ref().is_some_and(|l| l.sig == sig) {
            *g = None;
        }
    }
    let _ = gone.send(true);
    changed();
}

pub struct Target {
    pub url: String,
    pub key: String,
    pub ctx: i64,
}

async fn target(cfg: &Value, id: &str) -> Result<(Target, bool), String> {
    if cfg["mode"] != "connect" {
        let r = ensure_llama(&pick_hosted(&cfg["hosted"], id).unwrap_or(json!({}))).await?;
        return Ok((Target { url: llama_url(), key: LOCAL_KEY.clone(), ctx: r.ctx.unwrap_or(0) }, r.vision == Some(false)));
    }
    let url = cfg["url"].as_str().unwrap_or_default();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Set the local model server address in Settings → Local model".into());
    }
    Ok((Target { url: url.into(), key: cfg["key"].as_str().unwrap_or_default().into(), ctx: positive(&cfg["ctx"]).unwrap_or(0) }, false))
}

static BLIND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub async fn prepare(cfg: &Value, id: &str) -> Result<Target, String> {
    let (t, blind) = target(cfg, id).await?;
    *PROXY_TARGET.lock().unwrap() = t.url.trim_end_matches('/').to_string();
    BLIND.store(blind, std::sync::atomic::Ordering::SeqCst);
    let mut p = PROXY.lock().await;
    if p.is_none() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let addr = l.local_addr().map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = axum::serve(l, axum::Router::new().fallback(proxy)).await;
        });
        *p = Some(format!("http://{addr}"));
    }
    Ok(Target { url: p.clone().unwrap(), ..t })
}

async fn proxy(req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let err = |m: String| (axum::http::StatusCode::BAD_GATEWAY, [("content-type", "application/json")], json!({ "type": "error", "error": { "type": "api_error", "message": format!("Local model server: {m}") } }).to_string()).into_response();
    let (parts, body) = req.into_parts();
    let Ok(mut bytes) = axum::body::to_bytes(body, 1 << 30).await.map(|b| b.to_vec()) else { return err("request too large".into()) };
    let path = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_default();
    if parts.method == axum::http::Method::POST && path.contains("/v1/messages") {
        if let Ok(mut j) = serde_json::from_slice::<Value>(&bytes) {
            j["messages"] = for_llama(&j["messages"], BLIND.load(std::sync::atomic::Ordering::SeqCst));
            bytes = serde_json::to_vec(&j).unwrap();
        }
    }
    let base = PROXY_TARGET.lock().unwrap().clone();
    let mut up = http().request(parts.method.clone(), format!("{base}{path}"));
    for (k, v) in parts.headers.iter() {
        if !["host", "content-length", "connection", "accept-encoding"].contains(&k.as_str()) {
            up = up.header(k, v);
        }
    }
    if parts.method != axum::http::Method::GET && parts.method != axum::http::Method::HEAD {
        up = up.body(bytes);
    }
    match up.send().await {
        Ok(r) => {
            let mut b = axum::http::Response::builder().status(r.status());
            for (k, v) in r.headers() {
                if !["content-length", "content-encoding", "transfer-encoding", "connection"].contains(&k.as_str()) {
                    b = b.header(k, v);
                }
            }
            b.body(axum::body::Body::from_stream(r.bytes_stream())).unwrap_or_else(|e| err(e.to_string()))
        }
        Err(e) => err(e.to_string()),
    }
}

async fn local_models(cfg: &Value) -> Vec<Value> {
    if cfg["mode"] != "connect" {
        let hosted: Vec<(String, Value, Value)> = cfg["hosted"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|h| alias_of(h["source"].as_str().unwrap_or_default()).map(|id| (id, positive(&h["ctx"]).map(Value::from).unwrap_or(Value::Null), h["source"].clone())))
            .collect();
        let data = json!({ "data": hosted.iter().map(|(id, _, _)| json!({ "id": id })).collect::<Vec<_>>() });
        return parse_models(&data, "Hosted by Codedesk")
            .into_iter()
            .zip(hosted)
            .map(|(mut m, (_, ctx, source))| {
                m["ctx"] = ctx;
                m["source"] = source;
                m
            })
            .collect();
    }
    let url = cfg["url"].as_str().unwrap_or_default();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return vec![];
    }
    let mut r = http().get(format!("{}/v1/models", url.trim_end_matches('/'))).timeout(Duration::from_secs(4));
    if let Some(k) = cfg["key"].as_str().filter(|k| !k.is_empty()) {
        r = r.bearer_auth(k);
    }
    match r.send().await {
        Ok(r) if r.status().is_success() => parse_models(&r.json().await.unwrap_or_default(), "Local"),
        _ => vec![],
    }
}

pub async fn status(cfg: &Value) -> Value {
    let llama = crate::core::core().llama.clone();
    let devices = DEVICES
        .get_or_init(|| async {
            let Some(b) = llama.clone() else { return vec![] };
            let r = crate::util::run(b, &["--list-devices".to_string()], crate::util::RunOpts { timeout: Some(Duration::from_secs(20)), ..Default::default() }).await;
            let re = Regex::new(r"^\w+\d*: ").unwrap();
            format!("{}{}", r["stdout"].as_str().unwrap_or_default(), r["stderr"].as_str().unwrap_or_default()).lines().map(str::trim).filter(|l| re.is_match(l)).map(String::from).collect()
        })
        .await
        .clone();
    let (state, alias, ctx) = match LLAMA.lock().unwrap().as_ref() {
        Some(l) => {
            let r = l.ready.borrow();
            (if matches!(r.done, Some(Ok(()))) { "ready" } else { "loading" }, json!(l.alias), json!(r.ctx))
        }
        None => ("stopped", Value::Null, Value::Null),
    };
    let log: Vec<String> = { LOG.lock().unwrap().iter().rev().take(8).rev().cloned().collect() };
    json!({
        "installed": llama.is_some(), "path": llama, "devices": devices, "state": state, "alias": alias, "ctx": ctx,
        "log": log, "models": local_models(cfg).await,
    })
}

pub async fn start(cfg: &Value, id: &str) -> Result<(), String> {
    ensure_llama(&pick_hosted(&cfg["hosted"], id).unwrap_or(json!({}))).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(args: &[&str], alias: &str) -> ModelSource {
        ModelSource { args: args.iter().map(|s| s.to_string()).collect(), alias: alias.into() }
    }

    #[test]
    fn model_sources_map_to_llama_download_or_file_flags() {
        assert_eq!(
            model_source("ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf").unwrap(),
            src(&["-hf", "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF", "-hff", "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf"], "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp")
        );
        assert_eq!(model_source("unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL").unwrap(), src(&["-hf", "unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL"], "Qwen3.6-35B-A3B-UD-Q4_K_XL"));
        let home = crate::util::home().join("models/a.gguf").to_string_lossy().into_owned();
        assert_eq!(model_source("~/models/a.gguf").unwrap(), src(&["-m", &home], "a"));
        assert!(model_source("").is_err());
        assert!(model_source("--log-file /tmp/x").is_err());
    }

    fn at<'a>(a: &'a [String], flag: &str) -> &'a str {
        &a[a.iter().position(|x| x == flag).unwrap() + 1]
    }

    #[test]
    fn server_args_keep_the_key_bind_to_localhost_and_add_mtp_only_for_mtp_models() {
        let a = server_args(&json!({ "source": "org/r-GGUF/m-mtp.gguf", "ctx": 32768, "args": " --spec-type  ngram-mod " }), LOCAL_PORT, "k").unwrap();
        assert_eq!(at(&a, "--api-key"), "k");
        assert_eq!(at(&a, "--host"), "127.0.0.1");
        assert_eq!(at(&a, "-c"), "32768");
        assert_eq!(at(&a, "-np"), "1");
        assert!(a.contains(&"draft-mtp".to_string()));
        assert_eq!(a[a.len() - 2..], ["--spec-type", "ngram-mod"]);
        let b = server_args(&json!({ "source": "org/r:Q4", "ctx": "x" }), LOCAL_PORT, "k").unwrap();
        assert!(!b.contains(&"-c".to_string()));
        assert_eq!(at(&b, "-fitc"), "32768");
        assert!(!b.contains(&"draft-mtp".to_string()));
        for s in ["unsloth/Q-MTP-GGUF/Q-UD-IQ3_XXS.gguf", "unsloth/Q-M:UD-IQ3_S", "unsloth/Q:UD-IQ2_S", "unsloth/Q:UD-Q2_K_XL"] {
            assert!(server_args(&json!({ "source": s }), LOCAL_PORT, "k").unwrap().contains(&"draft-mtp".to_string()), "{s}");
        }
        assert!(!server_args(&json!({ "source": "orcarouter/Q:Q3_K_M" }), LOCAL_PORT, "k").unwrap().contains(&"draft-mtp".to_string()));
    }

    #[test]
    fn a_local_model_id_picks_its_hosted_entry_falling_back_to_the_first() {
        let hosted = json!([{ "source": "a/b-GGUF/one.gguf", "ctx": 1 }, { "source": "" }, { "source": "c/d-GGUF/two.gguf", "ctx": 2 }]);
        assert_eq!(pick_hosted(&hosted, "two").unwrap()["ctx"], 2);
        assert_eq!(pick_hosted(&hosted, "nope").unwrap()["ctx"], 1);
        assert!(pick_hosted(&Value::Null, "two").is_none());
        assert_eq!(alias_of(""), None);
    }

    #[test]
    fn local_exclusions_become_flag_settings() {
        assert_eq!(
            local_overrides(&json!({ "plugins": ["p@m"], "skills": ["s", "p:k"], "mcp": ["gh"] })),
            json!({ "enabledPlugins": { "p@m": false }, "skillOverrides": { "s": "off", "p:k": "off" }, "deniedMcpServers": [{ "serverName": "gh" }] })
        );
        assert_eq!(local_overrides(&Value::Null), json!({ "enabledPlugins": {}, "skillOverrides": {}, "deniedMcpServers": [] }));
    }

    #[test]
    fn local_env_routes_every_model_slot_to_the_local_model() {
        let e = local_env("http://h:1/", "", "m", 65536);
        assert_eq!(e["ANTHROPIC_BASE_URL"], "http://h:1");
        assert_eq!(e["ANTHROPIC_AUTH_TOKEN"], "local");
        for k in ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"] {
            assert_eq!(e[k], "m");
        }
        assert_eq!(e["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "65536");
        assert_eq!(e["ENABLE_TOOL_SEARCH"], "true");
        assert_eq!(e["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "8192");
        assert_eq!(local_env("http://h", "", "m", 20000)["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "4096");
        assert!(!local_env("http://h", "", "m", 0).contains_key("CLAUDE_CODE_MAX_CONTEXT_TOKENS"));
    }

    #[test]
    fn model_lists_become_local_values() {
        let v = |d: Value| parse_models(&d, "Local").iter().map(|m| m["value"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(v(json!({ "data": [{ "id": "a" }, { "id": "b" }] })), ["local:a", "local:b"]);
        assert_eq!(v(json!({ "models": [{ "name": "qwen" }] })), ["local:qwen"]);
        assert!(v(Value::Null).is_empty());
        assert!(is_local("local:a") && !is_local("opus") && local_id("local:a/b:c") == "a/b:c");
    }

    fn r(s: &str) -> String {
        format!("<system-reminder>\n{s}\n</system-reminder>")
    }

    #[test]
    fn mid_conversation_system_messages_fold_into_user_turns() {
        assert_eq!(
            for_llama(&json!([{ "role": "user", "content": "hi" }, { "role": "system", "content": "hook" }]), false),
            json!([{ "role": "user", "content": [{ "type": "text", "text": "hi" }, { "type": "text", "text": r("hook") }] }])
        );
        let out = for_llama(
            &json!([
                { "role": "user", "content": "a" }, { "role": "assistant", "content": "b" }, { "role": "system", "content": [{ "type": "text", "text": "x" }] },
                { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t", "content": "ok" }] },
            ]),
            false,
        );
        let shape: Vec<(String, String)> = out
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let parts = match &m["content"] {
                    Value::Array(a) => a.iter().map(|b| b["type"].as_str().unwrap_or("str").to_string()).collect::<Vec<_>>().join("+"),
                    _ => "str".into(),
                };
                (m["role"].as_str().unwrap().to_string(), parts)
            })
            .collect();
        assert_eq!(shape, [("user".to_string(), "str".to_string()), ("assistant".into(), "str".into()), ("user".into(), "tool_result+text".into())]);
        let tail = for_llama(&json!([{ "role": "assistant", "content": "b" }, { "role": "system", "content": "x" }]), false);
        assert_eq!(tail.as_array().unwrap().last().unwrap(), &json!({ "role": "user", "content": [{ "type": "text", "text": r("x") }] }));
        assert_eq!(for_llama(&Value::Null, false), json!([]));
    }

    #[test]
    fn tool_search_results_become_text() {
        let out = for_llama(&json!([{ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t", "content": [{ "type": "tool_reference", "tool_name": "mcp__x__y" }] }] }]), false);
        assert_eq!(out[0]["content"][0]["content"], json!([{ "type": "text", "text": "Tool loaded: mcp__x__y" }]));
    }

    #[test]
    fn images_become_a_note_for_a_blind_model() {
        let img = json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "x" } });
        let msgs = json!([{ "role": "user", "content": [{ "type": "text", "text": "hi" }, img, { "type": "tool_result", "tool_use_id": "t", "content": [img] }] }]);
        let blind = for_llama(&msgs, true);
        assert_eq!(blind[0]["content"][0]["text"], "hi");
        assert!(blind[0]["content"][1]["text"].as_str().unwrap().contains("cannot see images"));
        assert!(blind[0]["content"][2]["content"][0]["text"].as_str().unwrap().contains("cannot see images"));
        assert_eq!(for_llama(&msgs, false)[0]["content"], msgs[0]["content"]);
    }

    #[test]
    fn local_auto_mode_rules() {
        assert_eq!(local_mode("auto"), "acceptEdits");
        assert_eq!(local_mode("plan"), "plan");
        assert_eq!(local_mode(""), "default");
        assert!(local_auto_allows("auto", "Bash"));
        assert!(!local_auto_allows("auto", "AskUserQuestion"));
        assert!(!local_auto_allows("auto", "ExitPlanMode"));
        assert!(!local_auto_allows("acceptEdits", "Bash"));
    }
}
