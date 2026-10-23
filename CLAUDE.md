# Mcp core

Shared TypeScript package (`@novorb/mcp-core`) of foundational utilities for building MCP
(Model Context Protocol) servers: logging, an HTTP client, retry/backoff, pagination, a unified
stdio/HTTP transport, and an `McpServer` factory.

## Modules

| Module | Exports | Purpose |
|--------|---------|---------|
| `logger` (`src/utils/logger.ts`, subpath `./logger`) | `initLogger`, `getLogger`, `resetLogger`, `Logger`, `LogLevel`, `logToolCall`, `logToolResult`, `summarizeArgs`, `packageRootFrom`, `registerSecretValues`, `redactSecrets` + `maskPii` + `maskSecretValues` + `clearSecretValues` (subpath only), types `LoggerConfig`, `LoggerOptions`, `LogFormat`, `LogSinks`, `ArgsSummary` | stderr console + `<name>.log` / `exceptions.log` / `debug.log` file sinks with rotation, secret redaction, PII masking, tool-call helpers, opt-in process-error capture |
| `utils/redact` (internal) | `redactSecrets`, `redactQueryParams`, `maskPii`, `sanitizeString` | Secret redaction and PII masking applied to every log entry |
| `http-client` | `createHttpClient`, `McpHttpClient` (`request`/`requestRaw`/verbs/`head`/`paginate`), `HttpError`, `TokenBucket`, `createTokenBucket`, `joinUrl`, `buildQueryString`, `templatePath` | Hardened client: auth strategies, per-request options, shared retry, rate limit, TLS, `mapError`, route-shape logging |
| `rate-limiter` (internal, exported via `http-client`) | `TokenBucket`, `createTokenBucket` | FIFO token bucket shared by one client's requests |
| `retry` | `retryWithBackoff`, `isRetryableError`, `isRetryableStatus`, `isIdempotentMethod`, `retryDelayFor`, `calculateRetryDelay`, `parseRetryAfter`, `retryAfterFromError`, `sleep`, `throwIfAborted` + the policy sets | The one retry policy, Retry-After, full-jitter backoff |
| `pagination` | `normalizePagination`, `createPaginationMetadata`, `pageToOffset`, `paginateArray`, strategies (`pagePerPage`, `nextPageHeader`, `offsetLimit`, `linkHeader`, `nextLinkField`, `continuationToken`), `paginateRequests`, cursors (`encodeCursor`, `decodeCursor`, `invalidCursorResult`, `paginateArrayByCursor`), `PagedResult` + `pagedResultSchema` | Page-number helpers, upstream page walkers, MCP cursors and the paged result contract |
| `transport` | `startMcpServer`, `createRequestHandler`, `resolveHttpAuth`, `resolveTransportMode`, `bearerMatches`, `runBearerGate`, `isJsonRequest`, `toHostname`, `toOriginHostname`, `parseList`, `TransportMode`, `TransportOptions`, `TransportHandle`, `RequestContext`, `ServerFactory`, `ServerOrFactory`, `McpRequestHandler` | Unified stdio / stateless Streamable HTTP transport |
| `auth` (subpath `./auth`) | `apiKeyVerifier`, `bearerOptions`, `authenticate`, `writeWebResponse`, `API_KEY_TOKEN_PLACEHOLDER`, types `HttpAuthOptions`, `ApiKeyVerifierOptions` | The Bearer gate on the SDK's `verifyBearerToken` / `bearerAuthChallengeResponse` |
| `express` (subpath `./express` only, not in the barrel) | `createMcpRouter`, `mountMcpServer`, types `McpExpressOptions`, `McpExpressRouter` | The stateless handler + same guards on an Express app (`@modelcontextprotocol/express`; express is an optional peer) |
| `bootstrap` (subpath `./bootstrap`) | `runMcpServer`, `readPackageInfo`, `transportFromEnv`, types `RunMcpServerOptions`, `RunServerOptions`, `RunningServer`, `SetupContext`, `PackageInfo` | The server entry point: logger, env, shared state once, transport, started line, signals, stdio EOF |
| `tools` (subpath `./tools`) | `registerTools`, `defineTool`, `toolResult`, `toolError`, `maskClientText`, `normalizeOutcome`, `defaultMapError`, `notConfiguredMessage`, types `ToolDefinition`, `AnyToolDefinition`, `ToolContext`, `ToolOutcome` | Tool definitions onto `McpServer.registerTool` with central logging, error mapping, masking, degraded mode, result limits |
| `result-limits` (internal, used by `tools`) | `enforceResultLimits`, `decodeToolCursor`, `handlerArgs`, `argsFingerprint`, `declaresPageArgs`, types `ToolLimits`, `OversizeInfo` | Item/byte caps per tool result and the stateless tool cursor |
| `limits` | `resolveLimits`, `DEFAULT_LIST_PAGE_SIZE`, `DEFAULT_MAX_RESULT_ITEMS`, `DEFAULT_MAX_RESULT_BYTES`, `DEFAULT_MAX_TOOL_INPUT_ELEMENTS`, `HARD_MAX_COLLECT_ITEMS` | The response caps from the env |
| `list-pagination` | `paginateLists`, `pageListResult`, `LIST_RESULT_KEYS` | `tools/list` (prompts, resources) paging over the SDK's own list handler |
| `client-input` | `createClientInput`, `requestEra`, `supportsClientFeature`, types `InputOutcome`, `ClientInput` | `ctx.elicit` / `elicitUrl` / `sample` / `listRoots` over the SDK multi round-trip flow |
| `protocol-logging` | `enableProtocolLogging`, `runWithRequestContext`, `currentRequestContext`, `protocolLoggingEnabled`, `toMcpLoggingLevel` | Opt-in forwarding of logger entries as MCP `notifications/message` |
| `sdk/*` (subpaths `./sdk/server`, `./sdk/server/stdio`, `./sdk/node`, `./sdk/client`, `./sdk/client/stdio`, `./sdk/express`) | `export *` of the matching `@modelcontextprotocol/*` package | Every SDK feature through mcp-core |
| `utils/envLoader` (subpath `./env`) | `loadEnv`, `CORE_ENV_SCHEMA`, `renderEnvTable`, `renderEnvExample`, types `EnvVarSpec`, `EnvSchema`, `LoadedEnv` | Per-server env schema; the one env loader (no dotenv) |
| `utils/dataStore` (subpath `./data-store`) | `createDataStore`, `resolveInside`, `safeName`, `DataPathError`, `DataStorageDisabledError`, `DownloadError`, types `DataStore`, `JsonCache` | Disk writes under `DATA_PATH`, stateless mode, traversal-safe paths, caches, bounded downloads |
| `server` | `createMcpServer`, `DEFAULT_CACHE_HINTS`, `McpServer`, `Server`, `completable`, `fromJsonSchema`, `inputRequired`, `requireScopes`, `ProtocolError`, `ProtocolErrorCode`, `UrlElicitationRequiredError`, `OAuthError`, `OAuthErrorCode`, `TOOL_ANNOTATIONS`, types `CreateMcpServerOptions`, `Implementation`, `McpServerOptions`, `AuthInfo`, `OAuthTokenVerifier`, `ScopeChallengeHandler`, `ServerContext`, `InputRequiredResult`, `McpCallToolResult`, `McpToolAnnotations` | McpServer factory (Implementation + options, cache hints, input cap, list pagination, protocol logging), annotation presets, the curated SDK re-exports |
| `testing` (`src/testing/`, subpath `./testing` only) | integration: `startBuiltServer`, `createIsolatedDirs`, `readLogFiles`, `logLevels`, `findLeaks`, `collectStrings`, `callToolJson`, `listToolNames`, `toolCoverage`, `assertToolCoverage`, `rawHttp`, `mcpPostHeaders`, `initializeRequestBody`, `freePort`, `killAndWait`, `minimalOsEnv`; unit: `connectInMemory`, `withInMemoryClient`, `callToolInMemory`, `captureToolCall`, `expectToolSuccess`, `expectToolError`, `expectSchemaRejection`, `expectUnknownTool`, `makeRecordingServer`, `createTestClient` | Test harness for consumer unit and integration suites (see "Testing harness") |

