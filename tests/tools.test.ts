import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  inputRequired,
  ProtocolError,
  ProtocolErrorCode,
  requireScopes,
  type ServerContext,
  UrlElicitationRequiredError,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { createMcpServer, fromJsonSchema, type McpServer, TOOL_ANNOTATIONS } from '../src/server.js';
import { callToolJson, captureToolCall, connectInMemory, makeRecordingServer } from '../src/testing/index.js';
import {
  type AnyToolDefinition,
  defaultMapError,
  defineTool,
  normalizeOutcome,
  notConfiguredMessage,
  type RegisterToolsOptions,
  registerTools,
  type ToolContext,
  toolError,
  toolResult,
} from '../src/tools.js';
import { loadEnv } from '../src/utils/envLoader.js';
import { initLogger, registerSecretValues, resetLogger } from '../src/utils/logger.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'tools-test', fileMain: false, fileExceptions: false, fileDebug: false });
});

afterEach(() => {
  stderr.mockRestore();
  resetLogger();
});

function stderrText(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join('');
}

function serve(tools: AnyToolDefinition[], opts?: RegisterToolsOptions): () => McpServer {
  return () => {
    const server = createMcpServer('tools-test', '1.0.0');
    registerTools(server, tools, opts);
    return server;
  };
}

const echo = defineTool({
  name: 'echo',
  title: 'Echo',
  description: 'Echo text',
  inputSchema: z.object({ text: z.string(), count: z.number().int().optional() }),
  annotations: TOOL_ANNOTATIONS.readOnly,
  handler: async ({ text }) => toolResult(`echo: ${text}`),
});

describe('toolResult / toolError', () => {
  it('a string is the text; an object is pretty JSON text plus structuredContent', () => {
    expect(toolResult('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(toolResult({ a: 1 })).toEqual({
      content: [{ type: 'text', text: '{\n  "a": 1\n}' }],
      structuredContent: { a: 1 },
    });
  });

  it('an array or primitive gets no structuredContent (the spec requires an object); opts.text wins', () => {
    expect(toolResult([1, 2]).structuredContent).toBeUndefined();
    expect(toolResult(3)).toEqual({ content: [{ type: 'text', text: '3' }] });
    expect(toolResult(undefined)).toEqual({ content: [{ type: 'text', text: 'undefined' }] });
    expect(toolResult({ a: 1 }, { text: 'summary' }).content).toEqual([{ type: 'text', text: 'summary' }]);
  });

  it('toolError is isError with the message, details as a second JSON block', () => {
    expect(toolError('bad')).toEqual({ content: [{ type: 'text', text: 'bad' }], isError: true });
    expect(toolError('bad', { id: 7 }).content).toEqual([
      { type: 'text', text: 'bad' },
      { type: 'text', text: '{\n  "id": 7\n}' },
    ]);
  });
});

describe('normalizeOutcome', () => {
  it('passes a CallToolResult through', () => {
    const r = toolError('x');
    expect(normalizeOutcome(r)).toBe(r);
  });

  it('maps a legacy { success: false } envelope to isError: true (the fleet bug)', () => {
    const r = normalizeOutcome({ success: false, error: 'upstream 404' });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ success: false, error: 'upstream 404' });
  });

  it('keeps a legacy success body as text; structuredContent only with an output schema and an object', () => {
    const plain = normalizeOutcome({ success: true, data: { id: 1 } });
    expect(plain.isError).toBeUndefined();
    expect(plain.structuredContent).toBeUndefined();
    expect(normalizeOutcome({ success: true, data: { id: 1 } }, true).structuredContent).toEqual({ id: 1 });
    expect(normalizeOutcome({ success: true, data: [1] }, true).structuredContent).toBeUndefined();
  });

  it('wraps any other value with toolResult', () => {
    expect(normalizeOutcome({ k: 'v' }).structuredContent).toEqual({ k: 'v' });
  });
});

