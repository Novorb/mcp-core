/**
 * @novorb/mcp-core - The credential report on a tool result
 *
 * `registerTools` appends the report of a call's credentials (see `credentials.ts`) to every result
 * that touched one, in three shapes:
 *
 * - a short text block the model reads: `Credentials: A used; B degraded (quota, retry in 60s)`;
 * - `_meta[CREDENTIALS_META_KEY]`: the same entries, machine-readable;
 * - `structuredContent.credentials`, when the result has an object `structuredContent`. The tool's
 *   outputSchema gets that optional field automatically (`withCredentialsField`), unless the schema
 *   already declares its own `credentials` property (then only the text and `_meta` carry the report).
 *
 * Key names only, never values; the text passes the client masking.
 */

import type { CallToolResult, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { CREDENTIAL_STATUSES, type CredentialReportEntry, formatCredentialReport } from './credentials.js';

/** The `_meta` key of the machine-readable report. */
export const CREDENTIALS_META_KEY = 'io.novorb/credentials';

/** The field name added to `structuredContent` and to the output schema. */
export const CREDENTIALS_FIELD = 'credentials';

/** JSON Schema of the `credentials` field. */
export const CREDENTIALS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'array',
  description: 'Credentials this call used, and the ones it found degraded, invalid or expired (key names only)',
  items: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      status: { type: 'string', enum: [...CREDENTIAL_STATUSES] },
      used: { type: 'boolean' },
      reason: { type: 'string' },
      retryInSeconds: { type: 'number' },
    },
    required: ['key', 'status', 'used'],
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the listed output JSON Schema can carry the field: an object root (no `type`, or `object`)
 * with a `properties` map that does not already declare `credentials`.
 */
function extensible(schema: StandardSchemaWithJSON): boolean {
  try {
    const json = schema['~standard'].jsonSchema.output({ target: 'draft-2020-12' });
    const objectRoot = json.type === undefined || json.type === 'object';
    return objectRoot && isPlainObject(json.properties) && !(CREDENTIALS_FIELD in json.properties);
  } catch {
    return false;
  }
}

/**
 * The output schema plus an optional `credentials` field: validation strips the field before the
 * tool's own schema sees it (so strict schemas keep passing) and the listed JSON Schema declares it.
 * Returned UNCHANGED (the same object) when the listed schema cannot declare it: it already has its own
 * `credentials`, or its root is not an object with `properties` (a record root, `allOf`, `$ref`). Such
 * tools get the report in text and `_meta` only, never in `structuredContent`.
 */
export function withCredentialsField(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  if (!extensible(schema)) return schema;
  const std = schema['~standard'];
  type Validate = typeof std.validate;
  type Result = Awaited<ReturnType<Validate>>;
  const restore = (result: Result, credentials: unknown): Result =>
    result.issues !== undefined || !isPlainObject(result.value)
      ? result
      : { value: { ...result.value, [CREDENTIALS_FIELD]: credentials } };
  const validate: Validate = (value, options) => {
    if (!isPlainObject(value) || !(CREDENTIALS_FIELD in value)) return std.validate(value, options);
    const { [CREDENTIALS_FIELD]: credentials, ...rest } = value;
    const result = std.validate(rest, options);
    return result instanceof Promise ? result.then((r) => restore(r, credentials)) : restore(result, credentials);
  };
  return {
    '~standard': {
      version: 1,
      vendor: std.vendor,
      ...(std.types !== undefined ? { types: std.types } : {}),
      validate,
      jsonSchema: {
        input: (options) => std.jsonSchema.input(options),
        output: (options) => {
          const json = std.jsonSchema.output(options);
          if (!isPlainObject(json.properties)) return json;
          return { ...json, properties: { ...json.properties, [CREDENTIALS_FIELD]: CREDENTIALS_JSON_SCHEMA } };
        },
      },
    },
  };
}

/** Every copy of the entries goes through the same masking as the text block. */
function maskedEntries(
  entries: readonly CredentialReportEntry[],
  mask: (text: string) => string,
): CredentialReportEntry[] {
  return entries.map((e) => ({
    ...e,
    key: mask(e.key),
    ...(e.reason !== undefined ? { reason: mask(e.reason) } : {}),
  }));
}

/** The serialized size the report adds to a result (text block, `_meta`, and `structuredContent` when structured). */
export function credentialReportBytes(entries: readonly CredentialReportEntry[], structured: boolean): number {
  if (entries.length === 0) return 0;
  const text = Buffer.byteLength(JSON.stringify({ type: 'text', text: formatCredentialReport(entries) }));
  const meta = Buffer.byteLength(JSON.stringify({ [CREDENTIALS_META_KEY]: entries }));
  return text + meta + (structured ? Buffer.byteLength(JSON.stringify({ [CREDENTIALS_FIELD]: entries })) : 0) + 16;
}

/**
 * Append the report to a result: the text block, `_meta`, and `structuredContent.credentials` when
 * `structured` (the listed output schema declares it) and the result has object structured content.
 * Every copy (text, `_meta`, structured) passes `mask`. No entries = the result unchanged.
 */
export function attachCredentialReport(
  result: CallToolResult,
  entries: readonly CredentialReportEntry[],
  options: { structured: boolean; mask: (text: string) => string },
): CallToolResult {
  if (entries.length === 0) return result;
  const masked = maskedEntries(entries, options.mask);
  const out: CallToolResult = {
    ...result,
    content: [...result.content, { type: 'text', text: options.mask(formatCredentialReport(masked)) }],
    _meta: { ...(result._meta ?? {}), [CREDENTIALS_META_KEY]: masked.map((e) => ({ ...e })) },
  };
  if (
    options.structured &&
    isPlainObject(result.structuredContent) &&
    !(CREDENTIALS_FIELD in result.structuredContent)
  ) {
    out.structuredContent = { ...result.structuredContent, [CREDENTIALS_FIELD]: masked.map((e) => ({ ...e })) };
  }
  return out;
}

/** The report on a result that has no content (an input-required result): `_meta` only, masked. */
export function attachCredentialMeta<R extends { _meta?: Record<string, unknown> }>(
  result: R,
  entries: readonly CredentialReportEntry[],
  mask: (text: string) => string,
): R {
  if (entries.length === 0) return result;
  return { ...result, _meta: { ...(result._meta ?? {}), [CREDENTIALS_META_KEY]: maskedEntries(entries, mask) } };
}
