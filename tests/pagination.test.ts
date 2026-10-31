import { describe, expect, it } from '@jest/globals';
import * as z from 'zod';
import type { HttpResponse, RequestOptions } from '../src/http-client.js';
import { DEFAULT_MAX_RESULT_ITEMS, HARD_MAX_COLLECT_ITEMS } from '../src/limits.js';
import {
  type CollectResult,
  CURSOR_VERSION,
  continuationToken,
  createPaginationMetadata,
  DEFAULT_MAX_PAGES,
  decodeCursor,
  defaultItems,
  encodeCursor,
  HARD_MAX_PAGES,
  InvalidCursorError,
  invalidCursorResult,
  type JsonValue,
  linkHeader,
  MAX_CURSOR_LENGTH,
  nextLinkField,
  nextPageHeader,
  normalizePagination,
  offsetLimit,
  type PaginateOptions,
  type PaginationStrategy,
  pagedResultSchema,
  pagePerPage,
  pageToOffset,
  paginateArray,
  paginateArrayByCursor,
  paginateRequests,
  parseLinkHeader,
  readHeaderTotal,
} from '../src/pagination.js';

function res(data: unknown, headers: Record<string, string> = {}): HttpResponse<unknown> {
  return { status: 200, statusText: 'OK', headers, data };
}

/** A recorded-API stub: answers each request from `pages`, records what was asked. */
function stub(answer: (req: RequestOptions, index: number) => HttpResponse<unknown>): {
  fetch: (req: RequestOptions) => Promise<HttpResponse<unknown>>;
  seen: RequestOptions[];
} {
  const seen: RequestOptions[] = [];
  return {
    seen,
    fetch: async (req) => {
      seen.push(req);
      return answer(req, seen.length - 1);
    },
  };
}

const q = (req: RequestOptions, name: string): unknown => req.query?.[name];

/** `paginateRequests(...).collect()` for a stub, with the path/query as the first request. */
function walk<T>(
  api: ReturnType<typeof stub>,
  request: RequestOptions,
  strategy: PaginationStrategy<T>,
  options?: PaginateOptions,
): Promise<CollectResult<T>> {
  return paginateRequests(api.fetch, request, strategy, options).collect();
}

describe('page-number helpers', () => {
  describe('normalizePagination', () => {
    it('uses defaults, provided values, and clamps', () => {
      expect(normalizePagination()).toEqual({ page: 1, per_page: 20 });
      expect(normalizePagination({ page: 3, per_page: 50 })).toEqual({ page: 3, per_page: 50 });
      expect(normalizePagination({ page: 0 }).page).toBe(1);
      expect(normalizePagination({ page: -5 }).page).toBe(1);
      expect(normalizePagination({ per_page: 0 }).per_page).toBe(1);
      expect(normalizePagination({ per_page: 500 }).per_page).toBe(100);
      expect(normalizePagination({ per_page: 500 }, 200).per_page).toBe(200);
      expect(normalizePagination(undefined, 100, 50).per_page).toBe(50);
    });

    it('accepts an options object, incl. throw mode', () => {
      expect(normalizePagination({ per_page: 900 }, { maxPerPage: 500, defaultPerPage: 100 }).per_page).toBe(500);
      expect(normalizePagination(undefined, { defaultPerPage: 100, onInvalid: 'throw', maxPerPage: 500 })).toEqual({
        page: 1,
        per_page: 100,
      });
      expect(normalizePagination({}, {}).per_page).toBe(20);
      expect(() => normalizePagination({ page: 0 }, { onInvalid: 'throw' })).toThrow(
        'page must be an integer >= 1 (got 0)',
      );
      expect(() => normalizePagination({ page: 1.5 }, { onInvalid: 'throw' })).toThrow(RangeError);
      expect(() => normalizePagination({ per_page: 101 }, { onInvalid: 'throw' })).toThrow(
        'per_page must be an integer between 1 and 100 (got 101)',
      );
    });
  });

  it('createPaginationMetadata, pageToOffset, paginateArray', () => {
    expect(createPaginationMetadata(101, { page: 1, per_page: 20 })).toEqual({
      totalCount: 101,
      page: 1,
      perPage: 20,
      totalPages: 6,
    });
    expect(createPaginationMetadata(0, { page: 1, per_page: 20 }).totalPages).toBe(0);
    expect(pageToOffset(1, 20)).toBe(0);
    expect(pageToOffset(5, 10)).toBe(40);
    expect(pageToOffset(0, 20)).toBe(0);
    const items = Array.from({ length: 55 }, (_, i) => i);
    expect(paginateArray(items, { page: 3, per_page: 20 }).data).toEqual(Array.from({ length: 15 }, (_, i) => i + 40));
    expect(paginateArray(items, { page: 10, per_page: 20 }).data).toEqual([]);
    expect(paginateArray([], { page: 1, per_page: 20 }).metadata.totalPages).toBe(0);
  });
});

