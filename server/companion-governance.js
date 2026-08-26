import { randomUUID } from 'node:crypto';

export const PRODUCT_EXPORT_VERSION = 2;
export const PRODUCT_EXPORT_OPERATION_STATUSES = Object.freeze(['ready', 'stale', 'expired']);
export const DEFAULT_PRODUCT_EXPORT_TTL_MS = 60 * 60 * 1000;

const clone = value => value == null ? value : structuredClone(value);

export class CompanionGovernanceError extends Error {
  constructor(code, message, { status = 400, retryable = false } = {}) {
    super(message);
    this.name = 'CompanionGovernanceError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function subjectOf(context = {}) {
  const tenantId = String(context.tenantId ?? context.tenant_id ?? '').trim();
  const subjectUserId = String(context.subjectUserId ?? context.userId ?? context.user_id ?? '').trim();
  if (!tenantId || !subjectUserId) throw new CompanionGovernanceError('GOVERNANCE_CONTEXT_REQUIRED', 'Tenant and subject user are required', { status: 400 });
  return { tenantId, subjectUserId };
}

function safeSequence(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key) return randomUUID();
  if (key.length > 200) throw new CompanionGovernanceError('INVALID_IDEMPOTENCY_KEY', 'Idempotency key must be 1-200 characters', { status: 400 });
  return key;
}

export function ensureCompanionGovernanceState(state) {
  if (!state || typeof state !== 'object') throw new TypeError('Companion governance state is required');
  state.companion ||= {};
  state.companion.sessionMappings ||= {};
  state.companion.exportOperations ||= [];
  state.companion.interactionOutbox ||= [];
  state.companion.dataRevision = safeSequence(state.companion.dataRevision);
  return state.companion;
}

export function bumpCompanionDataRevision(state) {
  const companion = ensureCompanionGovernanceState(state);
  companion.dataRevision += 1;
  return companion.dataRevision;
}

export function productDataInventory({ storageProvider = 'unknown' } = {}) {
  return [
    {
      id: 'application.messages',
      owner: 'companion-runtime.state',
      export: 'included',
      delete: 'account/session delete clears canonical messages',
      verify: 'state inspection plus chat reconciliation'
    },
    {
      id: 'memory-module.canonical-and-derived',
      owner: 'memory-module',
      export: 'included',
      delete: 'memory governance delete propagates raw events, assertions, versions and derived rows',
      verify: 'memory deletion operation and recovery negative-read check'
    },
    {
      id: 'personality.projection',
      owner: 'personality-projection',
      export: 'included',
      delete: 'account delete resets projection, history and audit content',
      verify: 'projection owner state and evidence references'
    },
    {
      id: 'relationship.projection',
      owner: 'relationship-state',
      export: 'included',
      delete: 'account delete clears relationship state; relationship delete is memory-owned for memory data',
      verify: 'relationship state and source-event provenance'
    },
    {
      id: 'life-state.world-derived',
      owner: 'life-state',
      export: 'included',
      delete: 'account delete resets LifeState and its event-backed mapping',
      verify: 'LifeState revision and canonical event reconciliation'
    },
    {
      id: 'tasks.events.agents.preferences',
      owner: 'companion-runtime.state',
      export: 'included',
      delete: 'account delete clears product-local records',
      verify: 'state inspection'
    },
    {
      id: 'application.uploads',
      owner: 'companion-runtime.upload-store',
      export: 'included with owner-scoped file payloads',
      delete: 'account delete stages, purges and records owner-scoped upload files',
      verify: 'upload manifest, file existence and deletion cleanup status'
    },
    {
      id: 'interaction-event-outbox',
      owner: 'companion-runtime.interaction-outbox',
      export: 'included',
      delete: 'account delete clears pending, completed and dead-letter ingress envelopes',
      verify: 'outbox status plus Memory raw-event reconciliation'
    },
    {
      id: 'context-cache',
      owner: 'memory-module-cache',
      export: 'metadata-only',
      delete: 'subject generation bump invalidates cached bounded ContextBundle; physical purge is asynchronous',
      verify: 'cache generation and canonical read-after-delete'
    },
    {
      id: 'operational-logs',
      owner: 'deployment logging sink',
      export: 'excluded',
      delete: 'operator-managed retention and redaction policy',
      verify: 'log-sink audit; not claimed by this application export'
    },
    {
      id: 'backups-pitr',
      owner: `${storageProvider}-backup-operator`,
      export: 'excluded',
      delete: 'retention policy plus deletion-ledger replay before restore exposure',
      verify: 'backup/PITR restore drill and tombstone replay'
    },
    {
      id: 'external-model-provider-copies',
      owner: 'configured model provider',
      export: 'metadata-only',
      delete: 'provider retention/deletion SLA required; application does not claim provider-side erasure',
      verify: 'provider contract, region/training setting and audit evidence'
    }
  ];
}

