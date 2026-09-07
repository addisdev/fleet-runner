' ============================================================================
' The Roku agent: register, long-poll, claim, beacon, report.
'
' The same five HTTP calls every other runner in this repository makes, in a
' fifth language, sharing no code with any of them. That is the bargain
' docs/protocol.md describes and the reason this file re-implements SHA-256
' folding, JSON bodies and a poll loop that already exist four times over.
'
' NOTHING IN THIS FILE HAS RUN ON A ROKU. There is no Roku emulator -- Roku has
' never shipped one and BrightScript only runs on the device -- and no Roku
' hardware was available. Every claim below about how the platform behaves comes
' from Roku's published API documentation, not from having watched it. The
' places where that matters most are marked UNVERIFIED, and the README lists
' them together.
'
' == One collector, on purpose ==
'
' This agent registers with exactly one brain, so it implements neither half of
' the multi-homing contract: it never sends `busy` on a beacon and it never
' calls `POST /jobs/:id/release`. Both are explicitly conditional on having
' registered with more than one collector -- `busy` exists to tell the brains
' that are NOT running your job to stop offering, and `release` exists to hand
' back the job you lost a two-brain race for. With one brain there is no other
' queue to inform and no race to lose, and the one rule underneath both -- a
' device runs one job at a time -- is structural here: a single poll loop that
' does not ask again until `runJob` returns.
'
' Multi-homing a Roku would mean a poll loop per collector, which on a Task
' thread means a thread per collector. That is a real design, not a line to
' add, and it is not written.
'
' == What this runner declares, and why it is not `synthetic` ==
'
' `benchmark:roevp`, never `benchmark` and never `benchmark:synthetic`. The
' reasoning is in SyntheticBackend.brs; the short version is that each round is
' one native roEVPDigest call driven from an interpreted loop, so the rate
' measures the BrightScript interpreter's dispatch as much as it measures the
' SoC. Correctness is still comparable and is attested with `synthetic_digest`.
' A rate is this runner's own column; the digest is the fleet's.
' ============================================================================

sub init()
    m.top.functionName = "runAgent"
end sub

' ----------------------------------------------------------------------------
' Constants
' ----------------------------------------------------------------------------

function SCHEMA_VERSION() as Integer
    return 1
end function

' The client-side deadline on a long poll. The collector holds it open for
' about 25 seconds; 40 is the same margin every other runner uses, and it is a
' margin rather than a timeout -- a poll that returns at 25 s is normal and a
' poll still open at 40 s means the connection is wedged, not that the queue is
' quiet.
function POLL_DEADLINE_MS() as Integer
    return 40000
end function

' Any other request. Long enough for a slow LAN, short enough that a collector
' that has gone away is noticed within one loop.
function REQUEST_TIMEOUT_MS() as Integer
    return 15000
end function

' Beacon interval. The protocol asks for one every 60 s or so, idle or not.
' Because a poll occupies up to 40 s of every loop, checking on this clock at
' the top of each pass produces one every 30-70 s -- inside "or so", and
' comfortably inside a 600 s benchmark lease.
function BEACON_INTERVAL_MS() as Integer
    return 30000
end function

' ----------------------------------------------------------------------------
' The agent
' ----------------------------------------------------------------------------

