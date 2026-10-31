/**
 * @novorb/mcp-core - Credential health
 *
 * A credential is checked once when the env is loaded (see `credential-checks.ts`); after that its
 * health is learned from use. A key can degrade (quota, rate limit), become invalid or expire while the
 * server runs: that never crashes the server and never turns a tool call into an error on its own.
 * Instead every tool result that touched a credential carries a report of the keys it used and the
 * ones that are degraded, invalid or expired (see `registerTools`).
 *
 * - `CredentialRegistry` (process-wide by default, `processCredentials()`): the status per DECLARED key
 *   name, pools (an env `multi` family: `KEY`, `KEY_1`, `KEY_2`, ...), `pick(pool)` rotation that
 *   prefers valid over unknown over degraded and keeps invalid and expired keys as the last resort (so
 *   no key is lost for good), `record(key, outcome)`, `snapshot()`, and a background re-check of invalid
 *   and expired keys (the startup `check`) after `recheckMs`. Transitions are logged once per change.
 * - `CredentialScope`: one tool call's view of the registry. It remembers which credentials the call
 *   touched, so the result can report them; the http-client records into the current scope.
 * - `credentialOutcomeFromHttp`: the one HTTP outcome mapping (status-gated, see there).
 *
 * Only declared key NAMES ever appear in logs, results and snapshots: an identifier that is not a
 * registered name is refused with `UnknownCredentialError` (a programming error), so a value passed by
 * mistake is never published. A registry never holds a value.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getLogger, type Logger, maskSecretValues } from './utils/logger.js';
import { redactStringSecrets } from './utils/redact.js';

/**
 * - `valid`: the provider accepted the key.
 * - `invalid`: the provider rejected it (auth error); re-checked after `recheckMs`, still tried last.
 * - `expired`: the provider reported it expired; handled like `invalid`.
 * - `degraded`: quota exhausted or rate limited; back to `unknown` once the retry-after elapses.
 * - `unknown`: not decided (no check, the check timed out or hit a network error).
 */
export type CredentialStatus = 'valid' | 'invalid' | 'expired' | 'degraded' | 'unknown';

export const CREDENTIAL_STATUSES: readonly CredentialStatus[] = ['valid', 'invalid', 'expired', 'degraded', 'unknown'];

/**
 * What one use of a key showed:
 * - `ok` (alias `recovered`): the provider accepted it; the key becomes `valid`.
 * - `used`: the call went out but proved nothing about the key (a 404, a 500, a network error).
 * - `degraded` / `invalid` / `expired`: the key's new status.
 */
export type CredentialOutcome = 'ok' | 'recovered' | 'used' | 'degraded' | 'invalid' | 'expired';

export interface CredentialOutcomeInfo {
  /** Short, value-free reason (`quota`, `rate limit`, `auth rejected`, ...). */
  reason?: string;
  /** For `degraded`: how long until the key may work again. */
  retryAfterMs?: number;
}

/** An outcome with its details (what `credentialOutcomeFromHttp` returns). */
export interface ClassifiedOutcome extends CredentialOutcomeInfo {
  outcome: CredentialOutcome;
}

/** One credential's state as `snapshot()` reports it. Names only, never a value. */
export interface CredentialState {
  key: string;
  /** The pool (env `multi` base key) this key belongs to, when it is a pool member. */
  pool?: string;
  status: CredentialStatus;
  reason?: string;
  /** For `degraded`: seconds until the retry-after elapses. */
  retryInSeconds?: number;
  /** ISO time of the last status change. */
  changedAt?: string;
  /** ISO time of the last recorded use. */
  lastUsedAt?: string;
}

/** A re-check of one key (the startup `check` bound to the key's value): its new status. */
export type CredentialProbe = () => Promise<CredentialOutcomeInfo & { status: CredentialStatus }>;

