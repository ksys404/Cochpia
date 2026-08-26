const STORAGE_KEY = 'cochpia.life.command.queue.v1';
const MAX_QUEUE_SIZE = 100;

const asStorage = storage => storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
const browserStorage = () => {
  try { return globalThis?.localStorage || null; } catch { return null; }
};
const normalizeScope = scope => String(scope || 'local-user').trim().slice(0, 240) || 'local-user';
const storageKeyForScope = scope => {
  const normalized = normalizeScope(scope);
  return normalized === 'local-user' ? STORAGE_KEY : `${STORAGE_KEY}.${encodeURIComponent(normalized)}`;
};

function read(storage, storageKey) {
  const source = asStorage(storage);
  if (!source) return [];
  try {
    const parsed = JSON.parse(source.getItem(storageKey) || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => item && item.idempotencyKey && item.path && item.body) : [];
  } catch {
    return [];
  }
}

function write(storage, storageKey, items) {
  const source = asStorage(storage);
  if (!source) return;
  try { source.setItem(storageKey, JSON.stringify(items.slice(-MAX_QUEUE_SIZE))); } catch { /* quota/private mode: queue becomes memory-only */ }
}

export function createLifeCommandQueue(storage = browserStorage(), subjectScope = 'local-user') {
  const storageKey = storageKeyForScope(subjectScope);
  let items = read(storage, storageKey);
  const list = () => structuredClone(items);
  const enqueue = command => {
    if (!command?.idempotencyKey || !command?.path || !command?.body) throw new TypeError('A life command with idempotencyKey, path, and body is required');
    if (!items.some(item => item.idempotencyKey === command.idempotencyKey)) items = [...items, structuredClone(command)].slice(-MAX_QUEUE_SIZE);
    write(storage, storageKey, items);
    return list();
  };
  const remove = idempotencyKey => {
    items = items.filter(item => item.idempotencyKey !== idempotencyKey);
    write(storage, storageKey, items);
    return list();
  };
  const clear = () => { items = []; write(storage, storageKey, items); };
  return { list, enqueue, remove, clear, size: () => items.length, storageKey };
}

export function isRetryableLifeError(error) {
  if (error?.code === 'LIFE_EVENT_DEAD_LETTER') return false;
  if (error?.status === 409) return false;
  if ([502, 503, 504].includes(Number(error?.status))) return true;
  return error?.status == null;
}

export { STORAGE_KEY, MAX_QUEUE_SIZE, storageKeyForScope };