sub runAgent()
    base = fleetTrimSlashes(m.top.fleetUrl)
    if base = ""
        setStatus("no collector", "set fleet_url and relaunch")
        return
    end if
    m.base = base

    ' The self-test before anything else, and its result gates the capability
    ' list. A runner whose synthetic block does not match the fleet's must not
    ' take benchmark jobs off the queue from one whose does -- from the
    ' dashboard, a wrong number and a broken workload look identical, and only
    ' one of them gets investigated.
    setStatus("checking the synthetic block", "")
    selfTest = fleetSelfTest()
    m.top.digest = selfTest.digest
    if not selfTest.ok
        setStatus("synthetic block is wrong", selfTest.detail + " -- this Roku will register but declares no benchmark capability")
    end if
    m.selfTest = selfTest

    m.deviceId = resolveDeviceId()
    m.top.deviceId = m.deviceId

    if not registerDevice()
        ' Registration failing is not fatal. The loop below retries it on every
        ' pass, because the usual cause is a collector that has not started yet
        ' and a Roku that gives up needs someone to walk over and relaunch it.
        setStatus("collector unreachable", "retrying")
    end if

    ' The beacon clock is re-marked on every beacon rather than being read as an
    ' absolute time since start. roTimespan.TotalMilliseconds() returns a 32-bit
    ' integer, which wraps after about 25 days -- and a Roku left as the
    ' foreground channel for a month is a thing this fleet would actually do. A
    ' relative timer never gets near the ceiling.
    m.beaconClock = CreateObject("roTimespan")
    m.beaconClock.Mark()

    while true
        if m.beaconClock.TotalMilliseconds() >= BEACON_INTERVAL_MS()
            m.beaconClock.Mark()
            ' Re-register alongside the idle beacon. Registration is an upsert,
            ' and this is what brings a Roku back onto the shelf after the
            ' collector was restarted -- without it a channel that has been in
            ' the foreground for a week polls forever against a registry that
            ' has never heard of it.
            registerDevice()
            sendBeacon("")
        end if

        job = claimJob()
        if job <> invalid
            runJob(job)
        end if
    end while
end sub

' ----------------------------------------------------------------------------
' Identity
' ----------------------------------------------------------------------------

' The device_id, in preference order: whatever the scene was given (a launch
' parameter or the registry), else one derived from the device.
'
' GetChannelClientId() is stable per device per channel publisher and survives
' reinstalling the channel, which is exactly the "stable across restarts"
' property the protocol asks for. It does NOT survive a factory reset, and it is
' not the same value another publisher's channel would see on the same Roku --
' both of which are fine here and neither of which is obvious from the name.
'
' It is long and opaque, so a person naming their Rokus should pass device_id
' over ECP; this is the answer for a Roku nobody named.
function resolveDeviceId() as String
    given = m.top.deviceId
    if given <> "" then return given

    info = CreateObject("roDeviceInfo")
    clientId = info.GetChannelClientId()
    if clientId = invalid then clientId = "unknown"
    if clientId = "" then clientId = "unknown"
    return "roku-" + clientId
end function

' What this Roku can honestly say about itself.
'
' Three fields are null on purpose, and each one is a refusal rather than a gap.
' They are the reason this function is long: writing `invalid` takes one line
' and justifying it takes ten, and the justification is the part that stops
' somebody helpfully filling them in later.
function describe() as Object
    info = CreateObject("roDeviceInfo")

    version = info.GetOSVersion()
    osName = "roku"
    if version <> invalid
        osName = "roku-" + fleetStr(version.major) + "." + fleetStr(version.minor) + "." + fleetStr(version.revision)
    end if

    appVer = "unknown"
    appInfo = CreateObject("roAppInfo")
    if appInfo <> invalid
        ' A custom manifest key rather than GetVersion(). GetVersion() returns
        ' the three integers Roku requires, which cannot express "0.5.0-dev",
        ' and a development sideload reporting a released version number would
        ' put an unreleased build's rows next to a released build's.
        v = appInfo.GetValue("app_ver")
        if v <> invalid
            if v <> "" then appVer = v
        end if
    end if

    ' Built into a local and then returned, rather than returned as a literal.
    ' A multi-line literal is unambiguous on the right of an assignment;
    ' whether one is accepted as the operand of `return` is exactly the sort of
    ' thing that would compile everywhere except on the firmware you have, and
    ' nothing here can compile it at all. Same reason as the Cdbl() note below.
    d = {
        model: info.GetModelDisplayName(),

        ' The model code, e.g. "4660X". Not part of the protocol's named
        ' descriptor fields -- the descriptor is open, and this is included
        ' because "Roku Ultra" has meant four different pieces of hardware and
        ' the code is the only thing that separates them in a results table.
        model_code: info.GetModel(),

        ' "TV", "STB" or "Projector". `kind` below is the fleet's vocabulary and
        ' has one bucket for all three; this keeps the distinction a match
        ' expression might actually want.
        model_type: info.GetModelType(),

        ' NULL: Roku exposes no SoC, CPU model or core count through any API.
        ' roDeviceInfo answers questions about the display, the network and the
        ' firmware, and nothing at all about the silicon. A Roku Ultra's chip is
        ' a published fact but it is not a fact this channel can read, and
        ' hard-coding a lookup table from model code to SoC would be this file
        ' asserting something it did not measure.
        soc: invalid,

        ' NULL, and this is the one worth reading twice.
        '
        ' The only memory API a channel has is GetGeneralMemoryLevel(), which
        ' returns "normal", "low" or "critical" -- a pressure signal, not a
        ' quantity. There is no API for installed RAM. Turning three words into
        ' a number would be exactly the "refuse rather than approximate" failure
        ' docs/writing-a-runner.md is about: `ram_mb` is one of the two fields
        ' `targets.match` is most often written against, so an invented 1024
        ' here does not sit harmlessly in a descriptor -- it decides which jobs
        ' get sent to this device and appears in tables next to numbers that
        ' were actually measured.
        '
        ' The pressure signal is not thrown away: it rides on every beacon as
        ' `mem_pressure`, which is a free-form string in the result schema and
        ' is the honest home for it.
        ram_mb: invalid,

        os: osName,
        app_ver: appVer,

        ' NULL. Roku has shipped both MIPS and ARM devices -- the early Roku
        ' players were MIPS and everything current is ARM -- and no API reports
        ' which one this is. "Probably arm" is a guess, and a guess in `arch` is
        ' a guess a job's match expression will act on.
        arch: invalid,

        platform: "roku",

        ' Every Roku is attached to a television and every Roku is a television
        ' from the fleet's point of view, including the sticks: `kind` is the
        ' form factor of the thing on the shelf, and a stick with no display of
        ' its own is still the TV in the living room. `model_type` above carries
        ' the finer distinction for anyone who needs it.
        kind: "tv"
    }
    return d
