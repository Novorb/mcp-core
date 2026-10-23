/**
 * @novorb/mcp-core - Task tools (long-running tools on MCP Tasks, both protocol eras)
 *
 * A task tool answers a task handle instead of blocking: the client polls (or, on 2025-11-25, waits
 * on `tasks/result`) and can cancel. The work runs in this process behind a `ManagedTaskStore`; the
 * SDK 2.3.1 ships the wire types only, so mcp-core serves the methods itself, per era, with the
 * shapes of the spec and of SDK PR #2782:
 *
 * | | 2025-11-25 (legacy) | 2026-07-28 (modern, `io.modelcontextprotocol/tasks` extension) |
 * |---|---|---|
 * | capability | `tasks: { list, cancel, requests: { tools: { call } } }` | `extensions: { 'io.modelcontextprotocol/tasks': {} }` |
 * | start | `tools/call` with `params.task: { ttl? }` -> `{ task, content }` | `tools/call` from a client declaring the extension -> `{ resultType: 'task', ...task }` |
 * | poll | `tasks/get` -> Task (`ttl`, `pollInterval`) | `tasks/get` -> DetailedTask (result / error / inputRequests inlined) |
 * | result | `tasks/result` (blocks until terminal) | inlined in `tasks/get` |
 * | list | `tasks/list` | none (not in the extension) |
 * | cancel | `tasks/cancel` -> Task (terminal = -32602) | `tasks/cancel` -> ack (idempotent) |
 * | input | not supported (no `tasks/result` side channel) | `tasks/update` answers `input_required` |
 * | status | `notifications/tasks/status` (stdio: the connection is long-lived) | polling only (the extension has no notifications yet) |
 *
 * A client without task support (no `params.task`, no declared extension) gets the tool run
 * synchronously: the same `run` with progress notifications, unless `taskSupport: 'required'`.
 * Tasks are bound to the creating caller's `clientId`.
 *
 *   registerTaskTools(server, [
 *     defineTaskTool({
 *       name: 'run_backtest', description: 'Run a backtest', inputSchema: z.object({ strategy: z.string() }),
 *       annotations: TOOL_ANNOTATIONS.mutableWriteOpenWorld,
 *       run: async ({ strategy }, task) => {
 *         for (let i = 1; i <= 10; i++) { task.signal.throwIfAborted(); await step(); await task.progress(i, 10); }
 *         return toolResult({ strategy, trades: 42 });
 *       },
 *     }),
 *   ], { store, request: req, env });
 */

