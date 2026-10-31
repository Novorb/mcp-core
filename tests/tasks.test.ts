import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { createMcpServer, type OAuthTokenVerifier, ProtocolErrorCode, TOOL_ANNOTATIONS } from '../src/server.js';
import { InMemoryTaskStore, TASKS_EXTENSION_ID } from '../src/task-store.js';
import { declaresTasksExtension, defineTaskTool, registerTaskTools, toLegacyTask } from '../src/task-tools.js';
import { connectInMemory, createTestClient } from '../src/testing/index.js';
import { modernMeta, type RawPeer, rawHttpPeer, rawPeer } from '../src/testing/raw-peer.js';
import { toolResult } from '../src/tools.js';
import { type RequestContext, startMcpServer } from '../src/transport.js';
import { addLogListener, initLogger, type LogEntry, LogLevel, resetLogger } from '../src/utils/logger.js';
import { buildJobServer, jobTool, requiredTaskTool } from './fixtures/job-tools.js';

let stderr: jest.SpiedFunction<typeof process.stderr.write>;
let store: InMemoryTaskStore;
let entries: LogEntry[];
let unlisten: () => void;

beforeEach(() => {
  resetLogger();
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  initLogger({ name: 'tasks-test', fileMain: false, fileExceptions: false, fileDebug: false });
  entries = [];
  unlisten = addLogListener((e) => entries.push(e));
  store = new InMemoryTaskStore();
});

afterEach(() => {
  unlisten();
  store.close();
  stderr.mockRestore();
  resetLogger();
});

const TASKS_CAPS = { extensions: { [TASKS_EXTENSION_ID]: {} } };
const loose = z.looseObject({});
const confirm = {
  method: 'elicitation/create',
  params: { mode: 'form', message: 'Place the order?', requestedSchema: { type: 'object', properties: {} } },
};

const approvalTool = defineTaskTool({
  name: 'place_order',
  description: 'Asks for approval mid-task (2026-07-28 input_required)',
  inputSchema: z.object({}),
  annotations: TOOL_ANNOTATIONS.mutableWrite,
  pollIntervalMs: 10,
  run: async (_args, task) => {
    const answers = await task.requireInput({ approve: confirm } as never);
    const action = (answers.approve as { action?: string } | undefined)?.action;
    return toolResult({ placed: action === 'accept' });
  },
});

function factory(req: RequestContext) {
  const server = createMcpServer('tasks', '1.0.0');
  registerTaskTools(server, [jobTool, requiredTaskTool, approvalTool], { store, request: req, resultPollMs: 20 });
  return server;
}

async function modernPeer(): Promise<{ peer: RawPeer; close(): Promise<void> }> {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(factory, { transport: server });
  const peer = await rawPeer(client);
  return {
    peer,
    close: async () => {
      await peer.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
    },
  };
}

