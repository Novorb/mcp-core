/**
 * @novorb/mcp-core - Retry utilities
 *
 * One retry policy for the whole package, shared by `retryWithBackoff` and the HTTP client:
 * - retryable statuses: 408, 425, 429, 500, 502, 503, 504 (never 501, never any other 4xx)
 * - retryable network errors: ECONNRESET, ETIMEDOUT, EAI_AGAIN, and ECONNREFUSED on connect only
 * - `Retry-After` (seconds or HTTP date) is honoured, capped by `maxRetryAfterMs`
 * - otherwise exponential backoff with full jitter, capped by `maxDelayMs`
 * - bounded attempts (a loop, never recursion) and abort-signal aware
 *
 * Idempotency (which methods may be replayed) is decided by the caller; the HTTP client only retries
 * GET/HEAD/OPTIONS/PUT/DELETE unless the request carries an idempotency key or opts in explicitly.
 */

export interface RetryOptions {
  /** Maximum number of retries after the first attempt (default: 3). */
  maxRetries?: number;
  /** Base delay of the first retry in milliseconds (default: 1000). */
  initialDelayMs?: number;
  /** Cap of one backoff delay in milliseconds (default: 10000). */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2). */
  backoffMultiplier?: number;
  /** Cap applied to a server-sent Retry-After in milliseconds (default: 30000). */
  maxRetryAfterMs?: number;
  /** Stop retrying (and reject with the abort reason) once this signal aborts. */
  signal?: AbortSignal;
  /** Override the retry decision (default: `isRetryableError`). */
  shouldRetry?: (error: unknown, context: RetryContext) => boolean;
  /** Called before each wait with the delay about to be slept. */
  onRetry?: (info: RetryInfo) => void;
  /** Random source in [0, 1) for the jitter (default: Math.random). */
  random?: () => number;
}

export interface RetryContext {
  /** Current attempt number (0-based). */
  attempt: number;
  /** Maximum retries configured. */
  maxRetries: number;
  /** Last error encountered. */
  lastError?: Error;
}

export interface RetryInfo {
  /** The attempt that failed (0-based). */
  attempt: number;
  /** Delay before the next attempt in milliseconds. */
  delayMs: number;
  /** True when the delay came from a Retry-After header. */
  fromRetryAfter: boolean;
  /** The error that triggered the retry. */
  error: unknown;
}

const DEFAULT_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  maxRetryAfterMs: 30000,
};

/** HTTP statuses that are retried. 501 Not Implemented is permanent and deliberately absent. */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Network error codes that are retried. ECONNREFUSED additionally requires the connect syscall. */
export const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
]);

/** Methods that are safe to replay without an idempotency key. */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** True for a status in `RETRYABLE_STATUS_CODES`. */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

