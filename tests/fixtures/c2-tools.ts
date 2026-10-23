/**
 * The C2 feature fixture: resources (static + template + spill), prompts, a multi-step requestState
 * tool, runtime toggles and change notifications, and the backtest task tool, all over shared state.
 * Used in-process by the feature tests and spawned (c2-server.ts) by the stdio/HTTP round trips.
 */
import * as z from 'zod/v4';
import type { ServerNotifier } from '../../src/notifications.js';
import { createRuntimeSurface, type RuntimeSurface } from '../../src/notifications.js';
import { definePrompt, registerPrompts } from '../../src/prompts.js';
import type { RequestStateCodec } from '../../src/request-state.js';
import {
  createResultSpill,
  defineResource,
  defineResourceTemplate,
  type ResultSpill,
  registerResources,
  resourceLink,
} from '../../src/resources.js';
import { completable, createMcpServer, type McpServer, TOOL_ANNOTATIONS } from '../../src/server.js';
import type { ManagedTaskStore } from '../../src/task-store.js';
import { registerTaskTools } from '../../src/task-tools.js';
import { defineTool, registerTools, toolResult } from '../../src/tools.js';
import type { RequestContext } from '../../src/transport.js';
import { backtestTool, requiredTaskTool } from './backtest-tools.js';

export interface C2Shared {
  store: ManagedTaskStore;
  notify: ServerNotifier;
  surface: RuntimeSurface;
  spill: ResultSpill;
  docs: Map<string, string>;
  codec?: RequestStateCodec;
}

export function createC2Shared(store: ManagedTaskStore, notify: ServerNotifier, codec?: RequestStateCodec): C2Shared {
  return {
    store,
    notify,
    surface: createRuntimeSurface(notify),
    spill: createResultSpill({ ttlMs: 60_000 }),
    docs: new Map([
      ['readme.md', '# Readme\nhello'],
      ['notes.txt', 'some notes'],
    ]),
    ...(codec ? { codec } : {}),
  };
}

const confirmSchema = z.object({ confirm: z.boolean() });

export function buildC2Server(shared: C2Shared, req: RequestContext): McpServer {
  const server = createMcpServer('c2-fixture', '1.0.0', shared.codec ? { requestStateCodec: shared.codec } : {});
  registerTools(
    server,
    [
      defineTool({
        name: 'big_report',
        description: 'Returns a result over the byte limit (spilled to a resource)',
        inputSchema: z.object({ size: z.number().int().min(1) }),
        annotations: TOOL_ANNOTATIONS.readOnly,
        limits: { maxBytes: 1024 },
        handler: async ({ size }) => toolResult({ blob: 'x'.repeat(size) }),
      }),
      defineTool({
        name: 'link_doc',
        description: 'Points at a document resource instead of inlining it',
        inputSchema: z.object({ path: z.string() }),
        annotations: TOOL_ANNOTATIONS.readOnly,
        handler: async ({ path }) => ({
          content: [resourceLink({ uri: `docs://files/${path}`, name: path, mimeType: 'text/plain' })],
        }),
      }),
      defineTool({
        name: 'edit_doc',
        description: 'Changes a document and publishes resources/updated',
        inputSchema: z.object({ path: z.string(), text: z.string() }),
        annotations: TOOL_ANNOTATIONS.idempotentWrite,
        handler: async ({ path, text }) => {
          shared.docs.set(path, text);
          shared.notify.resourceUpdated(`docs://files/${path}`);
          return toolResult('edited');
        },
      }),
      defineTool({
        name: 'toggle',
        description: 'Enables or disables the optional tool at runtime',
        inputSchema: z.object({ enabled: z.boolean() }),
        annotations: TOOL_ANNOTATIONS.idempotentWrite,
        handler: async ({ enabled }) => {
          if (enabled) shared.surface.enable('tool', 'optional_tool');
          else shared.surface.disable('tool', 'optional_tool');
          return toolResult(`optional_tool ${enabled ? 'enabled' : 'disabled'}`);
        },
      }),
      defineTool({
        name: 'optional_tool',
        description: 'Can be disabled at runtime',
        inputSchema: z.object({}),
        annotations: TOOL_ANNOTATIONS.readOnly,
        handler: async () => toolResult('optional ran'),
      }),
      defineTool({
        name: 'transfer',
        description: 'A two-step flow: computes a quote, asks for confirmation, resumes from sealed state',
        inputSchema: z.object({ amount: z.number() }),
        annotations: TOOL_ANNOTATIONS.mutableWrite,
        handler: async ({ amount }, ctx) => {
          const state = ctx.requestState<{ quote: number; step: number }>();
          if (!state) {
            const quote = amount * 1.01;
            return ctx.continueWith(
              { quote, step: 1 },
              {
                confirm: {
                  method: 'elicitation/create',
                  params: {
                    mode: 'form',
                    message: `Transfer with fee, total ${quote}?`,
                    requestedSchema: {
                      type: 'object',
                      properties: { confirm: { type: 'boolean' } },
                      required: ['confirm'],
                    },
                  },
                },
              },
            );
          }
          const answer = ctx.elicit('confirm', { message: 'confirm', requestedSchema: confirmSchema });
          if (answer.status !== 'accepted' || !answer.value.confirm) return toolResult('cancelled');
          return toolResult({ transferred: state.quote, step: state.step + 1 });
        },
      }),
    ],
    { surface: shared.surface, onOversize: shared.spill.onOversize },
  );
  registerTaskTools(server, [backtestTool, requiredTaskTool], { store: shared.store, request: req });
  registerResources(
    server,
    [
      defineResource({
        name: 'readme',
        uri: 'docs://readme',
        title: 'Readme',
        mimeType: 'text/markdown',
        read: async () => shared.docs.get('readme.md') ?? '',
      }),
      defineResourceTemplate({
        name: 'file',
        uriTemplate: 'docs://files/{path}',
        mimeType: 'text/plain',
        list: async () => [...shared.docs.keys()].map((p) => ({ uri: `docs://files/${p}`, name: p })),
        complete: { path: (value) => [...shared.docs.keys()].filter((p) => p.startsWith(value)) },
        read: async ({ variables }) => {
          const doc = shared.docs.get(String(variables.path));
          if (doc === undefined) throw new Error(`no such document: ${String(variables.path)}`);
          return doc;
        },
      }),
      shared.spill.resource,
    ],
    { subscribe: true, request: req, surface: shared.surface },
  );
  registerPrompts(
    server,
    [
      definePrompt({
        name: 'summarise',
        description: 'Summarise a document',
        argsSchema: z.object({
          path: completable(z.string(), (value) => [...shared.docs.keys()].filter((p) => p.startsWith(value))),
        }),
        handler: async ({ path }) => `Summarise ${path}`,
      }),
    ],
    { surface: shared.surface },
  );
  return server;
}
