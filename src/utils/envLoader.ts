/**
 * @novorb/mcp-core - Env loader
 *
 * Every MCP server declares its own env schema (`EnvSchema`) and loads its environment through
 * `loadEnv`, the one loader for the fleet (no dotenv). mcp-core's own keys (`CORE_ENV_SCHEMA`: transport,
 * auth, logger, data storage) are merged in, so a server declares only its own keys.
 *
 * Sources, highest first: the real process env > `<rootDir>/.env` > the spec `value` default.
 * `MCP_ENV_FILE` (read from the real env only) overrides the file path (absolute, or relative to
 * rootDir); `MCP_ENV_FILE=none` disables the file. The file is parsed with Node's `util.parseEnv`.
 *
 *   const env = loadEnv([
 *     { key: 'GITLAB_URL', type: 'url', value: 'https://gitlab.com', description: 'GitLab base URL' },
 *     { key: 'GITLAB_PERSONAL_ACCESS_TOKEN', required: true, secret: true, description: 'API token' },
 *   ], { rootDir: packageRootFrom(import.meta.url) });
 *   if (!env.isConfigured()) getLogger().warn(`not configured: set ${env.missing.join(', ')}`);
 *
 * Values are never logged, never returned by `describe()`, and every set `secret: true` value is
 * registered with the logger so it is masked verbatim in every log entry.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseEnv } from 'node:util';
import { getLogger, MIN_SECRET_LENGTH, registerSecretValues } from './logger.js';

export type EnvVarType = 'string' | 'int' | 'bool' | 'url' | 'enum';

export interface EnvVarSpec {
  /** The variable name, or the base name of a `multi` family (`KEY`, `KEY_1`, `KEY_EU`, ...). */
  key: string;
  /** Default value when the variable is unset. */
  value?: string;
  /** Required for the server to be fully configured (reported by `missing` / `isConfigured`). */
  required?: boolean;
  /** Collect `KEY` plus every `KEY_<suffix>` into an ordered list (`getAll`). */
  multi?: boolean;
  /** A secret: never logged, never rendered, masked verbatim by the logger. */
  secret?: boolean;
  /** Validation type (default `string`). */
  type?: EnvVarType;
  /** The allowed values of an `enum`. */
  values?: readonly string[];
  /** Documentation; feeds `renderEnvTable` and `renderEnvExample`. */
  description?: string;
}

export type EnvSchema = readonly EnvVarSpec[];

/** Where a value came from. */
export type EnvSource = 'env' | 'file' | 'default';

/** One validation problem, by key name (never the value). */
export interface EnvError {
  key: string;
  message: string;
}

/** `describe()` row: names and state only, never a value. */
export interface EnvKeyState {
  key: string;
  set: boolean;
  source?: EnvSource;
  required: boolean;
  secret: boolean;
  /** multi families: how many members are set. */
  count?: number;
}

export interface LoadEnvOptions {
  /** The server's package root; `.env` and relative MCP_ENV_FILE paths resolve against it. */
  rootDir: string;
  /** The environment to read and populate (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Throw on validation errors instead of collecting them. */
  strict?: boolean;
  /** Merge `CORE_ENV_SCHEMA` (default true). */
  includeCore?: boolean;
}

export interface LoadedEnv {
  /** The merged schema (core keys first, then the server's). */
  readonly schema: EnvSchema;
  /** The env file that was read, or null (none found, or MCP_ENV_FILE=none). */
  readonly envFile: string | null;
  /** Required keys that are not set. */
  readonly missing: readonly string[];
  /** Validation errors (bad int, bool, url, enum, unreadable env file), by key name. */
  readonly errors: readonly EnvError[];
  /** Key names found in the env file that no schema declares (not loaded). */
  readonly unknownFileKeys: readonly string[];
  /** The resolved value (env > file > default); undefined when unset or empty. */
  get(key: string): string | undefined;
  /** A multi family: KEY first, then numeric suffixes in numeric order, then other suffixes A-Z. */
  getAll(key: string): string[];
  /** The value parsed as an integer; undefined when unset or invalid. */
  int(key: string): number | undefined;
  /** The value parsed as a boolean (true/false, 1/0, yes/no, on/off); undefined when unset or invalid. */
  bool(key: string): boolean | undefined;
  /** Whether the key (or, for a multi family, any member) has a non-empty value. */
  has(key: string): boolean;
  /** Whether every key in `keys` (default: every required key) is set. */
  isConfigured(keys?: readonly string[]): boolean;
  /** Names, set/unset and source per declared key. Never a value. */
  describe(): EnvKeyState[];
}

