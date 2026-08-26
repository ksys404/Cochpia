import { randomUUID } from 'node:crypto';
import { reconcileChat } from './companion-reconciliation.js';
import {
  buildProductDeletionManifest,
  clearProductUserState,
  createProductExportOperation,
  downloadProductExport,
  getProductExportOperation,
  sweepProductExportOperations
} from './companion-governance.js';
import { mergeState } from './state-merge.js';
import { ensureUploadOwnerKey } from './upload-store.js';

export class CompanionProductRuntimeError extends Error {
  constructor(code, message, { status = 503, retryable = false, cause = undefined } = {}) {
    super(message, { cause });
    this.name = 'CompanionProductRuntimeError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
function requireObject(value, name) {
  if (!value || typeof value !== 'object') throw new TypeError(`${name} is required`);
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} is required`);
}

/**
 * Cross-component product governance boundary.
 *
 * This runtime owns orchestration only: local product state, Memory Module
 * snapshots/deletions, upload-file staging, and chat stream cleanup. Domain
 * policy remains in companion-governance.js, Memory Module, and upload-store.js.
 */
export function createCompanionProductRuntime({
  state,
  baseState,
  getState = () => state,
  persist = async () => {},
  storageProvider = 'json',
  nodeEnv = 'development',
  memoryRuntime,
  uploadStore,
  chatStreamJournal,
  disableChatStreamJournals,
  activeRuns = new Map(),
  activeGroupRuns = new Set(),
  pendingRunReservations = new Set(),
  hasActiveUserInteraction,
  currentUserId = () => 'local-user'
} = {}) {
  requireObject(state, 'Product runtime state');
  requireObject(baseState, 'Product runtime base state');
  requireFunction(getState, 'Product runtime state resolver');
  requireFunction(persist, 'Product runtime persist');
  if (!memoryRuntime?.prepareForRequest || !memoryRuntime?.contextFromRequest || !memoryRuntime?.moduleForRequest || !memoryRuntime?.ensureChatSession) {
    throw new TypeError('Product runtime Memory Module runtime is required');
  }
  if (!uploadStore?.exportRecords || !uploadStore?.importRecords || !uploadStore?.stageUserDeletion) {
    throw new TypeError('Product runtime upload store is required');
  }
  if (!chatStreamJournal?.remove) throw new TypeError('Product runtime chat stream journal is required');
  requireFunction(disableChatStreamJournals, 'Product runtime stream journal disable hook');
  requireFunction(hasActiveUserInteraction, 'Product runtime interaction activity check');
  requireFunction(currentUserId, 'Product runtime user resolver');

  const accountDeletionInProgress = new Set();
  const sessionDeletionInProgress = new Set();
  let accountDeleteLocalSaveFailureInjected = false;

  const currentState = req => getState(req) || state;
  const currentUser = req => String(currentUserId(req) || 'local-user');

  const productExportReconciliation = (memory, req = undefined) => {
    const current = currentState(req);
    return (current.sessions || []).map(session => {
      const memorySessionId = current.companion?.sessionMappings?.[session.id] || session.id;
      const rawEvents = (memory?.state?.rawEvents || []).filter(event =>
        event.sessionId === memorySessionId || event.metadata?.source_id === session.id
      );
      return reconcileChat({
        sessionId: session.id,
        messages: current.messages?.[session.id] || [],
        rawEvents
      });
    });
  };

  const createExport = async (req, { idempotencyKey, requestId = null, ttlMs = process.env.PRODUCT_EXPORT_OPERATION_TTL_MS } = {}) => {
    const memory = await memoryRuntime.prepareForRequest(req);
    const swept = sweepProductExportOperations(currentState(req));
    if (swept.removed) await persist({ bumpCommitSequence: false });
    return createProductExportOperation({
      state,
      memory,
      context: memoryRuntime.contextFromRequest(req),
      persist: () => persist({ bumpCommitSequence: false }),
      idempotencyKey,
      requestId,
      ttlMs
    });
  };

  const exportStatus = async (req, id) => {
    const memory = await memoryRuntime.prepareForRequest(req);
    return getProductExportOperation({
      state,
      memory,
      context: memoryRuntime.contextFromRequest(req),
      id
    });
  };

  const downloadExport = async (req, id) => {
    const memory = await memoryRuntime.prepareForRequest(req);
    const uploadFiles = await uploadStore.exportRecords({ userId: currentUser(req), records: currentState(req).uploads || [] });
    return downloadProductExport({
      state,
      memory,
      context: memoryRuntime.contextFromRequest(req),
      id,
      reconciliation: productExportReconciliation(memory, req),
      uploadFiles,
      storageProvider
    });
  };

  const importProductState = async req => {
    const current = currentState(req);
    const snapshot = structuredClone(current);
    const importedUploads = [];
    try {
      const supplied = req.body?.state;
      if (!supplied || typeof supplied !== 'object') {
        throw new CompanionProductRuntimeError('INVALID_IMPORT', 'Import state is required', { status: 400 });
      }
      const incoming = supplied.kind === 'cochpia.product.export' && supplied.data && typeof supplied.data === 'object'
        ? supplied.data
        : supplied;
      const merged = mergeState(current, incoming);
      const existingUploads = Array.isArray(current.uploads) ? current.uploads : [];
      const incomingUploads = Array.isArray(incoming.uploads) ? incoming.uploads : [];
      const uploadAlreadyPresent = item => existingUploads.some(existing =>
        existing?.id === item?.id || (existing?.sourceId && existing.sourceId === item?.id)
      );
      const missingUploadPayload = incomingUploads.filter(item => item && !item.dataUrl && !uploadAlreadyPresent(item));
      if (missingUploadPayload.length) {
        throw new CompanionProductRuntimeError('UPLOAD_IMPORT_PAYLOAD_REQUIRED', 'Uploaded file payload is required for import', { status: 400 });
      }
      const importableUploads = incomingUploads.filter(item => item?.dataUrl && !uploadAlreadyPresent(item));
      if (importableUploads.length) {
        importedUploads.push(...await uploadStore.importRecords({
          userId: currentUser(req),
          records: importableUploads,
          storageKey: ensureUploadOwnerKey(current),
          existingRecords: existingUploads
        }));
      }
      merged.uploads = [...existingUploads, ...importedUploads];
      Object.assign(current, merged);
      await memoryRuntime.prepareForRequest(req);
      await persist();
      return { ok: true, importedAt: new Date().toISOString() };
    } catch (error) {
      await Promise.all(importedUploads.map(item => uploadStore.removeRecord(item).catch(cleanupError => {
        console.error(JSON.stringify({ event: 'import_upload_rollback_failed', code: cleanupError.code || 'IMPORT_UPLOAD_ROLLBACK_FAILED' }));
      })));
      for (const key of Object.keys(current)) delete current[key];
      Object.assign(current, snapshot);
      try { await persist(); } catch (recoveryError) {
        console.error(JSON.stringify({ event: 'import_recovery_persist_failed', code: recoveryError.code || 'IMPORT_RECOVERY_PERSIST_FAILED' }));
      }
      throw error;
    }
  };

  const deleteSession = async (req, sessionId) => {
    const userId = currentUser(req);
    const sessionRunKey = `${userId}:${sessionId}`;
    if (sessionDeletionInProgress.has(sessionRunKey)) {
      throw new CompanionProductRuntimeError('SESSION_DELETE_IN_PROGRESS', 'Session deletion is already in progress', { status: 409 });
    }
    if (activeRuns.has(sessionRunKey) || activeGroupRuns.has(sessionRunKey) || pendingRunReservations.has(sessionRunKey)) {
      throw new CompanionProductRuntimeError('SESSION_CHAT_ACTIVE', 'Cannot delete a session while an interaction is running', { status: 409 });
    }
    const current = currentState(req);
    const index = (current.sessions || []).findIndex(session => session.id === sessionId);
    if (index === -1) throw new CompanionProductRuntimeError('SESSION_NOT_FOUND', 'Session not found', { status: 404 });
    sessionDeletionInProgress.add(sessionRunKey);
    const sessionSnapshot = structuredClone(current.sessions[index]);
    const hadMessages = Object.hasOwn(current.messages || {}, sessionId);
    const messagesSnapshot = structuredClone(current.messages?.[sessionId] || []);
    const hadSessionMapping = Object.hasOwn(current.companion?.sessionMappings || {}, sessionId);
    const sessionMappingSnapshot = current.companion?.sessionMappings?.[sessionId];
    const restoreApplicationSession = async () => {
      if (!current.sessions.some(session => session.id === sessionId)) {
        current.sessions.splice(Math.min(index, current.sessions.length), 0, structuredClone(sessionSnapshot));
      }
      if (hadMessages) current.messages[sessionId] = structuredClone(messagesSnapshot);
      else delete current.messages[sessionId];
      current.companion ||= {};
      current.companion.sessionMappings ||= {};
      if (hadSessionMapping) current.companion.sessionMappings[sessionId] = sessionMappingSnapshot;
      else delete current.companion.sessionMappings[sessionId];
      try { await persist(); } catch (rollbackError) {
        console.error(JSON.stringify({ event: 'session_delete_rollback_failed', code: rollbackError.code || 'SESSION_DELETE_ROLLBACK_FAILED' }));
      }
    };
    try {
      const memorySessionId = await memoryRuntime.ensureChatSession(req, sessionId);
      const memory = memoryRuntime.moduleForRequest(req);
      const memorySession = memory.state.sessions.find(item => item.id === memorySessionId);
      const memoryContext = memoryRuntime.contextFromRequest(req, { chat: true, sessionId: memorySessionId });
      const memoryDeleteInput = memorySession ? {
        resourceRevision: memorySession.resourceRevision || 1,
        idempotency_key: req.get('Idempotency-Key') || `session-delete:${sessionId}:${memorySession.resourceRevision || 1}`
      } : null;
      disableChatStreamJournals({ userId, sessionId });
      current.sessions.splice(index, 1);
      delete current.messages[sessionId];
      if (current.companion?.sessionMappings) delete current.companion.sessionMappings[sessionId];
      try {
        await persist();
      } catch (error) {
        await restoreApplicationSession();
        throw error;
      }
      let memoryDeletion = null;
      if (memorySession) {
        try {
          memoryDeletion = await memory.deleteSession(memoryContext, memorySessionId, memoryDeleteInput);
        } catch (error) {
          await restoreApplicationSession();
          throw error;
        }
      }
      await chatStreamJournal.remove({ userId, sessionId });
      return { deleted: true, sessionId, memoryDeletion };
    } finally {
      sessionDeletionInProgress.delete(sessionRunKey);
    }
  };

  const deleteAccount = async req => {
    const userId = currentUser(req);
    if (accountDeletionInProgress.has(userId)) {
      throw new CompanionProductRuntimeError('ACCOUNT_DELETE_IN_PROGRESS', 'Account deletion is already in progress', { status: 409 });
    }
    if (hasActiveUserInteraction(userId)) {
      throw new CompanionProductRuntimeError('ACCOUNT_CHAT_ACTIVE', 'Cannot delete an account while an interaction is running', { status: 409 });
    }
    const current = currentState(req);
    const localSnapshot = structuredClone(current);
    accountDeletionInProgress.add(userId);
    const idempotencyKey = req.get('Idempotency-Key') || req.body?.idempotencyKey || `account-delete:${userId}`;
    let uploadDeletion = null;
    let uploadCommitted = false;
    const persistAccountDeleteLocalState = async () => {
      if (nodeEnv === 'test'
        && process.env.COCHPIA_TEST_FAIL_ACCOUNT_DELETE_FINAL_SAVE === 'once'
        && !accountDeleteLocalSaveFailureInjected) {
        accountDeleteLocalSaveFailureInjected = true;
        throw new CompanionProductRuntimeError('ACCOUNT_DELETE_LOCAL_PERSIST_INJECTED_FAILURE', 'Injected account delete local persistence failure', { status: 503 });
      }
      return persist();
    };
    try {
      const memory = await memoryRuntime.prepareForRequest(req);
      const context = memoryRuntime.contextFromRequest(req);
      const uploadStorageKey = current.companion?.uploadOwnerKey || null;
      uploadDeletion = await uploadStore.stageUserDeletion(userId, `account-${idempotencyKey}`, uploadStorageKey);
      const memoryDeletion = await memory.deleteAccount(context, { idempotency_key: idempotencyKey });
      disableChatStreamJournals({ userId });
      await chatStreamJournal.remove({ userId });
      const cleared = clearProductUserState(current, baseState);
      cleared.memoryModule = structuredClone(memory.state);
      const stagedUploadCleanup = {
        status: uploadDeletion.existed ? 'staged' : 'completed',
        ownerId: userId,
        operationId: uploadDeletion.operationId,
        fileStore: 'companion-runtime.upload-store'
      };
      const deletionManifest = buildProductDeletionManifest({
        context,
        memoryDeletion,
        storageProvider,
        localStateCleared: true,
        uploadCleanup: stagedUploadCleanup
      });
      cleared.deletionRecords = [{
        id: memoryDeletion.deletionOperationId,
        targetType: 'account',
        status: deletionManifest.status,
        memoryDeletion,
        manifest: deletionManifest,
        requestedAt: new Date().toISOString(),
        completedAt: deletionManifest.completedAt
      }];
      for (const key of Object.keys(current)) delete current[key];
      Object.assign(current, cleared);
      try {
        await persistAccountDeleteLocalState();
      } catch (error) {
        const committedMemoryState = structuredClone(memory.state);
        for (const key of Object.keys(current)) delete current[key];
        Object.assign(current, localSnapshot);
        current.memoryModule = committedMemoryState;
        try { await persist(); } catch (recoveryError) {
          console.error(JSON.stringify({ event: 'account_delete_local_recovery_persist_failed', code: recoveryError.code || 'ACCOUNT_DELETE_LOCAL_RECOVERY_PERSIST_FAILED' }));
        }
        throw error;
      }
      try {
        await uploadStore.commitUserDeletion(uploadDeletion);
        uploadCommitted = true;
      } catch (error) {
        const record = current.deletionRecords.find(item => item.id === memoryDeletion.deletionOperationId);
        const pendingManifest = buildProductDeletionManifest({
          context,
          memoryDeletion,
          storageProvider,
          localStateCleared: true,
          uploadCleanup: { ...stagedUploadCleanup, status: 'pending', errorCode: error.code || 'UPLOAD_DELETE_FAILED' }
        });
        if (record) {
          record.status = pendingManifest.status;
          record.manifest = pendingManifest;
          record.completedAt = null;
        }
        try { await persist(); } catch (persistError) {
          console.error(JSON.stringify({ event: 'account_delete_upload_cleanup_persist_failed', code: persistError.code || 'ACCOUNT_DELETE_UPLOAD_CLEANUP_PERSIST_FAILED' }));
        }
        uploadDeletion = null;
        throw new CompanionProductRuntimeError('ACCOUNT_UPLOAD_DELETE_PENDING', 'Account data was cleared, but uploaded files still require cleanup', { status: 503, cause: error });
      }
      const completeManifest = buildProductDeletionManifest({
        context,
        memoryDeletion,
        storageProvider,
        localStateCleared: true,
        uploadCleanup: { ...stagedUploadCleanup, status: 'completed' }
      });
      const deletionRecord = current.deletionRecords.find(item => item.id === memoryDeletion.deletionOperationId);
      if (deletionRecord) {
        deletionRecord.status = completeManifest.status;
        deletionRecord.manifest = completeManifest;
        deletionRecord.completedAt = completeManifest.completedAt;
      }
      try {
        await persist();
      } catch (error) {
        console.error(JSON.stringify({ event: 'account_delete_manifest_persist_failed', code: error.code || 'ACCOUNT_DELETE_MANIFEST_PERSIST_FAILED' }));
        throw new CompanionProductRuntimeError('ACCOUNT_DELETE_MANIFEST_PERSIST_FAILED', 'Account data was cleared but the deletion manifest could not be finalized', { status: 503, cause: error });
      }
      return { ok: true, deletion: memoryDeletion, manifest: completeManifest, localStateCleared: true };
    } catch (error) {
      if (uploadDeletion && !uploadCommitted) {
        try { await uploadStore.rollbackUserDeletion(uploadDeletion); } catch (rollbackError) {
          console.error(JSON.stringify({ event: 'account_delete_upload_rollback_failed', code: rollbackError.code || 'ACCOUNT_DELETE_UPLOAD_ROLLBACK_FAILED' }));
        }
      }
      throw error;
    } finally {
      accountDeletionInProgress.delete(userId);
    }
  };

  return {
    accountDeletionInProgress,
    createExport,
    deleteAccount,
    deleteSession,
    downloadExport,
    exportStatus,
    importProductState,
    isAccountDeletionInProgress: userId => accountDeletionInProgress.has(String(userId || 'local-user')),
    isSessionDeletionInProgress: key => sessionDeletionInProgress.has(String(key)),
    productExportReconciliation,
    sessionDeletionInProgress
  };
}
