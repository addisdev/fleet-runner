/**
 * The executor's pressure guard, on readings rather than on a loaded machine.
 *
 * Its thresholds come from a rule the owner of a shared Mac wrote for everyone
 * working on it: no heavy work above a load of ~50 or under ~2 GB free swap.
 */
import { parseDarwinSwap, parseLinuxSwap, pressureReason } from "./pressure.js";

type Check = (name: string, cond: boolean, detail?: string) => void;

export function runPressureChecks(check: Check) {
  check("macOS swap in megabytes is read",
    parseDarwinSwap("total = 10240.00M  used = 8909.88M  free = 1330.12M  (encrypted)") === 1330);
  check("macOS swap in gigabytes is converted",
    parseDarwinSwap("total = 8.00G  used = 5.50G  free = 2.50G  (encrypted)") === 2560);
  check("an unrecognisable swap line is unknown, not zero", parseDarwinSwap("nonsense") === null);
  check("Linux SwapFree is read in megabytes", parseLinuxSwap("MemTotal: 1 kB\nSwapFree:  2097152 kB\n") === 2048);

  const guarded = { FLEET_MAX_LOAD: "50", FLEET_MIN_FREE_SWAP_MB: "2048" };
  check("unset thresholds never refuse, however busy", pressureReason({ load1: 900, freeSwapMb: 0 }, {}) === null,
    "a dedicated machine must not be second-guessed");
  check("a calm host goes ahead", pressureReason({ load1: 12, freeSwapMb: 6000 }, guarded) === null);
  const hot = pressureReason({ load1: 228.08, freeSwapMb: 6000 }, guarded);
  check("load over the line refuses, and says the number", !!hot && hot.includes("228.1"), String(hot));
  const tight = pressureReason({ load1: 12, freeSwapMb: 1036 }, guarded);
  check("swap under the line refuses, and says the number", !!tight && tight.includes("1036 MB"), String(tight));
  const zero = pressureReason({ load1: 1, freeSwapMb: 0 }, guarded);
  check("zero free swap is exhausted, not unknown", !!zero, String(zero));
  check("unknown swap is judged on load alone", pressureReason({ load1: 12, freeSwapMb: null }, guarded) === null);
  const both = pressureReason({ load1: 300, freeSwapMb: 10 }, guarded) ?? "";
  check("both reasons are named when both apply", both.includes("load") && both.includes("swap"), both);
}
