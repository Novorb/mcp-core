import { spawn } from 'node:child_process';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { createServer, get as httpGet, type Server } from 'node:http';
import {
  type AddressInfo,
  createServer as createTcpServer,
  type LookupFunction,
  type Server as TcpServer,
} from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  ADDRESS_BLOCKED_CODE,
  addressPolicy,
  checkUrl,
  createGuardedAgent,
  GuardedFetchError,
  type GuardedFetchOptions,
  guardedFetch,
  guardedLookup,
  isPublicAddress,
  normalizeOrigins,
} from '../src/net.js';

type Reply = { status: number; headers?: Record<string, string>; body?: Buffer | string | 'hang' | 'reset' | 'stall' };

/** A local file host; every request it receives is recorded (path and headers). */
class FileHost {
  server?: Server;
  base = '';
  port = 0;
  hits: string[] = [];
  auth: Array<string | undefined> = [];
  /** Resolves when the socket of the latest stalled response closes. */
  stalledClosed: Promise<void> = Promise.resolve();
  reply: (url: string) => Reply = () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: Buffer.alloc(16, 1),
  });

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.hits.push(req.url ?? '');
      this.auth.push(req.headers.authorization);
      const r = this.reply(req.url ?? '');
      if (r.body === 'hang') return;
      if (r.body === 'reset') {
        // Headers and part of a declared body, then the connection drops.
        res.writeHead(r.status, { 'content-length': '100', ...r.headers });
        res.write(Buffer.alloc(10));
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      if (r.body === 'stall') {
        // Headers and part of a body, then nothing more (the body read must still be time-capped).
        this.stalledClosed = new Promise<void>((done) => res.socket?.once('close', () => done()));
        res.writeHead(r.status, r.headers ?? {});
        res.write(Buffer.alloc(10));
        return;
      }
      res.writeHead(r.status, r.headers ?? {});
      res.end(r.body ?? '');
    });
    await new Promise<void>((done) => this.server?.listen(0, '127.0.0.1', done));
    this.port = (this.server.address() as AddressInfo).port;
    this.base = `http://127.0.0.1:${this.port}`;
  }

  reset(): void {
    this.hits = [];
    this.auth = [];
    this.reply = () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.alloc(16, 1) });
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((done) => this.server?.close(() => done()));
  }
}

const host = new FileHost();
const other = new FileHost();
beforeAll(async () => {
  await host.start();
  await other.start();
});
afterAll(async () => {
  await host.stop();
  await other.stop();
});
beforeEach(() => {
  host.reset();
  other.reset();
});

/** A resolver answering fixed addresses for every name (the DNS seam), recording the names asked for. */
function fakeDns(addresses: LookupAddress[], asked: string[] = []): LookupFunction {
  return (hostname: string, options: LookupOptions, callback) => {
    asked.push(hostname);
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
}

/** A resolver answering per name (unknown names: ENOTFOUND). */
function dnsTable(table: Record<string, string>, asked: string[] = []): LookupFunction {
  return (hostname: string, options: LookupOptions, callback) => {
    asked.push(hostname);
    const address = table[hostname];
    if (address === undefined) {
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '', 4);
      return;
    }
    if (options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}

const MAX = 1024;
const local: GuardedFetchOptions = { allowPrivate: true, maxBytes: MAX };

async function refusal(promise: Promise<unknown>): Promise<GuardedFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GuardedFetchError);
    return error as GuardedFetchError;
  }
  throw new Error('expected a GuardedFetchError');
}

