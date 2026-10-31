/**
 * @novorb/mcp-core - Data store
 *
 * The one module an MCP server uses to write to disk (discovery caches, downloads, persisted settings).
 *
 * - Directory: `DATA_PATH` (absolute, or relative to rootDir), default `<rootDir>/.data`. Created
 *   lazily on the first write, never at import time and never relative to cwd.
 * - `DATA_STORAGE=false` runs the server STATELESS: nothing is written, no directory is created;
 *   `jsonCache` falls back to process memory and `downloadToFile` returns the bytes instead of a path.
 * - `downloadToFile` fetches a URL source through `guardedFetch` (`../net.ts`): public addresses only
 *   unless the caller passes `allowPrivate: true`, every redirect hop re-validated.
 * - Every path goes through `resolveInside`, which refuses `..`, absolute segments, drive letters, NUL
 *   and symlink escapes. Names that come from tool arguments or remote APIs go through `safeName` first.
 *
 *   const store = createDataStore({ rootDir, env });
 *   const cache = store.jsonCache<Discovery>({ name: 'discovery', ttlMs: 3_600_000 });
 *   const hit = await cache.read();
 */

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { LookupFunction } from 'node:net';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { GuardedFetchError, type GuardedFetchOptions, type GuardedFetchReason, guardedFetch } from '../net.js';
import { sleep } from '../retry.js';
import { toolError } from '../tools.js';
import type { LoadedEnv } from './envLoader.js';
import { getLogger, type Logger } from './logger.js';

/** A path that would leave the data directory (or is malformed). */
export class DataPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataPathError';
  }
}

/** A write was attempted while DATA_STORAGE=false. */
export class DataStorageDisabledError extends Error {
  constructor(feature: string) {
    super(storageDisabledMessage(feature));
    this.name = 'DataStorageDisabledError';
  }
}

