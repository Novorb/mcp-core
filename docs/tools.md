# Tools

- `registerTools(server, tools, { env?, enabled?, prefix?, serverName?, mapError? })` registers every
  definition through `McpServer.registerTool`: the SDK builds `tools/list`, validates input (a failure is
  an isError result `Input validation error: ... <field>: <message>`), validates `structuredContent`
  against `outputSchema`, and answers an unknown tool with ProtocolError `-32602`. Returns the SDK handles.
- Write each definition with `defineTool({...})` so the handler's arguments are typed from its own
  `inputSchema` (a zod 4 object, or `fromJsonSchema(...)`); `annotations` is required. Every SDK `Tool`
  field reaches the wire: `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`,
  `icons`, `_meta`. Results go through the SDK's output validation and era projection (nothing bypasses
  `registerTool`); an unknown or `disable()`d tool is the SDK's own ProtocolError `-32602`, unwrapped.
- Per call: `logToolCall` / `logToolResult` with the duration (shape only, never values). A thrown error
  becomes `toolError(mapError(err).message)` (default: the message only, secret parameters redacted, never
  a stack or a raw error object; with a `code`, `<code>: <message>`); a thrown zod / Standard Schema error
  becomes `Invalid arguments: <path>: <message>; ...`. A returned legacy `{ success: false, error }`
  envelope becomes `isError: true` (text = the envelope JSON); `{ success: true, data }` keeps its text,
  with `data` as `structuredContent` when the tool has an `outputSchema`.
- Degraded mode: a tool whose `requires` keys are not configured is still listed, and answers
  `<serverName> is not configured: set <KEYS>`. `requires` keys must be declared in the env schema.
- `ToolContext`: `signal` (pass it to outbound calls so cancellation stops upstream work), `authInfo`,
  `cursor` (the `cursor` argument when it is a non-empty string), `era` (`modern` | `legacy`),
  `clientCapabilities`, `logger`, `progress(progress, total?, message?)`, `elicit`, `elicitUrl`,
  `sample`, `listRoots` (see [Protocol features](protocol-features.md)), `credentials` (the call's credential scope, see
  [Credential health](credentials.md)), `tool`, `sdk` (the raw SDK context).
- `registerTools` option `credentials` picks the registry (default the process registry); every result
  that touched a credential carries the credential report.
- `toolResult(data, { text? })`: a string is the text; an object is pretty JSON plus `structuredContent`.
  `toolError(message, details?)`: `isError: true`, details as a second JSON text block.
- Client-bound error text is masked like the log files: `toolError`, the `mapError` output, thrown
  errors, schema-issue text, the degraded-mode message and any isError result a handler returns go
  through `maskClientText` (secret query/userinfo/Basic parameters redacted, every registered secret
  value as `[SECRET]`).
- SDK protocol errors keep their code: a handler throwing `UrlElicitationRequiredError` (`-32042`, the
  2025 URL-elicitation path) reaches the client as that JSON-RPC error, exactly as the SDK's own
  `tools/call` rethrows it; every other throw becomes an isError result (the SDK does the same). An SDK
  input-required result (`inputRequired(...)`, `resultType: 'input_required'`) is passed through
  untouched.
- `scopeChallenge` (for example `requireScopes('write')`) is forwarded to `registerTool`.

## Response limits and pagination

Every tool result is capped centrally (defaults; env in `CORE_ENV_SCHEMA`; `RegisterToolsOptions.limits`
for the server; `ToolDefinition.limits` per tool, which wins):

| Cap | Env | Default |
|-----|-----|---------|
| Items in a list-shaped result | `MCP_MAX_RESULT_ITEMS` | 100 |
| Serialized bytes per result | `MCP_MAX_RESULT_BYTES` | 262144 (256 KiB) |

- **List-shaped** = `structuredContent` of the `PagedResult` shape `{ items, nextCursor?, total? }`
  (`toolResult(page)`, `pagedResultSchema(z, Item)`). A result with more items than the cap (or than the
  client's `limit`, itself capped) is cut and carries an opaque `nextCursor`; the text block is
  regenerated from the cut page, so it never carries the full dump. The cursor resumes where the page
  stopped: it records the tool, a fingerprint of the other arguments, the offset inside the handler's
  page and the handler's own cursor for that page. The next call re-runs the handler with its own
  cursor (as `args.cursor` and `ctx.cursor`; `args.limit` arrives capped) and mcp-core serves the next
  slice, or wraps the handler's own `nextCursor` once its page is used up. Stateless: nothing is stored.
- **Never trusted:** a cursor for another tool or other arguments, a malformed one, or an out-of-range
  offset is refused with `Invalid cursor: ...` (isError). An edited offset can only address the caller's
  own result set. `paginated: true` on a definition makes cursor handling strict (only mcp-core cursors)
  and requires `cursor` and `limit` in its input schema (checked at registration):
  `inputSchema: z.object({ ..., cursor: z.string().optional(), limit: z.number().int().positive().optional() })`.
  A tool returning a `PagedResult` without `paginated` is paged too and passes foreign cursors (its own,
  from a non-paged result) through to the handler.
- **`limit` is clamped on every tool.** An argument named `limit` that is a number is clamped to
  `1..MCP_MAX_RESULT_ITEMS` before the handler sees it, on every registered tool, paginated or not; a tool
  whose own `limit` means something else must name it differently. The limits are read from the `env`
  passed to `registerTools` (its loaded env, file and defaults included) and fall back to `process.env`
  only when no env is passed.
- **Foreign cursors arrive raw.** On a tool that is not `paginated`, a cursor mcp-core did not issue is
  passed to the handler untouched as `args.cursor`; the handler must validate it as untrusted input
  (digits only for a page number, origin and path checks for a URL).
- **Byte cap:** a list-shaped result is first paged smaller (halving until it fits); anything still over
  the cap, and any other result, becomes an actionable isError (`<tool>: the result is N bytes, over the M
  byte limit per response; narrow the request ... or use cursor/limit`). Never a truncated body, invalid
  JSON or schema-breaking `structuredContent`. `RegisterToolsOptions.onOversize(info)` may return a
  replacement instead (the seam for a resource link once resources exist).
- **Envelope tools:** `envelope: { key: 'data', hint: '...' }` on a definition says the payload sits under
  `structuredContent.data`. The item cap then applies to that payload (an array, or a PagedResult) and
  refuses rather than pages (`<tool>: the result has N items, over the M item limit per response; <hint>`),
  since such a tool has no mcp-core cursor; a text block that only repeats the payload is counted once in
  the byte cap; `hint` names the caller's real lever (for example its own `limit`/`offset` arguments).
- Enforcement is logged by shape only: `Tool result paged: <tool>` with `{ tool, items, served, limit }`,
  `Tool result over the byte limit: <tool>` with `{ tool, bytes, maxBytes }`; never content.
- Handlers must be deterministic for a given cursor (list reads are). `paginate().collect()` in the HTTP
  client is capped at the same `MCP_MAX_RESULT_ITEMS` by default (an explicit `maxItems` up to
  `HARD_MAX_COLLECT_ITEMS`, 100000), so a tool cannot pull an unbounded upstream list into memory;
  `collect()` reports `truncated`.