end function

' What this runner declares it can run.
'
' One entry, and only when the arithmetic checked out. Never bare `benchmark`
' and never `benchmark:synthetic`: either would let a job asking for the fleet's
' cross-platform number land here, and this runner cannot produce that number.
' Naming `roevp` is what keeps a BrightScript interpreter's rate out of a column
' of phones' rates while still letting somebody ask for it deliberately.
function capabilities() as Object
    ' Nested rather than `m.selfTest <> invalid and m.selfTest.ok`. BrightScript
    ' is documented to short-circuit `and` on Boolean operands, but the left
    ' side here is a comparison against invalid and the right side dereferences
    ' the thing being tested -- so if that documentation is wrong on any
    ' firmware, this line is a runtime error that kills the agent thread. The
    ' same shape appears a few times below and is nested everywhere for the same
    ' reason; it is not worth being clever about on a platform nothing here can
    ' run.
    if m.selfTest <> invalid
        if m.selfTest.ok then return ["benchmark:roevp"]
    end if
    ' An empty list is not the same as omitting the key -- see the protocol. It
    ' says "nothing", which is the true answer for a device whose only backend
    ' just failed its own self-test.
    return []
end function

' Register. An upsert, called on startup and on every beacon tick.
'
' There is no `ttl_s`, deliberately. A Roku is a shelf device: a physical thing
' in a room, and one that has been switched off should stay in the registry
' reading offline rather than vanishing -- the same way a switched-off phone
' does. A TTL is for agents whose disappearance is normal: a closed browser tab,
' a finished CI runner, a container that exited. A television is not one of
' those, and without a row on the shelf there is nothing to pin a job to when
' somebody switches it back on.
'
' This is a real trade-off rather than a default, and the cost is visible: Roku
' suspends a channel when the user presses Home, so a Roku that is switched on
' and being used to watch television reads offline here. Offline-but-present is
' the truth in that case. Expired-and-gone would not be.
function registerDevice() as Boolean
    body = {
        device_id: m.deviceId,
        descriptor: describe(),
        pools: ["roku"],
        capabilities: capabilities()
    }
    res = httpJson("POST", m.base + "/devices/register", body, REQUEST_TIMEOUT_MS())
    if res.code >= 200 and res.code < 300
        setStatus("waiting for work", "registered as " + m.deviceId)
        return true
    end if
    setStatus("collector unreachable", "register -> " + fleetHttpDetail(res))
    return false