describe('isPublicAddress', () => {
  it.each([
    // IPv4 loopback, private, link-local (cloud metadata), CGNAT, this-network, broadcast, multicast, reserved
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '0.1.2.3',
    '255.255.255.255',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '192.0.0.8',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    // IPv6 unspecified, loopback, link-local (incl. a zone id), unique local, site-local, multicast
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fec0::1',
    'ff02::1',
    // IPv4-mapped, IPv4-compatible, NAT64 and 6to4 forms of private IPv4 addresses
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::ffff:10.0.0.1',
    '0:0:0:0:0:ffff:192.168.0.1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::169.254.169.254',
    '2002:7f00:1::1',
    '2002:a9fe:a9fe::',
    // Teredo, ORCHID and documentation ranges, and anything outside global unicast
    '2001::1',
    '2001:10::1',
    '2001:db8::1',
    '3fff::1',
    '100::1',
    '4000::1',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.32.0.1',
    '172.15.255.255',
    '100.128.0.1',
    '100.63.255.255',
    '169.255.0.1',
    '11.0.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:82b::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('allows the public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(['', 'localhost', 'example.com', '256.0.0.1', '1.2.3', '::ffff:1.2.3.400', 'fe80::1::2'])(
    'refuses %j, which is not an IP address',
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );
});

describe('addressPolicy and normalizeOrigins', () => {
  it('is public-only by default, everything with allowPrivate, and the custom policy when given', () => {
    expect(addressPolicy()('127.0.0.1')).toBe(false);
    expect(addressPolicy({ allowPrivate: false })('127.0.0.1')).toBe(false);
    expect(addressPolicy({ allowPrivate: true })('127.0.0.1')).toBe(true);
    const custom = (a: string): boolean => a === '10.0.0.1';
    expect(addressPolicy({ allowPrivate: true, isAllowedAddress: custom })('127.0.0.1')).toBe(false);
  });

  it('normalises a list or a comma-separated string, dropping blanks and duplicates', () => {
    expect(
      normalizeOrigins(' https://CDN.example.org/img/ , ,http://files.example.net:8080,https://cdn.example.org'),
    ).toEqual(['https://cdn.example.org', 'http://files.example.net:8080']);
    expect(normalizeOrigins(['https://a.example.com:443/x'])).toEqual(['https://a.example.com']);
  });

  it('refuses an entry that is not an http(s) origin, naming the label', () => {
    expect(() => normalizeOrigins('not a url', 'MY_ORIGINS')).toThrow(
      'MY_ORIGINS: every entry must be an http(s) origin',
    );
    expect(() => normalizeOrigins(['ftp://files.example.com'])).toThrow(
      'allowedOrigins: every entry must be an http(s) origin',
    );
  });
});

describe('checkUrl', () => {
  const allowedOrigins = [
    'https://files.example.com',
    'http://127.0.0.1',
    'http://[::1]',
    'http://169.254.169.254',
    'http://[::ffff:7f00:1]',
  ];
  const userinfo = 'user:pass';

  it('accepts a URL with a host name, with or without an origin list', () => {
    expect(checkUrl('https://files.example.com/a.png', { allowedOrigins }).hostname).toBe('files.example.com');
    expect(checkUrl(new URL('https://anything.example.org/a')).hostname).toBe('anything.example.org');
  });

  it.each<[string, string, RegExp]>([
    ['https://evil.example.org/a.png', 'origin', /origin https:\/\/evil\.example\.org is not allowed/],
    ['https://files.example.com:8443/a.png', 'origin', /origin https:\/\/files\.example\.com:8443 is not allowed/],
    ['http://files.example.com/a.png', 'origin', /origin http:\/\/files\.example\.com is not allowed/],
    ['file:///etc/passwd', 'protocol', /only http and https URLs are supported/],
    ['gopher://files.example.com/a', 'protocol', /only http and https URLs are supported/],
    ['not a url', 'url', /invalid URL/],
    [`https://${userinfo}@files.example.com/a.png`, 'credentials', /credentials in the URL are not allowed/],
    ['https://user@files.example.com/a.png', 'credentials', /credentials in the URL are not allowed/],
  ])('refuses %s (%s)', (url, reason, message) => {
    let thrown: unknown;
    try {
      checkUrl(url, { allowedOrigins });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GuardedFetchError);
    expect(thrown).toMatchObject({ reason, message: expect.stringMatching(message) });
  });

  // Even on an allowed origin, an IP literal in a private range is refused, in every spelling the URL
  // parser normalises to it (decimal, hex, octal, short forms, IPv6 brackets, IPv4-mapped IPv6).
  it.each([
    'http://127.0.0.1/a.png',
    'http://2130706433/a.png',
    'http://0x7f000001/a.png',
    'http://0x7f.0.0.1/a.png',
    'http://0177.0.0.1/a.png',
    'http://127.1/a.png',
    'http://[::1]/a.png',
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:127.0.0.1]/a.png',
  ])('refuses the private address literal %s', (url) => {
    expect(() => checkUrl(url, { allowedOrigins })).toThrow(/the host is a private, loopback or link-local address/);
    expect(() => checkUrl(url)).toThrow(expect.objectContaining({ reason: 'address', code: ADDRESS_BLOCKED_CODE }));
  });

  it('allows a private literal only with allowPrivate', () => {
    expect(checkUrl('http://127.0.0.1/a', { allowPrivate: true }).hostname).toBe('127.0.0.1');
  });
});

describe('guardedFetch: addresses', () => {
  it('refuses a loopback literal by default and never connects', async () => {
    const error = await refusal(guardedFetch(`${host.base}/a.png`));
    expect(error).toMatchObject({ reason: 'address', code: ADDRESS_BLOCKED_CODE });
    expect(error.message).toMatch(/the host is a private, loopback or link-local address/);
    expect(host.hits).toEqual([]);
  });

  it('refuses localhost through the real resolver and never connects', async () => {
    const error = await refusal(guardedFetch(`http://localhost:${host.port}/a.png`));
    expect(error.message).toMatch(/resolves to a private, loopback or link-local address/);
    expect(host.hits).toEqual([]);
  });

  it.each<[string, LookupAddress[]]>([
    ['loopback', [{ address: '127.0.0.1', family: 4 }]],
    ['link-local metadata', [{ address: '169.254.169.254', family: 4 }]],
    ['private', [{ address: '10.1.2.3', family: 4 }]],
    ['CGNAT', [{ address: '100.64.1.1', family: 4 }]],
    ['IPv6 loopback', [{ address: '::1', family: 6 }]],
    ['IPv6 unique local', [{ address: 'fd00::1', family: 6 }]],
    ['IPv4-mapped loopback', [{ address: '::ffff:127.0.0.1', family: 6 }]],
    [
      'a public and a private address',
      [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    ],
  ])('refuses a DNS name resolving to a %s address and never connects', async (_label, addresses) => {
    const asked: string[] = [];
    const error = await refusal(
      guardedFetch(`http://files.example.test:${host.port}/a.png`, { lookup: fakeDns(addresses, asked) }),
    );
    expect(error).toMatchObject({ reason: 'address', code: ADDRESS_BLOCKED_CODE });
    expect(error.message).toMatch(/resolves to a private, loopback or link-local address/);
    expect(asked).toEqual(['files.example.test']);
    expect(host.hits).toEqual([]);
  });

  it('refuses a name that resolves to no address', async () => {
    const error = await refusal(guardedFetch(`http://files.example.test:${host.port}/a.png`, { lookup: fakeDns([]) }));
    expect(error.reason).toBe('address');
  });

  it('reports a resolver failure as a network error', async () => {
    const error = await refusal(guardedFetch(`http://files.example.test:${host.port}/a.png`, { lookup: dnsTable({}) }));
    expect(error).toMatchObject({ reason: 'network', code: 'ENOTFOUND', message: 'network error (ENOTFOUND)' });
  });

  it('refuses a URL off the allowed origins before resolving it', async () => {
    const asked: string[] = [];
    const error = await refusal(
      guardedFetch(`http://files.example.test:${host.port}/a.png`, {
        allowedOrigins: ['https://files.example.com'],
        lookup: fakeDns([{ address: '93.184.216.34', family: 4 }], asked),
      }),
    );
    expect(error.reason).toBe('origin');
    expect(asked).toEqual([]);
  });

  it('checks the resolved address with the policy (a DNS name over the seam)', async () => {
    const res = await guardedFetch(`http://files.example.test:${host.port}/a.png`, {
      lookup: fakeDns([{ address: '127.0.0.1', family: 4 }]),
      isAllowedAddress: (address) => address === '127.0.0.1',
    });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(16);
    expect(host.hits).toEqual(['/a.png']);
  });

  it('connects to a private address only with allowPrivate', async () => {
    const res = await guardedFetch(`${host.base}/a.png`, local);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.url).toBe(`${host.base}/a.png`);
    expect(res.redirected).toBe(false);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.alloc(16, 1));
  });
});

