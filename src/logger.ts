/**
 * @novorb/mcp-core — Logger
 *
 * Unified logger for MCP servers. Supports two output modes:
 * - file: writes to rotating log files (for stdio-based MCP servers)
 * - stderr: writes to stderr (for Docker / HTTP transport)
 *
 * Log format (text): 2026-03-22T13:27:58.513Z | INFO  | Server | Starting...
 * Log format (json): {"level":"INFO","timestamp":"...","component":"Server","message":"Starting..."}
 *
 * Environment variables (read once at first logger creation):
 * - LOG_LEVEL: DEBUG, INFO, WARN, ERROR (default: INFO)
 * - LOG_PATH: log directory (default: ./logs)
 * - LOG_FILE: log file name (default: mcp.log)
 *
 * Security: `meta` is passed through `redactSecrets()` before serialisation — sensitive-keyed fields
 * (authorization/token/api_key/secret/password/cookie/...) are replaced with `[REDACTED]` so a
 * consumer that logs an error object or request params never writes a credential in cleartext. In
 * text mode the message + component are also stripped of CR/LF so a logged value can't forge log lines.
 */

import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/** Map string → LogLevel, case-insensitive */
function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const upper = value.toUpperCase();
  if (upper in LogLevel && typeof (LogLevel as any)[upper] === 'number') {
    return (LogLevel as any)[upper] as LogLevel;
  }
  return undefined;
}

export interface LoggerConfig {
  /** Minimum log level (default: INFO) */
  level: LogLevel;
  /** Output mode: 'file' writes to disk, 'stderr' writes to process.stderr */
  output: 'file' | 'stderr';
  /** Format: 'text' for human-readable, 'json' for structured (default: text) */
  format: 'text' | 'json';
  /** Directory for log files (file mode only) */
  logDir: string;
  /** Log file name (file mode only, default: mcp.log) */
  logFile: string;
  /** Max log file size in bytes before rotation (default: 10MB) */
  maxLogSize: number;
  /** Max number of rotated log files to keep (default: 5) */
  maxLogFiles: number;
}

const DEFAULT_CONFIG: LoggerConfig = {
  level: LogLevel.INFO,
  output: 'stderr',
  format: 'text',
  logDir: 'logs',
  logFile: 'mcp.log',
  maxLogSize: 10 * 1024 * 1024,
  maxLogFiles: 5,
};

/** Build config from defaults + env vars + explicit overrides */
function buildConfig(overrides?: Partial<LoggerConfig>): LoggerConfig {
  const envLevel = parseLogLevel(process.env.LOG_LEVEL);
  const envDir = process.env.LOG_PATH;
  const envFile = process.env.LOG_FILE;

  return {
    ...DEFAULT_CONFIG,
    ...(envLevel !== undefined ? { level: envLevel } : {}),
    ...(envDir ? { logDir: envDir } : {}),
    ...(envFile ? { logFile: envFile } : {}),
    ...overrides,
  };
}

// Keys whose values are redacted before a `meta` object is serialised. Defense-in-depth: consumers
// commonly pass error objects / request params carrying credentials, and a log sink must never write
// them in cleartext. Matched case-insensitively against each object key.
const SENSITIVE_KEY = /(authorization|cookie|password|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|api[_-]?key|apikey|bearer|private[_-]?key|signature|x-api-key)/i;
const REDACTED = '[REDACTED]';

/** Recursively copy a value, replacing any sensitive-keyed field with `[REDACTED]`. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactSecrets(v, depth + 1);
  }
  return out;
}

/** Collapse C0 control chars (incl. CR/LF) + DEL to spaces so a logged value can't forge log lines. */
function stripControlChars(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += (code < 0x20 || code === 0x7f) ? ' ' : s[i];
  }
  return out;
}

// Padded level names — fixed 5 chars for alignment
const LEVEL_NAMES: Record<number, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]:  'INFO ',
  [LogLevel.WARN]:  'WARN ',
  [LogLevel.ERROR]: 'ERROR',
};

export class Logger {
  private config: LoggerConfig;
  private logPath: string;

