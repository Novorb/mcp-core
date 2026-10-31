# Building a server (`runMcpServer` + `registerTools` + `loadEnv` + `createDataStore`)

## Minimal server

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
