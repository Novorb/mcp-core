# Env

```typescript
import { loadEnv, renderEnvExample, renderEnvTable } from '@novorb/mcp-core/env';

const env = loadEnv(ENV, { rootDir });       // runMcpServer does this for you
env.get('ACME_URL'); env.int('ACME_PAGE_SIZE'); env.has('ACME_TOKEN'); env.isConfigured(); env.missing;
env.getAll('SERPER_API_KEY');                // multi: KEY, KEY_1, KEY_2, ..., then KEY_<name> A-Z
env.describe();                              // names, set/unset, source; never values
```

- Precedence: real process env > `<rootDir>/.env` > the spec `value`. `MCP_ENV_FILE` (from the real env)
  points at another file (absolute or relative to rootDir); `MCP_ENV_FILE=none` disables the file (use it
  in integration tests: the harness `envFile: 'none'`). Parsed with `util.parseEnv`; no dotenv.
- Keys resolved from the file or a default are written into `process.env` (never over a set variable), so
  legacy `process.env.X` reads keep working. File keys no schema declares are not loaded and produce one
  WARN listing their names (never values).
- `CORE_ENV_SCHEMA` (merged automatically): `MCP_TRANSPORT`, `PORT`, `MCP_HTTP_HOST`, `MCP_API_KEY`
  (secret), `MCP_AUTH_DISABLED`, `MCP_MAX_BODY_BYTES`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`,
  `MCP_ENV_FILE`, the `LOG_*` switches, `LOG_PROTOCOL`, `DATA_PATH`, `DATA_STORAGE`, `MCP_LIST_PAGE_SIZE`,
  `MCP_MAX_RESULT_ITEMS`, `MCP_MAX_RESULT_BYTES`, `MCP_MAX_TOOL_INPUT_ELEMENTS`, `MCP_REQUEST_STATE_KEY`
  (secret), `MCP_REQUEST_STATE_PREVIOUS_KEY` (secret, multi), `MCP_REQUEST_STATE_TTL_SECONDS`,
  `MCP_CREDENTIAL_CHECKS` (default true), `MCP_CREDENTIAL_CHECK_TIMEOUT_MS` (default 5000),
  `MCP_CREDENTIAL_RECHECK_MS` (default 300000).
- `env.members(KEY)` returns the NAMES of the set members of a key (a multi family in `getAll` order).
- A spec may carry a `check` (an async credential probe, see [Credential health](credentials.md)); a spec with a `check`
  is a secret (`isSecret(spec)`) whether or not it sets `secret: true`.
- An env variable set to an empty string counts as unset (the file or the default then applies and is
  written into `process.env`).
- Validation (`int`, `bool`, `url`, `enum`) errors are collected in `env.errors` by key name (no values);
  `runMcpServer` logs each as a WARN. `strict: true` throws instead.
- Every set secret value (`secret: true`, or any spec with a `check`) is passed to the logger's `registerSecretValues`, which masks it as
  `[SECRET]` wherever it appears in any log entry and in client-bound error text (raw and JSON-escaped).
  A secret shorter than 6 characters cannot be masked; the loader logs one WARN naming the key.
- Generated docs: `renderEnvTable(ENV)` returns the README table (key, type, required, multi, secret,
  default, description; never a secret default) and `renderEnvExample(ENV)` the `.env.example` text
  (secrets always empty). Pass `{ includeCore: true }` to include mcp-core's keys. A test can assert the
  committed `.env.example` equals `renderEnvExample(ENV)`.
