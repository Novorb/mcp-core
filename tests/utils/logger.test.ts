import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  clearSecretValues,
  getLogger,
  initLogger,
  Logger,
  LogLevel,
  logToolCall,
  logToolResult,
  MIN_SECRET_LENGTH,
  maskPii,
  maskSecretValues,
  packageRootFrom,
  redactSecrets,
  registerSecretValues,
  resetLogger,
  summarizeArgs,
} from '../../src/utils/logger.js';

const LOG_ENV = [
  'LOG_LEVEL',
  'LOG_CONSOLE',
  'LOG_FILE_MAIN',
  'LOG_FILE_EXCEPTIONS',
  'LOG_FILE_DEBUG',
  'LOG_PATH',
  'LOG_FILE',
  'LOG_FORMAT',
] as const;

const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';

describe('Logger', () => {
  const tmpDir = path.join(process.cwd(), 'tests', '.tmp-logs');
  const logsDir = path.join(tmpDir, '.logs');
  const savedEnv: Partial<Record<(typeof LOG_ENV)[number], string>> = {};
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
  let stdoutSpy: jest.SpiedFunction<typeof process.stdout.write>;

  function stderrText(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  function read(file: string, dir = logsDir): string {
    return fs.readFileSync(path.join(dir, file), 'utf8');
  }

  function exists(file: string, dir = logsDir): boolean {
    return fs.existsSync(path.join(dir, file));
  }

  beforeEach(() => {
    resetLogger();
    for (const k of LOG_ENV) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write');
  });

  afterEach(() => {
    // The console sink is stderr only: no test may ever reach stdout (the stdio protocol channel).
    expect(stdoutSpy).not.toHaveBeenCalled();
    resetLogger();
    jest.restoreAllMocks();
    for (const k of LOG_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  describe('LogLevel', () => {
    it('has the documented numeric values', () => {
      expect([LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR]).toEqual([0, 1, 2, 3]);
    });
  });

  describe('defaults', () => {
    it('getLogger() without init is console-only and writes to stderr', () => {
      const logger = getLogger();
      expect(logger.sinks()).toEqual({ console: true });
      logger.info('hello', 'Ctx');
      expect(stderrText()).toMatch(new RegExp(`^${ISO} \\| INFO  \\| Ctx \\| hello\\n$`));
    });

    it('logs to <rootDir>/.logs with <name>.log, exceptions.log and debug.log', () => {
      const logger = initLogger({ name: 'gitlab-mcp', rootDir: tmpDir });
      expect(logger.sinks()).toEqual({
        console: true,
        main: path.join(logsDir, 'gitlab-mcp.log'),
        exceptions: path.join(logsDir, 'exceptions.log'),
        debug: path.join(logsDir, 'debug.log'),
      });
      expect(fs.statSync(logsDir).isDirectory()).toBe(true);
    });

    it('sanitises the name into a single safe file name', () => {
      const logger = initLogger({ name: '../My MCP/x', rootDir: tmpDir });
      expect(logger.sinks().main).toBe(path.join(logsDir, '-My-MCP-x.log'));
    });
  });

  describe('level-to-file routing', () => {
    it('INFO and WARN land in main only, ERROR in main + exceptions', () => {
      const logger = initLogger({ name: 'srv', rootDir: tmpDir });
      logger.info('info line');
      logger.warn('warn line');
      logger.error('error line');

      const main = read('srv.log');
      expect(main).toContain('info line');
      expect(main).toContain('warn line');
      expect(main).toContain('error line');
      const exceptions = read('exceptions.log');
      expect(exceptions).toContain('error line');
      expect(exceptions).not.toContain('info line');
      expect(exceptions).not.toContain('warn line');
      expect(exists('debug.log')).toBe(false);
    });

    it('DEBUG lands in main + debug only when DEBUG is enabled', () => {
      const logger = initLogger({ name: 'srv', rootDir: tmpDir, level: LogLevel.DEBUG });
      logger.debug('debug line');
      logger.info('info line');

      expect(read('srv.log')).toContain('debug line');
      expect(read('debug.log')).toContain('debug line');
      expect(read('debug.log')).not.toContain('info line');
      expect(exists('exceptions.log')).toBe(false);
    });

    it('DEBUG is dropped everywhere at the default INFO level', () => {
      const logger = initLogger({ name: 'srv', rootDir: tmpDir });
      logger.debug('hidden debug');
      expect(exists('debug.log')).toBe(false);
      expect(exists('srv.log')).toBe(false);
      expect(stderrText()).not.toContain('hidden debug');
    });

    it('the console gets every entry at or above the level', () => {
      const logger = initLogger({ name: 'srv', rootDir: tmpDir, level: LogLevel.WARN });
      logger.info('no');
      logger.warn('yes-warn');
      logger.error('yes-error');
      expect(stderrText()).not.toContain('no');
      expect(stderrText()).toContain('yes-warn');
      expect(stderrText()).toContain('yes-error');
    });
  });

  describe('env switches (config overrides env)', () => {
    it('LOG_LEVEL sets the minimum level, case-insensitively; an invalid value is ignored', () => {
      process.env.LOG_LEVEL = 'error';
      initLogger({ name: 'srv', rootDir: tmpDir }).warn('dropped');
      expect(exists('srv.log')).toBe(false);

      process.env.LOG_LEVEL = 'NOTALEVEL';
      initLogger({ name: 'srv', rootDir: tmpDir }).info('kept');
      expect(read('srv.log')).toContain('kept');
    });

    it('LOG_CONSOLE=false silences stderr; console: true overrides it', () => {
      process.env.LOG_CONSOLE = 'false';
      const logger = initLogger({ name: 'srv', rootDir: tmpDir });
      logger.info('file only');
      expect(stderrText()).toBe('');
      expect(read('srv.log')).toContain('file only');

      initLogger({ name: 'srv', rootDir: tmpDir, console: true }).info('console again');
      expect(stderrText()).toContain('console again');
    });

    it.each([
      ['LOG_FILE_MAIN', 'main'],
      ['LOG_FILE_EXCEPTIONS', 'exceptions'],
      ['LOG_FILE_DEBUG', 'debug'],
    ] as const)('%s=false disables the %s file sink', (envName, sink) => {
      process.env[envName] = 'false';
      const sinks = initLogger({ name: 'srv', rootDir: tmpDir }).sinks();
      expect(sinks[sink]).toBeUndefined();
      expect(Object.keys(sinks)).toHaveLength(3); // console + the two other files
    });

    it('accepts 0/1, yes/no and on/off, and ignores an unrecognised boolean', () => {
      process.env.LOG_FILE_DEBUG = '0';
      process.env.LOG_FILE_EXCEPTIONS = 'off';
      process.env.LOG_CONSOLE = 'maybe';
      const sinks = initLogger({ name: 'srv', rootDir: tmpDir }).sinks();
      expect(sinks.debug).toBeUndefined();
      expect(sinks.exceptions).toBeUndefined();
      expect(sinks.console).toBe(true);

      process.env.LOG_FILE_DEBUG = 'yes';
      process.env.LOG_FILE_EXCEPTIONS = '1';
      process.env.LOG_CONSOLE = 'no';
      const again = initLogger({ name: 'srv', rootDir: tmpDir }).sinks();
      expect(again.debug).toBeDefined();
      expect(again.exceptions).toBeDefined();
      expect(again.console).toBe(false);
    });

    it('a constructor flag overrides the env flag', () => {
      process.env.LOG_FILE_MAIN = 'false';
      expect(initLogger({ name: 'srv', rootDir: tmpDir, fileMain: true }).sinks().main).toBeDefined();
    });

    it('LOG_FORMAT=json switches to structured lines; an unknown format is ignored', () => {
      process.env.LOG_FORMAT = 'JSON';
      initLogger({ name: 'srv', rootDir: tmpDir }).info('structured', 'Comp', { extra: 42 });
      const parsed = JSON.parse(read('srv.log').trim());
      expect(parsed).toMatchObject({ level: 'INFO', component: 'Comp', message: 'structured', extra: 42 });

      process.env.LOG_FORMAT = 'xml';
      initLogger({ name: 'srv2', rootDir: tmpDir }).info('plain');
      expect(read('srv2.log')).toMatch(/\| INFO {2}\| General \| plain/);
    });

    it('LOG_PATH absolute overrides <rootDir>/.logs', () => {
      const dir = path.join(tmpDir, 'abs-dir');
      process.env.LOG_PATH = dir;
      initLogger({ name: 'srv', rootDir: tmpDir }).error('abs');
      expect(read('srv.log', dir)).toContain('abs');
      expect(read('exceptions.log', dir)).toContain('abs');
      expect(fs.existsSync(logsDir)).toBe(false);
    });

    it('LOG_PATH relative resolves against rootDir (never cwd), creating it recursively', () => {
      process.env.LOG_PATH = path.join('var', 'deep', 'logs');
      initLogger({ name: 'srv', rootDir: tmpDir }).info('relative');
      expect(read('srv.log', path.join(tmpDir, 'var', 'deep', 'logs'))).toContain('relative');
    });

    it('an explicit logDir overrides LOG_PATH', () => {
      process.env.LOG_PATH = path.join(tmpDir, 'from-env');
      const dir = path.join(tmpDir, 'from-config');
      initLogger({ name: 'srv', rootDir: tmpDir, logDir: dir }).info('cfg');
      expect(read('srv.log', dir)).toContain('cfg');
      expect(fs.existsSync(path.join(tmpDir, 'from-env'))).toBe(false);
    });

    it('LOG_FILE overrides the main file name; an absolute LOG_FILE is used as-is', () => {
      process.env.LOG_FILE = 'custom.log';
      expect(initLogger({ name: 'srv', rootDir: tmpDir }).sinks().main).toBe(path.join(logsDir, 'custom.log'));

      const abs = path.join(tmpDir, 'elsewhere', 'nested', 'main.log');
      process.env.LOG_FILE = abs;
      initLogger({ name: 'srv', rootDir: tmpDir }).info('absolute main');
      expect(fs.readFileSync(abs, 'utf8')).toContain('absolute main');
    });
  });

  describe('no log directory', () => {
    it('without rootDir and LOG_PATH the files stay off, with one console warning, never cwd', () => {
      const cwdLogs = path.join(process.cwd(), '.logs');
      const cwdLogsBefore = fs.existsSync(cwdLogs);
      const logger = initLogger({ name: 'srv' });
      initLogger({ name: 'srv' });
      logger.error('console only');

      expect(logger.sinks()).toEqual({ console: true });
      const warnings = stderrText()
        .split('\n')
        .filter((l) => l.includes('File logging disabled'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/\| WARN {2}\| Logger \| File logging disabled: no rootDir and no LOG_PATH/);
      expect(fs.existsSync(cwdLogs)).toBe(cwdLogsBefore);
    });

    it('a relative LOG_PATH without rootDir is refused (it would be cwd-relative)', () => {
      process.env.LOG_PATH = 'logs';
      expect(initLogger({ name: 'srv' }).sinks()).toEqual({ console: true });
      expect(stderrText()).toContain('File logging disabled: LOG_PATH "logs" is relative and no rootDir was given');
    });

    it('an absolute LOG_PATH works without rootDir', () => {
      process.env.LOG_PATH = path.join(tmpDir, 'no-root');
      initLogger({ name: 'srv' }).info('fine');
      expect(read('srv.log', path.join(tmpDir, 'no-root'))).toContain('fine');
    });

    it('no warning when every file sink is switched off', () => {
      initLogger({ name: 'srv', fileMain: false, fileExceptions: false, fileDebug: false });
      expect(stderrText()).toBe('');
    });

    it('the implicit default logger never warns', () => {
      getLogger().info('x');
      expect(stderrText()).not.toContain('File logging disabled');
    });
  });

  describe('name is required for the main file', () => {
    it('initLogger throws when the main file is enabled without name or LOG_FILE', () => {
      expect(() => initLogger({ rootDir: tmpDir })).toThrow(/name/);
    });

    it('LOG_FILE or fileMain: false satisfies it', () => {
      process.env.LOG_FILE = 'named.log';
      expect(() => initLogger({ rootDir: tmpDir })).not.toThrow();
      delete process.env.LOG_FILE;
      expect(() => initLogger({ rootDir: tmpDir, fileMain: false })).not.toThrow();
    });

    it('a nameless default logger simply has no main file', () => {
      process.env.LOG_PATH = path.join(tmpDir, 'nameless');
      const sinks = getLogger().sinks();
      expect(sinks.main).toBeUndefined();
      expect(sinks.exceptions).toBe(path.join(tmpDir, 'nameless', 'exceptions.log'));
    });
  });

  describe('initLogger reconfigures in place (import-order safety)', () => {
    it('keeps identity, and a logger captured before init writes to the file after init', () => {
      const captured = getLogger();
      const inited = initLogger({ name: 'srv', rootDir: tmpDir, console: false });
      expect(inited).toBe(captured);
      expect(getLogger()).toBe(captured);

      captured.info('after init', 'Tool');
      expect(read('srv.log')).toContain('after init');
      expect(stderrText()).not.toContain('after init');
    });

    it('creates the instance when none exists yet', () => {
      const logger = initLogger({ name: 'srv', rootDir: tmpDir });
      expect(getLogger()).toBe(logger);
    });

    it('a second initLogger recomputes from scratch (no stale overrides)', () => {
      const captured = getLogger();
      initLogger({ name: 'first', rootDir: tmpDir, level: LogLevel.ERROR });
      initLogger({ name: 'second', rootDir: tmpDir });
      captured.info('info lands');
      expect(exists('first.log')).toBe(false);
      expect(read('second.log')).toContain('info lands');
    });

    it('resetLogger drops the singleton', () => {
      const a = getLogger();
      resetLogger();
      expect(getLogger()).not.toBe(a);
    });

    it('setLevel changes the level dynamically', () => {
      const logger = initLogger({ name: 'srv', rootDir: tmpDir, level: LogLevel.ERROR });
      logger.info('before');
      logger.setLevel(LogLevel.INFO);
      logger.info('after');
      expect(read('srv.log')).not.toContain('before');
      expect(read('srv.log')).toContain('after');
    });
  });

  describe('rotation and sink isolation', () => {
    it('rotates each file independently', () => {
      const logger = initLogger({ name: 'srv', rootDir: tmpDir, maxLogSize: 100, maxLogFiles: 3, console: false });
      for (let i = 0; i < 12; i++) logger.error(`error number ${i} padded to exceed the rotation cap`);
      expect(exists('srv.log')).toBe(true);
      expect(exists('srv.log.1')).toBe(true);
      expect(exists('srv.log.2')).toBe(true);
      expect(exists('srv.log.3')).toBe(false);
      expect(exists('exceptions.log.1')).toBe(true);
    });

    it('a failing file sink does not affect the other sinks', () => {
      fs.mkdirSync(path.join(logsDir, 'exceptions.log'), { recursive: true }); // a directory: append fails
      const logger = initLogger({ name: 'srv', rootDir: tmpDir });
      expect(() => logger.error('still delivered')).not.toThrow();
      expect(read('srv.log')).toContain('still delivered');
      expect(stderrText()).toContain('still delivered');
    });

    it('an uncreatable directory fails silently', () => {
      const blocker = path.join(tmpDir, 'blocker');
      fs.writeFileSync(blocker, 'not a directory');
      process.env.LOG_PATH = path.join(blocker, 'sub');
      const logger = initLogger({ name: 'srv', console: false });
      expect(() => logger.error('nowhere')).not.toThrow();
      expect(stderrText()).toBe('');
    });
  });

  describe('console sink: stderr only, broken-pipe safe', () => {
    it('never calls console.log or stdout', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const logger = initLogger({ name: 'srv', rootDir: tmpDir, level: LogLevel.DEBUG });
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e', 'Ctx', { a: 1 });
      logToolCall('t', { a: 1 });
      logToolResult('t', { isError: true, durationMs: 1 });
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalled();
    });

    it('a synchronous EPIPE from stderr disables the console sink; files keep working', () => {
      stderrSpy.mockImplementation(() => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      });
      const logger = initLogger({ name: 'srv', rootDir: tmpDir });
      logger.info('one');
      logger.info('two');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(read('srv.log')).toContain('two');
    });

    it('an asynchronous EPIPE error event on stderr disables the console sink', () => {
      const logger = initLogger({ name: 'srv', rootDir: tmpDir });
      process.stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      logger.info('after epipe');
      expect(stderrText()).not.toContain('after epipe');
      expect(read('srv.log')).toContain('after epipe');
    });

    it('a non-pipe stderr failure is swallowed without disabling the sink', () => {
      let calls = 0;
      stderrSpy.mockImplementation(() => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return true;
      });
      const logger = getLogger();
      expect(() => logger.info('first')).not.toThrow();
      logger.info('second');
      expect(calls).toBe(2);
    });
  });

  describe('captureProcessErrors', () => {
    type Handler = (err: unknown) => void;

    function lastListener(event: 'uncaughtException' | 'unhandledRejection'): Handler {
      const listeners = process.listeners(event) as Handler[];
      return listeners[listeners.length - 1];
    }

    function mockExit(impl?: () => void): jest.SpiedFunction<typeof process.exit> {
      return jest.spyOn(process, 'exit').mockImplementation(((): never => {
        impl?.();
        return undefined as never;
      }) as typeof process.exit);
    }

    it('is off by default', () => {
      const before = process.listenerCount('uncaughtException');
      initLogger({ name: 'srv', rootDir: tmpDir });
      expect(process.listenerCount('uncaughtException')).toBe(before);
    });

    it('writes an uncaught exception to main + exceptions (masked) and exits non-zero', () => {
      const exit = mockExit();
      initLogger({ name: 'srv', rootDir: tmpDir, captureProcessErrors: true });
      lastListener('uncaughtException')(new Error('boom for jane@example.com'));

      for (const f of ['srv.log', 'exceptions.log']) {
        const text = read(f);
        expect(text).toContain('| ERROR | Process | Uncaught exception: Error: boom for [EMAIL]');
        expect(text).toContain('"stack"');
        expect(text).not.toContain('jane@example.com');
      }
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('writes an unhandled rejection with a non-Error reason', () => {
      const exit = mockExit();
      initLogger({ name: 'srv', rootDir: tmpDir, captureProcessErrors: true });
      lastListener('unhandledRejection')('plain reason');
      expect(read('exceptions.log')).toContain('Unhandled rejection: plain reason');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('is re-entrancy guarded: a fault while handling a fault is not logged again', () => {
      const exit = mockExit(() => lastListener('uncaughtException')(new Error('second fault')));
      initLogger({ name: 'srv', rootDir: tmpDir, captureProcessErrors: true });
      lastListener('uncaughtException')(new Error('first fault'));

      const text = read('exceptions.log');
      expect(text).toContain('first fault');
      expect(text).not.toContain('second fault');
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it('an EPIPE on stderr is never logged back to stderr (no loop), but reaches the files', () => {
      const exit = mockExit();
      initLogger({ name: 'srv', rootDir: tmpDir, captureProcessErrors: true });
      stderrSpy.mockClear();
      lastListener('uncaughtException')(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

      expect(stderrSpy).not.toHaveBeenCalled();
      expect(read('exceptions.log')).toContain('write EPIPE');
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it('reconfiguring with captureProcessErrors off, or resetLogger, removes the handlers', () => {
      const before = process.listenerCount('uncaughtException');
      const beforeRej = process.listenerCount('unhandledRejection');
      initLogger({ name: 'srv', rootDir: tmpDir, captureProcessErrors: true });
      initLogger({ name: 'srv', rootDir: tmpDir, captureProcessErrors: true });
      expect(process.listenerCount('uncaughtException')).toBe(before + 1);
      expect(process.listenerCount('unhandledRejection')).toBe(beforeRej + 1);

      initLogger({ name: 'srv', rootDir: tmpDir });
      expect(process.listenerCount('uncaughtException')).toBe(before);

      initLogger({ name: 'srv', rootDir: tmpDir, captureProcessErrors: true });
      resetLogger();
      expect(process.listenerCount('uncaughtException')).toBe(before);
      expect(process.listenerCount('unhandledRejection')).toBe(beforeRej);
    });
  });

  describe('formats', () => {
    it('text: timestamp | LEVEL | context | message, levels padded to 5, General default', () => {
      const logger = initLogger({ name: 'fmt', rootDir: tmpDir, level: LogLevel.DEBUG, console: false });
      logger.debug('d');
      logger.info('hello world', 'MyServer');
      logger.warn('w');
      logger.error('e');
      const lines = read('fmt.log').trim().split('\n');
      expect(lines[0]).toMatch(new RegExp(`^${ISO} \\| DEBUG \\| General \\| d$`));
      expect(lines[1]).toMatch(new RegExp(`^${ISO} \\| INFO  \\| MyServer \\| hello world$`));
      expect(lines[2]).toMatch(/\| WARN {2}\|/);
      expect(lines[3]).toMatch(/\| ERROR \|/);
    });

    it('text: appends redacted meta as JSON', () => {
      initLogger({ name: 'fmt', rootDir: tmpDir }).info('with meta', 'Ctx', { item: 'value', api_key: 'SECRET' });
      const line = read('fmt.log');
      expect(line).toContain('| {"item":"value","api_key":"[REDACTED]"}');
      expect(line).not.toContain('SECRET');
    });

    it('json: spreads object meta, puts primitive meta under "meta", defaults component to General', () => {
      const logger = initLogger({ name: 'fmt', rootDir: tmpDir, format: 'json' });
      logger.info('one', undefined, { extra: 42 });
      logger.info('two', 'C', 'just-a-string');
      logger.info('three', 'C', 7);
      const [a, b, c] = read('fmt.log')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(a).toMatchObject({ level: 'INFO', component: 'General', message: 'one', extra: 42 });
      expect(b.meta).toBe('just-a-string');
      expect(c.meta).toBe(7);
    });

    it('strips CR/LF from message and context in text mode (no forged lines)', () => {
      getLogger().error('line1\nINJECTED 2099 | ERROR | x | forged', 'Ctx\r\nEvil');
      expect(stderrText().trimEnd().split('\n')).toHaveLength(1);
    });
  });

  describe('security: every entry is redacted and PII-masked', () => {
    it('masks the message and every meta string, in text and json, on console and files', () => {
      for (const format of ['text', 'json'] as const) {
        resetLogger();
        stderrSpy.mockClear();
        const file = `sec-${format}`;
        initLogger({ name: file, rootDir: tmpDir, format }).error(
          'GET https://x.test/v?access_token=MSG_SECRET from 10.1.2.3 failed for ops@example.com',
          'Http',
          { user: { phone: '+31 6 12345678', card: '4111 1111 1111 1111' }, auth: 'Bearer abc123DEF456ghi789' },
        );
        for (const out of [read(`${file}.log`), stderrText()]) {
          expect(out).not.toContain('MSG_SECRET');
          expect(out).not.toContain('10.1.2.3');
          expect(out).not.toContain('ops@example.com');
          expect(out).not.toContain('12345678');
          expect(out).not.toContain('4111');
          expect(out).not.toContain('abc123DEF456ghi789');
          expect(out).toContain('access_token=[REDACTED]');
          expect(out).toContain('[IP]');
          expect(out).toContain('[EMAIL]');
          expect(out).toContain('[PHONE]');
          expect(out).toContain('[CARD]');
        }
      }
    });

    it('re-exports redactSecrets and maskPii', () => {
      expect(redactSecrets({ token: 'x' })).toEqual({ token: '[REDACTED]' });
      expect(maskPii('a@b.io')).toBe('[EMAIL]');
    });
  });

  describe('summarizeArgs', () => {
    it('describes each top-level key by shape only', () => {
      expect(
        summarizeArgs({
          name: 'abc',
          count: 3,
          flag: false,
          items: [1, 2, 3, 4],
          options: { masked: true, protected: false },
          nothing: null,
          missing: undefined,
          big: BigInt(7),
          fn: () => 1,
        }),
      ).toEqual({
        name: 'string(3)',
        count: 'number',
        flag: 'boolean',
        items: 'array(4)',
        options: 'object{masked,protected}',
        nothing: 'null',
        missing: 'undefined',
        big: 'bigint',
        fn: 'function',
      });
    });

    it('never contains a value, at any depth', () => {
      const secrets = ['CI_VAR_SECRET', 'QkFTRTY0Qk9N', 'file contents here', '424242', 'deep-secret'];
      const summary = summarizeArgs({
        value: secrets[0],
        bom: secrets[1],
        content: secrets[2],
        pin: 424242,
        nested: { inner: { deeper: secrets[4] } },
        list: [secrets[0], { x: secrets[4] }],
      });
      const text = JSON.stringify(summary);
      for (const s of secrets) expect(text).not.toContain(s);
      expect(summary.nested).toBe('object{inner}');
      expect(summary.list).toBe('array(2)');
    });

    it('caps the nested key list so a huge map cannot flood the line', () => {
      const wide: Record<string, number> = {};
      for (let i = 0; i < 30; i++) wide[`k${i}`] = i;
      const out = summarizeArgs({ wide }).wide;
      expect(out.startsWith('object{k0,k1,')).toBe(true);
      expect(out.endsWith(',...+10}')).toBe(true);
    });

    it('summarises non-object args under a single _args key', () => {
      expect(summarizeArgs(undefined)).toEqual({});
      expect(summarizeArgs(null)).toEqual({});
      expect(summarizeArgs('secret-string')).toEqual({ _args: 'string(13)' });
      expect(summarizeArgs([1, 2])).toEqual({ _args: 'array(2)' });
    });
  });

  describe('logToolCall / logToolResult', () => {
    it('writes a stable INFO "Tool call: <name>" line with a shape-only args summary', () => {
      initLogger({ name: 'tool', rootDir: tmpDir });
      logToolCall('gitlab_create_variable', { project: 'g/p', value: 'TOP_SECRET_CI_VALUE' });

      const line = read('tool.log').trim();
      expect(line).toMatch(
        new RegExp(
          `^${ISO} \\| INFO  \\| Tools \\| Tool call: gitlab_create_variable \\| \\{"tool":"gitlab_create_variable","args":\\{"project":"string\\(3\\)","value":"string\\(19\\)"\\}\\}$`,
        ),
      );
      expect(line).not.toContain('TOP_SECRET_CI_VALUE');
      expect(stderrText()).not.toContain('TOP_SECRET_CI_VALUE');
    });

    it('writes INFO "Tool result: <name>" on success and WARN on error, duration rounded', () => {
      initLogger({ name: 'tool', rootDir: tmpDir });
      logToolResult('dns_list', { isError: false, durationMs: 12.6 });
      logToolResult('dns_list', { isError: true, durationMs: 3 }, 'DnsServer');

      const [ok, bad] = read('tool.log').trim().split('\n');
      expect(ok).toMatch(
        new RegExp(
          `^${ISO} \\| INFO  \\| Tools \\| Tool result: dns_list \\| \\{"tool":"dns_list","isError":false,"durationMs":13\\}$`,
        ),
      );
      expect(bad).toMatch(
        new RegExp(
          `^${ISO} \\| WARN  \\| DnsServer \\| Tool result: dns_list \\| \\{"tool":"dns_list","isError":true,"durationMs":3\\}$`,
        ),
      );
      expect(exists('exceptions.log')).toBe(false); // a tool error is WARN, not an exception
    });

    it('honours the context argument and the json format', () => {
      initLogger({ name: 'tool', rootDir: tmpDir, format: 'json' });
      logToolCall('upload', { content: 'abc' }, 'Files');
      expect(JSON.parse(read('tool.log').trim())).toMatchObject({
        level: 'INFO',
        component: 'Files',
        message: 'Tool call: upload',
        tool: 'upload',
        args: { content: 'string(3)' },
      });
    });

    it('goes through the singleton, so it respects an initLogger done later', () => {
      getLogger();
      initLogger({ name: 'late', rootDir: tmpDir, console: false });
      logToolCall('late_tool', {});
      expect(read('late.log')).toContain('Tool call: late_tool | {"tool":"late_tool","args":{}}');
    });
  });

  describe('packageRootFrom', () => {
    const pkg = path.join(tmpDir, 'pkg');

    beforeEach(() => {
      fs.mkdirSync(path.join(pkg, 'dist', 'tools'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    });

    it('walks up from a file URL to the nearest package.json (Windows-safe, no URL.pathname)', () => {
      const url = pathToFileURL(path.join(pkg, 'dist', 'tools', 'index.js')).href;
      expect(packageRootFrom(url)).toBe(pkg);
      expect(packageRootFrom(new URL(url))).toBe(pkg);
    });

    it('accepts a plain file path too', () => {
      expect(packageRootFrom(path.join(pkg, 'dist', 'index.js'))).toBe(pkg);
    });

    it('feeds rootDir directly', () => {
      const root = packageRootFrom(pathToFileURL(path.join(pkg, 'dist', 'index.js')).href);
      initLogger({ name: 'pkg-mcp', rootDir: root }).info('in package');
      expect(read('pkg-mcp.log', path.join(pkg, '.logs'))).toContain('in package');
    });

    it('throws when no package.json exists up to the filesystem root', () => {
      const root = path.parse(process.cwd()).root;
      const probe = path.join(root, 'mcp-core-no-such-dir-7f3a', 'index.js');
      if (fs.existsSync(path.join(root, 'package.json'))) {
        expect(packageRootFrom(probe)).toBe(root);
      } else {
        expect(() => packageRootFrom(probe)).toThrow(/package\.json/);
      }
    });
  });

  describe('Logger class', () => {
    it('can be constructed directly with the same config', () => {
      const logger = new Logger({ name: 'direct', rootDir: tmpDir, console: false });
      logger.info('direct');
      expect(read('direct.log')).toContain('direct');
    });
  });

  describe('fix round 1', () => {
    type Handler = (err: unknown) => void;

    function lastListeners(event: 'uncaughtException'): Handler[] {
      return process.listeners(event) as Handler[];
    }

    it('masks the context argument (text and json)', () => {
      for (const format of ['text', 'json'] as const) {
        resetLogger();
        stderrSpy.mockClear();
        initLogger({ name: `ctx-${format}`, rootDir: tmpDir, format }).info('m', 'user bob@x.com from 10.0.0.1');
        const out = read(`ctx-${format}.log`) + stderrText();
        expect(out).not.toContain('bob@x.com');
        expect(out).not.toContain('10.0.0.1');
        expect(out).toContain('user [EMAIL] from [IP]');
      }
    });

    it('json: meta can never overwrite level, timestamp, component or message', () => {
      initLogger({ name: 'json-res', rootDir: tmpDir, format: 'json' }).error('real message', 'Real', {
        level: 'DEBUG',
        message: 'forged',
        component: 'Auth',
        timestamp: 'then',
        other: 1,
      });
      const parsed = JSON.parse(read('json-res.log').trim());
      expect(parsed.level).toBe('ERROR');
      expect(parsed.message).toBe('real message');
      expect(parsed.component).toBe('Real');
      expect(parsed.timestamp).not.toBe('then');
      expect(parsed.other).toBe(1);
      expect(parsed.meta).toEqual({ level: 'DEBUG', message: 'forged', component: 'Auth', timestamp: 'then' });
      expect(read('exceptions.log')).toContain('"level":"ERROR"');
    });

    it('json: array meta goes under "meta", not spread as index keys', () => {
      initLogger({ name: 'json-arr', rootDir: tmpDir, format: 'json' }).info('arr', 'C', ['a', 'b']);
      const parsed = JSON.parse(read('json-arr.log').trim());
      expect(parsed.meta).toEqual(['a', 'b']);
      expect(parsed['0']).toBeUndefined();
    });

    it('never throws into the caller on circular or BigInt meta (text and json)', () => {
      const circ: Record<string, unknown> = { a: 1 };
      circ.self = circ;
      for (const format of ['text', 'json'] as const) {
        resetLogger();
        const logger = initLogger({ name: `circ-${format}`, rootDir: tmpDir, format });
        expect(() => logger.error('circular', 'C', circ)).not.toThrow();
        expect(() => logger.error('bigint', 'C', { n: BigInt(5) })).not.toThrow();
        const text = read(`circ-${format}.log`);
        expect(text).toContain('[CIRCULAR]');
        expect(text).toContain('"n":"5"');
      }
    });

    it('logs Error meta with its message and stack instead of {}', () => {
      initLogger({ name: 'errmeta', rootDir: tmpDir }).error('failed', 'Http', { error: new Error('socket hang up') });
      const text = read('errmeta.log');
      expect(text).toContain('"message":"socket hang up"');
      expect(text).toContain('"stack"');
    });

    it('falls back to an "unserialisable meta" line when serialising fails', () => {
      const logger = initLogger({ name: 'unser', rootDir: tmpDir });
      const real = JSON.stringify;
      const spy = jest.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
        throw new Error('nope');
      });
      expect(() => logger.error('still logged', 'C', { a: 1 })).not.toThrow();
      spy.mockRestore();
      expect(JSON.stringify).toBe(real);
      expect(read('unser.log')).toMatch(/\| ERROR \| C \| still logged \| "\[unserialisable meta\]"$/m);
    });

    it('caps a huge line (text) and keeps a huge json line parseable', () => {
      const big: Record<string, string> = {};
      for (let i = 0; i < 200; i++) big[`k${i}`] = 'v '.repeat(16000);
      for (const format of ['text', 'json'] as const) {
        resetLogger();
        initLogger({ name: `big-${format}`, rootDir: tmpDir, format, console: false }).info('big', 'C', big);
        const line = read(`big-${format}.log`);
        expect(line.length).toBeLessThan(300 * 1024);
        if (format === 'json') {
          const parsed = JSON.parse(line.trim());
          expect(parsed.message).toBe('big');
          expect(String(parsed.meta)).toMatch(/^\[TRUNCATED: meta too large \(\d+ chars\)\]$/);
        } else {
          expect(line.trimEnd()).toMatch(/\.\.\.\[TRUNCATED \d+ chars\]$/);
        }
      }
    });

    it('logs a 5 MiB message quickly', () => {
      const logger = initLogger({ name: 'fast', rootDir: tmpDir, console: false });
      const started = performance.now();
      logger.info('A'.repeat(5 * 1024 * 1024));
      expect(performance.now() - started).toBeLessThan(500);
      expect(read('fast.log')).toMatch(/\[TRUNCATED \d+ chars\]/);
    });

    it('a crash whose error is circular still writes the fatal line', () => {
      const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
      initLogger({ name: 'fatal-circ', rootDir: tmpDir, captureProcessErrors: true });
      const err = new Error('circular crash') as Error & { self?: unknown };
      err.self = err;
      const listeners = lastListeners('uncaughtException');
      listeners[listeners.length - 1](err);
      expect(read('exceptions.log')).toContain('Uncaught exception: Error: circular crash');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('re-entrancy is process-wide: two capturing loggers log and exit once', () => {
      const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
      const before = process.listenerCount('uncaughtException');
      initLogger({ name: 'one', rootDir: tmpDir, captureProcessErrors: true });
      const second = new Logger({ name: 'two', rootDir: tmpDir, captureProcessErrors: true });
      const added = lastListeners('uncaughtException').slice(before);
      expect(added).toHaveLength(2);
      for (const h of added) h(new Error('once only'));
      expect(exit).toHaveBeenCalledTimes(1);
      const fatalLines = (file: string): number =>
        exists(file)
          ? read(file)
              .split('\n')
              .filter((l) => l.includes('Uncaught exception: Error: once only')).length
          : 0;
      expect(fatalLines('one.log') + fatalLines('two.log')).toBe(1);
      second.detachProcessHandlers();
    });

    it('warns that only exceptions/debug are off when an absolute LOG_FILE has no directory', () => {
      process.env.LOG_FILE = path.join(tmpDir, 'only-main.log');
      initLogger({ name: 'srv' }).info('main works');
      expect(fs.readFileSync(path.join(tmpDir, 'only-main.log'), 'utf8')).toContain('main works');
      expect(stderrText()).toContain('exceptions.log and debug.log disabled: no rootDir and no LOG_PATH');
      expect(stderrText()).not.toContain('File logging disabled');
    });

    const winIt = process.platform === 'win32' ? it : it.skip;

    winIt.each(['C:logs', '\\logs'])(
      'refuses the drive- or root-relative LOG_PATH %s (it would resolve against a cwd)',
      (p) => {
        process.env.LOG_PATH = p;
        const sinks = initLogger({ name: 'srv', rootDir: tmpDir }).sinks();
        expect(sinks).toEqual({ console: true });
        expect(stderrText()).toContain(`LOG_PATH "${p}" is drive- or root-relative`);
      },
    );

    winIt('refuses a drive- or root-relative LOG_FILE', () => {
      process.env.LOG_FILE = '\\main.log';
      const sinks = initLogger({ name: 'srv', rootDir: tmpDir }).sinks();
      expect(sinks.main).toBeUndefined();
      expect(sinks.exceptions).toBeDefined();
      expect(stderrText()).toContain('LOG_FILE "\\main.log" is drive- or root-relative');
    });

    it('maxLogFiles 1 keeps only the active file; 0 is treated as 1 (no ".-1" files)', () => {
      for (const keep of [1, 0]) {
        resetLogger();
        const dir = path.join(tmpDir, `keep-${keep}`);
        const logger = initLogger({ name: 'r', logDir: dir, maxLogSize: 100, maxLogFiles: keep, console: false });
        for (let i = 0; i < 10; i++) logger.info(`rotation line ${i} padded to exceed the cap`);
        const files = fs.readdirSync(dir).sort();
        expect(files).toEqual(['r.log']);
      }
    });

    it('rotates a file that already exceeds the cap at startup', () => {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, 'pre.log'), 'x'.repeat(500));
      initLogger({ name: 'pre', rootDir: tmpDir, maxLogSize: 100, console: false }).info('fresh');
      expect(read('pre.log.1')).toBe('x'.repeat(500));
      expect(read('pre.log')).toContain('fresh');
    });

    it('recreates the log directory if it is deleted after init', () => {
      const logger = initLogger({ name: 'gone', rootDir: tmpDir, console: false });
      logger.info('first');
      fs.rmSync(logsDir, { recursive: true });
      logger.info('second');
      expect(read('gone.log')).toContain('second');
    });

    it('the stderr guard re-throws a non-pipe error when it is the only listener', () => {
      // Other suites may leave stderr error listeners behind; take them off for this assertion.
      const others = process.stderr.listeners('error') as Array<(err: Error) => void>;
      for (const l of others) process.stderr.removeListener('error', l);
      try {
        initLogger({ name: 'g', rootDir: tmpDir });
        expect(() => process.stderr.emit('error', new Error('not a pipe error'))).toThrow('not a pipe error');
      } finally {
        for (const l of others) process.stderr.on('error', l);
      }
    });

    it('the stderr guard is removed when no logger has the console on', () => {
      const before = process.stderr.listenerCount('error');
      initLogger({ name: 'g', rootDir: tmpDir });
      expect(process.stderr.listenerCount('error')).toBe(before + 1);
      initLogger({ name: 'g', rootDir: tmpDir, console: false });
      expect(process.stderr.listenerCount('error')).toBe(before);
    });

    it('a real child process with a destroyed stderr pipe logs its crash once and exits 1 (no loop)', async () => {
      const { spawn } = await import('node:child_process');
      const { createRequire } = await import('node:module');
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const fixture = path.join(process.cwd(), 'tests', 'utils', 'fixtures', 'epipe-child.ts');
      const dir = path.join(tmpDir, 'child');
      const child = spawn(process.execPath, ['--import', tsx, fixture, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr?.destroy();
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

      expect(code).toBe(1);
      const main = fs.readFileSync(path.join(dir, 'epipe.log'), 'utf8');
      expect(main.split('\n').filter(Boolean)).toHaveLength(41);
      expect(main.split('Uncaught exception: Error: after-epipe').length - 1).toBe(1);
      expect(fs.statSync(path.join(dir, 'epipe.log')).size).toBeLessThan(200 * 1024);
      expect(fs.readFileSync(path.join(dir, 'exceptions.log'), 'utf8')).toContain('after-epipe');
    }, 30000);
  });

  describe('registerSecretValues (verbatim secret masking)', () => {
    const secret = 'sk-live-9f8e7d6c5b';

    it('masks a registered value in message, context and meta, text and json, files and console', () => {
      initLogger({ name: 'sec', rootDir: tmpDir });
      registerSecretValues([secret]);
      getLogger().info(`token ${secret} used`, `ctx-${secret}`, { nested: { header: `x${secret}y` } });
      initLogger({ name: 'sec', rootDir: tmpDir, format: 'json' });
      getLogger().error(`json ${secret}`, 'C', { list: [secret] });
      const all = read('sec.log') + read('exceptions.log') + stderrText();
      expect(all).not.toContain(secret);
      expect(all.split('[SECRET]').length - 1).toBeGreaterThanOrEqual(6);
    });

    it('masks the JSON-escaped form of a secret containing quotes or backslashes', () => {
      initLogger({ name: 'sec', rootDir: tmpDir, format: 'json' });
      const odd = 'pa"ss\\word-123';
      registerSecretValues([odd]);
      getLogger().info('m', 'C', { raw: odd });
      const line = read('sec.log');
      expect(line).not.toContain(JSON.stringify(odd).slice(1, -1));
      expect(line).toContain('[SECRET]');
    });

    it('masks the longest secret first and ignores values shorter than MIN_SECRET_LENGTH', () => {
      initLogger({ name: 'sec', rootDir: tmpDir });
      registerSecretValues(['abcdef', 'abcdefghij', 'short', '']);
      expect(MIN_SECRET_LENGTH).toBe(6);
      getLogger().info('abcdefghij and abcdef and short');
      expect(read('sec.log')).toContain('[SECRET] and [SECRET] and short');
    });

    it('clearSecretValues and resetLogger forget the values; maskSecretValues is a no-op when empty', () => {
      registerSecretValues([secret]);
      expect(maskSecretValues(`a ${secret}`)).toBe('a [SECRET]');
      clearSecretValues();
      expect(maskSecretValues(`a ${secret}`)).toBe(`a ${secret}`);
      registerSecretValues([secret]);
      resetLogger();
      expect(maskSecretValues(secret)).toBe(secret);
    });
  });
});
