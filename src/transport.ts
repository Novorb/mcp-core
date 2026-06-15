/**
 * @novorb/mcp-core — Transport
 *
 * Unified transport for MCP servers. Selects between stdio and native Streamable HTTP
 * based on the MCP_TRANSPORT environment variable.
 *
 * HTTP mode is stateless (sessionIdGenerator: undefined) — compatible with MCPize Cloud Run,
 * Apify Standby, and any other scale-to-zero host. One transport instance is created per
 * request; the server instance is resolved once and reconnected per request (SDK 1.29+).
 *
 * Usage:
 *   import { startMcpServer } from '@novorb/mcp-core/transport';
 *
 *   // Factory (recommended for HTTP — ensures clean state per request):
 *   await startMcpServer(() => createServer(services));
 *
 *   // Server instance (fine for stdio; also works for HTTP in SDK 1.29+):
 *   await startMcpServer(server);
 *
 * Environment variables:
 *   MCP_TRANSPORT        — 'stdio' (default) | 'http'
 *   PORT                 — listen port for HTTP transport (default: 8080)
 *   MCP_HTTP_HOST        — bind address for HTTP (default: '0.0.0.0' for container hosts; set
 *                          '127.0.0.1' for local-only)
 *   MCP_API_KEY          — Bearer token for HTTP auth. REQUIRED in HTTP mode unless MCP_AUTH_DISABLED.
 *   MCP_AUTH_DISABLED    — set 'true' to run HTTP WITHOUT auth (only when a gateway/platform fronts it)
 *   MCP_MAX_BODY_BYTES   — max accepted POST body size (default: 4 MiB)
 *   MCP_ALLOWED_HOSTS    — comma-separated Host allowlist; setting it enables DNS-rebinding protection
 *   MCP_ALLOWED_ORIGINS  — comma-separated Origin allowlist (also enables DNS-rebinding protection)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

/** Accepts both the high-level McpServer and the low-level Server */
type AnyMcpServer = {
  connect(transport: unknown): Promise<void>;
  close?(): Promise<void>;
};

/** A server instance or a factory that creates one per request */
type ServerOrFactory = AnyMcpServer | (() => AnyMcpServer);

export type TransportMode = 'stdio' | 'http';

export interface TransportOptions {
  /** Transport mode. Defaults to MCP_TRANSPORT env var, falling back to 'stdio'. */
  mode?: TransportMode;
  /** HTTP listen port. Defaults to PORT env var, falling back to 8080. */
  port?: number;
  /**
   * Optional Bearer token for HTTP auth. When set, all /mcp requests must include
   * `Authorization: Bearer <apiKey>`. Defaults to MCP_API_KEY env var.
   * Set to null to EXPLICITLY disable auth (equivalent to MCP_AUTH_DISABLED=true).
   */
  apiKey?: string | null;
}

function resolve(s: ServerOrFactory): AnyMcpServer {
  return typeof s === 'function' ? s() : s;
}

/** Marker error so the request handler can answer 413 rather than 500. */
class BodyTooLargeError extends Error {
  constructor() { super('Request body too large'); this.name = 'BodyTooLargeError'; }
}

/** Read the request body, rejecting (and destroying the socket) once it exceeds `maxBytes`. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        rej(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

/**
 * Constant-time comparison of the Authorization header against `Bearer <apiKey>`.
 * Both sides are SHA-256-hashed first so `timingSafeEqual` never throws on a length mismatch and the
 * token length is not itself a timing oracle.
 */
export function bearerMatches(authHeader: string, apiKey: string): boolean {
  const a = createHash('sha256').update(authHeader).digest();
  const b = createHash('sha256').update(`Bearer ${apiKey}`).digest();
  return timingSafeEqual(a, b);
}

export interface HttpAuthResolution {
  /** Whether the Bearer check is enforced on /mcp requests. */
  authEnabled: boolean;
  /** The resolved key ('' when auth is explicitly disabled). */
  apiKey: string;
}

/**
 * Resolve HTTP auth — FAIL CLOSED. `apiKey: null` (programmatic) or MCP_AUTH_DISABLED=true are the
 * only ways to run open; a missing/empty MCP_API_KEY is treated as "not configured" (not a valid
 * empty key) and THROWS, so a config typo can't silently downgrade the endpoint to no-auth.
 */
export function resolveHttpAuth(
  options: Pick<TransportOptions, 'apiKey'>,
  env: NodeJS.ProcessEnv = process.env,
): HttpAuthResolution {
  const explicitlyDisabled = options.apiKey === null || env.MCP_AUTH_DISABLED === 'true';
  const apiKey = (options.apiKey !== undefined && options.apiKey !== null)
    ? options.apiKey
    : (env.MCP_API_KEY || '');
  if (!explicitlyDisabled && apiKey.length === 0) {
    throw new Error(
      '[mcp-core] HTTP transport refused to start without auth: set MCP_API_KEY to a non-empty token, ' +
      'or set MCP_AUTH_DISABLED=true to run open (only when a gateway/platform fronts authentication).',
    );
  }
  return { authEnabled: apiKey.length > 0, apiKey };
}

