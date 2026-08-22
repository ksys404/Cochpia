import assert from 'node:assert/strict';
import { replayRedactionLedger } from './memory-module-recovery.js';

function visibleLeak(state, tombstone) {
  const sameSubject = item => item?.tenantId === tombstone.tenantId && item?.userId === tombstone.userId;
  const targetMemory = tombstone.targetType === 'memory' ? tombstone.targetId : null;
  const targetSession = tombstone.targetType === 'session' ? tombstone.targetId : null;
  const targetRelationship = tombstone.targetType === 'relationship' ? tombstone.targetId : null;
  const targetSource = tombstone.targetType === 'source_event' ? tombstone.targetId : null;
  const accountTarget = tombstone.targetType === 'account';
  const activeAssertions = (state.assertions || []).filter(assertion => sameSubject(assertion)
    && assertion.status === 'active'
    && (targetMemory ? assertion.id === targetMemory
      : targetSession ? assertion.sessionId === targetSession
        : targetRelationship ? assertion.scopeType === 'relationship' && assertion.relationshipAgentId === targetRelationship
          : accountTarget || targetSource));
  const indexed = (state.indexDocuments || []).filter(document => sameSubject(document)
    && (targetMemory ? document.sourceId === targetMemory
      : targetSource ? (document.sourceRefs || []).includes(targetSource)
        : targetSession ? document.sessionId === targetSession
          : targetRelationship ? document.relationshipAgentId === targetRelationship
            : accountTarget));
  const snapshotItems = (state.profileSnapshotItems || []).filter(item => sameSubject(item)
    && (targetMemory ? item.assertionId === targetMemory : accountTarget));
  const activeStates = (state.currentStates || []).filter(item => sameSubject(item)
    && item.status === 'active'
    && (targetSession ? item.sessionId === targetSession : accountTarget));
  const replayableOutbox = (state.outboxEvents || []).filter(item => sameSubject(item)
    && (targetMemory ? item.aggregateId === targetMemory : targetSource ? item.aggregateId === targetSource : accountTarget)
    && item.result !== 'redacted_during_recovery');
  return { activeAssertions, indexed, snapshotItems, activeStates, replayableOutbox };
}

export function checkRecoveryState(state, ledger) {
  assert.ok(state && typeof state === 'object', 'recovery state must be an object');
  assert.ok(Array.isArray(ledger) && ledger.length > 0, 'recovery ledger must contain at least one tombstone');
  state.tombstones = [...(state.tombstones || []), ...ledger];
  const replay = replayRedactionLedger(state);
  const leaks = ledger.map(tombstone => ({ tombstoneId: tombstone.id || null, ...visibleLeak(state, tombstone) }))
    .filter(result => Object.values(result).some(value => Array.isArray(value) && value.length));
  if (leaks.length) {
    const error = new Error('Recovery replay left visible or replayable memory references');
    error.code = 'MEMORY_RECOVERY_LEAK_DETECTED';
    error.leakCount = leaks.length;
    throw error;
  }
  return { replayApplied: replay.applied, tombstoneCount: ledger.length };
}