  constructor(config?: Partial<LoggerConfig>) {
    this.config = buildConfig(config);
    this.logPath = path.join(this.config.logDir, this.config.logFile);

    if (this.config.output === 'file') {
      this.ensureLogDirectory();
    }
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.config.logDir)) {
      fs.mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.config.level;
  }

  private formatText(level: LogLevel, message: string, context?: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const levelStr = LEVEL_NAMES[level] ?? LogLevel[level].padEnd(5);
    const contextStr = stripControlChars(context ?? 'General');
    const safeMessage = stripControlChars(message);
    const metaStr = meta !== undefined ? ` | ${JSON.stringify(redactSecrets(meta))}` : '';
    return `${timestamp} | ${levelStr} | ${contextStr} | ${safeMessage}${metaStr}\n`;
  }

  private formatJson(level: LogLevel, message: string, context?: string, meta?: unknown): string {
    const entry: Record<string, unknown> = {
      level: LogLevel[level],
      timestamp: new Date().toISOString(),
      component: context ?? 'General',
      message,
    };
    if (meta !== undefined) {
      const safeMeta = redactSecrets(meta);
      if (typeof safeMeta === 'object' && safeMeta !== null) {
        Object.assign(entry, safeMeta);
      } else {
        entry.meta = safeMeta;
      }
    }
    return JSON.stringify(entry) + '\n';
  }

  private format(level: LogLevel, message: string, context?: string, meta?: unknown): string {
    return this.config.format === 'json'
      ? this.formatJson(level, message, context, meta)
      : this.formatText(level, message, context, meta);
  }

  private write(level: LogLevel, message: string, context?: string, meta?: unknown): void {
    if (!this.shouldLog(level)) return;

    const formatted = this.format(level, message, context, meta);

    if (this.config.output === 'file') {
      this.writeToFile(formatted);
    } else {
      process.stderr.write(formatted);
    }
  }

  private writeToFile(message: string): void {
    try {
      if (fs.existsSync(this.logPath)) {
        const stats = fs.statSync(this.logPath);
        if (stats.size > this.config.maxLogSize) {
          this.rotateLog();
        }
      }
      fs.appendFileSync(this.logPath, message, 'utf8');
    } catch {
      // Silently fail — can't log to console in MCP stdio context
    }
  }

  private rotateLog(): void {
    try {
      for (let i = this.config.maxLogFiles - 1; i > 0; i--) {
        const oldPath = `${this.logPath}.${i}`;
        const newPath = `${this.logPath}.${i + 1}`;
        if (fs.existsSync(oldPath)) {
          if (i === this.config.maxLogFiles - 1) {
            fs.unlinkSync(oldPath);
          } else {
            fs.renameSync(oldPath, newPath);
          }
        }
      }
      if (fs.existsSync(this.logPath)) {
        fs.renameSync(this.logPath, `${this.logPath}.1`);
      }
    } catch {
      // Silently fail
    }
  }

  debug(message: string, context?: string, meta?: unknown): void {
    this.write(LogLevel.DEBUG, message, context, meta);
  }

  info(message: string, context?: string, meta?: unknown): void {
    this.write(LogLevel.INFO, message, context, meta);
  }

  warn(message: string, context?: string, meta?: unknown): void {
    this.write(LogLevel.WARN, message, context, meta);
  }

  error(message: string, context?: string, meta?: unknown): void {
    this.write(LogLevel.ERROR, message, context, meta);
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }
}

// Singleton management
let loggerInstance: Logger | null = null;

/**
 * Initialize logger with custom config.
 * Should be called once at application startup.
 * Reads LOG_LEVEL, LOG_PATH, LOG_FILE from env (overrides take precedence).
 */
export function initLogger(config?: Partial<LoggerConfig>): Logger {
  loggerInstance = new Logger(config);
  return loggerInstance;
}

/**
 * Get the logger instance.
 * Creates a default stderr/text instance if initLogger was not called.
 * Reads LOG_LEVEL, LOG_PATH, LOG_FILE from env on first creation.
 */
export function getLogger(config?: Partial<LoggerConfig>): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger(config);
  }
  return loggerInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetLogger(): void {
  loggerInstance = null;
}

export default getLogger;
