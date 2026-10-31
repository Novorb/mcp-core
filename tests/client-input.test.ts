import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Client, ClientCapabilities } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { createClientInput, requestEra, supportsClientFeature } from '../src/client-input.js';
import { createMcpServer, TOOL_ANNOTATIONS } from '../src/server.js';
import { connectInMemory, createTestClient, freePort, type ProtocolEra } from '../src/testing/index.js';
import { defineTool, registerTools, type ToolContext, toolError, toolResult } from '../src/tools.js';
import { startMcpServer } from '../src/transport.js';
import { initLogger, resetLogger } from '../src/utils/logger.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'client-input-test', fileMain: false, fileExceptions: false, fileDebug: false });
});

afterEach(() => {
  stderr.mockRestore();
  resetLogger();
});

const confirmSchema = z.object({ ok: z.boolean() });
const seen: ToolContext[] = [];

function unsupportedText(outcome: { status: string; reason?: string }): string {
  return `unsupported: ${outcome.reason ?? ''}`;
}

const tools = [
  defineTool({
    name: 'confirm',
    description: 'asks for a confirmation',
    inputSchema: z.object({}),
    annotations: TOOL_ANNOTATIONS.mutableWrite,
    handler: async (_a, ctx) => {
      seen.push(ctx);
      const r = ctx.elicit('confirm', { message: 'Proceed?', requestedSchema: confirmSchema });
      if (r.status === 'pending') return r.result;
      if (r.status === 'unsupported') return toolError(unsupportedText(r));
      if (r.status === 'accepted') return toolResult(r.value.ok ? 'confirmed' : 'refused');
      return toolResult(r.status);
    },
  }),
  defineTool({
    name: 'summarise',
    description: 'asks the client LLM',
    inputSchema: z.object({}),
    annotations: TOOL_ANNOTATIONS.readOnly,
    handler: async (_a, ctx) => {
      const r = ctx.sample('llm', {
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
        maxTokens: 10,
      });
      if (r.status === 'pending') return r.result;
      if (r.status === 'unsupported') return toolError(unsupportedText(r));
      if (r.status === 'accepted') {
        const content = r.value.content;
        const block = Array.isArray(content) ? content[0] : content;
        return toolResult(block?.type === 'text' ? block.text : 'non-text');
      }
      return toolResult(r.status);
    },
  }),
  defineTool({
    name: 'roots',
    description: 'lists the client roots',
    inputSchema: z.object({}),
    annotations: TOOL_ANNOTATIONS.readOnly,
    handler: async (_a, ctx) => {
      const r = ctx.listRoots();
      if (r.status === 'pending') return r.result;
      if (r.status === 'unsupported') return toolError(unsupportedText(r));
      if (r.status === 'accepted') return toolResult(r.value.map((root) => root.uri).join(','));
      return toolResult(r.status);
    },
  }),
];

function buildServer() {
  const server = createMcpServer('client-input', '1.0.0');
  registerTools(server, tools);
  return server;
}

const FULL_CAPS: ClientCapabilities = { elicitation: {}, sampling: {}, roots: {} };

function installHandlers(client: Client, elicitAction: 'accept' | 'decline' | 'cancel' = 'accept', ok = true): void {
  client.setRequestHandler('elicitation/create', async () =>
    elicitAction === 'accept' ? { action: 'accept', content: { ok } } : { action: elicitAction },
  );
  client.setRequestHandler('sampling/createMessage', async () => ({
    role: 'assistant',
    content: { type: 'text', text: 'a summary' },
    model: 'test-model',
  }));
  client.setRequestHandler('roots/list', async () => ({ roots: [{ uri: 'file:///work', name: 'work' }] }));
}

async function text(client: Client, name: string): Promise<{ text: string; isError: boolean }> {
  const r = await client.callTool({ name, arguments: {} });
  const block = (r.content as Array<{ type: string; text?: string }>)[0];
  return { text: block?.text ?? '', isError: r.isError === true };
}

