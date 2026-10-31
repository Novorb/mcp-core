import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

// The shipped `mcp-core-jest` bin, run the way a consumer's package script runs it.
const BIN = resolve('bin', 'mcp-core-jest.mjs');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-core-jest-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fake `jest` package under `<dir>/node_modules/jest` whose bin reports how it was started. */
function fakeJest(dir: string): void {
  const pkg = join(dir, 'node_modules', 'jest');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  mkdirSync(join(pkg, 'build'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'jest', version: '30.0.0', main: 'build/index.js' }));
  writeFileSync(join(pkg, 'build', 'index.js'), 'module.exports = {};\n');
  writeFileSync(
    join(pkg, 'bin', 'jest.js'),
    [
      'process.stdout.write(JSON.stringify({ execArgv: process.execArgv, args: process.argv.slice(2), cwd: process.cwd() }));',
      'if (process.env.FAKE_JEST_SIGNAL) process.kill(process.pid, process.env.FAKE_JEST_SIGNAL);',
      "else process.exit(Number(process.env.FAKE_JEST_EXIT ?? '0'));",
    ].join('\n'),
  );
}

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: false,
  });
}

describe('mcp-core-jest', () => {
  it("runs the consumer's own jest with --experimental-vm-modules and every argument unchanged", () => {
    const consumer = join(root, 'consumer');
    mkdirSync(consumer);
    fakeJest(consumer);
    const r = run(consumer, ['tests/integration', '--runInBand', '--coverage=false', 'a b']);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as { execArgv: string[]; args: string[]; cwd: string };
    expect(report.execArgv).toEqual(['--experimental-vm-modules']);
    expect(report.args).toEqual(['tests/integration', '--runInBand', '--coverage=false', 'a b']);
    expect(resolve(report.cwd)).toBe(resolve(consumer));
  });

  it('propagates the exit code', () => {
    fakeJest(root);
    expect(run(root, [], { FAKE_JEST_EXIT: '3' }).status).toBe(3);
  });

  it('finds a jest hoisted into a parent node_modules', () => {
    fakeJest(root);
    const nested = join(root, 'packages', 'server');
    mkdirSync(nested, { recursive: true });
    const r = run(nested, ['--version']);
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { args: string[] }).args).toEqual(['--version']);
  });

  it('fails with exit 1 and a clear message when the consumer has no jest', () => {
    const r = run(root, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('mcp-core-jest: could not locate jest from');
  });

  (process.platform === 'win32' ? it.skip : it)('ends with the signal that ended jest', () => {
    fakeJest(root);
    const r = run(root, [], { FAKE_JEST_SIGNAL: 'SIGTERM' });
    expect(r.signal).toBe('SIGTERM');
  });
});

describe('mcp-core-jest signals (POSIX)', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;

  /** A fake jest that announces itself, then waits (exits 7 on SIGTERM, 0 after the delay). */
  function slowJest(dir: string): void {
    fakeJest(dir);
    writeFileSync(
      join(dir, 'node_modules', 'jest', 'bin', 'jest.js'),
      [
        "process.on('SIGTERM', () => { process.stdout.write('term'); process.exit(7); });",
        "process.on('SIGINT', () => { process.stdout.write('int'); process.exit(8); });",
        "process.stdout.write('ready');",
        "setTimeout(() => { process.stdout.write('done'); process.exit(0); }, 600);",
      ].join('\n'),
    );
  }

  function start(cwd: string): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
    const child = spawn(process.execPath, [BIN], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, output: () => out, exited };
  }

  async function untilReady(output: () => string): Promise<void> {
    for (let i = 0; i < 100 && !output().includes('ready'); i++) await new Promise((r) => setTimeout(r, 20));
  }

  posixIt('forwards SIGTERM to jest and exits with its code', async () => {
    slowJest(root);
    const run = start(root);
    await untilReady(run.output);
    run.child.kill('SIGTERM');
    expect(await run.exited).toBe(7);
    expect(run.output()).toContain('term');
  });

  posixIt('does not forward SIGINT (the terminal delivers it to jest); it waits for jest instead', async () => {
    slowJest(root);
    const run = start(root);
    await untilReady(run.output);
    run.child.kill('SIGINT');
    expect(await run.exited).toBe(0);
    expect(run.output()).toContain('done');
    expect(run.output()).not.toContain('int');
  });
});