export interface CredentialRegistryOptions {
  /** Clock (tests). */
  now?: () => number;
  /** Logger for transitions (default the mcp-core singleton). */
  logger?: Logger;
  /** Cool-down for a `degraded` outcome that carries no retry-after (default 60000 ms). */
  defaultRetryAfterMs?: number;
  /** How long an invalid or expired key waits before its probe re-checks it (default 300000 ms). */
  recheckMs?: number;
}

interface Entry {
  key: string;
  pool?: string;
  status: CredentialStatus;
  reason?: string;
  retryAt?: number;
  recheckAt?: number;
  changedAt?: number;
  lastUsedAt?: number;
  probe?: CredentialProbe;
  probing?: Promise<CredentialStatus>;
  /** The other parts of a multi-part credential this key stands for (see `cover`). */
  covers?: string[];
}

const DEFAULT_RETRY_AFTER_MS = 60_000;
export const DEFAULT_CREDENTIAL_RECHECK_MS = 300_000;
const MAX_REASON = 200;
/** A credential identifier is an env variable name. */
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A reason is free text from a check or a caller: mask it like client text and bound it. */
function maskReason(reason: string): string {
  return maskSecretValues(redactStringSecrets(reason))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, MAX_REASON);
}

/** No candidate of a pool worked: every one was tried and failed on its credential, or none is configured. */
export class NoUsableCredentialError extends Error {
  readonly pool: string;
  readonly keys: readonly string[];
  constructor(pool: string, keys: readonly string[], detail?: string) {
    super(
      keys.length === 0
        ? `No credential is configured for ${pool}`
        : `No usable credential for ${pool}: ${detail ?? 'every candidate is invalid or expired'} (${keys.join(', ')})`,
    );
    this.name = 'NoUsableCredentialError';
    this.pool = pool;
    this.keys = keys;
  }
}

/**
 * A programming error: an identifier that is not a declared credential name (env key or pool member)
 * was passed where a key NAME belongs (often the VALUE by mistake). The identifier itself is never put
 * in the message.
 */
export class UnknownCredentialError extends Error {
  constructor() {
    super(
      'Unknown credential name: not a declared env key or pool member. Pass the key NAME (for example SEARCH_API_KEY_2), never its value.',
    );
    this.name = 'UnknownCredentialError';
  }
}

function outcomeStatus(outcome: CredentialOutcome): CredentialStatus | undefined {
  switch (outcome) {
    case 'ok':
    case 'recovered':
      return 'valid';
    case 'degraded':
    case 'invalid':
    case 'expired':
      return outcome;
    default:
      return undefined;
  }
}

const UNUSABLE: ReadonlySet<CredentialStatus> = new Set(['invalid', 'expired']);

