# Data store

```typescript
const store = createDataStore({ rootDir, env, logger });
await store.writeFile(`downloads/${safeName(remoteName)}`, bytes);   // atomic, via resolveInside
const cache = store.jsonCache<Discovery>({ name: 'discovery', ttlMs: 3_600_000 });
const dl = await store.downloadToFile(url, 'files/report.pdf', { maxBytes: 10_000_000, timeoutMs: 30_000, signal: ctx.signal });
const refusal = store.requireEnabled('the SQLite cache');            // a toolError when DATA_STORAGE=false
```

- Directory: `DATA_PATH` (absolute, or relative to rootDir), default `<rootDir>/.data`, created lazily.
  `DATA_STORAGE=false` runs stateless: no directory is ever created, writes throw
  `DataStorageDisabledError`, `readFile` is null, `jsonCache` keeps values in memory for the process, and
  `downloadToFile` returns `{ path: null, data }` so a tool can return the content inline. An invalid
  `DATA_STORAGE` value (not a boolean) also disables writes, with one WARN. The logger's file sinks are
  separate: for a fully stateless host also set `LOG_FILE_MAIN=false`, `LOG_FILE_EXCEPTIONS=false` and
  `LOG_FILE_DEBUG=false` (or `LOG_PATH` to a writable volume).
- Writes are atomic (a temp file, then a rename). On Windows a rename onto a file another handle has open
  (a reader polling it, AV, the indexer) fails with EPERM/EACCES/EBUSY; `renameWithRetry` retries those
  with a short growing backoff for up to about 2 s before rethrowing (other platforms and errors fail at
  once).
- `resolveInside` refuses `..`, absolute segments, drive letters (`C:\x`, `C:x`), UNC and root paths, NUL,
  and symlink/junction escapes (`DataPathError`). Pass untrusted names (tool arguments, remote file names)
  through `safeName` first.
- `downloadToFile(source, relPath, { maxBytes = 50 MiB, timeoutMs = 60 s, signal, maxRedirects = 3, headers,
  allowPrivate = false, allowedOrigins, allowedContentTypes })`: `source` is a URL or any client as
  `({ signal }) => Promise<Response>`. A URL source goes through `guardedFetch` (see
  [Outbound URLs](outbound-urls.md)): http/https only, no userinfo, public addresses only unless `allowPrivate: true` (checked in the
  socket lookup, own agent per request), every redirect hop re-validated and the count bounded, caller
  headers dropped on a cross-origin redirect. A function source is the caller's own client and is not
  guarded (the caller owns its URL). Size is checked on `Content-Length` and while streaming, and the body
  read is bounded by the timeout and signal even when a fetcher ignores them. The path is validated in
  both modes. Failures are `DownloadError` with `reason` `status | too-large | timeout | redirects |
  protocol | aborted | network | blocked | content-type` (`blocked`: the guard refused the URL or a hop).
  A server that must download from a private host (a self-hosted upstream on the LAN) passes
  `allowPrivate: true` explicitly, ideally together with `allowedOrigins`.
- Consumers gitignore `.data/` and `.logs/`.
