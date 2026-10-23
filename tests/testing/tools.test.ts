import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import * as z from 'zod/v4';
import { createMcpServer, Server } from '../../src/server.js';
import {
  assertToolCoverage,
  callToolInMemory,
  callToolJson,
  captureToolCall,
  connectInMemory,
  createTestClient,
  expectSchemaRejection,
  expectToolError,
  expectToolSuccess,
  expectUnknownTool,
  INVALID_PARAMS_CODE,
  type InMemoryConnection,
  listToolNames,
  type ToolJsonResult,
  toolCoverage,
  withInMemoryClient,
} from '../../src/testing/index.js';
import { buildEchoServer, ECHO_TOOL_NAMES } from '../fixtures/echo-tools.js';

// In-process logger output from the fixture would otherwise land on the jest console.
let stderrSpy: ReturnType<typeof jest.spyOn>;
beforeAll(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterAll(() => {
  stderrSpy.mockRestore();
});

/** A server whose tools exercise every body-decoding branch. */
function shapesServer() {
  const server = createMcpServer('shapes', '1.0.0');
  server.registerTool('json_text', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: '{"a":1}' }],
  }));
  server.registerTool('no_content', { inputSchema: z.object({}) }, async () => ({ content: [] }));
  server.registerTool('image_only', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
  }));
  server.registerTool('no_args', { description: 'takes nothing' }, async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  return server;
}

describe('callToolJson / listToolNames (in memory)', () => {
  let conn: InMemoryConnection;

  beforeAll(async () => {
    conn = await connectInMemory(buildEchoServer);
  });

  afterAll(async () => {
    await conn.close();
    await conn.close();
  });

  it('lists every tool in server order', async () => {
    expect(await listToolNames(conn.client)).toEqual(ECHO_TOOL_NAMES);
  });

  it('returns a non-JSON first text block as the body', async () => {
    const r = await callToolJson(conn.client, 'echo', { text: 'hi' });
    expect(r).toMatchObject({ isError: false, body: 'echo: hi', text: 'echo: hi' });
    expect(r.raw.content).toEqual([{ type: 'text', text: 'echo: hi' }]);
  });

  it('prefers structuredContent', async () => {
    const r = await callToolJson<{ text: string; length: number }>(conn.client, 'echo_json', { text: 'abc' });
    expect(r.body).toEqual({ text: 'abc', length: 3 });
  });

  it('flags isError results', async () => {
    const r = await callToolJson(conn.client, 'boom');
    expect(r.isError).toBe(true);
    expect(r.text).toBe('boom: failed');
  });
});

describe('callToolJson body decoding', () => {
  it('parses a JSON text block, and leaves the body undefined without text', async () => {
    await withInMemoryClient(shapesServer, async (client) => {
      expect((await callToolJson(client, 'json_text')).body).toEqual({ a: 1 });
      const empty = await callToolJson(client, 'no_content');
      expect(empty.body).toBeUndefined();
      expect(empty.text).toBe('');
      const image = await callToolJson(client, 'image_only');
      expect(image.body).toBeUndefined();
      expect(image.text).toBe('');
      expect((await callToolJson(client, 'no_args')).text).toBe('ok');
    });
  });
});

describe('toolCoverage / assertToolCoverage', () => {
  it('is ok when the sets match in any order', () => {
    expect(toolCoverage(['a', 'b'], ['b', 'a'])).toEqual({ missing: [], stale: [], duplicates: [], ok: true });
    expect(assertToolCoverage(['a'], ['a']).ok).toBe(true);
  });

  it('reports tools without a case, stale cases and duplicates, sorted', () => {
    expect(toolCoverage(['z', 'a', 'b'], ['b', 'gone', 'b'])).toEqual({
      missing: ['a', 'z'],
      stale: ['gone'],
      duplicates: ['b'],
      ok: false,
    });
  });

  it('throws with both lists', () => {
    expect(() => assertToolCoverage(['new_tool'], ['old_case'])).toThrow(
      'Tool coverage mismatch: tools without a case: [new_tool]; stale cases (no such tool): [old_case]',
    );
    expect(() => assertToolCoverage(['a'], ['a', 'a'])).toThrow(/duplicate cases: \[a\]/);
  });
});

