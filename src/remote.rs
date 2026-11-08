use crate::hub::{Client, Hub};
use crate::util::{now_ms, read_json, uuid, write_json};
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, Response, StatusCode};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, Weak};
use tokio::sync::{mpsc, oneshot};

pub const REMOTE_PORT: u16 = 4870;
const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_TTL: i64 = 5 * 60000;
const MAX_TRIES: u32 = 5;
const MAX_ATTEMPTS: usize = 10;
const PAGE_TTL: i64 = 24 * 3600000;
const PUBLIC: [&str; 6] = ["/pair.js", "/style.css", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon.png", "/icons/icon-touch.png"];

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("system random");
    b
}

fn sha(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn normalize(s: &str) -> String {
    s.to_uppercase().chars().filter(|c| *c != '-' && !c.is_whitespace()).map(|c| match c {
        'O' => '0',
        'I' | 'L' => '1',
        c => c,
    }).collect()
}

fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn device_name(ua: &str) -> String {
    let has = |s: &str| ua.contains(s);
    let os = if has("iPhone") { "iPhone" } else if has("iPad") { "iPad" } else if has("Android") { "Android" } else if has("Windows") { "Windows" } else if has("Mac OS X") { "Mac" } else if has("Linux") { "Linux" } else { "Device" };
    let browser = if has("Firefox") || has("FxiOS") { "Firefox" } else if has("Edg") { "Edge" } else if has("Chrome") || has("CriOS") { "Chrome" } else if has("Safari") { "Safari" } else { "Browser" };
    format!("{os} · {browser}")
}

#[derive(Default)]
struct DevState {
    enabled: bool,
    devices: Vec<Value>,
    pairing: Option<(String, i64, u32)>,
    attempts: Vec<i64>,
}

pub struct Devices {
    file: PathBuf,
    now: fn() -> i64,
    st: Mutex<DevState>,
}

fn public(d: &Value) -> Value {
    let mut d = d.clone();
    if let Some(o) = d.as_object_mut() {
        o.remove("tokenHash");
    }
    d
}

impl Devices {
    pub fn load(file: PathBuf, now: fn() -> i64) -> Self {
        let s = read_json(&file);
        let st = DevState { enabled: s["enabled"] == true, devices: s["devices"].as_array().cloned().unwrap_or_default(), ..Default::default() };
        Devices { file, now, st: Mutex::new(st) }
    }

    fn persist(&self, st: &DevState) -> Result<(), String> {
        if let Some(d) = self.file.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        write_json(&self.file, &json!({ "enabled": st.enabled, "devices": st.devices })).map_err(|e| e.to_string())
    }

    pub fn enabled(&self) -> bool {
        self.st.lock().unwrap().enabled
    }

    pub fn set_enabled(&self, on: bool) -> Result<(), String> {
        let mut st = self.st.lock().unwrap();
        st.enabled = on;
        self.persist(&st)
    }

    pub fn start_pairing(&self) -> String {
        let raw: String = random::<8>().iter().map(|b| ALPHABET[(b & 31) as usize] as char).collect();
        self.st.lock().unwrap().pairing = Some((raw.clone(), (self.now)() + CODE_TTL, 0));
        format!("{}-{}", &raw[..4], &raw[4..])
    }

    pub fn pair(&self, input: &str, ua: &str) -> Option<(String, Value)> {
        let now = (self.now)();
        let mut st = self.st.lock().unwrap();
        st.attempts.retain(|t| now - t < 60000);
        if st.attempts.len() >= MAX_ATTEMPTS {
            return None;
        }
        st.attempts.push(now);
        let (code, expires, tries) = st.pairing.clone()?;
        if now > expires {
            st.pairing = None;
            return None;
        }
        let given = normalize(input);
        if !same_bytes(given.as_bytes(), code.as_bytes()) {
            st.pairing = (tries + 1 < MAX_TRIES).then(|| (code, expires, tries + 1));
            return None;
        }
        st.pairing = None;
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random::<32>());
        let device = json!({ "id": uuid(), "name": device_name(ua), "tokenHash": sha(&token), "created": now, "lastSeen": now });
        st.devices.push(device.clone());
        let _ = self.persist(&st);
        Some((token, public(&device)))
    }

    pub fn check(&self, token: &str) -> Option<Value> {
        let h = sha(token);
        let now = (self.now)();
        let mut st = self.st.lock().unwrap();
        let i = st.devices.iter().position(|d| d["tokenHash"] == h.as_str())?;
        if now - st.devices[i]["lastSeen"].as_i64().unwrap_or(0) > 60000 {
            st.devices[i]["lastSeen"] = json!(now);
            let _ = self.persist(&st);
        }
        Some(public(&st.devices[i]))
    }

    pub fn revoke(&self, id: &str) -> Result<bool, String> {
        let mut st = self.st.lock().unwrap();
        let before = st.devices.len();
        st.devices.retain(|d| d["id"] != id);
        if st.devices.len() == before {
            return Ok(false);
        }
        self.persist(&st).map(|_| true)
    }

    pub fn list(&self) -> Vec<Value> {
        self.st.lock().unwrap().devices.iter().map(public).collect()
    }
}

pub struct Outbox {
    items: VecDeque<(u64, String, Value, usize)>,
    bytes: usize,
    seq: u64,
    max: usize,
    max_bytes: usize,
}

impl Outbox {
    pub fn new(max: usize, max_bytes: usize) -> Self {
        Outbox { items: VecDeque::new(), bytes: 0, seq: 0, max, max_bytes }
    }

