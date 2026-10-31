# NOVORB - MCP Core

---

[![CI](https://github.com/Novorb/mcp-core/actions/workflows/ci.yml/badge.svg)](https://github.com/Novorb/mcp-core/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@novorb/mcp-core)](https://www.npmjs.com/package/@novorb/mcp-core)
[![Node](https://img.shields.io/badge/Node-20%2B-green)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-1186-purple)]()
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

#### Quality Assurance

[![Coverage](https://img.shields.io/badge/coverage-98%25%20lines-brightgreen)]()
[![Audit](https://img.shields.io/badge/audit-1_moderate-yellow)](docs/sdk.md#known-advisories)
[![Fallow](https://img.shields.io/badge/fallow_health-86.6_(A)-brightgreen)](https://fallow.tools)
[![Maintainability](https://img.shields.io/badge/maintainability-94-brightgreen)](https://fallow.tools)

Shared TypeScript foundation for building MCP (Model Context Protocol) servers: bootstrap, transport, tools, logging, HTTP clients, credentials and testing, so every server gets the same tested behaviour without reimplementing it. Version 3 is built on the MCP SDK v2 packages.

## Features

- **Bootstrap** (`runMcpServer`): one entry point for every server, from env loading to clean shutdown
- **Transport**: stdio and stateless streamable HTTP with bearer auth, plus an adapter for existing Express apps
- **Tools** (`registerTools`): central logging, safe error mapping, result caps and tamper-checked cursors
- **Protocol features**: logging, elicitation, sampling, roots, progress and cancellation across both protocol eras
- **Resources, prompts and notifications**: registration helpers, runtime toggles and change events on every transport
- **Tasks and requestState**: long-running tools with file or in-memory stores, and sealed multi-step state
- **HTTP client, retry and pagination**: one hardened client per upstream, one retry policy, page walkers for common API shapes
- **Guarded outbound URLs**: safe fetches of caller-supplied URLs and safe encoding of path segments
- **Credential health**: startup checks, key pools with rotation, and a report on every result
- **Env and data store**: one env loader with typed validation, and traversal-safe, atomic disk writes
- **Logger**: console and rotating file sinks with secret redaction and PII masking
- **Testing harness**: unit and integration helpers for your own server, and a cross-platform jest runner
- **The SDK through mcp-core**: a curated entry plus full re-exports, so servers depend on one package

## Documentation

**Getting started**

- [Building a server](docs/building-a-server.md): a minimal server and what `runMcpServer` does
- [Features](docs/features.md): the full feature list in detail
- [API reference](docs/api-reference.md): every import path and what it exports
- [The MCP SDK](docs/sdk.md): importing the SDK through mcp-core, and what SDK v2 changes
- [Migrating to 3.0](docs/migrating-to-v3.md): breaking changes and moving a low-level `Server` consumer

**Serving**

- [Server](docs/server.md): the server builder, annotation presets, list pagination
- [Transport and Express adapter](docs/transport.md): stdio, HTTP, auth and guards
- [Tools](docs/tools.md): definitions, response limits, cursors
- [Protocol features](docs/protocol-features.md): logging, elicitation, sampling, roots, progress, cancellation
- [Resources, prompts, notifications, tasks, requestState](docs/resources-prompts-tasks.md)

**Upstreams and configuration**

- [HTTP client and retry](docs/http-client.md)
- [Pagination](docs/pagination.md)
- [Outbound URLs](docs/outbound-urls.md): `guardedFetch` and URL path segments
- [Env](docs/env.md)
- [Credential health](docs/credentials.md)
- [Data store](docs/data-store.md)
- [Logger](docs/logger.md)

**Testing and contributing**

- [Testing your server](docs/testing-harness.md): the `./testing` harness and `mcp-core-jest`
- [Testing mcp-core](docs/testing.md): this repo's test commands and conventions
- [CLAUDE.md](CLAUDE.md): agent and contributor context

## Quick Start

```bash
pnpm add @novorb/mcp-core zod
```

```typescript
import { z } from 'zod';
import { runMcpServer } from '@novorb/mcp-core/bootstrap';
import { packageRootFrom } from '@novorb/mcp-core/logger';
import { TOOL_ANNOTATIONS } from '@novorb/mcp-core/server';
import { defineTool, registerTools, toolResult } from '@novorb/mcp-core/tools';

await runMcpServer({
  rootDir: packageRootFrom(import.meta.url),
  env: [],
  create: (_shared, _req, { env, info, createServer }) => {
    const server = createServer();
    registerTools(
      server,
      [
        defineTool({
          name: 'hello',
          description: 'Say hello',
          inputSchema: z.object({ name: z.string() }),
          annotations: TOOL_ANNOTATIONS.readOnly,
          handler: async ({ name }) => toolResult(`Hello ${name}`),
        }),
      ],
      { env, serverName: info.name },
    );
    return server;
  },
});
```

The server runs on stdio by default; set `MCP_TRANSPORT=http` for HTTP. Continue with [Building a server](docs/building-a-server.md).

## Development

```bash
pnpm run build       # tsc to dist/
pnpm test            # all suites
pnpm run qa:all      # full QA matrix
```

This is an ESM package (`"type": "module"`). See [Testing mcp-core](docs/testing.md).

## License

[MIT](LICENSE)
