# Testing your server

## Testing harness (`@novorb/mcp-core/testing`)

A separate subpath for consumer test suites. Nothing in the runtime entry points imports it. It uses
`@modelcontextprotocol/client`, now a regular dependency of mcp-core: consumers need no SDK package of
their own and import client symbols from `@novorb/mcp-core/sdk/client` (drop a direct
`@modelcontextprotocol/client` devDependency when migrating). It is test-runner agnostic: helpers
return objects and throw `Error`s, nothing imports jest or vitest. Pure Node, Windows-safe (no shell,
`node` spawned directly via `process.execPath`, kill-and-await teardown).

Two example suites ship in the package under `examples/testing/` (in `files`), and mcp-core runs both
against its own echo fixture in its own test run, so they cannot rot:

- `tools.unit.test.example.ts`: in-process unit suite (case table over the in-memory client, coverage
  assertion, schema rejection, unknown tool, not-found, recording-server handler calls).
- `tools.integration.test.example.ts`: integration suite over the BUILT server, `describe.each` over
  stdio and http, TEST vs LIVE gating with `[SKIP]`, costly opt-in, create-then-cleanup with a prefix
  sweep, log-file assertions and the adverse cases (invalid args, unknown tool, not-found, wrong
  credential, 401, 413, 415).

Copy one to your server's `tests/` (drop `.example`), edit its "SERVER UNDER TEST" block and its case
table.

### Integration API

| Function | Returns | Notes |
|---|---|---|
| `startBuiltServer({ entry, mode, env?, cwd?, apiKey?, readyTimeoutMs?, inheritEnv?, nodeArgs?, port?, envFile?, era?, clientInfo?, clientOptions? })` | `{ client, mode, url?, baseUrl?, apiKey?, env, pid?, stderr(), stdout(), stop() }` | Spawns `node [nodeArgs] <entry>`. The child env is EXPLICIT: the SDK's minimal OS list (PATH, SystemRoot, TEMP, ...), then `env`, then the harness vars (`inheritEnv: true` passes the parent env instead). http sets `MCP_TRANSPORT=http`, `MCP_HTTP_HOST=127.0.0.1`, a free `PORT`, `MCP_API_KEY` (= `apiKey`, else `env.MCP_API_KEY`, else random hex; `apiKey: null` starts open with `MCP_AUTH_DISABLED=true`), polls `GET /health` (no fixed sleeps), connects `StreamableHTTPClientTransport` with the Bearer header. stdio uses `StdioClientTransport`. `envFile` sets `MCP_ENV_FILE` for servers that load env through mcp-core's env loader. Startup failures throw with the child's stderr tail. `stop()` closes the client and kills and awaits the child; idempotent, never throws |
| `createIsolatedDirs(prefix?)` | `{ root, cwd, home, logs, state, tmp, dir(name), env(), cleanup() }` | One temp root; `env()` gives HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_*, TMPDIR/TEMP/TMP, LOG_PATH. `cleanup()` retries on Windows locks, idempotent |
| `readLogFiles(logDir, serverName, { mainFile? })` | `{ main, exceptions, debug, exists, paths }` | `<name>.log` (sanitised like the logger), `exceptions.log`, `debug.log`; absent = `''` + `exists: false` |
| `logLevels(text)` | `string[]` | Level of each line, text or JSON format (`UNKNOWN` otherwise) |
| `findLeaks(texts, needles, { minLength? })` | `Array<{ index, preview, foundIn }>` | Needles found verbatim; the preview is masked (`ab***(len=12)`), never the value. Needles under 6 chars (`MIN_LEAK_NEEDLE_LENGTH`) and duplicates are ignored |
| `collectStrings(value)` | `string[]` | Every nested string value (tool arguments as leak needles) |
| `callToolJson(client, name, args?)` | `{ isError, body, text, raw }` | `body` = `structuredContent`, else the first text block parsed as JSON, else that text |
| `listToolNames(client)` | `string[]` | All pages |
| `captureToolWire(client)` | `ToolWire[]` | Every `tools/list` page reduced to name, title, description, inputSchema, outputSchema, annotations, execution; sorted by name; plain JSON for fixture snapshots |
| `toolCoverage(actual, cases)` / `assertToolCoverage(actual, cases)` | `{ missing, stale, duplicates, ok }` | The assert form throws listing tools without a case and stale cases |
| `rawHttp(url, { method?, headers?, body?, timeoutMs? })` | `{ status, headers, text }` | For 401/404/413/415 checks; `mcpPostHeaders(apiKey?)` and `initializeRequestBody()` build a valid POST |

### Unit API

