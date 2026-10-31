/**
 * @novorb/mcp-core - Task stores (server side of MCP Tasks)
 *
 * The task wire types and the `TaskStore` contract mirror the open SDK PR
 * modelcontextprotocol/typescript-sdk#2782 (`@modelcontextprotocol/server/ext/tasks`: `TaskStore`,
 * `CreateTaskParams`, `TaskAccess`, `InMemoryTaskStore` with its writer `TaskHandle`) field for field,
 * so a consumer can move to the SDK module when it ships. What mcp-core adds lives on
 * `ManagedTaskStore`, a superset the PR does not define: `list` (the 2025-11-25 `tasks/list`), `watch`
 * (status notifications and the blocking 2025 `tasks/result`), `updateContext` and `close`.
 *
 * - `InMemoryTaskStore`: records in a Map, TTL purge on a timer (the PR's reference store).
 * - `FileTaskStore`: one JSON file per task under the data store (`tasks/<id>.json`, atomic writes), so
 *   tasks survive a restart and several processes on one host share them; cancellation written by
 *   another process reaches the running work through a status poll. `createTaskStore` falls back to
 *   memory when DATA_STORAGE=false.
 *
 * Isolation: a task created by an authenticated request carries the caller's `clientId` as
 * `principal`; every read or write from another principal behaves exactly like an unknown task (no
 * existence leak). A task created without a principal (stdio) is visible to every caller of the store.
 */

import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type { CallToolResult, InputRequests, InputResponses } from '@modelcontextprotocol/server';
import { decodeCursor, encodeCursor, type JsonValue } from './pagination.js';
import type { DataStore } from './utils/dataStore.js';

/** The MCP Tasks extension identifier (2026-07-28). */
export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

