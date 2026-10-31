import { runMcpServer } from '../../src/bootstrap.js';
import { createMcpServer } from '../../src/server.js';
import { createDataStore } from '../../src/utils/dataStore.js';
import { packageRootFrom } from '../../src/utils/logger.js';
import { createEchoShared, ECHO_ENV, type EchoShared, registerEchoTools } from './echo-tools.js';

// Spawned by the round-trip, harness and example tests as `node --import <tsx loader> echo-server.ts`.
// The package root is tests/fixtures (its package.json names the fixture), so a run without LOG_PATH /
// DATA_PATH writes to tests/fixtures/.logs and .data (gitignored), never into cwd.
await runMcpServer<EchoShared>({
  rootDir: packageRootFrom(import.meta.url),
  env: ECHO_ENV,
  setup: ({ env, logger, rootDir }) =>
    createEchoShared(createDataStore({ rootDir, env, logger }), () => env.get('ECHO_UPSTREAM_TOKEN') ?? ''),
  create: (shared, _req, { info }) => {
    const server = createMcpServer(info.name, info.version);
    registerEchoTools(server, shared);
    return server;
  },
});
