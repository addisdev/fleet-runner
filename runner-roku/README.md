# runner-roku

A Roku streaming player, or a Roku TV, as a device on the shelf.

A SceneGraph channel in BrightScript that speaks the same five-call JSON
protocol as the Android, iOS, desktop and browser runners and shares no code
with any of them. It registers, long-polls for work, runs a benchmark, beacons,
and reports results.

> **This has never run on a Roku.** No Roku hardware was available and no Roku
> emulator exists -- Roku has never shipped one, and BrightScript only runs on
> the device. Everything here was written against Roku's published API
> documentation. It has not been compiled, because the only BrightScript
> compiler is the one inside a television. [What is not
> verified](#what-is-not-verified) lists the specific claims, and the last
> column of [docs/platforms.md](../docs/platforms.md) says the same thing in the
> table where somebody comparing platforms would look.

## Read the backend name before reading a number

This runner declares **`benchmark:roevp`**. It does not declare `benchmark`, and
it does not declare `benchmark:synthetic`.

The fleet's `synthetic` backend measures SHA-256 throughput because that is a
fair CPU proxy several platforms can implement identically. BrightScript has no
hash of its own: the only one on the platform is `roEVPDigest`, a native OpenSSL
object, called once per round from an interpreted `for` loop. At 4 KiB a round
the native hash is a small fraction of the work -- the rest is the interpreter
dispatching a method call, allocating the returned hex string, parsing it back
into a byte array and copying 32 bytes with another interpreted loop. So the
rate measures the BrightScript interpreter's dispatch at least as much as it
measures the SoC.

That is the identical argument the browser runner makes for declaring
`benchmark:jssha` rather than `benchmark:synthetic`, and it lands the same way:

- **The rate is this runner's own column.** Two Rokus on the same firmware
  compare fairly with each other. Neither compares with a phone's `synthetic`
  rate, and putting them in one column would be laundering.
- **The correctness is the fleet's.** The block, the initialisation, the fold
  and the round count are ported token for token, and the runner reports
  `synthetic_digest` and `synthetic_rounds`, so conformance clause 4 proves the
  arithmetic is identical even though the clock is not.

There is no version of this that makes the rate comparable. The fold is
sequential -- round N+1's input is round N's output -- so no batching removes
the per-round interpreter dispatch. Refusing the name is the honest option, not
a workaround for a missing one.

A job asking for `backend: "synthetic"` is **refused with a sentence**, not
quietly served with a roevp number.

## Enrol a Roku

Developer mode first. On the remote: **Home ×3, Up ×2, Right, Left, Right, Left,
Right**. Accept the agreement, set a password, and the Roku reboots with a
sideload page on port 80 and ECP on port 8060.

```bash
# Store the developer password once, on the executor host. This prompts; it
# never takes the password as an argument.
security add-generic-password -s fleet-roku-dev -a rokudev -w

cd runner-roku
./build.sh --install 192.168.1.44 --launch http://fleet-host.local:8788 --device-id roku-den
```

That packages the channel, installs it, and launches it with the collector URL
as an ECP launch parameter. The channel writes `fleet_url` and `device_id` to
the registry, so every later launch needs no parameters at all.

**ECP is the point.** A Roku's only input is a five-way pad, and typing
`http://fleet-host.local:8788` on an on-screen keyboard is about forty button
presses with no way to paste. The channel does have a keyboard behind the OK
button, and it is a fallback for a Roku on a network with nothing to `curl`
from -- not the intended path.

Watch it arrive:

```bash
curl -s http://fleet-host.local:8788/api/devices | grep roku
telnet 192.168.1.44 8085          # the channel's debug console
```

## What it reports

```json
{
  "model": "Roku Ultra", "model_code": "4660X", "model_type": "STB",
  "soc": null, "ram_mb": null, "arch": null,
  "os": "roku-13.0.0", "app_ver": "0.5.0-dev",
  "platform": "roku", "kind": "tv"
}
```

Three fields are `null` on purpose, and each one is a refusal rather than a gap.

**`ram_mb`** is the one worth reading twice. The only memory API a channel has
is `GetGeneralMemoryLevel()`, which answers `"normal"`, `"low"` or
`"critical"` -- a pressure signal, not a quantity. There is no API for installed
RAM at all. Turning three words into a number would be exactly the failure
[Refuse rather than approximate](../docs/writing-a-runner.md) is about:
`ram_mb` is one of the two fields `targets.match` is most often written against,
so an invented `1024` would not sit harmlessly in a descriptor -- it would
decide which jobs reach this device, and it would appear in tables beside
numbers that were measured. The pressure signal is not thrown away: it rides on
every beacon as `mem_pressure`, a free-form string in the result schema, which
is the honest home for it.

**`soc`** because Roku exposes no CPU model, SoC or core count through any API.
A Roku Ultra's chip is a published fact but not one this channel can read, and
a lookup table from model code to SoC would be the runner asserting something it
did not measure.

**`arch`** because Roku has shipped both MIPS and ARM devices, and no API says
which this is. "Probably arm" is a guess, and a guess in `arch` is one a match
expression will act on.

**Battery reads 100 and charging reads true**, exactly as the tvOS runner does.
This is not a `-1` standing in for unknown. A Roku is mains-powered, so a job
with `require_charging` is genuinely satisfied by it -- reporting `-1` would make
every charging-constrained job refuse to run on hardware that meets the
constraint better than any phone does.

**There is no `thermal`.** Roku has no thermal API, not even a coarse one. The
field is absent rather than `"nominal"`, because `"nominal"` is a measurement
and this would not be one.

**There is no `ttl_s`.** A Roku is a shelf device: a physical thing in a room,
and one that is switched off should read offline rather than vanish. The cost is
real and visible -- see [foreground only](#it-only-runs-in-the-foreground).

## Size a Roku job explicitly

The default `prompt_tokens` of 512 is **512,000 folds**, each one an interpreted
method call. On a phone that is seconds. On a Roku it is UNVERIFIED and probably
much longer -- possibly many minutes per iteration.

The defaults are not lowered here, because a runner that quietly measures a
tenth of what it was asked for reports a number nobody requested. Ask for what
you want instead:

```json
{ "workload": "benchmark", "backend": "roevp",
  "params": { "prompt_tokens": 8, "gen_tokens": 4, "measure_iters": 3 } }
```

The agent beacons **between tokens rather than between iterations**, which is
the accommodation this slowness needed. On the other runners a token is
milliseconds and beaconing between iterations is enough; here a single iteration
can outlast a 600 s lease, and a claim swept mid-iteration means every result
posted afterwards is rejected while the channel is visibly still working.

## One collector, on purpose

This agent registers with exactly one brain. It implements neither half of the
multi-homing contract -- it never sends `busy` on a beacon and it never calls
`POST /jobs/{id}/release` -- because both are explicitly conditional on having
registered with more than one collector, and neither has anything to do when
there is only one. The rule underneath them, *a device runs one job at a time*,
is structural here: one poll loop that does not ask for work again until the job
it is running has returned.

Multi-homing a Roku would mean a poll loop per collector, and on a SceneGraph
Task that means a thread per collector. That is a design, not a line to add, and
it is not written.

## It only runs in the foreground

**Roku suspends a channel when the user presses Home.** The agent stops
polling, stops beaconing and goes offline on the shelf until somebody launches
it again. There is no background execution model for a Roku channel and no way
to ask for one -- this is the platform, not a limitation of this runner.

So a Roku on this fleet is a Roku dedicated to the fleet, or a Roku that joins
it between programmes. That is why it registers without a `ttl_s`: a suspended
channel is an offline device, not a departed one, and it should stay on the
shelf so a job can be pinned to it before somebody switches it back on.

**UNVERIFIED: whether the screensaver suspends it.** Roku shows a screensaver
after an idle period, and the documentation does not state plainly whether a
channel with no video playing keeps executing behind it, is suspended, or is
left running but throttled. All three are plausible and they have very different
consequences: the third would silently produce slow benchmark numbers with no
indication anywhere that a screensaver was the cause. Nobody has watched a Roku
long enough to find out, and this runner makes no claim either way. If you run
one, the thing to check is whether the beacons keep arriving after the
screensaver appears.

## Layout

Roku dictates most of this; it is not a design.

```
manifest                       channel metadata. MUST be at the archive root
source/main.brs                entry: reads launch args, shows the scene
components/FleetScene.xml/.brs the UI, the registry, the keyboard fallback
components/AgentTask.xml/.brs  the Task node: register, poll, run, beacon, report
components/SyntheticBackend.brs the fold, the attestation, and the self-test
images/                        icon and splash art at Roku's exact sizes
build.sh                       zips it, and installs over ECP
```

The split between the two components is the load-bearing part. A SceneGraph
render thread that blocks stops drawing and stops answering the remote, and Roku
eventually kills the channel; so every network call and every hash round happens
on the `AgentTask` thread, and the scene only reads fields off it. The first
symptom of getting that wrong is a Roku that appears to have crashed halfway
through a benchmark.

## The self-test

Because there is no BrightScript test runner in this repository and no emulator
to run one on, the channel checks its own arithmetic on every boot and shows the
verdict on screen:

- the block is `(i * 31) AND 255`, 4096 bytes;
- one fold writes 32 bytes over the front and leaves the tail alone;
- one fold's output matches the reference SHA-256 of a fresh block;
- 1000 folds produce
  `d7e8b70dfb48593edebc84967a969e78429f9ac6da8d0c681a4b57a2fe078a84`,
  which is what `scripts/conformance.ts` recomputes independently from the
  written specification.

**If it fails, the runner registers with an empty capability list** and refuses
benchmark jobs with a reason. A runner whose arithmetic is wrong must not take
work off the queue from one whose is right: from a dashboard, a wrong number and
a broken workload look identical, and only one of them gets investigated.

## What is not verified

Everything in this list is a claim from Roku's documentation that no device has
confirmed. They are collected here rather than scattered, because a reader
deciding whether to trust a number needs the list, not the footnotes.

| Claim | Why it is uncertain |
|---|---|
| **The channel compiles at all** | BrightScript's only compiler is on the device. There is no linter, no `bsc` and no emulator here; the code was reviewed by hand line by line and never parsed. A first sideload may well report a syntax error. |
| **`roEVPDigest.Process()` reinitialises** | Roku documents it as a one-shot over the whole input but does not say whether it resets the context first. The code calls `Reset()` before every `Process()` so it is correct either way, at the cost of one interpreted call per round. |
| **`Process()` returns lowercase hex** | Undocumented. The result is passed through `LCase()` before comparison, so a device that returns uppercase still agrees with the fleet. |
| **`FormatJSON` writes `invalid` as `null`** | Three descriptor fields are deliberately `invalid`. If a firmware refuses to serialise them, `FormatJSON` returns `""` and the agent reports "cannot serialise the request body" rather than POSTing an empty body -- so the failure is legible, but it has not been seen either way. |
| **The screensaver's effect on a running channel** | See [above](#it-only-runs-in-the-foreground). Suspended, throttled and unaffected are all plausible, and the throttled case would silently produce slow numbers. |
| **How slow a token actually is** | Nobody has measured one. The default job size may be wildly impractical. |
| **The `collector/src/drivers/roku.ts` socket path** | Its parsers are checked against recorded SSDP and device-info shapes in `drivers.test.ts`; the UDP multicast code is exercised by nothing. |

## The driver

[`collector/src/drivers/roku.ts`](../collector/src/drivers/roku.ts) makes Rokus
visible to the executor: an SSDP `M-SEARCH` for `roku:ecp`, then
`GET http://<ip>:8060/query/device-info` for the descriptor. It is the first
driver in the registry that reaches devices over the network rather than over a
cable and a vendor CLI.

**It does not install.** A dev channel install is a multipart POST to
`/plugin_install` behind HTTP digest authentication, Node's `fetch` has no
digest support, and implementing RFC 7616 by hand against no hardware to test it
on would produce code that looks finished and fails the first time somebody
actually has a Roku. `build.sh` does the install with `curl --digest`, which is
a correct digest client that already exists.

If it is implemented later, `rokuDevPassword()` in that file is the seam: it
reads the password from the executor host's Keychain, the way
`collector/src/secrets.ts` does. **A password must never travel in a job spec.**
`POST /jobs` is unauthenticated and specs are stored in SQLite, returned by the
API and rendered on the dashboard, so a secret in one is published to everyone
on the LAN.

One honest gap: a driver-discovered Roku is identified by its **serial number**,
and the agent identifies itself by `GetChannelClientId()`, which is a
per-publisher value ECP does not expose. Nothing outside the device can compute
it, so the two ids do not automatically match. Pass `--device-id` at launch if
you want them to.

## Conformance

```bash
cd collector
npm run conformance -- --device roku-den
```

Nine clauses. Clause 4 is the one this runner exists to satisfy honestly: it
recomputes the synthetic digest from the written specification and compares it
to what the agent reported. Clauses that this runner's capabilities put out of
scope are skipped rather than failed -- clause 9 among them, since a
single-brain agent that never sends `busy` is conformant by definition.

**No clause has been run against a Roku.**
