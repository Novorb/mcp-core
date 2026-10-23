# Mcp core

Shared TypeScript package (`@novorb/mcp-core`) of foundational utilities for building MCP
(Model Context Protocol) servers: logging, an HTTP client, retry/backoff, pagination, a unified
stdio/HTTP transport, and an `McpServer` factory.

## Modules

| Module | Exports | Purpose |
|--------|---------|---------|
| `logger` | `initLogger`, `getLogger`, `Logger`, `LogLevel` | File/stderr logging with rotation and secret redaction |
| `http-client` | `createHttpClient` | Hardened axios wrapper with retry, logging, and pagination |
| `retry` | `retryWithBackoff`, `isRetryableError` | Exponential backoff with jitter |
| `pagination` | `normalizePagination`, `createPaginationMetadata`, `paginateArray` | Pagination helpers |
| `transport` | `startMcpServer`, `createRequestHandler`, `bearerMatches`, `resolveHttpAuth`, `TransportMode`, `TransportOptions`, `ServerFactory`, `ServerOrFactory`, `McpRequestHandler` | Unified stdio / stateless Streamable HTTP transport |
| `server` | `createMcpServer`, `McpServer`, `Server`, `completable`, `fromJsonSchema`, `ProtocolError`, `ProtocolErrorCode`, `TOOL_ANNOTATIONS`, types `McpCallToolResult`, `McpToolAnnotations` | McpServer factory, annotation presets, SDK re-exports |

## SDK v2 (version 3.0.0)

- Runtime deps: `@modelcontextprotocol/server ^2.3.1`, `@modelcontextprotocol/node ^2.1.1`. Node >= 20.
  Consumers bring `zod ^4.2`; mcp-core has no runtime zod dependency and `src/` never imports zod.
- **Import SDK types and symbols only through mcp-core** (`@novorb/mcp-core/server`). Never import from
  `@modelcontextprotocol/*` in a consumer, and never add a v1 `@modelcontextprotocol/sdk` import.
  Low-level consumers get `Server`, `fromJsonSchema`, `ProtocolError`, `ProtocolErrorCode` from there too.
- **HTTP is factory-only.** One SDK v2 server instance serves one connection, so an instance passed to
  `startMcpServer` in HTTP mode throws. stdio accepts an instance or a factory.
- **`completable` nesting:** `completable(z.string(), cb).optional()` returns completions;
  `completable(z.string().optional(), cb)` silently returns an empty list. Pinned by tests.
- Removed options: `session` and `enableJsonResponse`.
- The SDK prints a `responseMode: 'json'` warning to stderr at every HTTP start; expected.
- SDK subpaths used: `@modelcontextprotocol/server` (`createMcpHandler`, `McpServer`, ...),
  `@modelcontextprotocol/server/stdio` (`serveStdio`), `@modelcontextprotocol/node` (`toNodeHandler`,
  `hostHeaderValidation`, `originValidation`). Tests also use `@modelcontextprotocol/client` (dev).

## Transport

`startMcpServer` selects the transport from `MCP_TRANSPORT` (`stdio` by default, or `http`). stdio uses
`serveStdio`; SIGINT/SIGTERM close the handle and re-raise the signal when no other listener remains.
HTTP mode uses `createMcpHandler(factory, { legacy: 'stateless', responseMode: 'json' })` adapted with
`toNodeHandler`, behind mcp-core's own `node:http` server. Each request is independent with no session
state, which suits scale-to-zero hosts.

- Clients on protocol 2026-07-28 get JSON responses. 2025-era clients are served statelessly and get
  SSE responses (the SDK legacy path ignores `responseMode`).
- `GET /health` → `{"status":"healthy"}` (no auth).
- `POST /mcp` is handled by the SDK handler; a legacy `GET /mcp` answers 405. An empty or malformed
  POST body answers 400 JSON-RPC `-32700`.
- Request order: `/health`, Bearer check (401), path (404), Host/Origin guards (403), content type
  (415), body size (413), parse and dispatch; a handler throw is a 500 with no detail.
- Errors from the SDK and stdio go to the mcp-core logger (`getLogger().error`).
- Listens on `PORT` (default `8080`), binding `MCP_HTTP_HOST` (default `0.0.0.0`; set `127.0.0.1` for local-only).

### Auth

