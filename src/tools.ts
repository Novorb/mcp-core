/**
 * @novorb/mcp-core - Tools
 *
 * Register a server's tool definitions on an SDK v2 `McpServer` through `McpServer.registerTool`, so
 * the SDK keeps doing what it does (tools/list from the schemas, input validation, output validation
 * with the era projection, unknown tool = ProtocolError -32602) and mcp-core adds only what it lacks:
 *
 * - one central wrapper per tool: `logToolCall` / `logToolResult` with the duration (shape only,
 *   never values);
 * - thrown errors become an `isError` result through `mapError` (default: a safe message, never a
 *   stack trace, never a raw error object); a thrown schema error (zod / Standard Schema issues) names
 *   the offending fields;
 * - a returned legacy `{ success: false, error }` envelope becomes `isError: true`;
 * - degraded mode: a tool whose `requires` env keys are not configured is still LISTED and answers one
 *   uniform error, `<server> is not configured: set <KEYS>`;
 * - `enabled` filters what is registered at all.
 *
 *   registerTools(server, [
 *     {
 *       name: 'lookup',
 *       description: 'Look up a value',
 *       inputSchema: z.object({ key: z.string() }),
 *       annotations: TOOL_ANNOTATIONS.readOnly,
 *       requires: ['API_TOKEN'],
 *       handler: async ({ key }, ctx) => toolResult(await client.get(key, { signal: ctx.signal })),
 *     },
 *   ], { env, serverName: 'my-mcp' });
 */