/** All task statuses, in lifecycle order (terminal states last). */
export const TASK_STATUSES = ['working', 'input_required', 'completed', 'failed', 'cancelled'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Data associated with a task (2026-07-28 / PR #2782 shape; the 2025 wire maps ttlMs -> ttl). */
export interface Task {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  lastUpdatedAt: string;
  /** Retention from creation in ms; null = unlimited. */
  ttlMs: number | null;
  /** Suggested polling interval in ms. */
  pollIntervalMs?: number;
}

export interface WorkingTask extends Task {
  status: 'working';
}
export interface InputRequiredTask extends Task {
  status: 'input_required';
  inputRequests: InputRequests;
}
export interface CompletedTask extends Task {
  status: 'completed';
  result: { [key: string]: unknown };
}
export interface FailedTask extends Task {
  status: 'failed';
  error: { [key: string]: unknown };
}
export interface CancelledTask extends Task {
  status: 'cancelled';
}

/** A task with status-specific fields inlined (`tasks/get`). */
export type DetailedTask = WorkingTask | InputRequiredTask | CompletedTask | FailedTask | CancelledTask;

/** What a store is asked to create (PR #2782 `CreateTaskParams`). */
export interface CreateTaskParams {
  ttlMs: number | null;
  pollIntervalMs?: number;
  /** The creating caller; access from another principal is refused as "not found". */
  principal?: string;
  /** Store-defined context (the tool name, a job id). */
  context?: Record<string, unknown>;
}

/** The caller identity presented on a `tasks/*` request (PR #2782 `TaskAccess`). */
export interface TaskAccess {
  principal?: string;
}

/** The store contract of PR #2782, unchanged. */
export interface TaskStore {
  create(params: CreateTaskParams): Promise<Task>;
  get(taskId: string, access?: TaskAccess): Promise<DetailedTask | undefined>;
  update(taskId: string, inputResponses: InputResponses, access?: TaskAccess): Promise<boolean>;
  cancel(taskId: string, access?: TaskAccess): Promise<boolean>;
}

/** The writer side of a task, for the code that does the work (PR #2782 `TaskHandle`). */
export interface TaskHandle {
  readonly taskId: string;
  /** Aborted when the task is cancelled (or purged). */
  readonly signal: AbortSignal;
  status(message: string): Promise<void>;
  requireInput(requests: InputRequests): Promise<InputResponses>;
  complete(result: CallToolResult): Promise<void>;
  fail(error: { code: number; message: string; data?: unknown }): Promise<void>;
}

export interface TaskListPage {
  tasks: Task[];
  nextCursor?: string;
}

/** mcp-core's superset of `TaskStore` (not in PR #2782). */
export interface ManagedTaskStore extends TaskStore {
  /** The caller's tasks, newest first, paged with an opaque cursor. */
  list(access?: TaskAccess, options?: { cursor?: string; limit?: number }): Promise<TaskListPage>;
  /** The writer handle (throws for an unknown task). */
  handle(taskId: string): TaskHandle;
  /** The context recorded at creation. */
  context(taskId: string): Promise<Record<string, unknown> | undefined>;
  /**
   * Merge `patch` into the context (writer side, like `handle`: no caller check): for what the work learns
   * after creation, such as the id an upstream assigned. False for an unknown task.
   */
  updateContext(taskId: string, patch: Record<string, unknown>): Promise<boolean>;
  /** Observe one task's changes (this process's writes); returns unsubscribe. */
  watch(taskId: string, listener: (task: DetailedTask) => void): () => void;
  /** Stop timers, abort running work, release resources. */
  close(): void;
}

export interface TaskStoreOptions {
  /** Task id factory (default `crypto.randomUUID()`). */
  createTaskId?: () => string;
  /** Clock (default `Date.now`). */
  now?: () => number;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

/** Whether `status` is terminal (completed, failed, cancelled). */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

interface TaskRecord {
  taskId: string;
  principal?: string;
  context?: Record<string, unknown>;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: number;
  lastUpdatedAt: number;
  ttlMs: number | null;
  pollIntervalMs?: number;
  result?: CallToolResult;
  error?: { code: number; message: string; data?: unknown };
  inputRequests?: InputRequests;
  /** The answers so far; kept once complete (status back to working) until the waiter takes them. */
  inputResponses?: InputResponses;
  /** Identifies one requireInput call, so a waiter never takes the answers of an earlier round. */
  inputRound?: string;
}

function validateParams(params: CreateTaskParams): void {
  if (params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs < 0)) {
    throw new RangeError(`ttlMs must be a non-negative integer or null, got ${params.ttlMs}`);
  }
  if (
    params.pollIntervalMs !== undefined &&
    (!Number.isSafeInteger(params.pollIntervalMs) || params.pollIntervalMs < 0)
  ) {
    throw new RangeError(`pollIntervalMs must be a non-negative integer, got ${params.pollIntervalMs}`);
  }
}

function clearInput(record: TaskRecord): void {
  record.inputRequests = undefined;
  record.inputResponses = undefined;
  record.inputRound = undefined;
}

function snapshot(record: TaskRecord): Task {
  return {
    taskId: record.taskId,
    status: record.status,
    ...(record.statusMessage !== undefined ? { statusMessage: record.statusMessage } : {}),
    createdAt: new Date(record.createdAt).toISOString(),
    lastUpdatedAt: new Date(record.lastUpdatedAt).toISOString(),
    ttlMs: record.ttlMs,
    ...(record.pollIntervalMs !== undefined ? { pollIntervalMs: record.pollIntervalMs } : {}),
  };
}

function detailed(record: TaskRecord): DetailedTask {
  const base = snapshot(record);
  switch (record.status) {
    case 'working':
      return { ...base, status: 'working' };
    case 'input_required': {
      const inputRequests: InputRequests = {};
      for (const [key, request] of Object.entries(record.inputRequests ?? {})) {
        if (!(key in (record.inputResponses ?? {}))) inputRequests[key] = request;
      }
      return { ...base, status: 'input_required', inputRequests };
    }
    case 'completed':
      return { ...base, status: 'completed', result: (record.result ?? { content: [] }) as { [key: string]: unknown } };
    case 'failed':
      return { ...base, status: 'failed', error: record.error ?? { code: -32603, message: 'Task failed' } };
    case 'cancelled':
      return { ...base, status: 'cancelled' };
  }
}

function visible(record: TaskRecord | undefined, access: TaskAccess | undefined): record is TaskRecord {
  return record !== undefined && (record.principal === undefined || record.principal === access?.principal);
}

function isListCursor(data: JsonValue): data is { o: number } {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    typeof data.o === 'number' &&
    Number.isInteger(data.o) &&
    data.o >= 0
  );
}

function pageOf(records: TaskRecord[], options: { cursor?: string; limit?: number } = {}): TaskListPage {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const offset = options.cursor ? decodeCursor(options.cursor, { validate: isListCursor }).o : 0;
  const sorted = [...records].sort((a, b) => b.createdAt - a.createdAt || a.taskId.localeCompare(b.taskId));
  const slice = sorted.slice(offset, offset + limit).map(snapshot);
  const end = offset + limit;
  return { tasks: slice, ...(end < sorted.length ? { nextCursor: encodeCursor({ o: end }) } : {}) };
}

/** Shared bookkeeping for both stores: listeners, abort controllers, input waiters. */
abstract class BaseTaskStore implements ManagedTaskStore {
  protected readonly createTaskId: () => string;
  protected readonly now: () => number;
  protected readonly aborts = new Map<string, AbortController>();
  protected readonly listeners = new Map<string, Set<(task: DetailedTask) => void>>();
  private readonly waiters = new Map<string, { round: string; resolve: (responses: InputResponses) => void }>();

  constructor(options: TaskStoreOptions = {}) {
    this.createTaskId = options.createTaskId ?? (() => randomUUID());
    this.now = options.now ?? (() => Date.now());
  }

  protected abstract read(taskId: string): Promise<TaskRecord | undefined>;
  protected abstract write(record: TaskRecord): Promise<void>;
  protected abstract all(): Promise<TaskRecord[]>;
  protected abstract forget(taskId: string): Promise<void>;
  abstract close(): void;

  protected abortController(taskId: string): AbortController {
    let controller = this.aborts.get(taskId);
    if (!controller) {
      controller = new AbortController();
      this.aborts.set(taskId, controller);
    }
    return controller;
  }

  protected emit(record: TaskRecord): void {
    const set = this.listeners.get(record.taskId);
    if (!set) return;
    const task = detailed(record);
    for (const listener of [...set]) {
      try {
        listener(task);
      } catch {
        // A failing observer never affects the task.
      }
    }
  }

  protected async save(record: TaskRecord): Promise<void> {
    record.lastUpdatedAt = this.now();
    await this.write(record);
    this.emit(record);
  }

  protected expired(record: TaskRecord): boolean {
    return record.ttlMs !== null && record.createdAt + record.ttlMs <= this.now();
  }

  protected async live(taskId: string): Promise<TaskRecord | undefined> {
    const record = await this.read(taskId);
    if (!record) return undefined;
    if (this.expired(record)) {
      await this.purge(taskId);
      return undefined;
    }
    return record;
  }

  /**
   * Hand a completed round of answers to this process's waiting `requireInput`. The answers may have
   * been written by another process sharing the store (the file store calls this from its poll).
   */
  protected settleInput(record: TaskRecord): void {
    const waiter = this.waiters.get(record.taskId);
    if (!waiter || record.status !== 'working' || record.inputRound !== waiter.round || !record.inputResponses) {
      return;
    }
    this.waiters.delete(record.taskId);
    waiter.resolve(record.inputResponses);
  }

  protected async purge(taskId: string): Promise<void> {
    this.aborts.get(taskId)?.abort();
    this.aborts.delete(taskId);
    this.waiters.delete(taskId);
    await this.forget(taskId);
  }

  async create(params: CreateTaskParams): Promise<Task> {
    validateParams(params);
    const now = this.now();
    const record: TaskRecord = {
      taskId: this.createTaskId(),
      ...(params.principal !== undefined ? { principal: params.principal } : {}),
      ...(params.context !== undefined ? { context: params.context } : {}),
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: params.ttlMs,
      ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
    };
    await this.write(record);
    this.abortController(record.taskId);
    this.scheduled(record);
    return snapshot(record);
  }

  /** Hook: the in-memory store arms its TTL timer here. */
  protected scheduled(_record: TaskRecord): void {}

  async get(taskId: string, access?: TaskAccess): Promise<DetailedTask | undefined> {
    const record = await this.live(taskId);
    return visible(record, access) ? detailed(record) : undefined;
  }

  async update(taskId: string, inputResponses: InputResponses, access?: TaskAccess): Promise<boolean> {
    const record = await this.live(taskId);
    if (!visible(record, access)) return false;
    if (record.status !== 'input_required' || !record.inputRequests) return true;
    const responses: InputResponses = { ...(record.inputResponses ?? {}) };
    for (const [key, response] of Object.entries(inputResponses)) {
      // Unknown keys are ignored; the first answer to a key wins.
      if (key in record.inputRequests && !(key in responses)) responses[key] = response;
    }
    record.inputResponses = responses;
    const complete = Object.keys(record.inputRequests).every((key) => key in responses);
    if (complete) {
      record.status = 'working';
      record.inputRequests = undefined;
    }
    await this.save(record);
    if (complete) this.settleInput(record);
    return true;
  }

  async cancel(taskId: string, access?: TaskAccess): Promise<boolean> {
    const record = await this.live(taskId);
    if (!visible(record, access)) return false;
    if (isTerminalStatus(record.status)) return true;
    record.status = 'cancelled';
    clearInput(record);
    await this.save(record);
    this.aborts.get(taskId)?.abort();
    this.waiters.delete(taskId);
    return true;
  }

  async list(access?: TaskAccess, options?: { cursor?: string; limit?: number }): Promise<TaskListPage> {
    const records: TaskRecord[] = [];
    for (const record of await this.all()) {
      if (this.expired(record)) await this.purge(record.taskId);
      else if (visible(record, access)) records.push(record);
    }
    return pageOf(records, options);
  }

  async context(taskId: string): Promise<Record<string, unknown> | undefined> {
    return (await this.live(taskId))?.context;
  }

  async updateContext(taskId: string, patch: Record<string, unknown>): Promise<boolean> {
    const record = await this.live(taskId);
    if (!record) return false;
    record.context = { ...record.context, ...patch };
    await this.save(record);
    return true;
  }

  watch(taskId: string, listener: (task: DetailedTask) => void): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(taskId);
    };
  }

  handle(taskId: string): TaskHandle {
    const signal = this.abortController(taskId).signal;
    const running = async (): Promise<TaskRecord | undefined> => {
      const record = await this.live(taskId);
      if (!record || isTerminalStatus(record.status)) return undefined;
      return record;
    };
    return {
      taskId,
      signal,
      status: async (message) => {
        const record = await running();
        if (!record) return;
        record.statusMessage = message;
        await this.save(record);
      },
      requireInput: async (requests) => {
        const record = await running();
        if (!record) throw new Error(`Task "${taskId}" is no longer running`);
        const round = randomUUID();
        record.status = 'input_required';
        record.inputRequests = requests;
        record.inputResponses = {};
        record.inputRound = round;
        const answered = new Promise<InputResponses>((resolve, reject) => {
          this.waiters.set(taskId, { round, resolve });
          signal.addEventListener('abort', () => reject(new Error(`Task "${taskId}" was cancelled`)), { once: true });
        });
        await this.save(record);
        return answered;
      },
      complete: async (result) => {
        const record = await running();
        if (!record) return;
        record.status = 'completed';
        record.result = result;
        clearInput(record);
        await this.save(record);
      },
      fail: async (error) => {
        const record = await running();
        if (!record) return;
        record.status = 'failed';
        record.error = error;
        clearInput(record);
        await this.save(record);
      },
    };
  }
}

