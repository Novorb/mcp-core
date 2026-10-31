/**
 * @novorb/mcp-core - Logger
 *
 * One logging utility for every MCP server. Sinks:
 * - console: process.stderr only (never stdout, the stdio protocol channel)
 * - <name>.log: the main log, every entry at or above the level
 * - exceptions.log: ERROR entries only
 * - debug.log: DEBUG entries only (so only when the level is DEBUG)
 *
 * Log directory: `<rootDir>/.logs` by default (rootDir = the consumer's package root, see
 * `packageRootFrom`). LOG_PATH overrides it (absolute, or relative to rootDir). Without rootDir and
 * without an absolute LOG_PATH the file sinks stay off (one console warning from initLogger); nothing
 * is ever written relative to cwd.
 *
 * Switches (explicit config overrides env, env overrides the default):
 *   LOG_LEVEL            DEBUG | INFO | WARN | ERROR             default INFO
 *   LOG_FORMAT           text | json                             default text
 *   LOG_CONSOLE          true | false                            default true
 *   LOG_FILE_MAIN        true | false                            default true (needs a directory)
 *   LOG_FILE_EXCEPTIONS  true | false                            default true (needs a directory)
 *   LOG_FILE_DEBUG       true | false                            default true (needs a directory)
 *   LOG_PATH             log directory                           default <rootDir>/.logs
 *   LOG_FILE             main file name (absolute = as-is)       default <name>.log
 *
 * Text line: 2026-03-22T13:27:58.513Z | INFO  | Server | Starting... | {"meta":"json"}
 * JSON line: {"level":"INFO","timestamp":"...","component":"Server","message":"Starting...",...meta}
 *
 * Every entry is sanitised: sensitive-keyed meta fields become [REDACTED], secret query parameters
 * in strings become name=[REDACTED], and PII in the message and every meta string is masked
 * ([EMAIL] [PHONE] [CARD] [IBAN] [JWT] [TOKEN] [IP]). Text mode also strips control characters.
 *
 * `initLogger` reconfigures the singleton IN PLACE, so a logger obtained with `getLogger()` at import
 * time (before init) writes to the configured sinks after init.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets, sanitizeString } from './redact.js';

export { maskPii, redactSecrets } from './redact.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export type LogFormat = 'text' | 'json';

export interface LoggerConfig {
  /** Server name; the main log file is `<name>.log`. Required by initLogger when the main file is on. */
  name?: string;
  /** The consumer's package root; the default log directory is `<rootDir>/.logs`. */
  rootDir?: string;
  /** Log directory (overrides LOG_PATH); absolute, or relative to rootDir. */
  logDir?: string;
  /** Main log file name (overrides LOG_FILE); an absolute path is used as-is. */
  logFile?: string;
  /** Minimum level (LOG_LEVEL, default INFO). */
  level: LogLevel;
  /** Line format (LOG_FORMAT, default text). */
  format: LogFormat;
  /** stderr sink (LOG_CONSOLE, default true). */
  console: boolean;
  /** Main file sink (LOG_FILE_MAIN, default true). */
  fileMain: boolean;
  /** exceptions.log sink (LOG_FILE_EXCEPTIONS, default true). */
  fileExceptions: boolean;
  /** debug.log sink (LOG_FILE_DEBUG, default true). */
  fileDebug: boolean;
  /** Max size per file in bytes before rotation (default 10 MB). */
  maxLogSize: number;
  /** Rotated generations kept per file (default 5). */
  maxLogFiles: number;
  /** Log uncaught exceptions / unhandled rejections to main + exceptions, then exit(1). Default false. */
  captureProcessErrors: boolean;
}

export type LoggerOptions = Partial<LoggerConfig>;

/** The resolved sinks of a logger: console on/off and the absolute path of each active file. */
export interface LogSinks {
  console: boolean;
  main?: string;
  exceptions?: string;
  debug?: string;
}

const DEFAULTS: LoggerConfig = {
  level: LogLevel.INFO,
  format: 'text',
  console: true,
  fileMain: true,
  fileExceptions: true,
  fileDebug: true,
  maxLogSize: 10 * 1024 * 1024,
  maxLogFiles: 5,
  captureProcessErrors: false,
};

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const upper = value.toUpperCase();
  const byName = LogLevel as unknown as Record<string, number | undefined>;
  return upper in LogLevel && typeof byName[upper] === 'number' ? (byName[upper] as LogLevel) : undefined;
}

