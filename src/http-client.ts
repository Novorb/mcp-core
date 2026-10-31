/**
 * @novorb/mcp-core - HTTP client
 *
 * One hardened HTTP client for every MCP server, built on axios with one in-house retry loop:
 * - per-request options: headers, query, timeout, signal, responseType (json/text/arraybuffer/stream),
 *   response size cap, validateStatus, retry overrides, idempotency key
 * - auth configured once: bearer, basic, custom header, query-param key, async token provider (a 401
 *   triggers one forced refresh and one replay)
 * - base URL joining that never doubles a segment; absolute URLs (next-links) are used as-is but only
 *   toward the base URL's origin or an explicitly allowed one, so credentials never leave
 * - TLS options through an ESM `node:https` Agent (custom CA, or rejectUnauthorized=false for a
 *   self-signed test instance)
 * - `mapError` hook so each service keeps its own error wording; a client-side token bucket
 * - security: maxRedirects 0, request/response size caps (streams included), errors carry only
 *   status/statusText/code/method/path (never the raw response, config or headers), secrets masked
 * - logging through the mcp-core logger only: method, host, path template, status, duration, attempt;
 *   never query values, headers, bodies or response content
 */

import { Agent as HttpsAgent } from 'node:https';
import { type Readable, Transform, type TransformCallback } from 'node:stream';
import axios, { type AxiosInstance, type AxiosResponse, type ResponseType } from 'axios';
import {
  type AuthChallenge,
  type CredentialHttpFacts,
  type CredentialRecorder,
  credentialOutcomeFromHttp,
  currentCredentialScope,
  parseAuthChallenge,
  processCredentials,
  UnknownCredentialError,
} from './credentials.js';
import { type PageIterator, type PaginateOptions, type PaginationStrategy, paginateRequests } from './pagination.js';
import { createTokenBucket, TokenBucket, type TokenBucketOptions } from './rate-limiter.js';
import {
  isIdempotentMethod,
  isRetryableError,
  parseRetryAfter,
  retryDelayFor,
  sleep,
  throwIfAborted,
} from './retry.js';
import { getLogger, type Logger } from './utils/logger.js';

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type HttpResponseType = 'json' | 'text' | 'arraybuffer' | 'stream';
export type QueryScalar = string | number | boolean;
export type QueryValue = QueryScalar | null | undefined | ReadonlyArray<QueryScalar>;
export type QueryParams = Record<string, QueryValue>;
/** How array query values are written: `a=1&a=2` (repeat), `a[]=1&a[]=2` (brackets), `a=1,2` (comma). */
export type ArrayFormat = 'repeat' | 'brackets' | 'comma';

export interface TokenProviderContext {
  /** True after a 401: the provider must bypass its cache and fetch a fresh token. */
  forceRefresh: boolean;
  signal?: AbortSignal;
}

export type HttpAuth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  /** A custom header, e.g. `PRIVATE-TOKEN` (GitLab), `X-Api-Key` (Dependency-Track), `sso-key`. */
  | { type: 'header'; name: string; value: string }
  /** Query-parameter credentials, e.g. Trello `key` + `token`; masked in every log line and error. */
  | { type: 'query'; params: Record<string, string> }
  /** An async provider (refreshing OAuth tokens, e.g. Microsoft Graph). */
  | {
      type: 'tokenProvider';
      getToken: (context: TokenProviderContext) => Promise<string>;
      /** Header name (default `Authorization`). */
      headerName?: string;
      /** Scheme prefix (default `Bearer`; empty string sends the raw token). */
      scheme?: string;
    };

export interface HttpRetryInfo {
  attempt: number;
  delayMs: number;
  fromRetryAfter: boolean;
  status?: number;
  code?: string;
  method: HttpMethod;
  path: string;
}

export interface HttpRetryPolicy {
  /** Retries after the first attempt (default 3; 0 disables). */
  retries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  /** Cap on a server-sent Retry-After (default 30000 ms). */
  maxRetryAfterMs?: number;
  /** Also replay non-idempotent methods (POST/PATCH). Off by default. */
  unsafe?: boolean;
  /** Called before each retry wait. */
  onRetry?: (info: HttpRetryInfo) => void;
  /** Random source for the jitter (tests). */
  random?: () => number;
}

export interface TlsOptions {
  /** Extra trusted CA certificate(s), PEM. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** false accepts self-signed / invalid certificates (test instances only). Default true. */
  rejectUnauthorized?: boolean;
}

