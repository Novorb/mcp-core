/**
 * @novorb/mcp-core - Sealed requestState (multi-round-trip flows)
 *
 * A multi-step tool returns `inputRequired({ inputRequests?, requestState })`; the client echoes
 * `requestState` back on the retry (2026-07-28 MRTR; the SDK's legacy shim does the same in-process for
 * 2025-era connections). The echoed value is attacker-controlled. The SDK ships an HMAC codec
 * (`createRequestStateCodec`: signed, NOT encrypted, the client can read the payload) and the
 * `ServerOptions.requestState.verify` seam; mcp-core adds the authenticated-encryption variant with the
 * SAME `RequestStateCodec` interface (`mint` / `verify`), so it drops into that seam unchanged:
 *
 * - AES-256-GCM with a per-key sub-key derived by HKDF-SHA256 (the operator secret is never used as
 *   the cipher key directly); the payload is confidential and tamper-evident;
 * - expiry (`ttlSeconds`, default 600) inside the sealed envelope;
 * - context binding (default: the request method and the caller's `clientId`), compared in constant
 *   time, so a state minted for one caller is refused for another;
 * - key rotation: the current key seals, the current and every previous key open (`kid` routing);
 * - tamper, expiry, binding and unknown-key failures throw `RequestStateError` with a reason; the SDK
 *   answers the client the frozen `-32602 Invalid or expired requestState` and reports the reason to
 *   the server's `onerror` (the mcp-core logger).
 *
 * Wire: `ms1.<kid>.<iv>.<ciphertext+tag>` (base64url parts; AAD = `ms1.<kid>`).
 *
 * The key comes from `MCP_REQUEST_STATE_KEY` (secret, at least 32 bytes, for example
 * `openssl rand -base64 48`); `MCP_REQUEST_STATE_PREVIOUS_KEY` (multi: `_1`, `_2`, ...) keeps
 * in-flight flows valid across a rotation. The SAME key must be configured on every instance that can
 * receive a retry (stateless HTTP may route each round to a different replica). Without a key the
 * feature refuses to start (`requestStateCodecFromEnv` throws).
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestStateCodec, ServerContext } from '@modelcontextprotocol/server';
import type { LoadedEnv } from './utils/envLoader.js';
import { registerSecretValues } from './utils/logger.js';

export type { RequestStateCodec } from '@modelcontextprotocol/server';

/** Minimum key length in bytes (the SDK's HMAC codec uses the same bound). */
export const MIN_REQUEST_STATE_KEY_BYTES = 32;
/** Default lifetime of a minted state, in seconds. */
export const DEFAULT_REQUEST_STATE_TTL_SECONDS = 600;

const VERSION = 'ms1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type RequestStateFailure = 'malformed' | 'unknown-key' | 'tampered' | 'expired' | 'bind';

/** A refused requestState. `reason` is a fixed code; the message never carries the payload. */
export class RequestStateError extends Error {
  readonly reason: RequestStateFailure;
  constructor(reason: RequestStateFailure) {
    const text: Record<RequestStateFailure, string> = {
      malformed: 'requestState is malformed',
      'unknown-key':
        'requestState was sealed with a key this server does not hold (rotated out, or another deployment)',
      tampered: 'requestState failed authentication (tampered or corrupted)',
      expired: 'requestState has expired',
      bind: 'requestState was issued for another caller or method',
    };
    super(text[reason]);
    this.name = 'RequestStateError';
    this.reason = reason;
  }
}

/** Thrown when the feature is used without a valid key. */
export class RequestStateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestStateKeyError';
  }
}

export interface SealedRequestStateOptions {
  /** The operator secret (UTF-8 string or bytes), at least 32 bytes. */
  key: string | Uint8Array;
  /** Older secrets still accepted for opening (rotation). */
  previousKeys?: ReadonlyArray<string | Uint8Array>;
  /** Lifetime of a minted state in seconds (default 600). */
  ttlSeconds?: number;
  /**
   * Context binding, evaluated at mint and verify (default: method + caller clientId). `false`
   * disables binding (only for state that does not influence authorization or resource access).
   */
  bind?: ((ctx: ServerContext) => string) | false;
  /** Clock in milliseconds (tests). */
  now?: () => number;
}

interface DerivedKey {
  kid: string;
  key: Buffer;
}

function keyBytes(key: string | Uint8Array, label: string): Buffer {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
  if (bytes.length < MIN_REQUEST_STATE_KEY_BYTES) {
    throw new RequestStateKeyError(
      `${label} must be at least ${MIN_REQUEST_STATE_KEY_BYTES} bytes (got ${bytes.length}); generate one with \`openssl rand -base64 48\``,
    );
  }
  return bytes;
}

function derive(secret: Buffer): DerivedKey {
  const kid = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'mcp-core/request-state/kid', 6)).toString(
    'base64url',
  );
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'mcp-core/request-state/aes-256-gcm', 32));
  return { kid, key };
}

/** The default binding: the request method and the authenticated caller. */
export function defaultRequestStateBinding(ctx: ServerContext): string {
  return `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`;
}

function bindTag(value: string): string {
  return createHash('sha256').update(`mcp-core.requestState.bind:${value}`).digest('base64url');
}

