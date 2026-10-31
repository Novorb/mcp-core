# Logger

One logging utility for every MCP server: a console sink on stderr and three log files in the server's own repo, with rotation, text or JSON lines, secret redaction and PII masking on every entry. stdout is never written (it is the stdio protocol channel). The http-client and transport log through it too.

```typescript
import { initLogger, packageRootFrom } from '@novorb/mcp-core/logger';

// Once, at startup. rootDir = this server's package root (from src/ or dist/ alike).
const logger = initLogger({
  name: 'my-mcp',
  rootDir: packageRootFrom(import.meta.url),
  captureProcessErrors: true, // optional: log crashes to exceptions.log, then exit(1)
});

logger.info('Server started', 'Server');
logger.error('Request failed', 'HttpClient', { status: 500, path: '/api/items' });
```

**Sinks and routing.** The console writes to `process.stderr`. The files live in the log directory:

| File | Receives |
|------|----------|
| `<name>.log` | every entry at or above the level (the main log) |
| `exceptions.log` | ERROR entries only |
| `debug.log` | DEBUG entries only (so only when the level is DEBUG) |

INFO and WARN go to the main log; ERROR to main and exceptions; DEBUG to main and debug. Each file rotates on its own (10 MB, 5 generations) and a failing file never affects the other sinks.

**Log directory.** `<rootDir>/.logs` by default. `LOG_PATH` in the server's `.env` (or environment) overrides it, absolute or relative to `rootDir`. Without `rootDir` and without an absolute `LOG_PATH` the file sinks stay off and `initLogger` prints one console warning; nothing is ever written relative to the current working directory. `packageRootFrom(import.meta.url)` returns the nearest ancestor holding a `package.json`, using `fileURLToPath` so Windows paths are correct.

**Switches.** An explicit `initLogger` option beats the environment, which beats the default:

| Env | Option | Default | Meaning |
|-----|--------|---------|---------|
| `LOG_LEVEL` | `level` | `INFO` | minimum level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `LOG_FORMAT` | `format` | `text` | `text` or `json` |
| `LOG_CONSOLE` | `console` | `true` | stderr sink |
| `LOG_FILE_MAIN` | `fileMain` | `true` | `<name>.log` (needs a log directory) |
| `LOG_FILE_EXCEPTIONS` | `fileExceptions` | `true` | `exceptions.log` (needs a log directory) |
| `LOG_FILE_DEBUG` | `fileDebug` | `true` | `debug.log` (needs a log directory) |
| `LOG_PATH` | `logDir` | `<rootDir>/.logs` | log directory |
| `LOG_FILE` | `logFile` | `<name>.log` | main file name; an absolute path is used as-is |

Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`; anything else is ignored. Other options: `name` (sanitised to `[A-Za-z0-9._-]`; `initLogger` throws if the main file is on, a directory exists and there is neither `name` nor `LOG_FILE`), `rootDir`, `maxLogSize`, `maxLogFiles`, `captureProcessErrors`. `logger.sinks()` returns the resolved console flag and file paths.

**Line format.**

```
2026-10-23T17:50:10.764Z | INFO  | Server | Server started
2026-10-23T17:50:10.764Z | ERROR | HttpClient | Request failed | {"status":500,"path":"/api/items"}
{"level":"ERROR","timestamp":"2026-10-23T17:50:10.764Z","component":"HttpClient","message":"Request failed","status":500,"path":"/api/items"}
```

**Process errors.** With `captureProcessErrors: true`, uncaught exceptions and unhandled rejections are logged at ERROR with context `Process` (`Uncaught exception: <Name>: <message>` or `Unhandled rejection: <reason>`, meta `{"stack":...}`) to the main log and `exceptions.log`, then the process exits with code 1. The handler is re-entrancy guarded, and an EPIPE (a crash caused by a dead stderr pipe, a synchronous EPIPE from `stderr.write`, or an EPIPE `error` event on stderr) switches the console sink off, so it is never logged back to the broken pipe in a loop.

**Reconfigure in place.** `initLogger(options)` reconfigures the existing singleton without replacing it, recomputing every setting from defaults, env and `options`. A logger obtained with `getLogger()` at module load (before init) therefore writes to the configured sinks after init. Calling `initLogger` again recomputes from scratch; `resetLogger()` drops the singleton, its process handlers and the console state (tests only).

**Tool-call helpers.** Never log tool inputs or outputs. Log tool calls through these instead (CI variable values, base64 payloads and file contents are data that key-based redaction cannot recognise):

```typescript
import { logToolCall, logToolResult } from '@novorb/mcp-core/logger';