/** The process-wide (or a test's own) credential health registry. */
export class CredentialRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly pools = new Map<string, string[]>();
  private readonly cursors = new Map<string, number>();
  private readonly now: () => number;
  private readonly logger?: Logger;
  private readonly defaultRetryAfterMs: number;
  private recheckMs: number;

  constructor(options: CredentialRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.logger) this.logger = options.logger;
    this.defaultRetryAfterMs = options.defaultRetryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.recheckMs = options.recheckMs ?? DEFAULT_CREDENTIAL_RECHECK_MS;
  }

  private log(): Logger {
    return this.logger ?? getLogger();
  }

  /** Set the invalid/expired re-check cool-down (startup reads MCP_CREDENTIAL_RECHECK_MS). */
  setRecheckMs(ms: number): void {
    this.recheckMs = Math.max(0, ms);
  }

  /**
   * Declare a credential by its env NAME (status `unknown` until checked or used). Re-registering keeps
   * the status and updates the pool. A pool member is appended to its pool in registration order.
   * Throws `UnknownCredentialError` for anything that is not an env-variable-shaped name.
   */
  register(key: string, options: { pool?: string } = {}): void {
    if (!KEY_NAME.test(key) || (options.pool !== undefined && !KEY_NAME.test(options.pool))) {
      throw new UnknownCredentialError();
    }
    const existing = this.entries.get(key);
    const entry: Entry = existing ?? { key, status: 'unknown' };
    if (options.pool !== undefined && entry.pool !== options.pool) {
      if (entry.pool !== undefined) {
        const old = this.pools.get(entry.pool);
        if (old)
          this.pools.set(
            entry.pool,
            old.filter((k) => k !== key),
          );
      }
      entry.pool = options.pool;
      const members = this.pools.get(options.pool) ?? [];
      if (!members.includes(key)) members.push(key);
      this.pools.set(options.pool, members);
    }
    this.entries.set(key, entry);
  }

  /** Attach the re-check for an invalid or expired key (the startup `check` bound to its value). */
  setProbe(key: string, probe: CredentialProbe): void {
    this.entry(key).probe = probe;
  }

  /**
   * Declare that `key` stands for the other parts of a multi-part credential (client id + secret, key +
   * secret): every status change of `key` (a check, a recheck, a recorded outcome) is applied to each
   * part too, with the same reason. Both sides must be declared (else `UnknownCredentialError`); `key`
   * itself is ignored if listed.
   */
  cover(key: string, parts: readonly string[]): void {
    const entry = this.entry(key);
    const list = parts.filter((p) => p !== key);
    for (const p of list) this.entry(p);
    entry.covers = [...new Set([...(entry.covers ?? []), ...list])];
  }

  /** Forget every credential (tests, or a server re-reading its env). */
  clear(): void {
    this.entries.clear();
    this.pools.clear();
    this.cursors.clear();
  }

  /** Whether `key` is a declared credential name. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The declared entry, or `UnknownCredentialError`. */
  private entry(key: string): Entry {
    const entry = this.entries.get(key);
    if (!entry) throw new UnknownCredentialError();
    return entry;
  }

  /** A degraded key whose retry-after elapsed goes back to `unknown` (logged once). */
  private refresh(entry: Entry): void {
    if (entry.status === 'degraded' && entry.retryAt !== undefined && entry.retryAt <= this.now()) {
      this.transition(entry.key, 'unknown', { reason: 'retry-after elapsed' }, false);
    }
  }

  /** The current status (`unknown` for a key never registered). */
  status(key: string): CredentialStatus {
    const entry = this.entries.get(key);
    if (!entry) return 'unknown';
    this.refresh(entry);
    return entry.status;
  }

  /**
   * The member keys of `pool`: a pool name, a single declared key, or an explicit list of declared keys
   * (an undeclared name in a list throws `UnknownCredentialError`). An unknown pool name has no members.
   */
  members(pool: string | readonly string[]): string[] {
    if (typeof pool !== 'string') {
      for (const key of pool) if (!this.entries.has(key)) throw new UnknownCredentialError();
      return [...pool];
    }
    const members = this.pools.get(pool);
    if (members && members.length > 0) return [...members];
    return this.entries.has(pool) ? [pool] : [];
  }

  /**
   * Set a status directly (startup checks, re-checks). `silent` skips the transition log line (the
   * caller logs a summary instead).
   */
  set(key: string, status: CredentialStatus, info: CredentialOutcomeInfo & { silent?: boolean } = {}): void {
    this.entry(key);
    this.transition(key, status, info, info.silent === true);
  }

  /** Record what a use of `key` showed. `key` must be a declared name. */
  record(key: string, outcome: CredentialOutcome, info: CredentialOutcomeInfo = {}): void {
    const entry = this.entry(key);
    entry.lastUsedAt = this.now();
    const next = outcomeStatus(outcome);
    if (next !== undefined) this.transition(key, next, info, false);
  }

  /** Mark a declared key as used (no outcome). */
  touch(key: string): void {
    this.entry(key).lastUsedAt = this.now();
  }

  private transition(key: string, next: CredentialStatus, info: CredentialOutcomeInfo, silent: boolean): void {
    this.transitionOne(key, next, info, silent);
    for (const part of (this.entries.get(key) as Entry).covers ?? []) this.transitionOne(part, next, info, silent);
  }

  private transitionOne(key: string, next: CredentialStatus, info: CredentialOutcomeInfo, silent: boolean): void {
    const entry = this.entries.get(key) as Entry;
    const previous = entry.status;
    const changed = previous !== next;
    entry.status = next;
    if (next === 'valid') delete entry.reason;
    else if (info.reason !== undefined) entry.reason = maskReason(info.reason);
    else if (changed) delete entry.reason;
    if (next === 'degraded') entry.retryAt = this.now() + Math.max(0, info.retryAfterMs ?? this.defaultRetryAfterMs);
    else delete entry.retryAt;
    if (UNUSABLE.has(next)) entry.recheckAt = this.now() + this.recheckMs;
    else delete entry.recheckAt;
    if (!changed) return;
    entry.changedAt = this.now();
    if (silent) return;
    const detail = entry.reason !== undefined ? ` (${entry.reason})` : '';
    const line = `Credential ${key}: ${previous} -> ${next}${detail}`;
    if (next === 'valid' || next === 'unknown') this.log().info(line, 'Credentials');
    else this.log().warn(line, 'Credentials');
  }

  /** Rank for `candidates`: valid 0, unknown 1, degraded 2, invalid/expired 3 (the last resort). */
  private rank(key: string): number {
    const entry = this.entries.get(key) as Entry;
    this.refresh(entry);
    switch (entry.status) {
      case 'valid':
        return 0;
      case 'unknown':
        return 1;
      case 'degraded':
        return 2;
      default:
        return 3;
    }
  }

  /**
   * Re-check `key` now with its probe (the startup `check`). Resolves with the new status, or the
   * current one when there is no probe. One probe per key runs at a time; a probe never throws out.
   */
  recheck(key: string): Promise<CredentialStatus> {
    const entry = this.entry(key);
    if (!entry.probe) return Promise.resolve(entry.status);
    entry.probing ??= entry
      .probe()
      .then(
        (result) => {
          this.transition(key, result.status, result, false);
          return result.status;
        },
        () => {
          // A failing probe proves nothing: keep the status, wait another cool-down.
          if (UNUSABLE.has(entry.status)) entry.recheckAt = this.now() + this.recheckMs;
          return entry.status;
        },
      )
      .finally(() => {
        delete entry.probing;
      });
    return entry.probing;
  }

  /** Start the re-check of every invalid/expired member whose cool-down elapsed (not awaited). */
  private recheckDue(keys: readonly string[]): void {
    for (const key of keys) {
      const entry = this.entries.get(key) as Entry;
      if (UNUSABLE.has(entry.status) && entry.probe && !entry.probing && (entry.recheckAt ?? 0) <= this.now()) {
        void this.recheck(key);
      }
    }
  }

  /**
   * Every member of `pool`, best first: valid, unknown, degraded, then invalid and expired as the last
   * resort (so a pool whose keys all went bad still tries a request, and a success restores the key).
   * Rotated within the best tier so repeated calls spread over equally healthy keys. Invalid and expired
   * members whose re-check cool-down elapsed are re-checked in the background.
   */
  candidates(pool: string | readonly string[]): string[] {
    const members = this.members(pool);
    this.recheckDue(members);
    const ranked = members
      .map((key, index) => ({ key, index, rank: this.rank(key) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index);
    if (ranked.length === 0) return [];
    const best = ranked[0].rank;
    const top = ranked.filter((m) => m.rank === best);
    const id = typeof pool === 'string' ? pool : pool.join(',');
    const cursor = this.cursors.get(id) ?? 0;
    this.cursors.set(id, cursor + 1);
    const offset = cursor % top.length;
    const rotated = [...top.slice(offset), ...top.slice(0, offset)];
    return [...rotated, ...ranked.filter((m) => m.rank !== best)].map((m) => m.key);
  }

  /** The best member of `pool` (see `candidates`), or undefined when the pool has no member. */
  pick(pool: string | readonly string[]): string | undefined {
    return this.candidates(pool)[0];
  }

  /** One key's state (undefined when never registered). */
  state(key: string): CredentialState | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.refresh(entry);
    const out: CredentialState = { key, status: entry.status };
    if (entry.pool !== undefined) out.pool = entry.pool;
    if (entry.reason !== undefined) out.reason = entry.reason;
    if (entry.status === 'degraded' && entry.retryAt !== undefined) {
      out.retryInSeconds = Math.max(1, Math.ceil((entry.retryAt - this.now()) / 1000));
    }
    if (entry.changedAt !== undefined) out.changedAt = new Date(entry.changedAt).toISOString();
    if (entry.lastUsedAt !== undefined) out.lastUsedAt = new Date(entry.lastUsedAt).toISOString();
    return out;
  }

  /** Every credential's state, in registration order. */
  snapshot(): CredentialState[] {
    return [...this.entries.keys()].map((key) => this.state(key) as CredentialState);
  }
}

