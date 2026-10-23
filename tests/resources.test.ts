import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { type Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { createNotifier, InMemoryServerEventBus } from '../src/notifications.js';
import {
  blobContents,
  createResultSpill,
  defineResource,
  embeddedResource,
  normalizeReadOutcome,
  registerResources,
  resourceLink,
  textContents,
} from '../src/resources.js';
import { createMcpServer, ProtocolError, ProtocolErrorCode, requireScopes } from '../src/server.js';
import { InMemoryTaskStore } from '../src/task-store.js';
import { connectInMemory, createTestClient, type ProtocolEra } from '../src/testing/index.js';
import { defineTool, registerTools, toolResult } from '../src/tools.js';
import { startMcpServer } from '../src/transport.js';
import { loadEnv } from '../src/utils/envLoader.js';
import { addLogListener, initLogger, type LogEntry, registerSecretValues, resetLogger } from '../src/utils/logger.js';
import { buildC2Server, type C2Shared, createC2Shared } from './fixtures/c2-tools.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;
let shared: C2Shared;
let entries: LogEntry[];
let unlisten: () => void;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'resources-test', fileMain: false, fileExceptions: false, fileDebug: false });
  entries = [];
  unlisten = addLogListener((e) => entries.push(e));
  shared = createC2Shared(new InMemoryTaskStore(), createNotifier(new InMemoryServerEventBus()));
});

afterEach(() => {
  unlisten();
  shared.store.close();
  stderr.mockRestore();
  resetLogger();
});

const ERAS: ProtocolEra[] = ['legacy', 'modern'];

async function withClient<T>(era: ProtocolEra, fn: (client: Client) => Promise<T>): Promise<T> {
  const conn = await connectInMemory((req) => buildC2Server(shared, req), { era });
  try {
    return await fn(conn.client);
  } finally {
    await conn.close();
  }
}

