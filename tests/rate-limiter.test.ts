import { describe, expect, it } from '@jest/globals';
import { createTokenBucket, TokenBucket } from '../src/rate-limiter.js';

describe('TokenBucket', () => {
  it('rejects an invalid configuration', () => {
    expect(() => createTokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow('capacity must be >= 1');
    expect(() => createTokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow('refillPerSecond must be > 0');
  });

  it('allows a burst up to capacity, then refills at the configured rate', async () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 10, now: () => now });
    await bucket.acquire();
    await bucket.acquire();
    expect(bucket.available()).toBe(0);
    now = 50;
    expect(bucket.available()).toBeCloseTo(0.5);
    now = 1000;
    expect(bucket.available()).toBe(2); // capped at capacity
  });

  it('makes a waiter sleep until a token is available (real clock)', async () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 25 });
    await bucket.acquire();
    const start = Date.now();
    await bucket.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it('serves waiters in order and survives an aborted waiter', async () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 50 });
    await bucket.acquire();
    const controller = new AbortController();
    const order: string[] = [];
    const aborted = bucket.acquire(controller.signal).then(
      () => order.push('aborted-resolved'),
      () => order.push('aborted-rejected'),
    );
    const next = bucket.acquire().then(() => order.push('next'));
    controller.abort();
    await Promise.all([aborted, next]);
    expect(order).toEqual(['aborted-rejected', 'next']);
  });

  it('a waiter queued behind a slow one rejects as soon as its signal aborts, not at its turn', async () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1 });
    await bucket.acquire();
    const slow = bucket.acquire(); // waits about a second for the refill
    const controller = new AbortController();
    const queued = bucket.acquire(controller.signal);
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('caller gave up')), 20);
    await expect(queued).rejects.toThrow('caller gave up');
    expect(Date.now() - started).toBeLessThan(500);
    await slow;
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1 });
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(bucket.acquire(controller.signal)).rejects.toThrow('gone');
  });
});
