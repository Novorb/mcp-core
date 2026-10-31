/**
 * A fake long-running task tool: runs `steps` steps of `stepMs`, reports progress, honours cancellation,
 * and returns a result. Shared by the in-process task tests and the spawned task fixture server.
 */
import * as z from 'zod/v4';
import { createMcpServer, TOOL_ANNOTATIONS } from '../../src/server.js';
import type { ManagedTaskStore } from '../../src/task-store.js';
import { defineTaskTool, registerTaskTools } from '../../src/task-tools.js';
import { toolResult } from '../../src/tools.js';
import type { RequestContext } from '../../src/transport.js';

export const jobTool = defineTaskTool({
  name: 'run_job',
  description: 'Run a (fake) job; long-running, reports progress, can be cancelled',
  inputSchema: z.object({
    label: z.string(),
    steps: z.number().int().min(1).max(100).default(5),
    stepMs: z.number().int().min(0).max(5000).default(50),
    fail: z.boolean().optional(),
  }),
  annotations: TOOL_ANNOTATIONS.mutableWrite,
  pollIntervalMs: 20,
  run: async ({ label, steps, stepMs, fail }, task) => {
    for (let i = 1; i <= steps; i++) {
      task.signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, stepMs));
      await task.progress(i, steps, 'simulating');
    }
    if (fail) throw new Error('job runner rejected the input');
    return toolResult({ label, items: steps * 3, mode: task.mode });
  },
});

export const requiredTaskTool = defineTaskTool({
  name: 'run_only_as_task',
  description: 'Refuses clients without task support',
  inputSchema: z.object({}),
  annotations: TOOL_ANNOTATIONS.mutableWrite,
  taskSupport: 'required',
  run: async () => toolResult('ran'),
});

/** A factory serving the job tools over a shared store. */
export function buildJobServer(store: ManagedTaskStore) {
  return (req: RequestContext) => {
    const server = createMcpServer('job-fixture', '1.0.0');
    registerTaskTools(server, [jobTool, requiredTaskTool], { store, request: req });
    return server;
  };
}
