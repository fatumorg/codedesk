use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const EDGE: u64 = 65536;
const MAX_NAME: usize = 200;

pub fn project_dir(root: &Path, cwd: &str) -> PathBuf {
    let name: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let projects = root.join("projects");
    if name.len() <= MAX_NAME {
        return projects.join(name);
    }
    let prefix = &name[..MAX_NAME];
    std::fs::read_dir(&projects)
        .ok()
        .and_then(|rd| rd.flatten().map(|d| d.path()).find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(prefix))))
        .unwrap_or_else(|| projects.join(prefix))
}

fn dirs(root: &Path, cwd: Option<&str>) -> Vec<PathBuf> {
    match cwd.filter(|c| !c.is_empty()) {
        Some(c) => vec![project_dir(root, c)],
        None => std::fs::read_dir(root.join("projects")).map(|rd| rd.flatten().map(|d| d.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default(),
    }
}

fn edges(f: &Path) -> Option<(String, String, u64, i64)> {
    let mut file = std::fs::File::open(f).ok()?;
    let meta = file.metadata().ok()?;
    let size = meta.len();
    if size == 0 {
        return None;
    }
    let mtime = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
    let mut head = vec![0; EDGE.min(size) as usize];
    file.read_exact(&mut head).ok()?;
    let tail = if size <= EDGE {
        head.clone()
    } else {
        let mut t = vec![0; EDGE as usize];
        file.seek(SeekFrom::Start(size - EDGE)).ok()?;
        file.read_exact(&mut t).ok()?;
        t
    };
    Some((String::from_utf8_lossy(&head).into_owned(), String::from_utf8_lossy(&tail).into_owned(), size, mtime))
}

fn strings_of<'a>(text: &'a str, key: &'a str) -> impl Iterator<Item = String> + 'a {
    [format!("\"{key}\":\""), format!("\"{key}\": \"")].into_iter().flat_map(move |pat| {
        text.match_indices(&pat).map(|(i, _)| (i, pat.len())).collect::<Vec<_>>().into_iter().filter_map(move |(i, n)| {
            serde_json::Deserializer::from_str(&text[i + n - 1..]).into_iter::<String>().next().and_then(|r| r.ok()).map(|s| (i, s))
        })
    })
    .collect::<std::collections::BTreeMap<_, _>>()
    .into_values()
    .filter(|s| !s.is_empty())
}

fn last(text: &str, key: &str) -> Option<String> {
    strings_of(text, key).last()
}

fn first(text: &str, key: &str) -> Option<String> {
    strings_of(text, key).next()
}

fn clean(s: &str) -> String {
    let s: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().filter(|c| !c.is_control()).take(MAX_NAME).collect::<String>().trim().to_string()
}

fn first_prompt(head: &str) -> Option<String> {
    let mut fallback = None;
    for l in head.lines() {
        if !(l.contains("\"type\":\"user\"") || l.contains("\"type\": \"user\"")) || l.contains("\"tool_result\"") || l.contains("\"isMeta\":true") || l.contains("\"isCompactSummary\":true") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        let c = &v["message"]["content"];
        let text = match c {
            Value::String(s) => s.clone(),
            Value::Array(a) => a.iter().find(|b| b["type"] == "text").and_then(|b| b["text"].as_str()).unwrap_or_default().to_string(),
            _ => continue,
        };
        let t = text.trim();
        if t.starts_with('<') {
            if let Some(name) = t.split("<command-name>").nth(1).and_then(|r| r.split("</command-name>").next()) {
                fallback.get_or_insert_with(|| name.trim().to_string());
            }
            continue;
        }
        if !t.is_empty() {
            return Some(clean(t));
        }
    }
    fallback
}

fn info(id: &str, f: &Path, fallback_cwd: Option<&str>) -> Option<Value> {
    let (head, tail, size, mtime) = edges(f)?;
    if head.lines().next().is_some_and(|l| l.contains("\"isSidechain\":true") || l.contains("\"isSidechain\": true")) {
        return None;
    }
    let custom = last(&tail, "customTitle").or_else(|| last(&head, "customTitle"));
    let title = custom.clone().or_else(|| last(&tail, "aiTitle")).or_else(|| last(&head, "aiTitle"));
    let fp = first_prompt(&head);
    let summary = title.clone().or_else(|| last(&tail, "lastPrompt")).or_else(|| last(&tail, "summary")).or_else(|| fp.clone())?;
    let created = first(&head, "timestamp").and_then(|t| chrono_ms(&t));
    Some(json!({
        "sessionId": id, "summary": summary, "lastModified": mtime, "fileSize": size, "customTitle": title, "firstPrompt": fp,
        "gitBranch": last(&tail, "gitBranch").or_else(|| first(&head, "gitBranch")), "cwd": first(&head, "cwd").or(fallback_cwd.map(String::from)), "createdAt": created,
    }))
}

fn chrono_ms(t: &str) -> Option<i64> {
    let (date, time) = t.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, dd) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z');
    let mut parts = time.split(':');
    let (h, mi) = (parts.next()?.parse::<i64>().ok()?, parts.next()?.parse::<i64>().ok()?);
    let sec: f64 = parts.next().unwrap_or("0").parse().ok()?;
    let (yy, mm) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + dd - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60) as f64 * 1000.0 + sec * 1000.0).round() as i64)
}

