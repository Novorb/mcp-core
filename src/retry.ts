/**
 * @novorb/mcp-core — Retry utilities
 *
 * Exponential backoff with jitter for retrying failed HTTP requests.
 */

export interface RetryOptions {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Jitter factor 0-1 (default: 0.1 = 10%) */
  jitterFactor?: number;
}

export interface RetryContext {
  /** Current attempt number (0-based) */
  attempt: number;
  /** Maximum retries configured */
  maxRetries: number;
  /** Last error encountered */
  lastError?: Error;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

/**
 * Calculate retry delay with exponential backoff and jitter.
 */
export function calculateRetryDelay(
  attempt: number,
  options: RetryOptions = {}
): number {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const exponentialDelay = opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, opts.maxDelayMs);
  const jitterRange = cappedDelay * opts.jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, cappedDelay + jitter);
}

/**
 * Sleep for specified milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** HTTP status codes that should be retried */
const RETRYABLE_STATUS_CODES = [408, 429, 502, 503, 504];

/** Network error codes that should be retried */
const RETRYABLE_NETWORK_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'];

/**
 * Determine if an error is retryable.
 */
export function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // Network errors
    if (typeof err.code === 'string' && RETRYABLE_NETWORK_CODES.includes(err.code)) {
      return true;
    }

    // HTTP status codes
    const response = err.response as Record<string, unknown> | undefined;
    const status = response?.status;
    if (typeof status === 'number') {
      return RETRYABLE_STATUS_CODES.includes(status);
    }
  }
  return false;
}

/**
 * Retry a function with exponential backoff.
 *
 * @param fn - Async function to retry (receives RetryContext)
 * @param options - Retry options
 * @returns Result of successful function call
 * @throws Last error if all retries exhausted or error is not retryable
 */
export async function retryWithBackoff<T>(
  fn: (context: RetryContext) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    const context: RetryContext = { attempt, maxRetries: opts.maxRetries, lastError };

    try {
      return await fn(context);
    } catch (error) {
      lastError = error as Error;

      if (attempt === opts.maxRetries || !isRetryableError(error)) {
        throw error;
      }

      const delay = calculateRetryDelay(attempt, options);
      await sleep(delay);
    }
  }

  throw lastError || new Error('Retry exhausted');
}

/**
 * Parse Retry-After header value to milliseconds.
 */
export function parseRetryAfter(retryAfter: string | undefined): number | undefined {
  if (!retryAfter) return undefined;

  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) return seconds * 1000;

  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());

  return undefined;
}
