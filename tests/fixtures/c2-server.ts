import { runMcpServer } from '../../src/bootstrap.js';
import { requestStateCodecFromEnv } from '../../src/request-state.js';
import { createTaskStore } from '../../src/task-store.js';
import { createDataStore } from '../../src/utils/dataStore.js';
import { packageRootFrom } from '../../src/utils/logger.js';
import { buildC2Server, type C2Shared, createC2Shared } from './c2-tools.js';

// Spawned by tests/c2.roundtrip.test.ts (stdio and HTTP). Tasks live in a file store under DATA_PATH;
// requestState is sealed with MCP_REQUEST_STATE_KEY.
await runMcpServer<C2Shared>({
  rootDir: packageRootFrom(import.meta.url),
  name: 'c2-fixture',
  version: '1.0.0',
  env: [],
  setup: ({ env, logger, rootDir, notify }) =>
    createC2Shared(
      createTaskStore(createDataStore({ rootDir, env, logger }), { cancelPollMs: 50 }),
      notify,
      requestStateCodecFromEnv(env),
    ),
  create: (shared, req) => buildC2Server(shared, req),
  dispose: (shared) => shared.store.close(),
});
