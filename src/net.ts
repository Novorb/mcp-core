/**
 * @novorb/mcp-core - Guarded outbound fetch (server-side request forgery guard)
 *
 * The one way an MCP server fetches a URL it did not configure itself: a URL from a tool argument, or a
 * URL an upstream API handed back (a download link, a thumbnail, an avatar).
 *
 * - http(s) only, no userinfo, optionally only on `allowedOrigins`.
 * - Public addresses only (`isPublicAddress`), unless the caller opts in with `allowPrivate: true`. An IP
 *   literal is checked before anything is sent; a DNS name is checked INSIDE the socket's lookup, on
 *   every address it resolves to, so the socket can only connect to an address that passed (no
 *   check-then-connect gap, a rebinding name cannot slip through).
 * - Every request gets its own agent (keep-alive off), never Node's global agent: with
 *   `NODE_USE_ENV_PROXY` + `HTTP(S)_PROXY` the global agent would hand the request to a proxy, which
 *   resolves the name itself and skips the guarded lookup.
 * - Redirects are refused by default; with `redirects: <n>` at most n are followed and every hop is
 *   validated again by the same rules (scheme, userinfo, origins, addresses). Caller headers are dropped
 *   when a redirect changes origin.
 * - Size cap (declared and streamed), one total time cap (headers and body), the caller's abort signal,
 *   and an optional allow-list of content types.
 *
 *   const res = await guardedFetch(url, { allowedOrigins: ['https://cdn.example.com'], maxBytes, signal });
 *   const bytes = Buffer.from(await res.arrayBuffer());
 */