end function

' ----------------------------------------------------------------------------
' The loop
' ----------------------------------------------------------------------------

' One long poll. Returns a job spec, or invalid for "nothing to do".
'
' A 204 is the normal answer and is not an error: call again immediately. A
' transport failure backs off, and says so on screen, because a runner that is
' quietly retrying and a runner that is dead look the same from across a room.
function claimJob() as Object
    url = m.base + "/devices/" + fleetEscape(m.deviceId) + "/next-job"
    res = httpJson("GET", url, invalid, POLL_DEADLINE_MS())

    if res.code = 204 then return invalid
    if res.code = 200
        job = ParseJSON(res.body)
        if job = invalid or type(job) <> "roAssociativeArray"
            setStatus("waiting for work", "collector sent a 200 that is not a job spec")
            return invalid
        end if
        return job
    end if

    setStatus("collector unreachable", "next-job -> " + fleetHttpDetail(res) + "; retrying in 10s")
    fleetSleep(10000)
    return invalid
end function

' A beacon. Returns false when the claim is gone.
'
' `lease_renewed: false` means swept, closed or cancelled, and handling that one
' branch handles cancellation too -- which is the whole reason the collector has
' no separate cancel channel. Only an explicit false counts: a missing field, a
' proxy's HTML error page or a transport failure must all read as renewed, or a
' flaky network silently kills every job on the shelf.
function sendBeacon(jobId as String) as Boolean
    info = CreateObject("roDeviceInfo")

    sample = {
        ' 100 and charging, exactly as the tvOS runner reports. An Apple TV has
        ' no battery API because it is mains-powered; a Roku has none for the
        ' same reason. This is not a battery reading -1 for "unknown" -- the
        ' device really is permanently on external power, and a constraint
        ' asking for `require_charging` is genuinely satisfied by it. Reporting
        ' -1 instead would make every charging-constrained job refuse to run on
        ' hardware that meets the constraint better than any phone.
        battery_pct: 100,
        charging: true,

        ' No thermal API on Roku at all -- not a coarse one, none. Absent rather
        ' than "nominal", because "nominal" is a measurement and this is not one.
        thermal: invalid,

        ' The memory pressure signal that could not honestly become `ram_mb`.
        ' `mem_pressure` is a free-form string in the result schema, so
        ' "normal" / "low" / "critical" goes in as the three words Roku actually
        ' says rather than as a number nobody measured.
        mem_pressure: info.GetGeneralMemoryLevel()
    }

    body = {
        schema: SCHEMA_VERSION(),
        kind: "beacon",
        device_id: m.deviceId,
        beacon: sample
    }
    if jobId <> "" then body.job_id = jobId

    res = httpJson("POST", m.base + "/results", body, REQUEST_TIMEOUT_MS())
    if res.code < 200 or res.code >= 300 then return true ' see the header: not a cancellation

    reply = ParseJSON(res.body)
    if reply = invalid or type(reply) <> "roAssociativeArray" then return true
    if not reply.DoesExist("lease_renewed") then return true

    ' The type is checked before the value is. Comparing a string to a Boolean
    ' with <> is a runtime Type Mismatch in BrightScript, which would kill this
    ' thread outright -- so a proxy that answered `"lease_renewed": "false"`
    ' would not merely be misread, it would stop the agent. Only a real Boolean
    ' false is a cancellation; anything else reads as renewed.
    renewed = reply.lease_renewed
    t = type(renewed)
    if t = "Boolean" or t = "roBoolean" then return renewed
    return true
end function

sub runJob(job as Object)
    jobId = fleetStr(job.job_id)
    workload = fleetStr(job.workload)
    backend = fleetStr(job.backend)

    setStatus("running " + jobId, workload + " / " + backend)

    refusal = refuseReason(job)
    if refusal <> ""
        ' A refusal is a closed job with a sentence in `error`, not silence and
        ' not a bounced claim. The dashboard shows that sentence against the
        ' job, so it has to be one a person can act on.
        postFinal(jobId, false, invalid, refusal)
        setStatus("waiting for work", "refused " + jobId + ": " + refusal)
        return
    end if

    runBenchmark(job, jobId)
