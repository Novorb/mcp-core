# HTTP client and retry

## HTTP Client

One hardened client per upstream. Build it once per process (module scope or the server's setup), not inside the per-request server factory, so the rate limiter and the connection pool are shared.

```typescript
import { createHttpClient } from '@novorb/mcp-core/http-client';

const client = createHttpClient({
  baseURL: 'https://api.example.com/v1',     // relative paths are joined onto this exactly once
  auth: { type: 'bearer', token: process.env.API_TOKEN ?? '' },
  timeout: 30_000,                            // default; per request: { timeout }
  retry: { retries: 3, maxRetryAfterMs: 30_000 },
  mapError: (e) => ({ message: `Example API error (${e.status ?? e.code}): ${e.upstreamMessage ?? 'request failed'}` }),
  logContext: 'ExampleClient',
});

const item = await client.get<Item>('/items/42', { query: { expand: 'owner' }, signal: ctx.signal });
await client.post('/items', { name: 'new' }, { idempotencyKey: crypto.randomUUID() }); // replayable POST
const raw = await client.requestRaw({ path: '/items', validateStatus: () => true }); // { status, headers, data }
const headers = await client.head('/items');
const file = await client.get<Readable>('/files/1', { responseType: 'stream', maxResponseBytes: 50 * 1024 * 1024 });
```

- **Request options** (every verb, plus `request`/`requestRaw`): `query` (null/undefined skipped, arrays per `arrayFormat`: `repeat` default, `brackets`, `comma`), `headers`, `timeout`, `signal` (cancels the request and any retry wait), `responseType` (`json` | `text` | `arraybuffer` | `stream`), `maxResponseBytes`, `validateStatus`, `retry` (overrides, or `false`), `idempotencyKey` (sent as `Idempotency-Key`, configurable via `idempotencyKeyHeader`), `logPath` (the route template to log, e.g. `/repos/:owner/:repo`), `credential` (the key NAME this request authenticates with; its outcome is recorded, see "Credential health").
- **Auth** (`auth`): `bearer`, `basic`, `header` (`PRIVATE-TOKEN`, `X-Api-Key`, `sso-key ...`), `query` (Trello `key`/`token`), `tokenProvider` (`getToken({ forceRefresh, signal })`, called per request; a 401 triggers one forced refresh and one replay). Every configured secret value, and every token a provider returned, is masked as `[REDACTED]` in error messages.
- **URLs:** `joinUrl` puts exactly one `/` between base and path and touches nothing else. An absolute URL (an OData next-link that already contains `/v1.0`) is used as-is, but only toward the base URL's origin or an `allowedOrigins` entry; anything else throws `ERR_ORIGIN_NOT_ALLOWED` before sending, so credentials never leave.
- **Retry:** only GET/HEAD/OPTIONS/PUT/DELETE, unless the request has an `idempotencyKey` or `retry: { unsafe: true }`. Statuses 408, 425, 429, 500, 502, 503, 504 and network errors ECONNRESET, ETIMEDOUT (incl. timeouts), EAI_AGAIN, ECONNREFUSED on connect. `Retry-After` (seconds or date) is honoured up to `maxRetryAfterMs`; otherwise full-jitter backoff. `onRetry` observes each wait.
- **TLS:** `tls: { ca }` for a private CA, `tls: { rejectUnauthorized: false }` for a self-signed test instance (an ESM `node:https` Agent).
- **Rate limit:** `rateLimit: { capacity, refillPerSecond }` (or a shared `TokenBucket`) gates every attempt.
- **Errors:** every failure is an `HttpError` with only `message`, `status`, `statusText`, `code`, `method`, `path`, `retryAfterMs`. The default message is the upstream message (GitLab `message`, Graph `error.message`, Jira `errorMessages`, `errors`, plain text; HTML ignored; 300 chars max) or `HTTP <status> <text>` / `Network error (<code>)`. `mapError(info)` receives `{ method, host, path, status, statusText, code, upstreamMessage, upstreamCode, retryAfterMs }` and returns `{ message, code }`.
- **Security:** `maxRedirects: 0`; response (streams included) and request size caps (25 MiB default, `ERR_RESPONSE_TOO_LARGE` / `ERR_REQUEST_TOO_LARGE`); errors never carry the raw response, config or headers; a broken stream surfaces a sanitized `HttpError`.
- **Logging** (mcp-core logger only): `HTTP <METHOD> <host><path template>` with `{ method, host, path, status, durationMs, attempt }`; DEBUG on success, WARN on retry and 4xx, ERROR on 5xx and network failures. The path is a route TEMPLATE (`templatePath`), also in `HttpError.path`, and fails closed: without a template every request-path segment becomes `:id` except a leading API prefix or version (`api`, `rest`, `v4`); the base URL path keeps its API words and versions (`/api/v4`) and masks any other segment (a token in the base URL). So `GET /api/v4/projects/7/repository/tags/stable` logs `/api/v4/:id/:id/:id/:id/:id`. For readable lines declare the client's routes (`routes: ['/projects/:id/repository/tags/:tag']`, matched segment for segment, `:name` = any one segment) or pass a per-request `logPath`; their literal words are logged. Names, keys, tags and file names never reach a log line unless a route template spells them out. Query values, headers and bodies are never logged.

**Adoption per server:**

```typescript
// GitLab: PRIVATE-TOKEN header, X-Next-Page walking, service wording.
const gitlab = createHttpClient({
  baseURL: `${process.env.GITLAB_URL}/api/v4`,
  auth: { type: 'header', name: 'PRIVATE-TOKEN', value: process.env.GITLAB_TOKEN ?? '' },
  mapError: (e) => ({ message: `GitLab API error (${e.status ?? e.code}): ${e.upstreamMessage ?? 'request failed'}` }),
});
const { items, total } = await gitlab
  .paginate<Project>({ path: '/projects', query: { search: 'core' } }, nextPageHeader({ pageSize: 100 }))
  .collect();

// Microsoft Graph: refreshing token, absolute @odata.nextLink followed as-is (no /v1.0/v1.0).
const graph = createHttpClient({
  baseURL: 'https://graph.microsoft.com/v1.0',
  auth: { type: 'tokenProvider', getToken: ({ forceRefresh }) => tokens.get(forceRefresh) },
});
for await (const site of graph.paginate<Site>({ path: '/sites', query: { search: '*' } }, nextLinkField()).items()) {
  // ...
}

// Trello: key/token query auth (masked), 100 requests per 10 s per token, `before` cursor.
const trello = createHttpClient({
  baseURL: 'https://api.trello.com/1',
  auth: { type: 'query', params: { key: process.env.TRELLO_API_KEY ?? '', token: process.env.TRELLO_TOKEN ?? '' } },
  rateLimit: { capacity: 100, refillPerSecond: 10 },
});
const actions = await trello
  .paginate<Action>(
    { path: `/boards/${boardId}/actions`, query: { limit: 50 } },
    continuationToken({ requestParam: 'before', items: (b) => (Array.isArray(b) ? b : []),
      token: (_b, page) => (page.length === 50 ? page[page.length - 1].id : undefined) }),
  )
  .collect();

// Nexus: basic auth, self-signed test instance, continuationToken, raw status handling.
const nexus = createHttpClient({
  baseURL: `${process.env.NEXUS_URL}/service/rest`,
  auth: { type: 'basic', username: process.env.NEXUS_USERNAME ?? '', password: process.env.NEXUS_PASSWORD ?? '' },
  tls: process.env.NEXUS_VALIDATE_SSL === 'false' ? { rejectUnauthorized: false } : undefined,
});
const components = await nexus
  .paginate<Component>(
    { path: '/v1/components', query: { repository: 'maven-releases' } },
    continuationToken(),
    { maxItems: 500 },
  )
  .collect();
const res = await nexus.requestRaw({ path: '/v1/status', validateStatus: () => true });

// Dependency-Track: X-Api-Key header, pageNumber/pageSize + X-Total-Count.
const dt = createHttpClient({
  baseURL: `${process.env.DEPTRACK_BASE_URL}/api`,
  auth: { type: 'header', name: 'X-Api-Key', value: process.env.DEPTRACK_API_KEY ?? '' },
});
const projects = await dt
  .paginate<DtProject>({ path: '/v1/project' },
    pagePerPage({ pageParam: 'pageNumber', sizeParam: 'pageSize', pageSize: 100, totalHeader: 'X-Total-Count' }))
  .collect();
```

## Retry

The one retry policy, shared by the HTTP client and `retryWithBackoff`: statuses 408, 425, 429, 500, 502, 503, 504 (never 501, never another 4xx) and network errors ECONNRESET, ETIMEDOUT, EAI_AGAIN, ECONNREFUSED on connect (the code and syscall are read from the error or its `cause`). A loop, never recursion; `Retry-After` honoured with a cap; otherwise full-jitter exponential backoff.

```typescript
import { retryWithBackoff } from '@novorb/mcp-core/retry';

const result = await retryWithBackoff(async (ctx) => someUnreliableOperation(ctx.attempt), {
  maxRetries: 3,          // attempts = 1 + maxRetries
  initialDelayMs: 1000,   // backoff ceiling = min(maxDelayMs, initial * multiplier^attempt), then a uniform draw
  maxDelayMs: 10_000,
  maxRetryAfterMs: 30_000, // cap on a Retry-After read from error.retryAfterMs or error.response.headers
  signal: ctx.signal,     // stop retrying (reject with the abort reason) once aborted
  shouldRetry: (err) => isRetryableError(err), // the default
  onRetry: ({ attempt, delayMs, fromRetryAfter }) => {},
});
```

`isIdempotentMethod(method)` is exported for callers that wrap their own transport: never replay a POST/PATCH without an idempotency key.