/** A download failed: bad status, too large, too slow, too many redirects. */
export class DownloadError extends Error {
  /**
   * `blocked`: the SSRF guard refused the URL or a redirect hop (invalid URL, userinfo, origin off
   * `allowedOrigins`, private address); `content-type`: off `allowedContentTypes`.
   */
  readonly reason:
    | 'status'
    | 'too-large'
    | 'timeout'
    | 'redirects'
    | 'protocol'
    | 'aborted'
    | 'network'
    | 'blocked'
    | 'content-type';
  readonly status?: number;
  constructor(reason: DownloadError['reason'], message: string, status?: number) {
    super(message);
    this.name = 'DownloadError';
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

function storageDisabledMessage(feature: string): string {
  return `data storage is disabled (DATA_STORAGE=false): ${feature} needs it`;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_NAME_LENGTH = 200;

/**
 * Turn an untrusted name (a tool argument, a remote file name) into one safe path segment: separators
 * and characters outside `[A-Za-z0-9._ -]` become `_`, leading dots and trailing dots/spaces are
 * removed, Windows reserved device names are prefixed with `_`, length is capped. Never empty.
 */
export function safeName(name: string): string {
  let out = name
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
  if (out.length > MAX_NAME_LENGTH) out = out.slice(0, MAX_NAME_LENGTH).replace(/[.\s]+$/, '');
  return out || '_';
}

function checkSegment(segment: string): string[] {
  if (segment.includes('\0')) throw new DataPathError('path segment contains a NUL character');
  if (/^[A-Za-z]:/.test(segment)) throw new DataPathError('path segment has a drive letter');
  if (path.posix.isAbsolute(segment) || path.win32.isAbsolute(segment)) {
    throw new DataPathError('path segment is absolute');
  }
  const parts = segment.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new DataPathError('path segment contains ".."');
  return parts;
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  // `..` or `../x` escapes; a name that merely starts with dots (`..foo`) is inside.
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`);
  return rel === '' || (!escapes && !path.isAbsolute(rel));
}

/** The realpath of the deepest existing ancestor of `target` (symlink escapes are caught on it). */
function realAncestor(target: string): string | undefined {
  let current = target;
  for (;;) {
    try {
      return realpathSync.native(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/** Join `segments` under `baseDir`, throwing `DataPathError` if the result would escape it. */
export function resolveInside(baseDir: string, ...segments: string[]): string {
  const base = path.resolve(baseDir);
  const parts = segments.flatMap(checkSegment);
  if (parts.length === 0) throw new DataPathError('empty path');
  const target = path.join(base, ...parts);
  if (!isInside(base, target)) throw new DataPathError('path escapes the data directory');
  // Symlink escape: the deepest existing ancestor of the target, resolved, must stay inside the resolved
  // base (when the base does not exist yet both resolve to the same existing ancestor).
  const realBase = realAncestor(base);
  const realTarget = realAncestor(target);
  if (realBase && realTarget && !isInside(realBase, realTarget)) {
    throw new DataPathError('path escapes the data directory through a symlink');
  }
  return target;
}

export interface JsonCache<T> {
  /** The cached value and its age, or null when absent, expired or unreadable. */
  read(): Promise<{ data: T; ageMs: number } | null>;
  /** Store a value (now). */
  write(data: T): Promise<void>;
  /** Drop the cached value. */
  clear(): Promise<void>;
}

export type DownloadSource =
  | string
  | URL
  /** Any client: return a fetch `Response` for the request; mcp-core reads it with the same caps. */
  | ((init: { signal: AbortSignal }) => Promise<Response>);

export interface DownloadOptions {
  /** Max body size (default 50 MiB); larger is a `DownloadError('too-large')`. */
  maxBytes?: number;
  /** Total time limit in ms (default 60000). */
  timeoutMs?: number;
  /** Caller cancellation (pass `ctx.signal`). */
  signal?: AbortSignal;
  /** URL sources only: redirects followed (default 3), every hop re-validated by the SSRF guard. */
  maxRedirects?: number;
  /** URL sources only: request headers (dropped when a redirect changes origin). */
  headers?: Record<string, string>;
  /**
   * URL sources only: explicit opt-in to private, loopback and link-local targets. Default false: a URL
   * source is fetched through `guardedFetch` (`@novorb/mcp-core/net`) and only public addresses connect.
   */
  allowPrivate?: boolean;
  /** URL sources only: the URL and every redirect hop must be on one of these origins. */
  allowedOrigins?: readonly string[];
  /** URL sources only: content types a 2xx answer may have (`type/*` allowed); unset = any. */
  allowedContentTypes?: readonly string[];
  /** URL sources only: the DNS resolver (a test seam; every answer is still checked). */
  lookup?: LookupFunction;
  /** URL sources only: a custom address policy replacing the public-only default (a test seam). */
  isAllowedAddress?: (address: string) => boolean;
}

export interface DownloadResult {
  bytes: number;
  contentType?: string;
  /** The written file, or null when storage is disabled. */
  path: string | null;
  /** The body, when storage is disabled (return it inline from the tool instead of a path). */
  data?: Buffer;
}

export interface DataStore {
  readonly enabled: boolean;
  /** The data directory, or null when storage is disabled. */
  readonly dir: string | null;
  /** Join under the data directory; throws on escape (and DataStorageDisabledError when disabled). */
  resolveInside(...segments: string[]): string;
  /** Atomically write (temp file + rename). Throws DataStorageDisabledError when disabled. */
  writeFile(relPath: string, data: string | Uint8Array): Promise<string>;
  /** The file contents, or null when absent (always null when disabled). */
  readFile(relPath: string): Promise<Buffer | null>;
  /** Remove a file or directory; true when something was removed (false when disabled). */
  remove(relPath: string): Promise<boolean>;
  /** Create a directory (recursive). Throws DataStorageDisabledError when disabled. */
  ensureDir(relPath: string): Promise<string>;
  /** A TTL-checked JSON cache at `cache/<name>.json`; in memory when disabled. */
  jsonCache<T>(opts: { name: string; ttlMs: number }): JsonCache<T>;
  /** Bounded download (size, time, redirects); returns the bytes instead of writing when disabled. */
  downloadToFile(source: DownloadSource, relPath: string, opts?: DownloadOptions): Promise<DownloadResult>;
  /** undefined when enabled; otherwise the uniform toolError for a feature that needs storage. */
  requireEnabled(feature: string): CallToolResult | undefined;
}

export interface CreateDataStoreOptions {
  rootDir: string;
  env: LoadedEnv;
  logger?: Logger;
}

function isCwdDependent(p: string): boolean {
  if (/^[A-Za-z]:(?![\\/])/.test(p)) return true;
  return process.platform === 'win32' && /^[\\/](?![\\/])/.test(p);
}

function resolveDataDir(rootDir: string, dataPath: string | undefined): string {
  if (dataPath === undefined) return path.join(path.resolve(rootDir), '.data');
  if (isCwdDependent(dataPath)) throw new DataPathError(`DATA_PATH "${dataPath}" is drive- or root-relative`);
  return path.isAbsolute(dataPath) ? path.resolve(dataPath) : path.resolve(rootDir, dataPath);
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * A URL source through the SSRF guard: http(s) only, no userinfo, public addresses only (unless
 * `allowPrivate`) checked in the socket lookup, every redirect hop re-validated, headers dropped across
 * origins. The data store's own signal carries the time cap; the guard's cap is the same budget.
 */
function fetchGuarded(
  source: string | URL,
  opts: DownloadOptions,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Response> {
  const guard: GuardedFetchOptions = {
    redirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    maxBytes,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal,
  };
  if (opts.headers) guard.headers = opts.headers;
  if (opts.allowPrivate !== undefined) guard.allowPrivate = opts.allowPrivate;
  if (opts.allowedOrigins) guard.allowedOrigins = opts.allowedOrigins;
  if (opts.allowedContentTypes) guard.allowedContentTypes = opts.allowedContentTypes;
  if (opts.lookup) guard.lookup = opts.lookup;
  if (opts.isAllowedAddress) guard.isAllowedAddress = opts.isAllowedAddress;
  return guardedFetch(source, guard);
}

/** A download cap as a finite number at least `min`; a TypeError naming the option otherwise. */
function requireCap(name: string, value: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new TypeError(`downloadToFile: ${name} must be a finite number >= ${min}`);
  }
  return value;
}

const GUARD_REASONS: Record<GuardedFetchReason, DownloadError['reason']> = {
  url: 'blocked',
  protocol: 'protocol',
  credentials: 'blocked',
  origin: 'blocked',
  address: 'blocked',
  redirect: 'redirects',
  redirects: 'redirects',
  'content-type': 'content-type',
  'too-large': 'too-large',
  timeout: 'timeout',
  aborted: 'aborted',
  network: 'network',
};

/** `reader.read()` that rejects once `signal` aborts (a source that ignores the signal stays bounded). */
function readOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (r) => {
        signal.removeEventListener('abort', onAbort);
        resolve(r);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

async function readCapped(res: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new DownloadError('too-large', `body exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await readOrAbort(reader, signal);
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DownloadError('too-large', `body exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function describeFailure(err: unknown, timeout: AbortSignal, caller?: AbortSignal): DownloadError {
  if (err instanceof DownloadError) return err;
  if (caller?.aborted) return new DownloadError('aborted', 'download aborted');
  if (timeout.aborted) return new DownloadError('timeout', 'download timed out');
  if (err instanceof GuardedFetchError) {
    const reason = GUARD_REASONS[err.reason];
    const verb =
      reason === 'blocked' || reason === 'protocol' || reason === 'content-type'
        ? 'download refused'
        : 'download failed';
    return new DownloadError(reason, `${verb}: ${err.message}`);
  }
  return new DownloadError('network', `download failed: ${err instanceof Error ? err.message : String(err)}`);
}

/** The transient rename failures Windows raises while another handle (a reader, AV, the indexer) has the target open. */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface RenameRetryOptions {
  /** Platform deciding whether transient codes are retried (default `process.platform`; only win32 retries). */
  platform?: NodeJS.Platform;
  /** Total retry budget in ms (default 2000). */
  budgetMs?: number;
  /** The rename to run (default `fs/promises` rename; tests inject a failing one). */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * `rename(from, to)` with the Windows replace race handled: on win32 an EPERM/EACCES/EBUSY (the target is
 * open in another handle, for example a poller reading it) is retried with a short growing backoff
 * within `budgetMs`, then rethrown. Other platforms and other errors fail at once.
 */
export async function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): Promise<void> {
  const doRename = options.rename ?? rename;
  const retries = (options.platform ?? process.platform) === 'win32';
  const deadline = Date.now() + (options.budgetMs ?? 2000);
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    try {
      await doRename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (!retries || code === undefined || !TRANSIENT_RENAME_CODES.has(code) || Date.now() + delay > deadline) throw e;
      await sleep(delay);
    }
  }
}

/** Create the data store for a server (see the module header). */
export function createDataStore(opts: CreateDataStoreOptions): DataStore {
  // Fail closed: an invalid DATA_STORAGE value (a typo of "false") disables writes instead of enabling them.
  const raw = opts.env.get('DATA_STORAGE');
  const parsed = opts.env.bool('DATA_STORAGE');
  const enabled = raw === undefined ? true : parsed === true;
  if (raw !== undefined && parsed === undefined) {
    (opts.logger ?? getLogger()).warn('env DATA_STORAGE is not a boolean; disk storage is disabled', 'DataStore');
  }
  const dir = enabled ? resolveDataDir(opts.rootDir, opts.env.get('DATA_PATH')) : null;
  const memory = new Map<string, { savedAt: number; data: unknown }>();

  const inside = (...segments: string[]): string => {
    if (!dir) throw new DataStorageDisabledError('a file path');
    return resolveInside(dir, ...segments);
  };

  const atomicWrite = async (target: string, data: string | Uint8Array): Promise<void> => {
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temp, data);
      await renameWithRetry(temp, target);
    } catch (e) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw e;
    }
  };

  const store: DataStore = {
    enabled,
    dir,
    resolveInside: inside,
    async writeFile(relPath, data) {
      if (!dir) throw new DataStorageDisabledError('writing a file');
      const target = inside(relPath);
      await atomicWrite(target, data);
      return target;
    },
    async readFile(relPath) {
      if (!dir) return null;
      try {
        return await readFile(inside(relPath));
      } catch (e) {
        if ((e as { code?: unknown }).code === 'ENOENT') return null;
        throw e;
      }
    },
    async remove(relPath) {
      if (!dir) return false;
      const target = inside(relPath);
      try {
        await rm(target, { recursive: true });
        return true;
      } catch (e) {
        if ((e as { code?: unknown }).code === 'ENOENT') return false;
        throw e;
      }
    },
    async ensureDir(relPath) {
      if (!dir) throw new DataStorageDisabledError('a data directory');
      const target = inside(relPath);
      await mkdir(target, { recursive: true });
      return target;
    },
    jsonCache<T>({ name, ttlMs }: { name: string; ttlMs: number }): JsonCache<T> {
      const file = `cache/${safeName(name)}.json`;
      const fresh = (savedAt: number): number | null => {
        const ageMs = Date.now() - savedAt;
        return ageMs <= ttlMs ? Math.max(0, ageMs) : null;
      };
      return {
        async read() {
          if (!dir) {
            const hit = memory.get(file);
            const ageMs = hit ? fresh(hit.savedAt) : null;
            return hit && ageMs !== null ? { data: hit.data as T, ageMs } : null;
          }
          const raw = await store.readFile(file);
          if (!raw) return null;
          try {
            const parsed = JSON.parse(raw.toString('utf8')) as { savedAt?: unknown; data?: unknown };
            if (typeof parsed.savedAt !== 'number') return null;
            const ageMs = fresh(parsed.savedAt);
            return ageMs === null ? null : { data: parsed.data as T, ageMs };
          } catch {
            opts.logger?.warn(`cache ${safeName(name)} is unreadable; ignoring it`, 'DataStore');
            return null;
          }
        },
        async write(data) {
          const entry = { savedAt: Date.now(), data };
          if (!dir) memory.set(file, entry);
          else await store.writeFile(file, JSON.stringify(entry));
        },
        async clear() {
          if (!dir) memory.delete(file);
          else await store.remove(file);
        },
      };
    },
    async downloadToFile(source, relPath, dl = {}) {
      // The path is validated in both modes, so a call valid when stateless is valid when stateful.
      checkSegment(relPath);
      const target = dir ? inside(relPath) : null;
      // A non-finite or negative cap would silently disable it: refuse it before anything is fetched.
      const maxBytes = requireCap('maxBytes', dl.maxBytes ?? DEFAULT_MAX_BYTES, 0);
      requireCap('maxRedirects', dl.maxRedirects ?? DEFAULT_MAX_REDIRECTS, 0);
      const timeout = AbortSignal.timeout(requireCap('timeoutMs', dl.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1));
      const signal = dl.signal ? AbortSignal.any([timeout, dl.signal]) : timeout;
      let body: Buffer;
      let contentType: string | undefined;
      try {
        const res =
          typeof source === 'function' ? await source({ signal }) : await fetchGuarded(source, dl, maxBytes, signal);
        if (res.status < 200 || res.status >= 300) {
          await res.body?.cancel().catch(() => undefined);
          throw new DownloadError('status', `download failed with status ${res.status}`, res.status);
        }
        contentType = res.headers.get('content-type') ?? undefined;
        body = await readCapped(res, maxBytes, signal);
      } catch (e) {
        throw describeFailure(e, timeout, dl.signal);
      }
      const result: DownloadResult = { bytes: body.byteLength, path: target };
      if (contentType) result.contentType = contentType;
      if (!target) {
        result.data = body;
        return result;
      }
      await atomicWrite(target, body);
      opts.logger?.debug('download stored', 'DataStore', { bytes: body.byteLength });
      return result;
    },
    requireEnabled(feature) {
      return enabled ? undefined : toolError(storageDisabledMessage(feature));
    },
  };
  return store;
}
