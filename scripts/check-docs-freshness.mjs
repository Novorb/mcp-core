/**
 * Documentation freshness checker for @novorb/mcp-core (playbook dimension 08).
 *
 * mcp-core is a single standalone git repo, so this is the simple single-repo variant (no multi-repo
 * path prefixes). It reads `docs-freshness.json` and runs two deterministic checks:
 *
 *   A · source-map staleness — per doc page, the newest NON-cosmetic commit touching its mapped source
 *       vs the page's own last commit. A `style(...)` commit (a lint/format reflow) is ignored so a
 *       format pass does not false-flag every page. A page with no git history yet is SKIPPED. This is a
 *       git-TIME compare: a STALE flag clears only once the updated page is COMMITTED.
 *   B · pinned facts — a value derived from the code/config must appear in the docs that state it.
 *
 * Exit: 0 clean · 1 drift · 2 setup error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const cfgPath = join(PKG, 'docs-freshness.json');
if (!existsSync(cfgPath)) {
  console.error(`[docs:check] no docs-freshness.json in ${PKG}`);
  process.exit(2);
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
} catch (e) {
  console.error(`[docs:check] cannot parse docs-freshness.json: ${e.message}`);
  process.exit(2);
}

const rel = (p) => resolve(PKG, p);
function gitLog(absPath, extra) {
  try {
    return execFileSync('git', ['log', ...extra, '--', absPath], { cwd: PKG, encoding: 'utf8' });
  } catch {
    return '';
  }
}
const isStyle = (subj) => /^style(\(|:)/.test(subj);
function newestSourceCommit(absPath) {
  const rows = gitLog(absPath, ['--format=%ct\t%s'])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('\t');
      return { ct: +l.slice(0, i), subj: l.slice(i + 1) };
    })
    .filter((r) => !isStyle(r.subj));
  return { epoch: rows.length ? rows[0].ct : 0, why: rows.slice(0, 3) };
}
function lastDocCommit(absPath) {
  const out = gitLog(absPath, ['-1', '--format=%ct']).trim();
  return out ? +out : 0;
}

const problems = [];
const notes = [];

// A - source-map staleness
for (const [page, sources] of Object.entries(cfg.pages || {})) {
  const pageAbs = rel(page);
  if (!existsSync(pageAbs)) {
    problems.push(`A missing page: ${page}`);
    continue;
  }
  const docEpoch = lastDocCommit(pageAbs);
  if (docEpoch === 0) {
    notes.push(`A skip (uncommitted): ${page}`);
    continue;
  }
  const newer = [];
  for (const src of sources) {
    const { epoch, why } = newestSourceCommit(rel(src));
    if (epoch > docEpoch) newer.push({ src, why });
  }
  if (newer.length) {
    const detail = newer.map((n) => `      -> ${n.src} newer: ${n.why.map((w) => w.subj).join(' | ')}`).join('\n');
    problems.push(`A STALE: ${page}\n${detail}`);
  }
}

// B - pinned facts (each: { id, file, capture (regex, group 1), in: [docs], pattern with {value} })
for (const f of cfg.pinnedFacts || []) {
  const abs = rel(f.file);
  if (!existsSync(abs)) {
    problems.push(`B ${f.id}: source file missing ${f.file}`);
    continue;
  }
  const m = readFileSync(abs, 'utf8').match(new RegExp(f.capture));
  const val = m ? m[1] : null;
  if (val == null) {
    problems.push(`B cannot derive fact ${f.id}`);
    continue;
  }
  const needle = new RegExp(f.pattern.replace('{value}', val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const doc of f.in) {
    const dAbs = rel(doc);
    if (!existsSync(dAbs)) {
      problems.push(`B ${f.id}: doc missing ${doc}`);
      continue;
    }
    if (!needle.test(readFileSync(dAbs, 'utf8'))) problems.push(`B FACT DRIFT: ${f.id} = "${val}" not found in ${doc}`);
  }
}

console.log(`\n== docs:check - ${cfg.package || 'mcp-core'} ==`);
for (const n of notes) console.log(`  ${n}`);
if (!problems.length) {
  console.log(
    '  ok docs fresh (mapped facts + source-map staleness clean)\n  NOTE: freshness != completeness - CONTENT REVIEW is the subjective pass.\n',
  );
  process.exit(0);
}
console.log(`  ${problems.length} freshness issue(s):`);
for (const p of problems) console.log(`    - ${p}`);
console.log('');
process.exit(1);