describe('guardedFetch: redirects', () => {
  it('refuses a redirect by default, even to an allowed address, and never contacts the target', async () => {
    host.reply = () => ({ status: 302, headers: { location: `${other.base}/a.png` } });
    const error = await refusal(guardedFetch(`${host.base}/redirect.png`, local));
    expect(error).toMatchObject({ reason: 'redirect', status: 302, message: '302 redirect not followed' });
    expect(host.hits).toEqual(['/redirect.png']);
    expect(other.hits).toEqual([]);
  });

  it('follows up to the cap, reports the final URL, and refuses one hop more', async () => {
    host.reply = (url): Reply =>
      url === '/r2'
        ? { status: 301, headers: { location: '/r1' } }
        : url === '/r1'
          ? { status: 307, headers: { location: '/final' } }
          : { status: 200, headers: { 'content-type': 'text/plain' }, body: 'done' };
    const res = await guardedFetch(`${host.base}/r2`, { ...local, redirects: 2 });
    expect(await res.text()).toBe('done');
    expect(res.url).toBe(`${host.base}/final`);
    expect(res.redirected).toBe(true);
    const error = await refusal(guardedFetch(`${host.base}/r2`, { ...local, redirects: 1 }));
    expect(error).toMatchObject({ reason: 'redirects', message: 'more than 1 redirects' });
    const zero = await refusal(guardedFetch(`${host.base}/r1`, { ...local, redirects: 0 }));
    expect(zero.reason).toBe('redirects');
  });

  it('re-validates every hop: a private literal, a name resolving to a private address, another origin, another scheme', async () => {
    const asked: string[] = [];
    const lookup = dnsTable({ 'start.example.test': '127.0.0.1', 'evil.example.test': '10.0.0.1' }, asked);
    // Only the start host's resolved address passes the policy; the literal 127.0.0.2 does not.
    const policy = { lookup, isAllowedAddress: (a: string): boolean => a === '127.0.0.1', redirects: 3 };
    const start = `http://start.example.test:${host.port}`;
    const cases: Array<[string, string]> = [
      [`http://127.0.0.2:${other.port}/x`, 'address'],
      [`http://evil.example.test:${other.port}/x`, 'address'],
      ['ftp://start.example.test/x', 'protocol'],
      [`http://user:pw@start.example.test:${host.port}/x`, 'credentials'],
      ['http://[not valid/x', 'url'],
    ];
    for (const [location, reason] of cases) {
      host.reply = () => ({ status: 302, headers: { location } });
      const error = await refusal(guardedFetch(`${start}/go`, policy));
      expect(error.reason).toBe(reason);
    }
    expect(asked).toContain('evil.example.test');
    host.reply = () => ({ status: 302, headers: { location: `${other.base}/x` } });
    const offList = await refusal(
      guardedFetch(`${host.base}/go`, { ...local, redirects: 3, allowedOrigins: [host.base] }),
    );
    expect(offList.reason).toBe('origin');
    expect(other.hits).toEqual([]);
  });

  it('drops caller headers when a redirect changes origin, keeps them on the same origin', async () => {
    host.reply = (url) =>
      url === '/cross'
        ? { status: 307, headers: { location: `${other.base}/x` } }
        : url === '/same'
          ? { status: 302, headers: { location: '/end' } }
          : { status: 200, body: 'ok' };
    const headers = { authorization: 'Bearer abc123456' };
    await (await guardedFetch(`${host.base}/cross`, { ...local, redirects: 1, headers })).text();
    expect(other.auth).toEqual([undefined]);
    await (await guardedFetch(`${host.base}/same`, { ...local, redirects: 1, headers })).text();
    expect(host.auth.slice(-2)).toEqual(['Bearer abc123456', 'Bearer abc123456']);
  });

  it('when following, returns a 3xx without a location as a response', async () => {
    host.reply = () => ({ status: 302 });
    const res = await guardedFetch(`${host.base}/noloc`, { ...local, redirects: 3 });
    expect(res.status).toBe(302);
  });

  it.each([300, 302, 304, 305, 399])(
    'with redirects refused, every 3xx is refused (%i, with or without location)',
    async (status) => {
      host.reply = () => ({ status });
      expect(await refusal(guardedFetch(`${host.base}/x`, local))).toMatchObject({ reason: 'redirect', status });
      host.reply = () => ({ status, headers: { location: '/y' } });
      expect(await refusal(guardedFetch(`${host.base}/x`, local))).toMatchObject({ reason: 'redirect', status });
    },
  );
});

