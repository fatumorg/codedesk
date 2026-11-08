use crate::hub::Client;
use crate::util::{now_ms, read_json, uuid, write_json};
use chrono::{DateTime, Datelike, Duration as CDur, Local, NaiveTime, TimeZone};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

const GRACE_ONCE: i64 = 12 * 3_600_000;
const GRACE_DAILY: i64 = 10 * 60_000;
const IDLE_WAIT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, PartialEq)]
pub enum Due {
    Wait,
    Fire,
    Missed,
    Skip,
}

pub fn next_daily<Tz: TimeZone>(now: &DateTime<Tz>, time: &str, days: &[u32]) -> Option<DateTime<Tz>> {
    let t = NaiveTime::parse_from_str(time, "%H:%M").ok()?;
    (0..8).find_map(|d| {
        let date = now.date_naive() + CDur::days(d);
        let when = now.timezone().from_local_datetime(&date.and_time(t)).earliest()?;
        (when > *now && (days.is_empty() || days.contains(&date.weekday().num_days_from_sunday()))).then_some(when)
    })
}

pub fn reset_time(usage: &Value) -> Option<i64> {
    usage["rate_limits"]
        .as_object()?
        .values()
        .filter(|w| w["utilization"].as_f64().is_some_and(|u| u >= 100.0))
        .filter_map(|w| w["resets_at"].as_str().and_then(|r| DateTime::parse_from_rfc3339(r).ok()).map(|d| d.timestamp_millis()))
        .max()
}

pub fn next_run<Tz: TimeZone>(s: &Value, now: &DateTime<Tz>, usage: &Value) -> Option<i64> {
    if s["enabled"] != true {
        return None;
    }
    let w = &s["when"];
    match w["kind"].as_str()? {
        "once" => w["at"].as_i64(),
        "daily" => {
            let days: Vec<u32> = w["days"].as_array().into_iter().flatten().filter_map(|d| d.as_u64().map(|d| d as u32)).collect();
            next_daily(now, w["time"].as_str()?, &days).map(|d| d.timestamp_millis())
        }
        "reset" => reset_time(usage).map(|r| r + 60_000),
        _ => None,
    }
}

pub fn due(s: &Value, now: i64) -> Due {
    let Some(next) = s["nextRun"].as_i64().filter(|_| s["enabled"] == true) else { return Due::Wait };
    if next > now {
        return Due::Wait;
    }
    match s["when"]["kind"].as_str() {
        Some("once") if now - next > GRACE_ONCE => Due::Missed,
        Some("daily") if now - next > GRACE_DAILY => Due::Skip,
        _ => Due::Fire,
    }
}

pub fn poll_every(next: Option<i64>, now: i64) -> i64 {
    match next {
        Some(n) if n - now <= 10 * 60_000 => 30_000,
        _ => 300_000,
    }
}

pub async fn wait_idle(busy: impl Fn() -> bool, max: Duration, step: Duration) -> bool {
    let end = tokio::time::Instant::now() + max;
    while busy() {
        if tokio::time::Instant::now() >= end {
            return false;
        }
        tokio::time::sleep(step).await;
    }
    true
}

static LIST: Mutex<Vec<Value>> = Mutex::new(Vec::new());
static LOADED: std::sync::Once = std::sync::Once::new();
static POLLED: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);
static RUNNING: LazyLock<Mutex<std::collections::HashSet<String>>> = LazyLock::new(Default::default);
static WAITERS: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<(String, Value)>>>> = LazyLock::new(Default::default);

fn file() -> std::path::PathBuf {
    crate::core::core().data.join("schedules.json")
}

fn with_list<T>(f: impl FnOnce(&mut Vec<Value>) -> T) -> T {
    LOADED.call_once(|| *LIST.lock().unwrap() = read_json(&file()).as_array().cloned().unwrap_or_default());
    let mut l = LIST.lock().unwrap();
    let r = f(&mut l);
    let _ = write_json(&file(), &Value::Array(l.clone()));
    r
}

fn changed() {
    crate::core::core().hub.broadcast("schedules:changed", json!({}), None);
}

