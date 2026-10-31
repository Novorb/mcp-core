import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { type Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type AuthInfo, LOG_LEVEL_META_KEY } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { disableProtocolLogging, protocolLoggingEnabled, toMcpLoggingLevel } from '../src/protocol-logging.js';
import { createMcpServer, requireScopes, TOOL_ANNOTATIONS } from '../src/server.js';
import { connectInMemory, createTestClient, freePort, type ProtocolEra } from '../src/testing/index.js';
import { defineTool, registerTools, toolResult } from '../src/tools.js';
import { type RequestContext, startMcpServer, type TransportHandle } from '../src/transport.js';
import { addLogListener, initLogger, LogLevel, registerSecretValues, resetLogger } from '../src/utils/logger.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({
    name: 'protocol-test',
    fileMain: false,
    fileExceptions: false,
    fileDebug: false,
    level: LogLevel.DEBUG,
  });
});

afterEach(() => {
  stderr.mockRestore();
  disableProtocolLogging();
  resetLogger();
  delete process.env.LOG_PROTOCOL;
});

const SECRET = 'sk-live-0123456789';
const seenAuth: Array<AuthInfo | undefined> = [];
const factoryAuth: Array<AuthInfo | undefined> = [];

function buildServer(protocolLogging?: boolean) {
  return (req?: RequestContext) => {
    factoryAuth.push(req?.authInfo);
    const server = createMcpServer('features', '1.0.0', protocolLogging !== undefined ? { protocolLogging } : {});
    registerTools(server, [
      defineTool({
        name: 'work',
        description: 'logs and reports progress',
        inputSchema: z.object({ text: z.string() }),
        annotations: TOOL_ANNOTATIONS.readOnly,
        handler: async ({ text }, ctx) => {
          seenAuth.push(ctx.authInfo);
          ctx.logger.debug('debug detail', 'Work');
          ctx.logger.info(`working with ${SECRET}`, 'Work', { apiToken: SECRET, n: 1 });
          ctx.logger.error('something failed', 'Work');
          await ctx.progress(1, 2, 'half');
          await ctx.progress(2, 2);
          return toolResult(`done ${text.length}`);
        },
      }),
      defineTool({
        name: 'write_thing',
        description: 'needs the write scope',
        inputSchema: z.object({}),
        annotations: TOOL_ANNOTATIONS.mutableWrite,
        scopeChallenge: requireScopes('write'),
        handler: async () => toolResult('written'),
      }),
      defineTool({
        name: 'read_thing',
        description: 'needs the read scope',
        inputSchema: z.object({}),
        annotations: TOOL_ANNOTATIONS.readOnly,
        scopeChallenge: requireScopes('read'),
        handler: async () => toolResult('read'),
      }),
    ]);
    return server;
  };
}

interface LogMessage {
  level: string;
  logger?: string;
  data: { message: string; context: string; meta?: unknown };
}

function collectLogs(client: Client): LogMessage[] {
  const out: LogMessage[] = [];
  client.setNotificationHandler('notifications/message', (n) => {
    out.push(n.params as unknown as LogMessage);
  });
  return out;
}

describe('protocol logging (notifications/message)', () => {
  beforeEach(() => registerSecretValues([SECRET]));

  it('stdio/in-memory 2025 era: forwards masked entries, honours logging/setLevel, never tool values', async () => {
    const conn = await connectInMemory(buildServer(true), { era: 'legacy' });
    const logs = collectLogs(conn.client);
    try {
      expect(conn.client.getServerCapabilities()?.logging).toEqual({});
      await conn.client.setLoggingLevel('info');
      await conn.client.callTool({ name: 'work', arguments: { text: 'private input value' } });
      const all = JSON.stringify(logs);
      expect(logs.map((l) => l.level)).toEqual(expect.arrayContaining(['info', 'error']));
      expect(logs.some((l) => l.level === 'debug')).toBe(false);
      expect(all).toContain('working with [SECRET]');
      expect(all).not.toContain(SECRET);
      expect(all).toContain('"apiToken":"[REDACTED]"');
      expect(all).toContain('Tool call: work');
      expect(all).not.toContain('private input value');
      expect(logs[0]?.logger).toBe('protocol-test');

      logs.length = 0;
      await conn.client.setLoggingLevel('error');
      await conn.client.callTool({ name: 'work', arguments: { text: 'x' } });
      expect(logs.map((l) => l.level)).toEqual(['error']);
    } finally {
      await conn.close();
    }
  });

  it('2026-07-28 era: only with the per-request log level in _meta, at or above it', async () => {
    const conn = await connectInMemory(buildServer(true), { era: 'modern' });
    const logs = collectLogs(conn.client);
    try {
      await conn.client.callTool({ name: 'work', arguments: { text: 'x' } });
      expect(logs).toEqual([]);
      await conn.client.callTool({ name: 'work', arguments: { text: 'x' }, _meta: { [LOG_LEVEL_META_KEY]: 'error' } });
      expect(logs.map((l) => l.level)).toEqual(['error']);
      expect(JSON.stringify(logs)).not.toContain(SECRET);
    } finally {
      await conn.close();
    }
  });

  it('off by default: no logging capability and no messages; LOG_PROTOCOL switches it on', async () => {
    const conn = await connectInMemory(buildServer(), { era: 'legacy' });
    const logs = collectLogs(conn.client);
    try {
      expect(conn.client.getServerCapabilities()?.logging).toBeUndefined();
      await conn.client.callTool({ name: 'work', arguments: { text: 'x' } });
      expect(logs).toEqual([]);
    } finally {
      await conn.close();
    }
    process.env.LOG_PROTOCOL = 'true';
    expect(protocolLoggingEnabled()).toBe(true);
    expect(protocolLoggingEnabled(false)).toBe(false);
    expect(protocolLoggingEnabled(undefined, { LOG_PROTOCOL: 'nope' })).toBe(false);
    const viaEnv = await connectInMemory(buildServer(), { era: 'legacy' });
    try {
      expect(viaEnv.client.getServerCapabilities()?.logging).toEqual({});
    } finally {
      await viaEnv.close();
    }
  });

  it('maps the levels and leaves logging outside a request alone; listeners never break logging', () => {
    expect([LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR].map(toMcpLoggingLevel)).toEqual([
      'debug',
      'info',
      'warning',
      'error',
    ]);
    const entries: unknown[] = [];
    const off = addLogListener((e) => {
      entries.push(e);
      throw new Error('listener bug');
    });
    initLogger({ name: 'protocol-test', fileMain: false, fileExceptions: false, fileDebug: false });
    expect(() => initLogger().info('outside a request')).not.toThrow();
    off();
    initLogger().info('after unsubscribe');
    expect(entries).toHaveLength(1);
  });
});

