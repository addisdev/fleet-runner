' ============================================================================
' The fleet's synthetic block, in BrightScript.
'
' Ported token for token from runner-machine/src/backends/synthetic.ts, which
' was itself matched against the Kotlin and Swift backends. The four agree, and
' this file exists to make it five. The arithmetic is:
'
'   block[i] = (i * 31) AND 0xff, for i in 0..4095
'   one round  = block[0..31] := first 32 bytes of SHA-256(block)
'   one token  = ROUNDS_PER_TOKEN rounds
'   attestation = hex SHA-256 of the whole block after ATTEST_ROUNDS rounds,
'                 starting from a FRESH block
'
' Changing any of those -- the constant, the initialisation, the fold width,
' where the digest is written back -- silently invalidates every historical row
' on every platform, including the Android and iOS rows that predate this file.
' Nothing would throw. The digest is the only thing that would notice, which is
' why it is reported.
'
' == The backend is named `roevp`, not `synthetic` ==
'
' The rate this produces is NOT comparable with a phone's `synthetic` rate, and
' calling it `synthetic` would put it in the same tok/s column as one, which is
' the laundering docs/writing-a-runner.md is about.
'
' The reason is structural rather than "Roku is slow". BrightScript has no
' SHA-256 of its own; the only hash on the platform is `roEVPDigest`, a native
' OpenSSL object called once per round from an interpreted `for` loop. At 4 KiB
' a round, the native hash is a small fraction of the work -- the rest is the
' BrightScript interpreter dispatching a method call, allocating the returned
' hex string, parsing it back into an roByteArray, and copying 32 bytes with an
' interpreted inner loop. So the number measures the interpreter at least as
' much as it measures the SoC, and two Roku models with the same firmware would
' compare fairly with each other while neither compares with a Pixel.
'
' That is the identical argument collector/runner-web/index.html makes for
' declaring `benchmark:jssha` rather than `benchmark:synthetic`, and it lands
' the same way: the RATE is this runner's own column, and the CORRECTNESS is
' shared. Both fold the identical block through identical rounds, and both
' report `synthetic_digest`, so conformance clause 4 proves the arithmetic is
' the fleet's even though the clock is not.
'
' There is no way to make the rate comparable, either. `roEVPDigest.Update()` /
' `Final()` would let a round avoid one string round-trip, but the fold is
' inherently sequential -- round N+1's input is round N's output -- so there is
' no batching that removes the per-round interpreter dispatch. Refusing to name
' it `synthetic` is the honest option, not a workaround for a missing one.
' ============================================================================

' The two constants the whole fleet shares. Not configurable, on purpose.
function FLEET_BLOCK_SIZE() as Integer
    return 4096
end function

function FLEET_ROUNDS_PER_TOKEN() as Integer
    return 1000
end function

' How many rounds the attestation covers: one token's worth.
'
' Fixed, and on a FRESH block, matching ATTEST_ROUNDS in the machine runner.
' Attesting over the job's own rounds would make the answer depend on
' prompt_tokens, gen_tokens and how many iterations had already mutated the
' block, so two honest runners given different specs would produce different
' digests and the check would prove nothing.
function FLEET_ATTEST_ROUNDS() as Integer
    return FLEET_ROUNDS_PER_TOKEN()
end function

' The digest this file must produce, recomputed independently from the written
' specification (Node: sha256 of the 4 KiB block after 1000 folds).
'
' It is here so that a Roku that has never met a collector can still say
' whether its arithmetic is right -- see fleetSelfTest() -- rather than the
' first evidence of a broken port being a failed conformance clause on a
' machine somebody else owns.
function FLEET_EXPECTED_ATTEST_DIGEST() as String
    return "d7e8b70dfb48593edebc84967a969e78429f9ac6da8d0c681a4b57a2fe078a84"
end function

' ----------------------------------------------------------------------------

' A configured SHA-256 digest object.
'
' Setup() takes the algorithm name and returns false for one it does not know.
' Checked rather than assumed: a Roku firmware without "sha256" would otherwise
' produce an roByteArray of nothing per round, a block that never changes, and
' entirely plausible tok/s numbers for work that was not done.
function fleetNewDigest() as Object
    d = CreateObject("roEVPDigest")
    if d = invalid then return invalid
    if d.Setup("sha256") = false then return invalid
    return d
end function

' block[i] = (i * 31) AND 255 -- Kotlin's `(it * 31).toByte()`, Swift's
' `UInt8(truncatingIfNeeded:)`, JavaScript's `(i * 31) & 0xff`.
'
' `AND` is bitwise on integer operands in BrightScript, and i * 31 for
' i <= 4095 is well inside the 32-bit integer range, so there is no overflow to
' reason about. The array is grown to full size by one out-of-range assignment
' before the loop: roByteArray grows on write, and growing it 4096 times inside
' the loop is measurably slower on a Roku's interpreter.
function fleetInitBlock() as Object
    size = FLEET_BLOCK_SIZE()
    b = CreateObject("roByteArray")
    b[size - 1] = 0
    for i = 0 to size - 1
        b[i] = (i * 31) AND 255
    end for
    return b
