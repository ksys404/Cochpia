const encodeKeyPart = value => encodeURIComponent(String(value ?? ''));

function requireContext(context) {
  if (!context?.tenantId || !context?.subjectUserId) throw new TypeError('tenantId and subjectUserId are required');
  return context;
}

function cacheKey(prefix, context, { generation, readVersion, purpose, query }) {
  return [
    prefix,
    'context-bundle',
    encodeKeyPart(context.tenantId),
    encodeKeyPart(context.subjectUserId),
    encodeKeyPart(generation),
    encodeKeyPart(readVersion),
    encodeKeyPart(purpose),
    encodeKeyPart(query)
  ].join(':');
}

export function createMemoryModuleCache({ client, prefix = 'memory-module', ttlSeconds = 30 } = {}) {
  if (!client || typeof client.get !== 'function' || typeof client.set !== 'function') throw new TypeError('Redis-compatible cache client with get/set is required');
  const ttl = Math.max(1, Math.min(3600, Number(ttlSeconds) || 30));
  const versionKey = context => `${prefix}:subject-version:${encodeKeyPart(requireContext(context).tenantId)}:${encodeKeyPart(context.subjectUserId)}`;

  const getSubjectGeneration = async context => {
    try {
      return String(await client.get(versionKey(context)) || '0');
    } catch {
      return '0';
    }
  };

  const bumpSubjectGeneration = async context => {
    requireContext(context);
    if (typeof client.incr !== 'function') return null;
    try {
      return String(await client.incr(versionKey(context)));
    } catch {
      return null;
    }
  };

  const getContextBundle = async (context, { purpose = 'answer_user_query', query = '', readVersion = '0' } = {}) => {
    requireContext(context);
    if (String(query || '').trim()) return null;
    const generation = await getSubjectGeneration(context);
    const key = cacheKey(prefix, context, { generation, readVersion, purpose, query });
    try {
      const raw = await client.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const setContextBundle = async (context, { purpose = 'answer_user_query', query = '', readVersion = '0', state } = {}) => {
    requireContext(context);
    if (String(query || '').trim()) return false;
    if (state == null) return false;
    const generation = await getSubjectGeneration(context);
    const key = cacheKey(prefix, context, { generation, readVersion, purpose, query });
    try {
      await client.set(key, JSON.stringify(state), { EX: ttl });
      return true;
    } catch {
      return false;
    }
  };

  return { getSubjectGeneration, bumpSubjectGeneration, getContextBundle, setContextBundle, ttlSeconds: ttl };
}
