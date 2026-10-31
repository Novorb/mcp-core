/**
 * @novorb/mcp-core - HTTP auth
 *
 * mcp-core's HTTP auth runs on the SDK's resource-server gate: `verifyBearerToken` parses the
 * `Authorization` header, calls an `OAuthTokenVerifier`, checks `expectedResource`, `requiredScopes` and
 * the expiry, and `bearerAuthChallengeResponse` maps a failure to the 401 / 403 OAuth error with its
 * `WWW-Authenticate` challenge. The verified `AuthInfo` is set as `req.auth`, which the SDK forwards to
 * the server factory (`RequestContext.authInfo`) and to handlers (`ctx.http.authInfo`), so per-tool
 * `scopeChallenge` / `requireScopes(...)` gates work.
 *
 * The static `MCP_API_KEY` is one verifier (`apiKeyVerifier`): a constant-time comparison (SHA-256 of
 * both sides, `timingSafeEqual`) that answers an `AuthInfo` whose `token` is a placeholder, never the
 * key. A host can pass its own verifier (for example one checking OAuth JWTs) instead.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  type VerifyBearerTokenOptions,
  verifyBearerToken,
} from '@modelcontextprotocol/server';

/** The `AuthInfo.token` the API-key verifier reports: never the real key. */
export const API_KEY_TOKEN_PLACEHOLDER = '[api-key]';

/** How long an API-key `AuthInfo` is valid (the SDK refuses tokens without `expiresAt`). */
export const API_KEY_TTL_SECONDS = 3600;

export interface ApiKeyVerifierOptions {
  /** `AuthInfo.clientId` (default `api-key`). */
  clientId?: string;
  /** `AuthInfo.scopes` granted by the key (default none). */
  scopes?: string[];
  /** `AuthInfo.expiresAt` = now + this (default 3600 s). */
  ttlSeconds?: number;
}

/** Options for the HTTP auth gate (transport and Express adapter). */
export interface HttpAuthOptions {
  /** A token verifier (for example a JWT verifier). When set it replaces the static API key. */
  verifier?: OAuthTokenVerifier;
  /** Scopes every request must carry (403 `insufficient_scope` otherwise). */
  requiredScopes?: string[];
  /** RFC 9728 Protected Resource Metadata URL advertised in challenges. */
  resourceMetadataUrl?: string;
  /** Accept only tokens issued for this resource (audience). */
  expectedResource?: URL;
  /** `AuthInfo` fields for the static API key. */
  apiKey?: ApiKeyVerifierOptions;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** A verifier for one static key, compared in constant time. The returned `AuthInfo` never holds the key. */
export function apiKeyVerifier(apiKey: string, options: ApiKeyVerifierOptions = {}): OAuthTokenVerifier {
  if (apiKey.length === 0) throw new Error('apiKeyVerifier: the API key must not be empty');
  const expected = digest(apiKey);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (!timingSafeEqual(digest(token), expected)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid token');
      }
      return {
        token: API_KEY_TOKEN_PLACEHOLDER,
        clientId: options.clientId ?? 'api-key',
        scopes: [...(options.scopes ?? [])],
        expiresAt: Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? API_KEY_TTL_SECONDS),
      };
    },
  };
}

/** The SDK bearer options for a gate: the explicit verifier, else the API key, else none (open). */
export function bearerOptions(
  auth: HttpAuthOptions | undefined,
  apiKey: string | undefined,
): VerifyBearerTokenOptions | undefined {
  const verifier = auth?.verifier ?? (apiKey ? apiKeyVerifier(apiKey, auth?.apiKey) : undefined);
  if (!verifier) return undefined;
  return {
    verifier,
    ...(auth?.requiredScopes ? { requiredScopes: auth.requiredScopes } : {}),
    ...(auth?.resourceMetadataUrl ? { resourceMetadataUrl: auth.resourceMetadataUrl } : {}),
    ...(auth?.expectedResource ? { expectedResource: auth.expectedResource } : {}),
  };
}

export type AuthOutcome = { ok: true; authInfo: AuthInfo } | { ok: false; response: Response };

/** Verify an `Authorization` header value; a failure carries the SDK's ready-made challenge response. */
export async function authenticate(
  header: string | undefined,
  options: VerifyBearerTokenOptions,
): Promise<AuthOutcome> {
  try {
    return { ok: true, authInfo: await verifyBearerToken(header, options) };
  } catch (error) {
    return { ok: false, response: bearerAuthChallengeResponse(error, options) };
  }
}

/** Write a web `Response` (status, headers, body) to a Node response. */
export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await response.text();
  res.writeHead(response.status, headers);
  res.end(body);
}
