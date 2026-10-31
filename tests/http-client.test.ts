import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  CredentialRegistry,
  CredentialScope,
  runWithCredentialScope,
  setProcessCredentials,
  UnknownCredentialError,
} from '../src/credentials.js';
import {
  buildQueryString,
  createHttpClient,
  createTokenBucket,
  type HttpClientConfig,
  HttpError,
  type HttpErrorInfo,
  type HttpRetryInfo,
  joinUrl,
  McpHttpClient,
  templatePath,
} from '../src/http-client.js';
import { nextLinkField, nextPageHeader } from '../src/pagination.js';
import { initLogger, Logger, LogLevel, resetLogger } from '../src/utils/logger.js';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
type Handler = (req: IncomingMessage, res: ServerResponse, body: string, index: number) => void;

interface TestServer {
  base: string;
  origin: string;
  requests: Recorded[];
  close: () => Promise<void>;
}

const open: TestServer[] = [];

async function startServer(handler: Handler): Promise<TestServer> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body, requests.length - 1);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const ts: TestServer = {
    base: `${origin}/api/v4`,
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(ts);
  return ts;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** A quiet logger whose calls are captured raw (before redaction) so tests see exactly what we pass. */
function captureLogger(): { logger: Logger; calls: Array<{ level: string; message: string; meta: unknown }> } {
  const logger = new Logger({ console: false, fileMain: false, fileExceptions: false, fileDebug: false });
  const calls: Array<{ level: string; message: string; meta: unknown }> = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(logger, level).mockImplementation((message: string, _context?: string, meta?: unknown) => {
      calls.push({ level, message, meta });
    });
  }
  return { logger, calls };
}

const fast = { initialDelayMs: 1, maxDelayMs: 2 };

function client(ts: TestServer, extra: Partial<HttpClientConfig> = {}): McpHttpClient {
  return createHttpClient({ baseURL: ts.base, retry: fast, logger: captureLogger().logger, ...extra });
}

async function caught(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('expected a rejection');
}

beforeEach(() => resetLogger());
afterEach(async () => {
  while (open.length) await open.pop()?.close();
  jest.restoreAllMocks();
});

describe('pure helpers', () => {
  it('joinUrl joins exactly once and keeps absolute URLs as-is', () => {
    expect(joinUrl('https://h/api/v4', '/projects')).toBe('https://h/api/v4/projects');
    expect(joinUrl('https://h/api/v4/', 'projects')).toBe('https://h/api/v4/projects');
    expect(joinUrl('https://h/api/v4//', '//projects?x=1')).toBe('https://h/api/v4/projects?x=1');
    expect(joinUrl('https://h/api/v4', '')).toBe('https://h/api/v4');
    // An absolute OData next-link already holds `/v1.0` and must never be re-joined to `/v1.0/v1.0`.
    const next = 'https://graph.microsoft.com/v1.0/sites?$skiptoken=abc';
    expect(joinUrl('https://graph.microsoft.com/v1.0', next)).toBe(next);
  });

  it('buildQueryString skips null/undefined and supports three array formats', () => {
    const q = { a: 1, b: 'x y', c: true, d: null, e: undefined, ids: [1, 2] };
    expect(buildQueryString(q)).toBe('a=1&b=x%20y&c=true&ids=1&ids=2');
    expect(buildQueryString({ ids: [1, 2] }, 'brackets')).toBe('ids%5B%5D=1&ids%5B%5D=2');
    expect(buildQueryString({ ids: [1, 2] }, 'comma')).toBe('ids=1,2');
    expect(buildQueryString(undefined)).toBe('');
  });

  it('templatePath fails closed: every request segment is :id except a leading API prefix or version', () => {
    expect(templatePath('/api/v4/projects/123/merge_requests/7')).toBe('/api/:id/:id/:id/:id/:id');
    expect(templatePath('/v1.0/sites')).toBe('/v1.0/:id');
    expect(templatePath('/projects/group%2Fproj/branches')).toBe('/:id/:id/:id');
    expect(templatePath('/x')).toBe('/:id');
    expect(templatePath('/')).toBe('/');
    // The configured base path keeps its API words and versions; any other base segment is masked.
    expect(templatePath('/api/v4/projects/123', { basePath: '/api/v4' })).toBe('/api/v4/:id/:id');
    expect(templatePath('/api/v4/', { basePath: '/api/v4/' })).toBe('/api/v4');
    expect(templatePath('/bot123456:AAH-secret/sendMessage', { basePath: '/bot123456:AAH-secret' })).toBe('/:id/:id');
    expect(templatePath('/other/x', { basePath: '/api/v4' })).toBe('/:id/:id');
  });

  it('templatePath keeps a leading version (v4, 1, 12, v1.0) and masks look-alikes', () => {
    expect(templatePath('/1/boards/abc', { basePath: '/1' })).toBe('/1/:id/:id');
    expect(templatePath('/1/boards/abc')).toBe('/1/:id/:id');
    expect(templatePath('/12/boards')).toBe('/12/:id');
    expect(templatePath('/123/boards')).toBe('/:id/:id');
    expect(templatePath('/v2/x')).toBe('/v2/:id');
    expect(templatePath('/boards/1/cards')).toBe('/:id/:id/:id');
    expect(templatePath('/1/boards/abc/cards/9', { basePath: '/1', routes: ['/boards/:id/cards/:card'] })).toBe(
      '/1/boards/:id/cards/:card',
    );
    expect(templatePath('/1/boards/abc', { basePath: '/1', routes: ['/boards/:id'] })).toBe('/1/boards/:id');
    expect(templatePath('/api/1/boards/abc', { basePath: '/api/1', routes: ['/boards/:id'] })).toBe(
      '/api/1/boards/:id',
    );
  });

  it('templatePath never logs a dynamic segment (the review examples)', () => {
    for (const [path, leaks] of [
      ['/user/alice', ['alice']],
      ['/search/confidential', ['confidential']],
      ['/v1/domain/example/dns', ['example']],
      ['/user/johndoe/settings', ['johndoe']],
      ['/repos/acme/secretrepo', ['acme', 'secretrepo']],
      ['/repos/o/r/contents/docs/internal-plans/x.md', ['internal-plans', 'x.md', 'docs']],
      ['/api/v4/projects/7/repository/tags/stable', ['stable']],
      ['/api/v4/projects/7/repository/tags/v1.2.0', ['v1.2.0']],
      ['/api/v4/projects/7/variables/deploy_token', ['deploy_token']],
      ['/api/v4/projects/7/repository/files/README.md/raw', ['README.md']],
    ] as const) {
      const out = templatePath(path, { basePath: '/api/v4' });
      for (const leak of leaks) expect(out).not.toContain(leak);
    }
  });

  it('templatePath logs a matching route template with its literal words', () => {
    const routes = ['/projects/:id/repository/tags/:tag', '/repos/:owner/:repo'];
    expect(templatePath('/api/v4/projects/7/repository/tags/stable', { basePath: '/api/v4', routes })).toBe(
      '/api/v4/projects/:id/repository/tags/:tag',
    );
    expect(templatePath('/repos/acme/secretrepo', { routes })).toBe('/repos/:owner/:repo');
    // A literal must match exactly, and the segment count too.
    expect(templatePath('/repos/acme/secretrepo/issues', { routes })).toBe('/:id/:id/:id/:id');
    expect(templatePath('/projects/7/repository/branches/main', { routes })).toBe('/:id/:id/:id/:id/:id');
  });
});

