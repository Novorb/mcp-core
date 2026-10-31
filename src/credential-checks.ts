/**
 * @novorb/mcp-core - Startup credential checks
 *
 * `runMcpServer` registers every credential the env schema declares (a server's own `secret` keys and
 * every key with a `check`; each member of a `multi` family on its own, pooled under the family's base
 * key) and then runs the declared checks ONCE, in parallel, each bounded by
 * `MCP_CREDENTIAL_CHECK_TIMEOUT_MS` (default 5000). `MCP_CREDENTIAL_CHECKS=false` skips them. A check
 * never stops the server: a throw, a timeout or a network error reads `unknown`, and the results are
 * logged by key name and status only.
 *
 *   {
 *     key: 'SEARCH_API_KEY', multi: true, secret: true,
 *     check: async (value, { http, signal }) => {
 *       await http({ baseURL: 'https://api.example.com', auth: { type: 'bearer', token: value } })
 *         .get('/account', { signal });
 *       return 'valid';
 *     },
 *   }
 *
 * A check may return a status, `{ status, reason?, retryAfterMs? }`, or throw: a thrown `HttpError`
 * is classified like any HTTP outcome (401/403 invalid, 402/429 degraded, ...).
 */

import {
  CREDENTIAL_STATUSES,
  type CredentialOutcomeInfo,
  type CredentialRegistry,
  type CredentialStatus,
  credentialOutcomeFromError,
  UnknownCredentialError,
} from './credentials.js';
import { createHttpClient, type HttpClientConfig, type McpHttpClient } from './http-client.js';
import { CORE_ENV_SCHEMA, type LoadedEnv } from './utils/envLoader.js';
import { getLogger, type Logger, maskSecretValues } from './utils/logger.js';

export interface CredentialCheckContext {
  /** The credential's key name (`KEY` or a family member `KEY_2`). */
  key: string;
  /** Aborted when the check times out. */
  signal: AbortSignal;
  /** A hardened http-client for the probe (retries off by default, the check timeout as its timeout). */
  http(config: HttpClientConfig): McpHttpClient;
  /**
   * The loaded value of a sibling DECLARED env key (a multi-part credential: client id + secret, key +
   * secret, user + password), or undefined when unset. Throws `UnknownCredentialError` for a key the
   * schema does not declare. Values are never logged; declare the siblings `secret: true` so the logger
   * masks them too.
   */
  get(key: string): string | undefined;
}

export interface CredentialCheckResult extends CredentialOutcomeInfo {
  status: CredentialStatus;
}

/** A server-supplied probe for one credential value. */
export type CredentialCheck = (
  value: string,
  ctx: CredentialCheckContext,
) => Promise<CredentialStatus | CredentialCheckResult>;

export const DEFAULT_CREDENTIAL_CHECK_TIMEOUT_MS = 5000;

const CORE_KEYS = new Set(CORE_ENV_SCHEMA.map((s) => s.key));

/**
 * Register the env's credentials in `registry`: every set value of a spec with a `check`, and of every
 * `secret` spec that is not one of mcp-core's own keys. A multi family's members are pooled under the
 * base key. Returns the registered key names with their checks.
 */
export function registerEnvCredentials(
  env: LoadedEnv,
  registry: CredentialRegistry,
): Array<{ key: string; check?: CredentialCheck }> {
  const out: Array<{ key: string; check?: CredentialCheck }> = [];
  const declared = new Set(env.schema.map((s) => s.key));
  for (const spec of env.schema) {
    if (spec.check === undefined && !(spec.secret === true && !CORE_KEYS.has(spec.key))) continue;
    for (const key of env.members(spec.key)) {
      registry.register(key, spec.multi ? { pool: spec.key } : {});
      out.push(spec.check ? { key, check: spec.check } : { key });
    }
  }
  // Covered parts follow their primary's status; undeclared or unset parts are skipped.
  for (const spec of env.schema) {
    if (spec.check === undefined || spec.covers === undefined) continue;
    const parts = spec.covers.filter((k) => declared.has(k)).flatMap((k) => env.members(k));
    for (const part of parts) {
      const partSpec = env.schema.find((s) => s.key === part || env.members(s.key).includes(part));
      registry.register(part, partSpec?.multi ? { pool: partSpec.key } : {});
    }
    for (const key of env.members(spec.key)) registry.cover(key, parts);
  }
  return out;
}

export interface RunCredentialChecksOptions {
  /** Per-check timeout (default MCP_CREDENTIAL_CHECK_TIMEOUT_MS, else 5000 ms). */
  timeoutMs?: number;
  /** Run the checks (default MCP_CREDENTIAL_CHECKS, else true). */
  enabled?: boolean;
  /** How many checks run at once (default 4), so a large pool does not trip its provider's rate limit. */
  concurrency?: number;
  /** Re-check cool-down for invalid/expired keys (default MCP_CREDENTIAL_RECHECK_MS, else 300000 ms). */
  recheckMs?: number;
  logger?: Logger;
}

const STATUSES: ReadonlySet<string> = new Set(CREDENTIAL_STATUSES);