let processRegistry: CredentialRegistry | undefined;

/** The process-wide registry `runMcpServer` fills and `registerTools` reports from. */
export function processCredentials(): CredentialRegistry {
  processRegistry ??= new CredentialRegistry();
  return processRegistry;
}

/** Replace the process-wide registry (tests, or a host with its own). Undefined resets it. */
export function setProcessCredentials(registry: CredentialRegistry | undefined): void {
  processRegistry = registry;
}

/** One credential in a tool result's report. */
export interface CredentialReportEntry {
  key: string;
  status: CredentialStatus;
  /** True when this call used the key (a request went out with it). */
  used: boolean;
  reason?: string;
  retryInSeconds?: number;
}

const USABLE: ReadonlySet<CredentialStatus> = new Set(['valid', 'unknown']);

/** Anything that accepts an outcome for a key (a registry or a call scope). */
export interface CredentialRecorder {
  /** Whether `key` is a declared credential name. */
  has(key: string): boolean;
  record(key: string, outcome: CredentialOutcome, info?: CredentialOutcomeInfo): void;
}

/** A tool call's view of the registry: what it picks and records is reported on its result. */
export class CredentialScope implements CredentialRecorder {
  readonly registry: CredentialRegistry;
  private readonly touched = new Map<string, { used: boolean }>();
  private readonly valueFor: (key: string) => string | undefined;

