//! macOS menu bar: a live gauge glyph and the popover panel it opens.
//!
//! The glyph is a template image (one color, alpha only), so macOS tints it for light and
//! dark menu bars. Its arc fills with the serving account's weekly usage; a dashed track
//! means the core is stopped. The main window's routing controller reports both through
//! `set_tray_gauge`, and the icon is only redrawn when the rounded value changes.
//!
//! Left click toggles the "tray" webview window (the popover); right click shows the
//! native Open/Quit menu. The popover hides itself when it loses focus.

use super::*;

pub(crate) const TRAY_PANEL_LABEL: &str = "tray";
const PANEL_WIDTH: f64 = 340.0;
const PANEL_GAP: f64 = 6.0;
/// Template images are drawn at 2x the 18pt menu bar glyph.
const GLYPH_PX: u32 = 36;
/// A click this soon after the panel hid on blur is the same click that blurred it.
const REOPEN_GUARD: Duration = Duration::from_millis(350);

#[derive(Clone, Copy, PartialEq)]
pub(crate) struct GaugeState {
    /// Used percent of the serving account's week in 2% steps; None while the core is stopped.
    filled: Option<u8>,
}

#[derive(Default)]
pub(crate) struct MenubarState {
    gauge: Mutex<Option<GaugeState>>,
    panel_hidden_at: Mutex<Option<Instant>>,
}

/// Renders the gauge glyph as RGBA. `filled` is 0..=100, None draws the stopped state.
pub(crate) fn gauge_glyph(filled: Option<u8>) -> Vec<u8> {
    const SAMPLES: u32 = 4;
    let size = GLYPH_PX as f64;
    let (cx, cy, radius) = (size / 2.0, size * 0.555, size * 0.361);
    let width = if filled.is_some() { size * 0.111 } else { size * 0.089 };
    let sweep = 270.0_f64;
    let fill_end = filled.map(|pct| sweep * f64::from(pct.min(100)) / 100.0);
    let point_at = |t: f64| {
        let angle = (135.0 + t).to_radians();
        (cx + radius * angle.cos(), cy + radius * angle.sin())
    };
    let near = |x: f64, y: f64, (px, py): (f64, f64)| (x - px).hypot(y - py) <= width / 2.0;

    let mut rgba = vec![0u8; (GLYPH_PX * GLYPH_PX * 4) as usize];
    for py in 0..GLYPH_PX {
        for px in 0..GLYPH_PX {
            let mut alpha = 0.0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let x = f64::from(px) + (f64::from(sx) + 0.5) / f64::from(SAMPLES);
                    let y = f64::from(py) + (f64::from(sy) + 0.5) / f64::from(SAMPLES);
                    let t = ((y - cy).atan2(x - cx).to_degrees() - 135.0).rem_euclid(360.0);
                    let on_ring = ((x - cx).hypot(y - cy) - radius).abs() <= width / 2.0;
                    let on_track = (on_ring && t <= sweep) || near(x, y, point_at(0.0)) || near(x, y, point_at(sweep));
                    let sample = match fill_end {
                        Some(end) => {
                            let on_fill = (on_ring && t <= end) || (end > 0.0 && (near(x, y, point_at(0.0)) || near(x, y, point_at(end))));
                            let on_dot = (x - cx).hypot(y - cy) <= size * 0.072;
                            if on_fill || on_dot { 1.0 } else if on_track { 0.35 } else { 0.0 }
                        }
                        None => {
                            // Dashes along the arc: 3.2px on, 4.4px off.
                            let along = t.to_radians() * radius;
                            if on_ring && t <= sweep && along.rem_euclid(7.6) < 3.2 { 0.6 } else { 0.0 }
                        }
                    };
                    alpha += sample;
                }
            }
            let index = ((py * GLYPH_PX + px) * 4) as usize;
            rgba[index + 3] = (alpha / f64::from(SAMPLES * SAMPLES) * 255.0).round() as u8;
        }
    }
    rgba
}

pub(crate) fn apply_gauge(tray: &TrayIcon<tauri::Wry>, state: GaugeState) -> tauri::Result<()> {
    tray.set_icon(Some(tauri::image::Image::new_owned(gauge_glyph(state.filled), GLYPH_PX, GLYPH_PX)))?;
    tray.set_icon_as_template(true)
}