## SDK v2 (version 3.0.0)

- Runtime deps: `@modelcontextprotocol/server ~2.3.1`, `@modelcontextprotocol/node ~2.1.1`,
  `@modelcontextprotocol/client ~2.3.1`, `@modelcontextprotocol/express ~2.0.2` (patch ranges; a minor SDK
  release is adopted deliberately). `express ^4.18 || ^5` is an OPTIONAL peer (dev dep here), loaded only by
  `src/express.ts`. Node >= 20.12 (`util.parseEnv` in the env loader).
  Consumers bring `zod ^4.2`; mcp-core has no runtime zod dependency and `src/` never loads zod (the
  only reference is a type-only import in `pagination.ts`).
- **Consumers use the SDK only through mcp-core.** The curated `@novorb/mcp-core/server` is the
  recommended entry; `@novorb/mcp-core/sdk/{server,server/stdio,node,client,client/stdio,express}` are full
  `export *` re-exports for everything else. Never import `@modelcontextprotocol/*` in a consumer (tests
  included: `@modelcontextprotocol/client` becomes `@novorb/mcp-core/sdk/client`), never add a v1
  `@modelcontextprotocol/sdk` import. This is a documented rule, not a mechanical import-scanning test.
- **The SDK docs lead.** Where mcp-core differs from the SDK's documented practice, the reason is written
  next to the code and in README (current list: own `node:http` server instead of the Express adapter by
  default, own body read before `toNodeHandler` for the 413/400 order, list pagination by decorating
  `Server.setRequestHandler` because McpServer has no paging seam).
