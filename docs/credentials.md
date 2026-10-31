# Credential health

A credential is checked once when the env is loaded, and that is enough. While the server runs a key
can degrade (quota, rate limit), become invalid or expire: that never crashes the server and never turns
a tool call into an error just because one key went bad, and no key is lost for good. Every tool result
that touched a credential tells the model which keys it used and which are degraded, invalid or expired.
Only declared key NAMES ever appear in logs, results and the status tool; never a value.

Statuses: `valid`, `invalid` (the credential was rejected), `expired`, `degraded` (quota or rate limit,
back to `unknown` once the retry-after elapses), `unknown` (no check, timeout, network error).

**Declare** a `check` on the env spec (each member of a `multi` pool is its own credential, named by its
key). A spec with a `check` is always treated as `secret: true` (masked in every log line and error, never
rendered), whether or not it says so. A check returns a status, `{ status, reason?, retryAfterMs? }`, or
throws (a thrown `HttpError` is classified like any HTTP outcome). `ctx.http(config)` builds a hardened
client with retries off and the check timeout. A multi-part credential (client id + secret + user +
password, key + secret) puts the `check` on one key and reads the others with `ctx.get('SIBLING_KEY')`:
declared keys only (an undeclared key throws, the check reads `unknown`), values never logged; declare
the siblings `secret: true` so they are masked too, and name the rejected part in the reason
(`{ status: 'invalid', reason: 'CONTABO_API_PASSWORD rejected' }`). List the siblings in the spec's
`covers: ['CONTABO_CLIENT_SECRET', 'CONTABO_API_USER', 'CONTABO_API_PASSWORD']` (declared keys; a base key
of a `multi` family covers its members) and the registry applies the check's status and reason, every
re-check and every runtime outcome recorded on the primary key to each covered part, so no part stays
`unknown` in `credential_status` or the report. Without `covers` only the key carrying the check changes.

```typescript
import type { EnvSchema } from '@novorb/mcp-core/env';

const ENV: EnvSchema = [
  {
    key: 'SERPER_DEV_API_KEY', secret: true, description: 'Serper.dev key',
    check: async (value, { http, signal }) => {
      await http({ baseURL: 'https://google.serper.dev', headers: { 'X-API-KEY': value } })
        .post('/account', {}, { signal });
      return 'valid';                                   // a 401 throws -> invalid, 402/429 -> degraded
    },
  },
  {
    key: 'VALUE_SERP_API_KEY', secret: true, multi: true, description: 'ValueSERP keys (_1, _2, ...)',
    check: async (value, { http, signal }) => {
      const acct = await http({ baseURL: 'https://api.valueserp.com' })
        .get<{ account_info?: { credits_remaining?: number } }>('/account', { query: { api_key: value }, signal });
      return (acct.account_info?.credits_remaining ?? 1) > 0 ? 'valid' : { status: 'degraded', reason: 'quota' };
    },
  },
];
```