describe('guardedFetch: option validation', () => {
  it.each<[string, GuardedFetchOptions]>([
    ['redirects NaN', { redirects: Number.NaN }],
    ['redirects Infinity', { redirects: Number.POSITIVE_INFINITY }],
    ['redirects negative', { redirects: -1 }],
    ['maxBytes NaN', { maxBytes: Number.NaN }],
    ['maxBytes Infinity', { maxBytes: Number.POSITIVE_INFINITY }],
    ['maxBytes negative', { maxBytes: -5 }],
    ['timeoutMs NaN', { timeoutMs: Number.NaN }],
    ['timeoutMs zero', { timeoutMs: 0 }],
  ])('refuses %s with a TypeError before sending anything', async (_label, bad) => {
    await expect(guardedFetch(`${host.base}/a`, { ...local, ...bad })).rejects.toThrow(TypeError);
    expect(host.hits).toEqual([]);
  });
});

describe('guardedFetch: caps, types, time and abort', () => {
  it('refuses a body over maxBytes, declared or streamed', async () => {
    host.reply = () => ({ status: 200, headers: { 'content-length': String(MAX + 1) }, body: Buffer.alloc(MAX + 1) });
    expect(await refusal(guardedFetch(`${host.base}/big`, local))).toMatchObject({
      reason: 'too-large',
      message: `body exceeds ${MAX} bytes`,
    });
    host.reply = () => ({ status: 200, headers: { 'transfer-encoding': 'chunked' }, body: Buffer.alloc(MAX * 4) });
    const res = await guardedFetch(`${host.base}/chunked`, local);
    expect(await refusal(res.arrayBuffer())).toMatchObject({ reason: 'too-large' });
  });

  it('returns a non-2xx status as a response (the caller decides)', async () => {
    host.reply = () => ({ status: 404, body: 'missing' });
    const res = await guardedFetch(`${host.base}/missing`, local);
    expect(res.status).toBe(404);
    expect(res.statusText).toBe('Not Found');
    expect(await res.text()).toBe('missing');
  });

  it('has no body for HEAD and a 204', async () => {
    const head = await guardedFetch(`${host.base}/a`, { ...local, method: 'HEAD' });
    expect(head.body).toBeNull();
    host.reply = () => ({ status: 204 });
    expect((await guardedFetch(`${host.base}/a`, local)).body).toBeNull();
  });

  it.each([
    ['text/html; charset=utf-8', 'text/html'],
    ['application/json', 'application/json'],
    ['image/svg+xml', 'image/svg+xml'],
  ])('refuses a %s answer off the allowed content types', async (contentType, named) => {
    host.reply = () => ({ status: 200, headers: { 'content-type': contentType }, body: 'x' });
    const error = await refusal(
      guardedFetch(`${host.base}/x`, { ...local, allowedContentTypes: ['image/png', 'image/jpeg'] }),
    );
    expect(error).toMatchObject({ reason: 'content-type', message: `content type ${named} is not allowed` });
  });

  it('accepts an allowed type by essence (case, parameters, wildcard) and a missing type only when asked', async () => {
    for (const contentType of ['IMAGE/JPEG', 'image/jpeg; charset=binary', 'image/webp']) {
      host.reply = () => ({ status: 200, headers: { 'content-type': contentType }, body: 'x' });
      const res = await guardedFetch(`${host.base}/x`, { ...local, allowedContentTypes: ['image/jpeg', 'image/*'] });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    host.reply = () => ({ status: 200, body: 'x' });
    expect(await refusal(guardedFetch(`${host.base}/x`, { ...local, allowedContentTypes: ['image/*'] }))).toMatchObject(
      {
        reason: 'content-type',
        message: 'content type (none) is not allowed',
      },
    );
    const res = await guardedFetch(`${host.base}/x`, {
      ...local,
      allowedContentTypes: ['image/*'],
      allowMissingContentType: true,
    });
    expect(await res.text()).toBe('x');
    // The type check applies to a 2xx only: an error answer is returned for the caller to read.
    host.reply = () => ({ status: 500, headers: { 'content-type': 'text/html' }, body: 'boom' });
    expect((await guardedFetch(`${host.base}/x`, { ...local, allowedContentTypes: ['image/*'] })).status).toBe(500);
  });

  it('times out waiting for the head, and while the body stalls', async () => {
    host.reply = () => ({ status: 200, body: 'hang' });
    expect(await refusal(guardedFetch(`${host.base}/slow`, { ...local, timeoutMs: 50 }))).toMatchObject({
      reason: 'timeout',
      message: 'timed out after 50 ms',
    });
    host.reply = () => ({ status: 200, body: 'stall' });
    const res = await guardedFetch(`${host.base}/stall`, { ...local, timeoutMs: 150 });
    expect(await refusal(res.arrayBuffer())).toMatchObject({ reason: 'timeout' });
  });

  it('honours an abort before, during the head and during the body', async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(await refusal(guardedFetch(`${host.base}/a`, { ...local, signal: aborted.signal }))).toMatchObject({
      reason: 'aborted',
    });
    host.reply = () => ({ status: 200, body: 'hang' });
    const during = new AbortController();
    const pending = guardedFetch(`${host.base}/slow`, { ...local, signal: during.signal });
    setTimeout(() => during.abort(), 20);
    expect(await refusal(pending)).toMatchObject({ reason: 'aborted' });
    host.reply = () => ({ status: 200, body: 'stall' });
    const body = new AbortController();
    const res = await guardedFetch(`${host.base}/stall`, { ...local, signal: body.signal });
    setTimeout(() => body.abort(), 20);
    expect(await refusal(res.arrayBuffer())).toMatchObject({ reason: 'aborted' });
  });

  it('reports a connection dropped mid-body as a network error', async () => {
    host.reply = () => ({ status: 200, body: 'reset' });
    const res = await guardedFetch(`${host.base}/cut`, local);
    expect(await refusal(res.arrayBuffer())).toMatchObject({ reason: 'network' });
  });

  it('a cancelled body closes the connection long before the time cap', async () => {
    host.reply = () => ({ status: 200, body: 'stall' });
    const res = await guardedFetch(`${host.base}/stall`, { ...local, timeoutMs: 60_000 });
    const started = Date.now();
    await res.body?.cancel();
    await host.stalledClosed;
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a refused connection as a network error', async () => {
    const error = await refusal(guardedFetch('http://127.0.0.1:1/x', local));
    expect(error.reason).toBe('network');
  });
});