- **HTTP is factory-only.** One SDK v2 server instance serves one connection, so an instance passed to
  `startMcpServer` in HTTP mode throws. stdio accepts an instance or a factory.
- **`completable` nesting:** `completable(z.string(), cb).optional()` returns completions;
  `completable(z.string().optional(), cb)` silently returns an empty list. Pinned by tests.
- Removed options: `session` and `enableJsonResponse`.
- SDK subpaths used: `@modelcontextprotocol/server` (`createMcpHandler`, `McpServer`, `verifyBearerToken`,
  `isJsonContentType`, `inputRequired`, ...), `@modelcontextprotocol/server/stdio` (`serveStdio`),
  `@modelcontextprotocol/node` (`toNodeHandler`, `hostHeaderValidation`, `originValidation`),
  `@modelcontextprotocol/express` (express adapter), `@modelcontextprotocol/client` (the `testing`
  subpath and `sdk/client`). Never import `src/testing/` from a runtime module.

## Transport

`startMcpServer` selects the transport from `MCP_TRANSPORT` (`stdio` by default, or `http`; any other value
throws) and resolves with a `TransportHandle` (`{ mode, host?, port?, url?, closed, close() }`) once
serving: HTTP once the listener is bound (never only at shutdown). `closed` resolves when the transport
ends (close, or a stdio client closing stdin); `runMcpServer` then disposes and exits. `handleSignals`
(default true) installs SIGINT/SIGTERM handlers that close it; `runMcpServer` passes false and owns the
signals. `ServerFactory` receives the SDK's per-request `RequestContext` (`era`, `authInfo?` from the
Bearer gate, `requestInfo?`). stdio uses `serveStdio`; SIGINT/SIGTERM close the handle and re-raise the
signal when no other listener remains. HTTP mode uses `createMcpHandler(factory, { legacy: 'stateless' })`
(SDK default `responseMode: 'auto'`) adapted with `toNodeHandler`, behind mcp-core's own `node:http`
server. Each request is independent with no session state, which suits scale-to-zero hosts.

- Never set `responseMode: 'json'`: it drops progress and log notifications. `auto` answers one JSON body
  unless the handler emits a notification first (then SSE). 2025-era clients always get SSE (the SDK
  legacy path).
- The own `node:http` server (not `@modelcontextprotocol/express`) is deliberate: no framework dependency
  for the fleet, a fixed guard order, and `/health`. Hosts that run Express use `./express`, which keeps
  the same guards and order.
- `GET /health` → `{"status":"healthy"}` (no auth).
- `POST /mcp` is handled by the SDK handler; a legacy `GET /mcp` answers 405. An empty or malformed
  POST body answers 400 JSON-RPC `-32700`.
- Request order: `/health`, Bearer check (401), path (404), Host/Origin guards (403), content type
  (415), body size (413), parse and dispatch; a handler throw is a 500 with no detail.
- Errors from the SDK and stdio go to the mcp-core logger (`getLogger().error`).
- Listens on `PORT` (default `8080`), binding `MCP_HTTP_HOST` (default `0.0.0.0`; set `127.0.0.1` for local-only).

### Auth

HTTP mode is fail-closed: it refuses to start unless auth is explicitly configured.

- The gate is the SDK's `verifyBearerToken` + `bearerAuthChallengeResponse` (`src/auth.ts`): 401
  `invalid_token` / 403 `insufficient_scope` with `WWW-Authenticate`. On success `req.auth` is set, so the
  SDK hands the `AuthInfo` to the factory and to `ctx.http.authInfo`; `scopeChallenge` / `requireScopes`
  work end to end (tests/protocol-features.test.ts).
- `MCP_API_KEY` - Bearer token required on `/mcp`, through `apiKeyVerifier`: constant time
  (`crypto.timingSafeEqual` over SHA-256 digests), `AuthInfo.token` is the placeholder `[api-key]` (never
  the key), `expiresAt` now + 1 h (the SDK refuses tokens without one), scopes from `auth.apiKey.scopes`.
- `auth.verifier` (any `OAuthTokenVerifier`, for example the gateway's JWT verifier) replaces the key and
  always enforces auth.
- `MCP_AUTH_DISABLED=true` - run open, only when a gateway/platform fronts authentication. A missing or
  empty `MCP_API_KEY` is treated as "not configured" and throws, rather than silently serving the
  endpoint unauthenticated.
- `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` - comma-separated allowlists; setting either enables the
  SDK node validators (`hostHeaderValidation`/`originValidation`). Matching is by hostname only (port
  ignored); `host:port` and full-origin entries are normalised to hostnames (so a full origin's scheme
  is ignored). A lowercase `<scheme>://*` entry passes through unchanged and admits that whole scheme;
  `http://*` / `https://*` are never honoured by the SDK. Rejection is a 403 with a JSON-RPC body
  (`-32000`). Only `/mcp` is guarded.
- `MCP_MAX_BODY_BYTES` - POST body cap (default 4 MiB -> `413`); `POST /mcp` requires a JSON content type
  by the SDK's media-type essence compare (`isJsonContentType`; parameters and case allowed,
  `application/json-seq` refused -> `415`). mcp-core reads the body itself (before `toNodeHandler`) to
  keep the 413/400 order, so the SDK's own body checks are bypassed by design.

