import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProductDeletionManifest,
  buildProductExportManifest,
  createProductExportOperation,
  ensureCompanionGovernanceState,
  getProductExportOperation,
  sweepProductExportOperations
} from './companion-governance.js';

function state() {
  return {
    sessions: [{ id: 'session-1', title: '相遇' }],
    messages: { 'session-1': [{ id: 'message-1', role: 'user', content: 'hello' }] },
    tasks: [{ id: 'task-1', title: 'walk' }],
    events: [{ id: 'event-1', title: 'anniversary' }],
    agents: [{ id: 'agent-1', name: 'Aria' }],
    evidence: [{ id: 'evidence-1', claim: 'careful' }],
    personality: { version: 2 },
    personalityHistory: [{ id: 'personality-1', version: 1 }],
    personalityAudit: [{ id: 'audit-1' }],
    personalityProjection: { appliedEvidenceIds: ['evidence-1'] },
    relationshipStates: { 'cochpia:agent-1': { score: 0.5 } },
    lifeState: { revision: 4 },
    companion: { sessionMappings: { 'session-1': 'memory-session-1' }, uploadOwnerKey: 'private-storage-key', dataRevision: 7, exportOperations: [] },
    deletionRecords: [],
    profile: { name: 'Cochpia' },
    workspacePreferences: { theme: 'light' },
    workspacePreferencesUpdatedAt: '2026-08-24T00:00:00.000Z',
    mode: 'companion'
  };
}

function context() {
  return { tenantId: 'tenant-1', subjectUserId: 'user-1', actorType: 'user', actorId: 'user-1' };
}

function memoryStub() {
  const operations = new Map();
  return {
    async createExportOperation(_context, _input) {
      const operation = { id: 'memory-export-1', status: 'ready', consistencyToken: 'memory-token' };
      operations.set(operation.id, operation);
      return operation;
    },
    getExportOperation(_context, id) { return operations.get(id) || null; },
    async downloadExport(_context, id) {
      const operation = operations.get(id);
      return { version: 1, operation, data: { rawEvents: [{ id: 'raw-1' }], assertions: [] } };
    }
  };
}

test('product export operation is subject-bound and becomes stale on local data revision change', async () => {
  const current = state();
  const memory = memoryStub();
  const created = await createProductExportOperation({ state: current, memory, context: context(), idempotencyKey: 'export-1' });
  assert.equal(created.duplicate, false);
  assert.equal(created.operation.status, 'ready');
  const replay = await createProductExportOperation({ state: current, memory, context: context(), idempotencyKey: 'export-1' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.operation.id, created.operation.id);

  current.companion.dataRevision += 1;
  const stale = getProductExportOperation({ state: current, memory, context: context(), id: created.operation.id });
  assert.equal(stale.status, 'stale');
});

test('product export manifest includes local data, memory snapshot and explicit external ownership boundaries', () => {
  const manifest = buildProductExportManifest({
    state: state(),
    context: context(),
    operation: { id: 'product-export-1', localDataRevision: 7, memoryOperationId: 'memory-export-1' },
    memorySnapshot: { operation: { id: 'memory-export-1', status: 'ready' }, data: { rawEvents: [{ id: 'raw-1' }] } },
    storageProvider: 'postgres',
    reconciliation: [{ sessionId: 'session-1', ok: true }]
  });
  assert.equal(manifest.kind, 'cochpia.product.export');
  assert.equal(manifest.consistency.complete, true);
  assert.equal(manifest.data.messages['session-1'][0].id, 'message-1');
  assert.equal(manifest.data.memoryModule.rawEvents[0].id, 'raw-1');
  assert.equal(manifest.data.reconciliation[0].ok, true);
  assert.equal(manifest.inventory.find(item => item.id === 'operational-logs').export, 'excluded');
  assert.equal(manifest.inventory.find(item => item.id === 'external-model-provider-copies').delete.includes('does not claim'), true);
  assert.equal(Object.hasOwn(manifest.data.companion.exportOperations[0] || {}, 'idempotencyKey'), false);
  assert.equal(Object.hasOwn(manifest.data.companion, 'uploadOwnerKey'), false);
});

test('expired product export metadata is swept without touching canonical data', () => {
  const current = state();
  ensureCompanionGovernanceState(current).exportOperations.push({ id: 'expired', expiresAt: '2026-08-23T00:00:00.000Z' });
  ensureCompanionGovernanceState(current).exportOperations.push({ id: 'live', expiresAt: '2026-08-25T00:00:00.000Z' });
  const result = sweepProductExportOperations(current, { now: new Date('2026-08-24T00:00:00.000Z') });
  assert.deepEqual(result, { removed: 1, remaining: 1 });
  assert.equal(current.messages['session-1'][0].content, 'hello');
});

test('deletion manifest distinguishes application completion from operator/provider obligations', () => {
  const manifest = buildProductDeletionManifest({
    context: context(),
    memoryDeletion: { deletionOperationId: 'delete-1', status: 'completed' },
    storageProvider: 'postgres',
    localStateCleared: true,
    now: new Date('2026-08-24T00:00:00.000Z')
  });
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.deletionOperationId, 'delete-1');
  assert.equal(manifest.components.find(item => item.id === 'application.messages').status, 'completed');
  assert.equal(manifest.components.find(item => item.id === 'backups-pitr').status, 'operator_or_provider_required');
  assert.equal(manifest.components.find(item => item.id === 'external-model-provider-copies').status, 'operator_or_provider_required');
});

test('product export creation rolls back local metadata when the local persistence step fails', async () => {
  const current = state();
  await assert.rejects(
    () => createProductExportOperation({ state: current, memory: memoryStub(), context: context(), idempotencyKey: 'export-failure', persist: async () => { throw new Error('persist failed'); } }),
    /persist failed/
  );
  assert.equal(current.companion.exportOperations.length, 0);
});

test('product export status fails closed when its Memory operation is missing', async () => {
  const current = state();
  const memory = memoryStub();
  const created = await createProductExportOperation({ state: current, memory, context: context(), idempotencyKey: 'export-missing' });
  memory.getExportOperation = () => null;
  const status = getProductExportOperation({ state: current, memory, context: context(), id: created.operation.id });
  assert.equal(status.status, 'stale');
  assert.equal(status.memoryStatus, 'missing');
});
