import os from 'os';

/**
 * Returns the system load average.
 * On Windows, `os.loadavg()` returns an empty array, so we default to 0.
 */
export async function probeLoad(): Promise<number> {
  if (process.platform === 'win32') {
    // Windows lacks a load average; use 0 as a conservative estimate.
    return 0;
  }

  try {
    const avg = os.loadavg();
    return avg.length > 0 ? avg[0] : 0;
  } catch {
    return 0;
  }
}