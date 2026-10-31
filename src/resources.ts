/**
 * @novorb/mcp-core - Resources (static resources and URI templates), resource links, subscriptions
 *
 * `registerResources` mirrors `registerTools`: definitions go onto the SDK's own
 * `McpServer.registerResource` (so `resources/list`, `resources/templates/list`, `resources/read`,
 * template matching, completion of template variables and the `ResourceNotFoundError` are the SDK's),
 * and mcp-core adds only what the SDK lacks:
 *
 * - one wrapper per resource: `Resource read: <uri or uri template>` / `Resource result: ...` log
 *   lines (name, template, duration, size; never the content and never the filled-in URI);
 * - thrown errors become JSON-RPC errors through `mapError` (masked, never a stack);
 * - degraded mode: a resource whose `requires` env keys are missing is still listed and answers the
 *   uniform `<server> is not configured: set <KEYS>`;
 * - a size cap on every read (default `MCP_MAX_RESULT_BYTES`, per resource `maxBytes`): an oversized
 *   read is an actionable error, never a truncated document;
 * - shorthand results (a string is text, bytes are a blob, both with the definition's `mimeType`);
 * - `resources/subscribe` / `resources/unsubscribe` for 2025-era clients (`subscribe: true`); updates
 *   are published with `notify.resourceUpdated(uri)` (see `notifications.ts`);
 * - the list pagination of `resources/list` and `resources/templates/list` (C1, `createMcpServer`).
 *
 *   registerResources(server, [
 *     defineResource({ name: 'readme', uri: 'repo://readme', mimeType: 'text/markdown',
 *       read: async () => readme }),
 *     defineResourceTemplate({ name: 'file', uriTemplate: 'repo://files/{path}', mimeType: 'text/plain',
 *       complete: { path: (prefix) => paths.filter((p) => p.startsWith(prefix)) },
 *       read: async ({ variables }) => readFile(String(variables.path)) }),
 *   ], { env, serverName: 'repo-mcp', subscribe: true });
 *
 * Tools point at resources instead of inlining large payloads with `resourceLink(...)` /
 * `embeddedResource(...)`, and `createResultSpill()` connects the tool result byte cap (`onOversize`)
 * to a resource link automatically.
 */

import { randomUUID } from 'node:crypto';
import {
  type AuthInfo,
  type CacheHint,
  type CallToolResult,
  type CompleteResourceTemplateCallback,
  type EmbeddedResource,
  type Icon,
  type InputRequiredResult,
  isInputRequiredResult,
  type ListResourcesResult,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  type RegisteredResource,
  type RegisteredResourceTemplate,
  type Resource,
  type ResourceLink,
  ResourceTemplate,
  type ScopeChallengeHandler,
  type ServerContext,
  type Variables,
} from '@modelcontextprotocol/server';
import { type RequestEra, requestEra } from './client-input.js';
import { resolveLimits } from './limits.js';
import { bindToSurface, type RuntimeSurface, resourceSubscriptions } from './notifications.js';
import { type MapError, toProtocolError } from './protocol-errors.js';
import { runWithRequestContext } from './protocol-logging.js';
import type { OversizeInfo } from './result-limits.js';
import type { McpServer } from './server.js';
import { notConfiguredMessage } from './tools.js';
import type { RequestContext } from './transport.js';
import type { LoadedEnv } from './utils/envLoader.js';
import { getLogger, type Logger } from './utils/logger.js';

/** What a resource read handler may return: a result, an input-required result, text, or bytes. */
export type ResourceReadOutcome = ReadResourceResult | InputRequiredResult | string | Uint8Array;

/** Per-read context. */
export interface ResourceContext {
  /** The definition name. */
  name: string;
  /** The URI being read (the filled-in template for a template). */
  uri: URL;
  /** The template variables (empty for a static resource). */
  variables: Variables;
  /** Aborted when the client cancels or disconnects. */
  signal: AbortSignal;
  /** Caller identity when the transport supplies one. */
  authInfo?: AuthInfo;
  /** The protocol era (undefined when invoked directly). */
  era?: RequestEra;
  logger: Logger;
  /** The raw SDK context (undefined when invoked directly). */
  sdk?: ServerContext;
}

