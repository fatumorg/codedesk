use crate::core::{core, scheme_url};
use crate::{files, transcripts};
use crate::hub::Client;
use crate::util::{arg_str, run, strip_ansi, RunOpts};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub const REMOTE_BLOCKED: &[&str] = &["find", "pickFolder", "saveFile", "addAccount", "readBytes", "setIcon"];

fn shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        ("powershell.exe".into(), vec!["-NoProfile".into(), "-Command".into()])
    } else {
        (std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()), vec!["-c".into()])
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default()
}

fn ok<T: Into<Value>>(v: T) -> Result<Value, String> {
    Ok(v.into())
}

fn id_of(v: &Value) -> String {
    v.as_str().map(String::from).unwrap_or_else(|| v.to_string())
}

pub fn is_remote(client: &Client) -> bool {
    client.id.starts_with('p')
}

pub fn file_url(client: &Client, p: &str) -> String {
    let enc = percent_encoding::utf8_percent_encode(p, percent_encoding::NON_ALPHANUMERIC).to_string();
    if is_remote(client) {
        format!("/preview?f={enc}")
    } else {
        scheme_url(&format!("f/{enc}"))
    }
}

async fn status_line(input: Value) -> Value {
    let settings = crate::util::read_json(&crate::util::home().join(".claude/settings.json"));
    let Some(cmd) = (settings["statusLine"]["type"] == "command").then(|| settings["statusLine"]["command"].as_str()).flatten() else {
        return Value::Null;
    };
    let (sh, mut a) = if cfg!(windows) { ("cmd".to_string(), vec!["/C".to_string()]) } else { ("/bin/sh".to_string(), vec!["-c".to_string()]) };
    a.push(cmd.to_string());
    let cwd = input["cwd"].as_str().filter(|c| Path::new(c).is_dir()).map(PathBuf::from);
    let r = run(sh, &a, RunOpts { cwd, timeout: Some(Duration::from_secs(5)), stdin: Some(input.to_string()), ..Default::default() }).await;
    json!(strip_ansi(r["stdout"].as_str().unwrap_or_default()).trim().lines().next().unwrap_or_default())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f).await.expect("blocking task")
}

