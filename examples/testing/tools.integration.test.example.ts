/**
 * Example INTEGRATION suite for an MCP server built on @novorb/mcp-core.
 *
 * Copy to `tests/integration/tools.integration.test.ts` in your server and edit ONLY the
 * "SERVER UNDER TEST" block and the case table. The suite starts the BUILT server (`node dist/index.js`)
 * as a child process, in stdio AND http mode, with an explicit env and per-run temp dirs, and drives it
 * with the real v2 client. No mocks: real server process, real downstream API, real client.
 *
 * Gating (environment of the test run, never of the server):
 *   MCP_IT_TARGET=test|live   default test. LIVE runs read cases only; write/destructive need TEST.
 *   MCP_IT_ALLOW_COSTLY=true  costly cases (they spend quota or money) run only with this opt-in.
 * A case whose credentials are absent is skipped with a printed `[SKIP]` line: a skipped case protects
 * nothing, so read the skip list in the output.
 *
 * mcp-core runs this exact file against its own echo fixture, so it cannot drift from the harness.
 * Jest is used here (`@jest/globals`); the harness itself is runner-agnostic, so vitest works the same.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  assertToolCoverage,
  type BuiltServer,
  callToolJson,
  collectStrings,
  createIsolatedDirs,
  expectSchemaRejection,
  expectToolError,
  expectUnknownTool,
  findLeaks,
  type HarnessMode,
  type IsolatedDirs,
  initializeRequestBody,
  listToolNames,
  logLevels,
  mcpPostHeaders,
  rawHttp,
  readLogFiles,
  type StartBuiltServerOptions,
  startBuiltServer,
  type ToolJsonResult,
} from '@novorb/mcp-core/testing';

// ---- SERVER UNDER TEST -----------------------------------------------------------------------------
/** The name your server passes to initLogger (the main log file is `<name>.log`). */
const SERVER_NAME = 'echo-fixture';
/** Text of the INFO line your server logs at startup. */
const STARTUP_LINE = 'echo-fixture started';
/** Your built entry: `fileURLToPath(new URL('../../dist/index.js', import.meta.url))`. */
const ENTRY = fileURLToPath(new URL('../../tests/fixtures/echo-server.ts', import.meta.url));
/** Node arguments before the entry: `[]` for a built `dist/index.js` (the fixture is TypeScript). */
const NODE_ARGS = ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href];
/**
 * EVERY provider/credential variable the server reads, '' when not supplied, so a developer `.env` or a
 * dotenv load can never fill a gap. Use exactly the names your credentials spec gives the operator.
 */
const CREDENTIALS: Record<string, string> = { ECHO_UPSTREAM_TOKEN: process.env.ECHO_UPSTREAM_TOKEN ?? '' };
/** A deliberately wrong credential set, for the "downstream auth error surfaces as an error" case. */
const WRONG_CREDENTIALS: Record<string, string> = { ECHO_UPSTREAM_TOKEN: 'bad-token-mcpit-adverse' };
/** Extra per-run dirs the server needs, by env var name (DATA_PATH is mcp-core's data store directory). */
const stateEnv = (dirs: IsolatedDirs): Record<string, string> => ({ DATA_PATH: dirs.state });
// ---------------------------------------------------------------------------------------------------

const TARGET = process.env.MCP_IT_TARGET === 'live' ? 'live' : 'test';
const ALLOW_COSTLY = process.env.MCP_IT_ALLOW_COSTLY === 'true';
const RUN_ID = `mcpit-${Date.now().toString(36)}`;
/** A PII fixture sent as an argument value: it must never reach a log file unmasked. */
const PII_EMAIL = 'mcpit.person@example.com';

type Kind = 'read' | 'write' | 'destructive' | 'costly';

/** Everything a case touches, so the log assertions can scan for it afterwards. */
interface RunContext {
  client: BuiltServer['client'];
  /** Every string VALUE sent as a tool argument. */
  sent: string[];
  /** Every result text received. */
  received: string[];
  /** Tools called at least once. */
  called: Set<string>;
}