import {
  type AuthInfo,
  type CallToolResult,
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  type Icon,
  type InputRequests,
  type InputRequiredResult,
  inputRequired,
  isInputRequiredResult,
  ProtocolError,
  ProtocolErrorCode,
  type RegisteredTool,
  type ScopeChallengeHandler,
  type ServerContext,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { type ClientInput, createClientInput, type RequestEra, requestEra } from './client-input.js';
import { resolveLimits } from './limits.js';
import { bindToSurface, type RuntimeSurface } from './notifications.js';
import { InvalidCursorError, invalidCursorResult } from './pagination.js';
import { runWithRequestContext } from './protocol-logging.js';
import { RequestStateKeyError } from './request-state.js';
import {
  declaresPageArgs,
  decodeToolCursor,
  enforceResultLimits,
  handlerArgs,
  type OversizeInfo,
  type ToolCursor,
  type ToolLimits,
} from './result-limits.js';
import { type McpServer, type McpToolAnnotations, requestStateCodecOf } from './server.js';
import type { LoadedEnv } from './utils/envLoader.js';
import { getLogger, type Logger, logToolCall, logToolResult, maskSecretValues } from './utils/logger.js';
import { redactStringSecrets } from './utils/redact.js';

/** The `{ success, data, error }` body the fleet's tools historically return. */
export interface LegacyEnvelope {
  success: boolean;
  data?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/**
 * What a tool handler may return: an MCP result, an SDK input-required result (elicitation, sampling,
 * roots through `ctx.elicit` / `ctx.sample` / `ctx.listRoots` or the SDK's `inputRequired(...)`;
 * passed through untouched), or a legacy envelope (mapped to a result).
 */
export type ToolOutcome = CallToolResult | InputRequiredResult | LegacyEnvelope;

/** Inferred handler arguments for an input schema. */
export type ToolArgs<I extends StandardSchemaWithJSON> = StandardSchemaWithJSON.InferOutput<I>;

/**
 * Per-call context handed to every handler. The client input helpers (`elicit`, `elicitUrl`, `sample`,
 * `listRoots`, see `client-input.ts`) answer a typed outcome and never throw.
 */
export interface ToolContext extends ClientInput {
  /** The tool name. */
  tool: string;
  /** Aborted when the client cancels or disconnects; pass it to outbound calls. */
  signal: AbortSignal;
  /** Caller identity when the transport supplies one (HTTP with an auth layer); otherwise undefined. */
  authInfo?: AuthInfo;
  /** The `cursor` argument of a list tool, when it is a non-empty string. */
  cursor?: string;
  /** The protocol era of this request (undefined when a handler is invoked directly). */
  era?: RequestEra;
  /** The client's declared capabilities, when known (stdio and 2026-07-28 requests). */
  clientCapabilities?: ClientCapabilities;
  /** The mcp-core logger. */
  logger: Logger;
  /**
   * Send a progress notification when the client asked for progress (a `progressToken`); a no-op
   * otherwise, once the request is cancelled, and when the send fails (progress never fails a tool).
   */
  progress(progress: number, total?: number, message?: string): Promise<void>;
  /** The raw SDK handler context (undefined when a handler is invoked directly, e.g. in unit tests). */
  sdk?: ServerContext;
  /**
   * The VERIFIED requestState payload of a multi-step retry (the server's `requestStateCodec` has
   * already authenticated it). Undefined on a first call, and always undefined when the server has no
   * codec: a raw, unverified wire string is never handed out.
   */
  requestState<T = unknown>(): T | undefined;
  /**
   * Ask for another round: seal `state` with the server's codec (bound to this caller) and return the
   * input-required result to answer with; the handler is re-entered with `requestState()` = `state`
   * and the client's answers to `inputRequests` (`ctx.elicit(...)` reads them by key). Throws
   * `RequestStateKeyError` when the server has no codec (MCP_REQUEST_STATE_KEY not configured).
   */
  continueWith<T>(state: T, inputRequests?: InputRequests): Promise<InputRequiredResult>;
}

export interface ToolDefinition<I extends StandardSchemaWithJSON = StandardSchemaWithJSON> {
  name: string;
  title?: string;
  description: string;
  /** A zod 4 object (or `fromJsonSchema(...)` for a JSON Schema). */
  inputSchema: I;
  /** Optional output schema; the SDK validates `structuredContent` against it. */
  outputSchema?: StandardSchemaWithJSON;
  /** Required: use a `TOOL_ANNOTATIONS` preset (an `*OpenWorld` one when the tool calls an external API). */
  annotations: McpToolAnnotations;
  /** Icons for clients that show them (SDK `Tool.icons`). */
  icons?: Icon[];
  /** Tool `_meta` (SDK `Tool._meta`), passed to the wire unchanged. */
  _meta?: Record<string, unknown>;
  /**
   * SDK per-tool scope gate (for example `requireScopes('write')`), run by the SDK before input
   * validation against the caller's `AuthInfo` scopes.
   */
  scopeChallenge?: ScopeChallengeHandler;
  /** Env keys that must be configured; otherwise the tool answers the uniform "not configured" error. */
  requires?: readonly string[];
  /**
   * This tool returns a `PagedResult` (`{ items, nextCursor?, total? }`): its input schema must declare
   * `cursor` and `limit`, and every cursor it receives must be one mcp-core issued (strict). Tools that
   * return a `PagedResult` without declaring it are paged too, but accept foreign cursors.
   */
  paginated?: boolean;
  /** Per-tool result caps (override the server-wide ones). */
  limits?: ToolLimits;
  handler: (args: ToolArgs<I>, ctx: ToolContext) => Promise<ToolOutcome>;
}

/**
 * Any tool definition, for heterogeneous lists. Each definition is checked against its own schema when
 * written with `defineTool`; the list type erases the per-tool argument type (`never` accepts every
 * handler; the SDK has validated the arguments against the definition's own schema before the call).
 */
export type AnyToolDefinition = Omit<ToolDefinition, 'handler'> & {
  handler: (args: never, ctx: ToolContext) => Promise<ToolOutcome>;
};

/** Identity helper that types a definition's handler arguments from its own input schema. */
export function defineTool<I extends StandardSchemaWithJSON>(definition: ToolDefinition<I>): AnyToolDefinition {
  return definition as unknown as AnyToolDefinition;
}

export interface MappedToolError {
  message: string;
  code?: string;
}

export interface RegisterToolsOptions {
  /** The loaded env; required for `requires` (degraded mode). */
  env?: LoadedEnv;
  /** Register only these tool names (before any prefix). */
  enabled?: readonly string[];
  /** Prefix prepended to every registered tool name. */
  prefix?: string;
  /** Server name used in the degraded-mode message (default "this server"). */
  serverName?: string;
  /** Per-service wording for thrown errors. Never return a stack trace or a raw response. */
  mapError?: (err: unknown) => MappedToolError;
  /**
   * Server-wide result caps (default MCP_MAX_RESULT_ITEMS / MCP_MAX_RESULT_BYTES, else 100 items and
   * 256 KiB); a tool's own `limits` win.
   */
  limits?: ToolLimits;
  /**
   * Called when a result cannot be brought under the byte cap; return a replacement (for example a
   * resource link) or undefined for the default actionable isError.
   */
  onOversize?: (info: OversizeInfo) => CallToolResult | undefined;
  /** Runtime enable/disable state (see `createRuntimeSurface`); keyed by the registered name. */
  surface?: RuntimeSurface;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A success result: the text block is `opts.text`, the string itself, or pretty JSON; a plain object
 * is also sent as `structuredContent` (the spec requires an object there).
 */
export function toolResult(data: unknown, opts: { text?: string } = {}): CallToolResult {
  const text = opts.text ?? (typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? String(data)));
  const result: CallToolResult = { content: [{ type: 'text', text }] };
  if (isPlainObject(data)) result.structuredContent = data;
  return result;
}

/**
 * Text bound for a client in an error: secret query/userinfo/Basic parameters redacted and every
 * registered secret value masked, exactly as the logger does for its lines.
 */
export function maskClientText(text: string): string {
  return maskSecretValues(redactStringSecrets(text));
}

/**
 * An error result (`isError: true`): the message as text, optional details as a second JSON block.
 * Both are passed through `maskClientText`.
 */
export function toolError(message: string, details?: Record<string, unknown>): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: maskClientText(message) }];
  if (details !== undefined) content.push({ type: 'text', text: maskClientText(JSON.stringify(details, null, 2)) });
  return { content, isError: true };
}

