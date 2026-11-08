use crate::util::{read_json, run, RunOpts};
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const SKIP: &[&str] = &[".git", "node_modules", ".direnv", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", "result"];

pub fn list_dir(dir: &str) -> Value {
    let mut ents: Vec<(bool, String)> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|d| (d.path().is_dir(), d.file_name().to_string_lossy().into_owned())).collect())
        .unwrap_or_default();
    ents.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())).then_with(|| a.1.cmp(&b.1)));
    Value::Array(ents.into_iter().map(|(d, n)| json!({ "name": n, "dir": d })).collect())
}

pub async fn list_files(cwd: &str) -> Value {
    let g = run("git", &["ls-files".into(), "-co".into(), "--exclude-standard".into()], RunOpts { cwd: Some(cwd.into()), ..Default::default() }).await;
    if g["code"] == 0 {
        return Value::Array(g["stdout"].as_str().unwrap_or_default().lines().filter(|l| !l.is_empty()).take(50000).map(|l| json!(l)).collect());
    }
    let mut out = Vec::new();
    fn walk(root: &Path, rel: &str, out: &mut Vec<String>) {
        if out.len() > 20000 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(root.join(rel)) else { return };
        for d in rd.flatten() {
            let name = d.file_name().to_string_lossy().into_owned();
            if SKIP.contains(&name.as_str()) {
                continue;
            }
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if d.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                walk(root, &r, out)
            } else {
                out.push(r)
            }
        }
    }
    walk(Path::new(cwd), "", &mut out);
    json!(out)
}

pub fn image_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

pub fn read_file(file: &str) -> Result<Value, String> {
    let st = std::fs::metadata(file).map_err(|e| e.to_string())?;
    if st.len() > 5 << 20 {
        return Ok(json!({ "tooBig": true, "size": st.len() }));
    }
    let buf = std::fs::read(file).map_err(|e| e.to_string())?;
    let ext = Path::new(file).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if let Some(t) = image_type(&ext) {
        let data = base64::engine::general_purpose::STANDARD.encode(&buf);
        let text = (ext == "svg").then(|| String::from_utf8_lossy(&buf).into_owned());
        return Ok(json!({ "image": format!("data:{t};base64,{data}"), "text": text }));
    }
    if buf[..buf.len().min(8000)].contains(&0) {
        return Ok(json!({ "binary": true, "size": st.len() }));
    }
    Ok(json!({ "text": String::from_utf8_lossy(&buf) }))
}

pub fn read_bytes(file: &str) -> Result<Value, String> {
    let buf = std::fs::read(file).map_err(|e| e.to_string())?;
    if buf.len() > 50 << 20 {
        return Err("File is too big".into());
    }
    Ok(json!(base64::engine::general_purpose::STANDARD.encode(buf)))
}

pub fn create_file(file: &str, content: &str) -> Value {
    let p = Path::new(file);
    if let Some(d) = p.parent() {
        if let Err(e) = std::fs::create_dir_all(d) {
            return json!({ "error": e.to_string() });
        }
    }
    match std::fs::OpenOptions::new().write(true).create_new(true).open(p) {
        Ok(mut f) => match std::io::Write::write_all(&mut f, content.as_bytes()) {
            Ok(()) => Value::Null,
            Err(e) => json!({ "error": e.to_string() }),
        },
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => json!({ "error": "That file already exists" }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

pub fn append_memory(file: &str, text: &str) -> Result<(), String> {
    let p = Path::new(file);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let prev = std::fs::read_to_string(p).unwrap_or_default();
    let sep = if !prev.is_empty() && !prev.ends_with('\n') { "\n" } else { "" };
    std::fs::write(p, format!("{prev}{sep}- {text}\n")).map_err(|e| e.to_string())
}

pub fn field(text: &str, key: &str) -> String {
    let prefix = format!("{key}:");
    let Some(line) = text.lines().find(|l| l.starts_with(&prefix)) else { return String::new() };
    let v = line[prefix.len()..].trim();
    if matches!(v, ">" | "|" | ">-" | "|-") {
        return String::new();
    }
    let v = v.strip_prefix(['"', '\'']).unwrap_or(v);
    v.strip_suffix(['"', '\'']).unwrap_or(v).to_string()
}

pub fn skills_in(dir: &Path, prefix: &str, own: Option<&str>) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut names: Vec<String> = rd.flatten().map(|d| d.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|n| {
            let text = std::fs::read_to_string(dir.join(&n).join("SKILL.md")).ok()?;
            let name = Some(field(&text, "name")).filter(|s| !s.is_empty()).unwrap_or(n.clone());
            let source = if prefix.is_empty() { json!(own) } else { json!(&prefix[..prefix.len() - 1]) };
            Some(json!({
                "name": format!("{prefix}{name}"), "description": field(&text, "description"), "source": source,
                "dir": own.map(|_| dir.join(&n).to_string_lossy().into_owned()),
            }))
        })
        .collect()
}

pub fn claude_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| crate::util::home().join(".claude"))
}

