import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { DEFAULT_MAX_RESULT_BYTES, DEFAULT_MAX_RESULT_ITEMS, resolveLimits } from '../src/limits.js';
import { encodeCursor, type PagedResult, pagedResultSchema, paginateArrayByCursor } from '../src/pagination.js';
import { argsFingerprint, decodeToolCursor, enforceResultLimits } from '../src/result-limits.js';
import { createMcpServer, TOOL_ANNOTATIONS } from '../src/server.js';
import { connectInMemory, type ProtocolEra } from '../src/testing/index.js';
import {
  type AnyToolDefinition,
  defineTool,
  type RegisterToolsOptions,
  registerTools,
  toolResult,
} from '../src/tools.js';
import { loadEnv } from '../src/utils/envLoader.js';
import { initLogger, resetLogger } from '../src/utils/logger.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'limits-test', fileMain: false, fileExceptions: false, fileDebug: false });
});

afterEach(() => {
  stderr.mockRestore();
  resetLogger();
  delete process.env.MCP_MAX_RESULT_ITEMS;
  delete process.env.MCP_MAX_RESULT_BYTES;
});

function stderrText(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join('');
}

const ALL = Array.from({ length: 250 }, (_v, i) => ({ id: i, name: `item-${i}` }));
const Item = z.object({ id: z.number(), name: z.string() });
const pageInput = { cursor: z.string().optional(), limit: z.number().int().positive().optional() };
const handlerCalls: Array<{ cursor?: string; limit?: number; ctxCursor?: string }> = [];

/** A tool that returns its whole upstream page in one go (no own paging): mcp-core must cut it. */
const dumpAll = defineTool({
  name: 'dump_all',
  description: 'returns every item',
  inputSchema: z.object({ q: z.string().optional(), ...pageInput }),
  outputSchema: pagedResultSchema(z, Item),
  annotations: TOOL_ANNOTATIONS.readOnly,
  paginated: true,
  handler: async (args, ctx) => {
    handlerCalls.push({ cursor: args.cursor, limit: args.limit, ctxCursor: ctx.cursor });
    return toolResult({ items: ALL, total: ALL.length });
  },
});

/** A tool that pages upstream itself (pages of 120 with its own cursor): mcp-core slices and wraps. */
const upstreamPaged = defineTool({
  name: 'upstream_paged',
  description: 'pages of 120',
  inputSchema: z.object(pageInput),
  annotations: TOOL_ANNOTATIONS.readOnly,
  handler: async (args) => {
    handlerCalls.push({ cursor: args.cursor, limit: args.limit });
    const page = paginateArrayByCursor(ALL, { cursor: args.cursor, limit: 120, maxLimit: 120 });
    return toolResult(page);
  },
});

const big = defineTool({
  name: 'big_blob',
  description: 'a large non-list result',
  inputSchema: z.object({}),
  annotations: TOOL_ANNOTATIONS.readOnly,
  handler: async () => toolResult({ blob: 'x'.repeat(300 * 1024) }),
});

const fatItems = defineTool({
  name: 'fat_items',
  description: 'few items, each large',
  inputSchema: z.object(pageInput),
  annotations: TOOL_ANNOTATIONS.readOnly,
  limits: { maxBytes: 50_000 },
  handler: async () => toolResult({ items: Array.from({ length: 10 }, (_v, i) => ({ i, pad: 'y'.repeat(9_000) })) }),
});

const HINT = 'page it with query.limit and query.offset';

/** An envelope tool: the payload sits under `data`, and the text block repeats it. */
function envelopeTool(name: string, data: unknown, limits?: { maxItems?: number; maxBytes?: number }) {
  return defineTool({
    name,
    description: 'an enveloped payload',
    inputSchema: z.object({}),
    outputSchema: z.object({ data: z.unknown() }),
    annotations: TOOL_ANNOTATIONS.readOnly,
    envelope: { key: 'data', hint: HINT },
    ...(limits ? { limits } : {}),
    handler: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      structuredContent: { data },
    }),
  });
}

function serve(tools: AnyToolDefinition[], opts?: RegisterToolsOptions) {
  return () => {
    const server = createMcpServer('limits', '1.0.0');
    registerTools(server, tools, opts);
    return server;
  };
}