/** Mask every text block of an error result (whatever produced it). */
function maskErrorResult(result: CallToolResult): CallToolResult {
  if (result.isError !== true) return result;
  return {
    ...result,
    content: result.content.map((block) =>
      block.type === 'text' ? { ...block, text: maskClientText(block.text) } : block,
    ),
  };
}

interface SchemaIssue {
  message: string;
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
}

function schemaIssues(err: unknown): SchemaIssue[] | undefined {
  if (!isPlainObject(err) && !(err instanceof Error)) return undefined;
  const issues = (err as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  if (!issues.every((i) => isPlainObject(i) && typeof i.message === 'string')) return undefined;
  return issues as SchemaIssue[];
}

function issuePath(issue: SchemaIssue): string {
  const parts = (issue.path ?? []).map((p) => String(typeof p === 'object' && p !== null ? p.key : p));
  return parts.join('.');
}

/** "Invalid arguments: a.b: msg; c: msg" for a thrown zod / Standard Schema error. */
function formatIssues(issues: SchemaIssue[]): string {
  return `Invalid arguments: ${issues
    .map((i) => {
      const p = issuePath(i);
      return p ? `${p}: ${i.message}` : i.message;
    })
    .join('; ')}`;
}

const MAX_ERROR_MESSAGE = 2000;

/** The default `mapError`: the error message only (secret parameters redacted, bounded), never a stack. */
export function defaultMapError(err: unknown): MappedToolError {
  let message: string;
  if (err instanceof Error) message = err.message || err.name;
  else if (typeof err === 'string') message = err;
  else message = 'Internal error';
  message = maskClientText(message).replace(/[\r\n]+/g, ' ');
  if (message.length > MAX_ERROR_MESSAGE) message = `${message.slice(0, MAX_ERROR_MESSAGE)}...`;
  return { message: message || 'Internal error' };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isPlainObject(value) && Array.isArray(value.content);
}

function isLegacyEnvelope(value: unknown): value is LegacyEnvelope {
  return isPlainObject(value) && typeof value.success === 'boolean';
}

/**
 * Map a handler's return value onto a CallToolResult. An SDK input-required result
 * (`resultType: 'input_required'`) is returned untouched: the SDK owns it (it skips output validation
 * for it and drives the multi-round-trip flow, or the 2025 legacy shim).
 */
export function normalizeOutcome(outcome: unknown, hasOutputSchema = false): CallToolResult | InputRequiredResult {
  if (isInputRequiredResult(outcome)) return outcome;
  if (isCallToolResult(outcome)) return outcome;
  if (isLegacyEnvelope(outcome)) {
    const text = JSON.stringify(outcome, null, 2);
    if (!outcome.success) return { content: [{ type: 'text', text }], isError: true };
    const result: CallToolResult = { content: [{ type: 'text', text }] };
    if (hasOutputSchema && isPlainObject(outcome.data)) result.structuredContent = outcome.data;
    return result;
  }
  return toolResult(outcome);
}

/** The uniform degraded-mode message. */
export function notConfiguredMessage(serverName: string, missing: readonly string[]): string {
  return `${serverName} is not configured: set ${missing.join(', ')}`;
}

/**
 * The client's declared capabilities for this request, read the way the SDK's own input-required gate
 * reads them: the request's `_meta` envelope on 2026-07-28 requests, the `initialize`-scoped value on a
 * 2025-era connection (`getClientCapabilities()`, deprecated in favour of the envelope but functional).
 */
function clientCapabilitiesOf(server: McpServer, sdk: ServerContext | undefined): ClientCapabilities | undefined {
  if (!sdk) return undefined;
  const envelope = sdk.mcpReq.envelope as Record<string, unknown> | undefined;
  const fromEnvelope = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  return fromEnvelope ?? server.server.getClientCapabilities();
}

function contextFor(server: McpServer, tool: string, args: unknown, sdk: ServerContext | undefined): ToolContext {
  const cursor = isPlainObject(args) && typeof args.cursor === 'string' && args.cursor !== '' ? args.cursor : undefined;
  const progressToken = sdk?.mcpReq._meta?.progressToken;
  const clientCapabilities = clientCapabilitiesOf(server, sdk);
  const signal = sdk?.mcpReq.signal ?? new AbortController().signal;
  const codec = requestStateCodecOf(server);
  return {
    requestState: <T>() => (codec && sdk ? sdk.mcpReq.requestState<T>() : undefined),
    continueWith: async (state, inputRequests) => {
      if (!codec) {
        throw new RequestStateKeyError(
          'requestState is not configured on this server: set MCP_REQUEST_STATE_KEY and pass requestStateCodec to createMcpServer',
        );
      }
      if (!sdk) throw new Error('continueWith needs the SDK request context');
      const requestState = await codec.mint(state, sdk);
      return inputRequired({ ...(inputRequests !== undefined ? { inputRequests } : {}), requestState });
    },
    tool,
    signal,
    authInfo: sdk?.http?.authInfo,
    cursor,
    ...(sdk ? { era: requestEra(sdk) } : {}),
    ...(clientCapabilities !== undefined ? { clientCapabilities } : {}),
    logger: getLogger(),
    sdk,
    ...createClientInput(sdk, clientCapabilities),
    progress: async (progress, total, message) => {
      if (!sdk || progressToken === undefined || signal.aborted) return;
      try {
        await sdk.mcpReq.notify({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress,
            ...(total !== undefined ? { total } : {}),
            ...(message !== undefined ? { message } : {}),
          },
        });
      } catch {
        // A lost progress notification never fails the tool.
      }
    },
  };
}

