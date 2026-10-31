import { describe, expect, it } from '@jest/globals';
import { MAX_STRING_CHARS, maskPii, redactQueryParams, redactSecrets, sanitizeString } from '../../src/utils/redact.js';

describe('redact', () => {
  describe('security: sensitive-key redaction', () => {
    it('redacts the original key rules (authorization, token, api_key, password, ...)', () => {
      const out = JSON.stringify(
        redactSecrets({
          api_key: 'S1',
          authorization: 'S2',
          nested: { password: 'S3', accessToken: 'S4', refresh_token: 'S5', cookie: 'S6', safe: 'keep' },
        }),
      );
      for (const s of ['"S1"', '"S2"', '"S3"', '"S4"', '"S5"', '"S6"']) expect(out).not.toContain(s);
      expect(out).toContain('keep');
    });

    it.each([
      'key',
      'Key',
      'access_key',
      'accesskey',
      'accessKey',
      'credential',
      'credentials',
      'Credentials',
      'passwd',
      'tempauth',
      'TempAuth',
    ])('redacts the value of a %s field', (field) => {
      const out = JSON.stringify(redactSecrets({ nested: { [field]: 'LEAKED_SECRET_VALUE' } }));
      expect(out).not.toContain('LEAKED_SECRET_VALUE');
      expect(out).toContain('[REDACTED]');
    });

    it('matches `key` exactly, not as a substring (monkey, keyboard stay readable)', () => {
      expect(redactSecrets({ monkey: 'banana', keyboard: 'qwerty' })).toEqual({ monkey: 'banana', keyboard: 'qwerty' });
    });

    it.each([
      'maxTokens',
      'inputTokens',
      'output_tokens',
      'tokenizer',
      'tokenExpiry',
      'refreshTokenExpiresIn',
      'signatureAlgorithm',
      'credentialType',
      'primaryKey',
      'cacheKey',
      'sortKey',
      'keyId',
    ])('does not redact the operational field %s', (field) => {
      expect(redactSecrets({ [field]: 'visible' })).toEqual({ [field]: 'visible' });
    });

    it.each([
      'sessionToken',
      'idToken',
      'authToken',
      'X-Amz-Signature',
      'x-amz-security-token',
      'userPassword',
      'passwordHash',
      'tokenValue',
      'secretKey',
      'signingKey',
      'encryptionKey',
      'privateKey',
      'awsCredentials',
      'setCookie',
      'XApiKey',
      'APIKey',
      'clientSecret',
      'sig',
      'pwd',
      'passphrase',
    ])('redacts the secret field %s', (field) => {
      expect(redactSecrets({ [field]: 'LEAK' })).toEqual({ [field]: '[REDACTED]' });
    });

    it('does NOT redact generic data keys like value and content', () => {
      expect(redactSecrets({ record: { value: 'v=spf1 include:x -all' }, content: 'file body' })).toEqual({
        record: { value: 'v=spf1 include:x -all' },
        content: 'file body',
      });
    });

    it('leaves ordinary numbers, booleans and null unchanged', () => {
      expect(redactSecrets({ n: 1, b: true, z: null, big: 1700000000000 })).toEqual({
        n: 1,
        b: true,
        z: null,
        big: 1700000000000,
      });
    });

    it('security: never passes a deep subtree through raw (secrets and PII below the depth limit)', () => {
      const deep = {
        a: { b: { c: { d: { e: { f: { g: { h: { i: { password: 'hunter2', mail: 'x@y.com' } } } } } } } } },
      };
      const out = JSON.stringify(redactSecrets(deep));
      expect(out).not.toContain('hunter2');
      expect(out).not.toContain('x@y.com');
      expect(out).toContain('[DEPTH]');
    });

    it('security: masks a realistic deep manifest (k8s env) at every level it keeps', () => {
      const meta = {
        manifest: {
          spec: {
            template: {
              spec: { containers: [{ env: [{ name: 'DB_PASSWORD', value: 's3cret', email: 'a@b.com', token: 't' }] }] },
            },
          },
        },
      };
      const out = JSON.stringify(redactSecrets(meta));
      expect(out).not.toContain('a@b.com');
      expect(out).not.toContain('"t"');
    });

    it('replaces a circular reference instead of recursing or throwing', () => {
      const a: Record<string, unknown> = { name: 'a' };
      a.self = a;
      const out = redactSecrets(a) as Record<string, unknown>;
      expect(out.self).toBe('[CIRCULAR]');
      expect(() => JSON.stringify(out)).not.toThrow();
    });

    it('keeps a shared (non-circular) reference twice', () => {
      const shared = { v: 1 };
      expect(redactSecrets({ x: shared, y: shared })).toEqual({ x: { v: 1 }, y: { v: 1 } });
    });

    it('serialises a BigInt as a string so JSON.stringify cannot throw', () => {
      const out = redactSecrets({ n: BigInt(42) });
      expect(out).toEqual({ n: '42' });
    });

    it('masks a card number held as a JS number, and keeps other large integers', () => {
      expect(redactSecrets({ pan: 4111111111111111, id: 9007199254740991 })).toEqual({
        pan: '[CARD]',
        id: 9007199254740991,
      });
    });

    it('masks PII in object keys', () => {
      expect(redactSecrets({ 'bob@example.com': 1, 'alice@example.com': 2 })).toEqual({
        '[EMAIL]': 1,
        '[EMAIL]#2': 2,
      });
    });

    it('keeps Error name, message, stack, code and cause (sanitised)', () => {
      const cause = new Error('inner for x@y.com');
      const err = Object.assign(new Error('outer failed', { cause }), { code: 'ECONNRESET', password: 'p' });
      const out = redactSecrets({ err }) as { err: Record<string, unknown> };
      expect(out.err.name).toBe('Error');
      expect(out.err.message).toBe('outer failed');
      expect(out.err.code).toBe('ECONNRESET');
      expect(out.err.password).toBe('[REDACTED]');
      expect(String(out.err.stack)).toContain('outer failed');
      expect((out.err.cause as Record<string, unknown>).message).toBe('inner for [EMAIL]');
    });

    it('renders Date, URL, Map, Set and binary data meaningfully', () => {
      const out = redactSecrets({
        at: new Date('2026-10-23T17:50:10.764Z'),
        bad: new Date('nope'),
        url: new URL('https://x.test/a?token=SECRET'),
        map: new Map<unknown, unknown>([
          ['k', 'v'],
          ['api_key', 'S'],
        ]),
        set: new Set(['a@b.io', 'plain']),
        buf: new Uint8Array([1, 2, 3]),
        ab: new ArrayBuffer(8),
      });
      expect(out).toEqual({
        at: '2026-10-23T17:50:10.764Z',
        bad: 'Invalid Date',
        url: 'https://x.test/a?token=[REDACTED]',
        map: { k: 'v', api_key: '[REDACTED]' },
        set: ['[EMAIL]', 'plain'],
        buf: '[Binary 3 bytes]',
        ab: '[Binary 8 bytes]',
      });
    });

    it('caps arrays and objects at 200 entries', () => {
      const arr = Array.from({ length: 250 }, (_, i) => i);
      const out = redactSecrets(arr) as unknown[];
      expect(out).toHaveLength(201);
      expect(out[200]).toBe('[+50 more]');
      const obj: Record<string, number> = {};
      for (let i = 0; i < 205; i++) obj[`k${i}`] = i;
      const o = redactSecrets(obj) as Record<string, unknown>;
      expect(Object.keys(o)).toHaveLength(201);
      expect(o['[truncated]']).toBe('[+5 more keys]');
    });

    it('turns an object whose getter throws into a placeholder', () => {
      const evil = {};
      Object.defineProperty(evil, 'boom', {
        enumerable: true,
        get() {
          throw new Error('getter');
        },
      });
      expect(redactSecrets({ evil })).toEqual({ evil: '[UNREADABLE]' });
    });

    it('redacts inside arrays', () => {
      expect(redactSecrets([{ token: 'T' }, 'plain'])).toEqual([{ token: '[REDACTED]' }, 'plain']);
    });
  });

  describe('security: query-parameter redaction in strings', () => {
    it.each([
      'key',
      'api_key',
      'apikey',
      'access_key',
      'token',
      'access_token',
      'signature',
      'sig',
      'password',
      'secret',
      'tempauth',
      'client_secret',
      'API_KEY',
      'Token',
    ])('redacts the %s query parameter', (param) => {
      const url = `https://api.example.com/v1/items?page=2&${param}=QS_SECRET_123&limit=5#frag`;
      const out = redactQueryParams(url);
      expect(out).not.toContain('QS_SECRET_123');
      expect(out).toBe(`https://api.example.com/v1/items?page=2&${param}=[REDACTED]&limit=5#frag`);
    });

    it('redacts a first-position parameter and strings nested in meta', () => {
      expect(redactQueryParams('https://x.test/a?token=FIRST')).toBe('https://x.test/a?token=[REDACTED]');
      expect(JSON.stringify(redactSecrets({ urls: ['https://x.test/?sig=ARR'] }))).not.toContain('ARR');
      expect(redactSecrets('https://x.test/?api_key=PRIM')).toBe('https://x.test/?api_key=[REDACTED]');
    });

    it.each([
      ['a form body', 'token=abc123&x=1', 'token=[REDACTED]&x=1'],
      ['a message', 'retry with access_token=AT_1 now', 'retry with access_token=[REDACTED] now'],
      ['refresh_token', '?refresh_token=RT1', '?refresh_token=[REDACTED]'],
      ['id_token', '&id_token=opaque1', '&id_token=[REDACTED]'],
      [
        'AWS signature',
        '?X-Amz-Signature=abcd&X-Amz-Credential=AKIA/x',
        '?X-Amz-Signature=[REDACTED]&X-Amz-Credential=[REDACTED]',
      ],
      ['AWS session token', '&X-Amz-Security-Token=FQoG', '&X-Amz-Security-Token=[REDACTED]'],
    ])('redacts secret parameters in %s', (_label, input, expected) => {
      expect(sanitizeString(input)).toBe(expected);
    });

    it.each([
      // secretlint-disable-next-line
      ['postgres', 'postgres://admin:hunter2@localhost:5432/db', 'postgres://admin:[REDACTED]@localhost:5432/db'],
      ['https', 'https://user:pw@db.internal/x', 'https://user:[REDACTED]@db.internal/x'],
      // secretlint-disable-next-line
      ['mongodb+srv', 'mongodb+srv://u:p%40ss@cluster0.example.net', 'mongodb+srv://u:[REDACTED]@cluster0.example.net'],
    ])('redacts the password in %s connection-string userinfo', (_label, input, expected) => {
      expect(sanitizeString(input)).toBe(expected);
    });

    it('redacts HTTP Basic credentials, and leaves prose about basic auth', () => {
      const basic = Buffer.from('user:pass').toString('base64');
      expect(sanitizeString(`Authorization: Basic ${basic}`)).toBe('Authorization: Basic [TOKEN]');
      expect(sanitizeString('uses basic authentication here')).toBe('uses basic authentication here');
    });

    it('leaves parameters that only contain a secret name alone', () => {
      const url = 'https://x.test/?monkey=1&keys=2&tokens_used=3';
      expect(redactQueryParams(url)).toBe(url);
    });
  });

  describe('PII masking: positives', () => {
    it.each([
      ['email', 'contact jane.doe+ops@example.co.uk now', 'contact [EMAIL] now'],
      ['email (simple)', 'from a@b.io', 'from [EMAIL]'],
      ['phone international spaced', 'call +31 6 12345678 today', 'call [PHONE] today'],
      ['phone international compact', 'call +31612345678', 'call [PHONE]'],
      ['phone international parens', 'call +44 (20) 7946 0958', 'call [PHONE]'],
      ['phone international US', 'call +1 555 123 4567', 'call [PHONE]'],
      ['phone NANP parens', 'call (555) 123-4567', 'call [PHONE]'],
      ['phone NANP dashes', 'call 555-123-4567', 'call [PHONE]'],
      ['phone NANP dots', 'call 555.123.4567', 'call [PHONE]'],
      ['phone national NL mobile', 'bel 06-12345678', 'bel [PHONE]'],
      ['phone national NL landline', 'bel 020 123 4567', 'bel [PHONE]'],
      ['phone national DE', 'ruf 030 12345678', 'ruf [PHONE]'],
      ['card visa compact', 'card 4111111111111111 ok', 'card [CARD] ok'],
      ['card visa spaced', 'card 4111 1111 1111 1111', 'card [CARD]'],
      ['card mastercard dashed', 'card 5555-5555-5555-4444', 'card [CARD]'],
      ['card amex', 'card 3782 822463 10005', 'card [CARD]'],
      ['iban compact', 'iban NL91ABNA0417164300 ok', 'iban [IBAN] ok'],
      ['iban spaced', 'iban DE89 3704 0044 0532 0130 00', 'iban [IBAN]'],
      [
        'jwt',
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end',
        'jwt [JWT] end',
      ],
      ['bearer', 'Authorization: Bearer abc123DEF456ghi789', 'Authorization: Bearer [TOKEN]'],
      ['bearer lowercase', 'auth bearer xyz.987-654_321', 'auth bearer [TOKEN]'],
      ['bearer letters only, long', 'auth bearer abcdefghijklmnop', 'auth bearer [TOKEN]'],
      ['bearer letters only, mixed case', 'Authorization: Bearer AbCdEfGh', 'Authorization: Bearer [TOKEN]'],
      ['ipv4', 'from 192.168.1.10 port', 'from [IP] port'],
      ['ipv4 in url', 'http://10.0.0.5:8080/x', 'http://[IP]:8080/x'],
      ['ipv6 full', 'peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 up', 'peer [IP] up'],
      ['ipv6 compressed', 'peer 2001:db8::1 up', 'peer [IP] up'],
      ['ipv6 loopback', 'bind [::1]:8080', 'bind [IP]:8080'],
      ['ipv6 in url', 'http://[::1]:3000/x', 'http://[IP]:3000/x'],
      ['ipv6 link-local', 'peer fe80::1ff:fe23:4567:890a', 'peer [IP]'],
    ])('masks %s', (_label, input, expected) => {
      expect(maskPii(input)).toBe(expected);
    });

    it('masks every string value in meta recursively', () => {
      const out = redactSecrets({ user: { mail: 'x@y.com', peers: ['1.2.3.4'] }, note: 'card 4111111111111111' });
      expect(out).toEqual({ user: { mail: '[EMAIL]', peers: ['[IP]'] }, note: 'card [CARD]' });
    });
  });

  describe('PII masking: negatives (no false positives)', () => {
    it.each([
      ['ISO timestamp (Z)', '2026-10-23T17:50:10.764Z'],
      ['ISO timestamp (offset)', '2026-10-23T17:50:10+02:00'],
      ['ISO date', 'on 2026-10-23'],
      ['clock time', 'at 17:50:10'],
      ['semver', 'version 1.2.3'],
      ['prefixed four-part version', 'build v1.2.3.4'],
      ['prerelease version', '3.0.0-rc.1'],
      ['package spec', '@novorb/mcp-core@3.0.0'],
      ['plain integer', 'count 12345'],
      ['epoch millis', 'ts 1700000000000'],
      ['max safe integer', 'n 9007199254740991'],
      ['luhn-invalid card-shaped number', 'id 4111111111111112'],
      ['iban-shaped but bad checksum', 'ref NL00ABNA0417164300'],
      ['month-year', 'period 01-2026'],
      ['out-of-range dotted quad', 'value 300.1.2.3'],
      ['C++ scope', 'std::map and Foo::bar'],
      ['MAC address', 'mac 00:1a:2b:3c:4d:5e'],
      ['bearer prose', 'Bearer authentication is required'],
      ['signed small decimal', 'pnl +0.00012345'],
      ['signed decimal', 'change +12.3456789'],
      ['signed integer', 'delta +123456789'],
      ['short signed integer', 'qty +42'],
      ['grouped reference number', 'ref 0612-3456-78'],
      ['plain words', 'hello world'],
    ])('leaves %s alone', (_label, input) => {
      expect(maskPii(input)).toBe(input);
    });
  });

  describe('size cap', () => {
    it('truncates a string over the cap with a marker, cutting at a delimiter', () => {
      const long = `${'word '.repeat(MAX_STRING_CHARS / 5)}tail`;
      const out = sanitizeString(long);
      expect(out.length).toBeLessThan(MAX_STRING_CHARS + 64);
      expect(out).toMatch(/\.\.\.\[TRUNCATED \d+ chars\]$/);
      expect(out).not.toContain('tail');
    });

    it('does not leave half a secret at the cut (the partial token is dropped)', () => {
      const jwt = `eyJ${'a'.repeat(40)}.eyJ${'b'.repeat(40)}.${'c'.repeat(40)}`;
      const s = `${'x '.repeat((MAX_STRING_CHARS - 50) / 2)}${jwt}`;
      const out = sanitizeString(s);
      expect(out).not.toContain('eyJ');
      expect(out).toMatch(/\[TRUNCATED \d+ chars\]$/);
    });

    it('leaves a string at the cap untouched', () => {
      const s = 'a'.repeat(MAX_STRING_CHARS);
      expect(sanitizeString(s)).toBe(s);
    });
  });

  describe('performance: every pattern is linear on adversarial input', () => {
    const MB = 1024 * 1024;
    const shapes: Array<[string, string]> = [
      ['letters (old EMAIL quadratic)', 'A'],
      ['hex pairs', 'ab'],
      ['dotted letters', 'a.'],
      ['at signs', 'a@'],
      ['jwt-ish', 'eyJ'],
      ['digits', '1'],
      ['spaced digits', '22 '],
      ['colon hex', 'a:'],
      ['dotted digits', '1.'],
      ['plus digits', '+1'],
      ['query delimiters', '&token='],
      ['scheme', 'http://u:'],
      ['bearer', 'Bearer '],
      ['basic', 'basic '],
      ['uppercase alnum', 'NL91'],
      ['dash digits', '0-1 '],
    ];

    it.each(shapes)('maskPii + secret redaction on 1 MiB of %s', (_label, unit) => {
      const input = unit.repeat(Math.ceil(MB / unit.length));
      const started = performance.now();
      maskPii(redactQueryParams(input));
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('sanitizeString on a 5 MiB string returns quickly with a truncation marker', () => {
      const input = 'A'.repeat(5 * MB);
      const started = performance.now();
      const out = sanitizeString(input);
      expect(performance.now() - started).toBeLessThan(200);
      expect(out).toMatch(/\[TRUNCATED \d+ chars\]$/);
    });
  });
});
