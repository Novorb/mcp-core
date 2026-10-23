/**
 * @novorb/mcp-core - Express adapter peer loading (internal)
 *
 * `express` and `@modelcontextprotocol/express` are OPTIONAL peer dependencies: a stdio-only or
 * standalone `node:http` server never installs them (pnpm and npm would otherwise auto-install express,
 * which `@modelcontextprotocol/express` declares as a required peer, into every consumer). Only the
 * `./express` and `./sdk/express` subpaths load them, lazily, through this module; when they are absent
 * those subpaths fail at import with `ExpressAdapterUnavailableError` and a clear install hint.
 */

import type * as ExpressAdapter from '@modelcontextprotocol/express';
import type * as ExpressModule from 'express';

/** The two optional peers, as loaded. */
export interface ExpressPeers {
  express: typeof ExpressModule.default;
  adapter: typeof ExpressAdapter;
}

export const EXPRESS_PEERS_MISSING =
  'install express and @modelcontextprotocol/express to use the Express adapter ' +
  '(for example `pnpm add express @modelcontextprotocol/express`); they are optional peer dependencies of @novorb/mcp-core';

/** Thrown by the Express subpaths when the optional peers are not installed. */
export class ExpressAdapterUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(`[mcp-core] ${EXPRESS_PEERS_MISSING}`, cause === undefined ? undefined : { cause });
    this.name = 'ExpressAdapterUnavailableError';
  }
}

/** The default importer: the two packages as installed next to mcp-core. */
export async function importExpressPeers(): Promise<ExpressPeers> {
  const [expressModule, adapter] = await Promise.all([import('express'), import('@modelcontextprotocol/express')]);
  return { express: expressModule.default, adapter };
}

/**
 * Load the optional peers (`importer` is a test seam). Any import failure becomes an
 * `ExpressAdapterUnavailableError` naming both packages.
 */
export async function loadExpressPeers(
  importer: () => Promise<ExpressPeers> = importExpressPeers,
): Promise<ExpressPeers> {
  try {
    return await importer();
  } catch (err) {
    throw new ExpressAdapterUnavailableError(err);
  }
}