describe('requests', () => {
  it('GET joins the base once, serialises the query, merges default and per-request headers', async () => {
    const ts = await startServer((_q, res) => json(res, 200, { id: 1 }));
    const c = client(ts, { headers: { 'X-Default': 'd' } });
    const data = await c.get<{ id: number }>('/projects/1', {
      query: { page: 2, tags: ['a', 'b'], skip: undefined },
      headers: { 'X-Req': 'r' },
    });
    expect(data).toEqual({ id: 1 });
    expect(ts.requests[0].url).toBe('/api/v4/projects/1?page=2&tags=a&tags=b');
    expect(ts.requests[0].headers['x-default']).toBe('d');
    expect(ts.requests[0].headers['x-req']).toBe('r');
  });

  it('verb wrappers send the right method and body; head returns headers', async () => {
    const ts = await startServer((req, res, body) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'x-total': '42' });
        res.end();
        return;
      }
      json(res, 200, { method: req.method, body: body ? (JSON.parse(body) as unknown) : null });
    });
    const c = client(ts);
    expect(await c.post('/x', { a: 1 })).toEqual({ method: 'POST', body: { a: 1 } });
    expect(await c.put('/x', { b: 2 })).toEqual({ method: 'PUT', body: { b: 2 } });
    expect(await c.patch('/x', { c: 3 })).toEqual({ method: 'PATCH', body: { c: 3 } });
    expect(await c.delete('/x')).toEqual({ method: 'DELETE', body: null });
    expect(await c.request({ method: 'OPTIONS', path: '/x' })).toEqual({ method: 'OPTIONS', body: null });
    expect((await c.head('/x'))['x-total']).toBe('42');
    expect(ts.requests[0].headers['content-type']).toContain('application/json');
  });

  it('requestRaw returns status, lower-cased headers (multi-value joined) and data', async () => {
    const ts = await startServer((_q, res) => {
      res.setHeader('Set-Cookie', ['a=1', 'b=2']);
      json(res, 201, { ok: true }, { 'X-Total': '3' });
    });
    const raw = await client(ts).requestRaw<{ ok: boolean }>({ method: 'POST', path: '/x' });
    expect(raw.status).toBe(201);
    expect(raw.headers['x-total']).toBe('3');
    expect(raw.headers['set-cookie']).toBe('a=1, b=2');
    expect(raw.data).toEqual({ ok: true });
  });

  it('responseType text and arraybuffer', async () => {
    const ts = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"raw":true}');
    });
    const c = client(ts);
    expect(await c.get<string>('/t', { responseType: 'text' })).toBe('{"raw":true}');
    const buf = await c.get<Buffer>('/b', { responseType: 'arraybuffer' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf8')).toBe('{"raw":true}');
  });

  it('responseType stream returns a readable', async () => {
    const ts = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(1000, 1));
    });
    const stream = await client(ts).get<Readable>('/file', { responseType: 'stream' });
    let total = 0;
    for await (const chunk of stream) total += (chunk as Buffer).length;
    expect(total).toBe(1000);
  });

  it('validateStatus override returns a non-2xx response instead of throwing', async () => {
    const ts = await startServer((_q, res) => json(res, 404, { message: 'nope' }));
    const raw = await client(ts).requestRaw({ path: '/x', validateStatus: () => true });
    expect(raw.status).toBe(404);
    expect(ts.requests).toHaveLength(1);
  });
});

describe('auth strategies', () => {
  it('bearer, basic and custom header', async () => {
    const ts = await startServer((_q, res) => json(res, 200, {}));
    await client(ts, { auth: { type: 'bearer', token: 'tok-123' } }).get('/a');
    await client(ts, { auth: { type: 'basic', username: 'u', password: 'p-secret' } }).get('/b');
    await client(ts, { auth: { type: 'header', name: 'PRIVATE-TOKEN', value: 'glpat-xyz' } }).get('/c');
    expect(ts.requests[0].headers.authorization).toBe('Bearer tok-123');
    expect(ts.requests[1].headers.authorization).toBe(`Basic ${Buffer.from('u:p-secret').toString('base64')}`);
    expect(ts.requests[2].headers['private-token']).toBe('glpat-xyz');
  });

  it('query-param credentials are sent but never logged or put in an error', async () => {
    const ts = await startServer((_q, res) =>
      json(res, 401, { message: 'invalid key=TRELLO-KEY-1 token TRELLO-TOK-2' }),
    );
    const { logger, calls } = captureLogger();
    const c = createHttpClient({
      baseURL: ts.base,
      logger,
      auth: { type: 'query', params: { key: 'TRELLO-KEY-1', token: 'TRELLO-TOK-2' } },
    });
    const err = await caught(c.get('/boards/5f2b6c1a9d8e7f6a5b4c3d2e', { query: { fields: 'name' } }));
    expect(ts.requests[0].url).toBe(
      '/api/v4/boards/5f2b6c1a9d8e7f6a5b4c3d2e?fields=name&key=TRELLO-KEY-1&token=TRELLO-TOK-2',
    );
    expect(err.message).toBe('invalid key=[REDACTED] token [REDACTED]');
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain('TRELLO-KEY-1');
    expect(logged).not.toContain('TRELLO-TOK-2');
    expect(logged).not.toContain('fields');
    expect(c.maskSecrets('x TRELLO-KEY-1 y')).toBe('x [REDACTED] y');
  });

  it('caller query cannot override the auth params', async () => {
    const ts = await startServer((_q, res) => json(res, 200, {}));
    await client(ts, { auth: { type: 'query', params: { key: 'real' } } }).get('/x', { query: { key: 'evil' } });
    expect(ts.requests[0].url).toBe('/api/v4/x?key=real');
  });

  it('token provider: per-request token, one forced refresh on 401, then a replay', async () => {
    const ts = await startServer((req, res) => {
      if (req.headers.authorization === 'Bearer fresh') json(res, 200, { ok: true });
      else json(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'expired' } });
    });
    const getToken = jest.fn(async ({ forceRefresh }: { forceRefresh: boolean }) => (forceRefresh ? 'fresh' : 'stale'));
    const c = client(ts, { auth: { type: 'tokenProvider', getToken } });
    expect(await c.post('/sites', {})).toEqual({ ok: true });
    expect(getToken.mock.calls.map((call) => call[0].forceRefresh)).toEqual([false, true]);
    expect(ts.requests).toHaveLength(2);
  });

  it('token provider refreshes only once; custom header name and raw scheme', async () => {
    const ts = await startServer((_q, res) => json(res, 401, { message: 'still bad token-abcdef' }));
    const getToken = jest.fn(async () => 'token-abcdef');
    const c = client(ts, { auth: { type: 'tokenProvider', getToken, headerName: 'X-Auth', scheme: '' } });
    const err = await caught(c.get('/x'));
    expect(err.status).toBe(401);
    expect(err.message).toBe('still bad [REDACTED]');
    expect(ts.requests).toHaveLength(2);
    expect(ts.requests[0].headers['x-auth']).toBe('token-abcdef');
  });
});

