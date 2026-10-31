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
| `express` (subpath `./express` only, not in the barrel) | `createMcpRouter`, `mountMcpServer`, types `McpExpressOptions`, `McpExpressRouter` | The stateless handler + same guards on an Express app (`express` and `@modelcontextprotocol/express` are optional peers) |
| `express-peers` (internal; the error is in the barrel) | `loadExpressPeers`, `importExpressPeers`, `ExpressAdapterUnavailableError`, `EXPRESS_PEERS_MISSING` | Lazy loading of the two optional Express peers for `./express` and `./sdk/express` |
| `resources` (subpath `./resources`) | `registerResources`, `defineResource`, `defineResourceTemplate`, `enableResourceSubscriptions`, `textContents`, `blobContents`, `normalizeReadOutcome`, `resourceLink`, `embeddedResource`, `createResultSpill` | Resources and templates on `McpServer.registerResource`, 2025-era subscriptions, the oversize result spill |
| `prompts` (subpath `./prompts`) | `registerPrompts`, `definePrompt`, `normalizePromptOutcome` | Prompts on `McpServer.registerPrompt` |
| `protocol-errors` | `toProtocolError`, type `MapError` | Masked JSON-RPC errors for resources and prompts |
| `notifications` (subpath `./notifications`) | `processBus`, `setProcessBus`, `createNotifier`, `attachNotifications`, `resourceSubscriptions`, `createRuntimeSurface`, `bindToSurface`, `InMemoryServerEventBus` | The process event bus behind every transport, change notifications, runtime enable/disable |
| `task-store` (subpath `./task-store`) | `InMemoryTaskStore`, `FileTaskStore`, `createTaskStore`, `isTerminalStatus`, `TASK_STATUSES`, `TASKS_EXTENSION_ID` | Task stores (SDK PR #2782 contract + list/watch/updateContext/close) |
| `task-tools` (subpath `./task-tools`) | `registerTaskTools`, `defineTaskTool`, `enableTasks`, `declaresTasksExtension`, `toLegacyTask` | Long-running tools on MCP Tasks, both eras |
| `task-request` (internal) | `captureTaskAugmentation`, `currentTaskAugmentation` | The 2025 `tools/call` `params.task` for task tools |
| `request-state` (subpath `./request-state`) | `requestStateCodecFromEnv`, `createSealedRequestStateCodec`, `defaultRequestStateBinding`, `RequestStateError`, `RequestStateKeyError` | AES-256-GCM sealed, expiring, caller-bound requestState with key rotation |
| `bootstrap` (subpath `./bootstrap`) | `runMcpServer`, `readPackageInfo`, `transportFromEnv`, types `RunMcpServerOptions`, `RunServerOptions`, `RunningServer`, `SetupContext`, `PackageInfo` | The server entry point: logger, env, shared state once, transport, started line, signals, stdio EOF |
| `tools` (subpath `./tools`) | `registerTools`, `defineTool`, `toolResult`, `toolError`, `maskClientText`, `normalizeOutcome`, `defaultMapError`, `notConfiguredMessage`, types `ToolDefinition`, `AnyToolDefinition`, `ToolContext`, `ToolOutcome`, `ResultEnvelope` | Tool definitions onto `McpServer.registerTool` with central logging, error mapping, masking, degraded mode, result limits |
| `result-limits` (internal, used by `tools`) | `enforceResultLimits`, `decodeToolCursor`, `handlerArgs`, `argsFingerprint`, `declaresPageArgs`, types `ToolLimits`, `OversizeInfo`, `ResultEnvelope` | Item/byte caps per tool result and the stateless tool cursor |
| `credentials` (subpath `./credentials` via `src/credential-health.ts`, a pure re-export) | `CredentialRegistry`, `CredentialScope`, `processCredentials`, `setProcessCredentials`, `credentialOutcomeFromHttp`, `credentialOutcomeFromError`, `formatCredentialReport`, `runWithCredentialScope`, `currentCredentialScope`, `NoUsableCredentialError`, `CREDENTIAL_STATUSES` | Credential health: status per key name, pools + rotation, outcome recording, the per-call scope (AsyncLocalStorage) |
| `credential-checks` | `runCredentialChecks`, `registerEnvCredentials`, `DEFAULT_CREDENTIAL_CHECK_TIMEOUT_MS`, types `CredentialCheck`, `CredentialCheckContext`, `CredentialCheckResult` | Register the env's credentials and run the `check`s once at startup |
| `credential-report` | `attachCredentialReport`, `withCredentialsField`, `CREDENTIALS_META_KEY`, `CREDENTIALS_FIELD`, `CREDENTIALS_JSON_SCHEMA` | The report on a tool result (text, `_meta`, `structuredContent.credentials` + the output schema field) |
| `credential-status-tool` | `credentialStatusTool` | The ready `credential_status` tool |
| `limits` | `resolveLimits`, `DEFAULT_LIST_PAGE_SIZE`, `DEFAULT_MAX_RESULT_ITEMS`, `DEFAULT_MAX_RESULT_BYTES`, `DEFAULT_MAX_TOOL_INPUT_ELEMENTS`, `HARD_MAX_COLLECT_ITEMS` | The response caps from the env |
| `list-pagination` | `paginateLists`, `pageListResult`, `LIST_RESULT_KEYS` | `tools/list` (prompts, resources) paging over the SDK's own list handler |
| `client-input` | `createClientInput`, `requestEra`, `supportsClientFeature`, types `InputOutcome`, `ClientInput` | `ctx.elicit` / `elicitUrl` / `sample` / `listRoots` over the SDK multi round-trip flow |
| `protocol-logging` | `enableProtocolLogging`, `runWithRequestContext`, `currentRequestContext`, `protocolLoggingEnabled`, `toMcpLoggingLevel` | Opt-in forwarding of logger entries as MCP `notifications/message` |
| `sdk/*` (subpaths `./sdk/server`, `./sdk/server/stdio`, `./sdk/node`, `./sdk/client`, `./sdk/client/stdio`, `./sdk/express`) | `export *` of the matching `@modelcontextprotocol/*` package | Every SDK feature through mcp-core |
| `utils/envLoader` (subpath `./env`) | `loadEnv` (`LoadedEnv.members(key)` = set member names), `CORE_ENV_SCHEMA`, `renderEnvTable`, `renderEnvExample`, types `EnvVarSpec` (incl. the optional credential `check`), `EnvSchema`, `LoadedEnv` | Per-server env schema; the one env loader (no dotenv) |
| `utils/dataStore` (subpath `./data-store`) | `createDataStore`, `resolveInside`, `safeName`, `DataPathError`, `DataStorageDisabledError`, `DownloadError`, types `DataStore`, `JsonCache` | Disk writes under `DATA_PATH`, stateless mode, traversal-safe paths, caches, bounded downloads (URL sources through `net`) |
| `net` (subpath `./net`) | `guardedFetch`, `createGuardedAgent`, `guardedLookup`, `checkUrl`, `isPublicAddress`, `addressPolicy`, `normalizeOrigins`, `GuardedFetchError`, `ADDRESS_BLOCKED_CODE` | The SSRF guard for caller- or upstream-supplied URLs |
| `url-path` (subpath `./url-path`) | `pathSegment`, `buildPath`, `joinPath`, `InvalidPathSegmentError` | Caller values as exactly one upstream URL path segment |
| `server` | `createMcpServer`, `DEFAULT_CACHE_HINTS`, `McpServer`, `Server`, `completable`, `fromJsonSchema`, `inputRequired`, `requireScopes`, `ProtocolError`, `ProtocolErrorCode`, `UrlElicitationRequiredError`, `OAuthError`, `OAuthErrorCode`, `TOOL_ANNOTATIONS`, types `CreateMcpServerOptions`, `Implementation`, `McpServerOptions`, `AuthInfo`, `OAuthTokenVerifier`, `ScopeChallengeHandler`, `ServerContext`, `InputRequiredResult`, `McpCallToolResult`, `McpToolAnnotations` | McpServer factory (Implementation + options, cache hints, input cap, list pagination, protocol logging), annotation presets, the curated SDK re-exports |
| `testing` (`src/testing/`, subpath `./testing` only) | integration: `startBuiltServer`, `createIsolatedDirs`, `readLogFiles`, `logLevels`, `findLeaks`, `collectStrings`, `callToolJson`, `listToolNames`, `captureToolWire`, `toolCoverage`, `assertToolCoverage`, `rawHttp`, `mcpPostHeaders`, `initializeRequestBody`, `freePort`, `killAndWait`, `minimalOsEnv`; unit: `connectInMemory`, `withInMemoryClient`, `callToolInMemory`, `captureToolCall`, `expectToolSuccess`, `expectToolError`, `expectSchemaRejection`, `expectUnknownTool`, `makeRecordingServer`, `createTestClient` | Test harness for consumer unit and integration suites (see "Testing harness") |

## SDK v2 (version 3.0.0)

- Runtime deps: `@modelcontextprotocol/server ~2.4.0`, `@modelcontextprotocol/node ~2.1.2`,
  `@modelcontextprotocol/client ~2.4.0` (patch ranges; a minor SDK release is adopted deliberately). `node` is a
  separate release line with a peer on `server`, so a newer `node` patch can demand a newer `server` minor: check
  that peer against these ranges when moving either.
  `express ^4.18 || ^5` and `@modelcontextprotocol/express ~2.0.2` are OPTIONAL peers (dev deps here),
  loaded lazily only by `src/express.ts` and `src/sdk/express.ts` through `src/express-peers.ts`; never
  import either statically anywhere else. Node >= 20.12 (`util.parseEnv` in the env loader).
  Consumers bring `zod ^4.2`; mcp-core has no runtime zod dependency and `src/` never imports zod
  (`pagedResultSchema` takes the caller's `z` through a structural contract).
- **Consumers use the SDK only through mcp-core.** The curated `@novorb/mcp-core/server` is the
  recommended entry; `@novorb/mcp-core/sdk/{server,server/stdio,node,client,client/stdio,express}` are full
  `export *` re-exports for everything else. Never import `@modelcontextprotocol/*` in a consumer (tests
  included: `@modelcontextprotocol/client` becomes `@novorb/mcp-core/sdk/client`), never add a v1
  `@modelcontextprotocol/sdk` import. This is a documented rule, not a mechanical import-scanning test.
- **The SDK docs lead.** Where mcp-core differs from the SDK's documented practice, the reason is written
  next to the code and in `docs/` (current list: own `node:http` server instead of the Express adapter by
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
throws) and resolves with a `TransportHandle` (`{ mode, host?, port?, url?, closed, bus, notify, close() }`) once
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
  for servers, a fixed guard order, and `/health`. Hosts that run Express use `./express`, which keeps
  the same guards and order.
- `GET /health` → `{"status":"healthy"}` (no auth).
- `POST /mcp` is handled by the SDK handler; a legacy `GET /mcp` answers 405. An empty or malformed
  POST body answers 400 JSON-RPC `-32700`.
- Request order: `/health`, Bearer check (401), path (404), Host/Origin guards (403), content type
  (415), body size (413), parse and dispatch; a handler throw is a 500 with no detail.
- Errors from the SDK and stdio go to the mcp-core logger (`getLogger().error`). On Express, `onError` replaces that
  destination for every request error, including an `authenticateRequest` fault (a refusal is not reported).
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
- Express only: `authenticateRequest(req) => AuthInfo` is for a host whose own middleware already
  authenticated the request (a token verifier never sees `req`); it replaces the Bearer gate, must throw
  for an unauthenticated request (the throw answers the SDK challenge response), and combining it with
  `apiKey` or `auth.verifier` throws at construction.
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
- A tool with `envelope: { key, hint? }` carries its payload under `structuredContent[key]`: the item cap
  refuses (never pages) an array or PagedResult payload over `MCP_MAX_RESULT_ITEMS`, a text block that only
  repeats the payload is counted once in the byte cap, and `hint` replaces the cursor advice in both refusals.
- Tool cursors are stateless and validated (tool + argument fingerprint + offset + the handler's own
  cursor); refuse anything else with `Invalid cursor: ...`.
- An argument named `limit` is clamped to `MCP_MAX_RESULT_ITEMS` on every tool. A non-strict (not
  `paginated`) tool receives a foreign cursor raw as `args.cursor`; its handler validates it. Limits come
  from the `env` passed to `registerTools`, with `process.env` only as the no-env fallback.
- Protocol logging forwards logger entries (already redacted) through `ctx.mcpReq.log` inside the
  `registerTools` request scope; never forward tool inputs or outputs. Off unless `LOG_PROTOCOL`.
- Elicitation, sampling and roots go through the SDK's `inputRequired` (MRTR + legacy shim), never the
  push APIs; unsupported clients get a typed outcome, never a throw.

### Resources, prompts, notifications, tasks, requestState

- **Stay on the SDK** here too: `registerResources` / `registerPrompts` wrap `registerResource` /
  `registerPrompt`; never re-implement listing, template matching, completion or the not-found error.
  Their failures are JSON-RPC errors through `toProtocolError` (masked), not isError results.
- **One process bus** (`processBus()`) feeds every transport (`bus` option to override). Anything that
  subscribes per server instance (a surface binding, a stdio forwarder, a task status watcher) unsubscribes
  in the instance's `onclose`; per-request HTTP instances are closed by the SDK, and
  `tests/resources.test.ts` pins that no surface subscription outlives its request.
- **Tasks:** principals isolate (a foreign caller gets "not found", never "forbidden"). The file store is
  shared across processes on one host: cancellation and `tasks/update` answers reach the running work
  through the per-task poll, and an input round id keeps a waiter from taking an earlier round's answers.
  Task work is detached; its settle path must never produce an unhandled rejection.
- **requestState** is never handed out unverified: without a codec `ctx.requestState()` is undefined.
  `MCP_REQUEST_STATE_KEY` is at least 32 bytes and registered with the logger mask.
- **Result spill** is in memory and bounded by `maxEntries` and `maxTotalBytes` (oldest dropped first).

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
  throws `HttpError` carrying only status/statusText/code/method/path/retryAfterMs plus the masked
  credential facts (`description`, the parsed `challenge` `error` / `error_description`), never the raw
  axios `response`, `config` or headers (they hold the auth token). Stream errors are re-wrapped for the same
  reason (axios emits a raw AxiosError on the stream).

## HTTP client, retry, pagination

- **One retry policy** (`src/retry.ts`) used by `retryWithBackoff` and the client: 408, 425, 429, 500,
  502, 503, 504; ECONNRESET, ETIMEDOUT, EAI_AGAIN, ECONNREFUSED with syscall `connect`. Retry-After
  honoured up to `maxRetryAfterMs`, else full jitter. Do not add a second policy or `axios-retry` back.
- **One `requestRaw` core** in `McpHttpClient`; the verbs are thin wrappers. Add capability there.
- **URLs:** `joinUrl` joins once; absolute URLs are used as-is (an OData next-link already contains
  `/v1.0`, so re-joining would give `/v1.0/v1.0`), gated by the origin allowlist.
- **Logging** goes through the logger only: `{ method, host, path, status, durationMs, attempt }` (+
  `code`, `delayMs` on retry); the path is `templatePath`'d. Never log query values, headers or bodies.
  `templatePath` FAILS CLOSED: without a matching template every request-path segment is `:id` except a
  leading API prefix/version (`api`, `rest`, `v4`, `v1.0`, or a bare 1-2 digit number like Trello's `/1/`;
  never 3+ digits); the base URL path keeps only its API words and
  versions. Readable lines come only from explicit templates (client `routes`, request `logPath`). Never
  reintroduce a heuristic that keeps a dynamic segment: names, tag names, variable keys and file names
  must never reach a log line or `HttpError.path` (security regressions in `tests/http-client.test.ts`,
  including the review examples `/user/alice`, `/repos/acme/secretrepo`).
- **Pagination** (`src/pagination.ts`): strategies are pure `{ first, parse }` objects; `paginateRequests`
  owns the caps (default 100 pages, `HARD_MAX_PAGES` 10000) and the repeated-request loop guard.
  `pagination.ts` only type-imports `http-client` and imports no zod (`pagedResultSchema(z, item)` takes the
  consumer's `z` through the structural `PagedResultZod`, so a consumer on another zod 4.x copy typechecks).
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
`docs/building-a-server.md`. Rules for changing these modules:

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
  regressions (tests/utils/dataStore.test.ts); keep them failing-if-reintroduced. Atomic writes rename
  through `renameWithRetry` (win32 retries EPERM/EACCES/EBUSY for up to about 2 s: a poller or AV holding
  the target open is normal there, and the file task store relies on it).
- **Outbound URLs a server did not configure go through `net`** (`guardedFetch`). Keep the guarantees
  failing-if-reintroduced (tests/net.test.ts): the address policy runs inside the socket lookup on every
  resolved address (never check-then-connect), each request has its own agent (never the global one: the
  env-proxy child test pins it), every redirect hop is re-validated, IP literals are checked before
  sending (Node skips the lookup for them). `allowPrivate` stays an explicit opt-in. The data store's URL
  sources use it by default; a function source is the caller's own client. The http-client is not
  guarded (its base URL is operator config; absolute next-links are origin-gated instead).
- **Caller values in upstream paths go through `url-path`** (`pathSegment` / `buildPath` / `joinPath`):
  `encodeURIComponent` alone lets `.`/`..` collapse. A value is judged as the most lenient upstream reads
  it: lenient (overlong-accepting) percent decoding, three rounds, each form also NFKC-normalised, C0/C1
  controls and U+2028/U+2029 refused. Never write a non-ASCII character or its `\u` escape into a regex
  literal here (compare code units). `InvalidPathSegmentError` names the argument, never the value, and
  `registerTools` returns it as the isError text before `mapError` runs.
- **guardedFetch caps are validated** (a non-finite or negative cap is a TypeError); with redirects
  refused every 3xx is refused.
- **Degraded mode text is uniform:** `<serverName> is not configured: set <KEYS>` for every server.

### Credential health

Rule: a credential is checked ONCE at env load; after that a degraded, invalid or expired key
must never crash the server or turn a tool call into an error on its own. Every result that touched a
credential reports which keys were used and which are unhealthy. API and example in
`docs/credentials.md`. Rules for changing it:

- **Names only, never values**, in logs, results, `_meta`, snapshots and the status tool. Only DECLARED
  names are accepted: `record`/`use`/`set`/`members([...])` and the http-client `credential` option throw
  `UnknownCredentialError` (message without the identifier) for anything else, before anything is
  recorded or sent. Every report copy (text, `_meta`, `structuredContent`) and every reason is masked.
  A spec with a `check` is a secret (`isSecret`). Regression tests assert no value appears anywhere.
- **No key is lost for good.** Invalid and expired keys rank last but stay candidates (a single-key pool
  keeps trying; a success restores the key), and the startup check runs again as a background probe
  after `MCP_CREDENTIAL_RECHECK_MS` (default 300000). A degraded key returns to `unknown` once its
  retry-after elapses. Keep the HTTP mapping status-gated: body words count only on 401/402/403/429, a
  plain 403 never changes a key, 400/413/422 never do. The classified text is the code, the message, the
  OAuth `error_description` (kept apart by the http-client: GitLab's `error: "invalid_token"` comes first)
  and ONLY the `error` / `error_description` parameters of `WWW-Authenticate` (`parseAuthChallenge`
  tokenises the header, quoted strings are never searched; the 403 `invalid_token` check reads the parsed
  `error` only), joined with ` ; ` so a pattern never spans two fields. The client records and the thrown
  `HttpError` carries the same facts, so `credentialOutcomeFromError` agrees with what was recorded
  (`withFallback` re-classifies and the last write wins).
- **Never fatal.** A check throw, timeout or network error is `unknown`, and `runMcpServer` wraps the whole
  registration + checks in a try/catch (one WARN). Checks run after the env load and before `setup`, at
  most 4 at a time, bounded per check (`MCP_CREDENTIAL_CHECK_TIMEOUT_MS`), skipped with
  `MCP_CREDENTIAL_CHECKS=false`.
- A check reads sibling values (multi-part credentials) only through `ctx.get(key)`, which accepts declared
  schema keys and multi members only. The spec's `covers: [...]` lists the sibling parts: the registry
  (`cover(key, parts)`, wired by `registerEnvCredentials`) applies every status change of the primary
  (check, re-check, recorded outcome) to each covered part with the same reason. Undeclared or unset
  covers are skipped at registration; `cover()` itself throws `UnknownCredentialError`.
- **Which keys are credentials:** every spec with a `check`, plus a server's own `secret` keys (not
  mcp-core's `CORE_ENV_SCHEMA` secrets). Each `multi` member is its own credential, pooled under the
  base key.
- **One registry per process** (`processCredentials()`), like the process bus; a call scope
  (`CredentialScope`, opened by `registerTools` per call in an AsyncLocalStorage) is how the
  http-client's `credential` option reaches the report. `credentials.ts` must not import the
  http-client at runtime (the http-client imports it).
- **HTTP mapping is one function** (`credentialOutcomeFromHttp`); do not classify statuses anywhere else.
- **Transitions log once per change** (`Credential <KEY>: <from> -> <to>`); startup results are one
  summary line (registry `set(..., { silent: true })`).
- The report is appended after `enforceResultLimits` (the paged shape must stay intact), but its bytes
  are subtracted from the byte cap first, so the final result stays under it. An input-required result
  carries it in `_meta` only. The output schema wrapper strips `credentials` before the tool's own
  schema validates, so strict schemas pass; it is applied only to an object root with `properties`, and
  `structuredContent.credentials` is added only when the wrapper was applied.
- Outcomes go to the scope active where a request starts (AsyncLocalStorage): a shared in-flight
  promise reports its key on the starting call only.

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
- Run tests with `node bin/mcp-core-jest.mjs` (`--coverage` for the 85% gate; it sets
  `--experimental-vm-modules` portably). The same file ships as the `mcp-core-jest` bin for consumers:
  it resolves the consumer's jest from cwd, so never add jest as a runtime dependency here. Keep it
  dependency-free plain ESM (it runs before any build). It never forwards SIGINT (the terminal delivers
  it to jest; the launcher waits) and forwards SIGTERM/SIGHUP on POSIX only (on Windows `child.kill` is
  TerminateProcess).
- ESM package (`"type": "module"`). `tsconfig.json` is self-contained (no `extends`) so it builds standalone.
- Node version is pinned in `.nvmrc`. Uses pnpm; when the checkout sits inside another pnpm workspace, run it as
  `corepack pnpm <cmd> --ignore-workspace` (install: `corepack pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace`),
  so the parent workspace is never touched.
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
- `express` (`tests/express.test.ts`): a real Express app, both eras, every guard, the fail-closed rule
  and the host `authenticateRequest` gate (incl. the refusal to combine it with a key or verifier).
- `list-pagination`, `result-limits`, `client-input`, `protocol-features`: paging both eras (memory and
  HTTP), every result cap, cursor round-trip and tampering, elicitation/sampling/roots through MRTR and the
  legacy shim, protocol logging per era, progress over HTTP, `requireScopes` end to end.
- `sdk-subpaths`: the `./sdk/*` re-exports reach their SDK entry points.
- `resources`, `prompts`, `request-state`, `task-store`, `tasks`, `features.roundtrip`: reads, templates,
  completion, the read cap, degraded mode, subscriptions per era, listen streams over HTTP, the runtime
  surface (and no leaked subscription per HTTP request), the result spill (owner binding, expiry, entry and
  total byte budgets); prompts end to end; requestState tamper / expiry / binding / rotation; both task
  stores incl. cross-process cancel and input; task tools in both eras incl. per-caller isolation over
  HTTP and a failing store write while settling; a round trip with the `@modelcontextprotocol/ext-tasks`
  requester.
- `transport.roundtrip`: real v2 `Client` round-trips, built on the testing harness, over stdio and HTTP
  (child processes running `tests/fixtures/echo-server.ts` via `startBuiltServer`), in memory
  (`connectInMemory`) and HTTP in-process (keeps `startHttp` under coverage), in both protocol eras,
  plus the real Host/Origin allow-list semantics.
- `testing` (`tests/testing/*.test.ts`): real stdio and http starts of the fixture in isolated dirs
  (explicit env, stop idempotency, startup failures carry stderr, 401/404/413/415, logs written by the
  real logger and scanned for leaks), every unit helper, the SDK v2 outcome pins (schema rejection =
  isError result, unknown tool = thrown -32602), `findLeaks`, `readLogFiles`, coverage helpers.
- `examples/testing/*.example.ts`: the shipped consumer example suites, run against the echo fixture.
  `tests/setup-env.ts` stands in for the credential they read.
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
- `credentials`, `credential-checks`, `credential-report` (`tests/credentials.test.ts`,
  `tests/credential-checks.test.ts`, `tests/credential-report.test.ts`): rotation (invalid/expired last,
  never dropped), re-check probes, degraded back to unknown after the retry-after (injected clock),
  undeclared names refused, every status-gated HTTP outcome mapping (incl. GitLab's expired token via
  `error_description` and the `WWW-Authenticate` parameters, revoked stays invalid, the realm ignored), transitions logged once, masked reasons, the scope report and `withFallback`; startup checks
  (valid, invalid, thrown `HttpError`, timeout -> unknown, the switch off, multi members on their own,
  a real `ctx.http` probe), values never in logs; the schema wrapper and the report shapes. The report
  end to end (text + `_meta` + outputSchema field, the all-invalid isError, automatic http-client
  recording) is in `tests/tools.test.ts`; the server starting when every check fails and the status tool
  in `tests/bootstrap.test.ts`; the `credential` request option in `tests/http-client.test.ts`.
- `jest-runner` (`tests/jest-runner.test.ts`): the `mcp-core-jest` bin against a fake consumer jest:
  the flag, argument passthrough, exit code, a hoisted jest, missing jest; signal exit, SIGTERM
  forwarding and SIGINT not forwarded (POSIX only, skipped on win32).
- `utils/envLoader`: precedence, `MCP_ENV_FILE` (relative, absolute, none, missing), multi ordering,
  validation by key without values, strict, `describe()` never carrying a value, the unknown-key WARN
  (names only), secrets masked in logs, `renderEnvTable` / `renderEnvExample`.
- `utils/dataStore`: default dir and lazy creation, `DATA_PATH`, `DATA_STORAGE=false` writing nothing,
  in-memory `jsonCache`, every traversal form (POSIX, Windows `..\`, drive letters, UNC, NUL, junction
  escape), `safeName`, atomic writes, download size/time/redirect caps, cross-origin header drop, inline
  bytes when disabled; the SSRF guard on URL sources by default (private literal and name refused, never
  connecting, a redirect hop re-validated, origins and content types), `allowPrivate` for the local servers.
- `net` (`tests/net.test.ts`, child `tests/fixtures/net-proxy-child.ts` run with `node --import tsx`):
  every refused and allowed address range, the URL policy, the DNS seam (all addresses, empty answer,
  resolver failure), redirects refused / capped / re-validated per hop / headers dropped across origins,
  size, time (head and body), abort (before, head, body), content types, https lookup, multi-family
  wording, `createGuardedAgent` with `http.get`, and NODE_USE_ENV_PROXY with a recording proxy (http and
  https: refused, the proxy sees nothing).
- `url-path` (`tests/url-path.test.ts`): encoding, every dot-segment and encoded form, control
  characters raw and encoded, the message never echoing the value; the isError through `registerTools`
  is in `tests/tools.test.ts`.
- `retry`: the pinned status and network-code sets (501 and plain 4xx never), ECONNREFUSED connect-only,
  full-jitter bounds, Retry-After seconds/date/cap, bounded attempts, abort before, during and between
  attempts.
- `rate-limiter`: burst, refill, FIFO waiting, an aborted waiter not stalling the queue.
- `pagination`: every strategy against recorded response shapes (Dependency-Track, GitLab, offset/limit,
  Link header, Graph, Nexus, Trello) incl. each stop condition, the page caps, `maxItems`, the repeated
  next-link loop guard, cursor round-trip and every bad-cursor error, `pagedResultSchema` with real zod.

## Testing harness (`@novorb/mcp-core/testing`)

The API tables and a consumer example are in `docs/testing-harness.md`. Rules for changing it:

- **Separate subpath only.** `src/testing/` may import `transport`/`server` types, never the reverse;
  `src/index.ts` does not re-export it. `@modelcontextprotocol/client` is a regular dependency (also
  re-exported as `./sdk/client`).
- **Runner agnostic.** No jest/vitest imports in `src/testing/`; return objects, throw `Error`s.
- **Host agnostic and Windows-safe.** No host-specific paths; spawn `process.execPath` with `shell: false`; teardown
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
| [README.md](README.md) | Overview only; user-facing detail belongs in `docs/`, one page per area, and every page is mapped in `docs-freshness.json` |
| [docs/api-reference.md](docs/api-reference.md) | Every import path and its exports; update it when an export changes |
| [docs/testing.md](docs/testing.md) | Test runner commands, conventions, and guidance for adding tests |
