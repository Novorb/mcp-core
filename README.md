# NOVORB - MCP Core

---

[![CI](https://github.com/Novorb/mcp-core/actions/workflows/ci.yml/badge.svg)](https://github.com/Novorb/mcp-core/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@novorb/mcp-core)](https://www.npmjs.com/package/@novorb/mcp-core)
[![Node](https://img.shields.io/badge/Node-20%2B-green)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-163-purple)]()
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

#### Quality Assurance

[![Coverage](https://img.shields.io/badge/coverage-99.39%25%20lines-brightgreen)]()
[![Audit](https://img.shields.io/badge/audit-0_vulns-brightgreen)]()
[![Fallow](https://img.shields.io/badge/fallow_health-86.6_(A)-brightgreen)](https://fallow.tools)
[![Maintainability](https://img.shields.io/badge/maintainability-94-brightgreen)](https://fallow.tools)

Shared TypeScript utilities for building MCP (Model Context Protocol) servers — logging, HTTP clients, retry logic, pagination, and transport — so every MCP server gets a consistent, tested foundation without reimplementing common patterns.

Version 3 is built on the MCP SDK v2 packages.

## Features

- **Structured logging** — file output with rotation, stderr output, text or JSON format, secret redaction
- **HTTP client** — axios wrapper with automatic retry on 429/5xx, request logging, pagination
- **Retry with backoff** — exponential backoff with jitter, configurable retries and delays
- **Pagination helpers** — normalize params, compute metadata, paginate arrays in memory
- **Unified transport** — stdio and stateless streamable-HTTP with built-in auth and DNS-rebinding protection
- **Server builder** — `McpServer` factory, annotation presets, and SDK re-exports from one import point
- **ESM native** — built as ES modules with full TypeScript declarations

## Module map

| Import path | Exports | Purpose |
|-------------|---------|---------|
| `@novorb/mcp-core/server` | `createMcpServer`, `TOOL_ANNOTATIONS`, `McpServer`, `Server`, `completable`, `fromJsonSchema`, `ProtocolError`, `ProtocolErrorCode`, types `McpCallToolResult`, `McpToolAnnotations` | Server builder and the only sanctioned SDK import point |
| `@novorb/mcp-core/transport` | `startMcpServer`, `createRequestHandler`, `bearerMatches`, `resolveHttpAuth`, types `TransportMode`, `TransportOptions`, `ServerFactory`, `ServerOrFactory`, `McpRequestHandler` | stdio and streamable-HTTP transport |
| `@novorb/mcp-core/logger` | `initLogger`, `getLogger`, `Logger`, `LogLevel` | File/stderr logging with rotation and redaction |
| `@novorb/mcp-core/retry` | `retryWithBackoff`, `isRetryableError` | Exponential backoff with jitter |
| `@novorb/mcp-core/pagination` | `normalizePagination`, `createPaginationMetadata`, `paginateArray` | Pagination helpers |
| `@novorb/mcp-core/http-client` | `createHttpClient` | Hardened axios wrapper |

The package root (`@novorb/mcp-core`) re-exports the logger, retry, pagination, http-client and server surfaces, plus `startMcpServer` and the `ServerFactory`, `TransportMode` and `TransportOptions` types from transport. `createRequestHandler`, `bearerMatches`, `resolveHttpAuth`, `ServerOrFactory` and `McpRequestHandler` come from `@novorb/mcp-core/transport` only.

## SDK v2

Version 3.0.0 moves from `@modelcontextprotocol/sdk` (v1) to the SDK v2 packages.

- **Packages:** `@modelcontextprotocol/server` `^2.3.1` and `@modelcontextprotocol/node` `^2.1.1` are runtime dependencies. `@modelcontextprotocol/sdk` is gone.
- **Runtime:** Node 20 or newer.
- **zod:** consumers bring `zod` `^4.2`. mcp-core has no runtime zod dependency and never imports it.
- **Import only through mcp-core:** consumers take `McpServer`, `Server`, `completable`, `fromJsonSchema`, `ProtocolError`, `ProtocolErrorCode` and the result/annotation types from `@novorb/mcp-core/server`, never from the SDK packages directly. Low-level consumers that need the `Server` class (for example with `fromJsonSchema` and raw request handlers) get it from the same place.
- **HTTP is factory-only:** `startMcpServer` in HTTP mode requires a factory (`() => McpServer`). In SDK v2 one server instance serves one connection, so passing an instance throws. stdio accepts either form; a factory is still recommended.
- **Protocol eras:** the HTTP handler is `createMcpHandler(factory, { legacy: 'stateless', responseMode: 'json' })` adapted with `toNodeHandler`. Clients on the 2026-07-28 protocol receive JSON responses. 2025-era clients are served statelessly (no session id) and receive SSE responses, because the SDK's legacy path does not honour `responseMode`. SDK clients handle both; a hand-rolled caller that expects a JSON body from a 2025-era handshake must accept `text/event-stream`.
- **Startup warning:** the SDK prints a `responseMode: 'json'` warning to stderr once per HTTP start. This is expected.
- **`completable` nesting:** wrap the string first, then make it optional: `completable(z.string(), cb).optional()` returns completions. `completable(z.string().optional(), cb)` silently returns an empty list.

### Breaking changes in 3.0.0

- MCP SDK v1 (`@modelcontextprotocol/sdk`) replaced by `@modelcontextprotocol/server` and `@modelcontextprotocol/node`.
- Node 20 or newer; zod `^4.2` for consumers.
- HTTP transport accepts a server factory only; an instance throws.
- The `session` and `enableJsonResponse` options are removed (HTTP is stateless and JSON-first by construction).
- `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` now use the SDK's node validators: matching is by hostname only (the port is ignored, and the Origin scheme is ignored). `host:port` and full-origin entries are normalised to their hostname. A rejection is a 403 with a JSON-RPC error body (`-32000`).
- An empty or malformed POST body is answered with a 400 JSON-RPC parse error (`-32700`).
- Removed dependency overrides that only served the v1 SDK's express stack.

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — agent/contributor context and working conventions
- **[docs/TESTING.md](docs/TESTING.md)** — test runner commands, conventions, and guidelines

## Installation

```bash
pnpm add @novorb/mcp-core
```

## Modules

### Logger

Unified logger supporting file output (with rotation) and stderr output, in text or structured JSON format. MCP servers use stdio for protocol communication, so logging to stdout/stderr directly isn't always possible — file-based logging solves this. Sensitive-keyed fields in `meta` are redacted before serialisation.

```typescript
import { initLogger, LogLevel } from '@novorb/mcp-core';

// File-based (writes to logs/mcp.log with rotation)
const logger = initLogger({
  output: 'file',
  logDir: './logs',
  level: LogLevel.INFO,
});

// Stderr with structured JSON
const logger = initLogger({
  output: 'stderr',
  format: 'json',
});

logger.info('Server started', 'Server');
logger.error('Request failed', 'HttpClient', { status: 500, path: '/api/items' });
```

### HTTP Client

Pre-configured axios wrapper with automatic retry on transient failures (429, 5xx, network errors) for idempotent methods, request/response logging, and pagination support via `X-Total-Count` headers.

```typescript
import { createHttpClient } from '@novorb/mcp-core';

const client = createHttpClient({
  baseURL: 'https://api.example.com',
  headers: { 'Authorization': 'Bearer token' },
  retries: 3,
  logContext: 'MyApiClient',
});

const item = await client.get('/items/1');
const { data, totalCount } = await client.getPaginated('/items', { page: 1, per_page: 50 });
await client.post('/items', { name: 'new item' });
```

### Retry

Exponential backoff with jitter for retrying failed operations. Used internally by the HTTP client, but also available standalone.

```typescript
import { retryWithBackoff, isRetryableError } from '@novorb/mcp-core';

const result = await retryWithBackoff(async (ctx) => {
  console.log(`Attempt ${ctx.attempt + 1}/${ctx.maxRetries + 1}`);
  return await someUnreliableOperation();
}, {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
});
```

### Pagination

Normalize pagination parameters, compute metadata, and paginate arrays in memory.

```typescript
import { normalizePagination, createPaginationMetadata, paginateArray } from '@novorb/mcp-core';

const params = normalizePagination({ page: 3, per_page: 200 });
// { page: 3, per_page: 100 }  (capped at max)

const metadata = createPaginationMetadata(500, params);
// { totalCount: 500, page: 3, perPage: 100, totalPages: 5 }

const { data, metadata } = paginateArray(allItems, { page: 2, per_page: 20 });
```

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
| `MCP_ALLOWED_ORIGINS` | none | Comma-separated Origin allowlist, matched by hostname (scheme ignored); enables DNS-rebinding protection |

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

**`TOOL_ANNOTATIONS` presets:** `readOnly` (lookups/searches), `idempotentWrite` (upserts), `mutableWrite` (non-idempotent writes), `destructive` (deletes/overwrites).

## Testing

```bash
pnpm test            # 163 tests in 7 suites
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
