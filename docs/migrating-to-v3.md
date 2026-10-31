# Migrating to 3.0

## Breaking changes in 3.0.0

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
- `@modelcontextprotocol/express` moved from a dependency to an optional peer: an Express host adds `express` and `@modelcontextprotocol/express` itself.
- HTTP client rewritten: the `axios-retry` dependency is gone (one in-house retry loop); `retries` is now `retry: { retries }`; verbs take a per-request options object (`get(path, { query })` instead of `get(path, params)`); `getPaginated` and `PaginatedResponse` are replaced by `paginate(request, strategy)`; no default `Content-Type` header (axios sets it per body, so multipart works); failures throw `HttpError`; network failures read `Network error (<code>)`.
- Retry policy unified: retryable statuses are 408, 425, 429, 500, 502, 503, 504 (501 never); `ENOTFOUND` is no longer retried and `ECONNREFUSED` only on connect; backoff is full jitter (the `jitterFactor` option is gone); `retryWithBackoff` honours `Retry-After`.
- Logger: the `output` option (`'file' | 'stderr'`) is gone. Outputs are the console switch plus the three file switches, and the log directory defaults to `<rootDir>/.logs` instead of `./logs`; pass `initLogger({ name, rootDir })`. `initLogger` now reconfigures the singleton in place instead of replacing it. Meta keys named exactly `key`, or containing `passwd`, `access_key`, `credential` or `tempauth`, are now redacted, and PII is masked on every entry.

## Migrating a low-level `Server` consumer

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