async function poll(
  get: () => Promise<Record<string, unknown>>,
  done: (t: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const t = await get();
    if (done(t)) return t;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('task never reached the expected state');
}

describe('2026-07-28 tasks extension (raw JSON-RPC, in memory)', () => {
  const meta = () => modernMeta(TASKS_CAPS);

  it('advertises the extension and runs a job to completion', async () => {
    const { peer, close } = await modernPeer();
    try {
      const discover = await peer.request('server/discover', { _meta: meta() });
      expect((discover.result?.capabilities as Record<string, unknown>)?.extensions).toEqual({
        [TASKS_EXTENSION_ID]: {},
      });
      const started = await peer.request('tools/call', {
        name: 'run_job',
        arguments: { label: 'demo', steps: 3, stepMs: 20 },
        _meta: meta(),
      });
      expect(started.result).toMatchObject({
        resultType: 'task',
        status: 'working',
        ttlMs: 3_600_000,
        pollIntervalMs: 20,
      });
      const taskId = String(started.result?.taskId);
      const done = await poll(
        async () => (await peer.request('tasks/get', { taskId, _meta: meta() })).result ?? {},
        (t) => t.status === 'completed',
      );
      expect(done.statusMessage).toBe('simulating (3/3)');
      expect(done.result).toMatchObject({ resultType: 'complete', structuredContent: { items: 9, mode: 'task' } });
      expect(entries.map((e) => e.message)).toEqual(
        expect.arrayContaining(['Task started: run_job', 'Task finished: run_job']),
      );
    } finally {
      await close();
    }
  });

  it('cancels a running task cooperatively (idempotent ack)', async () => {
    const { peer, close } = await modernPeer();
    try {
      const started = await peer.request('tools/call', {
        name: 'run_job',
        arguments: { label: 'slow', steps: 50, stepMs: 20 },
        _meta: meta(),
      });
      const taskId = String(started.result?.taskId);
      expect((await peer.request('tasks/cancel', { taskId, _meta: meta() })).result).toMatchObject({
        resultType: 'complete',
      });
      const t = await poll(
        async () => (await peer.request('tasks/get', { taskId, _meta: meta() })).result ?? {},
        (x) => x.status === 'cancelled',
      );
      expect(t.status).toBe('cancelled');
      expect((await peer.request('tasks/cancel', { taskId, _meta: meta() })).error).toBeUndefined();
      await new Promise((r) => setTimeout(r, 40));
      expect((await peer.request('tasks/get', { taskId, _meta: meta() })).result?.status).toBe('cancelled');
    } finally {
      await close();
    }
  });

  it('surfaces input_required and resumes on tasks/update', async () => {
    const { peer, close } = await modernPeer();
    try {
      const started = await peer.request('tools/call', { name: 'place_order', arguments: {}, _meta: meta() });
      const taskId = String(started.result?.taskId);
      const waiting = await poll(
        async () => (await peer.request('tasks/get', { taskId, _meta: meta() })).result ?? {},
        (t) => t.status === 'input_required',
      );
      expect(Object.keys(waiting.inputRequests as object)).toEqual(['approve']);
      const ack = await peer.request('tasks/update', {
        taskId,
        inputResponses: { approve: { action: 'accept', content: {} } },
        _meta: meta(),
      });
      expect(ack.error).toBeUndefined();
      const done = await poll(
        async () => (await peer.request('tasks/get', { taskId, _meta: meta() })).result ?? {},
        (t) => t.status === 'completed',
      );
      expect(done.result).toMatchObject({ structuredContent: { placed: true } });
    } finally {
      await close();
    }
  });

  it('a failing run completes with an isError result; unknown task -32602; no extension -32021', async () => {
    const { peer, close } = await modernPeer();
    try {
      const started = await peer.request('tools/call', {
        name: 'run_job',
        arguments: { label: 'bad', steps: 1, stepMs: 0, fail: true },
        _meta: meta(),
      });
      const taskId = String(started.result?.taskId);
      const done = await poll(
        async () => (await peer.request('tasks/get', { taskId, _meta: meta() })).result ?? {},
        (t) => t.status === 'completed',
      );
      expect(done.result).toMatchObject({ isError: true });
      expect(JSON.stringify(done.result)).toContain('job runner rejected the input');
      expect((await peer.request('tasks/get', { taskId: 'nope', _meta: meta() })).error?.code).toBe(-32602);
      expect((await peer.request('tasks/update', { taskId: 'nope', _meta: meta() })).error?.code).toBe(-32602);
      expect((await peer.request('tasks/cancel', { taskId: 'nope', _meta: meta() })).error?.code).toBe(-32602);
      expect((await peer.request('tasks/get', { taskId, _meta: modernMeta({}) })).error?.code).toBe(-32021);
      expect((await peer.request('tasks/get', { _meta: meta() })).error?.code).toBe(-32602);
      // 2025-only methods are not served on the modern era.
      expect((await peer.request('tasks/list', { _meta: meta() })).error).toBeDefined();
    } finally {
      await close();
    }
  });

  it('a store write that fails while settling is logged, never an unhandled rejection', async () => {
    class FailingStore extends InMemoryTaskStore {
      override handle(taskId: string) {
        const handle = super.handle(taskId);
        return { ...handle, complete: () => Promise.reject(new Error('disk full')) };
      }
    }
    const failing = new FailingStore();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(
      (req: RequestContext) => {
        const server = createMcpServer('tasks', '1.0.0');
        registerTaskTools(server, [jobTool], { store: failing, request: req });
        return server;
      },
      { transport },
    );
    const peer = await rawPeer(client);
    try {
      await peer.request('tools/call', {
        name: 'run_job',
        arguments: { label: 'x', steps: 1, stepMs: 0 },
        _meta: meta(),
      });
      for (let i = 0; i < 100 && !entries.some((e) => e.message.startsWith('Task settle failed')); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const logged = entries.find((e) => e.message === 'Task settle failed: run_job');
      expect(logged?.level).toBe(LogLevel.ERROR);
      expect(logged?.meta).toMatchObject({ error: 'disk full' });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      await peer.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      failing.close();
    }
  });

  it('a client without the extension gets the tool run synchronously, or refused when required', async () => {
    const { peer, close } = await modernPeer();
    try {
      const sync = await peer.request('tools/call', {
        name: 'run_job',
        arguments: { label: 'sync', steps: 2, stepMs: 0 },
        _meta: modernMeta({}),
      });
      expect(sync.result).toMatchObject({ resultType: 'complete', structuredContent: { mode: 'sync', items: 6 } });
      const refused = await peer.request('tools/call', {
        name: 'run_only_as_task',
        arguments: {},
        _meta: modernMeta({}),
      });
      expect(refused.result).toMatchObject({ isError: true });
      expect(JSON.stringify(refused.result)).toContain(`declare the ${TASKS_EXTENSION_ID} extension`);
    } finally {
      await close();
    }
  });
});

describe('2025-11-25 tasks (SDK client, in memory)', () => {
  it('advertises tasks + per-tool taskSupport, waits on tasks/result, lists, pushes status notifications', async () => {
    const conn = await connectInMemory(factory);
    const statuses: string[] = [];
    conn.client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/tasks/status') statuses.push(String((n.params as { status?: string }).status));
    };
    try {
      expect(conn.client.getServerCapabilities()?.tasks).toEqual({
        list: {},
        cancel: {},
        requests: { tools: { call: {} } },
      });
      const { tools } = await conn.client.listTools();
      expect(tools.find((t) => t.name === 'run_job')?.execution).toEqual({ taskSupport: 'optional' });
      expect(tools.find((t) => t.name === 'run_only_as_task')?.execution).toEqual({ taskSupport: 'required' });
      const created = await conn.client.request(
        {
          method: 'tools/call',
          params: { name: 'run_job', arguments: { label: 'demo', steps: 2, stepMs: 20 }, task: { ttl: 60000 } },
        },
        loose,
      );
      const task = created.task as Record<string, unknown>;
      expect(task).toMatchObject({ status: 'working', ttl: 60000, pollInterval: 20 });
      const taskId = String(task.taskId);
      const result = await conn.client.request({ method: 'tasks/result', params: { taskId } }, loose);
      expect(result.structuredContent).toMatchObject({ label: 'demo', items: 6, mode: 'task' });
      expect((result._meta as Record<string, unknown>)['io.modelcontextprotocol/related-task']).toEqual({ taskId });
      const listed = await conn.client.request({ method: 'tasks/list', params: {} }, loose);
      expect((listed.tasks as Array<{ taskId: string }>).map((t) => t.taskId)).toContain(taskId);
      await new Promise((r) => setTimeout(r, 20));
      expect(statuses.at(-1)).toBe('completed');
      await expect(conn.client.request({ method: 'tasks/cancel', params: { taskId } }, loose)).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringContaining('already completed'),
      });
      await expect(
        conn.client.request({ method: 'tasks/get', params: { taskId: 'nope' } }, loose),
      ).rejects.toMatchObject({
        code: -32602,
      });
      await expect(
        conn.client.request({ method: 'tasks/list', params: { cursor: 'bad' } }, loose),
      ).rejects.toMatchObject({
        code: -32602,
      });
    } finally {
      await conn.close();
    }
  });

  it('cancels a running task and fails tasks/result; a failed task surfaces its error', async () => {
    const conn = await connectInMemory(factory);
    try {
      const created = await conn.client.request(
        {
          method: 'tools/call',
          params: { name: 'run_job', arguments: { label: 's', steps: 50, stepMs: 20 }, task: {} },
        },
        loose,
      );
      const taskId = String((created.task as { taskId: string }).taskId);
      const waiting = conn.client.request({ method: 'tasks/result', params: { taskId } }, loose);
      const cancelled = await conn.client.request({ method: 'tasks/cancel', params: { taskId } }, loose);
      expect(cancelled.status).toBe('cancelled');
      await expect(waiting).rejects.toMatchObject({ message: expect.stringContaining('was cancelled') });
      const failing = await store.create({ ttlMs: null });
      await store.handle(failing.taskId).fail({ code: -32000, message: 'engine down' });
      await expect(
        conn.client.request({ method: 'tasks/result', params: { taskId: failing.taskId } }, loose),
      ).rejects.toMatchObject({ code: -32000, message: expect.stringContaining('engine down') });
    } finally {
      await conn.close();
    }
  });

  it('runs synchronously without params.task (with progress) and refuses a required task tool', async () => {
    const conn = await connectInMemory(factory);
    try {
      const progress: number[] = [];
      const res = await conn.client.callTool(
        { name: 'run_job', arguments: { label: 'sync', steps: 2, stepMs: 0 } },
        { onprogress: (p) => progress.push(p.progress) },
      );
      expect(res.structuredContent).toMatchObject({ mode: 'sync' });
      expect(progress).toEqual([1, 2]);
      const refused = await conn.client.callTool({ name: 'run_only_as_task', arguments: {} });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('params.task');
    } finally {
      await conn.close();
    }
  });
});

