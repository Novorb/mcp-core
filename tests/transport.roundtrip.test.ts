import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { type Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  connectInMemory,
  createTestClient,
  freePort,
  initializeRequestBody,
  listToolNames,
  mcpPostHeaders,
  type ProtocolEra,
  rawHttp,
  startBuiltServer,
} from '../src/testing/index.js';
import { startMcpServer } from '../src/transport.js';
import { buildEchoServer, ECHO_TOOL_NAMES } from './fixtures/echo-tools.js';

// Real SDK v2 end to end: no mocks. stdio and child-process HTTP use the testing harness against the
// fixture; the in-process HTTP block keeps startMcpServer's own HTTP path under coverage and shuts it
// down through its own SIGINT listener.
jest.setTimeout(30_000);

const fixture = fileURLToPath(new URL('./fixtures/echo-server.ts', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

function expectEra(client: Client, era: ProtocolEra): void {
  const version = client.getNegotiatedProtocolVersion() ?? '';
  if (era === 'modern') expect(version).toBe('2026-07-28');
  else expect(version.startsWith('2025-')).toBe(true);
}

async function expectEchoRoundTrip(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(ECHO_TOOL_NAMES);
  expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
  expect(result.content).toEqual([{ type: 'text', text: 'echo: hi' }]);
}

interface RunningHttp {
  port: number;
  stop(): Promise<void>;
}

/** Start startMcpServer(http) in-process with the given env, and return a stop() that fires its SIGINT listener. */
async function startInProcessHttp(env: Record<string, string>, apiKey?: string): Promise<RunningHttp> {
  const port = await freePort();
  const saved = { ...process.env };
  Object.assign(process.env, { MCP_HTTP_HOST: '127.0.0.1' }, env);
  const before = process.listeners('SIGINT');
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let handle: Awaited<ReturnType<typeof startMcpServer>>;
  try {
    // Resolves once the listener is bound.
    handle = await startMcpServer(buildEchoServer, { mode: 'http', port, ...(apiKey ? { apiKey } : {}) });
  } finally {
    stderr.mockRestore();
    process.env = saved;
  }
  expect(handle.port).toBe(port);
  expect(handle.url).toBe(`http://127.0.0.1:${port}/mcp`);
  const shutdown = process.listeners('SIGINT').find((l) => !before.includes(l));
  if (!shutdown) throw new Error('HTTP server installed no SIGINT handler');
  return {
    port,
    stop: async (): Promise<void> => {
      // The transport's own SIGINT listener closes it; close() then resolves with the same shutdown.
      shutdown('SIGINT');
      await handle.close();
      expect(process.listeners('SIGINT')).not.toContain(shutdown);
    },
  };
}

const mcpAt = (port: number): string => `http://127.0.0.1:${port}/mcp`;

describe('stdio round-trip (built fixture via startBuiltServer, real SDK)', () => {
  it.each<ProtocolEra>(['legacy', 'modern'])('lists and calls the echo tool (%s era)', async (era) => {
    const srv = await startBuiltServer({ entry: fixture, nodeArgs: ['--import', tsxLoader], mode: 'stdio', era });
    try {
      expectEra(srv.client, era);
      await expectEchoRoundTrip(srv.client);
    } finally {
      await srv.stop();
    }
  });
});

describe('HTTP round-trip (built fixture via startBuiltServer, real SDK)', () => {
  it.each<ProtocolEra>(['legacy', 'modern'])(
    'lists and calls the echo tool with a Bearer key (%s era)',
    async (era) => {
      const srv = await startBuiltServer({ entry: fixture, nodeArgs: ['--import', tsxLoader], mode: 'http', era });
      try {
        expectEra(srv.client, era);
        await expectEchoRoundTrip(srv.client);
      } finally {
        await srv.stop();
      }
    },
  );
});

describe('in-memory round-trip (connectInMemory, real SDK)', () => {
  it.each<ProtocolEra>(['legacy', 'modern'])('lists and calls the echo tool (%s era)', async (era) => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const conn = await connectInMemory(buildEchoServer, { era });
    try {
      expectEra(conn.client, era);
      await expectEchoRoundTrip(conn.client);
    } finally {
      await conn.close();
      stderr.mockRestore();
    }
  });
});

describe('HTTP round-trip (in-process startMcpServer, real SDK)', () => {
  let open: RunningHttp;
  let keyed: RunningHttp;

  beforeAll(async () => {
    open = await startInProcessHttp({ MCP_AUTH_DISABLED: 'true' });
    keyed = await startInProcessHttp({}, 'right-key');
  });

  afterAll(async () => {
    await open?.stop();
    await keyed?.stop();
  });

  it('GET /health answers healthy without auth', async () => {
    const res = await rawHttp(`http://127.0.0.1:${keyed.port}/health`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ status: 'healthy' });
  });

  it.each<ProtocolEra>(['legacy', 'modern'])(
    'MCP_AUTH_DISABLED=true: lists and calls the echo tool (%s era)',
    async (era) => {
      const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const client = createTestClient({ era });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpAt(open.port))));
      try {
        expectEra(client, era);
        await expectEchoRoundTrip(client);
      } finally {
        await client.close();
        stderr.mockRestore();
      }
    },
  );

  it('a correct Bearer key gets through', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const client = createTestClient();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpAt(keyed.port)), {
        requestInit: { headers: { Authorization: 'Bearer right-key' } },
      }),
    );
    try {
      expect(await listToolNames(client)).toEqual(ECHO_TOOL_NAMES);
    } finally {
      await client.close();
      stderr.mockRestore();
    }
  });

  it('a wrong Bearer key is refused with 401 (client connect fails, raw request sees 401)', async () => {
    const client = createTestClient();
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(new URL(mcpAt(keyed.port)), {
          requestInit: { headers: { Authorization: 'Bearer wrong-key' } },
        }),
      ),
    ).rejects.toThrow();
    const raw = await rawHttp(mcpAt(keyed.port), {
      headers: mcpPostHeaders('wrong-key'),
      body: initializeRequestBody(),
    });
    expect(raw.status).toBe(401);
  });

  it('a legacy GET /mcp is answered 405 by the stateless SDK handler', async () => {
    const raw = await rawHttp(mcpAt(open.port), { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(raw.status).toBe(405);
  });
});