end sub

' What this runner will not do, checked before any work starts.
'
' Returns "" to proceed, or the sentence that goes in `error`.
function refuseReason(job as Object) as String
    workload = fleetStr(job.workload)
    if workload <> "benchmark"
        return "workload '" + workload + "' is not supported by the Roku runner; it runs benchmark only"
    end if

    ' A job that names no backend at all is accepted and run as roevp, which is
    ' what the browser runner does with `jssha`. It is safe because this agent
    ' never declares bare `benchmark`: capability routing cannot send an
    ' unqualified benchmark here, so the only way to arrive with no backend is
    ' for somebody to have pinned this device by id -- and having asked for this
    ' Roku specifically, they meant its backend.
    '
    ' `synthetic` is refused rather than silently substituted. A job asking for
    ' `synthetic` is asking for the fleet's cross-platform number, and answering
    ' it with an interpreter-bound rate under that name is precisely the
    ' laundering this runner is named `roevp` to avoid.
    backend = fleetStr(job.backend)
    if backend <> ""
        if backend <> "roevp"
            return "backend '" + backend + "' is not available on Roku. BrightScript's only hash is roEVPDigest, called once per round from an interpreted loop, so this runner declares benchmark:roevp and its rate is NOT comparable with a native runner's 'synthetic' rate -- ask for backend 'roevp'"
        end if
    end if

    if m.selfTest = invalid
        return "the Roku runner never completed its synthetic self-test, so it cannot say whether its numbers would be comparable"
    end if
    if not m.selfTest.ok
        return "the synthetic block does not match the fleet reference on this device, so any number from it would be incomparable: " + m.selfTest.detail
    end if

    ' The two constraints a runner owns. The collector enforces the rest before
    ' it ever offers the job.
    '
    ' Both are trivially satisfied here because a Roku is mains-powered and
    ' reports 100 / charging, and that is a real answer rather than a bypass:
    ' the device genuinely meets them. The branches exist so that a spec asking
    ' for something unmeetable -- min_battery_pct above 100 -- is refused with a
    ' reason instead of silently passing.
    constraints = job.constraints
    if constraints <> invalid and type(constraints) = "roAssociativeArray"
        if constraints.DoesExist("min_battery_pct")
            minPct = fleetNum(constraints.min_battery_pct, 0)
            if minPct > 100
                return "min_battery_pct is " + fleetStr(constraints.min_battery_pct) + ", which no device can meet; a Roku is mains-powered and reports 100"
            end if
        end if
    end if

    return ""
end function

' ----------------------------------------------------------------------------
' The benchmark
' ----------------------------------------------------------------------------

