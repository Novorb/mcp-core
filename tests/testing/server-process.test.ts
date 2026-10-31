import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  type BuiltServer,
  callToolJson,
  createIsolatedDirs,
  findLeaks,
  freePort,
  type HarnessMode,
  type IsolatedDirs,
  initializeRequestBody,
  killAndWait,
  logLevels,
  mcpPostHeaders,
  minimalOsEnv,
  rawHttp,
  readLogFiles,
  startBuiltServer,
} from '../../src/testing/index.js';

// Real child processes running the echo fixture through the harness: no mocks.
jest.setTimeout(60_000);

const fixture = fileURLToPath(new URL('../fixtures/echo-server.ts', import.meta.url));
const crashFixture = fileURLToPath(new URL('../fixtures/crash-server.ts', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const nodeArgs = ['--import', tsxLoader];
const SENT_VALUE = 'harness-sent-value-7f3a';

describe('minimalOsEnv', () => {
  it('keeps only the OS allow-list and drops unrelated variables', () => {
    const env = minimalOsEnv({
      PATH: '/bin',
      Path: '/x',
      SOME_SECRET: 's3cr3t-value',
      HOME: '/h',
      USERPROFILE: 'C:\\u',
    });
    expect(env.SOME_SECRET).toBeUndefined();
    expect(Object.values(env)).not.toContain('s3cr3t-value');
    expect(Object.keys(env).length).toBeGreaterThan(0);
  });

  it('skips shell-function values', () => {
    const env = minimalOsEnv({ PATH: '() { :; }', HOME: '() { :; }', SYSTEMROOT: '() { :; }' });
    expect(Object.keys(env)).toEqual([]);
  });
});

describe('freePort', () => {
  it('returns a usable loopback port', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe.each<HarnessMode>(['stdio', 'http'])('startBuiltServer (%s, real fixture, isolated dirs)', (mode) => {
  let dirs: IsolatedDirs;
  let srv: BuiltServer;
  const parentSecret = 'parent-only-secret-9d1c';

  beforeAll(async () => {
    process.env.MCP_IT_PARENT_ONLY = parentSecret;
    dirs = createIsolatedDirs(`mcp-core-${mode}`);
    srv = await startBuiltServer({
      entry: fixture,
      nodeArgs,
      mode,
      cwd: dirs.cwd,
      env: { ...dirs.env(), LOG_LEVEL: 'DEBUG', LOG_CONSOLE: 'false' },
    });
  });

  afterAll(async () => {
    delete process.env.MCP_IT_PARENT_ONLY;
    await srv?.stop();
    dirs?.cleanup();
  });

  it('passes an explicit env: harness vars set, parent-only vars absent', () => {
    expect(srv.mode).toBe(mode);
    expect(srv.env.MCP_TRANSPORT).toBe(mode);
    expect(srv.env.LOG_PATH).toBe(dirs.logs);
    expect(srv.env.MCP_IT_PARENT_ONLY).toBeUndefined();
    expect(typeof srv.pid).toBe('number');
    if (mode === 'http') {
      expect(srv.env.MCP_HTTP_HOST).toBe('127.0.0.1');
      expect(srv.apiKey).toMatch(/^[0-9a-f]{64}$/);
      expect(srv.env.MCP_API_KEY).toBe(srv.apiKey);
      expect(srv.url).toBe(`${srv.baseUrl}/mcp`);
    } else {
      expect(srv.url).toBeUndefined();
      expect(srv.stdout()).toBe('');
    }
  });

  it('calls the tools through the connected client', async () => {
    const echo = await callToolJson(srv.client, 'echo', { text: SENT_VALUE });
    expect(echo).toMatchObject({ isError: false, body: `echo: ${SENT_VALUE}` });
    const json = await callToolJson<{ text: string; length: number }>(srv.client, 'echo_json', { text: 'abc' });
    expect(json.body).toEqual({ text: 'abc', length: 3 });
    const boom = await callToolJson(srv.client, 'boom');
    expect(boom.isError).toBe(true);
  });

  it('http adverse cases: 401 without the key, 404, 415, and the health probe', async () => {
    if (mode !== 'http' || !srv.url || !srv.baseUrl) return;
    expect((await rawHttp(`${srv.baseUrl}/health`, { method: 'GET' })).status).toBe(200);
    expect((await rawHttp(srv.url, { headers: mcpPostHeaders(), body: initializeRequestBody() })).status).toBe(401);
    expect((await rawHttp(`${srv.baseUrl}/nope`, { headers: mcpPostHeaders(srv.apiKey) })).status).toBe(404);
    const unsupported = await rawHttp(srv.url, {
      headers: { ...mcpPostHeaders(srv.apiKey), 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(unsupported.status).toBe(415);
    expect(unsupported.headers['content-type']).toContain('application/json');
  });

  it('stop() is idempotent and the logs hold the expected lines and no leaked values', async () => {
    await Promise.all([srv.stop(), srv.stop()]);
    await srv.stop();
    const logs = readLogFiles(dirs.logs, 'echo-fixture');
    expect(logs.exists).toEqual({ main: true, exceptions: true, debug: true });
    expect(logs.main).toContain('echo-fixture started');
    for (const tool of ['echo', 'echo_json', 'boom']) {
      expect(logs.main).toContain(`Tool call: ${tool}`);
      expect(logs.main).toContain(`Tool result: ${tool}`);
    }
    expect(new Set(logLevels(logs.exceptions))).toEqual(new Set(['ERROR']));
    expect(logs.exceptions).toContain('boom failed on purpose');
    expect(new Set(logLevels(logs.debug))).toEqual(new Set(['DEBUG']));
    const needles = [SENT_VALUE, parentSecret, srv.apiKey ?? ''];
    expect(findLeaks([logs.main, logs.exceptions, logs.debug], needles)).toEqual([]);
    expect(srv.stderr()).not.toContain(SENT_VALUE);
  });
});

describe('startBuiltServer options and failures', () => {
  it('http: a given apiKey is used, a wrong key is refused, and a switched-off sink writes no file', async () => {
    const dirs = createIsolatedDirs('mcp-core-key');
    const srv = await startBuiltServer({
      entry: fixture,
      nodeArgs,
      mode: 'http',
      apiKey: 'given-key-0123456789',
      cwd: dirs.cwd,
      env: { ...dirs.env(), LOG_FILE_DEBUG: 'false', LOG_LEVEL: 'DEBUG' },
    });
    try {
      expect(srv.apiKey).toBe('given-key-0123456789');
      await callToolJson(srv.client, 'echo', { text: 'x' });
      const wrong = await rawHttp(srv.url ?? '', { headers: mcpPostHeaders('wrong'), body: initializeRequestBody() });
      expect(wrong.status).toBe(401);
    } finally {
      await srv.stop();
    }
    const logs = readLogFiles(dirs.logs, 'echo-fixture');
    expect(logs.exists.debug).toBe(false);
    expect(logs.debug).toBe('');
    expect(logs.exists.main).toBe(true);
    dirs.cleanup();
  });

  it('http: env.MCP_API_KEY is used when apiKey is omitted; MCP_MAX_BODY_BYTES gives a 413', async () => {
    const srv = await startBuiltServer({
      entry: fixture,
      nodeArgs,
      mode: 'http',
      env: { MCP_API_KEY: 'env-key-0123456789', MCP_MAX_BODY_BYTES: '1024', LOG_CONSOLE: 'false' },
    });
    try {
      expect(srv.apiKey).toBe('env-key-0123456789');
      const big = await rawHttp(srv.url ?? '', { headers: mcpPostHeaders(srv.apiKey), body: 'x'.repeat(64 * 1024) });
      expect(big.status).toBe(413);
      expect(big.headers.connection).toBe('close');
    } finally {
      await srv.stop();
    }
  });

  it('http: a body over the default 4 MiB cap is answered 413 (the response reaches the client)', async () => {
    const srv = await startBuiltServer({ entry: fixture, nodeArgs, mode: 'http', env: { LOG_CONSOLE: 'false' } });
    try {
      const big = await rawHttp(srv.url ?? '', {
        headers: mcpPostHeaders(srv.apiKey),
        body: 'x'.repeat(5 * 1024 * 1024),
      });
      expect(big.status).toBe(413);
      // The connection is closed after the 413, and the server keeps serving new requests.
      expect((await callToolJson(srv.client, 'echo', { text: 'after' })).body).toBe('echo: after');
    } finally {
      await srv.stop();
    }
  });

  it('http: apiKey null starts the server open (MCP_AUTH_DISABLED) on a fixed port', async () => {
    const port = await freePort();
    const srv = await startBuiltServer({
      entry: fixture,
      nodeArgs,
      mode: 'http',
      apiKey: null,
      port,
      env: { MCP_API_KEY: 'ignored', LOG_CONSOLE: 'false' },
    });
    try {
      expect(srv.apiKey).toBeUndefined();
      expect(srv.env.MCP_AUTH_DISABLED).toBe('true');
      expect(srv.env.MCP_API_KEY).toBeUndefined();
      expect(srv.baseUrl).toBe(`http://127.0.0.1:${port}`);
      expect(srv.stderr()).toContain('WITHOUT auth');
      expect(srv.stdout()).toBe('');
      const open = await rawHttp(srv.url ?? '', { headers: mcpPostHeaders(), body: initializeRequestBody() });
      expect(open.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it('inheritEnv passes the parent environment through', async () => {
    process.env.MCP_IT_INHERITED = 'inherited-value';
    try {
      const srv = await startBuiltServer({ entry: fixture, nodeArgs, mode: 'stdio', inheritEnv: true, env: {} });
      expect(srv.env.MCP_IT_INHERITED).toBe('inherited-value');
      await srv.stop();
    } finally {
      delete process.env.MCP_IT_INHERITED;
    }
  });

  it('http: a server that exits at startup fails fast with its stderr', async () => {
    await expect(startBuiltServer({ entry: crashFixture, nodeArgs, mode: 'http' })).rejects.toThrow(
      /exited \(code 3\) before \/health was ready[\s\S]*crash-fixture: refusing to start/,
    );
  });

  it('http: a server that never becomes healthy times out', async () => {
    await expect(
      startBuiltServer({ entry: fixture, nodeArgs: ['--import', tsxLoader], mode: 'http', readyTimeoutMs: 1 }),
    ).rejects.toThrow(/\/health not ready within 1 ms/);
  });

  it('http: a missing node binary argument surfaces as a startup error', async () => {
    await expect(
      startBuiltServer({ entry: fixture, nodeArgs: ['--no-such-node-flag'], mode: 'http', readyTimeoutMs: 10_000 }),
    ).rejects.toThrow(/startBuiltServer:/);
  });

  it('stdio: a server that exits at startup fails with its stderr', async () => {
    await expect(
      startBuiltServer({ entry: crashFixture, nodeArgs, mode: 'stdio', readyTimeoutMs: 10_000 }),
    ).rejects.toThrow(/stdio connect failed[\s\S]*crash-fixture: refusing to start/);
  });
});

describe('killAndWait', () => {
  it('kills a running child, awaits exit, and is a no-op once exited', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise<void>((r) => child.once('spawn', () => r()));
    await killAndWait(child, 200);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await killAndWait(child);
  });
});

describe('createIsolatedDirs (with the harness)', () => {
  it('leaves nothing behind after cleanup', () => {
    const dirs = createIsolatedDirs('mcp-core-cleanup');
    expect(existsSync(dirs.root)).toBe(true);
    dirs.cleanup();
    expect(existsSync(dirs.root)).toBe(false);
  });
});