### Limits, lists, protocol features

- Response caps are on by default (`src/limits.ts`, env in `CORE_ENV_SCHEMA`): `MCP_LIST_PAGE_SIZE` 100,
  `MCP_MAX_RESULT_ITEMS` 100, `MCP_MAX_RESULT_BYTES` 256 KiB, `MCP_MAX_TOOL_INPUT_ELEMENTS` 10000; the
  http-client collector uses `MCP_MAX_RESULT_ITEMS` as its default `maxItems`. Never send a result over
  the byte cap and never truncate one into invalid JSON or schema-invalid `structuredContent`.
- List pagination decorates `Server.setRequestHandler` (McpServer's list handlers are private); call
  `paginateLists` before any registration. Do not re-implement the SDK's list content.
- Tool cursors are stateless and validated (tool + argument fingerprint + offset + the handler's own
  cursor); refuse anything else with `Invalid cursor: ...`.
- Protocol logging forwards logger entries (already redacted) through `ctx.mcpReq.log` inside the
  `registerTools` request scope; never forward tool inputs or outputs. Off unless `LOG_PROTOCOL`.
- Elicitation, sampling and roots go through the SDK's `inputRequired` (MRTR + legacy shim), never the
  push APIs; unsupported clients get a typed outcome, never a throw.

### Logger

Consumers call `initLogger({ name: '<server-name>', rootDir: packageRootFrom(import.meta.url) })` once
at startup. The logger is the only logging path; http-client and transport log through it.

- **Sinks:** console = `process.stderr` only (never stdout, the stdio protocol channel). Files in the log
  directory: `<name>.log` (main: every entry at or above the level), `exceptions.log` (ERROR only),
  `debug.log` (DEBUG only, so only when the level is DEBUG). Routing: INFO/WARN -> main; ERROR -> main +
  exceptions; DEBUG -> main + debug. Each file rotates on its own (`maxLogSize` 10 MB, `maxLogFiles` 5)
  and fails silently without affecting the other sinks.
- **Log directory:** `<rootDir>/.logs` by default. `LOG_PATH` overrides it (absolute, or relative to
  `rootDir`). Without `rootDir` and without an absolute `LOG_PATH` the file sinks stay off and
  `initLogger` prints ONE console warning; nothing is ever written relative to cwd.
- **Switches** (explicit option > env > default): `LOG_LEVEL` (INFO), `LOG_FORMAT` text|json (text),
  `LOG_CONSOLE` (true), `LOG_FILE_MAIN` / `LOG_FILE_EXCEPTIONS` / `LOG_FILE_DEBUG` (true each; effective
  only with a directory), `LOG_PATH` (`<rootDir>/.logs`), `LOG_FILE` (main file name, default
  `<name>.log`; absolute = as-is). Booleans accept true/false, 1/0, yes/no, on/off.
- **`name`** is sanitised to `[A-Za-z0-9._-]`. `initLogger` throws when the main file is on, a directory
  exists, and there is neither `name` nor `LOG_FILE`. The implicit `getLogger()` default never throws or
  warns (it just has no main file until init).
- **`captureProcessErrors: true`** (opt-in) installs `uncaughtException` / `unhandledRejection`
  handlers that log `Uncaught exception: <Name>: <message>` / `Unhandled rejection: <reason>` at ERROR,
  context `Process`, meta `{ stack }`, to main + exceptions (+ console), then `process.exit(1)`.
  Re-entrancy guarded. An EPIPE (or a sync EPIPE from `stderr.write`, or an EPIPE `error` event on
  stderr) marks stderr broken, so the console sink stops and nothing loops back to the dead pipe.
- **Reconfigure in place:** `initLogger(options)` reconfigures the existing singleton (same object
  identity), recomputing every setting from defaults + env + `options`. A logger captured with
  `getLogger()` at import time writes to the configured sinks after init. A second `initLogger` recomputes
  from scratch. `resetLogger()` drops the singleton, its handlers and the stderr state (tests).
- **`packageRootFrom(import.meta.url)`** walks up to the nearest `package.json` (works from `src/` and
  `dist/`), Windows-safe via `fileURLToPath`; also accepts a path.
- **Never log tool inputs or outputs.** Use the helpers (through the singleton, default context `Tools`).
  Text lines, pinned by tests:
  - `logToolCall(name, args, context?)`:
    `<ISO> | INFO  | Tools | Tool call: <name> | {"tool":"<name>","args":<summarizeArgs(args)>}`
  - `logToolResult(name, { isError, durationMs }, context?)`: INFO on success, WARN when `isError`:
    `<ISO> | INFO  | Tools | Tool result: <name> | {"tool":"<name>","isError":false,"durationMs":<int>}`
    (`durationMs` is rounded to an integer).
  - `summarizeArgs(args)` is shape only, never values: per top-level key `string(<len>)`,
    `array(<len>)`, `object{<key names, one level, max 20 then ,...+N>}`, `number`, `boolean`, `null`,
    `undefined`, `bigint`, `function`. Non-object args go under `_args`; null/undefined give `{}`.
  - Never log raw `arguments` or result content (CI variable values, BOMs, file contents are data, not
    secrets by key name, so redaction cannot catch them).
- **PII masking** on every entry (message + every meta string, recursively), after secret redaction:
  `[EMAIL]`, `[PHONE]` (international `+..`, NANP `(555) 123-4567`, national `06-12345678` /
  `020 123 4567`, 8-15 digits), `[CARD]` (13-19 digits, issuer prefix + Luhn, spaces/dashes allowed),
  `[IBAN]` (mod-97 checked), `[JWT]` (`eyJ...` three segments), `Bearer [TOKEN]` (unless the token is a
  short all-lowercase word, so prose like "Bearer authentication" stays), `[IP]` (IPv4, IPv6 incl. compressed). Pinned
  negatives: ISO timestamps, clock times, semver / `v1.2.3.4` / prerelease versions, plain integers, epoch
  millis, Luhn-invalid or bad-checksum numbers, `std::map`, MAC addresses.

### Logger & HTTP-client hardening

- The logger redacts sensitive-keyed `meta` fields to `[REDACTED]` before serialising, matching keys
  by name segment (`isSensitiveKey` in `src/utils/redact.ts`): a secret noun followed only by a
  value-like suffix (`accessToken`, `passwordHash` redacted; `maxTokens`, `signatureAlgorithm`,
  `credentialType`, `primaryKey` kept). Exact `key` is redacted. Generic keys like `value` and `content`
  are deliberately NOT redacted (DNS values, file contents).
- Inside strings (message, context, meta): secret query/form parameters become `name=[REDACTED]`,
  connection-string passwords `scheme://user:[REDACTED]@`, HTTP Basic credentials `Basic [TOKEN]`.
- Every pattern is linear-time (pinned by 1 MiB adversarial tests); strings over 32768 chars are
  truncated with a marker, depth > 8 becomes `[DEPTH]`, cycles `[CIRCULAR]`, lines cap at 256 KiB, and
  logging never throws into the caller.
- Text mode strips CR/LF and other control chars so logged values can't forge log lines.
- `http-client` sets `maxRedirects: 0` and response/body size caps (streams included), retries only
  idempotent methods unless the request carries an idempotency key or `retry.unsafe`, sends credentials
  only to the base origin or `allowedOrigins`, masks every configured secret in error messages, and
  throws `HttpError` carrying only status/statusText/code/method/path/retryAfterMs, never the raw axios
  `response`, `config` or headers (they hold the auth token). Stream errors are re-wrapped for the same
  reason (axios emits a raw AxiosError on the stream).

## HTTP client, retry, pagination

- **One retry policy** (`src/retry.ts`) used by `retryWithBackoff` and the client: 408, 425, 429, 500,
  502, 503, 504; ECONNRESET, ETIMEDOUT, EAI_AGAIN, ECONNREFUSED with syscall `connect`. Retry-After
  honoured up to `maxRetryAfterMs`, else full jitter. Do not add a second policy or `axios-retry` back.
- **One `requestRaw` core** in `McpHttpClient`; the verbs are thin wrappers. Add capability there.
- **URLs:** `joinUrl` joins once; absolute URLs are used as-is (an OData next-link already contains
  `/v1.0`, the sharepoint `/v1.0/v1.0` bug), gated by the origin allowlist.
- **Logging** goes through the logger only: `{ method, host, path, status, durationMs, attempt }` (+
  `code`, `delayMs` on retry); the path is `templatePath`'d. Never log query values, headers or bodies.
- **Pagination** (`src/pagination.ts`): strategies are pure `{ first, parse }` objects; `paginateRequests`
  owns the caps (default 100 pages, `HARD_MAX_PAGES` 10000) and the repeated-request loop guard.
  `pagination.ts` only type-imports `http-client`, and only type-imports zod (`pagedResultSchema(z, item)`
  takes the consumer's `z`), so neither is loaded at runtime from it.
- **Rate limiter** (`src/rate-limiter.ts`, exported via `http-client`): a FIFO token bucket per client.

## Server module (`@novorb/mcp-core/server`)

Import from here instead of the SDK directly to centralise the MCP dependency:

```typescript
import { z } from 'zod';
import { createMcpServer, TOOL_ANNOTATIONS, completable } from '@novorb/mcp-core/server';
import type { McpToolAnnotations, McpCallToolResult } from '@novorb/mcp-core/server';
import { startMcpServer } from '@novorb/mcp-core/transport';

function buildServer() {
  const server = createMcpServer('my-mcp', '1.0.0');

  server.registerTool('lookup', {
    description: 'Look up a value',
    inputSchema: z.object({ key: z.string() }),
    outputSchema: z.object({ value: z.string(), found: z.boolean() }),
    annotations: TOOL_ANNOTATIONS.readOnly,
  }, async ({ key }) => ({
    content: [{ type: 'text', text: key }],
    structuredContent: { value: key, found: true },
  }));

  server.registerPrompt('find-and-summarise', {
    argsSchema: z.object({
      key: completable(z.string(), (val) => ['foo', 'bar'].filter((k) => k.startsWith(val))).optional(),
    }),
  }, ({ key }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Look up "${key}"` } }],
  }));

  return server;
}