describe.each<ProtocolEra>(['legacy', 'modern'])('client input over stdio/in-memory (%s era)', (era) => {
  it('elicit, sample and listRoots round-trip through the SDK multi-round-trip flow', async () => {
    seen.length = 0;
    const conn = await connectInMemory(buildServer, { era, clientOptions: { capabilities: FULL_CAPS } });
    installHandlers(conn.client);
    try {
      expect(await text(conn.client, 'confirm')).toEqual({ text: 'confirmed', isError: false });
      expect(await text(conn.client, 'summarise')).toEqual({ text: 'a summary', isError: false });
      expect(await text(conn.client, 'roots')).toEqual({ text: 'file:///work', isError: false });
      expect(seen[0]?.era).toBe(era);
      expect(seen[0]?.clientCapabilities?.elicitation).toBeDefined();
    } finally {
      await conn.close();
    }
  });

  it('declined and cancelled elicitations, and content failing the schema', async () => {
    for (const [action, expected] of [
      ['decline', 'declined'],
      ['cancel', 'cancelled'],
    ] as const) {
      const conn = await connectInMemory(buildServer, { era, clientOptions: { capabilities: FULL_CAPS } });
      installHandlers(conn.client, action);
      try {
        expect((await text(conn.client, 'confirm')).text).toBe(expected);
      } finally {
        await conn.close();
      }
    }
    const conn = await connectInMemory(buildServer, { era, clientOptions: { capabilities: FULL_CAPS } });
    conn.client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { ok: 'yes' } }));
    try {
      expect((await text(conn.client, 'confirm')).text).toBe('invalid');
    } finally {
      await conn.close();
    }
  });

  it('a client without the capabilities gets a typed unsupported outcome, never a throw', async () => {
    const conn = await connectInMemory(buildServer, { era });
    try {
      for (const [tool, feature] of [
        ['confirm', 'elicitation'],
        ['summarise', 'sampling'],
        ['roots', 'roots'],
      ] as const) {
        const r = await text(conn.client, tool);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
          `unsupported: ${feature} is not supported by this client: it did not declare the ${feature} capability`,
        );
      }
    } finally {
      await conn.close();
    }
  });
});

describe('client input over stateless HTTP', () => {
  it('2025-era requests carry no client capabilities (unsupported); 2026-07-28 requests do', async () => {
    const port = await freePort();
    const saved = { ...process.env };
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    let handle: Awaited<ReturnType<typeof startMcpServer>>;
    try {
      handle = await startMcpServer(buildServer, { mode: 'http', port, apiKey: null, handleSignals: false });
    } finally {
      process.env = saved;
    }
    try {
      for (const era of ['legacy', 'modern'] as const) {
        const client = createTestClient({ era, clientOptions: { capabilities: FULL_CAPS } });
        installHandlers(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
        try {
          const r = await text(client, 'confirm');
          if (era === 'modern') expect(r).toEqual({ text: 'confirmed', isError: false });
          else expect(r.text).toContain('no client capabilities are known for this request');
        } finally {
          await client.close();
        }
      }
    } finally {
      await handle.close();
    }
  });
});

describe('client input helpers without a protocol', () => {
  it('without an SDK context every helper is unsupported; era detection and capability rules', () => {
    const input = createClientInput(undefined, FULL_CAPS);
    expect(input.elicit('k', { message: 'm', requestedSchema: { type: 'object', properties: {} } }).status).toBe(
      'unsupported',
    );
    expect(input.elicitUrl('k', { message: 'm', url: 'https://x.example' }).status).toBe('unsupported');
    expect(supportsClientFeature({ elicitation: {} }, 'elicitation')).toBe(true);
    expect(supportsClientFeature({ elicitation: { url: {} } }, 'elicitation')).toBe(false);
    expect(supportsClientFeature({ elicitation: { url: {}, form: {} } }, 'elicitation')).toBe(true);
    expect(supportsClientFeature({ elicitation: { url: {} } }, 'elicitation.url')).toBe(true);
    expect(supportsClientFeature({}, 'sampling')).toBe(false);
    expect(supportsClientFeature(undefined, 'roots')).toBe(false);
    const legacy = { mcpReq: {} } as unknown as ServerContext;
    expect(requestEra(legacy)).toBe('legacy');
  });

  it('reads answers from inputResponses: raw JSON Schema content, URL elicitation, decline', () => {
    const sdk = (responses: Record<string, unknown>) =>
      ({ mcpReq: { inputResponses: responses } }) as unknown as ServerContext;
    const raw = createClientInput(sdk({ k: { action: 'accept', content: { a: 1 } } }), FULL_CAPS);
    expect(raw.elicit('k', { message: 'm', requestedSchema: { type: 'object', properties: {} } })).toEqual({
      status: 'accepted',
      value: { a: 1 },
    });
    expect(raw.elicitUrl('k', { message: 'm', url: 'https://x.example' })).toEqual({ status: 'accepted', value: true });
    const declined = createClientInput(sdk({ k: { action: 'decline' } }), FULL_CAPS);
    expect(declined.elicitUrl('k', { message: 'm', url: 'https://x.example' })).toEqual({ status: 'declined' });
    const cancelled = createClientInput(sdk({ k: { action: 'cancel' } }), FULL_CAPS);
    expect(cancelled.elicitUrl('k', { message: 'm', url: 'https://x.example' })).toEqual({ status: 'cancelled' });
    const urlCaps = createClientInput(sdk({}), { elicitation: { url: {} } });
    expect(urlCaps.elicitUrl('k', { message: 'm', url: 'https://x.example' }).status).toBe('pending');
    const noUrl = createClientInput(sdk({}), { elicitation: {} });
    expect(noUrl.elicitUrl('k', { message: 'm', url: 'https://x.example' }).status).toBe('unsupported');
  });
});
