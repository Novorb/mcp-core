import { runMcpServer } from '../../src/bootstrap.js';
import { requestStateCodecFromEnv } from '../../src/request-state.js';
import { createTaskStore } from '../../src/task-store.js';
import { createDataStore } from '../../src/utils/dataStore.js';
import { packageRootFrom } from '../../src/utils/logger.js';
import { buildFeatureServer, createFeatureShared, type FeatureShared } from './feature-tools.js';

// Spawned by tests/features.roundtrip.test.ts (stdio and HTTP). Tasks live in a file store under DATA_PATH;
// requestState is sealed with MCP_REQUEST_STATE_KEY.
await runMcpServer<FeatureShared>({
  rootDir: packageRootFrom(import.meta.url),
  name: 'feature-fixture',
  version: '1.0.0',
  env: [],
  setup: ({ env, logger, rootDir, notify }) =>
    createFeatureShared(
      createTaskStore(createDataStore({ rootDir, env, logger }), { cancelPollMs: 50 }),
      notify,
      requestStateCodecFromEnv(env),
    ),
  create: (shared, req) => buildFeatureServer(shared, req),
  dispose: (shared) => shared.store.close(),
});