function parseFormat(value: string | undefined): LogFormat | undefined {
  const v = value?.toLowerCase();
  return v === 'text' || v === 'json' ? v : undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return undefined;
}

function defined<T extends object>(obj: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Defaults, then env, then explicit options. */
function buildConfig(options?: LoggerOptions): LoggerConfig {
  const env = process.env;
  const fromEnv: Partial<LoggerConfig> = defined({
    level: parseLogLevel(env.LOG_LEVEL),
    format: parseFormat(env.LOG_FORMAT),
    console: parseBool(env.LOG_CONSOLE),
    fileMain: parseBool(env.LOG_FILE_MAIN),
    fileExceptions: parseBool(env.LOG_FILE_EXCEPTIONS),
    fileDebug: parseBool(env.LOG_FILE_DEBUG),
    logDir: env.LOG_PATH || undefined,
    logFile: env.LOG_FILE || undefined,
  });
  return { ...DEFAULTS, ...fromEnv, ...defined(options) };
}

function sanitizeName(name: string | undefined): string | undefined {
  const safe = name?.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  return safe ? safe : undefined;
}

interface Resolution {
  sinks: LogSinks;
  /** The one-line console warning for enabled file sinks that cannot be written, if any. */
  warning?: string;
  /** The main file is on and a directory exists, but there is no name and no LOG_FILE. */
  missingName: boolean;
}

/**
 * Windows drive-relative (`C:logs`) and root-relative (`\logs`) paths resolve against a current
 * directory, which would break the "never cwd" rule, so they are refused.
 */
function isCwdDependent(p: string): boolean {
  if (/^[A-Za-z]:(?![\\/])/.test(p)) return true;
  return process.platform === 'win32' && /^[\\/](?![\\/])/.test(p);
}

function resolveSinks(c: LoggerConfig): Resolution {
  let dir: string | undefined;
  let dirProblem: string | undefined;
  if (c.logDir) {
    if (isCwdDependent(c.logDir)) dirProblem = `LOG_PATH "${c.logDir}" is drive- or root-relative`;
    else if (path.isAbsolute(c.logDir)) dir = c.logDir;
    else if (c.rootDir) dir = path.resolve(c.rootDir, c.logDir);
    else dirProblem = `LOG_PATH "${c.logDir}" is relative and no rootDir was given`;
  } else if (c.rootDir) {
    dir = path.join(path.resolve(c.rootDir), '.logs');
  } else {
    dirProblem = 'no rootDir and no LOG_PATH';
  }

  const sinks: LogSinks = { console: c.console };
  const problems: string[] = [];
  let missingName = false;
  const badFile = c.logFile !== undefined && isCwdDependent(c.logFile);
  const absoluteMain = !badFile && c.logFile !== undefined && path.isAbsolute(c.logFile);
  if (c.fileMain) {
    if (badFile) {
      problems.push(`main log disabled: LOG_FILE "${c.logFile}" is drive- or root-relative`);
    } else if (absoluteMain) {
      sinks.main = c.logFile;
    } else if (dir) {
      const file = c.logFile ?? (sanitizeName(c.name) ? `${sanitizeName(c.name)}.log` : undefined);
      if (file) sinks.main = path.join(dir, file);
      else missingName = true;
    }
  }
  if (c.fileExceptions && dir) sinks.exceptions = path.join(dir, 'exceptions.log');
  if (c.fileDebug && dir) sinks.debug = path.join(dir, 'debug.log');

  if (!dir && dirProblem) {
    const mainNeedsDir = c.fileMain && !absoluteMain && !badFile;
    const others = c.fileExceptions || c.fileDebug;
    if (mainNeedsDir) problems.unshift(`File logging disabled: ${dirProblem}`);
    else if (others) problems.unshift(`exceptions.log and debug.log disabled: ${dirProblem}`);
  }
  const hint = !dir && dirProblem ? ' (pass initLogger({ rootDir }) or set an absolute LOG_PATH)' : '';
  return { sinks, warning: problems.length ? `${problems.join('; ')}${hint}` : undefined, missingName };
}

function isBrokenPipe(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END';
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Collapse C0 control chars (incl. CR/LF) + DEL to spaces so a logged value can't forge log lines. */
function stripControlChars(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? ' ' : s[i];
  }
  return out;
}

/** Registered secret values shorter than this are ignored (they would mask ordinary words). */
export const MIN_SECRET_LENGTH = 6;
const SECRET_MASK = '[SECRET]';
const secretValues = new Set<string>();

/**
 * Register secret VALUES (API tokens, passwords) that are masked verbatim as `[SECRET]` wherever they
 * appear in any log entry, in both line formats (raw and JSON-escaped). The env loader calls this for
 * every set `secret: true` variable. Process-global; values shorter than MIN_SECRET_LENGTH are ignored.
 */
export function registerSecretValues(values: Iterable<string>): void {
  for (const value of values) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    secretValues.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) secretValues.add(escaped);
  }
}

