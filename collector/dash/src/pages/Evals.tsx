// Evals as a page, so the next one needs no hand-written report.
//
// The plant-ID writeup in evals/ was typed by hand because the rows behind it
// could not be queried: top-1 accuracy lived in `decode_tok_s`, p50 in
// `ttft_ms`, and top-5 and p95 lived nowhere at all. Those rows are the reason
// this page exists, so this page must not do to them what the old dashboard
// did — hide them. Every row that cannot be pivoted is COUNTED, ATTRIBUTED and
// LISTED, above the table it is missing from.
//
// House style is Results.tsx: useApi + Loaded + Panel, a Csv button on the
// panel that holds the rows it exports. The Markdown button is the new one, and
// is the point of the page: it emits the table a writeup would have opened with,
// caveats included, so nobody starts the next eval report from a blank file.
import { useApi } from "../api.js";
import { Bars } from "../chart.js";
import { Link, Loaded, Panel, Pill, agoFrom, clock, num, short } from "../ui.js";

// --- shapes (mirrors src/api/evals.ts) ---

type Family = "vision" | "llm" | "speech" | "embed";
type PerJoule = { value: number; unit: string; basis: string };
type EnergyView = {
  wh: number;
  method: "plug" | "plug-shared" | "os";
  includes_charging: boolean | null;
  source: "result" | "integrated";
  baseline_source: string | null;
  note: string | null;
};
type Cell = {
  job_id: string;
  device_id: string;
  device_model: string | null;
  simulator: boolean;
  at: string | null;
  metrics: Record<string, number | null>;
  energy: EnergyView | null;
  per_joule: PerJoule | null;
};
type ModelRow = {
  key: string;
  model: string | null;
  quant: string | null;
  backend: string | null;
  accel: string | null;
  cells: Record<string, Cell>;
};
type Excluded = {
  job_id: string;
  device_id: string;
  at: string | null;
  workload: string;
  backend: string | null;
  input_sha256: string | null;
  reason: string;
  present: string[];
};
type EvalSet = {
  input_sha256: string;
  family: Family;
  headline: { key: string; label: string; unit: string; higherIsBetter: boolean };
  named_metrics: string[];
  workloads: string[];
  devices: { device_id: string; device_model: string | null; simulator: boolean }[];
  models: ModelRow[];
  runs: number;
  latest_at: string | null;
  excluded: number;
  has_energy: boolean;
};
type EvalsIndex = {
  sets: {
    input_sha256: string; family: Family; workloads: string[]; models: number; devices: number;
    runs: number; latest_at: string | null; excluded: number; has_energy: boolean;
  }[];
  excluded: { count: number; by_reason: { reason: string; count: number }[]; rows: Excluded[] };
  scanned: number;
  energy_configured: boolean;
};
type EvalSetResponse = { set: EvalSet | null; excluded: Excluded[]; energy_configured: boolean };

// --- exports ---

