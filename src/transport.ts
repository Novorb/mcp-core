/**
 * @novorb/mcp-core - Transport
 *
 * Unified transport for MCP servers on SDK v2. Selects between stdio and Streamable HTTP from the
 * MCP_TRANSPORT environment variable; both legs take the SAME server factory.
 *
 * - stdio: `serveStdio(factory)` from `@modelcontextprotocol/server/stdio` (one instance per
 *   connection; the client's opening message picks the protocol era).
 * - http: `createMcpHandler(factory, { legacy: 'stateless' })` (the SDK default `responseMode: 'auto'`:
 *   one JSON body unless the handler emits progress or log notifications first, then SSE) adapted with
 *   `toNodeHandler` from `@modelcontextprotocol/node`, behind mcp-core's own `node:http` server that
 *   adds `/health`, the fail-closed Bearer gate (the SDK's `verifyBearerToken` over the static key or a
 *   pluggable verifier, `req.auth` set for the SDK), Host/Origin allow-lists and the 415/413 guards.
 *   Stateless: a fresh instance per request, 2025-era clients served by the SDK's stateless fallback.
 *
 * Usage:
 *   import { startMcpServer } from '@novorb/mcp-core/transport';
 *   await startMcpServer(() => buildServer());
 *
 * Environment variables (an explicit option wins):
 *   MCP_TRANSPORT        - 'stdio' (default) | 'http'; any other value throws
 *   PORT                 - listen port for HTTP transport (default: 8080)
 *   MCP_HTTP_HOST        - bind address for HTTP (default: '0.0.0.0'; set '127.0.0.1' for local-only)
 *   MCP_API_KEY          - Bearer token for HTTP auth. REQUIRED in HTTP mode unless MCP_AUTH_DISABLED or
 *                          a `verifier` is passed.
 *   MCP_AUTH_DISABLED    - set 'true' to run HTTP WITHOUT auth (only when a gateway/platform fronts it)
 *   MCP_MAX_BODY_BYTES   - max accepted POST body size (default: 4 MiB)
 *   MCP_ALLOWED_HOSTS    - comma-separated Host allowlist; setting it enables DNS-rebinding protection
 *   MCP_ALLOWED_ORIGINS  - comma-separated Origin allowlist (also enables DNS-rebinding protection)
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import {
  type AuthInfo,
  createMcpHandler,
  isJsonContentType,
  type McpRequestContext,
  type McpServer,
  type Server,
  type VerifyBearerTokenOptions,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { authenticate, bearerOptions, type HttpAuthOptions, writeWebResponse } from './auth.js';
import { getLogger } from './utils/logger.js';

/**
 * What the SDK hands a factory per serving unit: the protocol `era` ('modern' | 'legacy'), and on HTTP
 * the verified `authInfo` (set by the Bearer gate) and the original `requestInfo`.
 */
export type RequestContext = McpRequestContext;

/**
 * Builds a fresh server instance: once per connection on stdio, once per request on HTTP. Receives the
 * SDK's per-request context; zero-argument factories remain valid.
 */
export type ServerFactory = (ctx: RequestContext) => McpServer | Server;

/** A started transport: resolved once stdio is serving or the HTTP listener is bound. */
export interface TransportHandle {
  mode: TransportMode;
  /** http only: the bound host. */
  host?: string;
  /** http only: the bound port (the real one when 0 was requested). */
  port?: number;
  /** http only: the `/mcp` endpoint URL. */
  url?: string;
  /**
   * Resolves once the transport has ended for any reason: `close()`, or (stdio) the client closing its
   * end of the pipe (stdin end / close). `runMcpServer` uses it to dispose and exit on a stdio EOF.
   */
  closed: Promise<void>;
  /** Close the transport (SDK handler, then the listener / stdio connection). Idempotent. */
  close(): Promise<void>;
}

