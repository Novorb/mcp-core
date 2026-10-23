/**
 * @novorb/mcp-core SDK re-export of `@modelcontextprotocol/express` (every runtime export and type).
 * Consumers import the SDK only through mcp-core; see README "The SDK through mcp-core".
 *
 * `@modelcontextprotocol/express` and `express` are optional peers: this subpath loads them lazily and
 * fails at import with `ExpressAdapterUnavailableError` when either is not installed.
 */
import { loadExpressPeers } from '../express-peers.js';

const { adapter } = await loadExpressPeers();

export type {
  AuthMetadataOptions,
  BearerAuthMiddlewareOptions,
  CreateMcpExpressAppOptions,
  OAuthTokenVerifier,
} from '@modelcontextprotocol/express';
export const {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  mcpAuthMetadataRouter,
  originValidation,
  requireBearerAuth,
} = adapter;
