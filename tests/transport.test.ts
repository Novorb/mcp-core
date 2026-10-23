import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/server';
import type { RequestHandlerConfig, ServerFactory } from '../src/transport.js';
import { resetLogger } from '../src/utils/logger.js';

// The SDK v2 entry points are mocked before importing our module. The classic `jest.mock` does NOT
// apply to native ESM, so use `unstable_mockModule` + a dynamic import AFTER the mocks.
type Guard = (req: IncomingMessage, res: ServerResponse) => boolean;
type NodeHandler = (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>;
interface MockMcpHandler {
  fetch: jest.Mock<() => Promise<Response>>;
  close: jest.Mock<() => Promise<void>>;
}

const mockStdioClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockServeStdio = jest.fn<(factory: ServerFactory, opts?: unknown) => { close: typeof mockStdioClose }>(() => ({
  close: mockStdioClose,
}));
const mockHandlerClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockCreateMcpHandler = jest.fn<(factory: ServerFactory, opts?: unknown) => MockMcpHandler>(() => ({
  fetch: jest.fn<() => Promise<Response>>(),
  close: mockHandlerClose,
}));
const mockNodeHandler = jest.fn<NodeHandler>().mockResolvedValue(undefined);
const mockToNodeHandler = jest.fn<(handler: MockMcpHandler, opts?: unknown) => NodeHandler>(() => mockNodeHandler);
let hostGuardResult = true;
let originGuardResult = true;
function rejectingGuard(result: () => boolean): Guard {
  return (_req, res) => {
    if (result()) return true;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"error":"forbidden"}');
    return false;
  };
}
const mockHostHeaderValidation = jest.fn<(allowed: string[]) => Guard>(() => rejectingGuard(() => hostGuardResult));
const mockOriginValidation = jest.fn<(allowed: string[]) => Guard>(() => rejectingGuard(() => originGuardResult));

jest.unstable_mockModule('@modelcontextprotocol/server/stdio', () => ({ serveStdio: mockServeStdio }));
// Only createMcpHandler is replaced; the bearer gate and content-type helpers are the real SDK (its
// CommonJS build, which the ESM mock registry does not intercept).
const actualServer = createRequire(import.meta.url)('@modelcontextprotocol/server') as Record<string, unknown>;
jest.unstable_mockModule('@modelcontextprotocol/server', () => ({
  ...actualServer,
  createMcpHandler: mockCreateMcpHandler,
}));
jest.unstable_mockModule('@modelcontextprotocol/node', () => ({
  toNodeHandler: mockToNodeHandler,
  hostHeaderValidation: mockHostHeaderValidation,
  originValidation: mockOriginValidation,
}));

const { startMcpServer, resolveHttpAuth, bearerMatches, createRequestHandler } = await import('../src/transport.js');

// --- Mock req/res helpers so the handler can be exercised without binding a socket ----------------
function makeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const { method = 'GET', url = '/', headers = {}, body = null } = opts;
  // A POST body is read via req.on('data'/'end'); a non-POST never reads, so an idle stream is fine.
  const base = body != null ? Readable.from([Buffer.from(body)]) : new Readable({ read() {} });
  const r = base as Readable & { method: string; url: string; headers: Record<string, string> };
  r.method = method;
  r.url = url;
  r.headers = headers;
  return r as unknown as IncomingMessage;
}

/** A ServerResponse stand-in that also records what the handler wrote, so tests can assert on it. */
type TestServerResponse = ServerResponse & { headersOut: Record<string, string>; body: string };

function makeRes(): TestServerResponse {
  const res = {
    statusCode: 0,
    headersOut: {} as Record<string, string>,
    body: '',
    headersSent: false,
    writeHead(code: number, hdrs?: Record<string, string>) {
      res.statusCode = code;
      if (hdrs) res.headersOut = hdrs;
      res.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk;
    },
  };
  return res as unknown as TestServerResponse;
}

