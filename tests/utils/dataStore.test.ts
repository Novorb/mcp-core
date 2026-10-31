import type { LookupOptions } from 'node:dns';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  createDataStore,
  DataPathError,
  DataStorageDisabledError,
  type DataStore,
  DownloadError,
  renameWithRetry,
  resolveInside,
  safeName,
} from '../../src/utils/dataStore.js';
import { loadEnv } from '../../src/utils/envLoader.js';
import { getLogger, initLogger, resetLogger } from '../../src/utils/logger.js';

let root: string;

function store(vars: Record<string, string> = {}): DataStore {
  const env = loadEnv([], { rootDir: root, env: { MCP_ENV_FILE: 'none', ...vars } });
  return createDataStore({ rootDir: root, env, logger: getLogger() });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-core-data-'));
  resetLogger();
  initLogger({ name: 'data-test', console: false, fileMain: false, fileExceptions: false, fileDebug: false });
});

afterEach(() => {
  resetLogger();
  rmSync(root, { recursive: true, force: true });
});

describe('data directory', () => {
  it('defaults to <rootDir>/.data and creates it lazily on the first write, never at creation', async () => {
    const s = store();
    expect(s.enabled).toBe(true);
    expect(s.dir).toBe(join(root, '.data'));
    expect(existsSync(join(root, '.data'))).toBe(false);
    const written = await s.writeFile('a/b.txt', 'hello');
    expect(written).toBe(join(root, '.data', 'a', 'b.txt'));
    expect((await s.readFile('a/b.txt'))?.toString()).toBe('hello');
    expect(readdirSync(join(root, '.data', 'a'))).toEqual(['b.txt']);
  });

  it('DATA_PATH overrides it, absolute or relative to rootDir', () => {
    const abs = join(root, 'elsewhere');
    expect(store({ DATA_PATH: abs }).dir).toBe(abs);
    expect(store({ DATA_PATH: 'state/x' }).dir).toBe(join(root, 'state', 'x'));
  });

  it('refuses a drive-relative DATA_PATH (it would resolve against a current directory)', () => {
    expect(() => store({ DATA_PATH: 'C:data' })).toThrow(DataPathError);
  });

  it('readFile is null and remove false for a missing file; remove deletes files and directories', async () => {
    const s = store();
    expect(await s.readFile('nope.txt')).toBeNull();
    expect(await s.remove('nope.txt')).toBe(false);
    await s.writeFile('d/f.txt', new Uint8Array([1, 2, 3]));
    expect(await s.ensureDir('d/sub')).toBe(join(root, '.data', 'd', 'sub'));
    expect(await s.remove('d')).toBe(true);
    expect(existsSync(join(root, '.data', 'd'))).toBe(false);
  });

  it('writeFile replaces atomically and leaves no temp file behind', async () => {
    const s = store();
    await s.writeFile('f.json', '1');
    await s.writeFile('f.json', '2');
    expect(readdirSync(join(root, '.data'))).toEqual(['f.json']);
    expect((await s.readFile('f.json'))?.toString()).toBe('2');
  });

  it('readFile and remove rethrow errors other than not-found', async () => {
    const s = store();
    await s.ensureDir('adir');
    await expect(s.readFile('adir')).rejects.toThrow();
  });
});

describe('DATA_STORAGE=false (stateless)', () => {
  it('writes nothing and creates no directory; every write path refuses', async () => {
    const s = store({ DATA_STORAGE: 'false' });
    expect(s.enabled).toBe(false);
    expect(s.dir).toBeNull();
    await expect(s.writeFile('a.txt', 'x')).rejects.toBeInstanceOf(DataStorageDisabledError);
    await expect(s.ensureDir('d')).rejects.toBeInstanceOf(DataStorageDisabledError);
    expect(() => s.resolveInside('a')).toThrow(DataStorageDisabledError);
    expect(await s.readFile('a.txt')).toBeNull();
    expect(await s.remove('a.txt')).toBe(false);
    const cache = s.jsonCache<{ n: number }>({ name: 'disc', ttlMs: 60_000 });
    await cache.write({ n: 1 });
    expect((await cache.read())?.data).toEqual({ n: 1 });
    expect(readdirSync(root)).toEqual([]);
  });

  it('requireEnabled gives the uniform toolError text; undefined when enabled', () => {
    expect(store({ DATA_STORAGE: 'false' }).requireEnabled('the SQLite cache')).toEqual({
      content: [{ type: 'text', text: 'data storage is disabled (DATA_STORAGE=false): the SQLite cache needs it' }],
      isError: true,
    });
    expect(store().requireEnabled('x')).toBeUndefined();
  });

  it('the in-memory cache expires and clears like the file one', async () => {
    const s = store({ DATA_STORAGE: 'false' });
    const expired = s.jsonCache<number>({ name: 'old', ttlMs: -1 });
    await expired.write(1);
    expect(await expired.read()).toBeNull();
    const c = s.jsonCache<number>({ name: 'c', ttlMs: 60_000 });
    expect(await c.read()).toBeNull();
    await c.write(2);
    await c.clear();
    expect(await c.read()).toBeNull();
  });
});

