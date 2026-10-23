import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  createTaskStore,
  type DetailedTask,
  FileTaskStore,
  InMemoryTaskStore,
  isTerminalStatus,
  type ManagedTaskStore,
  TASK_STATUSES,
  type TaskAccess,
} from '../src/task-store.js';
import { createDataStore } from '../src/utils/dataStore.js';
import { loadEnv } from '../src/utils/envLoader.js';
import { resetLogger } from '../src/utils/logger.js';

let dir: string;

beforeEach(() => {
  resetLogger();
  dir = mkdtempSync(path.join(tmpdir(), 'mcp-tasks-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function dataStore(enabled = true) {
  const env = loadEnv([], {
    rootDir: dir,
    env: { DATA_PATH: path.join(dir, 'data'), DATA_STORAGE: String(enabled), MCP_ENV_FILE: 'none' },
  });
  return createDataStore({ rootDir: dir, env });
}

const done = { content: [{ type: 'text' as const, text: 'ok' }] };

async function until(store: ManagedTaskStore, taskId: string, status: string, access?: TaskAccess): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await store.get(taskId, access))?.status === status) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`task never reached ${status}`);
}

describe.each<[string, (now?: () => number) => ManagedTaskStore]>([
  ['InMemoryTaskStore', (now) => new InMemoryTaskStore(now ? { now } : {})],
  ['FileTaskStore', (now) => new FileTaskStore(dataStore(), { cancelPollMs: 10, ...(now ? { now } : {}) })],
])('%s', (_name, make) => {
  it('creates, writes through the handle, and settles', async () => {
    const store = make();
    try {
      const task = await store.create({
        ttlMs: 60_000,
        pollIntervalMs: 50,
        principal: 'alice',
        context: { tool: 't' },
      });
      expect(task).toMatchObject({ status: 'working', ttlMs: 60_000, pollIntervalMs: 50 });
      expect(await store.context(task.taskId)).toEqual({ tool: 't' });
      const seen: string[] = [];
      const unwatch = store.watch(task.taskId, (t) => seen.push(t.status));
      const handle = store.handle(task.taskId);
      await handle.status('half way');
      expect(await store.get(task.taskId, { principal: 'alice' })).toMatchObject({ statusMessage: 'half way' });
      await handle.complete(done);
      await handle.fail({ code: 1, message: 'ignored after completion' });
      const final = (await store.get(task.taskId, { principal: 'alice' })) as DetailedTask;
      expect(final).toMatchObject({ status: 'completed', result: done });
      expect(seen).toEqual(['working', 'completed']);
      unwatch();
      expect(await store.cancel(task.taskId, { principal: 'alice' })).toBe(true);
      expect((await store.get(task.taskId, { principal: 'alice' }))?.status).toBe('completed');
    } finally {
      store.close();
    }
  });

  it('isolates principals: a foreign caller sees "not found"', async () => {
    const store = make();
    try {
      const task = await store.create({ ttlMs: null, principal: 'alice' });
      expect(await store.get(task.taskId, { principal: 'bob' })).toBeUndefined();
      expect(await store.get(task.taskId)).toBeUndefined();
      expect(await store.cancel(task.taskId, { principal: 'bob' })).toBe(false);
      expect(await store.update(task.taskId, {}, { principal: 'bob' })).toBe(false);
      expect((await store.list({ principal: 'bob' })).tasks).toEqual([]);
      const open = await store.create({ ttlMs: null });
      expect(await store.get(open.taskId, { principal: 'anyone' })).toBeDefined();
      expect(await store.get('unknown')).toBeUndefined();
      expect(await store.cancel('unknown')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('cancels cooperatively: aborts the handle signal, later writes are ignored', async () => {
    const store = make();
    try {
      const task = await store.create({ ttlMs: null });
      const handle = store.handle(task.taskId);
      expect(await store.cancel(task.taskId)).toBe(true);
      expect(handle.signal.aborted).toBe(true);
      await handle.complete(done);
      await handle.status('ignored');
      expect(await store.get(task.taskId)).toMatchObject({ status: 'cancelled' });
      expect(await store.cancel(task.taskId)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('asks for input and resumes once every key is answered', async () => {
    const store = make();
    try {
      const task = await store.create({ ttlMs: null });
      const handle = store.handle(task.taskId);
      const request = {
        method: 'elicitation/create',
        params: { message: 'ok?', mode: 'form', requestedSchema: { type: 'object', properties: {} } },
      };
      const answered = handle.requireInput({ a: request, b: request } as never);
      await until(store, task.taskId, 'input_required');
      const waiting = await store.get(task.taskId);
      expect(waiting?.status).toBe('input_required');
      expect(Object.keys((waiting as { inputRequests: object }).inputRequests)).toEqual(['a', 'b']);
      await store.update(task.taskId, { a: { action: 'accept', content: {} }, zzz: { action: 'decline' } } as never);
      expect(Object.keys(((await store.get(task.taskId)) as { inputRequests: object }).inputRequests)).toEqual(['b']);
      await store.update(task.taskId, { b: { action: 'decline' } } as never);
      await expect(answered).resolves.toEqual({ a: { action: 'accept', content: {} }, b: { action: 'decline' } });
      expect((await store.get(task.taskId))?.status).toBe('working');
      expect(await store.update(task.taskId, {})).toBe(true);
      const second = handle.requireInput({ c: request } as never);
      await until(store, task.taskId, 'input_required');
      await store.cancel(task.taskId);
      await expect(second).rejects.toThrow(/cancelled/);
      await expect(handle.requireInput({ d: request } as never)).rejects.toThrow(/no longer running/);
    } finally {
      store.close();
    }
  });

  it('expires by TTL, pages the list newest first, and fails a task with its error', async () => {
    let now = 1_000_000;
    const store = make(() => now);
    try {
      const a = await store.create({ ttlMs: 1000 });
      now += 10;
      const b = await store.create({ ttlMs: null });
      now += 10;
      const c = await store.create({ ttlMs: null });
      const first = await store.list({}, { limit: 2 });
      expect(first.tasks.map((t) => t.taskId)).toEqual([c.taskId, b.taskId]);
      const second = await store.list({}, { limit: 2, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) });
      expect(second.tasks.map((t) => t.taskId)).toEqual([a.taskId]);
      expect(second.nextCursor).toBeUndefined();
      await store.handle(b.taskId).fail({ code: -32000, message: 'engine down' });
      expect(await store.get(b.taskId)).toMatchObject({
        status: 'failed',
        error: { code: -32000, message: 'engine down' },
      });
      now += 5000;
      expect(await store.get(a.taskId)).toBeUndefined();
      expect((await store.list()).tasks.map((t) => t.taskId)).toEqual([c.taskId, b.taskId]);
      await expect(store.create({ ttlMs: -1 })).rejects.toThrow(RangeError);
      await expect(store.create({ ttlMs: 1, pollIntervalMs: 1.5 })).rejects.toThrow(RangeError);
    } finally {
      store.close();
    }
  });
});

describe('FileTaskStore specifics', () => {
  it('survives a new store instance on the same directory and sees a cross-process cancel', async () => {
    const data = dataStore();
    const writer = new FileTaskStore(data, { cancelPollMs: 10 });
    const reader = new FileTaskStore(data, { cancelPollMs: 10 });
    try {
      const task = await writer.create({ ttlMs: null, principal: 'p' });
      const handle = writer.handle(task.taskId);
      expect((await reader.get(task.taskId, { principal: 'p' }))?.status).toBe('working');
      await reader.cancel(task.taskId, { principal: 'p' });
      for (let i = 0; i < 100 && !handle.signal.aborted; i++) await new Promise((r) => setTimeout(r, 10));
      expect(handle.signal.aborted).toBe(true);
      expect(await reader.get('../escape')).toBeUndefined();
    } finally {
      writer.close();
      reader.close();
    }
  });

  it('resumes a waiting requireInput when another process answers it, never with a previous round', async () => {
    const data = dataStore();
    const worker = new FileTaskStore(data, { cancelPollMs: 10 });
    const front = new FileTaskStore(data, { cancelPollMs: 10 });
    const request = {
      method: 'elicitation/create',
      params: { message: 'ok?', mode: 'form', requestedSchema: { type: 'object', properties: {} } },
    };
    try {
      const task = await worker.create({ ttlMs: null, principal: 'p' });
      const handle = worker.handle(task.taskId);
      const first = handle.requireInput({ a: request } as never);
      await until(front, task.taskId, 'input_required', { principal: 'p' });
      expect(await front.update(task.taskId, { a: { action: 'decline' } } as never, { principal: 'p' })).toBe(true);
      await expect(first).resolves.toEqual({ a: { action: 'decline' } });
      // The file still carries round one's answers while round two is being registered.
      const second = handle.requireInput({ b: request } as never);
      let settled = false;
      void second.then(() => {
        settled = true;
      });
      await until(front, task.taskId, 'input_required', { principal: 'p' });
      await new Promise((r) => setTimeout(r, 50));
      expect(settled).toBe(false);
      await front.update(task.taskId, { b: { action: 'accept', content: {} } } as never, { principal: 'p' });
      await expect(second).resolves.toEqual({ b: { action: 'accept', content: {} } });
    } finally {
      worker.close();
      front.close();
    }
  });

  it('needs an enabled data store; createTaskStore falls back to memory', () => {
    expect(() => new FileTaskStore(dataStore(false))).toThrow(/enabled data store/);
    expect(createTaskStore(dataStore(false))).toBeInstanceOf(InMemoryTaskStore);
    expect(createTaskStore(undefined)).toBeInstanceOf(InMemoryTaskStore);
    const file = createTaskStore(dataStore());
    expect(file).toBeInstanceOf(FileTaskStore);
    file.close();
  });

  it('lists nothing before any task was written', async () => {
    const store = new FileTaskStore(dataStore());
    try {
      expect(await store.list()).toEqual({ tasks: [] });
    } finally {
      store.close();
    }
  });
});

describe('task statuses', () => {
  it('pins the lifecycle and the terminal set', () => {
    expect(TASK_STATUSES).toEqual(['working', 'input_required', 'completed', 'failed', 'cancelled']);
    expect(TASK_STATUSES.filter(isTerminalStatus)).toEqual(['completed', 'failed', 'cancelled']);
  });
});
