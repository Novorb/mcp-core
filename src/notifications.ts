/**
 * @novorb/mcp-core - Change notifications (list changed, resource updated) and the server event bus
 *
 * The SDK sources change events from a `ServerEventBus` (`publish` / `subscribe`): `createMcpHandler`
 * serves 2026-07-28 `subscriptions/listen` streams from it (ack, filtering and subscription ids are the
 * SDK's). mcp-core makes that bus process-wide and connects it to every transport, so one call reaches
 * every connection this process serves:
 *
 *   const notify = createNotifier();           // or ctx.notify in runMcpServer's setup
 *   notify.toolsChanged();                      // notifications/tools/list_changed
 *   notify.resourceUpdated('gitlab://repo/README.md');
 *
 * Delivery per era (what the SDK can carry; mcp-core adds no transport of its own):
 *
 * | Connection | Delivery |
 * |---|---|
 * | HTTP, 2026-07-28 | `subscriptions/listen` SSE streams on this process (the SDK listen router filters by the client's honored filter) |
 * | stdio, 2026-07-28 | the pinned instance's change notifications, rewritten by the SDK onto the connection's open subscriptions |
 * | stdio, 2025-era | unsolicited notifications on the connection; `resources/updated` only for URIs the client subscribed to |
 * | HTTP, 2025-era stateless | none: every request is answered by a fresh instance and the standalone GET stream is 405, so there is no channel |
 *
 * Multi-instance hosts replace the in-memory bus with a shared one (`setProcessBus`, or `bus` on the
 * transport options). A shared `ServerEventBus` implementation must: fan `publish(event)` out to the
 * listeners of EVERY instance (its own included); return an idempotent unsubscribe from `subscribe`;
 * never throw from `publish` (a failing listener must not stop the others); never echo an event back
 * to the listener that published it from inside that listener; and carry the event value as is
 * (`{ kind }` or `{ kind: 'resource_updated', uri }`, JSON-serialisable). No persistence or replay is
 * needed: listen streams are live and a client re-lists after reconnecting. Events are not addressed to
 * a caller: every open stream that opted in receives them (the SDK event has no principal).
 */

import {
  InMemoryServerEventBus,
  McpServer,
  type Server,
  type ServerEvent,
  type ServerEventBus,
  type ServerNotifier,
} from '@modelcontextprotocol/server';
import { getLogger } from './utils/logger.js';

export type { ServerEvent, ServerEventBus, ServerNotifier } from '@modelcontextprotocol/server';
export { InMemoryServerEventBus } from '@modelcontextprotocol/server';

function reportListenerError(error: Error): void {
  getLogger().warn(`notification listener failed: ${error.message}`, 'Notifications');
}

let current: ServerEventBus | undefined;

/** The process-wide bus every mcp-core transport uses by default (in memory unless replaced). */
export function processBus(): ServerEventBus {
  current ??= new InMemoryServerEventBus(reportListenerError);
  return current;
}

/**
 * Replace the process bus (a shared pub/sub on multi-instance hosts). Call it before starting the
 * transport; `undefined` restores a fresh in-memory bus on next use.
 */
export function setProcessBus(bus: ServerEventBus | undefined): void {
  current = bus;
}

/** The typed publish facade over a bus (the same shape as the SDK's `handler.notify`). */
export function createNotifier(bus: ServerEventBus = processBus()): ServerNotifier {
  return {
    toolsChanged: () => bus.publish({ kind: 'tools_list_changed' }),
    promptsChanged: () => bus.publish({ kind: 'prompts_list_changed' }),
    resourcesChanged: () => bus.publish({ kind: 'resources_list_changed' }),
    resourceUpdated: (uri: string) => bus.publish({ kind: 'resource_updated', uri }),
  };
}

const SUBSCRIPTIONS = Symbol.for('@novorb/mcp-core/resourceSubscriptions');

type WithSubscriptions = Server & { [SUBSCRIPTIONS]?: Set<string> };

function lowLevel(server: McpServer | Server): Server {
  return server instanceof McpServer ? server.server : server;
}

/** The URIs a 2025-era client subscribed to on this instance (`resources/subscribe`). */
export function resourceSubscriptions(server: McpServer | Server): Set<string> {
  const target = lowLevel(server) as WithSubscriptions;
  target[SUBSCRIPTIONS] ??= new Set<string>();
  return target[SUBSCRIPTIONS];
}

