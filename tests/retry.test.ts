import { describe, expect, it, jest } from '@jest/globals';
import {
  calculateRetryDelay,
  errorStatus,
  isIdempotentMethod,
  isRetryableError,
  isRetryableStatus,
  parseRetryAfter,
  RETRYABLE_STATUS_CODES,
  type RetryInfo,
  retryAfterFromError,
  retryDelayFor,
  retryWithBackoff,
  sleep,
  throwIfAborted,
} from '../src/retry.js';

const statusError = (status: number, headers?: Record<string, string>): Error & { response: unknown } =>
  Object.assign(new Error(`status ${status}`), { response: { status, headers } });
const netError = (code: string, syscall?: string): Error => Object.assign(new Error(code), { code, syscall });

describe('retry utilities', () => {
  describe('the shared retryable policy', () => {
    it.each([408, 425, 429, 500, 502, 503, 504])('retries status %i', (status) => {
      expect(isRetryableStatus(status)).toBe(true);
      expect(isRetryableError(statusError(status))).toBe(true);
    });

    it.each([400, 401, 403, 404, 409, 422, 501, 505])('never retries status %i', (status) => {
      expect(isRetryableStatus(status)).toBe(false);
      expect(isRetryableError(statusError(status))).toBe(false);
    });

    it('pins the exact status set (501 is permanent)', () => {
      expect([...RETRYABLE_STATUS_CODES].sort((a, b) => a - b)).toEqual([408, 425, 429, 500, 502, 503, 504]);
    });

    it('reads a normalized error status too', () => {
      expect(isRetryableError({ status: 503 })).toBe(true);
      expect(isRetryableError({ status: 404 })).toBe(false);
      expect(errorStatus({ status: 418 })).toBe(418);
      expect(errorStatus('x')).toBeUndefined();
      expect(errorStatus({ response: { status: 'x' } })).toBeUndefined();
    });

    it.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])('retries network error %s', (code) => {
      expect(isRetryableError(netError(code))).toBe(true);
    });

    it('retries ECONNREFUSED only on connect', () => {
      expect(isRetryableError(netError('ECONNREFUSED', 'connect'))).toBe(true);
      expect(isRetryableError(netError('ECONNREFUSED'))).toBe(false);
      expect(isRetryableError(netError('ECONNREFUSED', 'write'))).toBe(false);
    });

    it('reads the code and syscall from `cause` (axios wraps node errors)', () => {
      const wrapped = { code: 'ECONNREFUSED', cause: { code: 'ECONNREFUSED', syscall: 'connect' } };
      expect(isRetryableError(wrapped)).toBe(true);
      expect(isRetryableError({ cause: { code: 'ECONNRESET' } })).toBe(true);
    });

    it('never retries ENOTFOUND, a cancel, generic errors or non-objects', () => {
      expect(isRetryableError(netError('ENOTFOUND'))).toBe(false);
      expect(isRetryableError(netError('ERR_CANCELED'))).toBe(false);
      expect(isRetryableError(new Error('random'))).toBe(false);
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
      expect(isRetryableError('ECONNRESET')).toBe(false);
    });

    it('a response status wins over a network code', () => {
      expect(isRetryableError({ code: 'ECONNRESET', response: { status: 400 } })).toBe(false);
    });

    it('idempotent methods are GET/HEAD/OPTIONS/PUT/DELETE', () => {
      for (const m of ['GET', 'head', 'Options', 'PUT', 'delete', undefined]) expect(isIdempotentMethod(m)).toBe(true);
      for (const m of ['POST', 'patch']) expect(isIdempotentMethod(m)).toBe(false);
    });
  });

  describe('calculateRetryDelay (full jitter)', () => {
    it('is the exponential ceiling at random()=~1 and 0 at random()=0', () => {
      expect(calculateRetryDelay(2, { initialDelayMs: 1000, random: () => 0.999999 })).toBe(3999);
      expect(calculateRetryDelay(2, { initialDelayMs: 1000, random: () => 0 })).toBe(0);
    });

    it('caps the ceiling at maxDelayMs', () => {
      expect(calculateRetryDelay(10, { initialDelayMs: 1000, maxDelayMs: 5000, random: () => 0.999999 })).toBe(4999);
    });

    it('stays within [0, ceiling] for every draw', () => {
      for (let i = 0; i < 200; i++) {
        const d = calculateRetryDelay(1, { initialDelayMs: 100, backoffMultiplier: 3 });
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(300);
      }
    });

    it('treats a negative attempt as 0 and uses defaults', () => {
      expect(calculateRetryDelay(-1, { random: () => 0.5 })).toBe(500);
      expect(calculateRetryDelay(0)).toBeLessThanOrEqual(1000);
    });
  });

  describe('parseRetryAfter', () => {
    const now = Date.parse('2026-10-23T12:00:00Z');

    it('parses delta seconds', () => {
      expect(parseRetryAfter('60')).toBe(60000);
      expect(parseRetryAfter(' 0 ')).toBe(0);
    });

    it('parses an HTTP date relative to now', () => {
      expect(parseRetryAfter('Fri, 23 Oct 2026 12:00:05 GMT', now)).toBe(5000);
    });

    it('clamps a past date to 0', () => {
      expect(parseRetryAfter('Fri, 23 Oct 2026 11:59:00 GMT', now)).toBe(0);
    });

    it('rejects empty, partial numbers and garbage', () => {
      expect(parseRetryAfter(undefined)).toBeUndefined();
      expect(parseRetryAfter('')).toBeUndefined();
      expect(parseRetryAfter('not-a-date')).toBeUndefined();
      expect(parseRetryAfter('-5')).toBeUndefined();
    });
  });

  describe('retryAfterFromError / retryDelayFor', () => {
    it('reads retryAfterMs, a plain header object, and an AxiosHeaders-like getter', () => {
      expect(retryAfterFromError({ retryAfterMs: 1234 })).toBe(1234);
      expect(retryAfterFromError(statusError(429, { 'Retry-After': '2' }))).toBe(2000);
      const getter = { get: (name: string): string | undefined => (name === 'retry-after' ? '3' : undefined) };
      expect(retryAfterFromError({ response: { status: 429, headers: getter } })).toBe(3000);
      const getterMiss = { get: (): undefined => undefined, 'retry-after': '4' };
      expect(retryAfterFromError({ response: { headers: getterMiss } })).toBe(4000);
      expect(retryAfterFromError({ response: {} })).toBeUndefined();
      expect(retryAfterFromError(null)).toBeUndefined();
    });

    it('honours Retry-After capped by maxRetryAfterMs', () => {
      expect(retryDelayFor({ retryAfterMs: 2000 }, 0)).toEqual({ delayMs: 2000, fromRetryAfter: true });
      expect(retryDelayFor({ retryAfterMs: 90000 }, 0, { maxRetryAfterMs: 5000 })).toEqual({
        delayMs: 5000,
        fromRetryAfter: true,
      });
      expect(retryDelayFor({ retryAfterMs: 90000 }, 0).delayMs).toBe(30000);
    });

    it('falls back to backoff without Retry-After', () => {
      expect(retryDelayFor({}, 1, { initialDelayMs: 100, random: () => 0.5 })).toEqual({
        delayMs: 100,
        fromRetryAfter: false,
      });
    });
  });

  describe('retryWithBackoff', () => {
    it('succeeds on first try', async () => {
      await expect(retryWithBackoff(async () => 'ok')).resolves.toBe('ok');
    });

    it('retries a retryable error and succeeds', async () => {
      let calls = 0;
      const result = await retryWithBackoff(
        async () => {
          calls++;
          if (calls < 3) throw netError('ETIMEDOUT');
          return 'recovered';
        },
        { initialDelayMs: 1, maxDelayMs: 2 },
      );
      expect(result).toBe('recovered');
      expect(calls).toBe(3);
    });

    it('throws immediately on a non-retryable error', async () => {
      let calls = 0;
      await expect(
        retryWithBackoff(async () => {
          calls++;
          throw statusError(404);
        }),
      ).rejects.toThrow('status 404');
      expect(calls).toBe(1);
    });

    it('is bounded: initial + maxRetries attempts', async () => {
      let calls = 0;
      await expect(
        retryWithBackoff(
          async () => {
            calls++;
            throw statusError(503);
          },
          { maxRetries: 2, initialDelayMs: 1 },
        ),
      ).rejects.toThrow('status 503');
      expect(calls).toBe(3);
    });

    it('honours Retry-After (seconds) through onRetry, capped', async () => {
      const infos: RetryInfo[] = [];
      let calls = 0;
      await retryWithBackoff(
        async () => {
          calls++;
          if (calls === 1) throw statusError(429, { 'retry-after': '120' });
          return 'ok';
        },
        { maxRetryAfterMs: 5, onRetry: (i) => infos.push(i) },
      );
      expect(infos).toHaveLength(1);
      expect(infos[0]).toMatchObject({ attempt: 0, delayMs: 5, fromRetryAfter: true });
    });

    it('honours Retry-After as an HTTP date', async () => {
      const infos: RetryInfo[] = [];
      let calls = 0;
      const date = new Date(Date.now() + 60000).toUTCString();
      await retryWithBackoff(
        async () => {
          calls++;
          if (calls === 1) throw statusError(503, { 'retry-after': date });
          return 'ok';
        },
        { maxRetryAfterMs: 3, onRetry: (i) => infos.push(i) },
      );
      expect(infos[0].delayMs).toBe(3);
      expect(infos[0].fromRetryAfter).toBe(true);
    });

    it('accepts a custom shouldRetry and passes the context', async () => {
      const seen: Array<{ attempt: number; maxRetries: number; last?: string }> = [];
      await expect(
        retryWithBackoff(
          async (ctx) => {
            seen.push({ attempt: ctx.attempt, maxRetries: ctx.maxRetries, last: ctx.lastError?.message });
            throw 'plain string';
          },
          { maxRetries: 1, initialDelayMs: 1, shouldRetry: () => true },
        ),
      ).rejects.toBe('plain string');
      expect(seen).toEqual([
        { attempt: 0, maxRetries: 1, last: undefined },
        { attempt: 1, maxRetries: 1, last: 'plain string' },
      ]);
    });

    it('stops retrying once the signal aborts during the wait', async () => {
      const controller = new AbortController();
      let calls = 0;
      const promise = retryWithBackoff(
        async () => {
          calls++;
          throw statusError(503);
        },
        { maxRetries: 5, initialDelayMs: 10000, random: () => 1, signal: controller.signal },
      );
      setTimeout(() => controller.abort(new Error('cancelled by caller')), 20);
      await expect(promise).rejects.toThrow('cancelled by caller');
      expect(calls).toBe(1);
    });

    it('does not start when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const fn = jest.fn<() => Promise<string>>(async () => 'never');
      await expect(retryWithBackoff(fn, { signal: controller.signal })).rejects.toThrow('aborted');
      expect(fn).not.toHaveBeenCalled();
    });

    it('does not retry when the signal aborted during the attempt', async () => {
      const controller = new AbortController();
      let calls = 0;
      await expect(
        retryWithBackoff(
          async () => {
            calls++;
            controller.abort();
            throw statusError(503);
          },
          { signal: controller.signal, initialDelayMs: 1 },
        ),
      ).rejects.toThrow('status 503');
      expect(calls).toBe(1);
    });
  });

  describe('sleep / throwIfAborted', () => {
    it('resolves after the delay', async () => {
      const start = Date.now();
      await sleep(30);
      expect(Date.now() - start).toBeGreaterThanOrEqual(20);
    });

    it('rejects at once for an aborted signal and on a later abort', async () => {
      const done = new AbortController();
      done.abort('reason-string');
      await expect(sleep(1000, done.signal)).rejects.toThrow('The operation was aborted');
      const later = new AbortController();
      const p = sleep(10000, later.signal);
      later.abort(new Error('stop'));
      await expect(p).rejects.toThrow('stop');
    });

    it('resolves with a signal that never aborts', async () => {
      await expect(sleep(1, new AbortController().signal)).resolves.toBeUndefined();
    });

    it('throwIfAborted throws only for an aborted signal', () => {
      expect(() => throwIfAborted(undefined)).not.toThrow();
      const c = new AbortController();
      expect(() => throwIfAborted(c.signal)).not.toThrow();
      c.abort();
      expect(() => throwIfAborted(c.signal)).toThrow();
    });
  });
});
