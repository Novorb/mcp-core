/**
 * @novorb/mcp-core/testing - start a BUILT MCP server as a child process and connect a v2 client.
 *
 * stdio: the SDK `StdioClientTransport` spawns `node <entry>` and speaks over its stdin/stdout.
 * http:  the harness spawns `node <entry>` with MCP_TRANSPORT=http on a free loopback port, polls
 *        `GET /health` until it answers 200, then connects `StreamableHTTPClientTransport` with the
 *        Bearer header.
 *
 * The child env is EXPLICIT: the minimal OS variables node needs (the SDK's DEFAULT_INHERITED_ENV_VARS
 * list), the caller's `env`, and the harness variables. The parent's own environment (a developer's
 * secrets, a dotenv-loaded `.env`) never reaches the child unless `inheritEnv: true`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import type { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createTestClient, type TestClientOptions } from './client.js';

export type HarnessMode = 'stdio' | 'http';

export interface StartBuiltServerOptions extends TestClientOptions {
  /** Path of the server entry, e.g. `<repo>/dist/index.js`. Run as `node [nodeArgs] <entry>`. */
  entry: string;
  /** Transport to start the server in. */
  mode: HarnessMode;
  /** Variables for the child. Merged over the minimal OS set; the harness variables win over these. */
  env?: Record<string, string>;
  /** Working directory of the child (default: the parent's cwd). Use an isolated temp dir in tests. */
  cwd?: string;
  /**
   * http only: the Bearer key. A string sets MCP_API_KEY to it; `null` starts the server open
   * (MCP_AUTH_DISABLED=true, no Authorization header). Omitted: `env.MCP_API_KEY` when given, else a
   * random 32-byte hex key.
   */
  apiKey?: string | null;
  /** How long to wait for readiness: http `/health` polling and the client connect (default 20000). */
  readyTimeoutMs?: number;
  /** Pass the parent's full environment through (default false: explicit env only). */
  inheritEnv?: boolean;
  /** Extra node arguments before the entry, e.g. `['--import', 'tsx']` to run a `.ts` entry. */
  nodeArgs?: string[];
  /** http only: the listen port (default: a free loopback port). */
  port?: number;
  /**
   * Sets MCP_ENV_FILE for the child: the env-file override honoured by a server that loads its env
   * through mcp-core's env loader (point it at an empty file, or at the loader's documented "none"
   * value, so a developer `.env` cannot fill gaps). Equivalent to `env.MCP_ENV_FILE`; this wins.
   */
  envFile?: string;
}

export interface BuiltServer {
  /** A connected v2 client. */
  client: Client;
  mode: HarnessMode;
  /** http only: the `/mcp` endpoint URL. */
  url?: string;
  /** http only: the server base URL (`http://127.0.0.1:<port>`), for `/health` and raw requests. */
  baseUrl?: string;
  /** http only: the Bearer key in use (undefined when started open). Never log it. */
  apiKey?: string;
  /** The exact environment the child was started with (useful as `findLeaks` needles). */
  env: Readonly<Record<string, string>>;
  /** The child pid, when known. */
  pid?: number;
  /** Everything the child wrote to stderr so far. */
  stderr(): string;
  /** http only: everything the child wrote to stdout so far (stdio mode: always ''). */
  stdout(): string;
  /** Close the client and kill the child, awaiting its exit. Idempotent; never throws. */
  stop(): Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 50;
const EXIT_GRACE_MS = 5_000;

/** The minimal OS variables node needs to run, read from the parent (only those that are set). */
export function minimalOsEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = source[key];
    if (value !== undefined && !value.startsWith('()')) out[key] = value;
  }
  return out;
}

function stringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined) out[k] = v;
  return out;
}

/** A free TCP port on 127.0.0.1 (bound and released; a small reuse race is possible but rare). */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createNetServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? ok(port) : fail(new Error('freePort: no port assigned'))));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tail(text: string, max = 4000): string {
  return text.length > max ? `...${text.slice(-max)}` : text;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Kill a child and await its exit (SIGTERM, then SIGKILL after a grace period). Windows-safe. */
export async function killAndWait(child: ChildProcess, graceMs = EXIT_GRACE_MS): Promise<void> {
  if (hasExited(child)) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  // On Windows `kill()` maps to TerminateProcess regardless of the signal; on POSIX SIGTERM lets the
  // server's own shutdown path run first.
  child.kill('SIGTERM');
  const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), graceMs).unref());
  if ((await Promise.race([exited.then(() => 'exited' as const), timer])) === 'timeout' && !hasExited(child)) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs: number,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    if (hasExited(child)) {
      throw new Error(
        `startBuiltServer: server exited (code ${child.exitCode ?? child.signalCode}) before /health was ready.\n` +
          `stderr:\n${tail(stderr())}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.status === 200) return;
      lastError = `status ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `startBuiltServer: /health not ready within ${timeoutMs} ms (${lastError}).\nstderr:\n${tail(stderr())}`,
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= fn();
    return pending;
  };
}