function send(server: Server, event: ServerEvent, era: 'legacy' | 'modern'): Promise<void> | undefined {
  switch (event.kind) {
    case 'tools_list_changed':
      return server.sendToolListChanged();
    case 'prompts_list_changed':
      return server.sendPromptListChanged();
    case 'resources_list_changed':
      return server.sendResourceListChanged();
    case 'resource_updated':
      // On a 2025-era connection only subscribed URIs are sent; on 2026-07-28 the SDK router filters.
      if (era === 'legacy' && !resourceSubscriptions(server).has(event.uri)) return undefined;
      return server.sendResourceUpdated({ uri: event.uri });
  }
}

/**
 * Forward bus events to a long-lived instance (a stdio connection): each event becomes the instance's
 * own change notification. Detaches when the instance closes; returns the detach function. A send that
 * fails (not connected, capability not advertised) is dropped: notifications never fail the server.
 */
export function attachNotifications(
  server: McpServer | Server,
  era: 'legacy' | 'modern',
  bus: ServerEventBus = processBus(),
): () => void {
  const target = lowLevel(server);
  const unsubscribe = bus.subscribe((event) => {
    try {
      send(target, event, era)?.catch(() => undefined);
    } catch {
      // A notification the instance cannot send (capability not advertised) is dropped.
    }
  });
  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    unsubscribe();
  };
  const previous = target.onclose;
  target.onclose = () => {
    detach();
    previous?.();
  };
  return detach;
}

/** The kinds of primitive a runtime surface can enable or disable. */
export type SurfaceKind = 'tool' | 'prompt' | 'resource';

export interface RuntimeSurface {
  /** Whether `name` is enabled (everything is, until disabled). */
  isEnabled(kind: SurfaceKind, name: string): boolean;
  /** Enable `name` and publish the matching list-changed event (no-op when already enabled). */
  enable(kind: SurfaceKind, name: string): void;
  /** Disable `name` and publish the matching list-changed event (no-op when already disabled). */
  disable(kind: SurfaceKind, name: string): void;
  /** Observe changes (registerTools / registerResources / registerPrompts use it); returns unsubscribe. */
  subscribe(listener: (kind: SurfaceKind, name: string, enabled: boolean) => void): () => void;
}

/**
 * Process-level enable/disable state for tools, prompts and resources, so a runtime change works the
 * same in both serving models: per-request HTTP instances read it when they are built, live stdio
 * instances have their SDK handles toggled in place, and ONE list-changed event goes out on the bus.
 * Pass it as `surface` to `registerTools` / `registerResources` / `registerPrompts`.
 */
export function createRuntimeSurface(notifier: ServerNotifier = createNotifier()): RuntimeSurface {
  const disabled = new Set<string>();
  const listeners = new Set<(kind: SurfaceKind, name: string, enabled: boolean) => void>();
  const key = (kind: SurfaceKind, name: string): string => `${kind}\0${name}`;
  const publish = (kind: SurfaceKind): void => {
    if (kind === 'tool') notifier.toolsChanged();
    else if (kind === 'prompt') notifier.promptsChanged();
    else notifier.resourcesChanged();
  };
  const set = (kind: SurfaceKind, name: string, enabled: boolean): void => {
    const k = key(kind, name);
    if (enabled === !disabled.has(k)) return;
    if (enabled) disabled.delete(k);
    else disabled.add(k);
    for (const listener of [...listeners]) listener(kind, name, enabled);
    publish(kind);
  };
  return {
    isEnabled: (kind, name) => !disabled.has(key(kind, name)),
    enable: (kind, name) => set(kind, name, true),
    disable: (kind, name) => set(kind, name, false),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Bind one SDK handle (a registered tool, prompt, resource or template) to a surface: its `enabled`
 * flag follows the surface, set directly so the instance itself sends no list-changed notification
 * (the surface publishes exactly one on the bus). The binding is released when the instance closes.
 */
export function bindToSurface(
  server: McpServer,
  surface: RuntimeSurface,
  kind: SurfaceKind,
  name: string,
  handle: { enabled: boolean },
): void {
  handle.enabled = surface.isEnabled(kind, name);
  const unsubscribe = surface.subscribe((k, n, enabled) => {
    if (k === kind && n === name) handle.enabled = enabled;
  });
  const target = server.server;
  const previous = target.onclose;
  target.onclose = () => {
    unsubscribe();
    previous?.();
  };
}