/** mcp-core's own variables (transport, auth, logger, data storage), merged into every schema. */
export const CORE_ENV_SCHEMA: EnvSchema = [
  {
    key: 'MCP_TRANSPORT',
    type: 'enum',
    values: ['stdio', 'http'],
    description: 'Transport: stdio (default) or http',
  },
  { key: 'PORT', type: 'int', description: 'HTTP listen port (default 8080)' },
  { key: 'MCP_HTTP_HOST', description: 'HTTP bind address (default 0.0.0.0; 127.0.0.1 for local-only)' },
  {
    key: 'MCP_API_KEY',
    secret: true,
    description: 'Bearer token required on /mcp in HTTP mode (unless MCP_AUTH_DISABLED=true)',
  },
  { key: 'MCP_AUTH_DISABLED', type: 'bool', description: 'Run HTTP without auth (only behind a gateway)' },
  { key: 'MCP_MAX_BODY_BYTES', type: 'int', description: 'Max POST body size in bytes (default 4 MiB)' },
  { key: 'MCP_ALLOWED_HOSTS', description: 'Comma-separated Host allowlist (enables DNS-rebinding protection)' },
  { key: 'MCP_ALLOWED_ORIGINS', description: 'Comma-separated Origin allowlist (enables DNS-rebinding protection)' },
  { key: 'MCP_ENV_FILE', description: 'Env file path (absolute or relative to the package root); none disables it' },
  { key: 'LOG_LEVEL', type: 'enum', values: ['DEBUG', 'INFO', 'WARN', 'ERROR'], description: 'Log level (INFO)' },
  { key: 'LOG_FORMAT', type: 'enum', values: ['text', 'json'], description: 'Log line format (text)' },
  { key: 'LOG_CONSOLE', type: 'bool', description: 'stderr log sink (true)' },
  { key: 'LOG_FILE_MAIN', type: 'bool', description: 'Main <name>.log sink (true)' },
  { key: 'LOG_FILE_EXCEPTIONS', type: 'bool', description: 'exceptions.log sink (true)' },
  { key: 'LOG_FILE_DEBUG', type: 'bool', description: 'debug.log sink (true)' },
  { key: 'LOG_PATH', description: 'Log directory (default <package root>/.logs)' },
  { key: 'LOG_FILE', description: 'Main log file name (default <name>.log)' },
  {
    key: 'LOG_PROTOCOL',
    type: 'bool',
    description: 'Also send log entries to the client as MCP logging notifications (false; deprecated by 2026-07-28)',
  },
  { key: 'DATA_PATH', description: 'Data directory (default <package root>/.data)' },
  {
    key: 'DATA_STORAGE',
    type: 'bool',
    value: 'true',
    description: 'Write to disk; false runs stateless (an invalid value also disables writes)',
  },
  {
    key: 'MCP_LIST_PAGE_SIZE',
    type: 'int',
    description: 'tools/list (and resources/prompts) page size; 0 disables list pagination (default 100)',
  },
  {
    key: 'MCP_MAX_RESULT_ITEMS',
    type: 'int',
    description: 'Max items per list-shaped tool result before it is paginated (default 100)',
  },
  {
    key: 'MCP_MAX_RESULT_BYTES',
    type: 'int',
    description: 'Max serialized size of one tool result in bytes (default 262144)',
  },
  {
    key: 'MCP_MAX_TOOL_INPUT_ELEMENTS',
    type: 'int',
    description: 'Max array elements plus object members in one tools/call arguments payload (default 10000)',
  },
];

const ENV_FILE_NONE = 'none';
const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

function parseBoolWord(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  return undefined;
}