function sameTag(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/**
 * An authenticated-encryption `RequestStateCodec` (AES-256-GCM, HKDF sub-keys, expiry, binding,
 * rotation). Pass it as `createMcpServer(..., { requestStateCodec })`.
 */
export function createSealedRequestStateCodec<T = unknown>(options: SealedRequestStateOptions): RequestStateCodec<T> {
  const current = derive(keyBytes(options.key, 'MCP_REQUEST_STATE_KEY'));
  const opening = new Map<string, Buffer>([[current.kid, current.key]]);
  for (const [i, previous] of (options.previousKeys ?? []).entries()) {
    const d = derive(keyBytes(previous, `MCP_REQUEST_STATE_PREVIOUS_KEY (${i + 1})`));
    if (!opening.has(d.kid)) opening.set(d.kid, d.key);
  }
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_REQUEST_STATE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new RangeError('ttlSeconds must be a positive integer');
  const bind = options.bind === false ? undefined : (options.bind ?? defaultRequestStateBinding);
  const now = options.now ?? Date.now;

  return {
    async mint(payload: T, ctx?: ServerContext): Promise<string> {
      if (bind && !ctx) throw new TypeError('requestState mint needs the handler context for its binding');
      const body: { p: T; exp: number; b?: string } = { p: payload, exp: Math.floor(now() / 1000) + ttlSeconds };
      if (bind && ctx) body.b = bindTag(bind(ctx));
      const iv = randomBytes(IV_BYTES);
      const header = `${VERSION}.${current.kid}`;
      const cipher = createCipheriv('aes-256-gcm', current.key, iv);
      cipher.setAAD(Buffer.from(header, 'utf8'));
      const sealed = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return `${header}.${iv.toString('base64url')}.${sealed.toString('base64url')}`;
    },
    async verify(state: string, ctx: ServerContext): Promise<T> {
      const parts = state.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) throw new RequestStateError('malformed');
      const [version, kid, ivText, sealedText] = parts as [string, string, string, string];
      const key = opening.get(kid);
      if (!key) throw new RequestStateError('unknown-key');
      const iv = Buffer.from(ivText, 'base64url');
      const sealed = Buffer.from(sealedText, 'base64url');
      if (iv.length !== IV_BYTES || sealed.length <= TAG_BYTES) throw new RequestStateError('malformed');
      let plain: string;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(`${version}.${kid}`, 'utf8'));
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
        plain = Buffer.concat([
          decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new RequestStateError('tampered');
      }
      let body: { p?: T; exp?: unknown; b?: unknown };
      try {
        body = JSON.parse(plain) as typeof body;
      } catch {
        throw new RequestStateError('malformed');
      }
      if (typeof body.exp !== 'number' || body.exp * 1000 <= now()) throw new RequestStateError('expired');
      if (bind) {
        if (typeof body.b !== 'string' || !sameTag(body.b, bindTag(bind(ctx)))) throw new RequestStateError('bind');
      }
      return body.p as T;
    },
  };
}

function isLoadedEnv(env: LoadedEnv | NodeJS.ProcessEnv): env is LoadedEnv {
  return typeof (env as LoadedEnv).get === 'function' && typeof (env as LoadedEnv).getAll === 'function';
}

function previousFromProcessEnv(env: NodeJS.ProcessEnv): string[] {
  const base = 'MCP_REQUEST_STATE_PREVIOUS_KEY';
  const keys = Object.keys(env)
    .filter((k) => k === base || k.startsWith(`${base}_`))
    .sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b, 'en', { numeric: true })));
  return keys.map((k) => env[k]).filter((v): v is string => typeof v === 'string' && v !== '');
}

/**
 * The sealed codec from `MCP_REQUEST_STATE_KEY`, `MCP_REQUEST_STATE_PREVIOUS_KEY[_n]` and
 * `MCP_REQUEST_STATE_TTL_SECONDS`. Throws `RequestStateKeyError` when the key is missing or too short
 * (the feature never runs with a default or empty key). Every key is registered with the logger mask.
 */
export function requestStateCodecFromEnv<T = unknown>(
  env: LoadedEnv | NodeJS.ProcessEnv = process.env,
  options: Omit<SealedRequestStateOptions, 'key' | 'previousKeys' | 'ttlSeconds'> = {},
): RequestStateCodec<T> {
  const loaded = isLoadedEnv(env);
  const key = loaded ? env.get('MCP_REQUEST_STATE_KEY') : env.MCP_REQUEST_STATE_KEY || undefined;
  if (key === undefined) {
    throw new RequestStateKeyError(
      'requestState is not available: set MCP_REQUEST_STATE_KEY (a secret of at least 32 bytes, the same on every instance)',
    );
  }
  const previous = loaded ? env.getAll('MCP_REQUEST_STATE_PREVIOUS_KEY') : previousFromProcessEnv(env);
  registerSecretValues([key, ...previous]);
  const ttlRaw = loaded ? env.get('MCP_REQUEST_STATE_TTL_SECONDS') : env.MCP_REQUEST_STATE_TTL_SECONDS;
  const ttl = ttlRaw === undefined || ttlRaw === '' ? undefined : Number(ttlRaw);
  return createSealedRequestStateCodec<T>({
    ...options,
    key,
    previousKeys: previous,
    ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
  });
}
