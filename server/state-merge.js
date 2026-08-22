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

  if (incoming.memoryModule && typeof incoming.memoryModule === 'object') {
    const currentModule = merged.memoryModule && typeof merged.memoryModule === 'object' ? structuredClone(merged.memoryModule) : {};
    const incomingModule = incoming.memoryModule;
    const mergeModuleArray = key => {
      if (!Array.isArray(incomingModule[key])) return;
      const target = Array.isArray(currentModule[key]) ? currentModule[key].slice() : [];
      const existing = new Set(target.map(item => item?.id !== undefined ? `id:${item.id}` : `json:${JSON.stringify(item)}`));
      for (const item of incomingModule[key]) {
        if (!item || typeof item !== 'object') continue;
        const identity = item.id !== undefined ? `id:${item.id}` : `json:${JSON.stringify(item)}`;
        if (!existing.has(identity)) {
          target.push(item);
          existing.add(identity);
        }
      }
      currentModule[key] = target;
    };
    for (const key of ['rawEvents', 'outboxEvents', 'sessions', 'profileSnapshots', 'profileSnapshotItems', 'profileProjections', 'profileProjectionItems', 'indexDocuments', 'episodes', 'episodeMembers', 'assertions', 'assertionVersions', 'assertionVersionSources', 'currentStates', 'currentStateSources', 'profileProjectionSources', 'confirmations', 'accessConfirmations', 'mentionCooldowns', 'pins', 'scopeGrants', 'deletionOperations', 'tombstones', 'auditEvents', 'idempotencyRecords', 'jobAttempts']) mergeModuleArray(key);
    if (incomingModule.redactionEpochs && typeof incomingModule.redactionEpochs === 'object') {
      currentModule.redactionEpochs ||= {};
      for (const [key, value] of Object.entries(incomingModule.redactionEpochs)) {
        currentModule.redactionEpochs[key] = Math.max(Number(currentModule.redactionEpochs[key] || 0), Number(value || 0));
      }
    }
    currentModule.sequence = Math.max(Number(currentModule.sequence || 0), Number(incomingModule.sequence || 0));
    currentModule.persistenceBaseSequence = Math.max(Number(currentModule.persistenceBaseSequence || 0), Number(incomingModule.persistenceBaseSequence || 0));
    currentModule.grantVersion = Math.max(Number(currentModule.grantVersion || 0), Number(incomingModule.grantVersion || 0));
    currentModule.policyVersion ||= incomingModule.policyVersion || 'memory-policy-v1';
    currentModule.legacyImportVersion = Math.max(Number(currentModule.legacyImportVersion || 0), Number(incomingModule.legacyImportVersion || 0));
    merged.memoryModule = currentModule;
  }

  return merged;
}
