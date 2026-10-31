# Transport and Express adapter

## Transport

Unified transport that selects between stdio (`serveStdio`) and stateless streamable HTTP (`createMcpHandler` + `toNodeHandler`) based on the `MCP_TRANSPORT` environment variable. HTTP mode is fail-closed (refuses to start without auth unless explicitly disabled) and supports Bearer-token auth, body-size caps, and opt-in DNS-rebinding protection.

```typescript
import { startMcpServer } from '@novorb/mcp-core/transport';

// Factory (required for HTTP, recommended for stdio):
await startMcpServer(() => createServer(services));

// Server instance (stdio only; HTTP mode throws):
await startMcpServer(server);
```

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `PORT` | `8080` | HTTP listen port |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only) |
| `MCP_API_KEY` | none | Bearer token for HTTP auth (required in HTTP mode unless disabled) |
| `MCP_AUTH_DISABLED` | `false` | Set `true` to run HTTP without auth (only behind a fronting gateway) |
| `MCP_MAX_BODY_BYTES` | 4 MiB | Max accepted POST body size |
| `MCP_ALLOWED_HOSTS` | none | Comma-separated Host allowlist, matched by hostname (port ignored); enables DNS-rebinding protection |
| `MCP_ALLOWED_ORIGINS` | none | Comma-separated Origin allowlist, matched by hostname (port ignored; a full-origin entry's scheme is ignored); a lowercase `<scheme>://*` entry admits that whole scheme, `http://*` / `https://*` are never honoured; enables DNS-rebinding protection |

An unknown `MCP_TRANSPORT` value throws. Explicit options (`mode`, `port`, `host`, `apiKey`, `auth`,
`maxBodyBytes`, `allowedHosts`, `allowedOrigins`) win over the env; `runMcpServer` passes the values of
the loaded env (`transportFromEnv`). The handle's `closed` promise resolves when the transport ends
(`close()`, or a stdio client closing stdin).

### HTTP auth

The Bearer gate is the SDK's resource-server path: `verifyBearerToken` (header parse, verifier,
`expectedResource`, `requiredScopes`, expiry) and `bearerAuthChallengeResponse` (401 `invalid_token` /
403 `insufficient_scope` with `WWW-Authenticate: Bearer ...`, `resource_metadata` when configured). The
verified `AuthInfo` is set as `req.auth`; the SDK forwards it to the factory (`RequestContext.authInfo`)
and to handlers (`ctx.http.authInfo`, `ToolContext.authInfo`), so per-tool `scopeChallenge:
requireScopes('write')` works.

- Static key: `MCP_API_KEY` (or `apiKey`) becomes `apiKeyVerifier(key, { clientId?, scopes?, ttlSeconds? })`:
  a constant-time compare (SHA-256 of both sides, `timingSafeEqual`) answering
  `{ token: '[api-key]', clientId: 'api-key', scopes: [], expiresAt: now + 3600 }`. The real key never
  reaches `AuthInfo`. Set its scopes with `auth: { apiKey: { clientId, scopes } }`.
- Pluggable: `auth: { verifier }` takes any `OAuthTokenVerifier` (for example an OAuth JWT
  verifier); it replaces the static key and always enforces auth. `requiredScopes`,
  `resourceMetadataUrl` and `expectedResource` pass through to the SDK.
- Fail-closed is unchanged: no key, no verifier and no explicit disable refuses to start. Guard order
  is unchanged: `/health`, Bearer (401/403), path (404), Host/Origin (403), content type (415, the SDK's
  media-type essence compare: `application/json` with parameters, any case; `application/json-seq` is
  refused), body size (413), parse (400 `-32700`), dispatch.

## Express adapter (`@novorb/mcp-core/express`)

For hosts that already run Express: the same stateless handler, factory and
`RequestContext` semantics as `startMcpServer`'s HTTP mode, built on `@modelcontextprotocol/express`
(`requireBearerAuth`, `hostHeaderValidation`, `originValidation`). Install `express` (`^4.18 || ^5`) and
`@modelcontextprotocol/express` (`~2.0.2`); without them the import throws `ExpressAdapterUnavailableError`.

```typescript
import express from 'express';
import { mountMcpServer } from '@novorb/mcp-core/express';

const app = express();
const mcp = mountMcpServer(app, (req) => buildServer(req.authInfo), {
  auth: { verifier: keycloakVerifier, requiredScopes: ['mcp'] },   // or apiKey / MCP_API_KEY
  allowedHosts: ['gateway.internal'],
});
app.listen(8080);
// shutdown: await mcp.close();
```

Options: `path` (`/mcp`), `health` (`/health`; `false` disables, a string moves it), `apiKey` (default
`MCP_API_KEY`; `null` runs open), `auth` (as for the transport), `maxBodyBytes`, `allowedHosts`,
`allowedOrigins`, `env`, `bus` (the change-event bus, default the process bus), `onError` (receives every
SDK and adapter request error, including an authenticator fault that answers 500; default the mcp-core
logger), `authenticateRequest`
(for a host whose own middleware already authenticated the request: `(req) => AuthInfo` replaces the
Bearer gate, `apiKey` and `auth.verifier`, since a token verifier never sees `req`; it must throw for an
unauthenticated request, and a throw answers the SDK challenge, an `OAuthError` its 401/403 and anything
else 500; combining it with `apiKey` or `auth.verifier` throws at construction). Guard order: health > Bearer (401/403 SDK challenge, `req.auth` set) >
Host/Origin (403) > 415 > 413 > 400 `-32700` > dispatch; fail-closed like the transport. A body already
parsed by an app-level `express.json()` is used as is (then that parser's limit applies).
`createMcpRouter(factory, options)` returns the router without mounting it.