/** Forget every registered secret value (tests). */
export function clearSecretValues(): void {
  secretValues.clear();
}

/** Replace every registered secret value in `s` with `[SECRET]` (longest first). */
export function maskSecretValues(s: string): string {
  if (secretValues.size === 0) return s;
  let out = s;
  for (const secret of [...secretValues].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(SECRET_MASK);
  }
  return out;
}

/** One accepted log entry as a listener sees it: already redacted and masked like the file lines. */
export interface LogEntry {
  level: LogLevel;
  /** The logger name (`initLogger({ name })`), when set. */
  logger?: string;
  context: string;
  message: string;
  /** Redacted, PII-masked meta (secret values masked), or undefined. */
  meta?: unknown;
}

/** Receives every entry the logger accepts (at or above its level), after redaction and masking. */
export type LogListener = (entry: LogEntry) => void;

const logListeners = new Set<LogListener>();

/**
 * Subscribe to accepted log entries (process-global, survives `initLogger` reconfiguration; cleared by
 * `resetLogger`). Returns the unsubscribe function. A throwing listener is ignored, and a listener that
 * logs from inside its own callback is not re-entered.
 */
export function addLogListener(listener: LogListener): () => void {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}

let notifyingListeners = false;

function sanitizedMeta(meta: unknown): unknown {
  if (meta === undefined) return undefined;
  const json = JSON.stringify(redactSecrets(meta));
  return json === undefined ? undefined : (JSON.parse(maskSecretValues(json)) as unknown);
}

function notifyListeners(level: LogLevel, name: string | undefined, message: string, context?: string, meta?: unknown) {
  if (logListeners.size === 0 || notifyingListeners) return;
  notifyingListeners = true;
  try {
    let entry: LogEntry;
    try {
      entry = {
        level,
        ...(name !== undefined ? { logger: name } : {}),
        context: maskSecretValues(sanitizeString(context ?? 'General')),
        message: maskSecretValues(sanitizeString(maskSecretValues(message))),
        meta: sanitizedMeta(meta),
      };
    } catch {
      entry = { level, context: 'Logger', message: '[unformattable entry]' };
    }
    for (const listener of logListeners) {
      try {
        listener(entry);
      } catch {
        // A listener never breaks logging.
      }
    }
  } finally {
    notifyingListeners = false;
  }
}

const LEVEL_NAMES: Record<number, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO ',
  [LogLevel.WARN]: 'WARN ',
  [LogLevel.ERROR]: 'ERROR',
};

/** A rendered line longer than this is cut (text) or loses its meta (json). */
const MAX_LINE_CHARS = 256 * 1024;
const RESERVED_JSON_FIELDS = new Set(['level', 'timestamp', 'component', 'message', 'meta']);

// stderr and the process are global, so the broken-pipe state, the stderr guard and the fatal
// re-entrancy flag are too.
let stderrBroken = false;
let stderrGuard: ((err: Error) => void) | null = null;
const consoleLoggers = new Set<Logger>();
let dirWarningShown = false;
let fatalInProgress = false;

/**
 * Keep one stderr `error` listener while any logger has the console on. An EPIPE marks stderr broken
 * (the console sink stops); any other error is re-thrown when no one else listens, exactly as Node
 * would have done without this listener.
 */