    pub fn push(&mut self, ch: &str, d: Value) -> u64 {
        let size = d.to_string().len() + ch.len();
        self.seq += 1;
        self.items.push_back((self.seq, ch.into(), d, size));
        self.bytes += size;
        while self.items.len() > 1 && (self.items.len() > self.max || self.bytes > self.max_bytes) {
            if let Some(x) = self.items.pop_front() {
                self.bytes -= x.3;
            }
        }
        self.seq
    }

    pub fn since(&self, last: u64) -> Option<Vec<(u64, String, Value)>> {
        if last > self.seq {
            return None;
        }
        if last < self.seq && self.items.front().is_none_or(|f| last + 1 < f.0) {
            return None;
        }
        Some(self.items.iter().filter(|e| e.0 > last).map(|e| (e.0, e.1.clone(), e.2.clone())).collect())
    }
}

fn event(id: Option<u64>, ch: &str, d: &Value) -> String {
    let id = id.map(|i| format!("id: {i}\n")).unwrap_or_default();
    format!("{id}data: {}\n\n", json!({ "ch": ch, "d": d }))
}

struct PageInner {
    outbox: Outbox,
    res: Option<(u64, mpsc::UnboundedSender<String>)>,
    last_conn: i64,
}

struct Page {
    id: String,
    device: String,
    client: Client,
    inner: Mutex<PageInner>,
}

pub type CallFn = Arc<dyn Fn(String, Client, Vec<Value>) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>;

pub struct Opts {
    pub assets: Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>,
    pub call: CallFn,
    pub allowed: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub boot: Arc<dyn Fn() -> Value + Send + Sync>,
    pub preview: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub on_pair: Arc<dyn Fn(&Value) + Send + Sync>,
    pub outbox: (usize, usize),
    pub body_limit: usize,
}

pub struct Remote {
    pub devices: Devices,
    hub: Arc<Hub>,
    opts: Opts,
    pages: Mutex<HashMap<String, Arc<Page>>>,
    server: Mutex<Option<(oneshot::Sender<()>, u16)>>,
    pub error: Mutex<Option<String>>,
    conns: std::sync::atomic::AtomicU64,
    me: Weak<Remote>,
}

struct ConnGuard {
    page: Arc<Page>,
    conn: u64,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        let mut i = self.page.inner.lock().unwrap();
        if i.res.as_ref().is_some_and(|r| r.0 == self.conn) {
            i.res = None;
            i.last_conn = now_ms();
        }
    }
}

fn reply(status: StatusCode, body: impl Into<Body>, headers: &[(&str, &str)]) -> Response<Body> {
    let mut b = Response::builder().status(status).header("Referrer-Policy", "no-referrer").header("X-Content-Type-Options", "nosniff");
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    b.body(body.into()).unwrap()
}

fn json_reply(status: StatusCode, v: Value) -> Response<Body> {
    reply(status, v.to_string(), &[("Content-Type", "application/json"), ("Cache-Control", "no-store")])
}

fn hval<'a>(h: &'a HeaderMap, k: &str) -> Option<&'a str> {
    h.get(k).and_then(|v| v.to_str().ok())
}

fn same_origin(h: &HeaderMap) -> bool {
    if let Some(site) = hval(h, "sec-fetch-site") {
        return site == "same-origin";
    }
    let Some(origin) = hval(h, "origin") else { return false };
    let host = origin.split("://").nth(1).unwrap_or_default().split('/').next().unwrap_or_default();
    !host.is_empty() && (Some(host) == hval(h, "host") || Some(host) == hval(h, "x-forwarded-host"))
}

fn page_id_ok(p: &str) -> bool {
    (8..=64).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn query(uri: &axum::http::Uri, key: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then(|| percent_encoding::percent_decode_str(&v.replace('+', " ")).decode_utf8_lossy().into_owned())
    })
}

impl Remote {
    pub fn new(devices: Devices, hub: Arc<Hub>, opts: Opts) -> Arc<Remote> {
        Arc::new_cyclic(|me| Remote { devices, hub, opts, pages: Mutex::default(), server: Mutex::default(), error: Mutex::default(), conns: Default::default(), me: me.clone() })
    }

    pub fn port(&self) -> Option<u16> {
        self.server.lock().unwrap().as_ref().map(|s| s.1)
    }

    fn page_for(&self, device: &str, page: &str) -> Arc<Page> {
        let id = format!("p{device}:{page}");
        let mut pages = self.pages.lock().unwrap();
        if let Some(p) = pages.get(&id) {
            return p.clone();
        }
        let (max, bytes) = self.opts.outbox;
        let p = Arc::new_cyclic(|w: &Weak<Page>| {
            let (w1, w2) = (w.clone(), w.clone());
            Page {
                id: id.clone(),
                device: device.into(),
                client: Client::new(
                    &id,
                    move |ch, d| {
                        if let Some(p) = w1.upgrade() {
                            let mut i = p.inner.lock().unwrap();
                            let eid = i.outbox.push(ch, d.clone());
                            if let Some((_, tx)) = &i.res {
                                let _ = tx.send(event(Some(eid), ch, &d));
                            }
                        }
                    },
                    move || w2.upgrade().is_some_and(|p| {
                        let i = p.inner.lock().unwrap();
                        i.res.is_some() || now_ms() - i.last_conn < PAGE_TTL
                    }),
                ),
                inner: Mutex::new(PageInner { outbox: Outbox::new(max, bytes), res: None, last_conn: now_ms() }),
            }
        });
        pages.insert(id, p.clone());
        drop(pages);
        self.hub.connect(p.client.clone());
        p
    }