describe('registerResources', () => {
  it.each(ERAS)('lists static, template-enumerated and template resources (%s)', async (era) => {
    await withClient(era, async (client) => {
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toEqual([
        'docs://readme',
        'docs://files/readme.md',
        'docs://files/notes.txt',
      ]);
      expect(resources[0]).toMatchObject({ name: 'readme', title: 'Readme', mimeType: 'text/markdown' });
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['docs://files/{path}', 'mcp-core://results/{id}']);
    });
  });

  it.each(ERAS)('reads a static resource and a template with the shorthand text result (%s)', async (era) => {
    await withClient(era, async (client) => {
      const readme = await client.readResource({ uri: 'docs://readme' });
      expect(readme.contents).toEqual([{ uri: 'docs://readme', text: '# Readme\nhello', mimeType: 'text/markdown' }]);
      const file = await client.readResource({ uri: 'docs://files/notes.txt' });
      expect(file.contents[0]).toMatchObject({ text: 'some notes', mimeType: 'text/plain' });
    });
    const lines = entries.map((e) => e.message);
    expect(lines).toContain('Resource read: docs://files/{path}');
    expect(lines).toContain('Resource result: docs://files/{path}');
    // Never the filled-in URI, never the content.
    expect(lines.some((l) => l.includes('notes.txt') || l.includes('some notes'))).toBe(false);
  });

  it.each(ERAS)('maps a thrown error to a masked JSON-RPC error (%s)', async (era) => {
    registerSecretValues(['missing-doc-secret-xyz']);
    await withClient(era, async (client) => {
      await expect(client.readResource({ uri: 'docs://files/missing-doc-secret-xyz' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InternalError,
        message: expect.stringContaining('no such document: [SECRET]'),
      });
      await expect(client.readResource({ uri: 'docs://nothing' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
      });
    });
  });

  it.each(ERAS)('completes template variables (%s)', async (era) => {
    await withClient(era, async (client) => {
      const res = await client.complete({
        ref: { type: 'ref/resource', uri: 'docs://files/{path}' },
        argument: { name: 'path', value: 'no' },
      });
      expect(res.completion.values).toEqual(['notes.txt']);
    });
  });

  it('caps a read by size, answers degraded mode and refuses undeclared requires', async () => {
    const env = loadEnv([{ key: 'DOCS_TOKEN', secret: true }], { rootDir: process.cwd(), env: {} });
    const factory = () => {
      const server = createMcpServer('caps', '1.0.0');
      registerResources(
        server,
        [
          defineResource({ name: 'big', uri: 'x://big', maxBytes: 10, read: async () => 'x'.repeat(11) }),
          defineResource({
            name: 'blob',
            uri: 'x://blob',
            mimeType: 'application/octet-stream',
            read: async () => new Uint8Array([1, 2]),
          }),
          defineResource({ name: 'locked', uri: 'x://locked', requires: ['DOCS_TOKEN'], read: async () => 'never' }),
          defineResource({
            name: 'proto',
            uri: 'x://proto',
            read: async () => {
              throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad range');
            },
          }),
          defineResource({
            name: 'scoped',
            uri: 'x://scoped',
            scopeChallenge: requireScopes('docs'),
            read: async () => 'ok',
          }),
        ],
        { env, serverName: 'caps-mcp', enabled: ['big', 'blob', 'locked', 'proto'] },
      );
      return server;
    };
    const conn = await connectInMemory(factory);
    try {
      await expect(conn.client.readResource({ uri: 'x://big' })).rejects.toMatchObject({
        message: expect.stringContaining('big: the resource is 11 bytes, over the 10 byte limit'),
      });
      const blob = await conn.client.readResource({ uri: 'x://blob' });
      expect(blob.contents[0]).toMatchObject({ blob: 'AQI=', mimeType: 'application/octet-stream' });
      await expect(conn.client.readResource({ uri: 'x://locked' })).rejects.toMatchObject({
        message: expect.stringContaining('caps-mcp is not configured: set DOCS_TOKEN'),
      });
      await expect(conn.client.readResource({ uri: 'x://proto' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringContaining('bad range'),
      });
      const { resources } = await conn.client.listResources();
      expect(resources.map((r) => r.name)).toEqual(['big', 'blob', 'locked', 'proto']);
    } finally {
      await conn.close();
    }
    const server = createMcpServer('x', '1.0.0');
    expect(() =>
      registerResources(
        server,
        [defineResource({ name: 'a', uri: 'x://a', requires: ['NOPE'], read: async () => '' })],
        {
          env,
        },
      ),
    ).toThrow(/does not declare/);
    expect(() =>
      registerResources(server, [
        defineResource({ name: 'a', uri: 'x://a', requires: ['NOPE'], read: async () => '' }),
      ]),
    ).toThrow(/no env was passed/);
  });

  it('pages resources/list with the C1 list pagination', async () => {
    const factory = () => {
      const server = createMcpServer('paged', '1.0.0', { listPageSize: 2 });
      registerResources(
        server,
        [1, 2, 3, 4, 5].map((i) => defineResource({ name: `r${i}`, uri: `x://r${i}`, read: async () => String(i) })),
      );
      return server;
    };
    const conn = await connectInMemory(factory, { era: 'modern' });
    try {
      const first = await conn.client.listResources({ cursor: undefined });
      expect(first.resources).toHaveLength(5);
    } finally {
      await conn.close();
    }
  });
});

describe('resource helpers', () => {
  it('builds contents, links and embedded resources, and normalises outcomes', () => {
    expect(textContents('a://b', 't')).toEqual({ uri: 'a://b', text: 't' });
    expect(blobContents('a://b', new Uint8Array([255]), 'image/png')).toEqual({
      uri: 'a://b',
      blob: '/w==',
      mimeType: 'image/png',
    });
    expect(resourceLink({ uri: 'a://b', name: 'b' })).toEqual({ type: 'resource_link', uri: 'a://b', name: 'b' });
    expect(embeddedResource({ uri: 'a://b', text: 't' })).toEqual({
      type: 'resource',
      resource: { uri: 'a://b', text: 't' },
    });
    expect(normalizeReadOutcome({ contents: [{ uri: 'a://b', text: 't' }] }, 'a://b', 'text/plain')).toEqual({
      contents: [{ uri: 'a://b', text: 't', mimeType: 'text/plain' }],
    });
    const keep = { contents: [{ uri: 'a://b', text: 't', mimeType: 'x/y' }] };
    expect(normalizeReadOutcome(keep, 'a://b', 'text/plain')).toEqual(keep);
    expect(normalizeReadOutcome(keep, 'a://b')).toBe(keep);
    const ir = { resultType: 'input_required' as const, requestState: 's' };
    expect(normalizeReadOutcome(ir, 'a://b')).toBe(ir);
  });

  it.each(ERAS)('tool results point at resources with resource_link (%s)', async (era) => {
    await withClient(era, async (client) => {
      const res = await client.callTool({ name: 'link_doc', arguments: { path: 'notes.txt' } });
      expect(res.content).toEqual([
        { type: 'resource_link', uri: 'docs://files/notes.txt', name: 'notes.txt', mimeType: 'text/plain' },
      ]);
    });
  });
});

describe('createResultSpill (onOversize -> resource link)', () => {
  it.each(ERAS)('spills an oversized result and serves it as a resource (%s)', async (era) => {
    await withClient(era, async (client) => {
      const res = await client.callTool({ name: 'big_report', arguments: { size: 5000 } });
      expect(res.isError).toBeUndefined();
      const link = (res.content as Array<{ type: string; uri?: string }>).find((b) => b.type === 'resource_link');
      expect(link?.uri).toMatch(/^mcp-core:\/\/results\//);
      const read = await client.readResource({ uri: String(link?.uri) });
      expect(JSON.parse(String(read.contents[0]?.text))).toEqual({ blob: 'x'.repeat(5000) });
      await expect(client.readResource({ uri: 'mcp-core://results/unknown' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
      });
    });
  });

  it('binds entries to the caller, expires them, evicts the oldest and refuses huge ones', async () => {
    let now = 1000;
    const spill = createResultSpill({ ttlMs: 100, maxEntries: 2, maxBytes: 50, now: () => now });
    const result = { content: [{ type: 'text' as const, text: 'y' }], structuredContent: { a: 1 } };
    const owned = spill.onOversize({
      tool: 't',
      bytes: 9,
      maxBytes: 1,
      result,
      authInfo: { token: 'x', clientId: 'alice', scopes: [] },
    });
    const uriOf = (r: typeof owned): string =>
      String((r?.content.find((b) => b.type === 'resource_link') as { uri: string } | undefined)?.uri);
    const id = uriOf(owned).split('/').pop() ?? '';
    const read = (clientId?: string) =>
      spill.resource.read({
        name: 'tool-result',
        uri: new URL(uriOf(owned)),
        variables: { id },
        signal: new AbortController().signal,
        logger: undefined as never,
        ...(clientId ? { authInfo: { token: 'x', clientId, scopes: [] } } : {}),
      });
    await expect(read('alice')).resolves.toBe('{"a":1}');
    await expect(read('bob')).rejects.toThrow(/not found or expired/);
    await expect(read()).rejects.toThrow(/not found or expired/);
    now += 200;
    await expect(read('alice')).rejects.toThrow(/not found or expired/);
    expect(
      spill.onOversize({
        tool: 't',
        bytes: 9,
        maxBytes: 1,
        result: { content: [{ type: 'text', text: 'z'.repeat(60) }] },
      }),
    ).toBeUndefined();
    spill.onOversize({ tool: 't', bytes: 9, maxBytes: 1, result });
    spill.onOversize({ tool: 't', bytes: 9, maxBytes: 1, result });
    spill.onOversize({ tool: 't', bytes: 9, maxBytes: 1, result });
    spill.clear();
  });

  it('keeps the spilled results under a total byte budget, dropping the oldest first', async () => {
    const spill = createResultSpill({ maxEntries: 100, maxBytes: 40, maxTotalBytes: 50 });
    const spillOf = (text: string) =>
      spill.onOversize({ tool: 't', bytes: 99, maxBytes: 1, result: { content: [], structuredContent: { text } } });
    const readable = async (r: ReturnType<typeof spillOf>): Promise<boolean> => {
      const uri = String((r?.content.find((b) => b.type === 'resource_link') as { uri: string } | undefined)?.uri);
      return spill.resource
        .read({
          name: 'tool-result',
          uri: new URL(uri),
          variables: { id: uri.split('/').pop() ?? '' },
          signal: new AbortController().signal,
          logger: undefined as never,
        })
        .then(
          () => true,
          () => false,
        );
    };
    // Each payload serialises to 21 bytes ({"text":"aaaaaaaaaa"}): two fit in 50, a third evicts the first.
    const first = spillOf('a'.repeat(10));
    const second = spillOf('b'.repeat(10));
    expect(await readable(first)).toBe(true);
    const third = spillOf('c'.repeat(10));
    expect(await readable(first)).toBe(false);
    expect(await readable(second)).toBe(true);
    expect(await readable(third)).toBe(true);
    spill.clear();
    expect(await readable(third)).toBe(false);
    expect(spillOf('d'.repeat(10))).toBeDefined();
  });
});

describe('runtime surface over per-request HTTP instances', () => {
  it.each(ERAS)('releases every instance subscription once its request is answered (%s)', async (era) => {
    const surface = (await import('../src/notifications.js')).createRuntimeSurface(
      createNotifier(new InMemoryServerEventBus()),
    );
    let active = 0;
    const subscribe = surface.subscribe.bind(surface);
    surface.subscribe = (listener) => {
      active++;
      const unsubscribe = subscribe(listener);
      let released = false;
      return () => {
        if (!released) active--;
        released = true;
        unsubscribe();
      };
    };
    shared.surface = surface;
    const handle = await startMcpServer((req) => buildC2Server(shared, req), {
      mode: 'http',
      port: 0,
      host: '127.0.0.1',
      apiKey: null,
      handleSignals: false,
      bus: new InMemoryServerEventBus(),
    });
    const client = createTestClient({ era });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(String(handle.url))));
      for (let i = 0; i < 5; i++) await client.listTools();
      await client.callTool({ name: 'edit_doc', arguments: { path: 'notes.txt', text: 'v2' } });
      for (let i = 0; i < 50 && active > 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(active).toBe(0);
    } finally {
      await client.close().catch(() => undefined);
      await handle.close();
    }
  });
});

describe('subscriptions and change notifications', () => {
  it('2025 stdio: resources/subscribe filters resources/updated; list_changed reaches the client', async () => {
    const updated: string[] = [];
    const toolsChanged: number[] = [];
    const bus = new InMemoryServerEventBus();
    shared = createC2Shared(new InMemoryTaskStore(), createNotifier(bus));
    const conn = await connectInMemory((req) => buildC2Server(shared, req), { bus });
    try {
      conn.client.setNotificationHandler('notifications/tools/list_changed', () => {
        toolsChanged.push(1);
      });
      expect(conn.client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true });
      conn.client.setNotificationHandler('notifications/resources/updated', (n) => {
        updated.push(n.params.uri);
      });
      await conn.client.subscribeResource({ uri: 'docs://files/notes.txt' });
      await conn.client.callTool({ name: 'edit_doc', arguments: { path: 'notes.txt', text: 'v2' } });
      await conn.client.callTool({ name: 'edit_doc', arguments: { path: 'readme.md', text: 'v2' } });
      await conn.client.unsubscribeResource({ uri: 'docs://files/notes.txt' });
      await conn.client.callTool({ name: 'edit_doc', arguments: { path: 'notes.txt', text: 'v3' } });
      await new Promise((r) => setTimeout(r, 50));
      expect(updated).toEqual(['docs://files/notes.txt']);

      await conn.client.callTool({ name: 'toggle', arguments: { enabled: false } });
      await new Promise((r) => setTimeout(r, 50));
      expect(toolsChanged.length).toBeGreaterThanOrEqual(1);
      const { tools } = await conn.client.listTools();
      expect(tools.map((t) => t.name)).not.toContain('optional_tool');
      const call = await conn.client.callTool({ name: 'optional_tool', arguments: {} }).catch((e: unknown) => e);
      expect(call).toMatchObject({ code: ProtocolErrorCode.InvalidParams });
      await conn.client.callTool({ name: 'toggle', arguments: { enabled: true } });
      expect((await conn.client.listTools()).tools.map((t) => t.name)).toContain('optional_tool');
    } finally {
      await conn.close();
    }
  });

  it('2026-07-28 HTTP: subscriptions/listen streams receive bus events', async () => {
    const handle = await startMcpServer((req) => buildC2Server(shared, req), {
      mode: 'http',
      port: 0,
      host: '127.0.0.1',
      apiKey: null,
      handleSignals: false,
      bus: new InMemoryServerEventBus(),
    });
    shared.notify = handle.notify;
    shared.surface = (await import('../src/notifications.js')).createRuntimeSurface(handle.notify);
    const client = createTestClient({ era: 'modern' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(String(handle.url))));
      const seen: string[] = [];
      client.setNotificationHandler('notifications/resources/updated', (n) => {
        seen.push(`updated:${n.params.uri}`);
      });
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        seen.push('tools');
      });
      const sub = await client.listen({ toolsListChanged: true, resourceSubscriptions: ['docs://files/notes.txt'] });
      expect(sub.honoredFilter).toMatchObject({
        toolsListChanged: true,
        resourceSubscriptions: ['docs://files/notes.txt'],
      });
      await client.callTool({ name: 'edit_doc', arguments: { path: 'notes.txt', text: 'v2' } });
      await client.callTool({ name: 'edit_doc', arguments: { path: 'readme.md', text: 'v2' } });
      await client.callTool({ name: 'toggle', arguments: { enabled: false } });
      for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual(['updated:docs://files/notes.txt', 'tools']);
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('optional_tool');
      await sub.close();
    } finally {
      await client.close().catch(() => undefined);
      await handle.close();
    }
  });

  it('2025 stateless HTTP: subscribe is not advertised (no delivery channel)', async () => {
    const handle = await startMcpServer((req) => buildC2Server(shared, req), {
      mode: 'http',
      port: 0,
      host: '127.0.0.1',
      apiKey: null,
      handleSignals: false,
    });
    const client = createTestClient({ era: 'legacy' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(String(handle.url))));
      expect(client.getServerCapabilities()?.resources?.subscribe).toBeUndefined();
    } finally {
      await client.close().catch(() => undefined);
      await handle.close();
    }
  });
});

describe('registerResources metadata passthrough', () => {
  it('hands scopeChallenge, cacheHint and the metadata to the SDK registration', () => {
    const server = createMcpServer('scoped', '1.0.0');
    const gate = requireScopes('docs');
    const handles = registerResources(server, [
      defineResource({
        name: 'scoped',
        uri: 'x://scoped',
        description: 'd',
        size: 2,
        annotations: { audience: ['user'] },
        icons: [{ src: 'https://example.com/i.png' }],
        _meta: { k: 1 },
        cacheHint: { ttlMs: 1000 },
        scopeChallenge: gate,
        read: async () => 'ok',
      }),
    ]);
    const handle = handles.get('scoped') as { scopeChallenge?: unknown; cacheHint?: unknown; metadata?: unknown };
    expect(handle.scopeChallenge).toBe(gate);
    expect(handle.cacheHint).toEqual({ ttlMs: 1000 });
    expect(handle.metadata).toMatchObject({ description: 'd', size: 2, _meta: { k: 1 } });
    registerTools(server, [
      defineTool({
        name: 'noop',
        description: 'noop',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
        handler: async () => toolResult('ok'),
      }),
    ]);
  });
});