describe('guardedLookup', () => {
  const run = (base: LookupFunction, all: boolean) =>
    new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) => {
      guardedLookup(base, isPublicAddress)('files.example.test', { all }, (error, address, family) =>
        resolve({ error, address, family }),
      );
    });

  it('answers the single-address form when the socket asks for one', async () => {
    const result = await run(fakeDns([{ address: '93.184.216.34', family: 4 }]), false);
    expect(result).toEqual({ error: null, address: '93.184.216.34', family: 4 });
  });

  it('answers every address when the socket asks for all', async () => {
    const addresses = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ];
    expect((await run(fakeDns(addresses), true)).address).toEqual(addresses);
  });

  it('accepts a resolver that answers a single address, and still checks it', async () => {
    const single =
      (address: string): LookupFunction =>
      (_hostname, _options, callback) =>
        callback(null, address, 4);
    expect((await run(single('93.184.216.34'), false)).address).toBe('93.184.216.34');
    const refused = await run(single('127.0.0.1'), false);
    expect(refused.error?.code).toBe(ADDRESS_BLOCKED_CODE);
  });
});

describe('createGuardedAgent', () => {
  it('is a fresh agent per call whose sockets resolve through the guard', async () => {
    const asked: string[] = [];
    const agent = createGuardedAgent('http:', { lookup: fakeDns([{ address: '127.0.0.1', family: 4 }], asked) });
    expect(agent).not.toBe(createGuardedAgent('http:'));
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      httpGet(`http://files.example.test:${host.port}/a`, { agent }, (res) => res.resume()).on('error', resolve);
    });
    agent.destroy();
    expect(error.code).toBe(ADDRESS_BLOCKED_CODE);
    expect(asked).toEqual(['files.example.test']);
    expect(host.hits).toEqual([]);
  });

  it('connects when the policy allows the address', async () => {
    const agent = createGuardedAgent('http:', {
      lookup: fakeDns([{ address: '127.0.0.1', family: 4 }]),
      allowPrivate: true,
    });
    const status = await new Promise<number>((resolve, reject) => {
      httpGet(`http://files.example.test:${host.port}/a`, { agent }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject);
    });
    agent.destroy();
    expect(status).toBe(200);
  });
});