/** What `mapError` receives: safe facts only, never headers, config or the raw body. */
export interface HttpErrorInfo {
  method: HttpMethod;
  host: string;
  /** Route template (`templatePath`: dynamic segments are `:id`), or the request's `logPath`. */
  path: string;
  status?: number;
  statusText?: string;
  /** Network code (`ECONNRESET`, `ETIMEDOUT`, ...), or the upstream error code, or `HTTP_<status>`. */
  code?: string;
  /** The upstream error message (masked, max 300 chars) when the body carried one. */
  upstreamMessage?: string;
  /** The upstream error code (e.g. Graph `InvalidAuthenticationToken`). */
  upstreamCode?: string;
  /** The upstream OAuth-style `error_description` (masked, max 300 chars) when it differs from the message. */
  upstreamDescription?: string;
  /** The `WWW-Authenticate` `error` / `error_description` parameters (masked), when present. */
  challenge?: AuthChallenge;
  retryAfterMs?: number;
}

export interface MappedHttpError {
  message: string;
  code?: string;
}

export interface HttpClientConfig {
  /** Base URL for relative paths (e.g. `https://gitlab.com/api/v4`). */
  baseURL: string;
  /** Default request timeout in milliseconds (default 30000). */
  timeout?: number;
  /** Default headers for every request. */
  headers?: Record<string, string>;
  /** Credentials, applied to every request. */
  auth?: HttpAuth;
  /** Default retry policy. */
  retry?: HttpRetryPolicy;
  /** TLS options (an https Agent is created only when set). */
  tls?: TlsOptions;
  /** Token bucket shared by every request of this client. */
  rateLimit?: TokenBucketOptions | TokenBucket;
  /** Response size cap in bytes (default 25 MiB), streams included. */
  maxResponseBytes?: number;
  /** Request body size cap in bytes (default 25 MiB). */
  maxRequestBytes?: number;
  /** Extra origins absolute URLs may target (credentials are sent there). The base origin is implied. */
  allowedOrigins?: string[];
  /** Header carrying a request's idempotency key (default `Idempotency-Key`). */
  idempotencyKeyHeader?: string;
  /** Array query format (default `repeat`). */
  arrayFormat?: ArrayFormat;
  /** Maps a failure to the service's own wording and code. */
  mapError?: (info: HttpErrorInfo) => MappedHttpError;
  /** Logger instance (default: the mcp-core singleton). */
  logger?: Logger;
  /** Log context (default `HttpClient`). */
  logContext?: string;
  /**
   * Where a request's `credential` outcome is recorded when no tool call is in progress (default the
   * process credential registry). Inside a `registerTools` call it always goes to that call's scope.
   */
  credentials?: CredentialRecorder;
  /**
   * Route templates relative to the base URL (`/projects/:id/repository/tags/:tag`) logged with their
   * literal words when a request path matches one; any other path logs `:id` for every segment but a
   * leading API prefix (see `templatePath`).
   */
  routes?: readonly string[];
}

export interface RequestOptions {
  method?: HttpMethod;
  /** Path joined once onto the base URL, or an absolute URL (next-link) used as-is. */
  path: string;
  query?: QueryParams;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
  /** Cancellation (e.g. the MCP handler's `ctx.signal`); also stops retries. */
  signal?: AbortSignal;
  responseType?: HttpResponseType;
  /** Response size cap override in bytes. */
  maxResponseBytes?: number;
  /** Status acceptance override (default 2xx). `() => true` returns every response. */
  validateStatus?: (status: number) => boolean;
  /** Retry overrides, or false to disable retries for this request. */
  retry?: HttpRetryPolicy | false;
  /** Sent in the idempotency header; makes a POST/PATCH replayable. */
  idempotencyKey?: string;
  /** Path to log instead of the derived template (e.g. `/projects/:id/branches`). */
  logPath?: string;
  /**
   * The key NAME of the credential this request authenticates with (for example a pool member picked
   * with `ctx.credentials.pick(...)`). Its outcome is recorded automatically: 2xx ok, 401/403 invalid,
   * an expiry signal expired, 402/429/quota degraded; anything else leaves the status alone.
   */
  credential?: string;
}

/** Per-request options of the verb helpers. */
export type RequestConfig = Omit<RequestOptions, 'method' | 'path' | 'body'>;

