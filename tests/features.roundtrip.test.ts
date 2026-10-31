import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  createTaskSessionFromClient,
  resultFromTaskOutcome,
  type TaskEnabledSession,
  toolDeclaration,
} from '@modelcontextprotocol/ext-tasks/client';
import * as z from 'zod/v4';
import { TASKS_EXTENSION_ID } from '../src/task-store.js';
import {
  createIsolatedDirs,
  type IsolatedDirs,
  minimalOsEnv,
  type ProtocolEra,
  startBuiltServer,
} from '../src/testing/index.js';
import { modernMeta, rawHttpPeer, rawPeer } from '../src/testing/raw-peer.js';

// Resources, prompts and tasks end to end against a spawned server (tests/fixtures/feature-server.ts:
// runMcpServer, a file task store under DATA_PATH, a sealed requestState key), over stdio and HTTP, in
// both eras.
// Task tools are driven by @modelcontextprotocol/ext-tasks (the requester side of the Tasks
// extension) where the SDK client allows it, and by raw JSON-RPC on 2026-07-28 stdio.
jest.setTimeout(60_000);

const fixture = fileURLToPath(new URL('./fixtures/feature-server.ts', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const KEY = 'r'.repeat(48);
const TASKS_CAPS = { extensions: { [TASKS_EXTENSION_ID]: {} } };

let dirs: IsolatedDirs;

beforeEach(() => {
  dirs = createIsolatedDirs('mcp-features');
});

afterEach(() => {
  dirs.cleanup();
});

function childEnv(): Record<string, string> {
  return {
    ...dirs.env(),
    DATA_PATH: dirs.dir('data'),
    MCP_ENV_FILE: 'none',
    MCP_REQUEST_STATE_KEY: KEY,
  };
}

// ext-tasks' JSON check rejects objects from another realm (jest's VM context vs node's fetch), so the
// tool declarations are given rather than read through the SDK client's tools/list.
const declarations = {
  currentTool: (name: string) =>
    toolDeclaration({ name, inputSchema: { type: 'object' }, execution: { taskSupport: 'optional' } }),
};

function legacySession(client: Client): TaskEnabledSession {
  return createTaskSessionFromClient(client, { endpointId: 'features-legacy', tools: declarations });
}

function modernHttpSession(client: Client, url: string, apiKey: string | undefined): TaskEnabledSession {
  const raw = rawHttpPeer(url, apiKey);
  return createTaskSessionFromClient(client, {
    endpointId: 'features-modern',
    tools: declarations,
    rawDispatch: async (request) => {
      const r = request as { method: string; params?: Record<string, unknown> };
      const res = await raw.request(r.method, r.params);
      return res.error ? { kind: 'error', error: res.error as never } : { kind: 'result', result: res.result as never };
    },
    v2RequestFraming: {
      protocolVersion: '2026-07-28',
      clientInfo: { name: 'features', version: '1' },
      clientCapabilities: {},
    },
  });
}

async function runJobWithExtTasks(session: TaskEnabledSession): Promise<void> {
  const execution = await session.callTool(
    'run_job',
    { label: 'demo', steps: 3, stepMs: 50 },
    { task: { preference: 'require', retentionMs: 60_000 } },
  );
  expect(execution.kind).toBe('task');
  const statuses: string[] = [];
  const { outcome } = await execution.settle({
    onEvent: (event) => {
      if (event.type === 'task') statuses.push(event.task.status);
    },
  });
  const result = resultFromTaskOutcome(outcome) as { structuredContent?: Record<string, unknown> };
  expect(result.structuredContent).toMatchObject({ label: 'demo', items: 9, mode: 'task' });
  expect(statuses.at(-1)).toBe('completed');

  const slow = await session.callTool(
    'run_job',
    { label: 'slow', steps: 100, stepMs: 50 },
    { task: { preference: 'require' } },
  );
  await slow.cancel();
  const settled = await slow.settle();
  expect(settled.outcome.status).toBe('cancelled');
}

async function checkResourcesPromptsAndState(client: Client): Promise<void> {
  const readme = await client.readResource({ uri: 'docs://readme' });
  expect(readme.contents[0]).toMatchObject({ text: '# Readme\nhello', mimeType: 'text/markdown' });
  const prompt = await client.getPrompt({ name: 'summarise', arguments: { path: 'notes.txt' } });
  expect(prompt.messages[0]?.content).toEqual({ type: 'text', text: 'Summarise notes.txt' });
  const big = await client.callTool({ name: 'big_report', arguments: { size: 4000 } });
  const link = (big.content as Array<{ type: string; uri?: string }>).find((b) => b.type === 'resource_link');
  const spilled = await client.readResource({ uri: String(link?.uri) });
  expect(String(spilled.contents[0]?.text)).toContain('xxxx');
}

describe.each<ProtocolEra>(['legacy', 'modern'])('stdio (%s)', (era) => {
  it('resources, prompts, the requestState flow and tasks', async () => {
    const srv = await startBuiltServer({
      entry: fixture,
      nodeArgs: ['--import', tsxLoader],
      mode: 'stdio',
      era,
      env: childEnv(),
      cwd: dirs.cwd,
      clientOptions: { capabilities: { elicitation: { form: {} } } },
    });
    try {
      await checkResourcesPromptsAndState(srv.client);
      srv.client.setRequestHandler('elicitation/create', async () => ({
        action: 'accept',
        content: { confirm: true },
      }));
      const transfer = await srv.client.callTool({ name: 'transfer', arguments: { amount: 10 } });
      expect(transfer.structuredContent).toEqual({ transferred: 10.1, step: 2 });
      if (era === 'legacy') {
        const session = legacySession(srv.client);
        try {
          await runJobWithExtTasks(session);
        } finally {
          await session.close();
        }
      }
    } finally {
      await srv.stop();
    }
  });
});

describe('stdio 2026-07-28 tasks (raw JSON-RPC over the SDK stdio transport)', () => {
  it('starts, polls, cancels and reads a job task from the file store', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', tsxLoader, fixture],
      env: { ...minimalOsEnv(), ...childEnv(), MCP_TRANSPORT: 'stdio' },
      cwd: dirs.cwd,
      stderr: 'pipe',
    });
    const peer = await rawPeer(transport);
    try {
      const meta = () => modernMeta(TASKS_CAPS);
      const started = await peer.request('tools/call', {
        name: 'run_job',
        arguments: { label: 'stdio', steps: 3, stepMs: 30 },
        _meta: meta(),
      });
      expect(started.result).toMatchObject({ resultType: 'task', status: 'working' });
      const taskId = String(started.result?.taskId);
      let task: Record<string, unknown> = {};
      for (let i = 0; i < 200 && task.status !== 'completed'; i++) {
        task = (await peer.request('tasks/get', { taskId, _meta: meta() })).result ?? {};
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(task.result).toMatchObject({ structuredContent: { label: 'stdio', items: 9 } });
      const slow = await peer.request('tools/call', {
        name: 'run_job',
        arguments: { label: 'slow', steps: 100, stepMs: 50 },
        _meta: meta(),
      });
      const slowId = String(slow.result?.taskId);
      expect((await peer.request('tasks/cancel', { taskId: slowId, _meta: meta() })).error).toBeUndefined();
      expect((await peer.request('tasks/get', { taskId: slowId, _meta: meta() })).result?.status).toBe('cancelled');
    } finally {
      await peer.close();
    }
  });
});