pub fn claude_config() -> PathBuf {
    if std::env::var_os("CLAUDE_CONFIG_DIR").is_some() {
        claude_dir().join(".claude.json")
    } else {
        crate::util::home().join(".claude.json")
    }
}

pub async fn extensions(claude: &Path, cwd: Option<&str>) -> Value {
    let list: Value = {
        let r = run(claude, &["plugin".into(), "list".into(), "--json".into()], RunOpts::default()).await;
        serde_json::from_str(r["stdout"].as_str().unwrap_or("[]")).unwrap_or(json!([]))
    };
    let mut plugins: Vec<(String, bool, Option<String>)> = vec![];
    for p in list.as_array().cloned().unwrap_or_default() {
        let id = p["id"].as_str().unwrap_or_default().to_string();
        let enabled = p["enabled"].as_bool().unwrap_or(false);
        let path = p["installPath"].as_str().map(String::from);
        match plugins.iter_mut().find(|x| x.0 == id) {
            Some(x) => x.1 |= enabled,
            None => plugins.push((id, enabled, path)),
        }
    }
    let dir = claude_dir();
    let cfg = read_json(&claude_config());
    let user = read_json(&dir.join("settings.json"));
    let mcp_json = cwd.map(|c| read_json(&Path::new(c).join(".mcp.json"))).unwrap_or(json!({}));
    let mut skills = skills_in(&dir.join("skills"), "", Some("user"));
    if let Some(c) = cwd {
        skills.extend(skills_in(&Path::new(c).join(".claude/skills"), "", Some("project")));
    }
    for (id, enabled, path) in &plugins {
        if let (true, Some(p)) = (enabled, path) {
            let short = id.split('@').next().unwrap_or(id);
            skills.extend(skills_in(&Path::new(p).join("skills"), &format!("{short}:"), None));
        }
    }
    let mut mcp = vec![];
    let local = cwd.map(|c| cfg["projects"][c]["mcpServers"].clone()).unwrap_or(Value::Null);
    for (scope, o) in [("user", &cfg["mcpServers"]), ("local", &local), ("project", &mcp_json["mcpServers"])] {
        if let Some(o) = o.as_object() {
            for name in o.keys() {
                mcp.push(json!({ "name": name, "scope": scope }));
            }
        }
    }
    json!({
        "plugins": plugins.iter().map(|(id, e, _)| json!({ "id": id, "enabled": e })).collect::<Vec<_>>(),
        "mcp": mcp, "skills": skills, "skillOverrides": if user["skillOverrides"].is_object() { user["skillOverrides"].clone() } else { json!({}) },
    })
}

pub fn set_skill(settings: &Path, name: &str, on: bool) -> Result<(), String> {
    let mut s: Value = match std::fs::read_to_string(settings) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e.to_string()),
    };
    let mut o = s["skillOverrides"].as_object().cloned().unwrap_or_default();
    o.remove(name);
    if !on {
        o.insert(name.into(), json!("off"));
    }
    let obj = s.as_object_mut().ok_or("settings.json is not an object")?;
    if o.is_empty() {
        obj.remove("skillOverrides");
    } else {
        obj.insert("skillOverrides".into(), Value::Object(o));
    }
    if let Some(d) = settings.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(settings, serde_json::to_string_pretty(&s).unwrap() + "\n").map_err(|e| e.to_string())
}

