use std::path::Path;
use tauri::Manager;

const SVG: &str = include_str!("../ui/icons/icon.svg");

pub fn icon_svg(accent: &str) -> Result<String, String> {
    let hex = accent.strip_prefix('#').filter(|h| matches!(h.len(), 3 | 6) && h.chars().all(|c| c.is_ascii_hexdigit()));
    if hex.is_none() {
        return Err(format!("Not a color: {accent}"));
    }
    Ok(SVG.replace(r##"stroke="#d97757""##, &format!(r#"stroke="{accent}""#)))
}

pub fn render_png(svg: &str, size: u32) -> Result<Vec<u8>, String> {
    let tree = resvg::usvg::Tree::from_str(svg, &Default::default()).map_err(|e| e.to_string())?;
    let mut pix = resvg::tiny_skia::Pixmap::new(size, size).ok_or("Bad icon size")?;
    let s = size as f32 / tree.size().width().max(tree.size().height());
    resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(s, s), &mut pix.as_mut());
    pix.encode_png().map_err(|e| e.to_string())
}

fn write_if_changed(p: &Path, bytes: &[u8]) -> Result<bool, String> {
    if std::fs::read(p).ok().as_deref() == Some(bytes) {
        return Ok(false);
    }
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, p)).map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn write_launcher_icons(data: &Path, accent: &str) -> Result<(), String> {
    let svg = icon_svg(accent)?;
    let root = data.join("icons/hicolor");
    let a = write_if_changed(&root.join("scalable/apps/codedesk.svg"), svg.as_bytes())?;
    let b = write_if_changed(&root.join("512x512/apps/codedesk.png"), &render_png(&svg, 512)?)?;
    if a || b {
        if let Ok(d) = std::fs::File::open(&root) {
            let _ = d.set_modified(std::time::SystemTime::now());
        }
    }
    Ok(())
}

pub fn set_icon(accent: &str) -> Result<(), String> {
    let png = render_png(&icon_svg(accent)?, 256)?;
    let app = crate::core::core().app();
    for w in app.webview_windows().values() {
        if let Ok(img) = tauri::image::Image::from_bytes(&png) {
            let _ = w.set_icon(img);
        }
    }
    if cfg!(target_os = "linux") {
        if let Some(data) = dirs::data_dir() {
            write_launcher_icons(&data, accent)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chevron_takes_the_accent_color() {
        let s = icon_svg("#3366ff").unwrap();
        assert!(s.contains(r##"stroke="#3366ff""##));
        assert!(!s.contains("#d97757"));
        assert!(icon_svg("#abc").is_ok());
        for bad in ["red", "#12345", "#gggggg", "\"/><script>", "#3366ff\" onload=\"x"] {
            assert!(icon_svg(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn renders_a_png_at_512() {
        let png = render_png(&icon_svg("#3366ff").unwrap(), 512).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 512);
    }

    #[test]
    fn writes_launcher_icons_into_the_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        write_launcher_icons(dir.path(), "#3366ff").unwrap();
        let svg = std::fs::read_to_string(dir.path().join("icons/hicolor/scalable/apps/codedesk.svg")).unwrap();
        assert!(svg.contains("#3366ff"));
        assert!(dir.path().join("icons/hicolor/512x512/apps/codedesk.png").exists());
    }
}