/** The in-process reference store (PR #2782 `InMemoryTaskStore`, plus the `ManagedTaskStore` extras). */
export class InMemoryTaskStore extends BaseTaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  protected async read(taskId: string): Promise<TaskRecord | undefined> {
    return this.tasks.get(taskId);
  }
  protected async write(record: TaskRecord): Promise<void> {
    this.tasks.set(record.taskId, record);
  }
  protected async all(): Promise<TaskRecord[]> {
    return [...this.tasks.values()];
  }
  protected async forget(taskId: string): Promise<void> {
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
    this.tasks.delete(taskId);
  }
  protected override scheduled(record: TaskRecord): void {
    if (record.ttlMs === null) return;
    const timer = setTimeout(() => void this.purge(record.taskId), record.ttlMs);
    timer.unref?.();
    this.timers.set(record.taskId, timer);
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.aborts.values()) controller.abort();
    this.aborts.clear();
    this.tasks.clear();
    this.listeners.clear();
  }
}

export interface FileTaskStoreOptions extends TaskStoreOptions {
  /** How often running work re-reads its task file to see a cancellation from another process (ms, default 1000). */
  cancelPollMs?: number;
  /** How often expired task files are swept (ms, default 60000). */
  sweepMs?: number;
}

const TASK_DIR = 'tasks';