describe.each<ProtocolEra>(['legacy', 'modern'])('HTTP (%s)', (era) => {
  it('resources, prompts and tasks through ext-tasks', async () => {
    const srv = await startBuiltServer({
      entry: fixture,
      nodeArgs: ['--import', tsxLoader],
      mode: 'http',
      era,
      env: childEnv(),
      cwd: dirs.cwd,
    });
    try {
      await checkResourcesPromptsAndState(srv.client);
      const session =
        era === 'legacy' ? legacySession(srv.client) : modernHttpSession(srv.client, String(srv.url), srv.apiKey);
      try {
        await runJobWithExtTasks(session);
      } finally {
        await session.close();
      }
      if (era === 'modern') {
        // The 2026-07-28 MRTR flow over stateless HTTP: every round may hit a fresh instance; the sealed
        // state carries the quote across them.
        const raw = rawHttpPeer(String(srv.url), srv.apiKey);
        const meta = modernMeta({ elicitation: { form: {} } });
        const first = await raw.request('tools/call', { name: 'transfer', arguments: { amount: 50 }, _meta: meta });
        expect(first.result?.resultType).toBe('input_required');
        const requestState = String(first.result?.requestState);
        expect(requestState.startsWith('ms1.')).toBe(true);
        const second = await raw.request('tools/call', {
          name: 'transfer',
          arguments: { amount: 50 },
          requestState,
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          _meta: meta,
        });
        expect(second.result?.structuredContent).toEqual({ transferred: 50.5, step: 2 });
        const forged = await raw.request('tools/call', {
          name: 'transfer',
          arguments: { amount: 50 },
          requestState: `${requestState.slice(0, -4)}AAAA`,
          _meta: meta,
        });
        expect(forged.error).toMatchObject({ code: -32602, message: 'Invalid or expired requestState' });
      }
      const listing = await srv.client.request({ method: 'resources/templates/list', params: {} }, z.looseObject({}));
      expect(Array.isArray(listing.resourceTemplates)).toBe(true);
    } finally {
      await srv.stop();
    }
  });
});
