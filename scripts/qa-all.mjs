/**
 * QA orchestrator for @novorb/mcp-core (dimensions 00-08).
 *
 * `pnpm qa:all` walks the QA gates in order, runs each command, and prints a PASS/FAIL/WARN/SKIP
 * matrix with a one-line detail. Hard gates (00 typecheck, 01 lint, 03 test, 05 secrets) fail the run
 * (exit 1); judgment/advisory rows (02 ref-keys, 04 deps, 07 fallow) report without failing on their own.
 * The unit suite runs jest --runInBand (single worker) so it never saturates the host.
 *
 * `pnpm audit` runs with --ignore-workspace so it audits this package's own tree, even when the checkout
 * sits inside another pnpm workspace.
 *
 * A green matrix is the OBJECTIVE half only. The subjective triage (read the code behind 02/05/08) is
 * the actual pass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ -> package root
// Put the local .bin on PATH so bare `tsc`/`biome`/`secretlint` resolve to this package's installs.
const ENV = { ...process.env, PATH: `${join(PKG, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}` };

// --quick skips the heavy test + coverage dims.
const QUICK = process.argv.includes('--quick');
const pkgName = (() => {
  try {
    return JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).name ?? 'mcp-core';
  } catch {
    return 'mcp-core';
  }
})();

/** Run a command in the package dir; return {code, out}. shell:true so the local .bin shims resolve on Windows. */
function sh(cmd) {
  const r = spawnSync(cmd, { cwd: PKG, env: ENV, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const rows = [];
let hardFail = false;
function row(n, dim, verdict, note) {
  rows.push({ n, dim, verdict, note });
  if (verdict === 'FAIL') hardFail = true;
}

// 00 - TypeScript typecheck. A HARD gate the test run does not cover: ts-jest transpiles per-file, so
// type errors surface only here.
{
  const r = sh('tsc --noEmit');
  const errs = (r.out.match(/error TS\d+/g) || []).length;
  row(
    '00',
    'TS typecheck',
    r.code === 0 ? 'PASS' : 'FAIL',
    r.code === 0 ? 'tsc --noEmit clean' : `${errs || ''} type error(s)`,
  );
}

// 01 - Lint + format (Biome). biome check = lint + format, no write.
{
  const r = sh('biome check src tests scripts');
  const m = r.out.match(/Found (\d+) error/i);
  row(
    '01',
    'Lint / format',
    r.code === 0 ? 'PASS' : 'FAIL',
    r.code === 0 ? 'biome check clean' : `${m ? `${m[1]} ` : ''}error(s) (run \`pnpm format\`)`,
  );
}

// 02 - Reference-key hygiene: no decision-record keys / paths in src.
{
  const r = sh('git grep -nE "\\bADR\\b|docs/adr/" -- "src"');
  const hits = r.out.split('\n').filter((l) => /\bADR\b|docs\/adr\//.test(l));
  row(
    '02',
    'Reference-key hygiene',
    hits.length ? 'FAIL' : 'PASS',
    hits.length ? `${hits.length} ADR key/path(s) in src` : 'no ADR keys/paths in src',
  );
}

// 03 + 06 - Test hermeticity + coverage, one jest run (always --runInBand). --quick skips this pair.
if (QUICK) {
  row('03', 'Test hermeticity', 'SKIP', '--quick (unit suite skipped)');
  row('06', 'Coverage', 'SKIP', '--quick (coverage skipped)');
} else {
  const r = sh('node bin/mcp-core-jest.mjs --runInBand --coverage --coverageReporters=text-summary');
  const passedM = r.out.match(/^Tests:.*?(\d+) passed/m);
  const passed = passedM ? passedM[1] : '?';
  row(
    '03',
    'Test hermeticity',
    r.code === 0 ? 'PASS' : 'FAIL',
    r.code === 0 ? `${passed} tests pass (jest, in-band)` : 'jest failing',
  );
  const cov = r.out.match(/Statements\s*:\s*([\d.]+)%/i);
  row(
    '06',
    'Coverage',
    cov ? 'INFO' : 'SKIP',
    cov ? `${cov[1]}% stmts (unit; 85% threshold enforced by jest.config)` : 'no coverage summary',
  );
}

// 04 - Dependency audit (production-only: dev-toolchain advisories do not ship).
{
  const r = sh('pnpm audit --prod --ignore-workspace');
  const clean = /No known vulnerabilities/.test(r.out);
  const m = r.out.match(/(\d+) vulnerabilities found/);
  row(
    '04',
    'Dependency audit (prod)',
    clean ? 'PASS' : 'WARN',
    clean ? 'no known prod vulnerabilities' : `${m ? `${m[1]} ` : ''}prod advisory(ies) to triage`,
  );
}

// 05 - Secret scan (secretlint). Non-zero exit = a finding.
{
  const r = sh('secretlint "**/*" --secretlintignore .gitignore');
  row(
    '05',
    'Security (secretlint)',
    r.code === 0 ? 'PASS' : 'FAIL',
    r.code === 0 ? 'no secrets' : 'secretlint findings',
  );
}

// 07 - Fallow: advisory static-analysis score, run on demand (network install), not in the cheap gate.
row('07', 'Fallow / static analysis', 'INFO', 'run `npx fallow@3.3.0 health` (advisory score)');

// 08 - Documentation freshness: source-map staleness + pinned facts.
if (!existsSync(join(PKG, 'docs-freshness.json'))) {
  row('08', 'Documentation', 'WARN', 'no docs-freshness.json (freshness not onboarded)');
} else {
  const r = sh('node scripts/check-docs-freshness.mjs');
  const stale = (r.out.match(/STALE:/g) || []).length;
  const drift = /FACT DRIFT|INCONSISTENT|cannot derive|doc missing|missing page/.test(r.out);
  const verdict = r.code === 2 || drift ? 'FAIL' : r.code === 0 ? 'PASS' : 'WARN';
  const note =
    r.code === 0
      ? 'docs fresh'
      : r.code === 2
        ? 'docs:check setup error'
        : drift
          ? 'pinned-fact drift'
          : `${stale} stale doc(s) (update+commit)`;
  row('08', 'Documentation', verdict, note);
}

// ---- Matrix ----
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n== qa:all - ${pkgName} ==`);
console.log(`${pad('#', 3)} ${pad('Dimension', 28)} ${pad('Verdict', 8)} Detail`);
for (const r of rows) console.log(`${pad(r.n, 3)} ${pad(r.dim, 28)} ${pad(r.verdict, 8)} ${r.note}`);
console.log(
  hardFail
    ? '\nRESULT: FAIL (a hard gate failed)\n'
    : '\nRESULT: gates green - SUBJECTIVE TRIAGE REQUIRED (read 02/05/08 + the code)\n',
);
process.exit(hardFail ? 1 : 0);
