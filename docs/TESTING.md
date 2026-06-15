# Testing

## Overview

mcp-core uses Jest with ESM support. Each source module has a corresponding test file:

| Source | Test | Focus |
|--------|------|-------|
| `src/logger.ts` | `tests/logger.test.ts` | levels, file/stderr, text/json, rotation; **secret redaction** + CR/LF stripping |
| `src/http-client.ts` | `tests/http-client.test.ts` | every verb + factory; hardened axios config, `normalizeError` (no raw-response leak), idempotent-only retry, error paths |
| `src/transport.ts` | `tests/transport.test.ts` | stdio mode/options; **fail-closed** auth + **constant-time** Bearer compare; `createRequestHandler` routing (health/401/415/413/404/500 + /mcp dispatch) |
| `src/server.ts` | `tests/server.test.ts` | `createMcpServer` factory, `TOOL_ANNOTATIONS` presets, SDK re-exports |
| `src/retry.ts` | `tests/retry.test.ts` | backoff/jitter, `isRetryableError`, `parseRetryAfter`, `retryWithBackoff` |
| `src/pagination.ts` | `tests/pagination.test.ts` | `normalizePagination`, `createPaginationMetadata`, `paginateArray` |

`src/index.ts` is pure re-exports (no logic) and is excluded from coverage.

## Coverage

Coverage is enforced at **85%** (statements / branches / functions / lines) globally via
`coverageThreshold` in `jest.config.js`; `collectCoverageFrom` instruments every `src/**` module so an
untested file counts against the threshold. `jest --coverage` fails the run if coverage drops below it.

`transport.ts`'s `startHttp` bind-and-block-on-SIGTERM glue is intentionally not exercised (a real
listener would leave an open handle and hang the run) — the request logic is extracted into the
exported, directly-testable `createRequestHandler`, which the suite drives with mock `req`/`res`.

## Running tests

```bash
# All tests
NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest

# Single module
NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest tests/logger.test.ts

# Watch mode
NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest --watch

# Coverage
NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest --coverage
```

> **Windows note:** Do not use `pnpm run test` — the `NODE_OPTIONS=` syntax is Unix-only. Always invoke jest directly via bash.

## Conventions

- Import jest functions explicitly: `import { describe, it, expect, jest, beforeEach } from '@jest/globals'`
- Use `jest.fn<any>()` for mocks to avoid TS2345 under strict mode
- Tests must not depend on network access — mock all HTTP calls
- Temporary files (e.g. log rotation tests) go in `tests/.tmp-logs/` (gitignored)
- **Mock ESM dependencies with `jest.unstable_mockModule(...)` + a dynamic `await import(...)` of the
  module under test** (the classic `jest.mock` + static import does NOT intercept native ESM — the
  real module loads instead). See `http-client.test.ts` and `transport.test.ts` for the pattern.

## Adding tests for new modules

1. Create `tests/<module-name>.test.ts`
2. Import from the source (not from `dist/`)
3. Cover the public API — every exported function needs at least one happy-path and one error-path test
