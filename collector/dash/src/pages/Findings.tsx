// Findings: what night QA found, and the morning's one job -- deciding which of
// it is real.
//
// The explore workload drives each app overnight and replays every candidate on
// a clean install before posting it, so what lands here has already survived
// one round of doubt. The page is built around the second round, which only a
// person can do: look at the screenshot, read the steps, press one of four
// buttons. Those four verdicts are also how the fleet learns which checks to
// stop running -- a check class a person calls real less than 30% of the time
// is switched off for that app (the precision table at the top), so a wrong
// verdict costs tomorrow night something, and the buttons say what they mean.
import { useEffect, useRef, useState } from "preact/hooks";
import { useApi, type Finding, type FindingDetail as Detail, type FindingList, type FindingPrecision, type FindingVerdict } from "../api.js";
import { mutate, useMutation } from "../mutate.js";
import { useDeviceNames } from "../names.js";
import { navigate, useQuery } from "../router.js";
import {
  Actions, Button, DeviceName, ErrorBox, Field, Filters, Link, Loaded, Panel, Pill, Select, Stat, agoFrom, clock,
} from "../ui.js";

const STATUSES = ["open", "triaged", "all"] as const;

/** Severity reads as a pill in the colours the rest of the dashboard already uses for bad, worrying and quiet. */
const SEVERITY_PILL: Record<Finding["severity"], string> = { high: "failed", medium: "claimed", low: "queued" };

export const VERDICT_LABEL: Record<FindingVerdict, string> = {
  real: "Real",
  duplicate: "Duplicate",
  not_a_bug: "Not a bug",
  agent_mistake: "Agent's mistake",
};

const VERDICT_PILL: Record<FindingVerdict, string> = {
  real: "failed",
  duplicate: "queued",
  not_a_bug: "cancelled",
  agent_mistake: "cancelled",
};

/** reproduced N/N is solid, flaky is a warning, a crash log is its own evidence. */
function ReplayState({ f }: { f: Pick<Finding, "replay" | "replay_label"> }) {
  const tone = !f.replay ? "dim" : f.replay.reproduced >= f.replay.attempts ? "text-ok" : "text-warn";
  return <span class={tone}>{f.replay_label}</span>;
}

const CheckChip = ({ check }: { check: string }) => <span class="chip">{check}</span>;

function VerdictPill({ f }: { f: Pick<Finding, "verdict"> }) {
  if (!f.verdict) return <Pill kind="claimed">open</Pill>;
  return <Pill kind={VERDICT_PILL[f.verdict]}>{VERDICT_LABEL[f.verdict].toLowerCase()}</Pill>;
}

const pct = (p: number | null) => (p === null ? "—" : `${Math.round(p * 100)}%`);

/**
 * How often each check has been right, per app. Only drawn once something has
 * been judged: before that every row would read "—" and the table would be
 * explaining a rule that has not had anything to act on yet.
 */
