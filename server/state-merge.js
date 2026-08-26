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
  ['sessions', 'memories', 'evidence', 'personalityHistory', 'personalityAudit', 'agents'].forEach(mergeById);

  if (incoming.deletionRecords && Array.isArray(incoming.deletionRecords)) {
    const target = Array.isArray(merged.deletionRecords) ? merged.deletionRecords.slice() : [];
    const existing = new Set(target.map(item => String(item.id)));
    for (const item of incoming.deletionRecords) {
      if (item?.id !== undefined && !existing.has(String(item.id))) {
        target.push(item);
        existing.add(String(item.id));
      }
    }
    merged.deletionRecords = target;
  }

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
  if (!merged.lifeState && incoming.lifeState) merged.lifeState = incoming.lifeState;
  if (!merged.relationshipStates && incoming.relationshipStates) merged.relationshipStates = incoming.relationshipStates;
  if (!merged.personalityProjection && incoming.personalityProjection) merged.personalityProjection = incoming.personalityProjection;
  if (incoming.companion && typeof incoming.companion === 'object') {
    const currentCompanion = merged.companion && typeof merged.companion === 'object' ? structuredClone(merged.companion) : {};
    currentCompanion.sessionMappings ||= structuredClone(incoming.companion.sessionMappings || {});
    currentCompanion.exportOperations ||= structuredClone(incoming.companion.exportOperations || []);
    const currentOutbox = Array.isArray(currentCompanion.interactionOutbox) ? currentCompanion.interactionOutbox.slice() : [];
    const existingOutbox = new Set(currentOutbox.map(item => String(item?.id)));
    for (const item of Array.isArray(incoming.companion.interactionOutbox) ? incoming.companion.interactionOutbox : []) {
      if (item?.id !== undefined && !existingOutbox.has(String(item.id))) {
        currentOutbox.push(item);
        existingOutbox.add(String(item.id));
      }
    }
    currentCompanion.interactionOutbox = currentOutbox;
    currentCompanion.dataRevision = Math.max(Number(currentCompanion.dataRevision || 0), Number(incoming.companion.dataRevision || 0));
    merged.companion = currentCompanion;
  }

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
    for (const key of ['rawEvents', 'outboxEvents', 'sessions', 'profileSnapshots', 'profileSnapshotItems', 'profileProjections', 'profileProjectionItems', 'indexDocuments', 'episodes', 'episodeMembers', 'assertions', 'assertionVersions', 'assertionVersionSources', 'currentStates', 'currentStateSources', 'profileProjectionSources', 'confirmations', 'accessConfirmations', 'mentionCooldowns', 'pins', 'scopeGrants', 'deletionOperations', 'tombstones', 'exportOperations', 'auditEvents', 'idempotencyRecords', 'jobAttempts']) mergeModuleArray(key);
    if (incomingModule.redactionEpochs && typeof incomingModule.redactionEpochs === 'object') {
      currentModule.redactionEpochs ||= {};
      for (const [key, value] of Object.entries(incomingModule.redactionEpochs)) {
        currentModule.redactionEpochs[key] = Math.max(Number(currentModule.redactionEpochs[key] || 0), Number(value || 0));
      }
    }
    currentModule.sequence = Math.max(Number(currentModule.sequence || 0), Number(incomingModule.sequence || 0));
    currentModule.persistenceBaseSequence = Math.max(Number(currentModule.persistenceBaseSequence || 0), Number(incomingModule.persistenceBaseSequence || 0));
    if (incomingModule.subjectSequences && typeof incomingModule.subjectSequences === 'object') {
      currentModule.subjectSequences ||= {};
      for (const [key, value] of Object.entries(incomingModule.subjectSequences)) {
        currentModule.subjectSequences[key] = Math.max(Number(currentModule.subjectSequences[key] || 0), Number(value || 0));
      }
    }
    currentModule.grantVersion = Math.max(Number(currentModule.grantVersion || 0), Number(incomingModule.grantVersion || 0));
    currentModule.policyVersion ||= incomingModule.policyVersion || 'memory-policy-v1';
    currentModule.legacyImportVersion = Math.max(Number(currentModule.legacyImportVersion || 0), Number(incomingModule.legacyImportVersion || 0));
    merged.memoryModule = currentModule;
  }

  return merged;
}
