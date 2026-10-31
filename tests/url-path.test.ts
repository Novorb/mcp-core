import { describe, expect, it } from '@jest/globals';
import { buildPath, InvalidPathSegmentError, joinPath, pathSegment } from '../src/url-path.js';

function thrown(fn: () => unknown): InvalidPathSegmentError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidPathSegmentError);
    return error as InvalidPathSegmentError;
  }
  throw new Error('expected an InvalidPathSegmentError');
}

describe('pathSegment', () => {
  it.each([
    ['plain', 'plain'],
    ['my repo', 'my%20repo'],
    ['a/b', 'a%2Fb'],
    ['a?b#c', 'a%3Fb%23c'],
    ['...', '...'],
    ['.hidden', '.hidden'],
    ['a..b', 'a..b'],
    ['%41', '%2541'],
    [`caf${String.fromCharCode(0xe9)}`, 'caf%C3%A9'],
  ])('encodes %j as one segment (%s)', (value, encoded) => {
    expect(pathSegment(value)).toBe(encoded);
  });

  const u = (...codes: number[]): string => String.fromCharCode(...codes);

  it.each([
    ['fullwidth full stop', u(0xff0e)],
    ['two fullwidth full stops', u(0xff0e, 0xff0e)],
    ['one dot leader', u(0x2024)],
    ['two one dot leaders', u(0x2024, 0x2024)],
    ['two dot leader', u(0x2025)],
    ['small full stop', u(0xfe52)],
    ['ideographic full stop', u(0x3002)],
    ['halfwidth ideographic full stop', u(0xff61, 0xff61)],
    ['a dot and a fullwidth dot', `.${u(0xff0e)}`],
    ['encoded fullwidth dots', '%EF%BC%8E%EF%BC%8E'],
    ['overlong two-byte dot', '%c0%ae'],
    ['overlong two-byte dots', '%c0%ae%c0%ae'],
    ['overlong three-byte dot', '%e0%80%ae'],
    ['overlong four-byte dots', '%f0%80%80%ae%f0%80%80%ae'],
    ['an overlong dot after a dot', '.%c0%ae'],
  ])('refuses the unicode or lenient dot form: %s', (_label, value) => {
    expect(thrown(() => pathSegment(value, { name: 'id' })).problem).toBe('dot-segment');
  });

  it.each([
    ['C1 control', u(0x85)],
    ['C1 control in a name', `a${u(0x9f)}b`],
    ['line separator', `a${u(0x2028)}b`],
    ['paragraph separator', u(0x2029)],
    ['encoded C1 control', 'a%C2%85b'],
    ['overlong NUL', 'a%c0%80b'],
  ])('refuses the %s', (_label, value) => {
    expect(thrown(() => pathSegment(value, { name: 'id' })).problem).toBe('control');
  });

  it('keeps ordinary non-ASCII names, including ones with a fullwidth dot inside', () => {
    expect(pathSegment(`a${u(0xff0e)}b`)).toBe('a%EF%BC%8Eb');
    expect(pathSegment(u(0x2026))).toBe('%E2%80%A6');
  });

  it('accepts finite numbers', () => {
    expect(pathSegment(42)).toBe('42');
    expect(pathSegment(0)).toBe('0');
  });

  it.each(['', '.', '..', '%2e', '%2E', '%2e%2e', '%2E%2e', '.%2e', '%2e.', '%252e', '%252E%252e'])(
    'refuses the dot segment or empty value %j',
    (value) => {
      const error = thrown(() => pathSegment(value, { name: 'repository' }));
      expect(error.argument).toBe('repository');
      expect(error.message).toMatch(/^Invalid repository: /);
    },
  );

  it.each(['a\u0000b', '\u0000', 'a\nb', 'a\rb', 'tab\there', 'del\u007f', 'a%00b', 'a%0Ab', 'a%250ab'])(
    'refuses the control character in %j',
    (value) => {
      const error = thrown(() => pathSegment(value, { name: 'file' }));
      expect(error.problem).toBe('control');
      expect(error.message).toBe('Invalid file: must not contain control characters');
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('refuses the number %p', (value) => {
    expect(thrown(() => pathSegment(value)).problem).toBe('invalid');
  });

  it('refuses a non-string, non-number at runtime (untyped callers)', () => {
    const value: unknown = { toString: () => 'x' };
    expect(thrown(() => pathSegment(value as string)).problem).toBe('invalid');
  });

  it('names the argument and never echoes the value', () => {
    const secret = 'glpat-SECRETVALUE..';
    const control = thrown(() => pathSegment(`${secret}\u0000`, { name: 'token_name' }));
    expect(control.message).not.toContain('SECRET');
    expect(thrown(() => pathSegment('..', { name: 'project_id' })).message).toBe(
      'Invalid project_id: must not be "." or ".." (or an encoded form of them)',
    );
    expect(thrown(() => pathSegment('')).message).toBe('Invalid path segment: must not be empty');
    expect(thrown(() => pathSegment('')).name).toBe('InvalidPathSegmentError');
  });

  it('a malformed percent sequence is encoded, not refused', () => {
    expect(pathSegment('100%')).toBe('100%25');
    expect(pathSegment('%E0%A4%A')).toBe('%25E0%25A4%25A');
  });
});

describe('buildPath (tagged) and joinPath', () => {
  it('encodes every interpolated value as one segment and keeps the literal parts', () => {
    const repo = 'my repo';
    expect(buildPath`/service/rest/v1/repositories/${repo}/components`).toBe(
      '/service/rest/v1/repositories/my%20repo/components',
    );
    expect(buildPath`/projects/${{ name: 'project_id', value: 'group/sub' }}/files/${7}`).toBe(
      '/projects/group%2Fsub/files/7',
    );
  });

  it('refuses a dot segment in an interpolated value, naming it', () => {
    expect(thrown(() => buildPath`/repositories/${{ name: 'repository', value: '.' }}`).message).toBe(
      'Invalid repository: must not be "." or ".." (or an encoded form of them)',
    );
    expect(thrown(() => buildPath`/repositories/${'..'}/x`).argument).toBe('path segment');
  });

  it('joinPath joins encoded segments with one leading slash', () => {
    expect(joinPath('sites', { name: 'siteId', value: 'a b' }, 'lists', 3)).toBe('/sites/a%20b/lists/3');
    expect(joinPath()).toBe('/');
    expect(thrown(() => joinPath('drives', { name: 'driveId', value: '%2e%2e' })).argument).toBe('driveId');
  });
});
