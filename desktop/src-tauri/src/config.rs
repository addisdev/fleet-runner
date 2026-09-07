//! `~/.fleet/config.json`, as the CLI already defines it.
//!
//! This is a mirror of `FleetConfig` in `fleet/src/config.ts` and nothing else.
//! There is no desktop config file, no preferences plist, no second copy of the
//! port number -- because the moment there are two files, one of them is wrong
//! and the fleet has been started with the other one. The switch labelled "this
//! Mac is a brain" is a switch over the same bytes `fleet config set roles`
//! writes, and `fleet up` reads.
//!
//! The mirror has to be kept by hand, which is the cost of not adding a Rust
//! build to the TypeScript one. Two things keep it cheap:
//!
//! - Unknown top-level keys survive a round trip through `extra`, so a key this
//!   file has not learned about yet is not silently deleted by saving from the
//!   settings window.
//! - The field order below is the order `save()` in config.ts emits, so a file
//!   written here and a file written by the CLI are byte-identical rather than
//!   merely equivalent. A config.json that reshuffles itself depending on which
//!   program touched it last is a diff nobody can read.
//!
//! What this deliberately does NOT mirror is the precedence rule. config.ts is
//! clear that `FLEET_*` environment beats the file, and this app cannot see the
//! environment a launchd plist gives some other process. So the settings window
//! shows the file, says so, and does not pretend to show effective values.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collector {
    pub port: u16,
    pub bind: Vec<String>,
    pub discovery: bool,
    #[serde(rename = "tailnetAllowlist")]
    pub tailnet_allowlist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    /// Which brains to register with. A list, because a device can belong to
    /// more than one fleet.
    pub collectors: Vec<String>,
    pub pools: Vec<String>,
    #[serde(rename = "deviceId", skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// Seconds. `ttl_s` in the JSON is `ttlS`, and getting that wrong writes a
    /// key the CLI ignores while dropping the one it reads.
    #[serde(rename = "ttlS", skip_serializing_if = "Option::is_none")]
    pub ttl_s: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Executor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FleetConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub roles: Vec<String>,
    pub collector: Collector,
    pub agent: Agent,
    pub executor: Executor,
    pub peers: Vec<String>,
    /// Anything this build has not heard of. Kept so that saving from the
    /// settings window is never a downgrade of somebody's hand-edited file.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

pub const ROLES: [&str; 3] = ["brain", "agent", "executor"];

impl Default for FleetConfig {
    /// `defaults()` in config.ts, value for value.
    fn default() -> Self {
        Self {
            name: None,
            roles: vec!["brain".into(), "agent".into()],
            collector: Collector {
                port: 8788,
                bind: vec!["0.0.0.0".into()],
                discovery: false,
                tailnet_allowlist: vec![],
            },
            agent: Agent {
                collectors: vec![],
                pools: vec!["machines".into()],
                device_id: None,
                ttl_s: None,
            },
            executor: Executor { collector: None, name: None },
            peers: vec![],
            extra: Map::new(),
        }
    }
}

/// `~/.fleet`, or wherever `FLEET_HOME` says -- `fleet/src/paths.ts`.
pub fn fleet_home() -> PathBuf {
    if let Ok(home) = std::env::var("FLEET_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    let user = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    PathBuf::from(user).join(".fleet")
}

pub fn config_path() -> PathBuf {
    fleet_home().join("config.json")
}

pub fn log_dir() -> PathBuf {
    fleet_home().join("logs")
}

/// Read the config, filling in anything absent.
///
/// A malformed file is the defaults, never an error dialog -- the same call
/// config.ts makes and for the same reason. This app's one job is to be the
/// thing that can start a stopped fleet, and refusing to open because somebody
/// left a trailing comma in a JSON file is the one failure that makes it
/// useless exactly when it is needed. The malformed text is handed back to the
/// caller so the settings window can say so instead of quietly showing
/// defaults that are not what is on disk.
pub fn load() -> (FleetConfig, Option<String>) {
    let path = config_path();
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (FleetConfig::default(), None),
        Err(e) => return (FleetConfig::default(), Some(format!("{} could not be read: {e}", path.display()))),
    };
    let on_disk: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return (FleetConfig::default(), Some(format!("{} is not valid JSON: {e}", path.display())))
        }
    };
    (merge(on_disk), None)
}