const fakeServer = { connect: jest.fn() } as unknown as McpServer;

describe('startMcpServer', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let sigintBefore: NodeJS.SignalsListener[];
  let sigtermBefore: NodeJS.SignalsListener[];

  beforeEach(() => {
    originalEnv = { ...process.env };
    sigintBefore = process.listeners('SIGINT');
    sigtermBefore = process.listeners('SIGTERM');
    jest.clearAllMocks();
    hostGuardResult = true;
    originGuardResult = true;
  });

  afterEach(() => {
    process.env = originalEnv;
    for (const l of process.listeners('SIGINT')) if (!sigintBefore.includes(l)) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) if (!sigtermBefore.includes(l)) process.off('SIGTERM', l);
  });

  function addedListener(signal: 'SIGINT' | 'SIGTERM'): NodeJS.SignalsListener {
    const before = signal === 'SIGINT' ? sigintBefore : sigtermBefore;
    const added = process.listeners(signal).filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    return added[0] as NodeJS.SignalsListener;
  }

  // -------------------------------------------------------------------------
  // stdio transport (serveStdio)
  // -------------------------------------------------------------------------

  describe('stdio transport', () => {
    it('uses stdio when MCP_TRANSPORT is not set', async () => {
      delete process.env.MCP_TRANSPORT;
      await startMcpServer(() => fakeServer);
      expect(mockServeStdio).toHaveBeenCalledTimes(1);
    });

    it('uses stdio when MCP_TRANSPORT=stdio', async () => {
      process.env.MCP_TRANSPORT = 'stdio';
      await startMcpServer(() => fakeServer);
      expect(mockServeStdio).toHaveBeenCalledTimes(1);
    });

    it('option mode takes precedence over env var', async () => {
      process.env.MCP_TRANSPORT = 'http';
      await startMcpServer(() => fakeServer, { mode: 'stdio' });
      expect(mockServeStdio).toHaveBeenCalledTimes(1);
      expect(mockCreateMcpHandler).not.toHaveBeenCalled();
    });

    it('hands the factory itself to serveStdio (no eager construction)', async () => {
      const factory = jest.fn<ServerFactory>(() => fakeServer);
      await startMcpServer(factory, { mode: 'stdio' });
      expect(mockServeStdio.mock.calls[0]?.[0]).toBe(factory);
      expect(factory).not.toHaveBeenCalled();
    });

    it('wraps a server instance as () => instance', async () => {
      await startMcpServer(fakeServer, { mode: 'stdio' });
      const factory = mockServeStdio.mock.calls[0]?.[0] as ServerFactory;
      expect(factory()).toBe(fakeServer);
    });

    it('passes an onerror that reports to the logger (stderr)', async () => {
      resetLogger();
      const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await startMcpServer(() => fakeServer, { mode: 'stdio' });
        const opts = mockServeStdio.mock.calls[0]?.[1] as { onerror: (e: Error) => void };
        opts.onerror(new Error('stdio broke'));
        expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('stdio broke');
      } finally {
        write.mockRestore();
      }
    });

    it('SIGINT closes the stdio handle and re-raises the signal once no other listener remains', async () => {
      const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
      for (const l of sigintBefore) process.off('SIGINT', l);
      try {
        await startMcpServer(() => fakeServer, { mode: 'stdio' });
        const onSigint = addedListener('SIGINT');
        addedListener('SIGTERM');
        onSigint('SIGINT');
        await new Promise((r) => setImmediate(r));
        expect(mockStdioClose).toHaveBeenCalledTimes(1);
        expect(process.listeners('SIGINT').filter((l) => !sigintBefore.includes(l))).toHaveLength(0);
        expect(process.listeners('SIGTERM').filter((l) => !sigtermBefore.includes(l))).toHaveLength(0);
        expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
      } finally {
        for (const l of sigintBefore) process.on('SIGINT', l);
        kill.mockRestore();
      }
    });

    it('does not re-raise when another SIGINT listener is still registered; a failing close is logged', async () => {
      resetLogger();
      const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
      const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      mockStdioClose.mockRejectedValueOnce(new Error('close failed'));
      const other = (): void => {};
      process.on('SIGINT', other);
      try {
        await startMcpServer(() => fakeServer, { mode: 'stdio' });
        const added = process.listeners('SIGINT').filter((l) => !sigintBefore.includes(l) && l !== other);
        (added[0] as NodeJS.SignalsListener)('SIGINT');
        await new Promise((r) => setImmediate(r));
        expect(mockStdioClose).toHaveBeenCalledTimes(1);
        expect(kill).not.toHaveBeenCalled();
        expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('close failed');
      } finally {
        process.off('SIGINT', other);
        write.mockRestore();
        kill.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // HTTP start guards (these throw before any socket is bound, so no open handle)
  // -------------------------------------------------------------------------

  describe('HTTP start guards', () => {
    beforeEach(() => {
      delete process.env.MCP_API_KEY;
      delete process.env.MCP_AUTH_DISABLED;
    });

    it('HTTP REFUSES a server instance (factory required in SDK v2)', async () => {
      process.env.MCP_API_KEY = 'k';
      await expect(startMcpServer(fakeServer, { mode: 'http' })).rejects.toThrow(
        'HTTP transport requires a server factory; one McpServer serves one connection in SDK v2',
      );
      expect(mockCreateMcpHandler).not.toHaveBeenCalled();
    });

    it('startMcpServer(http) REFUSES to start with no key and no explicit disable', async () => {
      process.env.MCP_TRANSPORT = 'http';
      await expect(startMcpServer(() => fakeServer)).rejects.toThrow(/refused to start without auth/i);
      expect(mockCreateMcpHandler).not.toHaveBeenCalled();
    });
  });

  describe('HTTP auth resolution (fail-closed)', () => {
    it('resolveHttpAuth throws when no key + not disabled', () => {
      expect(() => resolveHttpAuth({}, {})).toThrow(/without auth/i);
    });

    it('treats an EMPTY-string MCP_API_KEY as not-configured (still throws)', () => {
      expect(() => resolveHttpAuth({}, { MCP_API_KEY: '' })).toThrow(/without auth/i);
    });

    it('enforces auth when a non-empty key is set', () => {
      expect(resolveHttpAuth({}, { MCP_API_KEY: 'sekret' })).toEqual({ authEnabled: true, apiKey: 'sekret' });
    });

    it('a programmatic apiKey wins over MCP_API_KEY', () => {
      expect(resolveHttpAuth({ apiKey: 'prog' }, { MCP_API_KEY: 'env' })).toEqual({
        authEnabled: true,
        apiKey: 'prog',
      });
    });

    it('runs OPEN only when MCP_AUTH_DISABLED=true (explicit opt-in)', () => {
      expect(resolveHttpAuth({}, { MCP_AUTH_DISABLED: 'true' })).toEqual({ authEnabled: false, apiKey: '' });
    });

    it('runs OPEN when apiKey:null is passed programmatically', () => {
      expect(resolveHttpAuth({ apiKey: null }, {})).toEqual({ authEnabled: false, apiKey: '' });
    });

    it('a verifier always enforces auth, even with the disable switches set', () => {
      const verifier = { verifyAccessToken: jest.fn<() => Promise<never>>() };
      expect(resolveHttpAuth({ apiKey: null, auth: { verifier } }, { MCP_AUTH_DISABLED: 'true' })).toEqual({
        authEnabled: true,
        apiKey: '',
      });
    });

    it('an unknown MCP_TRANSPORT value throws instead of silently picking a mode', async () => {
      process.env.MCP_TRANSPORT = 'stdin';
      await expect(startMcpServer(() => fakeServer)).rejects.toThrow(/MCP_TRANSPORT must be 'stdio' or 'http'/);
    });
  });

  describe('bearerMatches (constant-time auth compare)', () => {
    it('matches the exact Bearer token', () => {
      expect(bearerMatches('Bearer abc123', 'abc123')).toBe(true);
    });
    it('rejects a wrong / missing / malformed token', () => {
      expect(bearerMatches('Bearer wrong', 'abc123')).toBe(false);
      expect(bearerMatches('', 'abc123')).toBe(false);
      expect(bearerMatches('abc123', 'abc123')).toBe(false); // missing "Bearer " prefix
      expect(bearerMatches('Bearer abc123 ', 'abc123')).toBe(false); // trailing space
    });
  });

  // -------------------------------------------------------------------------
  // createRequestHandler: the routing/auth/guards unit, exercised with mock req/res
  // -------------------------------------------------------------------------

  describe('createRequestHandler', () => {
    function makeConfig(overrides: Partial<RequestHandlerConfig> = {}): RequestHandlerConfig {
      return {
        getServer: () => fakeServer,
        authEnabled: false,
        apiKey: '',
        maxBodyBytes: 4 * 1024 * 1024,
        enableDnsRebindingProtection: false,
        allowedHosts: [],
        allowedOrigins: [],
        ...overrides,
      };
    }

    it('builds ONE createMcpHandler (stateless legacy, SDK default responseMode auto) and adapts it', () => {
      const getServer = (): McpServer => fakeServer;
      createRequestHandler(makeConfig({ getServer }));
      expect(mockCreateMcpHandler).toHaveBeenCalledTimes(1);
      expect(mockCreateMcpHandler.mock.calls[0]?.[0]).toBe(getServer);
      expect(mockCreateMcpHandler.mock.calls[0]?.[1]).toMatchObject({ legacy: 'stateless' });
      const handlerOpts = mockCreateMcpHandler.mock.calls[0]?.[1] as
        | { onerror?: unknown; responseMode?: unknown }
        | undefined;
      // No 'json': progress and log notifications must be able to upgrade the response to SSE.
      expect(handlerOpts?.responseMode).toBeUndefined();
      expect(typeof handlerOpts?.onerror).toBe('function');
      expect(mockToNodeHandler).toHaveBeenCalledTimes(1);
      expect(mockToNodeHandler.mock.calls[0]?.[0]).toBe(mockCreateMcpHandler.mock.results[0]?.value);
    });

    it('close() closes the SDK handler', async () => {
      const handler = createRequestHandler(makeConfig());
      await handler.close();
      expect(mockHandlerClose).toHaveBeenCalledTimes(1);
    });

    it('returns 200 { status: "healthy" } for GET /health without auth', async () => {
      const handler = createRequestHandler(makeConfig({ authEnabled: true, apiKey: 'k' }));
      const res = makeRes();
      await handler(makeReq({ method: 'GET', url: '/health' }), res);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'healthy' });
      expect(mockNodeHandler).not.toHaveBeenCalled();
    });

    it('returns 401 when auth is enabled and the Bearer token is missing/wrong', async () => {
      const handler = createRequestHandler(makeConfig({ authEnabled: true, apiKey: 'secret' }));

      const resMissing = makeRes();
      await handler(makeReq({ method: 'POST', url: '/mcp', headers: {} }), resMissing);
      expect(resMissing.statusCode).toBe(401);

      const resWrong = makeRes();
      await handler(makeReq({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer nope' } }), resWrong);
      expect(resWrong.statusCode).toBe(401);
      expect(mockNodeHandler).not.toHaveBeenCalled();
    });

    it('answers the SDK OAuth challenge: invalid_token body and a WWW-Authenticate Bearer header', async () => {
      const handler = createRequestHandler(makeConfig({ authEnabled: true, apiKey: 'secret' }));
      const res = makeRes();
      await handler(makeReq({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer nope' } }), res);
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_token' });
      expect(res.headersOut['www-authenticate']).toMatch(/^Bearer /);
      expect(res.body).not.toContain('secret');
    });

    it('sets req.auth to an AuthInfo with a placeholder token (never the key) for the SDK to forward', async () => {
      const handler = createRequestHandler(
        makeConfig({ authEnabled: true, apiKey: 'secret', auth: { apiKey: { clientId: 'fleet', scopes: ['read'] } } }),
      );
      const req = makeReq({ method: 'GET', url: '/mcp', headers: { authorization: 'Bearer secret' } });
      await handler(req, makeRes());
      const auth = (req as IncomingMessage & { auth?: { token: string; clientId: string; scopes: string[] } }).auth;
      expect(auth).toMatchObject({ token: '[api-key]', clientId: 'fleet', scopes: ['read'] });
      expect(JSON.stringify(auth)).not.toContain('secret');
      expect(mockNodeHandler).toHaveBeenCalledTimes(1);
    });

    it('a pluggable verifier replaces the key; requiredScopes answers 403 insufficient_scope', async () => {
      const verifier = {
        verifyAccessToken: jest.fn(async (token: string) => ({
          token,
          clientId: 'jwt-user',
          scopes: token === 'admin' ? ['mcp', 'admin'] : ['mcp'],
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        })),
      };
      const handler = createRequestHandler(
        makeConfig({ authEnabled: true, apiKey: '', auth: { verifier, requiredScopes: ['admin'] } }),
      );
      const denied = makeRes();
      await handler(makeReq({ method: 'GET', url: '/mcp', headers: { authorization: 'Bearer user' } }), denied);
      expect(denied.statusCode).toBe(403);
      expect(JSON.parse(denied.body)).toMatchObject({ error: 'insufficient_scope' });
      await handler(makeReq({ method: 'GET', url: '/mcp', headers: { authorization: 'Bearer admin' } }), makeRes());
      expect(mockNodeHandler).toHaveBeenCalledTimes(1);
      expect(verifier.verifyAccessToken).toHaveBeenCalledTimes(2);
    });

    it('refuses an enabled gate with neither a key nor a verifier', () => {
      expect(() => createRequestHandler(makeConfig({ authEnabled: true, apiKey: '' }))).toThrow(/neither an API key/);
    });

    it('compares the media-type essence: params and case allowed, application/json-seq refused', async () => {
      const handler = createRequestHandler(makeConfig());
      const seq = makeRes();
      await handler(
        makeReq({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json-seq' }, body: '{}' }),
        seq,
      );
      expect(seq.statusCode).toBe(415);
      await handler(
        makeReq({
          method: 'POST',
          url: '/mcp',
          headers: { 'content-type': 'Application/JSON; charset=utf-8' },
          body: '{}',
        }),
        makeRes(),
      );
      expect(mockNodeHandler).toHaveBeenCalledTimes(1);
    });

    it('MCP_AUTH_DISABLED (authEnabled:false) lets an unauthenticated /mcp request through', async () => {
      const handler = createRequestHandler(makeConfig());
      await handler(makeReq({ method: 'GET', url: '/mcp' }), makeRes());
      expect(mockNodeHandler).toHaveBeenCalledTimes(1);
    });

    it('delegates an authenticated GET /mcp to the node handler with no parsed body', async () => {
      const handler = createRequestHandler(makeConfig({ authEnabled: true, apiKey: 'secret' }));
      const req = makeReq({ method: 'GET', url: '/mcp', headers: { authorization: 'Bearer secret' } });
      const res = makeRes();
      await handler(req, res);
      expect(mockNodeHandler).toHaveBeenCalledTimes(1);
      expect(mockNodeHandler.mock.calls[0]?.[0]).toBe(req);
      expect(mockNodeHandler.mock.calls[0]?.[1]).toBe(res);
      expect(mockNodeHandler.mock.calls[0]?.[2]).toBeUndefined();
    });

    it('delegates a valid POST /mcp (and /mcp?query) with the parsed JSON body', async () => {
      const handler = createRequestHandler(makeConfig());
      for (const url of ['/mcp', '/mcp?x=1']) {
        await handler(
          makeReq({
            method: 'POST',
            url,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
          }),
          makeRes(),
        );
      }
      expect(mockNodeHandler).toHaveBeenCalledTimes(2);
      expect(mockNodeHandler.mock.calls[0]?.[2]).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
    });

    it('answers a JSON-RPC parse error (400) for an empty or malformed POST body', async () => {
      const handler = createRequestHandler(makeConfig());
      for (const body of ['', '{not json']) {
        const res = makeRes();
        await handler(
          makeReq({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, body }),
          res,
        );
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 }, id: null });
      }
      expect(mockNodeHandler).not.toHaveBeenCalled();
    });

    it('returns 415 when POST /mcp is not application/json', async () => {
      const handler = createRequestHandler(makeConfig());
      const res = makeRes();
      await handler(
        makeReq({ method: 'POST', url: '/mcp', headers: { 'content-type': 'text/plain' }, body: 'hi' }),
        res,
      );
      expect(res.statusCode).toBe(415);
      expect(mockNodeHandler).not.toHaveBeenCalled();
    });

    it('returns 413 when the POST body exceeds maxBodyBytes', async () => {
      const handler = createRequestHandler(makeConfig({ maxBodyBytes: 8 }));
      const res = makeRes();
      const req = makeReq({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(64),
      });
      await handler(req, res);
      expect(res.statusCode).toBe(413);
      // The 413 closes the connection after the response instead of destroying the socket first.
      expect(res.headersOut.Connection).toBe('close');
      expect(mockNodeHandler).not.toHaveBeenCalled();
    });

    it('drains (and discards) the chunks after the cap instead of destroying the request', async () => {
      const handler = createRequestHandler(makeConfig({ maxBodyBytes: 8 }));
      const res = makeRes();
      // autoDestroy off, so `destroyed` reflects only an explicit destroy() by the handler.
      // Regression: destroying the request socket meant the client never received the 413.
      const stream = new Readable({ autoDestroy: false, read() {} });
      for (const chunk of ['x'.repeat(16), 'y'.repeat(16), 'z']) stream.push(Buffer.from(chunk));
      stream.push(null);
      const req = Object.assign(stream, {
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
      }) as unknown as IncomingMessage;
      await handler(req, res);
      await new Promise<void>((r) => (stream.readableEnded ? r() : stream.once('end', () => r())));
      expect(res.statusCode).toBe(413);
      expect(req.destroyed).toBe(false);
      expect(mockNodeHandler).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown route', async () => {
      const handler = createRequestHandler(makeConfig());
      const res = makeRes();
      await handler(makeReq({ method: 'GET', url: '/nope' }), res);
      expect(res.statusCode).toBe(404);
      expect(mockNodeHandler).not.toHaveBeenCalled();
    });

    it('returns 500 (without leaking details) and reports to the logger when the delegate throws', async () => {
      resetLogger();
      const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      mockNodeHandler.mockRejectedValueOnce(new Error('boom secret detail'));
      try {
        const handler = createRequestHandler(makeConfig());
        const res = makeRes();
        await handler(
          makeReq({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, body: '{}' }),
          res,
        );
        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error' });
        expect(res.body).not.toContain('boom secret detail');
        expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('boom secret detail');
      } finally {
        write.mockRestore();
      }
    });

    it('reports a non-Error throw from the delegate too', async () => {
      resetLogger();
      const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      mockNodeHandler.mockRejectedValueOnce('plain string failure');
      try {
        const handler = createRequestHandler(makeConfig());
        const res = makeRes();
        await handler(makeReq({ method: 'GET', url: '/mcp' }), res);
        expect(res.statusCode).toBe(500);
        expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('plain string failure');
      } finally {
        write.mockRestore();
      }
    });

    describe('Host / Origin allow-lists (DNS-rebinding protection)', () => {
      it('installs no validators when protection is off', async () => {
        const handler = createRequestHandler(makeConfig({ allowedHosts: ['a.example'] }));
        await handler(makeReq({ method: 'GET', url: '/mcp' }), makeRes());
        expect(mockHostHeaderValidation).not.toHaveBeenCalled();
        expect(mockOriginValidation).not.toHaveBeenCalled();
        expect(mockNodeHandler).toHaveBeenCalledTimes(1);
      });

      it('builds the SDK guards from port-agnostic hostnames (host:port and full origins normalised)', () => {
        createRequestHandler(
          makeConfig({
            enableDnsRebindingProtection: true,
            allowedHosts: ['api.example.com', 'localhost:8080', '[::1]:3000'],
            allowedOrigins: ['https://app.example.com', 'http://localhost:3000', 'chrome-extension://*', 'plain.host'],
          }),
        );
        expect(mockHostHeaderValidation).toHaveBeenCalledWith(['api.example.com', 'localhost', '[::1]']);
        expect(mockOriginValidation).toHaveBeenCalledWith([
          'app.example.com',
          'localhost',
          'chrome-extension://*',
          'plain.host',
        ]);
      });

      it('keeps an unparseable allow-list entry verbatim (it then simply never matches)', () => {
        createRequestHandler(
          makeConfig({
            enableDnsRebindingProtection: true,
            allowedHosts: ['bad host'],
            allowedOrigins: ['http://[bad'],
          }),
        );
        expect(mockHostHeaderValidation).toHaveBeenCalledWith(['bad host']);
        expect(mockOriginValidation).toHaveBeenCalledWith(['http://[bad']);
      });

      it('only the configured list gets a guard', () => {
        createRequestHandler(makeConfig({ enableDnsRebindingProtection: true, allowedOrigins: ['https://a.example'] }));
        expect(mockHostHeaderValidation).not.toHaveBeenCalled();
        expect(mockOriginValidation).toHaveBeenCalledTimes(1);
      });

      it('a rejecting Host guard answers (403) before the body is read or the delegate runs', async () => {
        hostGuardResult = false;
        const handler = createRequestHandler(
          makeConfig({ enableDnsRebindingProtection: true, allowedHosts: ['good.example'] }),
        );
        const res = makeRes();
        await handler(
          makeReq({ method: 'POST', url: '/mcp', headers: { 'content-type': 'text/plain' }, body: 'x' }),
          res,
        );
        expect(res.statusCode).toBe(403);
        expect(mockNodeHandler).not.toHaveBeenCalled();
      });

      it('a rejecting Origin guard answers 403', async () => {
        originGuardResult = false;
        const handler = createRequestHandler(
          makeConfig({ enableDnsRebindingProtection: true, allowedHosts: ['h'], allowedOrigins: ['https://o'] }),
        );
        const res = makeRes();
        await handler(makeReq({ method: 'GET', url: '/mcp' }), res);
        expect(res.statusCode).toBe(403);
        expect(mockNodeHandler).not.toHaveBeenCalled();
      });

      it('passing guards reach the delegate; /health is never guarded', async () => {
        const handler = createRequestHandler(
          makeConfig({ enableDnsRebindingProtection: true, allowedHosts: ['h'], allowedOrigins: ['https://o'] }),
        );
        await handler(makeReq({ method: 'GET', url: '/mcp' }), makeRes());
        expect(mockNodeHandler).toHaveBeenCalledTimes(1);
        hostGuardResult = false;
        const res = makeRes();
        await handler(makeReq({ method: 'GET', url: '/health' }), res);
        expect(res.statusCode).toBe(200);
      });
    });
  });
});