function exportLocalState(state) {
  const keys = [
    'sessions', 'messages', 'tasks', 'events', 'agents', 'evidence',
    'personality', 'personalityHistory', 'personalityAudit', 'personalityProjection',
    'relationshipStates', 'lifeState', 'companion', 'deletionRecords', 'uploads',
    'profile', 'workspacePreferences', 'workspacePreferencesUpdatedAt', 'mode'
  ];
  const result = {};
  for (const key of keys) result[key] = clone(state[key] ?? null);
  if (result.companion && typeof result.companion === 'object') {
    const { uploadOwnerKey: _uploadOwnerKey, ...safeCompanion } = result.companion;
    result.companion = {
      ...safeCompanion,
      exportOperations: (safeCompanion.exportOperations || []).map(operation => {
        const { idempotencyKey: _idempotencyKey, ...safeOperation } = operation || {};
        return safeOperation;
      })
    };
  }
  return result;
}

export function buildProductExportManifest({
  state,
  context,
  operation = null,
  memorySnapshot = null,
  reconciliation = [],
  uploadFiles = null,
  storageProvider = 'unknown',
  now = new Date()
} = {}) {
  const subject = subjectOf(context);
  const memoryData = memorySnapshot?.data ?? null;
  const localData = exportLocalState(state);
  return {
    kind: 'cochpia.product.export',
    version: PRODUCT_EXPORT_VERSION,
    exportedAt: new Date(now).toISOString(),
    scope: subject,
    operation: operation ? clone(operation) : null,
    consistency: {
      localDataRevision: safeSequence(operation?.localDataRevision ?? state?.companion?.dataRevision),
      memoryOperationId: operation?.memoryOperationId || memorySnapshot?.operation?.id || null,
      memoryStatus: memorySnapshot?.operation?.status || null,
      complete: Boolean(memoryData)
    },
    inventory: productDataInventory({ storageProvider }),
    data: {
      ...localData,
      uploads: uploadFiles ?? localData.uploads ?? [],
      memoryModule: clone(memoryData),
      reconciliation: clone(reconciliation)
    }
  };
}

function operationStatus(operation, state, memoryStatus, now = new Date()) {
  if (operation.expiresAt && new Date(operation.expiresAt).getTime() <= new Date(now).getTime()) return 'expired';
  if (safeSequence(state?.companion?.dataRevision) !== safeSequence(operation.localDataRevision)) return 'stale';
  if (memoryStatus === 'expired' || memoryStatus === 'stale' || memoryStatus === 'missing') return memoryStatus === 'missing' ? 'stale' : memoryStatus;
  return operation.status || 'ready';
}

function publicOperation(operation, { status, memoryStatus, now } = {}) {
  return {
    id: operation.id,
    kind: operation.kind,
    tenantId: operation.tenantId,
    subjectUserId: operation.subjectUserId,
    status: status || operation.status || 'ready',
    memoryStatus: memoryStatus || null,
    localDataRevision: safeSequence(operation.localDataRevision),
    memoryOperationId: operation.memoryOperationId,
    requestedAt: operation.requestedAt,
    completedAt: operation.completedAt,
    expiresAt: operation.expiresAt,
    resourceRevision: operation.resourceRevision || 1,
    ...(now ? { checkedAt: new Date(now).toISOString() } : {})
  };
}

export function getProductExportOperation({ state, memory, context, id, now = new Date() } = {}) {
  const subject = subjectOf(context);
  const companion = ensureCompanionGovernanceState(state);
  const operation = companion.exportOperations.find(item => item.id === String(id) && item.tenantId === subject.tenantId && item.subjectUserId === subject.subjectUserId);
  if (!operation) return null;
  const memoryOperation = memory?.getExportOperation ? memory.getExportOperation(context, operation.memoryOperationId) : null;
  const memoryStatus = memoryOperation?.status || 'missing';
  const status = operationStatus(operation, state, memoryStatus, now);
  return {
    ...publicOperation(operation, { status, memoryStatus, now }),
    consistencyToken: memoryOperation?.consistencyToken || null
  };
}

export async function createProductExportOperation({
  state,
  memory,
  context,
  persist = async () => {},
  idempotencyKey,
  requestId = null,
  ttlMs = DEFAULT_PRODUCT_EXPORT_TTL_MS,
  now = new Date()
} = {}) {
  const subject = subjectOf(context);
  if (!memory?.createExportOperation) throw new TypeError('Memory export operation is required');
  const companion = ensureCompanionGovernanceState(state);
  const key = normalizeIdempotencyKey(idempotencyKey);
  const existing = companion.exportOperations.find(item => item.tenantId === subject.tenantId && item.subjectUserId === subject.subjectUserId && item.idempotencyKey === key);
  if (existing) {
    return { operation: getProductExportOperation({ state, memory, context, id: existing.id, now }), duplicate: true };
  }
  const memoryOperation = await memory.createExportOperation(context, { idempotency_key: key });
  const boundedTtl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Math.min(Number(ttlMs), 24 * 60 * 60 * 1000) : DEFAULT_PRODUCT_EXPORT_TTL_MS;
  const requestedAt = new Date(now).toISOString();
  const operation = {
    id: randomUUID(),
    kind: 'product',
    tenantId: subject.tenantId,
    subjectUserId: subject.subjectUserId,
    idempotencyKey: key,
    requestId: requestId ? String(requestId).slice(0, 128) : null,
    status: 'ready',
    memoryOperationId: memoryOperation.id,
    localDataRevision: safeSequence(companion.dataRevision),
    requestedAt,
    completedAt: requestedAt,
    expiresAt: new Date(new Date(now).getTime() + boundedTtl).toISOString(),
    resourceRevision: 1
  };
  companion.exportOperations.push(operation);
  try {
    await persist();
  } catch (error) {
    companion.exportOperations = companion.exportOperations.filter(item => item.id !== operation.id);
    throw error;
  }
  return { operation: getProductExportOperation({ state, memory, context, id: operation.id, now }), duplicate: false };
}