function PrecisionTable({ app }: { app: string }) {
  const state = useApi<FindingPrecision>(`/api/findings/precision${app ? `?app=${encodeURIComponent(app)}` : ""}`, ["finding"]);
  const d = state.data;
  // A class nobody has judged yet has nothing to say: a row of dashes and
  // "10 to go" per check would bury the one row that matters, the one that
  // has been switched off.
  const shown = d?.classes.filter((c) => c.judged > 0 || c.duplicate > 0) ?? [];
  if (!d || shown.length === 0) return null;
  return (
    <Panel title="Precision by check">
      <div class="scroll">
        <table>
          <tr>
            <th>App</th>
            <th>Check</th>
            <th class="right">Judged</th>
            <th class="right">Real</th>
            <th class="right">Not a bug</th>
            <th class="right">Agent</th>
            <th class="right">Dup</th>
            <th class="right">Open</th>
            <th class="right">Precision</th>
            <th />
          </tr>
          {shown.map((c) => (
            <tr key={`${c.app}/${c.check}`}>
              <td>{c.app}</td>
              <td><CheckChip check={c.check} /></td>
              <td class="num">{c.judged}</td>
              <td class="num">{c.real}</td>
              <td class="num">{c.not_a_bug}</td>
              <td class="num">{c.agent_mistake}</td>
              <td class="num faint">{c.duplicate}</td>
              <td class="num">{c.open}</td>
              <td class={`num${c.disabled ? " text-bad" : ""}`}>{pct(c.precision)}</td>
              <td>
                {c.disabled ? (
                  <Pill kind="failed">switched off</Pill>
                ) : c.judged < d.min ? (
                  <span class="faint" title={`Needs ${d.min} judged findings before the 30% rule applies`}>
                    {d.min - c.judged} to go
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </table>
      </div>
      <p class="empty">
        Judged counts real, not a bug and agent's mistake; duplicates are left out. A check is switched off for an app
        once {d.min} are judged and fewer than {Math.round(d.floor * 100)}% were real — night QA reads this table before
        it starts.
      </p>
    </Panel>
  );
}

function FindingRows({ findings }: { findings: Finding[] }) {
  return (
    <div class="scroll">
      <table class="findings">
        <tr>
          <th>Severity</th>
          <th>Check</th>
          <th>Finding</th>
          <th class="right">Seen</th>
          <th>Replay</th>
          <th>First / last seen</th>
          <th>Verdict</th>
        </tr>
        {findings.map((f) => (
          <tr key={f.id} class="clickable" onClick={(e) => {
            // The title is a real link (cmd-click works); the rest of the row is a convenience.
            if ((e.target as HTMLElement).closest("a")) return;
            navigate(`/findings/${f.id}`);
          }}>
            <td><Pill kind={SEVERITY_PILL[f.severity]}>{f.severity}</Pill></td>
            <td><CheckChip check={f.check} /></td>
            <td class="finding-title">
              <Link to={`/findings/${f.id}`}>{f.title}</Link>
              <div class="dim">
                {f.app}
                {f.screen_name ? ` · ${f.screen_name}` : ""}
              </div>
            </td>
            <td class="num">
              {f.seen_count}×
              <div class="faint" title={f.builds_seen.join(", ")}>
                {f.builds_seen.length} build{f.builds_seen.length === 1 ? "" : "s"}
              </div>
            </td>
            <td><ReplayState f={f} /></td>
            <td class="dim">
              {clock(f.first_seen)}
              <div class="faint">{agoFrom(f.last_seen)}</div>
            </td>
            <td><VerdictPill f={f} /></td>
          </tr>
        ))}
      </table>
    </div>
  );
}

export function Findings() {
  const [q, setQuery] = useQuery();
  const app = q.get("app") ?? "";
  const check = q.get("check") ?? "";
  const status = (STATUSES as readonly string[]).includes(q.get("status") ?? "") ? (q.get("status") as string) : "open";
  const params = new URLSearchParams({ status });
  if (app) params.set("app", app);
  if (check) params.set("check", check);
  const state = useApi<FindingList>(`/api/findings?${params}`, ["finding"], 60_000);

  return (
    <>
      <h1>Findings</h1>
      <PrecisionTable app={app} />
      <Loaded state={state} what="findings">
        {(d) => (
          <Panel
            title={`${d.counts.open} open · ${d.counts.triaged} triaged`}
            aside={
              <span class="windows">
                {STATUSES.map((s) => (
                  <button key={s} type="button" class={`linkish${s === status ? " on" : ""}`}
                    onClick={() => setQuery({ status: s === "open" ? null : s })}>
                    {s}
                  </button>
                ))}
              </span>
            }
          >
            <Filters active={!!(app || check)} onClear={() => setQuery({ app: null, check: null })}>
              <Select label="app" value={app} options={d.apps} onChange={(v) => setQuery({ app: v })} />
              <Select label="check" value={check} options={d.checks} onChange={(v) => setQuery({ check: v })} />
            </Filters>
            {d.findings.length === 0 ? (
              <p class="empty">
                {d.counts.total === 0
                  ? "Nothing found yet. Night QA posts here after it has replayed a finding on a clean install."
                  : status === "open"
                    ? "Nothing waiting for a verdict."
                    : "No findings match."}
              </p>
            ) : (
              <FindingRows findings={d.findings} />
            )}
          </Panel>
        )}
      </Loaded>
    </>
  );
}

// --- one finding ---------------------------------------------------------

const ARTIFACTS: [keyof Finding["artifacts"], string][] = [
  ["shot", "screenshot"],
  ["sheet", "contact sheet"],
  ["trajectory", "trajectory"],
  ["log", "log"],
  ["replay", "replay file"],
];

/** True while a keystroke would go into a form field rather than the page. */
const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
};

/**
 * The four buttons, the note, and the duplicate picker.
 *
 * r / d / n / a do the same as the buttons. They are ignored straight after a
 * `g`, because "g r" is already "go to Results" and a shortcut that filed a
 * verdict on the way out of the page would be a nasty surprise.
 */
function VerdictBox({ f, onDone }: { f: Detail; onDone: () => void }) {
  const [note, setNote] = useState(f.verdict_note ?? "");
  const [picking, setPicking] = useState(false);
  const [dupOf, setDupOf] = useState("");
  const pickRef = useRef<HTMLSelectElement>(null);
  const others = useApi<FindingList>(picking ? `/api/findings?app=${encodeURIComponent(f.app)}&status=all&limit=200` : null);

  const [pending, setPending] = useState<FindingVerdict | null>(null);
  const send = useMutation(async () => {
    const body: Record<string, unknown> = { verdict: pending, note: note.trim() || null };
    if (pending === "duplicate") body.duplicate_of = Number(dupOf);
    const r = await mutate("POST", `/api/findings/${f.id}/verdict`, body);
    setPicking(false);
    onDone();
    return r;
  });
  const reopen = useMutation(async () => {
    const r = await mutate("POST", `/api/findings/${f.id}/verdict`, { verdict: null });
    onDone();
    return r;
  });

  // The mutation reads `pending` from state, so it is fired from an effect
  // once the state has landed rather than in the same tick that set it.
  const [fire, setFire] = useState(0);
  useEffect(() => {
    if (fire) void send.go();
  }, [fire]);
  const judge = (v: FindingVerdict) => {
    if (v === "duplicate") {
      setPicking(true);
      setTimeout(() => pickRef.current?.focus(), 0);
      return;
    }
    setPending(v);
    setFire((n) => n + 1);
  };

  useEffect(() => {
    let afterG = false;
    let timer: number | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "g") {
        afterG = true;
        clearTimeout(timer);
        timer = setTimeout(() => (afterG = false), 1500) as unknown as number;
        return;
      }
      if (afterG) {
        afterG = false;
        return;
      }
      const v = ({ r: "real", d: "duplicate", n: "not_a_bug", a: "agent_mistake" } as Record<string, FindingVerdict>)[e.key];
      if (v) {
        e.preventDefault();
        judge(v);
      }
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [f.id, note]);

  const candidates = (others.data?.findings ?? []).filter((o) => o.id !== f.id);
  return (
    <Panel
      title="Verdict"
      aside={f.verdict ? (
        <span class="dim">
          {VERDICT_LABEL[f.verdict]} · {clock(f.verdict_at)}{" "}
          <button type="button" class="linkish" onClick={() => void reopen.go()}>reopen</button>
        </span>
      ) : <span class="faint">keys: r d n a</span>}
    >
      <div class="verdicts">
        {(Object.keys(VERDICT_LABEL) as FindingVerdict[]).map((v) => (
          <Button
            key={v}
            tone={f.verdict === v ? "primary" : undefined}
            busy={send.busy && pending === v}
            onClick={() => judge(v)}
            title={{
              real: "A bug in the app. Counts towards this check's precision.",
              duplicate: "The same problem as another finding. Left out of precision.",
              not_a_bug: "The app is fine; the check was wrong. Counts against this check.",
              agent_mistake: "The model did something silly and the app reacted correctly. Counts against this check.",
            }[v]}
          >
            <kbd>{v === "not_a_bug" ? "n" : v[0]}</kbd> {VERDICT_LABEL[v]}
          </Button>
        ))}
      </div>
      {picking && (
        <div class="filters dup-pick">
          <label class="field">
            <span>duplicate of</span>
            <select ref={pickRef} value={dupOf} onChange={(e) => setDupOf((e.target as HTMLSelectElement).value)}>
              <option value="">{others.loading ? "loading…" : "choose a finding"}</option>
              {candidates.map((o) => (
                <option key={o.id} value={String(o.id)}>
                  #{o.id} · {o.check} · {o.title}
                </option>
              ))}
            </select>
          </label>
          <Button tone="primary" disabled={!dupOf} busy={send.busy}
            onClick={() => { setPending("duplicate"); setFire((n) => n + 1); }}>
            Mark duplicate
          </Button>
          <button type="button" class="linkish" onClick={() => setPicking(false)}>cancel</button>
        </div>
      )}
      <Field label="note" hint="optional — why, for whoever reads this next">
        <textarea rows={2} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
      </Field>
      {send.error && <ErrorBox error={send.error} />}
      {reopen.error && <ErrorBox error={reopen.error} />}
    </Panel>
  );
}

/** The next finding still waiting for a verdict, so a morning's triage is a run of keystrokes. */
function NextOpen({ f }: { f: Detail }) {
  const list = useApi<FindingList>(`/api/findings?status=open&limit=200`, ["finding"]);
  const next = list.data?.findings.find((o) => o.id !== f.id);
  if (!list.data) return null;
  return next ? (
    <Link to={`/findings/${next.id}`} class="next-open">next open: {next.title} →</Link>
  ) : (
    <span class="faint">nothing else is open</span>
  );
}

function IssuePanel({ issue }: { issue: NonNullable<Finding["issue"]> }) {
  const label: Record<typeof issue.state, string> = {
    dry_run: "dry run — not sent",
    pending: "filing…",
    filed: "filed",
    failed: "failed",
    capped: "capped for today",
    no_repo: "no repository mapped",
  };
  return (
    <Panel
      title="GitHub issue"
      aside={<Pill kind={issue.state === "filed" ? "done" : issue.state === "failed" ? "failed" : "queued"}>{label[issue.state]}</Pill>}
    >
      <p class="stub">
        {issue.url ? <a href={issue.url} target="_blank" rel="noreferrer">{issue.url}</a> : <>{issue.title}</>}
        {issue.repo && <> · <code>{issue.repo}</code></>}
      </p>
      <p class="empty">{issue.detail}</p>
      <details class="json">
        <summary>issue body</summary>
        <pre>{issue.body}</pre>
      </details>
    </Panel>
  );
}

export function FindingPage({ id }: { id: string }) {
  const state = useApi<Detail>(`/api/findings/${encodeURIComponent(id)}`, ["finding"]);
  const names = useDeviceNames();

  return (
    <>
      <p class="crumbs"><Link to="/findings">← Findings</Link></p>
      <Loaded state={state} what="finding">
        {(f) => (
          <>
            <h1>{f.title}</h1>
            <Panel
              title={`#${f.id} · ${f.app}`}
              aside={
                <span class="with-icon">
                  <Pill kind={SEVERITY_PILL[f.severity]}>{f.severity}</Pill>
                  <CheckChip check={f.check} />
                  <VerdictPill f={f} />
                </span>
              }
            >
              <div class="stats">
                <Stat label="seen" value={`${f.seen_count}×`} />
                <Stat label={`build${f.builds_seen.length === 1 ? "" : "s"}`} value={f.builds_seen.length} />
                <Stat label="replay" value={<ReplayState f={f} />} />
                <Stat label="first seen" value={agoFrom(f.first_seen)} />
                <Stat label="last seen" value={agoFrom(f.last_seen)} />
              </div>
              <p class="empty">
                {f.screen_name || "unnamed screen"}
                {f.screen && <> (<code>{f.screen}</code>)</>} · <DeviceName id={f.device_id} names={names} /> ({f.platform}) ·
                mission <code>{f.mission_id}</code> · first found by <Link to={`/jobs/${encodeURIComponent(f.job_id)}`}>{f.job_id}</Link>
                {f.last_job_id && f.last_job_id !== f.job_id && (
                  <>, last by <Link to={`/jobs/${encodeURIComponent(f.last_job_id)}`}>{f.last_job_id}</Link></>
                )}
                {" "}· builds {f.builds_seen.join(", ")}
              </p>
              {f.duplicate_of && (
                <p class="stub">
                  Duplicate of <Link to={`/findings/${f.duplicate_of}`}>#{f.duplicate_of}{f.duplicate_of_title ? ` ${f.duplicate_of_title}` : ""}</Link>.
                </p>
              )}
              {f.verdict_note && <p class="stub">“{f.verdict_note}”</p>}
            </Panel>

            <VerdictBox key={f.id} f={f} onDone={state.reload} />
            <p class="next-row"><NextOpen f={f} /></p>

            <Panel title="What happened">
              <div class="finding-body">
                <figure class="finding-shot">
                  {f.artifacts.shot ? (
                    <a href={`/artifacts/${f.artifacts.shot}`} target="_blank" rel="noreferrer">
                      <img src={`/artifacts/${f.artifacts.shot}`} alt={`Screenshot at the moment: ${f.title}`} />
                    </a>
                  ) : (
                    <p class="empty">No screenshot was posted with this finding.</p>
                  )}
                </figure>
                <div>
                  {f.detail && <pre class="finding-detail">{f.detail}</pre>}
                  <h3 class="sub">Steps</h3>
                  {f.steps.length ? (
                    <ol class="finding-steps">{f.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                  ) : (
                    <p class="empty">No steps recorded.</p>
                  )}
                  <h3 class="sub">Evidence</h3>
                  <p class="artifact-links">
                    {ARTIFACTS.filter(([k]) => f.artifacts[k]).map(([k, label]) => (
                      <a key={k} href={`/artifacts/${f.artifacts[k]}`} target="_blank" rel="noreferrer">{label}</a>
                    ))}
                    {f.replay?.sha256 && !f.artifacts.replay && (
                      <a href={`/artifacts/${f.replay.sha256}`} target="_blank" rel="noreferrer">replay file</a>
                    )}
                    {!Object.values(f.artifacts).some(Boolean) && !f.replay?.sha256 && <span class="faint">none posted</span>}
                  </p>
                  {f.replay && (
                    <p class="empty">
                      Replayed {f.replay.attempts}× on a clean install ({f.replay.kind}); reproduced {f.replay.reproduced}×.
                    </p>
                  )}
                </div>
              </div>
            </Panel>

            {f.duplicates.length > 0 && (
              <Panel title="Marked as duplicates of this">
                <ul class="dup-list">
                  {f.duplicates.map((d) => (
                    <li key={d.id}><Link to={`/findings/${d.id}`}>#{d.id} {d.title}</Link> <span class="faint">seen {d.seen_count}×</span></li>
                  ))}
                </ul>
              </Panel>
            )}

            {f.issue && <IssuePanel issue={f.issue} />}

            <Actions>
              <span class="faint mono">fingerprint {f.fingerprint}</span>
            </Actions>
          </>
        )}
      </Loaded>
    </>
  );
}