HTTP mode is fail-closed: it refuses to start unless auth is explicitly configured.

- `MCP_API_KEY` — Bearer token required on `/mcp`; compared in constant time (`crypto.timingSafeEqual` over SHA-256 digests).
- `MCP_AUTH_DISABLED=true` — run open, only when a gateway/platform fronts authentication. A missing or
  empty `MCP_API_KEY` is treated as "not configured" and throws, rather than silently serving the
  endpoint unauthenticated.
- `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` — comma-separated allowlists; setting either enables the
  SDK node validators (`hostHeaderValidation`/`originValidation`). Matching is by hostname only (port
  ignored, Origin scheme ignored); `host:port` and full-origin entries are normalised to hostnames.
  Rejection is a 403 with a JSON-RPC body (`-32000`). Only `/mcp` is guarded.
- `MCP_MAX_BODY_BYTES` — POST body cap (default 4 MiB → `413`); `POST /mcp` requires
  `Content-Type: application/json` (→ `415`).

### Logger & HTTP-client hardening

- The logger redacts sensitive-keyed `meta` fields (authorization, token, api_key, secret, password,
  cookie, …) to `[REDACTED]` before serialising, and strips CR/LF in text mode so logged values can't
  forge log lines.
- `http-client` sets `maxRedirects: 0` and response/body size caps, retries `429`/`5xx` only for
  idempotent methods (never replays POST/PATCH), and normalized errors carry only `status`/`statusText`
  — never the raw axios `response` (whose config/headers hold the request's auth token).

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
   audit. The only protocol dependencies are `@modelcontextprotocol/server` and `@modelcontextprotocol/node`,
   used in `transport` and `server`.

## Working here

- Source is in `src/`, tests in `tests/` — one test file per module.
- Build with `pnpm run build` (runs `tsc`).
- Run tests with `NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest`.
- ESM package (`"type": "module"`). `tsconfig.json` is self-contained (no `extends`) so it builds standalone.
- Node version is pinned in `.nvmrc`. Uses pnpm; install with `pnpm install --frozen-lockfile --ignore-scripts`.
- Type mocks precisely (`jest.fn<Signature>()`, `jest.Mock<T>`, real SDK/axios types) — no `any` in tests.
- Local consumer link: from a consumer dir, `pnpm add @novorb/mcp-core@link:<relative path to this package>`
  (the consumer resolves `dist/`, so run `pnpm run build` here first). Do not use `pnpm link --global`.

## Testing

Every module has a test file under `tests/` and every exported function is covered (ESM `ts-jest`),
with coverage **enforced at 85%** (statements/branches/functions/lines) via `jest.config.js`. Beyond
behavior, the suite includes **security regression tests** that assert a vulnerability's *absence*:

- `logger` — levels, file/stderr output, text/json formats, rotation, env config; **redaction** of
  sensitive-keyed `meta` (incl. a raw axios-error object) and CR/LF stripping.
- `http-client` — every verb (`get`/`getPaginated`/`post`/`put`/`patch`/`delete`) + the factory; the
  hardened axios config (`maxRedirects: 0` + size caps), `normalizeError` not leaking the raw response,
  idempotent-only `429`/`5xx` retries, and per-verb error paths.
- `transport` — stdio mode, options; **fail-closed** auth resolution (throws when unconfigured) and the
  **constant-time** Bearer comparison; `createRequestHandler` routing (`/health`, `401`, `415`, `413`,
  `404`, `500`, and `/mcp` dispatch) driven with mock `req`/`res`, with the SDK entry points mocked.
- `transport.roundtrip`: real v2 `Client` round-trips over stdio (child process running
  `tests/fixtures/echo-server.ts`) and HTTP (in-process), in both protocol eras, plus the real
  Host/Origin allow-list semantics.
- `server`: `createMcpServer` factory, the `TOOL_ANNOTATIONS` presets, the SDK re-exports, and the
  `completable` nesting pins.
- `retry` — backoff/jitter, `isRetryableError`, `parseRetryAfter`, `retryWithBackoff`.
- `pagination` — `normalizePagination`, `createPaginationMetadata`, `paginateArray`.

## Documentation

| File | Description |
|------|-------------|
| [docs/TESTING.md](docs/TESTING.md) | Test runner commands, conventions, and guidance for adding tests |
