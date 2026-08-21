export function queryCollection(items = [], { search = '', limit = 20, offset = 0, filter = () => true, text = item => item.title || item.summary || item.content || '' } = {}) {
  const normalizedSearch = String(search || '').trim().toLowerCase();
  const filtered = items.filter(filter).filter(item => !normalizedSearch || String(text(item)).toLowerCase().includes(normalizedSearch));
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return { items: filtered.slice(safeOffset, safeOffset + safeLimit), total: filtered.length, limit: safeLimit, offset: safeOffset };
}
