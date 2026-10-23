import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { createNotifier, InMemoryServerEventBus } from '../src/notifications.js';
import {
  createSealedRequestStateCodec,
  DEFAULT_REQUEST_STATE_TTL_SECONDS,
  defaultRequestStateBinding,
  RequestStateError,
  RequestStateKeyError,
  requestStateCodecFromEnv,
} from '../src/request-state.js';
import { createMcpServer, createRequestStateCodec, TOOL_ANNOTATIONS } from '../src/server.js';
import { InMemoryTaskStore } from '../src/task-store.js';
import { connectInMemory, type ProtocolEra } from '../src/testing/index.js';
import { defineTool, registerTools, toolResult } from '../src/tools.js';
import { loadEnv } from '../src/utils/envLoader.js';
import { addLogListener, initLogger, type LogEntry, maskSecretValues, resetLogger } from '../src/utils/logger.js';
import { buildC2Server, createC2Shared } from './fixtures/c2-tools.js';

const KEY = 'k'.repeat(40);
const OLD_KEY = 'o'.repeat(40);

let stderr: jest.SpiedFunction<typeof process.stderr.write>;
let entries: LogEntry[];
let unlisten: () => void;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'rs-test', fileMain: false, fileExceptions: false, fileDebug: false });
  entries = [];
  unlisten = addLogListener((e) => entries.push(e));
});

afterEach(() => {
  unlisten();
  stderr.mockRestore();
  resetLogger();
});

function ctx(method = 'tools/call', clientId?: string): ServerContext {
  return {
    mcpReq: { method },
    ...(clientId ? { http: { authInfo: { token: 't', clientId, scopes: [] } } } : {}),
  } as unknown as ServerContext;
}

describe('createSealedRequestStateCodec', () => {
  it('round-trips a confidential payload bound to the caller', async () => {
    const codec = createSealedRequestStateCodec<{ quote: number; secret: string }>({ key: KEY });
    const sealed = await codec.mint({ quote: 1.5, secret: 'hidden-value' }, ctx('tools/call', 'alice'));
    expect(sealed.startsWith('ms1.')).toBe(true);
    const [, , , body] = sealed.split('.');
    expect(Buffer.from(String(body), 'base64url').toString('latin1')).not.toContain('hidden-value');
    await expect(codec.verify(sealed, ctx('tools/call', 'alice'))).resolves.toEqual({
      quote: 1.5,
      secret: 'hidden-value',
    });
    await expect(codec.verify(sealed, ctx('tools/call', 'bob'))).rejects.toMatchObject({ reason: 'bind' });
    await expect(codec.verify(sealed, ctx('prompts/get', 'alice'))).rejects.toMatchObject({ reason: 'bind' });
  });

  it('rejects tampering, malformed values, expiry and unknown keys with a reason', async () => {
    let now = 1_000_000;
    const codec = createSealedRequestStateCodec({ key: KEY, ttlSeconds: 60, now: () => now });
    const sealed = await codec.mint({ a: 1 }, ctx());
    const parts = sealed.split('.');
    const body = Buffer.from(String(parts[3]), 'base64url');
    body[0] = (body[0] ?? 0) ^ 1;
    const tampered = [parts[0], parts[1], parts[2], body.toString('base64url')].join('.');
    await expect(codec.verify(tampered, ctx())).rejects.toMatchObject({ reason: 'tampered' });
    await expect(codec.verify('v1.x.y', ctx())).rejects.toMatchObject({ reason: 'malformed' });
    await expect(codec.verify('ms1.kid.AAAA.AAAA', ctx())).rejects.toMatchObject({ reason: 'unknown-key' });
    await expect(codec.verify(`ms1.${parts[1]}.AAAA.AAAA`, ctx())).rejects.toMatchObject({ reason: 'malformed' });
    now += 61_000;
    await expect(codec.verify(sealed, ctx())).rejects.toMatchObject({ reason: 'expired' });
    const err = new RequestStateError('expired');
    expect(err.message).toBe('requestState has expired');
    expect(err.name).toBe('RequestStateError');
  });

  it('rotates: the new key opens state sealed with a previous key', async () => {
    const old = createSealedRequestStateCodec({ key: OLD_KEY });
    const sealed = await old.mint('flow', ctx());
    const rotated = createSealedRequestStateCodec({ key: KEY, previousKeys: [OLD_KEY, OLD_KEY] });
    await expect(rotated.verify(sealed, ctx())).resolves.toBe('flow');
    const fresh = createSealedRequestStateCodec({ key: KEY });
    await expect(fresh.verify(sealed, ctx())).rejects.toMatchObject({ reason: 'unknown-key' });
  });

  it('validates the key length, ttl and bind requirements', async () => {
    expect(() => createSealedRequestStateCodec({ key: 'short' })).toThrow(RequestStateKeyError);
    expect(() => createSealedRequestStateCodec({ key: KEY, previousKeys: ['short'] })).toThrow(/PREVIOUS_KEY/);
    expect(() => createSealedRequestStateCodec({ key: KEY, ttlSeconds: 0 })).toThrow(RangeError);
    expect(() => createSealedRequestStateCodec({ key: new Uint8Array(32) })).not.toThrow();
    const bound = createSealedRequestStateCodec({ key: KEY });
    await expect(bound.mint('x')).rejects.toThrow(TypeError);
    const unbound = createSealedRequestStateCodec({ key: KEY, bind: false });
    const s = await unbound.mint('x');
    await expect(unbound.verify(s, ctx('anything', 'anyone'))).resolves.toBe('x');
    expect(defaultRequestStateBinding(ctx('tools/call', 'c'))).toBe('tools/call\0c');
    expect(DEFAULT_REQUEST_STATE_TTL_SECONDS).toBe(600);
  });
});

