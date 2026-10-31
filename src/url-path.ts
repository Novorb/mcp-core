/**
 * @novorb/mcp-core - Upstream URL path segments
 *
 * `encodeURIComponent` alone is not enough to put a caller value (an id, a name) into an upstream URL
 * path: it leaves `.` and `..` intact and the URL parser collapses them (`/repositories/..` addresses
 * the parent resource). `pathSegment` encodes one value as exactly one segment and refuses what would
 * not stay one, as the most lenient upstream would read it: empty, `.`, `..`, their percent-encoded
 * forms (also double-encoded, for upstreams that decode twice), overlong UTF-8 dots (`%c0%ae`), unicode
 * dot forms after NFKC normalisation (fullwidth, small, one-dot leader, ideographic full stop), and C0 /
 * C1 control characters, DEL, U+2028 and U+2029 (raw or encoded).
 *
 * The error (`InvalidPathSegmentError`) names the argument and never echoes the value; `registerTools`
 * turns it into an actionable isError (`Invalid <name>: ...`) whatever the server's `mapError` does.
 *
 *   const path = buildPath`/repositories/${{ name: 'repository', value: args.repository }}/components`;
 *   const same = joinPath('repositories', { name: 'repository', value: args.repository }, 'components');
 */

/** What was wrong with a path segment. */
export type PathSegmentProblem = 'empty' | 'dot-segment' | 'control' | 'invalid';

const PROBLEM_TEXT: Record<PathSegmentProblem, string> = {
  empty: 'must not be empty',
  'dot-segment': 'must not be "." or ".." (or an encoded form of them)',
  control: 'must not contain control characters',
  invalid: 'must be a string or a finite number',
};

/** A value that cannot be one upstream path segment. The message names the argument, never the value. */
export class InvalidPathSegmentError extends Error {
  /** The argument name (`options.name`, default `path segment`). */
  readonly argument: string;
  readonly problem: PathSegmentProblem;
  constructor(argument: string, problem: PathSegmentProblem) {
    super(`Invalid ${argument}: ${PROBLEM_TEXT[problem]}`);
    this.name = 'InvalidPathSegmentError';
    this.argument = argument;
    this.problem = problem;
  }
}

export interface PathSegmentOptions {
  /** The argument name used in the error (for example the tool argument `repository`). */
  name?: string;
}

/** A value for `buildPath` / `joinPath`: a bare value, or one carrying its argument name for the error. */
export type PathValue = string | number | { name: string; value: string | number };

const DEFAULT_NAME = 'path segment';
/** How many percent-decoding rounds are checked (an upstream that decodes twice, plus one). */
const DECODE_ROUNDS = 3;
/** The ideographic full stop: NFKC keeps it (and maps the halfwidth form onto it), so it is mapped here. */
const IDEOGRAPHIC_FULL_STOP = String.fromCharCode(0x3002);
const REPLACEMENT = String.fromCharCode(0xfffd);

/** Whether `text` has a C0 or C1 control, DEL, U+2028 or U+2029 (compared by code unit). */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** The UTF-8 bytes of `text`, with each `%XX` taken as one byte (a stray `%` stays a byte). */
function percentBytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = text.codePointAt(i) ?? 0;
      if (code > 0xffff) i++;
      bytes.push(...Buffer.from(String.fromCodePoint(code), 'utf8'));
    }
  }
  return bytes;
}

/**
 * A LENIENT UTF-8 decode, as a forgiving upstream would do it: overlong forms are accepted (`%c0%ae` is
 * `.`), anything unreadable becomes U+FFFD. The point is to see what the most lenient reader would see.
 */
function lenientUtf8(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const lead = bytes[i];
    if (lead < 0x80) {
      out += String.fromCharCode(lead);
      i++;
      continue;
    }
    const extra =
      lead >= 0xf0 && lead <= 0xf7 ? 3 : lead >= 0xe0 && lead < 0xf0 ? 2 : lead >= 0xc0 && lead < 0xe0 ? 1 : 0;
    let code = lead & (0xff >> (extra + 2));
    let ok = extra > 0 && i + extra < bytes.length;
    for (let k = 1; ok && k <= extra; k++) {
      const cont = bytes[i + k];
      if ((cont & 0xc0) !== 0x80) ok = false;
      else code = (code << 6) | (cont & 0x3f);
    }
    if (!ok || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      out += REPLACEMENT;
      i++;
      continue;
    }
    out += String.fromCodePoint(code);
    i += extra + 1;
  }
  return out;
}

/** The value, its leniently percent-decoded forms (up to DECODE_ROUNDS), and the NFKC form of each. */
function decodedForms(value: string): string[] {
  const forms = [value];
  let current = value;
  for (let i = 0; i < DECODE_ROUNDS; i++) {
    if (!current.includes('%')) break;
    const next = lenientUtf8(percentBytes(current));
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms.flatMap((form) => [form, form.normalize('NFKC').split(IDEOGRAPHIC_FULL_STOP).join('.')]);
}

/**
 * Encode `value` as exactly one URL path segment (`encodeURIComponent`), refusing empty, dot segments in
 * every encoded, overlong and unicode form, and control characters. Throws `InvalidPathSegmentError`
 * naming `options.name`.
 */
export function pathSegment(value: string | number, options: PathSegmentOptions = {}): string {
  const name = options.name ?? DEFAULT_NAME;
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidPathSegmentError(name, 'invalid');
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    throw new InvalidPathSegmentError(name, 'invalid');
  }
  if (text === '') throw new InvalidPathSegmentError(name, 'empty');
  const forms = decodedForms(text);
  if (forms.some(hasControl)) throw new InvalidPathSegmentError(name, 'control');
  if (forms.some((form) => form === '' || form === '.' || form === '..')) {
    throw new InvalidPathSegmentError(name, 'dot-segment');
  }
  return encodeURIComponent(text);
}

function encodeValue(part: PathValue): string {
  if (typeof part === 'object' && part !== null) return pathSegment(part.value, { name: part.name });
  return pathSegment(part);
}

/**
 * Tagged template: the literal parts are kept as written, every interpolated value goes through
 * `pathSegment` (pass `{ name, value }` to name the argument in the error).
 */
export function buildPath(template: TemplateStringsArray, ...values: PathValue[]): string {
  let out = template[0];
  values.forEach((value, i) => {
    out += encodeValue(value) + template[i + 1];
  });
  return out;
}

/** Join segments, each through `pathSegment`, with one leading slash (`/` for none). */
export function joinPath(...segments: PathValue[]): string {
  return `/${segments.map(encodeValue).join('/')}`;
}