interface ResourceBase {
  name: string;
  title?: string;
  description?: string;
  /** Applied to shorthand results and to contents that carry no `mimeType`. */
  mimeType?: string;
  /** Size in bytes, when known (advertised in `resources/list`). */
  size?: number;
  annotations?: Resource['annotations'];
  icons?: Icon[];
  _meta?: Record<string, unknown>;
  /** 2026-07-28 cache hint for this resource's reads. */
  cacheHint?: CacheHint;
  /** SDK scope gate (for example `requireScopes('files:read')`). */
  scopeChallenge?: ScopeChallengeHandler;
  /** Env keys that must be configured; otherwise reads answer the uniform "not configured" error. */
  requires?: readonly string[];
  /** Max serialized bytes of one read (default MCP_MAX_RESULT_BYTES / the `maxBytes` option). */
  maxBytes?: number;
}

/** A resource at a fixed URI. */
export interface ResourceDefinition extends ResourceBase {
  uri: string;
  read: (ctx: ResourceContext) => Promise<ResourceReadOutcome>;
}

/** A family of resources under an RFC 6570 URI template (`repo://files/{path}`). */
export interface ResourceTemplateDefinition extends ResourceBase {
  uriTemplate: string;
  /** Enumerate concrete resources for `resources/list` (omit when the family is not enumerable). */
  list?: (ctx: ServerContext) => Promise<Resource[] | ListResourcesResult>;
  /** Completion per template variable (`completion/complete` with a `ref/resource`). */
  complete?: Record<string, CompleteResourceTemplateCallback>;
  read: (ctx: ResourceContext) => Promise<ResourceReadOutcome>;
}

export type AnyResourceDefinition = ResourceDefinition | ResourceTemplateDefinition;

/** Identity helper for a static resource definition. */
export function defineResource(definition: ResourceDefinition): ResourceDefinition {
  return definition;
}

/** Identity helper for a resource template definition. */
export function defineResourceTemplate(definition: ResourceTemplateDefinition): ResourceTemplateDefinition {
  return definition;
}

export interface RegisterResourcesOptions {
  /** The loaded env; required for `requires`. */
  env?: LoadedEnv;
  /** Register only these resource names. */
  enabled?: readonly string[];
  /** Server name in the degraded-mode message (default "this server"). */
  serverName?: string;
  /** Per-service wording for thrown errors (the `registerTools` signature). */
  mapError?: MapError;
  /** Server-wide read cap in bytes (default MCP_MAX_RESULT_BYTES); a definition's `maxBytes` wins. */
  maxBytes?: number;
  /**
   * Advertise `resources.subscribe` and serve `resources/subscribe` / `resources/unsubscribe` (2025-era
   * clients; 2026-07-28 clients subscribe through `subscriptions/listen`). Not advertised on a 2025-era
   * stateless HTTP instance (pass `request`), where no update could ever be delivered.
   */
  subscribe?: boolean;
  /** The factory's request context (lets `subscribe` skip 2025-era stateless HTTP). */
  request?: RequestContext;
  /** Runtime enable/disable state (see `createRuntimeSurface`). */
  surface?: RuntimeSurface;
}

function isTemplate(def: AnyResourceDefinition): def is ResourceTemplateDefinition {
  return 'uriTemplate' in def;
}

function contentBytes(result: ReadResourceResult): number {
  let bytes = 0;
  for (const c of result.contents) {
    if ('text' in c && typeof c.text === 'string') bytes += Buffer.byteLength(c.text, 'utf8');
    if ('blob' in c && typeof c.blob === 'string') bytes += c.blob.length;
  }
  return bytes;
}

