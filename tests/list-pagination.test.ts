import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { DEFAULT_LIST_PAGE_SIZE, resolveLimits } from '../src/limits.js';
import { pageListResult, paginateLists } from '../src/list-pagination.js';
import { encodeCursor } from '../src/pagination.js';
import {
  createMcpServer,
  DEFAULT_CACHE_HINTS,
  McpServer,
  ProtocolErrorCode,
  Server,
  TOOL_ANNOTATIONS,
} from '../src/server.js';
import { connectInMemory, createTestClient, freePort, type ProtocolEra } from '../src/testing/index.js';
import { defineTool, registerTools, toolResult } from '../src/tools.js';
import { startMcpServer } from '../src/transport.js';
import { initLogger, resetLogger } from '../src/utils/logger.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'list-test', fileMain: false, fileExceptions: false, fileDebug: false });
});

afterEach(() => {
  stderr.mockRestore();
  resetLogger();
  delete process.env.MCP_LIST_PAGE_SIZE;
});

const NAMES = Array.from({ length: 7 }, (_v, i) => `tool_${i}`);

function buildServer(listPageSize?: number) {
  return () => {
    const server = createMcpServer('lists', '1.0.0', listPageSize !== undefined ? { listPageSize } : {});
    registerTools(
      server,
      NAMES.map((name) =>
        defineTool({
          name,
          description: name,
          inputSchema: z.object({}),
          annotations: TOOL_ANNOTATIONS.readOnly,
          handler: async () => toolResult(name),
        }),
      ),
    );
    return server;
  };
}

describe.each<ProtocolEra>(['legacy', 'modern'])('tools/list pagination in memory (%s era)', (era) => {
  it('the SDK client follows nextCursor: listTools() aggregates every page', async () => {
    const conn = await connectInMemory(buildServer(3), { era });
    try {
      expect((await conn.client.listTools()).tools.map((t) => t.name)).toEqual(NAMES);
    } finally {
      await conn.close();
    }
  });

  it('one page per explicit cursor, with a nextCursor until the last page', async () => {
    const conn = await connectInMemory(buildServer(3), { era });
    try {
      const first = await conn.client.request({ method: 'tools/list', params: {} });
      expect(first.tools.map((t) => t.name)).toEqual(['tool_0', 'tool_1', 'tool_2']);
      expect(first.nextCursor).toBe(encodeCursor({ l: 'tools/list', o: 3 }));
      const second = await conn.client.listTools({ cursor: encodeCursor({ l: 'tools/list', o: 3 }) });
      expect(second.tools.map((t) => t.name)).toEqual(['tool_3', 'tool_4', 'tool_5']);
      expect(typeof second.nextCursor).toBe('string');
      const last = await conn.client.listTools({ cursor: second.nextCursor });
      expect(last.tools.map((t) => t.name)).toEqual(['tool_6']);
      expect(last.nextCursor).toBeUndefined();
    } finally {
      await conn.close();
    }
  });

  it('a malformed, foreign-method or out-of-range cursor answers -32602', async () => {
    const conn = await connectInMemory(buildServer(3), { era });
    try {
      for (const cursor of [
        'not a cursor!',
        encodeCursor({ l: 'prompts/list', o: 3 }),
        encodeCursor({ l: 'tools/list', o: 99 }),
        encodeCursor({ l: 'tools/list', o: 0 }),
      ]) {
        await expect(conn.client.listTools({ cursor })).rejects.toMatchObject({
          code: ProtocolErrorCode.InvalidParams,
        });
      }
    } finally {
      await conn.close();
    }
  });

  it('the default page size (100) serves a 7-tool server on one page; 0 disables paging', async () => {
    for (const size of [undefined, 0]) {
      const conn = await connectInMemory(buildServer(size), { era });
      try {
        const first = await conn.client.request({ method: 'tools/list', params: {} });
        expect(first.tools).toHaveLength(7);
        expect(first.nextCursor).toBeUndefined();
      } finally {
        await conn.close();
      }
    }
  });
});

