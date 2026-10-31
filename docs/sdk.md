# The MCP SDK

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

- **Packages:** `@modelcontextprotocol/server` `~2.3.1`, `@modelcontextprotocol/node` `~2.1.1` and `@modelcontextprotocol/client` `~2.3.1` are runtime dependencies (patch-level ranges: a minor SDK release is adopted deliberately). `express` (`^4.18 || ^5`) and `@modelcontextprotocol/express` (`~2.0.2`) are optional peers, needed only for `@novorb/mcp-core/express` and `/sdk/express`; a stdio-only or `node:http` consumer installs neither. Those two subpaths load them lazily and fail at import with `ExpressAdapterUnavailableError` when either is missing. `@modelcontextprotocol/sdk` (v1) is gone.
- **Runtime:** Node 20.12 or newer (the env loader uses `util.parseEnv`).
- **zod:** consumers bring `zod` `^4.2`. mcp-core has no runtime zod dependency and never loads it; `pagedResultSchema(z, item)` takes the consumer's `z` and never imports zod: its parameter is a structural contract, so any zod 4.x namespace typechecks (no shared zod identity or tsconfig `paths` entry needed).
- **Import only through mcp-core:** see "The SDK through mcp-core" above.
- **HTTP is factory-only:** `startMcpServer` in HTTP mode requires a factory (`() => McpServer`). In SDK v2 one server instance serves one connection, so passing an instance throws. stdio accepts either form; a factory is still recommended.
- **Protocol eras:** the HTTP handler is `createMcpHandler(factory, { legacy: 'stateless' })` with the SDK default `responseMode: 'auto'`, adapted with `toNodeHandler`. A 2026-07-28 request gets one JSON body unless the handler emits progress or log notifications before its result, in which case the SDK upgrades that response to SSE. 2025-era clients are served statelessly (no session id) and receive SSE responses (the SDK's legacy path always streams). SDK clients handle both; a hand-rolled caller must accept `text/event-stream`.
- **`completable` nesting:** wrap the string first, then make it optional: `completable(z.string(), cb).optional()` returns completions. `completable(z.string().optional(), cb)` silently returns an empty list.

## Known advisories

`pnpm audit --prod` reports one moderate advisory, [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f) in `@hono/node-server` 1.x, a dependency of `@modelcontextprotocol/node`. It concerns `serveStatic`. The SDK imports only the package's main entry and mcp-core does not use the package directly, so `serveStatic` is never loaded. The fixed release is 2.x, a major version outside the SDK's `^1.19.9` range, so it stays until the SDK moves.
