# Security policy

## Read this before reporting

**Fleet Runner has no authentication, by design.** The collector is built for a
home LAN or a tailnet. Anyone who can reach it can enqueue a job, and a job can
install software on a device, drive a browser, or run a UI suite.

That is the stated posture, not an oversight, and **"there is no authentication"
is not a vulnerability report.** The network is the access control:
`FLEET_BIND` decides which network, and setting it to loopback plus a tailnet
address is the configuration the documentation recommends.
`FLEET_DASH_TOKEN` guards the dashboard's mutations and is explicitly described
as a speed bump against a stray browser tab, not an access control — `POST /jobs`
stays open so `curl` and CI keep working.

If you want to put this on the public internet, the honest starting point is
that every endpoint would need re-thinking, not that a token would need adding.

## What is in scope

Given that posture, these are the things a report can meaningfully be about.

**The `shell` workload's trust boundary.** `shell` runs a script named by a job
spec, and `POST /jobs` is unauthenticated, so the machine agent refuses to take
the collector's word for anything: the owner pins a sha256 by hand in a local
allowlist file, the capability is declared **only** when that file exists and is
non-empty, and the hash is checked **before** the artifact is fetched. A way to
run an unpinned script, to make an unpinned machine declare the capability, or
to get a non-sha256 value past the check, is in scope.

**Artifact handling.** Path traversal in artifact names or `?filename=`, a hash
that is not verified where the code claims it is, or a way to make a job read or
write outside the artifact directory.

**The `web-*` workloads fetch arbitrary URLs from a job spec.** They are meant
to. A way to turn that into reading a local file, reaching a link-local metadata
address, or executing something on the executor host is in scope.

**Credential handling.** Job specs carry credential *names*, never secrets, and
the values come from the Keychain or the environment of the machine that needs
them. A path where a secret ends up in a job spec, a result row, an uploaded
artifact or a log is in scope — including build logs, which are uploaded on
failure.

**`FLEET_BIND` not doing what it says.** If the collector answers on an
interface the configuration excluded, that is a real bug, because it is the
control the whole posture rests on.

**Anything that escapes the stated boundary**: a request that reaches the host
beyond the documented API, a device left in a modified state that the journals
do not record, or a way to get code execution on an executor from a job spec
alone.

## What is out of scope

- The absence of authentication, authorisation, rate limiting, TLS or audit
  logging on the collector.
- That `POST /jobs` is open, or that `FLEET_DASH_TOKEN` does not protect it.
- Anything that requires being on the LAN or tailnet as a precondition and then
  does what the API already documents.
- Denial of service by enqueueing many jobs.
- Findings from a scanner against a deployment you do not own.

## Reporting

Use GitHub's private advisory form:
**[Report a vulnerability](https://github.com/addisdev/fleet-runner/security/advisories/new)**.

Please do not open a public issue for something in the in-scope list above.

This is a personal project maintained by one person. Expect a first response
within a week, and expect the fix to be a commit rather than a coordinated
release.

## Supported versions

The tip of `main`. There are no maintained release branches, and a fix will land
on `main` and in the next tag rather than being backported.

## What the design already does

Worth knowing, because it is where a report is least likely to find something:

- **Job specs never carry secrets**, and this is structural rather than
  validated — an unauthenticated enqueue endpoint means a spec is not a place a
  credential could safely live, so the agents read their own.
- **A build's failure log is uploaded anonymously**, because a log published
  under the app's name would become what a nightly asking for `"latest"` picks
  up.
- **A `serve` job's endpoint binds to loopback or the tailnet, never
  `0.0.0.0`** — an unauthenticated inference server on a laptop's hotel wifi is
  a different product to the one anybody asked for.
- **Dependabot is on for security alerts and security fixes only.** There is no
  `dependabot.yml`, deliberately, so version-bump pull requests do not bury the
  ones that matter.
