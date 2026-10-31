# Pagination

**Page-number helpers** for list tools: `normalizePagination` (clamps by default; `normalizePagination(params, { maxPerPage, defaultPerPage, onInvalid: 'throw' })` throws a `RangeError` instead), `createPaginationMetadata`, `pageToOffset`, `paginateArray`.

```typescript
const params = normalizePagination({ page: 3, per_page: 200 }); // { page: 3, per_page: 100 }
const { data, metadata } = paginateArray(allItems, params);
```

**Upstream strategies** for `client.paginate(request, strategy, { maxPages, maxItems })` (or `paginateRequests(fetchPage, request, strategy, options)`). The result is an async iterator of pages `{ items, pageIndex, total }` with `items()` and `collect()` (`{ items, total, pages, stopReason, truncated }`, `stopReason` = `end` | `maxPages` | `maxItems` | `repeated`). `maxPages` defaults to 100 and is never above `HARD_MAX_PAGES` (10000); `maxItems` defaults to `MCP_MAX_RESULT_ITEMS` (100) and is never above `HARD_MAX_COLLECT_ITEMS` (100000), so a walk never pulls an unbounded list into memory; a next request identical to an earlier one stops the walk (`repeated`), so a misbehaving API cannot loop forever. Set `pageSize` / `limit` at or below the API's own maximum: a server that silently caps the page (asked for 100, sends 50) makes the first page look short, and the size-based strategies then stop early (`stopReason: 'end'`) unless a total header or field is configured. A relative next link is joined onto the client's `baseURL` (root-relative links, the common case, resolve correctly).

| Strategy | Upstream shape | Stops when |
|----------|----------------|------------|
| `pagePerPage({ pageParam, sizeParam, pageSize, startPage, totalHeader, totalField, items })` | `page`/`per_page` (Dependency-Track `pageNumber`/`pageSize` + `X-Total-Count`) | empty or short page, or page * size >= total |
| `nextPageHeader({ header, pageParam, sizeParam, pageSize, totalHeader, items })` | GitLab `X-Next-Page` + `X-Total` | the header is empty or absent, or the page is empty |
| `offsetLimit({ offsetParam, limitParam, limit, startOffset, totalHeader, totalField, items })` | offset/limit | empty or short page, or offset + items >= total |
| `linkHeader({ rel, totalHeader, items })` | RFC 5988 `Link: <url>; rel="next"` | no `next` link |
| `nextLinkField({ field, totalField, items })` | Graph `@odata.nextLink` / `@odata.count` / `value` | no next link |
| `continuationToken({ requestParam, token, items })` | Nexus `continuationToken`; Trello `before` via a token function | token absent/empty, or the page is empty |

`items` is a body field name or an extractor; the default takes an array body or the first array under `value`/`items`/`data`/`results`.

**MCP-side cursors and the paged result contract** for list tools:

```typescript
import { z } from 'zod';
import { decodeCursor, encodeCursor, invalidCursorResult, pagedResultSchema } from '@novorb/mcp-core/pagination';

server.registerTool('project_list', {
  inputSchema: z.object({ cursor: z.string().optional() }),
  outputSchema: pagedResultSchema(z, Project), // { items, nextCursor?, total? }
}, async ({ cursor }) => {
  let page = 1;
  try {
    if (cursor) page = decodeCursor(cursor, { validate: isPageState }).page;
  } catch (err) {
    return invalidCursorResult(err); // isError, "Invalid cursor: <reason>"
  }
  const { items, total, hasMore } = await fetchPage(page);
  const result = { items, total, ...(hasMore ? { nextCursor: encodeCursor({ page: page + 1 }) } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});
```

Cursors are base64url JSON `{ v, d }`, versioned (`CURSOR_VERSION`), at most `MAX_CURSOR_LENGTH` (2048) chars, and validated on decode (`InvalidCursorError`). `paginateArrayByCursor(items, { cursor, limit, defaultLimit, maxLimit })` returns a `PagedResult` over an in-memory list.
