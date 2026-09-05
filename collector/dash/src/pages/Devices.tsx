// The shelf. What is online, what it is doing, and how to get to it.
import { useState } from "preact/hooks";
import { useApi, type Device, type DeviceList } from "../api.js";
import { ArtNoDevices } from "../art.js";
import { DeviceGlyph, Icon } from "../icons.js";
import { mutate } from "../mutate.js";
import { refreshNames } from "../names.js";
import { useQuery } from "../router.js";
import { Filters, Link, Loaded, Panel, Pill, Search, Select, Stat, agoFrom } from "../ui.js";

/**
 * The device's name, editable by clicking it.
 *
 * No button and no separate column: the thing you want to change is the thing
 * you click. An unnamed device shows its id, because until you name it that is
 * its name — so the same click renames either case.
 */
function EditableName({ device, onDone }: { device: Device; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const commit = async () => {
    const next = value.trim();
    if (next === (device.name ?? "")) return setEditing(false);
    setBusy(true);
    try {
      await mutate("PATCH", `/api/devices/${encodeURIComponent(device.device_id)}`, { name: next || null });
      await refreshNames();
      setEditing(false);
      setError(null);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (editing)
    return (
      <span class="name-edit">
        <input
          autofocus
          disabled={busy}
          value={value}
          placeholder={device.device_id}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          // Blur commits too: clicking away from a half-typed name and losing
          // it is the most annoying way an inline editor can behave.
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") {
              setValue(device.name ?? "");
              setEditing(false);
            }
          }}
        />
        {error && <span class="text-bad name-err">{error}</span>}
      </span>
    );

  return (
    <button
      type="button"
      class="name-btn"
      title={`${device.device_id} — click to rename`}
      onClick={() => {
        setValue(device.name ?? "");
        setEditing(true);
      }}
    >
      {device.name ? <strong>{device.name}</strong> : <code>{device.device_id}</code>}
    </button>
  );
}

export function Battery({ pct, charging }: { pct: number | null; charging: boolean | null }) {
  if (pct == null) return <span class="faint">—</span>;
  // Simulators report -1 rather than a battery level. Showing "-1%" would look
  // like a reading; it is the absence of one.
  if (pct < 0) return <span class="faint" title="Device reports no battery telemetry">n/a</span>;
  // .text-bad / .text-warn are the word-colouring classes; bare .bad and
  // .warn only exist scoped to stat tiles, so a low battery never went red.
  const tone = pct < 15 && !charging ? "text-bad" : pct < 30 && !charging ? "text-warn" : "";
  return (
    <span class={tone ? `with-icon ${tone}` : "with-icon"} title={charging ? "charging" : "on battery"}>
      {pct}%{charging && <Icon name="charging" title="charging" />}
    </span>
  );
}

export function Thermal({ state }: { state: string | null }) {
  if (!state) return <span class="faint">—</span>;
  return (
    <span class={`with-icon th-text th-${state}`}>
      <Icon name="thermal" />
      {state}
    </span>
  );
}

/** Battery as a bar as well as a number, for the shelf cards. */
function BatteryMeter({ pct, charging }: { pct: number | null; charging: boolean | null }) {
  if (pct == null || pct < 0) return <Battery pct={pct} charging={charging} />;
  const tone = pct < 15 && !charging ? "critical" : pct < 30 && !charging ? "low" : "";
  return (
    <span class="with-icon">
      <Battery pct={pct} charging={charging} />
      <span class={`batt-track ${tone}`} aria-hidden="true">
        <i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </span>
    </span>
  );
}

/**
 * Which silhouette a device gets.
 *
 * Read from the reported OS, not from the API's `platform` field: platform is
 * an ios/android split where anything not iOS is called android, so a MacBook
 * running the machine runner would be drawn as a phone.
 */
function glyphKind(device: Device): "phone" | "laptop" {
  const os = String(device.descriptor.os ?? "").toLowerCase();
  return /^(macos|darwin|linux|windows|win32)/.test(os) ? "laptop" : "phone";
}

