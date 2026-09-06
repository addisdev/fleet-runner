import os from 'os';
import { execSync } from 'child_process';

/**
 * Returns the current idle time in seconds.
 * On Windows, it falls back to 0 as a safe default.
 */
export async function probeIdle(): Promise<number> {
  if (process.platform === 'win32') {
    // Windows does not expose a simple API for idle time.
    // The safest approach is to return 0, indicating “unknown”.
    return 0;
  }

  // Unix-like implementations: use `os.cpus()` to calculate idle percentage.
  try {
    const cpus = os.cpus();
    const idleTimes = cpus.map((cpu) => {
      const { times } = cpu;
      return times.idle;
    });
    const totalIdle = idleTimes.reduce((a, b) => a + b, 0);
    const total = idleTimes.length;
    // Convert idle ticks to seconds.
    // Since we only need a relative value, return 0 when data is unavailable.
    return total > 0 ? totalIdle / total / 1e3 : 0;
  } catch {
    return 0;
  }
}