/** A text resource contents entry. */
export function textContents(uri: string, text: string, mimeType?: string): ReadResourceResult['contents'][number] {
  return { uri, text, ...(mimeType !== undefined ? { mimeType } : {}) };
}

/** A binary resource contents entry (base64). */
export function blobContents(uri: string, data: Uint8Array, mimeType?: string): ReadResourceResult['contents'][number] {
  return { uri, blob: Buffer.from(data).toString('base64'), ...(mimeType !== undefined ? { mimeType } : {}) };
}

/** Map a read outcome onto a `ReadResourceResult` (shorthands, default mimeType). */
export function normalizeReadOutcome(
  outcome: ResourceReadOutcome,
  uri: string,
  mimeType?: string,
): ReadResourceResult | InputRequiredResult {
  if (typeof outcome === 'string') return { contents: [textContents(uri, outcome, mimeType)] };
  if (outcome instanceof Uint8Array) return { contents: [blobContents(uri, outcome, mimeType)] };
  if (isInputRequiredResult(outcome)) return outcome;
  if (mimeType === undefined) return outcome;
  return { ...outcome, contents: outcome.contents.map((c) => (c.mimeType === undefined ? { ...c, mimeType } : c)) };
}

/** A `resource_link` content block for a tool result (the client reads it with `resources/read`). */
export function resourceLink(resource: {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}): ResourceLink {
  return { type: 'resource_link', ...resource };
}

/** An embedded `resource` content block (the contents inline in the tool result). */
export function embeddedResource(contents: ReadResourceResult['contents'][number]): EmbeddedResource {
  return { type: 'resource', resource: contents };
}