describe('extractors and header helpers', () => {
  it('defaultItems finds array bodies and common wrappers', () => {
    expect(defaultItems([1])).toEqual([1]);
    expect(defaultItems({ value: [2] })).toEqual([2]);
    expect(defaultItems({ items: [3] })).toEqual([3]);
    expect(defaultItems({ data: [4] })).toEqual([4]);
    expect(defaultItems({ results: [5] })).toEqual([5]);
    expect(defaultItems({ other: 1 })).toEqual([]);
    expect(defaultItems('x')).toEqual([]);
  });

  it('readHeaderTotal reads integers only', () => {
    expect(readHeaderTotal({ 'x-total': '42' }, 'X-Total')).toBe(42);
    expect(readHeaderTotal({ 'x-total': 'abc' }, 'x-total')).toBeUndefined();
    expect(readHeaderTotal({}, 'x-total')).toBeUndefined();
  });

  it('parseLinkHeader handles several links, quoted and multi-valued rels', () => {
    const value =
      '<https://gitlab.com/api/v4/projects?id_after=42&per_page=2>; rel="next", ' +
      '<https://gitlab.com/api/v4/projects?per_page=2>; rel="first", <https://x/a>; rel=last, <https://x/nolink>';
    expect(parseLinkHeader(value)).toEqual({
      next: 'https://gitlab.com/api/v4/projects?id_after=42&per_page=2',
      first: 'https://gitlab.com/api/v4/projects?per_page=2',
      last: 'https://x/a',
    });
    expect(parseLinkHeader('<https://x/p>; rel="prev next"')).toEqual({ prev: 'https://x/p', next: 'https://x/p' });
    expect(parseLinkHeader('<https://x/1>; rel="next", <https://x/2>; rel="next"').next).toBe('https://x/1');
    expect(parseLinkHeader(undefined)).toEqual({});
  });
});

