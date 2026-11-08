use base64::Engine;
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};
pub use enigo::Key;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::Mutex;

const MAX_EDGE: u32 = 1280;

pub fn mcp_config() -> Value {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "codedesk".into());
    json!({ "mcpServers": { "computer": { "type": "stdio", "command": exe, "args": ["--computer-use-mcp"] } } })
}

pub fn scale(w: u32, h: u32, max: u32) -> (u32, u32, f64) {
    let long = w.max(h);
    if long <= max {
        return (w, h, 1.0);
    }
    let f = max as f64 / long as f64;
    ((w as f64 * f).round() as u32, (h as f64 * f).round() as u32, f)
}

pub fn parse_keys(s: &str) -> Result<Vec<Key>, String> {
    s.split('+').map(str::trim).filter(|k| !k.is_empty()).map(|k| {
        let l = k.to_ascii_lowercase();
        Ok(match l.as_str() {
            "ctrl" | "control" => Key::Control,
            "shift" => Key::Shift,
            "alt" | "option" => Key::Alt,
            "super" | "meta" | "win" | "cmd" | "command" => Key::Meta,
            "return" | "enter" => Key::Return,
            "tab" => Key::Tab,
            "esc" | "escape" => Key::Escape,
            "backspace" => Key::Backspace,
            "delete" | "del" => Key::Delete,
            "space" => Key::Space,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" | "page_up" | "prior" => Key::PageUp,
            "pagedown" | "page_down" | "next" => Key::PageDown,
            "up" | "uparrow" => Key::UpArrow,
            "down" | "downarrow" => Key::DownArrow,
            "left" | "leftarrow" => Key::LeftArrow,
            "right" | "rightarrow" => Key::RightArrow,
            "insert" => Key::Insert,
            "capslock" => Key::CapsLock,
            "f1" => Key::F1, "f2" => Key::F2, "f3" => Key::F3, "f4" => Key::F4, "f5" => Key::F5, "f6" => Key::F6,
            "f7" => Key::F7, "f8" => Key::F8, "f9" => Key::F9, "f10" => Key::F10, "f11" => Key::F11, "f12" => Key::F12,
            _ if k.chars().count() == 1 => Key::Unicode(l.chars().next().unwrap()),
            _ => return Err(format!("Unknown key: {k}")),
        })
    }).collect()
}

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({ "name": name, "description": description, "inputSchema": { "type": "object", "properties": props, "required": required } })
}

fn tools() -> Value {
    let xy = |extra: Value| {
        let mut p = json!({ "x": { "type": "number", "description": "X in screenshot pixels" }, "y": { "type": "number", "description": "Y in screenshot pixels" } });
        if let (Some(p), Some(e)) = (p.as_object_mut(), extra.as_object()) {
            p.extend(e.clone());
        }
        p
    };
    json!([
        tool("screenshot", "Capture the screen. Coordinates for other tools are in this image's pixels.", json!({}), &[]),
        tool("click", "Click at a point.", xy(json!({ "button": { "type": "string", "enum": ["left", "right", "middle"] }, "count": { "type": "integer", "minimum": 1, "maximum": 3 } })), &["x", "y"]),
        tool("move", "Move the mouse pointer to a point.", xy(json!({})), &["x", "y"]),
        tool("drag", "Press the left button at one point, move to another and release.", json!({ "from_x": { "type": "number" }, "from_y": { "type": "number" }, "to_x": { "type": "number" }, "to_y": { "type": "number" } }), &["from_x", "from_y", "to_x", "to_y"]),
        tool("scroll", "Scroll at a point.", xy(json!({ "direction": { "type": "string", "enum": ["up", "down", "left", "right"] }, "amount": { "type": "integer", "minimum": 1 } })), &["x", "y", "direction"]),
        tool("type", "Type text with the keyboard.", json!({ "text": { "type": "string" } }), &["text"]),
        tool("key", "Press a key or combination such as ctrl+s, Return or super.", json!({ "keys": { "type": "string" } }), &["keys"]),
        tool("cursor_position", "Report the pointer position in screenshot pixels.", json!({}), &[]),
    ])
}

