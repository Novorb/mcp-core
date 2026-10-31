/**
 * @novorb/mcp-core - Prompts
 *
 * `registerPrompts` mirrors `registerTools` for `McpServer.registerPrompt`: the SDK keeps
 * `prompts/list`, argument validation from `argsSchema`, `completion/complete` for `completable`
 * arguments and the unknown-prompt error; mcp-core adds the same wrapper conventions:
 *
 * - `Prompt get: <name>` / `Prompt result: <name>` log lines (argument SHAPE only, never values);
 * - thrown errors become JSON-RPC errors through `mapError`, masked;
 * - degraded mode (`requires`): listed, and answers `<server> is not configured: set <KEYS>`;
 * - a string result is shorthand for one user message;
 * - `enabled` filter, `surface` runtime toggles, and the list pagination of `prompts/list`.
 *
 *   registerPrompts(server, [
 *     definePrompt({
 *       name: 'review-mr',
 *       description: 'Review a merge request',
 *       argsSchema: z.object({ project: completable(z.string(), (v) => projects.filter((p) => p.startsWith(v))) }),
 *       handler: async ({ project }) => `Review the open merge requests of ${project}.`,
 *     }),
 *   ], { env, serverName: 'my-mcp' });
 */

import type {
  AuthInfo,
  GetPromptResult,
  Icon,
  InputRequiredResult,
  RegisteredPrompt,
  ScopeChallengeHandler,
  ServerContext,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { type RequestEra, requestEra } from './client-input.js';
import { bindToSurface, type RuntimeSurface } from './notifications.js';
import { type MapError, toProtocolError } from './protocol-errors.js';
import { runWithRequestContext } from './protocol-logging.js';
import type { McpServer } from './server.js';
import { notConfiguredMessage } from './tools.js';
import type { LoadedEnv } from './utils/envLoader.js';
import { getLogger, type Logger, summarizeArgs } from './utils/logger.js';

/** What a prompt handler may return. A string is one user text message. */
export type PromptOutcome = GetPromptResult | InputRequiredResult | string;

export interface PromptContext {
  prompt: string;
  signal: AbortSignal;
  authInfo?: AuthInfo;
  era?: RequestEra;
  logger: Logger;
  sdk?: ServerContext;
}

export interface PromptDefinition<A extends StandardSchemaWithJSON = StandardSchemaWithJSON> {
  name: string;
  title?: string;
  description?: string;
  /** Arguments (a zod 4 object; `completable(...)` fields get completions). Omit for no arguments. */
  argsSchema?: A;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
  scopeChallenge?: ScopeChallengeHandler;
  requires?: readonly string[];
  handler: (args: StandardSchemaWithJSON.InferOutput<A>, ctx: PromptContext) => Promise<PromptOutcome>;
}

/** A prompt definition in a heterogeneous list (see `AnyToolDefinition`). */
export type AnyPromptDefinition = Omit<PromptDefinition, 'handler'> & {
  handler: (args: never, ctx: PromptContext) => Promise<PromptOutcome>;
};

/** Identity helper that types a prompt handler's arguments from its own schema. */
export function definePrompt<A extends StandardSchemaWithJSON>(definition: PromptDefinition<A>): AnyPromptDefinition {
  return definition as unknown as AnyPromptDefinition;
}

export interface RegisterPromptsOptions {
  env?: LoadedEnv;
  enabled?: readonly string[];
  prefix?: string;
  serverName?: string;
  mapError?: MapError;
  surface?: RuntimeSurface;
}

/** Map a prompt outcome onto a `GetPromptResult` (string shorthand). */
export function normalizePromptOutcome(outcome: PromptOutcome): GetPromptResult | InputRequiredResult {
  if (typeof outcome === 'string') return { messages: [{ role: 'user', content: { type: 'text', text: outcome } }] };
  return outcome;
}

/** Register `defs` on `server`; returns the SDK handles by registered name. */
export function registerPrompts(
  server: McpServer,
  defs: readonly AnyPromptDefinition[],
  opts: RegisterPromptsOptions = {},
): Map<string, RegisteredPrompt> {
  const handles = new Map<string, RegisteredPrompt>();
  const enabled = opts.enabled ? new Set(opts.enabled) : undefined;
  const serverName = opts.serverName ?? 'this server';
  const declared = new Set(opts.env?.schema.map((s) => s.key));

  for (const def of defs) {
    if (enabled && !enabled.has(def.name)) continue;
    const name = `${opts.prefix ?? ''}${def.name}`;
    const requires = def.requires ?? [];
    if (requires.length > 0 && !opts.env) {
      throw new Error(`registerPrompts: prompt ${name} declares requires but no env was passed`);
    }
    const undeclared = requires.filter((k) => !declared.has(k));
    if (undeclared.length > 0) {
      throw new Error(
        `registerPrompts: prompt ${name} requires ${undeclared.join(', ')}, which the env schema does not declare`,
      );
    }

    const get = async (args: unknown, sdk: ServerContext): Promise<GetPromptResult | InputRequiredResult> => {
      const log = getLogger();
      const started = Date.now();
      log.info(`Prompt get: ${name}`, 'Prompts', { prompt: name, args: summarizeArgs(args) });
      let isError = true;
      try {
        const missing = requires.filter((k) => !opts.env?.has(k));
        if (missing.length > 0) {
          throw new ProtocolError(ProtocolErrorCode.InternalError, notConfiguredMessage(serverName, missing));
        }
        const ctx: PromptContext = {
          prompt: name,
          signal: sdk.mcpReq.signal,
          era: requestEra(sdk),
          logger: log,
          sdk,
          ...(sdk.http?.authInfo ? { authInfo: sdk.http.authInfo } : {}),
        };
        const result = normalizePromptOutcome(await def.handler(args as never, ctx));
        isError = false;
        return result;
      } catch (err) {
        throw toProtocolError(err, opts.mapError);
      } finally {
        const meta = { prompt: name, isError, durationMs: Math.round(Date.now() - started) };
        if (isError) log.warn(`Prompt result: ${name}`, 'Prompts', meta);
        else log.info(`Prompt result: ${name}`, 'Prompts', meta);
      }
    };
    const run = (args: unknown, sdk: ServerContext): Promise<GetPromptResult | InputRequiredResult> =>
      runWithRequestContext(sdk, () => get(args, sdk));

    const config = {
      ...(def.title !== undefined ? { title: def.title } : {}),
      ...(def.description !== undefined ? { description: def.description } : {}),
      ...(def.icons !== undefined ? { icons: def.icons } : {}),
      ...(def._meta !== undefined ? { _meta: def._meta } : {}),
      ...(def.scopeChallenge !== undefined ? { scopeChallenge: def.scopeChallenge } : {}),
    };
    const argsSchema = def.argsSchema;
    const handle = argsSchema
      ? server.registerPrompt(name, { ...config, argsSchema }, (args: unknown, sdk: ServerContext) => run(args, sdk))
      : server.registerPrompt(name, config, (sdk: ServerContext) => run(undefined, sdk));
    if (opts.surface) bindToSurface(server, opts.surface, 'prompt', name, handle);
    handles.set(name, handle);
  }
  return handles;
}