describe('resolveInside and safeName (path traversal regression)', () => {
  const base = (): string => join(root, 'base');

  it.each([
    ['..'],
    ['../x'],
    ['a/../../b'],
    ['a/..'],
    ['..\\x'],
    ['a\\..\\..\\b'],
    ['C:\\Windows\\x'],
    ['C:x'],
    ['c:'],
    ['/etc/passwd'],
    ['\\\\server\\share\\x'],
    ['\\rooted'],
    ['a\0b'],
  ])('rejects %j', async (segment) => {
    expect(() => resolveInside(base(), segment)).toThrow(DataPathError);
    await expect(store().writeFile(segment, 'x')).rejects.toBeInstanceOf(DataPathError);
    expect(existsSync(join(root, '.data'))).toBe(false);
  });

  it('rejects an empty path and accepts nested and dotted names', () => {
    expect(() => resolveInside(base())).toThrow('empty path');
    expect(() => resolveInside(base(), '', '.')).toThrow('empty path');
    expect(resolveInside(base(), 'a', 'b/c.txt')).toBe(join(base(), 'a', 'b', 'c.txt'));
    expect(resolveInside(base(), './a..b', 'x')).toBe(join(base(), 'a..b', 'x'));
  });

  it('rejects a symlink (junction) inside the base that points outside it', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    mkdirSync(base());
    symlinkSync(outside, join(base(), 'link'), 'junction');
    expect(() => resolveInside(base(), 'link', 'f.txt')).toThrow(/symlink/);
    const inner = join(base(), 'inner');
    mkdirSync(inner);
    symlinkSync(inner, join(base(), 'innerlink'), 'junction');
    expect(resolveInside(base(), 'innerlink', 'f.txt')).toBe(join(base(), 'innerlink', 'f.txt'));
  });

  it('safeName makes an untrusted name one safe segment', () => {
    expect(safeName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeName('a\\b:c*?.txt')).toBe('a_b_c__.txt');
    expect(safeName('...hidden')).toBe('hidden');
    expect(safeName('trailing. . ')).toBe('trailing');
    expect(safeName('CON')).toBe('_CON');
    expect(safeName('nul.txt')).toBe('_nul.txt');
    expect(safeName('')).toBe('_');
    expect(safeName('..')).toBe('_');
    expect(safeName('x'.repeat(300))).toHaveLength(200);
    expect(() => resolveInside(base(), safeName('../../x'))).not.toThrow();
  });
});

describe('jsonCache on disk', () => {
  it('stores under cache/<name>.json and reports the age', async () => {
    const s = store();
    const c = s.jsonCache<{ a: number }>({ name: 'discovery', ttlMs: 60_000 });
    expect(await c.read()).toBeNull();
    await c.write({ a: 1 });
    const hit = await c.read();
    expect(hit?.data).toEqual({ a: 1 });
    expect(hit?.ageMs).toBeGreaterThanOrEqual(0);
    expect(existsSync(join(root, '.data', 'cache', 'discovery.json'))).toBe(true);
    await c.clear();
    expect(await c.read()).toBeNull();
  });

  it('an expired, malformed or unstamped file reads as null; the name is sanitised', async () => {
    const s = store();
    const old = s.jsonCache<number>({ name: 'old', ttlMs: -1 });
    await old.write(1);
    expect(await old.read()).toBeNull();
    mkdirSync(join(root, '.data', 'cache'), { recursive: true });
    writeFileSync(join(root, '.data', 'cache', 'bad.json'), '{not json');
    expect(await s.jsonCache({ name: 'bad', ttlMs: 1000 }).read()).toBeNull();
    writeFileSync(join(root, '.data', 'cache', 'nostamp.json'), '{"data":1}');
    expect(await s.jsonCache({ name: 'nostamp', ttlMs: 1000 }).read()).toBeNull();
    const evil = s.jsonCache<number>({ name: '../../escape', ttlMs: 1000 });
    await evil.write(3);
    expect(existsSync(join(root, '.data', 'cache', '_.._escape.json'))).toBe(true);
  });
});