describe('retry', () => {
  it('retries an idempotent GET on 503 and succeeds', async () => {
    const ts = await startServer((_q, res, _b, i) => (i === 0 ? json(res, 503, {}) : json(res, 200, { ok: 1 })));
    expect(await client(ts).get('/x')).toEqual({ ok: 1 });
    expect(ts.requests).toHaveLength(2);
  });

  it('never replays a POST or PATCH by default', async () => {
    const ts = await startServer((_q, res) => json(res, 503, {}));
    const c = client(ts);
    expect((await caught(c.post('/x', {}))).status).toBe(503);
    expect((await caught(c.patch('/x', {}))).status).toBe(503);
    expect(ts.requests).toHaveLength(2);
  });

  it('replays a POST with an idempotency key (sent in the header) or retry.unsafe', async () => {
    const ts = await startServer((_q, res, _b, i) => (i % 2 === 0 ? json(res, 502, {}) : json(res, 200, {})));
    const c = client(ts, { idempotencyKeyHeader: 'X-Idem' });
    await c.post('/x', {}, { idempotencyKey: 'k-1' });
    expect(ts.requests[1].headers['x-idem']).toBe('k-1');
    await c.post('/x', {}, { retry: { unsafe: true } });
    expect(ts.requests).toHaveLength(4);
  });

  it('is bounded and honours retry overrides and retry:false', async () => {
    const ts = await startServer((_q, res) => json(res, 500, {}));
    const c = client(ts, { retry: { ...fast, retries: 2 } });
    await caught(c.get('/x'));
    expect(ts.requests).toHaveLength(3);
    await caught(c.get('/x', { retry: false }));
    expect(ts.requests).toHaveLength(4);
    await caught(c.get('/x', { retry: { retries: 1 } }));
    expect(ts.requests).toHaveLength(6);
  });

  it('never retries 501 or a plain 4xx', async () => {
    const ts = await startServer((_q, res, _b, i) => json(res, i === 0 ? 501 : 404, {}));
    const c = client(ts);
    expect((await caught(c.get('/x'))).status).toBe(501);
    expect((await caught(c.get('/x'))).status).toBe(404);
    expect(ts.requests).toHaveLength(2);
  });

  it('honours Retry-After seconds and dates, capped by maxRetryAfterMs', async () => {
    const date = new Date(Date.now() + 3_600_000).toUTCString();
    const ts = await startServer((_q, res, _b, i) => {
      if (i === 0) json(res, 429, {}, { 'Retry-After': '1' });
      else if (i === 1) json(res, 503, {}, { 'Retry-After': date });
      else json(res, 200, {});
    });
    const infos: HttpRetryInfo[] = [];
    const c = client(ts, { retry: { ...fast, maxRetryAfterMs: 15, onRetry: (i) => infos.push(i) } });
    await c.get('/projects/9');
    expect(infos.map((i) => [i.status, i.delayMs, i.fromRetryAfter])).toEqual([
      [429, 15, true],
      [503, 15, true],
    ]);
    expect(infos[0]).toMatchObject({ method: 'GET', path: '/api/v4/:id/:id', attempt: 0 });
  });

  it('Retry-After 0 retries at once; without it, the jittered backoff is used', async () => {
    const ts = await startServer((_q, res, _b, i) => {
      if (i === 0) json(res, 429, {}, { 'Retry-After': '0' });
      else if (i === 1) json(res, 500, {});
      else json(res, 200, {});
    });
    const infos: HttpRetryInfo[] = [];
    await client(ts, { retry: { initialDelayMs: 8, random: () => 0.5, onRetry: (i) => infos.push(i) } }).get('/x');
    expect(infos.map((i) => [i.delayMs, i.fromRetryAfter])).toEqual([
      [0, true],
      [8, false],
    ]);
  });

  it('retries a per-request timeout (ETIMEDOUT) for GET, then fails with that code', async () => {
    const ts = await startServer(() => undefined);
    const err = await caught(client(ts, { retry: { ...fast, retries: 1 } }).get('/slow', { timeout: 30 }));
    expect(err.code).toBe('ETIMEDOUT');
    expect(err.message).toBe('Network error (ETIMEDOUT)');
    expect(ts.requests.length).toBeLessThanOrEqual(2);
  });

  it('retries ECONNREFUSED (connect) and reports it', async () => {
    const ts = await startServer(() => undefined);
    await ts.close();
    open.pop();
    const infos: HttpRetryInfo[] = [];
    const err = await caught(client(ts, { retry: { ...fast, retries: 2, onRetry: (i) => infos.push(i) } }).get('/x'));
    expect(err.code).toBe('ECONNREFUSED');
    expect(infos).toHaveLength(2);
  });
});

