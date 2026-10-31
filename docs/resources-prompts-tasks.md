# Resources, prompts, notifications, tasks, requestState

**Resources** (`@novorb/mcp-core/resources`) go onto the SDK's `registerResource`, so listing, template
matching, completion and `ResourceNotFoundError` stay the SDK's. mcp-core adds a log line per read (name and
size, never the content or the filled-in URI), masked JSON-RPC errors through `mapError`, the uniform
degraded-mode error for missing `requires`, and a byte cap per read (`maxBytes`, default
`MCP_MAX_RESULT_BYTES`): an oversized read is an actionable error, never a truncated document. A handler
may return a string (text) or bytes (blob); `mimeType` fills in.

```typescript
registerResources(server, [
  defineResource({ name: 'readme', uri: 'repo://readme', mimeType: 'text/markdown', read: async () => readme }),
  defineResourceTemplate({
    name: 'file', uriTemplate: 'repo://files/{path}', mimeType: 'text/plain',
    complete: { path: (prefix) => paths.filter((p) => p.startsWith(prefix)) },
    read: async ({ variables }) => readFile(String(variables.path)),
  }),
], { env, serverName: 'repo-mcp', subscribe: true, request: req });
```

`subscribe: true` serves the 2025-era `resources/subscribe` / `unsubscribe` (not advertised on 2025-era
stateless HTTP, where no update can be delivered). Tools point at resources with `resourceLink(...)` or
`embeddedResource(...)`. `createResultSpill()` connects the tool result byte cap to resource links: pass
`spill.onOversize` to `registerTools` and register `spill.resource`; an oversized result is kept in memory
(bound to the caller's `clientId`, expiring after `ttlMs`, at most `maxEntries` and `maxTotalBytes`, oldest
dropped first) and the tool answers a short text plus a `resource_link`. It is per process, so a
multi-instance HTTP deployment needs sticky routing for the read.

**Prompts** (`@novorb/mcp-core/prompts`): `registerPrompts(server, [definePrompt({ name, argsSchema,
handler })], opts)` on the SDK's `registerPrompt`, with the same logging (argument shape only), masking,
degraded mode, `enabled` and `prefix`. A handler may return a string (one user message).

**Change notifications** (`@novorb/mcp-core/notifications`): the SDK serves 2026-07-28
`subscriptions/listen` streams from a `ServerEventBus`. mcp-core makes one bus process-wide
(`processBus()`) and wires it into every transport, so one publish reaches every connection:

```typescript
const notify = createNotifier();            // or ctx.notify in runMcpServer's setup, or handle.notify
notify.toolsChanged();
notify.resourceUpdated('repo://files/notes.txt');
```

| Connection | Delivery |
|---|---|
| HTTP, 2026-07-28 | `subscriptions/listen` SSE streams on this process |
| stdio, 2026-07-28 | the connection's open subscriptions |
| stdio, 2025-era | unsolicited notifications; `resources/updated` only for subscribed URIs |
| HTTP, 2025-era stateless | none (no channel) |

Multi-instance hosts pass a shared bus (`setProcessBus`, or `bus` on `startMcpServer`, `runMcpServer`,
`mountMcpServer`); the contract a shared implementation must meet is documented in `src/notifications.ts`.
`createRuntimeSurface(notify)` passed as `surface` to `registerTools` / `registerResources` /
`registerPrompts` enables and disables primitives at runtime: per-request HTTP instances read it when built,
live stdio instances are toggled in place, and one list-changed event goes out.

**Tasks** (`@novorb/mcp-core/task-store`, `/task-tools`): a task tool answers a task handle and runs its
work in this process; the client polls, waits or cancels. `registerTaskTools` serves the task methods for
the request's era:

| | 2025-11-25 | 2026-07-28 (`io.modelcontextprotocol/tasks` extension) |
|---|---|---|
| start | `tools/call` with `params.task` | `tools/call` from a client declaring the extension |
| poll | `tasks/get` | `tasks/get` (result, error or input requests inlined) |
| result | `tasks/result` (blocks until terminal) | inlined in `tasks/get` |
| list | `tasks/list` | none |
| cancel | `tasks/cancel` | `tasks/cancel` (idempotent) |
| input | not supported | `task.requireInput(...)`, answered with `tasks/update` |

```typescript
const store = createTaskStore(data);         // in setup: FileTaskStore under DATA_PATH, memory when DATA_STORAGE=false
registerTaskTools(server, [
  defineTaskTool({
    name: 'export_report', description: 'Export a report', inputSchema: z.object({ report: z.string() }),
    annotations: TOOL_ANNOTATIONS.mutableWriteOpenWorld,
    run: async ({ report }, task) => {
      for (let i = 1; i <= 10; i++) { task.signal.throwIfAborted(); await step(); await task.progress(i, 10); }
      return toolResult({ report, rows: 42 });
    },
  }),
], { store, request: req });
```

A client without task support gets the tool run synchronously (with progress), unless `taskSupport:
'required'`. Tasks are bound to the creating caller's `clientId`: another caller sees "not found". The file
store shares tasks between processes on one host: a cancel or a `tasks/update` written by one process
reaches the work running in another through a status poll (`cancelPollMs`).

**Sealed requestState** (`@novorb/mcp-core/request-state`): a multi-step tool returns
`await ctx.continueWith(state, inputRequests?)` and reads `ctx.requestState()` on the retry. The echoed
state is attacker-controlled, so mcp-core seals it: AES-256-GCM under an HKDF sub-key, an expiry
(`MCP_REQUEST_STATE_TTL_SECONDS`, default 600), binding to the method and the caller's `clientId`, and key
rotation (`MCP_REQUEST_STATE_PREVIOUS_KEY_1`, ...). Pass `requestStateCodec: requestStateCodecFromEnv(env)`
to `createMcpServer`; it throws without `MCP_REQUEST_STATE_KEY` (at least 32 bytes, the same on every
instance). A refused state answers the SDK's `-32602 Invalid or expired requestState`; the reason goes to
the server log. Without a codec `ctx.requestState()` is always undefined and `continueWith` throws.