async function page(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { result: r, sc: r.structuredContent as PagedResult<{ id: number }> | undefined };
}

async function walk(client: Client, name: string, args: Record<string, unknown> = {}): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const { sc } = await page(client, name, cursor ? { ...args, cursor } : args);
    ids.push(...(sc?.items ?? []).map((x) => x.id));
    cursor = sc?.nextCursor;
    if (!cursor) break;
  }
  return ids;
}

describe.each<ProtocolEra>(['legacy', 'modern'])('list-shaped results (%s era)', (era) => {
  it('cuts a whole dump to the default 100 items, resumes with the cursor, ends without one', async () => {
    handlerCalls.length = 0;
    const conn = await connectInMemory(serve([dumpAll]), { era });
    try {
      const first = await page(conn.client, 'dump_all', {});
      expect(first.sc?.items).toHaveLength(DEFAULT_MAX_RESULT_ITEMS);
      expect(first.sc?.total).toBe(250);
      expect(typeof first.sc?.nextCursor).toBe('string');
      // The text block mirrors the cut page, never the full dump.
      expect(JSON.parse((first.result.content as Array<{ text: string }>)[0]?.text ?? '{}').items).toHaveLength(100);
      expect(await walk(conn.client, 'dump_all')).toEqual(ALL.map((x) => x.id));
      expect(handlerCalls.every((c) => c.cursor === undefined && c.ctxCursor === undefined)).toBe(true);
      expect(stderrText()).toContain('Tool result paged: dump_all');
      expect(stderrText()).not.toContain('item-1');
    } finally {
      await conn.close();
    }
  });

  it('a client limit pages smaller and is capped at the max; the handler sees the capped limit', async () => {
    handlerCalls.length = 0;
    const conn = await connectInMemory(serve([dumpAll]), { era });
    try {
      expect((await page(conn.client, 'dump_all', { limit: 30 })).sc?.items).toHaveLength(30);
      expect((await page(conn.client, 'dump_all', { limit: 5000 })).sc?.items).toHaveLength(100);
      expect(handlerCalls.map((c) => c.limit)).toEqual([30, 100]);
      expect(await walk(conn.client, 'dump_all', { limit: 40 })).toEqual(ALL.map((x) => x.id));
    } finally {
      await conn.close();
    }
  });

  it('slices a self-paging handler and wraps its own nextCursor; the handler gets its own cursor back', async () => {
    handlerCalls.length = 0;
    const conn = await connectInMemory(serve([upstreamPaged]), { era });
    try {
      expect(await walk(conn.client, 'upstream_paged')).toEqual(ALL.map((x) => x.id));
      const ownCursors = handlerCalls.map((c) => c.cursor);
      expect(ownCursors[0]).toBeUndefined();
      expect(ownCursors).toContain(encodeCursor({ o: 120 }));
      expect(ownCursors).toContain(encodeCursor({ o: 240 }));
    } finally {
      await conn.close();
    }
  });

  it('refuses a tampered cursor, one issued for other arguments or another tool', async () => {
    const conn = await connectInMemory(serve([dumpAll, upstreamPaged]), { era });
    try {
      const first = await page(conn.client, 'dump_all', { q: 'a' });
      const cursor = first.sc?.nextCursor ?? '';
      const otherArgs = await conn.client.callTool({ name: 'dump_all', arguments: { q: 'b', cursor } });
      expect(otherArgs.isError).toBe(true);
      expect(JSON.stringify(otherArgs.content)).toContain('Invalid cursor: issued for other arguments');
      const otherTool = await conn.client.callTool({ name: 'upstream_paged', arguments: { cursor } });
      expect(JSON.stringify(otherTool.content)).toContain('Invalid cursor: issued for another tool');
      const garbage = await conn.client.callTool({ name: 'dump_all', arguments: { cursor: 'zz!!' } });
      expect(garbage.isError).toBe(true);
      expect(JSON.stringify(garbage.content)).toContain('Invalid cursor');
      const edited = Buffer.from(cursor, 'base64url').toString('utf8').replace('"o":100', '"o":-5');
      const negative = await conn.client.callTool({
        name: 'dump_all',
        arguments: { q: 'a', cursor: Buffer.from(edited).toString('base64url') },
      });
      expect(negative.isError).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it('a non-list result over the byte cap becomes an actionable isError, never a truncated body', async () => {
    const conn = await connectInMemory(serve([big]), { era });
    try {
      const r = await conn.client.callTool({ name: 'big_blob', arguments: {} });
      expect(r.isError).toBe(true);
      const text = JSON.stringify(r.content);
      expect(text).toContain(`over the ${DEFAULT_MAX_RESULT_BYTES} byte limit`);
      expect(text).toContain('narrow the request');
      expect(r.structuredContent).toBeUndefined();
      expect(stderrText()).toContain('Tool result over the byte limit: big_blob');
    } finally {
      await conn.close();
    }
  });

  it('a list result over the per-tool byte cap is paged smaller until it fits', async () => {
    const conn = await connectInMemory(serve([fatItems]), { era });
    try {
      const first = await page(conn.client, 'fat_items');
      const n = first.sc?.items.length ?? 0;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(10);
      expect(Buffer.byteLength(JSON.stringify(first.result))).toBeLessThanOrEqual(60_000);
      expect(first.sc?.nextCursor).toBeDefined();
    } finally {
      await conn.close();
    }
  });
});

describe('envelope results', () => {
  it('refuses an array payload over the item cap with the hint, and passes one at the cap', async () => {
    const over = envelopeTool('env_over', ALL);
    const at = envelopeTool('env_at', ALL.slice(0, 100));
    const conn = await connectInMemory(serve([over, at]));
    try {
      const r = await conn.client.callTool({ name: 'env_over', arguments: {} });
      expect(r.isError).toBe(true);
      expect((r.content as Array<{ text: string }>)[0]?.text).toBe(
        `env_over: the result has 250 items, over the ${DEFAULT_MAX_RESULT_ITEMS} item limit per response; ${HINT}`,
      );
      expect(r.structuredContent).toBeUndefined();
      const ok = await conn.client.callTool({ name: 'env_at', arguments: {} });
      expect(ok.isError).not.toBe(true);
      expect((ok.structuredContent as { data: unknown[] }).data).toHaveLength(100);
      expect(stderrText()).toContain('Tool result over the item limit: env_over');
    } finally {
      await conn.close();
    }
  });

  it('applies the item cap to a PagedResult-shaped payload too', async () => {
    const conn = await connectInMemory(serve([envelopeTool('env_paged', { items: ALL, total: 250 })]));
    try {
      const r = await conn.client.callTool({ name: 'env_paged', arguments: {} });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain('the result has 250 items');
    } finally {
      await conn.close();
    }
  });

  it('counts a text copy of the payload once in the byte cap and names the hint when over', () => {
    const data = { blob: 'q'.repeat(600) };
    const result = {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      structuredContent: { data },
    };
    const once = Buffer.byteLength(JSON.stringify({ content: [], structuredContent: { data } }));
    const ctx = { tool: 't', args: {}, decoded: undefined, maxItems: 10, envelope: { key: 'data', hint: HINT } };
    // Twice the payload would not fit this cap; once does.
    expect(enforceResultLimits({ ...ctx, maxBytes: once + 10 }, result)).toBe(result);
    const refused = enforceResultLimits({ ...ctx, maxBytes: once - 10 }, result);
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]?.text).toBe(
      `t: the result is ${once} bytes, over the ${once - 10} byte limit per response; ${HINT}`,
    );
  });

  it('a result without the envelope key, or an error, keeps the default caps', () => {
    const plain = { content: [{ type: 'text' as const, text: 'z'.repeat(500) }] };
    const ctx = { tool: 't', args: {}, decoded: undefined, maxItems: 10, maxBytes: 100, envelope: { key: 'data' } };
    expect(JSON.stringify(enforceResultLimits(ctx, plain).content)).toContain('narrow the request');
    const err = { content: [{ type: 'text' as const, text: 'e' }], isError: true, structuredContent: { data: ALL } };
    expect(enforceResultLimits({ ...ctx, maxBytes: 100_000 }, err)).toBe(err);
  });
});

describe('limits configuration and edges', () => {
  it('env defaults, overrides and per-tool limits', async () => {
    expect(resolveLimits({}, {})).toMatchObject({ maxResultItems: 100, maxResultBytes: 262_144 });
    expect(resolveLimits({}, { MCP_MAX_RESULT_ITEMS: '7', MCP_MAX_RESULT_BYTES: '1000' })).toMatchObject({
      maxResultItems: 7,
      maxResultBytes: 1000,
    });
    expect(resolveLimits({}, { MCP_MAX_RESULT_ITEMS: '0' }).maxResultItems).toBe(100);
    process.env.MCP_MAX_RESULT_ITEMS = '12';
    const envConn = await connectInMemory(serve([dumpAll]));
    const optConn = await connectInMemory(serve([dumpAll], { limits: { maxItems: 9 } }));
    const toolConn = await connectInMemory(
      serve([{ ...dumpAll, limits: { maxItems: 4 } }], { limits: { maxItems: 9 } }),
    );
    try {
      expect((await page(envConn.client, 'dump_all')).sc?.items).toHaveLength(12);
      expect((await page(optConn.client, 'dump_all')).sc?.items).toHaveLength(9);
      expect((await page(toolConn.client, 'dump_all')).sc?.items).toHaveLength(4);
    } finally {
      await envConn.close();
      await optConn.close();
      await toolConn.close();
    }
  });

  it('limits come from the loaded env, not process.env, when an env is passed', async () => {
    process.env.MCP_MAX_RESULT_ITEMS = '12';
    const env = loadEnv([], { rootDir: process.cwd(), env: { MCP_MAX_RESULT_ITEMS: '5', MCP_ENV_FILE: 'none' } });
    const conn = await connectInMemory(serve([dumpAll], { env }));
    try {
      expect((await page(conn.client, 'dump_all')).sc?.items).toHaveLength(5);
    } finally {
      await conn.close();
    }
  });

  it('a paginated tool must declare cursor and limit', () => {
    const server = createMcpServer('x', '1');
    expect(() =>
      registerTools(server, [
        defineTool({
          name: 'bad',
          description: 'bad',
          inputSchema: z.object({ q: z.string() }),
          annotations: TOOL_ANNOTATIONS.readOnly,
          paginated: true,
          handler: async () => toolResult({ items: [] }),
        }),
      ]),
    ).toThrow(/must declare cursor and limit/);
  });

  it('a small result passes untouched; onOversize can supply a replacement (the resource-link seam)', async () => {
    const small = { content: [{ type: 'text' as const, text: 'ok' }] };
    expect(enforceResultLimits({ tool: 't', args: {}, decoded: undefined, maxItems: 10, maxBytes: 1000 }, small)).toBe(
      small,
    );
    const replaced = enforceResultLimits(
      {
        tool: 't',
        args: {},
        decoded: undefined,
        maxItems: 10,
        maxBytes: 100,
        onOversize: () => ({ content: [{ type: 'text', text: 'see resource' }] }),
      },
      { content: [{ type: 'text', text: 'z'.repeat(500) }] },
    );
    expect(replaced.content).toEqual([{ type: 'text', text: 'see resource' }]);
    const oversizedError = enforceResultLimits(
      { tool: 't', args: {}, decoded: undefined, maxItems: 10, maxBytes: 100 },
      { content: [{ type: 'text', text: 'e'.repeat(500) }], isError: true },
    );
    expect(oversizedError.isError).toBe(true);
    expect(JSON.stringify(oversizedError.content)).toContain('over the 100 byte limit');
  });

  it('a foreign cursor passes through to a non-paginated tool; the fingerprint ignores cursor/limit and key order', () => {
    expect(decodeToolCursor('t', {}, encodeCursor({ o: 5 }), false)).toBeUndefined();
    expect(() => decodeToolCursor('t', {}, encodeCursor({ o: 5 }), true)).toThrow(/Invalid cursor/);
    expect(argsFingerprint({ a: 1, b: { c: 2, d: 3 }, cursor: 'x', limit: 3 })).toBe(
      argsFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(argsFingerprint(undefined)).toBe(argsFingerprint({}));
  });
});
