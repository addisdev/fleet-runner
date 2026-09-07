// The console window is a debug-build convenience on Windows and a stray black
// rectangle behind a release app, which is the one thing users report.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Fleet, the menu-bar app.
//!
//! A shell around the `fleet` CLI, and nothing more than a shell. It writes
//! `~/.fleet/config.json` -- the same file, the same schema -- keeps one
//! `fleet up` alive as a Tauri sidecar, shows the dashboard the collector
//! already serves, and turns the supervisor's `GAVE UP` line into a desktop
//! notification. Every one of those is a thing the CLI could already do and a
//! thing nobody was doing, because it needed a terminal to be open.
//!
//! What it exists for is narrower than "a GUI". `docs/deploy/networking.md`
//! records that macOS gates local-network access per application and that a
//! launchd agent has no way to ask, so the deployed fix is an SSH tunnel to
//! loopback. An app bundle can ask. Whether that grant reaches a *sidecar* is
//! unverified and is the whole bet -- see `desktop/README.md`.

mod config;
mod sidecar;
mod tray;

use tauri::menu::MenuEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

// --- commands the settings window calls -------------------------------------

#[tauri::command]
fn get_status(app: AppHandle) -> sidecar::Status {
    app.state::<sidecar::Fleet>().status()
}

#[tauri::command]
fn get_config() -> config::FleetConfig {
    config::load().0
}

/// Write the config and bring the fleet in line with it.
///
/// Restarting rather than reloading, because none of the three components has a
/// reload: a collector picks its port and its bind list at listen() and an agent
/// picks its brain at registration. A switch that changed the file and left the
/// running fleet on the old values would be the worst of both -- the settings
/// window would be telling the truth about the file and lying about the fleet.
///
/// Async so it lands on a worker: a synchronous Tauri command runs on the main
/// thread, and `stop` blocks for up to fifteen seconds waiting for the
/// collector to drain. That would freeze the menu bar and deadlock the tray
/// refresh, which needs the main thread to build a menu.
#[tauri::command]
async fn set_config(app: AppHandle, config: crate::config::FleetConfig) -> Result<(), String> {
    crate::config::save(&config)?;
    let _ = app.emit("fleet://changed", ());
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if handle.state::<sidecar::Fleet>().is_running() {
            sidecar::stop(&handle);
            sidecar::start(&handle)
        } else {
            tray::refresh(&handle);
            Ok(())
        }
    })
    .await
    .map_err(|e| format!("the restart task did not finish: {e}"))?
}

#[tauri::command]
async fn start_fleet(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::start(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn stop_fleet(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::stop(&app))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_dashboard(app: AppHandle) -> Result<(), String> {
    show_dashboard(&app)
}

// --- windows ----------------------------------------------------------------

/// The dashboard, in a webview window pointed at the collector.
///
/// Destroyed and rebuilt rather than navigated, because the port can change
/// under it: somebody moves the collector to 9000 in the settings window, and a
/// dashboard window still showing :8788 is a window full of connection errors
/// that looks like the fleet is down.
fn show_dashboard(app: &AppHandle) -> Result<(), String> {
    let (config, _) = config::load();
    let url = config::dashboard_url(&config);

    if let Some(existing) = app.get_webview_window("dashboard") {
        let _ = existing.destroy();
    }

    let parsed = url.parse().map_err(|e| format!("{url} is not a URL: {e}"))?;
    WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::External(parsed))
        .title("Fleet Dashboard")
        .inner_size(1180.0, 820.0)
        .build()
        .map_err(|e| {
            format!("the dashboard window could not be opened: {e}. The collector serves it at {url}.")
        })?;
    Ok(())
}

fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        // The window may have been hidden for hours; tell it to re-read rather
        // than showing whatever the config was when it was last visible.
        let _ = app.emit("fleet://changed", ());
    }
}

// --- notifications ----------------------------------------------------------

/// A component has stopped being restarted. Say so where somebody will see it.
///
/// This is the reason the app parses stdout at all. The supervisor's whole
/// point is that it stops pretending after enough failures in a short enough
/// window -- and that message currently goes to a log file under a launchd
/// agent, where the project's own README says "a red nightly that reaches
/// nobody is worse than no nightly".
///
/// The failure is deliberately not fatal: the tray headline says the same thing
/// and does not need permission from anybody, so a denied notification grant
/// degrades to a menu you have to look at rather than to silence.
pub fn notify_gave_up(app: &AppHandle, gave_up: &sidecar::GaveUp) {
    let _ = app
        .notification()
        .builder()
        .title(format!("{} gave up", gave_up.child))
        .body(&gave_up.detail)
        .show();
}