export async function downloadProductExport({
  state,
  memory,
  context,
  id,
  reconciliation = [],
  uploadFiles = null,
  storageProvider = 'unknown',
  now = new Date()
} = {}) {
  const operation = getProductExportOperation({ state, memory, context, id, now });
  if (!operation) throw new CompanionGovernanceError('EXPORT_OPERATION_NOT_FOUND', 'Product export operation not found', { status: 404 });
  if (operation.status === 'expired') throw new CompanionGovernanceError('EXPORT_OPERATION_EXPIRED', 'Product export operation has expired', { status: 410 });
  if (operation.status === 'stale') throw new CompanionGovernanceError('EXPORT_SNAPSHOT_STALE', 'Canonical product data changed after the export operation was created', { status: 409 });
  const memorySnapshot = await memory.downloadExport(context, operation.memoryOperationId);
  const current = getProductExportOperation({ state, memory, context, id, now });
  if (!current || current.status !== 'ready') {
    if (current?.status === 'expired') throw new CompanionGovernanceError('EXPORT_OPERATION_EXPIRED', 'Product export operation has expired', { status: 410 });
    throw new CompanionGovernanceError('EXPORT_SNAPSHOT_STALE', 'Canonical product data changed during export download', { status: 409 });
  }
  return buildProductExportManifest({
    state,
    context,
    operation: current,
    memorySnapshot,
    reconciliation,
    uploadFiles,
    storageProvider,
    now
  });
}

export function sweepProductExportOperations(state, { now = new Date() } = {}) {
  const companion = ensureCompanionGovernanceState(state);
  const before = companion.exportOperations.length;
  const timestamp = new Date(now).getTime();
  companion.exportOperations = companion.exportOperations.filter(operation => !operation.expiresAt || new Date(operation.expiresAt).getTime() > timestamp);
  return { removed: before - companion.exportOperations.length, remaining: companion.exportOperations.length };
}

export function buildProductDeletionManifest({
  context,
  memoryDeletion = null,
  deletionOperationId = memoryDeletion?.deletionOperationId || null,
  storageProvider = 'unknown',
  localStateCleared = false,
  uploadCleanup = null,
  now = new Date()
} = {}) {
  const subject = subjectOf(context);
  const requestedAt = new Date(now).toISOString();
  const cleanup = uploadCleanup || { status: localStateCleared ? 'completed' : 'pending' };
  const complete = localStateCleared && memoryDeletion?.status === 'completed' && cleanup.status === 'completed';
  return {
    kind: 'cochpia.product.deletion',
    version: 1,
    scope: subject,
    deletionOperationId,
    status: complete ? 'completed' : 'partially_completed',
    requestedAt,
    completedAt: complete ? requestedAt : null,
    components: productDataInventory({ storageProvider }).map(item => ({
      id: item.id,
      owner: item.owner,
      action: item.delete,
      status: item.id === 'operational-logs' || item.id === 'backups-pitr' || item.id === 'external-model-provider-copies'
        ? 'operator_or_provider_required'
        : item.id === 'application.uploads'
          ? cleanup.status
        : localStateCleared ? 'completed' : 'pending',
      verification: item.verify
    })),
    memoryDeletion: clone(memoryDeletion),
    uploadCleanup: clone(cleanup),
    notes: [
      'Application state and Memory Module canonical data are separate owners.',
      'This response does not claim provider-side model deletion, log erasure, or backup physical destruction.',
      'Backups/PITR must replay the deletion ledger before restored traffic is opened.'
    ]
  };
}

export function clearProductUserState(state, baseState, { preserveDeletionRecords = true } = {}) {
  if (!state || !baseState) throw new TypeError('state and baseState are required');
  const next = structuredClone(baseState);
  next.sessions = [];
  next.messages = {};
  next.tasks = [];
  next.events = [];
  next.agents = [];
  next.memories = [];
  next.evidence = [];
  next.personalityHistory = [];
  next.personalityAudit = [];
  next.personalityProjection = { appliedEvidenceIds: [], appliedSourceEventIds: [] };
  next.lifeState = clone(baseState.lifeState || null);
  next.relationshipStates = {};
  next.companion = { sessionMappings: {}, exportOperations: [], interactionOutbox: [], dataRevision: 0 };
  next.workspacePreferences = null;
  next.workspacePreferencesUpdatedAt = null;
  next.deletionRecords = preserveDeletionRecords ? clone(state.deletionRecords || []) : [];
  next.uploads = [];
  return next;
}
