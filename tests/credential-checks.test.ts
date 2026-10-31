import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  type CredentialCheck,
  DEFAULT_CREDENTIAL_CHECK_TIMEOUT_MS,
  registerEnvCredentials,
  runCredentialChecks,
} from '../src/credential-checks.js';
import { CredentialRegistry } from '../src/credentials.js';
import { HttpError } from '../src/http-client.js';
import { type EnvSchema, loadEnv } from '../src/utils/envLoader.js';
import { initLogger, resetLogger } from '../src/utils/logger.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;
let server: Server | undefined;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'checks-test', fileMain: false, fileExceptions: false, fileDebug: false });
});

afterEach(async () => {
  stderr.mockRestore();
  resetLogger();
  if (server) {
    const s = server;
    server = undefined;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

function stderrText(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join('');
}

function env(schema: EnvSchema, vars: Record<string, string>) {
  return loadEnv(schema, { rootDir: tmpdir(), env: { MCP_ENV_FILE: 'none', ...vars } });
}

const SECRET_A = 'value-a-0123456789';
const SECRET_B = 'value-b-0123456789';
const SECRET_C = 'value-c-0123456789';

/** A check answering by value: the test's stand-in for a provider probe. */
const byValue =
  (answers: Record<string, Awaited<ReturnType<CredentialCheck>>>): CredentialCheck =>
  async (value) =>
    answers[value] ?? 'unknown';

describe('registerEnvCredentials', () => {
  it('registers checked keys and the server secrets, pools multi members, skips core secrets and unset keys', () => {
    const e = env(
      [
        { key: 'SEARCH_KEY', multi: true, secret: true, check: byValue({}) },
        { key: 'PLAIN_SECRET', secret: true },
        { key: 'NOT_SECRET' },
        { key: 'UNSET_SECRET', secret: true },
      ],
      {
        SEARCH_KEY: SECRET_A,
        SEARCH_KEY_2: SECRET_B,
        PLAIN_SECRET: SECRET_C,
        NOT_SECRET: 'x',
        MCP_API_KEY: 'core-api-key-0123456789',
      },
    );
    const r = new CredentialRegistry();
    const declared = registerEnvCredentials(e, r);
    expect(declared.map((d) => [d.key, d.check !== undefined])).toEqual([
      ['SEARCH_KEY', true],
      ['SEARCH_KEY_2', true],
      ['PLAIN_SECRET', false],
    ]);
    expect(r.members('SEARCH_KEY')).toEqual(['SEARCH_KEY', 'SEARCH_KEY_2']);
    expect(r.snapshot().map((s) => s.key)).toEqual(['SEARCH_KEY', 'SEARCH_KEY_2', 'PLAIN_SECRET']);
  });
});

describe('runCredentialChecks', () => {
  it('checks each pool member on its own, in parallel, with its own key name', async () => {
    const seen: string[] = [];
    let running = 0;
    let peak = 0;
    const check: CredentialCheck = async (value, ctx) => {
      seen.push(ctx.key);
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return value === SECRET_A ? 'valid' : { status: 'invalid', reason: 'auth rejected' };
    };
    const e = env([{ key: 'SEARCH_KEY', multi: true, secret: true, check }], {
      SEARCH_KEY: SECRET_A,
      SEARCH_KEY_1: SECRET_B,
    });
    const r = new CredentialRegistry();
    const results = await runCredentialChecks(e, r);
    expect(seen.sort()).toEqual(['SEARCH_KEY', 'SEARCH_KEY_1']);
    expect(peak).toBe(2);
    expect(results).toEqual([
      { key: 'SEARCH_KEY', status: 'valid' },
      { key: 'SEARCH_KEY_1', status: 'invalid', reason: 'auth rejected' },
    ]);
    expect(r.status('SEARCH_KEY_1')).toBe('invalid');
    const out = stderrText();
    expect(out).toContain('credential checks: SEARCH_KEY valid, SEARCH_KEY_1 invalid (auth rejected)');
    expect(out).toMatch(/WARN {2}\| Credentials \| credential checks/);
    expect(out).not.toContain(SECRET_A);
    expect(out).not.toContain(SECRET_B);
    expect(out).not.toMatch(/Credential SEARCH_KEY: /);
  });

  it('logs INFO when every check is valid, and accepts a degraded result with retry-after', async () => {
    const e = env(
      [
        { key: 'A_KEY', secret: true, check: byValue({ [SECRET_A]: 'valid' }) },
        {
          key: 'B_KEY',
          secret: true,
          check: byValue({ [SECRET_B]: { status: 'degraded', reason: 'quota', retryAfterMs: 5000 } }),
        },
      ],
      { A_KEY: SECRET_A, B_KEY: SECRET_B },
    );
    const r = new CredentialRegistry();
    await runCredentialChecks(e, r);
    expect(r.state('B_KEY')).toMatchObject({ status: 'degraded', reason: 'quota', retryInSeconds: 5 });
    const onlyValid = env([{ key: 'A_KEY', secret: true, check: byValue({ [SECRET_A]: 'valid' }) }], {
      A_KEY: SECRET_A,
    });
    await runCredentialChecks(onlyValid, new CredentialRegistry());
    expect(stderrText()).toMatch(/INFO {2}\| Credentials \| credential checks: A_KEY valid/);
  });

  it('a check that times out reads unknown (timeout) and its signal is aborted', async () => {
    let aborted = false;
    const hang: CredentialCheck = (_value, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
        });
        setTimeout(() => resolve('valid'), 5000).unref();
      });
    const e = env([{ key: 'SLOW_KEY', secret: true, check: hang }], { SLOW_KEY: SECRET_A });
    const r = new CredentialRegistry();
    const started = Date.now();
    const results = await runCredentialChecks(e, r, { timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(results).toEqual([{ key: 'SLOW_KEY', status: 'unknown', reason: 'timeout' }]);
    expect(aborted).toBe(true);
  });

  it('reads the timeout from MCP_CREDENTIAL_CHECK_TIMEOUT_MS', async () => {
    const hang: CredentialCheck = () => new Promise(() => undefined);
    const e = env([{ key: 'SLOW_KEY', secret: true, check: hang }], {
      SLOW_KEY: SECRET_A,
      MCP_CREDENTIAL_CHECK_TIMEOUT_MS: '25',
    });
    const results = await runCredentialChecks(e, new CredentialRegistry());
    expect(results[0]?.reason).toBe('timeout');
    expect(DEFAULT_CREDENTIAL_CHECK_TIMEOUT_MS).toBe(5000);
  });

  it('MCP_CREDENTIAL_CHECKS=false skips every check (keys stay unknown); the option overrides', async () => {
    const check = jest.fn<CredentialCheck>(async () => 'valid');
    const e = env([{ key: 'A_KEY', secret: true, check }], { A_KEY: SECRET_A, MCP_CREDENTIAL_CHECKS: 'false' });
    const r = new CredentialRegistry();
    expect(await runCredentialChecks(e, r)).toEqual([]);
    expect(check).not.toHaveBeenCalled();
    expect(r.status('A_KEY')).toBe('unknown');
    expect(stderrText()).toContain('credential checks skipped (MCP_CREDENTIAL_CHECKS=false): 1 credential(s) unknown');
    await runCredentialChecks(e, r, { enabled: true });
    expect(r.status('A_KEY')).toBe('valid');
  });

  it('no declared check: nothing runs and nothing is logged', async () => {
    const e = env([{ key: 'A_KEY', secret: true }], { A_KEY: SECRET_A });
    const r = new CredentialRegistry();
    expect(await runCredentialChecks(e, r)).toEqual([]);
    expect(r.status('A_KEY')).toBe('unknown');
    expect(stderrText()).not.toContain('credential checks');
  });

  it('a thrown HttpError is classified; other throws and bad answers read unknown; reasons are masked', async () => {
    const e = env(
      [
        {
          key: 'A_KEY',
          secret: true,
          check: async () => {
            throw new HttpError({ message: 'Unauthorized', method: 'GET', path: '/me', status: 401 });
          },
        },
        {
          key: 'B_KEY',
          secret: true,
          check: async () => {
            throw new HttpError({ message: 'Too many', method: 'GET', path: '/me', status: 429, retryAfterMs: 2000 });
          },
        },
        {
          key: 'C_KEY',
          secret: true,
          check: async () => {
            throw new HttpError({ message: 'Server', method: 'GET', path: '/me', status: 503 });
          },
        },
        {
          key: 'D_KEY',
          secret: true,
          check: async (value) => {
            throw new Error(`network down for ${value}`);
          },
        },
        {
          key: 'E_KEY',
          secret: true,
          check: (async () => 'maybe') as unknown as CredentialCheck,
        },
        { key: 'F_KEY', secret: true, check: async (value) => ({ status: 'invalid', reason: `rejected ${value}` }) },
        { key: 'G_KEY', secret: true, check: (async () => ({ status: 'nope' })) as unknown as CredentialCheck },
      ],
      {
        A_KEY: 'value-a-0123456789',
        B_KEY: 'value-b-0123456789',
        C_KEY: 'value-c-0123456789',
        D_KEY: 'value-d-0123456789',
        E_KEY: 'value-e-0123456789',
        F_KEY: 'value-f-0123456789',
        G_KEY: 'value-g-0123456789',
      },
    );
    const r = new CredentialRegistry();
    const results = await runCredentialChecks(e, r);
    expect(results).toEqual([
      { key: 'A_KEY', status: 'invalid', reason: 'auth rejected' },
      { key: 'B_KEY', status: 'degraded', reason: 'rate limit' },
      { key: 'C_KEY', status: 'unknown', reason: 'check failed (HTTP 503)' },
      { key: 'D_KEY', status: 'unknown', reason: 'check failed' },
      { key: 'E_KEY', status: 'unknown', reason: 'check returned no status' },
      { key: 'F_KEY', status: 'invalid', reason: 'rejected [SECRET]' },
      { key: 'G_KEY', status: 'unknown', reason: 'check returned no status' },
    ]);
    expect(r.state('B_KEY')?.retryInSeconds).toBe(2);
    expect(stderrText()).not.toMatch(/value-[a-g]-0123456789/);
  });

  it('ctx.http is a working client: a real 401 reads invalid, a 200 valid', async () => {
    server = createServer((req, res) => {
      const ok = req.headers.authorization === `Bearer ${SECRET_A}`;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'bad token' }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const check: CredentialCheck = async (value, { http, signal }) => {
      await http({ baseURL: `http://127.0.0.1:${port}`, auth: { type: 'bearer', token: value } }).get('/me', {
        signal,
      });
      return 'valid';
    };
    const e = env([{ key: 'API_KEY', multi: true, secret: true, check }], { API_KEY: SECRET_A, API_KEY_1: SECRET_B });
    const r = new CredentialRegistry();
    await runCredentialChecks(e, r);
    expect(r.status('API_KEY')).toBe('valid');
    expect(r.status('API_KEY_1')).toBe('invalid');
    expect(stderrText()).not.toContain(SECRET_B);
  });
});

describe('runCredentialChecks: re-checks and limits', () => {
  it('attaches each check as the key re-check: an invalid key is restored once the provider accepts it', async () => {
    let accept = false;
    const check: CredentialCheck = async () => (accept ? 'valid' : { status: 'invalid', reason: 'auth rejected' });
    const e = env([{ key: 'A_KEY', secret: true, check }], { A_KEY: SECRET_A, MCP_CREDENTIAL_RECHECK_MS: '1' });
    const r = new CredentialRegistry();
    await runCredentialChecks(e, r);
    expect(r.status('A_KEY')).toBe('invalid');
    accept = true;
    expect(await r.recheck('A_KEY')).toBe('valid');
    expect(stderrText()).toContain('Credential A_KEY: invalid -> valid');
  });

  it('reads MCP_CREDENTIAL_RECHECK_MS into the registry cool-down (the option wins)', async () => {
    const check = jest.fn<CredentialCheck>(async () => 'invalid');
    const e = env([{ key: 'A_KEY', secret: true, check }], { A_KEY: SECRET_A, MCP_CREDENTIAL_RECHECK_MS: '600000' });
    const r = new CredentialRegistry();
    const spy = jest.spyOn(r, 'setRecheckMs');
    await runCredentialChecks(e, r);
    expect(spy).toHaveBeenCalledWith(600000);
    await runCredentialChecks(e, r, { recheckMs: 7 });
    expect(spy).toHaveBeenLastCalledWith(7);
  });

  it('runs at most `concurrency` checks at once (default 4)', async () => {
    let running = 0;
    let peak = 0;
    const check: CredentialCheck = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
      return 'valid';
    };
    const vars: Record<string, string> = { POOL_KEY: SECRET_A };
    for (let i = 1; i <= 9; i++) vars[`POOL_KEY_${i}`] = `pool-value-${i}-0123456789`;
    const e = env([{ key: 'POOL_KEY', multi: true, secret: true, check }], vars);
    const results = await runCredentialChecks(e, new CredentialRegistry());
    expect(results).toHaveLength(10);
    expect(peak).toBe(4);
    peak = 0;
    await runCredentialChecks(e, new CredentialRegistry(), { concurrency: 2 });
    expect(peak).toBe(2);
  });

  it('a check without secret: true is still masked (a check implies a secret)', async () => {
    const e = env([{ key: 'NOT_FLAGGED', check: async (value) => ({ status: 'invalid', reason: `bad ${value}` }) }], {
      NOT_FLAGGED: SECRET_C,
    });
    const r = new CredentialRegistry();
    await runCredentialChecks(e, r);
    expect(r.state('NOT_FLAGGED')?.reason).toBe('bad [SECRET]');
    expect(stderrText()).not.toContain(SECRET_C);
  });
});

describe('multi-part credentials: ctx.get reads declared sibling keys', () => {
  it('a check probes with its siblings (client id + secret + user + password), values never logged', async () => {
    const seen: Array<string | undefined> = [];
    const schema: EnvSchema = [
      {
        key: 'CONTABO_CLIENT_ID',
        secret: true,
        check: async (value, ctx) => {
          seen.push(
            value,
            ctx.get('CONTABO_CLIENT_SECRET'),
            ctx.get('CONTABO_API_USER'),
            ctx.get('CONTABO_API_PASSWORD'),
          );
          return ctx.get('CONTABO_API_PASSWORD') === 'password-0123456789'
            ? 'valid'
            : { status: 'invalid', reason: 'CONTABO_API_PASSWORD rejected' };
        },
      },
      { key: 'CONTABO_CLIENT_SECRET', secret: true },
      { key: 'CONTABO_API_USER' },
      { key: 'CONTABO_API_PASSWORD', secret: true },
    ];
    const vars = {
      CONTABO_CLIENT_ID: 'client-id-0123456789',
      CONTABO_CLIENT_SECRET: 'client-secret-0123456789',
      CONTABO_API_USER: 'ops@example.test',
      CONTABO_API_PASSWORD: 'password-0123456789',
    };
    const r = new CredentialRegistry();
    await runCredentialChecks(env(schema, vars), r);
    expect(seen).toEqual(Object.values(vars));
    expect(r.status('CONTABO_CLIENT_ID')).toBe('valid');
    await runCredentialChecks(env(schema, { ...vars, CONTABO_API_PASSWORD: 'wrong-password-0123456789' }), r);
    expect(r.state('CONTABO_CLIENT_ID')).toMatchObject({ status: 'invalid', reason: 'CONTABO_API_PASSWORD rejected' });
    const out = stderrText();
    for (const value of [...Object.values(vars), 'wrong-password-0123456789']) expect(out).not.toContain(value);
  });

  it('covers: the check status, reason and later runtime outcomes apply to every covered part', async () => {
    const schema: EnvSchema = [
      {
        key: 'TRELLO_API_KEY',
        secret: true,
        covers: ['TRELLO_TOKEN', 'NOT_DECLARED'],
        check: async (_value, ctx) =>
          ctx.get('TRELLO_TOKEN') === 'token-0123456789'
            ? 'valid'
            : { status: 'invalid', reason: 'TRELLO_TOKEN rejected' },
      },
      { key: 'TRELLO_TOKEN', secret: true },
    ];
    const vars = { TRELLO_API_KEY: 'key-0123456789', TRELLO_TOKEN: 'token-0123456789' };
    const r = new CredentialRegistry();
    await runCredentialChecks(env(schema, vars), r);
    expect(r.status('TRELLO_API_KEY')).toBe('valid');
    expect(r.status('TRELLO_TOKEN')).toBe('valid');
    r.record('TRELLO_API_KEY', 'degraded', { reason: 'quota', retryAfterMs: 1000 });
    expect(r.state('TRELLO_TOKEN')).toMatchObject({ status: 'degraded', reason: 'quota' });
    const bad = new CredentialRegistry();
    await runCredentialChecks(env(schema, { ...vars, TRELLO_TOKEN: 'wrong-token-0123456789' }), bad);
    expect(bad.state('TRELLO_API_KEY')).toMatchObject({ status: 'invalid', reason: 'TRELLO_TOKEN rejected' });
    expect(bad.state('TRELLO_TOKEN')).toMatchObject({ status: 'invalid', reason: 'TRELLO_TOKEN rejected' });
    expect(stderrText()).not.toContain('token-0123456789');
  });

  it('covers: a re-check moves the covered part too, and a part that is not covered stays unknown', async () => {
    let answer: 'invalid' | 'valid' = 'invalid';
    const schema: EnvSchema = [
      { key: 'NEXUS_USERNAME', secret: true, covers: ['NEXUS_PASSWORD'], check: async () => answer },
      { key: 'NEXUS_PASSWORD', secret: true },
      { key: 'NEXUS_OTHER', secret: true },
    ];
    const r = new CredentialRegistry();
    await runCredentialChecks(
      env(schema, { NEXUS_USERNAME: 'user-0123456789', NEXUS_PASSWORD: 'pw-0123456789', NEXUS_OTHER: 'o-0123456789' }),
      r,
    );
    expect(r.status('NEXUS_PASSWORD')).toBe('invalid');
    expect(r.status('NEXUS_OTHER')).toBe('unknown');
    answer = 'valid';
    await r.recheck('NEXUS_USERNAME');
    expect(r.status('NEXUS_PASSWORD')).toBe('valid');
  });

  it('ctx.get refuses an undeclared key (the check reads unknown, nothing leaks)', async () => {
    const schema: EnvSchema = [
      {
        key: 'GODADDY_API_KEY',
        secret: true,
        check: async (_value, ctx) => (ctx.get('PATH') ? 'valid' : 'invalid'),
      },
    ];
    const r = new CredentialRegistry();
    const results = await runCredentialChecks(env(schema, { GODADDY_API_KEY: SECRET_A, PATH: 'not-declared' }), r);
    expect(results).toEqual([{ key: 'GODADDY_API_KEY', status: 'unknown', reason: 'check failed' }]);
  });
});
