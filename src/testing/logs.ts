/**
 * @novorb/mcp-core/testing - read the logger's three files and scan text for leaked values.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface LogFiles {
  /** `<serverName>.log` (or the `mainFile` override): every entry at or above the level. */
  main: string;
  /** `exceptions.log`: ERROR entries only. */
  exceptions: string;
  /** `debug.log`: DEBUG entries only. */
  debug: string;
  /** Whether each file exists (a switched-off sink writes no file). */
  exists: { main: boolean; exceptions: boolean; debug: boolean };
  /** Absolute path of each file. */
  paths: { main: string; exceptions: string; debug: string };
}

/** Same rule as the logger: the main file is `<name>.log` with the name sanitised to `[A-Za-z0-9._-]`. */
export function logFileName(serverName: string): string {
  const safe = serverName.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  if (!safe) throw new Error(`logFileName: "${serverName}" sanitises to an empty name`);
  return `${safe}.log`;
}

function readOrEmpty(path: string): { text: string; exists: boolean } {
  if (!existsSync(path)) return { text: '', exists: false };
  return { text: readFileSync(path, 'utf8'), exists: true };
}

/**
 * Read `<logDir>/<serverName>.log`, `exceptions.log` and `debug.log`. An absent file reads as ''.
 * `mainFile` mirrors LOG_FILE: a bare name inside `logDir`, or an absolute path used as-is.
 */
export function readLogFiles(logDir: string, serverName: string, options: { mainFile?: string } = {}): LogFiles {
  const mainPath =
    options.mainFile !== undefined
      ? isAbsolute(options.mainFile)
        ? options.mainFile
        : join(logDir, options.mainFile)
      : join(logDir, logFileName(serverName));
  const paths = { main: mainPath, exceptions: join(logDir, 'exceptions.log'), debug: join(logDir, 'debug.log') };
  const main = readOrEmpty(paths.main);
  const exceptions = readOrEmpty(paths.exceptions);
  const debug = readOrEmpty(paths.debug);
  return {
    main: main.text,
    exceptions: exceptions.text,
    debug: debug.text,
    exists: { main: main.exists, exceptions: exceptions.exists, debug: debug.exists },
    paths,
  };
}

const TEXT_LEVEL = /^\S+ \| (DEBUG|INFO|WARN|ERROR)\s* \|/;

/**
 * The level of every non-empty line of a log file, in order: `DEBUG` / `INFO` / `WARN` / `ERROR`, or
 * `UNKNOWN` for a line in neither format. Reads the text format (`<ISO> | INFO  | ...`) and the JSON
 * format (`{"level":"INFO",...}`).
 */
export function logLevels(text: string): string[] {
  const levels: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const m = TEXT_LEVEL.exec(line);
    if (m?.[1]) {
      levels.push(m[1]);
      continue;
    }
    let level = 'UNKNOWN';
    if (line.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(line);
        const value = typeof parsed === 'object' && parsed !== null ? (parsed as { level?: unknown }).level : undefined;
        if (typeof value === 'string') level = value;
      } catch {
        // not JSON: UNKNOWN
      }
    }
    levels.push(level);
  }
  return levels;
}

/** Needles shorter than this are ignored by `findLeaks` (too likely to match by chance). */
export const MIN_LEAK_NEEDLE_LENGTH = 6;

export interface Leak {
  /** Index of the needle in the `needles` array. */
  index: number;
  /** A masked preview: the first two characters, then `***`, then the length. Never the full value. */
  preview: string;
  /** Indexes of the texts the needle appears in. */
  foundIn: number[];
}

/** Mask a value for a report: `ab***(len=12)`. */
export function maskValue(value: string): string {
  return `${value.slice(0, 2)}***(len=${value.length})`;
}

/**
 * Return every needle that appears verbatim in any text, as `{ index, preview, foundIn }` (never the
 * value itself, so a failing assertion cannot print the secret). Needles that are empty or shorter than
 * `minLength` (default {@link MIN_LEAK_NEEDLE_LENGTH}) are skipped, as are duplicates.
 */
export function findLeaks(texts: string[], needles: string[], options: { minLength?: number } = {}): Leak[] {
  const minLength = Math.max(1, options.minLength ?? MIN_LEAK_NEEDLE_LENGTH);
  const seen = new Set<string>();
  const leaks: Leak[] = [];
  needles.forEach((needle, index) => {
    if (needle.length < minLength || seen.has(needle)) return;
    seen.add(needle);
    const foundIn: number[] = [];
    texts.forEach((text, t) => {
      if (text.includes(needle)) foundIn.push(t);
    });
    if (foundIn.length > 0) leaks.push({ index, preview: maskValue(needle), foundIn });
  });
  return leaks;
}

/** Collect every string value (recursively) from tool arguments, for use as `findLeaks` needles. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (typeof value === 'object' && value !== null) for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}