describe('defaultMapError', () => {
  it('returns the message only, redacting secret parameters, never a stack', () => {
    const err = new Error('GET https://x.test/a?api_key=sk-123456789&q=1 failed\nsecond line');
    const mapped = defaultMapError(err);
    expect(mapped.message).not.toContain('sk-123456789');
    expect(mapped.message).not.toContain('\n');
    expect(mapped.message).not.toContain('at ');
    expect(defaultMapError('plain')).toEqual({ message: 'plain' });
  });

  it('never serialises a raw error object (axios-like with config.headers)', () => {
    const axiosLike = { config: { headers: { Authorization: 'Bearer raw-secret-token' } }, response: { status: 500 } };
    expect(defaultMapError(axiosLike)).toEqual({ message: 'Internal error' });
    const nameOnly = new Error('');
    expect(defaultMapError(nameOnly).message).toBe('Error');
  });

  it('caps very long messages', () => {
    expect(defaultMapError(new Error('x'.repeat(5000))).message.length).toBeLessThanOrEqual(2003);
  });
});

describe('registerTools over the SDK (in memory)', () => {
  it('lists every tool with title, description, annotations and the zod input schema', async () => {
    const conn = await connectInMemory(serve([echo]));
    try {
      const { tools } = await conn.client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: 'echo',
        title: 'Echo',
        description: 'Echo text',
        annotations: { readOnlyHint: true, idempotentHint: true },
      });
      expect(tools[0]?.inputSchema.required).toEqual(['text']);
    } finally {
      await conn.close();
    }
  });

  it('calls the handler and logs one call line and one result line with a duration, never values', async () => {
    const conn = await connectInMemory(serve([echo]));
    try {
      const r = await callToolJson(conn.client, 'echo', { text: 'value-never-logged' });
      expect(r).toMatchObject({ isError: false, text: 'echo: value-never-logged' });
    } finally {
      await conn.close();
    }
    const out = stderrText();
    expect(out).toContain('Tool call: echo | {"tool":"echo","args":{"text":"string(18)"}}');
    expect(out).toMatch(/Tool result: echo \| \{"tool":"echo","isError":false,"durationMs":\d+\}/);
    expect(out).not.toContain('value-never-logged');
  });

  it('a schema rejection is the SDK isError result naming the field; an unknown tool is -32602', async () => {
    const conn = await connectInMemory(serve([echo]));
    try {
      const bad = await callToolJson(conn.client, 'echo', { text: 5 });
      expect(bad.isError).toBe(true);
      expect(bad.text).toMatch(/^Input validation error: .*text/);
      const unknown = await captureToolCall(conn.client, 'nope');
      expect(unknown).toMatchObject({ kind: 'protocol-error', code: -32602 });
    } finally {
      await conn.close();
    }
  });

  it('maps throws: Error message, schema issues by field, mapError with a code, a throwing mapError', async () => {
    const tools = [
      defineTool({
        name: 'throws',
        description: 'throws an Error',
        inputSchema: z.object({}),
        annotations: TOOL_ANNOTATIONS.readOnly,
        handler: async () => {
          throw new Error('upstream exploded');
        },
      }),
      defineTool({
        name: 'parses',
        description: 'throws a zod error from its own parse',
        inputSchema: z.object({ raw: z.string() }),
        annotations: TOOL_ANNOTATIONS.readOnly,
        handler: async ({ raw }) =>
          toolResult(z.object({ id: z.number(), tags: z.array(z.string()) }).parse(JSON.parse(raw))),
      }),
      defineTool({
        name: 'issues',
        description: 'throws a Standard Schema issue list without a path',
        inputSchema: z.object({}),
        annotations: TOOL_ANNOTATIONS.readOnly,
        handler: async () => {
          throw { issues: [{ message: 'top-level problem' }, { message: 'deep', path: [{ key: 'a' }, 0] }] };
        },
      }),
    ];
    const conn = await connectInMemory(serve(tools));
    try {
      expect(await callToolJson(conn.client, 'throws')).toMatchObject({ isError: true, text: 'upstream exploded' });
      const parsed = await callToolJson(conn.client, 'parses', { raw: '{"id":"x","tags":[1]}' });
      expect(parsed.isError).toBe(true);
      expect(parsed.text).toMatch(/^Invalid arguments: id: .*; tags\.0: /);
      expect((await callToolJson(conn.client, 'issues')).text).toBe('Invalid arguments: top-level problem; a.0: deep');
    } finally {
      await conn.close();
    }

    const custom = await connectInMemory(
      serve(tools, { mapError: () => ({ message: 'try later', code: 'RATE_LIMIT' }) }),
    );
    try {
      expect((await callToolJson(custom.client, 'throws')).text).toBe('RATE_LIMIT: try later');
    } finally {
      await custom.close();
    }

    const broken = await connectInMemory(
      serve(tools, {
        mapError: () => {
          throw new Error('mapper bug');
        },
      }),
    );
    try {
      expect((await callToolJson(broken.client, 'throws')).text).toBe('Internal error');
    } finally {
      await broken.close();
    }
  });

  it('a returned legacy { success: false } envelope reaches the client as isError: true', async () => {
    const legacy = defineTool({
      name: 'legacy',
      description: 'legacy envelope',
      inputSchema: z.object({ ok: z.boolean() }),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async ({ ok }) => (ok ? { success: true, data: { id: 1 } } : { success: false, error: 'not found' }),
    });
    const conn = await connectInMemory(serve([legacy]));
    try {
      expect((await callToolJson(conn.client, 'legacy', { ok: false })).isError).toBe(true);
      const ok = await callToolJson<{ success: boolean }>(conn.client, 'legacy', { ok: true });
      expect(ok.isError).toBe(false);
      expect(ok.body).toEqual({ success: true, data: { id: 1 } });
    } finally {
      await conn.close();
    }
  });

  it('a JSON Schema input (fromJsonSchema) and an output schema validated by the SDK', async () => {
    const json = defineTool({
      name: 'json_schema',
      description: 'JSON Schema input',
      inputSchema: fromJsonSchema({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }),
      outputSchema: z.object({ doubled: z.number() }),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async (args) => toolResult({ doubled: (args as { n: number }).n * 2 }),
    });
    const conn = await connectInMemory(serve([json]));
    try {
      expect((await callToolJson(conn.client, 'json_schema', { n: 2 })).body).toEqual({ doubled: 4 });
      expect((await callToolJson(conn.client, 'json_schema', { n: 'x' })).isError).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it('enabled filters registration; prefix renames; the handles are returned', () => {
    const rec = makeRecordingServer();
    const other = defineTool({ ...echo, name: 'other' } as Parameters<typeof defineTool>[0]);
    const handles = registerTools(rec.asMcpServer(), [echo, other], { enabled: ['other'], prefix: 'x_' });
    expect([...rec.tools.keys()]).toEqual(['x_other']);
    expect([...handles.keys()]).toEqual(['x_other']);
  });

  it('puts every SDK Tool field on the wire: title, outputSchema, annotations, icons, _meta', async () => {
    const full = defineTool({
      name: 'full',
      title: 'Full tool',
      description: 'every field',
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.object({ hits: z.number() }),
      annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
      icons: [{ src: 'https://example.test/icon.png', mimeType: 'image/png' }],
      _meta: { 'example.test/category': 'search' },
      handler: async () => toolResult({ hits: 3 }),
    });
    const conn = await connectInMemory(serve([full]));
    try {
      const [tool] = (await conn.client.listTools()).tools;
      expect(tool).toMatchObject({
        name: 'full',
        title: 'Full tool',
        description: 'every field',
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        icons: [{ src: 'https://example.test/icon.png', mimeType: 'image/png' }],
        _meta: { 'example.test/category': 'search' },
      });
      expect(tool?.outputSchema?.properties).toHaveProperty('hits');
      expect((await callToolJson(conn.client, 'full', { q: 'x' })).body).toEqual({ hits: 3 });
    } finally {
      await conn.close();
    }
  });

  it('a disabled tool answers the SDK ProtocolError -32602 unwrapped (handles from registerTools)', async () => {
    const conn = await connectInMemory(() => {
      const server = createMcpServer('tools-test', '1.0.0');
      registerTools(server, [echo]).get('echo')?.disable();
      return server;
    });
    try {
      expect(await captureToolCall(conn.client, 'echo', { text: 'a' })).toMatchObject({
        kind: 'protocol-error',
        code: -32602,
        message: expect.stringMatching(/disabled/),
      });
    } finally {
      await conn.close();
    }
  });
});

describe('degraded mode (requires)', () => {
  const paid = defineTool({
    name: 'paid',
    description: 'needs credentials',
    inputSchema: z.object({}),
    annotations: TOOL_ANNOTATIONS.readOnly,
    requires: ['PAID_TOKEN', 'PAID_ACCOUNT'],
    handler: async () => toolResult({ ok: true }),
  });

  it('lists the tool and answers the uniform not-configured error when keys are missing', async () => {
    const env = loadEnv([{ key: 'PAID_TOKEN' }, { key: 'PAID_ACCOUNT' }], {
      rootDir: process.cwd(),
      env: { MCP_ENV_FILE: 'none', PAID_ACCOUNT: 'acct' },
    });
    const conn = await connectInMemory(serve([paid, echo], { env, serverName: 'paid-mcp' }));
    try {
      expect((await conn.client.listTools()).tools.map((t) => t.name)).toEqual(['paid', 'echo']);
      const r = await callToolJson(conn.client, 'paid');
      expect(r).toMatchObject({ isError: true, text: 'paid-mcp is not configured: set PAID_TOKEN' });
      expect((await callToolJson(conn.client, 'echo', { text: 'a' })).isError).toBe(false);
    } finally {
      await conn.close();
    }
  });

  it('runs the handler once every key is configured; the default server name', async () => {
    const env = loadEnv([{ key: 'PAID_TOKEN' }, { key: 'PAID_ACCOUNT' }], {
      rootDir: process.cwd(),
      env: { MCP_ENV_FILE: 'none', PAID_TOKEN: 't', PAID_ACCOUNT: 'a' },
    });
    const conn = await connectInMemory(serve([paid], { env }));
    try {
      expect((await callToolJson(conn.client, 'paid')).body).toEqual({ ok: true });
    } finally {
      await conn.close();
    }
    expect(notConfiguredMessage('this server', ['A', 'B'])).toBe('this server is not configured: set A, B');
  });

  it('refuses to register a requires tool without an env', () => {
    expect(() => registerTools(createMcpServer('x', '1'), [paid])).toThrow(/requires but no env/);
  });

  it('refuses a requires key the env schema does not declare (a typo would degrade forever)', () => {
    const env = loadEnv([{ key: 'PAID_TOKEN' }], { rootDir: process.cwd(), env: { MCP_ENV_FILE: 'none' } });
    expect(() => registerTools(createMcpServer('x', '1'), [paid], { env })).toThrow(
      /requires PAID_ACCOUNT, which the env schema does not declare/,
    );
  });
});

describe('ToolContext', () => {
  function capture(): { tool: AnyToolDefinition; seen: ToolContext[] } {
    const seen: ToolContext[] = [];
    const tool = defineTool({
      name: 'list_things',
      description: 'a list tool',
      inputSchema: z.object({ cursor: z.string().optional() }),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async (_args, ctx) => {
        seen.push(ctx);
        await ctx.progress(1, 2, 'half');
        return toolResult({ ok: true });
      },
    });
    return { tool, seen };
  }

  it('carries the SDK signal, the cursor argument, the logger and the raw SDK context over the protocol', async () => {
    const { tool, seen } = capture();
    const conn = await connectInMemory(serve([tool]));
    try {
      await callToolJson(conn.client, 'list_things', { cursor: 'abc' });
      await callToolJson(conn.client, 'list_things', { cursor: '' });
    } finally {
      await conn.close();
    }
    expect(seen[0]?.cursor).toBe('abc');
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.sdk).toBeDefined();
    expect(seen[0]?.tool).toBe('list_things');
    expect(typeof seen[0]?.logger.info).toBe('function');
    expect(seen[1]?.cursor).toBeUndefined();
  });

  it('works without an SDK context (handler called directly) and sends progress only with a token', async () => {
    const { tool, seen } = capture();
    const rec = makeRecordingServer();
    registerTools(rec.asMcpServer(), [tool]);
    const handler = rec.tools.get('list_things')?.handler;
    if (!handler) throw new Error('not registered');
    expect((await handler({})).structuredContent).toEqual({ ok: true });
    expect(seen[0]?.signal.aborted).toBe(false);
    expect(seen[0]?.sdk).toBeUndefined();

    const notify = jest.fn<(n: unknown) => Promise<void>>(async () => undefined);
    const controller = new AbortController();
    const withToken = {
      mcpReq: { _meta: { progressToken: 'p1' }, signal: controller.signal, notify },
      http: { authInfo: { token: 't', clientId: 'c', scopes: [] } },
    } as unknown as ServerContext;
    await handler({}, withToken);
    expect(notify).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'p1', progress: 1, total: 2, message: 'half' },
    });
    expect(seen[1]?.signal).toBe(controller.signal);
    expect(seen[1]?.authInfo).toEqual({ token: 't', clientId: 'c', scopes: [] });

    notify.mockClear();
    await handler({}, { mcpReq: { _meta: {}, signal: controller.signal, notify } } as unknown as ServerContext);
    expect(notify).not.toHaveBeenCalled();
  });

  it('progress without total or message sends only the given fields', async () => {
    const tool = defineTool({
      name: 'p',
      description: 'p',
      inputSchema: z.object({}),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async (_a, ctx) => {
        await ctx.progress(5);
        return toolResult('done');
      },
    });
    const rec = makeRecordingServer();
    registerTools(rec.asMcpServer(), [tool]);
    const notify = jest.fn<(n: unknown) => Promise<void>>(async () => undefined);
    await rec.tools.get('p')?.handler({}, {
      mcpReq: { _meta: { progressToken: 9 }, signal: new AbortController().signal, notify },
    } as unknown as ServerContext);
    expect(notify).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 9, progress: 5 },
    });
  });
});