async function call<T = unknown>(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolJsonResult<T>> {
  collectStrings(args, ctx.sent);
  ctx.called.add(name);
  const result = await callToolJson<T>(ctx.client, name, args);
  if (result.text) ctx.received.push(result.text);
  return result;
}

interface Case {
  tool: string;
  kind: Kind;
  /** Credential variables the case needs (skipped with [SKIP] when any is empty). */
  needs?: string[];
  run(ctx: RunContext): Promise<void>;
}

/** One case per registered tool, real call, assert the real response shape and a meaningful value. */
const CASES: Case[] = [
  {
    tool: 'echo',
    kind: 'read',
    run: async (ctx) => {
      const r = await call(ctx, 'echo', { text: `${RUN_ID} ${PII_EMAIL}` });
      expect(r.isError).toBe(false);
      expect(r.text).toBe(`echo: ${RUN_ID} ${PII_EMAIL}`);
    },
  },
  {
    tool: 'echo_json',
    kind: 'read',
    run: async (ctx) => {
      const r = await call<{ text: string; length: number }>(ctx, 'echo_json', { text: `${RUN_ID}-json` });
      expect(r.body).toEqual({ text: `${RUN_ID}-json`, length: `${RUN_ID}-json`.length });
    },
  },
  {
    tool: 'boom',
    kind: 'read',
    // Pins the CURRENT error envelope: a tool-level failure is `isError: true`, not a thrown error.
    run: async (ctx) => {
      expectToolError(await call(ctx, 'boom'), 'boom: failed');
    },
  },
  {
    tool: 'upstream_status',
    kind: 'read',
    needs: ['ECHO_UPSTREAM_TOKEN'],
    run: async (ctx) => {
      expect((await call(ctx, 'upstream_status')).body).toEqual({ authenticated: true });
    },
  },
  {
    tool: 'paid_lookup',
    kind: 'costly',
    run: async (ctx) => {
      expect((await call(ctx, 'paid_lookup', { query: RUN_ID })).body).toEqual({ query: RUN_ID, charged: 1 });
    },
  },
  {
    tool: 'note_create',
    kind: 'write',
    // Writes create their own uniquely named objects and clean them up.
    run: async (ctx) => {
      const name = `${RUN_ID}-create`;
      expect((await call(ctx, 'note_create', { name, body: `${RUN_ID} body` })).body).toEqual({ name, created: true });
      expect((await call(ctx, 'note_delete', { name })).isError).toBe(false);
    },
  },
  {
    tool: 'note_list',
    kind: 'read',
    run: async (ctx) => {
      const r = await call<{ names: string[] }>(ctx, 'note_list', { prefix: `${RUN_ID}-none` });
      expect(r.body).toEqual({ names: [] });
    },
  },
  {
    tool: 'note_delete',
    kind: 'destructive',
    // Destructive tools only act on objects the test created.
    run: async (ctx) => {
      const name = `${RUN_ID}-delete`;
      await call(ctx, 'note_create', { name, body: 'to delete' });
      expect((await call(ctx, 'note_delete', { name })).body).toEqual({ name, deleted: true });
      const after = await call<{ names: string[] }>(ctx, 'note_list', { prefix: name });
      expect(after.body).toEqual({ names: [] });
    },
  },
];

function skipReason(c: Case): string | undefined {
  if (c.kind === 'costly' && !ALLOW_COSTLY) return 'costly; set MCP_IT_ALLOW_COSTLY=true to run it';
  if ((c.kind === 'write' || c.kind === 'destructive' || c.kind === 'costly') && TARGET === 'live') {
    return `${c.kind} cases run only with MCP_IT_TARGET=test`;
  }
  const missing = (c.needs ?? []).filter((v) => !CREDENTIALS[v]);
  if (missing.length > 0) return `missing credential ${missing.join(', ')}`;
  return undefined;
}

function serverOptions(
  mode: HarnessMode,
  dirs: IsolatedDirs,
  extra: Record<string, string> = {},
): StartBuiltServerOptions {
  return {
    entry: ENTRY,
    nodeArgs: NODE_ARGS,
    mode,
    cwd: dirs.cwd,
    env: { ...dirs.env(), ...stateEnv(dirs), ...CREDENTIALS, LOG_LEVEL: 'DEBUG', LOG_CONSOLE: 'false', ...extra },
    // MCP_ENV_FILE=none: the server's env loader never reads a developer `.env`.
    envFile: 'none',
  };
}

describe.each<HarnessMode>(['stdio', 'http'])('tools over %s (integration)', (mode) => {
  let dirs: IsolatedDirs;
  let srv: BuiltServer;
  let ctx: RunContext;

  beforeAll(async () => {
    dirs = createIsolatedDirs(`mcpit-${mode}`);
    srv = await startBuiltServer(serverOptions(mode, dirs));
    ctx = { client: srv.client, sent: [], received: [], called: new Set() };
  });

  afterAll(async () => {
    // Prefix sweep: remove anything this run created that a failed case left behind (TEST only).
    if (srv && TARGET === 'test') {
      try {
        const left = await callToolJson<{ names: string[] }>(srv.client, 'note_list', { prefix: RUN_ID });
        for (const name of left.body?.names ?? []) await callToolJson(srv.client, 'note_delete', { name });
      } catch {
        // the server may already be stopped by the log test
      }
    }
    await srv?.stop();
    dirs?.cleanup();
  });

  it('has exactly one case per registered tool (both directions)', async () => {
    assertToolCoverage(
      await listToolNames(srv.client),
      CASES.map((c) => c.tool),
    );
  });

  for (const c of CASES) {
    const reason = skipReason(c);
    if (reason) console.log(`[SKIP] ${mode} ${c.tool}: ${reason} (a skipped case protects nothing)`);
    (reason ? it.skip : it)(`${c.tool} (${c.kind})`, async () => {
      await c.run(ctx);
    });
  }

  it('adverse: invalid arguments are rejected by the schema', async () => {
    ctx.called.add('echo');
    await expectSchemaRejection(srv.client, 'echo', { text: 42 });
    await expectSchemaRejection(srv.client, 'note_delete', { name: '../../etc' });
  });

  it('adverse: an unknown tool is refused', async () => {
    const refused = await expectUnknownTool(srv.client, `${RUN_ID}_no_such_tool`);
    expect(refused.via).toBe('protocol-error');
  });

  it('adverse: a not-found id is an error result', async () => {
    expectToolError(await call(ctx, 'note_delete', { name: `${RUN_ID}-missing` }), 'note not found');
  });

  it('adverse: a wrong credential surfaces the downstream auth error as an error result', async () => {
    const wrongDirs = createIsolatedDirs(`mcpit-${mode}-wrong`);
    const wrong = await startBuiltServer(serverOptions(mode, wrongDirs, WRONG_CREDENTIALS));
    try {
      const r = await callToolJson(wrong.client, 'upstream_status');
      expectToolError(r, /401/);
    } finally {
      await wrong.stop();
      wrongDirs.cleanup();
    }
  });

  if (mode === 'http') {
    it('adverse http: 401 without the key, 413 oversized body, 415 wrong content type', async () => {
      const url = srv.url ?? '';
      expect((await rawHttp(url, { headers: mcpPostHeaders(), body: initializeRequestBody() })).status).toBe(401);
      const big = await rawHttp(url, { headers: mcpPostHeaders(srv.apiKey), body: 'x'.repeat(5 * 1024 * 1024) });
      expect(big.status).toBe(413);
      const wrongType = { ...mcpPostHeaders(srv.apiKey), 'content-type': 'text/plain' };
      expect((await rawHttp(url, { headers: wrongType, body: initializeRequestBody() })).status).toBe(415);
    });
  }

  it('logs: startup + per-tool lines in the main log, level-pure side files, no leaked values', async () => {
    await srv.stop();
    const logs = readLogFiles(dirs.logs, SERVER_NAME);
    expect(logs.main).toContain(STARTUP_LINE);
    for (const tool of ctx.called) {
      expect(logs.main).toContain(`Tool call: ${tool}`);
      expect(logs.main).toContain(`Tool result: ${tool}`);
    }
    expect(logLevels(logs.exceptions).length).toBeGreaterThan(0);
    expect(new Set(logLevels(logs.exceptions))).toEqual(new Set(['ERROR']));
    expect(new Set(logLevels(logs.debug))).toEqual(new Set(['DEBUG']));
    const needles = [...Object.values(CREDENTIALS), srv.apiKey ?? '', ...ctx.sent, ...ctx.received, PII_EMAIL];
    const leaks = findLeaks([logs.main, logs.exceptions, logs.debug, srv.stdout()], needles);
    expect(leaks).toEqual([]);
  });
});

describe('log switches (integration)', () => {
  it('a sink switched off writes no file', async () => {
    const dirs = createIsolatedDirs('mcpit-switch');
    const srv = await startBuiltServer(serverOptions('stdio', dirs, { LOG_FILE_DEBUG: 'false' }));
    try {
      await callToolJson(srv.client, 'echo', { text: RUN_ID });
    } finally {
      await srv.stop();
    }
    const logs = readLogFiles(dirs.logs, SERVER_NAME);
    expect(logs.exists).toEqual({ main: true, exceptions: false, debug: false });
    dirs.cleanup();
  });
});
