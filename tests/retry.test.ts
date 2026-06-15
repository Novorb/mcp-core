import { describe, it, expect } from '@jest/globals';
import {
  calculateRetryDelay,
  isRetryableError,
  retryWithBackoff,
  parseRetryAfter,
  sleep,
} from '../src/retry.js';

describe('retry utilities', () => {
  describe('calculateRetryDelay', () => {
    it('should return initialDelayMs for attempt 0', () => {
      const delay = calculateRetryDelay(0, {
        initialDelayMs: 1000,
        jitterFactor: 0,
      });
      expect(delay).toBe(1000);
    });

    it('should apply exponential backoff', () => {
      const delay = calculateRetryDelay(2, {
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        jitterFactor: 0,
      });
      expect(delay).toBe(4000); // 1000 * 2^2
    });

    it('should cap at maxDelayMs', () => {
      const delay = calculateRetryDelay(10, {
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        jitterFactor: 0,
      });
      expect(delay).toBe(5000);
    });

    it('should apply jitter within range', () => {
      const delays = Array.from({ length: 100 }, () =>
        calculateRetryDelay(0, { initialDelayMs: 1000, jitterFactor: 0.1 })
      );
      const min = Math.min(...delays);
      const max = Math.max(...delays);
      expect(min).toBeGreaterThanOrEqual(900);
      expect(max).toBeLessThanOrEqual(1100);
    });

    it('should never return negative', () => {
      const delay = calculateRetryDelay(0, {
        initialDelayMs: 1,
        jitterFactor: 1.0,
      });
      expect(delay).toBeGreaterThanOrEqual(0);
    });
  });

  describe('isRetryableError', () => {
    it('should retry ECONNRESET', () => {
      expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    });

    it('should retry ETIMEDOUT', () => {
      expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    });

    it('should retry ENOTFOUND', () => {
      expect(isRetryableError({ code: 'ENOTFOUND' })).toBe(true);
    });

    it('should retry ECONNREFUSED', () => {
      expect(isRetryableError({ code: 'ECONNREFUSED' })).toBe(true);
    });

    it('should retry 429', () => {
      expect(isRetryableError({ response: { status: 429 } })).toBe(true);
    });

    it('should retry 502', () => {
      expect(isRetryableError({ response: { status: 502 } })).toBe(true);
    });

    it('should retry 503', () => {
      expect(isRetryableError({ response: { status: 503 } })).toBe(true);
    });

    it('should retry 504', () => {
      expect(isRetryableError({ response: { status: 504 } })).toBe(true);
    });

    it('should not retry 400', () => {
      expect(isRetryableError({ response: { status: 400 } })).toBe(false);
    });

    it('should not retry 401', () => {
      expect(isRetryableError({ response: { status: 401 } })).toBe(false);
    });

    it('should not retry 404', () => {
      expect(isRetryableError({ response: { status: 404 } })).toBe(false);
    });

    it('should not retry generic errors', () => {
      expect(isRetryableError(new Error('random'))).toBe(false);
    });

    it('should handle null/undefined', () => {
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
    });
  });

  describe('retryWithBackoff', () => {
    it('should succeed on first try', async () => {
      const result = await retryWithBackoff(async () => 'ok');
      expect(result).toBe('ok');
    });

    it('should retry on retryable error and succeed', async () => {
      let calls = 0;
      const result = await retryWithBackoff(
        async () => {
          calls++;
          if (calls < 3) {
            const err = new Error('timeout') as Error & { code?: string };
            err.code = 'ETIMEDOUT';
            throw err;
          }
          return 'recovered';
        },
        { initialDelayMs: 10, maxDelayMs: 20 }
      );
      expect(result).toBe('recovered');
      expect(calls).toBe(3);
    });

    it('should throw immediately on non-retryable error', async () => {
      let calls = 0;
      await expect(
        retryWithBackoff(async () => {
          calls++;
          const err = new Error('not found') as Error & { response?: { status: number } };
          err.response = { status: 404 };
          throw err;
        })
      ).rejects.toThrow('not found');
      expect(calls).toBe(1);
    });

    it('should throw after maxRetries exhausted', async () => {
      let calls = 0;
      await expect(
        retryWithBackoff(
          async () => {
            calls++;
            const err = new Error('down') as Error & { response?: { status: number } };
            err.response = { status: 503 };
            throw err;
          },
          { maxRetries: 2, initialDelayMs: 10 }
        )
      ).rejects.toThrow('down');
      expect(calls).toBe(3); // initial + 2 retries
    });

    it('should pass context to function', async () => {
      const contexts: Array<{ attempt: number; maxRetries: number }> = [];
      await retryWithBackoff(async (ctx) => {
        contexts.push({ attempt: ctx.attempt, maxRetries: ctx.maxRetries });
        return 'done';
      });
      expect(contexts).toEqual([{ attempt: 0, maxRetries: 3 }]);
    });
  });

  describe('parseRetryAfter', () => {
    it('should parse seconds', () => {
      expect(parseRetryAfter('60')).toBe(60000);
    });

    it('should parse HTTP date', () => {
      const future = new Date(Date.now() + 5000).toUTCString();
      const ms = parseRetryAfter(future);
      expect(ms).toBeDefined();
      expect(ms!).toBeGreaterThan(0);
      expect(ms!).toBeLessThanOrEqual(6000);
    });

    it('should return undefined for empty', () => {
      expect(parseRetryAfter(undefined)).toBeUndefined();
      expect(parseRetryAfter('')).toBeUndefined();
    });
  });

  describe('sleep', () => {
    it('should resolve after delay', async () => {
      const start = Date.now();
      await sleep(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });
  });
});
