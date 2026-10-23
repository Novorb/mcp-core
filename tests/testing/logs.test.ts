import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  collectStrings,
  findLeaks,
  logFileName,
  logLevels,
  MIN_LEAK_NEEDLE_LENGTH,
  maskValue,
  readLogFiles,
} from '../../src/testing/index.js';
import { getLogger, initLogger, LogLevel, logToolCall, resetLogger } from '../../src/utils/logger.js';

describe('readLogFiles with the real logger', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-core-logs-'));
    for (const k of Object.keys(process.env)) if (k.startsWith('LOG_')) delete process.env[k];
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads <name>.log, exceptions.log and debug.log as the logger routes them', () => {
    initLogger({ name: 'my server', logDir: dir, console: false, level: LogLevel.DEBUG });
    getLogger().info('hello info', 'Startup');
    getLogger().error('bad thing', 'Tools');
    getLogger().debug('details', 'Tools');
    logToolCall('lookup', { key: 'secret-argument-value' });

    const logs = readLogFiles(dir, 'my server');
    expect(logs.paths.main).toBe(join(dir, 'my-server.log'));
    expect(logs.exists).toEqual({ main: true, exceptions: true, debug: true });
    expect(logs.main).toContain('hello info');
    expect(logs.main).toContain('Tool call: lookup');
    expect(logLevels(logs.main)).toEqual(['INFO', 'ERROR', 'DEBUG', 'INFO']);
    expect(logLevels(logs.exceptions)).toEqual(['ERROR']);
    expect(logLevels(logs.debug)).toEqual(['DEBUG']);
    expect(findLeaks([logs.main, logs.exceptions, logs.debug], ['secret-argument-value'])).toEqual([]);
  });

  it('reads the JSON format levels too', () => {
    initLogger({ name: 'json-srv', logDir: dir, console: false, format: 'json' });
    getLogger().warn('careful');
    getLogger().error('broken');
    expect(logLevels(readLogFiles(dir, 'json-srv').main)).toEqual(['WARN', 'ERROR']);
  });

  it('absent files read as empty with exists=false', () => {
    const logs = readLogFiles(dir, 'nothing-here');
    expect(logs).toMatchObject({
      main: '',
      exceptions: '',
      debug: '',
      exists: { main: false, exceptions: false, debug: false },
    });
  });

  it('honours a mainFile override, relative or absolute (LOG_FILE)', () => {
    initLogger({ name: 'x', logDir: dir, logFile: 'custom.log', console: false });
    getLogger().info('to custom');
    expect(readLogFiles(dir, 'x', { mainFile: 'custom.log' }).main).toContain('to custom');
    const abs = join(dir, 'custom.log');
    expect(readLogFiles('/elsewhere', 'x', { mainFile: abs }).paths.main).toBe(abs);
  });
});

describe('logFileName', () => {
  it('sanitises like the logger and refuses an empty result', () => {
    expect(logFileName('gitlab-mcp')).toBe('gitlab-mcp.log');
    expect(logFileName('a b/c')).toBe('a-b-c.log');
    expect(logFileName('..hidden')).toBe('hidden.log');
    expect(() => logFileName('...')).toThrow(/empty name/);
  });
});

describe('logLevels', () => {
  it('classifies text, JSON, unknown and invalid-JSON lines and skips blank lines', () => {
    const text = [
      '2026-10-23T10:00:00.000Z | INFO  | Ctx | message',
      '',
      '{"level":"DEBUG","message":"x"}',
      '{"message":"no level"}',
      '{not json',
      'plain text',
      '2026-10-23T10:00:00.000Z | ERROR | Ctx | message',
    ].join('\r\n');
    expect(logLevels(text)).toEqual(['INFO', 'DEBUG', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'ERROR']);
    expect(logLevels('')).toEqual([]);
    expect(logLevels('null\n')).toEqual(['UNKNOWN']);
  });
});

describe('findLeaks', () => {
  it('reports needles found verbatim, masked, with the texts they appear in', () => {
    const leaks = findLeaks(['log a: token-123456', 'log b', 'log c: token-123456'], ['token-123456', 'absent-value']);
    expect(leaks).toEqual([{ index: 0, preview: 'to***(len=12)', foundIn: [0, 2] }]);
    expect(JSON.stringify(leaks)).not.toContain('token-123456');
  });

  it('ignores empty, short and duplicate needles; minLength is configurable', () => {
    expect(MIN_LEAK_NEEDLE_LENGTH).toBe(6);
    expect(findLeaks(['abc abcde'], ['', 'abc', 'abcde'])).toEqual([]);
    expect(findLeaks(['abc'], ['abc'], { minLength: 3 })).toHaveLength(1);
    expect(findLeaks(['abc'], ['abc'], { minLength: 0 })).toHaveLength(1);
    expect(findLeaks(['secret-x secret-x'], ['secret-x', 'secret-x'])).toEqual([
      { index: 0, preview: 'se***(len=8)', foundIn: [0] },
    ]);
  });
});

describe('maskValue and collectStrings', () => {
  it('masks to two characters plus the length', () => {
    expect(maskValue('abcdefgh')).toBe('ab***(len=8)');
  });

  it('collects every nested string value', () => {
    expect(collectStrings({ a: 'x', b: [1, 'y', { c: 'z' }], d: null, e: true })).toEqual(['x', 'y', 'z']);
    expect(collectStrings('only')).toEqual(['only']);
    expect(collectStrings(undefined)).toEqual([]);
  });
});

describe('readLogFiles on hand-written files', () => {
  it('reads files it did not create through the logger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-core-logs-raw-'));
    try {
      writeFileSync(join(dir, 'exceptions.log'), 'x\n');
      const logs = readLogFiles(dir, 'srv');
      expect(logs.exists).toEqual({ main: false, exceptions: true, debug: false });
      expect(logs.exceptions).toBe('x\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
