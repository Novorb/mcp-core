/**
 * @novorb/mcp-core - Token bucket rate limiter
 *
 * A client-side limiter shared by every request of one HTTP client instance (e.g. Trello: 100 requests
 * per 10 seconds per token = capacity 100, refillPerSecond 10). Waiters are served in FIFO order.
 * Build the client once per process, not per MCP request, or the bucket limits nothing.
 */

import { sleep, throwIfAborted } from './retry.js';

export interface TokenBucketOptions {
  /** Maximum burst (bucket size); must be >= 1. */
  capacity: number;
  /** Tokens added per second; must be > 0. */
  refillPerSecond: number;
  /** Clock in milliseconds (default Date.now; injectable for tests). */
  now?: () => number;
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();
  private readonly capacity: number;
  private readonly ratePerMs: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    if (!(options.capacity >= 1)) throw new RangeError('capacity must be >= 1');
    if (!(options.refillPerSecond > 0)) throw new RangeError('refillPerSecond must be > 0');
    this.capacity = options.capacity;
    this.ratePerMs = options.refillPerSecond / 1000;
    this.now = options.now ?? Date.now;
    this.tokens = options.capacity;
    this.last = this.now();
  }

  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.ratePerMs);
    this.last = now;
  }

  /** Tokens available right now (after refill). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Waits for one token. Rejects with the abort reason as soon as `signal` aborts, also while still
   * queued behind other waiters (its turn then takes no token).
   */
  acquire(signal?: AbortSignal): Promise<void> {
    const turn = this.queue.then(() => this.take(signal));
    // Keep the chain alive when one waiter aborts so later waiters still get served.
    this.queue = turn.catch(() => undefined);
    if (!signal) return turn;
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      turn.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private async take(signal: AbortSignal | undefined): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil((1 - this.tokens) / this.ratePerMs), signal);
    }
  }
}

/** Creates a token bucket. */
export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  return new TokenBucket(options);
}