/** Resolved configuration for the HTTP request handler — everything `startHttp` derives once at boot. */
export interface RequestHandlerConfig {
  /** Returns a server instance to connect for a request (fresh per request in the stateless model). */
  getServer: () => AnyMcpServer;
  /** Whether the Bearer check is enforced on /mcp requests. */
  authEnabled: boolean;
  /** The resolved Bearer key ('' when auth is disabled). */
  apiKey: string;
  /** Max accepted POST body size in bytes (→ 413 when exceeded). */
  maxBodyBytes: number;
  /** Whether to enable the SDK's DNS-rebinding (Host/Origin) protection. */
  enableDnsRebindingProtection: boolean;
  /** Host allowlist (only consulted when DNS-rebinding protection is enabled). */
  allowedHosts: string[];
  /** Origin allowlist (only consulted when DNS-rebinding protection is enabled). */
  allowedOrigins: string[];
}

/**
 * Build the `(req, res)` handler for the HTTP transport. Extracted from `startHttp` so the routing,
 * auth, content-type/size guards, and error handling are unit-testable with mock req/res — no socket
 * binding required.
 */
export function createRequestHandler(
  cfg: RequestHandlerConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const {
    getServer, authEnabled, apiKey, maxBodyBytes,
    enableDnsRebindingProtection, allowedHosts, allowedOrigins,
  } = cfg;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // Health probe — no auth required
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy' }));
        return;
      }

      // Bearer token auth (constant-time)
      if (authEnabled) {
        const auth = (req.headers['authorization'] as string | undefined) ?? '';
        if (!bearerMatches(auth, apiKey)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // MCP endpoint — stateless: new server + transport per request
      if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
        let body: unknown;
        if (req.method === 'POST') {
          // Require JSON content type (the body is parsed below).
          const contentType = ((req.headers['content-type'] as string | undefined) ?? '').toLowerCase();
          if (!contentType.includes('application/json')) {
            res.writeHead(415, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unsupported Media Type: Content-Type must be application/json' }));
            return;
          }
          let raw: string;
          try {
            raw = await readBody(req, maxBodyBytes);
          } catch (e) {
            if (e instanceof BodyTooLargeError) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Payload Too Large' }));
              return;
            }
            throw e;
          }
          if (raw.trim()) {
            try { body = JSON.parse(raw); } catch { /* let transport surface the error */ }
          }
        }

        const server = getServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless — no Mcp-Session-Id
          enableJsonResponse: true,
          ...(enableDnsRebindingProtection ? { enableDnsRebindingProtection: true, allowedHosts, allowedOrigins } : {}),
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp-core] request error: ${msg}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  };
}

/**
 * Start an MCP server with the configured transport.
 *
 * For stdio: connects once and keeps the process alive.
 * For http: starts a stateless HTTP server. GET /health is always available.
 *           Pass a factory function to get a fresh server instance per request.
 */
export async function startMcpServer(
  serverOrFactory: ServerOrFactory,
  options: TransportOptions = {},
): Promise<void> {
  const mode = options.mode ?? (process.env.MCP_TRANSPORT as TransportMode | undefined) ?? 'stdio';
  if (mode === 'stdio') {
    const server = resolve(serverOrFactory);
    await server.connect(new StdioServerTransport());
    return;
  }
  await startHttp(serverOrFactory, options);
}

async function startHttp(serverOrFactory: ServerOrFactory, options: TransportOptions): Promise<void> {
  const port = options.port ?? parseInt(process.env.PORT ?? '8080', 10);
  const host = process.env.MCP_HTTP_HOST || '0.0.0.0';
  const maxBodyBytes = Number(process.env.MCP_MAX_BODY_BYTES) || 4 * 1024 * 1024;

  // Auth resolution: FAIL CLOSED (throws when http + no key + not explicitly disabled).
  const { authEnabled, apiKey } = resolveHttpAuth(options);
  if (!authEnabled) {
    process.stderr.write(
      '[mcp-core] WARNING: HTTP transport running WITHOUT auth (MCP_AUTH_DISABLED). ' +
      'Ensure a gateway/platform fronts authentication.\n',
    );
  }

  // --- DNS-rebinding / Host+Origin protection (opt-in via allowlist envs) --------------------------
  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const enableDnsRebindingProtection = allowedHosts.length > 0 || allowedOrigins.length > 0;

  // Wrap a plain instance so getServer() always returns a callable factory
  const getServer = typeof serverOrFactory === 'function' ? serverOrFactory : () => serverOrFactory;

  const httpServer = createServer(createRequestHandler({
    getServer, authEnabled, apiKey, maxBodyBytes,
    enableDnsRebindingProtection, allowedHosts, allowedOrigins,
  }));

  await new Promise<void>((ok, fail) => {
    httpServer.listen(port, host, ok);
    httpServer.once('error', fail);
  });

  process.stderr.write(`[mcp-core] HTTP server listening on http://${host}:${port}/mcp\n`);

  // Block until signal
  await new Promise<void>(done => {
    const shutdown = (): void => {
      httpServer.close(() => done());
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}