  constructor(registry: CredentialRegistry, valueFor: (key: string) => string | undefined = () => undefined) {
    this.registry = registry;
    this.valueFor = valueFor;
  }

  private touch(key: string, used: boolean): void {
    const seen = this.touched.get(key);
    if (seen) seen.used ||= used;
    else this.touched.set(key, { used });
  }

  has(key: string): boolean {
    return this.registry.has(key);
  }

  /** Consider every member of `pool` (reported when not healthy) and return them, best first. */
  candidates(pool: string | readonly string[]): string[] {
    for (const key of this.registry.members(pool)) this.touch(key, false);
    return this.registry.candidates(pool);
  }

  /**
   * The best key of `pool` (marked used); an invalid or expired key when nothing better is left (try
   * it and record the outcome). Undefined only when the pool has no member.
   */
  pick(pool: string | readonly string[]): string | undefined {
    const key = this.candidates(pool)[0];
    if (key !== undefined) this.touch(key, true);
    return key;
  }

  /** Like `pick`, but throws `NoUsableCredentialError` when the pool has no member. */
  require(pool: string | readonly string[]): string {
    const key = this.pick(pool);
    if (key === undefined) throw new NoUsableCredentialError(poolName(pool), this.registry.members(pool));
    return key;
  }

  /** Mark a declared `key` as used by this call without recording an outcome. */
  use(key: string): void {
    this.registry.touch(key);
    this.touch(key, true);
  }

