import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type RunMcpServerOptions, readPackageInfo, runMcpServer } from '../src/bootstrap.js';
import { credentialStatusTool } from '../src/credential-status-tool.js';
import { CredentialRegistry, setProcessCredentials } from '../src/credentials.js';
import { HttpError } from '../src/http-client.js';
import { createMcpServer, type McpServer } from '../src/server.js';
import {
  callToolJson,
  createTestClient,
  initializeRequestBody,
  mcpPostHeaders,
  rawHttp,
} from '../src/testing/index.js';
import { registerTools } from '../src/tools.js';
import type { RequestContext } from '../src/transport.js';
import type { EnvSchema } from '../src/utils/envLoader.js';
import { getLogger, resetLogger } from '../src/utils/logger.js';

let root: string;
let logs: string;
let stderr: jest.SpiedFunction<typeof process.stderr.write>;
let savedHost: string | undefined;
let sigintBefore: NodeJS.SignalsListener[];
let sigtermBefore: NodeJS.SignalsListener[];

beforeEach(() => {
  resetLogger();
  root = mkdtempSync(join(tmpdir(), 'mcp-core-boot-'));
  logs = join(root, 'logs');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@scope/demo-mcp', version: '2.1.0', description: 'Demo server' }),
  );
  savedHost = process.env.MCP_HTTP_HOST;
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  sigintBefore = process.listeners('SIGINT');
  sigtermBefore = process.listeners('SIGTERM');
});

afterEach(() => {
  for (const l of process.listeners('SIGINT')) if (!sigintBefore.includes(l)) process.off('SIGINT', l);
  for (const l of process.listeners('SIGTERM')) if (!sigtermBefore.includes(l)) process.off('SIGTERM', l);
  stderr.mockRestore();
  if (savedHost === undefined) delete process.env.MCP_HTTP_HOST;
  else process.env.MCP_HTTP_HOST = savedHost;
  resetLogger();
  rmSync(root, { recursive: true, force: true });
});

function mainLog(name = 'demo-mcp'): string {
  return readFileSync(join(logs, `${name}.log`), 'utf8');
}

interface Shared {
  id: number;
  events: string[];
}

function httpOptions(events: string[], extra: Partial<RunMcpServerOptions<Shared>> = {}): RunMcpServerOptions<Shared> {
  return {
    rootDir: root,
    env: [{ key: 'DEMO_KEY', description: 'demo' }],
    logger: { logDir: logs, console: false },
    transport: { mode: 'http', port: 0, apiKey: 'boot-test-key-123456' },
    processEnv: { MCP_ENV_FILE: 'none' },
    setup: ({ info, env }) => {
      events.push(`setup:${info.name}:${env.get('DEMO_KEY') ?? '-'}`);
      return { id: Math.random(), events };
    },
    create: (shared: Shared, req: RequestContext): McpServer => {
      shared.events.push(`create:${req.era}`);
      return createMcpServer('demo-mcp', '2.1.0');
    },
    dispose: (shared: Shared) => {
      shared.events.push('dispose');
    },
    ...extra,
  };
}

describe('readPackageInfo', () => {
  it('reads name, version and description', () => {
    expect(readPackageInfo(root)).toEqual({ name: '@scope/demo-mcp', version: '2.1.0', description: 'Demo server' });
  });

  it('throws on a missing file or a missing name/version', () => {
    expect(() => readPackageInfo(join(root, 'nope'))).toThrow(/cannot read/);
    mkdirSync(join(root, 'bad'));
    writeFileSync(join(root, 'bad', 'package.json'), JSON.stringify({ name: 'x' }));
    expect(() => readPackageInfo(join(root, 'bad'))).toThrow(/no name or version/);
    writeFileSync(join(root, 'bad', 'package.json'), '[]');
    expect(() => readPackageInfo(join(root, 'bad'))).toThrow(/no name or version/);
  });
});

