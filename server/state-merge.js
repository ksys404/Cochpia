// 增量合并导入数据:按 id 去重,已有数据不覆盖,只补充缺失项。
export function mergeState(base, incoming) {
  if (!base || typeof base !== 'object') throw new Error('Invalid base state');
  if (!incoming || typeof incoming !== 'object') throw new Error('Invalid import state');

  const merged = { ...base };
  const mergeById = key => {
    const target = Array.isArray(merged[key]) ? merged[key].slice() : [];
    const existing = new Set(target.map(item => String(item.id)));
    const items = Array.isArray(incoming[key]) ? incoming[key] : [];
    for (const item of items) {
      if (item && item.id !== undefined && !existing.has(String(item.id))) {
        target.push(item);
        existing.add(String(item.id));
      }
    }
    merged[key] = target;
  };
  ['sessions', 'memories', 'evidence', 'tasks', 'personalityHistory', 'personalityAudit', 'agents'].forEach(mergeById);

  if (incoming.messages && typeof incoming.messages === 'object') {
    merged.messages = { ...(merged.messages || {}) };
    for (const [sessionId, messages] of Object.entries(incoming.messages)) {
      if (!Array.isArray(messages)) continue;
      const target = Array.isArray(merged.messages[sessionId]) ? merged.messages[sessionId].slice() : [];
      const existing = new Set(target.map(message => String(message.id)));
      for (const message of messages) {
        if (message && message.id !== undefined && !existing.has(String(message.id))) {
          target.push(message);
          existing.add(String(message.id));
        }
      }
      merged.messages[sessionId] = target;
    }
  }

  if (!merged.personality && incoming.personality) merged.personality = incoming.personality;
  if (!merged.profile && incoming.profile) merged.profile = incoming.profile;
  if (!merged.workspacePreferences && incoming.workspacePreferences) merged.workspacePreferences = incoming.workspacePreferences;
  return merged;
}
