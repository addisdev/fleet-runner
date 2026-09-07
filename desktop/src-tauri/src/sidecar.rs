//! `fleet up`, as a child process this app keeps.
//!
//! ## Why a sidecar and not a supervisor
//!
//! `fleet/src/supervisor.ts` already restarts with a backoff, rotates the logs,
//! and -- the part nothing else does -- gives up after enough failures in a
//! short enough window instead of restarting a broken collector every ten
//! seconds forever. Reimplementing that in Rust would mean two supervisors with
//! two backoff curves, and the desktop one would be the one nobody tested.
//!
//! So this process supervises exactly one child, `fleet up`, and reads its
//! stdout. That is the same division the CLI's own comment describes for
//! launchd: the outer thing is good at "start it and restart it if it dies",
//! the inner thing is good at knowing what its three children are for.
//!
//! ## The one thing that has to be right
//!
//! Stopping. `CommandChild::kill()` in tauri-plugin-shell is a SIGKILL, and a
//! SIGKILLed `fleet up` never runs the `shutdown()` in cli.ts, so it never
//! calls `supervisor.stop()`, so the collector is never asked to stand down and
//! dies with sockets open and its SQLite database mid-write. Quitting the menu
//! bar app must not be worse than closing a terminal. So `stop()` below sends
//! SIGTERM by pid and waits, and the SIGKILL is only the admission that
//! something is wedged.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// How long to let `fleet up` drain before killing it.
///
/// Its own supervisor gives each child 10s of SIGTERM grace before SIGKILLing
/// it, because a component handles SIGTERM at its next loop boundary and for a
/// running job that means finishing it. A parent that gave up sooner than the
/// child it is waiting for would make the child's grace period a fiction.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(15);

/// Lines of `fleet up` output kept for the settings window.
///
/// Enough to show why the last start failed, not enough to be a log viewer --
/// the real logs are per-component files in `~/.fleet/logs` and the GAVE UP
/// message names the one to open.
const SCROLLBACK: usize = 200;