pub fn list(root: &Path, cwd: Option<&str>, limit: usize) -> Vec<Value> {
    let mut out: Vec<Value> = dirs(root, cwd)
        .into_iter()
        .flat_map(|d| std::fs::read_dir(d).map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>()).unwrap_or_default())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .filter_map(|p| info(&p.file_stem()?.to_string_lossy(), &p, cwd))
        .collect();
    out.sort_by_key(|v| -v["lastModified"].as_i64().unwrap_or(0));
    out.truncate(limit);
    out
}

fn find(root: &Path, id: &str, cwd: Option<&str>) -> Option<PathBuf> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return None;
    }
    let file = format!("{id}.jsonl");
    let ok = |p: PathBuf| p.metadata().is_ok_and(|m| m.len() > 0).then_some(p);
    dirs(root, cwd).into_iter().find_map(|d| ok(d.join(&file))).or_else(|| dirs(root, None).into_iter().find_map(|d| ok(d.join(&file))))
}

fn entries(f: &Path) -> Vec<Value> {
    std::fs::read_to_string(f)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| matches!(v["type"].as_str(), Some("user" | "assistant" | "progress" | "system" | "attachment")) && v["uuid"].is_string())
        .collect()
}

pub fn messages(root: &Path, id: &str, cwd: Option<&str>) -> Vec<Value> {
    let Some(f) = find(root, id, cwd) else { return vec![] };
    let all = entries(&f);
    let by_id: HashMap<&str, &Value> = all.iter().map(|e| (e["uuid"].as_str().unwrap(), e)).collect();
    let Some(leaf) = all.iter().rev().find(|e| e["isSidechain"] != true && (e["type"] == "user" || e["type"] == "assistant")) else { return vec![] };
    let mut chain = vec![];
    let mut seen = HashSet::new();
    let mut cur = Some(leaf);
    while let Some(e) = cur {
        if !seen.insert(e["uuid"].as_str().unwrap()) {
            break;
        }
        chain.push(e);
        cur = e["parentUuid"].as_str().and_then(|p| by_id.get(p).copied());
    }
    chain
        .into_iter()
        .rev()
        .filter(|e| (e["type"] == "user" || e["type"] == "assistant") && e["isMeta"] != true && e["origin"]["kind"].as_str().is_none_or(|k| k == "human"))
        .map(|e| json!({ "type": e["type"], "uuid": e["uuid"], "session_id": id, "message": e["message"], "parent_tool_use_id": null, "compact": e["isCompactSummary"] == true }))
        .collect()
}

pub fn rename(root: &Path, id: &str, title: &str, cwd: Option<&str>) -> Result<(), String> {
    let t = title.trim();
    if t.is_empty() {
        return Err("title must be non-empty".into());
    }
    let f = find(root, id, cwd).ok_or_else(|| format!("Session {id} not found"))?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(f).map_err(|e| e.to_string())?;
    file.write_all(format!("{}\n", json!({ "type": "custom-title", "customTitle": t, "sessionId": id })).as_bytes()).map_err(|e| e.to_string())
}

pub fn delete(root: &Path, id: &str, cwd: Option<&str>) -> Result<(), String> {
    let f = find(root, id, cwd).ok_or_else(|| format!("Session {id} not found"))?;
    std::fs::remove_file(&f).map_err(|e| e.to_string())?;
    let side = f.with_extension("");
    if side.is_dir() {
        let _ = std::fs::remove_dir_all(side);
    }
    Ok(())
}