  record(key: string, outcome: CredentialOutcome, info: CredentialOutcomeInfo = {}): void {
    this.registry.record(key, outcome, info);
    this.touch(key, true);
  }

  /**
   * Try the members of `pool` in order (best first, invalid and expired last): `fn(key, value)` for each
   * until one succeeds. A failure that is a credential problem (see `credentialOutcomeFromError`) is
   * recorded and the next key is tried; any other error is rethrown. When every member failed on its
   * credential (or the pool is empty) it throws `NoUsableCredentialError`.
   */
  async withFallback<T>(
    pool: string | readonly string[],
    fn: (key: string, value: string | undefined) => Promise<T>,
  ): Promise<T> {
    const keys = this.candidates(pool);
    const failures: string[] = [];
    for (const key of keys) {
      this.touch(key, true);
      try {
        return await fn(key, this.valueFor(key));
      } catch (err) {
        const classified = credentialOutcomeFromError(err);
        if (classified === undefined) throw err;
        this.record(key, classified.outcome, classified);
        failures.push(`${key} ${classified.outcome}`);
      }
    }
    const members = this.registry.members(pool);
    throw new NoUsableCredentialError(
      poolName(pool),
      members,
      failures.length > 0 ? `every candidate failed (${failures.join(', ')})` : undefined,
    );
  }

  /** Whether this call touched any credential. */
  get touchedAny(): boolean {
    return this.touched.size > 0;
  }

  /**
   * The report entries: every key the call used, plus every considered key that is not healthy
   * (degraded, invalid, expired). Considered-but-unused healthy keys are left out.
   */
  report(): CredentialReportEntry[] {
    const out: CredentialReportEntry[] = [];
    for (const [key, { used }] of this.touched) {
      const state = this.registry.state(key);
      const status = state?.status ?? 'unknown';
      if (!used && USABLE.has(status)) continue;
      const entry: CredentialReportEntry = { key, status, used };
      if (state?.reason !== undefined) entry.reason = state.reason;
      if (state?.retryInSeconds !== undefined) entry.retryInSeconds = state.retryInSeconds;
      out.push(entry);
    }
    return out;
  }
}

function poolName(pool: string | readonly string[]): string {
  return typeof pool === 'string' ? pool : pool.join(', ');
}