describe('unit helpers', () => {
  it('callToolInMemory runs one call against a fresh server', async () => {
    const r = await callToolInMemory<{ text: string; length: number }>(buildEchoServer, 'echo_json', { text: 'x' });
    expect(expectToolSuccess(r)).toEqual({ text: 'x', length: 1 });
    expect((await callToolInMemory(buildEchoServer, 'boom', {}, { era: 'modern' })).isError).toBe(true);
  });

  it('withInMemoryClient closes even when the callback throws', async () => {
    await expect(
      withInMemoryClient(buildEchoServer, async () => {
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');
  });

  it('expectToolError / expectToolSuccess throw on the wrong outcome', async () => {
    const ok = await callToolInMemory(buildEchoServer, 'echo', { text: 'y' });
    const bad = await callToolInMemory(buildEchoServer, 'boom');
    expect(() => expectToolError(ok)).toThrow(/Expected an isError result/);
    expect(() => expectToolError(bad, 'other')).toThrow(/did not match other/);
    expect(() => expectToolError(bad, /nomatch/)).toThrow(/did not match/);
    expect(expectToolError(bad)).toBe('boom: failed');
    expect(() => expectToolSuccess(bad)).toThrow(/Expected success, got isError/);
  });

  it('captureToolCall returns protocol errors as data', async () => {
    await withInMemoryClient(buildEchoServer, async (client) => {
      const outcome = await captureToolCall(client, 'missing_tool');
      expect(outcome).toEqual({
        kind: 'protocol-error',
        code: INVALID_PARAMS_CODE,
        message: expect.stringMatching(/not found/),
      });
      expect((await captureToolCall(client, 'echo', { text: 'a' })).kind).toBe('result');
    });
  });

  it('pins the SDK v2 shapes: schema rejection is an isError result, an unknown tool throws -32602', async () => {
    await withInMemoryClient(buildEchoServer, async (client) => {
      const rejection = await expectSchemaRejection(client, 'echo', { text: 1 });
      expect(rejection.via).toBe('tool-error');
      expect(rejection.message).toMatch(/^Input validation error:/);
      expect(await expectUnknownTool(client, 'nope')).toEqual({
        via: 'protocol-error',
        message: expect.stringMatching(/Tool nope not found/),
      });
      await expect(expectSchemaRejection(client, 'echo', { text: 'valid' })).rejects.toThrow(/but it succeeded/);
      await expect(expectUnknownTool(client, 'echo')).rejects.toThrow(/Expected unknown tool echo/);
    });
  });

  it('expectSchemaRejection accepts InvalidParams, refuses other protocol codes; expectUnknownTool accepts isError', async () => {
    // A low-level Server that answers with protocol errors and error results, as some consumers do.
    const lowLevel = () => {
      const server = new Server({ name: 'low', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler('tools/list', async () => ({ tools: [] }));
      server.setRequestHandler('tools/call', async (req) => {
        const name = req.params.name;
        if (name === 'invalid') throw Object.assign(new Error('bad params'), { code: INVALID_PARAMS_CODE });
        if (name === 'internal') throw Object.assign(new Error('internal'), { code: -32603 });
        return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
      });
      return server;
    };
    await withInMemoryClient(lowLevel, async (client) => {
      expect((await expectSchemaRejection(client, 'invalid', {})).via).toBe('protocol-error');
      await expect(expectSchemaRejection(client, 'internal', {})).rejects.toThrow(/got code/);
      expect(await expectUnknownTool(client, 'whatever')).toEqual({
        via: 'tool-error',
        message: 'unknown tool whatever',
      });
    });
  });

  it('captureToolCall records a non-numeric code as undefined', async () => {
    const client = createTestClient();
    const fake = { callTool: async (): Promise<never> => Promise.reject('plain string') } as unknown as typeof client;
    expect(await captureToolCall(fake, 'x')).toEqual({
      kind: 'protocol-error',
      code: undefined,
      message: 'plain string',
    });
  });

  it('a result type can be narrowed by the caller', () => {
    const r: ToolJsonResult<{ n: number }> = {
      isError: false,
      body: { n: 1 },
      text: '',
      raw: { content: [] },
    };
    expect(expectToolSuccess(r).n).toBe(1);
  });
});
