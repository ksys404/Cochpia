import test from 'node:test';
import assert from 'node:assert/strict';
import { featureEnabled, resolveMemoryFeatureFlags } from './memory-module-flags.js';

test('memory features are independently disabled by default and can be enabled per flag', () => {
  const flags = resolveMemoryFeatureFlags({}, { autoExtract: true, vectorRetrieval: true });
  assert.equal(flags.autoExtract, true);
  assert.equal(flags.vectorRetrieval, true);
  assert.equal(flags.hybridRetrieval, false);
  assert.equal(featureEnabled(flags, 'autoExtract'), true);
  assert.equal(featureEnabled(flags, 'episodeGrouping'), false);
});

test('environment flag names are stable and do not turn unrelated features on', () => {
  const flags = resolveMemoryFeatureFlags({ MEMORY_AUTO_EXTRACT: 'true', MEMORY_VECTOR_RETRIEVAL: '1' });
  assert.equal(flags.autoExtract, true);
  assert.equal(flags.vectorRetrieval, true);
  assert.equal(flags.autoProfileUpdate, false);
});