export interface HttpResponse<T> {
  status: number;
  statusText: string;
  /** Lower-cased header names; multi-value headers joined with `, `. */
  headers: Record<string, string>;
  data: T;
}

/** The normalized error every failure becomes. Carries no response, config or headers. */
export class HttpError extends Error {
  readonly status?: number;
  readonly statusText?: string;
  readonly code?: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly retryAfterMs?: number;
  /** The upstream OAuth `error_description` (masked), for the credential mapping. */
  readonly description?: string;
  /** The parsed `WWW-Authenticate` `error` / `error_description` (masked); never the raw header. */
  readonly challenge?: AuthChallenge;

  constructor(fields: {
    message: string;
    method: HttpMethod;
    path: string;
    status?: number;
    statusText?: string;
    code?: string;
    retryAfterMs?: number;
    description?: string;
    challenge?: AuthChallenge;
  }) {
    super(fields.message);
    this.name = 'HttpError';
    this.method = fields.method;
    this.path = fields.path;
    if (fields.status !== undefined) this.status = fields.status;
    if (fields.statusText !== undefined) this.statusText = fields.statusText;
    if (fields.code !== undefined) this.code = fields.code;
    if (fields.retryAfterMs !== undefined) this.retryAfterMs = fields.retryAfterMs;
    if (fields.description !== undefined) this.description = fields.description;
    if (fields.challenge !== undefined) this.challenge = fields.challenge;
  }
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_UPSTREAM_MESSAGE = 300;
/** Provider tokens remembered for masking (the latest ones; older tokens are expired anyway). */
const MAX_REMEMBERED_TOKENS = 8;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function isAbsoluteUrl(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

/**
 * Joins a path onto a base URL exactly once: one slash between them, nothing else touched. An absolute
 * URL is returned unchanged (an OData next-link already holds its `/v1.0` segment).
 */
export function joinUrl(baseURL: string, path: string): string {
  if (isAbsoluteUrl(path)) return path;
  const base = baseURL.replace(/\/+$/, '');
  const rest = path.replace(/^\/+/, '');
  return rest ? `${base}/${rest}` : base;
}

/** Serialises query params (null/undefined skipped) without touching an existing query string. */
export function buildQueryString(query: QueryParams | undefined, arrayFormat: ArrayFormat = 'repeat'): string {
  if (!query) return '';
  const parts: string[] = [];
  const enc = encodeURIComponent;
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const values = value as ReadonlyArray<QueryScalar>;
      if (arrayFormat === 'comma') {
        parts.push(`${enc(key)}=${values.map((v) => enc(String(v))).join(',')}`);
      } else {
        const name = arrayFormat === 'brackets' ? `${key}[]` : key;
        for (const v of values) parts.push(`${enc(name)}=${enc(String(v))}`);
      }
    } else {
      parts.push(`${enc(key)}=${enc(String(value))}`);
    }
  }
  return parts.join('&');
}

function appendQuery(url: string, queryString: string): string {
  if (!queryString) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
}

/** A fixed API word in a CONFIGURED base path: lowercase letters with `_`/`-` separators (`api`, `rest`). */
const API_WORD = /^[a-z]+(?:[_-][a-z]+)*$/;
/** An API version segment: `v4`, `v1.0`, or a bare 1-2 digit number (Trello's `/1/`). */
const API_VERSION = /^(?:v\d+(?:\.\d+)*|\d{1,2})$/;
/** The only request-path segment logged without a route template: a leading API prefix or version. */
const API_PREFIX = /^(?:api|rest|v\d+(?:\.\d+)*|\d{1,2})$/;

