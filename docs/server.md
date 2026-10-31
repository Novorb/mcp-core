# Server

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
| `requestStateCodec` | none | The codec for multi-step `requestState` (`requestStateCodecFromEnv()`); installed as `requestState.verify` and used by `ToolContext.continueWith` / `requestState()`. Pass this or `requestState.verify`, not both |

`runMcpServer({ server: { title, websiteUrl, icons, instructions, ... } })` hands the same options to
`ctx.createServer()` (with the package `name`, `version` and `description`).

## List pagination

SDK v2's `McpServer` answers `tools/list` in one result with no cursor, and has no extension point for
it (its list handlers are installed by private methods). mcp-core pages it on the documented low-level
hook instead of forking McpServer: `paginateLists(server.server, pageSize)` decorates the instance's
public `Server.setRequestHandler`, so the list handler the SDK installs (lazily, on the first
registration) is wrapped; the wrapper calls it unchanged and returns one page plus `nextCursor`. The
list content stays the SDK's.

- On by default at 100 per page, so a typical server fits on one page and nothing changes for it; raise
  or lower it for very large surfaces.
- Cursors are bound to the method (`{ l: 'tools/list', o: offset }`, brief B's `encodeCursor`); a
  malformed, foreign-method or out-of-range cursor answers JSON-RPC `-32602`.
- Clients: the SDK v2 client's `listTools()` (no cursor) follows `nextCursor` up to `listMaxPages`
  (default 64) in both eras (tested in memory and over HTTP); `listTools({ cursor })` returns one page.
  2025-era clients are expected to follow `nextCursor` by the spec (every list method has had
  `cursor` / `nextCursor` since 2024-11-05); a client that ignores it sees only the first 100.
- A low-level `Server` can call `paginateLists(server, n)` before its `setRequestHandler('tools/list', ...)`.
  A handler that pages a list itself must not be combined with it (`listPageSize: 0`).

**`TOOL_ANNOTATIONS` presets:** `readOnly` (lookups/searches), `idempotentWrite` (upserts), `mutableWrite` (non-idempotent writes), `destructive` (deletes/overwrites), and the same four with `openWorldHint: true` (`readOnlyOpenWorld`, `idempotentWriteOpenWorld`, `mutableWriteOpenWorld`, `destructiveOpenWorld`) for tools that reach an external API.