pub fn fork(root: &Path, id: &str, cwd: Option<&str>, up_to: Option<&str>) -> Result<String, String> {
    let f = find(root, id, cwd).ok_or_else(|| format!("Session {id} not found"))?;
    let mut list: Vec<Value> = entries(&f).into_iter().filter(|e| e["isSidechain"] != true).collect();
    if let Some(u) = up_to.filter(|u| !u.is_empty()) {
        let i = list.iter().position(|e| e["uuid"] == u).ok_or_else(|| format!("Message {u} not found in session {id}"))?;
        list.truncate(i + 1);
    }
    let by_id: HashMap<String, Value> = list.iter().map(|e| (e["uuid"].as_str().unwrap().to_string(), e.clone())).collect();
    let fresh: HashMap<String, String> = list.iter().map(|e| (e["uuid"].as_str().unwrap().to_string(), crate::util::uuid())).collect();
    let kept: Vec<&Value> = list.iter().filter(|e| e["type"] != "progress").collect();
    if kept.is_empty() {
        return Err(format!("Session {id} has no messages to fork"));
    }
    let new_id = crate::util::uuid();
    let mut out = String::new();
    for e in kept {
        let mut parent = e["parentUuid"].as_str().map(String::from);
        let mut seen = HashSet::new();
        while let Some(p) = parent.clone() {
            match by_id.get(&p) {
                Some(x) if x["type"] == "progress" && seen.insert(p.clone()) => parent = x["parentUuid"].as_str().map(String::from),
                Some(_) => break,
                None => {
                    parent = None;
                    break;
                }
            }
        }
        let mut n = e.clone();
        n["uuid"] = json!(fresh[e["uuid"].as_str().unwrap()]);
        n["parentUuid"] = parent.and_then(|p| fresh.get(&p).cloned()).map(Value::from).unwrap_or(Value::Null);
        if let Some(l) = e["logicalParentUuid"].as_str() {
            n["logicalParentUuid"] = fresh.get(l).cloned().map(Value::from).unwrap_or(Value::Null);
        }
        n["sessionId"] = json!(new_id);
        out.push_str(&format!("{n}\n"));
    }
    if let Some(base) = info(id, &f, cwd).and_then(|i| i["customTitle"].as_str().or(i["firstPrompt"].as_str()).map(String::from)) {
        out.push_str(&format!("{}\n", json!({ "type": "custom-title", "customTitle": format!("{base} (fork)"), "sessionId": new_id })));
    }
    std::fs::write(f.with_file_name(format!("{new_id}.jsonl")), out).map_err(|e| e.to_string())?;
    Ok(new_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "11111111-1111-4111-8111-111111111111";

    fn line(v: Value) -> String {
        format!("{v}\n")
    }

    fn fixture(root: &Path, cwd: &str) -> PathBuf {
        let dir = project_dir(root, cwd);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(format!("{A}.jsonl"));
        let body = [
            line(json!({ "type": "user", "uuid": "u1", "parentUuid": null, "sessionId": A, "cwd": cwd, "gitBranch": "main", "timestamp": "2026-01-01T00:00:00.000Z", "message": { "role": "user", "content": "first question" } })),
            line(json!({ "type": "assistant", "uuid": "a1", "parentUuid": "u1", "sessionId": A, "message": { "role": "assistant", "content": [{ "type": "text", "text": "answer" }] } })),
            line(json!({ "type": "user", "uuid": "s1", "parentUuid": "a1", "isSidechain": true, "sessionId": A, "message": { "role": "user", "content": "side" } })),
            line(json!({ "type": "progress", "uuid": "p1", "parentUuid": "a1", "sessionId": A })),
            line(json!({ "type": "user", "uuid": "u2", "parentUuid": "p1", "sessionId": A, "message": { "role": "user", "content": "second" } })),
            line(json!({ "type": "user", "uuid": "m1", "parentUuid": "u2", "isMeta": true, "sessionId": A, "message": { "role": "user", "content": "meta" } })),
            line(json!({ "type": "user", "uuid": "n1", "parentUuid": "m1", "origin": { "kind": "task-notification" }, "sessionId": A, "message": { "role": "user", "content": "<task-notification>x</task-notification>" } })),
            line(json!({ "type": "assistant", "uuid": "a2", "parentUuid": "n1", "sessionId": A, "message": { "role": "assistant", "content": [{ "type": "text", "text": "done" }] } })),
            line(json!({ "type": "last-prompt", "lastPrompt": "second", "sessionId": A })),
        ]
        .concat();
        std::fs::write(&f, body).unwrap();
        f
    }

    #[test]
    fn project_dirs_replace_non_alphanumerics() {
        assert_eq!(project_dir(Path::new("/c"), "/home/a.b/x_y"), PathBuf::from("/c/projects/-home-a-b-x-y"));
    }

    #[test]
    fn list_reads_fields_and_title_precedence() {
        let root = tempfile::tempdir().unwrap();
        let f = fixture(root.path(), "/w/p");
        let l = list(root.path(), Some("/w/p"), 200);
        assert_eq!(l.len(), 1);
        let s = &l[0];
        assert_eq!(s["sessionId"], A);
        assert_eq!(s["summary"], "second");
        assert_eq!(s["firstPrompt"], "first question");
        assert_eq!(s["gitBranch"], "main");
        assert_eq!(s["cwd"], "/w/p");
        assert!(s["lastModified"].as_i64().unwrap() > 0 && s["fileSize"].as_u64().unwrap() > 0);
        assert_eq!(s["createdAt"], 1767225600000i64);
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(line(json!({ "type": "ai-title", "aiTitle": "AI", "sessionId": A })).as_bytes()).unwrap();
        assert_eq!(list(root.path(), Some("/w/p"), 200)[0]["summary"], "AI");
        rename(root.path(), A, "  Mine ", Some("/w/p")).unwrap();
        let s = &list(root.path(), None, 200)[0];
        assert_eq!(s["summary"], "Mine");
        assert_eq!(s["customTitle"], "Mine");
        assert!(rename(root.path(), A, " ", Some("/w/p")).is_err());
    }

    #[test]
    fn sidechain_first_files_are_skipped() {
        let root = tempfile::tempdir().unwrap();
        let dir = project_dir(root.path(), "/w");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.jsonl"), line(json!({ "type": "user", "uuid": "z", "isSidechain": true, "message": { "content": "a" } }))).unwrap();
        assert!(list(root.path(), Some("/w"), 200).is_empty());
    }

    #[test]
    fn messages_follow_the_chain_without_sidechains_meta_or_progress() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "/w/p");
        let m = messages(root.path(), A, Some("/w/p"));
        let ids: Vec<_> = m.iter().map(|m| m["uuid"].as_str().unwrap()).collect();
        assert_eq!(ids, ["u1", "a1", "u2", "a2"]);
        assert_eq!(m[0]["type"], "user");
        assert_eq!(m[0]["session_id"], A);
        assert_eq!(m[0]["message"]["content"], "first question");
        assert!(m[0]["parent_tool_use_id"].is_null());
        assert_eq!(messages(root.path(), A, None).len(), 4);
        assert!(messages(root.path(), "nope", None).is_empty());
    }

    #[test]
    fn fork_copies_the_chain_up_to_a_message_under_a_new_id() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "/w/p");
        let id = fork(root.path(), A, Some("/w/p"), Some("a1")).unwrap();
        assert_ne!(id, A);
        let m = messages(root.path(), &id, Some("/w/p"));
        assert_eq!(m.len(), 2);
        assert_eq!(m[1]["message"]["content"][0]["text"], "answer");
        assert!(m.iter().all(|x| x["session_id"] == id.as_str() && x["uuid"] != "u1" && x["uuid"] != "a1"));
        assert_eq!(list(root.path(), Some("/w/p"), 200).iter().find(|s| s["sessionId"] == id.as_str()).unwrap()["summary"], "first question (fork)");
        let all = fork(root.path(), A, Some("/w/p"), None).unwrap();
        assert_eq!(messages(root.path(), &all, Some("/w/p")).len(), 4);
        assert!(fork(root.path(), A, Some("/w/p"), Some("missing")).is_err());
    }

    #[test]
    fn delete_removes_the_transcript() {
        let root = tempfile::tempdir().unwrap();
        let f = fixture(root.path(), "/w/p");
        delete(root.path(), A, Some("/w/p")).unwrap();
        assert!(!f.exists());
        assert!(delete(root.path(), A, Some("/w/p")).is_err());
    }
}