import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { type ClientRequest, Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

/** Why a guarded fetch was refused or failed. */
export type GuardedFetchReason =
  | 'url'
  | 'protocol'
  | 'credentials'
  | 'origin'
  | 'address'
  | 'redirect'
  | 'redirects'
  | 'content-type'
  | 'too-large'
  | 'timeout'
  | 'aborted'
  | 'network';

/** The error code of an address the policy refused (on the URL literal or in the socket lookup). */
export const ADDRESS_BLOCKED_CODE = 'ERR_ADDRESS_BLOCKED';

/** A refused or failed guarded fetch. The message never carries the URL (callers add it if they want). */
export class GuardedFetchError extends Error {
  readonly reason: GuardedFetchReason;
  /** `ERR_ADDRESS_BLOCKED` for the address policy, the socket error code for a network error. */
  readonly code?: string;
  /** The HTTP status of a refused redirect. */
  readonly status?: number;
  constructor(reason: GuardedFetchReason, message: string, details: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'GuardedFetchError';
    this.reason = reason;
    if (details.code !== undefined) this.code = details.code;
    if (details.status !== undefined) this.status = details.status;
  }
}

/** The address side of the guard (shared by `guardedFetch`, `createGuardedAgent` and `checkUrl`). */
export interface AddressGuardOptions {
  /** Explicit opt-in to private, loopback and link-local targets (default false: public addresses only). */
  allowPrivate?: boolean;
  /** A custom address policy replacing `isPublicAddress` (a test seam, or a stricter policy). */
  isAllowedAddress?: (address: string) => boolean;
  /** The DNS resolver (default `dns.lookup`); every address it answers goes through the policy. */
  lookup?: LookupFunction;
}

export interface UrlGuardOptions extends AddressGuardOptions {
  /** When set, the URL (and every redirect hop) must be on one of these origins (`scheme://host[:port]`). */
  allowedOrigins?: readonly string[];
}

export interface GuardedFetchOptions extends UrlGuardOptions {
  /** GET (default) or HEAD: a guarded fetch reads, it never sends a body. */
  method?: 'GET' | 'HEAD';
  /** Request headers; dropped when a redirect leaves the starting origin. */
  headers?: Record<string, string>;
  /** `'refuse'` (default): any redirect is an error. A number: follow at most that many, each re-validated. */
  redirects?: 'refuse' | number;
  /** Body cap in bytes (default 50 MiB), declared (`content-length`) and while streaming. */
  maxBytes?: number;
  /** Total time cap in ms (default 30000), covering every hop and the body read. */
  timeoutMs?: number;
  /** Caller cancellation (pass `ctx.signal`). */
  signal?: AbortSignal;
  /**
   * Content types a 2xx answer may have, compared on the lower-cased essence (`image/png`); `type/*`
   * admits a whole top-level type. Unset: any type.
   */
  allowedContentTypes?: readonly string[];
  /** With `allowedContentTypes`, whether an answer without a content type passes (default false). */
  allowMissingContentType?: boolean;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);
const PRIVATE_LITERAL = 'the host is a private, loopback or link-local address';
const PRIVATE_NAME = 'the host resolves to a private, loopback or link-local address';

type Bytes = number[];

/** The four bytes of a dotted-quad IPv4 address, or undefined. */
function parseIPv4(text: string): Bytes | undefined {
  if (isIP(text) !== 4) return undefined;
  return text.split('.').map(Number);
}

/** The sixteen bytes of an IPv6 address (zone id dropped, a dotted IPv4 tail allowed), or undefined. */
function parseIPv6(text: string): Bytes | undefined {
  const address = text.split('%')[0];
  if (isIP(address) !== 6) return undefined;
  let body = address;
  const tail: number[] = [];
  if (body.includes('.')) {
    const cut = body.lastIndexOf(':') + 1;
    const v4 = parseIPv4(body.slice(cut));
    if (!v4) return undefined;
    tail.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    body = body.slice(0, cut);
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const halves = body.split('::');
  const words = (part: string): number[] => (part === '' ? [] : part.split(':').map((w) => Number.parseInt(w, 16)));
  const left = words(halves[0]);
  const right = halves.length > 1 ? words(halves[1]) : [];
  const fill = 8 - tail.length - left.length - right.length;
  const all = halves.length > 1 ? [...left, ...new Array<number>(fill).fill(0), ...right, ...tail] : [...left, ...tail];
  if (all.length !== 8) return undefined;
  return all.flatMap((w) => [w >> 8, w & 0xff]);
}

/** Whether `bytes` lies in `prefix/bits` (prefix given as bytes, missing bytes zero). */
function inRange(bytes: Bytes, prefix: Bytes, bits: number): boolean {
  for (let i = 0; i < bits; i += 1) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

/** IPv4 ranges that are not globally reachable (RFC 6890 and its updates). */
const BLOCKED_V4: ReadonlyArray<readonly [Bytes, number]> = [
  [[0], 8], // this network
  [[10], 8], // private
  [[100, 64], 10], // carrier-grade NAT
  [[127], 8], // loopback
  [[169, 254], 16], // link-local, cloud metadata
  [[172, 16], 12], // private
  [[192, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2], 24], // documentation
  [[192, 31, 196], 24], // AS112
  [[192, 52, 193], 24], // AMT
  [[192, 88, 99], 24], // 6to4 relay anycast
  [[192, 168], 16], // private
  [[192, 175, 48], 24], // AS112
  [[198, 18], 15], // benchmarking
  [[198, 51, 100], 24], // documentation
  [[203, 0, 113], 24], // documentation
  [[224], 4], // multicast
  [[240], 4], // reserved, broadcast
];

function isPublicV4(bytes: Bytes): boolean {
  return !BLOCKED_V4.some(([prefix, bits]) => inRange(bytes, prefix, bits));
}

/** IPv6 ranges inside global unicast (2000::/3) that are not globally reachable or embed another address. */
const BLOCKED_V6: ReadonlyArray<readonly [Bytes, number]> = [
  [[0x20, 0x01, 0x00, 0x00], 23], // IETF protocol assignments (Teredo, ORCHID, benchmarking)
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x3f, 0xff], 20], // documentation
];

function isPublicV6(bytes: Bytes): boolean {
  const embedded = (from: number): boolean => isPublicV4(bytes.slice(from, from + 4));
  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64) reach the embedded IPv4 address.
  if (inRange(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return embedded(12);
  if (inRange(bytes, [0x00, 0x64, 0xff, 0x9b], 96)) return embedded(12);
  // 2002:a.b.c.d::/48 (6to4) tunnels to the embedded IPv4 address.
  if (inRange(bytes, [0x20, 0x02], 16)) return embedded(2);
  // Only global unicast is public: this drops ::, ::1, ::a.b.c.d, 100::/64, fc00::/7, fe80::/10, fec0::/10, ff00::/8.
  if (!inRange(bytes, [0x20], 3)) return false;
  return !BLOCKED_V6.some(([prefix, bits]) => inRange(bytes, prefix, bits));
}

/**
 * Whether an IP address is globally reachable. False for loopback, private, link-local (including the
 * cloud metadata address), CGNAT, multicast, reserved and documentation ranges, IPv6 unique local and
 * site-local, the IPv6 forms that embed such an IPv4 address (mapped, compatible, NAT64, 6to4), and for
 * anything that is not an IP address.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isPublicV4(v4);
  const v6 = parseIPv6(address);
  return v6 !== undefined && isPublicV6(v6);
}

/** The address policy the options select: the custom one, everything (`allowPrivate`), or public only. */
export function addressPolicy(options: AddressGuardOptions = {}): (address: string) => boolean {
  if (options.isAllowedAddress) return options.isAllowedAddress;
  if (options.allowPrivate === true) return () => true;
  return isPublicAddress;
}

/**
 * Normalise origin entries (a comma-separated string or a list; blanks dropped, duplicates removed) to
 * WHATWG origins. Throws a TypeError naming `label` when an entry is not an http(s) URL.
 */
export function normalizeOrigins(entries: string | readonly string[], label = 'allowedOrigins'): string[] {
  const list = typeof entries === 'string' ? entries.split(',') : entries;
  const out: string[] = [];
  for (const entry of list.map((e) => e.trim()).filter((e) => e !== '')) {
    let origin: string;
    try {
      const parsed = new URL(entry);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
      origin = parsed.origin;
    } catch {
      throw new TypeError(`${label}: every entry must be an http(s) origin`);
    }
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** The URL's host as an address (IPv6 brackets dropped), or undefined for a DNS name. */
function literalAddress(parsed: URL): string | undefined {
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  return isIP(host) ? host : undefined;
}

/**
 * The parsed URL when it may be fetched: http(s), no userinfo, on an allowed origin (when given), and not
 * an IP literal outside the address policy. Throws `GuardedFetchError` otherwise. A DNS name is checked
 * later, inside the socket lookup.
 */
export function checkUrl(url: string | URL, options: UrlGuardOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new GuardedFetchError('url', 'invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GuardedFetchError('protocol', 'only http and https URLs are supported');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new GuardedFetchError('credentials', 'credentials in the URL are not allowed');
  }
  if (options.allowedOrigins !== undefined && !normalizeOrigins(options.allowedOrigins).includes(parsed.origin)) {
    throw new GuardedFetchError('origin', `origin ${parsed.origin} is not allowed`);
  }
  const literal = literalAddress(parsed);
  if (literal !== undefined && !addressPolicy(options)(literal)) {
    throw new GuardedFetchError('address', PRIVATE_LITERAL, { code: ADDRESS_BLOCKED_CODE });
  }
  return parsed;
}

/** A socket lookup that refuses the name when it resolves to no address or any address fails the policy. */
export function guardedLookup(base: LookupFunction, isAllowedAddress: (address: string) => boolean): LookupFunction {
  return (hostname: string, options: LookupOptions, callback) => {
    base(hostname, { ...options, all: true }, (error, result) => {
      if (error) {
        callback(error, '', 4);
        return;
      }
      const addresses: LookupAddress[] = Array.isArray(result)
        ? result
        : [{ address: result, family: isIP(result) || 4 }];
      if (addresses.length === 0 || addresses.some((a) => !isAllowedAddress(a.address))) {
        callback(Object.assign(new Error(PRIVATE_NAME), { code: ADDRESS_BLOCKED_CODE }), '', 4);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/**
 * A fresh agent (keep-alive off) for `protocol` whose sockets resolve through `guardedLookup`. Pass it as
 * the `agent` of every `http.request` / `https.request` to a caller-supplied URL (after `checkUrl`, which
 * covers IP literals: Node never calls the lookup for them), and destroy it when the request settles.
 * It never reads the proxy environment, unlike the global agent.
 */
export function createGuardedAgent(protocol: 'http:' | 'https:', options: AddressGuardOptions = {}): HttpAgent {
  const lookup = guardedLookup(options.lookup ?? dnsLookup, addressPolicy(options));
  return protocol === 'https:'
    ? new HttpsAgent({ keepAlive: false, lookup })
    : new HttpAgent({ keepAlive: false, lookup });
}

/** Whether a socket error is (or, wrapped by multi-address connect, contains) the lookup refusal. */
function isBlocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as NodeJS.ErrnoException).code === ADDRESS_BLOCKED_CODE) return true;
  const nested = (error as { errors?: unknown }).errors;
  return Array.isArray(nested) && nested.some(isBlocked);
}

function networkError(error: unknown): GuardedFetchError {
  if (isBlocked(error)) return new GuardedFetchError('address', PRIVATE_NAME, { code: ADDRESS_BLOCKED_CODE });
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const name = typeof code === 'string' ? code : 'ERR_NETWORK';
  return new GuardedFetchError('network', `network error (${name})`, { code: name });
}

/** The reason the internal signal aborted (a timeout or the caller), as a GuardedFetchError. */
function abortReason(signal: AbortSignal): GuardedFetchError {
  return signal.reason instanceof GuardedFetchError ? signal.reason : new GuardedFetchError('aborted', 'aborted');
}

function tooLarge(maxBytes: number): GuardedFetchError {
  return new GuardedFetchError('too-large', `body exceeds ${maxBytes} bytes`);
}

interface Hop {
  res: IncomingMessage;
  agent: HttpAgent;
}

/** One request on its own guarded agent; resolves with the response head. */
function sendHop(
  url: URL,
  method: 'GET' | 'HEAD',
  headers: Record<string, string> | undefined,
  options: AddressGuardOptions,
  signal: AbortSignal,
): Promise<Hop> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const agent = createGuardedAgent(url.protocol === 'https:' ? 'https:' : 'http:', options);
  const lookup = guardedLookup(options.lookup ?? dnsLookup, addressPolicy(options));
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    let req: ClientRequest | undefined;
    const onAbort = (): void => fail(abortReason(signal));
    const fail = (error: GuardedFetchError): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      req?.destroy();
      agent.destroy();
      reject(error);
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    try {
      req = send(url, { method, agent, lookup, ...(headers ? { headers } : {}) }, (res) => {
        if (settled) {
          res.resume();
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve({ res, agent });
      });
    } catch (error) {
      fail(networkError(error));
      return;
    }
    // Stays attached for the life of the request, so a late socket error is never unhandled.
    req.on('error', (error: Error) => fail(networkError(error)));
    signal.addEventListener('abort', onAbort, { once: true });
    req.end();
  });
}

function contentTypeAllowed(essence: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    const want = entry.trim().toLowerCase();
    return want.endsWith('/*') ? essence.startsWith(want.slice(0, -1)) : essence === want;
  });
}

function toHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, item);
      } catch {
        // A header value fetch's Headers refuses is dropped, never fatal.
      }
    }
  }
  return headers;
}