/** A server instance (stdio only) or a factory (stdio and HTTP). */
export type ServerOrFactory = McpServer | Server | ServerFactory;

export type TransportMode = 'stdio' | 'http';

export interface TransportOptions {
  /** Transport mode. Defaults to MCP_TRANSPORT env var, falling back to 'stdio'. */
  mode?: TransportMode;
  /** HTTP listen port. Defaults to PORT env var, falling back to 8080. */
  port?: number;
  /** HTTP bind address. Defaults to MCP_HTTP_HOST, falling back to 0.0.0.0. */
  host?: string;
  /**
   * Optional Bearer token for HTTP auth. When set, all /mcp requests must include
   * `Authorization: Bearer <apiKey>`. Defaults to MCP_API_KEY env var.
   * Set to null to EXPLICITLY disable auth (equivalent to MCP_AUTH_DISABLED=true).
   */
  apiKey?: string | null;
  /**
   * Bearer gate options: a pluggable `verifier` (replaces the static key, for example a JWT verifier),
   * `requiredScopes`, `resourceMetadataUrl`, `expectedResource`, and the API key's `AuthInfo` fields.
   */
  auth?: HttpAuthOptions;
  /** POST body cap in bytes. Defaults to MCP_MAX_BODY_BYTES, falling back to 4 MiB. */
  maxBodyBytes?: number;
  /** Host allow-list. Defaults to MCP_ALLOWED_HOSTS. */
  allowedHosts?: string[];
  /** Origin allow-list. Defaults to MCP_ALLOWED_ORIGINS. */
  allowedOrigins?: string[];
  /**
   * Install SIGINT/SIGTERM handlers that close the transport (default true). `runMcpServer` passes
   * false and owns the signals itself (close transport, dispose, exit).
   */
  handleSignals?: boolean;
}

const HTTP_FACTORY_REQUIRED =
  '[mcp-core] HTTP transport requires a server factory; one McpServer serves one connection in SDK v2';

/** Default POST body cap (the SDK's own default too). */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  getLogger().error(`request error: ${message}`, 'mcp-core');
}