describe('cancellation', () => {
  it('an in-flight abort rejects with the abort reason', async () => {
    const ts = await startServer(() => undefined);
    const controller = new AbortController();
    const p = client(ts).get('/x', { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('tool cancelled')), 20);
    await expect(p).rejects.toThrow('tool cancelled');
  });

  it('an abort during the retry wait stops retrying', async () => {
    const ts = await startServer((_q, res) => json(res, 503, {}, { 'Retry-After': '60' }));
    const controller = new AbortController();
    const p = client(ts, { retry: { maxRetryAfterMs: 60000 } }).get('/x', { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop')), 50);
    await expect(p).rejects.toThrow('stop');
    expect(ts.requests).toHaveLength(1);
  });

  it('an already-aborted signal sends nothing', async () => {
    const ts = await startServer((_q, res) => json(res, 200, {}));
    const controller = new AbortController();
    controller.abort();
    await expect(client(ts).get('/x', { signal: controller.signal })).rejects.toThrow();
    expect(ts.requests).toHaveLength(0);
  });
});

describe('security', () => {
  it('creates the axios instance with maxRedirects 0 and size caps; TLS via an https Agent', () => {
    const plain = createHttpClient({ baseURL: 'https://api.example.com' }).getAxiosInstance().defaults;
    expect(plain.maxRedirects).toBe(0);
    expect(plain.maxContentLength).toBe(25 * 1024 * 1024);
    expect(plain.maxBodyLength).toBe(25 * 1024 * 1024);
    expect(plain.httpsAgent).toBeUndefined();
    const tls = createHttpClient({ baseURL: 'https://nexus.test', tls: { rejectUnauthorized: false } });
    const agent = tls.getAxiosInstance().defaults.httpsAgent as { options: { rejectUnauthorized?: boolean } };
    expect(agent.options.rejectUnauthorized).toBe(false);
    const ca = createHttpClient({ baseURL: 'https://nexus.test', tls: { ca: 'PEM' } });
    const caAgent = ca.getAxiosInstance().defaults.httpsAgent as {
      options: { ca?: string; rejectUnauthorized?: boolean };
    };
    expect(caAgent.options).toMatchObject({ ca: 'PEM', rejectUnauthorized: true });
  });

  it('never follows a redirect (the credential cannot ride to the Location)', async () => {
    let followed = 0;
    const target = await startServer((_q, res) => {
      followed++;
      json(res, 200, {});
    });
    const ts = await startServer((_q, res) => {
      res.writeHead(302, { location: `${target.base}/steal` });
      res.end();
    });
    const err = await caught(client(ts, { auth: { type: 'bearer', token: 'secret-bearer' } }).get('/x'));
    expect(err.status).toBe(302);
    expect(followed).toBe(0);
  });

  it('normalized errors carry no response, config or headers (no auth or cookie leak)', async () => {
    const ts = await startServer((_q, res) => json(res, 403, { message: 'denied' }, { 'set-cookie': 'sid=LEAKED' }));
    const err = await caught(client(ts, { auth: { type: 'bearer', token: 'SECRET-TOKEN' } }).get('/x'));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('denied');
    expect(err.status).toBe(403);
    expect(err.statusText).toBe('Forbidden');
    const record = err as unknown as Record<string, unknown>;
    expect(record.response).toBeUndefined();
    expect(record.config).toBeUndefined();
    expect(record.request).toBeUndefined();
    const own = Object.getOwnPropertyNames(record)
      .map((k) => JSON.stringify(record[k]))
      .join('|');
    expect(own).not.toContain('SECRET-TOKEN');
    expect(own).not.toContain('LEAKED');
  });

  it('a stream that breaks mid-body surfaces a sanitized error', async () => {
    const ts = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(100));
      setTimeout(() => req.socket.destroy(), 20);
    });
    const c = client(ts, { auth: { type: 'bearer', token: 'stream-secret' } });
    const stream = await c.get<Readable>('/file', { responseType: 'stream' });
    const err = await caught(
      (async (): Promise<void> => {
        for await (const _chunk of stream) {
          // drain
        }
      })(),
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('Response stream failed');
    expect(
      JSON.stringify(Object.getOwnPropertyNames(err).map((k) => (err as unknown as Record<string, unknown>)[k])),
    ).not.toContain('stream-secret');
  });

  it('refuses absolute URLs to a foreign origin before sending; allowedOrigins opts in', async () => {
    const other = await startServer((_q, res) => json(res, 200, { other: true }));
    const ts = await startServer((_q, res) => json(res, 200, {}));
    const err = await caught(client(ts, { auth: { type: 'bearer', token: 'tok-1' } }).get(`${other.base}/x`));
    expect(err.code).toBe('ERR_ORIGIN_NOT_ALLOWED');
    expect(other.requests).toHaveLength(0);
    expect(await client(ts, { allowedOrigins: [other.origin] }).get(`${other.base}/x`)).toEqual({ other: true });
    expect((await caught(client(ts).get('ftp://x/y'))).code).toBe('ERR_ORIGIN_NOT_ALLOWED');
    expect((await caught(client(ts).get('http://[bad'))).code).toBe('ERR_INVALID_URL');
  });

  it('caps the response size (json and stream) and the request size, without retrying', async () => {
    const ts = await startServer((req, res) => {
      if (req.url?.includes('chunked')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write(Buffer.alloc(600));
        res.end(Buffer.alloc(600));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '2000' });
      res.end(Buffer.alloc(2000));
    });
    const c = client(ts);
    expect((await caught(c.get('/big', { maxResponseBytes: 100 }))).code).toBe('ERR_RESPONSE_TOO_LARGE');
    expect((await caught(c.get('/big', { maxResponseBytes: 100, responseType: 'stream' }))).code).toBe(
      'ERR_RESPONSE_TOO_LARGE',
    );
    const stream = await c.get<Readable>('/chunked', { maxResponseBytes: 1000, responseType: 'stream' });
    const streamErr = await caught(
      (async (): Promise<void> => {
        for await (const _chunk of stream) {
          // drain
        }
      })(),
    );
    expect(streamErr.code).toBe('ERR_RESPONSE_TOO_LARGE');
    expect(streamErr).toBeInstanceOf(HttpError); // never the raw AxiosError, whose config holds auth
    expect((streamErr as unknown as Record<string, unknown>).config).toBeUndefined();
    const small = client(ts, { maxRequestBytes: 10 });
    expect((await caught(small.put('/x', 'x'.repeat(100)))).code).toBe('ERR_REQUEST_TOO_LARGE');
    expect(ts.requests.length).toBe(3);
  });
});