/** The fetch `Response` over a guarded response head; the body keeps the size and time caps. */
function toResponse(
  hop: Hop,
  url: URL,
  redirected: boolean,
  method: 'GET' | 'HEAD',
  maxBytes: number,
  signal: AbortSignal,
  release: () => void,
): Response {
  const { res, agent } = hop;
  const status = res.statusCode ?? 0;
  let finished = false;
  let onAbort = (): void => undefined;
  const done = (): void => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', onAbort);
    release();
    agent.destroy();
  };
  let body: ReadableStream<Uint8Array> | null = null;
  if (method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
    res.resume();
    done();
  } else {
    body = new ReadableStream<Uint8Array>({
      start(controller): void {
        let size = 0;
        const fail = (error: GuardedFetchError): void => {
          if (finished) return;
          done();
          res.destroy();
          controller.error(error);
        };
        onAbort = (): void => fail(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        res.on('data', (chunk: Buffer) => {
          if (finished) return;
          size += chunk.length;
          if (size > maxBytes) fail(tooLarge(maxBytes));
          else controller.enqueue(new Uint8Array(chunk));
        });
        res.on('end', () => {
          if (finished) return;
          done();
          controller.close();
        });
        res.on('error', (error: Error) => fail(networkError(error)));
      },
      cancel(): void {
        done();
        res.destroy();
      },
    });
  }
  const response = new Response(body, { status, statusText: res.statusMessage ?? '', headers: toHeaders(res) });
  Object.defineProperty(response, 'url', { value: url.href });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
}