describe('per-caller isolation over HTTP (both eras)', () => {
  const verifier: OAuthTokenVerifier = {
    verifyAccessToken: async (token) => ({
      token,
      clientId: token,
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  };

  it('a task is invisible to another authenticated caller', async () => {
    const handle = await startMcpServer(factory, {
      mode: 'http',
      port: 0,
      host: '127.0.0.1',
      auth: { verifier },
      handleSignals: false,
    });
    try {
      const alice = rawHttpPeer(String(handle.url), 'alice');
      const bob = rawHttpPeer(String(handle.url), 'bob');
      const started = await alice.request('tools/call', {
        name: 'run_job',
        arguments: { label: 'a', steps: 1, stepMs: 0 },
        _meta: modernMeta(TASKS_CAPS),
      });
      const taskId = String(started.result?.taskId);
      expect((await alice.request('tasks/get', { taskId, _meta: modernMeta(TASKS_CAPS) })).result?.taskId).toBe(taskId);
      expect((await bob.request('tasks/get', { taskId, _meta: modernMeta(TASKS_CAPS) })).error?.code).toBe(-32602);
      expect((await bob.request('tasks/cancel', { taskId, _meta: modernMeta(TASKS_CAPS) })).error?.code).toBe(-32602);

      const legacy = createTestClient({ era: 'legacy' });
      await legacy.connect(
        new StreamableHTTPClientTransport(new URL(String(handle.url)), {
          requestInit: { headers: { authorization: 'Bearer bob' } },
        }),
      );
      await expect(legacy.request({ method: 'tasks/get', params: { taskId } }, loose)).rejects.toMatchObject({
        code: -32602,
      });
      const listed = await legacy.request({ method: 'tasks/list', params: {} }, loose);
      expect(listed.tasks).toEqual([]);
      await legacy.close();
    } finally {
      await handle.close();
    }
  });
});

describe('task tool helpers', () => {
  it('maps the 2025 wire shape and reads the extension declaration', () => {
    expect(
      toLegacyTask({
        taskId: 't',
        status: 'working',
        createdAt: 'a',
        lastUpdatedAt: 'b',
        ttlMs: null,
        pollIntervalMs: 5,
        statusMessage: 'm',
      }),
    ).toEqual({
      taskId: 't',
      status: 'working',
      ttl: null,
      createdAt: 'a',
      lastUpdatedAt: 'b',
      pollInterval: 5,
      statusMessage: 'm',
    });
    const ctx = (caps: unknown) =>
      ({ mcpReq: { envelope: { 'io.modelcontextprotocol/clientCapabilities': caps } } }) as never;
    expect(declaresTasksExtension(ctx({ extensions: { [TASKS_EXTENSION_ID]: {} } }))).toBe(true);
    expect(declaresTasksExtension(ctx({ extensions: {} }))).toBe(false);
    expect(declaresTasksExtension(ctx(undefined))).toBe(false);
  });

  it('a job invoked directly (no SDK context) runs synchronously', async () => {
    const server = createMcpServer('direct', '1.0.0');
    const handles = registerTaskTools(server, [jobTool], { store, request: { era: 'modern' } });
    expect(handles.has('run_job')).toBe(true);
    const server2 = createMcpServer('direct2', '1.0.0');
    registerTaskTools(server2, [jobTool], { store, request: { era: 'legacy' }, prefix: 'x_' });
    const conn = await connectInMemory(() => {
      const s = createMcpServer('d', '1.0.0');
      registerTaskTools(s, [jobTool], { store, request: { era: 'legacy' }, prefix: 'x_' });
      return s;
    });
    try {
      const { tools } = await conn.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['x_run_job']);
    } finally {
      await conn.close();
    }
  });

  it('serves the fixture factory over stdio era detection', async () => {
    const conn = await connectInMemory(buildJobServer(store), { era: 'modern' });
    try {
      const res = await conn.client.callTool({
        name: 'run_job',
        arguments: { label: 'm', steps: 1, stepMs: 0 },
      });
      expect(res.structuredContent).toMatchObject({ mode: 'sync' });
    } finally {
      await conn.close();
    }
  });
});