sub runBenchmark(job as Object, jobId as String)
    params = job.params
    if params = invalid or type(params) <> "roAssociativeArray" then params = {}

    ' The same defaults as the other four runners. They are sized for a phone,
    ' and on a Roku they are almost certainly far too large -- see the README:
    ' 512 prompt tokens is 512,000 folds, each one an interpreted method call,
    ' and how long that actually takes on Roku hardware is UNVERIFIED. A job
    ' aimed at a Roku should set prompt_tokens and gen_tokens explicitly. The
    ' defaults are not lowered because a runner that quietly measures a tenth of
    ' what it was asked for reports a number for work nobody requested.
    promptTokens = fleetNum(params.prompt_tokens, 512)
    genTokens = fleetNum(params.gen_tokens, 128)
    warmups = fleetNum(params.warmup_iters, 1)
    measures = fleetNum(params.measure_iters, 3)

    digest = fleetNewDigest()
    if digest = invalid
        ' Unreachable if refuseReason did its job, since the self-test needed a
        ' working digest. Kept because "unreachable" and "crashes the agent
        ' thread if it is ever reached" is a bad pair.
        postFinal(jobId, false, invalid, "roEVPDigest has no sha256 on this firmware")
        return
    end if

    m.jobId = jobId
    m.cancelled = false

    ' `load` on a real backend is loading a model. Here it is allocating the
    ' block and warming the digest object, which is the honest analogue and is
    ' reported under the same name because it is the same phase of the same
    ' shape of work.
    loadSpan = CreateObject("roTimespan")
    loadSpan.Mark()
    block = fleetInitBlock()
    digest.Reset()
    digest.Process(block)
    loadMs = loadSpan.TotalMilliseconds()

    ' Warm-ups are discarded, so they do not need their own block state beyond
    ' being reset for the measured runs below.
    for w = 1 to warmups
        block = fleetInitBlock()
        runTokens(digest, block, 1)
        if m.cancelled
            ' Cancelled during a warm-up still closes the job with a verdict.
            ' Returning silently here would leave the row claimed until the
            ' lease swept it, which the dashboard shows as a timeout on a device
            ' that was working normally.
            postFinal(jobId, false, invalid, "cancelled")
            return
        end if
    end for

    ' Cdbl() rather than BrightScript's `#` type-suffix syntax throughout.
    ' Both are documented, but a suffix that a given firmware's parser dislikes
    ' is a channel that will not compile at all, and nothing here could have
    ' compiled it to find out -- see the header. Cdbl() is a plain global
    ' function call and cannot be a parse error.
    prefillTotal = Cdbl(0)
    decodeTotal = Cdbl(0)
    ttftTotal = Cdbl(0)
    rows = 0

    for iter = 1 to measures
        if m.cancelled
            postFinal(jobId, false, invalid, "cancelled")
            return
        end if

        ' A fresh block for every iteration, so iteration 3 folds the same bytes
        ' iteration 1 did. Carrying the block over would make each iteration
        ' hash different data than the last -- still the same amount of work, so
        ' the tok/s would look fine, but the run would no longer be the fixed
        ' computation the digest attests to.
        block = fleetInitBlock()

        span = CreateObject("roTimespan")
        span.Mark()
        runTokens(digest, block, promptTokens)
        prefillMs = span.TotalMilliseconds()

        span.Mark()
        runTokens(digest, block, 1)
        firstTokenMs = span.TotalMilliseconds()

        span.Mark()
        runTokens(digest, block, genTokens - 1)
        decodeMs = firstTokenMs + span.TotalMilliseconds()

        if m.cancelled
            postFinal(jobId, false, invalid, "cancelled")
            return
        end if

        ' The phones' arithmetic exactly, including the 1 ms clamp that keeps a
        ' sub-millisecond phase reporting a large number rather than dividing by
        ' zero. In double precision: BrightScript's default float is 32-bit, and
        ' a tok/s that lands in a results table as 1024.00006 is a distraction
        ' with no cause anybody reading the table can see.
        prefillTokS = (Cdbl(promptTokens) * 1000.0) / fleetMaxMs(prefillMs)
        decodeTokS = (Cdbl(genTokens) * 1000.0) / fleetMaxMs(decodeMs)
        ttftMs = Cdbl(prefillMs + firstTokenMs)

        prefillTotal = prefillTotal + prefillTokS
        decodeTotal = decodeTotal + decodeTokS
        ttftTotal = ttftTotal + ttftMs
        rows = rows + 1

        ' One row per measured iteration, plus the summary below. Conformance
        ' asks for these: a benchmark that posts only a summary is a number
        ' whose spread nobody can see.
        row = {
            prefill_tok_s: prefillTokS,
            decode_tok_s: decodeTokS,
            ttft_ms: ttftMs
        }
        iterBody = {
            schema: SCHEMA_VERSION(),
            kind: "result",
            device_id: m.deviceId,
            job_id: jobId,
            iter: iter,
            metrics: row
        }
        httpJson("POST", m.base + "/results", iterBody, REQUEST_TIMEOUT_MS())

        setStatus("running " + jobId, "iter " + iter.ToStr() + "/" + measures.ToStr() + ": " + fleetStr(Int(decodeTokS)) + " decode tok/s (roevp)")
    end for

    if rows = 0
        postFinal(jobId, false, invalid, "measure_iters was " + measures.ToStr() + ", so nothing was measured")
        return
    end if

    metrics = {
        load_ms: loadMs,
        prefill_tok_s: prefillTotal / rows,
        decode_tok_s: decodeTotal / rows,
        ttft_ms: ttftTotal / rows,

        ' Correctness, even though the rate above is this runner's own column.
        ' This is the number conformance clause 4 recomputes from the written
        ' specification: it proves this BrightScript port folds the identical
        ' block through identical rounds as the Kotlin, Swift, TypeScript and
        ' JavaScript ones, which is the only thing about a Roku's benchmark that
        ' is comparable with the rest of the fleet.
        synthetic_digest: m.selfTest.digest,
        synthetic_rounds: FLEET_ATTEST_ROUNDS()
    }

    postFinal(jobId, true, metrics, "")
    m.top.jobsRun = m.top.jobsRun + 1
    setStatus("waiting for work", "finished " + jobId)