/** Register `defs` on `server`; returns the SDK handles by name (`enable` / `disable` / `update` / `remove`). */
export function registerResources(
  server: McpServer,
  defs: readonly AnyResourceDefinition[],
  opts: RegisterResourcesOptions = {},
): Map<string, RegisteredResource | RegisteredResourceTemplate> {
  const handles = new Map<string, RegisteredResource | RegisteredResourceTemplate>();
  const enabled = opts.enabled ? new Set(opts.enabled) : undefined;
  const serverName = opts.serverName ?? 'this server';
  const declared = new Set(opts.env?.schema.map((s) => s.key));

  for (const def of defs) {
    if (enabled && !enabled.has(def.name)) continue;
    const requires = def.requires ?? [];
    if (requires.length > 0 && !opts.env) {
      throw new Error(`registerResources: resource ${def.name} declares requires but no env was passed`);
    }
    const undeclared = requires.filter((k) => !declared.has(k));
    if (undeclared.length > 0) {
      throw new Error(
        `registerResources: resource ${def.name} requires ${undeclared.join(', ')}, which the env schema does not declare`,
      );
    }
    const label = isTemplate(def) ? def.uriTemplate : def.uri;
    const maxBytes = def.maxBytes ?? opts.maxBytes ?? resolveLimits().maxResultBytes;

    const read = async (uri: URL, variables: Variables, sdk: ServerContext): Promise<ReadResourceResult> => {
      const log = getLogger();
      const started = Date.now();
      log.info(`Resource read: ${label}`, 'Resources', { resource: def.name });
      let isError = true;
      let bytes = 0;
      try {
        const missing = requires.filter((k) => !opts.env?.has(k));
        if (missing.length > 0) {
          throw new ProtocolError(ProtocolErrorCode.InternalError, notConfiguredMessage(serverName, missing));
        }
        const ctx: ResourceContext = {
          name: def.name,
          uri,
          variables,
          signal: sdk.mcpReq.signal,
          era: requestEra(sdk),
          logger: log,
          sdk,
          ...(sdk.http?.authInfo ? { authInfo: sdk.http.authInfo } : {}),
        };
        const result = normalizeReadOutcome(await def.read(ctx), uri.href, def.mimeType);
        if (isInputRequiredResult(result)) {
          isError = false;
          return result as unknown as ReadResourceResult;
        }
        bytes = contentBytes(result);
        if (bytes > maxBytes) {
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `${def.name}: the resource is ${bytes} bytes, over the ${maxBytes} byte limit per response; read a narrower resource (a smaller range or a sub-path)`,
          );
        }
        isError = false;
        return result;
      } catch (err) {
        throw toProtocolError(err, opts.mapError);
      } finally {
        const meta = { resource: def.name, isError, durationMs: Math.round(Date.now() - started), bytes };
        if (isError) log.warn(`Resource result: ${label}`, 'Resources', meta);
        else log.info(`Resource result: ${label}`, 'Resources', meta);
      }
    };
    const scoped = (uri: URL, variables: Variables, sdk: ServerContext): Promise<ReadResourceResult> =>
      runWithRequestContext(sdk, () => read(uri, variables, sdk));

    const metadata = {
      ...(def.title !== undefined ? { title: def.title } : {}),
      ...(def.description !== undefined ? { description: def.description } : {}),
      ...(def.mimeType !== undefined ? { mimeType: def.mimeType } : {}),
      ...(def.size !== undefined ? { size: def.size } : {}),
      ...(def.annotations !== undefined ? { annotations: def.annotations } : {}),
      ...(def.icons !== undefined ? { icons: def.icons } : {}),
      ...(def._meta !== undefined ? { _meta: def._meta } : {}),
      ...(def.cacheHint !== undefined ? { cacheHint: def.cacheHint } : {}),
      ...(def.scopeChallenge !== undefined ? { scopeChallenge: def.scopeChallenge } : {}),
    };

    let handle: RegisteredResource | RegisteredResourceTemplate;
    if (isTemplate(def)) {
      const list = def.list;
      const template = new ResourceTemplate(def.uriTemplate, {
        list: list
          ? async (ctx: ServerContext): Promise<ListResourcesResult> => {
              const listed = await list(ctx);
              return Array.isArray(listed) ? { resources: listed } : listed;
            }
          : undefined,
        ...(def.complete !== undefined ? { complete: def.complete } : {}),
      });
      handle = server.registerResource(def.name, template, metadata, (uri, variables, sdk) =>
        scoped(uri, variables, sdk),
      );
    } else {
      handle = server.registerResource(def.name, def.uri, metadata, (uri, sdk) => scoped(uri, {}, sdk));
    }
    if (opts.surface) bindToSurface(server, opts.surface, 'resource', def.name, handle);
    handles.set(def.name, handle);
  }

  const legacyStatelessHttp = opts.request?.era === 'legacy' && opts.request.requestInfo !== undefined;
  if (opts.subscribe && !legacyStatelessHttp) enableResourceSubscriptions(server);
  return handles;
}

const SUBSCRIBE_INSTALLED = Symbol.for('@novorb/mcp-core/resourceSubscribe');

/**
 * Advertise `resources.subscribe` and serve the 2025-era `resources/subscribe` / `resources/unsubscribe`
 * on this instance (the subscribed URIs filter `notify.resourceUpdated` on a 2025-era connection).
 * Call before the instance is connected. Idempotent.
 */
export function enableResourceSubscriptions(server: McpServer): void {
  const low = server.server as McpServer['server'] & { [SUBSCRIBE_INSTALLED]?: boolean };
  if (low[SUBSCRIBE_INSTALLED]) return;
  low[SUBSCRIBE_INSTALLED] = true;
  const listChanged = low.getCapabilities().resources?.listChanged;
  low.registerCapabilities({ resources: { subscribe: true, ...(listChanged !== undefined ? { listChanged } : {}) } });
  const subscriptions = resourceSubscriptions(server);
  low.setRequestHandler('resources/subscribe', (request) => {
    subscriptions.add(request.params.uri);
    return {};
  });
  low.setRequestHandler('resources/unsubscribe', (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });
}

