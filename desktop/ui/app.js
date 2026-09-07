// The settings window.
//
// `window.__TAURI__` is here because `app.withGlobalTauri` is set in
// tauri.conf.json, which is what lets this be a plain script tag with no
// bundler and no import map. Everything that touches the fleet is a
// #[tauri::command] in src-tauri/src/main.rs -- this file has no shell access,
// no filesystem access, and no permission in capabilities/default.json to
// acquire any.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const el = (id) => document.getElementById(id);
const ROLES = ["brain", "agent", "executor"];

/**
 * The config as it is on disk.
 *
 * Kept whole rather than as the four fields this window edits, so that applying
 * writes back everything else -- pools, bind, discovery, the tailnet allowlist,
 * a key a newer CLI added -- exactly as it was found. A settings window that
 * silently drops the settings it does not render is worse than one that has
 * fewer settings.
 */
let saved = null;

/** True while the user has unapplied edits; suppresses form refreshes. */
let dirty = false;

// --- rendering --------------------------------------------------------------

function fillForm(config) {
  for (const role of ROLES) el(`role-${role}`).checked = config.roles.includes(role);
  el("port").value = config.collector.port;
  el("collectors").value = (config.agent.collectors || []).join("\n");
  syncDerived();
}

/** The bits of the form that are read-outs of other bits of the form. */
function syncDerived() {
  const port = Number(el("port").value) || 0;
  el("dash-url").textContent = `http://127.0.0.1:${port}/dash`;

  // agentCollectors() in fleet/src/config.ts: empty means "the brain on this
  // machine", and only when this machine is one. Saying so beats writing
  // http://127.0.0.1:8788 into the file, which would become a lie the moment
  // the port changed.
  const empty = el("collectors").value.trim() === "";
  const isBrain = el("role-brain").checked;
  el("collectors-hint").textContent = !empty
    ? "One URL per line."
    : isBrain
      ? `Empty, so the agent registers with this machine's own brain on :${port}.`
      : "Empty, and this machine is not a brain -- so the agent has nowhere to register.";
}

function render(status) {
  const gaveUp = status.gave_up || [];
  const headline = el("headline");

  if (gaveUp.length > 0) {
    headline.className = "sub state-bad";
    headline.textContent = `${gaveUp.map((g) => g.child).join(", ")} gave up and will not be restarted.`;
  } else if (status.running) {
    headline.className = "sub state-running";
    const up = status.uptime_s === null || status.uptime_s === undefined ? "" : ` · up ${fmtDuration(status.uptime_s)}`;
    headline.textContent = `Running: ${status.roles.join(", ")} · :${status.port}${up}`;
  } else {
    headline.className = "sub state-stopped";
    headline.textContent = "Not running.";
  }

  const alert = el("alert");
  if (status.config_error) {
    // The one case where the form must not be trusted: the file on disk could
    // not be parsed, so what is shown is defaults and applying would overwrite
    // whatever is actually in there.
    alert.hidden = false;
    alert.textContent = `${status.config_error} — the fields below are defaults, not the file. Fix the file before applying.`;
  } else {
    alert.hidden = true;
  }

  el("log").textContent = (status.lines || []).slice(-60).join("\n") || "nothing yet";
  el("config-path").textContent = status.config_path;
  el("log-dir").textContent = status.log_dir;
}

function fmtDuration(s) {
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

// --- reading the form -------------------------------------------------------

function formConfig() {
  // Start from the file, not from an empty object. See `saved`.
  const next = JSON.parse(JSON.stringify(saved));
  next.roles = ROLES.filter((r) => el(`role-${r}`).checked);
  next.collector.port = Number(el("port").value);
  next.agent.collectors = el("collectors")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return next;
}

function isDirty() {
  if (!saved) return false;
  return JSON.stringify(formConfig()) !== JSON.stringify(saved);
}

function markDirty() {
  dirty = isDirty();
  el("apply").disabled = !dirty;
  el("revert").disabled = !dirty;
  syncDerived();
}

/** What applying is about to do, in the imperative, or null if it is fine. */
function refuse(config) {
  if (config.roles.length === 0) {
    return "Pick at least one role. A fleet with no roles starts nothing, and the CLI would fall back to brain and agent rather than honour it.";
  }
  const port = config.collector.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "The collector port has to be a whole number between 1 and 65535.";
  }
  const bad = config.agent.collectors.filter((u) => !/^https?:\/\/.+/.test(u));
  if (bad.length > 0) {
    // The agent would take this string, fail every registration against it, and
    // report it as a brain that is not answering.
    return `Not a URL: ${bad.join(", ")}. Each line needs a scheme, like http://fleet-host.local:8788`;
  }
  return null;
}

// --- wiring -----------------------------------------------------------------

async function refresh({ form } = { form: false }) {
  const status = await invoke("get_status");
  render(status);
  // Never overwrite what somebody is halfway through typing. A poll that
  // resets a half-entered URL every two seconds is a window nobody can use.
  if (form && !dirty) {
    saved = await invoke("get_config");
    fillForm(saved);
    markDirty();
  }
}

async function apply() {
  const next = formConfig();
  const problem = refuse(next);
  const alert = el("alert");
  if (problem) {
    alert.hidden = false;
    alert.textContent = problem;
    return;
  }

  el("apply").disabled = true;
  el("apply").textContent = "Restarting...";
  try {
    // Returns only once the old collector has let go of the port. Waiting is
    // the point: starting the new one first gives an EADDRINUSE that reads as
    // "the app is broken" rather than "the fleet is restarting".
    await invoke("set_config", { config: next });
    saved = next;
    dirty = false;
    alert.hidden = true;
    await refresh({ form: true });
  } catch (e) {
    alert.hidden = false;
    alert.textContent = String(e);
  } finally {
    el("apply").textContent = "Apply and restart";
    markDirty();
  }
}

for (const role of ROLES) el(`role-${role}`).addEventListener("change", markDirty);
el("port").addEventListener("input", markDirty);
el("collectors").addEventListener("input", markDirty);
el("apply").addEventListener("click", apply);
el("revert").addEventListener("click", () => {
  fillForm(saved);
  markDirty();
});

// Rust emits this whenever the sidecar says something or the config is written,
// so the common case costs no polling at all.
listen("fleet://changed", () => refresh({ form: true }));

// The poll is the backstop for the things that change with nothing to announce
// them: the uptime counter, and a `fleet config set` in a terminal.
setInterval(() => refresh({ form: true }), 2000);

refresh({ form: true });