// --- startup ----------------------------------------------------------------

/// Is something already listening on the collector's port?
///
/// Asked before auto-starting, because `fleet service install` writes a launchd
/// unit that runs `fleet up` at login, and a person who has both that and this
/// app gets two collectors racing for one port. The second one exits with
/// `EADDRINUSE` -- which the deploy docs already call out as looking, for a
/// moment, exactly like it worked.
///
/// A bind attempt rather than an HTTP probe: it needs no dependency, it answers
/// for a half-started collector that is not serving yet, and a fleet running
/// under a different config is still a fleet this app must not fight with.
fn port_is_taken(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

fn autostart(app: &AppHandle) {
    let (config, error) = config::load();
    let state = app.state::<sidecar::Fleet>();

    if error.is_some() {
        // Defaults would start a collector on 8788 that the person did not ask
        // for. Better to sit in the menu bar saying nothing is running.
        return;
    }
    if config.roles.iter().any(|r| r == "brain") && port_is_taken(config.collector.port) {
        state.note(format!(
            "something is already listening on 127.0.0.1:{} -- not starting, so as not to fight a \
             `fleet service` unit or a `fleet up` in a terminal. Stop that one, then Start here.",
            config.collector.port
        ));
        tray::refresh(app);
        return;
    }
    if let Err(e) = sidecar::start(app) {
        state.note(e);
        tray::refresh(app);
    }
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "dashboard" => {
            if let Err(e) = show_dashboard(app) {
                app.state::<sidecar::Fleet>().note(e);
                tray::refresh(app);
            }
        }
        "settings" => show_settings(app),
        "start" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = sidecar::start(&app) {
                    app.state::<sidecar::Fleet>().note(e);
                    tray::refresh(&app);
                }
            });
        }
        "stop" => {
            let app = app.clone();
            std::thread::spawn(move || sidecar::stop(&app));
        }
        "quit" => {
            // Off the main thread, so that the fifteen seconds `stop` may spend
            // waiting for the collector to drain do not freeze the menu bar --
            // and so that the tray refreshes `stop` triggers can still get the
            // main thread they need.
            let app = app.clone();
            std::thread::spawn(move || {
                sidecar::stop(&app);
                app.exit(0);
            });
        }
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(sidecar::Fleet::default())
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_config,
            set_config,
            start_fleet,
            stop_fleet,
            open_dashboard
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                // No Dock tile, no application menu: this lives in the menu bar.
                // `LSUIElement` in Info.plist does the same thing earlier, and
                // both are set -- this call alone leaves a Dock icon that
                // appears for a moment at launch and then vanishes.
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            let handle = app.handle().clone();
            // The tray icon itself comes from `app.trayIcon` in tauri.conf.json
            // -- the path and the macOS template flag never change. Only the
            // menu is built here, because every line of it does.
            if let Some(tray) = app.tray_by_id(tray::TRAY_ID) {
                tray.set_menu(Some(tray::build(&handle)?))?;
            }
            // Registered on the app rather than on the tray so that a menu
            // rebuilt by `tray::refresh` keeps working: the handler outlives
            // any particular Menu.
            app.on_menu_event(|app, event| on_menu(app, event));

            autostart(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the settings window hides it. Destroying it would be the
            // ordinary desktop behaviour and the wrong one here: there is no
            // Dock icon to click to get it back, so a closed window would be a
            // window you can only reopen from the tray -- and a webview
            // rebuilt on every visit loses its scroll position and its
            // half-typed collector URL.
            if window.label() == "settings" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Fleet could not start")
        .run(|app, event| match event {
            // With no windows visible the app would otherwise exit the moment
            // the settings window is hidden, taking the fleet with it.
            RunEvent::ExitRequested { api, .. } => api.prevent_exit(),

            // The last chance to be polite. Anything that gets here has skipped
            // the Quit item -- a `killall Fleet`, or a logout -- so there is no
            // time to wait for a drain; the SIGTERM is sent and the supervisor
            // gets whatever the OS gives it. The Quit item is the path that
            // actually waits, which is why it exists rather than relying on
            // this.
            RunEvent::Exit => sidecar::terminate_now(app),

            _ => {}
        });
}