fn client() -> Client {
    static C: LazyLock<Client> = LazyLock::new(|| {
        let c = Client::new(
            "s",
            |ch, d| {
                let tab = d["tab"].as_str().unwrap_or_default().to_string();
                if let Some(tx) = WAITERS.lock().unwrap().get(&tab) {
                    let _ = tx.send((ch.to_string(), d));
                }
            },
            || true,
        );
        crate::core::core().hub.connect(c.clone());
        c
    });
    C.clone()
}

pub fn pending() -> bool {
    with_list(|l| l.iter().any(|x| x["enabled"] == true))
}

pub fn list() -> Value {
    Value::Array(with_list(|l| l.clone()))
}

pub fn save(mut s: Value) -> Result<Value, String> {
    if s["prompt"].as_str().is_none_or(|p| p.trim().is_empty()) {
        return Err("Write the prompt to send".into());
    }
    if s["target"]["cwd"].as_str().is_none_or(|c| c.is_empty()) {
        return Err("Choose a project folder".into());
    }
    if s["id"].as_str().is_none_or(|i| i.is_empty()) {
        s["id"] = json!(uuid());
        s["created"] = json!(now_ms());
    }
    if s["enabled"].is_null() {
        s["enabled"] = json!(true);
    }
    s["nextRun"] = json!(next_run(&s, &Local::now(), &Value::Null));
    let id = s["id"].clone();
    POLLED.lock().unwrap().remove(id.as_str().unwrap_or_default());
    with_list(|l| match l.iter_mut().find(|x| x["id"] == id) {
        Some(x) => *x = s.clone(),
        None => l.push(s.clone()),
    });
    changed();
    Ok(s)
}

pub fn delete(id: &str) {
    with_list(|l| l.retain(|x| x["id"] != id));
    changed();
}

fn update(id: &str, f: impl FnOnce(&mut Value)) {
    with_list(|l| {
        if let Some(x) = l.iter_mut().find(|x| x["id"] == id) {
            f(x)
        }
    });
    changed();
}

pub fn start() {
    tauri::async_runtime::spawn(async {
        let mut t = tokio::time::interval(Duration::from_secs(20));
        loop {
            t.tick().await;
            tick().await;
        }
    });
}

async fn tick() {
    let now = now_ms();
    for s in with_list(|l| l.clone()) {
        let id = s["id"].as_str().unwrap_or_default().to_string();
        if s["enabled"] != true || RUNNING.lock().unwrap().contains(&id) {
            continue;
        }
        if s["when"]["kind"] == "reset" {
            let last = POLLED.lock().unwrap().get(&id).copied().unwrap_or(0);
            let next = s["nextRun"].as_i64();
            if now - last >= poll_every(next, now) || next.is_some_and(|n| n <= now) {
                POLLED.lock().unwrap().insert(id.clone(), now);
                let account = s["when"]["account"].as_str().or(s["opts"]["account"].as_str()).unwrap_or("system").to_string();
                let usage = crate::session::probe_usage(&account, false).await;
                if usage.is_null() {
                    continue;
                }
                let fresh = next_run(&s, &Local::now(), &usage);
                match (next, fresh) {
                    (Some(n), None) if n <= now => {}
                    (Some(n), Some(f)) if n <= now && f <= now => {}
                    _ => {
                        if fresh != next {
                            update(&id, |x| x["nextRun"] = json!(fresh));
                        }
                        continue;
                    }
                }
                fire(id, false);
                continue;
            }
            continue;
        }
        match due(&s, now) {
            Due::Fire => fire(id, false),
            Due::Missed => update(&id, |x| {
                x["enabled"] = json!(false);
                x["nextRun"] = Value::Null;
                x["lastRun"] = json!({ "at": now, "ok": false, "error": "Missed: Codedesk was not running at the scheduled time" });
            }),
            Due::Skip => update(&id, |x| x["nextRun"] = json!(next_run(x, &Local::now(), &Value::Null))),
            Due::Wait => {}
        }
    }
}

pub fn run_now(id: &str) -> Result<(), String> {
    if !with_list(|l| l.iter().any(|x| x["id"] == id)) {
        return Err("Schedule not found".into());
    }
    fire(id.to_string(), true);
    Ok(())
}