    fn drop_page(&self, id: &str) {
        if let Some(p) = self.pages.lock().unwrap().remove(id) {
            p.inner.lock().unwrap().res = None;
            self.hub.drop_client(&p.id);
        }
    }

    pub fn revoke(&self, id: &str) -> Result<(), String> {
        let ids: Vec<String> = if id == "all" { self.devices.list().iter().filter_map(|d| d["id"].as_str().map(String::from)).collect() } else { vec![id.into()] };
        for d in ids {
            if self.devices.revoke(&d)? {
                let pages: Vec<String> = self.pages.lock().unwrap().values().filter(|p| p.device == d).map(|p| p.id.clone()).collect();
                pages.iter().for_each(|p| self.drop_page(p));
            }
        }
        Ok(())
    }

    pub async fn listen(&self, port: u16) -> Result<u16, String> {
        if let Some(p) = self.port() {
            return Ok(p);
        }
        let l = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse { format!("Port {port} is already in use") } else { e.to_string() }
        })?;
        let bound = l.local_addr().map_err(|e| e.to_string())?.port();
        let (tx, rx) = oneshot::channel::<()>();
        let me = self.me.upgrade().unwrap();
        let app = axum::Router::new().fallback(route).with_state(me.clone());
        tokio::spawn(async move {
            let _ = axum::serve(l, app).with_graceful_shutdown(async { let _ = rx.await; }).await;
        });
        let sweeper = self.me.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                t.tick().await;
                let Some(r) = sweeper.upgrade() else { break };
                if r.port() != Some(bound) {
                    break;
                }
                let stale: Vec<String> = r.pages.lock().unwrap().values().filter(|p| {
                    let i = p.inner.lock().unwrap();
                    i.res.is_none() && now_ms() - i.last_conn >= PAGE_TTL
                }).map(|p| p.id.clone()).collect();
                stale.iter().for_each(|p| r.drop_page(p));
            }
        });
        *self.server.lock().unwrap() = Some((tx, bound));
        Ok(bound)
    }

    pub fn close(&self) {
        let ids: Vec<String> = self.pages.lock().unwrap().keys().cloned().collect();
        ids.iter().for_each(|p| self.drop_page(p));
        if let Some((tx, _)) = self.server.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }

    fn asset(&self, path: &str, extra: &[(&str, &str)]) -> Response<Body> {
        let p = path.trim_start_matches('/');
        if p.is_empty() || p.split('/').any(|s| s == ".." || s == "." || s.is_empty()) || p.contains('\\') {
            return reply(StatusCode::NOT_FOUND, "", &[]);
        }
        match (self.opts.assets)(p) {
            Some(b) => {
                let mut h = vec![("Content-Type", crate::util::mime(p)), ("Cache-Control", "no-cache")];
                h.extend_from_slice(extra);
                reply(StatusCode::OK, b, &h)
            }
            None => reply(StatusCode::NOT_FOUND, "", &[]),
        }
    }

    fn authed(&self, h: &HeaderMap) -> Option<Value> {
        let cookie = hval(h, "cookie")?;
        let token = cookie.split(';').map(str::trim).find_map(|c| c.strip_prefix("cd_device="))?;
        token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-').then(|| self.devices.check(token)).flatten()
    }

    fn index(&self) -> Response<Body> {
        let Some(html) = (self.opts.assets)("index.html") else { return reply(StatusCode::NOT_FOUND, "", &[]) };
        let html = String::from_utf8_lossy(&html)
            .replacen("</head>", "  <link rel=\"manifest\" href=\"/manifest.webmanifest\">\n  <link rel=\"apple-touch-icon\" href=\"/icons/icon-touch.png\">\n  <meta name=\"apple-mobile-web-app-title\" content=\"Codedesk\">\n</head>", 1)
            .replacen("<script", "<script src=\"/boot.js\"></script>\n  <script src=\"/remote.js\"></script>\n  <script", 1);
        reply(StatusCode::OK, html, &[("Content-Type", "text/html; charset=utf-8"), ("Cache-Control", "no-store"), ("Content-Security-Policy", "frame-ancestors 'none'")])
    }

    fn events(&self, h: &HeaderMap, uri: &axum::http::Uri, device: &str) -> Response<Body> {
        let Some(page_id) = query(uri, "page").filter(|p| page_id_ok(p)) else { return reply(StatusCode::BAD_REQUEST, "", &[]) };
        if let Some(prev) = query(uri, "prev").filter(|p| *p != page_id) {
            self.drop_page(&format!("p{device}:{prev}"));
        }
        let page = self.page_for(device, &page_id);
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let conn = self.conns.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        {
            let mut i = page.inner.lock().unwrap();
            let _ = tx.send("retry: 2000\n\n".into());
            let last = hval(h, "last-event-id").and_then(|v| v.parse().ok()).unwrap_or(0);
            match i.outbox.since(last) {
                None => {
                    let _ = tx.send(event(None, "remote:resync", &json!({})));
                }
                Some(missed) => missed.iter().for_each(|(id, ch, d)| {
                    let _ = tx.send(event(Some(*id), ch, d));
                }),
            }
            i.res = Some((conn, tx.clone()));
            i.last_conn = now_ms();
        }
        let ping = tx.downgrade();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(25)).await;
                match ping.upgrade() {
                    Some(t) if t.send(": ping\n\n".into()).is_ok() => {}
                    _ => break,
                }
            }
        });
        drop(tx);
        let guard = ConnGuard { page, conn };
        let stream = futures_util::stream::unfold((rx, guard), |(mut rx, g)| async move { rx.recv().await.map(|s| (Ok::<_, std::convert::Infallible>(Bytes::from(s)), (rx, g))) });
        reply(
            StatusCode::OK,
            Body::from_stream(stream),
            &[("Content-Type", "text/event-stream; charset=utf-8"), ("Cache-Control", "no-store"), ("Connection", "keep-alive"), ("X-Accel-Buffering", "no")],
        )
    }

    fn preview(&self, uri: &axum::http::Uri) -> Response<Body> {
        let sandbox = [("Content-Security-Policy", "sandbox allow-scripts"), ("Cache-Control", "no-store")];
        if let Some(html) = query(uri, "h").and_then(|h| (self.opts.preview)(&h)) {
            return reply(StatusCode::OK, html, &[("Content-Type", "text/html; charset=utf-8"), sandbox[0], sandbox[1]]);
        }
        match query(uri, "f").filter(|f| std::path::Path::new(f).is_absolute()).and_then(|f| std::fs::read(&f).ok().map(|b| (f, b))) {
            Some((f, b)) => reply(StatusCode::OK, b, &[("Content-Type", crate::util::mime(&f)), sandbox[0], sandbox[1]]),
            None => reply(StatusCode::NOT_FOUND, "", &[]),
        }
    }
}