end sub

' `count` tokens of folding, beaconing on a clock while it works.
'
' The beacon inside this loop is the load-bearing part. On the other runners a
' token is milliseconds and beaconing between iterations is often enough; here a
' single iteration can plausibly run for many minutes, so a benchmark with a
' 600 s lease would have its claim swept out from under it mid-iteration and
' every result posted afterwards would be rejected -- with the channel still
' hashing, and the dashboard showing a job that timed out on a device that was
' visibly busy. Beaconing per token is also what makes a cancellation land
' within one interval rather than at the end of the run.
'
' `count <= 0` does nothing, which is the `gen_tokens - 1 == -1` edge every
' other runner handles the same way.
sub runTokens(digest as Object, block as Object, count as Integer)
    for i = 1 to count
        fleetFoldBlock(digest, block, FLEET_ROUNDS_PER_TOKEN())
        if m.beaconClock.TotalMilliseconds() >= BEACON_INTERVAL_MS()
            m.beaconClock.Mark()
            if not sendBeacon(m.jobId)
                ' The claim is gone: swept, closed, or cancelled. Stop rather
                ' than finish work nothing will accept.
                m.cancelled = true
                return
            end if
        end if
    end for
end sub

' The one row per device per job that carries `final`.
sub postFinal(jobId as String, ok as Boolean, metrics as Object, errorText as String)
    body = {
        schema: SCHEMA_VERSION(),
        kind: "result",
        device_id: m.deviceId,
        job_id: jobId,
        iter: 0,
        final: true,
        ok: ok,
        device: describe()
    }
    if metrics <> invalid then body.metrics = metrics
    if errorText <> "" then body.error = errorText
    httpJson("POST", m.base + "/results", body, REQUEST_TIMEOUT_MS())
end sub

' ----------------------------------------------------------------------------
' HTTP
'
' roUrlTransfer, one per request. It is NOT reusable across async requests --
' Roku's own documentation says a transfer object may have only one outstanding
' request -- and reusing one is a class of bug that shows up as an event from
' the previous request being delivered against the current one. A fresh message
' port per request for the same reason: a cancelled long poll can still deliver
' its event afterwards, and a shared port would hand that stale event to the
' next call.
'
' This is also why every network call in this channel is on the Task thread.
' roUrlTransfer's synchronous methods are not permitted on the render thread at
' all, and the async ones there would deliver into a port nothing is waiting on.
' ----------------------------------------------------------------------------