describe('HTTP strategies (recorded shapes)', () => {
  it('pagePerPage: Dependency-Track pageNumber/pageSize with X-Total-Count stops at the total', async () => {
    const api = stub((req) => {
      const page = Number(q(req, 'pageNumber'));
      return res(page === 1 ? [{ uuid: 'a' }, { uuid: 'b' }] : [{ uuid: 'c' }, { uuid: 'd' }], {
        'x-total-count': '4',
      });
    });
    const strategy = pagePerPage<{ uuid: string }>({
      pageParam: 'pageNumber',
      sizeParam: 'pageSize',
      pageSize: 2,
      totalHeader: 'X-Total-Count',
    });
    const result = await paginateRequests(api.fetch, { path: '/v1/project' }, strategy).collect();
    expect(result.items.map((i) => i.uuid)).toEqual(['a', 'b', 'c', 'd']);
    expect(result).toMatchObject({ total: 4, pages: 2, stopReason: 'end', truncated: false });
    expect(api.seen[0].query).toEqual({ pageNumber: 1, pageSize: 2 });
  });

  it('pagePerPage stops on a short page and on an empty page; reads a body total', async () => {
    const short = stub(() => res([1]));
    expect((await walk(short, { path: '/x' }, pagePerPage({ pageSize: 2 }))).pages).toBe(1);
    const empty = stub((_r, i) => res(i === 0 ? [1, 2] : []));
    const r = await walk(empty, { path: '/x' }, pagePerPage({ pageSize: 2, totalField: 'total' }));
    expect(r.items).toEqual([1, 2]);
    expect(r.pages).toBe(2);
    const body = stub(() => res({ total: 2, data: [1, 2] }));
    const b = await walk(body, { path: '/x' }, pagePerPage({ pageSize: 2, totalField: 'total', items: 'data' }));
    expect(b).toMatchObject({ items: [1, 2], total: 2, pages: 1 });
    const s = pagePerPage<number>({ pageSize: 2 });
    expect(s.parse(res([1, 2]), { path: '/x', query: { page: '3' } }).next?.query?.page).toBe(4);
    expect(s.parse(res([1, 2]), { path: '/x' }).next?.query?.page).toBe(2);
  });

  it('nextPageHeader: GitLab X-Next-Page / X-Total, empty on the last page', async () => {
    const api = stub((req) => {
      const page = Number(q(req, 'page'));
      return res(page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }], {
        'x-total': '3',
        'x-next-page': page === 1 ? '2' : '',
        'x-page': String(page),
      });
    });
    const result = await walk(api, { path: '/projects', query: { search: 'x' } }, nextPageHeader({ pageSize: 2 }));
    expect(result.items.map((i) => (i as { id: number }).id)).toEqual([1, 2, 3]);
    expect(result.total).toBe(3);
    expect(api.seen.map((r) => r.query)).toEqual([
      { search: 'x', page: 1, per_page: 2 },
      { search: 'x', page: 2, per_page: 2 },
    ]);
  });

  it('nextPageHeader keeps walking without X-Total (gitlab.com above 10k) and stops on an empty page', async () => {
    const api = stub((_r, i) => res(i < 2 ? [i] : [], { 'x-next-page': String(i + 2) }));
    const result = await walk(api, { path: '/x' }, nextPageHeader({ header: 'X-Next-Page' }));
    expect(result).toMatchObject({ items: [0, 1], total: undefined, pages: 3, stopReason: 'end' });
  });

  it('offsetLimit: stops on the total, a short page, or an empty page', async () => {
    const api = stub((req) => {
      const offset = Number(q(req, 'offset'));
      return res({ results: [offset, offset + 1], count: 4 });
    });
    const r = await walk(api, { path: '/x' }, offsetLimit({ limit: 2, totalField: 'count' }));
    expect(r).toMatchObject({ items: [0, 1, 2, 3], total: 4, pages: 2 });
    expect(api.seen.map((x) => x.query)).toEqual([
      { offset: 0, limit: 2 },
      { offset: 2, limit: 2 },
    ]);
    const short = stub(() => res([1]));
    const renamed = offsetLimit({ limit: 5, offsetParam: 'start', limitParam: 'max' });
    expect((await walk(short, { path: '/x' }, renamed)).pages).toBe(1);
    expect(short.seen[0].query).toEqual({ start: 0, max: 5 });
  });

  it('linkHeader: follows rel="next" as-is and drops the caller query', async () => {
    const api = stub((_r, i) =>
      res([i], i === 0 ? { link: '<https://gitlab.com/api/v4/projects?id_after=1&per_page=1>; rel="next"' } : {}),
    );
    const r = await walk(api, { path: '/projects', query: { per_page: 1 } }, linkHeader({ totalHeader: 'x-total' }));
    expect(r.items).toEqual([0, 1]);
    expect(api.seen[1]).toEqual({ path: 'https://gitlab.com/api/v4/projects?id_after=1&per_page=1', query: undefined });
  });

  it('nextLinkField: Graph @odata.nextLink / @odata.count / value', async () => {
    const next = 'https://graph.microsoft.com/v1.0/sites/root/lists?$skiptoken=X1';
    const api = stub((_r, i) =>
      i === 0
        ? res({
            '@odata.context': 'ctx',
            '@odata.count': 3,
            value: [{ id: 'a' }, { id: 'b' }],
            '@odata.nextLink': next,
          })
        : res({ value: [{ id: 'c' }] }),
    );
    const r = await walk(api, { path: '/sites/root/lists', query: { $count: true } }, nextLinkField());
    expect(r).toMatchObject({ total: 3, pages: 2, stopReason: 'end' });
    expect(api.seen[1].path).toBe(next);
    expect(api.seen[1].query).toBeUndefined();
  });

  it('continuationToken: Nexus {items, continuationToken} stops on a null token', async () => {
    const api = stub((_r, i) =>
      res({ items: [{ id: `c${i}` }], continuationToken: i === 0 ? '88491cd1d185dd1' : null }),
    );
    const request = { path: '/service/rest/v1/components', query: { repository: 'maven' } };
    const r = await walk(api, request, continuationToken());
    expect(r.items).toEqual([{ id: 'c0' }, { id: 'c1' }]);
    expect(api.seen[1].query).toEqual({ repository: 'maven', continuationToken: '88491cd1d185dd1' });
  });

  it('continuationToken with a token function: Trello `before=<last id>` until a short page', async () => {
    const ids = ['a5', 'a4', 'a3', 'a2', 'a1'];
    const api = stub((req) => {
      const before = q(req, 'before');
      const start = before ? ids.indexOf(String(before)) + 1 : 0;
      return res(ids.slice(start, start + 2).map((id) => ({ id })));
    });
    const strategy = continuationToken<{ id: string }>({
      requestParam: 'before',
      items: (body) => (Array.isArray(body) ? (body as Array<{ id: string }>) : []),
      token: (_body, items) => (items.length === 2 ? items[items.length - 1].id : undefined),
    });
    const r = await paginateRequests(api.fetch, { path: '/boards/b/actions', query: { limit: 2 } }, strategy).collect();
    expect(r.items.map((i) => i.id)).toEqual(ids);
    expect(api.seen.map((s) => s.query?.before)).toEqual([undefined, 'a4', 'a2']);
  });
});