/** The report as one line the model reads: `Credentials: A used; B degraded (quota, retry in 60s); C invalid`. */
export function formatCredentialReport(entries: readonly CredentialReportEntry[]): string {
  const parts = entries.map((e) => {
    if (USABLE.has(e.status)) return `${e.key} used`;
    const details: string[] = [];
    if (e.reason !== undefined) details.push(e.reason);
    if (e.retryInSeconds !== undefined && e.retryInSeconds > 0) details.push(`retry in ${e.retryInSeconds}s`);
    return `${e.key} ${e.status}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
  });
  return `Credentials: ${parts.join('; ')}`;
}

const scopeStorage = new AsyncLocalStorage<CredentialScope>();

/**
 * Run `fn` with `scope` as the current call's credential scope (registerTools does this per call).
 * Outcomes are recorded into the scope active where a request STARTS: a shared in-flight promise
 * (a dedup cache, a coalesced request) reports its key on the call that started it only.
 */
export function runWithCredentialScope<T>(scope: CredentialScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

/** The current tool call's credential scope, when inside one. */
export function currentCredentialScope(): CredentialScope | undefined {
  return scopeStorage.getStore();
}

/** The facts `credentialOutcomeFromHttp` reads. */
export interface CredentialHttpFacts {
  /** HTTP status; undefined for a network error. */
  status?: number;
  /** Upstream or normalized error code. */
  code?: string;
  /** Upstream error message (already masked). */
  message?: string;
  /** Upstream OAuth-style `error_description` (already masked), when the body carried one apart from `message`. */
  description?: string;
  /**
   * The `WWW-Authenticate` response header, when present. Only its `error` and `error_description`
   * parameters are read (RFC 6750), never the realm or anything else.
   */
  authenticate?: string;
  /** The challenge's parameters already parsed (`HttpError.challenge`); used instead of `authenticate`. */
  challenge?: AuthChallenge;
  retryAfterMs?: number;
}

/** The two `WWW-Authenticate` parameters the credential mapping reads (RFC 6750). */
export interface AuthChallenge {
  error?: string;
  description?: string;
}

const MAX_CHALLENGE_LENGTH = 2048;
const TOKEN_CHAR = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;

/**
 * The `error` and `error_description` auth-params of a `WWW-Authenticate` header (first occurrence of
 * each). The header is tokenised left to right: a quoted string (`"..."` with backslash escapes, or
 * `'...'`) is one value and is never searched, so a quoted realm cannot inject a parameter.
 */
export function parseAuthChallenge(header: string | undefined): AuthChallenge {
  const out: AuthChallenge = {};
  if (!header) return out;
  const s = header.slice(0, MAX_CHALLENGE_LENGTH);
  let i = 0;
  const skipSpace = (): void => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === ',')) i++;
  };
  const readToken = (): string => {
    const start = i;
    while (i < s.length && TOKEN_CHAR.test(s[i])) i++;
    return s.slice(start, i);
  };
  const readQuoted = (quote: string): string => {
    i++;
    let value = '';
    while (i < s.length && s[i] !== quote) {
      if (quote === '"' && s[i] === '\\' && i + 1 < s.length) i++;
      value += s[i];
      i++;
    }
    i++;
    return value;
  };
  while (i < s.length) {
    skipSpace();
    if (i >= s.length) break;
    if (s[i] === '"') {
      readQuoted('"');
      continue;
    }
    const name = readToken();
    if (name === '') {
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (s[j] !== '=') continue;
    i = j + 1;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    let value: string;
    if (s[i] === '"' || s[i] === "'") value = readQuoted(s[i]);
    else {
      const start = i;
      while (i < s.length && s[i] !== ',' && s[i] !== ' ' && s[i] !== '\t') i++;
      value = s.slice(start, i);
    }
    const key = name.toLowerCase();
    if (key === 'error' && out.error === undefined) out.error = value;
    else if (key === 'error_description' && out.description === undefined) out.description = value;
  }
  return out;
}

function challengeOf(facts: CredentialHttpFacts): AuthChallenge {
  return facts.challenge ?? parseAuthChallenge(facts.authenticate);
}

/** "expired" next to a credential word, or a credential-expired code. Never a bare "expired". */
const EXPIRED =
  /\b(?:token|key|credentials?|subscription|password|license|licence)\b[^.;\n]{0,40}\bexpired\b|\bexpired\b[^.;\n]{0,20}\b(?:token|key|credentials?|subscription|password|license|licence)\b|(?:token|key|credentials?)[_-]?expired/i;
/** A quota or rate-limit signal. Never a bare "exceeded" ("length exceeded" is a bad request). */
const QUOTA =
  /quota|rate[ _-]?limit|too many requests|out of credits|insufficient credits|credits? exhausted|run out of|usage limit/i;
/** A 403 that is about the credential itself, not about access to one resource. */
const CREDENTIAL_REJECTED =
  /invalid[ _-]?(?:api[ _-]?)?(?:token|key|credentials?|auth\w*)|bad credentials|\b(?:token|key|credentials?)\b[^.;\n]{0,30}\b(?:revoked|disabled|deactivated|suspended)\b|\brevoked\b|invalid_token|invalid_client|invalid_grant|unauthenticated|not authenticated|authentication (?:failed|required)/i;

/**
 * Map an HTTP outcome onto a credential outcome, status-gated:
 * - 2xx/3xx -> ok; 5xx, network errors and every other 4xx (400, 404, 409, 413, 422, ...) -> used;
 * - 401 -> invalid, or expired when the code, message, `error_description` or the `WWW-Authenticate`
 *   `error` / `error_description` parameters name an expired credential (GitLab: `error="invalid_token",
 *   error_description="Token is expired"`);
 * - 402 -> degraded (quota); 429 -> degraded (rate limit, or quota when the body says so);
 * - 403 -> expired / degraded / invalid ONLY when the body (or the challenge's `error="invalid_token"`)
 *   says the credential itself expired, hit a quota or rate limit, or was rejected; a plain 403 is an
 *   authorization answer about one resource and leaves the key alone (used).
 * Degraded outcomes carry the Retry-After.
 */
export function credentialOutcomeFromHttp(facts: CredentialHttpFacts): ClassifiedOutcome {
  const { status } = facts;
  if (status === undefined || status >= 500) return { outcome: 'used' };
  if (status < 400) return { outcome: 'ok' };
  // GitLab-style OAuth answers put a generic `error: "invalid_token"` first and the expiry only in
  // `error_description` and the challenge, so all of them are read.
  // Joined with ` ; ` so no pattern spans two fields (the patterns stop at `;`).
  const challenge = challengeOf(facts);
  const text = [facts.code, facts.message, facts.description, challenge.error, challenge.description]
    .filter((part) => part !== undefined && part !== '')
    .join(' ; ');
  const retry = facts.retryAfterMs !== undefined ? { retryAfterMs: facts.retryAfterMs } : {};
  const quotaReason = /quota|credits|run out|usage limit/i.test(text) ? 'quota' : 'rate limit';
  switch (status) {
    case 401:
      return EXPIRED.test(text)
        ? { outcome: 'expired', reason: 'expired' }
        : { outcome: 'invalid', reason: 'auth rejected' };
    case 402:
      return { outcome: 'degraded', reason: 'quota', ...retry };
    case 429:
      return { outcome: 'degraded', reason: /quota/i.test(text) ? 'quota' : 'rate limit', ...retry };
    case 403:
      if (EXPIRED.test(text)) return { outcome: 'expired', reason: 'expired' };
      if (QUOTA.test(text)) return { outcome: 'degraded', reason: quotaReason, ...retry };
      if (CREDENTIAL_REJECTED.test(text) || /invalid_token/i.test(challenge.error ?? '')) {
        return { outcome: 'invalid', reason: 'credential rejected' };
      }
      return { outcome: 'used' };
    default:
      return { outcome: 'used' };
  }
}

/**
 * Classify a thrown error as a credential problem, or undefined when it is not one. Reads an
 * `HttpError`-shaped object (`status`, `code`, `message`, `description`, `challenge`, `retryAfterMs`), so
 * it reaches the same verdict the http-client recorded (an expired GitLab token stays expired inside
 * `withFallback` and on a throwing startup check); only invalid, expired and degraded count.
 */
export function credentialOutcomeFromError(err: unknown): ClassifiedOutcome | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    description?: unknown;
    challenge?: unknown;
    retryAfterMs?: unknown;
  };
  if (typeof e.status !== 'number') return undefined;
  const facts: CredentialHttpFacts = { status: e.status };
  if (typeof e.code === 'string') facts.code = e.code;
  if (typeof e.message === 'string') facts.message = e.message;
  if (typeof e.description === 'string') facts.description = e.description;
  if (typeof e.challenge === 'object' && e.challenge !== null) {
    const c = e.challenge as { error?: unknown; description?: unknown };
    const challenge: AuthChallenge = {};
    if (typeof c.error === 'string') challenge.error = c.error;
    if (typeof c.description === 'string') challenge.description = c.description;
    facts.challenge = challenge;
  }
  if (typeof e.retryAfterMs === 'number') facts.retryAfterMs = e.retryAfterMs;
  const classified = credentialOutcomeFromHttp(facts);
  return classified.outcome === 'invalid' || classified.outcome === 'expired' || classified.outcome === 'degraded'
    ? classified
    : undefined;
}
