import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  CredentialRegistry,
  CredentialScope,
  credentialOutcomeFromError,
  credentialOutcomeFromHttp,
  currentCredentialScope,
  DEFAULT_CREDENTIAL_RECHECK_MS,
  formatCredentialReport,
  NoUsableCredentialError,
  processCredentials,
  runWithCredentialScope,
  setProcessCredentials,
  UnknownCredentialError,
} from '../src/credentials.js';
import { HttpError } from '../src/http-client.js';
import { initLogger, registerSecretValues, resetLogger } from '../src/utils/logger.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  resetLogger();
  clock = Date.UTC(2026, 0, 1);
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'credentials-test', fileMain: false, fileExceptions: false, fileDebug: false });
});

afterEach(() => {
  stderr.mockRestore();
  resetLogger();
  setProcessCredentials(undefined);
});

function stderrText(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join('');
}

type Status = 'valid' | 'invalid' | 'expired' | 'degraded' | 'unknown';

function pool(...statuses: Status[]): CredentialRegistry {
  const registry = new CredentialRegistry({ now });
  statuses.forEach((status, i) => {
    const key = i === 0 ? 'KEY' : `KEY_${i}`;
    registry.register(key, { pool: 'KEY' });
    if (status !== 'unknown') registry.set(key, status, { silent: true });
  });
  return registry;
}

