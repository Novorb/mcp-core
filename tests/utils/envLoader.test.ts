import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  CORE_ENV_SCHEMA,
  type EnvSchema,
  loadEnv,
  renderEnvExample,
  renderEnvTable,
} from '../../src/utils/envLoader.js';
import { getLogger, initLogger, resetLogger } from '../../src/utils/logger.js';

const SECRET = 'tok-very-secret-4f2a9c';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-core-env-'));
  resetLogger();
});

afterEach(() => {
  resetLogger();
  rmSync(root, { recursive: true, force: true });
});

function envFile(text: string, name = '.env'): string {
  const file = join(root, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

/** Capture every stderr line the logger writes during `fn`. */
function captureStderr(fn: () => void): string {
  const lines: string[] = [];
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('');
}

const SCHEMA: EnvSchema = [
  { key: 'API_URL', type: 'url', value: 'https://api.example.test', description: 'API base URL' },
  { key: 'API_TOKEN', required: true, secret: true, description: 'API token' },
  { key: 'SEARCH_KEY', multi: true, secret: true, description: 'Rotating keys' },
  { key: 'PAGE_SIZE', type: 'int', value: '50' },
  { key: 'VERBOSE', type: 'bool' },
  { key: 'REGION', type: 'enum', values: ['eu', 'us'] },
];

describe('loadEnv precedence and sources', () => {
  it('real env > .env file > spec default, and populates the target only from file/default', () => {
    envFile('API_URL=https://file.example.test\nPAGE_SIZE=10\nAPI_TOKEN=from-file-token\n');
    const target: NodeJS.ProcessEnv = { API_TOKEN: 'from-env-token' };
    const env = loadEnv(SCHEMA, { rootDir: root, env: target });
    expect(env.get('API_TOKEN')).toBe('from-env-token');
    expect(env.get('API_URL')).toBe('https://file.example.test');
    expect(env.int('PAGE_SIZE')).toBe(10);
    expect(env.envFile).toBe(join(root, '.env'));
    // populated, never overriding a set variable
    expect(target.API_TOKEN).toBe('from-env-token');
    expect(target.API_URL).toBe('https://file.example.test');
    expect(target.DATA_STORAGE).toBe('true');
    const sources = Object.fromEntries(env.describe().map((d) => [d.key, d.source]));
    expect(sources).toMatchObject({ API_TOKEN: 'env', API_URL: 'file', DATA_STORAGE: 'default' });
  });

  it('uses the spec default when neither env nor file sets the key', () => {
    const env = loadEnv(SCHEMA, { rootDir: root, env: {} });
    expect(env.get('API_URL')).toBe('https://api.example.test');
    expect(env.int('PAGE_SIZE')).toBe(50);
    expect(env.envFile).toBeNull();
  });

  it('treats an empty value as unset', () => {
    envFile('API_TOKEN=\n');
    const env = loadEnv(SCHEMA, { rootDir: root, env: { VERBOSE: '' } });
    expect(env.has('API_TOKEN')).toBe(false);
    expect(env.get('VERBOSE')).toBeUndefined();
    expect(env.missing).toEqual(['API_TOKEN']);
  });

  it('MCP_ENV_FILE=none disables the file', () => {
    envFile('API_TOKEN=from-file-token\n');
    const env = loadEnv(SCHEMA, { rootDir: root, env: { MCP_ENV_FILE: 'none' } });
    expect(env.has('API_TOKEN')).toBe(false);
    expect(env.envFile).toBeNull();
  });

  it('MCP_ENV_FILE points at another file, relative to rootDir or absolute', () => {
    mkdirSync(join(root, 'cfg'));
    envFile('API_TOKEN=relative-file-token\n', 'cfg/test.env');
    const rel = loadEnv(SCHEMA, { rootDir: root, env: { MCP_ENV_FILE: 'cfg/test.env' } });
    expect(rel.get('API_TOKEN')).toBe('relative-file-token');
    const abs = loadEnv(SCHEMA, { rootDir: tmpdir(), env: { MCP_ENV_FILE: join(root, 'cfg', 'test.env') } });
    expect(abs.get('API_TOKEN')).toBe('relative-file-token');
  });

  it('a named env file that does not exist is an error, by key', () => {
    const env = loadEnv(SCHEMA, { rootDir: root, env: { MCP_ENV_FILE: 'missing.env' } });
    expect(env.errors).toEqual([{ key: 'MCP_ENV_FILE', message: 'env file not found' }]);
  });

  it('a directory in place of the env file is an unreadable-file error', () => {
    mkdirSync(join(root, '.env'));
    const env = loadEnv(SCHEMA, { rootDir: root, env: {} });
    expect(env.errors).toEqual([{ key: 'MCP_ENV_FILE', message: 'env file could not be read' }]);
  });

  it('merges CORE_ENV_SCHEMA unless includeCore is false; a server spec overrides a core one', () => {
    const env = loadEnv([{ key: 'PORT', type: 'int', value: '9000' }], { rootDir: root, env: {} });
    expect(env.schema.map((s) => s.key)).toEqual(expect.arrayContaining(CORE_ENV_SCHEMA.map((s) => s.key)));
    expect(env.int('PORT')).toBe(9000);
    const bare = loadEnv(SCHEMA, { rootDir: root, env: {}, includeCore: false });
    expect(bare.schema.map((s) => s.key)).toEqual(SCHEMA.map((s) => s.key));
  });
});

describe('loadEnv multi families', () => {
  it('orders KEY, then numeric suffixes numerically, then other suffixes alphabetically; skips empties', () => {
    envFile('SEARCH_KEY_2=k-two\nSEARCH_KEY_EU=k-eu\n');
    const env = loadEnv(SCHEMA, {
      rootDir: root,
      env: {
        SEARCH_KEY: 'k-base',
        SEARCH_KEY_10: 'k-ten',
        SEARCH_KEY_1: 'k-one',
        SEARCH_KEY_AP: 'k-ap',
        SEARCH_KEY_3: '',
      },
    });
    expect(env.getAll('SEARCH_KEY')).toEqual(['k-base', 'k-one', 'k-two', 'k-ten', 'k-ap', 'k-eu']);
    expect(env.has('SEARCH_KEY')).toBe(true);
    expect(env.describe().find((d) => d.key === 'SEARCH_KEY')?.count).toBe(6);
  });

  it('a family with only suffixed members is set; a declared KEY_X is not a member', () => {
    const env = loadEnv([...SCHEMA, { key: 'SEARCH_KEY_URL', type: 'url' }], {
      rootDir: root,
      env: { SEARCH_KEY_1: 'only-one', SEARCH_KEY_URL: 'https://x.test' },
    });
    expect(env.getAll('SEARCH_KEY')).toEqual(['only-one']);
    expect(env.get('SEARCH_KEY')).toBeUndefined();
    expect(env.has('SEARCH_KEY')).toBe(true);
    expect(env.getAll('API_URL')).toEqual(['https://api.example.test']);
  });
});

describe('loadEnv validation', () => {
  const bad = { PAGE_SIZE: '12x', VERBOSE: 'maybe', REGION: 'mars', API_URL: 'not a url', API_TOKEN: SECRET };

  it('collects bad int/bool/enum/url by key name, never the value', () => {
    const env = loadEnv(SCHEMA, { rootDir: root, env: { ...bad } });
    expect(env.errors.map((e) => e.key).sort()).toEqual(['API_URL', 'PAGE_SIZE', 'REGION', 'VERBOSE']);
    expect(JSON.stringify(env.errors)).not.toMatch(/12x|maybe|mars|not a url/);
    expect(env.errors.find((e) => e.key === 'REGION')?.message).toBe('must be one of: eu, us');
    // invalid values read as undefined through the typed accessors
    expect(env.int('PAGE_SIZE')).toBeUndefined();
    expect(env.bool('VERBOSE')).toBeUndefined();
  });

  it('throws with strict: true, naming keys only', () => {
    expect(() => loadEnv(SCHEMA, { rootDir: root, env: { ...bad }, strict: true })).toThrow(
      /PAGE_SIZE must be an integer/,
    );
    try {
      loadEnv(SCHEMA, { rootDir: root, env: { ...bad }, strict: true });
    } catch (e) {
      expect(String(e)).not.toMatch(/12x|maybe|mars/);
    }
  });

  it('parses bool words and rejects unsafe integers', () => {
    for (const [word, value] of [
      ['yes', true],
      ['ON', true],
      ['0', false],
      ['off', false],
    ] as const) {
      expect(loadEnv(SCHEMA, { rootDir: root, env: { VERBOSE: word } }).bool('VERBOSE')).toBe(value);
    }
    const big = loadEnv(SCHEMA, { rootDir: root, env: { PAGE_SIZE: '99999999999999999999' } });
    expect(big.errors.map((e) => e.key)).toEqual(['PAGE_SIZE']);
    expect(loadEnv(SCHEMA, { rootDir: root, env: { PAGE_SIZE: '-7' } }).int('PAGE_SIZE')).toBe(-7);
    expect(loadEnv(SCHEMA, { rootDir: root, env: {} }).bool('VERBOSE')).toBeUndefined();
  });

  it('an enum without values rejects everything', () => {
    const env = loadEnv([{ key: 'MODE', type: 'enum' }], { rootDir: root, env: { MODE: 'a' } });
    expect(env.errors).toEqual([{ key: 'MODE', message: 'must be one of: ' }]);
  });
});

describe('loadEnv configuration state', () => {
  it('missing / isConfigured / has', () => {
    const unset = loadEnv(SCHEMA, { rootDir: root, env: {} });
    expect(unset.missing).toEqual(['API_TOKEN']);
    expect(unset.isConfigured()).toBe(false);
    expect(unset.isConfigured(['API_URL'])).toBe(true);
    expect(unset.isConfigured(['SEARCH_KEY'])).toBe(false);
    const set = loadEnv(SCHEMA, { rootDir: root, env: { API_TOKEN: SECRET } });
    expect(set.isConfigured()).toBe(true);
    expect(set.missing).toEqual([]);
  });

  it('describe() lists names and state, never a value', () => {
    const env = loadEnv(SCHEMA, { rootDir: root, env: { API_TOKEN: SECRET, SEARCH_KEY_1: 'search-secret-1' } });
    const described = env.describe();
    expect(described.find((d) => d.key === 'API_TOKEN')).toEqual({
      key: 'API_TOKEN',
      set: true,
      source: 'env',
      required: true,
      secret: true,
    });
    expect(described.find((d) => d.key === 'VERBOSE')).toEqual({
      key: 'VERBOSE',
      set: false,
      required: false,
      secret: false,
    });
    expect(JSON.stringify(described)).not.toContain(SECRET);
    expect(JSON.stringify(described)).not.toContain('search-secret-1');
  });
});

describe('loadEnv logging', () => {
  it('warns once about undeclared env-file keys by name, never their values, and does not load them', () => {
    envFile('API_TOKEN=x-file-token\nSTRAY_ONE=stray-value-1\nSTRAY_TWO=stray-value-2\n');
    const target: NodeJS.ProcessEnv = {};
    let env: ReturnType<typeof loadEnv> | undefined;
    const out = captureStderr(() => {
      env = loadEnv(SCHEMA, { rootDir: root, env: target });
    });
    expect(env?.unknownFileKeys).toEqual(['STRAY_ONE', 'STRAY_TWO']);
    expect(out.match(/no schema knows/g)).toHaveLength(1);
    expect(out).toContain('STRAY_ONE, STRAY_TWO');
    expect(out).not.toContain('stray-value');
    expect(target.STRAY_ONE).toBeUndefined();
    expect(env?.get('STRAY_ONE')).toBeUndefined();
  });

  it('mcp-core keys in the file are known and loaded (no warning)', () => {
    envFile('LOG_LEVEL=DEBUG\nMCP_TRANSPORT=http\n');
    const target: NodeJS.ProcessEnv = {};
    const out = captureStderr(() => {
      loadEnv([], { rootDir: root, env: target });
    });
    expect(out).not.toContain('no schema knows');
    expect(target.LOG_LEVEL).toBe('DEBUG');
    expect(target.MCP_TRANSPORT).toBe('http');
  });

  it('registers every set secret with the logger, so it is masked verbatim in any entry', () => {
    initLogger({ name: 'env-test', fileMain: false, fileExceptions: false, fileDebug: false });
    envFile('SEARCH_KEY_2=search-secret-from-file\n');
    loadEnv(SCHEMA, { rootDir: root, env: { API_TOKEN: SECRET, SEARCH_KEY: 'search-secret-base' } });
    const out = captureStderr(() => {
      getLogger().info(`calling with ${SECRET}`, 'Test', { header: `x ${SECRET} y`, note: 'search-secret-from-file' });
      getLogger().warn('search-secret-base appears raw');
    });
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('search-secret-from-file');
    expect(out).not.toContain('search-secret-base');
    expect(out).toContain('[SECRET]');
  });

  it('warns (by key, never the value) about a secret too short to be masked', () => {
    initLogger({ name: 'env-test', fileMain: false, fileExceptions: false, fileDebug: false });
    const out = captureStderr(() => {
      loadEnv(SCHEMA, { rootDir: root, env: { MCP_ENV_FILE: 'none', API_TOKEN: 'abc12' } });
    });
    expect(out).toContain('env API_TOKEN is a secret shorter than 6 characters and cannot be masked');
    expect(out).not.toContain('abc12');
  });
});

describe('renderEnvTable / renderEnvExample', () => {
  it('renders a markdown table with every column and no secret default', () => {
    const table = renderEnvTable([
      ...SCHEMA,
      { key: 'SECRET_WITH_DEFAULT', secret: true, value: 'never-shown', description: 'a | pipe\nnewline' },
    ]);
    const lines = table.trim().split('\n');
    expect(lines[0]).toBe('| Key | Type | Required | Multi | Secret | Default | Description |');
    expect(lines).toContain('| `API_TOKEN` | string | yes | no | yes |  | API token |');
    expect(lines).toContain('| `SEARCH_KEY`, `SEARCH_KEY_*` | string | no | yes | yes |  | Rotating keys |');
    expect(lines).toContain('| `REGION` | enum (eu, us) | no | no | no |  |  |');
    expect(lines).toContain('| `PAGE_SIZE` | int | no | no | no | `50` |  |');
    expect(table).not.toContain('never-shown');
    expect(table).toContain('a \\| pipe newline');
  });

  it('includes the core keys on request', () => {
    expect(renderEnvTable([], { includeCore: true })).toContain('`MCP_API_KEY`');
    expect(renderEnvTable([])).not.toContain('MCP_API_KEY');
  });

  it('renders .env.example with comments, defaults, and empty secrets', () => {
    const text = renderEnvExample([...SCHEMA, { key: 'SECRET_WITH_DEFAULT', secret: true, value: 'never-shown' }]);
    expect(text).toContain('# API token (required; secret)\nAPI_TOKEN=\n');
    expect(text).toContain('# API base URL (url)\nAPI_URL=https://api.example.test\n');
    expect(text).toContain('# Rotating keys (secret; multi: also SEARCH_KEY_1, SEARCH_KEY_2, ...)\nSEARCH_KEY=\n');
    expect(text).toContain('# (enum (eu, us))\nREGION=\n');
    expect(text).toContain('SECRET_WITH_DEFAULT=\n');
    expect(text).not.toContain('never-shown');
    expect(renderEnvExample([], { includeCore: true })).toContain('DATA_STORAGE=true');
  });
});