**Startup** (`runMcpServer`): after the env load every server credential is registered (a server's
own `secret` keys and every key with a `check`; mcp-core's own secrets such as `MCP_API_KEY` are not) and
the checks run ONCE, at most 4 at a time (so a large pool does not trip its provider's rate limit), each
bounded by `MCP_CREDENTIAL_CHECK_TIMEOUT_MS` (default 5000; a timeout reads `unknown`).
`MCP_CREDENTIAL_CHECKS=false` skips them for offline or stateless starts. The server ALWAYS starts (even
when the registration itself fails: one WARN); one summary line is logged (`credential checks: KEY valid,
KEY_2 invalid (auth rejected)`), WARN when any key is not valid. The results live in the process
`CredentialRegistry` (`processCredentials()`, also `ctx.credentials` in `setup`/`create` and
`running.credentials`).

**Recovery:** an invalid or expired key is never dropped. It stays a last-resort candidate (tried when
nothing healthier is left, so a single-key server keeps trying its key and a success restores it), and
after `MCP_CREDENTIAL_RECHECK_MS` (default 300000) its startup `check` runs again in the background the
next time its pool is consulted; a pass makes it `valid`. A degraded key goes back to `unknown` once its
retry-after elapses.

**At call time** every handler gets `ctx.credentials` (a per-call scope over the registry):

```typescript
const search = defineTool({
  name: 'search', description: 'Web search', annotations: TOOL_ANNOTATIONS.readOnlyOpenWorld,
  inputSchema: z.object({ q: z.string() }),
  outputSchema: z.object({ results: z.array(z.string()) }),   // gets an optional `credentials` field
  handler: async ({ q }, ctx) =>
    // Tries the pool members in order (valid, unknown, degraded, then invalid/expired last); a credential
    // failure (401, 402, 429, a credential-specific 403) is recorded and the next key is tried; every
    // member failing -> an actionable isError with the report.
    ctx.credentials.withFallback(['SERPER_DEV_API_KEY', ...env.members('VALUE_SERP_API_KEY')], (key, value) =>
      key === 'SERPER_DEV_API_KEY'
        ? serper.post('/search', { q }, { credential: key, headers: { 'X-API-KEY': value ?? '' }, signal: ctx.signal })
        : valueSerp.get('/search', { credential: key, query: { api_key: value ?? '', q }, signal: ctx.signal }),
    ).then((data) => toolResult({ results: extract(data) })),
});
```

- `pick(pool)` returns the best key NAME: valid first, then unknown, then degraded, then invalid and
  expired as the last resort; it rotates among equally healthy keys. It is undefined only for a pool with
  no member, and `require(pool)` throws `NoUsableCredentialError` in that case. `candidates(pool)` lists
  the members in that order. `record(key, outcome, { reason?, retryAfterMs? })` reports what a use
  showed: `ok` / `recovered` -> valid, `used` = no change, or `degraded` / `invalid` / `expired`.
  `use(key)` marks a key used. A pool is a multi family's base key, a single key, or a list of keys.
- **Names only:** every identifier must be a declared env key or pool member. Anything else (most often a
  value passed where the name belongs) throws `UnknownCredentialError` before it is recorded, reported
  or sent; the message never contains the identifier.
- The http-client records automatically: pass `credential: '<KEY NAME>'` on the request. Mapping
  (`credentialOutcomeFromHttp`, status-gated): 2xx ok. 401 -> invalid, or expired when the error code,
  message, OAuth `error_description` or the `WWW-Authenticate` challenge's `error` / `error_description`
  parameters name an expired credential (GitLab answers an expired token with `{"error":"invalid_token",
  "error_description":"Token is expired. ..."}` and `WWW-Authenticate: Bearer error="invalid_token",
  error_description="Token is expired. ..."`: that is `expired`; a revoked token stays `invalid`; the
  realm and other challenge parameters are never read: the header is tokenised, so a quoted value cannot
  inject one; the fields are joined with ` ; ` so no pattern spans two of them). A thrown `HttpError`
  carries the same facts (`description`, `challenge: { error?, description? }`, masked, never the raw
  header), so `credentialOutcomeFromError` (`withFallback`, a startup check that throws) reaches the same
  verdict the client recorded. 402 -> degraded (quota). 429 -> degraded (rate limit, or quota). A 403 changes the
  key only when its body or `WWW-Authenticate` says the credential itself expired, hit a quota or rate
  limit, or was rejected (`bad credentials`, `invalid api key`, `revoked`, `invalid_token`); a plain 403
  is about access to one resource and leaves the key alone. Every other status (400, 404, 413, 422, 5xx)
  and network errors leave the status alone, whatever the body says. Degraded outcomes carry the
  `Retry-After`. Inside a tool call it records into the call's scope (so the result reports it); outside
  one into `HttpClientConfig.credentials` or the process registry. A shared in-flight request (a dedup
  cache or a coalesced call) reports its key on the call that started it only.
- Transitions are logged once per change: `Credential VALUE_SERP_API_KEY_2: valid -> degraded (quota)`.
- **The report**, appended to every result that touched a credential (successes and isErrors alike):
  a text block `Credentials: SERPER_DEV_API_KEY used; VALUE_SERP_API_KEY_2 degraded (quota, retry in
  3600s); SERPAPI_API_KEY invalid`, the same entries (`{ key, status, used, reason?, retryInSeconds? }`)
  under `_meta["io.novorb/credentials"]` (`CREDENTIALS_META_KEY`), and as `structuredContent.credentials`
  when the listed outputSchema declares that field. registerTools adds it (`withCredentialsField`) to an
  object-root schema with `properties`; a schema that declares its own `credentials`, a record root or an
  `allOf`/`$ref` root is left unchanged and gets the text and `_meta` report only. Every copy passes the
  client masking. The report's bytes count against `MCP_MAX_RESULT_BYTES`. An input-required result
  keeps the report in `_meta`. Reported: the keys the call used plus the considered pool members that
  are not healthy.
- A call where every member was tried and failed on its credential answers `<server> cannot serve
  <tool>: No usable credential for <POOL>: every candidate failed (...) (KEYS). Replace or renew the
  key(s), or wait for a degraded one to recover.` as an isError with the report. A call that succeeds
  with a fallback key is a success with the report.
- **Status tool:** `credentialStatusTool({ name?, registry? })` is a ready read-only tool
  (`credential_status`) listing every credential's status (names, pools, statuses, reasons, retry-after);
  integration tests read the startup results through it.
- A custom registry: `runMcpServer({ credentials })`, then `registerTools(server, tools, { credentials:
  ctx.credentials })` and `credentialStatusTool({ registry: ctx.credentials })`. A unit test that builds
  its own `CredentialRegistry` must `register(...)` the names it uses.