/** A cap option as a finite number at least `min`; a TypeError naming the option otherwise. */
function requireCap(name: string, value: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new TypeError(`guardedFetch: ${name} must be a finite number >= ${min}`);
  }
  return value;
}

/**
 * Fetch a caller- or upstream-supplied URL under the guard (see the module header). Resolves with a fetch
 * `Response` for any final status (the caller decides what a 404 means); with redirects refused every
 * 3xx is refused. Its body stays under `maxBytes` and the time cap. Rejects with `GuardedFetchError` when
 * the guard refuses or the transfer fails, and with a `TypeError` for a non-finite or negative cap.
 */
export async function guardedFetch(input: string | URL, options: GuardedFetchOptions = {}): Promise<Response> {
  const method = options.method ?? 'GET';
  const redirects = options.redirects ?? 'refuse';
  // A non-finite or negative cap would silently disable it (`hop >= NaN` is never true): refuse it.
  if (redirects !== 'refuse') requireCap('redirects', redirects, 0);
  const maxRedirects = redirects === 'refuse' ? 0 : Math.floor(redirects);
  const maxBytes = requireCap('maxBytes', options.maxBytes ?? DEFAULT_MAX_BYTES, 0);
  const timeoutMs = requireCap('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1);
  const urlOptions: UrlGuardOptions = {
    ...options,
    ...(options.allowedOrigins !== undefined ? { allowedOrigins: normalizeOrigins(options.allowedOrigins) } : {}),
  };
  let current = checkUrl(input, urlOptions);
  if (options.signal?.aborted) throw new GuardedFetchError('aborted', 'aborted');

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new GuardedFetchError('timeout', `timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  const onCallerAbort = (): void => controller.abort(new GuardedFetchError('aborted', 'aborted'));
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const release = (): void => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  };

  let headers = options.headers;
  try {
    for (let hop = 0; ; hop++) {
      const sent = await sendHop(current, method, headers, options, controller.signal);
      const { res, agent } = sent;
      const status = res.statusCode ?? 0;
      const refuse = (error: GuardedFetchError): never => {
        res.resume();
        agent.destroy();
        throw error;
      };
      const location = res.headers.location;
      // With redirects refused every 3xx is refused (as the gitlab original), with or without Location.
      if (redirects === 'refuse' && status >= 300 && status < 400) {
        refuse(new GuardedFetchError('redirect', `${status} redirect not followed`, { status }));
      }
      if (REDIRECT_STATUSES.has(status) && location) {
        if (hop >= maxRedirects)
          refuse(new GuardedFetchError('redirects', `more than ${maxRedirects} redirects`, { status }));
        let next: URL;
        try {
          next = checkUrl(new URL(location, current), urlOptions);
        } catch (error) {
          return refuse(error instanceof GuardedFetchError ? error : new GuardedFetchError('url', 'invalid URL'));
        }
        res.resume();
        agent.destroy();
        // Never carry caller headers (credentials) to another origin.
        if (next.origin !== current.origin) headers = undefined;
        current = next;
        continue;
      }
      if (status < 200 || status > 599)
        refuse(new GuardedFetchError('network', `network error (invalid status ${status})`));
      if (status < 300 && options.allowedContentTypes !== undefined) {
        const essence = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        const passes =
          essence === ''
            ? options.allowMissingContentType === true
            : contentTypeAllowed(essence, options.allowedContentTypes);
        if (!passes)
          refuse(new GuardedFetchError('content-type', `content type ${essence || '(none)'} is not allowed`));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) refuse(tooLarge(maxBytes));
      return toResponse(sent, current, hop > 0, method, maxBytes, controller.signal, release);
    }
  } catch (error) {
    release();
    throw error instanceof GuardedFetchError ? error : networkError(error);
  }
}