/** Marker error so the request handler can answer 413 rather than 500. */
class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Read the request body, rejecting once it exceeds `maxBytes`. The rest of the body is drained and
 * discarded (never buffered) instead of destroying the socket, so the client actually receives the 413
 * the handler writes; that response carries `Connection: close`.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        rej(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

/**
 * Constant-time comparison of the Authorization header against `Bearer <apiKey>`.
 * Both sides are SHA-256-hashed first so `timingSafeEqual` never throws on a length mismatch and the
 * token length is not itself a timing oracle. (The transport itself now verifies through the SDK's
 * `verifyBearerToken` with `apiKeyVerifier`, which compares the same way.)
 */
export function bearerMatches(authHeader: string, apiKey: string): boolean {
  const a = createHash('sha256').update(authHeader).digest();
  const b = createHash('sha256').update(`Bearer ${apiKey}`).digest();
  return timingSafeEqual(a, b);
}

export interface HttpAuthResolution {
  /** Whether the Bearer check is enforced on /mcp requests. */
  authEnabled: boolean;
  /** The resolved key ('' when auth is explicitly disabled or a verifier replaces it). */
  apiKey: string;
}

/**
 * Resolve HTTP auth - FAIL CLOSED. `apiKey: null` (programmatic) or MCP_AUTH_DISABLED=true are the
 * only ways to run open; a missing/empty MCP_API_KEY is treated as "not configured" (not a valid
 * empty key) and THROWS, so a config typo can't silently downgrade the endpoint to no-auth. A passed
 * `auth.verifier` always enforces auth (it wins over every "disabled" switch).
 */
export function resolveHttpAuth(
  options: Pick<TransportOptions, 'apiKey' | 'auth'>,
  env: NodeJS.ProcessEnv = process.env,
): HttpAuthResolution {
  if (options.auth?.verifier) return { authEnabled: true, apiKey: '' };
  const explicitlyDisabled = options.apiKey === null || env.MCP_AUTH_DISABLED === 'true';
  const apiKey = options.apiKey !== undefined && options.apiKey !== null ? options.apiKey : env.MCP_API_KEY || '';
  if (!explicitlyDisabled && apiKey.length === 0) {
    throw new Error(
      '[mcp-core] HTTP transport refused to start without auth: set MCP_API_KEY to a non-empty token, ' +
        'or set MCP_AUTH_DISABLED=true to run open (only when a gateway/platform fronts authentication).',
    );
  }
  return { authEnabled: apiKey.length > 0, apiKey };
}

/** Resolved configuration for the HTTP request handler: everything `startHttp` derives once at boot. */
export interface RequestHandlerConfig {
  /** Builds a fresh server instance for each request (one instance serves one connection in SDK v2). */
  getServer: ServerFactory;
  /** Whether the Bearer check is enforced on /mcp requests (with the API key, or `auth.verifier`). */
  authEnabled: boolean;
  /** The resolved Bearer key ('' when auth is disabled or a verifier replaces it). */
  apiKey: string;
  /** Bearer gate options (verifier, scopes, resource metadata, the API key's AuthInfo fields). */
  auth?: HttpAuthOptions;
  /** Max accepted POST body size in bytes (413 when exceeded). */
  maxBodyBytes: number;
  /** Whether to enforce the Host/Origin allow-lists (DNS-rebinding protection). */
  enableDnsRebindingProtection: boolean;
  /** Host allowlist; `host` or `host:port` entries, matched port-agnostically by hostname. */
  allowedHosts: string[];
  /** Origin allowlist; full origins or bare hostnames (matched by hostname), or `<scheme>://*`. */
  allowedOrigins: string[];
}

/** The `(req, res)` listener for `node:http`, plus `close()` to tear down the SDK handler. */
export type McpRequestHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & {
  close(): Promise<void>;
};

/** `host` or `host:port` -> the bare hostname the SDK's port-agnostic Host validation compares. */
export function toHostname(entry: string): string {
  try {
    return new URL(`http://${entry}`).hostname || entry;
  } catch {
    return entry;
  }
}

/**
 * A full origin (`https://app.example.com:443`) -> its hostname; bare hostnames and `<scheme>://*`
 * entries pass unchanged. The SDK honours a lowercase `<scheme>://*` entry (for example
 * `chrome-extension://*`) as "every origin of that scheme", but never `http://*` or `https://*`.
 */
export function toOriginHostname(entry: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\/\*$/i.test(entry)) return entry;
  if (!entry.includes('://')) return toHostname(entry);
  try {
    return new URL(entry).hostname || entry;
  } catch {
    return entry;
  }
}

/** Split a comma-separated allow-list env value. */
export function parseList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isMcpPath(url: string | undefined): boolean {
  return url === '/mcp' || (url?.startsWith('/mcp?') ?? false);
}

/** `IncomingMessage` with the `auth` the SDK node adapter forwards as `authInfo`. */
export type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

/**
 * Run the Bearer gate: answers the SDK challenge (401/403 with `WWW-Authenticate`) and returns false,
 * or sets `req.auth` and returns true. With no gate configured it lets the request through.
 */
export async function runBearerGate(
  req: AuthenticatedRequest,
  res: ServerResponse,
  gate: VerifyBearerTokenOptions | undefined,
): Promise<boolean> {
  if (!gate) return true;
  const outcome = await authenticate(req.headers.authorization, gate);
  if (!outcome.ok) {
    await writeWebResponse(res, outcome.response);
    return false;
  }
  req.auth = outcome.authInfo;
  return true;
}

/** The content-type check: the SDK's media-type essence comparison (`application/json`, params allowed). */
export function isJsonRequest(req: IncomingMessage): boolean {
  const header = req.headers['content-type'];
  return typeof header === 'string' && isJsonContentType(header);
}