#[derive(Default)]
pub struct Fleet {
    child: Mutex<Option<CommandChild>>,
    /// Whether the child is up. An atomic rather than a lock because `stop`
    /// polls it from a blocking thread while the output pump clears it, and a
    /// mutex there would be a lock held across a sleep.
    alive: AtomicBool,
    started_at: Mutex<Option<Instant>>,
    lines: Mutex<Vec<String>>,
    /// Components that have stopped being restarted, and why. Cleared on start,
    /// because a component that gave up an hour ago and has since been started
    /// again is not a component that is down.
    gave_up: Mutex<Vec<GaveUp>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GaveUp {
    pub child: String,
    pub detail: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Status {
    pub running: bool,
    pub pid: Option<u32>,
    pub uptime_s: Option<u64>,
    pub roles: Vec<String>,
    pub port: u16,
    pub dashboard: String,
    pub collectors: Vec<String>,
    pub gave_up: Vec<GaveUp>,
    pub lines: Vec<String>,
    pub config_path: String,
    pub log_dir: String,
    /// Set when config.json is on disk but unreadable. The settings window says
    /// so rather than showing defaults that are not what `fleet up` will read.
    pub config_error: Option<String>,
}

impl Fleet {
    pub fn is_running(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Everything the tray and the settings window render from, in one read.
    ///
    /// The config half is re-read from disk each time rather than cached, so
    /// that a `fleet config set` in a terminal shows up in the menu without
    /// this app having to watch the file. It is a few hundred bytes.
    pub fn status(&self) -> Status {
        let (config, config_error) = crate::config::load();
        Status {
            running: self.is_running(),
            pid: self.child.lock().ok().and_then(|c| c.as_ref().map(|c| c.pid())),
            uptime_s: self
                .started_at
                .lock()
                .ok()
                .and_then(|s| *s)
                .map(|t| t.elapsed().as_secs()),
            roles: config.roles.clone(),
            port: config.collector.port,
            dashboard: crate::config::dashboard_url(&config),
            collectors: crate::config::agent_collectors(&config),
            gave_up: self.gave_up.lock().map(|g| g.clone()).unwrap_or_default(),
            lines: self.lines.lock().map(|l| l.clone()).unwrap_or_default(),
            config_path: crate::config::config_path().display().to_string(),
            log_dir: crate::config::log_dir().display().to_string(),
            config_error,
        }
    }

    /// Put something in the scrollback that did not come from the child.
    ///
    /// Refusals to start belong in the same list as the supervisor's own
    /// output. "Nothing is running and the menu does not say why" is the state
    /// this whole app is supposed to make impossible.
    pub fn note(&self, line: String) {
        self.push_line(line);
    }

    fn push_line(&self, line: String) {
        if let Ok(mut lines) = self.lines.lock() {
            lines.push(line);
            let overflow = lines.len().saturating_sub(SCROLLBACK);
            if overflow > 0 {
                lines.drain(0..overflow);
            }
        }
    }
}

/// Start `fleet up`, if it is not already running.
///
/// No `--role` and no `--port`. Those flags exist in the CLI so that trying a
/// port is not the same as configuring one, and this app is the configuring
/// half: it writes config.json and lets `fleet up` read it. Passing the roles
/// on the command line as well would mean the switches in the settings window
/// and the file on disk could disagree, and the file would be the one that
/// looked wrong.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Fleet>();
    if state.is_running() {
        return Ok(());
    }

    let command = app
        .shell()
        .sidecar("fleet")
        .map_err(|e| format!("the bundled fleet binary is missing or unusable: {e}"))?
        .args(["up"]);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("fleet up could not be started: {e}"))?;

    let pid = child.pid();
    state.alive.store(true, Ordering::SeqCst);
    *state.child.lock().map_err(|_| "sidecar lock poisoned")? = Some(child);
    *state.started_at.lock().map_err(|_| "sidecar lock poisoned")? = Some(Instant::now());
    if let Ok(mut g) = state.gave_up.lock() {
        g.clear();
    }
    if let Ok(mut l) = state.lines.lock() {
        l.clear();
    }
    state.push_line(format!("fleet up started, pid {pid}"));

    let pump = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = pump;
        while let Some(event) = rx.recv().await {
            match event {
                // The supervisor's own event lines: `start`, `exit`, and the
                // GAVE UP that goes to stderr. The components' output is piped
                // to files by the supervisor and never appears here, which is
                // why this can be parsed at all.
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    for line in split_lines(&bytes) {
                        on_line(&app, line);
                    }
                }
                CommandEvent::Error(message) => {
                    on_line(&app, format!("fleet up: {message}"));
                }
                CommandEvent::Terminated(payload) => {
                    let how = match (payload.code, payload.signal) {
                        (_, Some(sig)) => format!("signal {sig}"),
                        (Some(code), _) => format!("code {code}"),
                        _ => "unknown".into(),
                    };
                    finish(&app, &format!("fleet up exited ({how})"));
                    break;
                }
                _ => {}
            }
        }
        // Belt and braces: an event stream that ends without a Terminated event
        // still means the child is gone, and a tray that says "running" over a
        // dead process is worse than one that says nothing.
        finish(&app, "fleet up: output stream closed");
    });

    let _ = app.emit("fleet://changed", ());
    crate::tray::refresh(app);
    Ok(())
}

/// One line of `fleet up` output: remember it, and raise a notification if it
/// is the line that means a component is down for good.
fn on_line(app: &AppHandle, line: String) {
    let state = app.state::<Fleet>();
    state.push_line(line.clone());

    if let Some(gave_up) = parse_gave_up(&line) {
        if let Ok(mut g) = state.gave_up.lock() {
            g.push(gave_up.clone());
        }
        crate::notify_gave_up(app, &gave_up);
    }
    let _ = app.emit("fleet://changed", ());
    crate::tray::refresh(app);
}

fn finish(app: &AppHandle, why: &str) {
    let state = app.state::<Fleet>();
    if !state.alive.swap(false, Ordering::SeqCst) {
        return;
    }
    state.push_line(why.to_string());
    if let Ok(mut c) = state.child.lock() {
        // Take and drop, never kill. The process is already reaped, and a
        // `kill()` on a reaped pid can land on whatever the OS handed the
        // number to next. Dropping a CommandChild signals nothing, which is
        // exactly what is wanted here.
        let _ = c.take();
    }
    if let Ok(mut s) = state.started_at.lock() {
        *s = None;
    }
    let _ = app.emit("fleet://changed", ());
    crate::tray::refresh(app);
}

