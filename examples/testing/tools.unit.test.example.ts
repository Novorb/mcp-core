/**
 * Example UNIT suite for an MCP server built on @novorb/mcp-core.
 *
 * Copy to `tests/unit/tools.unit.test.ts` in your server and edit ONLY the "SERVER UNDER TEST" block.
 * Everything runs in process: the real server factory over the SDK's in-memory transport (no child
 * process, no network), plus direct handler calls through a recording server. Unit tests MAY mock
 * your downstream clients; the integration example must not.
 *
 * mcp-core runs this exact file against its own echo fixture, so it cannot drift from the harness.
 * Jest is used here (`@jest/globals`); the harness itself is runner-agnostic, so vitest works the same.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { McpServer } from '@novorb/mcp-core/server';
import {
  assertToolCoverage,
  callToolInMemory,
  callToolJson,
  connectInMemory,
  expectSchemaRejection,
  expectToolError,
  expectToolSuccess,
  expectUnknownTool,
  type InMemoryConnection,
  listToolNames,
  makeRecordingServer,
  withInMemoryClient,
} from '@novorb/mcp-core/testing';

// ---- SERVER UNDER TEST: replace with your server's factory and register function -----------------
import { buildEchoServer, registerEchoTools } from '../../tests/fixtures/echo-tools.js';

const buildServer: () => McpServer = buildEchoServer;
const registerTools: (server: McpServer) => void = registerEchoTools;
// ---------------------------------------------------------------------------------------------------

const RUN_ID = `mcpunit-${Date.now().toString(36)}`;

/** One case per registered tool: call it in memory and assert a meaningful value, not just "no error". */
interface UnitCase {
  tool: string;
  args: Record<string, unknown>;
  check(body: unknown, text: string): void;
}

const CASES: UnitCase[] = [
  { tool: 'echo', args: { text: 'hello' }, check: (_b, text) => expect(text).toBe('echo: hello') },
  {
    tool: 'echo_json',
    args: { text: 'abcd' },
    check: (body) => expect(body).toEqual({ text: 'abcd', length: 4 }),
  },
  { tool: 'boom', args: {}, check: (_b, text) => expect(text).toBe('boom: failed') },
  { tool: 'upstream_status', args: {}, check: (_b, text) => expect(text).toMatch(/authenticated|401/) },
  { tool: 'paid_lookup', args: { query: 'q' }, check: (body) => expect(body).toEqual({ query: 'q', charged: 1 }) },
  {
    tool: 'note_create',
    args: { name: `${RUN_ID}-a`, body: 'note body' },
    check: (body) => expect(body).toEqual({ name: `${RUN_ID}-a`, created: true }),
  },
  {
    tool: 'note_list',
    args: { prefix: RUN_ID },
    check: (body) => expect((body as { names: string[] }).names).toContain(`${RUN_ID}-a`),
  },
  {
    tool: 'note_delete',
    args: { name: `${RUN_ID}-a` },
    check: (body) => expect(body).toEqual({ name: `${RUN_ID}-a`, deleted: true }),
  },
];

describe('tools (unit, in memory)', () => {
  // One connection for the ordered cases (create -> list -> delete share the server's state).
  let conn: InMemoryConnection;

  beforeAll(async () => {
    conn = await connectInMemory(buildServer);
  });

  afterAll(async () => {
    await conn?.close();
  });

  it('has exactly one case per registered tool (both directions)', async () => {
    const names = await listToolNames(conn.client);
    expect(
      assertToolCoverage(
        names,
        CASES.map((c) => c.tool),
      ).ok,
    ).toBe(true);
  });

  it.each(CASES.map((c) => [c.tool, c] as const))('%s', async (_name, c) => {
    const result = await callToolJson(conn.client, c.tool, c.args);
    c.check(result.body, result.text);
  });
});

describe('tools (unit, adverse)', () => {
  it('a one-shot call decodes success and error results', async () => {
    const ok = await callToolInMemory<{ text: string; length: number }>(buildServer, 'echo_json', { text: 'xy' });
    expect(expectToolSuccess(ok)).toEqual({ text: 'xy', length: 2 });
    const failed = await callToolInMemory(buildServer, 'boom');
    expect(expectToolError(failed, /failed/)).toBe('boom: failed');
  });

  it('rejects arguments that break the input schema', async () => {
    await withInMemoryClient(buildServer, async (client) => {
      const wrongType = await expectSchemaRejection(client, 'echo', { text: 5 });
      expect(wrongType.message).toMatch(/Input validation error/);
      await expectSchemaRejection(client, 'echo', {});
      await expectSchemaRejection(client, 'note_create', { name: '../escape', body: 'x' });
    });
  });

  it('refuses an unknown tool', async () => {
    await withInMemoryClient(buildServer, async (client) => {
      const refused = await expectUnknownTool(client, 'no_such_tool');
      expect(refused).toEqual({ via: 'protocol-error', message: expect.stringMatching(/not found/) });
    });
  });

  it('answers a not-found id with an error result', async () => {
    const missing = await callToolInMemory(buildServer, 'note_delete', { name: `${RUN_ID}-missing` });
    expectToolError(missing, 'note not found');
  });
});

describe('tools (unit, recording server: handlers called directly)', () => {
  const rec = makeRecordingServer();
  registerTools(rec.asMcpServer());

  it('registers every tool with a description and an input schema', () => {
    expect([...rec.tools.keys()].sort()).toEqual(CASES.map((c) => c.tool).sort());
    for (const tool of rec.tools.values()) {
      expect(typeof tool.config.description).toBe('string');
      expect(tool.config.inputSchema).toBeDefined();
    }
  });

  it('invokes a handler without the protocol (no schema validation on this path)', async () => {
    const echo = rec.tools.get('echo');
    if (!echo) throw new Error('echo was not registered');
    const result = await echo.handler({ text: 'direct' });
    expect(result.content).toEqual([{ type: 'text', text: 'echo: direct' }]);
  });
});