function hardware(device: Device): string {
  const d = device.descriptor;
  const bits = [
    String(d.os ?? "?"),
    d.soc ? String(d.soc) : null,
    d.ram_mb ? `${Math.round(Number(d.ram_mb) / 1024)} GB` : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

/** One device, as an object on a shelf. */
function DeviceCard({ device, onDone }: { device: Device; onDone: () => void }) {
  return (
    <div class="dev-card">
      <DeviceGlyph
        kind={glyphKind(device)}
        status={device.status}
        busy={!!device.current_job}
        simulator={device.simulator}
      />
      <div class="dev-body">
        <div class="dev-top">
          <EditableName device={device} onDone={onDone} />
          <Pill kind={device.status} />
        </div>
        {device.simulator && (
          <div class="faint with-icon" style={{ fontSize: "0.72rem" }}>
            <Icon name="simulator" />
            simulator
          </div>
        )}
        <div class="dev-hw">
          {String(device.descriptor.model ?? "?")} · {hardware(device)}
        </div>
        <div class="dev-facts">
          <BatteryMeter pct={device.beacon?.battery_pct ?? null} charging={device.beacon?.charging ?? null} />
          <Thermal state={device.beacon?.thermal ?? null} />
          {device.current_job ? (
            <Link to={`/jobs/${encodeURIComponent(device.current_job)}`} class="dev-doing">
              <code>{device.current_job}</code>
            </Link>
          ) : (
            <span class="faint">idle</span>
          )}
          {device.lock && <span class="faint with-icon"><Icon name="locked" />locked</span>}
        </div>
        <div class="dev-facts dim" style={{ marginTop: "0.35rem", fontSize: "0.75rem" }}>
          <Link to={`/devices/${encodeURIComponent(device.device_id)}`} class="faint open-link">
            open
          </Link>
          <span>{device.pools.join(", ") || "no pool"}</span>
          <span>{agoFrom(device.last_seen)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Hardware first, simulators under it.
 *
 * The two are not the same kind of thing: a wedged physical phone needs
 * someone to walk over to the shelf, a wedged simulator needs a `simctl`. They
 * used to interleave in one id-sorted table, so the question "is any real
 * device in trouble" meant reading every row.
 */
function Shelf({ devices, onDone }: { devices: Device[]; onDone: () => void }) {
  const real = devices.filter((d) => !d.simulator);
  const sims = devices.filter((d) => d.simulator);
  return (
    <>
      {real.length > 0 && (
        <div class="shelf-row">
          {sims.length > 0 && <h3 class="sub">Hardware</h3>}
          <div class="shelf">
            {real.map((d) => (
              <DeviceCard key={d.device_id} device={d} onDone={onDone} />
            ))}
          </div>
        </div>
      )}
      {sims.length > 0 && (
        <div class="shelf-row">
          {real.length > 0 && <h3 class="sub">Simulators and emulators</h3>}
          <div class="shelf">
            {sims.map((d) => (
              <DeviceCard key={d.device_id} device={d} onDone={onDone} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** The original table, unchanged — still the right view for comparing columns. */
function Table({ devices, onDone }: { devices: Device[]; onDone: () => void }) {
  return (
    <div class="scroll">
      <table>
        <tr>
          <th>Device</th>
          <th>Hardware</th>
          <th>Pools</th>
          <th>Runs</th>
          <th>Battery</th>
          <th>Thermal</th>
          <th>Doing</th>
          <th>Last seen</th>
        </tr>
        {devices.map((dev) => (
          <tr key={dev.device_id}>
            <td class="wrap-anywhere">
              <EditableName device={dev} onDone={onDone} />
              <div>
                <Link to={`/devices/${encodeURIComponent(dev.device_id)}`} class="faint open-link">
                  open
                </Link>{" "}
                <Pill kind={dev.status} />{" "}
                {dev.simulator && (
                  <span class="faint with-icon">
                    <Icon name="simulator" />
                    simulator
                  </span>
                )}
              </div>
            </td>
            <td>
              {String(dev.descriptor.model ?? "?")}
              <div class="faint">
                {String(dev.descriptor.os ?? "?")}
                {dev.descriptor.soc ? ` · ${dev.descriptor.soc}` : ""}
                {dev.descriptor.ram_mb ? ` · ${Math.round(Number(dev.descriptor.ram_mb) / 1024)} GB` : ""}
              </div>
            </td>
            <td class="dim">{dev.pools.join(", ") || "—"}</td>
            <td class="dim wrap-anywhere">
              {dev.capabilities === null ? (
                <span class="faint" title="Registered before capability routing; offered every workload.">
                  all
                </span>
              ) : (
                dev.capabilities.join(", ") || "—"
              )}
            </td>
            <td>
              <Battery pct={dev.beacon?.battery_pct ?? null} charging={dev.beacon?.charging ?? null} />
            </td>
            <td>
              <Thermal state={dev.beacon?.thermal ?? null} />
            </td>
            <td class="wrap-anywhere">
              {dev.current_job ? (
                <Link to={`/jobs/${encodeURIComponent(dev.current_job)}`}>
                  <code>{dev.current_job}</code>
                </Link>
              ) : (
                <span class="faint">idle</span>
              )}
              {dev.lock && <div class="faint">locked</div>}
            </td>
            <td class="dim">
              {agoFrom(dev.last_seen)}
              {dev.last_net && <div class="faint">{dev.last_net}</div>}
            </td>
          </tr>
        ))}
      </table>
    </div>
  );
}

export function Devices() {
  const [q, setQuery] = useQuery();
  const status = q.get("status") ?? "";
  const pool = q.get("pool") ?? "";
  const platform = q.get("platform") ?? "";
  const search = q.get("q") ?? "";
  const hideSims = q.get("simulator") === "false";
  // The shelf leads because the fleet is objects on a rack and that is the
  // question this screen usually answers. The table is one click away and,
  // because the choice lives in the URL, a link to either stays that view.
  const view = q.get("view") === "table" ? "table" : "shelf";

  const params = new URLSearchParams();
  for (const [k, v] of [
    ["status", status],
    ["pool", pool],
    ["platform", platform],
    ["q", search],
    ["simulator", hideSims ? "false" : ""],
  ] as const)
    if (v) params.set(k, v);

  const state = useApi<DeviceList>(
    `/api/devices${params.toString() ? `?${params}` : ""}`,
    ["device", "beacon", "job", "lock"],
    30_000,
  );
  const active = !!(status || pool || platform || search || hideSims);

  return (
    <>
      <h1>
        Devices{" "}
        <Link to="/devices/new" class="newjob">
          + add a device
        </Link>
      </h1>
      <Loaded state={state} what="devices" shape="rows">
        {(d) => (
          <>
            <Panel>
              <Filters
                active={active}
                onClear={() => setQuery({ status: null, pool: null, platform: null, q: null, simulator: null })}
              >
                <Select label="status" value={status} options={["online", "stale", "offline"]} onChange={(v) => setQuery({ status: v })} />
                <Select label="pool" value={pool} options={d.pools} onChange={(v) => setQuery({ pool: v })} />
                <Select label="platform" value={platform} options={["android", "ios"]} onChange={(v) => setQuery({ platform: v })} />
                <Search label="find" value={search} placeholder="id, model, SoC" onChange={(v) => setQuery({ q: v })} />
                <label class="field checkbox">
                  <input type="checkbox" checked={hideSims} onChange={(e) => setQuery({ simulator: (e.target as HTMLInputElement).checked ? "false" : null })} />
                  <span>hardware only</span>
                </label>
                <span style={{ flex: 1 }} />
                <div class="segmented" role="group" aria-label="View">
                  <button type="button" aria-pressed={view === "shelf"} onClick={() => setQuery({ view: null })}>
                    shelf
                  </button>
                  <button type="button" aria-pressed={view === "table"} onClick={() => setQuery({ view: "table" })}>
                    table
                  </button>
                </div>
              </Filters>
            </Panel>

            <Panel title={`${d.devices.length} device${d.devices.length === 1 ? "" : "s"}`}>
              {d.devices.length === 0 ? (
                <ArtNoDevices
                  caption={active ? "No device matches these filters." : "No devices yet. Scan the code to enrol one."}
                />
              ) : view === "shelf" ? (
                <Shelf devices={d.devices} onDone={state.reload} />
              ) : (
                <Table devices={d.devices} onDone={state.reload} />
              )}
            </Panel>

            <Panel title="Pools">
              <div class="stats">
                {d.pools.length === 0 ? (
                  <p class="empty">No pools yet.</p>
                ) : (
                  d.pools.map((p) => (
                    <Stat key={p} label={p} value={d.devices.filter((dev) => dev.pools.includes(p)).length} />
                  ))
                )}
              </div>
            </Panel>
          </>
        )}
      </Loaded>
    </>
  );
}