export interface ResultSpillOptions {
  /** URI prefix of spilled results (default `mcp-core://results/`); the template is `<prefix>{id}`. */
  uriPrefix?: string;
  /** How long a spilled result stays readable (default 15 minutes). */
  ttlMs?: number;
  /** Max spilled results kept (default 100; the oldest is dropped first). */
  maxEntries?: number;
  /** Max bytes of one spilled result (default 16 MiB); a larger one keeps the default isError. */
  maxBytes?: number;
  /** Max bytes of all spilled results together (default 64 MiB; the oldest is dropped first). */
  maxTotalBytes?: number;
  /** Resource name (default `tool-result`). */
  name?: string;
  /** Clock (tests). */
  now?: () => number;
}

export interface ResultSpill {
  /** Pass as `registerTools(..., { onOversize: spill.onOversize })`. */
  onOversize: (info: OversizeInfo) => CallToolResult | undefined;
  /** Register this template so clients can read the spilled results (`registerResources`). */
  resource: ResourceTemplateDefinition;
  /** Drop every spilled result. */
  clear(): void;
}

interface SpillEntry {
  json: string;
  bytes: number;
  owner: string | undefined;
  expiresAt: number;
  tool: string;
}

/**
 * Connect the tool result byte cap to resource links: an oversized result is kept in memory and the
 * tool answers a short text plus a `resource_link` the client reads with `resources/read` (bounded by
 * `maxBytes`, bound to the caller's `clientId`, expiring after `ttlMs`). In-memory, so on a
 * multi-instance HTTP deployment the read must reach the same process (sticky routing) or the client
 * gets "not found"; use a shared store in the host for that case.
 */
export function createResultSpill(options: ResultSpillOptions = {}): ResultSpill {
  const prefix = options.uriPrefix ?? 'mcp-core://results/';
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  const maxEntries = options.maxEntries ?? 100;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
  const name = options.name ?? 'tool-result';
  const now = options.now ?? Date.now;
  const entries = new Map<string, SpillEntry>();
  let totalBytes = 0;

  const drop = (id: string): void => {
    const e = entries.get(id);
    if (!e) return;
    totalBytes -= e.bytes;
    entries.delete(id);
  };
  const prune = (): void => {
    const t = now();
    for (const [id, e] of entries) if (e.expiresAt <= t) drop(id);
    while (entries.size > maxEntries || totalBytes > maxTotalBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
  };

  return {
    onOversize(info) {
      const payload = info.result.structuredContent ?? info.result.content;
      const json = JSON.stringify(payload);
      const bytes = Buffer.byteLength(json, 'utf8');
      if (bytes > maxBytes || bytes > maxTotalBytes) return undefined;
      const id = randomUUID();
      entries.set(id, { json, bytes, owner: info.authInfo?.clientId, expiresAt: now() + ttlMs, tool: info.tool });
      totalBytes += bytes;
      prune();
      const uri = `${prefix}${id}`;
      return {
        content: [
          {
            type: 'text',
            text: `${info.tool}: the result is ${info.bytes} bytes, over the ${info.maxBytes} byte limit per response; it is available as the resource ${uri} for ${Math.round(ttlMs / 60_000)} minutes`,
          },
          resourceLink({
            uri,
            name,
            mimeType: 'application/json',
            size: bytes,
            description: `Full result of ${info.tool}`,
          }),
        ],
      };
    },
    resource: {
      name,
      uriTemplate: `${prefix}{id}`,
      description: 'Tool results too large to return inline',
      mimeType: 'application/json',
      maxBytes,
      read: async ({ variables, authInfo, uri }) => {
        prune();
        const id = String(variables.id);
        const entry = entries.get(id);
        // A foreign caller's entry answers exactly like a missing one (no existence leak).
        if (!entry || (entry.owner !== undefined && entry.owner !== authInfo?.clientId)) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri.href} not found or expired`);
        }
        return entry.json;
      },
    },
    clear: () => {
      entries.clear();
      totalBytes = 0;
    },
  };
}