describe('requestStateCodecFromEnv', () => {
  it('refuses to start without a key and registers every key for masking', async () => {
    expect(() => requestStateCodecFromEnv({})).toThrow(/set MCP_REQUEST_STATE_KEY/);
    const codec = requestStateCodecFromEnv({
      MCP_REQUEST_STATE_KEY: KEY,
      MCP_REQUEST_STATE_PREVIOUS_KEY: OLD_KEY,
      MCP_REQUEST_STATE_PREVIOUS_KEY_2: 'p'.repeat(40),
      MCP_REQUEST_STATE_TTL_SECONDS: '30',
    });
    expect(maskSecretValues(`x ${KEY} ${OLD_KEY}`)).toBe('x [SECRET] [SECRET]');
    const old = createSealedRequestStateCodec({ key: 'p'.repeat(40) });
    await expect(codec.verify(await old.mint(1, ctx()), ctx())).resolves.toBe(1);
    const loaded = loadEnv([], {
      rootDir: process.cwd(),
      env: { MCP_REQUEST_STATE_KEY: KEY, MCP_REQUEST_STATE_PREVIOUS_KEY_1: OLD_KEY, MCP_ENV_FILE: 'none' },
    });
    const fromLoaded = requestStateCodecFromEnv(loaded);
    const oldSealed = await createSealedRequestStateCodec({ key: OLD_KEY }).mint(2, ctx());
    await expect(fromLoaded.verify(oldSealed, ctx())).resolves.toBe(2);
    expect(() => requestStateCodecFromEnv({ MCP_REQUEST_STATE_KEY: 'too-short' })).toThrow(/at least 32 bytes/);
  });
});

describe.each<ProtocolEra>(['legacy', 'modern'])('multi-step tool over MRTR (%s)', (era) => {
  it('asks, resumes from the sealed state, and reads the answer', async () => {
    const shared = createC2Shared(
      new InMemoryTaskStore(),
      createNotifier(new InMemoryServerEventBus()),
      createSealedRequestStateCodec({ key: KEY }),
    );
    const prompts: string[] = [];
    const conn = await connectInMemory((req) => buildC2Server(shared, req), {
      era,
      clientOptions: { capabilities: { elicitation: { form: {} } } },
    });
    conn.client.setRequestHandler('elicitation/create', async (request) => {
      prompts.push(String(request.params.message));
      return { action: 'accept', content: { confirm: true } };
    });
    try {
      const result = await conn.client.callTool({ name: 'transfer', arguments: { amount: 100 } });
      expect(result.structuredContent).toEqual({ transferred: 101, step: 2 });
      expect(prompts).toEqual(['Transfer with fee, total 101?']);
    } finally {
      await conn.close();
      shared.store.close();
    }
  });

  it('refuses a forged requestState with the frozen -32602 and logs the reason', async () => {
    const codec = createSealedRequestStateCodec({ key: KEY });
    const factory = () => {
      const server = createMcpServer('rs', '1.0.0', { requestStateCodec: codec });
      registerTools(server, [
        defineTool({
          name: 'step',
          description: 'reads state',
          inputSchema: z.object({}),
          annotations: TOOL_ANNOTATIONS.readOnly,
          handler: async (_a, c) => toolResult({ state: c.requestState() ?? null }),
        }),
      ]);
      return server;
    };
    const conn = await connectInMemory(factory, { era: 'modern' });
    try {
      const forged = await conn.client
        .request(
          { method: 'tools/call', params: { name: 'step', arguments: {}, requestState: 'ms1.forged.AAAA.AAAA' } },
          z.looseObject({}),
        )
        .catch((e: unknown) => e);
      expect(forged).toMatchObject({
        code: -32602,
        message: expect.stringContaining('Invalid or expired requestState'),
      });
      expect(
        entries.some(
          (e) =>
            e.message.startsWith('protocol error: requestState verification rejected tools/call') &&
            e.message.includes('sealed with a key this server does not hold'),
        ),
      ).toBe(true);
      const fresh = await conn.client.callTool({ name: 'step', arguments: {} });
      expect(fresh.structuredContent).toEqual({ state: null });
    } finally {
      await conn.close();
    }
  });
});

describe('createMcpServer requestState wiring', () => {
  it('refuses both a codec and a verify hook, and hands tools no unverified state without a codec', async () => {
    const codec = createRequestStateCodec({ key: KEY });
    expect(() =>
      createMcpServer('x', '1.0.0', { requestStateCodec: codec, requestState: { verify: codec.verify } }),
    ).toThrow(/not both/);
    const factory = () => {
      const server = createMcpServer('plain', '1.0.0');
      registerTools(server, [
        defineTool({
          name: 'ask',
          description: 'tries continueWith without a codec',
          inputSchema: z.object({}),
          annotations: TOOL_ANNOTATIONS.readOnly,
          handler: async (_a, c) => {
            expect(c.requestState()).toBeUndefined();
            return c.continueWith({ x: 1 });
          },
        }),
      ]);
      return server;
    };
    const conn = await connectInMemory(factory, { era: 'modern' });
    try {
      const res = await conn.client.callTool({ name: 'ask', arguments: {} });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('requestState is not configured');
    } finally {
      await conn.close();
    }
  });
});
