import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitOpenError,
  createCircuitBreaker,
} from '../src/services/cache/circuit.js';

/**
 * A controllable clock, so none of these tests wait on real time — the cooldown
 * is a duration, and a test that sleeps for it is slow and flaky for no gain.
 */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const fail = () => Promise.reject(new Error('ECONNREFUSED'));
const ok = () => Promise.resolve('value');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('circuit breaker', () => {
  it('passes results and errors straight through while closed', async () => {
    const breaker = createCircuitBreaker();
    await expect(breaker.run('x', ok)).resolves.toBe('value');
    expect(breaker.state()).toBe('closed');
    await expect(breaker.run('x', fail)).rejects.toThrow('ECONNREFUSED');
    expect(breaker.state()).toBe('closed');
  });

  it('stays closed below the failure threshold', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 2; i += 1) await expect(breaker.run('x', fail)).rejects.toThrow();
    expect(breaker.state()).toBe('closed');
  });

  it('opens on the threshold-th consecutive failure', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i += 1) await expect(breaker.run('x', fail)).rejects.toThrow();
    expect(breaker.state()).toBe('open');
  });

  it('resets the count after a success, so intermittent errors never open it', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 10; i += 1) {
      await expect(breaker.run('x', fail)).rejects.toThrow();
      await expect(breaker.run('x', fail)).rejects.toThrow();
      await expect(breaker.run('x', ok)).resolves.toBe('value');
    }
    expect(breaker.state()).toBe('closed');
  });

  // The whole point: an open circuit must not run the operation at all. That is
  // what turns a 1500 ms connect timeout into a microsecond rejection.
  it('does not invoke the operation while open', async () => {
    const c = clock();
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: c.now });
    for (let i = 0; i < 2; i += 1) await expect(breaker.run('x', fail)).rejects.toThrow();

    const op = vi.fn(fail);
    await expect(breaker.run('flag:demo', op)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(breaker.run('flag:demo', op)).rejects.toThrow(/skipped flag:demo/);
    expect(op).not.toHaveBeenCalled();
  });

  it('admits one probe after the cooldown and closes on success', async () => {
    const c = clock();
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: c.now });
    for (let i = 0; i < 2; i += 1) await expect(breaker.run('x', fail)).rejects.toThrow();
    expect(breaker.state()).toBe('open');

    c.advance(1000);
    expect(breaker.state()).toBe('half-open');
    await expect(breaker.run('x', ok)).resolves.toBe('value');
    expect(breaker.state()).toBe('closed');
  });

  it('restarts the cooldown when the probe fails, instead of probing on every request', async () => {
    const c = clock();
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: c.now });
    for (let i = 0; i < 2; i += 1) await expect(breaker.run('x', fail)).rejects.toThrow();

    c.advance(1000);
    const probe = vi.fn(fail);
    await expect(breaker.run('x', probe)).rejects.toThrow('ECONNREFUSED');
    expect(probe).toHaveBeenCalledTimes(1);

    // Immediately afterwards the circuit is shut again, not still half-open.
    expect(breaker.state()).toBe('open');
    await expect(breaker.run('x', probe)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  // Under load many requests reach a half-open circuit at once. Letting them all
  // through would recreate the pile-up the breaker exists to prevent.
  it('lets only one concurrent caller probe', async () => {
    const c = clock();
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: c.now });
    for (let i = 0; i < 2; i += 1) await expect(breaker.run('x', fail)).rejects.toThrow();
    c.advance(1000);

    let release: (v: string) => void = () => undefined;
    const slow = vi.fn(() => new Promise<string>((r) => (release = r)));

    const results = await Promise.allSettled([
      breaker.run('x', slow),
      breaker.run('x', slow),
      breaker.run('x', slow),
      Promise.resolve().then(() => release('value')),
    ]);

    expect(slow).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value === 'value')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(CircuitOpenError);
    }
  });
});
