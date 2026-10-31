# Testing

## Commands

```bash
pnpm test            # all suites, including examples/testing/*.example.ts against the echo fixture
pnpm run test:watch  # watch mode
pnpm run test:coverage
pnpm run docs:check  # documentation freshness
pnpm run qa:all      # full QA matrix
```

The scripts run jest through the package's own `mcp-core-jest` bin, so they work in PowerShell, cmd and
POSIX shells alike.

## Overview

mcp-core uses Jest with ESM support. Each source module has a corresponding test file:

| Source | Test | Focus |
|--------|------|-------|
| `src/utils/logger.ts` | `tests/utils/logger.test.ts` | every env switch + config override, level-to-file routing, file names, `.logs` / `LOG_PATH` / `LOG_FILE` resolution, the no-directory warning (never cwd), required `name`, reconfigure-in-place, per-file rotation + sink isolation, sync/async EPIPE, `captureProcessErrors` (re-entrancy, EPIPE no-loop), formats, masking end to end, tool-helper line text + levels, `summarizeArgs` carries no values, `packageRootFrom`. Asserts after EVERY test that stdout was never written |
| `src/utils/redact.ts` | `tests/utils/redact.test.ts` | **secret redaction** (every key rule, every query-param rule, `value`/`content` kept) and **PII masking** (every pattern positive, pinned negatives: timestamps, versions, plain integers, ...) |
| `src/http-client.ts` | `tests/http-client.test.ts` | against a real `node:http` server on 127.0.0.1 (no axios mock): the fail-closed route-template path logging (the review examples, tag names, variable keys and file names never in a log line or `HttpError.path`; client `routes`), the `credential` option recording (status-gated, undeclared names refused before sending), verbs, responseTypes, `validateStatus`, every auth strategy + masking, URL joining + origin guard, idempotent-only retry, Retry-After + cap, timeout, ECONNREFUSED, abort, no redirect follow, size caps, errors without response/config/headers, `mapError`, log meta, rate limit, `paginate` |
| `src/rate-limiter.ts` | `tests/rate-limiter.test.ts` | burst + refill (injected clock), FIFO waiting, aborted waiters |
| `src/transport.ts` | `tests/transport.test.ts` | stdio mode/options; **fail-closed** auth + **constant-time** Bearer compare; `createRequestHandler` routing (health/401/415/413/404/500 + /mcp dispatch); mocks `createMcpHandler` (the rest of `@modelcontextprotocol/server` is its real CommonJS build, loaded with `createRequire`), `@modelcontextprotocol/server/stdio` and `@modelcontextprotocol/node` |
| `src/transport.ts` | `tests/transport.roundtrip.test.ts` | real `@modelcontextprotocol/client` round-trips over stdio (child process) and HTTP, in both protocol eras; real Host/Origin allow-list semantics |
| `src/server.ts` | `tests/server.test.ts` | `createMcpServer` factory, `TOOL_ANNOTATIONS` presets, SDK re-exports, `completable` nesting pins |
| `src/tools.ts` | `tests/tools.test.ts` | `registerTools` over the real SDK in memory: listing, central call/result lines, SDK schema rejection + unknown tool, thrown errors / schema issues / `mapError`, legacy `{ success: false }` as isError, degraded mode, `enabled`/`prefix`, `ToolContext` (signal, cursor, authInfo, progress) |
| `src/bootstrap.ts` | `tests/bootstrap.test.ts` | `runMcpServer` in-process over HTTP: order + one started line after bind, shared state once across many requests, close/dispose order, signal close + exit, failed start disposes, `.env` loading, `readPackageInfo` |
| `src/credentials.ts` | `tests/credentials.test.ts` | registry: pools, rotation (valid, unknown, degraded, invalid/expired last), degraded back to unknown after the retry-after (injected clock), background re-check probes restoring invalid keys, undeclared names refused without echoing them, outcomes, transitions logged once, masked bounded reasons, snapshot; `credentialOutcomeFromHttp` (every status-gated mapping incl. plain 403 and 400/413/422 left alone, GitLab's expired token via `error_description` and the `WWW-Authenticate` parameters) and `credentialOutcomeFromError`; the call scope (report, `require`, `withFallback`, the AsyncLocalStorage scope) |
| `src/credential-checks.ts` | `tests/credential-checks.test.ts` | which env keys are credentials, multi members checked on their own in parallel, valid/invalid/degraded results, thrown `HttpError` classified, timeout -> unknown (signal aborted), the env timeout, `MCP_CREDENTIAL_CHECKS=false`, a real `ctx.http` probe, values never logged |
| `src/credential-report.ts`, `src/credential-status-tool.ts` | `tests/credential-report.test.ts`, `tests/tools.test.ts`, `tests/bootstrap.test.ts` | the output schema wrapper (strict schemas, async validators, own `credentials` field), the report in text + `_meta` + `structuredContent`, the all-invalid isError, automatic recording through the http-client inside a call, the server starting when every check fails, the status tool |
| `bin/mcp-core-jest.mjs` | `tests/jest-runner.test.ts` | the flag, argument passthrough, exit code, hoisted jest, missing jest; signal exit, SIGTERM forwarded, SIGINT not forwarded (POSIX only) |
| `src/utils/envLoader.ts` | `tests/utils/envLoader.test.ts` | precedence, `MCP_ENV_FILE` (relative/absolute/none/missing), multi ordering, validation by key, strict, `describe()` without values, unknown-key WARN, secrets masked in logs, rendered table / `.env.example` |
| `src/utils/dataStore.ts` | `tests/utils/dataStore.test.ts` | `renameWithRetry` (win32 EPERM/EACCES/EBUSY retried within the budget, other platforms and codes not), default/`DATA_PATH` dir, lazy creation, `DATA_STORAGE=false` writes nothing, in-memory cache, every traversal form (incl. Windows `..\`, drive letters, junction escape), `safeName`, download caps against a local server (`allowPrivate`), inline bytes when disabled, the SSRF guard on URL sources by default (private literal / name refused without connecting, a redirect hop re-validated, origins, content types) |
| `src/net.ts` | `tests/net.test.ts` (+ child `tests/fixtures/net-proxy-child.ts`, run with `node --import tsx`) | **SSRF guard**: every refused / allowed address range, the URL policy, the DNS seam, redirects refused / capped / re-validated / headers dropped across origins, size, time and abort (head and body), content types, https lookup, `createGuardedAgent`, and NODE_USE_ENV_PROXY + HTTP(S)_PROXY with a recording proxy (refused, the proxy sees nothing) |
| `src/url-path.ts` | `tests/url-path.test.ts`, `tests/tools.test.ts` | one-segment encoding, empty / `.` / `..` and every percent-encoded, overlong (`%c0%ae`) and NFKC unicode dot form, C0/C1 controls and U+2028/U+2029 raw and encoded, the message naming the argument and never the value; the isError through `registerTools` whatever `mapError` does |
| `src/retry.ts` | `tests/retry.test.ts` | pinned retryable statuses + network codes, full-jitter bounds, Retry-After seconds/date/cap, bounded attempts, abort |
| `src/pagination.ts` | `tests/pagination.test.ts` | page-number helpers, every strategy against recorded shapes + stop conditions, page/item caps, loop guard, cursors + bad-cursor errors, `pagedResultSchema` |
| `src/testing/server-process.ts` | `tests/testing/server-process.test.ts` | real stdio + http starts of the fixture in isolated dirs: explicit env (parent-only vars absent, `inheritEnv`), apiKey given / from env / random / `null` (open), 401/404/413 (custom and default cap)/415, stop idempotency, startup failures carrying stderr (exit, timeout, bad node flag), log files written by the real logger and scanned with `findLeaks`, a switched-off sink, `killAndWait`, `freePort`, `minimalOsEnv` |
| `src/testing/logs.ts` | `tests/testing/logs.test.ts` | `readLogFiles` with the real logger (routing, JSON format, absent files, `mainFile`), `logFileName`, `logLevels`, `findLeaks` (masking, min length, duplicates), `collectStrings` |
| `src/testing/tools.ts`, `src/testing/unit.ts` | `tests/testing/tools.test.ts` | `callToolJson` body decoding, `listToolNames`, coverage helpers, every unit helper, the pinned SDK v2 outcomes (schema rejection = isError result, unknown tool = thrown -32602), a low-level `Server` answering with protocol errors |
| `src/testing/{isolated-dirs,raw-http,recording-server,in-memory,client}.ts` | `tests/testing/harness-misc.test.ts` | temp-dir layout + env + cleanup, `rawHttp` against a local server, recording server, in-memory connect in both eras |
| `src/auth.ts`, `src/transport.ts` | `tests/transport.test.ts`, `tests/protocol-features.test.ts` | the SDK Bearer gate (401/403 challenge, `req.auth` placeholder, verifier, scopes), `requireScopes` end to end over HTTP in both eras |
| `src/express.ts` | `tests/express.test.ts` | a real Express app: round trip in both eras, app-level `express.json()`, health/401/403/405/413/415/400, Host/Origin, verifier + required scopes, fail-closed, custom path |
| `src/list-pagination.ts`, `src/server.ts` | `tests/list-pagination.test.ts` | `tools/list` paging both eras in memory and over HTTP, cursor errors -32602, defaults and env, low-level `Server`, `createMcpServer` Implementation/instructions/capabilities/cache hints/`maxToolInputElements` |
| `src/result-limits.ts`, `src/limits.ts` | `tests/result-limits.test.ts` | item and byte caps both eras, client `limit`, self-paging handlers, cursor round trip + tampering (other args, other tool, garbage, negative offset), byte-cap isError, `onOversize`, overrides |
| `src/client-input.ts` | `tests/client-input.test.ts` | elicit/sample/listRoots through MRTR (2026) and the legacy shim (2025), decline/cancel/invalid, unsupported clients, stateless HTTP (no capabilities on 2025) |
| `src/protocol-logging.ts` | `tests/protocol-features.test.ts` | protocol logging per era (setLevel on 2025, `_meta` log level on 2026, stateless HTTP), masking, off by default, `LOG_PROTOCOL`; progress over HTTP in both eras |
| `src/sdk/*` | `tests/sdk-subpaths.test.ts` | the SDK re-export subpaths reach their entry points |
| `src/resources.ts`, `src/notifications.ts` | `tests/resources.test.ts` | static resources and templates (completion, list), the read cap, degraded mode, masked errors, shorthand results, subscriptions per era, `subscriptions/listen` over HTTP, the runtime surface (no subscription outlives its HTTP request, both eras), the result spill (owner binding, expiry, entry and total byte budgets) |
| `src/prompts.ts`, `src/protocol-errors.ts` | `tests/prompts.test.ts` | listing, get, completion, error mapping, degraded mode, the runtime surface |
| `src/request-state.ts` | `tests/request-state.test.ts` | seal/open, tamper, expiry, caller and method binding, key rotation, missing or short keys, `continueWith` / `requestState()` round trip |
| `src/task-store.ts` | `tests/task-store.test.ts` | both stores: create/settle, principal isolation, cooperative cancel, input rounds, TTL and paging; file store across instances (cross-process cancel and input answers, never a previous round's) |
| `src/task-tools.ts`, `src/task-request.ts`, `src/testing/raw-peer.ts` | `tests/tasks.test.ts` | the 2026-07-28 extension over raw JSON-RPC (run, cancel, `input_required` + `tasks/update`, errors), the 2025-11-25 methods (`tasks/result`, list, status notifications), sync fallback, per-caller isolation over HTTP, a failing store write while settling (logged, no unhandled rejection) |
| (feature round trip) | `tests/features.roundtrip.test.ts` | resources, prompts and tasks end to end through the `@modelcontextprotocol/ext-tasks` requester |
| (consumer examples) | `examples/testing/tools.unit.test.example.ts`, `examples/testing/tools.integration.test.example.ts` | the shipped example suites, run against the echo fixture so they cannot rot |

`src/index.ts` and `src/testing/index.ts` are pure re-exports (no logic) and are excluded from coverage.

`tests/fixtures/echo-tools.ts` builds the fixture server (`echo`, `echo_json`, `boom`, `upstream_status`,
`paid_lookup`, `note_create`, `note_list`, `note_delete`; defined with `defineTool` and registered with
`registerTools`, notes in a data-store `jsonCache`) shared by the round-trip, harness and example suites;
`tests/fixtures/echo-server.ts` runs it on `runMcpServer` (package root `tests/fixtures/`, its
`package.json` names it `echo-fixture`) and is spawned as a child process with the tsx loader
(`--import <file URL of tsx>`). `tests/fixtures/crash-server.ts` exits at startup.
`tests/fixtures/feature-tools.ts` builds the resources/prompts/tasks fixture (`buildFeatureServer` over a
`FeatureShared` state), `tests/fixtures/job-tools.ts` the task tools, and `tests/fixtures/feature-server.ts`
runs that fixture on `runMcpServer`. `tests/setup-env.ts`
(jest `setupFiles`) stands in for the credential the integration example reads.

The example suites import `@novorb/mcp-core/testing` by package name; jest maps it to `src/`
(`moduleNameMapper`), and `tsconfig.examples.json` (`paths`) typechecks them with the harness tests and
fixtures (`pnpm run typecheck`).

## Coverage

Coverage is enforced at **85%** (statements / branches / functions / lines) globally via
`coverageThreshold` in `jest.config.js`; `collectCoverageFrom` instruments every `src/**` module so an
untested file counts against the threshold (except the pure re-exports: `src/index.ts`,
`src/testing/index.ts`, `src/sdk/*`). `jest --coverage` fails the run if coverage drops below it.

Current coverage is 96.75 / 92.23 / 94.69 / 98.04 (statements / branches / functions / lines).
`transport.ts`'s `startHttp` is exercised by the round-trip suite, which binds a free loopback port
and shuts down through the server's own SIGINT listener; the request logic is also directly testable
through the exported `createRequestHandler`, driven with mock `req`/`res`.

## Running tests

```bash
# All tests (the same command in PowerShell, cmd and POSIX shells)
node bin/mcp-core-jest.mjs

# Single module
node bin/mcp-core-jest.mjs tests/utils/logger.test.ts

# Watch mode
node bin/mcp-core-jest.mjs --watch

# Coverage (the 85% gate)
node bin/mcp-core-jest.mjs --runInBand --coverage
```

`pnpm test` / `pnpm run test:coverage` run the same launcher. `bin/mcp-core-jest.mjs` starts node with
`--experimental-vm-modules` and runs the jest resolved from the current directory, so it works without
the POSIX-only `NODE_OPTIONS=... jest` syntax.

## The `mcp-core-jest` runner for consumers

The launcher ships as the package bin `mcp-core-jest`. A consumer calls it from its own scripts:

```json
"test:unit": "mcp-core-jest tests/unit",
"test:integration": "mcp-core-jest tests/integration --runInBand --coverage=false"
```

It resolves the consumer's jest from the consumer's cwd (jest stays the consumer's devDependency;
mcp-core never depends on it at runtime), passes every argument through, exits with jest's exit code,
forwards SIGINT/SIGTERM/SIGHUP and ends with the signal that ended jest. Without a jest it exits 1 with
a message. Pinned by `tests/jest-runner.test.ts`.

## Testing harness for consumers

`@novorb/mcp-core/testing` is the harness the MCP servers build their own suites on (API in
[testing-harness.md](testing-harness.md), rules in CLAUDE.md "Testing harness"). Start from the two shipped examples:

- `examples/testing/tools.unit.test.example.ts`: in memory, no child process, no network.
- `examples/testing/tools.integration.test.example.ts`: the built server over stdio and http, explicit
  env, temp dirs, `MCP_IT_TARGET=test|live`, `MCP_IT_ALLOW_COSTLY=true`, `[SKIP]` lines, log and leak
  assertions, adverse cases.

Copy, drop `.example`, edit the "SERVER UNDER TEST" block and the case table.

## Conventions

- Import jest functions explicitly: `import { describe, it, expect, jest, beforeEach } from '@jest/globals'`
- Use `jest.fn<any>()` for mocks to avoid TS2345 under strict mode
- Tests must not depend on network access beyond loopback: mock outbound HTTP; the harness tests bind
  `127.0.0.1` only
- Temporary files (e.g. log rotation tests) go in `tests/.tmp-logs/` (gitignored)
- **Mock ESM dependencies with `jest.unstable_mockModule(...)` + a dynamic `await import(...)` of the
  module under test** (the classic `jest.mock` + static import does NOT intercept native ESM; the
  real module loads instead). See `transport.test.ts` for the pattern. Prefer a real loopback server
  over a mock when the behaviour lives in the dependency (`http-client.test.ts` drives real axios).

## Adding tests for new modules

1. Create `tests/<module-name>.test.ts`
2. Import from the source (not from `dist/`)
3. Cover the public API: every exported function needs at least one happy-path and one error-path test