' Returns { code, body, error }. `code` is the HTTP status, or 0 for a timeout,
' or a negative libcurl code for a transport failure.
function httpJson(method as String, url as String, body as Object, timeoutMs as Integer) as Object
    xfer = CreateObject("roUrlTransfer")
    if xfer = invalid then return { code: 0, body: "", error: "no roUrlTransfer" }

    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    xfer.SetUrl(url)

    ' The single most common way a Roku channel's HTTPS silently fails. Without
    ' a certificate bundle every TLS request returns -77 and no body, which
    ' reads as "the collector is down" and is really "this channel never told
    ' the device where its CA bundle is". Harmless on plain HTTP, which is what
    ' a LAN collector is, so it is set unconditionally.
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()

    started = false
    if method = "GET"
        started = xfer.AsyncGetToString()
    else
        payload = FormatJSON(body)
        ' FormatJSON returns an empty string when it cannot serialise something.
        ' Checked rather than assumed, because the alternative is POSTing an
        ' empty body to /devices/register and getting a 400 that says nothing
        ' about which field was the problem. UNVERIFIED: the descriptor contains
        ' `invalid` values on purpose and Roku's documentation does not state
        ' plainly that FormatJSON writes those as JSON null. If a Roku ever
        ' reports "cannot serialise the request body", that is what happened,
        ' and the fix is to omit those keys rather than to invent values for
        ' them.
        if payload = ""
            return { code: 0, body: "", error: "cannot serialise the request body" }
        end if
        xfer.AddHeader("Content-Type", "application/json")
        started = xfer.AsyncPostFromString(payload)
    end if

    if not started then return { code: 0, body: "", error: "request could not be started" }

    event = wait(timeoutMs, port)
    if event = invalid
        xfer.AsyncCancel()
        return { code: 0, body: "", error: "no response within " + timeoutMs.ToStr() + " ms" }
    end if

    if type(event) <> "roUrlEvent"
        xfer.AsyncCancel()
        return { code: 0, body: "", error: "unexpected event " + type(event) }
    end if

    code = event.GetResponseCode()
    return { code: code, body: event.GetString(), error: event.GetFailureReason() }
end function

' A sentence for the screen. A negative code is libcurl's, not HTTP's, and
' saying so saves somebody looking up "HTTP 502" and finding nothing -- -77 is a
' missing CA bundle and 0 is this runner's own timeout.
function fleetHttpDetail(res as Object) as String
    if res.code > 0 then return "HTTP " + res.code.ToStr()
    if res.error <> invalid
        if res.error <> "" then return res.error
    end if
    return "transport error " + res.code.ToStr()
end function

' ----------------------------------------------------------------------------
' Small helpers
' ----------------------------------------------------------------------------

sub setStatus(status as String, detail as String)
    m.top.status = status
    m.top.detail = detail
end sub

' Trailing slashes off the base URL, so "http://host:8788/" and
' "http://host:8788" build the same paths. A double slash is not fatal but it
' does produce a different route on some proxies, and the address is typed by
' hand often enough here to be worth normalising.
function fleetTrimSlashes(url as String) as String
    out = url.Trim()
    while out.Len() > 0 and out.Right(1) = "/"
        out = out.Left(out.Len() - 1)
    end while
    return out
end function

' Percent-encode one path segment. roUrlTransfer.Escape is the only URL encoder
' BrightScript has; it needs an instance, hence the throwaway object.
function fleetEscape(s as String) as String
    xfer = CreateObject("roUrlTransfer")
    if xfer = invalid then return s
    return xfer.Escape(s)
end function

' Anything to a string, without throwing.
'
' BrightScript's `+` on a string and an invalid is a runtime error that stops
' the thread, and so is calling `.ToStr()` on a type that does not have it --
' Boolean is the one that catches people. A status line is not worth stopping an
' agent for, so every type this can be handed is named and anything else becomes
' an empty string rather than an exception.
function fleetStr(v as Dynamic) as String
    if v = invalid then return ""
    t = type(v)
    if t = "roString" or t = "String" then return v
    if t = "Integer" or t = "roInt" or t = "roInteger" then return v.ToStr()
    if t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" then return Str(v).Trim()
    if t = "Boolean" or t = "roBoolean"
        if v then return "true"
        return "false"
    end if
    return ""
end function

' A job param as an integer, with a default for absent or non-numeric.
function fleetNum(v as Dynamic, fallback as Integer) as Integer
    if v = invalid then return fallback
    t = type(v)
    if t = "Integer" or t = "roInt" or t = "roInteger" then return v
    if t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" then return Int(v)
    return fallback
end function

' The 1 ms clamp, as a double so the division that follows is one.
function fleetMaxMs(ms as Integer) as Double
    if ms < 1 then return Cdbl(1)
    return Cdbl(ms)
end function

' A blocking pause on the Task thread. `sleep()` is a global and is legitimate
' here for the same reason the long poll is: this thread is allowed to block,
' and it is the only one that is.
sub fleetSleep(ms as Integer)
    sleep(ms)
end sub