export interface TemplatePathOptions {
  /** The client's base URL path (`/api/v4`): its API words and versions are kept, anything else masked. */
  basePath?: string;
  /** Route templates relative to the base path (`/projects/:id/repository/tags/:tag`); a match is logged as-is. */
  routes?: readonly string[];
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

function matchRoute(segments: readonly string[], routes: readonly string[]): string | undefined {
  for (const route of routes) {
    const parts = segmentsOf(route);
    if (parts.length !== segments.length) continue;
    if (parts.every((part, i) => part.startsWith(':') || part === segments[i])) return `/${parts.join('/')}`;
  }
  return undefined;
}

/**
 * The route shape of a path for logs and errors, never a dynamic value. Fail closed: without a matching
 * route template every request-path segment becomes `:id` except a leading API prefix or version
 * (`api`, `rest`, `v4`). The configured base path keeps its API words and versions (`/api/v4`); any
 * other base segment (a token in the base URL) is masked too. A `routes` template that matches the
 * path segment for segment (`:name` matches any one segment) is logged instead, with its literal words;
 * a request's own `logPath` overrides everything.
 *
 *   templatePath('/api/v4/projects/7/repository/tags/stable', { basePath: '/api/v4' })
 *     -> '/api/v4/:id/:id/:id/:id/:id'
 *   templatePath('/api/v4/projects/7/repository/tags/stable', {
 *     basePath: '/api/v4', routes: ['/projects/:id/repository/tags/:tag'] })
 *     -> '/api/v4/projects/:id/repository/tags/:tag'
 */
export function templatePath(pathname: string, options: TemplatePathOptions = {}): string {
  const base = segmentsOf(options.basePath ?? '');
  const all = segmentsOf(pathname);
  const underBase = base.length > 0 && base.every((s, i) => all[i] === s);
  const baseOut = underBase ? base.map((s) => (API_WORD.test(s) || API_VERSION.test(s) ? s : ':id')) : [];
  const rest = underBase ? all.slice(base.length) : all;
  const prefix = baseOut.length > 0 ? `/${baseOut.join('/')}` : '';
  const routed = options.routes ? matchRoute(rest, options.routes) : undefined;
  if (routed !== undefined) return `${prefix}${routed}`;
  const masked = rest.map((s, i) => (i === 0 && API_PREFIX.test(s) ? s : ':id'));
  const tail = masked.length > 0 ? `/${masked.join('/')}` : '';
  return `${prefix}${tail}` || '/';
}

function plainHeaders(headers: unknown): Record<string, string> {
  const record = asRecord(headers);
  if (!record) return {};
  const toJSON = record.toJSON;
  const source = typeof toJSON === 'function' ? (asRecord(toJSON.call(headers)) ?? {}) : record;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) out[key.toLowerCase()] = value.map(String).join(', ');
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key.toLowerCase()] = String(value);
    }
  }
  return out;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item) ?? firstString(asRecord(item)?.message);
      if (found) return found;
    }
  }
  return undefined;
}

/** Extracts `{ message, code }` from common upstream error bodies (GitLab, Graph, Jira, Nexus, DT). */
function upstreamDetails(data: unknown, depth = 0): { message?: string; code?: string; description?: string } {
  if (depth > 2 || data === undefined || data === null) return {};
  if (Buffer.isBuffer(data)) return upstreamDetails(data.subarray(0, 4096).toString('utf8'), depth + 1);
  if (typeof data === 'string') {
    const text = data.trim();
    if (!text || text.startsWith('<')) return {};
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return upstreamDetails(JSON.parse(text) as unknown, depth + 1);
      } catch {
        // fall through to the plain text
      }
    }
    return { message: text };
  }
  const body = asRecord(data);
  if (!body) return {};
  const error = asRecord(body.error);
  const message =
    firstString(body.message) ??
    firstString(error?.message) ??
    firstString(body.error) ??
    firstString(body.errorMessages) ??
    firstString(body.errors) ??
    firstString(body.error_description) ??
    firstString(body.detail) ??
    firstString(body.title);
  const code = firstString(error?.code) ?? (typeof body.code === 'string' ? body.code : undefined);
  // OAuth-style bodies (GitLab `{ error: "invalid_token", error_description: "Token is expired" }`): the
  // message stays the `error` code, the description is kept apart for the credential mapping.
  const description = firstString(body.error_description);
  return { message, code, ...(description !== undefined && description !== message ? { description } : {}) };
}

/**
 * Caps a response stream and sanitises its errors: a source error (axios emits a raw AxiosError, whose
 * `config` holds the auth headers) is replaced by a normalized one before it reaches the consumer.
 */
function capStream(source: Readable, cap: number, makeError: (code: string, message: string) => HttpError): Readable {
  let total = 0;
  const tooLarge = (): HttpError => makeError('ERR_RESPONSE_TOO_LARGE', `Response exceeds ${cap} bytes`);
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      total += chunk.length;
      if (total > cap) callback(tooLarge());
      else callback(null, chunk);
    },
  });
  source.on('error', (err: Error) => {
    if (err.message.includes('maxContentLength')) limiter.destroy(tooLarge());
    else {
      const code = asRecord(err)?.code;
      limiter.destroy(makeError(typeof code === 'string' ? code : 'ERR_STREAM', 'Response stream failed'));
    }
  });
  limiter.on('error', () => source.destroy());
  return source.pipe(limiter);
}