import {
  type AuthInfo,
  type CallToolResult,
  CLIENT_CAPABILITIES_META_KEY,
  type InputRequests,
  type InputResponses,
  isInputRequiredResult,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  RELATED_TASK_META_KEY,
  type ServerContext,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { requestEra } from './client-input.js';
import { resolveLimits } from './limits.js';
import { InvalidCursorError } from './pagination.js';
import type { McpServer } from './server.js';
import { currentTaskAugmentation } from './task-request.js';
import {
  type DetailedTask,
  isTerminalStatus,
  type ManagedTaskStore,
  TASKS_EXTENSION_ID,
  type Task,
  type TaskAccess,
  type TaskHandle,
} from './task-store.js';
import {
  type AnyToolDefinition,
  defaultMapError,
  defineTool,
  type MappedToolError,
  maskClientText,
  normalizeOutcome,
  type RegisterToolsOptions,
  registerTools,
  type ToolArgs,
  type ToolContext,
  type ToolDefinition,
  type ToolOutcome,
  toolError,
} from './tools.js';
import type { RequestContext } from './transport.js';
import { getLogger, type Logger } from './utils/logger.js';

/** What a task tool's `run` receives (both modes). */
export interface TaskContext {
  /** `task`: running behind a task handle; `sync`: the client has no task support. */
  mode: 'task' | 'sync';
  /** The task id (task mode only). */
  taskId?: string;
  /** Aborted on `tasks/cancel` (task mode) or the request's cancellation (sync mode). */
  signal: AbortSignal;
  authInfo?: AuthInfo;
  logger: Logger;
  /** Report progress: the task's `statusMessage` (task mode) or a progress notification (sync mode). */
  progress(current: number, total?: number, message?: string): Promise<void>;
  /** Set the task's `statusMessage` (task mode; a progress message in sync mode). */
  status(message: string): Promise<void>;
  /**
   * Ask the client for input mid-task (2026-07-28 `input_required` + `tasks/update`). Rejects in sync
   * mode and on 2025-era tasks (use `ToolContext.elicit` in a plain tool there).
   */
  requireInput(requests: InputRequests): Promise<InputResponses>;
}

export interface TaskToolDefinition<I extends StandardSchemaWithJSON = StandardSchemaWithJSON>
  extends Omit<ToolDefinition<I>, 'handler' | 'outputSchema' | 'paginated'> {
  /** `optional` (default): sync for clients without task support; `required`: refuse them. */
  taskSupport?: 'optional' | 'required';
  /** Retention of a task from creation, ms (default 1 hour; a 2025 client's `ttl` may lower it). */
  ttlMs?: number;
  /** Suggested polling interval, ms (default 1000). */
  pollIntervalMs?: number;
  run: (args: ToolArgs<I>, task: TaskContext) => Promise<ToolOutcome>;
}

export type AnyTaskToolDefinition = Omit<TaskToolDefinition, 'run'> & {
  run: (args: never, task: TaskContext) => Promise<ToolOutcome>;
};

/** Identity helper that types `run` from the tool's own input schema. */
export function defineTaskTool<I extends StandardSchemaWithJSON>(
  definition: TaskToolDefinition<I>,
): AnyTaskToolDefinition {
  return definition as unknown as AnyTaskToolDefinition;
}

const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_POLL_MS = 1000;

/** The 2025-11-25 wire shape of a task (`ttl`, `pollInterval`). */
export interface LegacyTask {
  taskId: string;
  status: Task['status'];
  ttl: number | null;
  createdAt: string;
  lastUpdatedAt: string;
  pollInterval?: number;
  statusMessage?: string;
}

/** Map a task onto the 2025-11-25 wire shape. */
export function toLegacyTask(task: Task): LegacyTask {
  return {
    taskId: task.taskId,
    status: task.status,
    ttl: task.ttlMs,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ...(task.pollIntervalMs !== undefined ? { pollInterval: task.pollIntervalMs } : {}),
    ...(task.statusMessage !== undefined ? { statusMessage: task.statusMessage } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a 2026-07-28 request declared the tasks extension in its envelope capabilities. */
export function declaresTasksExtension(sdk: ServerContext): boolean {
  const envelope = sdk.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  return isRecord(caps) && isRecord(caps.extensions) && TASKS_EXTENSION_ID in caps.extensions;
}

function requireExtension(sdk: ServerContext, what: string): void {
  if (declaresTasksExtension(sdk)) return;
  throw new MissingRequiredClientCapabilityError(
    { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
    `${what} requires the request to declare the "${TASKS_EXTENSION_ID}" extension capability`,
  );
}

function accessOf(sdk: ServerContext): TaskAccess {
  const principal = sdk.http?.authInfo?.clientId;
  return principal !== undefined ? { principal } : {};
}

const notFound = (): ProtocolError => new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not found');

/** A minimal Standard Schema over a hand-written check (src/ never loads zod). */
function paramsSchema<T>(parse: (value: Record<string, unknown>) => T): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'mcp-core',
      validate: (value: unknown) => {
        if (!isRecord(value)) return { issues: [{ message: 'params must be an object' }] };
        try {
          return { value: parse(value) };
        } catch (e) {
          return { issues: [{ message: e instanceof Error ? e.message : 'invalid params' }] };
        }
      },
    },
  };
}

const taskIdParams = paramsSchema((p) => {
  if (typeof p.taskId !== 'string' || p.taskId === '') throw new Error('taskId must be a non-empty string');
  return {
    taskId: p.taskId,
    inputResponses: isRecord(p.inputResponses) ? (p.inputResponses as InputResponses) : undefined,
  };
});
const listParams = paramsSchema((p) => {
  if (p.cursor !== undefined && typeof p.cursor !== 'string') throw new Error('cursor must be a string');
  return { cursor: p.cursor as string | undefined };
});

async function waitForTerminal(
  store: ManagedTaskStore,
  taskId: string,
  access: TaskAccess,
  signal: AbortSignal,
  pollMs: number,
): Promise<DetailedTask> {
  for (;;) {
    const task = await store.get(taskId, access);
    if (!task) throw notFound();
    if (isTerminalStatus(task.status)) return task;
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        unwatch();
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        done();
        reject(signal.reason);
      };
      // Woken by this process's writes; the timer covers writes from other processes (file store).
      const unwatch = store.watch(taskId, () => {
        done();
        resolve();
      });
      const timer = setTimeout(() => {
        done();
        resolve();
      }, pollMs);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export interface EnableTasksOptions {
  /** The request era this instance serves (the factory's `req.era`). */
  era: 'legacy' | 'modern';
  /** How often a blocking 2025 `tasks/result` re-reads the store (ms, default 1000). */
  resultPollMs?: number;
}

const TASKS_INSTALLED = Symbol.for('@novorb/mcp-core/tasks');

/**
 * Serve the task methods for this instance's era and advertise the matching capability (call before
 * the instance is connected; `registerTaskTools` does it). Idempotent.
 */
export function enableTasks(server: McpServer, store: ManagedTaskStore, options: EnableTasksOptions): void {
  const low = server.server as McpServer['server'] & { [TASKS_INSTALLED]?: boolean };
  if (low[TASKS_INSTALLED]) return;
  low[TASKS_INSTALLED] = true;
  const pollMs = options.resultPollMs ?? DEFAULT_POLL_MS;

  if (options.era === 'modern') {
    low.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } });
    low.setRequestHandler('tasks/get', { params: taskIdParams }, async (params, sdk) => {
      requireExtension(sdk, 'tasks/get');
      const task = await store.get(params.taskId, accessOf(sdk));
      if (!task) throw notFound();
      // The inlined result is a 2026-07-28 CallToolResult: it carries its own resultType (SEP-2663).
      if (task.status === 'completed') return { ...task, result: { resultType: 'complete', ...task.result } };
      return { ...task };
    });
    low.setRequestHandler('tasks/update', { params: taskIdParams }, async (params, sdk) => {
      requireExtension(sdk, 'tasks/update');
      const responses = (sdk.mcpReq.inputResponses ?? params.inputResponses ?? {}) as InputResponses;
      if (!(await store.update(params.taskId, responses, accessOf(sdk)))) throw notFound();
      return {};
    });
    low.setRequestHandler('tasks/cancel', { params: taskIdParams }, async (params, sdk) => {
      requireExtension(sdk, 'tasks/cancel');
      if (!(await store.cancel(params.taskId, accessOf(sdk)))) throw notFound();
      return {};
    });
    return;
  }

  low.registerCapabilities({ tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } });
  low.setRequestHandler('tasks/get', { params: taskIdParams }, async (params, sdk) => {
    const task = await store.get(params.taskId, accessOf(sdk));
    if (!task) throw notFound();
    return { ...toLegacyTask(task) };
  });
  low.setRequestHandler('tasks/result', { params: taskIdParams }, async (params, sdk) => {
    const task = await waitForTerminal(store, params.taskId, accessOf(sdk), sdk.mcpReq.signal, pollMs);
    const related = { [RELATED_TASK_META_KEY]: { taskId: task.taskId } };
    if (task.status === 'completed') {
      const result = task.result as Record<string, unknown>;
      return { ...result, _meta: { ...(isRecord(result._meta) ? result._meta : {}), ...related } };
    }
    if (task.status === 'failed') {
      const code = typeof task.error.code === 'number' ? task.error.code : ProtocolErrorCode.InternalError;
      const message = typeof task.error.message === 'string' ? task.error.message : 'Task failed';
      throw new ProtocolError(code, message, related);
    }
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Task ${task.taskId} was cancelled`, related);
  });
  low.setRequestHandler('tasks/list', { params: listParams }, async (params, sdk) => {
    try {
      const page = await store.list(accessOf(sdk), params.cursor !== undefined ? { cursor: params.cursor } : {});
      return { tasks: page.tasks.map(toLegacyTask), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    } catch (e) {
      if (e instanceof InvalidCursorError) throw new ProtocolError(ProtocolErrorCode.InvalidParams, e.message);
      throw e;
    }
  });
  low.setRequestHandler('tasks/cancel', { params: taskIdParams }, async (params, sdk) => {
    const access = accessOf(sdk);
    const before = await store.get(params.taskId, access);
    if (!before) throw notFound();
    if (isTerminalStatus(before.status)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Cannot cancel task ${before.taskId}: it is already ${before.status}`,
      );
    }
    await store.cancel(params.taskId, access);
    const after = await store.get(params.taskId, access);
    return { ...toLegacyTask(after ?? before) };
  });
}