function updateStderrGuard(logger: Logger, consoleOn: boolean): void {
  if (consoleOn) consoleLoggers.add(logger);
  else consoleLoggers.delete(logger);
  if (consoleLoggers.size > 0 && !stderrGuard) {
    stderrGuard = (err: Error) => {
      if (isBrokenPipe(err)) {
        stderrBroken = true;
        return;
      }
      if (process.stderr.listenerCount('error') === 1) throw err;
    };
    process.stderr.on('error', stderrGuard);
  } else if (consoleLoggers.size === 0 && stderrGuard) {
    process.stderr.removeListener('error', stderrGuard);
    stderrGuard = null;
  }
}

export class Logger {
  private config: LoggerConfig = DEFAULTS;
  private resolved: LogSinks = { console: true };
  private fatalHandlers: { exception: (err: unknown) => void; rejection: (reason: unknown) => void } | null = null;
  // Known size per file, so rotation needs one stat per file per configuration, not one per line.
  private sizes = new Map<string, number>();

  constructor(options?: LoggerOptions) {
    this.configure(options);
  }

  /**
   * Reconfigure in place: recompute every setting from defaults + env + `options` (exactly as the
   * constructor does), create the log directories, and install or remove the process-error handlers.
   */
  configure(options?: LoggerOptions): void {
    this.config = buildConfig(options);
    this.resolved = resolveSinks(this.config).sinks;
    this.sizes.clear();
    for (const file of [this.resolved.main, this.resolved.exceptions, this.resolved.debug]) {
      if (!file) continue;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch {
        // Silent: a file sink may fail without affecting the others.
      }
    }
    updateStderrGuard(this, this.resolved.console);
    if (this.config.captureProcessErrors) this.attachProcessHandlers();
    else this.detachProcessHandlers();
  }

  /** The active sinks (console flag and absolute file paths). */
  sinks(): LogSinks {
    return { ...this.resolved };
  }

  /** Remove the process-error handlers and this logger's claim on the stderr guard. */
  detach(): void {
    this.detachProcessHandlers();
    updateStderrGuard(this, false);
  }

  /** Remove the process-error handlers, if installed. */
  detachProcessHandlers(): void {
    if (!this.fatalHandlers) return;
    process.removeListener('uncaughtException', this.fatalHandlers.exception);
    process.removeListener('unhandledRejection', this.fatalHandlers.rejection);
    this.fatalHandlers = null;
  }

  private attachProcessHandlers(): void {
    if (this.fatalHandlers) return;
    this.fatalHandlers = {
      exception: (err: unknown) => this.onFatal('Uncaught exception', err),
      rejection: (reason: unknown) => this.onFatal('Unhandled rejection', reason),
    };
    process.on('uncaughtException', this.fatalHandlers.exception);
    process.on('unhandledRejection', this.fatalHandlers.rejection);
  }

  private onFatal(kind: string, err: unknown): void {
    // Process-wide: a second capturing logger, or a fault raised while handling one, does nothing.
    if (fatalInProgress) return;
    fatalInProgress = true;
    try {
      // An EPIPE means stderr is gone: logging it back to stderr is exactly the runaway loop.
      if (isBrokenPipe(err)) stderrBroken = true;
      const stack = err instanceof Error && err.stack ? { stack: err.stack } : undefined;
      this.write(LogLevel.ERROR, `${kind}: ${describeError(err)}`, 'Process', stack);
    } finally {
      process.exit(1);
    }
  }

  /** Write one WARN line to the console sink only (used for the directory warning). */
  consoleWarn(message: string, context: string): void {
    if (this.resolved.console) this.writeConsole(this.format(LogLevel.WARN, message, context));
  }

  private formatText(level: LogLevel, message: string, context?: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const levelStr = LEVEL_NAMES[level] ?? LogLevel[level].padEnd(5);
    const contextStr = stripControlChars(sanitizeString(context ?? 'General'));
    const safeMessage = stripControlChars(sanitizeString(message));
    const metaStr = meta !== undefined ? ` | ${JSON.stringify(redactSecrets(meta))}` : '';
    let line = `${timestamp} | ${levelStr} | ${contextStr} | ${safeMessage}${metaStr}`;
    if (line.length > MAX_LINE_CHARS) {
      line = `${line.slice(0, MAX_LINE_CHARS)}...[TRUNCATED ${line.length - MAX_LINE_CHARS} chars]`;
    }
    return `${line}\n`;
  }