function isReadable(value: unknown): value is Readable {
  const record = asRecord(value);
  return record !== undefined && typeof record.pipe === 'function' && typeof record.destroy === 'function';
}

/**
 * MCP HTTP client. Build one per upstream per process (not per MCP request), so the rate limiter and
 * the connection pool are shared.
 */
export class McpHttpClient {
  private readonly client: AxiosInstance;
  private readonly logger: Logger;
  private readonly logContext: string;
  private readonly config: HttpClientConfig;
  private readonly baseOrigin: string;
  private readonly basePath: string;
  private readonly allowedOrigins: Set<string>;
  private readonly bucket?: TokenBucket;
  private readonly staticSecrets: string[] = [];
  private readonly providerTokens = new Set<string>();

  constructor(config: HttpClientConfig) {
    this.config = config;
    this.logger = config.logger ?? getLogger();
    this.logContext = config.logContext ?? 'HttpClient';
    this.baseOrigin = new URL(config.baseURL).origin;
    this.basePath = new URL(config.baseURL).pathname;
    this.allowedOrigins = new Set([this.baseOrigin, ...(config.allowedOrigins ?? []).map((o) => new URL(o).origin)]);
    if (config.rateLimit) {
      this.bucket = config.rateLimit instanceof TokenBucket ? config.rateLimit : createTokenBucket(config.rateLimit);
    }
    this.collectSecrets(config.auth);

    const httpsAgent = config.tls
      ? new HttpsAgent({ ca: config.tls.ca, rejectUnauthorized: config.tls.rejectUnauthorized ?? true })
      : undefined;
    this.client = axios.create({
      timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
      // Never follow redirects: requests carry credentials, and a 3xx Location could harvest them.
      maxRedirects: 0,
      // Size caps (OOM/DoS guard).
      maxContentLength: config.maxResponseBytes ?? DEFAULT_MAX_BYTES,
      maxBodyLength: config.maxRequestBytes ?? DEFAULT_MAX_BYTES,
      headers: { ...config.headers },
      transitional: { clarifyTimeoutError: true, silentJSONParsing: true, forcedJSONParsing: true },
      ...(httpsAgent ? { httpsAgent } : {}),
    });
  }

  private collectSecrets(auth: HttpAuth | undefined): void {
    if (!auth) return;
    const add = (value: string): void => {
      if (value.length >= 4) this.staticSecrets.push(value);
    };
    switch (auth.type) {
      case 'bearer':
        add(auth.token);
        break;
      case 'basic':
        add(auth.password);
        add(Buffer.from(`${auth.username}:${auth.password}`).toString('base64'));
        break;
      case 'header':
        add(auth.value);
        break;
      case 'query':
        for (const value of Object.values(auth.params)) {
          add(value);
          add(encodeURIComponent(value));
        }
        break;
      case 'tokenProvider':
        break;
    }
  }

  /** Replaces every configured credential value in `text` with `[REDACTED]`. */
  maskSecrets(text: string): string {
    let out = text;
    for (const secret of [...this.staticSecrets, ...this.providerTokens]) {
      out = out.split(secret).join('[REDACTED]');
    }
    return out;
  }

  private async authHeaders(signal: AbortSignal | undefined, forceRefresh: boolean): Promise<Record<string, string>> {
    const auth = this.config.auth;
    if (!auth) return {};
    switch (auth.type) {
      case 'bearer':
        return { Authorization: `Bearer ${auth.token}` };
      case 'basic':
        return {
          Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
        };
      case 'header':
        return { [auth.name]: auth.value };
      case 'tokenProvider': {
        const token = await auth.getToken({ forceRefresh, signal });
        if (token.length >= 4) {
          // Keep only the most recent tokens (a refreshing provider must not grow this for ever).
          this.providerTokens.delete(token);
          this.providerTokens.add(token);
          while (this.providerTokens.size > MAX_REMEMBERED_TOKENS) {
            const oldest = this.providerTokens.values().next().value;
            if (oldest === undefined) break;
            this.providerTokens.delete(oldest);
          }
        }
        const scheme = auth.scheme ?? 'Bearer';
        return { [auth.headerName ?? 'Authorization']: scheme ? `${scheme} ${token}` : token };
      }
      case 'query':
        return {};
    }
  }