describe('CredentialRegistry', () => {
  it('registers keys as unknown, pools members in order and keeps a status on re-register', () => {
    const r = new CredentialRegistry({ now });
    r.register('A');
    r.register('P', { pool: 'P' });
    r.register('P_1', { pool: 'P' });
    expect(r.status('A')).toBe('unknown');
    expect(r.status('NEVER')).toBe('unknown');
    expect(r.members('P')).toEqual(['P', 'P_1']);
    expect(r.members('A')).toEqual(['A']);
    expect(r.members('NONE')).toEqual([]);
    expect(r.members(['A', 'P_1'])).toEqual(['A', 'P_1']);
    r.set('A', 'valid');
    r.register('A');
    expect(r.status('A')).toBe('valid');
    r.register('A', { pool: 'Q' });
    r.register('A', { pool: 'R' });
    expect(r.members('Q')).toEqual([]);
    expect(r.members('R')).toEqual(['A']);
    expect(r.state('A')?.pool).toBe('R');
    expect(r.has('A')).toBe(true);
    r.clear();
    expect(r.has('A')).toBe(false);
    expect(r.snapshot()).toEqual([]);
  });

  it('candidates rank valid, unknown, degraded, then invalid and expired as the last resort', () => {
    expect(pool('invalid', 'expired', 'valid').candidates('KEY')).toEqual(['KEY_2', 'KEY', 'KEY_1']);
    expect(pool('degraded', 'unknown').pick('KEY')).toBe('KEY_1');
    expect(pool('unknown', 'valid').pick('KEY')).toBe('KEY_1');
    expect(pool('degraded', 'invalid').pick('KEY')).toBe('KEY');
    // A pool whose keys all went bad still offers them (no key is lost for good).
    expect(pool('invalid', 'expired').candidates('KEY')).toEqual(['KEY', 'KEY_1']);
    expect(new CredentialRegistry().pick('EMPTY')).toBeUndefined();
  });

  it('rotates within the healthiest tier and keeps the worse tiers after it', () => {
    const r = pool('valid', 'valid', 'unknown');
    expect(r.candidates('KEY')).toEqual(['KEY', 'KEY_1', 'KEY_2']);
    expect(r.candidates('KEY')).toEqual(['KEY_1', 'KEY', 'KEY_2']);
    expect(r.pick('KEY')).toBe('KEY');
    expect(r.pick(['KEY_2', 'KEY_1'])).toBe('KEY_1');
  });

  it('a degraded key goes back to unknown once the retry-after elapses (logged once), valid on success', () => {
    const r = pool('unknown', 'unknown');
    r.record('KEY', 'degraded', { reason: 'quota', retryAfterMs: 10_000 });
    expect(r.state('KEY')).toMatchObject({ status: 'degraded', reason: 'quota', retryInSeconds: 10 });
    expect(r.pick('KEY')).toBe('KEY_1');
    r.record('KEY_1', 'degraded');
    expect(r.state('KEY_1')?.retryInSeconds).toBe(60);
    clock += 10_001;
    expect(r.state('KEY')).toMatchObject({ status: 'unknown', reason: 'retry-after elapsed' });
    expect(r.state('KEY')?.retryInSeconds).toBeUndefined();
    expect(r.pick('KEY')).toBe('KEY');
    expect(stderrText().match(/Credential KEY: degraded -> unknown/g)).toHaveLength(1);
    r.record('KEY', 'ok');
    expect(r.state('KEY')).toMatchObject({ status: 'valid' });
    expect(r.state('KEY')?.reason).toBeUndefined();
    r.record('KEY_1', 'recovered');
    expect(r.status('KEY_1')).toBe('valid');
  });

  it('record: used leaves the status; lastUsedAt is set; degraded defaults its cool-down', () => {
    const r = new CredentialRegistry({ now, defaultRetryAfterMs: 5000 });
    r.register('NEW');
    r.record('NEW', 'used');
    expect(r.state('NEW')).toEqual({ key: 'NEW', status: 'unknown', lastUsedAt: new Date(clock).toISOString() });
    r.record('NEW', 'invalid', { reason: 'auth rejected' });
    r.record('NEW', 'used');
    expect(r.status('NEW')).toBe('invalid');
    r.record('NEW', 'expired');
    expect(r.state('NEW')?.reason).toBeUndefined();
    r.record('NEW', 'degraded');
    expect(r.state('NEW')?.retryInSeconds).toBe(5);
    r.set('NEW', 'degraded', { reason: 'rate limit', retryAfterMs: 1000 });
    expect(r.state('NEW')).toMatchObject({ reason: 'rate limit', retryInSeconds: 1 });
    r.register('OTHER');
    r.set('OTHER', 'valid', { silent: true });
    r.touch('OTHER');
    expect(r.state('OTHER')?.lastUsedAt).toBeDefined();
  });

  it('refuses any identifier that is not a declared key name, without echoing it', () => {
    const value = `ghp_${'a'.repeat(36)}`;
    const r = new CredentialRegistry({ now });
    r.register('DECLARED');
    for (const call of [
      () => r.record(value, 'ok'),
      () => r.set(value, 'valid'),
      () => r.touch(value),
      () => r.setProbe(value, async () => ({ status: 'valid' })),
      () => r.recheck(value),
      () => r.members(['DECLARED', value]),
      () => r.register('not a name'),
      () => r.register('sk-live/abc'),
      () => r.register('OK', { pool: 'bad pool' }),
    ]) {
      expect(call).toThrow(UnknownCredentialError);
      try {
        call();
      } catch (e) {
        expect((e as Error).message).not.toContain(value);
      }
    }
    expect(r.has(value)).toBe(false);
    expect(r.snapshot().map((s) => s.key)).toEqual(['DECLARED']);
  });

  it('logs each transition once, by key name only, WARN for unhealthy and INFO for healthy', () => {
    const r = new CredentialRegistry({ now });
    r.register('SERPER_KEY');
    r.record('SERPER_KEY', 'ok');
    r.record('SERPER_KEY', 'ok');
    r.record('SERPER_KEY', 'degraded', { reason: 'quota' });
    r.record('SERPER_KEY', 'degraded', { reason: 'quota' });
    r.set('SERPER_KEY', 'unknown');
    const out = stderrText();
    expect(out.match(/Credential SERPER_KEY: unknown -> valid/g)).toHaveLength(1);
    expect(out.match(/Credential SERPER_KEY: valid -> degraded \(quota\)/g)).toHaveLength(1);
    expect(out).toMatch(/WARN {2}\| Credentials \| Credential SERPER_KEY: valid -> degraded/);
    expect(out).toMatch(/INFO {2}\| Credentials \| Credential SERPER_KEY: degraded -> unknown/);
  });

  it('masks a registered secret value inside a reason and bounds it', () => {
    registerSecretValues(['super-secret-value-123']);
    const r = new CredentialRegistry({ now });
    r.register('K');
    r.record('K', 'invalid', { reason: `rejected super-secret-value-123\nline ${'x'.repeat(300)}` });
    const reason = r.state('K')?.reason ?? '';
    expect(reason).not.toContain('super-secret-value-123');
    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(stderrText()).not.toContain('super-secret-value-123');
  });

  it('snapshot reports names and statuses in registration order, with timestamps', () => {
    const r = pool('valid', 'invalid');
    expect(r.snapshot().map((s) => [s.key, s.pool, s.status])).toEqual([
      ['KEY', 'KEY', 'valid'],
      ['KEY_1', 'KEY', 'invalid'],
    ]);
    expect(r.snapshot()[0]?.changedAt).toBe(new Date(clock).toISOString());
    expect(r.state('NONE')).toBeUndefined();
  });

  it('processCredentials is one registry per process until replaced', () => {
    const a = processCredentials();
    expect(processCredentials()).toBe(a);
    const own = new CredentialRegistry();
    setProcessCredentials(own);
    expect(processCredentials()).toBe(own);
    setProcessCredentials(undefined);
    expect(processCredentials()).not.toBe(own);
  });
});