end function

' `rounds` folds of `block`, in place.
'
' rounds <= 0 does nothing, which is what Kotlin's `repeat`, Swift's
' `0..<max(n, 0)` and the machine runner's loop all do at the
' `gen_tokens - 1 == -1` edge. BrightScript's `for i = 1 to 0` does not execute,
' so that edge is free here -- but it is worth naming, because a `while` written
' the obvious way would run forever on a negative count.
sub fleetFoldBlock(digest as Object, block as Object, rounds as Integer)
    out = CreateObject("roByteArray")
    for i = 1 to rounds
        ' Reset() before each Process() is defensive. Roku documents Process()
        ' as a one-shot over the whole input, but does not state whether it
        ' reinitialises the context first, and a digest object that carried
        ' state between rounds would chain a DIFFERENT function than the rest of
        ' the fleet -- and would still return 64 plausible hex characters every
        ' time. This costs one interpreted call per round against a wrong answer
        ' nothing else would detect.
        digest.Reset()
        hex = digest.Process(block)
        out.FromHexString(hex)
        ' Write the digest back over the FRONT of the block, 32 bytes, leaving
        ' the remaining 4064 untouched. This is the fold, and it is the detail
        ' most likely to be got wrong in a port: replacing the whole block, or
        ' appending, or XOR-ing, all produce a working benchmark with an
        ' incomparable digest.
        for j = 0 to 31
            block[j] = out[j]
        end for
    end for
end sub

' The fleet's attestation: a fresh block, ATTEST_ROUNDS folds, hex SHA-256 of
' the WHOLE 4 KiB block -- not of its first 32 bytes.
'
' Lowercased because the fleet's reference digest is lowercase hex and Roku does
' not document the case roEVPDigest returns. A digest that differed only in case
' would fail conformance clause 4 with a message about incomparable arithmetic,
' which is a long way from the actual problem.
function fleetAttestDigest() as String
    digest = fleetNewDigest()
    if digest = invalid then return ""
    block = fleetInitBlock()
    fleetFoldBlock(digest, block, FLEET_ATTEST_ROUNDS())
    digest.Reset()
    return LCase(digest.Process(block))
end function

' ----------------------------------------------------------------------------
' Checks that need no collector, no network and no job.
'
' There is no BrightScript unit-test runner in this repository and no Roku
' emulator to run one on, so the port cannot be tested the way the other four
' runners test theirs. This is the substitute: the channel checks itself on
' every boot, shows the verdict on screen, and refuses to declare a benchmark
' capability if it fails. A runner that cannot do the fleet's arithmetic must
' not take benchmark jobs off the queue from one that can.
'
' Returns an assocarray: { ok, digest, detail }.
' ----------------------------------------------------------------------------
function fleetSelfTest() as Object
    digest = fleetNewDigest()
    if digest = invalid
        return { ok: false, digest: "", detail: "roEVPDigest has no sha256 on this firmware" }
    end if

    ' 1. The block is initialised the way every other runner initialises it.
    block = fleetInitBlock()
    if block.Count() <> FLEET_BLOCK_SIZE()
        return { ok: false, digest: "", detail: "block is " + block.Count().ToStr() + " bytes, not 4096" }
    end if
    if block[0] <> 0 or block[1] <> 31 or block[10] <> 54
        return { ok: false, digest: "", detail: "block initialisation is not (i * 31) AND 255" }
    end if

    ' 2. One fold writes the digest over the front and leaves the tail alone.
    '    Both halves matter: a fold that replaced the whole block would pass a
    '    check that only looked at block[0].
    tail = block[4095]
    fleetFoldBlock(digest, block, 1)
    if block[4095] <> tail
        return { ok: false, digest: "", detail: "a fold overwrote past byte 32" }
    end if
    digest.Reset()
    ' sha256 of the fresh 4 KiB block, computed off-device from the written
    ' specification. After one fold the block's first 32 bytes ARE that digest,
    ' so this pins the hash itself and the write-back position at once.
    if LCase(block.ToHexString()).Left(64) <> "695fb69684bbdf7f0df73d0cbcf84b46104edfe6504fd3a1dcbd340f628f8d8a"
        return { ok: false, digest: "", detail: "one fold does not match the reference SHA-256" }
    end if

    ' 3. The full attestation, which is the number the collector checks.
    attested = fleetAttestDigest()
    if attested <> FLEET_EXPECTED_ATTEST_DIGEST()
        return { ok: false, digest: attested, detail: "attestation digest does not match the fleet reference" }
    end if

    return { ok: true, digest: attested, detail: "synthetic block matches the fleet reference" }
end function