  private resolve(req: RequestOptions, method: HttpMethod): { url: string; host: string; path: string } {
    const joined = joinUrl(this.config.baseURL, req.path);
    let parsed: URL;
    try {
      parsed = new URL(joined);
    } catch {
      throw new HttpError({ message: 'Invalid request URL', method, path: '', code: 'ERR_INVALID_URL' });
    }
    const path =
      req.logPath ?? templatePath(parsed.pathname, { basePath: this.basePath, routes: this.config.routes ?? [] });
    if (!/^https?:$/.test(parsed.protocol) || !this.allowedOrigins.has(parsed.origin)) {
      throw new HttpError({
        message: `Refusing to send credentials to a non-allowed origin (${parsed.host})`,
        method,
        path,
        code: 'ERR_ORIGIN_NOT_ALLOWED',
      });
    }
    const auth = this.config.auth;
    const query: QueryParams = { ...req.query, ...(auth?.type === 'query' ? auth.params : {}) };
    return { url: appendQuery(joined, buildQueryString(query, this.config.arrayFormat)), host: parsed.host, path };
  }

  private errorInfo(error: unknown, method: HttpMethod, host: string, path: string): HttpErrorInfo {
    const err = asRecord(error) ?? {};
    const response = asRecord(err.response);
    const status = typeof response?.status === 'number' ? response.status : undefined;
    const statusText =
      typeof response?.statusText === 'string' && response.statusText ? response.statusText : undefined;
    const info: HttpErrorInfo = { method, host, path };
    if (status !== undefined) {
      info.status = status;
      if (statusText) info.statusText = statusText;
      const headers = plainHeaders(response?.headers);
      const retryAfterMs = parseRetryAfter(headers['retry-after']);
      if (retryAfterMs !== undefined) info.retryAfterMs = retryAfterMs;
      const details = isReadable(response?.data) ? {} : upstreamDetails(response?.data);
      if (details.message) info.upstreamMessage = this.maskSecrets(details.message).slice(0, MAX_UPSTREAM_MESSAGE);
      if (details.code) info.upstreamCode = details.code;
      if (details.description) {
        info.upstreamDescription = this.maskSecrets(details.description).slice(0, MAX_UPSTREAM_MESSAGE);
      }
      const parsed = parseAuthChallenge(headers['www-authenticate']);
      const challenge: AuthChallenge = {};
      if (parsed.error) challenge.error = this.maskSecrets(parsed.error).slice(0, MAX_UPSTREAM_MESSAGE);
      if (parsed.description)
        challenge.description = this.maskSecrets(parsed.description).slice(0, MAX_UPSTREAM_MESSAGE);
      if (challenge.error !== undefined || challenge.description !== undefined) info.challenge = challenge;
      info.code = details.code ?? `HTTP_${status}`;
    } else {
      const message = typeof err.message === 'string' ? err.message : '';
      info.code = message.includes('maxContentLength')
        ? 'ERR_RESPONSE_TOO_LARGE'
        : message.includes('maxBodyLength')
          ? 'ERR_REQUEST_TOO_LARGE'
          : typeof err.code === 'string'
            ? err.code
            : 'ERR_NETWORK';
    }
    return info;
  }

  private toHttpError(info: HttpErrorInfo): HttpError {
    const fallback = info.upstreamMessage
      ? info.upstreamMessage
      : info.status !== undefined
        ? `HTTP ${info.status}${info.statusText ? ` ${info.statusText}` : ''}`
        : `Network error (${info.code})`;
    const mapped = this.config.mapError?.(info);
    return new HttpError({
      message: this.maskSecrets(mapped?.message ?? fallback),
      method: info.method,
      path: info.path,
      status: info.status,
      statusText: info.statusText,
      code: mapped?.code ?? info.code,
      retryAfterMs: info.retryAfterMs,
      ...(info.upstreamDescription !== undefined ? { description: info.upstreamDescription } : {}),
      ...(info.challenge !== undefined ? { challenge: info.challenge } : {}),
    });
  }

  /**
   * Where a request's `credential` outcome goes: the current tool call's scope, else the configured
   * recorder, else the process registry. The name must be declared there (`UnknownCredentialError`
   * otherwise, before anything is sent: a value passed by mistake is never published).
   */
  private credentialRecorder(key: string): CredentialRecorder {
    const recorder = currentCredentialScope() ?? this.config.credentials ?? processCredentials();
    if (!recorder.has(key)) throw new UnknownCredentialError();
    return recorder;
  }