  private formatJson(level: LogLevel, message: string, context?: string, meta?: unknown): string {
    const entry: Record<string, unknown> = {
      level: LogLevel[level],
      timestamp: new Date().toISOString(),
      component: sanitizeString(context ?? 'General'),
      message: sanitizeString(message),
    };
    if (meta !== undefined) {
      const safeMeta = redactSecrets(meta);
      if (typeof safeMeta === 'object' && safeMeta !== null && !Array.isArray(safeMeta)) {
        // Meta never overwrites the entry's own fields: colliding keys go under `meta`.
        const collisions: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(safeMeta)) {
          if (RESERVED_JSON_FIELDS.has(k)) collisions[k] = v;
          else entry[k] = v;
        }
        if (Object.keys(collisions).length > 0) entry.meta = collisions;
      } else {
        entry.meta = safeMeta;
      }
    }
    let line = JSON.stringify(entry);
    if (line.length > MAX_LINE_CHARS) {
      line = JSON.stringify({
        level: entry.level,
        timestamp: entry.timestamp,
        component: entry.component,
        message: String(entry.message).slice(0, MAX_LINE_CHARS / 2),
        meta: `[TRUNCATED: meta too large (${line.length} chars)]`,
      });
    }
    return `${line}\n`;
  }

  private format(level: LogLevel, message: string, context?: string, meta?: unknown): string {
    try {
      // Registered secrets are masked in the raw message first (before truncation could split one),
      // then in the whole rendered line (context and every meta string included).
      const safeMessage = maskSecretValues(message);
      const line =
        this.config.format === 'json'
          ? this.formatJson(level, safeMessage, context, meta)
          : this.formatText(level, safeMessage, context, meta);
      return maskSecretValues(line);
    } catch {
      // Logging must never throw into the caller: drop the meta and keep the line.
      if (meta === undefined)
        return `${new Date().toISOString()} | ${LEVEL_NAMES[level]} | Logger | [unformattable entry]\n`;
      return this.format(level, message, context, '[unserialisable meta]');
    }
  }

  private write(level: LogLevel, message: string, context?: string, meta?: unknown): void {
    if (level < this.config.level) return;
    const line = this.format(level, message, context, meta);
    const { main, exceptions, debug } = this.resolved;
    if (main) this.writeFile(main, line);
    if (exceptions && level === LogLevel.ERROR) this.writeFile(exceptions, line);
    if (debug && level === LogLevel.DEBUG) this.writeFile(debug, line);
    if (this.resolved.console) this.writeConsole(line);
    notifyListeners(level, this.config.name, message, context, meta);
  }

  private writeConsole(line: string): void {
    if (stderrBroken) return;
    try {
      process.stderr.write(line);
    } catch (err) {
      if (isBrokenPipe(err)) stderrBroken = true;
    }
  }

  private knownSize(file: string): number {
    let size = this.sizes.get(file);
    if (size === undefined) {
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      this.sizes.set(file, size);
    }
    return size;
  }

  private writeFile(file: string, line: string): void {
    try {
      if (this.knownSize(file) > this.config.maxLogSize) this.rotate(file);
      try {
        fs.appendFileSync(file, line, 'utf8');
      } catch (err) {
        // The directory was removed after configuration: recreate it once and retry.
        if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line, 'utf8');
      }
      this.sizes.set(file, this.knownSize(file) + Buffer.byteLength(line, 'utf8'));
    } catch {
      // Silent: a file sink may fail without affecting the others.
    }
  }

  /** maxLogFiles counts the active file: N keeps the active file plus N-1 rotated ones (minimum 1). */
  private rotate(file: string): void {
    try {
      const keep = Math.max(1, Math.floor(this.config.maxLogFiles));
      if (keep === 1) {
        fs.unlinkSync(file);
      } else {
        if (fs.existsSync(`${file}.${keep - 1}`)) fs.unlinkSync(`${file}.${keep - 1}`);
        for (let i = keep - 2; i > 0; i--) {
          if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        }
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      // Silent
    }
    this.sizes.set(file, 0);
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
    this.config = { ...this.config, level };
  }
}

let loggerInstance: Logger | null = null;

