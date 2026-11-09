use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

type SendFn = Arc<dyn Fn(&str, Value) + Send + Sync>;
type AliveFn = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone)]
pub struct Client {
    pub id: String,
    send: SendFn,
    alive: AliveFn,
}

impl Client {
    pub fn new(id: &str, send: impl Fn(&str, Value) + Send + Sync + 'static, alive: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Client { id: id.to_string(), send: Arc::new(send), alive: Arc::new(alive) }
    }
    pub fn alive(&self) -> bool {
        (self.alive)()
    }
    pub fn send(&self, ch: &str, d: Value) {
        if self.alive() {
            (self.send)(ch, d)
        }
    }
}

fn tab_key(tab: &Value) -> String {
    match tab {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

fn route_key(client: &str, tab: &Value) -> String {
    format!("{}:{}", client, tab_key(tab))
}

fn with_tab(tab: &Value, d: &Value) -> Value {
    let mut m = Map::new();
    m.insert("tab".into(), tab.clone());
    if let Value::Object(o) = d {
        for (k, v) in o {
            m.insert(k.clone(), v.clone());
        }
    }
    Value::Object(m)
}

#[derive(Default)]
pub struct EntryState {
    pub info: Value,
    pub session_id: Option<String>,
    pub busy: bool,
    pub meta: Option<Value>,
    pub pending: Vec<(String, Value)>,
    subs: Vec<(Client, Value)>,
    last_active: i64,
}

pub struct Entry {
    pub key: String,
    hub: Weak<Hub>,
    stop: Box<dyn Fn() + Send + Sync>,
    pub state: Mutex<EntryState>,
}

impl Entry {
    fn now(&self) -> i64 {
        self.hub.upgrade().map(|h| (h.now)()).unwrap_or(0)
    }
    fn announce(&self) {
        if let Some(h) = self.hub.upgrade() {
            h.announce()
        }
    }
    pub fn session_id(&self) -> Option<String> {
        self.state.lock().unwrap().session_id.clone()
    }
    pub fn set_session_id(&self, id: Option<String>) {
        self.state.lock().unwrap().session_id = id;
        self.announce();
    }
    pub fn busy(&self) -> bool {
        self.state.lock().unwrap().busy
    }
    pub fn info(&self) -> Value {
        self.state.lock().unwrap().info.clone()
    }
    pub fn set_info(&self, f: impl FnOnce(&mut Value)) {
        f(&mut self.state.lock().unwrap().info)
    }
    pub fn watched(&self) -> bool {
        !self.state.lock().unwrap().subs.is_empty()
    }
    pub fn emit(&self, ch: &str, data: Value) {
        let now = self.now();
        let (subs, changed) = {
            let mut s = self.state.lock().unwrap();
            let was = (s.session_id.clone(), s.busy);
            s.last_active = now;
            match ch {
                "claude:meta" => s.meta = Some(data.clone()),
                "claude:permission" => {
                    let id = data["id"].as_str().unwrap_or_default().to_string();
                    s.pending.retain(|(k, _)| *k != id);
                    s.pending.push((id, data.clone()));
                }
                "claude:message" => {
                    let m = &data["msg"];
                    if m["type"] == "system" && m["subtype"] == "init" {
                        s.session_id = m["session_id"].as_str().map(String::from);
                    } else if m["type"] == "result" {
                        s.busy = false;
                    } else if m["type"] == "system" && m["subtype"] == "status" && m["status"] == "requesting" {
                        s.busy = true;
                    }
                }
                _ => {}
            }
            (s.subs.clone(), was != (s.session_id.clone(), s.busy))
        };
        for (c, tab) in subs {
            c.send(ch, with_tab(&tab, &data));
        }
        if changed {
            self.announce()
        }
    }
    pub fn mark_busy(&self) {
        let now = self.now();
        let flipped = {
            let mut s = self.state.lock().unwrap();
            s.last_active = now;
            !std::mem::replace(&mut s.busy, true)
        };
        if flipped {
            self.announce()
        }
    }
    pub fn answered(&self, id: &str, by_client: &str, by_tab: Option<&Value>) -> bool {
        let subs = {
            let mut s = self.state.lock().unwrap();
            let before = s.pending.len();
            s.pending.retain(|(k, _)| k != id);
            if s.pending.len() == before {
                return false;
            }
            s.subs.clone()
        };
        for (c, tab) in subs {
            if c.id != by_client || by_tab.is_some_and(|t| tab_key(t) != tab_key(&tab)) {
                c.send("claude:permission-done", json!({ "tab": tab, "id": id }));
            }
        }
        true
    }
    pub fn stop(&self) {
        (self.stop)()
    }
}

#[derive(Default)]
struct State {
    clients: HashMap<String, Client>,
    entries: HashMap<String, Arc<Entry>>,
    routes: HashMap<String, String>,
}

pub struct Hub {
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    idle_ms: i64,
    state: Mutex<State>,
    me: Weak<Hub>,
}

impl Hub {
    pub fn new(now: Box<dyn Fn() -> i64 + Send + Sync>, idle_ms: i64) -> Arc<Hub> {
        Arc::new_cyclic(|me| Hub { now, idle_ms, state: Mutex::default(), me: me.clone() })
    }

    pub fn connect(&self, client: Client) {
        self.state.lock().unwrap().clients.insert(client.id.clone(), client);
    }

    pub fn broadcast(&self, ch: &str, data: Value, except: Option<&str>) {
        let clients: Vec<Client> = self.state.lock().unwrap().clients.values().cloned().collect();
        for c in clients {
            if Some(c.id.as_str()) != except {
                c.send(ch, data.clone())
            }
        }
    }

    fn announce(&self) {
        self.broadcast("sessions:changed", json!({}), None)
    }

    fn unsubscribe(st: &mut State, entry: &Entry, client: &str, tab: Option<&Value>) {
        let mut s = entry.state.lock().unwrap();
        s.subs.retain(|(c, t)| {
            let hit = c.id == client && tab.is_none_or(|x| tab_key(x) == tab_key(t));
            if hit {
                st.routes.remove(&route_key(client, t));
            }
            !hit
        });
    }

    fn subscribe(st: &mut State, entry: &Arc<Entry>, client: &Client, tab: &Value) {
        let rk = route_key(&client.id, tab);
        if let Some(prev) = st.routes.get(&rk).cloned() {
            if prev != entry.key {
                if let Some(p) = st.entries.get(&prev).cloned() {
                    Self::unsubscribe(st, &p, &client.id, Some(tab));
                }
            }
        }
        Self::unsubscribe(st, entry, &client.id, Some(tab));
        entry.state.lock().unwrap().subs.push((client.clone(), tab.clone()));
        st.routes.insert(rk, entry.key.clone());
    }

    pub fn get(&self, client: &str, tab: &Value) -> Option<Arc<Entry>> {
        let st = self.state.lock().unwrap();
        st.routes.get(&route_key(client, tab)).and_then(|k| st.entries.get(k)).cloned()
    }

    pub fn entry(&self, key: &str) -> Option<Arc<Entry>> {
        self.state.lock().unwrap().entries.get(key).cloned()
    }

    pub fn remove(&self, key: &str) {
        {
            let mut st = self.state.lock().unwrap();
            let Some(entry) = st.entries.remove(key) else { return };
            let subs = std::mem::take(&mut entry.state.lock().unwrap().subs);
            for (c, t) in subs {
                st.routes.remove(&route_key(&c.id, &t));
            }
        }
        self.announce()
    }

    pub fn drop_client(&self, client: &str) {
        {
            let mut st = self.state.lock().unwrap();
            st.clients.remove(client);
            let entries: Vec<_> = st.entries.values().cloned().collect();
            for e in entries {
                Self::unsubscribe(&mut st, &e, client, None);
            }
        }
        self.announce()
    }

    pub fn add(&self, key: &str, client: &Client, tab: Value, stop: Box<dyn Fn() + Send + Sync>) -> Arc<Entry> {
        let entry = Arc::new(Entry {
            key: key.to_string(),
            hub: self.me.clone(),
            stop,
            state: Mutex::new(EntryState { info: json!({}), last_active: (self.now)(), ..Default::default() }),
        });
        {
            let mut st = self.state.lock().unwrap();
            st.clients.insert(client.id.clone(), client.clone());
            st.entries.insert(key.to_string(), entry.clone());
            Self::subscribe(&mut st, &entry, client, &tab);
        }
        self.announce();
        entry
    }

    pub fn attach(&self, client: &Client, tab: Value, key: &str) -> Option<Value> {
        let entry = {
            let mut st = self.state.lock().unwrap();
            let entry = st.entries.get(key).cloned()?;
            st.clients.insert(client.id.clone(), client.clone());
            Self::subscribe(&mut st, &entry, client, &tab);
            entry
        };
        let (meta, pending, info, sid, busy) = {
            let s = entry.state.lock().unwrap();
            (s.meta.clone(), s.pending.clone(), s.info.clone(), s.session_id.clone(), s.busy)
        };
        if let Some(m) = meta {
            client.send("claude:meta", with_tab(&tab, &m));
        }
        for (_, p) in pending {
            client.send("claude:permission", with_tab(&tab, &p));
        }
        self.announce();
        Some(json!({
            "sessionId": sid, "cwd": info["cwd"], "model": info["model"], "permissionMode": info["permissionMode"],
            "account": info["account"], "busy": busy,
        }))
    }

    pub fn detach(&self, client: &str, tab: &Value) -> usize {
        let left = {
            let mut st = self.state.lock().unwrap();
            let Some(entry) = st.routes.get(&route_key(client, tab)).and_then(|k| st.entries.get(k)).cloned() else { return 0 };
            Self::unsubscribe(&mut st, &entry, client, Some(tab));
            let n = entry.state.lock().unwrap().subs.len();
            n
        };
        self.announce();
        left
    }

    pub fn list(&self, client: &str) -> Vec<Value> {
        let entries: Vec<_> = self.state.lock().unwrap().entries.values().cloned().collect();
        entries
            .iter()
            .map(|e| {
                let s = e.state.lock().unwrap();
                json!({
                    "key": e.key, "sessionId": s.session_id, "cwd": s.info["cwd"], "model": s.info["model"], "account": s.info["account"],
                    "busy": s.busy, "waiting": !s.pending.is_empty(), "here": s.subs.iter().any(|(c, _)| c.id == client),
                })
            })
            .collect()
    }

    pub fn sweep(&self) -> Vec<String> {
        let now = (self.now)();
        let entries: Vec<_> = self.state.lock().unwrap().entries.values().cloned().collect();
        let stale: Vec<_> = entries
            .into_iter()
            .filter(|e| {
                let s = e.state.lock().unwrap();
                s.subs.is_empty() && !s.busy && now - s.last_active >= self.idle_ms
            })
            .collect();
        for e in &stale {
            e.stop();
            self.remove(&e.key);
        }
        stale.iter().map(|e| e.key.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    type Log = Arc<Mutex<Vec<(String, Value)>>>;

    fn fake(id: &str) -> (Client, Log) {
        let log: Log = Arc::default();
        let l = log.clone();
        (Client::new(id, move |ch, d| l.lock().unwrap().push((ch.to_string(), d)), || true), log)
    }
    fn last(log: &Log, ch: &str) -> Option<Value> {
        log.lock().unwrap().iter().rev().find(|(c, _)| c == ch).map(|(_, d)| d.clone())
    }
    fn count(log: &Log, ch: &str) -> usize {
        log.lock().unwrap().iter().filter(|(c, _)| c == ch).count()
    }
    struct Rig {
        hub: Arc<Hub>,
        clock: Arc<AtomicI64>,
        a: (Client, Log),
        b: (Client, Log),
        c: (Client, Log),
        stopped: Arc<AtomicUsize>,
    }
    impl Rig {
        fn stop(&self) -> Box<dyn Fn() + Send + Sync> {
            let s = self.stopped.clone();
            Box::new(move || {
                s.fetch_add(1, Ordering::SeqCst);
            })
        }
    }
    fn rig() -> Rig {
        let clock = Arc::new(AtomicI64::new(0));
        let c2 = clock.clone();
        let hub = Hub::new(Box::new(move || c2.load(Ordering::SeqCst)), 900000);
        let (a, b, c) = (fake("a"), fake("b"), fake("c"));
        for x in [&a.0, &b.0, &c.0] {
            hub.connect(x.clone());
        }
        Rig { hub, clock, a, b, c, stopped: Arc::default() }
    }

    #[test]
    fn emit_fans_out_with_each_subscriber_tab() {
        let r = rig();
        let e = r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        r.hub.attach(&r.b.0, json!("t9"), "k");
        e.emit("claude:message", json!({ "msg": { "type": "x" } }));
        assert_eq!(last(&r.a.1, "claude:message").unwrap()["tab"], "t1");
        assert_eq!(last(&r.b.1, "claude:message").unwrap()["tab"], "t9");
    }

    #[test]
    fn routes_resolve_per_client_and_tab() {
        let r = rig();
        r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        r.hub.attach(&r.b.0, json!("t9"), "k");
        assert_eq!(r.hub.get("a", &json!("t1")).unwrap().key, "k");
        assert_eq!(r.hub.get("b", &json!("t9")).unwrap().key, "k");
        assert!(r.hub.get("b", &json!("t1")).is_none());
    }

    #[test]
    fn attach_replays_meta_and_open_permissions_to_the_new_subscriber_only() {
        let r = rig();
        let e = r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        e.emit("claude:meta", json!({ "commands": [1] }));
        e.emit("claude:permission", json!({ "id": "p1" }));
        r.hub.attach(&r.c.0, json!("t2"), "k");
        assert_eq!(last(&r.c.1, "claude:permission").unwrap()["id"], "p1");
        assert_eq!(last(&r.c.1, "claude:meta").unwrap()["tab"], "t2");
        assert_eq!(count(&r.a.1, "claude:permission"), 1);
    }

    #[test]
    fn first_permission_answer_wins_others_are_told() {
        let r = rig();
        let e = r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        r.hub.attach(&r.b.0, json!("t9"), "k");
        e.emit("claude:permission", json!({ "id": "p1" }));
        assert!(e.answered("p1", "b", None));
        assert!(!e.answered("p1", "a", None));
        assert_eq!(last(&r.a.1, "claude:permission-done").unwrap()["id"], "p1");
        assert!(last(&r.b.1, "claude:permission-done").is_none());
    }

    #[test]
    fn another_tab_of_the_answering_client_is_told_too() {
        let r = rig();
        let e = r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        r.hub.attach(&r.a.0, json!("t2"), "k");
        e.emit("claude:permission", json!({ "id": "p1" }));
        assert!(e.answered("p1", "a", Some(&json!("t2"))));
        assert_eq!(last(&r.a.1, "claude:permission-done").unwrap()["tab"], "t1");
        assert_eq!(count(&r.a.1, "claude:permission-done"), 1);
    }

    #[test]
    fn busy_init_and_result_each_announce_a_change() {
        let r = rig();
        let e = r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        let n = || count(&r.a.1, "sessions:changed");
        let before = n();
        e.mark_busy();
        assert_eq!(n(), before + 1);
        let before = n();
        e.emit("claude:message", json!({ "msg": { "type": "system", "subtype": "init", "session_id": "s1" } }));
        assert_eq!(e.session_id().as_deref(), Some("s1"));
        assert_eq!(n(), before + 1);
        let before = n();
        e.emit("claude:message", json!({ "msg": { "type": "result" } }));
        assert!(!e.busy());
        assert_eq!(n(), before + 1);
    }

    #[test]
    fn dropping_a_client_keeps_its_session_as_an_orphan() {
        let r = rig();
        r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        r.hub.drop_client("a");
        let rows = r.hub.list("z");
        assert_eq!(rows[0]["key"], "k");
        assert_eq!(rows[0]["here"], false);
    }

    #[test]
    fn list_marks_watching_and_waiting() {
        let r = rig();
        let e = r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        assert_eq!(r.hub.list("a")[0]["here"], true);
        assert_eq!(r.hub.list("a")[0]["waiting"], false);
        e.emit("claude:permission", json!({ "id": "p1" }));
        assert_eq!(r.hub.list("z")[0]["waiting"], true);
        e.answered("p1", "a", None);
        assert_eq!(r.hub.list("z")[0]["waiting"], false);
    }

    #[test]
    fn sweep_stops_idle_orphans_only() {
        let r = rig();
        r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        r.hub.drop_client("a");
        r.clock.fetch_add(900000 - 1, Ordering::SeqCst);
        assert!(r.hub.sweep().is_empty());
        r.clock.fetch_add(1, Ordering::SeqCst);
        assert_eq!(r.hub.sweep(), vec!["k".to_string()]);
        assert_eq!(r.stopped.load(Ordering::SeqCst), 1);
        assert!(r.hub.list("z").is_empty());
    }

    #[test]
    fn sweep_never_stops_a_busy_orphan() {
        let r = rig();
        r.hub.add("k2", &r.a.0, json!("t1"), r.stop()).mark_busy();
        r.hub.drop_client("a");
        r.clock.fetch_add(10 * 900000, Ordering::SeqCst);
        assert!(r.hub.sweep().is_empty());
    }

    #[test]
    fn sweep_never_stops_a_watched_session() {
        let r = rig();
        r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        r.clock.fetch_add(10 * 900000, Ordering::SeqCst);
        assert!(r.hub.sweep().is_empty());
    }

    #[test]
    fn detach_reports_who_is_left_remove_clears_routes() {
        let r = rig();
        r.hub.add("k", &r.a.0, json!("t1"), r.stop());
        r.hub.attach(&r.b.0, json!("t9"), "k");
        assert_eq!(r.hub.detach("b", &json!("t9")), 1);
        assert!(r.hub.get("b", &json!("t9")).is_none());
        r.hub.remove("k");
        assert!(r.hub.get("a", &json!("t1")).is_none());
    }

    #[test]
    fn attach_to_an_unknown_session_is_none() {
        let r = rig();
        assert!(r.hub.attach(&r.a.0, json!("t1"), "nope").is_none());
    }
}
