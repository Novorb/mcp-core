import { writeFileSync } from 'node:fs';
import { runMcpServer } from '../../src/bootstrap.js';
import { createMcpServer } from '../../src/server.js';
import { packageRootFrom } from '../../src/utils/logger.js';

// A stdio server whose shared state holds a keep-alive handle (an interval), like a pool or a watcher
// would. Without the stdio-EOF hook in runMcpServer it never exits once the client closes stdin.
await runMcpServer<{ timer: NodeJS.Timeout }>({
  rootDir: packageRootFrom(import.meta.url),
  env: [{ key: 'KEEPALIVE_MARKER', description: 'File the dispose hook writes' }],
  setup: () => ({ timer: setInterval(() => undefined, 1000) }),
  create: () => createMcpServer('keepalive', '1.0.0'),
  dispose: (shared) => {
    clearInterval(shared.timer);
    const marker = process.env.KEEPALIVE_MARKER;
    if (marker) writeFileSync(marker, 'disposed');
  },
});