function isStatus(value: unknown): value is CredentialStatus {
  return typeof value === 'string' && STATUSES.has(value);
}

function asResult(value: unknown): CredentialCheckResult {
  if (isStatus(value)) return { status: value };
  if (typeof value === 'object' && value !== null) {
    const r = value as { status?: unknown; reason?: unknown; retryAfterMs?: unknown };
    if (isStatus(r.status)) {
      return {
        status: r.status,
        ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
        ...(typeof r.retryAfterMs === 'number' ? { retryAfterMs: r.retryAfterMs } : {}),
      };
    }
  }
  return { status: 'unknown', reason: 'check returned no status' };
}

function fromThrow(err: unknown, timedOut: boolean): CredentialCheckResult {
  if (timedOut) return { status: 'unknown', reason: 'timeout' };
  const classified = credentialOutcomeFromError(err);
  if (classified) {
    return {
      status: classified.outcome as CredentialStatus,
      ...(classified.reason !== undefined ? { reason: classified.reason } : {}),
      ...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
    };
  }
  const status = (err as { status?: unknown } | null)?.status;
  return { status: 'unknown', reason: typeof status === 'number' ? `check failed (HTTP ${status})` : 'check failed' };
}

async function runOne(
  key: string,
  value: string,
  check: CredentialCheck,
  timeoutMs: number,
  get: (key: string) => string | undefined,
): Promise<CredentialCheckResult> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
    timer.unref?.();
  });
  const ctx: CredentialCheckContext = {
    key,
    signal: controller.signal,
    http: (config) => createHttpClient({ timeout: timeoutMs, ...config, retry: { retries: 0, ...config.retry } }),
    get,
  };
  try {
    return asResult(await Promise.race([check(value, ctx), timeout]));
  } catch (err) {
    return fromThrow(err, timedOut);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const DEFAULT_CREDENTIAL_CHECK_CONCURRENCY = 4;

/** Run `jobs` with at most `limit` in flight, results in input order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await job(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

/**
 * Register the env's credentials and run their checks once (at most `concurrency` at a time, each with
 * a timeout), then attach each check as the key's re-check probe (run again after the
 * MCP_CREDENTIAL_RECHECK_MS cool-down while the key is invalid or expired). Never throws; logs one
 * summary line (key names and statuses only). Resolves with the checked keys' results.
 */
export async function runCredentialChecks(
  env: LoadedEnv,
  registry: CredentialRegistry,
  options: RunCredentialChecksOptions = {},
): Promise<Array<{ key: string; status: CredentialStatus; reason?: string }>> {
  const logger = options.logger ?? getLogger();
  const declared = registerEnvCredentials(env, registry);
  const withCheck = declared.filter((d): d is { key: string; check: CredentialCheck } => d.check !== undefined);
  if (withCheck.length === 0) return [];
  const enabled = options.enabled ?? env.bool('MCP_CREDENTIAL_CHECKS') ?? true;
  if (!enabled) {
    logger.info(
      `credential checks skipped (MCP_CREDENTIAL_CHECKS=false): ${withCheck.length} credential(s) unknown`,
      'Credentials',
    );
    return [];
  }
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ?? positive(env.int('MCP_CREDENTIAL_CHECK_TIMEOUT_MS')) ?? DEFAULT_CREDENTIAL_CHECK_TIMEOUT_MS,
  );
  const recheckMs = options.recheckMs ?? positive(env.int('MCP_CREDENTIAL_RECHECK_MS'));
  if (recheckMs !== undefined) registry.setRecheckMs(recheckMs);
  const declaredKeys = new Set(env.schema.flatMap((spec) => [spec.key, ...env.members(spec.key)]));
  const get = (name: string): string | undefined => {
    if (!declaredKeys.has(name)) throw new UnknownCredentialError();
    return env.get(name);
  };
  const mask = (reason: string | undefined): string | undefined =>
    reason !== undefined ? maskSecretValues(reason).slice(0, 200) : undefined;
  const results = await mapLimited(
    withCheck,
    options.concurrency ?? DEFAULT_CREDENTIAL_CHECK_CONCURRENCY,
    async ({ key, check }) => {
      const value = env.get(key) ?? '';
      const probe = async (): Promise<CredentialCheckResult> => {
        const r = await runOne(key, value, check, timeoutMs, get);
        const reason = mask(r.reason);
        return { status: r.status, ...(reason !== undefined ? { reason } : {}), ...retryOf(r) };
      };
      const result = await probe();
      registry.set(key, result.status, { silent: true, ...result });
      registry.setProbe(key, probe);
      return { key, status: result.status, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
    },
  );
  const summary = results.map((r) => `${r.key} ${r.status}${r.reason ? ` (${r.reason})` : ''}`).join(', ');
  const healthy = results.every((r) => r.status === 'valid');
  if (healthy) logger.info(`credential checks: ${summary}`, 'Credentials');
  else logger.warn(`credential checks: ${summary}`, 'Credentials');
  return results;
}

function retryOf(r: CredentialCheckResult): { retryAfterMs?: number } {
  return r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {};
}