function save(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Same CSV writer Results.tsx uses, over the rows the page is showing. */
function downloadCsv(name: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  save(`${name}.csv`, [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"), "text/csv");
}

const Csv = ({ name, rows }: { name: string; rows: Record<string, unknown>[] }) => (
  <button type="button" class="linkish" onClick={() => downloadCsv(name, rows)}>
    CSV
  </button>
);

/** Flat rows for CSV: one line per (model, device) cell. */
function flatten(set: EvalSet): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of set.models)
    for (const d of set.devices) {
      const c = m.cells[d.device_id];
      if (!c) continue;
      out.push({
        input_sha256: set.input_sha256,
        model: m.model, quant: m.quant, backend: m.backend, accel: m.accel,
        device_id: c.device_id, device_model: c.device_model, simulator: c.simulator,
        job_id: c.job_id, at: c.at,
        ...c.metrics,
        energy_wh: c.energy?.wh ?? null,
        energy_method: c.energy?.method ?? null,
        energy_source: c.energy?.source ?? null,
        includes_charging: c.energy?.includes_charging ?? null,
        per_joule: c.per_joule?.value ?? null,
        per_joule_unit: c.per_joule?.unit ?? null,
      });
    }
  return out;
}

/**
 * The Markdown a writeup would have opened with.
 *
 * It carries the caveats, not just the numbers. An export that emitted a clean
 * table and left the excluded rows behind would let the next report repeat the
 * original mistake with less typing, which is worse than no export at all.
 */
function markdown(set: EvalSet, excluded: Excluded[], energyConfigured: boolean): string {
  const L: string[] = [];
  const cols = set.devices;
  L.push(`# Eval set \`${set.input_sha256.slice(0, 12)}…\``);
  L.push("");
  L.push(`- **Input artifact:** \`${set.input_sha256}\` — every device below scored these exact bytes.`);
  L.push(`- **Workload:** ${set.workloads.join(", ")} (${set.family})`);
  L.push(`- **Runs:** ${set.runs} across ${set.models.length} model(s) and ${cols.length} device(s)`);
  L.push(`- **Latest run:** ${set.latest_at ?? "—"}`);
  L.push(`- **Generated from** \`/api/evals/${set.input_sha256}\` — this table is a query, not a transcription.`);
  L.push("");

  const anyPerJoule = set.models.some((m) => Object.values(m.cells).some((c) => c.per_joule));
  for (const key of set.named_metrics) {
    const present = set.models.some((m) => Object.values(m.cells).some((c) => c.metrics[key] != null));
    if (!present) continue;
    L.push(`## ${key}`);
    L.push("");
    L.push(`| Model | ${cols.map((d) => d.device_model ?? d.device_id).join(" | ")} |`);
    L.push(`|---|${cols.map(() => "---:").join("|")}|`);
    for (const m of set.models) {
      const name = `${m.model ?? "?"}${m.quant ? ` ${m.quant}` : ""} (${m.backend ?? "?"}${m.accel ? `/${m.accel}` : ""})`;
      L.push(`| ${name} | ${cols.map((d) => fmt(m.cells[d.device_id]?.metrics[key])).join(" | ")} |`);
    }
    L.push("");
  }

  if (anyPerJoule) {
    L.push("## Energy");
    L.push("");
    L.push(`| Model | Device | Wh | Method | Per joule | Includes charging |`);
    L.push("|---|---|---:|---|---:|---|");
    for (const m of set.models)
      for (const d of cols) {
        const c = m.cells[d.device_id];
        if (!c?.energy) continue;
        L.push(
          `| ${m.model ?? "?"} | ${c.device_model ?? c.device_id} | ${c.energy.wh.toFixed(3)} | ${c.energy.method} | ${
            c.per_joule ? `${c.per_joule.value.toPrecision(3)} ${c.per_joule.unit}` : "—"
          } | ${c.energy.includes_charging === null ? "unknown" : c.energy.includes_charging ? "yes" : "no"} |`,
        );
      }
    L.push("");
    L.push(
      "> Watt-hours are measured at the wall, above the pool's idle baseline, over the job's claim window. " +
        "`plug-shared` figures are the whole pool's and must not be divided per device. " +
        "Where *includes charging* is yes, the figure includes energy that went into the battery rather than into the work — " +
        "an idle baseline removes the charger's standing draw, not its charging current.",
    );
    L.push("");
  } else if (!energyConfigured) {
    L.push("## Energy");
    L.push("");
    L.push("_No pool in `power.json` declares `read_url` + `watts_path` + `energy_method`, so no run here has energy data._");
    L.push("");
  }

  L.push("## Rows this table excludes");
  L.push("");
  if (excluded.length === 0) {
    L.push("None — every result in scope carried named metrics.");
  } else {
    L.push(
      `**${excluded.length} result row(s) are not in the tables above.** They are listed rather than dropped: ` +
        "rows that predate the named metric fields are exactly why this page exists, and hiding them would repeat " +
        "the mistake that made the last eval a hand-written document.",
    );
    L.push("");
    L.push("| Job | Device | Workload | Metrics it does carry | Why |");
    L.push("|---|---|---|---|---|");
    for (const e of excluded)
      L.push(`| \`${e.job_id}\` | ${e.device_id} | ${e.workload} | ${e.present.join(", ") || "none"} | ${e.reason} |`);
  }
  L.push("");
  return L.join("\n");
}

const fmt = (v: number | null | undefined) => (typeof v === "number" ? num(v) : "—");

const Markdown = ({ set, excluded, energyConfigured }: { set: EvalSet; excluded: Excluded[]; energyConfigured: boolean }) => (
  <button
    type="button"
    class="linkish"
    title="The table, the energy caveats and the excluded rows — the opening of the next writeup"
    onClick={() => save(`eval-${set.input_sha256.slice(0, 12)}.md`, markdown(set, excluded, energyConfigured), "text/markdown")}
  >
    Markdown
  </button>
);

// --- excluded rows ---

function ExcludedPanel({ rows, scope }: { rows: Excluded[]; scope: string }) {
  if (rows.length === 0)
    return (
      <Panel title="Excluded rows">
        <p class="empty">None — every {scope} carried named metrics and named an eval set.</p>
      </Panel>
    );
  return (
    <Panel title={`Excluded from the tables above (${rows.length})`} aside={<Csv name="evals-excluded" rows={rows as unknown as Record<string, unknown>[]} />}>
      <p class="stub">
        These rows are real results that this page cannot pivot, and they are listed rather than filtered out.{" "}
        <strong>Rows that predate the named metric fields are the reason this page exists</strong> — the plant-ID eval
        had to be written by hand precisely because its numbers sat in fields that mean something else. Dropping them
        quietly would make the same mistake with a nicer table.
      </p>
      <div class="scroll">
        <table>
          <tr>
            <th>Job</th>
            <th>Device</th>
            <th>Workload</th>
            <th>Carries</th>
            <th>Why it is out</th>
            <th>When</th>
          </tr>
          {rows.map((e) => (
            <tr key={`${e.job_id}:${e.device_id}`}>
              <td class="wrap-anywhere">
                <Link to={`/jobs/${encodeURIComponent(e.job_id)}`}>
                  <code>{short(e.job_id)}</code>
                </Link>
              </td>
              <td class="wrap-anywhere">
                <Link to={`/devices/${encodeURIComponent(e.device_id)}`}>
                  <code>{short(e.device_id, 22)}</code>
                </Link>
              </td>
              <td class="dim">
                {e.workload}
                {e.backend ? ` · ${e.backend}` : ""}
              </td>
              <td class="dim">{e.present.length ? e.present.map((p) => <code key={p}>{p} </code>) : <span class="faint">nothing</span>}</td>
              <td class="faint">{e.reason}</td>
              <td class="dim">{clock(e.at)}</td>
            </tr>
          ))}
        </table>
      </div>
    </Panel>
  );
}

// --- energy caveat, stated once per page that shows a watt-hour ---

function EnergyNote({ set }: { set: EvalSet }) {
  const cells = set.models.flatMap((m) => Object.values(m.cells)).filter((c) => c.energy);
  if (cells.length === 0) return null;
  const shared = cells.some((c) => c.energy!.method === "plug-shared");
  const charging = cells.filter((c) => c.energy!.includes_charging === true).length;
  const unknown = cells.filter((c) => c.energy!.includes_charging === null).length;
  const estimated = cells.filter((c) => c.energy!.baseline_source === "estimated-p10").length;

  return (
    <Panel title="What the watt-hours mean">
      <p class="stub">
        Energy is measured <strong>at the wall</strong>, above the pool's idle baseline, across the job's claim window.
        It is not the energy the model used.
      </p>
      {shared && (
        <p class="stub">
          Some of these pools are <code>plug-shared</code>: several devices sit behind one plug, so the figure is the{" "}
          <strong>whole pool's</strong>. Do not divide it by the number of devices — the devices are not identical, the
          idle ones are already inside the baseline, and a per-device number reached by division would be indistinguishable
          from a measured one.
        </p>
      )}
      {charging > 0 && (
        <p class="stub">
          <strong>{charging} of {cells.length} runs were charging while they ran.</strong> A phone on a plug is also
          filling its battery, and subtracting an idle baseline removes the charger's standing draw but not its charging
          current. Those watt-hours include battery replenishment as well as the work.
        </p>
      )}
      {unknown > 0 && (
        <p class="stub">
          {unknown} run(s) had no beacon covering the window, so whether the device was also charging is unknown.
        </p>
      )}
      {estimated > 0 && (
        <p class="stub">
          {estimated} run(s) used an <em>estimated</em> idle baseline (the 10th percentile of the pool's own samples)
          because <code>power.json</code> declares no <code>idle_watts</code> for that pool. Measure it with the shelf
          quiet and the figures get better.
        </p>
      )}
    </Panel>
  );
}

// --- one eval set ---

export function EvalSetPage({ sha }: { sha: string }) {
  const state = useApi<EvalSetResponse>(`/api/evals/${encodeURIComponent(sha)}`, ["result"], 60_000);

  return (
    <>
      <h1>Eval set</h1>
      <Panel>
        <p class="stub">
          <Link to="/evals">← all eval sets</Link> · input artifact <code class="wrap-anywhere">{sha}</code>
        </p>
      </Panel>
      <Loaded state={state} what="this eval set">
        {(d) =>
          !d.set ? (
            <>
              <Panel>
                <p class="empty">
                  No pivotable result carries this <code>input_sha256</code>.
                  {d.excluded.length > 0 && " Every row that names it is listed below."}
                </p>
              </Panel>
              <ExcludedPanel rows={d.excluded} scope="row" />
            </>
          ) : (
            <>
              <Panel
                title={`${d.set.models.length} model(s) × ${d.set.devices.length} device(s)`}
                aside={
                  <>
                    <Csv name={`eval-${sha.slice(0, 12)}`} rows={flatten(d.set)} />{" "}
                    <Markdown set={d.set} excluded={d.excluded} energyConfigured={d.energy_configured} />
                  </>
                }
              >
                <p class="stub">
                  {d.set.workloads.join(", ")} · {d.set.family} · {d.set.runs} runs · latest{" "}
                  {agoFrom(d.set.latest_at)}
                </p>
                <h3 class="sub">
                  {d.set.headline.label} — {d.set.headline.higherIsBetter ? "higher is better" : "lower is better"}
                </h3>
                <Bars
                  items={d.set.models.flatMap((m) =>
                    d.set!.devices
                      .filter((dev) => m.cells[dev.device_id])
                      .map((dev) => ({
                        label: `${m.model ?? "?"}${m.quant ? ` ${m.quant}` : ""} · ${dev.device_model ?? dev.device_id}`,
                        value: m.cells[dev.device_id].metrics[d.set!.headline.key] ?? null,
                        muted: dev.simulator,
                      })),
                  )}
                  unit={d.set.headline.unit}
                />
              </Panel>

              {d.set.named_metrics
                .filter((key) => d.set!.models.some((m) => Object.values(m.cells).some((c) => c.metrics[key] != null)))
                .map((key) => (
                  <Panel key={key} title={key}>
                    <div class="scroll">
                      <table>
                        <tr>
                          <th>Model</th>
                          {d.set!.devices.map((dev) => (
                            <th key={dev.device_id} class="right">
                              {dev.device_model ?? dev.device_id}
                              {dev.simulator && <div class="faint">simulator</div>}
                            </th>
                          ))}
                        </tr>
                        {d.set!.models.map((m) => (
                          <tr key={m.key}>
                            <td>
                              {m.model ?? "?"}
                              {m.quant ? ` ${m.quant}` : ""}
                              <div class="faint">
                                {m.backend ?? "?"}
                                {m.accel ? ` · ${m.accel}` : ""}
                              </div>
                            </td>
                            {d.set!.devices.map((dev) => {
                              const c = m.cells[dev.device_id];
                              return (
                                <td key={dev.device_id} class="num">
                                  {c ? (
                                    <Link to={`/jobs/${encodeURIComponent(c.job_id)}`}>{fmt(c.metrics[key])}</Link>
                                  ) : (
                                    <span class="faint" title="this model was never run on this device">
                                      not run
                                    </span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </table>
                    </div>
                  </Panel>
                ))}

              <EnergyNote set={d.set} />

              {d.set.has_energy ? (
                <Panel title="Energy">
                  <div class="scroll">
                    <table>
                      <tr>
                        <th>Model</th>
                        <th>Device</th>
                        <th class="right">Wh</th>
                        <th>Method</th>
                        <th class="right">Per joule</th>
                        <th>Charging</th>
                      </tr>
                      {d.set.models.flatMap((m) =>
                        d.set!.devices.map((dev) => {
                          const c = m.cells[dev.device_id];
                          if (!c?.energy) return null;
                          return (
                            <tr key={`${m.key}:${dev.device_id}`} class={dev.simulator ? "muted-row" : ""}>
                              <td>
                                {m.model ?? "?"}
                                {m.quant ? ` ${m.quant}` : ""}
                              </td>
                              <td class="wrap-anywhere">
                                <code>{c.device_model ?? c.device_id}</code>
                              </td>
                              <td class="num">{c.energy.wh.toFixed(3)}</td>
                              <td class="dim">
                                <Pill kind={c.energy.method === "plug" ? "done" : "queued"}>{c.energy.method}</Pill>
                                <div class="faint">{c.energy.source === "result" ? "from the runner" : "integrated here"}</div>
                              </td>
                              {/* Omitted cleanly where the run has no countable
                                  work: a rate times a duration would look like a
                                  measurement without being one. */}
                              <td class="num">
                                {c.per_joule ? (
                                  <span title={`from ${c.per_joule.basis}`}>
                                    {c.per_joule.value.toPrecision(3)} <span class="faint">{c.per_joule.unit}</span>
                                  </span>
                                ) : (
                                  <span class="faint" title="no stored count of items processed, so this is not computable">
                                    —
                                  </span>
                                )}
                              </td>
                              <td class="dim">
                                {c.energy.includes_charging === null
                                  ? "unknown"
                                  : c.energy.includes_charging
                                    ? "yes — includes battery"
                                    : "no"}
                              </td>
                            </tr>
                          );
                        }),
                      )}
                    </table>
                  </div>
                </Panel>
              ) : (
                <Panel title="Energy">
                  <p class="empty">
                    {d.energy_configured
                      ? "No run in this set has energy data: either the runner stored none and the plug had too few samples inside the job window, or the device's pool declares no energy_method."
                      : "No pool in power.json declares read_url, watts_path and energy_method, so nothing here has energy data. See power.example.json."}
                  </p>
                </Panel>
              )}

              <ExcludedPanel rows={d.excluded} scope="row" />
            </>
          )
        }
      </Loaded>
    </>
  );
}

// --- the index ---

export function Evals() {
  const state = useApi<EvalsIndex>("/api/evals", ["result"], 60_000);

  return (
    <>
      <h1>Evals</h1>
      <Panel>
        <p class="stub">
          An <strong>eval set</strong> is one <code>params.input_sha256</code> — the exact bytes every device scored.
          Results group by model and pivot across devices, which is the shape a writeup wants, so the next eval report
          starts from the Markdown button rather than from a blank file.
        </p>
      </Panel>
      <Loaded state={state} what="evals">
        {(d) => (
          <>
            {d.sets.length === 0 ? (
              <Panel>
                <p class="empty">
                  No eval set has a pivotable result yet.
                  {d.excluded.count > 0 && ` ${d.excluded.count} row(s) were found but could not be pivoted — see below.`}
                </p>
              </Panel>
            ) : (
              <Panel title={`Eval sets (${d.sets.length})`} aside={<Csv name="eval-sets" rows={d.sets as unknown as Record<string, unknown>[]} />}>
                <div class="scroll">
                  <table>
                    <tr>
                      <th>Input artifact</th>
                      <th>Workload</th>
                      <th class="right">Models</th>
                      <th class="right">Devices</th>
                      <th class="right">Runs</th>
                      <th class="right">Excluded</th>
                      <th>Energy</th>
                      <th>Latest</th>
                    </tr>
                    {d.sets.map((s) => (
                      <tr key={s.input_sha256}>
                        <td class="wrap-anywhere">
                          <Link to={`/evals/${encodeURIComponent(s.input_sha256)}`}>
                            <code>{s.input_sha256.slice(0, 16)}…</code>
                          </Link>
                        </td>
                        <td class="dim">
                          {s.workloads.join(", ")}
                          <div class="faint">{s.family}</div>
                        </td>
                        <td class="num">{s.models}</td>
                        <td class="num">{s.devices}</td>
                        <td class="num">{s.runs}</td>
                        <td class="num">{s.excluded > 0 ? <strong>{s.excluded}</strong> : "0"}</td>
                        <td class="dim">{s.has_energy ? "yes" : <span class="faint">—</span>}</td>
                        <td class="dim">{clock(s.latest_at)}</td>
                      </tr>
                    ))}
                  </table>
                </div>
              </Panel>
            )}

            {d.excluded.count > 0 && (
              <Panel title={`${d.excluded.count} row(s) excluded across all sets`}>
                <p class="stub">
                  Counted here rather than filtered away. The breakdown:{" "}
                  {d.excluded.by_reason.map((r) => `${r.count} × ${r.reason}`).join(", ")}. Open a set to see which rows,
                  and what each one does carry.
                </p>
              </Panel>
            )}

            <ExcludedPanel rows={d.excluded.rows} scope="result in scope" />
          </>
        )}
      </Loaded>
    </>
  );
}