| Function | Returns | Notes |
|---|---|---|
| `connectInMemory(factory, { era?, onServerError? })` | `{ client, close() }` | SDK in-memory transport pair; the server side is the SDK's `serveStdio` connection owner, so both protocol eras work |
| `withInMemoryClient(factory, fn)` / `callToolInMemory(factory, name, args?)` | `fn`'s result / `ToolJsonResult` | Connect, run, always close |
| `captureToolCall(client, name, args?)` | `{ kind: 'result', result }` or `{ kind: 'protocol-error', code, message }` | A thrown protocol error as data |
| `expectToolSuccess(result)` / `expectToolError(result, pattern?)` | body / error text | Throw on the wrong outcome |
| `expectSchemaRejection(client, name, args)` | `{ via, message }` | McpServer answers bad args with an isError `Input validation error:` result; an InvalidParams (-32602) protocol error also counts |
| `expectUnknownTool(client, name)` | `{ via, message }` | McpServer throws -32602 `Tool <name> not found`; an isError "unknown/not found" result also counts |
| `makeRecordingServer()` | `{ tools, prompts, asMcpServer() }` | Records `registerTool` / `registerPrompt` so handlers can be called directly (no protocol, no schema validation) |
| `createTestClient({ era?, clientInfo?, clientOptions? })` | `Client` | `era: 'modern'` negotiates 2026-07-28 |

### Example: a consumer per-tool integration suite over both modes

```typescript
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  assertToolCoverage, type BuiltServer, callToolJson, collectStrings, createIsolatedDirs, expectSchemaRejection,
  expectToolError, expectUnknownTool, findLeaks, type HarnessMode, type IsolatedDirs, initializeRequestBody,
  listToolNames, logLevels, mcpPostHeaders, rawHttp, readLogFiles, startBuiltServer,
} from '@novorb/mcp-core/testing';

const ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const CREDS = { MY_API_TOKEN: process.env.MY_API_TOKEN ?? '' }; // every provider var, '' when absent
const RUN_ID = `mcpit-${Date.now().toString(36)}`;

describe.each<HarnessMode>(['stdio', 'http'])('my-mcp over %s', (mode) => {
  let dirs: IsolatedDirs;
  let srv: BuiltServer;
  const sent: string[] = [];

  beforeAll(async () => {
    dirs = createIsolatedDirs(`my-mcp-${mode}`);
    srv = await startBuiltServer({
      entry: ENTRY, mode, cwd: dirs.cwd, envFile: 'none',
      env: { ...dirs.env(), ...CREDS, DATA_PATH: dirs.state, LOG_LEVEL: 'DEBUG', LOG_CONSOLE: 'false' },
    });
  });
  afterAll(async () => { await srv?.stop(); dirs?.cleanup(); });

  const cases: Record<string, () => Promise<void>> = {
    my_lookup: async () => {
      const args = { key: `${RUN_ID}-k` };
      collectStrings(args, sent);
      const r = await callToolJson<{ found: boolean }>(srv.client, 'my_lookup', args);
      expect(r.isError).toBe(false);
      expect(r.body.found).toBe(false);
    },
  };

  it('one case per tool', async () => {
    assertToolCoverage(await listToolNames(srv.client), Object.keys(cases));
  });
  for (const [tool, run] of Object.entries(cases)) it(tool, run);

  it('adverse', async () => {
    await expectSchemaRejection(srv.client, 'my_lookup', { key: 42 });
    await expectUnknownTool(srv.client, 'no_such_tool');
    if (mode === 'http' && srv.url) {
      expect((await rawHttp(srv.url, { headers: mcpPostHeaders(), body: initializeRequestBody() })).status).toBe(401);
      const big = await rawHttp(srv.url, { headers: mcpPostHeaders(srv.apiKey), body: 'x'.repeat(5 * 1024 * 1024) });
      expect(big.status).toBe(413);
    }
  });

  it('logs', async () => {
    await srv.stop();
    const logs = readLogFiles(dirs.logs, 'my-mcp');
    expect(logs.main).toContain('Tool call: my_lookup');
    expect(new Set(logLevels(logs.debug))).toEqual(new Set(['DEBUG']));
    expect(findLeaks([logs.main, logs.exceptions, logs.debug], [...Object.values(CREDS), srv.apiKey ?? '', ...sent])).toEqual([]);
  });
});
```

The full version (gating, `[SKIP]`, create-then-cleanup, wrong credential, 415, switched-off sinks) is
`examples/testing/tools.integration.test.example.ts`.

## `mcp-core-jest` for consumers

ESM jest suites need node started with `--experimental-vm-modules`; the usual
`NODE_OPTIONS=... jest` script is POSIX-only. mcp-core ships a bin that does it portably:

```json
{
  "scripts": {
    "test:unit": "mcp-core-jest tests/unit",
    "test:integration": "mcp-core-jest tests/integration --runInBand --coverage=false"
  },
  "devDependencies": { "jest": "^30.3.0", "ts-jest": "^29.4.9" }
}
```

It resolves the CONSUMER's own jest from the current directory (walking up, so a hoisted jest works),
passes every argument through unchanged, exits with jest's exit code, forwards SIGINT/SIGTERM/SIGHUP
to jest and ends with the signal that ended jest. mcp-core has no runtime dependency on jest: jest stays
the consumer's devDependency (without one the bin exits 1 with a message).
