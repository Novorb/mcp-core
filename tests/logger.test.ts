import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { Logger, LogLevel, initLogger, getLogger, resetLogger } from '../src/logger.js';

describe('Logger', () => {
  const tmpDir = path.join(process.cwd(), 'tests', '.tmp-logs');

  beforeEach(() => {
    resetLogger();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  describe('LogLevel', () => {
    it('should have correct numeric values', () => {
      expect(LogLevel.DEBUG).toBe(0);
      expect(LogLevel.INFO).toBe(1);
      expect(LogLevel.WARN).toBe(2);
      expect(LogLevel.ERROR).toBe(3);
    });
  });

  describe('file output', () => {
    it('should create log directory and write logs', () => {
      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'test.log',
        level: LogLevel.DEBUG,
      });

      logger.info('test message', 'TestCtx');

      const logPath = path.join(tmpDir, 'test.log');
      expect(fs.existsSync(logPath)).toBe(true);

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('INFO');
      expect(content).toContain('test message');
      expect(content).toContain('TestCtx');
    });

    it('should include metadata in log', () => {
      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'meta.log',
      });

      logger.info('with meta', 'Ctx', { key: 'value' });

      const content = fs.readFileSync(path.join(tmpDir, 'meta.log'), 'utf8');
      expect(content).toContain('"key":"value"');
    });

    it('should filter by log level', () => {
      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'level.log',
        level: LogLevel.WARN,
      });

      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');

      const content = fs.readFileSync(path.join(tmpDir, 'level.log'), 'utf8');
      expect(content).not.toContain('debug msg');
      expect(content).not.toContain('info msg');
      expect(content).toContain('warn msg');
      expect(content).toContain('error msg');
    });

    it('should rotate logs when size exceeded', () => {
      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'rotate.log',
        maxLogSize: 100, // Very small for testing
        maxLogFiles: 3,
      });

      // Write enough to trigger rotation
      for (let i = 0; i < 10; i++) {
        logger.info(`Message number ${i} with some padding to fill the log`);
      }

      const logPath = path.join(tmpDir, 'rotate.log');
      expect(fs.existsSync(logPath)).toBe(true);
      expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    });
  });

  describe('stderr output', () => {
    it('should write to stderr', () => {
      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const logger = new Logger({ output: 'stderr', format: 'text' });
      logger.info('stderr test', 'Ctx');

      expect(stderrSpy).toHaveBeenCalled();
      const written = stderrSpy.mock.calls[0][0] as string;
      expect(written).toContain('INFO');
      expect(written).toContain('stderr test');

      stderrSpy.mockRestore();
    });
  });

  describe('security: meta redaction + log-injection', () => {
    function capture(format: 'text' | 'json', message: string, context: string | undefined, meta: unknown): string {
      const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      new Logger({ output: 'stderr', format }).error(message, context, meta);
      const out = spy.mock.calls[0][0] as string;
      spy.mockRestore();
      return out;
    }

    it('redacts sensitive-keyed fields in meta (text + json)', () => {
      const meta = {
        api_key: 'SECRET_KEY',
        authorization: 'Bearer SECRET_TOKEN',
        nested: { password: 'p@ss', accessToken: 'AT123', safe: 'keep' },
        url: 'https://example.com',
      };
      for (const fmt of ['text', 'json'] as const) {
        const out = capture(fmt, 'req failed', 'Http', meta);
        expect(out).not.toContain('SECRET_KEY');
        expect(out).not.toContain('SECRET_TOKEN');
        expect(out).not.toContain('p@ss');
        expect(out).not.toContain('AT123');
        expect(out).toContain('[REDACTED]');
        expect(out).toContain('keep');                 // non-sensitive value preserved
        expect(out).toContain('https://example.com');
      }
    });

    it('redacts a raw AxiosError-shaped object (config.params.api_key etc.)', () => {
      const axiosLike = { message: 'boom', config: { headers: { Authorization: 'Bearer LEAK' }, params: { api_key: 'LEAK2' } } };
      const out = capture('json', 'GET failed', 'Http', axiosLike);
      expect(out).not.toContain('LEAK');
      expect(out).not.toContain('LEAK2');
    });

    it('strips CR/LF from message + context in text mode (no forged log lines)', () => {
      const out = capture('text', 'line1\nINJECTED 2099 | ERROR | x | forged', 'Ctx\r\nEvil', undefined);
      expect(out.trimEnd().split('\n')).toHaveLength(1); // exactly one log line
      expect(out).not.toContain('\nINJECTED');
    });
  });

  describe('json format', () => {
    it('should output structured JSON', () => {
      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'json.log',
        format: 'json',
      });

      logger.info('json msg', 'Component', { extra: 42 });

      const content = fs.readFileSync(path.join(tmpDir, 'json.log'), 'utf8').trim();
      const parsed = JSON.parse(content);
      expect(parsed.level).toBe('INFO');
      expect(parsed.message).toBe('json msg');
      expect(parsed.component).toBe('Component');
      expect(parsed.extra).toBe(42);
    });
  });

  describe('setLevel', () => {
    it('should change level dynamically', () => {
      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'dynamic.log',
        level: LogLevel.ERROR,
      });

      logger.info('should not appear');
      logger.setLevel(LogLevel.INFO);
      logger.info('should appear');

      const content = fs.readFileSync(path.join(tmpDir, 'dynamic.log'), 'utf8');
      expect(content).not.toContain('should not appear');
      expect(content).toContain('should appear');
    });
  });

  describe('text format alignment', () => {
    it('should pad all log levels to 5 characters', () => {
      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'align.log',
        level: LogLevel.DEBUG,
      });

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const lines = fs.readFileSync(path.join(tmpDir, 'align.log'), 'utf8').trim().split('\n');
      // Each level field should be exactly 5 chars between the pipes
      expect(lines[0]).toMatch(/\| DEBUG \|/);
      expect(lines[1]).toMatch(/\| INFO  \|/);
      expect(lines[2]).toMatch(/\| WARN  \|/);
      expect(lines[3]).toMatch(/\| ERROR \|/);
    });

    it('should use "General" as default context when none provided', () => {
      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'default-ctx.log',
      });

      logger.info('no context');

      const content = fs.readFileSync(path.join(tmpDir, 'default-ctx.log'), 'utf8');
      expect(content).toContain('| General |');
    });

    it('should match format: timestamp | LEVEL | context | message', () => {
      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'format.log',
      });

      logger.info('hello world', 'MyServer');

      const content = fs.readFileSync(path.join(tmpDir, 'format.log'), 'utf8').trim();
      // ISO timestamp | padded level | context | message
      expect(content).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \| INFO  \| MyServer \| hello world$/
      );
    });
  });

  describe('environment variable config', () => {
    const origEnv = { ...process.env };

    afterEach(() => {
      process.env.LOG_LEVEL = origEnv.LOG_LEVEL;
      process.env.LOG_PATH = origEnv.LOG_PATH;
      process.env.LOG_FILE = origEnv.LOG_FILE;
      // Clean up any undefined keys
      if (origEnv.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL;
      if (origEnv.LOG_PATH === undefined) delete process.env.LOG_PATH;
      if (origEnv.LOG_FILE === undefined) delete process.env.LOG_FILE;
    });

    it('should read LOG_LEVEL from env', () => {
      process.env.LOG_LEVEL = 'ERROR';

      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'env-level.log',
      });

      logger.info('should not appear');
      logger.error('should appear');

      const content = fs.readFileSync(path.join(tmpDir, 'env-level.log'), 'utf8');
      expect(content).not.toContain('should not appear');
      expect(content).toContain('should appear');
    });

    it('should read LOG_LEVEL case-insensitively', () => {
      process.env.LOG_LEVEL = 'debug';

      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'env-level-lower.log',
      });

      logger.debug('debug visible');

      const content = fs.readFileSync(path.join(tmpDir, 'env-level-lower.log'), 'utf8');
      expect(content).toContain('debug visible');
    });

    it('should read LOG_PATH from env', () => {
      const customDir = path.join(tmpDir, 'custom-path');
      process.env.LOG_PATH = customDir;

      const logger = new Logger({ output: 'file' });
      logger.info('path test');

      expect(fs.existsSync(path.join(customDir, 'mcp.log'))).toBe(true);
    });

    it('should read LOG_FILE from env', () => {
      process.env.LOG_FILE = 'custom-name.log';

      const logger = new Logger({ output: 'file', logDir: tmpDir });
      logger.info('file test');

      expect(fs.existsSync(path.join(tmpDir, 'custom-name.log'))).toBe(true);
    });

    it('should let explicit config override env vars', () => {
      process.env.LOG_LEVEL = 'ERROR';

      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'override.log',
        level: LogLevel.DEBUG,
      });

      logger.debug('override visible');

      const content = fs.readFileSync(path.join(tmpDir, 'override.log'), 'utf8');
      expect(content).toContain('override visible');
    });
  });

  describe('json format defaults', () => {
    it('should use "General" as component when no context in JSON mode', () => {
      const logger = new Logger({
        output: 'file',
        logDir: tmpDir,
        logFile: 'json-default.log',
        format: 'json',
      });

      logger.info('no ctx json');

      const content = fs.readFileSync(path.join(tmpDir, 'json-default.log'), 'utf8').trim();
      const parsed = JSON.parse(content);
      expect(parsed.component).toBe('General');
    });
  });

  describe('singleton', () => {
    it('getLogger returns same instance', () => {
      const a = getLogger();
      const b = getLogger();
      expect(a).toBe(b);
    });

    it('initLogger replaces instance', () => {
      const a = getLogger();
      const b = initLogger({ level: LogLevel.DEBUG });
      const c = getLogger();
      expect(b).toBe(c);
      expect(a).not.toBe(b);
    });

    it('resetLogger clears instance', () => {
      const a = getLogger();
      resetLogger();
      const b = getLogger();
      expect(a).not.toBe(b);
    });
  });
});