pub async fn dispatch(ch: &str, client: &Client, args: Vec<Value>) -> Result<Value, String> {
    let c = core();
    let s = |i: usize| arg_str(&args, i);
    let a = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
    match ch {
        "info" => ok(c.info()),
        "listDir" => ok(files::list_dir(&s(0))),
        "listFiles" => ok(files::list_files(&s(0)).await),
        "readFile" => files::read_file(&s(0)),
        "readBytes" => files::read_bytes(&s(0)),
        "createFile" => ok(files::create_file(&s(0), &s(1))),
        "writeFile" => std::fs::write(s(0), s(1)).map(|_| Value::Null).map_err(|e| e.to_string()),
        "appendMemory" => files::append_memory(&s(0), &s(1)).map(|_| Value::Null),
        "git" => ok(run("git", &strings(&args[1]), RunOpts { cwd: Some(s(0).into()), ..Default::default() }).await),
        "runShell" => {
            let (sh, mut a) = shell();
            a.push(s(1));
            ok(run(sh, &a, RunOpts { cwd: Some(s(0).into()), ..Default::default() }).await)
        }
        "cli" => ok(run(c.claude_bin(), &strings(args.first().unwrap_or(&Value::Null)), RunOpts { timeout: Some(Duration::from_secs(600)), ..Default::default() }).await),
        "statusLine" => ok(status_line(args.first().cloned().unwrap_or_default()).await),
        "extensions" => {
            let cwd = args.first().and_then(|v| v.as_str()).map(String::from);
            ok(files::extensions(&c.claude_bin(), cwd.as_deref()).await)
        }
        "setSkill" => files::set_skill(&files::claude_dir().join("settings.json"), &s(0), args.get(1).and_then(|v| v.as_bool()).unwrap_or(false)).map(|_| Value::Null),
        "deleteSkill" => files::delete_skill(&s(0)).map(|_| Value::Null),
        "writeTemp" => {
            let id = c.preview_html(s(0));
            ok(if is_remote(client) { format!("/preview?h={id}") } else { scheme_url(&format!("h/{id}")) })
        }
        "fileUrl" => ok(file_url(client, &s(0))),
        "openPath" => {
            let p = s(0);
            ok(c.app().opener().open_path(p, None::<&str>).err().map(|e| e.to_string()).unwrap_or_default())
        }
        "openInEditor" => {
            open_in_editor(&s(0), &s(1), args.get(2).and_then(|v| v.as_u64()));
            ok(Value::Null)
        }
        "showItem" => {
            let _ = c.app().opener().reveal_item_in_dir(s(0));
            ok(Value::Null)
        }
        "openExternal" => {
            let u = s(0);
            if u.starts_with("http://") || u.starts_with("https://") {
                let _ = c.app().opener().open_url(u, None::<&str>);
            }
            ok(Value::Null)
        }
        "pickFolder" => {
            let app = c.app().clone();
            ok(blocking(move || app.dialog().file().blocking_pick_folder()).await.map(|p| json!(p.to_string())).unwrap_or(Value::Null))
        }
        "saveFile" => {
            let (app, name, content) = (c.app().clone(), s(0), s(1));
            let picked = blocking(move || app.dialog().file().set_file_name(name).blocking_save_file()).await;
            match picked.and_then(|p| p.into_path().ok()) {
                Some(p) => std::fs::write(p, content).map(|_| json!(true)).map_err(|e| e.to_string()),
                None => ok(false),
            }
        }
        "saveShared" => {
            let own = Value::Object(crate::shared::pick_shared(args.first().unwrap_or(&Value::Null)));
            c.shared.save(&own).await.map_err(|e| e.to_string())?;
            c.hub.broadcast("shared:changed", own, Some(&client.id));
            ok(Value::Null)
        }
        "find" => ok(Value::Null),
        "schedules" => ok(crate::schedule::list()),
        "saveSchedule" => crate::schedule::save(a(0)),
        "deleteSchedule" => {
            crate::schedule::delete(&s(0));
            ok(Value::Null)
        }
        "runSchedule" => crate::schedule::run_now(&s(0)).map(|_| Value::Null),
        "termStart" => {
            let n = |i: usize| args.get(i).and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            crate::term::start(client, &id_of(&a(0)), &s(1), n(2), n(3), crate::term::shell()).map(|_| Value::Null)
        }
        "termWrite" => {
            crate::term::write(client, &id_of(&a(0)), &s(1));
            ok(Value::Null)
        }
        "termResize" => {
            let n = |i: usize| args.get(i).and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            crate::term::resize(client, &id_of(&a(0)), n(1), n(2));
            ok(Value::Null)
        }
        "termKill" => {
            crate::term::kill(client, &id_of(&a(0)));
            ok(Value::Null)
        }
        "remoteStatus" => ok(crate::remote::status().await),
        "remoteSet" => crate::remote::set(a(0) == true).await,
        "remotePair" => ok(crate::remote::pair()),
        "remoteRevoke" => {
            crate::remote::REMOTE.revoke(&s(0))?;
            ok(crate::remote::status().await)
        }
        "remoteTailscale" => ok(crate::remote::tailscale_serve().await),
        "listSessions" => {
            let dir = args.first().and_then(|v| v.as_str()).filter(|d| !d.is_empty()).map(String::from);
            ok(blocking(move || {
                let mut out: Vec<Value> = crate::session::gemini_store()
                    .into_values()
                    .filter(|g| dir.as_deref().is_none_or(|d| g["cwd"] == d))
                    .map(|mut g| {
                        if let Some(o) = g.as_object_mut() {
                            o.remove("messages");
                        }
                        g
                    })
                    .collect();
                out.extend(transcripts::list(&files::claude_dir(), dir.as_deref(), 200));
                out.sort_by_key(|v| -v["lastModified"].as_i64().unwrap_or(0));
                out
            })
            .await)
        }
        "history" => {
            let (id, dir) = (s(0), s(1));
            if let Some(h) = crate::session::live_gemini_history(&id) {
                return ok(h);
            }
            if let Some(g) = crate::session::gemini_store().get(&id) {
                return ok(if g["messages"].is_array() { g["messages"].clone() } else { json!([]) });
            }
            ok(blocking(move || transcripts::messages(&files::claude_dir(), &id, Some(&dir).filter(|d| !d.is_empty()).map(|d| d.as_str()))).await)
        }
        "renameSession" => {
            let (id, title, dir) = (s(0), s(1), s(2));
            let t = title.clone();
            if crate::session::update_gemini_store(|all| all.get_mut(&id).map(|g| g["customTitle"] = json!(t)).is_some()) {
                return ok(Value::Null);
            }
            transcripts::rename(&files::claude_dir(), &id, &title, Some(dir.as_str()).filter(|d| !d.is_empty())).map(|_| Value::Null)
        }
        "deleteSession" => {
            let (id, dir) = (s(0), s(1));
            if crate::session::update_gemini_store(|all| all.remove(&id).is_some()) {
                return ok(Value::Null);
            }
            transcripts::delete(&files::claude_dir(), &id, Some(dir.as_str()).filter(|d| !d.is_empty())).map(|_| Value::Null)
        }
        "forkSession" => {
            let (id, dir, up) = (s(0), s(1), s(2));
            if crate::session::gemini_store().contains_key(&id) {
                return Err("Fork is not available for Gemini conversations".into());
            }
            transcripts::fork(&files::claude_dir(), &id, Some(dir.as_str()).filter(|d| !d.is_empty()), Some(up.as_str()).filter(|u| !u.is_empty())).map(|n| json!({ "sessionId": n }))
        }
        "start" => crate::session::start(client, a(0), a(1)).await,
        "stop" | "detach" => {
            crate::session::detach(client, &a(0));
            ok(Value::Null)
        }
        "send" => {
            crate::session::send(client, &a(0), a(1));
            ok(Value::Null)
        }
        "control" => crate::session::control(client, &a(0), &s(1), args.iter().skip(2).cloned().collect()).await,
        "permit" => {
            crate::session::permit(client, &a(0), &s(1), a(2));
            ok(Value::Null)
        }
        "liveSessions" => ok(crate::session::live(client)),
        "attach" => ok(crate::session::attach(client, a(0), &s(1))),
        "usage" => ok(crate::session::usage(client, &a(0), a(1) == true, &s(2)).await),
        "accounts" => ok(crate::session::accounts().list()),
        "addAccount" => {
            let bin = c.claude_bin();
            ok(crate::session::accounts()
                .add(|env| async move { run(bin, &["auth".into(), "login".into()], RunOpts { env, timeout: Some(Duration::from_secs(600)), ..Default::default() }).await })
                .await)
        }
        "removeAccount" => crate::session::accounts().remove(&s(0)).map(|_| Value::Null),
        "googleStatus" => ok(crate::session::google_status().await),
        "localStatus" => ok(crate::local::status(&a(0)).await),
        "localStart" => crate::local::start(&a(0), &s(1)).await.map(|_| Value::Null),
        "localStop" => {
            crate::local::stop_llama();
            ok(Value::Null)
        }
        _ => Err(format!("Unknown channel: {ch}")),
    }
}