describe('paginateRequests caps and stop conditions', () => {
  const endless = (): ReturnType<typeof stub> => stub((req) => res([Number(q(req, 'page'))]));
  const strategy = pagePerPage<number>({ pageSize: 1 });

  it('defaults to DEFAULT_MAX_PAGES and reports truncation', async () => {
    const api = endless();
    const r = await paginateRequests(api.fetch, { path: '/x' }, strategy, { maxItems: 1000 }).collect();
    expect(r.pages).toBe(DEFAULT_MAX_PAGES);
    expect(r).toMatchObject({ stopReason: 'maxPages', truncated: true });
  });

  it('is bounded by default by MCP_MAX_RESULT_ITEMS (100) and an explicit maxItems by HARD_MAX_COLLECT_ITEMS', async () => {
    const byDefault = await paginateRequests(endless().fetch, { path: '/x' }, strategy, { maxPages: 1000 }).collect();
    expect(byDefault.items).toHaveLength(DEFAULT_MAX_RESULT_ITEMS);
    expect(byDefault).toMatchObject({ stopReason: 'maxItems', truncated: true });
    const saved = process.env.MCP_MAX_RESULT_ITEMS;
    process.env.MCP_MAX_RESULT_ITEMS = '5';
    try {
      expect((await paginateRequests(endless().fetch, { path: '/x' }, strategy).collect()).items).toHaveLength(5);
    } finally {
      if (saved === undefined) delete process.env.MCP_MAX_RESULT_ITEMS;
      else process.env.MCP_MAX_RESULT_ITEMS = saved;
    }
    const huge = stub((req) => res(Array.from({ length: 1000 }, (_v, i) => Number(q(req, 'page')) * 1000 + i)));
    const capped = await paginateRequests(huge.fetch, { path: '/x' }, pagePerPage<number>({ pageSize: 1000 }), {
      maxItems: 10_000_000,
      maxPages: 10_000,
    }).collect();
    expect(capped.items).toHaveLength(HARD_MAX_COLLECT_ITEMS);
  });

  it('honours maxPages and clamps it to [1, HARD_MAX_PAGES]', async () => {
    expect((await walk(endless(), { path: '/x' }, strategy, { maxPages: 3 })).pages).toBe(3);
    expect((await walk(endless(), { path: '/x' }, strategy, { maxPages: 0 })).pages).toBe(1);
    expect(HARD_MAX_PAGES).toBe(10000);
  });

  it('maxItems trims the last page and stops', async () => {
    const api = stub((req) => {
      const p = Number(q(req, 'page'));
      return res([p * 10, p * 10 + 1, p * 10 + 2]);
    });
    const r = await walk(api, { path: '/x' }, pagePerPage({ pageSize: 3 }), { maxItems: 4 });
    expect(r).toMatchObject({ items: [10, 11, 12, 20], pages: 2, stopReason: 'maxItems', truncated: true });
  });

  it('maxItems exactly at the end of the last page is not a truncation', async () => {
    const api = stub(() => res([1, 2]));
    const r = await walk(api, { path: '/x' }, pagePerPage({ pageSize: 3 }), { maxItems: 2 });
    expect(r).toMatchObject({ items: [1, 2], stopReason: 'end', truncated: false });
  });

  it('a misbehaving API that repeats its next link is stopped', async () => {
    const api = stub(() => res({ value: [1], '@odata.nextLink': 'https://g/v1.0/same' }));
    const r = await paginateRequests(api.fetch, { path: '/x' }, nextLinkField()).collect();
    expect(r).toMatchObject({ pages: 2, stopReason: 'repeated', truncated: true });
    expect(api.seen).toHaveLength(2);
  });

  it('iterates pages and items lazily; each iteration restarts the walk', async () => {
    const api = stub((req) => res(Number(q(req, 'page')) <= 2 ? [Number(q(req, 'page'))] : []));
    const it1 = paginateRequests(api.fetch, { path: '/x' }, pagePerPage<number>({ pageSize: 1 }));
    const pages: number[] = [];
    for await (const page of it1) pages.push(page.pageIndex);
    expect(pages).toEqual([0, 1, 2]);
    const items: number[] = [];
    for await (const item of it1.items()) {
      items.push(item);
      if (items.length === 1) break;
    }
    expect(items).toEqual([1]);
    expect(api.seen).toHaveLength(4);
  });
});

