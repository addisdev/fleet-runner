//! The menu-bar item: what the fleet is doing, and the four things to do to it.
//!
//! The menu is rebuilt from scratch on every refresh rather than holding onto
//! `MenuItem` handles and calling `set_text` on them. It is seven items and it
//! changes at most once a second, so the cost is nothing, and the alternative
//! is a set of handles that have to be kept in managed state and stay valid
//! across a tray that macOS may have rebuilt underneath us. Rebuilding is the
//! version that cannot go stale.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager, Runtime};

/// The id in `tauri.conf.json`'s `app.trayIcon`. The icon and its template flag
/// stay in the config -- they never change -- and only the menu is built here.
pub const TRAY_ID: &str = "fleet";

pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    // Menus are main-thread objects on macOS. This is called from the sidecar's
    // output pump, which is not the main thread, so hopping is not optional --
    // building a menu off it is a crash, not a warning.
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            if let Ok(menu) = build(&app) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    });
}

/// One line saying what the fleet is, at the top of the menu, disabled.
///
/// Disabled because it is a readout and not a command; a menu item that looks
/// clickable and does nothing is worse than one that is visibly not.
fn headline<R: Runtime>(app: &AppHandle<R>) -> String {
    let status = app.state::<crate::sidecar::Fleet>().status();

    if !status.gave_up.is_empty() {
        let names: Vec<&str> = status.gave_up.iter().map(|g| g.child.as_str()).collect();
        return format!("{} gave up -- see the logs", names.join(", "));
    }
    if !status.running {
        return "Not running".into();
    }
    let uptime = match status.uptime_s {
        Some(s) if s < 90 => format!("up {s}s"),
        Some(s) if s < 5400 => format!("up {}m", s / 60),
        Some(s) => format!("up {}h", s / 3600),
        None => "up".into(),
    };
    format!("{}  ·  :{}  ·  {}", status.roles.join(", "), status.port, uptime)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let running = app.state::<crate::sidecar::Fleet>().is_running();

    let status = MenuItem::with_id(app, "status", headline(app), false, None::<&str>)?;
    let dash = MenuItem::with_id(app, "dashboard", "Open Dashboard", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    // Both items are always present and one of them is always disabled, rather
    // than a single item whose label flips between Start and Stop. A label that
    // changes under the cursor is how you click Stop meaning Start.
    let start = MenuItem::with_id(app, "start", "Start", !running, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop", running, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Fleet", true, Some("Cmd+Q"))?;

    Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &dash,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &start,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}