/** The SDK rethrows exactly this protocol error from its tools/call handler; so must the wrapper. */
function isRethrownProtocolError(err: unknown): boolean {
  return ProtocolError.isInstance(err) && err.code === ProtocolErrorCode.UrlElicitationRequired;
}

/**
 * Register `tools` on `server` with `McpServer.registerTool`. Returns the SDK handles by registered
 * name (for `disable()` / `enable()` / `remove()`).
 */
export function registerTools(
  server: McpServer,
  tools: readonly AnyToolDefinition[],
  opts: RegisterToolsOptions = {},
): Map<string, RegisteredTool> {
  const handles = new Map<string, RegisteredTool>();
  const enabled = opts.enabled ? new Set(opts.enabled) : undefined;
  const mapError = opts.mapError ?? defaultMapError;
  const serverName = opts.serverName ?? 'this server';
  const prefix = opts.prefix ?? '';
  const serverLimits = opts.limits ?? {};

  for (const tool of tools) {
    if (enabled && !enabled.has(tool.name)) continue;
    const name = `${prefix}${tool.name}`;
    const requires = tool.requires ?? [];
    if (requires.length > 0 && !opts.env) {
      throw new Error(`registerTools: tool ${name} declares requires but no env was passed`);
    }
    const declared = new Set(opts.env?.schema.map((s) => s.key));
    const undeclared = requires.filter((k) => !declared.has(k));
    if (undeclared.length > 0) {
      throw new Error(
        `registerTools: tool ${name} requires ${undeclared.join(', ')}, which the env schema does not declare`,
      );
    }

    if (tool.paginated && !declaresPageArgs(tool.inputSchema)) {
      throw new Error(`registerTools: paginated tool ${name} must declare cursor and limit in its input schema`);
    }
    const limits = resolveLimits({
      ...(serverLimits.maxItems !== undefined ? { maxResultItems: serverLimits.maxItems } : {}),
      ...(serverLimits.maxBytes !== undefined ? { maxResultBytes: serverLimits.maxBytes } : {}),
      ...(tool.limits?.maxItems !== undefined ? { maxResultItems: tool.limits.maxItems } : {}),
      ...(tool.limits?.maxBytes !== undefined ? { maxResultBytes: tool.limits.maxBytes } : {}),
    });

    const execute = async (args: unknown, sdk?: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
      const started = Date.now();
      logToolCall(name, args);
      let result: CallToolResult | InputRequiredResult;
      let decoded: ToolCursor | undefined;
      try {
        const missing = requires.filter((k) => !opts.env?.has(k));
        const cursor = isPlainObject(args) && typeof args.cursor === 'string' ? args.cursor : undefined;
        if (cursor !== undefined) decoded = decodeToolCursor(name, args, cursor, tool.paginated === true);
        if (missing.length > 0) {
          result = toolError(notConfiguredMessage(serverName, missing));
        } else {
          const callArgs = handlerArgs(args, decoded, limits.maxResultItems);
          const outcome = await tool.handler(callArgs as never, contextFor(server, name, callArgs, sdk));
          result = normalizeOutcome(outcome, tool.outputSchema !== undefined);
          if (!isInputRequiredResult(result)) result = maskErrorResult(result);
        }
      } catch (err) {
        if (err instanceof InvalidCursorError) {
          result = invalidCursorResult(err);
          logToolResult(name, { isError: true, durationMs: Date.now() - started });
          return result;
        }
        if (isRethrownProtocolError(err)) {
          logToolResult(name, { isError: true, durationMs: Date.now() - started });
          throw err;
        }
        const issues = schemaIssues(err);
        if (issues) {
          result = toolError(formatIssues(issues));
        } else {
          let mapped: MappedToolError;
          try {
            mapped = mapError(err);
          } catch {
            mapped = { message: 'Internal error' };
          }
          result = toolError(mapped.code ? `${mapped.code}: ${mapped.message}` : mapped.message);
        }
      }
      if (!isInputRequiredResult(result)) {
        result = enforceResultLimits(
          {
            tool: name,
            args,
            decoded,
            maxItems: limits.maxResultItems,
            maxBytes: limits.maxResultBytes,
            ...(opts.onOversize ? { onOversize: opts.onOversize } : {}),
            ...(sdk?.http?.authInfo ? { authInfo: sdk.http.authInfo } : {}),
          },
          result,
        );
      }
      logToolResult(name, {
        isError: !isInputRequiredResult(result) && result.isError === true,
        durationMs: Date.now() - started,
      });
      return result;
    };
    // The request scope lets the protocol log forwarder find this request's SDK context.
    const run = (args: unknown, sdk?: ServerContext): Promise<CallToolResult | InputRequiredResult> =>
      sdk ? runWithRequestContext(sdk, () => execute(args, sdk)) : execute(args, sdk);

    const config = {
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      annotations: tool.annotations,
      ...(tool.icons !== undefined ? { icons: tool.icons } : {}),
      ...(tool.scopeChallenge !== undefined ? { scopeChallenge: tool.scopeChallenge } : {}),
      ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
    };
    const handle = server.registerTool(name, config, (args: unknown, ctx: ServerContext) => run(args, ctx));
    if (opts.surface) bindToSurface(server, opts.surface, 'tool', name, handle);
    handles.set(name, handle);
  }
  return handles;
}