/**
 * Build the `(req, res)` handler for the HTTP transport. Extracted from `startHttp` so the routing,
 * auth, content-type/size guards, and error handling are unit-testable with mock req/res, no socket
 * binding required. Order: `/health`, Bearer check, path check, Host/Origin allow-lists, 415, 413,
 * then the SDK handler.
 */
export function createRequestHandler(cfg: RequestHandlerConfig): McpRequestHandler {
  const { getServer, authEnabled, apiKey, maxBodyBytes, enableDnsRebindingProtection, allowedHosts, allowedOrigins } =
    cfg;

  const mcpHandler = createMcpHandler(getServer, { legacy: 'stateless', onerror: reportError });
  const nodeHandler = toNodeHandler(mcpHandler, { onerror: reportError });
  const gate = authEnabled ? bearerOptions(cfg.auth, apiKey || undefined) : undefined;
  if (authEnabled && !gate)
    throw new Error('[mcp-core] HTTP auth is enabled but neither an API key nor a verifier is set');

  const guards: Array<(req: IncomingMessage, res: ServerResponse) => boolean> = [];
  if (enableDnsRebindingProtection && allowedHosts.length > 0) {
    guards.push(hostHeaderValidation(allowedHosts.map(toHostname)));
  }
  if (enableDnsRebindingProtection && allowedOrigins.length > 0) {
    guards.push(originValidation(allowedOrigins.map(toOriginHostname)));
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // Health probe: no auth required
      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { status: 'healthy' });
        return;
      }

      // Bearer gate (the SDK's verifyBearerToken; constant-time key compare); sets req.auth.
      if (!(await runBearerGate(req, res, gate))) return;

      if (!isMcpPath(req.url)) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      // DNS-rebinding protection: each SDK guard answers 403 itself and returns false.
      for (const guard of guards) {
        if (!guard(req, res)) return;
      }

      let body: unknown;
      if (req.method === 'POST') {
        if (!isJsonRequest(req)) {
          sendJson(res, 415, { error: 'Unsupported Media Type: Content-Type must be application/json' });
          return;
        }
        let raw: string;
        try {
          raw = await readBody(req, maxBodyBytes);
        } catch (e) {
          if (e instanceof BodyTooLargeError) {
            sendJson(res, 413, { error: 'Payload Too Large' }, { Connection: 'close' });
            return;
          }
          throw e;
        }
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error: Invalid JSON' },
            id: null,
          });
          return;
        }
      }

      await nodeHandler(req, res, body);
    } catch (err) {
      reportError(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  };

  return Object.assign(handle, { close: (): Promise<void> => mcpHandler.close() });
}

function onceAsync(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= fn();
    return pending;
  };
}

/** The transport mode from the option, else MCP_TRANSPORT, else stdio; anything else throws. */
export function resolveTransportMode(option: TransportMode | undefined, env: NodeJS.ProcessEnv = process.env) {
  const mode = option ?? (env.MCP_TRANSPORT || 'stdio');
  if (mode !== 'stdio' && mode !== 'http') {
    throw new Error(`[mcp-core] MCP_TRANSPORT must be 'stdio' or 'http' (got '${mode}')`);
  }
  return mode;
}

/**
 * Start an MCP server with the configured transport. Resolves with a `TransportHandle` once serving:
 *
 * For stdio: serves the process' stdin/stdout. An instance is accepted and wrapped as `() => instance`.
 *            With `handleSignals` (default) SIGINT/SIGTERM close the connection and re-raise the signal
 *            when no other listener remains. `closed` resolves when the client closes stdin.
 * For http:  starts a stateless HTTP server and resolves once the listener is bound (the process stays
 *            alive on the listener). With `handleSignals` (default) SIGINT/SIGTERM close it. Requires a
 *            factory (a fresh instance per request).
 */