async function startHttp(apiKey: string | null, scopes?: string[]): Promise<{ port: number; handle: TransportHandle }> {
  const port = await freePort();
  const handle = await startMcpServer(buildServer(true), {
    mode: 'http',
    port,
    host: '127.0.0.1',
    apiKey,
    ...(scopes ? { auth: { apiKey: { clientId: 'api-key-client', scopes } } } : {}),
    handleSignals: false,
  });
  return { port, handle };
}

async function connect(port: number, era: ProtocolEra, key?: string): Promise<Client> {
  const client = createTestClient({ era });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      ...(key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : {}),
    }),
  );
  return client;
}

describe('progress and logging over stateless HTTP (responseMode auto)', () => {
  it.each<ProtocolEra>(['legacy', 'modern'])('progress notifications reach the client (%s era)', async (era) => {
    const { port, handle } = await startHttp(null);
    const client = await connect(port, era);
    try {
      const progress: Array<{ progress: number; total?: number; message?: string }> = [];
      const r = await client.callTool(
        { name: 'work', arguments: { text: 'abc' } },
        { onprogress: (p) => progress.push(p) },
      );
      expect(r.content).toEqual([{ type: 'text', text: 'done 3' }]);
      expect(progress).toEqual([
        { progress: 1, total: 2, message: 'half' },
        { progress: 2, total: 2 },
      ]);
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('2025-era stateless HTTP sends every level (logging/setLevel is not kept across requests)', async () => {
    registerSecretValues([SECRET]);
    const { port, handle } = await startHttp(null);
    const client = await connect(port, 'legacy');
    const logs = collectLogs(client);
    try {
      await client.setLoggingLevel('error');
      await client.callTool({ name: 'work', arguments: { text: 'x' } });
      expect(logs.map((l) => l.level)).toEqual(expect.arrayContaining(['debug', 'info', 'error']));
      expect(JSON.stringify(logs)).not.toContain(SECRET);
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

describe('AuthInfo and scope challenges over HTTP (end to end)', () => {
  it.each<ProtocolEra>(['legacy', 'modern'])(
    'the API key yields an AuthInfo for the factory and handlers; requireScopes gates per tool (%s era)',
    async (era) => {
      seenAuth.length = 0;
      factoryAuth.length = 0;
      const { port, handle } = await startHttp('scoped-key-123456', ['read']);
      const client = await connect(port, era, 'scoped-key-123456');
      try {
        expect((await client.callTool({ name: 'read_thing', arguments: {} })).content).toEqual([
          { type: 'text', text: 'read' },
        ]);
        await expect(client.callTool({ name: 'write_thing', arguments: {} })).rejects.toThrow(/403|scope/i);
        await client.callTool({ name: 'work', arguments: { text: 'x' } });
        expect(seenAuth.at(-1)).toMatchObject({ token: '[api-key]', clientId: 'api-key-client', scopes: ['read'] });
        expect(factoryAuth.some((a) => a?.clientId === 'api-key-client')).toBe(true);
        expect(JSON.stringify([...seenAuth, ...factoryAuth])).not.toContain('scoped-key-123456');
      } finally {
        await client.close();
        await handle.close();
      }
    },
  );
});