describe('tools/list pagination over stateless HTTP', () => {
  it.each<ProtocolEra>(['legacy', 'modern'])('the SDK client walks every page (%s era)', async (era) => {
    const port = await freePort();
    const handle = await startMcpServer(buildServer(2), {
      mode: 'http',
      port,
      host: '127.0.0.1',
      apiKey: null,
      handleSignals: false,
    });
    const client = createTestClient({ era });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(NAMES);
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

describe('list pagination configuration', () => {
  it('MCP_LIST_PAGE_SIZE sets the default; invalid values fall back; the option wins', () => {
    expect(resolveLimits({}, {}).listPageSize).toBe(DEFAULT_LIST_PAGE_SIZE);
    expect(resolveLimits({}, { MCP_LIST_PAGE_SIZE: '5' }).listPageSize).toBe(5);
    expect(resolveLimits({}, { MCP_LIST_PAGE_SIZE: '0' }).listPageSize).toBe(0);
    expect(resolveLimits({}, { MCP_LIST_PAGE_SIZE: 'lots' }).listPageSize).toBe(DEFAULT_LIST_PAGE_SIZE);
    expect(resolveLimits({}, { MCP_LIST_PAGE_SIZE: '-1' }).listPageSize).toBe(DEFAULT_LIST_PAGE_SIZE);
    expect(resolveLimits({ listPageSize: 9 }, { MCP_LIST_PAGE_SIZE: '5' }).listPageSize).toBe(9);
  });

  it('the env page size reaches createMcpServer', async () => {
    process.env.MCP_LIST_PAGE_SIZE = '4';
    const conn = await connectInMemory(buildServer());
    try {
      const first = await conn.client.listTools({ cursor: encodeCursor({ l: 'tools/list', o: 4 }) });
      expect(first.tools).toHaveLength(3);
    } finally {
      await conn.close();
    }
  });

  it('pageListResult leaves a self-paginated or non-list result alone; paginateLists is idempotent', () => {
    const own = { tools: [1, 2, 3], nextCursor: 'theirs' };
    expect(pageListResult('tools/list', own, undefined, 1)).toBe(own);
    const odd = { tools: 'not a list' };
    expect(pageListResult('tools/list', odd, undefined, 1)).toBe(odd);
    expect(() => pageListResult('tools/list', { tools: [1, 2] }, 7, 1)).toThrow(/not a string/);
    const server = new Server({ name: 'low', version: '1.0.0' }, { capabilities: { tools: {} } });
    paginateLists(server, 2);
    paginateLists(server, 2);
    paginateLists(server, 0);
    expect(typeof server.setRequestHandler).toBe('function');
  });

  it('a low-level Server list handler is paged too; other handlers pass through', async () => {
    const factory = () => {
      const server = new Server({ name: 'low', version: '1.0.0' }, { capabilities: { tools: {} } });
      paginateLists(server, 2);
      server.setRequestHandler('tools/list', () => ({
        tools: ['a', 'b', 'c'].map((name) => ({ name, inputSchema: { type: 'object' as const } })),
      }));
      server.setRequestHandler('tools/call', () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
      return server;
    };
    const conn = await connectInMemory(factory);
    try {
      expect((await conn.client.listTools()).tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
      expect((await conn.client.callTool({ name: 'a', arguments: {} })).content).toEqual([
        { type: 'text', text: 'ok' },
      ]);
    } finally {
      await conn.close();
    }
  });
});

describe('createMcpServer options', () => {
  it('passes the full Implementation, instructions and capabilities through to the client', async () => {
    const conn = await connectInMemory(() =>
      createMcpServer(
        {
          name: 'rich',
          version: '2.0.0',
          title: 'Rich Server',
          description: 'Does things',
          websiteUrl: 'https://example.com',
        },
        { instructions: 'Call list first.', capabilities: { tools: { listChanged: false } } },
      ),
    );
    try {
      expect(conn.client.getServerVersion()).toMatchObject({
        name: 'rich',
        version: '2.0.0',
        title: 'Rich Server',
        description: 'Does things',
        websiteUrl: 'https://example.com',
      });
      expect(conn.client.getInstructions()).toBe('Call list first.');
      expect(conn.client.getServerCapabilities()?.tools).toEqual({ listChanged: false });
      expect(conn.client.getServerCapabilities()?.logging).toBeUndefined();
    } finally {
      await conn.close();
    }
  });

  it('defaults: tools/list cache hint (private, 5 min) and maxToolInputElements; invalid hints throw', async () => {
    expect(DEFAULT_CACHE_HINTS['tools/list']).toEqual({ ttlMs: 300_000, cacheScope: 'private' });
    expect(() => createMcpServer('x', '1', { cacheHints: { 'tools/list': { ttlMs: -1 } } })).toThrow(RangeError);
    const factory = () => {
      const server = createMcpServer('inputs', '1.0.0', { maxToolInputElements: 5 });
      registerTools(server, [
        defineTool({
          name: 'sum',
          description: 'sum',
          inputSchema: z.object({ values: z.array(z.number()) }),
          annotations: TOOL_ANNOTATIONS.readOnly,
          handler: async ({ values }) => toolResult(String(values.reduce((a, b) => a + b, 0))),
        }),
      ]);
      return server;
    };
    const conn = await connectInMemory(factory, { era: 'modern' });
    try {
      const listed = await conn.client.request({ method: 'tools/list', params: {} });
      expect(listed).toMatchObject({ ttlMs: 300_000, cacheScope: 'private' });
      expect((await conn.client.callTool({ name: 'sum', arguments: { values: [1, 2] } })).content).toEqual([
        { type: 'text', text: '3' },
      ]);
      const big = await conn.client.callTool({ name: 'sum', arguments: { values: [1, 2, 3, 4, 5, 6] } });
      expect(big.isError).toBe(true);
      expect(JSON.stringify(big.content)).toContain('maximum of 5 elements');
    } finally {
      await conn.close();
    }
  });

  it('a list capability passed in options is registered after the paging hook (still paged)', async () => {
    const conn = await connectInMemory(() => {
      const server = createMcpServer('caps', '1.0.0', { capabilities: { tools: {} }, listPageSize: 1 });
      registerTools(server, [
        defineTool({
          name: 'only',
          description: 'only',
          inputSchema: z.object({}),
          annotations: TOOL_ANNOTATIONS.readOnly,
          handler: async () => toolResult('x'),
        }),
        defineTool({
          name: 'second',
          description: 'second',
          inputSchema: z.object({}),
          annotations: TOOL_ANNOTATIONS.readOnly,
          handler: async () => toolResult('y'),
        }),
      ]);
      return server;
    });
    try {
      const page = await conn.client.request({ method: 'tools/list', params: {} });
      expect(page.tools).toHaveLength(1);
      expect(page.nextCursor).toBeDefined();
      expect(conn.client.getServerCapabilities()?.tools).toBeDefined();
    } finally {
      await conn.close();
    }
  });

  it('returns a plain SDK McpServer', () => {
    expect(createMcpServer({ name: 'a', version: '1' })).toBeInstanceOf(McpServer);
  });
});
