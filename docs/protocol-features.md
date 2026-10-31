# Protocol features (logging, sampling, roots, elicitation, progress, cancellation)

The 2026-07-28 revision deprecates protocol logging, sampling and roots (SEP-2577: functional for at
least twelve months, marked `@deprecated` in the SDK types) and removes server-to-client push requests
in favour of multi round-trip requests (MRTR, `inputRequired(...)`). 2025 clients still use all of
them, so mcp-core keeps them available:

| Feature | 2025-era stdio | 2025-era stateless HTTP | 2026-07-28 (stdio and HTTP) | SDK mechanism |
|---------|----------------|-------------------------|-----------------------------|---------------|
| Protocol logging | yes, `logging/setLevel` kept per connection | yes, every level (each request is a fresh instance, so a set level is not kept) | only when the request carries `_meta['io.modelcontextprotocol/logLevel']` (the v2 client's `setLoggingLevel` throws on this era) | `ctx.mcpReq.log` |
| Elicitation (form, URL) | yes (legacy shim: real server-to-client request + re-entry) | no: the instance never saw `initialize`, so no client capability is known (`unsupported`) | yes (client fulfils, retries) | `inputRequired.elicit` / `.elicitUrl` |
| Sampling | yes (shim) | no (`unsupported`) | yes | `inputRequired.createMessage` |
| Roots | yes (shim) | no (`unsupported`) | yes | `inputRequired.listRoots` |
| Progress | yes | yes (`responseMode: 'auto'` upgrades to SSE) | yes | `notifications/progress` |
| Cancellation | `ctx.signal` | `ctx.signal` | `ctx.signal` | `ctx.mcpReq.signal` |

**Protocol logging** (`LOG_PROTOCOL=true` or `createMcpServer(..., { protocolLogging: true })`, default
off): advertises the `logging` capability and forwards every mcp-core logger entry produced while a
`registerTools` handler runs (an AsyncLocalStorage scope; `runWithRequestContext(ctx, fn)` for
hand-registered handlers) as `notifications/message` with `{ message, context, meta? }` and the logger
name. The entries are exactly what the log files get (redacted, PII-masked, registered secrets as
`[SECRET]`), and the logger never carries tool inputs or outputs (`logToolCall` is shape only). Levels map
DEBUG/INFO/WARN/ERROR to `debug`/`info`/`warning`/`error`; an entry below the logger's own `LOG_LEVEL` is
never produced.

**Elicitation, sampling, roots** on `ToolContext`, era-blind over MRTR; each returns a typed
`InputOutcome` and never throws:

```typescript
handler: async ({ domain }, ctx) => {
  const answer = ctx.elicit('confirm', {
    message: `Buy ${domain}?`,
    requestedSchema: z.object({ confirm: z.boolean() }),   // the accepted content is validated against it
  });
  if (answer.status === 'pending') return answer.result;    // re-entered with the user's answer
  if (answer.status === 'unsupported') return toolError(`cannot confirm: ${answer.reason}`);
  if (answer.status !== 'accepted' || !answer.value.confirm) return toolResult('not purchased');
  return toolResult(await buy(domain, { signal: ctx.signal }));
}
```

Statuses: `accepted` (`value`), `declined`, `cancelled`, `invalid` (accepted content failing the schema),
`pending` (`result`: return it), `unsupported` (`reason`: the client did not declare the capability, or no
capabilities are known for the request). `ctx.sample(key, params)` answers the `CreateMessageResult`,
`ctx.listRoots(key = 'roots')` the `Root[]`, `ctx.elicitUrl(key, params)` `true` once accepted. For
several requests at once return `inputRequired({ inputRequests: { ... } })` yourself (from
`@novorb/mcp-core/server`) and read `ctx.sdk.mcpReq.inputResponses`.

**Progress and cancellation:** `await ctx.progress(current, total?, message?)` sends
`notifications/progress` when the client passed a `progressToken`; it is a no-op without one, once the
request is cancelled, and when the send fails. Pass `ctx.signal` to every outbound call:

```typescript
handler: async ({ projectIds }, ctx) => {
  for (const [i, id] of projectIds.entries()) {
    if (ctx.signal.aborted) break;                     // the client cancelled or disconnected
    await sync(id, { signal: ctx.signal });
    await ctx.progress(i + 1, projectIds.length, `synced ${id}`);
  }
  return toolResult({ synced: projectIds.length });
}
```