fn finish(id: &str, manual: bool, result: Value) {
    let name = with_list(|l| l.iter().find(|x| x["id"] == id).map(|x| x["name"].clone())).unwrap_or_default();
    update(id, |x| {
        x["lastRun"] = result.clone();
        if manual {
            return;
        }
        let kind = x["when"]["kind"].as_str().unwrap_or_default().to_string();
        if kind == "once" || (kind == "reset" && x["when"]["then"] != true) {
            x["enabled"] = json!(false);
            x["nextRun"] = Value::Null;
        } else if kind == "reset" {
            x["nextRun"] = Value::Null;
        } else {
            x["nextRun"] = json!(next_run(x, &Local::now(), &Value::Null));
        }
    });
    for w in crate::core::core().window_clients() {
        w.send("schedules:ran", json!({ "id": id, "name": name, "ok": result["ok"], "error": result["error"], "sessionId": result["sessionId"] }));
    }
}

fn fire(id: String, manual: bool) {
    if !RUNNING.lock().unwrap().insert(id.clone()) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let s = with_list(|l| l.iter().find(|x| x["id"] == id.as_str()).cloned());
        let r = match s {
            Some(s) => run(&s).await,
            None => Err("Schedule not found".into()),
        };
        let at = now_ms();
        finish(&id, manual, match r {
            Ok(sid) => json!({ "at": at, "ok": true, "sessionId": sid }),
            Err(e) => json!({ "at": at, "ok": false, "error": e }),
        });
        RUNNING.lock().unwrap().remove(&id);
    });
}

async fn run(s: &Value) -> Result<Option<String>, String> {
    let prompt = s["prompt"].as_str().unwrap_or_default().to_string();
    let target = &s["target"];
    let resume = (target["kind"] == "resume").then(|| target["sessionId"].as_str().map(String::from)).flatten().filter(|x| !x.is_empty());
    let msg = json!({ "message": { "role": "user", "content": prompt } });
    if let Some(sid) = &resume {
        if crate::session::live_key(sid).is_some() {
            if !wait_idle(|| crate::session::busy_session(sid), IDLE_WAIT, Duration::from_secs(5)).await {
                return Err("The conversation stayed busy for 30 minutes".into());
            }
            let key = crate::session::live_key(sid).ok_or("The conversation closed")?;
            crate::session::send_key(&key, msg);
            return Ok(Some(sid.clone()));
        }
    }
    let c = client();
    let tab = format!("sched-{}-{}", s["id"].as_str().unwrap_or_default(), now_ms());
    let (tx, mut rx) = mpsc::unbounded_channel();
    WAITERS.lock().unwrap().insert(tab.clone(), tx);
    let o = &s["opts"];
    let opts = json!({
        "cwd": target["cwd"], "model": o["model"], "effort": o["effort"], "permissionMode": o["permissionMode"],
        "account": o["account"], "resume": resume, "computerUse": crate::core::core().shared.get()["computerUse"] == true,
    });
    let tabv = json!(tab);
    let outcome = async {
        let key = crate::session::start(&c, tabv.clone(), opts).await?;
        if key.is_null() {
            return Err(next_error(&mut rx).await.unwrap_or_else(|| "Could not start the conversation".into()));
        }
        crate::session::send(&c, &tabv, msg);
        loop {
            match tokio::time::timeout(Duration::from_secs(120), rx.recv()).await {
                Ok(Some((ch, d))) => match ch.as_str() {
                    "claude:message" if d["msg"]["type"] == "system" && d["msg"]["subtype"] == "init" => return Ok(d["msg"]["session_id"].as_str().map(String::from)),
                    "claude:error" => return Err(d["error"].as_str().unwrap_or("Failed").to_string()),
                    "claude:ended" => return Err("The conversation ended before it started".into()),
                    _ => {}
                },
                Ok(None) => return Err("Scheduler stopped".into()),
                Err(_) => return Err("Claude did not answer within 2 minutes".into()),
            }
        }
    }
    .await;
    let watch = tab.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Some((ch, d)) if (ch == "claude:message" && d["msg"]["type"] == "result") || ch == "claude:ended" => break,
                Some(_) => {}
                None => break,
            }
        }
        WAITERS.lock().unwrap().remove(&watch);
        crate::core::core().hub.detach("s", &json!(watch));
    });
    outcome
}

