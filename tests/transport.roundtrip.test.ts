import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startMcpServer } from '../src/transport.js';
import { buildEchoServer } from './fixtures/echo-tools.js';

// Real SDK v2 end to end: no mocks. stdio spawns the fixture in a child process; HTTP runs
// startMcpServer in-process on a free loopback port and shuts it down through its own SIGINT listener.
jest.setTimeout(30_000);

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/echo-server.ts', import.meta.url));

type Era = 'legacy' | 'modern';

function makeClient(era: Era): Client {
  return new Client(
    { name: 'mcp-core-roundtrip', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {},
  );
}

function expectEra(client: Client, era: Era): void {
  const version = client.getNegotiatedProtocolVersion() ?? '';
  if (era === 'modern') expect(version).toBe('2026-07-28');
  else expect(version.startsWith('2025-')).toBe(true);
}

async function expectEchoRoundTrip(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(['echo']);
  expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
  expect(result.content).toEqual([{ type: 'text', text: 'echo: hi' }]);
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createNetServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => ok(port));
    });
  });
}

interface RunningHttp {
  port: number;
  stop(): Promise<void>;
}

/** Start startMcpServer(http) in-process with the given env, and return a stop() that fires its SIGINT listener. */
async function startHttp(env: Record<string, string>, apiKey?: string): Promise<RunningHttp> {
  const port = await freePort();
  const saved = { ...process.env };
  Object.assign(process.env, { MCP_HTTP_HOST: '127.0.0.1' }, env);
  const before = process.listeners('SIGINT');
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const running = startMcpServer(buildEchoServer, { mode: 'http', port, ...(apiKey ? { apiKey } : {}) });
  try {
    for (let i = 0; i < 100; i++) {
      const added = process.listeners('SIGINT').filter((l) => !before.includes(l));
      if (added.length === 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    stderr.mockRestore();
    process.env = saved;
  }
  const shutdown = process.listeners('SIGINT').find((l) => !before.includes(l));
  if (!shutdown) throw new Error('HTTP server did not start');
  return {
    port,
    stop: async (): Promise<void> => {
      shutdown('SIGINT');
      await running;
    },
  };
}

function rawRequest(
  port: number,
  opts: { method: string; headers?: Record<string, string>; body?: string; path?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: opts.path ?? '/mcp', method: opts.method, headers: opts.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', fail);
    req.end(opts.body);
  });
}

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } },
});
const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('stdio round-trip (spawned fixture, real SDK)', () => {
  it.each<Era>(['legacy', 'modern'])('lists and calls the echo tool (%s era)', async (era) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', fixture],
      cwd: pkgRoot,
      env: { ...getDefaultEnvironment(), MCP_TRANSPORT: 'stdio' },
      stderr: 'pipe',
    });
    const client = makeClient(era);
    await client.connect(transport);
    try {
      expectEra(client, era);
      await expectEchoRoundTrip(client);
    } finally {
      await client.close();
    }
  });
});

describe('HTTP round-trip (in-process startMcpServer, real SDK)', () => {
  let open: RunningHttp;
  let keyed: RunningHttp;

  beforeAll(async () => {
    open = await startHttp({ MCP_AUTH_DISABLED: 'true' });
    keyed = await startHttp({}, 'right-key');
  });

  afterAll(async () => {
    await open?.stop();
    await keyed?.stop();
  });

  it('GET /health answers healthy without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${keyed.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'healthy' });
  });

  it.each<Era>(['legacy', 'modern'])('MCP_AUTH_DISABLED=true: lists and calls the echo tool (%s era)', async (era) => {
    const client = makeClient(era);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${open.port}/mcp`)));
    try {
      expectEra(client, era);
      await expectEchoRoundTrip(client);
    } finally {
      await client.close();
    }
  });

  it('a correct Bearer key gets through', async () => {
    const client = makeClient('legacy');
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${keyed.port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer right-key' } },
      }),
    );
    try {
      await expectEchoRoundTrip(client);
    } finally {
      await client.close();
    }
  });

  it('a wrong Bearer key is refused with 401 (client connect fails, raw request sees 401)', async () => {
    const client = makeClient('legacy');
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${keyed.port}/mcp`), {
          requestInit: { headers: { Authorization: 'Bearer wrong-key' } },
        }),
      ),
    ).rejects.toThrow();
    const raw = await rawRequest(keyed.port, {
      method: 'POST',
      headers: { ...jsonHeaders, authorization: 'Bearer wrong-key' },
      body: initializeBody,
    });
    expect(raw.status).toBe(401);
  });

  it('a legacy GET /mcp is answered 405 by the stateless SDK handler', async () => {
    const raw = await rawRequest(open.port, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(raw.status).toBe(405);
  });
});

describe('HTTP Host/Origin allow-lists (real SDK validators)', () => {
  let guarded: RunningHttp;

  beforeAll(async () => {
    guarded = await startHttp({
      MCP_AUTH_DISABLED: 'true',
      MCP_ALLOWED_HOSTS: '127.0.0.1:1,localhost',
      MCP_ALLOWED_ORIGINS: 'http://localhost:3000',
    });
  });

  afterAll(async () => {
    await guarded?.stop();
  });

  it('rejects a Host that is not allowed with 403', async () => {
    const raw = await rawRequest(guarded.port, {
      method: 'POST',
      headers: { ...jsonHeaders, host: 'evil.example' },
      body: initializeBody,
    });
    expect(raw.status).toBe(403);
  });

  it('matches an allowed Host port-agnostically (127.0.0.1:1 admits 127.0.0.1:<any port>)', async () => {
    const raw = await rawRequest(guarded.port, { method: 'POST', headers: jsonHeaders, body: initializeBody });
    expect(raw.status).toBe(200);
  });

  it('rejects a disallowed Origin with 403 and admits the allowed hostname on any port', async () => {
    const bad = await rawRequest(guarded.port, {
      method: 'POST',
      headers: { ...jsonHeaders, origin: 'https://evil.example' },
      body: initializeBody,
    });
    expect(bad.status).toBe(403);
    const good = await rawRequest(guarded.port, {
      method: 'POST',
      headers: { ...jsonHeaders, origin: 'http://localhost:5173' },
      body: initializeBody,
    });
    expect(good.status).toBe(200);
  });

  it('requests without an Origin header pass (non-browser clients)', async () => {
    const client = makeClient('legacy');
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${guarded.port}/mcp`)));
    try {
      await expectEchoRoundTrip(client);
    } finally {
      await client.close();
    }
  });
});