describe('errors and mapError', () => {
  it.each([
    ['GitLab', { message: '404 Project Not Found' }, '404 Project Not Found', 'HTTP_404'],
    [
      'Graph',
      { error: { code: 'itemNotFound', message: 'The resource could not be found.' } },
      'The resource could not be found.',
      'itemNotFound',
    ],
    ['Jira', { errorMessages: ['Issue does not exist'], errors: {} }, 'Issue does not exist', 'HTTP_404'],
    ['errors array', { errors: [{ message: 'bad field' }] }, 'bad field', 'HTTP_404'],
    ['plain error string', { error: 'not_found' }, 'not_found', 'HTTP_404'],
  ])('extracts the upstream message (%s)', async (_name, body, message, code) => {
    const ts = await startServer((_q, res) => json(res, 404, body));
    const err = await caught(client(ts).get('/x'));
    expect(err.message).toBe(message);
    expect(err.code).toBe(code);
  });

  it('uses plain-text bodies, ignores HTML, and truncates long messages', async () => {
    const ts = await startServer((_q, res, _b, i) => {
      res.writeHead(i === 0 ? 400 : i === 1 ? 500 : 422, { 'content-type': 'text/plain' });
      res.end(i === 0 ? 'plain failure' : i === 1 ? '<html>oops</html>' : 'y'.repeat(1000));
    });
    const c = client(ts, { retry: { retries: 0 } });
    expect((await caught(c.get('/a'))).message).toBe('plain failure');
    expect((await caught(c.get('/b'))).message).toBe('HTTP 500 Internal Server Error');
    expect((await caught(c.get('/c'))).message).toHaveLength(300);
  });

  it('decodes an arraybuffer error body', async () => {
    const ts = await startServer((_q, res) => json(res, 400, { message: 'bad download' }));
    expect((await caught(client(ts).get('/x', { responseType: 'arraybuffer' }))).message).toBe('bad download');
  });

  it('mapError receives safe facts and sets the message and code', async () => {
    const ts = await startServer((_q, res) => json(res, 409, { message: 'Branch already exists' }));
    const infos: HttpErrorInfo[] = [];
    const c = client(ts, {
      mapError: (info) => {
        infos.push(info);
        return { message: `GitLab API error (${info.status}): ${info.upstreamMessage}`, code: 'CONFLICT' };
      },
    });
    const err = await caught(c.post('/projects/12/repository/branches', {}));
    expect(err.message).toBe('GitLab API error (409): Branch already exists');
    expect(err.code).toBe('CONFLICT');
    expect(err.method).toBe('POST');
    expect(err.path).toBe('/api/v4/:id/:id/:id/:id');
    expect(infos[0]).toEqual({
      method: 'POST',
      host: new URL(ts.base).host,
      path: '/api/v4/:id/:id/:id/:id',
      status: 409,
      statusText: 'Conflict',
      code: 'HTTP_409',
      upstreamMessage: 'Branch already exists',
    });
  });

  it('a non-HTTP failure from the transport keeps a network code', async () => {
    const c = createHttpClient({
      baseURL: 'http://127.0.0.1:1',
      retry: { retries: 0 },
      logger: captureLogger().logger,
    });
    const err = await caught(c.get('/x'));
    expect(err.code).toMatch(/^E|^ERR_/);
  });
});

describe('logging', () => {
  it('logs method, host, path template, status, duration and attempt; never query values', async () => {
    const ts = await startServer((_q, res, _b, i) => (i === 0 ? json(res, 503, {}) : json(res, 200, {})));
    const { logger, calls } = captureLogger();
    const c = createHttpClient({ baseURL: ts.base, logger, retry: fast, logContext: 'GitLabClient' });
    await c.get('/projects/123/issues', { query: { search: 'secret-search-term' }, headers: { 'X-Hdr': 'hdr-value' } });
    expect(calls.map((x) => x.level)).toEqual(['warn', 'debug']);
    const success = calls[1].meta as Record<string, unknown>;
    expect(Object.keys(success).sort()).toEqual(['attempt', 'durationMs', 'host', 'method', 'path', 'status']);
    expect(success).toMatchObject({ method: 'GET', path: '/api/v4/:id/:id/:id', status: 200, attempt: 1 });
    const text = JSON.stringify(calls);
    expect(text).not.toContain('secret-search-term');
    expect(text).not.toContain('hdr-value');
    expect(text).not.toContain('123');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('/api/v4/:id/:id/:id'),
      'GitLabClient',
      expect.anything(),
    );
  });

  it('logPath overrides the template; 4xx logs WARN, 5xx logs ERROR; bodies never logged', async () => {
    const ts = await startServer((_q, res, _b, i) => json(res, i === 0 ? 404 : 500, { message: 'upstream-body' }));
    const { logger, calls } = captureLogger();
    const c = createHttpClient({ baseURL: ts.base, logger, retry: { retries: 0 } });
    await caught(c.post('/x', { password: 'body-secret' }, { logPath: '/things/:name' }));
    await caught(c.get('/y'));
    expect(calls.map((x) => [x.level, x.message])).toEqual([
      ['warn', `HTTP POST ${new URL(ts.base).host}/things/:name failed`],
      ['error', `HTTP GET ${new URL(ts.base).host}/api/v4/:id failed`],
    ]);
    const text = JSON.stringify(calls);
    expect(text).not.toContain('upstream-body');
    expect(text).not.toContain('body-secret');
  });
});

describe('rate limiting', () => {
  it('shares one token bucket across requests of a client', async () => {
    const ts = await startServer((_q, res) => json(res, 200, {}));
    const c = client(ts, { rateLimit: { capacity: 1, refillPerSecond: 20 } });
    const start = Date.now();
    await Promise.all([c.get('/a'), c.get('/b'), c.get('/c')]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
    expect(ts.requests).toHaveLength(3);
  });

  it('accepts a prebuilt bucket shared by two clients', async () => {
    const ts = await startServer((_q, res) => json(res, 200, {}));
    const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 1000 });
    await client(ts, { rateLimit: bucket }).get('/a');
    await client(ts, { rateLimit: bucket }).get('/b');
    expect(bucket.available()).toBeLessThanOrEqual(2);
  });
});

