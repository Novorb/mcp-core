import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as z from 'zod/v4';
import { createNotifier, createRuntimeSurface, InMemoryServerEventBus } from '../src/notifications.js';
import { definePrompt, normalizePromptOutcome, registerPrompts } from '../src/prompts.js';
import { completable, createMcpServer, ProtocolError, ProtocolErrorCode } from '../src/server.js';
import { connectInMemory, type ProtocolEra } from '../src/testing/index.js';
import { loadEnv } from '../src/utils/envLoader.js';
import { addLogListener, initLogger, type LogEntry, registerSecretValues, resetLogger } from '../src/utils/logger.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;
let entries: LogEntry[];
let unlisten: () => void;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'prompts-test', fileMain: false, fileExceptions: false, fileDebug: false });
  entries = [];
  unlisten = addLogListener((e) => entries.push(e));
});

afterEach(() => {
  unlisten();
  stderr.mockRestore();
  resetLogger();
});

const env = loadEnv([{ key: 'PROMPT_TOKEN', secret: true }], { rootDir: process.cwd(), env: {} });
const surface = createRuntimeSurface(createNotifier(new InMemoryServerEventBus()));

function factory() {
  const server = createMcpServer('prompts', '1.0.0');
  registerPrompts(
    server,
    [
      definePrompt({
        name: 'summarise',
        title: 'Summarise',
        description: 'Summarise a document',
        argsSchema: z.object({
          path: completable(z.string(), (v) => ['notes.txt', 'readme.md'].filter((p) => p.startsWith(v))),
        }),
        handler: async ({ path }) => `Summarise ${path}`,
      }),
      definePrompt({
        name: 'plain',
        handler: async (_args, ctx) => ({
          messages: [{ role: 'assistant', content: { type: 'text', text: `era ${ctx.era}` } }],
        }),
      }),
      definePrompt({
        name: 'broken',
        argsSchema: z.object({ q: z.string() }),
        handler: async ({ q }) => {
          throw new Error(`upstream rejected ${q}`);
        },
      }),
      definePrompt({
        name: 'proto',
        handler: async () => {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'bad prompt input');
        },
      }),
      definePrompt({ name: 'locked', requires: ['PROMPT_TOKEN'], handler: async () => 'never' }),
      definePrompt({ name: 'hidden', handler: async () => 'hidden' }),
      definePrompt({ name: 'toggled', handler: async () => 'toggled' }),
    ],
    {
      env,
      serverName: 'prompts-mcp',
      prefix: 'p_',
      enabled: ['summarise', 'plain', 'broken', 'proto', 'locked', 'toggled'],
      surface,
    },
  );
  return server;
}

describe.each<ProtocolEra>(['legacy', 'modern'])('registerPrompts (%s)', (era) => {
  it('lists, gets, completes, maps errors, degrades and follows the surface', async () => {
    registerSecretValues(['prompt-secret-value']);
    const conn = await connectInMemory(factory, { era });
    try {
      const { prompts } = await conn.client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual([
        'p_summarise',
        'p_plain',
        'p_broken',
        'p_proto',
        'p_locked',
        'p_toggled',
      ]);
      const got = await conn.client.getPrompt({ name: 'p_summarise', arguments: { path: 'notes.txt' } });
      expect(got.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Summarise notes.txt' } }]);
      const plain = await conn.client.getPrompt({ name: 'p_plain' });
      expect(plain.messages[0]?.content).toEqual({ type: 'text', text: `era ${era}` });
      const completion = await conn.client.complete({
        ref: { type: 'ref/prompt', name: 'p_summarise' },
        argument: { name: 'path', value: 'r' },
      });
      expect(completion.completion.values).toEqual(['readme.md']);
      await expect(
        conn.client.getPrompt({ name: 'p_broken', arguments: { q: 'prompt-secret-value' } }),
      ).rejects.toMatchObject({
        code: ProtocolErrorCode.InternalError,
        message: expect.stringContaining('upstream rejected [SECRET]'),
      });
      await expect(conn.client.getPrompt({ name: 'p_proto' })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
      });
      await expect(conn.client.getPrompt({ name: 'p_locked' })).rejects.toMatchObject({
        message: expect.stringContaining('prompts-mcp is not configured: set PROMPT_TOKEN'),
      });
      surface.disable('prompt', 'p_toggled');
      expect((await conn.client.listPrompts()).prompts.map((p) => p.name)).not.toContain('p_toggled');
      surface.enable('prompt', 'p_toggled');
      expect((await conn.client.listPrompts()).prompts.map((p) => p.name)).toContain('p_toggled');
    } finally {
      await conn.close();
    }
    const messages = entries.map((e) => e.message);
    expect(messages).toContain('Prompt get: p_summarise');
    expect(messages).toContain('Prompt result: p_broken');
    const get = entries.find((e) => e.message === 'Prompt get: p_summarise');
    expect(JSON.stringify(get?.meta)).not.toContain('notes.txt');
  });
});

describe('prompt registration rules', () => {
  it('normalises a string outcome and refuses undeclared or env-less requires', () => {
    expect(normalizePromptOutcome('hi')).toEqual({
      messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
    });
    const r = { messages: [] };
    expect(normalizePromptOutcome(r)).toBe(r);
    const server = createMcpServer('x', '1.0.0');
    expect(() =>
      registerPrompts(server, [definePrompt({ name: 'a', requires: ['NOPE'], handler: async () => '' })], { env }),
    ).toThrow(/does not declare/);
    expect(() =>
      registerPrompts(server, [definePrompt({ name: 'a', requires: ['NOPE'], handler: async () => '' })]),
    ).toThrow(/no env was passed/);
  });
});
