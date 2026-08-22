const ROUTES = Object.freeze(['profile_exact', 'state_current', 'episode_recall', 'relationship_recall', 'bridge_candidate', 'unknown']);

const patterns = {
  bridge_candidate: /一跳|关联|桥接|bridge|link|relate/i,
  relationship_recall: /我们|共同|关系|一起|你和我|relationship|shared|between\s+us/i,
  state_current: /现在|当前|正在|情绪|心情|目标|进展|(?:^|[^A-Za-z0-9_])(?:current|currently|mood|state|goal)(?:$|[^A-Za-z0-9_])/i,
  episode_recall: /经历|那次|当时|对话|发布|回忆|episode|during|release|what\s+happened/i,
  profile_exact: /偏好|喜欢|不喜欢|背景|姓名|叫什么|画像|profile|preference|like|dislike/i
};

export function routeMemoryQuery(query) {
  const normalized = String(query || '').trim();
  if (!normalized) return 'unknown';
  for (const route of ['bridge_candidate', 'relationship_recall', 'state_current', 'episode_recall', 'profile_exact']) {
    if (patterns[route].test(normalized)) return route;
  }
  return 'unknown';
}

export { ROUTES as MEMORY_QUERY_ROUTES };
