import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { Readable } from 'node:stream';

// Mock the MCP SDK transports before importing our module. The classic `jest.mock` does NOT apply to
// native ESM, so use `unstable_mockModule` + a dynamic import AFTER the mocks (same pattern as
// http-client.test.ts) — otherwise the real StreamableHTTPServerTransport handles /mcp.
const mockStdioConnect = jest.fn<any>().mockResolvedValue(undefined);
const mockHandleRequest = jest.fn<any>().mockResolvedValue(undefined);
const mockStreamableConnect = jest.fn<any>().mockResolvedValue(undefined);

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn<any>().mockImplementation(() => ({
    connect: mockStdioConnect,
  })),
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn<any>().mockImplementation(() => ({
    connect: mockStreamableConnect,
    handleRequest: mockHandleRequest,
    onclose: undefined,
  })),
}));

// Dynamic import AFTER mocks are registered
const {
  startMcpServer,
  resolveHttpAuth,
  bearerMatches,
  createRequestHandler,
} = await import('../src/transport.js');

// --- Mock req/res helpers so the handler can be exercised without binding a socket ----------------
function makeReq(opts: { method?: string; url?: string; headers?: Record<string, string>; body?: string }): any {
  const { method = 'GET', url = '/', headers = {}, body = null } = opts;
  // A POST body is read via req.on('data'/'end'); a non-POST never reads, so an idle stream is fine.
  const r: any = body != null ? Readable.from([Buffer.from(body)]) : new Readable({ read() {} });
  r.method = method;
  r.url = url;
  r.headers = headers;
  return r;
}

function makeRes(): any {
  return {
    statusCode: 0,
    headersOut: {} as Record<string, string>,
    body: '',
    headersSent: false,
    writeHead(code: number, hdrs?: Record<string, string>) {
      this.statusCode = code;
      if (hdrs) this.headersOut = hdrs;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
    },
  };
}