/** A store of JSON files under the data store (`<DATA_PATH>/tasks/<taskId>.json`). */
export class FileTaskStore extends BaseTaskStore {
  private readonly pollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly cancelPollMs: number;

  constructor(
    private readonly data: DataStore,
    options: FileTaskStoreOptions = {},
  ) {
    super(options);
    if (!data.enabled) throw new Error('FileTaskStore needs an enabled data store (DATA_STORAGE=true)');
    this.cancelPollMs = options.cancelPollMs ?? 1000;
    this.sweeper = setInterval(() => void this.list().catch(() => undefined), options.sweepMs ?? 60_000);
    this.sweeper.unref?.();
  }

  private file(taskId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new Error('invalid task id');
    return `${TASK_DIR}/${taskId}.json`;
  }

  protected async read(taskId: string): Promise<TaskRecord | undefined> {
    let file: string;
    try {
      file = this.file(taskId);
    } catch {
      return undefined;
    }
    const raw = await this.data.readFile(file);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw.toString('utf8')) as TaskRecord;
    } catch {
      return undefined;
    }
  }
  protected async write(record: TaskRecord): Promise<void> {
    await this.data.writeFile(this.file(record.taskId), JSON.stringify(record));
  }
  protected async all(): Promise<TaskRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.data.resolveInside(TASK_DIR));
    } catch {
      return [];
    }
    const records: TaskRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = await this.read(name.slice(0, -'.json'.length));
      if (record) records.push(record);
    }
    return records;
  }
  protected async forget(taskId: string): Promise<void> {
    this.stopPolling(taskId);
    await this.data.remove(this.file(taskId));
  }

  private stopPolling(taskId: string): void {
    const poller = this.pollers.get(taskId);
    if (poller) clearInterval(poller);
    this.pollers.delete(taskId);
  }

  override handle(taskId: string): TaskHandle {
    const handle = super.handle(taskId);
    // Another process may cancel or answer input through the shared files: poll while the work runs.
    if (!this.pollers.has(taskId)) {
      const poller = setInterval(() => {
        void this.read(taskId).then((record) => {
          if (!record || record.status === 'cancelled' || this.expired(record)) {
            this.aborts.get(taskId)?.abort();
          }
          if (record) this.settleInput(record);
          if (!record || isTerminalStatus(record.status)) this.stopPolling(taskId);
        });
      }, this.cancelPollMs);
      poller.unref?.();
      this.pollers.set(taskId, poller);
    }
    return handle;
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const poller of this.pollers.values()) clearInterval(poller);
    this.pollers.clear();
    for (const controller of this.aborts.values()) controller.abort();
    this.aborts.clear();
    this.listeners.clear();
  }
}

/** A file store when the data store is enabled, otherwise the in-memory store. */
export function createTaskStore(data: DataStore | undefined, options: FileTaskStoreOptions = {}): ManagedTaskStore {
  return data?.enabled ? new FileTaskStore(data, options) : new InMemoryTaskStore(options);
}