export interface RegisterTaskToolsOptions extends Omit<RegisterToolsOptions, 'limits' | 'onOversize'> {
  /** Where tasks live (shared state from `setup`: one store for every request of the process). */
  store: ManagedTaskStore;
  /** The factory's request context (selects the era's methods and capability). */
  request: Pick<RequestContext, 'era'>;
  /** Max serialized bytes of a stored task result (default MCP_MAX_RESULT_BYTES). */
  maxResultBytes?: number;
  /** How often a blocking 2025 `tasks/result` re-reads the store (ms). */
  resultPollMs?: number;
}

function formatProgress(current: number, total?: number, message?: string): string {
  const position = total !== undefined ? `${current}/${total}` : String(current);
  return message ? `${message} (${position})` : position;
}

function byteCapped(tool: string, result: CallToolResult, maxBytes: number): CallToolResult {
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes <= maxBytes) return result;
  return toolError(
    `${tool}: the task result is ${bytes} bytes, over the ${maxBytes} byte limit per response; narrow the request`,
  );
}

function errorText(mapError: (err: unknown) => MappedToolError, err: unknown): string {
  let mapped: MappedToolError;
  try {
    mapped = mapError(err);
  } catch {
    mapped = { message: 'Internal error' };
  }
  return mapped.code ? `${mapped.code}: ${mapped.message}` : mapped.message;
}

