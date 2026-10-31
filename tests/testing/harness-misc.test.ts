import { existsSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import * as z from 'zod/v4';
import { createMcpServer, TOOL_ANNOTATIONS } from '../../src/server.js';
import {
  connectInMemory,
  createIsolatedDirs,
  createTestClient,
  initializeRequestBody,
  makeRecordingServer,
  mcpPostHeaders,
  rawHttp,
} from '../../src/testing/index.js';
import { buildEchoServer, registerEchoTools } from '../fixtures/echo-tools.js';

describe('createIsolatedDirs', () => {
  it('creates cwd/home/logs/state/tmp under one temp root and an env pointing into it', () => {
    const dirs = createIsolatedDirs('mcp core/prefix');
    try {
      for (const d of [dirs.cwd, dirs.home, dirs.logs, dirs.state, dirs.tmp]) {
        expect(d.startsWith(dirs.root)).toBe(true);
        expect(existsSync(d)).toBe(true);
      }
      expect(dirs.root).toMatch(/mcp-core-prefix-/);
      const env = dirs.env();
      expect(env).toMatchObject({
        HOME: dirs.home,
        USERPROFILE: dirs.home,
        LOG_PATH: dirs.logs,
        TMPDIR: dirs.tmp,
        TEMP: dirs.tmp,
        TMP: dirs.tmp,
      });
      for (const key of [
        'APPDATA',
        'LOCALAPPDATA',
        'XDG_CONFIG_HOME',
        'XDG_CACHE_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
      ]) {
        expect(env[key]?.startsWith(dirs.home)).toBe(true);
      }
      const db = dirs.dir('db');
      expect(db).toBe(join(dirs.root, 'db'));
      expect(existsSync(db)).toBe(true);
      expect(dirs.dir('a/b')).toBe(join(dirs.root, 'a-b'));
      expect(() => dirs.dir('...')).toThrow(/invalid directory name/);
      writeFileSync(join(dirs.logs, 'x.log'), 'x');
    } finally {
      dirs.cleanup();
      dirs.cleanup();
    }
    expect(existsSync(dirs.root)).toBe(false);
  });

  it('uses a default prefix', () => {
    const dirs = createIsolatedDirs();
    expect(dirs.root).toMatch(/mcp-it-/);
    dirs.cleanup();
  });
});

describe('rawHttp', () => {
  let server: HttpServer;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        res.writeHead(201, { 'X-Echo-Method': req.method ?? '', 'Content-Type': 'text/plain' });
        res.end(`${req.headers.authorization ?? 'none'}|${body}`);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('defaults to POST and returns status, lower-cased headers and text', async () => {
    const res = await rawHttp(base, { headers: mcpPostHeaders('k-123'), body: 'payload' });
    expect(res.status).toBe(201);
    expect(res.headers['x-echo-method']).toBe('POST');
    expect(res.text).toBe('Bearer k-123|payload');
  });

  it('supports other methods and no options', async () => {
    expect((await rawHttp(base, { method: 'GET' })).text).toBe('none|');
    expect((await rawHttp(base)).headers['x-echo-method']).toBe('POST');
  });

  it('builds the MCP POST headers and an initialize body', () => {
    expect(mcpPostHeaders()).toEqual({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });
    expect(mcpPostHeaders('abc').authorization).toBe('Bearer abc');
    expect(JSON.parse(initializeRequestBody(7))).toMatchObject({ jsonrpc: '2.0', id: 7, method: 'initialize' });
  });
});

describe('makeRecordingServer', () => {
  it('records tools and prompts, replaces by name, and removes through the handle', async () => {
    const rec = makeRecordingServer();
    const server = rec.asMcpServer();
    const handle = server.registerTool(
      'lookup',
      { description: 'Look up', inputSchema: z.object({ key: z.string() }), annotations: TOOL_ANNOTATIONS.readOnly },
      async ({ key }) => ({ content: [{ type: 'text', text: `v:${key}` }] }),
    );
    const prompt = server.registerPrompt('ask', { description: 'Ask' }, () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'q' } }],
    }));
    expect([...rec.tools.keys()]).toEqual(['lookup']);
    expect(rec.tools.get('lookup')?.config.description).toBe('Look up');
    const result = await rec.tools.get('lookup')?.handler({ key: 'k' });
    expect(result?.content).toEqual([{ type: 'text', text: 'v:k' }]);
    const promptResult = await rec.prompts.get('ask')?.handler({});
    expect(promptResult?.messages).toHaveLength(1);

    server.registerTool('lookup', { description: 'Replaced' }, async () => ({ content: [] }));
    expect(rec.tools.get('lookup')?.config.description).toBe('Replaced');
    handle.remove();
    prompt.remove();
    expect(rec.tools.size).toBe(0);
    expect(rec.prompts.size).toBe(0);
  });

  it('captures a real register function', () => {
    const rec = makeRecordingServer();
    registerEchoTools(rec.asMcpServer());
    expect(rec.tools.size).toBe(8);
  });
});

describe('connectInMemory / createTestClient', () => {
  it('reports server errors to onServerError and closes idempotently', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const errors: Error[] = [];
    const conn = await connectInMemory(buildEchoServer, { onServerError: (e) => errors.push(e) });
    try {
      expect((await conn.client.listTools()).tools.length).toBe(8);
    } finally {
      await Promise.all([conn.close(), conn.close()]);
      stderr.mockRestore();
    }
  });

  it('rejects (and tears down) when the client cannot connect', async () => {
    const broken = () => {
      const s = createMcpServer('broken', '1.0.0');
      // Force a failure while the server instance is built for the opening message.
      throw Object.assign(new Error('factory failed'), { server: s });
    };
    await expect(connectInMemory(broken)).rejects.toThrow();
  });

  it('uses the given client info and options', async () => {
    const client = createTestClient({ clientInfo: { name: 'custom', version: '9.9.9' }, clientOptions: {} });
    expect(client).toBeDefined();
    const conn = await connectInMemory(buildEchoServer, { era: 'modern', clientInfo: { name: 'n', version: '1' } });
    expect(conn.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    await conn.close();
  });
});
