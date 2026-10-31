// Spawned by tests/utils/logger.test.ts with its stderr pipe destroyed by the parent. It logs enough to
// overflow the pipe buffer (so writes to the dead pipe fail), then crashes; captureProcessErrors must
// log the crash once to the files and exit 1, never looping on the broken stderr.
import { initLogger } from '../../../src/utils/logger.js';

const dir = process.argv[2];
const logger = initLogger({ name: 'epipe', logDir: dir, captureProcessErrors: true });
const padding = 'x'.repeat(2048);
let i = 0;
const timer = setInterval(() => {
  logger.info(`line ${i} ${padding}`);
  i += 1;
  if (i === 40) {
    clearInterval(timer);
    throw new Error('after-epipe');
  }
}, 5);
