/**
 * @novorb/mcp-core - Errors for primitives answered with JSON-RPC errors (resources, prompts)
 *
 * Tools answer failures in-band (`isError` results). `resources/read` and `prompts/get` have no such
 * result shape, so their failures are JSON-RPC errors: a `ProtocolError` the handler throws is kept
 * (its code), anything else becomes `-32603` with the `mapError` text. Every message is passed through
 * `maskClientText` (secrets redacted, registered secret values masked), exactly like tool errors.
 */

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { defaultMapError, type MappedToolError, maskClientText } from './tools.js';

/** The `mapError` signature shared with `registerTools`. */
export type MapError = (err: unknown) => MappedToolError;

/** A thrown handler error as the JSON-RPC error a client receives (masked, never a stack). */
export function toProtocolError(err: unknown, mapError: MapError = defaultMapError): ProtocolError {
  if (ProtocolError.isInstance(err)) {
    if (err.code === ProtocolErrorCode.UrlElicitationRequired) return err;
    return new ProtocolError(err.code, maskClientText(err.message), err.data);
  }
  let mapped: MappedToolError;
  try {
    mapped = mapError(err);
  } catch {
    mapped = { message: 'Internal error' };
  }
  const text = mapped.code ? `${mapped.code}: ${mapped.message}` : mapped.message;
  return new ProtocolError(ProtocolErrorCode.InternalError, maskClientText(text));
}
