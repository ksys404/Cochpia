import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionProductRuntime } from './product-runtime.js';

function request(body = {}, headers = {}) {
  return {
    body,
    requestId: 'request-1',
    get(name) { return headers[name] || headers[name.toLowerCase()] || null; }
  };
}

function harness() {
  const state = {
    sessions: [{ id: 'session-1', title: '相遇' }],
    messages: { 'session-1': [{ id: 'message-1', role: 'user', content: 'hello' }] },
    tasks: [],
    events: [],
    agents: [],
    memories: [],
    evidence: [],
    personality: {},
    personalityHistory: [],
    personalityAudit: [],
    personalityProjection: { appliedEvidenceIds: [], appliedSourceEventIds: [] },
    relationshipStates: {},
    lifeState: { revision: 1 },
    companion: { sessionMappings: {}, exportOperations: [], interactionOutbox: [], dataRevision: 0 },
    deletionRecords: [],
    uploads: [],
    workspacePreferences: null,
    workspacePreferencesUpdatedAt: null,
    profile: { name: 'Cochpia' },
    mode: 'companion',
    memoryModule: { rawEvents: [] }
  };
  const baseState = structuredClone(state);
  const memoryState = {
    rawEvents: [],
    sessions: [],
    tombstones: [],
    deletionOperations: []
  };
  const exportOperations = new Map();
  const memory = {
    state: memoryState,
    async createExportOperation() {
      const operation = { id: 'memory-export-1', status: 'ready', consistencyToken: 'memory-token' };
      exportOperations.set(operation.id, operation);
      return operation;
    },
    getExportOperation(_context, id) { return exportOperations.get(id) || null; },
    async downloadExport(_context, id) { return { version: 1, operation: exportOperations.get(id), data: { rawEvents: [] } }; },
    async deleteAccount() {
      memoryState.rawEvents = [];
      return { deletionOperationId: 'memory-delete-1', status: 'completed' };
    },
    async deleteSession() { return { deletionOperationId: 'memory-session-delete-1', status: 'completed' }; }
  };
  let persistCount = 0;
  const runtime = createCompanionProductRuntime({
    state,
    baseState,
    getState: () => state,
    persist: async () => { persistCount += 1; },
    storageProvider: 'json',
    nodeEnv: 'test',
    memoryRuntime: {
      async prepareForRequest() { return memory; },
      contextFromRequest() { return { tenantId: 'tenant-1', subjectUserId: 'user-1', actorType: 'user', actorId: 'user-1' }; },
      moduleForRequest() { return memory; },
      async ensureChatSession(_req, id) {
        if (!memory.state.sessions.some(item => item.id === id)) memory.state.sessions.push({ id, resourceRevision: 1 });
        return id;
      }
    },
    uploadStore: {
      async exportRecords() { return []; },
      async importRecords() { return []; },
      async removeRecord() {},
      async stageUserDeletion(userId, operationId) { return { userId, operationId, existed: false, operationId }; },
      async rollbackUserDeletion() {},
      async commitUserDeletion() {}
    },
    chatStreamJournal: { async remove() {} },
    disableChatStreamJournals() {},
    hasActiveUserInteraction() { return false; },
    currentUserId() { return 'user-1'; }
  });
  return { runtime, state, memory, getPersistCount: () => persistCount };
}

test('product runtime composes export operation creation, status and download', async () => {
  const { runtime } = harness();
  const created = await runtime.createExport(request({}, { 'Idempotency-Key': 'export-1' }), {
    idempotencyKey: 'export-1',
    requestId: 'request-1'
  });
  assert.equal(created.duplicate, false);
  const status = await runtime.exportStatus(request(), created.operation.id);
  assert.equal(status.status, 'ready');
  const data = await runtime.downloadExport(request(), created.operation.id);
  assert.equal(data.kind, 'cochpia.product.export');
  assert.equal(data.data.memoryModule.rawEvents.length, 0);
});

test('product runtime clears local product state only after account memory deletion succeeds', async () => {
  const { runtime, state, getPersistCount } = harness();
  const result = await runtime.deleteAccount(request({}, { 'Idempotency-Key': 'account-delete-1' }));
  assert.equal(result.ok, true);
  assert.equal(result.deletion.status, 'completed');
  assert.equal(result.manifest.status, 'completed');
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.messages, {});
  assert.equal(state.deletionRecords.length, 1);
  assert.ok(getPersistCount() >= 2);
});

test('product runtime restores the application state when session memory deletion fails', async () => {
  const { runtime, state, memory } = harness();
  const original = structuredClone(state);
  const requestValue = request({}, { 'Idempotency-Key': 'session-delete-1' });
  memory.deleteSession = async () => { throw new Error('memory delete failed'); };
  await assert.rejects(
    () => runtime.deleteSession(requestValue, 'session-1'),
    /memory delete failed/
  );
  assert.equal(state.sessions[0].id, original.sessions[0].id);
});