  private recordCredential(
    req: RequestOptions,
    recorder: CredentialRecorder | undefined,
    facts: CredentialHttpFacts,
  ): void {
    if (req.credential === undefined || recorder === undefined) return;
    const { outcome, ...info } = credentialOutcomeFromHttp(facts);
    recorder.record(req.credential, outcome, info);
  }

  /** Performs a request and returns status, headers and data. */
  async requestRaw<T = unknown>(req: RequestOptions): Promise<HttpResponse<T>> {
    const method: HttpMethod = req.method ?? 'GET';
    const { url, host, path } = this.resolve(req, method);
    const recorder = req.credential !== undefined ? this.credentialRecorder(req.credential) : undefined;
    const policy: HttpRetryPolicy = req.retry === false ? { retries: 0 } : { ...this.config.retry, ...req.retry };
    const retries = Math.max(0, policy.retries ?? 3);
    const replayable = isIdempotentMethod(method) || req.idempotencyKey !== undefined || policy.unsafe === true;
    const maxBytes = req.maxResponseBytes ?? this.config.maxResponseBytes ?? DEFAULT_MAX_BYTES;
    const responseType: ResponseType = req.responseType ?? 'json';
    let forceRefresh = false;
    let refreshed = false;

    for (let attempt = 0; ; ) {
      throwIfAborted(req.signal);
      await this.bucket?.acquire(req.signal);
      let auth: Record<string, string>;
      try {
        auth = await this.authHeaders(req.signal, forceRefresh);
      } catch (error) {
        throwIfAborted(req.signal);
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(`HTTP ${method} ${host}${path} token provider failed`, this.logContext, {
          method,
          host,
          path,
          code: 'ERR_TOKEN_PROVIDER',
          attempt,
        });
        throw new HttpError({
          message: this.maskSecrets(`Token provider failed: ${detail}`).slice(0, MAX_UPSTREAM_MESSAGE),
          method,
          path,
          code: 'ERR_TOKEN_PROVIDER',
        });
      }
      const headers: Record<string, string> = { ...req.headers, ...auth };
      if (req.idempotencyKey !== undefined) {
        headers[this.config.idempotencyKeyHeader ?? 'Idempotency-Key'] = req.idempotencyKey;
      }
      const started = Date.now();
      try {
        const response: AxiosResponse<unknown> = await this.client.request<unknown>({
          method,
          url,
          data: req.body,
          headers,
          timeout: req.timeout,
          signal: req.signal,
          responseType,
          maxContentLength: maxBytes,
          ...(req.validateStatus ? { validateStatus: req.validateStatus } : {}),
        });
        const durationMs = Date.now() - started;
        this.logger.debug(`HTTP ${method} ${host}${path} ${response.status}`, this.logContext, {
          method,
          host,
          path,
          status: response.status,
          durationMs,
          attempt,
        });
        const plain = plainHeaders(response.headers);
        if (req.credential !== undefined) {
          const facts: CredentialHttpFacts = { status: response.status };
          if (response.status >= 400) {
            const details = isReadable(response.data) ? {} : upstreamDetails(response.data);
            if (details.code) facts.code = details.code;
            if (details.message) facts.message = this.maskSecrets(details.message);
            if (details.description) facts.description = this.maskSecrets(details.description);
            const retryAfterMs = parseRetryAfter(plain['retry-after']);
            if (retryAfterMs !== undefined) facts.retryAfterMs = retryAfterMs;
            if (plain['www-authenticate']) facts.authenticate = plain['www-authenticate'];
          }
          this.recordCredential(req, recorder, facts);
        }
        let data: unknown = response.data;
        if (responseType === 'stream' && isReadable(data)) {
          const declared = Number(plain['content-length']);
          const streamError = (code: string, message: string): HttpError =>
            new HttpError({ message, method, path, code });
          if (Number.isFinite(declared) && declared > maxBytes) {
            data.destroy();
            throw streamError('ERR_RESPONSE_TOO_LARGE', `Response exceeds ${maxBytes} bytes`);
          }
          data = capStream(data, maxBytes, streamError);
        }
        return { status: response.status, statusText: response.statusText ?? '', headers: plain, data: data as T };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const durationMs = Date.now() - started;
        const response = asRecord(asRecord(error)?.response);
        if (isReadable(response?.data)) response.data.destroy();
        throwIfAborted(req.signal);
        const info = this.errorInfo(error, method, host, path);
        if (info.status === 401 && this.config.auth?.type === 'tokenProvider' && !refreshed) {
          refreshed = true;
          forceRefresh = true;
          this.logger.warn(`HTTP ${method} ${host}${path} 401, refreshing token`, this.logContext, {
            method,
            host,
            path,
            status: 401,
            durationMs,
            attempt,
          });
          continue;
        }
        if (replayable && attempt < retries && isRetryableError(error)) {
          const { delayMs, fromRetryAfter } = retryDelayFor(
            info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {},
            attempt,
            {
              initialDelayMs: policy.initialDelayMs,
              maxDelayMs: policy.maxDelayMs,
              backoffMultiplier: policy.backoffMultiplier,
              maxRetryAfterMs: policy.maxRetryAfterMs,
              random: policy.random,
            },
          );
          this.logger.warn(`HTTP ${method} ${host}${path} retrying`, this.logContext, {
            method,
            host,
            path,
            status: info.status,
            code: info.code,
            durationMs,
            attempt,
            delayMs,
          });
          policy.onRetry?.({ attempt, delayMs, fromRetryAfter, status: info.status, code: info.code, method, path });
          await sleep(delayMs, req.signal);
          attempt++;
          continue;
        }
        const meta = { method, host, path, status: info.status, code: info.code, durationMs, attempt };
        const line = `HTTP ${method} ${host}${path} failed`;
        if (info.status === undefined || info.status >= 500) this.logger.error(line, this.logContext, meta);
        else this.logger.warn(line, this.logContext, meta);
        // The same facts the thrown HttpError carries, so a later re-classification agrees.
        this.recordCredential(req, recorder, {
          challenge: info.challenge ?? {},
          ...(info.status !== undefined ? { status: info.status } : {}),
          ...(info.upstreamCode !== undefined ? { code: info.upstreamCode } : {}),
          ...(info.upstreamMessage !== undefined ? { message: info.upstreamMessage } : {}),
          ...(info.upstreamDescription !== undefined ? { description: info.upstreamDescription } : {}),
          ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}),
        });
        throw this.toHttpError(info);
      }
    }
  }

  /** Performs a request and returns the response data. */
  async request<T = unknown>(req: RequestOptions): Promise<T> {
    return (await this.requestRaw<T>(req)).data;
  }

  async get<T = unknown>(path: string, config: RequestConfig = {}): Promise<T> {
    return this.request<T>({ ...config, method: 'GET', path });
  }

  /** HEAD request; returns the response headers (lower-cased). */
  async head(path: string, config: RequestConfig = {}): Promise<Record<string, string>> {
    return (await this.requestRaw<unknown>({ ...config, method: 'HEAD', path })).headers;
  }

  async post<T = unknown>(path: string, body?: unknown, config: RequestConfig = {}): Promise<T> {
    return this.request<T>({ ...config, method: 'POST', path, body });
  }

  async put<T = unknown>(path: string, body?: unknown, config: RequestConfig = {}): Promise<T> {
    return this.request<T>({ ...config, method: 'PUT', path, body });
  }

  async patch<T = unknown>(path: string, body?: unknown, config: RequestConfig = {}): Promise<T> {
    return this.request<T>({ ...config, method: 'PATCH', path, body });
  }

  async delete<T = unknown>(path: string, config: RequestConfig = {}): Promise<T> {
    return this.request<T>({ ...config, method: 'DELETE', path });
  }

  /**
   * Walks an upstream API's pages with a strategy (see `pagination`). Returns an async iterator of
   * pages plus `items()` and `collect()`; capped by `maxPages` (default 100) and `maxItems`.
   */
  paginate<T>(
    request: RequestOptions,
    strategy: PaginationStrategy<T>,
    options: PaginateOptions = {},
  ): PageIterator<T> {
    return paginateRequests<T>((req) => this.requestRaw<unknown>(req), request, strategy, options);
  }

  /** The underlying axios instance for advanced use cases (bypasses retry, auth and logging). */
  getAxiosInstance(): AxiosInstance {
    return this.client;
  }
}

/**
 * Create a configured HTTP client.
 */
export function createHttpClient(config: HttpClientConfig): McpHttpClient {
  return new McpHttpClient(config);
}

export { createTokenBucket, TokenBucket, type TokenBucketOptions } from './rate-limiter.js';
