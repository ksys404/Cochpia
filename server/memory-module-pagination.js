export class PaginationCursorError extends Error {
  constructor(message = 'Invalid pagination cursor') {
    super(message);
    this.name = 'PaginationCursorError';
    this.code = 'INVALID_CURSOR';
  }
}

export function encodeOpaqueCursor(payload = {}) {
  return Buffer.from(JSON.stringify({ v: 1, ...payload }), 'utf8').toString('base64url');
}

export function decodeOpaqueCursor(value) {
  if (typeof value !== 'string' || !value.trim()) throw new PaginationCursorError();
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || decoded.v !== 1 || typeof decoded.resource !== 'string' || typeof decoded.id !== 'string' || typeof decoded.sortValue !== 'string' || Number.isNaN(new Date(decoded.sortValue).getTime())) throw new PaginationCursorError();
    return decoded;
  } catch (error) {
    if (error instanceof PaginationCursorError) throw error;
    throw new PaginationCursorError();
  }
}

export function assertCursorBinding(cursor, expected = {}) {
  for (const key of ['resource', 'tenantId', 'subjectUserId', 'purpose', 'scopeType', 'sensitivity', 'status']) {
    if (expected[key] !== undefined && (cursor[key] ?? null) !== (expected[key] ?? null)) throw new PaginationCursorError();
  }
}

export function pageNewestFirst(items, { cursor = null, limit = 20, cursorPayload = {} } = {}) {
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const start = cursor
    ? items.findIndex(item => new Date(item.sortValue).getTime() < new Date(cursor.sortValue).getTime()
      || (new Date(item.sortValue).getTime() === new Date(cursor.sortValue).getTime() && String(item.id) < String(cursor.id)))
    : 0;
  const offset = start < 0 ? items.length : start;
  const page = items.slice(offset, offset + pageSize + 1);
  const hasMore = page.length > pageSize;
  const visible = page.slice(0, pageSize);
  const last = visible.at(-1);
  return {
    items: visible,
    nextCursor: hasMore && last
      ? encodeOpaqueCursor({ ...cursorPayload, id: String(last.id), sortValue: new Date(last.sortValue).toISOString() })
      : null
  };
}