await startMcpServer(buildServer);
```

**`TOOL_ANNOTATIONS` presets:**
- `readOnly` — `readOnlyHint: true, idempotentHint: true` (lookups, searches, status checks)
- `idempotentWrite` — `idempotentHint: true` (upserts)
- `mutableWrite` — non-idempotent writes
- `destructive` — `destructiveHint: true` (deletes, overwrites)
- `readOnlyOpenWorld`, `idempotentWriteOpenWorld`, `mutableWriteOpenWorld`, `destructiveOpenWorld`: the
  same four plus `openWorldHint: true`; use them for every tool that calls an external API.

## Bootstrap, tools, env, data store

The full minimal-server example, env table generation and the low-level `Server` migration steps are in
README "Building a server". Rules for changing these modules:

- **Stay on the SDK.** `registerTools` is built on `McpServer.registerTool`: never re-implement
  tools/list, input validation, output validation or the unknown-tool error. mcp-core adds only the
  wrapper (logging, `mapError`, legacy envelope mapping, degraded mode, `enabled`/`prefix`, result
  limits, client-bound masking). Rethrow what the SDK rethrows (`UrlElicitationRequired` -32042) and
  pass input-required results through untouched.
- **Every client-bound error text goes through `maskClientText`** (the logger's redaction + registered
  secret values): `toolError`, `mapError` output, schema-issue text, degraded text, returned isError.
- **`runMcpServer` order is pinned** (tests/bootstrap.test.ts): logger init > `loadEnv` > logger
  reconfigure > `setup` once > transport > ONE `<name> started` INFO line after bind. Signals and a stdio
  EOF: close transport, then `dispose`, then `exit(0)` (`exit(1)` when either failed). Shared state is
  created once and reused by every request. Transport settings come from the loaded env.
- **Env:** every key a server reads is declared in its schema; mcp-core's own keys live in
  `CORE_ENV_SCHEMA` (add a key there when transport/logger/data store start reading one). Values are never
  logged or returned by `describe()`; errors name keys only; set secrets go to `registerSecretValues`.
- **Data store:** every disk path goes through `resolveInside`; nothing is created at import time or
  relative to cwd; `DATA_STORAGE=false` must write nothing. Traversal and stateless cases are security
  regressions (tests/utils/dataStore.test.ts); keep them failing-if-reintroduced.
- **Degraded mode text is uniform:** `<serverName> is not configured: set <KEYS>` for every server.

## Design principles

1. **Secure by default (fail-closed).** Controls default to the safe state and fail *loudly* on
   misconfiguration — the HTTP transport refuses to start without auth rather than silently serving
   open; opting out is explicit (`MCP_AUTH_DISABLED=true`).
2. **Secrets never reach a sink.** Credentials must not appear in logs, thrown errors, or responses —
   the logger redacts sensitive-keyed metadata, normalized errors carry only `status`/`statusText`, and
   a raw error object is never passed to a logger. *Defense-in-depth:* redact even though callers
   shouldn't pass secrets in the first place.
3. **Outbound HTTP is hardened at the client, not per-caller.** `maxRedirects: 0`, response/body size
   caps, timeouts, and idempotent-only retries are set once on the shared client so no caller can forget.
4. **Constant-time comparison and bounded input.** Token checks use `timingSafeEqual`; request bodies
   are size- and content-type-limited.
5. **Every security fix ships a regression test** — one that *fails if the vulnerability returns* (e.g.
   asserting no `api_key` survives serialization), not just a behavior test.
6. **Standalone, dependency-light, no business logic.** Builds in isolation (`tsconfig.json` has no
   `extends`), keeps a minimal dependency surface, and stays a pure utility layer — easy to trust and
   audit. The protocol dependencies are the `@modelcontextprotocol/*` packages listed under "SDK v2",
   which mcp-core owns and re-exports for its consumers.

## Working here

- Source is in `src/` (the logger and redaction live in `src/utils/`, the test harness in
  `src/testing/`), tests mirror it in `tests/`, one test file per module. The `./logger` export subpath
  maps to `dist/utils/logger.js`, `./testing` to `dist/testing/index.js`.
- Typecheck with `pnpm run typecheck` (the `src` build plus `tsconfig.examples.json`, which covers the
  example suites, the harness tests and the fixtures).
- Build with `pnpm run build` (runs `tsc`).
- Run tests with `node scripts/run-jest.mjs` (`--coverage` for the 85% gate; it sets
  `--experimental-vm-modules` portably).
- ESM package (`"type": "module"`). `tsconfig.json` is self-contained (no `extends`) so it builds standalone.
- Node version is pinned in `.nvmrc`. Uses pnpm; inside HQ always run it as
  `corepack pnpm <cmd> --ignore-workspace` (install: `corepack pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace`),
  so the `system/fabric` workspace is never touched.
- Type mocks precisely (`jest.fn<Signature>()`, `jest.Mock<T>`, real SDK/axios types) — no `any` in tests.
- Local consumer link: from a consumer dir, `pnpm add @novorb/mcp-core@link:<relative path to this package>`
  (the consumer resolves `dist/`, so run `pnpm run build` here first). Do not use `pnpm link --global`.

## Testing

Every module has a test file under `tests/` and every exported function is covered (ESM `ts-jest`),
with coverage **enforced at 85%** (statements/branches/functions/lines) via `jest.config.js`. Beyond
behavior, the suite includes **security regression tests** that assert a vulnerability's *absence*:

- `utils/logger` (`tests/utils/logger.test.ts`): every env switch and its config override, level-to-file
  routing, file names and directory resolution (`.logs`, LOG_PATH absolute/relative, LOG_FILE, the
  no-directory warning, never cwd), required `name`, reconfigure-in-place, per-file rotation and sink
  isolation, console never touching stdout (asserted after every test), sync and async EPIPE,
  `captureProcessErrors` incl. re-entrancy and the EPIPE no-loop case, formats, masking end to end, the
  tool-helper line text and levels, `summarizeArgs` never carrying a value, `packageRootFrom`.
- `utils/redact` (`tests/utils/redact.test.ts`): every sensitive-key rule and query-parameter rule as a
  security regression, `value`/`content` left intact, every PII pattern positive and the pinned negatives.
- `http-client`: driven against a real `node:http` server on 127.0.0.1 (no axios mock): every verb,
  `head`, `requestRaw`, each responseType, `validateStatus`, every auth strategy incl. the token-provider
  401 refresh, query-key masking in errors and logs, base-URL joining and the absolute next-link case,
  the origin guard, idempotent-only retries (POST replay only with an idempotency key or `unsafe`),
  Retry-After seconds/date and its cap, timeouts, ECONNREFUSED, abort in flight and during a retry wait,
  no redirect follow, size caps (json, stream, chunked stream, request body), sanitized stream errors,
  errors without response/config/headers, upstream message extraction, `mapError`, log meta shape,
  the rate limiter, and `paginate` end to end.
- `transport` — stdio mode, options; **fail-closed** auth resolution (throws when unconfigured) and the
  **constant-time** Bearer comparison; `createRequestHandler` routing (`/health`, `401`/`403` SDK
  challenge, `req.auth` placeholder, pluggable verifier, `415` essence compare, `413`, `404`, `500`, and
  `/mcp` dispatch) driven with mock `req`/`res`; only `createMcpHandler`/`serveStdio`/the node adapter are
  mocked (the SDK's auth helpers are its real CommonJS build).
- `express` (`tests/express.test.ts`): a real Express app, both eras, every guard and the fail-closed rule.
- `list-pagination`, `result-limits`, `client-input`, `protocol-features`: paging both eras (memory and
  HTTP), every result cap, cursor round-trip and tampering, elicitation/sampling/roots through MRTR and the
  legacy shim, protocol logging per era, progress over HTTP, `requireScopes` end to end.
- `sdk-subpaths`: the `./sdk/*` re-exports reach their SDK entry points.
- `transport.roundtrip`: real v2 `Client` round-trips, built on the testing harness, over stdio and HTTP
  (child processes running `tests/fixtures/echo-server.ts` via `startBuiltServer`), in memory
  (`connectInMemory`) and HTTP in-process (keeps `startHttp` under coverage), in both protocol eras,
  plus the real Host/Origin allow-list semantics.
- `testing` (`tests/testing/*.test.ts`): real stdio and http starts of the fixture in isolated dirs
  (explicit env, stop idempotency, startup failures carry stderr, 401/404/413/415, logs written by the
  real logger and scanned for leaks), every unit helper, the SDK v2 outcome pins (schema rejection =
  isError result, unknown tool = thrown -32602), `findLeaks`, `readLogFiles`, coverage helpers.
- `examples/testing/*.example.ts`: the shipped consumer example suites, run against the echo fixture.
  `tests/setup-env.ts` stands in for the operator-supplied credential they read.
- `server`: `createMcpServer` factory, the `TOOL_ANNOTATIONS` presets, the SDK re-exports, and the
  `completable` nesting pins.
- `tools` (`tests/tools.test.ts`): over the real SDK in memory: listing, call/result log lines (shape
  only), SDK schema rejection and unknown tool `-32602`, thrown Error / schema issues / `mapError` (and a
  throwing one), legacy `{ success: false }` as isError, `fromJsonSchema` + output schema, `enabled` and
  `prefix`, degraded listing and its uniform error, undeclared `requires`, every `ToolContext` field.
- `bootstrap` (`tests/bootstrap.test.ts`): in-process HTTP: the order and the single started line after
  bind, shared state created once across many requests (both eras), `close()` order and idempotency,
  SIGINT/SIGTERM close + dispose + exit 0, a failing dispose (exit 1), `handleSignals: false`, dispose on
  a failed start, `.env` loading with env errors logged by key, name/version overrides, `readPackageInfo`,
  and a spawned stdio fixture with a keep-alive timer that disposes and exits on stdin EOF.
- `utils/envLoader`: precedence, `MCP_ENV_FILE` (relative, absolute, none, missing), multi ordering,
  validation by key without values, strict, `describe()` never carrying a value, the unknown-key WARN
  (names only), secrets masked in logs, `renderEnvTable` / `renderEnvExample`.
- `utils/dataStore`: default dir and lazy creation, `DATA_PATH`, `DATA_STORAGE=false` writing nothing,
  in-memory `jsonCache`, every traversal form (POSIX, Windows `..\`, drive letters, UNC, NUL, junction
  escape), `safeName`, atomic writes, download size/time/redirect caps, cross-origin header drop, inline
  bytes when disabled.
- `retry`: the pinned status and network-code sets (501 and plain 4xx never), ECONNREFUSED connect-only,
  full-jitter bounds, Retry-After seconds/date/cap, bounded attempts, abort before, during and between
  attempts.
- `rate-limiter`: burst, refill, FIFO waiting, an aborted waiter not stalling the queue.
- `pagination`: every strategy against recorded response shapes (Dependency-Track, GitLab, offset/limit,
  Link header, Graph, Nexus, Trello) incl. each stop condition, the page caps, `maxItems`, the repeated
  next-link loop guard, cursor round-trip and every bad-cursor error, `pagedResultSchema` with real zod.

## Testing harness (`@novorb/mcp-core/testing`)

The API tables and a consumer example are in README "Testing harness". Rules for changing it:

- **Separate subpath only.** `src/testing/` may import `transport`/`server` types, never the reverse;
  `src/index.ts` does not re-export it. `@modelcontextprotocol/client` is a regular dependency (also
  re-exported as `./sdk/client`).
- **Runner agnostic.** No jest/vitest imports in `src/testing/`; return objects, throw `Error`s.
- **HQ agnostic and Windows-safe.** No HQ paths; spawn `process.execPath` with `shell: false`; teardown
  is kill-and-await (`killAndWait`), temp dirs under `os.tmpdir()`, cleanup with retries.
- **Explicit child env.** `startBuiltServer` passes only the SDK's minimal OS list
  (`DEFAULT_INHERITED_ENV_VARS`) + the caller's env + harness vars; `inheritEnv` is opt-in. Note
  `StdioClientTransport` itself always merges that same OS list, so stdio and http see the same base.
  `envFile` sets `MCP_ENV_FILE` for mcp-core's env loader (`'none'` = never read a `.env`).
- **The echo fixture is a real server.** `tests/fixtures/echo-server.ts` runs on `runMcpServer` +
  `registerTools` + `createDataStore` (package root `tests/fixtures/`, whose `package.json` names it
  `echo-fixture`); `echo-tools.ts` keeps the 8 tools and a zero-argument `buildEchoServer` over an
  in-memory (`DATA_STORAGE=false`) shared state for in-process tests. Its notes live under `DATA_PATH`.
- **Pinned SDK v2 outcomes** (`tests/testing/tools.test.ts`): McpServer rejects bad arguments with an
  isError result starting `Input validation error:`; an unknown tool throws ProtocolError -32602
  `Tool <name> not found`. `expectSchemaRejection` / `expectUnknownTool` accept either surface.
- **Examples cannot rot.** `examples/testing/tools.{unit,integration}.test.example.ts` ship in the
  package (`files`), are matched by jest (`testMatch`), import mcp-core by package name (resolved to
  `src/` by `moduleNameMapper` in jest and `paths` in `tsconfig.examples.json`, typechecked by
  `pnpm run typecheck`), and target the echo fixture. Keep the "SERVER UNDER TEST" block the only part
  a consumer edits. Changing a helper's shape means updating both examples in the same change.

## Documentation

| File | Description |
|------|-------------|
| [docs/TESTING.md](docs/TESTING.md) | Test runner commands, conventions, and guidance for adding tests |