/// Fill a partial on-disk object out to a whole config.
///
/// config.ts merges section by section (`{...d.collector, ...onDisk.collector}`)
/// rather than requiring a complete file, so a config.json containing only
/// `{"roles":["agent"]}` is legal and common. Deserialising straight into
/// `FleetConfig` would reject it, so the same shallow merge happens here.
fn merge(on_disk: Value) -> FleetConfig {
    let d = FleetConfig::default();
    let mut base = serde_json::to_value(&d).unwrap_or(Value::Null);
    let (Value::Object(base_map), Value::Object(disk_map)) = (&mut base, &on_disk) else {
        return d;
    };
    for (key, value) in disk_map {
        match (base_map.get_mut(key), value) {
            // One level of merging, matching config.ts. A `collector` object on
            // disk with only `port` in it keeps the default bind and discovery.
            (Some(Value::Object(into)), Value::Object(from)) => {
                for (k, v) in from {
                    into.insert(k.clone(), v.clone());
                }
            }
            _ => {
                base_map.insert(key.clone(), value.clone());
            }
        }
    }

    let mut config: FleetConfig = serde_json::from_value(base).unwrap_or(d);
    // config.ts drops role strings it does not recognise and falls back to the
    // defaults if that leaves nothing. Without the fallback, a typo in `roles`
    // gives a fleet that starts and runs nothing, which reads as a crash.
    config.roles.retain(|r| ROLES.contains(&r.as_str()));
    if config.roles.is_empty() {
        config.roles = FleetConfig::default().roles;
    }
    config
}

/// Write it back, atomically.
///
/// Same temp-then-rename as `save()` in config.ts, and the pid in the temp name
/// is load-bearing for the same reason: this app and a `fleet config set` in a
/// terminal can be writing at the same moment, and a shared temp name would let
/// them interleave into one corrupt file. Rename is what makes a reader either
/// see the old file or the new one -- a collector starting mid-write would
/// otherwise read a truncated config and come up with the wrong port.
pub fn save(config: &FleetConfig) -> Result<PathBuf, String> {
    let home = fleet_home();
    fs::create_dir_all(&home).map_err(|e| format!("{} could not be created: {e}", home.display()))?;
    let path = config_path();
    let tmp = home.join(format!("config.json.{}.tmp", std::process::id()));
    // Two-space indent and a trailing newline, because that is what
    // `JSON.stringify(config, null, 2)` plus the "\n" in config.ts produces.
    let mut text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    text.push('\n');
    fs::write(&tmp, text).map_err(|e| format!("{} could not be written: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("{} could not be replaced: {e}", path.display()))?;
    Ok(path)
}

/// Which brains the agent registers with -- `agentCollectors()` in config.ts.
///
/// Empty means "the one on this machine". Writing `http://127.0.0.1:8788` into
/// the file to say that would be a lie the moment the port changed, so the
/// settings window shows the list empty and labels it, rather than helpfully
/// filling it in.
pub fn agent_collectors(config: &FleetConfig) -> Vec<String> {
    if !config.agent.collectors.is_empty() {
        return config.agent.collectors.clone();
    }
    if config.roles.iter().any(|r| r == "brain") {
        return vec![format!("http://127.0.0.1:{}", config.collector.port)];
    }
    vec![]
}

/// The dashboard this machine serves.
///
/// Always loopback, never the LAN address, even when the collector binds every
/// interface: loopback is the one address that works before anybody has
/// answered the local-network dialog this whole app is a bet on.
pub fn dashboard_url(config: &FleetConfig) -> String {
    format!("http://127.0.0.1:{}/dash", config.collector.port)
}