describe('downloadToFile', () => {
  type Route = (req: IncomingMessage, res: ServerResponse) => void;
  const routes = new Map<string, Route>();
  const seenAuth: Array<string | undefined> = [];
  const hits: string[] = [];
  /** The test servers listen on 127.0.0.1, so URL sources opt in to private targets explicitly. */
  const L = { allowPrivate: true } as const;
  /** A resolver answering 127.0.0.1 for every name, recording the names asked for. */
  const loopbackDns =
    (asked: string[] = []): LookupFunction =>
    (hostname: string, options: LookupOptions, callback) => {
      asked.push(hostname);
      if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    };
  let server: Server;
  let other: Server;
  let base: string;
  let otherBase: string;

  function listen(s: Server): Promise<string> {
    return new Promise((ok) =>
      s.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)),
    );
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      const route = routes.get(req.url ?? '');
      if (route) route(req, res);
      else {
        res.writeHead(404);
        res.end('missing');
      }
    });
    other = createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      res.end('other-origin');
    });
    base = await listen(server);
    otherBase = await listen(other);
    routes.set('/file', (_q, r) => {
      r.writeHead(200, { 'content-type': 'text/plain' });
      r.end('file-body');
    });
    routes.set('/big-declared', (_q, r) => {
      r.writeHead(200, { 'content-length': '5000' });
      r.end('x'.repeat(5000));
    });
    routes.set('/big-chunked', (_q, r) => {
      r.writeHead(200);
      for (let i = 0; i < 10; i++) r.write('y'.repeat(1000));
      r.end();
    });
    routes.set('/hang', () => undefined);
    routes.set('/redirect', (_q, r) => {
      r.writeHead(302, { location: '/file' });
      r.end();
    });
    routes.set('/loop', (_q, r) => {
      r.writeHead(301, { location: '/loop' });
      r.end();
    });
    routes.set('/noloc', (_q, r) => {
      r.writeHead(302);
      r.end();
    });
    routes.set('/cross', (_q, r) => {
      r.writeHead(307, { location: `${otherBase}/x` });
      r.end();
    });
    routes.set('/ftp', (_q, r) => {
      r.writeHead(302, { location: 'ftp://127.0.0.1/x' });
      r.end();
    });
  });

  afterAll(async () => {
    server.closeAllConnections();
    other.closeAllConnections();
    await new Promise((r) => server.close(r));
    await new Promise((r) => other.close(r));
  });

  it('writes the body through resolveInside and reports bytes and content type', async () => {
    const r = await store().downloadToFile(`${base}/file`, 'dl/file.txt', L);
    expect(r).toEqual({ bytes: 9, contentType: 'text/plain', path: join(root, '.data', 'dl', 'file.txt') });
    expect((await store().readFile('dl/file.txt'))?.toString()).toBe('file-body');
  });

  it('returns the bytes inline and writes nothing when storage is disabled', async () => {
    const r = await store({ DATA_STORAGE: 'false' }).downloadToFile(new URL(`${base}/file`), 'dl/file.txt', L);
    expect(r.path).toBeNull();
    expect(r.data?.toString()).toBe('file-body');
    expect(readdirSync(root)).toEqual([]);
  });

  it('caps the size by content-length and while streaming, leaving no file', async () => {
    const s = store();
    await expect(s.downloadToFile(`${base}/big-declared`, 'a.bin', { ...L, maxBytes: 1000 })).rejects.toMatchObject({
      reason: 'too-large',
    });
    await expect(s.downloadToFile(`${base}/big-chunked`, 'b.bin', { ...L, maxBytes: 1000 })).rejects.toMatchObject({
      reason: 'too-large',
    });
    expect(existsSync(join(root, '.data'))).toBe(false);
  });

  it('caps the time and honours the caller signal', async () => {
    const s = store();
    await expect(s.downloadToFile(`${base}/hang`, 'h.bin', { ...L, timeoutMs: 200 })).rejects.toMatchObject({
      reason: 'timeout',
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      s.downloadToFile(`${base}/hang`, 'h.bin', { ...L, signal: controller.signal, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ reason: 'aborted' });
  });

  it('follows a bounded number of redirects, never to another protocol', async () => {
    const s = store();
    expect((await s.downloadToFile(`${base}/redirect`, 'r.txt', L)).bytes).toBe(9);
    await expect(s.downloadToFile(`${base}/redirect`, 'r.txt', { ...L, maxRedirects: 0 })).rejects.toMatchObject({
      reason: 'redirects',
    });
    await expect(s.downloadToFile(`${base}/loop`, 'r.txt', L)).rejects.toMatchObject({ reason: 'redirects' });
    await expect(s.downloadToFile(`${base}/noloc`, 'r.txt', L)).rejects.toMatchObject({
      reason: 'status',
      status: 302,
    });
    await expect(s.downloadToFile(`${base}/ftp`, 'r.txt', L)).rejects.toMatchObject({ reason: 'protocol' });
    await expect(s.downloadToFile('file:///etc/passwd', 'r.txt', L)).rejects.toMatchObject({ reason: 'protocol' });
  });

  it('drops caller headers on a cross-origin redirect', async () => {
    seenAuth.length = 0;
    const r = await store().downloadToFile(`${base}/cross`, 'x.txt', {
      ...L,
      headers: { authorization: 'Bearer abc123456' },
    });
    expect(r.bytes).toBe('other-origin'.length);
    expect(seenAuth).toEqual([undefined]);
  });

  it('a non-2xx status and a refused connection are DownloadErrors', async () => {
    const s = store();
    await expect(s.downloadToFile(`${base}/absent`, 'a.txt', L)).rejects.toMatchObject({
      reason: 'status',
      status: 404,
    });
    await expect(s.downloadToFile('http://127.0.0.1:1/x', 'a.txt', L)).rejects.toBeInstanceOf(DownloadError);
  });

  // SSRF guard: URL sources go through guardedFetch by default (public addresses only, checked in the
  // socket lookup on every hop); private targets need the explicit allowPrivate opt-in.
  it('refuses a private address literal by default and never connects, writing nothing', async () => {
    hits.length = 0;
    await expect(store().downloadToFile(`${base}/file`, 'p.txt')).rejects.toMatchObject({ reason: 'blocked' });
    await expect(
      store({ DATA_STORAGE: 'false' }).downloadToFile(new URL(`${base}/file`), 'p.txt'),
    ).rejects.toMatchObject({
      reason: 'blocked',
      message: expect.stringMatching(/private, loopback or link-local/),
    });
    expect(hits).toEqual([]);
    expect(existsSync(join(root, '.data'))).toBe(false);
  });

  it('refuses a name resolving to a private address in the socket lookup by default', async () => {
    hits.length = 0;
    const asked: string[] = [];
    const port = new URL(base).port;
    await expect(
      store().downloadToFile(`http://files.example.test:${port}/file`, 'n.txt', { lookup: loopbackDns(asked) }),
    ).rejects.toMatchObject({ reason: 'blocked', message: expect.stringMatching(/resolves to a private/) });
    expect(asked).toEqual(['files.example.test']);
    expect(hits).toEqual([]);
  });

  it('re-validates every redirect hop with the same guard', async () => {
    hits.length = 0;
    const port = new URL(base).port;
    // The start name resolves to the test server and the policy admits exactly that address; the redirect
    // to the literal 127.0.0.2 is then refused before anything connects to it.
    routes.set('/to-literal', (_q, r) => {
      r.writeHead(302, { location: `http://127.0.0.2:${port}/file` });
      r.end();
    });
    const seam = { lookup: loopbackDns(), isAllowedAddress: (a: string): boolean => a === '127.0.0.1' };
    await expect(
      store().downloadToFile(`http://files.example.test:${port}/to-literal`, 'h.txt', seam),
    ).rejects.toMatchObject({ reason: 'blocked' });
    expect(hits).toEqual(['/to-literal']);
    expect((await store().downloadToFile(`http://files.example.test:${port}/redirect`, 'ok.txt', seam)).bytes).toBe(9);
  });

  it.each([
    ['maxBytes NaN', { maxBytes: Number.NaN }],
    ['maxBytes Infinity', { maxBytes: Number.POSITIVE_INFINITY }],
    ['maxRedirects NaN', { maxRedirects: Number.NaN }],
    ['timeoutMs NaN', { timeoutMs: Number.NaN }],
  ])('refuses a cap that would disable itself (%s) with a TypeError, before fetching', async (_label, bad) => {
    const fetcher = jest.fn(async () => new Response('x', { status: 200 }));
    await expect(store().downloadToFile(fetcher, 'n.txt', bad)).rejects.toThrow(TypeError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('applies allowedOrigins and allowedContentTypes', async () => {
    await expect(
      store().downloadToFile(`${base}/file`, 'o.txt', { ...L, allowedOrigins: ['https://cdn.example.com'] }),
    ).rejects.toMatchObject({ reason: 'blocked', message: expect.stringMatching(/is not allowed/) });
    await expect(
      store().downloadToFile(`${base}/cross`, 'o.txt', { ...L, allowedOrigins: [base] }),
    ).rejects.toMatchObject({ reason: 'blocked' });
    await expect(
      store().downloadToFile(`${base}/file`, 't.txt', { ...L, allowedContentTypes: ['image/*'] }),
    ).rejects.toMatchObject({ reason: 'content-type' });
    const ok = await store().downloadToFile(`${base}/file`, 't.txt', { ...L, allowedContentTypes: ['text/plain'] });
    expect(ok.bytes).toBe(9);
  });

  it('accepts any client as a fetcher function (same caps), and rejects a bad path before fetching', async () => {
    const fetcher = jest.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return new Response('from-client', { status: 200 });
    });
    const r = await store().downloadToFile(fetcher, 'c.txt');
    expect(r.bytes).toBe(11);
    expect(r.contentType).toBe('text/plain;charset=UTF-8');
    const bodyless = await store().downloadToFile(async () => new Response(null, { status: 204 }), 'e.txt');
    expect(bodyless.bytes).toBe(0);
    fetcher.mockClear();
    await expect(store().downloadToFile(fetcher, '../escape')).rejects.toBeInstanceOf(DataPathError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('review fixes (fail closed, both-mode path checks, dotted names, signal-bound reads)', () => {
  it('an invalid DATA_STORAGE value disables writes (fails closed) and warns', async () => {
    const lines: string[] = [];
    resetLogger();
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      initLogger({ name: 'data-test', fileMain: false, fileExceptions: false, fileDebug: false });
      const s = store({ DATA_STORAGE: 'flase' });
      expect(s.enabled).toBe(false);
      expect(s.dir).toBeNull();
      await expect(s.writeFile('a.txt', 'x')).rejects.toBeInstanceOf(DataStorageDisabledError);
      expect(readdirSync(root)).toEqual([]);
      expect(lines.join('')).toContain('DATA_STORAGE is not a boolean; disk storage is disabled');
    } finally {
      spy.mockRestore();
    }
  });

  it('downloadToFile validates the path in stateless mode too', async () => {
    const fetcher = jest.fn(async () => new Response('x', { status: 200 }));
    await expect(store({ DATA_STORAGE: 'false' }).downloadToFile(fetcher, '../escape')).rejects.toBeInstanceOf(
      DataPathError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a name that merely starts with two dots stays inside', () => {
    expect(resolveInside(root, '..foo')).toBe(join(root, '..foo'));
    expect(resolveInside(root, 'a', '..b', 'c')).toBe(join(root, 'a', '..b', 'c'));
  });

  it('a fetcher that ignores the signal is still cut off by the timeout while its body hangs', async () => {
    const hanging = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
          },
        }),
        { status: 200 },
      );
    await expect(store().downloadToFile(hanging, 'h.bin', { timeoutMs: 150 })).rejects.toMatchObject({
      reason: 'timeout',
    });
  });
});

describe('renameWithRetry (the Windows replace race behind atomic writes)', () => {
  function flaky(
    failures: number,
    code: string,
  ): { rename: (a: string, b: string) => Promise<void>; calls: () => number } {
    let calls = 0;
    return {
      rename: async () => {
        calls++;
        if (calls <= failures) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
      },
      calls: () => calls,
    };
  }

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient %s on win32 until the rename lands', async (code) => {
    const f = flaky(3, code);
    await renameWithRetry('a', 'b', { platform: 'win32', rename: f.rename });
    expect(f.calls()).toBe(4);
  });

  it('gives up after the budget and rethrows the last error', async () => {
    const f = flaky(1000, 'EPERM');
    const started = Date.now();
    await expect(
      renameWithRetry('a', 'b', { platform: 'win32', rename: f.rename, budgetMs: 60 }),
    ).rejects.toMatchObject({
      code: 'EPERM',
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.calls()).toBeGreaterThan(1);
  });

  it('never retries on other platforms or for other errors', async () => {
    const posix = flaky(1, 'EPERM');
    await expect(renameWithRetry('a', 'b', { platform: 'linux', rename: posix.rename })).rejects.toMatchObject({
      code: 'EPERM',
    });
    expect(posix.calls()).toBe(1);
    const other = flaky(1, 'ENOENT');
    await expect(renameWithRetry('a', 'b', { platform: 'win32', rename: other.rename })).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(other.calls()).toBe(1);
    const plain = { rename: async (): Promise<void> => Promise.reject(new Error('no code')) };
    await expect(renameWithRetry('a', 'b', { platform: 'win32', rename: plain.rename })).rejects.toThrow('no code');
  });

  it('defaults to the real rename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-core-rename-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'x');
      await renameWithRetry(join(dir, 'a.txt'), join(dir, 'b.txt'));
      expect(existsSync(join(dir, 'b.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