/// Ask `fleet up` to stand down, and wait for it.
///
/// Blocking, on purpose: the caller is either the Quit menu item or a config
/// change that is about to restart the fleet, and both are cases where
/// returning before the old collector has let go of the port produces an
/// `EADDRINUSE` on the next start that looks like the app is broken.
pub fn stop(app: &AppHandle) {
    let state = app.state::<Fleet>();
    let child = match state.child.lock() {
        Ok(mut c) => c.take(),
        Err(_) => None,
    };
    let Some(child) = child else {
        state.alive.store(false, Ordering::SeqCst);
        return;
    };

    let pid = child.pid();
    terminate(pid);

    let deadline = Instant::now() + DRAIN_TIMEOUT;
    while state.alive.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }

    if state.alive.load(Ordering::SeqCst) {
        // Past the point where waiting is patience rather than hanging. The
        // collector's database may be mid-write; say so in the scrollback so
        // that a later "database is locked" has something to be traced to.
        state.push_line(format!("fleet up (pid {pid}) did not stop within {DRAIN_TIMEOUT:?}; killing it"));
        let _ = child.kill();
        state.alive.store(false, Ordering::SeqCst);
    } else {
        // The child is already reaped; `child` is only dropped here, never
        // killed. Dropping a CommandChild does not signal the process.
        drop(child);
    }

    if let Ok(mut s) = state.started_at.lock() {
        *s = None;
    }
    let _ = app.emit("fleet://changed", ());
    crate::tray::refresh(app);
}

/// SIGTERM and return, without waiting.
///
/// For `RunEvent::Exit` only: the process is already unwinding and there is
/// nothing left to wait with. A `fleet up` that gets this has whatever time the
/// OS gives it to drain, which is better than the nothing it gets today when
/// somebody force-quits a terminal -- but it is not the Quit menu item, which
/// waits, and it is not a substitute for it.
pub fn terminate_now(app: &AppHandle) {
    let state = app.state::<Fleet>();
    let child = state.child.lock().ok().and_then(|mut c| c.take());
    if let Some(child) = child {
        terminate(child.pid());
    }
    state.alive.store(false, Ordering::SeqCst);
}

/// SIGTERM, by pid.
///
/// tauri-plugin-shell has no graceful stop -- `CommandChild::kill()` is
/// `Child::kill()`, which is SIGKILL on unix. This is the whole reason `libc`
/// is a dependency.
#[cfg(unix)]
fn terminate(pid: u32) {
    // Safety: `kill` with a pid this process owns and a signal number from
    // libc. The worst case for a stale pid is ESRCH, which is ignored.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

/// Windows has no SIGTERM, and `fleet up`'s shutdown hangs off `process.on`,
/// which never fires for a `TerminateProcess`. Documented rather than faked:
/// the honest fix is a control message the CLI listens for, and neither this
/// app nor the CLI has been run on Windows at all.
#[cfg(not(unix))]
fn terminate(_pid: u32) {}

/// Split a chunk of child output into lines.
///
/// tauri-plugin-shell emits line by line today, but a chunk that ever arrives
/// split mid-line would drop exactly one GAVE UP -- the message this app exists
/// to surface -- so the split happens here rather than being assumed.
fn split_lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .split('\n')
        .map(|l| l.trim_end_matches('\r').trim_end().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// `12:00:00  brain: GAVE UP -- 5 failures in quick succession; ...`
///
/// Matched on the literal the CLI prints (`cli.ts`, the `up` command's
/// `onEvent`) rather than by a regex over the timestamp, because the timestamp
/// format is incidental and the marker is not. If the CLI ever stops printing
/// it, this returns None forever and the notifications quietly stop -- so
/// `desktop/README.md` names this as the coupling to check when the CLI's
/// output changes.
fn parse_gave_up(line: &str) -> Option<GaveUp> {
    let (head, detail) = line.split_once(": GAVE UP -- ")?;
    let child = head.split_whitespace().last()?.to_string();
    Some(GaveUp { child, detail: detail.trim().to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_line_the_cli_actually_prints() {
        let line = "12:34:56  brain: GAVE UP -- 5 failures in quick succession; not restarting. \
                    The reason is in /Users/x/.fleet/logs/brain.log.";
        let got = parse_gave_up(line).expect("should parse");
        assert_eq!(got.child, "brain");
        assert!(got.detail.starts_with("5 failures"));
    }

    #[test]
    fn ordinary_lines_are_not_gave_up() {
        assert!(parse_gave_up("12:34:56  agent: start pid 4211").is_none());
        assert!(parse_gave_up("12:34:56  agent: exit code 1 after 3s").is_none());
    }

    #[test]
    fn a_chunk_holding_two_lines_yields_two() {
        let lines = split_lines(b"12:00:00  brain: start pid 1\n12:00:01  agent: start pid 2\n");
        assert_eq!(lines.len(), 2);
    }
}