async fn route(State(r): State<Arc<Remote>>, req: Request) -> Response<Body> {
    let (parts, body) = req.into_parts();
    let raw = parts.uri.path();
    let p = percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned();
    if p.contains('\0') {
        return reply(StatusCode::BAD_REQUEST, "", &[]);
    }
    let read = parts.method == Method::GET || parts.method == Method::HEAD;
    if p == "/pair" {
        if parts.method == Method::POST {
            if !same_origin(&parts.headers) {
                return reply(StatusCode::FORBIDDEN, "", &[]);
            }
            let Ok(b) = axum::body::to_bytes(body, 4096).await else { return reply(StatusCode::FORBIDDEN, "", &[]) };
            let code = serde_json::from_slice::<Value>(&b).ok().and_then(|v| v["code"].as_str().map(String::from));
            let ua = hval(&parts.headers, "user-agent").unwrap_or_default();
            return match code.and_then(|c| r.devices.pair(&c, ua)) {
                Some((token, device)) => {
                    (r.opts.on_pair)(&device);
                    reply(StatusCode::NO_CONTENT, "", &[("Set-Cookie", &format!("cd_device={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000"))])
                }
                None => reply(StatusCode::FORBIDDEN, "", &[]),
            };
        }
        if read {
            return r.asset("pair.html", &[("Content-Security-Policy", "frame-ancestors 'none'")]);
        }
    }
    if read && (PUBLIC.contains(&p.as_str()) || p.starts_with("/vendor/npm/@fontsource-variable/")) {
        return r.asset(&p, &[]);
    }
    let Some(device) = r.authed(&parts.headers) else {
        return if p.starts_with("/api/") || p == "/events" { json_reply(StatusCode::UNAUTHORIZED, json!({ "error": "Not paired" })) } else { reply(StatusCode::FOUND, "", &[("Location", "/pair")]) };
    };
    let device = device["id"].as_str().unwrap_or_default().to_string();
    if parts.method == Method::POST {
        if let Some(ch) = p.strip_prefix("/api/") {
            return api(&r, &parts.headers, body, &device, ch).await;
        }
    }
    if !read {
        return reply(StatusCode::METHOD_NOT_ALLOWED, "", &[]);
    }
    match p.as_str() {
        "/" | "/ui/index.html" => reply(StatusCode::FOUND, "", &[("Location", "/index.html")]),
        "/index.html" => r.index(),
        "/boot.js" => {
            let data = (r.opts.boot)().to_string().replace('<', "\\u003c");
            reply(StatusCode::OK, format!("window.__codedesk={data}"), &[("Content-Type", "text/javascript; charset=utf-8"), ("Cache-Control", "no-store")])
        }
        "/events" => r.events(&parts.headers, &parts.uri, &device),
        "/preview" => r.preview(&parts.uri),
        _ => r.asset(&p, &[]),
    }
}

async fn api(r: &Remote, h: &HeaderMap, body: Body, device: &str, ch: &str) -> Response<Body> {
    if hval(h, "x-codedesk") != Some("1") || !same_origin(h) {
        return json_reply(StatusCode::FORBIDDEN, json!({ "error": "Forbidden" }));
    }
    let Some(page) = hval(h, "x-codedesk-page").filter(|p| page_id_ok(p)).map(String::from) else { return json_reply(StatusCode::BAD_REQUEST, json!({ "error": "Bad page" })) };
    if !(r.opts.allowed)(ch) {
        return json_reply(StatusCode::NOT_FOUND, json!({ "error": "Unknown channel" }));
    }
    let Ok(b) = axum::body::to_bytes(body, r.opts.body_limit).await else { return json_reply(StatusCode::PAYLOAD_TOO_LARGE, json!({ "error": "Request too large" })) };
    let args: Value = if b.is_empty() {
        json!([])
    } else {
        match serde_json::from_slice(&b) {
            Ok(v) => v,
            Err(_) => return json_reply(StatusCode::BAD_REQUEST, json!({ "error": "Bad JSON" })),
        }
    };
    let Value::Array(args) = args else { return json_reply(StatusCode::BAD_REQUEST, json!({ "error": "Bad arguments" })) };
    let page = r.page_for(device, &page);
    match (r.opts.call)(ch.to_string(), page.client.clone(), args).await {
        Ok(v) => json_reply(StatusCode::OK, json!({ "ok": v })),
        Err(e) if e.starts_with("Unknown channel") => json_reply(StatusCode::NOT_FOUND, json!({ "error": "Unknown channel" })),
        Err(e) => json_reply(StatusCode::OK, json!({ "error": e })),
    }
}

