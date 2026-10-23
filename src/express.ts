/**
 * @novorb/mcp-core/express - mount the stateless MCP handler on an existing Express app
 *
 * For hosts that already run Express (the HQ gateway). Same handler, factory and context semantics as
 * `startMcpServer`'s HTTP mode (`createMcpHandler(factory, { legacy: 'stateless' })` through
 * `toNodeHandler`), with the same guards in the same order, built on `@modelcontextprotocol/express`:
 *
 *   /health (optional, no auth) > Bearer gate (`requireBearerAuth` over the static key or a pluggable
 *   verifier; sets `req.auth`) > Host / Origin allow-lists (`hostHeaderValidation` /
 *   `originValidation`) > 415 (media-type essence) > 413 (body cap) > 400 -32700 (parse) > dispatch.
 *
 * `express` (`^4.18 || ^5`) and `@modelcontextprotocol/express` are OPTIONAL peer dependencies: an
 * Express host installs both (the one sanctioned exception to "consumers import only from mcp-core"
 * is that the host adds these two packages). This subpath loads them lazily at import; when either is
 * missing the import fails with `ExpressAdapterUnavailableError` ("install express and
 * @modelcontextprotocol/express ..."). Nothing else in mcp-core loads them.
 *
 *   import express from 'express';
 *   import { mountMcpServer } from '@novorb/mcp-core/express';
 *   const app = express();
 *   const mcp = mountMcpServer(app, (req) => buildServer(req), { auth: { verifier: jwtVerifier } });
 *   app.listen(8080);
 *   // on shutdown: await mcp.close();
 */

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type ServerEventBus } from '@modelcontextprotocol/server';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { bearerOptions, type HttpAuthOptions } from './auth.js';
import { loadExpressPeers } from './express-peers.js';
import { processBus } from './notifications.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  isJsonRequest,
  parseList,
  resolveHttpAuth,
  type ServerFactory,
  toHostname,
  toOriginHostname,
} from './transport.js';
import { getLogger } from './utils/logger.js';

const { express, adapter } = await loadExpressPeers();
const { hostHeaderValidation, originValidation, requireBearerAuth } = adapter;

export interface McpExpressOptions {
  /** Route the MCP endpoint is served on (default `/mcp`). */
  path?: string;
  /** Serve `GET <health>` -> `{"status":"healthy"}` without auth: true = `/health` (default), false = off. */
  health?: boolean | string;
  /** Static Bearer key (default MCP_API_KEY); null runs open (like MCP_AUTH_DISABLED=true). */
  apiKey?: string | null;
  /** Bearer gate options; a `verifier` replaces the static key. */
  auth?: HttpAuthOptions;
  /** POST body cap in bytes (default MCP_MAX_BODY_BYTES, else 4 MiB). */
  maxBodyBytes?: number;
  /** Host allow-list (default MCP_ALLOWED_HOSTS). */
  allowedHosts?: string[];
  /** Origin allow-list (default MCP_ALLOWED_ORIGINS). */
  allowedOrigins?: string[];
  /** The environment the defaults are read from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /**
   * The change-event bus `subscriptions/listen` streams subscribe to (default: the process bus,
   * `processBus()`, shared with `startMcpServer`). Pass a shared implementation on multi-instance hosts.
   */
  bus?: ServerEventBus;
}

/** A router carrying the MCP endpoint, plus `close()` for the SDK handler. */
export type McpExpressRouter = Router & { close(): Promise<void> };

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  getLogger().error(`request error: ${message}`, 'mcp-core');
}

function contentTypeGuard(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST' || isJsonRequest(req)) {
      next();
      return;
    }
    res.status(415).json({ error: 'Unsupported Media Type: Content-Type must be application/json' });
  };
}

function bodyReader(maxBodyBytes: number): RequestHandler[] {
  const raw = express.raw({ type: () => true, limit: maxBodyBytes });
  return [
    (req: Request, res: Response, next: NextFunction) => {
      // A body the host already parsed (an app-level express.json()) is used as is.
      if (req.method !== 'POST' || (req.body !== undefined && !Buffer.isBuffer(req.body))) {
        next();
        return;
      }
      raw(req, res, next);
    },
    (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'POST' || !Buffer.isBuffer(req.body)) {
        next();
        return;
      }
      try {
        req.body = JSON.parse(req.body.toString('utf8')) as unknown;
        next();
      } catch {
        res
          .status(400)
          .json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null });
      }
    },
  ];
}

/** Express error middleware: 413 for the body cap, 500 (no detail) otherwise. */
function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const type = (err as { type?: unknown } | undefined)?.type;
  if (type === 'entity.too.large') {
    res.status(413).set('Connection', 'close').json({ error: 'Payload Too Large' });
    return;
  }
  reportError(err);
  res.status(500).json({ error: 'Internal server error' });
}

/** Build a router serving the MCP endpoint (and `/health`) with mcp-core's guards. Fail-closed auth. */
export function createMcpRouter(factory: ServerFactory, options: McpExpressOptions = {}): McpExpressRouter {
  const env = options.env ?? process.env;
  const { authEnabled, apiKey } = resolveHttpAuth(options, env);
  const gate = authEnabled ? bearerOptions(options.auth, apiKey || undefined) : undefined;
  const allowedHosts = options.allowedHosts ?? parseList(env.MCP_ALLOWED_HOSTS);
  const allowedOrigins = options.allowedOrigins ?? parseList(env.MCP_ALLOWED_ORIGINS);
  const maxBodyBytes = options.maxBodyBytes ?? (Number(env.MCP_MAX_BODY_BYTES) || DEFAULT_MAX_BODY_BYTES);
  const mcpPath = options.path ?? '/mcp';
  const healthPath =
    options.health === false ? undefined : typeof options.health === 'string' ? options.health : '/health';

  const mcpHandler = createMcpHandler(factory, {
    legacy: 'stateless',
    onerror: reportError,
    bus: options.bus ?? processBus(),
  });
  const nodeHandler = toNodeHandler(mcpHandler, { onerror: reportError });

  const router = express.Router();
  if (healthPath) router.get(healthPath, (_req, res) => void res.json({ status: 'healthy' }));

  const chain: RequestHandler[] = [];
  if (gate) chain.push(requireBearerAuth(gate));
  if (allowedHosts.length > 0) chain.push(hostHeaderValidation(allowedHosts.map(toHostname)));
  if (allowedOrigins.length > 0) chain.push(originValidation(allowedOrigins.map(toOriginHostname)));
  chain.push(contentTypeGuard(), ...bodyReader(maxBodyBytes));
  chain.push((req: Request, res: Response, next: NextFunction) => {
    nodeHandler(req, res, req.method === 'POST' ? (req.body as unknown) : undefined).catch(next);
  });
  router.all(mcpPath, ...chain);
  router.use(mcpPath, errorHandler);

  return Object.assign(router, { close: (): Promise<void> => mcpHandler.close() });
}

/** Mount `createMcpRouter(factory, options)` on `app`; returns the router (call `close()` on shutdown). */
export function mountMcpServer(
  app: { use(router: Router): unknown },
  factory: ServerFactory,
  options: McpExpressOptions = {},
): McpExpressRouter {
  const router = createMcpRouter(factory, options);
  app.use(router);
  return router;
}
