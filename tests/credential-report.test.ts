import { describe, expect, it } from '@jest/globals';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  attachCredentialMeta,
  attachCredentialReport,
  CREDENTIALS_JSON_SCHEMA,
  CREDENTIALS_META_KEY,
  credentialReportBytes,
  withCredentialsField,
} from '../src/credential-report.js';
import type { CredentialReportEntry } from '../src/credentials.js';

const target = { target: 'draft-2020-12' } as const;
const entries: CredentialReportEntry[] = [
  { key: 'A', status: 'valid', used: true },
  { key: 'B', status: 'degraded', used: false, reason: 'quota', retryInSeconds: 9 },
];

function custom(
  output: Record<string, unknown>,
  validate: StandardSchemaWithJSON['~standard']['validate'] = (value) => ({ value }),
): StandardSchemaWithJSON {
  return {
    '~standard': { version: 1, vendor: 'custom', validate, jsonSchema: { input: () => output, output: () => output } },
  };
}

describe('withCredentialsField', () => {
  it('lists an optional credentials property and validates a strict schema with it present', async () => {
    const wrapped = withCredentialsField(z.strictObject({ n: z.number() }));
    const json = wrapped['~standard'].jsonSchema.output(target);
    expect((json.properties as Record<string, unknown>).credentials).toEqual(CREDENTIALS_JSON_SCHEMA);
    expect(json.required).toEqual(['n']);
    expect(wrapped['~standard'].jsonSchema.input(target)).toEqual(
      z.strictObject({ n: z.number() })['~standard'].jsonSchema.input(target),
    );
    expect(await wrapped['~standard'].validate({ n: 1, credentials: entries })).toEqual({
      value: { n: 1, credentials: entries },
    });
    expect(await wrapped['~standard'].validate({ n: 1 })).toEqual({ value: { n: 1 } });
    const bad = await wrapped['~standard'].validate({ n: 'x', credentials: entries });
    expect(bad.issues?.length).toBeGreaterThan(0);
    expect(wrapped['~standard'].vendor).toBe('zod');
  });

  it('supports an async validator on an object root', async () => {
    const wrapped = withCredentialsField(
      custom({ type: 'object', properties: { v: { type: 'number' } } }, async (value) => ({
        value: { v: (value as { v: number }).v },
      })),
    );
    expect(await wrapped['~standard'].validate({ v: 2, credentials: [] })).toEqual({
      value: { v: 2, credentials: [] },
    });
    expect(await wrapped['~standard'].validate('raw')).toEqual({ value: { v: undefined } });
  });

  it('returns the SAME schema when the listed JSON cannot declare the field (so no structured report)', () => {
    const own = z.object({ credentials: z.string() });
    expect(withCredentialsField(own)).toBe(own);
    for (const schema of [
      custom({ type: 'object', additionalProperties: { type: 'number' } }),
      custom({ allOf: [{ $ref: '#/$defs/x' }] }),
      custom({ type: 'number' }),
      custom({ type: 'array', properties: { a: {} } }),
      z.record(z.string(), z.number()),
    ]) {
      expect(withCredentialsField(schema)).toBe(schema);
    }
    const broken: StandardSchemaWithJSON = {
      '~standard': {
        version: 1,
        vendor: 'custom',
        validate: (value) => ({ value }),
        jsonSchema: {
          input: () => ({}),
          output: () => {
            throw new Error('no json');
          },
        },
      },
    };
    expect(withCredentialsField(broken)).toBe(broken);
  });
});

describe('attachCredentialReport', () => {
  const mask = (t: string): string => t;

  it('appends the text block, _meta and (when structured) the field; keeps existing _meta', () => {
    const out = attachCredentialReport(
      { content: [{ type: 'text', text: 'x' }], structuredContent: { n: 1 }, _meta: { other: 1 } },
      entries,
      { structured: true, mask },
    );
    expect(out.content.at(-1)).toEqual({ type: 'text', text: 'Credentials: A used; B degraded (quota, retry in 9s)' });
    expect(out._meta).toEqual({ other: 1, [CREDENTIALS_META_KEY]: entries });
    expect(out.structuredContent).toEqual({ n: 1, credentials: entries });
  });

  it('masks every copy: text, _meta and structuredContent', () => {
    const secret = 'leaked-value-0123456789';
    const out = attachCredentialReport(
      { content: [], structuredContent: { n: 1 } },
      [{ key: secret, status: 'invalid', used: true, reason: `bad ${secret}` }],
      { structured: true, mask: (t) => t.split(secret).join('[SECRET]') },
    );
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out._meta?.[CREDENTIALS_META_KEY]).toEqual([
      { key: '[SECRET]', status: 'invalid', used: true, reason: 'bad [SECRET]' },
    ]);
  });

  it('no structured field when not structured, absent, or already present; no entries = unchanged', () => {
    const base = { content: [], structuredContent: { n: 1 } };
    expect(attachCredentialReport(base, entries, { structured: false, mask }).structuredContent).toEqual({ n: 1 });
    expect(
      attachCredentialReport({ content: [] }, entries, { structured: true, mask }).structuredContent,
    ).toBeUndefined();
    const taken = { content: [], structuredContent: { credentials: 5 } };
    expect(attachCredentialReport(taken, entries, { structured: true, mask }).structuredContent).toEqual({
      credentials: 5,
    });
    expect(attachCredentialReport(base, [], { structured: true, mask })).toBe(base);
  });

  it('attachCredentialMeta puts the masked entries in _meta only; credentialReportBytes covers the added bytes', () => {
    const r = { resultType: 'input_required', _meta: { x: 1 } };
    expect(attachCredentialMeta(r, entries, (t) => t.toLowerCase())._meta).toEqual({
      x: 1,
      [CREDENTIALS_META_KEY]: [
        { key: 'a', status: 'valid', used: true },
        { key: 'b', status: 'degraded', used: false, reason: 'quota', retryInSeconds: 9 },
      ],
    });
    expect(attachCredentialMeta(r, [], mask)).toBe(r);
    const before = { content: [{ type: 'text' as const, text: 'x' }], structuredContent: { n: 1 } };
    const after = attachCredentialReport(before, entries, { structured: true, mask });
    const added = JSON.stringify(after).length - JSON.stringify(before).length;
    expect(credentialReportBytes(entries, true)).toBeGreaterThanOrEqual(added);
    expect(credentialReportBytes(entries, false)).toBeLessThan(credentialReportBytes(entries, true));
    expect(credentialReportBytes([], true)).toBe(0);
  });
});
