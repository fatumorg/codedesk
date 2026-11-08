use crate::hub::Client;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{LazyLock, Mutex};

struct Term {
    client: Client,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    gen: u64,
}

static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

static TERMS: LazyLock<Mutex<HashMap<String, Term>>> = LazyLock::new(Default::default);

fn key(client: &Client, id: &str) -> String {
    format!("{}:{id}", client.id)
}

pub fn shell() -> CommandBuilder {
    if cfg!(windows) {
        let mut c = CommandBuilder::new("powershell.exe");
        c.arg("-NoLogo");
        c
    } else {
        let sh = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).map(std::path::PathBuf::from).or_else(|| crate::util::find_bin("bash")).or_else(|| crate::util::find_bin("sh")).unwrap_or_else(|| "/bin/sh".into());
        let mut c = CommandBuilder::new(sh);
        c.args(["-il"]);
        c
    }
}

pub fn start(client: &Client, id: &str, cwd: &str, cols: u16, rows: u16, mut cmd: CommandBuilder) -> Result<(), String> {
    let pair = native_pty_system().openpty(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let k = key(client, id);
    let gen = GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if let Some(mut old) = TERMS.lock().unwrap().insert(k.clone(), Term { client: client.clone(), master: pair.master, writer, child, gen }) {
        let _ = old.child.kill();
    }
    let (c, id) = (client.clone(), id.to_string());
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut rest: Vec<u8> = vec![];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            rest.extend_from_slice(&buf[..n]);
            let cut = match std::str::from_utf8(&rest) {
                Ok(_) => rest.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => rest.len(),
            };
            let chunk: Vec<u8> = rest.drain(..cut).collect();
            if c.alive() && !chunk.is_empty() {
                c.send("term:data", json!({ "id": id, "data": String::from_utf8_lossy(&chunk) }));
            }
        }
        let mine = {
            let mut t = TERMS.lock().unwrap();
            match t.get(&k) {
                Some(term) if term.gen == gen => t.remove(&k).is_some(),
                Some(_) => false,
                None => true,
            }
        };
        if mine && c.alive() {
            c.send("term:exit", json!({ "id": id }));
        }
    });
    Ok(())
}

pub fn write(client: &Client, id: &str, data: &str) {
    if let Some(t) = TERMS.lock().unwrap().get_mut(&key(client, id)) {
        let _ = t.writer.write_all(data.as_bytes());
    }
}

pub fn resize(client: &Client, id: &str, cols: u16, rows: u16) {
    if let Some(t) = TERMS.lock().unwrap().get(&key(client, id)) {
        let _ = t.master.resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 });
    }
}

pub fn kill(client: &Client, id: &str) {
    if let Some(t) = TERMS.lock().unwrap().get_mut(&key(client, id)) {
        let _ = t.child.kill();
    }
}

pub fn kill_where(pred: impl Fn(&Client) -> bool) {
    let mut t = TERMS.lock().unwrap();
    t.retain(|_, term| {
        let dead = pred(&term.client);
        if dead {
            let _ = term.child.kill();
        }
        !dead
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::Duration;

    #[test]
    fn a_terminal_runs_commands_resizes_and_reports_exit() {
        let (tx, rx) = std::sync::mpsc::channel::<(String, Value)>();
        let tx = Mutex::new(tx);
        let c = Client::new("wterm", move |ch, d| {
            let _ = tx.lock().unwrap().send((ch.to_string(), d));
        }, || true);
        let mut sh = CommandBuilder::new("/bin/sh");
        sh.env("PS1", "$ ");
        start(&c, "t1", "/tmp", 80, 24, sh).unwrap();
        resize(&c, "t1", 100, 30);
        write(&c, "t1", "stty size; echo hi-$((40+2))\n");
        let mut out = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !(out.contains("30 100") && out.contains("hi-42")) {
            let (ch, d) = rx.recv_timeout(deadline - std::time::Instant::now()).expect("output");
            assert_eq!(ch, "term:data");
            assert_eq!(d["id"], "t1");
            out.push_str(d["data"].as_str().unwrap());
        }
        write(&c, "t1", "exit\n");
        loop {
            let (ch, _) = rx.recv_timeout(Duration::from_secs(5)).expect("exit");
            if ch == "term:exit" {
                break;
            }
        }
        assert!(!TERMS.lock().unwrap().contains_key("wterm:t1"));
    }
}
