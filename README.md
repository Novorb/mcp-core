# NOVORB - MCP Core

---

[![CI](https://github.com/Novorb/mcp-core/actions/workflows/ci.yml/badge.svg)](https://github.com/Novorb/mcp-core/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@novorb/mcp-core)](https://www.npmjs.com/package/@novorb/mcp-core)
[![Node](https://img.shields.io/badge/Node-20%2B-green)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-741-purple)]()
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

#### Quality Assurance

[![Coverage](https://img.shields.io/badge/coverage-99.39%25%20lines-brightgreen)]()
[![Audit](https://img.shields.io/badge/audit-0_vulns-brightgreen)]()
[![Fallow](https://img.shields.io/badge/fallow_health-86.6_(A)-brightgreen)](https://fallow.tools)
[![Maintainability](https://img.shields.io/badge/maintainability-94-brightgreen)](https://fallow.tools)

Shared TypeScript utilities for building MCP (Model Context Protocol) servers — logging, HTTP clients, retry logic, pagination, and transport — so every MCP server gets a consistent, tested foundation without reimplementing common patterns.

Version 3 is built on the MCP SDK v2 packages.

## Features

- **Structured logging**: stderr console plus main/exceptions/debug log files in the server's own `.logs`, rotation, text or JSON, secret redaction, PII masking, shape-only tool-call logging, opt-in crash capture
- **HTTP client**: one hardened client for every upstream: auth strategies (bearer, basic, custom header, query key, refreshing token provider), per-request options (signal, timeout, responseType incl. streams, size cap, validateStatus, retry), idempotent-only retries honouring `Retry-After`, a token-bucket rate limiter, TLS options, a `mapError` hook, and route-shape-only logging
- **Retry with backoff**: one shared retry policy, full-jitter exponential backoff, `Retry-After` (seconds or date) with a cap, bounded and abort-aware
- **Pagination**: upstream page walkers (page/per_page, `X-Next-Page`, offset/limit, `Link: rel="next"`, OData `@odata.nextLink`, continuation tokens) with stop conditions and hard caps; opaque MCP cursors and one paged result contract for list tools
- **The SDK through mcp-core**: the curated `./server` entry plus full re-exports of every SDK package (`./sdk/server`, `./sdk/node`, `./sdk/client`, `./sdk/express`, ...), so consumers never depend on `@modelcontextprotocol/*`
- **Unified transport**: stdio and stateless streamable-HTTP with the SDK's Bearer gate (static key or a pluggable verifier, `AuthInfo` for scope challenges), DNS-rebinding protection, and progress/log streaming (`responseMode: 'auto'`)
- **Express adapter** (`./express`): the same handler and guards on an existing Express app
- **Server builder**: `McpServer` factory taking the full `Implementation` and `McpServerOptions` (instructions, cache hints, input caps), annotation presets, list pagination on by default
- **Response limits**: list-shaped tool results paged with stateless, tamper-checked cursors; a byte cap per result answered with an actionable error; bounded upstream collectors
- **Protocol features**: opt-in MCP protocol logging, era-blind elicitation / sampling / roots helpers over the SDK's multi round-trip flow, progress and cancellation
- **Bootstrap** (`runMcpServer`): one entry point shape for every server: logger, env, shared state created once per process, transport, one "started" line after bind, owned signal handling, name and version from `package.json`
- **Tool registration** (`registerTools`): tool definitions onto `McpServer.registerTool` with central call/result logging, safe error mapping, legacy `{ success: false }` envelopes as `isError`, uniform degraded mode for unconfigured credentials, and an `enabled` filter
- **Env loader** (`loadEnv`): every server declares its env schema; one loader (no dotenv) with process env > `.env` > defaults, multi-key families, typed validation by key name, secrets masked verbatim in logs, and generated README tables / `.env.example`
- **Data store** (`createDataStore`): the one way to write to disk: `DATA_PATH` / `DATA_STORAGE=false` (stateless), traversal-safe paths, atomic writes, TTL JSON caches, bounded downloads
- **Testing harness** (`@novorb/mcp-core/testing`): unit helpers (in-memory client, recording server, outcome assertions) and an integration harness (start the built server over stdio or HTTP with an explicit env and temp dirs, log-file and leak checks, raw HTTP adverse checks), plus two example suites to copy
- **ESM native** — built as ES modules with full TypeScript declarations

## Module map

| Import path | Exports | Purpose |
|-------------|---------|---------|
| `@novorb/mcp-core/server` | `createMcpServer`, `DEFAULT_CACHE_HINTS`, `TOOL_ANNOTATIONS`, `McpServer`, `Server`, `completable`, `fromJsonSchema`, `inputRequired`, `requireScopes`, `ProtocolError`, `ProtocolErrorCode`, `UrlElicitationRequiredError`, `OAuthError`, `OAuthErrorCode`, types `CreateMcpServerOptions`, `Implementation`, `McpServerOptions`, `AuthInfo`, `OAuthTokenVerifier`, `ScopeChallengeHandler`, `ServerContext`, `InputRequiredResult`, `McpCallToolResult`, `McpToolAnnotations` | The recommended, curated entry: server builder plus the SDK symbols servers use |
| `@novorb/mcp-core/transport` | `startMcpServer`, `createRequestHandler`, `resolveHttpAuth`, `resolveTransportMode`, `bearerMatches`, `runBearerGate`, `isJsonRequest`, `toHostname`, `toOriginHostname`, `parseList`, `DEFAULT_MAX_BODY_BYTES`, types `TransportMode`, `TransportOptions`, `TransportHandle`, `RequestContext`, `ServerFactory`, `ServerOrFactory`, `McpRequestHandler`, `AuthenticatedRequest` | stdio and streamable-HTTP transport |
| `@novorb/mcp-core/auth` | `apiKeyVerifier`, `bearerOptions`, `authenticate`, `writeWebResponse`, `API_KEY_TOKEN_PLACEHOLDER`, `API_KEY_TTL_SECONDS`, types `HttpAuthOptions`, `ApiKeyVerifierOptions`, `AuthOutcome` | The HTTP Bearer gate on the SDK's `verifyBearerToken` (static key or a pluggable verifier) |
| `@novorb/mcp-core/express` | `createMcpRouter`, `mountMcpServer`, types `McpExpressOptions`, `McpExpressRouter` | The same stateless handler and guards mounted on an existing Express app (optional peer `express`) |
| `@novorb/mcp-core/bootstrap` | `runMcpServer`, `readPackageInfo`, `transportFromEnv`, types `RunMcpServerOptions`, `RunServerOptions`, `RunningServer`, `SetupContext`, `PackageInfo` | Server entry point: logger, env, shared state, transport, signals, stdio EOF |
| `@novorb/mcp-core/tools` | `registerTools`, `defineTool`, `toolResult`, `toolError`, `maskClientText`, `normalizeOutcome`, `defaultMapError`, `notConfiguredMessage`, types `ToolDefinition`, `AnyToolDefinition`, `ToolContext`, `ToolOutcome`, `ToolArgs`, `LegacyEnvelope`, `RegisterToolsOptions`, `MappedToolError` | Tool registration on `McpServer` with result limits and the client input helpers |
| `@novorb/mcp-core/sdk/server`, `/sdk/server/stdio`, `/sdk/node`, `/sdk/client`, `/sdk/client/stdio`, `/sdk/express` | `export *` of `@modelcontextprotocol/server`, `/server/stdio`, `/node`, `/client`, `/client/stdio`, `/express` | Every SDK feature, through mcp-core (see "The SDK through mcp-core") |
| `@novorb/mcp-core/env` | `loadEnv`, `CORE_ENV_SCHEMA`, `renderEnvTable`, `renderEnvExample`, types `EnvVarSpec`, `EnvSchema`, `LoadedEnv`, `LoadEnvOptions`, `EnvError`, `EnvKeyState`, `EnvSource`, `EnvVarType`, `RenderOptions` | Per-server env schema and the one env loader |
| `@novorb/mcp-core/data-store` | `createDataStore`, `resolveInside`, `safeName`, `DataPathError`, `DataStorageDisabledError`, `DownloadError`, types `DataStore`, `JsonCache`, `DownloadSource`, `DownloadOptions`, `DownloadResult`, `CreateDataStoreOptions` | Disk writes, caches and downloads under `DATA_PATH` |
| `@novorb/mcp-core/logger` | `initLogger`, `getLogger`, `resetLogger`, `Logger`, `LogLevel`, `logToolCall`, `logToolResult`, `summarizeArgs`, `packageRootFrom`, `redactSecrets`, `maskPii`, types `LoggerConfig`, `LoggerOptions`, `LogFormat`, `LogSinks`, `ArgsSummary` | Console + file logging with rotation, redaction, PII masking and tool-call helpers |
| `@novorb/mcp-core/retry` | `retryWithBackoff`, `isRetryableError`, `isRetryableStatus`, `isIdempotentMethod`, `calculateRetryDelay`, `retryDelayFor`, `parseRetryAfter`, `retryAfterFromError`, `errorStatus`, `sleep`, `throwIfAborted`, `RETRYABLE_STATUS_CODES`, `RETRYABLE_NETWORK_CODES`, `IDEMPOTENT_METHODS`, types `RetryOptions`, `RetryContext`, `RetryInfo` | The one retry policy (statuses, network codes, idempotency, Retry-After, full-jitter backoff) |
| `@novorb/mcp-core/pagination` | `normalizePagination`, `createPaginationMetadata`, `pageToOffset`, `paginateArray`; strategies `pagePerPage`, `nextPageHeader`, `offsetLimit`, `linkHeader`, `nextLinkField`, `continuationToken`, runner `paginateRequests`, `parseLinkHeader`, `readHeaderTotal`, `defaultItems`; cursors `encodeCursor`, `decodeCursor`, `InvalidCursorError`, `invalidCursorResult`, `paginateArrayByCursor`, `pagedResultSchema` (+ types incl. `PagedResult`, `PaginationStrategy`, `PageIterator`) | Page-number helpers, upstream page walkers, MCP cursors and the paged result contract |
| `@novorb/mcp-core/http-client` | `createHttpClient`, `McpHttpClient`, `HttpError`, `TokenBucket`, `createTokenBucket`, `joinUrl`, `buildQueryString`, `templatePath` (+ types incl. `HttpClientConfig`, `RequestOptions`, `HttpAuth`, `HttpResponse`, `HttpErrorInfo`) | Hardened HTTP client |
| `@novorb/mcp-core/testing` | `startBuiltServer`, `createIsolatedDirs`, `readLogFiles`, `logLevels`, `findLeaks`, `collectStrings`, `callToolJson`, `listToolNames`, `toolCoverage`, `assertToolCoverage`, `rawHttp`, `mcpPostHeaders`, `initializeRequestBody`, `connectInMemory`, `withInMemoryClient`, `callToolInMemory`, `captureToolCall`, `expectToolSuccess`, `expectToolError`, `expectSchemaRejection`, `expectUnknownTool`, `makeRecordingServer`, `createTestClient`, `freePort`, `killAndWait`, `minimalOsEnv` (+ types) | Test harness (uses `@modelcontextprotocol/client`, a regular dependency). Never imported by the runtime entry points |

The package root (`@novorb/mcp-core`) re-exports the logger (except `redactSecrets` and `maskPii`, which are on `@novorb/mcp-core/logger` only; `registerSecretValues` is on both), retry, pagination, http-client, server, bootstrap, tools, env and data-store surfaces, the auth basics (`apiKeyVerifier`, `HttpAuthOptions`), the limits (`resolveLimits`, the `DEFAULT_*` caps), list pagination (`paginateLists`, `pageListResult`), protocol logging (`enableProtocolLogging`, `runWithRequestContext`, ...) and the client input types, plus `startMcpServer`, `resolveTransportMode`, `DEFAULT_MAX_BODY_BYTES` and the `ServerFactory`, `RequestContext`, `TransportHandle`, `TransportMode` and `TransportOptions` types from transport. `createRequestHandler`, `bearerMatches`, `resolveHttpAuth`, `ServerOrFactory` and `McpRequestHandler` come from `@novorb/mcp-core/transport` only; the Express adapter only from `@novorb/mcp-core/express` (it loads express).

## The SDK through mcp-core

Consumers depend on `@novorb/mcp-core` only, never on `@modelcontextprotocol/*`:

- **Recommended:** the curated `@novorb/mcp-core/server` (plus `/tools`, `/bootstrap`, `/transport`, `/testing`).
- **Everything else the SDK offers:** `@novorb/mcp-core/sdk/server` (= `@modelcontextprotocol/server`),
  `/sdk/server/stdio`, `/sdk/node`, `/sdk/client` (with its HTTP, SSE and in-memory transports),
  `/sdk/client/stdio`, `/sdk/express`. Each is a full `export *` (values and types), pinned to the SDK
  versions mcp-core ships (`server ~2.3.1`, `node ~2.1.1`, `client ~2.3.1`, `express ~2.0.2`). There is no
  `/sdk/core`: `@modelcontextprotocol/server` and `/client` already re-export every spec type, and
  `@modelcontextprotocol/core` is the SDK's internal schema package.
- **Migration:** in consumer tests replace `import ... from '@modelcontextprotocol/client'` with
  `'@novorb/mcp-core/sdk/client'` (and `/client/stdio` with `/sdk/client/stdio`), remove
  `@modelcontextprotocol/*` from the consumer's `package.json`, and keep importing server symbols from
  `@novorb/mcp-core/server`.

## SDK v2

Version 3.0.0 moves from `@modelcontextprotocol/sdk` (v1) to the SDK v2 packages.

- **Packages:** `@modelcontextprotocol/server` `~2.3.1`, `@modelcontextprotocol/node` `~2.1.1`, `@modelcontextprotocol/client` `~2.3.1` and `@modelcontextprotocol/express` `~2.0.2` are runtime dependencies (patch-level ranges: a minor SDK release is adopted deliberately). `express` (`^4.18 || ^5`) is an optional peer, needed only for `@novorb/mcp-core/express`; note that a package manager that auto-installs peers (pnpm, npm 7+) installs express for every consumer because `@modelcontextprotocol/express` declares it as a required peer. `@modelcontextprotocol/sdk` (v1) is gone.
- **Runtime:** Node 20.12 or newer (the env loader uses `util.parseEnv`).
- **zod:** consumers bring `zod` `^4.2`. mcp-core has no runtime zod dependency and never loads it; `pagedResultSchema(z, item)` takes the consumer's `z` and only references zod types (type-only import).
- **Import only through mcp-core:** see "The SDK through mcp-core" above.
- **HTTP is factory-only:** `startMcpServer` in HTTP mode requires a factory (`() => McpServer`). In SDK v2 one server instance serves one connection, so passing an instance throws. stdio accepts either form; a factory is still recommended.
- **Protocol eras:** the HTTP handler is `createMcpHandler(factory, { legacy: 'stateless' })` with the SDK default `responseMode: 'auto'`, adapted with `toNodeHandler`. A 2026-07-28 request gets one JSON body unless the handler emits progress or log notifications before its result, in which case the SDK upgrades that response to SSE. 2025-era clients are served statelessly (no session id) and receive SSE responses (the SDK's legacy path always streams). SDK clients handle both; a hand-rolled caller must accept `text/event-stream`.
- **`completable` nesting:** wrap the string first, then make it optional: `completable(z.string(), cb).optional()` returns completions. `completable(z.string().optional(), cb)` silently returns an empty list.

### Breaking changes in 3.0.0

- MCP SDK v1 (`@modelcontextprotocol/sdk`) replaced by `@modelcontextprotocol/server` and `@modelcontextprotocol/node`.
- Node 20 or newer; zod `^4.2` for consumers.
- HTTP transport accepts a server factory only; an instance throws.
- `startMcpServer` resolves with a `TransportHandle` (`{ mode, host, port, url, close() }`) once serving: in HTTP mode once the listener is bound, no longer after shutdown. Code placed after `await startMcpServer(...)` now runs at startup (a "started" log there is now correct). `handleSignals: false` leaves SIGINT/SIGTERM to the caller. `ServerFactory` receives the SDK's per-request `RequestContext` (`era`, `authInfo?`, `requestInfo?`); zero-argument factories still fit.
- Node 20.12 or newer (`util.parseEnv`).
- The `session` and `enableJsonResponse` options are removed (HTTP is stateless and JSON-first by construction).
- `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` now use the SDK's node validators: matching is by hostname only (the port is ignored; a full-origin entry is normalised to its hostname, so its scheme is ignored). A lowercase `<scheme>://*` entry (for example `chrome-extension://*`) is passed through and admits every origin of that scheme; `http://*` and `https://*` are not honoured by the SDK. A rejection is a 403 with a JSON-RPC error body (`-32000`).
- HTTP auth runs on the SDK's `verifyBearerToken`: a refused token is a 401 OAuth body (`{"error":"invalid_token",...}`, previously `{"error":"Unauthorized"}`) with a `WWW-Authenticate: Bearer` challenge; `req.auth` carries an `AuthInfo` (token placeholder `[api-key]`, never the key).
- HTTP `responseMode` is the SDK default `'auto'` (was `'json'`, which dropped progress and log notifications); the stderr warning is gone.
- `MCP_TRANSPORT` other than `stdio` / `http` throws (it used to select HTTP silently); `runMcpServer` reads the transport settings from the loaded env, exits 1 when close or dispose fails, and disposes and exits when a stdio client closes stdin.
- Defaults that cap responses: `tools/list` is paged at 100 (`MCP_LIST_PAGE_SIZE`), list-shaped tool results at 100 items (`MCP_MAX_RESULT_ITEMS`), tool results at 256 KiB (`MCP_MAX_RESULT_BYTES`), tool arguments at 10000 elements (`MCP_MAX_TOOL_INPUT_ELEMENTS`), and `paginate().collect()` at `MCP_MAX_RESULT_ITEMS` items unless `maxItems` is passed.
- `DATA_STORAGE` with an invalid value disables disk writes (it used to enable them).
- Error text sent to clients (`toolError`, `mapError` output, thrown errors, returned isError results) masks registered secret values like the logger.
- An empty or malformed POST body is answered with a 400 JSON-RPC parse error (`-32700`).
- Removed dependency overrides that only served the v1 SDK's express stack.
- HTTP client rewritten: the `axios-retry` dependency is gone (one in-house retry loop); `retries` is now `retry: { retries }`; verbs take a per-request options object (`get(path, { query })` instead of `get(path, params)`); `getPaginated` and `PaginatedResponse` are replaced by `paginate(request, strategy)`; no default `Content-Type` header (axios sets it per body, so multipart works); failures throw `HttpError`; network failures read `Network error (<code>)`.
- Retry policy unified: retryable statuses are 408, 425, 429, 500, 502, 503, 504 (501 never); `ENOTFOUND` is no longer retried and `ECONNREFUSED` only on connect; backoff is full jitter (the `jitterFactor` option is gone); `retryWithBackoff` honours `Retry-After`.
- Logger: the `output` option (`'file' | 'stderr'`) is gone. Outputs are the console switch plus the three file switches, and the log directory defaults to `<rootDir>/.logs` instead of `./logs`; pass `initLogger({ name, rootDir })`. `initLogger` now reconfigures the singleton in place instead of replacing it. Meta keys named exactly `key`, or containing `passwd`, `access_key`, `credential` or `tempauth`, are now redacted, and PII is masked on every entry.

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — agent/contributor context and working conventions
- **[docs/TESTING.md](docs/TESTING.md)** — test runner commands, conventions, and guidelines

## Installation

```bash
pnpm add @novorb/mcp-core
```

## Modules

### Logger

One logging utility for every MCP server: a console sink on stderr and three log files in the server's own repo, with rotation, text or JSON lines, secret redaction and PII masking on every entry. stdout is never written (it is the stdio protocol channel). The http-client and transport log through it too.

```typescript
import { initLogger, packageRootFrom } from '@novorb/mcp-core/logger';

// Once, at startup. rootDir = this server's package root (from src/ or dist/ alike).
const logger = initLogger({
  name: 'gitlab-mcp',
  rootDir: packageRootFrom(import.meta.url),
  captureProcessErrors: true, // optional: log crashes to exceptions.log, then exit(1)
});

logger.info('Server started', 'Server');
logger.error('Request failed', 'HttpClient', { status: 500, path: '/api/items' });
```

**Sinks and routing.** The console writes to `process.stderr`. The files live in the log directory:

| File | Receives |
|------|----------|
| `<name>.log` | every entry at or above the level (the main log) |
| `exceptions.log` | ERROR entries only |
| `debug.log` | DEBUG entries only (so only when the level is DEBUG) |

INFO and WARN go to the main log; ERROR to main and exceptions; DEBUG to main and debug. Each file rotates on its own (10 MB, 5 generations) and a failing file never affects the other sinks.

**Log directory.** `<rootDir>/.logs` by default. `LOG_PATH` in the server's `.env` (or environment) overrides it, absolute or relative to `rootDir`. Without `rootDir` and without an absolute `LOG_PATH` the file sinks stay off and `initLogger` prints one console warning; nothing is ever written relative to the current working directory. `packageRootFrom(import.meta.url)` returns the nearest ancestor holding a `package.json`, using `fileURLToPath` so Windows paths are correct.

**Switches.** An explicit `initLogger` option beats the environment, which beats the default:

| Env | Option | Default | Meaning |
|-----|--------|---------|---------|
| `LOG_LEVEL` | `level` | `INFO` | minimum level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `LOG_FORMAT` | `format` | `text` | `text` or `json` |
| `LOG_CONSOLE` | `console` | `true` | stderr sink |
| `LOG_FILE_MAIN` | `fileMain` | `true` | `<name>.log` (needs a log directory) |
| `LOG_FILE_EXCEPTIONS` | `fileExceptions` | `true` | `exceptions.log` (needs a log directory) |
| `LOG_FILE_DEBUG` | `fileDebug` | `true` | `debug.log` (needs a log directory) |
| `LOG_PATH` | `logDir` | `<rootDir>/.logs` | log directory |
| `LOG_FILE` | `logFile` | `<name>.log` | main file name; an absolute path is used as-is |

Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`; anything else is ignored. Other options: `name` (sanitised to `[A-Za-z0-9._-]`; `initLogger` throws if the main file is on, a directory exists and there is neither `name` nor `LOG_FILE`), `rootDir`, `maxLogSize`, `maxLogFiles`, `captureProcessErrors`. `logger.sinks()` returns the resolved console flag and file paths.

**Line format.**

```
2026-10-23T17:50:10.764Z | INFO  | Server | Server started
2026-10-23T17:50:10.764Z | ERROR | HttpClient | Request failed | {"status":500,"path":"/api/items"}
{"level":"ERROR","timestamp":"2026-10-23T17:50:10.764Z","component":"HttpClient","message":"Request failed","status":500,"path":"/api/items"}
```

**Process errors.** With `captureProcessErrors: true`, uncaught exceptions and unhandled rejections are logged at ERROR with context `Process` (`Uncaught exception: <Name>: <message>` or `Unhandled rejection: <reason>`, meta `{"stack":...}`) to the main log and `exceptions.log`, then the process exits with code 1. The handler is re-entrancy guarded, and an EPIPE (a crash caused by a dead stderr pipe, a synchronous EPIPE from `stderr.write`, or an EPIPE `error` event on stderr) switches the console sink off, so it is never logged back to the broken pipe in a loop.

**Reconfigure in place.** `initLogger(options)` reconfigures the existing singleton without replacing it, recomputing every setting from defaults, env and `options`. A logger obtained with `getLogger()` at module load (before init) therefore writes to the configured sinks after init. Calling `initLogger` again recomputes from scratch; `resetLogger()` drops the singleton, its process handlers and the console state (tests only).

**Tool-call helpers.** Never log tool inputs or outputs. Log tool calls through these instead (CI variable values, base64 payloads and file contents are data that key-based redaction cannot recognise):

```typescript
import { logToolCall, logToolResult } from '@novorb/mcp-core/logger';

const started = Date.now();
logToolCall('create_variable', args);
// ... run the tool ...
logToolResult('create_variable', { isError: false, durationMs: Date.now() - started });
```

Both go through the singleton and default to context `Tools` (pass a third argument to override). The text lines are stable and pinned by tests:

```
<ISO> | INFO  | Tools | Tool call: create_variable | {"tool":"create_variable","args":{"key":"[REDACTED]","value":"string(6)"}}
<ISO> | INFO  | Tools | Tool result: create_variable | {"tool":"create_variable","isError":false,"durationMs":42}
<ISO> | WARN  | Tools | Tool result: create_variable | {"tool":"create_variable","isError":true,"durationMs":7}
```

`durationMs` is rounded to an integer. `summarizeArgs(args)` produces the shape-only `args` summary and never contains a value: per top-level key `string(<len>)`, `array(<len>)`, `object{<key names, one level, max 20 then ,...+N>}`, `number`, `boolean`, `null`, `undefined`, `bigint` or `function`. Non-object args are summarised under `_args`; `null`/`undefined` give `{}`. The summary still passes through redaction, so a sensitive key name such as `key` shows `[REDACTED]` instead of its shape.

**Redaction.** Before serialising, `meta` is copied with these fields replaced by `[REDACTED]` (case-insensitive):

- Keys are matched by name segment (camelCase, snake_case, kebab-case). A key is redacted when it names a secret (`password`, `passwd`, `pwd`, `passphrase`, `secret`, `token`, `cookie(s)`, `authorization`, `bearer`, `signature`, `sig`, `credential(s)`, `tempauth`, `api`+`key`, `access`+`key`, `private`/`secret`/`signing`/`encryption`+`key`) and nothing but a value-like suffix follows (`passwordHash` and `tokenValue` are redacted; `maxTokens`, `tokenExpiry`, `signatureAlgorithm`, `credentialType`, `primaryKey` are not).
- Key is exactly `key` (so `monkey` or `keyboard` are left alone).
- Inside any string value, the message and the context: the value of a query or form parameter (after `?`, `&`, `;`, whitespace or at the start) named `key`, `api_key`, `apikey`, `access_key`, `token`, `access_token`, `refresh_token`, `id_token`, `signature`, `sig`, `password`, `secret`, `tempauth`, `client_secret` or `X-Amz-Signature` / `X-Amz-Credential` / `X-Amz-Security-Token` becomes `name=[REDACTED]`; a connection-string password becomes `scheme://user:[REDACTED]@host`; HTTP Basic credentials become `Basic [TOKEN]`.
- Limits: strings over 32768 characters are cut at a delimiter with `...[TRUNCATED <n> chars]`, subtrees deeper than 8 levels become `[DEPTH]`, cycles `[CIRCULAR]`, arrays and objects keep 200 entries, and a line over 256 KiB is cut (text) or drops its meta (json). Errors keep name, message, stack, code and cause; Date, URL, Map, Set and binary data get a readable form. In json format meta never overwrites `level`, `timestamp`, `component` or `message` (colliding keys go under `meta`). Logging never throws into the caller.

Generic keys such as `value` and `content` are deliberately not redacted (DNS record values and file contents are legitimate data). Text mode also strips CR/LF and other control characters so a logged value cannot forge a log line.

**PII masking.** After redaction, the message and every string in `meta` (recursively) are masked with typed placeholders:

| Placeholder | Matches |
|-------------|---------|
| `[EMAIL]` | email addresses |
| `[PHONE]` | international `+31 6 12345678`, `+44 (20) 7946 0958`; NANP `(555) 123-4567`, `555-123-4567`; national `06-12345678`, `020 123 4567` |
| `[CARD]` | 13 to 19 digits with optional spaces or dashes, a card issuer prefix and a valid Luhn checksum |
| `[IBAN]` | IBANs, compact or in groups of four, with a valid mod-97 checksum |
| `[JWT]` | three base64url segments starting `eyJ` |
| `Bearer [TOKEN]` | `Bearer <token>`, unless the token is a short all-lowercase word (so "Bearer authentication" stays) |
| `[IP]` | IPv4 and IPv6 (full and compressed) addresses |

ISO timestamps, clock times, version strings (`1.2.3`, `v1.2.3.4`, `3.0.0-rc.1`), plain integers, epoch milliseconds, Luhn-invalid card-shaped numbers, bad-checksum IBANs, `std::map` and MAC addresses are left alone; both the positives and these negatives are pinned by tests.

### HTTP Client

One hardened client per upstream. Build it once per process (module scope or the server's setup), not inside the per-request server factory, so the rate limiter and the connection pool are shared.

```typescript
import { createHttpClient } from '@novorb/mcp-core/http-client';

const client = createHttpClient({
  baseURL: 'https://api.example.com/v1',     // relative paths are joined onto this exactly once
  auth: { type: 'bearer', token: process.env.API_TOKEN ?? '' },
  timeout: 30_000,                            // default; per request: { timeout }
  retry: { retries: 3, maxRetryAfterMs: 30_000 },
  mapError: (e) => ({ message: `Example API error (${e.status ?? e.code}): ${e.upstreamMessage ?? 'request failed'}` }),
  logContext: 'ExampleClient',
});

const item = await client.get<Item>('/items/42', { query: { expand: 'owner' }, signal: ctx.signal });
await client.post('/items', { name: 'new' }, { idempotencyKey: crypto.randomUUID() }); // replayable POST
const raw = await client.requestRaw({ path: '/items', validateStatus: () => true }); // { status, headers, data }
const headers = await client.head('/items');
const file = await client.get<Readable>('/files/1', { responseType: 'stream', maxResponseBytes: 50 * 1024 * 1024 });
```

- **Request options** (every verb, plus `request`/`requestRaw`): `query` (null/undefined skipped, arrays per `arrayFormat`: `repeat` default, `brackets`, `comma`), `headers`, `timeout`, `signal` (cancels the request and any retry wait), `responseType` (`json` | `text` | `arraybuffer` | `stream`), `maxResponseBytes`, `validateStatus`, `retry` (overrides, or `false`), `idempotencyKey` (sent as `Idempotency-Key`, configurable via `idempotencyKeyHeader`), `logPath`.
- **Auth** (`auth`): `bearer`, `basic`, `header` (`PRIVATE-TOKEN`, `X-Api-Key`, `sso-key ...`), `query` (Trello `key`/`token`), `tokenProvider` (`getToken({ forceRefresh, signal })`, called per request; a 401 triggers one forced refresh and one replay). Every configured secret value, and every token a provider returned, is masked as `[REDACTED]` in error messages.
- **URLs:** `joinUrl` puts exactly one `/` between base and path and touches nothing else. An absolute URL (an OData next-link that already contains `/v1.0`) is used as-is, but only toward the base URL's origin or an `allowedOrigins` entry; anything else throws `ERR_ORIGIN_NOT_ALLOWED` before sending, so credentials never leave.
- **Retry:** only GET/HEAD/OPTIONS/PUT/DELETE, unless the request has an `idempotencyKey` or `retry: { unsafe: true }`. Statuses 408, 425, 429, 500, 502, 503, 504 and network errors ECONNRESET, ETIMEDOUT (incl. timeouts), EAI_AGAIN, ECONNREFUSED on connect. `Retry-After` (seconds or date) is honoured up to `maxRetryAfterMs`; otherwise full-jitter backoff. `onRetry` observes each wait.
- **TLS:** `tls: { ca }` for a private CA, `tls: { rejectUnauthorized: false }` for a self-signed test instance (an ESM `node:https` Agent).
- **Rate limit:** `rateLimit: { capacity, refillPerSecond }` (or a shared `TokenBucket`) gates every attempt.
- **Errors:** every failure is an `HttpError` with only `message`, `status`, `statusText`, `code`, `method`, `path`, `retryAfterMs`. The default message is the upstream message (GitLab `message`, Graph `error.message`, Jira `errorMessages`, `errors`, plain text; HTML ignored; 300 chars max) or `HTTP <status> <text>` / `Network error (<code>)`. `mapError(info)` receives `{ method, host, path, status, statusText, code, upstreamMessage, upstreamCode, retryAfterMs }` and returns `{ message, code }`.
- **Security:** `maxRedirects: 0`; response (streams included) and request size caps (25 MiB default, `ERR_RESPONSE_TOO_LARGE` / `ERR_REQUEST_TOO_LARGE`); errors never carry the raw response, config or headers; a broken stream surfaces a sanitized `HttpError`.
- **Logging** (mcp-core logger only): `HTTP <METHOD> <host><path template>` with `{ method, host, path, status, durationMs, attempt }`; DEBUG on success, WARN on retry and 4xx, ERROR on 5xx and network failures. Id-like path segments become `:id`; query values, headers and bodies are never logged.

**Adoption per server:**

```typescript
// GitLab: PRIVATE-TOKEN header, X-Next-Page walking, service wording.
const gitlab = createHttpClient({
  baseURL: `${process.env.GITLAB_URL}/api/v4`,
  auth: { type: 'header', name: 'PRIVATE-TOKEN', value: process.env.GITLAB_TOKEN ?? '' },
  mapError: (e) => ({ message: `GitLab API error (${e.status ?? e.code}): ${e.upstreamMessage ?? 'request failed'}` }),
});
const { items, total } = await gitlab
  .paginate<Project>({ path: '/projects', query: { search: 'core' } }, nextPageHeader({ pageSize: 100 }))
  .collect();

// Microsoft Graph: refreshing token, absolute @odata.nextLink followed as-is (no /v1.0/v1.0).
const graph = createHttpClient({
  baseURL: 'https://graph.microsoft.com/v1.0',
  auth: { type: 'tokenProvider', getToken: ({ forceRefresh }) => tokens.get(forceRefresh) },
});
for await (const site of graph.paginate<Site>({ path: '/sites', query: { search: '*' } }, nextLinkField()).items()) {
  // ...
}

// Trello: key/token query auth (masked), 100 requests per 10 s per token, `before` cursor.
const trello = createHttpClient({
  baseURL: 'https://api.trello.com/1',
  auth: { type: 'query', params: { key: process.env.TRELLO_API_KEY ?? '', token: process.env.TRELLO_TOKEN ?? '' } },
  rateLimit: { capacity: 100, refillPerSecond: 10 },
});
const actions = await trello
  .paginate<Action>(
    { path: `/boards/${boardId}/actions`, query: { limit: 50 } },
    continuationToken({ requestParam: 'before', items: (b) => (Array.isArray(b) ? b : []),
      token: (_b, page) => (page.length === 50 ? page[page.length - 1].id : undefined) }),
  )
  .collect();

// Nexus: basic auth, self-signed test instance, continuationToken, raw status handling.
const nexus = createHttpClient({
  baseURL: `${process.env.NEXUS_URL}/service/rest`,
  auth: { type: 'basic', username: process.env.NEXUS_USERNAME ?? '', password: process.env.NEXUS_PASSWORD ?? '' },
  tls: process.env.NEXUS_VALIDATE_SSL === 'false' ? { rejectUnauthorized: false } : undefined,
});
const components = await nexus
  .paginate<Component>(
    { path: '/v1/components', query: { repository: 'maven-releases' } },
    continuationToken(),
    { maxItems: 500 },
  )
  .collect();
const res = await nexus.requestRaw({ path: '/v1/status', validateStatus: () => true });

// Dependency-Track: X-Api-Key header, pageNumber/pageSize + X-Total-Count.
const dt = createHttpClient({
  baseURL: `${process.env.DEPTRACK_BASE_URL}/api`,
  auth: { type: 'header', name: 'X-Api-Key', value: process.env.DEPTRACK_API_KEY ?? '' },
});
const projects = await dt
  .paginate<DtProject>({ path: '/v1/project' },
    pagePerPage({ pageParam: 'pageNumber', sizeParam: 'pageSize', pageSize: 100, totalHeader: 'X-Total-Count' }))
  .collect();
```

### Retry

The one retry policy, shared by the HTTP client and `retryWithBackoff`: statuses 408, 425, 429, 500, 502, 503, 504 (never 501, never another 4xx) and network errors ECONNRESET, ETIMEDOUT, EAI_AGAIN, ECONNREFUSED on connect (the code and syscall are read from the error or its `cause`). A loop, never recursion; `Retry-After` honoured with a cap; otherwise full-jitter exponential backoff.

```typescript
import { retryWithBackoff } from '@novorb/mcp-core/retry';

const result = await retryWithBackoff(async (ctx) => someUnreliableOperation(ctx.attempt), {
  maxRetries: 3,          // attempts = 1 + maxRetries
  initialDelayMs: 1000,   // backoff ceiling = min(maxDelayMs, initial * multiplier^attempt), then a uniform draw
  maxDelayMs: 10_000,
  maxRetryAfterMs: 30_000, // cap on a Retry-After read from error.retryAfterMs or error.response.headers
  signal: ctx.signal,     // stop retrying (reject with the abort reason) once aborted
  shouldRetry: (err) => isRetryableError(err), // the default
  onRetry: ({ attempt, delayMs, fromRetryAfter }) => {},
});
```

`isIdempotentMethod(method)` is exported for callers that wrap their own transport: never replay a POST/PATCH without an idempotency key.

### Pagination

**Page-number helpers** for list tools: `normalizePagination` (clamps by default; `normalizePagination(params, { maxPerPage, defaultPerPage, onInvalid: 'throw' })` throws a `RangeError` instead), `createPaginationMetadata`, `pageToOffset`, `paginateArray`.

```typescript
const params = normalizePagination({ page: 3, per_page: 200 }); // { page: 3, per_page: 100 }
const { data, metadata } = paginateArray(allItems, params);
```

**Upstream strategies** for `client.paginate(request, strategy, { maxPages, maxItems })` (or `paginateRequests(fetchPage, request, strategy, options)`). The result is an async iterator of pages `{ items, pageIndex, total }` with `items()` and `collect()` (`{ items, total, pages, stopReason, truncated }`, `stopReason` = `end` | `maxPages` | `maxItems` | `repeated`). `maxPages` defaults to 100 and is never above `HARD_MAX_PAGES` (10000); `maxItems` defaults to `MCP_MAX_RESULT_ITEMS` (100) and is never above `HARD_MAX_COLLECT_ITEMS` (100000), so a walk never pulls an unbounded list into memory; a next request identical to an earlier one stops the walk (`repeated`), so a misbehaving API cannot loop forever. Set `pageSize` / `limit` at or below the API's own maximum: a server that silently caps the page (asked for 100, sends 50) makes the first page look short, and the size-based strategies then stop early (`stopReason: 'end'`) unless a total header or field is configured. A relative next link is joined onto the client's `baseURL` (root-relative links, the common case, resolve correctly).

| Strategy | Upstream shape | Stops when |
|----------|----------------|------------|
| `pagePerPage({ pageParam, sizeParam, pageSize, startPage, totalHeader, totalField, items })` | `page`/`per_page` (Dependency-Track `pageNumber`/`pageSize` + `X-Total-Count`) | empty or short page, or page * size >= total |
| `nextPageHeader({ header, pageParam, sizeParam, pageSize, totalHeader, items })` | GitLab `X-Next-Page` + `X-Total` | the header is empty or absent, or the page is empty |
| `offsetLimit({ offsetParam, limitParam, limit, startOffset, totalHeader, totalField, items })` | offset/limit | empty or short page, or offset + items >= total |
| `linkHeader({ rel, totalHeader, items })` | RFC 5988 `Link: <url>; rel="next"` | no `next` link |
| `nextLinkField({ field, totalField, items })` | Graph `@odata.nextLink` / `@odata.count` / `value` | no next link |
| `continuationToken({ requestParam, token, items })` | Nexus `continuationToken`; Trello `before` via a token function | token absent/empty, or the page is empty |

`items` is a body field name or an extractor; the default takes an array body or the first array under `value`/`items`/`data`/`results`.

**MCP-side cursors and the paged result contract** for list tools:

```typescript
import { z } from 'zod';
import { decodeCursor, encodeCursor, invalidCursorResult, pagedResultSchema } from '@novorb/mcp-core/pagination';

server.registerTool('project_list', {
  inputSchema: z.object({ cursor: z.string().optional() }),
  outputSchema: pagedResultSchema(z, Project), // { items, nextCursor?, total? }
}, async ({ cursor }) => {
  let page = 1;
  try {
    if (cursor) page = decodeCursor(cursor, { validate: isPageState }).page;
  } catch (err) {
    return invalidCursorResult(err); // isError, "Invalid cursor: <reason>"
  }
  const { items, total, hasMore } = await fetchPage(page);
  const result = { items, total, ...(hasMore ? { nextCursor: encodeCursor({ page: page + 1 }) } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});
```

Cursors are base64url JSON `{ v, d }`, versioned (`CURSOR_VERSION`), at most `MAX_CURSOR_LENGTH` (2048) chars, and validated on decode (`InvalidCursorError`). `paginateArrayByCursor(items, { cursor, limit, defaultLimit, maxLimit })` returns a `PagedResult` over an in-memory list.

### Transport

Unified transport that selects between stdio (`serveStdio`) and stateless streamable HTTP (`createMcpHandler` + `toNodeHandler`) based on the `MCP_TRANSPORT` environment variable. HTTP mode is fail-closed (refuses to start without auth unless explicitly disabled) and supports Bearer-token auth, body-size caps, and opt-in DNS-rebinding protection.

```typescript
import { startMcpServer } from '@novorb/mcp-core/transport';

// Factory (required for HTTP, recommended for stdio):
await startMcpServer(() => createServer(services));

// Server instance (stdio only; HTTP mode throws):
await startMcpServer(server);
```

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `PORT` | `8080` | HTTP listen port |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only) |
| `MCP_API_KEY` | none | Bearer token for HTTP auth (required in HTTP mode unless disabled) |
| `MCP_AUTH_DISABLED` | `false` | Set `true` to run HTTP without auth (only behind a fronting gateway) |
| `MCP_MAX_BODY_BYTES` | 4 MiB | Max accepted POST body size |
| `MCP_ALLOWED_HOSTS` | none | Comma-separated Host allowlist, matched by hostname (port ignored); enables DNS-rebinding protection |
| `MCP_ALLOWED_ORIGINS` | none | Comma-separated Origin allowlist, matched by hostname (port ignored; a full-origin entry's scheme is ignored); a lowercase `<scheme>://*` entry admits that whole scheme, `http://*` / `https://*` are never honoured; enables DNS-rebinding protection |

An unknown `MCP_TRANSPORT` value throws. Explicit options (`mode`, `port`, `host`, `apiKey`, `auth`,
`maxBodyBytes`, `allowedHosts`, `allowedOrigins`) win over the env; `runMcpServer` passes the values of
the loaded env (`transportFromEnv`). The handle's `closed` promise resolves when the transport ends
(`close()`, or a stdio client closing stdin).

#### HTTP auth

The Bearer gate is the SDK's resource-server path: `verifyBearerToken` (header parse, verifier,
`expectedResource`, `requiredScopes`, expiry) and `bearerAuthChallengeResponse` (401 `invalid_token` /
403 `insufficient_scope` with `WWW-Authenticate: Bearer ...`, `resource_metadata` when configured). The
verified `AuthInfo` is set as `req.auth`; the SDK forwards it to the factory (`RequestContext.authInfo`)
and to handlers (`ctx.http.authInfo`, `ToolContext.authInfo`), so per-tool `scopeChallenge:
requireScopes('write')` works.

- Static key: `MCP_API_KEY` (or `apiKey`) becomes `apiKeyVerifier(key, { clientId?, scopes?, ttlSeconds? })`:
  a constant-time compare (SHA-256 of both sides, `timingSafeEqual`) answering
  `{ token: '[api-key]', clientId: 'api-key', scopes: [], expiresAt: now + 3600 }`. The real key never
  reaches `AuthInfo`. Set its scopes with `auth: { apiKey: { clientId, scopes } }`.
- Pluggable: `auth: { verifier }` takes any `OAuthTokenVerifier` (for example a Keycloak JWT verifier in
  the HQ gateway); it replaces the static key and always enforces auth. `requiredScopes`,
  `resourceMetadataUrl` and `expectedResource` pass through to the SDK.
- Fail-closed is unchanged: no key, no verifier and no explicit disable refuses to start. Guard order
  is unchanged: `/health`, Bearer (401/403), path (404), Host/Origin (403), content type (415, the SDK's
  media-type essence compare: `application/json` with parameters, any case; `application/json-seq` is
  refused), body size (413), parse (400 `-32700`), dispatch.

### Server

Import MCP server-building primitives from here instead of the SDK directly, to centralise the MCP dependency.

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

  return server;
}

await startMcpServer(buildServer);
```

Prompt arguments that offer completions nest `completable` inside the optional: `completable(z.string(), cb).optional()`.

`createMcpServer(info, options?)` takes the full `Implementation` (`name`, `version`, `title`,
`description`, `websiteUrl`, `icons`) or the `(name, version, options?)` shorthand, and the SDK's
`McpServerOptions` (`instructions`, `capabilities`, `cacheHints`, `maxToolInputElements`,
`inputRequired`, `requestState`, ...) passed through, plus mcp-core's own:

| Option | Default | Effect |
|--------|---------|--------|
| `cacheHints` | `{ 'tools/list': { ttlMs: 300000, cacheScope: 'private' } }` (`DEFAULT_CACHE_HINTS`), merged under yours | 2026-07-28 clients may cache the tool list for 5 minutes (private: lists may differ per caller) |
| `maxToolInputElements` | `MCP_MAX_TOOL_INPUT_ELEMENTS`, else 10000 | Array elements + object members per `tools/call` arguments payload (SDK check, isError beyond it) |
| `listPageSize` | `MCP_LIST_PAGE_SIZE`, else 100; 0 disables | Page size of `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list` |
| `protocolLogging` | `LOG_PROTOCOL`, else false | Advertise `logging` and forward log entries as MCP notifications |

`runMcpServer({ server: { title, websiteUrl, icons, instructions, ... } })` hands the same options to
`ctx.createServer()` (with the package `name`, `version` and `description`).

#### List pagination

SDK v2's `McpServer` answers `tools/list` in one result with no cursor, and has no extension point for
it (its list handlers are installed by private methods). mcp-core pages it on the documented low-level
hook instead of forking McpServer: `paginateLists(server.server, pageSize)` decorates the instance's
public `Server.setRequestHandler`, so the list handler the SDK installs (lazily, on the first
registration) is wrapped; the wrapper calls it unchanged and returns one page plus `nextCursor`. The
list content stays the SDK's.

- On by default at 100 per page: today's largest fleet server (gitlab, 51 tools) fits on one page, so
  nothing changes for it; raise or lower it for very large surfaces such as the HQ gateway.
- Cursors are bound to the method (`{ l: 'tools/list', o: offset }`, brief B's `encodeCursor`); a
  malformed, foreign-method or out-of-range cursor answers JSON-RPC `-32602`.
- Clients: the SDK v2 client's `listTools()` (no cursor) follows `nextCursor` up to `listMaxPages`
  (default 64) in both eras (tested in memory and over HTTP); `listTools({ cursor })` returns one page.
  2025-era clients are expected to follow `nextCursor` by the spec (every list method has had
  `cursor` / `nextCursor` since 2024-11-05); a client that ignores it sees only the first 100.
- A low-level `Server` can call `paginateLists(server, n)` before its `setRequestHandler('tools/list', ...)`.
  A handler that pages a list itself must not be combined with it (`listPageSize: 0`).

**`TOOL_ANNOTATIONS` presets:** `readOnly` (lookups/searches), `idempotentWrite` (upserts), `mutableWrite` (non-idempotent writes), `destructive` (deletes/overwrites), and the same four with `openWorldHint: true` (`readOnlyOpenWorld`, `idempotentWriteOpenWorld`, `mutableWriteOpenWorld`, `destructiveOpenWorld`) for tools that reach an external API.

## Building a server (`runMcpServer` + `registerTools` + `loadEnv` + `createDataStore`)

### Minimal server

```typescript
// src/index.ts
import { z } from 'zod';
import { runMcpServer } from '@novorb/mcp-core/bootstrap';
import { createDataStore } from '@novorb/mcp-core/data-store';
import type { EnvSchema } from '@novorb/mcp-core/env';
import { packageRootFrom } from '@novorb/mcp-core/logger';
import { TOOL_ANNOTATIONS } from '@novorb/mcp-core/server';
import { defineTool, registerTools, toolResult } from '@novorb/mcp-core/tools';

export const ENV: EnvSchema = [
  { key: 'ACME_URL', type: 'url', value: 'https://api.acme.example', description: 'Acme API base URL' },
  { key: 'ACME_TOKEN', required: true, secret: true, description: 'Acme API token' },
  { key: 'ACME_PAGE_SIZE', type: 'int', value: '50', description: 'Page size for list calls' },
];

await runMcpServer({
  rootDir: packageRootFrom(import.meta.url),
  env: ENV,
  // Once per process (shared by every connection / HTTP request).
  setup: ({ env, logger, rootDir }) => ({
    api: new AcmeClient(env.get('ACME_URL'), env.get('ACME_TOKEN')),
    cache: createDataStore({ rootDir, env, logger }).jsonCache<string[]>({ name: 'projects', ttlMs: 3_600_000 }),
  }),
  // Per connection (stdio) / per HTTP request.
  create: (shared, _req, { env, info, createServer }) => {
    const server = createServer(); // createMcpServer with the package identity + the `server` options
    registerTools(
      server,
      [
        defineTool({
          name: 'acme_project_list',
          description: 'List Acme projects',
          inputSchema: z.object({ cursor: z.string().optional() }),
          annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
          requires: ['ACME_TOKEN'],
          handler: async (_args, ctx) => toolResult({ projects: await shared.api.projects({ signal: ctx.signal }) }),
        }),
      ],
      { env, serverName: info.name },
    );
    return server;
  },
  dispose: (shared) => shared.api.close(),
});
```

`runMcpServer` runs: logger init (`name` from package.json without its scope, `rootDir`) > `loadEnv` (then
the logger is reconfigured so `LOG_*` from `.env` apply) > `setup` once > transport start > ONE INFO line
`<name> started` with meta `{ version, transport, host, port, url }` after the listener is bound. It owns
SIGINT/SIGTERM: close the transport, then `dispose(shared)`, then `exit(0)` (`exit(1)` when close or
dispose failed); servers install no handlers. When a stdio client closes stdin the same shutdown runs
(`<name> stopping (transport closed)`), so an interval, pool or watcher created in `setup` cannot keep an
orphaned process alive (with `handleSignals: false` it disposes without exiting). Transport settings come
from the loaded env (`transportFromEnv`; `transport: {...}` overrides; `transport.auth.verifier` plugs a
token verifier); `strictEnv: true` throws on env validation errors. `create`'s third argument also
carries `createServer()`, a `createMcpServer` call with the package identity and `server` options.
It returns `{ info, env, shared, mode, host?, port?, url?, close() }`. If the transport cannot start (for
example HTTP without auth), `dispose` runs and the error is rethrown.

### Tools

- `registerTools(server, tools, { env?, enabled?, prefix?, serverName?, mapError? })` registers every
  definition through `McpServer.registerTool`: the SDK builds `tools/list`, validates input (a failure is
  an isError result `Input validation error: ... <field>: <message>`), validates `structuredContent`
  against `outputSchema`, and answers an unknown tool with ProtocolError `-32602`. Returns the SDK handles.
- Write each definition with `defineTool({...})` so the handler's arguments are typed from its own
  `inputSchema` (a zod 4 object, or `fromJsonSchema(...)`); `annotations` is required. Every SDK `Tool`
  field reaches the wire: `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`,
  `icons`, `_meta`. Results go through the SDK's output validation and era projection (nothing bypasses
  `registerTool`); an unknown or `disable()`d tool is the SDK's own ProtocolError `-32602`, unwrapped.
- Per call: `logToolCall` / `logToolResult` with the duration (shape only, never values). A thrown error
  becomes `toolError(mapError(err).message)` (default: the message only, secret parameters redacted, never
  a stack or a raw error object; with a `code`, `<code>: <message>`); a thrown zod / Standard Schema error
  becomes `Invalid arguments: <path>: <message>; ...`. A returned legacy `{ success: false, error }`
  envelope becomes `isError: true` (text = the envelope JSON); `{ success: true, data }` keeps its text,
  with `data` as `structuredContent` when the tool has an `outputSchema`.
- Degraded mode: a tool whose `requires` keys are not configured is still listed, and answers
  `<serverName> is not configured: set <KEYS>`. `requires` keys must be declared in the env schema.
- `ToolContext`: `signal` (pass it to outbound calls so cancellation stops upstream work), `authInfo`,
  `cursor` (the `cursor` argument when it is a non-empty string), `era` (`modern` | `legacy`),
  `clientCapabilities`, `logger`, `progress(progress, total?, message?)`, `elicit`, `elicitUrl`,
  `sample`, `listRoots` (see "Protocol features"), `tool`, `sdk` (the raw SDK context).
- `toolResult(data, { text? })`: a string is the text; an object is pretty JSON plus `structuredContent`.
  `toolError(message, details?)`: `isError: true`, details as a second JSON text block.
- Client-bound error text is masked like the log files: `toolError`, the `mapError` output, thrown
  errors, schema-issue text, the degraded-mode message and any isError result a handler returns go
  through `maskClientText` (secret query/userinfo/Basic parameters redacted, every registered secret
  value as `[SECRET]`).
- SDK protocol errors keep their code: a handler throwing `UrlElicitationRequiredError` (`-32042`, the
  2025 URL-elicitation path) reaches the client as that JSON-RPC error, exactly as the SDK's own
  `tools/call` rethrows it; every other throw becomes an isError result (the SDK does the same). An SDK
  input-required result (`inputRequired(...)`, `resultType: 'input_required'`) is passed through
  untouched.
- `scopeChallenge` (for example `requireScopes('write')`) is forwarded to `registerTool`.

#### Response limits and pagination

Every tool result is capped centrally (defaults; env in `CORE_ENV_SCHEMA`; `RegisterToolsOptions.limits`
for the server; `ToolDefinition.limits` per tool, which wins):

| Cap | Env | Default |
|-----|-----|---------|
| Items in a list-shaped result | `MCP_MAX_RESULT_ITEMS` | 100 |
| Serialized bytes per result | `MCP_MAX_RESULT_BYTES` | 262144 (256 KiB) |

- **List-shaped** = `structuredContent` of the `PagedResult` shape `{ items, nextCursor?, total? }`
  (`toolResult(page)`, `pagedResultSchema(z, Item)`). A result with more items than the cap (or than the
  client's `limit`, itself capped) is cut and carries an opaque `nextCursor`; the text block is
  regenerated from the cut page, so it never carries the full dump. The cursor resumes where the page
  stopped: it records the tool, a fingerprint of the other arguments, the offset inside the handler's
  page and the handler's own cursor for that page. The next call re-runs the handler with its own
  cursor (as `args.cursor` and `ctx.cursor`; `args.limit` arrives capped) and mcp-core serves the next
  slice, or wraps the handler's own `nextCursor` once its page is used up. Stateless: nothing is stored.
- **Never trusted:** a cursor for another tool or other arguments, a malformed one, or an out-of-range
  offset is refused with `Invalid cursor: ...` (isError). An edited offset can only address the caller's
  own result set. `paginated: true` on a definition makes cursor handling strict (only mcp-core cursors)
  and requires `cursor` and `limit` in its input schema (checked at registration):
  `inputSchema: z.object({ ..., cursor: z.string().optional(), limit: z.number().int().positive().optional() })`.
  A tool returning a `PagedResult` without `paginated` is paged too and passes foreign cursors (its own,
  from a non-paged result) through to the handler.
- **Byte cap:** a list-shaped result is first paged smaller (halving until it fits); anything still over
  the cap, and any other result, becomes an actionable isError (`<tool>: the result is N bytes, over the M
  byte limit per response; narrow the request ... or use cursor/limit`). Never a truncated body, invalid
  JSON or schema-breaking `structuredContent`. `RegisterToolsOptions.onOversize(info)` may return a
  replacement instead (the seam for a resource link once resources exist).
- Enforcement is logged by shape only: `Tool result paged: <tool>` with `{ tool, items, served, limit }`,
  `Tool result over the byte limit: <tool>` with `{ tool, bytes, maxBytes }`; never content.
- Handlers must be deterministic for a given cursor (list reads are). `paginate().collect()` in the HTTP
  client is capped at the same `MCP_MAX_RESULT_ITEMS` by default (an explicit `maxItems` up to
  `HARD_MAX_COLLECT_ITEMS`, 100000), so a tool cannot pull an unbounded upstream list into memory;
  `collect()` reports `truncated`.

### Protocol features (logging, sampling, roots, elicitation, progress, cancellation)

The 2026-07-28 revision deprecates protocol logging, sampling and roots (SEP-2577: functional for at
least twelve months, marked `@deprecated` in the SDK types) and removes server-to-client push requests
in favour of multi round-trip requests (MRTR, `inputRequired(...)`). 2025 clients still use all of
them, so mcp-core keeps them available:

| Feature | 2025-era stdio | 2025-era stateless HTTP | 2026-07-28 (stdio and HTTP) | SDK mechanism |
|---------|----------------|-------------------------|-----------------------------|---------------|
| Protocol logging | yes, `logging/setLevel` kept per connection | yes, every level (each request is a fresh instance, so a set level is not kept) | only when the request carries `_meta['io.modelcontextprotocol/logLevel']` (the v2 client's `setLoggingLevel` throws on this era) | `ctx.mcpReq.log` |
| Elicitation (form, URL) | yes (legacy shim: real server-to-client request + re-entry) | no: the instance never saw `initialize`, so no client capability is known (`unsupported`) | yes (client fulfils, retries) | `inputRequired.elicit` / `.elicitUrl` |
| Sampling | yes (shim) | no (`unsupported`) | yes | `inputRequired.createMessage` |
| Roots | yes (shim) | no (`unsupported`) | yes | `inputRequired.listRoots` |
| Progress | yes | yes (`responseMode: 'auto'` upgrades to SSE) | yes | `notifications/progress` |
| Cancellation | `ctx.signal` | `ctx.signal` | `ctx.signal` | `ctx.mcpReq.signal` |

**Protocol logging** (`LOG_PROTOCOL=true` or `createMcpServer(..., { protocolLogging: true })`, default
off): advertises the `logging` capability and forwards every mcp-core logger entry produced while a
`registerTools` handler runs (an AsyncLocalStorage scope; `runWithRequestContext(ctx, fn)` for
hand-registered handlers) as `notifications/message` with `{ message, context, meta? }` and the logger
name. The entries are exactly what the log files get (redacted, PII-masked, registered secrets as
`[SECRET]`), and the logger never carries tool inputs or outputs (`logToolCall` is shape only). Levels map
DEBUG/INFO/WARN/ERROR to `debug`/`info`/`warning`/`error`; an entry below the logger's own `LOG_LEVEL` is
never produced.

**Elicitation, sampling, roots** on `ToolContext`, era-blind over MRTR; each returns a typed
`InputOutcome` and never throws:

```typescript
handler: async ({ domain }, ctx) => {
  const answer = ctx.elicit('confirm', {
    message: `Buy ${domain}?`,
    requestedSchema: z.object({ confirm: z.boolean() }),   // the accepted content is validated against it
  });
  if (answer.status === 'pending') return answer.result;    // re-entered with the user's answer
  if (answer.status === 'unsupported') return toolError(`cannot confirm: ${answer.reason}`);
  if (answer.status !== 'accepted' || !answer.value.confirm) return toolResult('not purchased');
  return toolResult(await buy(domain, { signal: ctx.signal }));
}
```

Statuses: `accepted` (`value`), `declined`, `cancelled`, `invalid` (accepted content failing the schema),
`pending` (`result`: return it), `unsupported` (`reason`: the client did not declare the capability, or no
capabilities are known for the request). `ctx.sample(key, params)` answers the `CreateMessageResult`,
`ctx.listRoots(key = 'roots')` the `Root[]`, `ctx.elicitUrl(key, params)` `true` once accepted. For
several requests at once return `inputRequired({ inputRequests: { ... } })` yourself (from
`@novorb/mcp-core/server`) and read `ctx.sdk.mcpReq.inputResponses`.

**Progress and cancellation:** `await ctx.progress(current, total?, message?)` sends
`notifications/progress` when the client passed a `progressToken`; it is a no-op without one, once the
request is cancelled, and when the send fails. Pass `ctx.signal` to every outbound call:

```typescript
handler: async ({ projectIds }, ctx) => {
  for (const [i, id] of projectIds.entries()) {
    if (ctx.signal.aborted) break;                     // the client cancelled or disconnected
    await sync(id, { signal: ctx.signal });
    await ctx.progress(i + 1, projectIds.length, `synced ${id}`);
  }
  return toolResult({ synced: projectIds.length });
}
```

### Express adapter (`@novorb/mcp-core/express`)

For hosts that already run Express (the HQ gateway): the same stateless handler, factory and
`RequestContext` semantics as `startMcpServer`'s HTTP mode, built on `@modelcontextprotocol/express`
(`requireBearerAuth`, `hostHeaderValidation`, `originValidation`). Install `express` (`^4.18 || ^5`).

```typescript
import express from 'express';
import { mountMcpServer } from '@novorb/mcp-core/express';

const app = express();
const mcp = mountMcpServer(app, (req) => buildServer(req.authInfo), {
  auth: { verifier: keycloakVerifier, requiredScopes: ['mcp'] },   // or apiKey / MCP_API_KEY
  allowedHosts: ['gateway.internal'],
});
app.listen(8080);
// shutdown: await mcp.close();
```

Options: `path` (`/mcp`), `health` (`/health`; `false` disables, a string moves it), `apiKey` (default
`MCP_API_KEY`; `null` runs open), `auth` (as for the transport), `maxBodyBytes`, `allowedHosts`,
`allowedOrigins`, `env`. Guard order: health > Bearer (401/403 SDK challenge, `req.auth` set) >
Host/Origin (403) > 415 > 413 > 400 `-32700` > dispatch; fail-closed like the transport. A body already
parsed by an app-level `express.json()` is used as is (then that parser's limit applies).
`createMcpRouter(factory, options)` returns the router without mounting it.

### Env

```typescript
import { loadEnv, renderEnvExample, renderEnvTable } from '@novorb/mcp-core/env';

const env = loadEnv(ENV, { rootDir });       // runMcpServer does this for you
env.get('ACME_URL'); env.int('ACME_PAGE_SIZE'); env.has('ACME_TOKEN'); env.isConfigured(); env.missing;
env.getAll('SERPER_API_KEY');                // multi: KEY, KEY_1, KEY_2, ..., then KEY_<name> A-Z
env.describe();                              // names, set/unset, source; never values
```

- Precedence: real process env > `<rootDir>/.env` > the spec `value`. `MCP_ENV_FILE` (from the real env)
  points at another file (absolute or relative to rootDir); `MCP_ENV_FILE=none` disables the file (use it
  in integration tests: the harness `envFile: 'none'`). Parsed with `util.parseEnv`; no dotenv.
- Keys resolved from the file or a default are written into `process.env` (never over a set variable), so
  legacy `process.env.X` reads keep working. File keys no schema declares are not loaded and produce one
  WARN listing their names (never values).
- `CORE_ENV_SCHEMA` (merged automatically): `MCP_TRANSPORT`, `PORT`, `MCP_HTTP_HOST`, `MCP_API_KEY`
  (secret), `MCP_AUTH_DISABLED`, `MCP_MAX_BODY_BYTES`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`,
  `MCP_ENV_FILE`, the `LOG_*` switches, `LOG_PROTOCOL`, `DATA_PATH`, `DATA_STORAGE`, `MCP_LIST_PAGE_SIZE`,
  `MCP_MAX_RESULT_ITEMS`, `MCP_MAX_RESULT_BYTES`, `MCP_MAX_TOOL_INPUT_ELEMENTS`.
- An env variable set to an empty string counts as unset (the file or the default then applies and is
  written into `process.env`).
- Validation (`int`, `bool`, `url`, `enum`) errors are collected in `env.errors` by key name (no values);
  `runMcpServer` logs each as a WARN. `strict: true` throws instead.
- Every set `secret: true` value is passed to the logger's `registerSecretValues`, which masks it as
  `[SECRET]` wherever it appears in any log entry and in client-bound error text (raw and JSON-escaped).
  A secret shorter than 6 characters cannot be masked; the loader logs one WARN naming the key.
- Generated docs: `renderEnvTable(ENV)` returns the README table (key, type, required, multi, secret,
  default, description; never a secret default) and `renderEnvExample(ENV)` the `.env.example` text
  (secrets always empty). Pass `{ includeCore: true }` to include mcp-core's keys. A test can assert the
  committed `.env.example` equals `renderEnvExample(ENV)`.

### Data store

```typescript
const store = createDataStore({ rootDir, env, logger });
await store.writeFile(`downloads/${safeName(remoteName)}`, bytes);   // atomic, via resolveInside
const cache = store.jsonCache<Discovery>({ name: 'discovery', ttlMs: 3_600_000 });
const dl = await store.downloadToFile(url, 'files/report.pdf', { maxBytes: 10_000_000, timeoutMs: 30_000, signal: ctx.signal });
const refusal = store.requireEnabled('the SQLite cache');            // a toolError when DATA_STORAGE=false
```

- Directory: `DATA_PATH` (absolute, or relative to rootDir), default `<rootDir>/.data`, created lazily.
  `DATA_STORAGE=false` runs stateless: no directory is ever created, writes throw
  `DataStorageDisabledError`, `readFile` is null, `jsonCache` keeps values in memory for the process, and
  `downloadToFile` returns `{ path: null, data }` so a tool can return the content inline. An invalid
  `DATA_STORAGE` value (not a boolean) also disables writes, with one WARN. The logger's file sinks are
  separate: for a fully stateless host also set `LOG_FILE_MAIN=false`, `LOG_FILE_EXCEPTIONS=false` and
  `LOG_FILE_DEBUG=false` (or `LOG_PATH` to a writable volume).
- `resolveInside` refuses `..`, absolute segments, drive letters (`C:\x`, `C:x`), UNC and root paths, NUL,
  and symlink/junction escapes (`DataPathError`). Pass untrusted names (tool arguments, remote file names)
  through `safeName` first.
- `downloadToFile(source, relPath, { maxBytes = 50 MiB, timeoutMs = 60 s, signal, maxRedirects = 3, headers })`:
  `source` is a URL or any client as `({ signal }) => Promise<Response>`; http/https only, redirects
  bounded, caller headers dropped on a cross-origin redirect, size checked on `Content-Length` and while
  streaming, and the body read bounded by the timeout and signal even when a fetcher ignores them. The
  path is validated in both modes. Failures are `DownloadError` with `reason` `status | too-large | timeout | redirects |
  protocol | aborted | network`.
- Consumers gitignore `.data/` and `.logs/`.

### Migrating a low-level `Server` consumer

1. Replace `index.ts` with `runMcpServer({ rootDir: packageRootFrom(import.meta.url), env: ENV, setup,
   create, dispose })`. Delete dotenv, `initLogger`, the "started" log, any `process.on('SIGINT'...)`, and
   hard-coded name/version (`version.ts`): they come from `package.json`.
2. Declare `ENV` (every variable the server reads, with `required`/`secret`/`type`/`description`); move
   `config.ts` reads to `env.get(...)`. Generate the README env table and `.env.example` from it.
3. Move process-level resources (API clients, rate limiters, DB handles, caches) into `setup`; release
   them in `dispose`. `create` only builds the `McpServer` per connection/request.
4. Replace `new Server(...)` + the `tools/list` / `tools/call` handlers with `createMcpServer(info.name,
   info.version)` + `registerTools(server, TOOLS, { env, serverName: info.name })`. Each tool becomes
   `defineTool({ name, description, inputSchema: <its zod object>, annotations, requires?, handler })`;
   delete `schema.ts` (`toInputSchema`), the per-handler try/parse/catch blocks, and the raw-argument
   logging. Handlers may keep returning `{ success, data, error }` (now mapped to `isError` correctly) and
   move to `toolResult` / `toolError` over time. A tool with a hand-written JSON Schema can use
   `fromJsonSchema(schema)` as its `inputSchema`.
5. Replace the "unconfigured" branches with `requires: [...]` (tools stay listed; one uniform error).
6. Replace state-dir heuristics and file writes with `createDataStore` (`DATA_PATH`; set `DATA_STORAGE=false`
   for stateless hosts). Integration tests pass `envFile: 'none'` and `DATA_PATH: dirs.state`.
7. Wire changes: error wording becomes the SDK's for schema failures (`Input validation error: ...`), an
   unknown tool becomes ProtocolError `-32602`, and tool names and wire `inputSchema`s stay the same.

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

## Testing

```bash
pnpm test            # all suites, including examples/testing/*.example.ts against the echo fixture
pnpm run test:watch  # watch mode
pnpm run test:coverage
pnpm run docs:check  # documentation freshness
pnpm run qa:all      # full QA matrix
```

> **Windows note:** the test scripts set `NODE_OPTIONS=` inline, which is Unix shell syntax. On Windows, invoke jest directly via a bash shell. See [docs/TESTING.md](docs/TESTING.md).

## Building

```bash
pnpm run build   # tsc → dist/
```

This is an ESM package (`"type": "module"`). `tsconfig.json` is self-contained so it builds standalone.

## CI / Releasing

GitHub Actions (`.github/workflows/`):

- **CI** (`ci.yml`) — runs build + test on every push to `main` and on pull requests.
- **Publish** (`publish.yml`) — on a pushed version tag `v*`, runs build + test, verifies the
  tag matches `package.json` `version`, then publishes to the public npm registry (with provenance).

Release flow:

```bash
# 1. bump "version" in package.json (e.g. 2.1.1), commit
# 2. tag and push — the tag triggers the publish workflow
git tag v2.1.1 && git push origin v2.1.1
```

Requires the repo secret **`NPM_TOKEN`** (an npm automation/granular token with publish rights for
the `@novorb` scope) under *Settings → Secrets and variables → Actions*.

## License

[MIT](LICENSE)