/// Called by the main window after every routing tick and core status change.
#[tauri::command]
pub(crate) fn set_tray_gauge(app: tauri::AppHandle, week_pct: Option<f64>, running: bool) -> Result<(), String> {
    let next = GaugeState {
        filled: running.then(|| ((week_pct.unwrap_or(0.0).clamp(0.0, 100.0) / 2.0).round() * 2.0) as u8),
    };
    let state = app.state::<MenubarState>();
    let mut current = state.gauge.lock().map_err(|_| "Menu bar state is unavailable".to_string())?;
    if *current == Some(next) {
        return Ok(());
    }
    if let Some(tray) = app.tray_by_id(MACOS_TRAY_ID) {
        apply_gauge(&tray, next).map_err(|error| format!("Failed to update the menu bar icon: {error}"))?;
    }
    *current = Some(next);
    Ok(())
}

/// Creates the hidden popover window once, at startup, so the first click opens instantly.
pub(crate) fn create_tray_panel(app: &tauri::AppHandle) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(app, TRAY_PANEL_LABEL, tauri::WebviewUrl::App("index.html".into()))
        .title("CPA Desk")
        .inner_size(PANEL_WIDTH, 420.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    Ok(())
}

/// Shows the popover centred under the menu bar icon, or hides it if it's open.
pub(crate) fn toggle_tray_panel(app: &tauri::AppHandle, icon: tauri::Rect) {
    let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) else {
        return;
    };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    let just_hid = app
        .state::<MenubarState>()
        .panel_hidden_at
        .lock()
        .ok()
        .and_then(|hidden| *hidden)
        .is_some_and(|at| at.elapsed() < REOPEN_GUARD);
    if just_hid {
        return;
    }
    let scale = panel.scale_factor().unwrap_or(2.0);
    let position = icon.position.to_physical::<f64>(scale);
    let size = icon.size.to_physical::<f64>(scale);
    let width = PANEL_WIDTH * scale;
    let mut x = position.x + size.width / 2.0 - width / 2.0;
    if let Ok(Some(monitor)) = panel.current_monitor() {
        let right = f64::from(monitor.position().x) + f64::from(monitor.size().width);
        x = x.min(right - width - 8.0 * scale).max(f64::from(monitor.position().x) + 8.0 * scale);
    }
    let y = position.y + size.height + PANEL_GAP * scale;
    let _ = panel.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = panel.show();
    let _ = panel.set_focus();
}

/// Window-event hook: the popover closes as soon as it loses focus, like a native popover.
pub(crate) fn on_tray_panel_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::Focused(false) = event {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            if let Ok(mut hidden) = window.state::<MenubarState>().panel_hidden_at.lock() {
                *hidden = Some(Instant::now());
            }
        }
    }
}

/// The popover sizes itself to its content.
#[tauri::command]
pub(crate) fn resize_tray_panel(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    let panel = app.get_webview_window(TRAY_PANEL_LABEL).ok_or("Menu bar panel is missing")?;
    panel
        .set_size(tauri::LogicalSize::new(PANEL_WIDTH, height.clamp(120.0, 720.0)))
        .map_err(|error| format!("Failed to resize the menu bar panel: {error}"))
}

#[tauri::command]
pub(crate) fn open_main_window(app: tauri::AppHandle) {
    if let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) {
        let _ = panel.hide();
    }
    show_main_window(&app);
}

#[tauri::command]
pub(crate) fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha(rgba: &[u8], x: u32, y: u32) -> u8 {
        rgba[((y * GLYPH_PX + x) * 4 + 3) as usize]
    }

    #[test]
    fn gauge_fill_follows_usage() {
        // Top of the arc (about 55% along) is solid when 80% is used and faint when 20% is.
        let top = (GLYPH_PX / 2, (GLYPH_PX as f64 * (0.555 - 0.361)).round() as u32);
        assert!(alpha(&gauge_glyph(Some(80)), top.0, top.1) > 200);
        let faint = alpha(&gauge_glyph(Some(20)), top.0, top.1);
        assert!(faint > 40 && faint < 130, "track should be translucent, got {faint}");
        // Stopped: no center dot.
        assert_eq!(alpha(&gauge_glyph(None), GLYPH_PX / 2, (GLYPH_PX as f64 * 0.555) as u32), 0);
        assert!(alpha(&gauge_glyph(Some(0)), GLYPH_PX / 2, (GLYPH_PX as f64 * 0.555) as u32) > 200);
    }
}
