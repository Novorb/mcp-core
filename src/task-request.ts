/**
 * @novorb/mcp-core - The `tools/call` request's task augmentation (internal)
 *
 * A 2025-11-25 client asks for task execution with `params.task` on `tools/call`; McpServer hands a
 * tool callback only the validated arguments and the context, not the params. mcp-core decorates the
 * instance's public `Server.setRequestHandler` (the same documented low-level hook list pagination
 * uses) so the installed `tools/call` handler runs inside an AsyncLocalStorage scope that carries
 * `params.task`; task tools read it with `currentTaskAugmentation()`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server } from '@modelcontextprotocol/server';

/** The 2025-11-25 `params.task` of a task-augmented request. */
export interface TaskAugmentation {
  /** Requested retention in ms. */
  ttl?: number;
}

const scope = new AsyncLocalStorage<{ task?: TaskAugmentation }>();
const CAPTURED = Symbol.for('@novorb/mcp-core/taskAugmentation');

type ToolCallHandler = (request: { params?: { task?: unknown } }, ctx: unknown) => unknown;

function augmentation(value: unknown): TaskAugmentation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const ttl = (value as { ttl?: unknown }).ttl;
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0 ? { ttl } : {};
}

/** Decorate `server` so the `tools/call` handler installed from now on sees `params.task`. Idempotent. */
export function captureTaskAugmentation(server: Server): void {
  const target = server as unknown as Record<PropertyKey, unknown> & {
    setRequestHandler: (method: string, ...rest: unknown[]) => void;
  };
  if (target[CAPTURED]) return;
  target[CAPTURED] = true;
  const original = target.setRequestHandler.bind(server) as (method: string, ...rest: unknown[]) => void;
  target.setRequestHandler = (method: string, ...rest: unknown[]): void => {
    const handler = rest[0];
    if (method === 'tools/call' && rest.length === 1 && typeof handler === 'function') {
      const wrapped: ToolCallHandler = (request, ctx) => {
        const task = augmentation(request.params?.task);
        return scope.run(task ? { task } : {}, () => (handler as ToolCallHandler)(request, ctx));
      };
      original(method, wrapped);
      return;
    }
    original(method, ...rest);
  };
}

/** The current `tools/call`'s task augmentation (2025-11-25), or undefined when it has none. */
export function currentTaskAugmentation(): TaskAugmentation | undefined {
  return scope.getStore()?.task;
}