describe('re-checking invalid and expired keys', () => {
  it('runs the probe after the cool-down (in the background of candidates) and a success restores the key', async () => {
    const r = new CredentialRegistry({ now, recheckMs: 1000 });
    r.register('KEY', { pool: 'KEY' });
    r.register('KEY_1', { pool: 'KEY' });
    r.set('KEY_1', 'valid', { silent: true });
    const probe = jest.fn(async () => ({ status: 'valid' as const }));
    r.setProbe('KEY', probe);
    r.record('KEY', 'invalid', { reason: 'auth rejected' });
    r.candidates('KEY');
    expect(probe).not.toHaveBeenCalled();
    clock += 1000;
    r.candidates('KEY');
    expect(probe).toHaveBeenCalledTimes(1);
    // One probe per key at a time.
    r.candidates('KEY');
    expect(probe).toHaveBeenCalledTimes(1);
    await r.recheck('KEY');
    expect(r.status('KEY')).toBe('valid');
    expect(stderrText()).toContain('Credential KEY: invalid -> valid');
  });

  it('a probe that still fails keeps the key invalid and waits another cool-down; a throwing probe proves nothing', async () => {
    const r = new CredentialRegistry({ now, recheckMs: 500 });
    r.register('KEY');
    let answer: () => Promise<{ status: 'invalid' | 'valid' }> = async () => ({ status: 'invalid' });
    const probe = jest.fn(() => answer());
    r.setProbe('KEY', probe);
    r.record('KEY', 'expired');
    clock += 500;
    expect(await r.recheck('KEY')).toBe('invalid');
    r.candidates('KEY');
    expect(probe).toHaveBeenCalledTimes(1);
    answer = async () => {
      throw new Error('offline');
    };
    clock += 500;
    expect(await r.recheck('KEY')).toBe('invalid');
    r.candidates('KEY');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('without a probe a re-check keeps the status; the default cool-down is five minutes', async () => {
    const r = new CredentialRegistry({ now });
    r.register('KEY');
    r.record('KEY', 'invalid');
    expect(await r.recheck('KEY')).toBe('invalid');
    expect(DEFAULT_CREDENTIAL_RECHECK_MS).toBe(300_000);
    r.setRecheckMs(-5);
    r.record('KEY', 'invalid');
    const probe = jest.fn(async () => ({ status: 'valid' as const }));
    r.setProbe('KEY', probe);
    r.candidates('KEY');
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('credentialOutcomeFromHttp', () => {
  it.each([
    [{ status: 200 }, 'ok', undefined],
    [{ status: 304 }, 'ok', undefined],
    [{ status: 401 }, 'invalid', 'auth rejected'],
    [{ status: 401, code: 'token_expired' }, 'expired', 'expired'],
    [{ status: 401, message: 'The access token expired' }, 'expired', 'expired'],
    // A plain 403 is an authorization answer about one resource: the key is left alone.
    [{ status: 403 }, 'used', undefined],
    [{ status: 403, message: 'You do not have access to this project' }, 'used', undefined],
    [{ status: 403, message: 'The caller does not have permission' }, 'used', undefined],
    [{ status: 403, message: 'Bad credentials' }, 'invalid', 'credential rejected'],
    [{ status: 403, message: 'Invalid API key provided' }, 'invalid', 'credential rejected'],
    [{ status: 403, message: 'This token has been revoked' }, 'invalid', 'credential rejected'],
    [{ status: 403, authenticate: 'Bearer error="invalid_token"' }, 'invalid', 'credential rejected'],
    [{ status: 403, message: 'API key expired. Please renew the API key.' }, 'expired', 'expired'],
    [{ status: 403, message: 'API rate limit exceeded' }, 'degraded', 'rate limit'],
    [{ status: 403, message: 'Daily quota exhausted' }, 'degraded', 'quota'],
    [{ status: 402 }, 'degraded', 'quota'],
    [{ status: 429 }, 'degraded', 'rate limit'],
    [{ status: 429, message: 'Monthly quota exhausted' }, 'degraded', 'quota'],
    // Ordinary client errors never touch the key, whatever the body says.
    [{ status: 400, message: 'API key expired. Please renew the API key.' }, 'used', undefined],
    [{ status: 400, message: 'Your account has run out of searches' }, 'used', undefined],
    [{ status: 400, message: 'Too many requests' }, 'used', undefined],
    [{ status: 413, message: 'payload size exceeded' }, 'used', undefined],
    [{ status: 422, message: 'length exceeded' }, 'used', undefined],
    [{ status: 401, message: 'pagination cursor has expired' }, 'invalid', 'auth rejected'],
    // GitLab (OAuth style): `error` is the generic code, the expiry is in `error_description` and the
    // `WWW-Authenticate` challenge; both are read on a 401.
    [
      {
        status: 401,
        message: 'invalid_token',
        description: 'Token is expired. You can either do re-authorization or token refresh.',
      },
      'expired',
      'expired',
    ],
    [
      {
        status: 401,
        message: 'invalid_token',
        authenticate:
          'Bearer realm="", error="invalid_token", error_description="Token is expired. You can either do re-authorization or token refresh."',
      },
      'expired',
      'expired',
    ],
    [
      {
        status: 401,
        message: '401 Unauthorized',
        authenticate: 'Bearer error_description="Token has expired", error="invalid_token"',
      },
      'expired',
      'expired',
    ],
    [
      { status: 401, authenticate: "Bearer error=invalid_token, error_description='The access token expired'" },
      'expired',
      'expired',
    ],
    [
      {
        status: 401,
        message: 'invalid_token',
        description: 'Token was revoked. You have to re-authorize from the user.',
      },
      'invalid',
      'auth rejected',
    ],
    [
      {
        status: 401,
        message: 'invalid_token',
        authenticate:
          'Bearer realm="", error="invalid_token", error_description="Token was revoked. You have to re-authorize from the user."',
      },
      'invalid',
      'auth rejected',
    ],
    // Only the challenge's error parameters count, never the realm or any other parameter.
    [
      { status: 401, authenticate: 'Bearer realm="token expired portal", error="invalid_token"' },
      'invalid',
      'auth rejected',
    ],
    // A quoted value cannot inject a parameter (the header is tokenised, quoted strings skipped).
    [
      { status: 401, authenticate: 'Bearer realm="x, error_description=token expired", error="invalid_token"' },
      'invalid',
      'auth rejected',
    ],
    [
      { status: 401, authenticate: 'Bearer realm="a\\"b, error_description=\\"token expired"' },
      'invalid',
      'auth rejected',
    ],
    // error and error_description never combine into one match ("token" + "expired").
    [{ status: 401, authenticate: 'Bearer error="token", error_description="expired"' }, 'invalid', 'auth rejected'],
    // The 403 branch reads only the parsed error parameter, never the realm.
    [{ status: 403, authenticate: 'Bearer realm="invalid_token"' }, 'used', undefined],
    [{ status: 403, authenticate: 'Bearer realm="x", error=invalid_token' }, 'invalid', 'credential rejected'],
    [{ status: 403, challenge: { error: 'invalid_token' } }, 'invalid', 'credential rejected'],
    [{ status: 401, challenge: { error: 'invalid_token', description: 'The token expired' } }, 'expired', 'expired'],
    [
      { status: 403, authenticate: 'Bearer error="invalid_token", error_description="The access token expired"' },
      'expired',
      'expired',
    ],
    [{ status: 403, description: 'Token is expired' }, 'expired', 'expired'],
    [
      { status: 400, description: 'Token is expired', authenticate: 'Bearer error_description="Token is expired"' },
      'used',
      undefined,
    ],
    [{ status: 403, message: 'upload URL expired' }, 'used', undefined],
    [{ status: 403, message: 'signature expired' }, 'used', undefined],
    [{ status: 403, message: 'length exceeded' }, 'used', undefined],
    [{ status: 404 }, 'used', undefined],
    [{ status: 500, message: 'quota' }, 'used', undefined],
    [{}, 'used', undefined],
  ])('%j -> %s', (facts, outcome, reason) => {
    const c = credentialOutcomeFromHttp(facts);
    expect(c.outcome).toBe(outcome);
    expect(c.reason).toBe(reason);
  });

  it('carries the retry-after on degraded outcomes', () => {
    expect(credentialOutcomeFromHttp({ status: 429, retryAfterMs: 3_600_000 })).toEqual({
      outcome: 'degraded',
      reason: 'rate limit',
      retryAfterMs: 3_600_000,
    });
    expect(credentialOutcomeFromHttp({ status: 402, retryAfterMs: 5 }).retryAfterMs).toBe(5);
  });

  it('credentialOutcomeFromError reads the credential facts an HttpError carries (GitLab expired)', () => {
    const expiredText = 'Token is expired. You can either do re-authorization or token refresh.';
    const bodyOnly = new HttpError({
      message: 'invalid_token',
      method: 'GET',
      path: '/user',
      status: 401,
      description: expiredText,
    });
    const headerOnly = new HttpError({
      message: '401 Unauthorized',
      method: 'GET',
      path: '/user',
      status: 401,
      challenge: { error: 'invalid_token', description: expiredText },
    });
    const revoked = new HttpError({
      message: 'invalid_token',
      method: 'GET',
      path: '/user',
      status: 401,
      challenge: { error: 'invalid_token', description: 'Token was revoked.' },
    });
    expect(credentialOutcomeFromError(bodyOnly)).toEqual({ outcome: 'expired', reason: 'expired' });
    expect(credentialOutcomeFromError(headerOnly)).toEqual({ outcome: 'expired', reason: 'expired' });
    expect(credentialOutcomeFromError(revoked)).toEqual({ outcome: 'invalid', reason: 'auth rejected' });
    // A plain object with the same facts classifies the same; malformed facts are ignored.
    expect(credentialOutcomeFromError({ status: 401, challenge: { description: expiredText } })?.outcome).toBe(
      'expired',
    );
    expect(credentialOutcomeFromError({ status: 401, description: 7, challenge: 'x' })?.outcome).toBe('invalid');
  });

  it('credentialOutcomeFromError classifies only credential problems', () => {
    const err = new HttpError({ message: 'Too Many', method: 'GET', path: '/x', status: 429, retryAfterMs: 1000 });
    expect(credentialOutcomeFromError(err)).toEqual({ outcome: 'degraded', reason: 'rate limit', retryAfterMs: 1000 });
    expect(credentialOutcomeFromError({ status: 401, code: 'HTTP_401' })?.outcome).toBe('invalid');
    expect(credentialOutcomeFromError({ status: 403, message: 'Forbidden' })).toBeUndefined();
    expect(credentialOutcomeFromError({ status: 404 })).toBeUndefined();
    expect(credentialOutcomeFromError(new Error('boom'))).toBeUndefined();
    expect(credentialOutcomeFromError('nope')).toBeUndefined();
    expect(credentialOutcomeFromError(null)).toBeUndefined();
  });
});

describe('CredentialScope', () => {
  it('reports used keys and unhealthy considered keys, never healthy unused ones', () => {
    const r = pool('invalid', 'valid', 'valid');
    r.set('KEY', 'invalid', { reason: 'auth rejected', silent: true });
    const scope = new CredentialScope(r);
    expect(scope.touchedAny).toBe(false);
    expect(scope.has('KEY')).toBe(true);
    expect(scope.pick('KEY')).toBe('KEY_1');
    expect(scope.report()).toEqual([
      { key: 'KEY', status: 'invalid', used: false, reason: 'auth rejected' },
      { key: 'KEY_1', status: 'valid', used: true },
    ]);
    expect(scope.touchedAny).toBe(true);
  });

  it('a past-retry degraded key that is not used is not reported', () => {
    const r = pool('valid', 'unknown');
    r.record('KEY_1', 'degraded', { retryAfterMs: 1000 });
    clock += 2000;
    const scope = new CredentialScope(r);
    scope.pick('KEY');
    expect(scope.report()).toEqual([{ key: 'KEY', status: 'valid', used: true }]);
  });

  it('a single-key pool whose key is invalid still offers it (try and record), require throws only when empty', () => {
    const scope = new CredentialScope(pool('invalid'));
    expect(scope.require('KEY')).toBe('KEY');
    expect(() => new CredentialScope(new CredentialRegistry()).require('EMPTY')).toThrow(
      'No credential is configured for EMPTY',
    );
    expect(() => new CredentialScope(new CredentialRegistry()).require('EMPTY')).toThrow(NoUsableCredentialError);
  });

  it('use and record mark declared keys as used and write through; undeclared names throw', () => {
    const r = new CredentialRegistry({ now });
    r.register('A');
    r.register('B');
    const scope = new CredentialScope(r);
    scope.use('A');
    scope.use('A');
    scope.record('B', 'degraded', { reason: 'quota', retryAfterMs: 2000 });
    expect(r.status('B')).toBe('degraded');
    expect(scope.report()).toEqual([
      { key: 'A', status: 'unknown', used: true },
      { key: 'B', status: 'degraded', used: true, reason: 'quota', retryInSeconds: 2 },
    ]);
    expect(() => scope.use('sk-not-a-name')).toThrow(UnknownCredentialError);
    expect(() => scope.record('UNDECLARED', 'ok')).toThrow(UnknownCredentialError);
    expect(() => scope.pick(['UNDECLARED'])).toThrow(UnknownCredentialError);
    expect(scope.report().map((e) => e.key)).toEqual(['A', 'B']);
  });

  it('withFallback moves past credential failures, records them, and hands each key its value', async () => {
    const r = pool('valid', 'valid');
    const values: Record<string, string> = { KEY: 'v0', KEY_1: 'v1' };
    const scope = new CredentialScope(r, (k) => values[k]);
    const seen: Array<[string, string | undefined]> = [];
    const out = await scope.withFallback('KEY', async (key, value) => {
      seen.push([key, value]);
      if (key === 'KEY') throw new HttpError({ message: 'quota', method: 'GET', path: '/', status: 402 });
      return 'served';
    });
    expect(out).toBe('served');
    expect(seen).toEqual([
      ['KEY', 'v0'],
      ['KEY_1', 'v1'],
    ]);
    expect(r.status('KEY')).toBe('degraded');
    expect(formatCredentialReport(scope.report())).toBe('Credentials: KEY degraded (quota, retry in 60s); KEY_1 used');
  });

  it.each([
    ['body only', { description: 'Token is expired. You can either do re-authorization or token refresh.' }],
    ['header only', { challenge: { error: 'invalid_token', description: 'Token is expired' } }],
  ])('withFallback keeps a GitLab expired answer expired (%s)', async (_label, facts) => {
    const r = pool('valid', 'valid');
    const scope = new CredentialScope(r, () => 'v');
    const out = await scope.withFallback('KEY', async (key) => {
      if (key === 'KEY') {
        // What the http-client records before it throws, then the thrown error withFallback classifies.
        scope.record('KEY', 'expired', { reason: 'expired' });
        throw new HttpError({ message: 'invalid_token', method: 'GET', path: '/user', status: 401, ...facts });
      }
      return 'served';
    });
    expect(out).toBe('served');
    expect(r.state('KEY')).toMatchObject({ status: 'expired', reason: 'expired' });
  });

  it('withFallback tries invalid keys last, and a success restores one', async () => {
    const r = pool('invalid', 'expired');
    const scope = new CredentialScope(r);
    const tried: string[] = [];
    const out = await scope.withFallback('KEY', async (key) => {
      tried.push(key);
      if (key === 'KEY') throw new HttpError({ message: 'no', method: 'GET', path: '/', status: 401 });
      scope.record(key, 'ok');
      return 'served';
    });
    expect(out).toBe('served');
    expect(tried).toEqual(['KEY', 'KEY_1']);
    expect(r.status('KEY_1')).toBe('valid');
  });

  it('withFallback rethrows a non-credential error and throws NoUsableCredentialError when all fail', async () => {
    const scope = new CredentialScope(pool('valid', 'unknown'));
    await expect(
      scope.withFallback('KEY', async () => {
        throw new Error('parse failure');
      }),
    ).rejects.toThrow('parse failure');
    const all = new CredentialScope(pool('valid', 'unknown'));
    await expect(
      all.withFallback('KEY', async () => {
        throw new HttpError({ message: 'nope', method: 'GET', path: '/', status: 401 });
      }),
    ).rejects.toThrow('No usable credential for KEY: every candidate failed (KEY invalid, KEY_1 invalid) (KEY, KEY_1)');
    const none = new CredentialScope(new CredentialRegistry());
    await expect(none.withFallback('EMPTY', async () => 'x')).rejects.toThrow('No credential is configured for EMPTY');
    const registry = pool('valid');
    const listed = new CredentialScope(registry);
    await expect(
      listed.withFallback(['KEY'], async () => {
        throw new HttpError({ message: 'x', method: 'GET', path: '/', status: 402 });
      }),
    ).rejects.toThrow('No usable credential for KEY: every candidate failed (KEY degraded) (KEY)');
  });

  it('runWithCredentialScope exposes the scope to code running inside it only', async () => {
    const scope = new CredentialScope(new CredentialRegistry());
    expect(currentCredentialScope()).toBeUndefined();
    const inside = await runWithCredentialScope(scope, async () => {
      await Promise.resolve();
      return currentCredentialScope();
    });
    expect(inside).toBe(scope);
    expect(currentCredentialScope()).toBeUndefined();
  });
});

describe('formatCredentialReport', () => {
  it('formats used, degraded with reason and retry, invalid and expired; never "retry in 0s"', () => {
    expect(
      formatCredentialReport([
        { key: 'SERPER_DEV_API_KEY', status: 'valid', used: true },
        { key: 'VALUE_SERP_API_KEY_2', status: 'degraded', used: true, reason: 'quota', retryInSeconds: 3600 },
        { key: 'SERPAPI_API_KEY', status: 'invalid', used: false },
        { key: 'OLD', status: 'expired', used: true, reason: 'expired' },
        { key: 'NEW', status: 'unknown', used: true },
        { key: 'ZERO', status: 'degraded', used: true, retryInSeconds: 0 },
      ]),
    ).toBe(
      'Credentials: SERPER_DEV_API_KEY used; VALUE_SERP_API_KEY_2 degraded (quota, retry in 3600s); SERPAPI_API_KEY invalid; OLD expired (expired); NEW used; ZERO degraded',
    );
  });
});