function parseIntStrict(value: string): number | undefined {
  const v = value.trim();
  if (!/^[+-]?\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Merge schemas by key: a later spec for the same key replaces the earlier one (server overrides core). */
function mergeSchemas(...schemas: EnvSchema[]): EnvVarSpec[] {
  const byKey = new Map<string, EnvVarSpec>();
  for (const schema of schemas) for (const spec of schema) byKey.set(spec.key, spec);
  return [...byKey.values()];
}

/** Order multi-family suffixes: numeric first (numeric order), then the rest alphabetically. */
function compareSuffixes(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b) || a.localeCompare(b);
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

interface FileRead {
  file: string | null;
  values: Record<string, string>;
  error?: string;
}

function readEnvFile(rootDir: string, override: string | undefined): FileRead {
  if (override !== undefined && override.trim().toLowerCase() === ENV_FILE_NONE) return { file: null, values: {} };
  const explicit = override !== undefined && override !== '';
  const file = explicit ? path.resolve(rootDir, override) : path.join(path.resolve(rootDir), '.env');
  if (!existsSync(file)) {
    return explicit ? { file: null, values: {}, error: 'env file not found' } : { file: null, values: {} };
  }
  try {
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (v !== undefined) values[k] = v;
    return { file, values };
  } catch {
    return { file: null, values: {}, error: 'env file could not be read' };
  }
}

function validate(spec: EnvVarSpec, value: string): string | undefined {
  switch (spec.type) {
    case 'int':
      return parseIntStrict(value) === undefined ? 'must be an integer' : undefined;
    case 'bool':
      return parseBoolWord(value) === undefined ? 'must be a boolean (true/false, 1/0, yes/no, on/off)' : undefined;
    case 'url':
      return isValidUrl(value) ? undefined : 'must be a URL';
    case 'enum': {
      const allowed = spec.values ?? [];
      return allowed.includes(value) ? undefined : `must be one of: ${allowed.join(', ')}`;
    }
    default:
      return undefined;
  }
}

/**
 * Load the environment for `schema` (merged with `CORE_ENV_SCHEMA`). Collects validation errors by key
 * name (throws only with `strict: true`), warns once about undeclared env-file keys (names only),
 * populates `env` for keys resolved from the file or a default (never overriding a set variable), and
 * registers every set secret with the logger for verbatim masking.
 */
export function loadEnv(schema: EnvSchema, options: LoadEnvOptions): LoadedEnv {
  const target = options.env ?? process.env;
  const merged = options.includeCore === false ? mergeSchemas(schema) : mergeSchemas(CORE_ENV_SCHEMA, schema);
  const specs = new Map(merged.map((s) => [s.key, s]));
  const fileRead = readEnvFile(options.rootDir, target.MCP_ENV_FILE);

  const resolved = new Map<string, { value: string; source: EnvSource }>();
  const resolveName = (name: string, fallback?: string): void => {
    const fromEnv = nonEmpty(target[name]);
    if (fromEnv !== undefined) resolved.set(name, { value: fromEnv, source: 'env' });
    else if (nonEmpty(fileRead.values[name]) !== undefined) {
      resolved.set(name, { value: fileRead.values[name], source: 'file' });
    } else if (nonEmpty(fallback) !== undefined && fallback !== undefined) {
      resolved.set(name, { value: fallback, source: 'default' });
    }
  };

  // Multi families: KEY plus KEY_<suffix> from the env and the file, excluding keys declared on their own.
  const families = new Map<string, string[]>();
  const claimed = new Set<string>(specs.keys());
  for (const spec of merged) {
    resolveName(spec.key, spec.value);
    if (!spec.multi) continue;
    const prefix = `${spec.key}_`;
    const suffixes = new Set<string>();
    for (const name of [...Object.keys(target), ...Object.keys(fileRead.values)]) {
      if (name.startsWith(prefix) && name.length > prefix.length && !specs.has(name)) {
        suffixes.add(name.slice(prefix.length));
      }
    }
    const members = [...suffixes].sort(compareSuffixes).map((s) => `${prefix}${s}`);
    for (const member of members) {
      claimed.add(member);
      resolveName(member);
    }
    families.set(spec.key, members);
  }

  const errors: EnvError[] = [];
  if (fileRead.error) errors.push({ key: 'MCP_ENV_FILE', message: fileRead.error });
  for (const spec of merged) {
    const names = [spec.key, ...(families.get(spec.key) ?? [])];
    for (const name of names) {
      const entry = resolved.get(name);
      if (!entry) continue;
      const problem = validate(spec, entry.value);
      if (problem) errors.push({ key: name, message: problem });
    }
  }

  const unknownFileKeys = Object.keys(fileRead.values)
    .filter((k) => !claimed.has(k))
    .sort();
  if (unknownFileKeys.length > 0) {
    getLogger().warn(
      `env file declares ${unknownFileKeys.length} key(s) no schema knows (not loaded): ${unknownFileKeys.join(', ')}`,
      'Env',
    );
  }

  // Populate the target env for file/default values so legacy `process.env.X` reads keep working.
  for (const [name, entry] of resolved) {
    if (entry.source !== 'env' && nonEmpty(target[name]) === undefined) target[name] = entry.value;
  }

  // Secrets: hand every set secret value to the logger for verbatim masking.
  const secretValues: string[] = [];
  for (const spec of merged) {
    if (!spec.secret) continue;
    for (const name of [spec.key, ...(families.get(spec.key) ?? [])]) {
      const entry = resolved.get(name);
      if (!entry) continue;
      secretValues.push(entry.value);
      if (entry.value.length < MIN_SECRET_LENGTH) {
        getLogger().warn(
          `env ${name} is a secret shorter than ${MIN_SECRET_LENGTH} characters and cannot be masked in logs or errors`,
          'Env',
        );
      }
    }
  }
  registerSecretValues(secretValues);

  const has = (key: string): boolean => {
    if (resolved.has(key)) return true;
    return (families.get(key) ?? []).some((m) => resolved.has(m));
  };
  const missing = merged.filter((s) => s.required && !has(s.key)).map((s) => s.key);

  if (options.strict && errors.length > 0) {
    throw new Error(`loadEnv: invalid environment: ${errors.map((e) => `${e.key} ${e.message}`).join('; ')}`);
  }

  const get = (key: string): string | undefined => resolved.get(key)?.value;
  const valid = (key: string): string | undefined => {
    const value = get(key);
    if (value === undefined) return undefined;
    return errors.some((e) => e.key === key) ? undefined : value;
  };

  return {
    schema: merged,
    envFile: fileRead.file,
    missing,
    errors,
    unknownFileKeys,
    get,
    getAll: (key) => {
      const out: string[] = [];
      const base = get(key);
      if (base !== undefined) out.push(base);
      for (const member of families.get(key) ?? []) {
        const value = get(member);
        if (value !== undefined) out.push(value);
      }
      return out;
    },
    int: (key) => {
      const value = valid(key);
      return value === undefined ? undefined : parseIntStrict(value);
    },
    bool: (key) => {
      const value = valid(key);
      return value === undefined ? undefined : parseBoolWord(value);
    },
    has,
    isConfigured: (keys) => (keys ?? merged.filter((s) => s.required).map((s) => s.key)).every(has),
    describe: () =>
      merged.map((spec) => {
        const state: EnvKeyState = {
          key: spec.key,
          set: has(spec.key),
          required: spec.required === true,
          secret: spec.secret === true,
        };
        const source = resolved.get(spec.key)?.source;
        if (source) state.source = source;
        if (spec.multi) {
          state.count = [spec.key, ...(families.get(spec.key) ?? [])].filter((n) => resolved.has(n)).length;
        }
        return state;
      }),
  };
}

export interface RenderOptions {
  /** Include `CORE_ENV_SCHEMA` before the server's keys (default false). */
  includeCore?: boolean;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function typeLabel(spec: EnvVarSpec): string {
  if (spec.type === 'enum') return `enum (${(spec.values ?? []).join(', ')})`;
  return spec.type ?? 'string';
}

/** A markdown table (key, type, required, multi, secret, default, description) for READMEs. */
export function renderEnvTable(schema: EnvSchema, options: RenderOptions = {}): string {
  const specs = options.includeCore ? mergeSchemas(CORE_ENV_SCHEMA, schema) : mergeSchemas(schema);
  const lines = [
    '| Key | Type | Required | Multi | Secret | Default | Description |',
    '|-----|------|----------|-------|--------|---------|-------------|',
  ];
  for (const s of specs) {
    const key = s.multi ? `\`${s.key}\`, \`${s.key}_*\`` : `\`${s.key}\``;
    const def = s.secret || s.value === undefined || s.value === '' ? '' : `\`${escapeCell(s.value)}\``;
    lines.push(
      `| ${key} | ${escapeCell(typeLabel(s))} | ${s.required ? 'yes' : 'no'} | ${s.multi ? 'yes' : 'no'} | ` +
        `${s.secret ? 'yes' : 'no'} | ${def} | ${escapeCell(s.description ?? '')} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** `.env.example` text: a comment per key, the default as the value, secrets always empty. */
export function renderEnvExample(schema: EnvSchema, options: RenderOptions = {}): string {
  const specs = options.includeCore ? mergeSchemas(CORE_ENV_SCHEMA, schema) : mergeSchemas(schema);
  const blocks: string[] = [];
  for (const s of specs) {
    const notes: string[] = [];
    if (s.required) notes.push('required');
    if (s.secret) notes.push('secret');
    if (s.type && s.type !== 'string') notes.push(typeLabel(s));
    if (s.multi) notes.push(`multi: also ${s.key}_1, ${s.key}_2, ...`);
    const head = [s.description ?? '', notes.length ? `(${notes.join('; ')})` : ''].filter(Boolean).join(' ');
    const value = s.secret ? '' : (s.value ?? '');
    blocks.push(`${head ? `# ${head.replace(/[\r\n]+/g, ' ')}\n` : ''}${s.key}=${value}`);
  }
  return `${blocks.join('\n\n')}\n`;
}