describe('HTTP Host/Origin allow-lists (real SDK validators)', () => {
  let guarded: RunningHttp;

  beforeAll(async () => {
    guarded = await startInProcessHttp({
      MCP_AUTH_DISABLED: 'true',
      MCP_ALLOWED_HOSTS: '127.0.0.1:1,localhost',
      MCP_ALLOWED_ORIGINS: 'http://localhost:3000',
    });
  });

  afterAll(async () => {
    await guarded?.stop();
  });

  // fetch() forbids overriding Host, so the Host rejection is driven with node:http.
  it('rejects a Host that is not allowed with 403', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((ok, fail) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: guarded.port,
          path: '/mcp',
          method: 'POST',
          headers: { ...mcpPostHeaders(), host: 'evil.example' },
        },
        (res) => {
          res.resume();
          res.on('end', () => ok(res.statusCode ?? 0));
        },
      );
      req.on('error', fail);
      req.end(initializeRequestBody());
    });
    expect(status).toBe(403);
  });

  it('matches an allowed Host port-agnostically (127.0.0.1:1 admits 127.0.0.1:<any port>)', async () => {
    const raw = await rawHttp(mcpAt(guarded.port), { headers: mcpPostHeaders(), body: initializeRequestBody() });
    expect(raw.status).toBe(200);
  });

  it('rejects a disallowed Origin with 403 and admits the allowed hostname on any port', async () => {
    const bad = await rawHttp(mcpAt(guarded.port), {
      headers: { ...mcpPostHeaders(), origin: 'https://evil.example' },
      body: initializeRequestBody(),
    });
    expect(bad.status).toBe(403);
    const good = await rawHttp(mcpAt(guarded.port), {
      headers: { ...mcpPostHeaders(), origin: 'http://localhost:5173' },
      body: initializeRequestBody(),
    });
    expect(good.status).toBe(200);
  });

  it('requests without an Origin header pass (non-browser clients)', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const client = createTestClient();
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpAt(guarded.port))));
    try {
      await expectEchoRoundTrip(client);
    } finally {
      await client.close();
      stderr.mockRestore();
    }
  });
});