describe('startMcpServer', () => {
  let mockServer: any;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockServer = {
      connect: jest.fn<any>().mockResolvedValue(undefined),
    };
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // -------------------------------------------------------------------------
  // stdio transport
  // -------------------------------------------------------------------------

  describe('stdio transport', () => {
    it('uses stdio when MCP_TRANSPORT is not set', async () => {
      delete process.env.MCP_TRANSPORT;
      await startMcpServer(mockServer);
      expect(mockServer.connect).toHaveBeenCalledTimes(1);
    });

    it('uses stdio when MCP_TRANSPORT=stdio', async () => {
      process.env.MCP_TRANSPORT = 'stdio';
      await startMcpServer(mockServer);
      expect(mockServer.connect).toHaveBeenCalledTimes(1);
    });

    it('uses stdio when mode option is stdio', async () => {
      delete process.env.MCP_TRANSPORT;
      await startMcpServer(mockServer, { mode: 'stdio' });
      expect(mockServer.connect).toHaveBeenCalledTimes(1);
    });

    it('option mode takes precedence over env var', async () => {
      process.env.MCP_TRANSPORT = 'http';
      await startMcpServer(mockServer, { mode: 'stdio' });
      expect(mockServer.connect).toHaveBeenCalledTimes(1);
    });

    it('accepts a factory and calls it once for stdio', async () => {
      delete process.env.MCP_TRANSPORT;
      const factory = jest.fn<any>().mockReturnValue(mockServer);
      await startMcpServer(factory, { mode: 'stdio' });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(mockServer.connect).toHaveBeenCalledTimes(1);
    });
  });

  // NOTE: HTTP transport is intentionally NOT exercised by calling startMcpServer() in http
  // mode here — that starts a real listener and blocks until SIGTERM (startMcpServer never
  // resolves), which leaves an open handle and hangs the Jest process / CI job. The /health
  // contract is covered below with a self-contained, closeable http.createServer instead.

  // -------------------------------------------------------------------------
  // transport options
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // HTTP auth — FAIL CLOSED (these throw before any socket is bound, so no open handle)
  // -------------------------------------------------------------------------
  describe('HTTP auth resolution (fail-closed)', () => {
    beforeEach(() => {
      delete process.env.MCP_API_KEY;
      delete process.env.MCP_AUTH_DISABLED;
    });

    it('startMcpServer(http) REFUSES to start with no key and no explicit disable', async () => {
      process.env.MCP_TRANSPORT = 'http';
      await expect(startMcpServer(mockServer, { mode: 'http' })).rejects.toThrow(/refused to start without auth/i);
      expect(mockServer.connect).not.toHaveBeenCalled();
    });

    it('resolveHttpAuth throws when no key + not disabled', () => {
      expect(() => resolveHttpAuth({}, {})).toThrow(/without auth/i);
    });

    it('treats an EMPTY-string MCP_API_KEY as not-configured (still throws)', () => {
      expect(() => resolveHttpAuth({}, { MCP_API_KEY: '' })).toThrow(/without auth/i);
    });

    it('enforces auth when a non-empty key is set', () => {
      expect(resolveHttpAuth({}, { MCP_API_KEY: 'sekret' })).toEqual({ authEnabled: true, apiKey: 'sekret' });
    });

    it('runs OPEN only when MCP_AUTH_DISABLED=true (explicit opt-in)', () => {
      expect(resolveHttpAuth({}, { MCP_AUTH_DISABLED: 'true' })).toEqual({ authEnabled: false, apiKey: '' });
    });

    it('runs OPEN when apiKey:null is passed programmatically', () => {
      expect(resolveHttpAuth({ apiKey: null }, {})).toEqual({ authEnabled: false, apiKey: '' });
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

  describe('transport options', () => {
    it('reads MCP_TRANSPORT env var', async () => {
      process.env.MCP_TRANSPORT = 'stdio';
      await startMcpServer(mockServer);
      expect(mockServer.connect).toHaveBeenCalledTimes(1);
    });

    it('accepts explicit mode option', async () => {
      delete process.env.MCP_TRANSPORT;
      await startMcpServer(mockServer, { mode: 'stdio' });
      expect(mockServer.connect).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // createRequestHandler — the routing/auth/guards unit, exercised with mock req/res
  // (no socket binding, so no open handle / SIGTERM block)
  // -------------------------------------------------------------------------

  describe('createRequestHandler', () => {
    function makeConfig(overrides: Record<string, unknown> = {}): any {
      return {
        getServer: () => mockServer,
        authEnabled: false,
        apiKey: '',
        maxBodyBytes: 4 * 1024 * 1024,
        enableDnsRebindingProtection: false,
        allowedHosts: [],
        allowedOrigins: [],
        ...overrides,
      };
    }

    it('returns 200 { status: "healthy" } for GET /health without auth', async () => {
      const handler = createRequestHandler(makeConfig({ authEnabled: true, apiKey: 'k' }));
      const res = makeRes();
      await handler(makeReq({ method: 'GET', url: '/health' }), res);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'healthy' });
    });

    it('returns 401 when auth is enabled and the Bearer token is missing/wrong', async () => {
      const handler = createRequestHandler(makeConfig({ authEnabled: true, apiKey: 'secret' }));

      const resMissing = makeRes();
      await handler(makeReq({ method: 'POST', url: '/mcp', headers: {} }), resMissing);
      expect(resMissing.statusCode).toBe(401);

      const resWrong = makeRes();
      await handler(
        makeReq({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer nope' } }),
        resWrong,
      );
      expect(resWrong.statusCode).toBe(401);
      expect(mockServer.connect).not.toHaveBeenCalled();
    });

    it('dispatches GET /mcp to the SDK transport (server connected, request handled)', async () => {
      const handler = createRequestHandler(makeConfig({ authEnabled: true, apiKey: 'secret' }));
      const res = makeRes();
      await handler(
        makeReq({ method: 'GET', url: '/mcp', headers: { authorization: 'Bearer secret' } }),
        res,
      );
      expect(mockServer.connect).toHaveBeenCalledTimes(1);
      expect(mockHandleRequest).toHaveBeenCalledTimes(1);
    });

    it('dispatches a valid POST /mcp (parses JSON body, connects, handles)', async () => {
      const handler = createRequestHandler(makeConfig());
      const res = makeRes();
      await handler(
        makeReq({
          method: 'POST',
          url: '/mcp',
          headers: { 'content-type': 'application/json' },
          body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
        }),
        res,
      );
      expect(mockServer.connect).toHaveBeenCalledTimes(1);
      expect(mockHandleRequest).toHaveBeenCalledTimes(1);
    });

    it('returns 415 when POST /mcp is not application/json', async () => {
      const handler = createRequestHandler(makeConfig());
      const res = makeRes();
      await handler(
        makeReq({ method: 'POST', url: '/mcp', headers: { 'content-type': 'text/plain' }, body: 'hi' }),
        res,
      );
      expect(res.statusCode).toBe(415);
      expect(mockServer.connect).not.toHaveBeenCalled();
    });

    it('returns 413 when the POST body exceeds maxBodyBytes', async () => {
      const handler = createRequestHandler(makeConfig({ maxBodyBytes: 8 }));
      const res = makeRes();
      await handler(
        makeReq({
          method: 'POST',
          url: '/mcp',
          headers: { 'content-type': 'application/json' },
          body: 'x'.repeat(64),
        }),
        res,
      );
      expect(res.statusCode).toBe(413);
      expect(mockServer.connect).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown route', async () => {
      const handler = createRequestHandler(makeConfig());
      const res = makeRes();
      await handler(makeReq({ method: 'GET', url: '/nope' }), res);
      expect(res.statusCode).toBe(404);
    });

    it('returns 500 (without leaking details) when the handler throws', async () => {
      const handler = createRequestHandler(
        makeConfig({ getServer: () => { throw new Error('boom secret detail'); } }),
      );
      const res = makeRes();
      await handler(
        makeReq({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, body: '{}' }),
        res,
      );
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error' });
      expect(res.body).not.toContain('boom secret detail');
    });
  });
});
