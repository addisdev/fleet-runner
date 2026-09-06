import { probeIdle } from '../src/probes/idle';
import { probeLoad } from '../src/probes/load';

describe('Windows probe fallback', () => {
  // Simulate Windows platform for the test.
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', {
    value: 'win32',
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
  });

  test('probeIdle returns a number on Windows', async () => {
    const idle = await probeIdle();
    expect(typeof idle).toBe('number');
  });

  test('probeLoad returns a number on Windows', async () => {
    const load = await probeLoad();
    expect(typeof load).toBe('number');
  });
});