/**
 * Initialise (or reconfigure in place) the logger singleton. Call once at startup with the server
 * `name` and its package `rootDir`. Throws when the main file is on, a directory exists, and neither
 * `name` nor LOG_FILE is given. Warns once on the console when file sinks are on but there is no
 * usable directory.
 */
export function initLogger(options?: LoggerOptions): Logger {
  const resolution = resolveSinks(buildConfig(options));
  if (resolution.missingName) {
    throw new Error('initLogger: `name` is required for the main log file (or set LOG_FILE, or fileMain: false)');
  }
  if (loggerInstance) loggerInstance.configure(options);
  else loggerInstance = new Logger(options);
  if (resolution.warning && !dirWarningShown) {
    dirWarningShown = true;
    loggerInstance.consoleWarn(resolution.warning, 'Logger');
  }
  return loggerInstance;
}

/** Get the singleton, creating a default (console-only unless LOG_PATH is absolute) one if needed. */
export function getLogger(options?: LoggerOptions): Logger {
  if (!loggerInstance) loggerInstance = new Logger(options);
  return loggerInstance;
}

/** Drop the singleton, its process handlers and the process-global console state (tests). */
export function resetLogger(): void {
  loggerInstance?.detach();
  loggerInstance = null;
  consoleLoggers.clear();
  if (stderrGuard) process.stderr.removeListener('error', stderrGuard);
  stderrGuard = null;
  stderrBroken = false;
  dirWarningShown = false;
  fatalInProgress = false;
  secretValues.clear();
  logListeners.clear();
  notifyingListeners = false;
}

/**
 * The package root of the module at `importMetaUrl` (pass `import.meta.url`): the nearest ancestor
 * directory holding a package.json. Works from `src/` and `dist/` alike and is Windows-safe
 * (`fileURLToPath`, never `URL.pathname`). Also accepts a plain file path.
 */
export function packageRootFrom(importMetaUrl: string | URL): string {
  const asString = importMetaUrl instanceof URL ? importMetaUrl.href : importMetaUrl;
  const file = asString.startsWith('file:') ? fileURLToPath(asString) : path.resolve(asString);
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`packageRootFrom: no package.json above ${file}`);
    dir = parent;
  }
}

/** Shape-only summary of tool arguments: one descriptor string per top-level key. */
export type ArgsSummary = Record<string, string>;

const MAX_NESTED_KEYS = 20;
const TOOL_CONTEXT = 'Tools';

function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    const shown = keys.slice(0, MAX_NESTED_KEYS).join(',');
    const more = keys.length > MAX_NESTED_KEYS ? `,...+${keys.length - MAX_NESTED_KEYS}` : '';
    return `object{${shown}${more}}`;
  }
  return typeof value;
}

/**
 * Summarise tool arguments by shape only, never by value. Per top-level key: `string(<len>)`,
 * `array(<len>)`, `object{<key names, one level, max 20>}`, `number`, `boolean`, `null`, `undefined`,
 * `bigint`, `function`. Non-object args are summarised under `_args`; null/undefined give `{}`.
 */
export function summarizeArgs(args: unknown): ArgsSummary {
  if (args === null || args === undefined) return {};
  if (typeof args !== 'object' || Array.isArray(args)) return { _args: describeShape(args) };
  const out: ArgsSummary = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = describeShape(v);
  return out;
}

/** INFO `Tool call: <name>` with meta `{ tool, args: summarizeArgs(args) }`. Never the argument values. */
export function logToolCall(name: string, args: unknown, context?: string): void {
  getLogger().info(`Tool call: ${name}`, context ?? TOOL_CONTEXT, { tool: name, args: summarizeArgs(args) });
}

/**
 * `Tool result: <name>` with meta `{ tool, isError, durationMs }` (durationMs rounded). INFO on
 * success, WARN when isError. Never the result content.
 */
export function logToolResult(name: string, outcome: { isError: boolean; durationMs: number }, context?: string): void {
  const meta = { tool: name, isError: outcome.isError, durationMs: Math.round(outcome.durationMs) };
  if (outcome.isError) getLogger().warn(`Tool result: ${name}`, context ?? TOOL_CONTEXT, meta);
  else getLogger().info(`Tool result: ${name}`, context ?? TOOL_CONTEXT, meta);
}

export default getLogger;
