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
| `transport` | `startMcpServer`, `TransportMode`, `TransportOptions` | Unified stdio / stateless Streamable HTTP transport |
| `server` | `createMcpServer`, `McpServer`, `completable`, `TOOL_ANNOTATIONS` | McpServer factory, annotation presets, SDK re-exports |

## Transport

`startMcpServer` selects the transport from `MCP_TRANSPORT` (`stdio` by default, or `http`). HTTP mode
uses the SDK's native stateless `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) — each
request is independent with no session state, which suits scale-to-zero hosts.

- `GET /health` → `{"status":"healthy"}` (no auth).
- `POST /mcp` and `GET /mcp` are handled by the SDK transport.
- Listens on `PORT` (default `8080`), binding `MCP_HTTP_HOST` (default `0.0.0.0`; set `127.0.0.1` for local-only).

### Auth

HTTP mode is fail-closed: it refuses to start unless auth is explicitly configured.

- `MCP_API_KEY` — Bearer token required on `/mcp`; compared in constant time (`crypto.timingSafeEqual` over SHA-256 digests).
- `MCP_AUTH_DISABLED=true` — run open, only when a gateway/platform fronts authentication. A missing or
  empty `MCP_API_KEY` is treated as "not configured" and throws, rather than silently serving the
  endpoint unauthenticated.
- `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` — comma-separated allowlists; setting either enables the
  SDK's DNS-rebinding protection (Host/Origin validation).
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
import { createMcpServer, TOOL_ANNOTATIONS, completable } from '@novorb/mcp-core/server';
import type { McpToolAnnotations, McpCallToolResult } from '@novorb/mcp-core/server';

const server = createMcpServer('my-mcp', '1.0.0');

server.registerTool('lookup', {
  description: 'Look up a value',
  inputSchema: { key: z.string() },
  outputSchema: { value: z.string(), found: z.boolean() },
  annotations: TOOL_ANNOTATIONS.readOnly,
}, async ({ key }) => ({
  content: [{ type: 'text', text: value }],
  structuredContent: { value, found: true },
}));

server.registerPrompt('find-and-summarise', {
  argsSchema: { key: completable(z.string(), val => ['foo', 'bar'].filter(k => k.startsWith(val))) },
}, ({ key }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Look up "${key}"` } }],
}));
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
   audit. The only protocol dependency is `@modelcontextprotocol/sdk`, used in `transport` and `server`.

## Working here

- Source is in `src/`, tests in `tests/` — one test file per module.
- Build with `pnpm run build` (runs `tsc`).
- Run tests with `NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest`.
- ESM package (`"type": "module"`). `tsconfig.json` is self-contained (no `extends`) so it builds standalone.
- Node version is pinned in `.nvmrc`. Uses pnpm; install with `pnpm install --frozen-lockfile --ignore-scripts`.
- Use `jest.fn<any>()` for mocks (strict-mode compatibility).

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
  `404`, `500`, and `/mcp` dispatch) driven with mock `req`/`res`.
- `server` — `createMcpServer` factory, the `TOOL_ANNOTATIONS` presets, and the SDK re-exports.
- `retry` — backoff/jitter, `isRetryableError`, `parseRetryAfter`, `retryWithBackoff`.
- `pagination` — `normalizePagination`, `createPaginationMetadata`, `paginateArray`.

## Documentation

| File | Description |
|------|-------------|
| [docs/TESTING.md](docs/TESTING.md) | Test runner commands, conventions, and guidance for adding tests |
