import { useKeyboard, SHORTCUTS } from "./keys.js";
import { useApi, type Peers } from "./api.js";
import { TokenBanner } from "./TokenBanner.js";
import { useLiveState } from "./live.js";
import { match, useRoute } from "./router.js";
import { Glyph, Icon, NAV_ICON } from "./icons.js";
import { Link, Panel } from "./ui.js";
import { Compose } from "./pages/Compose.js";
import { DeviceDetail } from "./pages/DeviceDetail.js";
import { Devices } from "./pages/Devices.js";
import { Enroll } from "./pages/Enroll.js";
import { JobDetail } from "./pages/JobDetail.js";
import { Jobs } from "./pages/Jobs.js";
import { Overview } from "./pages/Overview.js";
import { Schedules } from "./pages/Schedules.js";
import { AlertBanner, Alerts } from "./pages/Alerts.js";
import { Artifacts } from "./pages/Artifacts.js";
import { Evals, EvalSetPage } from "./pages/Evals.js";
import { Events } from "./pages/Events.js";
import { Results } from "./pages/Results.js";
import { Visual } from "./pages/Visual.js";

import { System } from "./pages/System.js";

const NAV = [
  ["/", "Overview"],
  ["/devices", "Devices"],
  ["/jobs", "Jobs"],
  ["/results", "Results"],
  ["/evals", "Evals"],
  ["/visual", "Visual"],
  ["/schedules", "Schedules"],
  ["/artifacts", "Artifacts"],
  ["/events", "Events"],
  ["/alerts", "Alerts"],
  ["/system", "System"],
] as const;

const LIVE_LABEL: Record<string, string> = {
  live: "live",
  connecting: "connecting",
  down: "offline",
};

function LiveDot() {
  const state = useLiveState();
  return (
    <span
      class={`live ${state}`}
      title={
        state === "live"
          ? "Streaming updates from the collector"
          : "Not receiving updates — the collector may be restarting"
      }
    >
      <i />
      {LIVE_LABEL[state]}
    </span>
  );
}

function NotFound({ route }: { route: string }) {
  return (
    <>
      <h1>Not found</h1>
      <Panel>
        <p class="stub">
          No dashboard route at <code>{route}</code>. <Link to="/">Back to the overview</Link>.
        </p>
      </Panel>
    </>
  );
}

function Router() {
  const route = useRoute();

  if (match("/", route)) return <Overview />;
  if (match("/system", route)) return <System />;
  if (match("/alerts", route)) return <Alerts />;
  if (match("/devices", route)) return <Devices />;
  // Before /devices/:id, or "new" reads as a device id.
  if (match("/devices/new", route)) return <Enroll />;
  if (match("/jobs", route)) return <Jobs />;
  // Before /jobs/:id, or "new" would be read as a job id.
  if (match("/jobs/new", route)) return <Compose />;
  if (match("/results", route)) return <Results />;
  if (match("/evals", route)) return <Evals />;
  if (match("/visual", route)) return <Visual />;
  if (match("/artifacts", route)) return <Artifacts />;
  if (match("/events", route)) return <Events />;
  if (match("/schedules", route)) return <Schedules />;

  // Keyed on the id so switching between two detail pages remounts rather than
  // showing the previous device's charts under the new device's name.
  const device = match("/devices/:id", route);
  if (device) return <DeviceDetail key={device.id} id={device.id} />;
  const job = match("/jobs/:id", route);
  if (job) return <JobDetail key={job.id} id={job.id} />;
  // After the literal /evals above, for the same reason /devices/new is before
  // /devices/:id — a literal segment must never be read as an id.
  const evalSet = match("/evals/:sha", route);
  if (evalSet) return <EvalSetPage key={evalSet.sha} sha={evalSet.sha} />;


  return <NotFound route={route} />;
}

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div class="overlay" onClick={onClose}>
      <div class="help" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard</h2>
        <table>
          {SHORTCUTS.map((s) => (
            <tr key={s.keys}>
              <td>
                <kbd>{s.keys}</kbd>
              </td>
              <td>{s.does}</td>
            </tr>
          ))}
        </table>
        <button type="button" class="linkish" onClick={onClose}>
          close
        </button>
      </div>
    </div>
  );
}

/**
 * Which brain this is, and the others it knows about.
 *
 * Absent entirely when no peers are configured, which is the overwhelmingly
 * common case -- one fleet, one dashboard, and a name in the header would be
 * chrome answering a question nobody asked.
 *
 * The links navigate to the OTHER brain's own dashboard rather than pulling its
 * data into this one. That is deliberate and is the same rule the peers proxy
 * follows: mutations are not proxied, so a screen that mixed two fleets would
 * have a compose button whose target was ambiguous. One origin, one owner of
 * that queue.
 */
function BrainSwitcher() {
  const { data } = useApi<Peers>("peers", [], 30_000);
  if (!data || data.peers.length === 0) return null;
  return (
    <span class="brains">
      <span class="brain-self" title={data.self.id}>
        {data.self.name}
      </span>
      {data.peers.map((p) => (
        <a
          key={p.url}
          href={`${p.url}/dash`}
          class={p.reachable ? "brain-peer" : "brain-peer down"}
          title={
            p.reachable
              ? `${p.devices ? `${p.devices.online} of ${p.devices.total} devices online` : "up"} — opens ${p.url}`
              : `unreachable: ${p.error ?? "no answer"}`
          }
        >
          {p.name ?? p.url.replace(/^https?:\/\//, "")}
          {p.reachable && p.devices ? <span class="faint"> {p.devices.online}</span> : null}
        </a>
      ))}
    </span>
  );
}

export function App() {
  const { help, setHelp } = useKeyboard();

  return (
    <div class="shell">
      <header class="topbar">
        <span class="brand">
          <Glyph />
          <span>
            Fleet Runner <span>collector</span>
          </span>
        </span>
        <BrainSwitcher />
        <nav class="nav">
          {NAV.map(([to, label]) => {
            const icon = NAV_ICON[to];
            return (
              <Link key={to} to={to}>
                {icon && <Icon name={icon} />}
                {label}
              </Link>
            );
          })}
        </nav>
        <LiveDot />
      </header>
      <TokenBanner />
      <AlertBanner />
      <main>
        <Router />
      </main>
      <footer class="footer">
        <a href="/dash/legacy">legacy dashboard</a>
        <a href="/api/overview">/api/overview</a>
        <button type="button" class="linkish" onClick={() => setHelp(true)}>
          keyboard (?)
        </button>
      </footer>
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
