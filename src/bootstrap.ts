/**
 * @novorb/mcp-core - Bootstrap
 *
 * `runMcpServer` is the one entry point shape for every MCP server:
 *
 *   1. logger init (name, rootDir)
 *   2. env load (`loadEnv(schema)`, then the logger is reconfigured so LOG_* from the env file apply)
 *   3. `setup` ONCE per process: clients, caches, DB handles, rate limiters (the shared state)
 *   4. transport start: `create(shared, req)` builds a server per connection (stdio) / per request (HTTP)
 *   5. ONE "started" line (transport, version, http url) after the listener is bound
 *
 * Signals are owned here: SIGINT/SIGTERM close the transport, then `dispose(shared)`, then exit 0.
 * Consumers install no handlers of their own. Name and version come from `<rootDir>/package.json`.
 *
 *   await runMcpServer({
 *     rootDir: packageRootFrom(import.meta.url),
 *     env: ENV_SCHEMA,
 *     setup: ({ env }) => ({ client: new ApiClient(env.get('API_URL')) }),
 *     create: (shared, req, { env, info }) => {
 *       const server = createMcpServer(info.name, info.version);
 *       registerTools(server, buildTools(shared), { env, serverName: info.name });
 *       return server;
 *     },
 *   });
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Implementation } from '@modelcontextprotocol/server';
import { type CreateMcpServerOptions, createMcpServer, type McpServer, type Server } from './server.js';
import {
  parseList,
  type RequestContext,
  resolveTransportMode,
  startMcpServer,
  type TransportHandle,
  type TransportMode,
  type TransportOptions,
} from './transport.js';
import { type EnvSchema, type LoadedEnv, loadEnv } from './utils/envLoader.js';
import { getLogger, initLogger, type Logger, type LoggerOptions } from './utils/logger.js';

export interface PackageInfo {
  name: string;
  version: string;
  description?: string;
}

/** Read name, version and description from `<rootDir>/package.json`. Throws when it is missing or invalid. */
export function readPackageInfo(rootDir: string): PackageInfo {
  const file = path.join(rootDir, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`readPackageInfo: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const pkg = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (typeof pkg.name !== 'string' || pkg.name === '' || typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`readPackageInfo: ${file} has no name or version`);
  }
  const info: PackageInfo = { name: pkg.name, version: pkg.version };
  if (typeof pkg.description === 'string') info.description = pkg.description;
  return info;
}

/** What `setup` and `create` receive. */
export interface SetupContext {
  env: LoadedEnv;
  logger: Logger;
  info: PackageInfo;
  rootDir: string;
  /**
   * A fresh `McpServer` for this server: `createMcpServer` with the package identity (`name`,
   * `version`, `description`) plus `RunMcpServerOptions.server` (Implementation fields and
   * `McpServerOptions`). Call it once per `create`.
   */
  createServer(): McpServer;
}

/** Server identity and options `runMcpServer` passes to every `createServer()`. */
export interface RunServerOptions extends CreateMcpServerOptions {
  /** Implementation fields beyond name/version/description. */
  title?: string;
  websiteUrl?: string;
  icons?: Implementation['icons'];
}

export interface RunMcpServerOptions<S> {
  /** The server's package root: `packageRootFrom(import.meta.url)`. */
  rootDir: string;
  /** The server's own env schema (mcp-core's keys are merged in). */
  env: EnvSchema;
  /** Overrides package.json `name` (used for the logger and the started line). */
  name?: string;
  /** Overrides package.json `version`. */
  version?: string;
  /** Once per process: build the shared state (clients, caches, DB handles, rate limiters). */
  setup?: (ctx: SetupContext) => Promise<S> | S;
  /** Per connection (stdio) / per HTTP request: build a server over the shared state. */
  create: (shared: S, req: RequestContext, ctx: SetupContext) => McpServer | Server;
  /** On shutdown, after the transport is closed: release the shared state. */
  dispose?: (shared: S) => Promise<void> | void;
  /** Log uncaught exceptions / unhandled rejections, then exit 1 (default false). */
  captureProcessErrors?: boolean;
  /** Extra logger options (name and rootDir are set by runMcpServer). */
  logger?: Omit<LoggerOptions, 'name' | 'rootDir' | 'captureProcessErrors'>;
  /** Server identity and `McpServerOptions` for `ctx.createServer()`. */
  server?: RunServerOptions;
  /**
   * Transport overrides; otherwise from the loaded env (MCP_TRANSPORT, PORT, MCP_HTTP_HOST,
   * MCP_MAX_BODY_BYTES, MCP_ALLOWED_HOSTS, MCP_ALLOWED_ORIGINS, MCP_API_KEY). `auth.verifier` plugs a
   * token verifier (for example JWTs) in place of the static key.
   */
  transport?: Omit<TransportOptions, 'handleSignals'>;
  /** Throw on env validation errors instead of logging them (default false). */
  strictEnv?: boolean;
  /** Install SIGINT/SIGTERM handlers (default true). */
  handleSignals?: boolean;
  /** The environment to read and populate (default `process.env`). */
  processEnv?: NodeJS.ProcessEnv;
}

export interface RunningServer<S> {
  info: PackageInfo;
  env: LoadedEnv;
  shared: S;
  mode: TransportMode;
  /** http only. */
  host?: string;
  port?: number;
  url?: string;
  /** Close the transport, then dispose the shared state. Idempotent; does not exit the process. */
  close(): Promise<void>;
}

/** The logger file name for a package name: the npm scope is dropped (`@scope/x-mcp` -> `x-mcp`). */
function loggerName(name: string): string {
  return name.replace(/^@[^/]+\//, '');
}

/**
 * The transport options from the LOADED env (so `processEnv` and the env file reach the transport, and
 * an invalid MCP_TRANSPORT throws), with explicit `overrides` winning.
 */
export function transportFromEnv(
  env: LoadedEnv,
  overrides: Omit<TransportOptions, 'handleSignals'> = {},
): Omit<TransportOptions, 'handleSignals'> {
  const mode: TransportMode = resolveTransportMode(
    overrides.mode ?? (env.get('MCP_TRANSPORT') as TransportMode | undefined),
  );
  const out: Omit<TransportOptions, 'handleSignals'> = { ...overrides, mode };
  const port = env.int('PORT');
  if (out.port === undefined && port !== undefined) out.port = port;
  const host = env.get('MCP_HTTP_HOST');
  if (out.host === undefined && host !== undefined) out.host = host;
  const maxBody = env.int('MCP_MAX_BODY_BYTES');
  if (out.maxBodyBytes === undefined && maxBody !== undefined) out.maxBodyBytes = maxBody;
  out.allowedHosts ??= parseList(env.get('MCP_ALLOWED_HOSTS'));
  out.allowedOrigins ??= parseList(env.get('MCP_ALLOWED_ORIGINS'));
  if (out.apiKey === undefined && !out.auth?.verifier) {
    out.apiKey = env.bool('MCP_AUTH_DISABLED') === true ? null : (env.get('MCP_API_KEY') ?? '');
  }
  return out;
}

/** Bootstrap an MCP server: logger, env, shared state, transport, started line, signals. */
export async function runMcpServer<S = undefined>(opts: RunMcpServerOptions<S>): Promise<RunningServer<S>> {
  const rootDir = path.resolve(opts.rootDir);
  const pkg = opts.name !== undefined && opts.version !== undefined ? undefined : readPackageInfo(rootDir);
  const info: PackageInfo = {
    ...(pkg ?? {}),
    name: opts.name ?? pkg?.name ?? 'mcp-server',
    version: opts.version ?? pkg?.version ?? '0.0.0',
  };
  const loggerOptions: LoggerOptions = {
    ...opts.logger,
    name: loggerName(info.name),
    rootDir,
    captureProcessErrors: opts.captureProcessErrors === true,
  };

  // 1. logger, so env-loading warnings are logged; 2. env; then reconfigure for LOG_* from the file.
  initLogger(loggerOptions);
  const env = loadEnv(opts.env, { rootDir, env: opts.processEnv ?? process.env, strict: opts.strictEnv === true });
  const logger = initLogger(loggerOptions);
  for (const e of env.errors) logger.warn(`env ${e.key} ${e.message}`, 'Env');

  const serverOptions = opts.server ?? {};
  const ctx: SetupContext = {
    env,
    logger,
    info,
    rootDir,
    createServer: () => {
      const { title, websiteUrl, icons, ...mcpOptions } = serverOptions;
      return createMcpServer(
        {
          name: info.name,
          version: info.version,
          ...(info.description !== undefined ? { description: info.description } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(websiteUrl !== undefined ? { websiteUrl } : {}),
          ...(icons !== undefined ? { icons } : {}),
        },
        mcpOptions,
      );
    },
  };
  const transportOptions = transportFromEnv(env, opts.transport);
  const shared = (opts.setup ? await opts.setup(ctx) : undefined) as S;

  let transport: TransportHandle;
  try {
    transport = await startMcpServer((req: RequestContext) => opts.create(shared, req, ctx), {
      ...transportOptions,
      handleSignals: false,
    });
  } catch (err) {
    await Promise.resolve(opts.dispose?.(shared)).catch(() => undefined);
    throw err;
  }

  let closing: Promise<void> | undefined;
  const shutdownAndExit = (reason: string): void => {
    getLogger().info(`${info.name} stopping (${reason})`, 'Server');
    let code = 0;
    close()
      .catch((e: unknown) => {
        code = 1;
        getLogger().error(`shutdown failed: ${e instanceof Error ? e.message : String(e)}`, 'Server');
      })
      .finally(() => process.exit(code));
  };
  const onSignal = (signal: NodeJS.Signals): void => shutdownAndExit(signal);
  // The client closed the connection (stdio EOF): dispose the shared state and exit, so keep-alive
  // handles created in `setup` (timers, pools, watchers) never orphan the process.
  transport.closed.then(() => {
    if (closing) return;
    if (opts.handleSignals === false) {
      getLogger().info(`${info.name} stopping (transport closed)`, 'Server');
      close().catch((e: unknown) =>
        getLogger().error(`shutdown failed: ${e instanceof Error ? e.message : String(e)}`, 'Server'),
      );
      return;
    }
    shutdownAndExit('transport closed');
  });
  const close = (): Promise<void> => {
    closing ??= (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      try {
        await transport.close();
      } finally {
        await opts.dispose?.(shared);
      }
    })();
    return closing;
  };
  if (opts.handleSignals !== false) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  const meta: Record<string, unknown> = { version: info.version, transport: transport.mode };
  if (transport.url) Object.assign(meta, { host: transport.host, port: transport.port, url: transport.url });
  logger.info(`${info.name} started`, 'Server', meta);

  return {
    info,
    env,
    shared,
    mode: transport.mode,
    ...(transport.host !== undefined ? { host: transport.host } : {}),
    ...(transport.port !== undefined ? { port: transport.port } : {}),
    ...(transport.url !== undefined ? { url: transport.url } : {}),
    close,
  };
}