describe('paginate', () => {
  it('follows an absolute OData nextLink exactly as given (no /v1.0/v1.0)', async () => {
    let origin = '';
    const ts = await startServer((req, res) => {
      if (req.url?.includes('skiptoken')) json(res, 200, { value: [3], '@odata.count': 3 });
      else json(res, 200, { value: [1, 2], '@odata.nextLink': `${origin}/v1.0/sites?$skiptoken=abc` });
    });
    origin = ts.origin;
    const c = createHttpClient({ baseURL: `${ts.origin}/v1.0`, retry: fast, logger: captureLogger().logger });
    const result = await c.paginate<number>({ path: '/sites', query: { $top: 2 } }, nextLinkField()).collect();
    expect(result).toEqual({ items: [1, 2, 3], total: 3, pages: 2, stopReason: 'end', truncated: false });
    expect(ts.requests.map((r) => r.url)).toEqual(['/v1.0/sites?%24top=2', '/v1.0/sites?$skiptoken=abc']);
  });

  it('walks GitLab pages by X-Next-Page and stops on an empty header', async () => {
    const ts = await startServer((req, res) => {
      const page = Number(new URL(req.url ?? '', 'http://x').searchParams.get('page'));
      json(res, 200, page === 1 ? [1, 2] : [3], { 'x-total': '3', 'x-next-page': page === 1 ? '2' : '' });
    });
    const result = await client(ts)
      .paginate<number>({ path: '/projects' }, nextPageHeader({ pageSize: 2 }))
      .collect();
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.total).toBe(3);
    expect(ts.requests[0].url).toBe('/api/v4/projects?page=1&per_page=2');
  });
});

describe('factory', () => {
  it('createHttpClient returns an McpHttpClient', () => {
    expect(createHttpClient({ baseURL: 'https://api.example.com' })).toBeInstanceOf(McpHttpClient);
  });
});

describe('review fixes (token provider failures, token memory, echo masking, paginate origin guard)', () => {
  it('a failing token provider is an HttpError ERR_TOKEN_PROVIDER with a masked message, logged by shape', async () => {
    const ts = await startServer((_q, res) => json(res, 200, {}));
    const { logger, calls } = captureLogger();
    let n = 0;
    const getToken = async (): Promise<string> => {
      n++;
      if (n === 1) return 'first-token-123';
      throw new Error('vault said no for first-token-123');
    };
    const c = createHttpClient({ baseURL: ts.base, retry: fast, logger, auth: { type: 'tokenProvider', getToken } });
    await c.get('/ok');
    const err = await caught(c.get('/x'));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.code).toBe('ERR_TOKEN_PROVIDER');
    expect(err.message).toBe('Token provider failed: vault said no for [REDACTED]');
    expect(calls.some((c2) => c2.message.includes('token provider failed'))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('first-token-123');
  });

  it('remembers only the latest provider tokens for masking', async () => {
    const ts = await startServer((_q, res) => json(res, 500, { message: 'boom' }));
    let n = 0;
    const getToken = async (): Promise<string> => `rotating-token-${n++}`;
    const c = client(ts, { auth: { type: 'tokenProvider', getToken }, retry: { retries: 0 } });
    for (let i = 0; i < 20; i++) await caught(c.get('/x'));
    expect(c.maskSecrets('rotating-token-19 rotating-token-12')).toBe('[REDACTED] [REDACTED]');
    expect(c.maskSecrets('rotating-token-0')).toBe('rotating-token-0');
  });

  it.each([
    ['bearer', { type: 'bearer' as const, token: 'echo-bearer-secret' }, 'echo-bearer-secret'],
    ['header', { type: 'header' as const, name: 'PRIVATE-TOKEN', value: 'echo-header-secret' }, 'echo-header-secret'],
    ['basic', { type: 'basic' as const, username: 'svc', password: 'echo-basic-pass' }, 'echo-basic-pass'],
  ])('masks a %s secret the upstream echoes in its error body', async (_name, auth, secret) => {
    const ts = await startServer((_q, res) => json(res, 400, { message: `bad credential ${secret}` }));
    const err = await caught(client(ts, { auth }).get('/x'));
    expect(err.message).toBe('bad credential [REDACTED]');
  });

  it('paginate refuses a next-link to a foreign origin before sending the credential', async () => {
    let foreignHits = 0;
    const foreign = await startServer((_q, res) => {
      foreignHits++;
      json(res, 200, { value: [] });
    });
    const ts = await startServer((_q, res) =>
      json(res, 200, { value: [1], '@odata.nextLink': `${foreign.origin}/v1.0/steal?$skiptoken=x` }),
    );
    const c = client(ts, { auth: { type: 'bearer', token: 'paged-secret' } });
    const err = await caught(c.paginate<number>({ path: '/sites' }, nextLinkField()).collect());
    expect(err.code).toBe('ERR_ORIGIN_NOT_ALLOWED');
    expect(foreignHits).toBe(0);
  });
});

