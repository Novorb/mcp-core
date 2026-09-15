/**
 * Cross-platform jest launcher for @novorb/mcp-core.
 *
 * The package's tests are ESM (`"type": "module"` + ts-jest useESM), which jest supports only when the
 * NODE binary is started with `--experimental-vm-modules`. The historical `NODE_OPTIONS=… jest` script
 * is POSIX-only inline-env syntax and does NOT run under PowerShell or cmd, so the suite could not be
 * run on a Windows host. This launcher sets the flag on the node binary itself and resolves jest's bin
 * (walking up node_modules so it works whether jest is local or hoisted), so `npm test` is portable.
 *
 * Pass jest args straight through, e.g. `node scripts/run-jest.mjs --runInBand --coverage`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** Find `jest/bin/jest.js` (its `exports` map hides the bin subpath, so derive it from the package entry). */
function findJestBin() {
  try {
    const entry = require.resolve('jest');
    const marker = `${sep}jest${sep}`;
    const root = entry.slice(0, entry.lastIndexOf(marker) + marker.length - 1);
    const bin = join(root, 'bin', 'jest.js');
    if (existsSync(bin)) return bin;
  } catch {
    /* fall through to the walk */
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const bin = join(dir, 'node_modules', 'jest', 'bin', 'jest.js');
    if (existsSync(bin)) return bin;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

const jestBin = findJestBin();
if (!jestBin) {
  console.error('Could not locate jest/bin/jest.js. Run `pnpm install --ignore-workspace --frozen-lockfile`.');
  process.exit(1);
}

const { status } = spawnSync(process.execPath, ['--experimental-vm-modules', jestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(status ?? 1);
