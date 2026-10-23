import type { Server as HttpServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AuthInfo } from '@modelcontextprotocol/server';
import express from 'express';
import { createMcpRouter, type McpExpressOptions, type McpExpressRouter, mountMcpServer } from '../src/express.js';
import {
  createTestClient,
  initializeRequestBody,
  mcpPostHeaders,
  type ProtocolEra,
  rawHttp,
} from '../src/testing/index.js';
import type { RequestContext } from '../src/transport.js';
import { initLogger, resetLogger } from '../src/utils/logger.js';
import { buildEchoServer, ECHO_TOOL_NAMES } from './fixtures/echo-tools.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'express-test', fileMain: false, fileExceptions: false, fileDebug: false });
});

afterEach(() => {
  stderr.mockRestore();
  resetLogger();
});

interface Running {
  base: string;
  router: McpExpressRouter;
  stop(): Promise<void>;
}

const factoryAuth: Array<AuthInfo | undefined> = [];

async function start(options: McpExpressOptions, preParse = false): Promise<Running> {
  const app = express();
  if (preParse) app.use(express.json());
  app.get('/other', (_req, res) => void res.send('host route'));
  const router = mountMcpServer(
    app,
    (req: RequestContext) => {
      factoryAuth.push(req.authInfo);
      return buildEchoServer();
    },
    options,
  );
  const server: HttpServer = await new Promise((ok) => {
    const s = app.listen(0, '127.0.0.1', () => ok(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    router,
    stop: async () => {
      await router.close();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}

describe.each<ProtocolEra>(['legacy', 'modern'])('Express adapter round trip (%s era)', (era) => {
  it('lists and calls the echo tools with the API key; the factory gets the AuthInfo', async () => {
    factoryAuth.length = 0;
    const srv = await start({ apiKey: 'express-key-123456', auth: { apiKey: { clientId: 'gw' } } });
    const client = createTestClient({ era });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), {
          requestInit: { headers: { Authorization: 'Bearer express-key-123456' } },
        }),
      );
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(ECHO_TOOL_NAMES);
      expect((await client.callTool({ name: 'echo', arguments: { text: 'hi' } })).content).toEqual([
        { type: 'text', text: 'echo: hi' },
      ]);
      expect(factoryAuth.some((a) => a?.clientId === 'gw' && a.token === '[api-key]')).toBe(true);
    } finally {
      await client.close();
      await srv.stop();
    }
  });

  it('works behind an app-level express.json() (pre-parsed body)', async () => {
    const srv = await start({ apiKey: null }, true);
    const client = createTestClient({ era });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`)));
      expect((await client.callTool({ name: 'echo', arguments: { text: 'x' } })).content).toEqual([
        { type: 'text', text: 'echo: x' },
      ]);
    } finally {
      await client.close();
      await srv.stop();
    }
  });
});

describe('Express adapter guards', () => {
  it('health without auth, 401 challenge, host routes untouched, 405 for a legacy GET', async () => {
    const srv = await start({ apiKey: 'express-key-123456' });
    try {
      const health = await rawHttp(`${srv.base}/health`, { method: 'GET' });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.text)).toEqual({ status: 'healthy' });
      const denied = await rawHttp(`${srv.base}/mcp`, {
        headers: mcpPostHeaders('wrong'),
        body: initializeRequestBody(),
      });
      expect(denied.status).toBe(401);
      expect(denied.headers['www-authenticate']).toMatch(/^Bearer /);
      expect(JSON.parse(denied.text)).toMatchObject({ error: 'invalid_token' });
      expect((await rawHttp(`${srv.base}/other`, { method: 'GET' })).text).toBe('host route');
      const get = await rawHttp(`${srv.base}/mcp`, {
        method: 'GET',
        headers: { authorization: 'Bearer express-key-123456', accept: 'text/event-stream' },
      });
      expect(get.status).toBe(405);
    } finally {
      await srv.stop();
    }
  });

  it('415, 413 and a 400 parse error, in that order after auth', async () => {
    const srv = await start({ apiKey: null, maxBodyBytes: 64 });
    try {
      const wrongType = await rawHttp(`${srv.base}/mcp`, {
        headers: { ...mcpPostHeaders(), 'content-type': 'application/json-seq' },
        body: '{}',
      });
      expect(wrongType.status).toBe(415);
      const tooLarge = await rawHttp(`${srv.base}/mcp`, { headers: mcpPostHeaders(), body: 'x'.repeat(200) });
      expect(tooLarge.status).toBe(413);
      expect(JSON.parse(tooLarge.text)).toEqual({ error: 'Payload Too Large' });
      const bad = await rawHttp(`${srv.base}/mcp`, { headers: mcpPostHeaders(), body: '{not json' });
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.text)).toMatchObject({ error: { code: -32700 } });
    } finally {
      await srv.stop();
    }
  });

  it('Host and Origin allow-lists answer 403 (port-agnostic); a pluggable verifier with required scopes', async () => {
    const verifier = {
      verifyAccessToken: async (token: string): Promise<AuthInfo> => ({
        token,
        clientId: 'jwt',
        scopes: token === 'good' ? ['mcp'] : [],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
    };
    const srv = await start({
      auth: { verifier, requiredScopes: ['mcp'] },
      allowedHosts: ['127.0.0.1:1'],
      allowedOrigins: ['http://localhost:3000'],
    });
    try {
      const scope = await rawHttp(`${srv.base}/mcp`, {
        headers: mcpPostHeaders('weak'),
        body: initializeRequestBody(),
      });
      expect(scope.status).toBe(403);
      expect(JSON.parse(scope.text)).toMatchObject({ error: 'insufficient_scope' });
      const origin = await rawHttp(`${srv.base}/mcp`, {
        headers: { ...mcpPostHeaders('good'), origin: 'https://evil.example' },
        body: initializeRequestBody(),
      });
      expect(origin.status).toBe(403);
      const ok = await rawHttp(`${srv.base}/mcp`, { headers: mcpPostHeaders('good'), body: initializeRequestBody() });
      expect(ok.status).toBe(200);
      const port = new URL(srv.base).port;
      const host = await new Promise<number>((done, fail) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: { ...mcpPostHeaders('good'), host: 'evil.example' },
          },
          (res) => {
            res.resume();
            res.on('end', () => done(res.statusCode ?? 0));
          },
        );
        req.on('error', fail);
        req.end(initializeRequestBody());
      });
      expect(host).toBe(403);
    } finally {
      await srv.stop();
    }
  });

  it('fails closed without a key, a verifier or an explicit null; custom path and no health route', async () => {
    expect(() => createMcpRouter(buildEchoServer, { env: {} })).toThrow(/refused to start without auth/);
    const router = createMcpRouter(buildEchoServer, {
      env: { MCP_API_KEY: 'env-key-123456' },
      path: '/rpc',
      health: false,
    });
    const app = express();
    app.use(router);
    const server: HttpServer = await new Promise((ok) => {
      const s = app.listen(0, '127.0.0.1', () => ok(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await rawHttp(`${base}/health`, { method: 'GET' })).status).toBe(404);
      const ok = await rawHttp(`${base}/rpc`, {
        headers: mcpPostHeaders('env-key-123456'),
        body: initializeRequestBody(),
      });
      expect(ok.status).toBe(200);
    } finally {
      await router.close();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    }
  });
});