describe('runMcpServer (http, in process)', () => {
  it('logger > env > setup once > listen > ONE started line after bind; name/version from package.json', async () => {
    const events: string[] = [];
    const running = await runMcpServer(httpOptions(events, { processEnv: { MCP_ENV_FILE: 'none', DEMO_KEY: 'v' } }));
    try {
      expect(running.info).toEqual({ name: '@scope/demo-mcp', version: '2.1.0', description: 'Demo server' });
      expect(running.mode).toBe('http');
      expect(running.host).toBe('127.0.0.1');
      expect(running.port).toBeGreaterThan(0);
      expect(running.url).toBe(`http://127.0.0.1:${running.port}/mcp`);
      expect(events).toEqual(['setup:@scope/demo-mcp:v']);
      // The listener is bound by the time the started line exists.
      expect((await rawHttp(`http://127.0.0.1:${running.port}/health`, { method: 'GET' })).status).toBe(200);
      const started = mainLog()
        .split('\n')
        .filter((l) => l.includes('started'));
      expect(started).toHaveLength(1);
      expect(started[0]).toContain('| INFO  | Server | @scope/demo-mcp started |');
      // The logger masks IP addresses as PII, so the bound host reads [IP]; the port is kept.
      expect(started[0]).toContain(`"version":"2.1.0","transport":"http","host":"[IP]","port":${running.port}`);
      expect(running.env.get('DEMO_KEY')).toBe('v');
    } finally {
      await running.close();
    }
  });

  it('creates the shared state ONCE and reuses it across many HTTP requests (create per request)', async () => {
    const events: string[] = [];
    const seen = new Set<Shared>();
    const running = await runMcpServer(
      httpOptions(events, {
        create: (shared, req) => {
          seen.add(shared);
          shared.events.push(`create:${req.era}`);
          return createMcpServer('demo-mcp', '2.1.0');
        },
      }),
    );
    try {
      for (let i = 1; i <= 3; i++) {
        const r = await rawHttp(running.url ?? '', {
          headers: mcpPostHeaders('boot-test-key-123456'),
          body: initializeRequestBody(i),
        });
        expect(r.status).toBe(200);
      }
      const client = createTestClient({ era: 'modern' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(running.url ?? ''), {
          requestInit: { headers: { Authorization: 'Bearer boot-test-key-123456' } },
        }),
      );
      await client.listTools().catch(() => undefined);
      await client.close();
    } finally {
      await running.close();
    }
    expect(events.filter((e) => e.startsWith('setup'))).toHaveLength(1);
    expect(events.filter((e) => e.startsWith('create')).length).toBeGreaterThanOrEqual(4);
    expect(events).toContain('create:legacy');
    expect(events).toContain('create:modern');
    expect(seen.size).toBe(1);
    expect(events[events.length - 1]).toBe('dispose');
  });

  it('close(): transport first, then dispose; idempotent; the listener is gone', async () => {
    const events: string[] = [];
    const running = await runMcpServer(httpOptions(events));
    const health = `http://127.0.0.1:${running.port}/health`;
    await Promise.all([running.close(), running.close()]);
    await running.close();
    expect(events.filter((e) => e === 'dispose')).toHaveLength(1);
    await expect(rawHttp(health, { method: 'GET' })).rejects.toThrow();
  });

  it('SIGINT closes the transport, disposes, logs the stop and exits 0; handlers are its own', async () => {
    const events: string[] = [];
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    try {
      const running = await runMcpServer(httpOptions(events));
      const added = process.listeners('SIGINT').filter((l) => !sigintBefore.includes(l));
      expect(added).toHaveLength(1);
      expect(process.listeners('SIGTERM').filter((l) => !sigtermBefore.includes(l))).toHaveLength(1);
      (added[0] as NodeJS.SignalsListener)('SIGINT');
      for (let i = 0; i < 100 && exit.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(exit).toHaveBeenCalledWith(0);
      expect(events[events.length - 1]).toBe('dispose');
      expect(process.listeners('SIGINT').filter((l) => !sigintBefore.includes(l))).toHaveLength(0);
      expect(mainLog()).toContain('@scope/demo-mcp stopping (SIGINT)');
      await running.close();
    } finally {
      exit.mockRestore();
    }
  });

  it('a failing dispose during a signal is logged and exits 1', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
    try {
      await runMcpServer(
        httpOptions([], {
          dispose: () => {
            throw new Error('dispose broke');
          },
        }),
      );
      const added = process.listeners('SIGTERM').filter((l) => !sigtermBefore.includes(l));
      (added[0] as NodeJS.SignalsListener)('SIGTERM');
      for (let i = 0; i < 100 && exit.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(exit).toHaveBeenCalledWith(1);
      expect(readFileSync(join(logs, 'exceptions.log'), 'utf8')).toContain('shutdown failed: dispose broke');
    } finally {
      exit.mockRestore();
    }
  });

  it('handleSignals: false installs no handlers', async () => {
    const running = await runMcpServer(httpOptions([], { handleSignals: false }));
    try {
      expect(process.listeners('SIGINT').filter((l) => !sigintBefore.includes(l))).toHaveLength(0);
    } finally {
      await running.close();
    }
  });

  it('disposes the shared state and rethrows when the transport cannot start (fail-closed auth)', async () => {
    const events: string[] = [];
    await expect(
      runMcpServer(httpOptions(events, { transport: { mode: 'http', port: 0 }, processEnv: { MCP_ENV_FILE: 'none' } })),
    ).rejects.toThrow(/refused to start without auth/);
    expect(events).toEqual(['setup:@scope/demo-mcp:-', 'dispose']);
  });

  it('loads <rootDir>/.env, logs env errors as WARN by key, and works without setup', async () => {
    writeFileSync(join(root, '.env'), 'DEMO_KEY=from-file\nPORT=not-a-number\n');
    const target: NodeJS.ProcessEnv = {};
    const running = await runMcpServer<undefined>({
      rootDir: root,
      env: [{ key: 'DEMO_KEY' }],
      logger: { logDir: logs, console: false },
      transport: { mode: 'http', port: 0, apiKey: null },
      processEnv: target,
      create: (shared) => {
        expect(shared).toBeUndefined();
        return createMcpServer('x', '1');
      },
      handleSignals: false,
    });
    try {
      expect(running.env.get('DEMO_KEY')).toBe('from-file');
      expect(target.DEMO_KEY).toBe('from-file');
      expect(running.shared).toBeUndefined();
      expect(mainLog()).toContain('| WARN  | Env | env PORT must be an integer');
      expect(mainLog()).not.toContain('not-a-number');
    } finally {
      await running.close();
    }
  });

  it('name and version options skip package.json; captureProcessErrors is passed to the logger', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'mcp-core-bare-'));
    const before = process.listenerCount('uncaughtException');
    try {
      const running = await runMcpServer({
        rootDir: bare,
        name: 'bare-mcp',
        version: '0.1.0',
        env: [],
        logger: { logDir: logs, console: false },
        transport: { mode: 'http', port: 0, apiKey: 'boot-test-key-123456' },
        processEnv: { MCP_ENV_FILE: 'none' },
        captureProcessErrors: true,
        create: () => createMcpServer('bare-mcp', '0.1.0'),
        handleSignals: false,
      });
      expect(running.info).toEqual({ name: 'bare-mcp', version: '0.1.0' });
      expect(process.listenerCount('uncaughtException')).toBe(before + 1);
      expect(mainLog('bare-mcp')).toContain('bare-mcp started');
      await running.close();
    } finally {
      getLogger().detachProcessHandlers();
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('runMcpServer (stdio EOF, spawned)', () => {
  it('disposes the shared state and exits 0 when the client closes stdin (a keep-alive handle cannot orphan it)', async () => {
    const { spawn } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const fixture = fileURLToPath(new URL('./fixtures/keepalive-server.ts', import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const marker = join(root, 'disposed.txt');
    const child = spawn(process.execPath, ['--import', tsx, fixture], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        MCP_TRANSPORT: 'stdio',
        MCP_ENV_FILE: 'none',
        LOG_PATH: logs,
        LOG_CONSOLE: 'false',
        KEEPALIVE_MARKER: marker,
      },
    });
    let stderrText = '';
    child.stderr.on('data', (c: Buffer) => {
      stderrText += c.toString();
    });
    try {
      // Wait for the started line, then close stdin like a client that disconnects.
      for (let i = 0; i < 200; i++) {
        try {
          if (readFileSync(join(logs, 'echo-fixture.log'), 'utf8').includes('started')) break;
        } catch {
          // not written yet
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      child.stdin.end();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no exit after stdin EOF; stderr: ${stderrText}`)), 15_000);
        child.once('exit', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      expect(code).toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('disposed');
      expect(readFileSync(join(logs, 'echo-fixture.log'), 'utf8')).toContain('stopping (transport closed)');
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 30_000);
});

describe('runMcpServer credential checks', () => {
  const VALUES = {
    GOOD_KEY: 'good-value-0123456789',
    POOL_KEY: 'pool-value-0123456789',
    POOL_KEY_1: 'pool-value-1123456789',
    SLOW_KEY: 'slow-value-0123456789',
  };
  const schema: EnvSchema = [
    { key: 'GOOD_KEY', secret: true, check: async () => 'valid' },
    {
      key: 'POOL_KEY',
      secret: true,
      multi: true,
      check: async (value) => {
        if (value === VALUES.POOL_KEY) throw new HttpError({ message: 'no', method: 'GET', path: '/me', status: 401 });
        throw new Error(`offline ${value}`);
      },
    },
    { key: 'SLOW_KEY', secret: true, check: () => new Promise(() => undefined) },
  ];

  function credentialOptions(
    registry: CredentialRegistry,
    extraEnv: Record<string, string> = {},
  ): RunMcpServerOptions<undefined> {
    return {
      rootDir: root,
      env: schema,
      logger: { logDir: logs, console: false },
      transport: { mode: 'http', port: 0, apiKey: 'boot-test-key-123456' },
      processEnv: { MCP_ENV_FILE: 'none', MCP_CREDENTIAL_CHECK_TIMEOUT_MS: '50', ...VALUES, ...extraEnv },
      credentials: registry,
      create: (_shared, _req, ctx) => {
        const server = ctx.createServer();
        registerTools(server, [credentialStatusTool({ registry: ctx.credentials })], {
          env: ctx.env,
          credentials: ctx.credentials,
        });
        return server;
      },
    };
  }

  async function statusOver(url: string): Promise<{ text: string; credentials: Array<Record<string, unknown>> }> {
    const client = createTestClient({ era: 'modern' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: 'Bearer boot-test-key-123456' } },
      }),
    );
    try {
      const r = await callToolJson<{ credentials: Array<Record<string, unknown>> }>(client, 'credential_status');
      return { text: r.text, credentials: r.body.credentials };
    } finally {
      await client.close();
    }
  }

  it('the server starts when every check fails; results reach the status tool, names only', async () => {
    const registry = new CredentialRegistry();
    const running = await runMcpServer(credentialOptions(registry));
    try {
      expect(running.credentials).toBe(registry);
      const { text, credentials } = await statusOver(running.url ?? '');
      expect(credentials.map((c) => [c.key, c.pool, c.status, c.reason])).toEqual([
        ['GOOD_KEY', undefined, 'valid', undefined],
        ['POOL_KEY', 'POOL_KEY', 'invalid', 'auth rejected'],
        ['POOL_KEY_1', 'POOL_KEY', 'unknown', 'check failed'],
        ['SLOW_KEY', undefined, 'unknown', 'timeout'],
      ]);
      expect(text).toContain('POOL_KEY_1 [POOL_KEY]: unknown (check failed)');
      const log = mainLog();
      expect(log).toContain(
        'credential checks: GOOD_KEY valid, POOL_KEY invalid (auth rejected), POOL_KEY_1 unknown (check failed), SLOW_KEY unknown (timeout)',
      );
      expect(log.indexOf('credential checks')).toBeLessThan(log.indexOf('started'));
      for (const value of Object.values(VALUES)) {
        expect(log).not.toContain(value);
        expect(JSON.stringify(credentials)).not.toContain(value);
      }
    } finally {
      await running.close();
    }
  });

  it('MCP_CREDENTIAL_CHECKS=false skips the checks: every credential is listed as unknown', async () => {
    const registry = new CredentialRegistry();
    const running = await runMcpServer(credentialOptions(registry, { MCP_CREDENTIAL_CHECKS: 'false' }));
    try {
      const { credentials } = await statusOver(running.url ?? '');
      expect(credentials.map((c) => c.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
      expect(mainLog()).toContain('credential checks skipped (MCP_CREDENTIAL_CHECKS=false): 4 credential(s) unknown');
    } finally {
      await running.close();
    }
  });

  it('defaults to the process registry and an empty status tool says so', async () => {
    const own = new CredentialRegistry();
    setProcessCredentials(own);
    try {
      const base = credentialOptions(own);
      delete base.credentials;
      const running = await runMcpServer({
        ...base,
        env: [],
        create: (_shared, _req, ctx) => {
          const server = ctx.createServer();
          registerTools(server, [credentialStatusTool()], { env: ctx.env });
          return server;
        },
      });
      try {
        expect(running.credentials).toBe(own);
        const { text, credentials } = await statusOver(running.url ?? '');
        expect(credentials).toEqual([]);
        expect(text).toBe('No credentials are registered.');
      } finally {
        await running.close();
      }
    } finally {
      setProcessCredentials(undefined);
    }
  });
});

describe('runMcpServer survives a failing credential registration', () => {
  it('starts and logs one WARN when the checks throw (a malformed credential key name)', async () => {
    const events: string[] = [];
    const running = await runMcpServer(
      httpOptions(events, {
        env: [{ key: 'BAD-KEY', secret: true, description: 'not an env-variable name' }],
        processEnv: { MCP_ENV_FILE: 'none', 'BAD-KEY': 'bad-key-value-0123456789' },
        credentials: new CredentialRegistry(),
      }),
    );
    try {
      expect(events).toEqual(['setup:@scope/demo-mcp:-']);
      const log = mainLog();
      expect(log).toContain('credential checks failed: UnknownCredentialError');
      expect(log).not.toContain('bad-key-value-0123456789');
    } finally {
      await running.close();
    }
  });
});
