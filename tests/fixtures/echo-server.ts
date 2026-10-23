import { startMcpServer } from '../../src/transport.js';
import { buildEchoServer } from './echo-tools.js';

// Spawned by tests/transport.roundtrip.test.ts as `node --import tsx tests/fixtures/echo-server.ts`.
await startMcpServer(buildEchoServer);