/**
 * Register task tools on `server` (through `registerTools`, so logging, masking, degraded mode and
 * the enabled/prefix/surface options are the same) and enable the era's task methods.
 */
export function registerTaskTools(
  server: McpServer,
  defs: readonly AnyTaskToolDefinition[],
  opts: RegisterTaskToolsOptions,
): ReturnType<typeof registerTools> {
  const { store, request, maxResultBytes, resultPollMs, ...toolOptions } = opts;
  enableTasks(server, store, { era: request.era, ...(resultPollMs !== undefined ? { resultPollMs } : {}) });
  const maxBytes = maxResultBytes ?? resolveLimits().maxResultBytes;
  const mapError = opts.mapError ?? defaultMapError;
  const prefix = opts.prefix ?? '';

  const tools: AnyToolDefinition[] = defs.map((def) => {
    const { run, taskSupport, ttlMs, pollIntervalMs, ...rest } = def;
    const name = `${prefix}${def.name}`;
    const definition: ToolDefinition = {
      ...rest,
      handler: async (args: unknown, ctx: ToolContext): Promise<ToolOutcome> => {
        const sdk = ctx.sdk;
        const era = sdk ? requestEra(sdk) : undefined;
        const augmentation = era === 'legacy' ? currentTaskAugmentation() : undefined;
        const asTask =
          sdk !== undefined && (era === 'modern' ? declaresTasksExtension(sdk) : augmentation !== undefined);

        if (!asTask) {
          if (taskSupport === 'required') {
            return toolError(
              `${name} runs only as a task: the client must ${era === 'modern' ? `declare the ${TASKS_EXTENSION_ID} extension` : 'send tools/call with params.task (tasks capability)'}`,
            );
          }
          return run(args as never, {
            mode: 'sync',
            signal: ctx.signal,
            ...(ctx.authInfo ? { authInfo: ctx.authInfo } : {}),
            logger: ctx.logger,
            progress: (current, total, message) => ctx.progress(current, total, message),
            status: (message) => ctx.progress(0, undefined, message),
            requireInput: () => Promise.reject(new Error('requireInput is only available in task mode')),
          });
        }

        const ttl = Math.min(augmentation?.ttl ?? ttlMs ?? DEFAULT_TTL_MS, ttlMs ?? DEFAULT_TTL_MS);
        const principal = sdk.http?.authInfo?.clientId;
        const task = await store.create({
          ttlMs: ttl,
          pollIntervalMs: pollIntervalMs ?? DEFAULT_POLL_MS,
          ...(principal !== undefined ? { principal } : {}),
          context: { tool: name },
        });
        const handle = store.handle(task.taskId);
        if (era === 'legacy') notifyStatus(server, store, task.taskId);
        // Detached: a failing store write while settling the task is logged, never an unhandled rejection.
        execute(name, handle, run, args, era === 'modern', ctx, mapError, maxBytes).catch((err: unknown) => {
          getLogger().error(`Task settle failed: ${name}`, 'Tasks', {
            tool: name,
            taskId: task.taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        if (era === 'modern') return { resultType: 'task', ...task, content: [] } as unknown as CallToolResult;
        return {
          content: [
            { type: 'text', text: `Task ${task.taskId} started (${name}); poll tasks/get or wait on tasks/result` },
          ],
          task: toLegacyTask(task),
          _meta: { [RELATED_TASK_META_KEY]: { taskId: task.taskId } },
        } as CallToolResult;
      },
    };
    return defineTool(definition);
  });
  const handles = registerTools(server, tools, { ...toolOptions, limits: { maxBytes } });
  if (request.era === 'legacy') {
    // 2025-11-25 advertises per tool whether `params.task` is accepted (`Tool.execution.taskSupport`).
    for (const def of defs) {
      const handle = handles.get(`${prefix}${def.name}`);
      if (handle) handle.execution = { taskSupport: def.taskSupport ?? 'optional' };
    }
  }
  return handles;
}

/** 2025-era: push `notifications/tasks/status` on this instance's connection until the task is terminal. */
function notifyStatus(server: McpServer, store: ManagedTaskStore, taskId: string): void {
  const low = server.server;
  const unwatch = store.watch(taskId, (task) => {
    low
      .notification({ method: 'notifications/tasks/status', params: { ...toLegacyTask(task) } })
      .catch(() => undefined);
    if (isTerminalStatus(task.status)) unwatch();
  });
  const previous = low.onclose;
  low.onclose = () => {
    unwatch();
    previous?.();
  };
}

async function execute(
  tool: string,
  handle: TaskHandle,
  run: AnyTaskToolDefinition['run'],
  args: unknown,
  modern: boolean,
  ctx: ToolContext,
  mapError: (err: unknown) => MappedToolError,
  maxBytes: number,
): Promise<void> {
  const log = getLogger();
  const started = Date.now();
  log.info(`Task started: ${tool}`, 'Tasks', { tool, taskId: handle.taskId });
  const task: TaskContext = {
    mode: 'task',
    taskId: handle.taskId,
    signal: handle.signal,
    ...(ctx.authInfo ? { authInfo: ctx.authInfo } : {}),
    logger: log,
    progress: (current, total, message) => handle.status(formatProgress(current, total, message)),
    status: (message) => handle.status(message),
    requireInput: (requests) =>
      modern
        ? handle.requireInput(requests)
        : Promise.reject(new Error('requireInput is not supported on 2025-era tasks')),
  };
  let outcome = 'completed';
  try {
    const raw = await run(args as never, task);
    const result = normalizeOutcome(raw);
    if (isInputRequiredResult(result)) {
      outcome = 'failed';
      await handle.fail({
        code: ProtocolErrorCode.InternalError,
        message: `${tool} returned an input-required result; a task asks for input with task.requireInput`,
      });
      return;
    }
    const masked: CallToolResult =
      result.isError === true
        ? {
            ...result,
            content: result.content.map((b) => (b.type === 'text' ? { ...b, text: maskClientText(b.text) } : b)),
          }
        : result;
    await handle.complete(byteCapped(tool, masked, maxBytes));
  } catch (err) {
    if (handle.signal.aborted) {
      outcome = 'cancelled';
      return;
    }
    // A tool failure is a completed task with an isError result (the MCP tool-error model).
    outcome = 'error';
    await handle.complete(toolError(errorText(mapError, err)));
  } finally {
    if (handle.signal.aborted) outcome = 'cancelled';
    log.info(`Task finished: ${tool}`, 'Tasks', {
      tool,
      taskId: handle.taskId,
      outcome,
      durationMs: Math.round(Date.now() - started),
    });
  }
}