describe('SDK protocol errors, input-required results and client-bound masking', () => {
  it('rethrows the SDK UrlElicitationRequired error (-32042) instead of turning it into isError', async () => {
    const tool = defineTool({
      name: 'needs_url',
      description: 'needs a URL elicitation',
      inputSchema: z.object({}),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async () => {
        throw new UrlElicitationRequiredError([
          { mode: 'url', message: 'Sign in', url: 'https://auth.example/x', elicitationId: 'e1' },
        ]);
      },
    });
    const conn = await connectInMemory(serve([tool]));
    try {
      await expect(conn.client.callTool({ name: 'needs_url', arguments: {} })).rejects.toMatchObject({
        code: ProtocolErrorCode.UrlElicitationRequired,
      });
    } finally {
      await conn.close();
    }
  });

  it('any other ProtocolError from a handler stays a (masked) isError result, as the SDK does', async () => {
    const tool = defineTool({
      name: 'bad',
      description: 'throws a protocol error',
      inputSchema: z.object({}),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async () => {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'nope');
      },
    });
    const conn = await connectInMemory(serve([tool]));
    try {
      expect(await callToolJson(conn.client, 'bad')).toMatchObject({ isError: true, text: 'nope' });
    } finally {
      await conn.close();
    }
  });

  it('normalizeOutcome passes an SDK input-required result through untouched', () => {
    const result = inputRequired({ inputRequests: { roots: inputRequired.listRoots() } });
    expect(normalizeOutcome(result)).toBe(result);
    expect(normalizeOutcome(result, true)).toBe(result);
  });

  it('masks registered secret values in every client-bound error text (thrown, mapError, issues, toolError, returned)', async () => {
    registerSecretValues(['sk-live-0123456789']);
    const throwing = (name: string, err: () => unknown) =>
      defineTool({
        name,
        description: name,
        inputSchema: z.object({}),
        annotations: TOOL_ANNOTATIONS.readOnly,
        handler: async () => {
          throw err();
        },
      });
    const tools = [
      throwing('thrown', () => new Error('auth failed for sk-live-0123456789')),
      throwing('issues', () => ({ issues: [{ message: 'bad token sk-live-0123456789' }] })),
      defineTool({
        name: 'returned',
        description: 'returns a raw isError result',
        inputSchema: z.object({}),
        annotations: TOOL_ANNOTATIONS.readOnly,
        handler: async () => ({ content: [{ type: 'text', text: 'key sk-live-0123456789' }], isError: true }),
      }),
      defineTool({
        name: 'helper',
        description: 'returns toolError',
        inputSchema: z.object({}),
        annotations: TOOL_ANNOTATIONS.readOnly,
        handler: async () => toolError('key sk-live-0123456789', { key: 'sk-live-0123456789' }),
      }),
    ];
    const conn = await connectInMemory(serve(tools));
    const custom = await connectInMemory(
      serve(tools, { mapError: (e) => ({ message: `custom: ${(e as Error).message}` }) }),
    );
    try {
      for (const name of ['thrown', 'issues', 'returned', 'helper']) {
        const r = await conn.client.callTool({ name, arguments: {} });
        const text = JSON.stringify(r.content);
        expect(text).not.toContain('sk-live-0123456789');
        expect(text).toContain('[SECRET]');
      }
      const r = await custom.client.callTool({ name: 'thrown', arguments: {} });
      expect(JSON.stringify(r.content)).not.toContain('sk-live-0123456789');
    } finally {
      await conn.close();
      await custom.close();
    }
    expect(toolError('x sk-live-0123456789 y').content).toEqual([{ type: 'text', text: 'x [SECRET] y' }]);
  });

  it('forwards scopeChallenge to the SDK registration', () => {
    const rec = makeRecordingServer();
    const scopeChallenge = requireScopes('write');
    registerTools(rec.asMcpServer(), [
      defineTool({
        name: 's',
        description: 's',
        inputSchema: z.object({}),
        annotations: TOOL_ANNOTATIONS.mutableWrite,
        scopeChallenge,
        handler: async () => toolResult('ok'),
      }),
    ]);
    expect(rec.tools.get('s')?.config.scopeChallenge).toBe(scopeChallenge);
  });

  it('progress is a no-op once the request is aborted and never throws when the send fails', async () => {
    const tool = defineTool({
      name: 'p2',
      description: 'p2',
      inputSchema: z.object({}),
      annotations: TOOL_ANNOTATIONS.readOnly,
      handler: async (_a, ctx) => {
        await ctx.progress(1);
        return toolResult('done');
      },
    });
    const rec = makeRecordingServer();
    registerTools(rec.asMcpServer(), [tool]);
    const failing = jest.fn<(n: unknown) => Promise<void>>(async () => {
      throw new Error('closed');
    });
    const ok = await rec.tools.get('p2')?.handler({}, {
      mcpReq: { _meta: { progressToken: 1 }, signal: new AbortController().signal, notify: failing },
    } as unknown as ServerContext);
    expect(ok?.isError).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    const notify = jest.fn<(n: unknown) => Promise<void>>(async () => undefined);
    await rec.tools.get('p2')?.handler({}, {
      mcpReq: { _meta: { progressToken: 1 }, signal: aborted.signal, notify },
    } as unknown as ServerContext);
    expect(notify).not.toHaveBeenCalled();
  });
});