fn open_in_editor(cmd: &str, file: &str, line: Option<u64>) {
    let mut parts = cmd.split_whitespace();
    let Some(bin) = parts.next() else {
        let _ = core().app().opener().open_path(file, None::<&str>);
        return;
    };
    let mut a: Vec<String> = parts.map(String::from).collect();
    let base = Path::new(bin).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if line.is_some() && ["code", "cursor", "codium", "windsurf", "zed"].contains(&base.as_str()) {
        a.push("-g".into());
    }
    a.push(match line {
        Some(l) => format!("{file}:{l}"),
        None => file.to_string(),
    });
    let spawned = std::process::Command::new(bin).args(&a).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
    match spawned {
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
        }
        Err(_) => {
            let _ = core().app().opener().open_path(file, None::<&str>);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_ui_channel_has_a_handler() {
        let src = [include_str!("api.rs"), include_str!("main.rs")].concat();
        let channels = "start stop send control permit listSessions history renameSession deleteSession forkSession listDir listFiles readFile writeFile git runShell cli appendMemory createFile \
            writeTemp fileUrl openPath openInEditor showItem openExternal pickFolder saveFile find info statusLine usage termStart termWrite termResize termKill \
            googleStatus accounts addAccount removeAccount liveSessions attach detach saveShared remoteStatus remoteSet remotePair remoteRevoke remoteTailscale localStatus localStart localStop \
            extensions setSkill deleteSkill readBytes newWindow zoom devtools fullscreen quit";
        let ui: String = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/ui")).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "js")).map(|e| std::fs::read_to_string(e.path()).unwrap()).collect();
        let used: Vec<String> = ui.match_indices("api.").filter_map(|(i, _)| {
            let name: String = ui[i + 4..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            (!["on", "shared", "pathFor"].contains(&name.as_str()) && !name.is_empty()).then_some(name)
        }).collect();
        for c in channels.split_whitespace().map(String::from).chain(used) {
            assert!(src.contains(&format!("\"{c}\"")), "no handler for {c}");
        }
    }
}