/** Start a built server in stdio or http mode and return a connected v2 client plus teardown. */
export async function startBuiltServer(options: StartBuiltServerOptions): Promise<BuiltServer> {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const base = options.inheritEnv ? stringEnv(process.env) : minimalOsEnv();
  const callerEnv: Record<string, string> = { ...options.env };
  if (options.envFile !== undefined) callerEnv.MCP_ENV_FILE = options.envFile;
  const opts: StartBuiltServerOptions = { ...options, env: callerEnv };
  const args = [...(options.nodeArgs ?? []), options.entry];
  return options.mode === 'stdio'
    ? startStdio(opts, { ...base, ...callerEnv, MCP_TRANSPORT: 'stdio' }, args, readyTimeoutMs)
    : startHttp(opts, base, args, readyTimeoutMs);
}

async function startStdio(
  options: StartBuiltServerOptions,
  env: Record<string, string>,
  args: string[],
  readyTimeoutMs: number,
): Promise<BuiltServer> {
  let stderrText = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env,
    cwd: options.cwd,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderrText += chunk.toString();
  });
  const client = createTestClient(options);
  const stop = once(async () => {
    // client.close() closes the transport, which ends stdin, then SIGTERM, then SIGKILL, awaiting exit.
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  });
  try {
    await withTimeout(client.connect(transport), readyTimeoutMs, 'startBuiltServer: stdio connect');
  } catch (e) {
    await stop();
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`startBuiltServer: stdio connect failed: ${message}\nstderr:\n${tail(stderrText)}`);
  }
  return {
    client,
    mode: 'stdio',
    env,
    pid: transport.pid ?? undefined,
    stderr: () => stderrText,
    stdout: () => '',
    stop,
  };
}

function resolveApiKey(options: StartBuiltServerOptions): string | undefined {
  if (options.apiKey === null) return undefined;
  if (typeof options.apiKey === 'string') return options.apiKey;
  return options.env?.MCP_API_KEY || randomBytes(32).toString('hex');
}

async function startHttp(
  options: StartBuiltServerOptions,
  base: Record<string, string>,
  args: string[],
  readyTimeoutMs: number,
): Promise<BuiltServer> {
  const port = options.port ?? (await freePort());
  const apiKey = resolveApiKey(options);
  const env: Record<string, string> = {
    ...base,
    ...options.env,
    MCP_TRANSPORT: 'http',
    MCP_HTTP_HOST: '127.0.0.1',
    PORT: String(port),
  };
  if (apiKey === undefined) {
    delete env.MCP_API_KEY;
    env.MCP_AUTH_DISABLED = 'true';
  } else {
    env.MCP_API_KEY = apiKey;
  }

  const child = spawn(process.execPath, args, {
    env,
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let stderrText = '';
  let stdoutText = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString();
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutText += chunk.toString();
  });
  const spawnError = new Promise<never>((_, fail) => {
    child.once('error', (err) => fail(new Error(`startBuiltServer: spawn failed: ${err.message}`)));
  });
  spawnError.catch(() => undefined);

  const baseUrl = `http://127.0.0.1:${port}`;
  const url = `${baseUrl}/mcp`;
  const client = createTestClient(options);
  let connected = false;
  const stop = once(async () => {
    if (connected) await client.close().catch(() => undefined);
    await killAndWait(child);
  });

  try {
    await Promise.race([waitForHealth(baseUrl, child, readyTimeoutMs, () => stderrText), spawnError]);
    const transport = new StreamableHTTPClientTransport(
      new URL(url),
      apiKey === undefined ? {} : { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } },
    );
    await withTimeout(client.connect(transport), readyTimeoutMs, 'startBuiltServer: http connect');
    connected = true;
  } catch (e) {
    await stop();
    throw e instanceof Error && e.message.startsWith('startBuiltServer:')
      ? e
      : new Error(
          `startBuiltServer: http connect failed: ${e instanceof Error ? e.message : String(e)}\nstderr:\n${tail(stderrText)}`,
        );
  }

  return {
    client,
    mode: 'http',
    url,
    baseUrl,
    apiKey,
    env,
    pid: child.pid,
    stderr: () => stderrText,
    stdout: () => stdoutText,
    stop,
  };
}