async fn next_error(rx: &mut mpsc::UnboundedReceiver<(String, Value)>) -> Option<String> {
    while let Ok(Some((ch, d))) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
        if ch == "claude:error" {
            return d["error"].as_str().map(String::from);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, TimeZone};
    use serde_json::json;

    fn at(d: u32, h: u32, m: u32) -> chrono::DateTime<FixedOffset> {
        FixedOffset::east_opt(3600).unwrap().with_ymd_and_hms(2026, 11, d, h, m, 0).unwrap()
    }

    #[test]
    fn daily_next_slot() {
        assert_eq!(next_daily(&at(13, 10, 0), "09:00", &[1, 2, 3, 4, 5]), Some(at(16, 9, 0)));
        assert_eq!(next_daily(&at(13, 8, 0), "09:00", &[1, 2, 3, 4, 5]), Some(at(13, 9, 0)));
        assert_eq!(next_daily(&at(13, 9, 0), "09:00", &[5]), Some(at(20, 9, 0)));
        assert_eq!(next_daily(&at(13, 9, 0), "23:30", &[]), Some(at(13, 23, 30)));
        assert_eq!(next_daily(&at(13, 9, 0), "25:00", &[1]), None);
    }

    #[test]
    fn once_future() {
        let s = json!({ "enabled": true, "when": { "kind": "once", "at": 5_000_000 } });
        assert_eq!(next_run(&s, &at(13, 10, 0), &Value::Null), Some(5_000_000));
        assert_eq!(next_run(&json!({ "enabled": false, "when": { "kind": "once", "at": 5 } }), &at(13, 10, 0), &Value::Null), None);
    }

    #[test]
    fn missed_once_rules() {
        let h = 3_600_000;
        let s = |at: i64| json!({ "enabled": true, "nextRun": at, "when": { "kind": "once", "at": at } });
        assert_eq!(due(&s(100 * h), 100 * h + 11 * h), Due::Fire);
        assert_eq!(due(&s(100 * h), 100 * h + 13 * h), Due::Missed);
        assert_eq!(due(&s(100 * h), 99 * h), Due::Wait);
        let daily = json!({ "enabled": true, "nextRun": 100 * h, "when": { "kind": "daily", "time": "09:00", "days": [] } });
        assert_eq!(due(&daily, 100 * h + 60_000), Due::Fire);
        assert_eq!(due(&daily, 100 * h + h), Due::Skip);
    }

    #[test]
    fn reset_fires_after_resets_at_plus_60s() {
        let limited = json!({ "rate_limits": { "five_hour": { "utilization": 100, "resets_at": "2026-11-13T12:00:00Z" }, "seven_day": { "utilization": 40, "resets_at": "2026-11-15T00:00:00Z" } } });
        let s = json!({ "enabled": true, "when": { "kind": "reset", "account": "system" } });
        let reset = chrono::DateTime::parse_from_rfc3339("2026-11-13T12:00:00Z").unwrap().timestamp_millis();
        assert_eq!(reset_time(&limited), Some(reset));
        assert_eq!(next_run(&s, &at(13, 10, 0), &limited), Some(reset + 60_000));
        let free = json!({ "rate_limits": { "five_hour": { "utilization": 20, "resets_at": "2026-11-13T12:00:00Z" } } });
        assert_eq!(next_run(&s, &at(13, 10, 0), &free), None);
        let both = json!({ "rate_limits": { "five_hour": { "utilization": 100, "resets_at": "2026-11-13T12:00:00Z" }, "seven_day": { "utilization": 100, "resets_at": "2026-11-15T00:00:00Z" } } });
        assert_eq!(reset_time(&both), Some(chrono::DateTime::parse_from_rfc3339("2026-11-15T00:00:00Z").unwrap().timestamp_millis()));
    }

    #[test]
    fn poll_cadence_speeds_up_near_the_reset() {
        assert_eq!(poll_every(None, 0), 300_000);
        assert_eq!(poll_every(Some(3_600_000), 0), 300_000);
        assert_eq!(poll_every(Some(500_000), 0), 30_000);
    }

    #[tokio::test]
    async fn busy_target_waits() {
        let n = std::sync::atomic::AtomicU32::new(0);
        let ok = wait_idle(|| n.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 3, std::time::Duration::from_secs(2), std::time::Duration::from_millis(5)).await;
        assert!(ok);
        assert!(n.load(std::sync::atomic::Ordering::SeqCst) >= 4);
        assert!(!wait_idle(|| true, std::time::Duration::from_millis(30), std::time::Duration::from_millis(5)).await);
    }
}
