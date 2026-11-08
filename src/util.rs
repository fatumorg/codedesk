use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn data_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| home().join(".config")).join("Codedesk")
}

pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        o => o,
    }
}

pub fn find_bin(name: &str) -> Option<PathBuf> {
    let key = format!("{}_PATH", name.to_uppercase().replace('-', "_"));
    if let Ok(p) = std::env::var(&key) {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let h = home();
    let user = std::env::var("USER").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend([
        h.join(".local/bin"),
        h.join(".claude/local"),
        h.join(".nix-profile/bin"),
        PathBuf::from("/run/current-system/sw/bin"),
        PathBuf::from(format!("/etc/profiles/per-user/{user}/bin")),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    dirs.into_iter().filter(|d| !d.as_os_str().is_empty()).map(|d| d.join(&file)).find(|p| p.is_file())
}

#[derive(Default)]
pub struct RunOpts {
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub timeout: Option<Duration>,
    pub stdin: Option<String>,
}

pub async fn run(cmd: impl AsRef<std::ffi::OsStr>, args: &[String], o: RunOpts) -> Value {
    let mut c = Command::new(cmd);
    c.args(args).envs(&o.env).stdin(if o.stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(d) = &o.cwd {
        c.current_dir(d);
    }
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return json!({ "code": 1, "stdout": "", "stderr": e.to_string() }),
    };
    if let (Some(input), Some(mut sin)) = (o.stdin, child.stdin.take()) {
        let _ = sin.write_all(input.as_bytes()).await;
    }
    let fut = child.wait_with_output();
    let out = match tokio::time::timeout(o.timeout.unwrap_or(Duration::from_secs(120)), fut).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return json!({ "code": 1, "stdout": "", "stderr": e.to_string() }),
        Err(_) => return json!({ "code": 1, "stdout": "", "stderr": "Timed out" }),
    };
    json!({
        "code": out.status.code().unwrap_or(1),
        "stdout": String::from_utf8_lossy(&out.stdout),
        "stderr": String::from_utf8_lossy(&out.stderr),
    })
}

pub fn read_json(p: &Path) -> Value {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}))
}

pub fn read_json_or_null(p: &Path) -> Option<Value> {
    match std::fs::read_to_string(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(json!({})),
        Err(_) => None,
        Ok(s) => serde_json::from_str(&s).ok(),
    }
}

pub fn write_json(p: &Path, v: &Value) -> std::io::Result<()> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = p.with_extension(format!("{}.tmp", uuid()));
    std::fs::write(&tmp, serde_json::to_string_pretty(v)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, p)
}

pub fn mime(file: &str) -> &'static str {
    let ext = Path::new(file).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn arg_str(args: &[Value], i: usize) -> String {
    args.get(i).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' && it.peek() == Some(&'[') {
            it.next();
            while let Some(&n) = it.peek() {
                it.next();
                if !(n.is_ascii_digit() || n == ';') {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_color_codes() {
        assert_eq!(strip_ansi("\x1b[1;32mok\x1b[0m done"), "ok done");
    }

    #[test]
    fn write_json_is_atomic_and_readable() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a/b.json");
        write_json(&p, &json!({ "x": 1 })).unwrap();
        assert_eq!(read_json(&p)["x"], 1);
        assert_eq!(std::fs::read_dir(p.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn missing_json_reads_empty_and_corrupt_reads_none() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_json_or_null(&d.path().join("nope.json")), Some(json!({})));
        std::fs::write(d.path().join("bad.json"), "{").unwrap();
        assert_eq!(read_json_or_null(&d.path().join("bad.json")), None);
    }
}