describe('guardedFetch under https and several address families', () => {
  /** A plain TCP listener counting connections (the refusal happens before any TLS handshake). */
  let tcp: TcpServer;
  let tcpPort = 0;
  let connections = 0;
  beforeAll(async () => {
    tcp = createTcpServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((done) => tcp.listen(0, '127.0.0.1', done));
    tcpPort = (tcp.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((done) => tcp.close(() => done()));
  });
  beforeEach(() => {
    connections = 0;
  });

  it('runs the guarded lookup on an https URL too and never connects', async () => {
    const asked: string[] = [];
    const error = await refusal(
      guardedFetch(`https://files.example.test:${tcpPort}/a.png`, {
        lookup: fakeDns([{ address: '127.0.0.1', family: 4 }], asked),
      }),
    );
    expect(error.message).toMatch(/the host resolves to a private, loopback or link-local address/);
    expect(asked).toEqual(['files.example.test']);
    expect(connections).toBe(0);
  });

  it('keeps the actionable refusal when every family resolves to a blocked address', async () => {
    const both = fakeDns([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
    const error = await refusal(guardedFetch(`http://files.example.test:${tcpPort}/a.png`, { lookup: both }));
    expect(error.message).toMatch(/the host resolves to a private, loopback or link-local address/);
    expect(connections).toBe(0);
  });
});

describe('guardedFetch ignores an environment proxy', () => {
  /**
   * A recording proxy: plain proxy requests are answered with 200 (so a request routed through it would
   * succeed), CONNECT tunnels are counted and dropped.
   */
  let proxy: Server;
  let proxyPort = 0;
  const proxied: string[] = [];
  beforeAll(async () => {
    proxy = createServer((req, res) => {
      proxied.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.alloc(8, 1));
    });
    proxy.on('connect', (req, socket) => {
      proxied.push(`CONNECT ${req.url}`);
      socket.destroy();
    });
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    proxyPort = (proxy.address() as AddressInfo).port;
  });
  afterAll(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((done) => proxy.close(() => done()));
  });

  const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'net-proxy-child.ts');

  /** Run the child with Node's env proxy switched on; its one JSON line. */
  function runChild(scheme: 'http' | 'https'): Promise<{ ok: boolean; message?: string; asked: string[] }> {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
        cwd: join(dirname(CHILD), '..', '..'),
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          TARGET_SCHEME: scheme,
          TARGET_PORT: String(host.port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      child.on('error', reject);
      child.on('close', () => {
        const line = out.trim().split('\n').pop() ?? '';
        try {
          resolve(JSON.parse(line) as { ok: boolean; message?: string; asked: string[] });
        } catch {
          reject(new Error(`child printed no result: ${out} ${err}`));
        }
      });
    });
  }

  it.each(['http', 'https'] as const)(
    'with NODE_USE_ENV_PROXY and %s proxy env set, a name resolving to loopback is still refused and the proxy sees nothing',
    async (scheme) => {
      proxied.length = 0;
      const result = await runChild(scheme);
      expect(result).toEqual({
        ok: false,
        message: expect.stringMatching(/the host resolves to a private, loopback or link-local address/),
        asked: ['files.example.test'],
      });
      expect(proxied).toEqual([]);
      expect(host.hits).toEqual([]);
    },
    30_000,
  );
});
