/**
 * @novorb/mcp-core - Client input (elicitation, sampling, roots)
 *
 * Era-blind helpers over the SDK's multi-round-trip mechanism (MRTR, `inputRequired(...)`): a handler
 * asks for input by RETURNING an input-required result, and is re-entered with the client's answer in
 * `ctx.mcpReq.inputResponses`. This is how the SDK serves both eras from one handler:
 *
 * - 2026-07-28: the client fulfils the embedded requests and retries the call;
 * - 2025-era connections: the SDK's legacy shim (on by default) sends real server-to-client requests
 *   and re-enters the handler itself.
 *
 * Each helper first reads the answer for its `key`; when there is none it checks the client's declared
 * capability and answers either `{ status: 'pending', result }` (return `result` from the handler) or
 * `{ status: 'unsupported', reason }` (never a throw). Stateless HTTP serves every 2025-era request on
 * a fresh instance that never saw `initialize`, so no client capability is known there and every
 * helper answers `unsupported`; stdio and 2026-07-28 clients declare theirs.
 *
 * Sampling and roots are deprecated by the 2026-07-28 revision (SEP-2577) but remain functional for at
 * least twelve months; elicitation is not deprecated.
 */

import {
  acceptedContent,
  type ClientCapabilities,
  type CreateMessageRequestParams,
  type CreateMessageResult,
  type CreateMessageResultWithTools,
  type ElicitInputParams,
  type ElicitRequestURLParams,
  type InputRequest,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  PROTOCOL_VERSION_META_KEY,
  type Root,
  type ServerContext,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';

/** The protocol era of the request being handled. */
export type RequestEra = 'modern' | 'legacy';

/** The outcome of asking the client for input. */
export type InputOutcome<T> =
  /** The client answered (an accepted elicitation, a sampling result, the roots). */
  | { status: 'accepted'; value: T }
  /** The user declined the elicitation. */
  | { status: 'declined' }
  /** The user cancelled the elicitation. */
  | { status: 'cancelled' }
  /** An accepted elicitation whose content failed the requested schema. */
  | { status: 'invalid' }
  /** No answer yet: return `result` from the handler; the handler is re-entered with the answer. */
  | { status: 'pending'; result: InputRequiredResult }
  /** The client cannot answer (capability not declared, or no capability information at all). */
  | { status: 'unsupported'; reason: string };

/** Elicitation parameters whose `requestedSchema` is a Standard Schema (the content is validated). */
export type TypedElicitParams<S extends StandardSchemaWithJSON> = Omit<ElicitInputParams, 'requestedSchema'> & {
  requestedSchema: S;
};

export type ClientFeature = 'elicitation' | 'elicitation.url' | 'sampling' | 'roots';

/** The era of a request: modern when it carries the 2026-07-28 per-request envelope. */
export function requestEra(sdk: ServerContext): RequestEra {
  const envelope = sdk.mcpReq.envelope as Record<string, unknown> | undefined;
  return envelope?.[PROTOCOL_VERSION_META_KEY] !== undefined ? 'modern' : 'legacy';
}

/** Whether `caps` declares `feature`. A bare `elicitation: {}` means form mode only (2025-11-25). */
export function supportsClientFeature(caps: ClientCapabilities | undefined, feature: ClientFeature): boolean {
  if (!caps) return false;
  const elicitation = caps.elicitation as { form?: unknown; url?: unknown } | undefined;
  switch (feature) {
    case 'elicitation':
      return elicitation !== undefined && (elicitation.form !== undefined || elicitation.url === undefined);
    case 'elicitation.url':
      return elicitation?.url !== undefined;
    case 'sampling':
      return caps.sampling !== undefined;
    case 'roots':
      return caps.roots !== undefined;
  }
}

function unsupported(feature: ClientFeature, caps: ClientCapabilities | undefined): InputOutcome<never> {
  const reason =
    caps === undefined
      ? `${feature} is not supported by this client: no client capabilities are known for this request (stateless HTTP 2025-era requests carry none)`
      : `${feature} is not supported by this client: it did not declare the ${feature} capability`;
  return { status: 'unsupported', reason };
}

function pending(key: string, request: InputRequest): InputOutcome<never> {
  return { status: 'pending', result: inputRequired({ inputRequests: { [key]: request } }) };
}

function isStandardSchema(value: unknown): value is StandardSchemaWithJSON {
  return typeof value === 'object' && value !== null && '~standard' in value;
}

/** The per-request client input helpers; `caps` is the client's declared capabilities. */
export interface ClientInput {
  elicit<S extends StandardSchemaWithJSON>(
    key: string,
    params: TypedElicitParams<S>,
  ): InputOutcome<StandardSchemaWithJSON.InferOutput<S>>;
  elicit(key: string, params: ElicitInputParams): InputOutcome<Record<string, unknown>>;
  elicitUrl(key: string, params: Omit<ElicitRequestURLParams, 'mode' | 'elicitationId'>): InputOutcome<true>;
  sample(
    key: string,
    params: CreateMessageRequestParams,
  ): InputOutcome<CreateMessageResult | CreateMessageResultWithTools>;
  listRoots(key?: string): InputOutcome<Root[]>;
}

/** Build the helpers for one request. Without an SDK context every helper answers `unsupported`. */
export function createClientInput(sdk: ServerContext | undefined, caps: ClientCapabilities | undefined): ClientInput {
  const responses = sdk?.mcpReq.inputResponses;
  const known = sdk ? caps : undefined;

  function elicit(key: string, params: ElicitInputParams): InputOutcome<unknown> {
    const view = inputResponse(responses, key);
    if (view.kind === 'elicit') {
      if (view.action === 'decline') return { status: 'declined' };
      if (view.action === 'cancel') return { status: 'cancelled' };
      if (isStandardSchema(params.requestedSchema)) {
        const value: unknown = acceptedContent(responses, key, params.requestedSchema);
        return value === undefined ? { status: 'invalid' } : { status: 'accepted', value };
      }
      return { status: 'accepted', value: view.content ?? {} };
    }
    if (!supportsClientFeature(known, 'elicitation')) return unsupported('elicitation', known);
    return pending(key, inputRequired.elicit(params));
  }

  return {
    elicit: elicit as ClientInput['elicit'],
    elicitUrl(key, params) {
      const view = inputResponse(responses, key);
      if (view.kind === 'elicit') {
        if (view.action === 'decline') return { status: 'declined' };
        if (view.action === 'cancel') return { status: 'cancelled' };
        return { status: 'accepted', value: true };
      }
      if (!supportsClientFeature(known, 'elicitation.url')) return unsupported('elicitation.url', known);
      return pending(key, inputRequired.elicitUrl(params));
    },
    sample(key, params) {
      const view = inputResponse(responses, key);
      if (view.kind === 'sampling') return { status: 'accepted', value: view.result };
      if (!supportsClientFeature(known, 'sampling')) return unsupported('sampling', known);
      return pending(key, inputRequired.createMessage(params));
    },
    listRoots(key = 'roots') {
      const view = inputResponse(responses, key);
      if (view.kind === 'roots') return { status: 'accepted', value: view.roots };
      if (!supportsClientFeature(known, 'roots')) return unsupported('roots', known);
      return pending(key, inputRequired.listRoots());
    },
  };
}