const started = Date.now();
logToolCall('create_variable', args);
// ... run the tool ...
logToolResult('create_variable', { isError: false, durationMs: Date.now() - started });
```

Both go through the singleton and default to context `Tools` (pass a third argument to override). The text lines are stable and pinned by tests:

```
<ISO> | INFO  | Tools | Tool call: create_variable | {"tool":"create_variable","args":{"key":"[REDACTED]","value":"string(6)"}}
<ISO> | INFO  | Tools | Tool result: create_variable | {"tool":"create_variable","isError":false,"durationMs":42}
<ISO> | WARN  | Tools | Tool result: create_variable | {"tool":"create_variable","isError":true,"durationMs":7}
```

`durationMs` is rounded to an integer. `summarizeArgs(args)` produces the shape-only `args` summary and never contains a value: per top-level key `string(<len>)`, `array(<len>)`, `object{<key names, one level, max 20 then ,...+N>}`, `number`, `boolean`, `null`, `undefined`, `bigint` or `function`. Non-object args are summarised under `_args`; `null`/`undefined` give `{}`. The summary still passes through redaction, so a sensitive key name such as `key` shows `[REDACTED]` instead of its shape.

**Redaction.** Before serialising, `meta` is copied with these fields replaced by `[REDACTED]` (case-insensitive):

- Keys are matched by name segment (camelCase, snake_case, kebab-case). A key is redacted when it names a secret (`password`, `passwd`, `pwd`, `passphrase`, `secret`, `token`, `cookie(s)`, `authorization`, `bearer`, `signature`, `sig`, `credential(s)`, `tempauth`, `api`+`key`, `access`+`key`, `private`/`secret`/`signing`/`encryption`+`key`) and nothing but a value-like suffix follows (`passwordHash` and `tokenValue` are redacted; `maxTokens`, `tokenExpiry`, `signatureAlgorithm`, `credentialType`, `primaryKey` are not).
- Key is exactly `key` (so `monkey` or `keyboard` are left alone).
- Inside any string value, the message and the context: the value of a query or form parameter (after `?`, `&`, `;`, whitespace or at the start) named `key`, `api_key`, `apikey`, `access_key`, `token`, `access_token`, `refresh_token`, `id_token`, `signature`, `sig`, `password`, `secret`, `tempauth`, `client_secret` or `X-Amz-Signature` / `X-Amz-Credential` / `X-Amz-Security-Token` becomes `name=[REDACTED]`; a connection-string password becomes `scheme://user:[REDACTED]@host`; HTTP Basic credentials become `Basic [TOKEN]`.
- Limits: strings over 32768 characters are cut at a delimiter with `...[TRUNCATED <n> chars]`, subtrees deeper than 8 levels become `[DEPTH]`, cycles `[CIRCULAR]`, arrays and objects keep 200 entries, and a line over 256 KiB is cut (text) or drops its meta (json). Errors keep name, message, stack, code and cause; Date, URL, Map, Set and binary data get a readable form. In json format meta never overwrites `level`, `timestamp`, `component` or `message` (colliding keys go under `meta`). Logging never throws into the caller.

Generic keys such as `value` and `content` are deliberately not redacted (DNS record values and file contents are legitimate data). Text mode also strips CR/LF and other control characters so a logged value cannot forge a log line.

**PII masking.** After redaction, the message and every string in `meta` (recursively) are masked with typed placeholders:

| Placeholder | Matches |
|-------------|---------|
| `[EMAIL]` | email addresses |
| `[PHONE]` | international `+31 6 12345678`, `+44 (20) 7946 0958`; NANP `(555) 123-4567`, `555-123-4567`; national `06-12345678`, `020 123 4567` |
| `[CARD]` | 13 to 19 digits with optional spaces or dashes, a card issuer prefix and a valid Luhn checksum |
| `[IBAN]` | IBANs, compact or in groups of four, with a valid mod-97 checksum |
| `[JWT]` | three base64url segments starting `eyJ` |
| `Bearer [TOKEN]` | `Bearer <token>`, unless the token is a short all-lowercase word (so "Bearer authentication" stays) |
| `[IP]` | IPv4 and IPv6 (full and compressed) addresses |

ISO timestamps, clock times, version strings (`1.2.3`, `v1.2.3.4`, `3.0.0-rc.1`), plain integers, epoch milliseconds, Luhn-invalid card-shaped numbers, bad-checksum IBANs, `std::map` and MAC addresses are left alone; both the positives and these negatives are pinned by tests.