pub fn skill_dir_ok(dir: &Path, claude: &Path) -> bool {
    let Some(parent) = dir.parent() else { return false };
    let Some(owner) = parent.parent() else { return false };
    parent.file_name().is_some_and(|n| n == "skills") && (owner == claude || owner.file_name().is_some_and(|n| n == ".claude")) && dir.join("SKILL.md").exists()
}

pub fn delete_skill(dir: &str) -> Result<(), String> {
    let d = std::path::absolute(dir).map_err(|e| e.to_string())?;
    if !skill_dir_ok(&d, &claude_dir()) {
        return Err("Not a skill folder".into());
    }
    if std::fs::symlink_metadata(&d).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        std::fs::remove_file(&d).map_err(|e| e.to_string())
    } else {
        trash::delete(&d).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_dir_puts_folders_first_then_names() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("b.txt"), "").unwrap();
        std::fs::write(d.path().join("A.txt"), "").unwrap();
        std::fs::create_dir(d.path().join("zdir")).unwrap();
        let v = list_dir(d.path().to_str().unwrap());
        let names: Vec<_> = v.as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["zdir", "A.txt", "b.txt"]);
        assert_eq!(v[0]["dir"], true);
    }

    #[test]
    fn read_file_classifies_text_binary_image_and_size() {
        let d = tempfile::tempdir().unwrap();
        let p = |n: &str| d.path().join(n).to_string_lossy().into_owned();
        std::fs::write(p("a.txt"), "hi").unwrap();
        std::fs::write(p("b.bin"), [1u8, 0, 2]).unwrap();
        std::fs::write(p("c.png"), [137u8, 80]).unwrap();
        std::fs::write(p("big.txt"), vec![b'a'; (5 << 20) + 1]).unwrap();
        assert_eq!(read_file(&p("a.txt")).unwrap()["text"], "hi");
        assert_eq!(read_file(&p("b.bin")).unwrap()["binary"], true);
        assert!(read_file(&p("c.png")).unwrap()["image"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(read_file(&p("big.txt")).unwrap()["tooBig"], true);
    }

    #[test]
    fn create_file_refuses_existing() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("x/y.txt").to_string_lossy().into_owned();
        assert_eq!(create_file(&f, "1"), Value::Null);
        assert_eq!(create_file(&f, "2")["error"], "That file already exists");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "1");
    }

    #[test]
    fn append_memory_adds_bullets_on_new_lines() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("CLAUDE.md");
        std::fs::write(&f, "# Notes").unwrap();
        append_memory(f.to_str().unwrap(), "one").unwrap();
        append_memory(f.to_str().unwrap(), "two").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "# Notes\n- one\n- two\n");
    }

    #[test]
    fn frontmatter_fields() {
        let t = "---\nname: \"my-skill\"\ndescription: >-\nfoo: bar\n---";
        assert_eq!(field(t, "name"), "my-skill");
        assert_eq!(field(t, "description"), "");
        assert_eq!(field(t, "foo"), "bar");
        assert_eq!(field(t, "nope"), "");
    }

    #[test]
    fn set_skill_toggles_overrides_and_drops_empty() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("settings.json");
        std::fs::write(&f, r#"{"model":"opus"}"#).unwrap();
        set_skill(&f, "a", false).unwrap();
        assert_eq!(read_json(&f)["skillOverrides"]["a"], "off");
        set_skill(&f, "a", true).unwrap();
        assert!(read_json(&f).get("skillOverrides").is_none());
        assert_eq!(read_json(&f)["model"], "opus");
    }

    #[test]
    fn skill_dir_must_live_in_a_claude_skills_folder() {
        let d = tempfile::tempdir().unwrap();
        let ok = d.path().join("proj/.claude/skills/s");
        let bad = d.path().join("proj/other/skills/s");
        for p in [&ok, &bad] {
            std::fs::create_dir_all(p).unwrap();
            std::fs::write(p.join("SKILL.md"), "x").unwrap();
        }
        assert!(skill_dir_ok(&ok, Path::new("/nonexistent")));
        assert!(!skill_dir_ok(&bad, Path::new("/nonexistent")));
    }
}
