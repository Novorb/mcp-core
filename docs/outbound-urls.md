# Outbound URLs

## Guarded outbound fetch (`@novorb/mcp-core/net`)

Use it for every URL a server did not configure itself: a tool argument (an avatar or image URL), or a
URL an upstream handed back (a download link, a thumbnail).

```typescript
import { guardedFetch, GuardedFetchError, normalizeOrigins } from '@novorb/mcp-core/net';

const res = await guardedFetch(url, {
  allowedOrigins: normalizeOrigins(env.get('MY_ALLOWED_ORIGINS') ?? '', 'MY_ALLOWED_ORIGINS'), // optional
  redirects: 'refuse',               // default; or a number: follow at most n, every hop re-validated
  maxBytes: 5_000_000,               // default 50 MiB, declared and streamed
  timeoutMs: 30_000,                 // default 30 s, head and body together
  signal: ctx.signal,
  allowedContentTypes: ['image/*'],  // optional, lower-cased essence; `allowMissingContentType` to pass none
});
if (!res.ok) throw new Error(`download failed (${res.status})`);
const bytes = Buffer.from(await res.arrayBuffer());   // a GuardedFetchError if the body breaks a cap
```

- **Guarantees:** http(s) only; no userinfo; `allowedOrigins` (WHATWG origins, normalised); public
  addresses only (`isPublicAddress`): IPv4 this-network, private, CGNAT, loopback, link-local and the
  cloud metadata address, IETF assignments, documentation, benchmarking, multicast, reserved, broadcast;
  IPv6 unspecified, loopback, link-local, unique local, site-local, multicast, documentation, Teredo /
  ORCHID, everything outside 2000::/3, and the forms embedding a refused IPv4 address (mapped,
  compatible, NAT64, 6to4). IP literals (every spelling the URL parser normalises: decimal, hex, octal,
  short) are checked before sending; DNS names are checked inside the socket lookup on every resolved
  address (`all: true`, an empty answer refused), so there is no check-then-connect gap and a rebinding
  name cannot slip through. Each request has its own agent (keep-alive off, destroyed when the body
  settles), never the global agent: with `NODE_USE_ENV_PROXY` + `HTTP(S)_PROXY` the global agent hands
  the request to the proxy, which resolves the name itself.
- **Options:** `allowPrivate` (explicit opt-in, default false), `isAllowedAddress` (a custom policy; also
  the test seam), `lookup` (the DNS seam), `method` `GET | HEAD`, `headers` (dropped when a redirect
  changes origin), `redirects`, `maxBytes`, `timeoutMs`, `signal`, `allowedContentTypes` (applied to a
  2xx), `allowMissingContentType`.
- **Caps are validated:** a non-finite or negative `redirects`, `maxBytes` or `timeoutMs` (which would
  silently disable the cap) is a `TypeError` before anything is sent; `downloadToFile` validates its
  `maxBytes`, `maxRedirects` and `timeoutMs` the same way.
- **Result:** a fetch `Response` for any final status (the caller decides what a 404 means), with `url`
  (the final URL) and `redirected`. With `redirects: 'refuse'` every 3xx (300 to 399, with or without
  `Location`) is refused; when following, a 3xx without `Location` (or a 300/304/305) is returned. Refusals and failures are `GuardedFetchError` with `reason` `url |
  protocol | credentials | origin | address | redirect | redirects | content-type | too-large | timeout |
  aborted | network`, `code` (`ERR_ADDRESS_BLOCKED` for the address policy, the socket code otherwise)
  and `status` for a refused redirect. Messages never contain the URL.
- **Lower level:** `checkUrl(url, opts)` (the URL rules, throws), `createGuardedAgent('http:' | 'https:',
  opts)` (an agent whose sockets resolve through the guard: pass it as `agent` to `http.request`, after
  `checkUrl`, since Node never calls the lookup for an IP literal, and destroy it when done),
  `guardedLookup(base, policy)`, `addressPolicy(opts)`, `normalizeOrigins(entries, label)`.

**Example: downloading an image a tool caller named.**

```typescript
import { guardedFetch, GuardedFetchError, normalizeOrigins } from '@novorb/mcp-core/net';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export async function downloadImage(url: string, o: ImageDownloadOptions): Promise<Blob> {
  try {
    const res = await guardedFetch(url, {
      allowedOrigins: o.allowedOrigins, maxBytes: o.maxBytes, timeoutMs: o.timeoutMs, signal: o.signal,
      allowedContentTypes: IMAGE_TYPES, allowMissingContentType: true, headers: { Accept: 'image/*' },
    });
    if (!res.ok) throw new Error(`Failed to download image from ${url}: ${res.status} ${res.statusText}`);
    const type = (res.headers.get('content-type') ?? 'image/png').split(';')[0].trim().toLowerCase();
    return new Blob([await res.arrayBuffer()], { type });
  } catch (e) {
    if (e instanceof GuardedFetchError) throw new Error(`Failed to download image from ${url}: ${e.message}`);
    throw e;
  }
}
```

Build the origin list with `[new URL(apiUrl).origin, ...normalizeOrigins(extra ?? '', 'MY_ALLOWED_ORIGINS')]`.
`store.downloadToFile(url, ...)` is guarded by default; pass `allowedContentTypes` (for example `['image/*',
'video/*']`) to tighten it, and never `allowPrivate`.

## Upstream URL path segments (`@novorb/mcp-core/url-path`)

`encodeURIComponent` leaves `.` and `..` intact and the URL parser collapses them
(`/repositories/..` addresses the parent). Put every caller id or name into an upstream path through:

```typescript
import { buildPath, joinPath, pathSegment } from '@novorb/mcp-core/url-path';

const path = buildPath`/service/rest/v1/repositories/${{ name: 'repository', value: args.repository }}`;
const same = joinPath('service', 'rest', 'v1', 'repositories', { name: 'repository', value: args.repository });
const one = pathSegment(args.itemId, { name: 'itemId' });
```

- One segment, encoded with `encodeURIComponent`. Refused (`InvalidPathSegmentError`, `argument` and
  `problem` `empty | dot-segment | control | invalid`): empty, `.`, `..`, their percent-encoded and
  double-encoded forms (`%2e`, `%2E%2e`, `.%2e`, `%252e`), overlong UTF-8 dots decoded leniently
  (`%c0%ae`, `%e0%80%ae`), unicode dot forms after NFKC normalisation (U+FF0E fullwidth, U+FE52 small,
  U+2024 / U+2025 leaders, U+3002 / U+FF61 ideographic full stops), C0 and C1 control characters, DEL,
  U+2028 and U+2029 (raw or encoded, `%00`, `%0A`, `%C2%85`, `%c0%80`), and non-finite numbers. `...`,
  `.hidden`, `a..b` and a name with a fullwidth dot inside are ordinary names. Each value is checked as
  the most lenient upstream would read it (up to three decoding rounds, each also NFKC-normalised).
- The message is `Invalid <name>: must not be "." or ".." (or an encoded form of them)` (and the like): it
  names the argument and never echoes the value. `registerTools` returns it as the isError text
  whatever the server's `mapError` does.
- Literal parts of `buildPath` are kept as written; `joinPath` encodes every part and adds one leading
  slash.
