#!/usr/bin/env node
/**
 * mcp-core-jest: a cross-platform jest launcher for ESM MCP servers (and for mcp-core itself).
 *
 * ESM jest suites (`"type": "module"` + ts-jest useESM) need the node binary started with
 * `--experimental-vm-modules`. The usual `NODE_OPTIONS=--experimental-vm-modules jest` script is POSIX
 * inline-env syntax and does not run under PowerShell or cmd. This launcher starts node with the flag
 * and runs the CALLER's jest: jest is resolved from the current working directory (the consumer's
 * package), so it stays the consumer's devDependency and mcp-core never depends on it at runtime.
 *
 *   "test:unit": "mcp-core-jest tests/unit",
 *   "test:integration": "mcp-core-jest tests/integration --runInBand --coverage=false"
 *
 * Every argument is passed through to jest unchanged. The exit code is jest's; a signal that ends jest
 * ends this process with the same signal; SIGTERM/SIGHUP are forwarded on POSIX and SIGINT (which reaches jest
 * from the terminal) is waited out, never doubled.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

/** The directory of the `jest` package that owns `entry` (the nearest package.json named jest). */
function jestPackageRoot(entry) {
  let dir = dirname(entry);
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === 'jest') return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `jest/bin/jest.js` as resolved from `cwd` (its `exports` map hides the bin subpath, so derive it). */
function findJestBin(cwd) {
  try {
    const entry = createRequire(join(resolve(cwd), 'noop.js')).resolve('jest');
    const root = jestPackageRoot(entry);
    if (root) {
      const bin = join(root, 'bin', 'jest.js');
      if (existsSync(bin)) return bin;
    }
  } catch {
    /* fall through to the walk */
  }
  let dir = resolve(cwd);
  for (;;) {
    const bin = join(dir, 'node_modules', 'jest', 'bin', 'jest.js');
    if (existsSync(bin)) return bin;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Signal handling, as npm and cross-spawn do it:
 * - SIGINT is never forwarded: a Ctrl+C reaches jest from the terminal itself (the console process group
 *   on POSIX, CTRL_C_EVENT on Windows), so forwarding would deliver it twice. The launcher only ignores
 *   it and waits for jest to finish its own shutdown.
 * - SIGTERM and SIGHUP are forwarded on POSIX (a supervisor signals the launcher, not the group).
 * - On Windows nothing is forwarded: `child.kill(signal)` there is TerminateProcess, which would cut
 *   jest's own cleanup short.
 */
const IGNORED_SIGNALS = ['SIGINT'];
const FORWARDED_SIGNALS = process.platform === 'win32' ? [] : ['SIGTERM', 'SIGHUP'];

function main() {
  const jestBin = findJestBin(process.cwd());
  if (!jestBin) {
    process.stderr.write(
      `mcp-core-jest: could not locate jest from ${process.cwd()}. Add jest as a devDependency of this package and install it.\n`,
    );
    process.exit(1);
  }
  const child = spawn(process.execPath, ['--experimental-vm-modules', jestBin, ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: false,
  });
  const forwarders = [
    ...IGNORED_SIGNALS.map((signal) => [signal, () => undefined]),
    ...FORWARDED_SIGNALS.map((signal) => [
      signal,
      () => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      },
    ]),
  ];
  for (const [signal, handler] of forwarders) process.on(signal, handler);
  child.on('error', (err) => {
    process.stderr.write(`mcp-core-jest: could not start jest: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    for (const [name, forward] of forwarders) process.off(name, forward);
    if (signal) {
      process.exitCode = 1;
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main();