/** True for GET/HEAD/OPTIONS/PUT/DELETE (case-insensitive). A missing method counts as GET. */
export function isIdempotentMethod(method: string | undefined): boolean {
  return IDEMPOTENT_METHODS.has((method ?? 'GET').toUpperCase());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** Reads an HTTP status from an axios-style error (`response.status`) or a normalized one (`status`). */
export function errorStatus(error: unknown): number | undefined {
  const err = asRecord(error);
  if (!err) return undefined;
  const status = asRecord(err.response)?.status ?? err.status;
  return typeof status === 'number' ? status : undefined;
}

function networkCode(err: Record<string, unknown>): { code?: string; syscall?: string } {
  const cause = asRecord(err.cause);
  const code = typeof err.code === 'string' ? err.code : typeof cause?.code === 'string' ? cause.code : undefined;
  const syscall =
    typeof err.syscall === 'string' ? err.syscall : typeof cause?.syscall === 'string' ? cause.syscall : undefined;
  return { code, syscall };
}

/**
 * Determine if an error is retryable under the shared policy. A response status decides when one is
 * present; otherwise the network error code (own or `cause`) decides.
 */
export function isRetryableError(error: unknown): boolean {
  const err = asRecord(error);
  if (!err) return false;
  const status = errorStatus(error);
  if (status !== undefined) return isRetryableStatus(status);
  const { code, syscall } = networkCode(err);
  if (code === undefined || !RETRYABLE_NETWORK_CODES.has(code)) return false;
  if (code === 'ECONNREFUSED') return syscall === 'connect';
  return true;
}

/**
 * Exponential backoff with full jitter: a uniform value in [0, min(maxDelayMs, initial * mult^attempt)].
 */
export function calculateRetryDelay(attempt: number, options: RetryOptions = {}): number {
  const initial = options.initialDelayMs ?? DEFAULT_OPTIONS.initialDelayMs;
  const multiplier = options.backoffMultiplier ?? DEFAULT_OPTIONS.backoffMultiplier;
  const maxDelay = options.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(maxDelay, initial * multiplier ** Math.max(0, attempt));
  return Math.max(0, Math.floor(random() * ceiling));
}

/**
 * Parse a Retry-After header value (delta seconds or an HTTP date) to milliseconds. Returns undefined
 * for a missing or unparseable value; a date in the past gives 0.
 */
export function parseRetryAfter(retryAfter: string | undefined, now: number = Date.now()): number | undefined {
  if (!retryAfter) return undefined;
  const trimmed = retryAfter.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // An HTTP date always names a day/month; this keeps `-5` or `1.5` from parsing as a year.
  const date = /[a-z]/i.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

function headerFrom(headers: unknown, name: string): string | undefined {
  const record = asRecord(headers);
  if (!record) return undefined;
  const getter = record.get;
  if (typeof getter === 'function') {
    const value: unknown = getter.call(headers, name);
    if (typeof value === 'string') return value;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * The Retry-After delay carried by an error, in milliseconds: a normalized error's `retryAfterMs`, or
 * the `retry-after` header of an axios-style `response`.
 */
export function retryAfterFromError(error: unknown, now: number = Date.now()): number | undefined {
  const err = asRecord(error);
  if (!err) return undefined;
  if (typeof err.retryAfterMs === 'number') return err.retryAfterMs;
  return parseRetryAfter(headerFrom(asRecord(err.response)?.headers, 'retry-after'), now);
}

/**
 * The delay before the next attempt: the error's Retry-After capped by `maxRetryAfterMs`, else the
 * full-jitter backoff for `attempt`.
 */
export function retryDelayFor(
  error: unknown,
  attempt: number,
  options: RetryOptions = {},
): { delayMs: number; fromRetryAfter: boolean } {
  const retryAfter = retryAfterFromError(error);
  if (retryAfter !== undefined) {
    const cap = options.maxRetryAfterMs ?? DEFAULT_OPTIONS.maxRetryAfterMs;
    return { delayMs: Math.min(retryAfter, cap), fromRetryAfter: true };
  }
  return { delayMs: calculateRetryDelay(attempt, options), fromRetryAfter: false };
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** Throws the signal's abort reason when it has aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Sleep for `ms` milliseconds. With a signal, rejects with its abort reason as soon as it aborts.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry a function under the shared policy.
 *
 * @param fn - Async function to retry (receives RetryContext)
 * @param options - Retry options
 * @returns Result of the first successful call
 * @throws The last error when retries are exhausted or the error is not retryable; the abort reason
 *   when the signal aborts
 */
export async function retryWithBackoff<T>(
  fn: (context: RetryContext) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_OPTIONS.maxRetries);
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => isRetryableError(error));
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options.signal);
    const context: RetryContext = { attempt, maxRetries, lastError };
    try {
      return await fn(context);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxRetries || options.signal?.aborted || !shouldRetry(error, context)) {
        throw error;
      }
      const { delayMs, fromRetryAfter } = retryDelayFor(error, attempt, options);
      options.onRetry?.({ attempt, delayMs, fromRetryAfter, error });
      await sleep(delayMs, options.signal);
    }
  }
  /* istanbul ignore next -- unreachable: the last attempt always returns or throws inside the loop */
  throw lastError ?? new Error('Retry exhausted');
}