describe('credential outcomes (the `credential` request option)', () => {
  /** A registry that declares `keys` and logs nowhere (no console noise in test runs). */
  function registryWith(...keys: string[]): CredentialRegistry {
    const registry = new CredentialRegistry({ logger: captureLogger().logger });
    for (const key of keys) registry.register(key);
    return registry;
  }

  it('records 2xx ok, 401 invalid, an expired signal, 402/429 degraded with retry-after, others unchanged', async () => {
    const ts = await startServer((req, res) => {
      const route = (req.url ?? '').split('?')[0];
      if (route === '/api/v4/ok') json(res, 200, { ok: true });
      else if (route === '/api/v4/denied') json(res, 401, { message: 'bad key' });
      else if (route === '/api/v4/expired')
        json(res, 401, { error: { code: 'key_expired', message: 'The key expired' } });
      else if (route === '/api/v4/paid') json(res, 402, { message: 'payment required' });
      else if (route === '/api/v4/limited') json(res, 429, { message: 'slow down' }, { 'retry-after': '3600' });
      else if (route === '/api/v4/quota') json(res, 400, { message: 'Monthly quota exceeded' });
      else if (route === '/api/v4/forbidden') json(res, 403, { message: 'You have no access to this project' });
      else if (route === '/api/v4/revoked')
        json(res, 403, { message: 'nope' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
      else if (route === '/api/v4/missing') json(res, 404, { message: 'nope' });
      else json(res, 500, { message: 'quota' });
    });
    const keys = [
      'K_OK',
      'K_DENIED',
      'K_EXPIRED',
      'K_PAID',
      'K_LIMITED',
      'K_QUOTA',
      'K_FORBIDDEN',
      'K_REVOKED',
      'K_MISSING',
      'K_BOOM',
    ];
    const registry = registryWith(...keys);
    for (const key of keys) registry.set(key, 'valid', { silent: true });
    const c = client(ts, { credentials: registry, retry: { retries: 0 } });
    await c.get('/ok', { credential: 'K_OK' });
    for (const [path, key] of [
      ['/denied', 'K_DENIED'],
      ['/expired', 'K_EXPIRED'],
      ['/paid', 'K_PAID'],
      ['/limited', 'K_LIMITED'],
      ['/quota', 'K_QUOTA'],
      ['/forbidden', 'K_FORBIDDEN'],
      ['/revoked', 'K_REVOKED'],
      ['/missing', 'K_MISSING'],
      ['/boom', 'K_BOOM'],
    ] as const) {
      await caught(c.get(path, { credential: key }));
    }
    expect(registry.status('K_OK')).toBe('valid');
    expect(registry.state('K_DENIED')).toMatchObject({ status: 'invalid', reason: 'auth rejected' });
    expect(registry.status('K_EXPIRED')).toBe('expired');
    expect(registry.state('K_PAID')).toMatchObject({ status: 'degraded', reason: 'quota' });
    expect(registry.state('K_LIMITED')).toMatchObject({
      status: 'degraded',
      reason: 'rate limit',
      retryInSeconds: 3600,
    });
    // A 400 is a bad request, whatever its body says; a plain 403 is about one resource.
    expect(registry.status('K_QUOTA')).toBe('valid');
    expect(registry.status('K_FORBIDDEN')).toBe('valid');
    expect(registry.state('K_REVOKED')).toMatchObject({ status: 'invalid', reason: 'credential rejected' });
    expect(registry.status('K_MISSING')).toBe('valid');
    expect(registry.status('K_BOOM')).toBe('valid');
    expect(registry.state('K_MISSING')?.lastUsedAt).toBeDefined();
  });

  it('records a GitLab expired token as expired (error_description and WWW-Authenticate), a revoked one as invalid', async () => {
    const expiredText = 'Token is expired. You can either do re-authorization or token refresh.';
    const revokedText = 'Token was revoked. You have to re-authorize from the user.';
    const challenge = (description: string): Record<string, string> => ({
      'www-authenticate': `Bearer realm="", error="invalid_token", error_description="${description}"`,
    });
    const ts = await startServer((req, res) => {
      const route = (req.url ?? '').split('?')[0];
      if (route === '/api/v4/body') json(res, 401, { error: 'invalid_token', error_description: expiredText });
      else if (route === '/api/v4/header') json(res, 401, { message: '401 Unauthorized' }, challenge(expiredText));
      else if (route === '/api/v4/both')
        json(res, 401, { error: 'invalid_token', error_description: expiredText }, challenge(expiredText));
      else if (route === '/api/v4/revoked')
        json(res, 401, { error: 'invalid_token', error_description: revokedText }, challenge(revokedText));
      else json(res, 401, { message: '401 Unauthorized' });
    });
    const keys = ['K_BODY', 'K_HEADER', 'K_BOTH', 'K_REVOKED', 'K_PLAIN', 'K_RAW'];
    const registry = registryWith(...keys);
    for (const key of keys) registry.set(key, 'valid', { silent: true });
    const c = client(ts, { credentials: registry, retry: { retries: 0 } });
    for (const [path, key] of [
      ['/body', 'K_BODY'],
      ['/header', 'K_HEADER'],
      ['/both', 'K_BOTH'],
      ['/revoked', 'K_REVOKED'],
      ['/plain', 'K_PLAIN'],
    ] as const) {
      await caught(c.get(path, { credential: key }));
    }
    await c.requestRaw({ path: '/both', credential: 'K_RAW', validateStatus: () => true });
    expect(registry.state('K_BODY')).toMatchObject({ status: 'expired', reason: 'expired' });
    expect(registry.state('K_HEADER')).toMatchObject({ status: 'expired', reason: 'expired' });
    expect(registry.state('K_BOTH')).toMatchObject({ status: 'expired', reason: 'expired' });
    expect(registry.state('K_RAW')).toMatchObject({ status: 'expired', reason: 'expired' });
    expect(registry.state('K_REVOKED')).toMatchObject({ status: 'invalid', reason: 'auth rejected' });
    expect(registry.state('K_PLAIN')).toMatchObject({ status: 'invalid', reason: 'auth rejected' });
  });

  it.each([
    ['body only', { error: 'invalid_token', error_description: 'Token is expired. Refresh it.' }, {}],
    [
      'header only',
      { message: '401 Unauthorized' },
      { 'www-authenticate': 'Bearer realm="", error="invalid_token", error_description="Token is expired"' },
    ],
  ])('withFallback over the client keeps a GitLab expired token expired (%s)', async (_label, body, headers) => {
    const ts = await startServer((req, res) =>
      (req.url ?? '').includes('second') ? json(res, 200, { ok: true }) : json(res, 401, body, headers),
    );
    const registry = new CredentialRegistry({ logger: captureLogger().logger });
    for (const key of ['KEY', 'KEY_1']) {
      registry.register(key, { pool: 'KEY' });
      registry.set(key, 'valid', { silent: true });
    }
    const scope = new CredentialScope(registry, () => 'v');
    const c = client(ts, { retry: { retries: 0 } });
    const out = await runWithCredentialScope(scope, () =>
      scope.withFallback('KEY', (key) => c.get(key === 'KEY' ? '/first' : '/second', { credential: key })),
    );
    expect(out).toEqual({ ok: true });
    expect(registry.state('KEY')).toMatchObject({ status: 'expired', reason: 'expired' });
  });

  it('a thrown HttpError carries the description and the parsed challenge (masked), never the raw header', async () => {
    const ts = await startServer((_q, res) =>
      json(
        res,
        401,
        { error: 'invalid_token', error_description: 'Token is expired' },
        {
          'www-authenticate':
            'Bearer realm="secret-realm", error="invalid_token", error_description="Token is expired"',
        },
      ),
    );
    const err = await caught(client(ts, { retry: { retries: 0 } }).get('/x'));
    expect(err.description).toBe('Token is expired');
    expect(err.challenge).toEqual({ error: 'invalid_token', description: 'Token is expired' });
    expect(JSON.stringify(err)).not.toContain('secret-realm');
  });

  it('records the final outcome after retries, and a status accepted by validateStatus', async () => {
    const ts = await startServer((_req, res, _body, index) =>
      index === 0 ? json(res, 503, {}) : json(res, 401, { message: 'bad key' }),
    );
    const registry = registryWith('K', 'K2');
    const c = client(ts, { credentials: registry });
    await caught(c.get('/x', { credential: 'K', retry: { retries: 1, ...fast } }));
    expect(ts.requests).toHaveLength(2);
    expect(registry.status('K')).toBe('invalid');
    const limited = await startServer((_q, res) =>
      json(res, 429, { message: 'Too many requests' }, { 'retry-after': '7' }),
    );
    const raw = await client(limited, { credentials: registry }).requestRaw({
      path: '/x',
      credential: 'K2',
      validateStatus: () => true,
    });
    expect(raw.status).toBe(429);
    expect(registry.state('K2')).toMatchObject({ status: 'degraded', reason: 'rate limit', retryInSeconds: 7 });
    const revoked = await startServer((_q, res) =>
      json(res, 403, {}, { 'www-authenticate': 'Bearer error="invalid_token"' }),
    );
    await client(revoked, { credentials: registry }).requestRaw({
      path: '/x',
      credential: 'K2',
      validateStatus: () => true,
    });
    expect(registry.status('K2')).toBe('invalid');
  });

  it('a network error leaves the status alone; no credential option records nothing', async () => {
    const ts = await startServer((_q, res) => json(res, 200, {}));
    const base = ts.base;
    await ts.close();
    open.pop();
    const registry = registryWith('K');
    const c = createHttpClient({
      baseURL: base,
      retry: { retries: 0 },
      credentials: registry,
      logger: captureLogger().logger,
    });
    registry.set('K', 'valid', { silent: true });
    await caught(c.get('/x', { credential: 'K' }));
    expect(registry.status('K')).toBe('valid');
    const live = await startServer((_q, res) => json(res, 401, {}));
    await caught(client(live, { credentials: registry }).get('/x'));
    expect(registry.snapshot().map((s) => s.key)).toEqual(['K']);
  });

  it('refuses an undeclared credential name (a value by mistake) before anything is sent (security regression)', async () => {
    const ts = await startServer((_q, res) => json(res, 200, {}));
    const value = `ghp_${'b'.repeat(36)}`;
    const registry = registryWith('DECLARED');
    let thrown: unknown;
    try {
      await client(ts, { credentials: registry }).get('/x', { credential: value });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnknownCredentialError);
    expect(String((thrown as Error).message)).not.toContain(value);
    expect(ts.requests).toHaveLength(0);
    expect(registry.has(value)).toBe(false);
  });

  it('inside a tool call scope the outcome goes to that scope (and its registry)', async () => {
    const ts = await startServer((_q, res) => json(res, 401, { message: 'nope' }));
    const registry = registryWith('K');
    const scope = new CredentialScope(registry);
    const other = registryWith();
    await runWithCredentialScope(scope, () =>
      caught(client(ts, { credentials: other }).get('/x', { credential: 'K' })),
    );
    expect(registry.status('K')).toBe('invalid');
    expect(other.has('K')).toBe(false);
    expect(scope.report()).toEqual([{ key: 'K', status: 'invalid', used: true, reason: 'auth rejected' }]);
  });

  it('without a scope or configured registry it records into the process registry', async () => {
    const ts = await startServer((_q, res) => json(res, 200, {}));
    const own = registryWith('PROC_K');
    setProcessCredentials(own);
    try {
      await client(ts).get('/x', { credential: 'PROC_K' });
      expect(own.status('PROC_K')).toBe('valid');
    } finally {
      setProcessCredentials(undefined);
    }
  });
});

describe('route templates', () => {
  it('a configured route logs its literal words; anything else fails closed', async () => {
    const ts = await startServer((_q, res) => json(res, 200, {}));
    const { logger, calls } = captureLogger();
    const c = createHttpClient({ baseURL: ts.base, logger, routes: ['/projects/:id/repository/tags/:tag'] });
    await c.get('/projects/7/repository/tags/release-candidate');
    await c.get('/projects/7/repository/branches/feature-x');
    const paths = calls.map((x) => (x.meta as { path: string }).path);
    expect(paths).toEqual(['/api/v4/projects/:id/repository/tags/:tag', '/api/v4/:id/:id/:id/:id/:id']);
    expect(JSON.stringify(calls)).not.toMatch(/release-candidate|feature-x/);
  });
});

describe('request logging carries the route template only', () => {
  it('a tag name, a variable key and a file name never appear in any log line or error (security regression)', async () => {
    const TAG = 'release-candidate';
    const VAR_KEY = 'DEPLOY_TOKEN_PROD';
    const FILE = 'secrets.env';
    const writes: string[] = [];
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    initLogger({ name: 'http-paths', level: LogLevel.DEBUG, fileMain: false, fileExceptions: false, fileDebug: false });
    const ts = await startServer((req, res, _body, index) => {
      if ((req.url ?? '').includes('/tags/')) json(res, 200, { name: 'x' });
      else if ((req.url ?? '').includes('/variables/')) json(res, 404, { message: 'not found' });
      else if (index < 3) json(res, 503, {});
      else json(res, 500, {});
    });
    const c = createHttpClient({ baseURL: ts.base, retry: { retries: 1, ...fast } });
    const errors: HttpError[] = [];
    try {
      await c.get(`/projects/7/repository/tags/${encodeURIComponent(TAG)}`);
      errors.push(await caught(c.put(`/projects/7/variables/${VAR_KEY}`, { value: 'v' })));
      errors.push(await caught(c.get(`/projects/7/repository/files/${encodeURIComponent(FILE)}/raw`)));
      errors.push(await caught(c.get(`/projects/7/repository/files/${FILE}`)));
    } finally {
      spy.mockRestore();
    }
    const log = writes.join('');
    expect(log).toContain('HTTP GET');
    expect(log).toContain('/api/v4/:id/:id/:id/:id/:id');
    expect(log).toContain('/api/v4/:id/:id/:id/:id');
    expect(log).toContain('/api/v4/:id/:id/:id/:id/:id/:id');
    for (const value of [TAG, VAR_KEY, FILE, 'secrets']) {
      expect(log).not.toContain(value);
      for (const err of errors) {
        expect(err.path).not.toContain(value);
        expect(err.message).not.toContain(value);
      }
    }
  });
});