export async function startMcpServer(
  serverOrFactory: ServerOrFactory,
  options: TransportOptions = {},
): Promise<TransportHandle> {
  const mode = resolveTransportMode(options.mode);
  const handleSignals = options.handleSignals !== false;
  if (mode === 'stdio') {
    return startStdio(typeof serverOrFactory === 'function' ? serverOrFactory : () => serverOrFactory, handleSignals);
  }
  if (typeof serverOrFactory !== 'function') {
    throw new Error(HTTP_FACTORY_REQUIRED);
  }
  return startHttp(serverOrFactory, options, handleSignals);
}

function startStdio(factory: ServerFactory, handleSignals: boolean): TransportHandle {
  const stdio = serveStdio(factory, { onerror: reportError });
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  // The SDK's stdio transport closes itself when stdin ends; mirror that so the host can dispose and
  // exit (keep-alive handles from `setup` would otherwise orphan the process).
  const onStdinEnd = (): void => {
    close().catch(reportError);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    close()
      .catch(reportError)
      .finally(() => {
        // Restore the default "signal terminates the process" unless the host app handles it itself.
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
  };
  const close = onceAsync(async () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.stdin.off('end', onStdinEnd);
    process.stdin.off('close', onStdinEnd);
    try {
      await stdio.close();
    } finally {
      markClosed();
    }
  });
  process.stdin.once('end', onStdinEnd);
  process.stdin.once('close', onStdinEnd);
  if (handleSignals) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
  return { mode: 'stdio', closed, close };
}

async function startHttp(
  factory: ServerFactory,
  options: TransportOptions,
  handleSignals: boolean,
): Promise<TransportHandle> {
  const port = options.port ?? parseInt(process.env.PORT ?? '8080', 10);
  const host = options.host || process.env.MCP_HTTP_HOST || '0.0.0.0';
  const maxBodyBytes = options.maxBodyBytes ?? (Number(process.env.MCP_MAX_BODY_BYTES) || DEFAULT_MAX_BODY_BYTES);

  // Auth resolution: FAIL CLOSED (throws when http + no key + no verifier + not explicitly disabled).
  const { authEnabled, apiKey } = resolveHttpAuth(options);
  if (!authEnabled) {
    process.stderr.write(
      '[mcp-core] WARNING: HTTP transport running WITHOUT auth (MCP_AUTH_DISABLED). ' +
        'Ensure a gateway/platform fronts authentication.\n',
    );
  }

  // DNS-rebinding / Host+Origin protection (opt-in via allowlist envs)
  const allowedHosts = options.allowedHosts ?? parseList(process.env.MCP_ALLOWED_HOSTS);
  const allowedOrigins = options.allowedOrigins ?? parseList(process.env.MCP_ALLOWED_ORIGINS);
  const enableDnsRebindingProtection = allowedHosts.length > 0 || allowedOrigins.length > 0;

  const handler = createRequestHandler({
    getServer: factory,
    authEnabled,
    apiKey,
    ...(options.auth ? { auth: options.auth } : {}),
    maxBodyBytes,
    enableDnsRebindingProtection,
    allowedHosts,
    allowedOrigins,
  });
  const httpServer = createServer(handler);

  await new Promise<void>((ok, fail) => {
    httpServer.once('error', fail);
    httpServer.listen(port, host, ok);
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${boundPort}/mcp`;
  process.stderr.write(`[mcp-core] HTTP server listening on ${url}\n`);

  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  // Close the SDK handler (aborts in-flight exchanges), then the listener.
  const shutdown = (): void => {
    close().catch(reportError);
  };
  const close = onceAsync(async () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await handler.close().catch(reportError);
    await new Promise<void>((done) => {
      httpServer.close(() => done());
      httpServer.closeAllConnections?.();
    });
    markClosed();
  });
  if (handleSignals) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
  return { mode: 'http', host, port: boundPort, url, closed, close };
}