pub fn parse_tailscale(status: Option<&str>, serve: Option<&str>, port: u16) -> Value {
    let dns = status.and_then(|s| serde_json::from_str::<Value>(s).ok()).and_then(|v| v["Self"]["DNSName"].as_str().map(|d| d.trim_end_matches('.').to_string())).filter(|d| !d.is_empty());
    let serving = serve.is_some_and(|s| s.contains(&format!("127.0.0.1:{port}")) || s.contains(&format!("localhost:{port}")));
    json!({ "dnsName": dns, "serving": serving })
}

pub static REMOTE: LazyLock<Arc<Remote>> = LazyLock::new(|| {
    let c = crate::core::core();
    let call: CallFn = Arc::new(|ch, client, args| Box::pin(async move { crate::api::dispatch(&ch, &client, args).await }));
    Remote::new(
        Devices::load(c.data.join("remote.json"), now_ms),
        c.hub.clone(),
        Opts {
            assets: Arc::new(|p| crate::core::core().app().asset_resolver().get(p.to_string()).map(|a| a.bytes)),
            call,
            allowed: Arc::new(|ch| !crate::api::REMOTE_BLOCKED.contains(&ch) && !ch.starts_with("remote")),
            boot: Arc::new(|| json!({ "shared": crate::core::core().shared.get(), "info": crate::core::core().info() })),
            preview: Arc::new(|id| crate::core::core().previews.lock().unwrap().get(id).cloned()),
            on_pair: Arc::new(|d| {
                for w in crate::core::core().window_clients() {
                    w.send("remote:paired", json!({ "name": d["name"] }));
                }
            }),
            outbox: (5000, 8 << 20),
            body_limit: 64 << 20,
        },
    )
});

pub async fn status() -> Value {
    let r = &*REMOTE;
    let ts = crate::core::core().tailscale.clone();
    let tailscale = match &ts {
        Some(b) => {
            let opts = || crate::util::RunOpts { timeout: Some(std::time::Duration::from_secs(8)), ..Default::default() };
            let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
            let (sa, va) = (args(&["status", "--json"]), args(&["serve", "status", "--json"]));
            let (s, v) = tokio::join!(crate::util::run(b, &sa, opts()), crate::util::run(b, &va, opts()));
            let out = |r: &Value| (r["code"] == 0).then(|| r["stdout"].as_str().unwrap_or_default().to_string());
            let mut t = parse_tailscale(out(&s).as_deref(), out(&v).as_deref(), port());
            t["installed"] = json!(true);
            t
        }
        None => json!({ "installed": false, "dnsName": null, "serving": false }),
    };
    json!({ "enabled": r.devices.enabled(), "listening": r.port().is_some(), "error": *r.error.lock().unwrap(), "devices": r.devices.list(), "tailscale": tailscale })
}