describe('MCP cursors', () => {
  it('round-trips JSON state as an opaque base64url string', () => {
    const state: JsonValue = { page: 3, filter: 'a b/c', nested: [1, null, true] };
    const cursor = encodeCursor(state);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(state);
    expect(CURSOR_VERSION).toBe(1);
  });

  it('validates with a type guard and a version', () => {
    const isPage = (d: JsonValue): d is { page: number } =>
      typeof d === 'object' && d !== null && !Array.isArray(d) && typeof d.page === 'number';
    expect(decodeCursor(encodeCursor({ page: 2 }), { validate: isPage }).page).toBe(2);
    expect(() => decodeCursor(encodeCursor({ nope: 1 }), { validate: isPage })).toThrow(
      'Invalid cursor: unexpected content',
    );
    expect(() => decodeCursor(encodeCursor({ page: 1 }, 2))).toThrow('Invalid cursor: version 2 is not 1');
    expect(decodeCursor(encodeCursor({ page: 1 }, 2), { version: 2 })).toEqual({ page: 1 });
  });

  it.each([
    ['', 'Invalid cursor: empty'],
    ['a'.repeat(MAX_CURSOR_LENGTH + 1), 'Invalid cursor: too long'],
    ['not base64!', 'Invalid cursor: not base64url'],
    ['bm90LWpzb24', 'Invalid cursor: not decodable'],
    [Buffer.from('[1,2]').toString('base64url'), 'Invalid cursor: unrecognised format'],
    [Buffer.from('{"v":1}').toString('base64url'), 'Invalid cursor: unrecognised format'],
  ])('rejects a bad cursor %#', (cursor, message) => {
    expect(() => decodeCursor(cursor)).toThrow(message);
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError);
  });

  it('invalidCursorResult is an isError tool result with a clear message', () => {
    let error: unknown;
    try {
      decodeCursor('###');
    } catch (e) {
      error = e;
    }
    expect(invalidCursorResult(error)).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Invalid cursor: not base64url' }],
    });
    expect(invalidCursorResult(new Error('other')).content[0].text).toBe('Invalid cursor');
  });

  it('paginateArrayByCursor pages an array with nextCursor and total', () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    const first = paginateArrayByCursor(items, { limit: 2 });
    expect(first.items).toEqual([0, 1]);
    expect(first.total).toBe(5);
    const second = paginateArrayByCursor(items, { limit: 2, cursor: first.nextCursor });
    expect(second.items).toEqual([2, 3]);
    const last = paginateArrayByCursor(items, { limit: 2, cursor: second.nextCursor });
    expect(last).toEqual({ items: [4], total: 5 });
    expect(paginateArrayByCursor(items, { limit: 500, maxLimit: 3 }).items).toHaveLength(3);
    expect(paginateArrayByCursor(items, { limit: 0 }).items).toHaveLength(1);
    expect(paginateArrayByCursor(items).items).toHaveLength(5);
    expect(() => paginateArrayByCursor(items, { cursor: encodeCursor({ o: 99 }) })).toThrow(
      'Invalid cursor: out of range',
    );
    expect(() => paginateArrayByCursor(items, { cursor: encodeCursor({ o: -1 }) })).toThrow('unexpected content');
  });
});