struct Screen {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

fn monitor() -> Result<(xcap::Monitor, Screen), String> {
    let all = xcap::Monitor::all().map_err(|e| format!("Screen capture is not available here: {e}"))?;
    let m = all.iter().find(|m| m.is_primary().unwrap_or(false)).or(all.first()).cloned().ok_or("No screen found")?;
    let s = Screen { x: m.x().map_err(|e| e.to_string())?, y: m.y().map_err(|e| e.to_string())?, w: m.width().map_err(|e| e.to_string())?, h: m.height().map_err(|e| e.to_string())? };
    Ok((m, s))
}

fn factor() -> Result<(Screen, f64), String> {
    let (_, s) = monitor()?;
    let f = scale(s.w, s.h, MAX_EDGE).2;
    Ok((s, f))
}

static INPUT: Mutex<Option<Enigo>> = Mutex::new(None);

fn input<T>(f: impl FnOnce(&mut Enigo) -> Result<T, String>) -> Result<T, String> {
    let mut g = INPUT.lock().unwrap();
    if g.is_none() {
        *g = Some(Enigo::new(&Settings::default()).map_err(|e| format!("Mouse and keyboard control is not available here: {e}"))?);
    }
    f(g.as_mut().unwrap())
}

fn num(a: &Value, k: &str) -> Result<f64, String> {
    a[k].as_f64().ok_or_else(|| format!("Missing number: {k}"))
}

fn to_real(a: &Value, kx: &str, ky: &str) -> Result<(i32, i32), String> {
    let (x, y) = (num(a, kx)?, num(a, ky)?);
    let (s, f) = factor()?;
    Ok((s.x + (x / f).round() as i32, s.y + (y / f).round() as i32))
}

fn ok_text(t: String) -> Value {
    json!({ "content": [{ "type": "text", "text": t }] })
}

fn call(name: &str, a: &Value) -> Result<Value, String> {
    let e = |r: enigo::InputResult<()>| r.map_err(|e| e.to_string());
    match name {
        "screenshot" => {
            let (m, s) = monitor()?;
            let img = m.capture_image().map_err(|e| format!("Screen capture failed: {e}"))?;
            let (w, h, _) = scale(img.width(), img.height(), MAX_EDGE);
            let img = if (w, h) == (img.width(), img.height()) { img } else { xcap::image::imageops::resize(&img, w, h, xcap::image::imageops::FilterType::Triangle) };
            let mut png = std::io::Cursor::new(Vec::new());
            img.write_to(&mut png, xcap::image::ImageFormat::Png).map_err(|e| e.to_string())?;
            Ok(json!({ "content": [
                { "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(png.into_inner()), "mimeType": "image/png" },
                { "type": "text", "text": format!("Screenshot {w}x{h} (screen {}x{})", s.w, s.h) },
            ] }))
        }
        "click" => {
            let (x, y) = to_real(a, "x", "y")?;
            let button = match a["button"].as_str().unwrap_or("left") {
                "right" => Button::Right,
                "middle" => Button::Middle,
                _ => Button::Left,
            };
            let count = a["count"].as_u64().unwrap_or(1).clamp(1, 3);
            input(|en| {
                e(en.move_mouse(x, y, Coordinate::Abs))?;
                for _ in 0..count {
                    e(en.button(button, Direction::Click))?;
                }
                Ok(())
            })?;
            Ok(ok_text(format!("Clicked {} time(s) at ({}, {})", count, a["x"], a["y"])))
        }
        "move" => {
            let (x, y) = to_real(a, "x", "y")?;
            input(|en| e(en.move_mouse(x, y, Coordinate::Abs)))?;
            Ok(ok_text(format!("Moved to ({}, {})", a["x"], a["y"])))
        }
        "drag" => {
            let (fx, fy) = to_real(a, "from_x", "from_y")?;
            let (tx, ty) = to_real(a, "to_x", "to_y")?;
            input(|en| {
                e(en.move_mouse(fx, fy, Coordinate::Abs))?;
                e(en.button(Button::Left, Direction::Press))?;
                for i in 1..=10 {
                    e(en.move_mouse(fx + (tx - fx) * i / 10, fy + (ty - fy) * i / 10, Coordinate::Abs))?;
                    std::thread::sleep(std::time::Duration::from_millis(15));
                }
                e(en.button(Button::Left, Direction::Release))
            })?;
            Ok(ok_text("Dragged".into()))
        }
        "scroll" => {
            let (x, y) = to_real(a, "x", "y")?;
            let amount = a["amount"].as_i64().unwrap_or(3).max(1) as i32;
            let (len, axis) = match a["direction"].as_str().unwrap_or("down") {
                "up" => (-amount, Axis::Vertical),
                "left" => (-amount, Axis::Horizontal),
                "right" => (amount, Axis::Horizontal),
                _ => (amount, Axis::Vertical),
            };
            input(|en| {
                e(en.move_mouse(x, y, Coordinate::Abs))?;
                e(en.scroll(len, axis))
            })?;
            Ok(ok_text(format!("Scrolled {} by {amount}", a["direction"].as_str().unwrap_or("down"))))
        }
        "type" => {
            let t = a["text"].as_str().ok_or("Missing text")?;
            input(|en| e(en.text(t)))?;
            Ok(ok_text(format!("Typed {} characters", t.chars().count())))
        }
        "key" => {
            let keys = parse_keys(a["keys"].as_str().ok_or("Missing keys")?)?;
            input(|en| {
                for k in &keys {
                    e(en.key(*k, Direction::Press))?;
                }
                for k in keys.iter().rev() {
                    e(en.key(*k, Direction::Release))?;
                }
                Ok(())
            })?;
            Ok(ok_text(format!("Pressed {}", a["keys"].as_str().unwrap_or_default())))
        }
        "cursor_position" => {
            let (x, y) = input(|en| en.location().map_err(|e| e.to_string()))?;
            let (s, f) = factor()?;
            Ok(ok_text(format!("{}, {}", ((x - s.x) as f64 * f).round(), ((y - s.y) as f64 * f).round())))
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}

pub fn handle(msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let result = match msg["method"].as_str().unwrap_or_default() {
        "initialize" => json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "codedesk-computer", "version": env!("CARGO_PKG_VERSION") },
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let p = &msg["params"];
            match call(p["name"].as_str().unwrap_or_default(), &p["arguments"]) {
                Ok(v) => v,
                Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
            }
        }
        m => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {m}") } })),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

pub fn run_mcp_stdio() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(r) = handle(&msg) {
            if writeln!(out, "{r}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initialize_reports_server_info_and_tools() {
        let r = handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })).unwrap();
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["serverInfo"]["name"], "codedesk-computer");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert!(handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        assert_eq!(handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "nope" })).unwrap()["error"]["code"], -32601);
    }

    #[test]
    fn tools_list_names_every_tool_with_a_schema() {
        let r = handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).unwrap();
        let tools = r["result"]["tools"].as_array().unwrap();
        let names: Vec<_> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["screenshot", "click", "move", "drag", "scroll", "type", "key", "cursor_position"]);
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object" && t["description"].is_string()));
    }

    #[test]
    fn screenshots_scale_the_long_edge_to_1280() {
        assert_eq!(scale(2560, 1440, 1280), (1280, 720, 0.5));
        assert_eq!(scale(1000, 3000, 1280), (427, 1280, 1280.0 / 3000.0));
        assert_eq!(scale(800, 600, 1280), (800, 600, 1.0));
    }

    #[test]
    fn key_combos_parse_to_modifiers_then_key() {
        assert_eq!(parse_keys("ctrl+s").unwrap(), [Key::Control, Key::Unicode('s')]);
        assert_eq!(parse_keys("Return").unwrap(), [Key::Return]);
        assert_eq!(parse_keys("super").unwrap(), [Key::Meta]);
        assert_eq!(parse_keys("ctrl+shift+Tab").unwrap(), [Key::Control, Key::Shift, Key::Tab]);
        assert_eq!(parse_keys("F5").unwrap(), [Key::F5]);
        assert!(parse_keys("ctrl+nosuchkey").is_err());
    }

    #[test]
    fn bad_arguments_become_error_results() {
        let r = handle(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "click", "arguments": {} } })).unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("x"));
        let r = handle(&json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "fly", "arguments": {} } })).unwrap();
        assert_eq!(r["result"]["isError"], true);
    }
}