pub fn port() -> u16 {
    std::env::var("CODEDESK_REMOTE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(REMOTE_PORT)
}

pub async fn start() {
    let r = &*REMOTE;
    let e = r.listen(port()).await.err();
    *r.error.lock().unwrap() = e;
}

pub async fn set(on: bool) -> Result<Value, String> {
    REMOTE.devices.set_enabled(on)?;
    if on {
        start().await;
    } else {
        REMOTE.close();
        *REMOTE.error.lock().unwrap() = None;
    }
    Ok(status().await)
}

pub fn pair() -> Value {
    json!({ "code": REMOTE.devices.start_pairing(), "expires": now_ms() + CODE_TTL })
}

pub async fn tailscale_serve() -> Value {
    let command = format!("tailscale serve --bg {}", port());
    let Some(b) = crate::core::core().tailscale.clone() else { return json!({ "ok": false, "error": "Tailscale is not installed", "command": command }) };
    let r = crate::util::run(b, &["serve".into(), "--bg".into(), port().to_string()], crate::util::RunOpts { timeout: Some(std::time::Duration::from_secs(20)), ..Default::default() }).await;
    if r["code"] == 0 {
        json!({ "ok": true, "command": command })
    } else {
        let err = format!("{}{}", r["stderr"].as_str().unwrap_or_default(), r["stdout"].as_str().unwrap_or_default());
        json!({ "ok": false, "error": err.trim(), "command": command })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    static CLOCK: AtomicI64 = AtomicI64::new(1_000_000_000_000);
    fn clock() -> i64 {
        CLOCK.load(Ordering::SeqCst)
    }

    fn devices(dir: &tempfile::TempDir) -> Devices {
        Devices::load(dir.path().join("remote.json"), now_ms)
    }

    #[test]
    fn pairing_code_works_once_and_tokens_are_hashed() {
        let dir = tempfile::tempdir().unwrap();
        let d = devices(&dir);
        let code = d.start_pairing();
        assert!(code.len() == 9 && code.as_bytes()[4] == b'-');
        let (token, dev) = d.pair(&code, "x").unwrap();
        assert_eq!(token.len(), 43);
        assert!(dev.get("tokenHash").is_none());
        assert!(d.pair(&code, "x").is_none());
        let raw = std::fs::read_to_string(dir.path().join("remote.json")).unwrap();
        assert!(!raw.contains(&token) && raw.contains(&sha(&token)));
        assert_eq!(d.check(&token).unwrap()["id"], dev["id"]);
        assert!(d.check("nope").is_none());
        let again = Devices::load(dir.path().join("remote.json"), now_ms);
        assert_eq!(again.list().len(), 1);
    }

    #[test]
    fn codes_expire_lock_after_five_tries_and_rate_limit() {
        let dir = tempfile::tempdir().unwrap();
        let d = Devices::load(dir.path().join("r.json"), clock);
        let code = d.start_pairing();
        CLOCK.fetch_add(CODE_TTL + 1, Ordering::SeqCst);
        assert!(d.pair(&code, "x").is_none());
        let code = d.start_pairing();
        for _ in 0..5 {
            assert!(d.pair("ZZZZ-ZZZZ", "x").is_none());
        }
        assert!(d.pair(&code, "x").is_none());
        CLOCK.fetch_add(61000, Ordering::SeqCst);
        let code = d.start_pairing();
        for _ in 0..10 {
            d.pair("ZZZZ-ZZZY", "x");
        }
        CLOCK.fetch_add(61000, Ordering::SeqCst);
        let code2 = d.start_pairing();
        for _ in 0..10 {
            let _ = d.pair(&format!("{code}x"), "x");
        }
        assert!(d.pair(&code2, "x").is_none());
    }

    #[test]
    fn crockford_look_alikes_are_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let d = devices(&dir);
        let code = loop {
            let c = d.start_pairing();
            if c.contains(['0', '1']) {
                break c;
            }
        };
        assert!(d.pair(&code.replace('0', "O").replace('1', "l").to_lowercase(), "x").is_some());
    }

    #[test]
    fn device_names() {
        assert_eq!(device_name("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
        assert_eq!(device_name("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"), "Linux · Firefox");
        assert_eq!(device_name(""), "Device · Browser");
    }

    #[test]
    fn outbox_caps_by_count_and_bytes() {
        let mut o = Outbox::new(2, 1 << 20);
        for n in 1..=3 {
            o.push("a", json!(n));
        }
        assert!(o.since(0).is_none());
        assert_eq!(o.since(1).unwrap().iter().map(|e| e.0).collect::<Vec<_>>(), [2, 3]);
        assert!(o.since(3).unwrap().is_empty());
        assert!(o.since(9).is_none());
        let mut o = Outbox::new(100, 50);
        o.push("a", json!("x".repeat(30)));
        o.push("a", json!("y".repeat(30)));
        assert!(o.since(0).is_none());
        assert_eq!(o.since(1).unwrap().len(), 1);
    }

    #[test]
    fn tailscale_status_is_read_from_both_outputs() {
        let status = r#"{"Self":{"DNSName":"box.tail1234.ts.net."}}"#;
        let serve = r#"{"Web":{"box.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4870"}}}}}"#;
        assert_eq!(parse_tailscale(Some(status), Some(serve), 4870), json!({ "dnsName": "box.tail1234.ts.net", "serving": true }));
        assert_eq!(parse_tailscale(Some(status), Some("{}"), 4870)["serving"], false);
        assert_eq!(parse_tailscale(Some("not json"), None, 4870), json!({ "dnsName": null, "serving": false }));
    }

    struct T {
        r: Arc<Remote>,
        hub: Arc<Hub>,
        base: String,
        clients: Arc<Mutex<Vec<Client>>>,
        http: reqwest::Client,
        _dir: tempfile::TempDir,
    }

    async fn boot(fail: bool, outbox: usize, body_limit: usize) -> T {
        let dir = tempfile::tempdir().unwrap();
        let hub = Hub::new(Box::new(now_ms), 900000);
        let clients: Arc<Mutex<Vec<Client>>> = Arc::default();
        let seen = clients.clone();
        let ui = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ui");
        let r = Remote::new(
            Devices::load(dir.path().join("remote.json"), now_ms),
            hub.clone(),
            Opts {
                assets: Arc::new(move |p| std::fs::read(ui.join(p)).ok()),
                call: Arc::new(move |ch, c, args| {
                    seen.lock().unwrap().push(c.clone());
                    Box::pin(async move { if fail { Err("boom".to_string()) } else { Ok(json!([ch, c.id, args])) } })
                }),
                allowed: Arc::new(|ch| ["listDir", "echo"].contains(&ch)),
                boot: Arc::new(|| json!({ "shared": null, "info": { "home": "/h" } })),
                preview: Arc::new(|id| (id == "hid").then(|| "<b>hi</b>".to_string())),
                on_pair: Arc::new(|_| {}),
                outbox: (outbox, 8 << 20),
                body_limit,
            },
        );
        let port = r.listen(0).await.unwrap();
        T { r, hub, base: format!("http://127.0.0.1:{port}"), clients, http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap(), _dir: dir }
    }

    impl T {
        async fn login(&self) -> (reqwest::Response, String, Value) {
            let code = self.r.devices.start_pairing();
            let r = self.http.post(format!("{}/pair", self.base)).header("origin", &self.base).body(json!({ "code": code }).to_string()).send().await.unwrap();
            let cookie = r.headers().get("set-cookie").map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string()).unwrap_or_default();
            (r, cookie, self.r.devices.list().last().cloned().unwrap_or_default())
        }
        async fn get(&self, p: &str, cookie: &str) -> reqwest::Response {
            self.http.get(format!("{}{p}", self.base)).header("cookie", cookie).send().await.unwrap()
        }
        async fn api(&self, cookie: &str, ch: &str, args: Value, extra: &[(&str, &str)]) -> reqwest::Response {
            let mut h = HeaderMap::new();
            for (k, v) in [("cookie", cookie), ("origin", self.base.as_str()), ("x-codedesk", "1"), ("x-codedesk-page", "pg123456")].iter().chain(extra) {
                h.insert(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
            }
            self.http.post(format!("{}/api/{ch}", self.base)).headers(h).body(args.to_string()).send().await.unwrap()
        }
        async fn sse(&self, cookie: &str, page: &str, last: Option<u64>) -> (reqwest::StatusCode, mpsc::UnboundedReceiver<Value>) {
            let mut req = self.http.get(format!("{}/events?page={page}", self.base)).header("cookie", cookie);
            if let Some(l) = last {
                req = req.header("last-event-id", l.to_string());
            }
            let r = req.send().await.unwrap();
            let status = r.status();
            let (tx, rx) = mpsc::unbounded_channel();
            tokio::spawn(async move {
                use futures_util::StreamExt;
                let mut s = r.bytes_stream();
                let mut buf = String::new();
                while let Some(Ok(c)) = s.next().await {
                    buf.push_str(&String::from_utf8_lossy(&c));
                    while let Some(i) = buf.find("\n\n") {
                        let block = buf[..i].to_string();
                        buf.drain(..i + 2);
                        let id = block.lines().find_map(|l| l.strip_prefix("id: ")).map(String::from);
                        if let Some(d) = block.lines().find_map(|l| l.strip_prefix("data: ")) {
                            let mut v: Value = serde_json::from_str(d).unwrap();
                            v["id"] = json!(id);
                            let _ = tx.send(v);
                        }
                    }
                }
                let _ = tx.send(json!("closed"));
            });
            (status, rx)
        }
    }

    async fn next(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv()).await.expect("event").unwrap()
    }

    #[tokio::test]
    async fn without_a_cookie_pages_redirect_and_api_is_401() {
        let t = boot(false, 5000, 1 << 20).await;
        let r = t.get("/", "").await;
        assert_eq!(r.status(), 302);
        assert_eq!(r.headers()["location"], "/pair");
        assert_eq!(t.get("/index.html", "").await.status(), 302);
        assert_eq!(t.api("", "echo", json!([]), &[]).await.status(), 401);
        assert_eq!(t.get("/events?page=pg123456", "").await.status(), 401);
        assert_eq!(t.get("/pair", "").await.status(), 200);
        assert_eq!(t.get("/pair.js", "").await.status(), 200);
        let icon = t.get("/icons/icon-touch.png", "").await;
        assert_eq!(icon.status(), 200);
        assert_eq!(icon.headers()["content-type"], "image/png");
        let m: Value = t.get("/manifest.webmanifest", "").await.json().await.unwrap();
        assert!(m["icons"].as_array().unwrap().iter().any(|i| i["src"] == "/icons/icon-touch.png" && i["purpose"] == "maskable"));
    }

    #[tokio::test]
    async fn pairing_sets_a_strict_cookie_and_rejects_bad_codes() {
        let t = boot(false, 5000, 1 << 20).await;
        let (r, _, _) = t.login().await;
        assert_eq!(r.status(), 204);
        let c = r.headers()["set-cookie"].to_str().unwrap();
        let token = c.strip_prefix("cd_device=").unwrap().split(';').next().unwrap();
        assert_eq!(token.len(), 43);
        assert!(c.ends_with("; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000"));
        t.r.devices.start_pairing();
        let bad = t.http.post(format!("{}/pair", t.base)).header("origin", &t.base).body(r#"{"code":"AAAA-AAAA"}"#).send().await.unwrap();
        assert_eq!(bad.status(), 403);
        let code = t.r.devices.start_pairing();
        let no_origin = t.http.post(format!("{}/pair", t.base)).body(json!({ "code": code }).to_string()).send().await.unwrap();
        assert_eq!(no_origin.status(), 403);
    }

    #[tokio::test]
    async fn api_checks_headers_origin_page_channel_and_size() {
        let t = boot(false, 5000, 1024).await;
        let (_, cookie, dev) = t.login().await;
        assert_eq!(t.api(&cookie, "echo", json!([]), &[("x-codedesk", "")]).await.status(), 403);
        assert_eq!(t.api(&cookie, "echo", json!([]), &[("origin", "https://evil.test")]).await.status(), 403);
        assert_eq!(t.api(&cookie, "echo", json!([]), &[("x-codedesk-page", "../x")]).await.status(), 400);
        assert_eq!(t.api(&cookie, "find", json!([]), &[]).await.status(), 404);
        assert_eq!(t.api(&cookie, "nope", json!([]), &[]).await.status(), 404);
        let ok: Value = t.api(&cookie, "listDir", json!(["/"]), &[]).await.json().await.unwrap();
        assert_eq!(ok, json!({ "ok": ["listDir", format!("p{}:pg123456", dev["id"].as_str().unwrap()), ["/"]] }));
        assert_eq!(t.api(&cookie, "echo", json!(["x".repeat(2000)]), &[]).await.status(), 413);
        assert_eq!(t.api(&cookie, "echo", json!(["ok"]), &[]).await.status(), 200);
        assert_eq!(t.api(&cookie, "echo", json!([]), &[("sec-fetch-site", "cross-site")]).await.status(), 403);
        assert_eq!(t.api(&cookie, "echo", json!([]), &[("sec-fetch-site", "same-site")]).await.status(), 403);
        assert_eq!(t.api(&cookie, "echo", json!([]), &[("origin", "https://pc.example.net"), ("sec-fetch-site", "same-origin")]).await.status(), 200);
        assert_eq!(t.api(&cookie, "echo", json!([]), &[("origin", "https://pc.example.net"), ("x-forwarded-host", "pc.example.net")]).await.status(), 200);
    }

    #[tokio::test]
    async fn handler_errors_come_back_as_error() {
        let t = boot(true, 5000, 1 << 20).await;
        let (_, cookie, _) = t.login().await;
        assert_eq!(t.api(&cookie, "echo", json!([]), &[]).await.json::<Value>().await.unwrap(), json!({ "error": "boom" }));
    }

    #[tokio::test]
    async fn traversal_is_refused_and_index_gets_boot_and_shim() {
        let t = boot(false, 5000, 1 << 20).await;
        let (_, cookie, _) = t.login().await;
        for p in ["/../Cargo.toml", "/%2e%2e/Cargo.toml", "/vendor/..%2f..%2fCargo.toml", "/vendor/npm/marked/../../../Cargo.toml"] {
            assert_eq!(t.get(p, &cookie).await.status(), 404, "{p}");
        }
        assert_eq!(t.get("/vendor/npm/marked/lib/marked.umd.js", &cookie).await.status(), 200);
        assert_eq!(t.get("/ui/index.html", &cookie).await.headers()["location"], "/index.html");
        let r = t.get("/index.html", &cookie).await;
        assert!(r.headers()["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
        assert_eq!(r.headers()["referrer-policy"], "no-referrer");
        let body = r.text().await.unwrap();
        let first = body.find("bridge.js").unwrap();
        assert!(body.find("/boot.js").unwrap() < first && body.find("/remote.js").unwrap() < first);
        let head = &body[..body.find("</head>").unwrap()];
        assert!(head.contains("<link rel=\"manifest\" href=\"/manifest.webmanifest\">") && head.contains("apple-touch-icon"));
        let boot = t.get("/boot.js", &cookie).await.text().await.unwrap();
        assert_eq!(boot, r#"window.__codedesk={"info":{"home":"/h"},"shared":null}"#);
    }

    #[tokio::test]
    async fn events_replay_resync_and_stay_per_device() {
        let t = boot(false, 5000, 1 << 20).await;
        let (_, cookie, _) = t.login().await;
        t.api(&cookie, "echo", json!([]), &[]).await;
        let c = t.clients.lock().unwrap()[0].clone();
        for n in 1..=3 {
            c.send("x", json!({ "n": n }));
        }
        let (status, mut rx) = t.sse(&cookie, "pg123456", Some(1)).await;
        assert_eq!(status, 200);
        let a = next(&mut rx).await;
        let b = next(&mut rx).await;
        assert_eq!((a["id"].clone(), a["ch"].clone(), a["d"]["n"].clone()), (json!("2"), json!("x"), json!(2)));
        assert_eq!(b["id"], "3");
        c.send("x", json!({ "n": 4 }));
        assert_eq!(next(&mut rx).await["id"], "4");
        let (_, two, _) = t.login().await;
        let (_, mut other) = t.sse(&two, "pg123456", None).await;
        c.send("x", json!({ "secret": 1 }));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(150), other.recv()).await.is_err());
        let small = boot(false, 2, 1 << 20).await;
        let (_, ck, _) = small.login().await;
        small.api(&ck, "echo", json!([]), &[]).await;
        let sc = small.clients.lock().unwrap()[0].clone();
        for n in 1..=3 {
            sc.send("x", json!({ "n": n }));
        }
        let (_, mut srx) = small.sse(&ck, "pg123456", Some(0)).await;
        assert_eq!(next(&mut srx).await["ch"], "remote:resync");
    }

    #[tokio::test]
    async fn revoking_closes_streams_and_a_new_page_drops_the_previous_one() {
        let t = boot(false, 5000, 1 << 20).await;
        let (_, cookie, dev) = t.login().await;
        t.api(&cookie, "echo", json!([]), &[("x-codedesk-page", "oldpage123")]).await;
        let old = t.clients.lock().unwrap().last().cloned().unwrap();
        t.hub.add("k", &old, json!("t1"), Box::new(|| {}));
        let (_, _rx) = t.sse(&cookie, "newpage123&prev=oldpage123", None).await;
        assert_eq!(t.hub.list(&old.id)[0]["here"], false);
        let (_, mut rx) = t.sse(&cookie, "pg123456", None).await;
        t.r.revoke(dev["id"].as_str().unwrap()).unwrap();
        while next(&mut rx).await != json!("closed") {}
        assert_eq!(t.get("/index.html", &cookie).await.status(), 302);
    }

    #[tokio::test]
    async fn preview_is_sandboxed_and_server_relistens_and_reports_busy_ports() {
        let t = boot(false, 5000, 1 << 20).await;
        let (_, cookie, _) = t.login().await;
        let r = t.get("/preview?h=hid", &cookie).await;
        assert_eq!(r.headers()["content-security-policy"], "sandbox allow-scripts");
        assert_eq!(r.text().await.unwrap(), "<b>hi</b>");
        let f = concat!(env!("CARGO_MANIFEST_DIR"), "/ui/index.html");
        let enc = percent_encoding::utf8_percent_encode(f, percent_encoding::NON_ALPHANUMERIC).to_string();
        assert_eq!(t.get(&format!("/preview?f={enc}"), &cookie).await.headers()["content-security-policy"], "sandbox allow-scripts");
        assert_eq!(t.get("/preview", &cookie).await.status(), 404);
        assert_eq!(t.get("/preview?f=Cargo.toml", &cookie).await.status(), 404);
        let port = t.r.port().unwrap();
        let other = boot(false, 5000, 1 << 20).await;
        other.r.close();
        assert!(other.r.listen(port).await.unwrap_err().contains("already in use"));
        assert!(other.r.listen(0).await.unwrap() > 0);
        other.r.close();
        assert!(other.r.port().is_none());
    }
}