describe('pagedResultSchema', () => {
  it('validates the shared paged shape with the consumer zod', () => {
    const schema = pagedResultSchema(z, z.object({ id: z.number() }));
    expect(schema.parse({ items: [{ id: 1 }], nextCursor: 'abc', total: 9 })).toEqual({
      items: [{ id: 1 }],
      nextCursor: 'abc',
      total: 9,
    });
    expect(schema.parse({ items: [] })).toEqual({ items: [] });
    expect(schema.safeParse({ items: [{ id: 'x' }] }).success).toBe(false);
    expect(schema.safeParse({ items: [], total: -1 }).success).toBe(false);
    expect(schema.safeParse({ items: [], total: 1.5 }).success).toBe(false);
  });

  it('accepts any zod-shaped namespace, not one specific zod identity', () => {
    const calls: string[] = [];
    const leaf = (name: string) => {
      const node = { name, optional: () => node, int: () => node, nonnegative: () => node };
      return node;
    };
    const foreignZ = {
      object: (shape: Record<string, unknown>) => {
        calls.push(`object:${Object.keys(shape).join(',')}`);
        return { kind: 'object', shape };
      },
      array: (item: unknown) => ({ kind: 'array', item }),
      string: () => leaf('string'),
      number: () => leaf('number'),
    };
    const itemSchema = { kind: 'item' };
    const schema = pagedResultSchema(foreignZ, itemSchema);
    expect(schema).toMatchObject({ kind: 'object', shape: { items: { kind: 'array', item: itemSchema } } });
    expect(calls).toEqual(['object:items,nextCursor,total']);
    expect(() =>
      // @ts-expect-error a namespace without `object` is not a zod-shaped value
      pagedResultSchema({ array: foreignZ.array, string: foreignZ.string, number: foreignZ.number }, itemSchema),
    ).toThrow(TypeError);
  });
});
