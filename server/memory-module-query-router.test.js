import test from 'node:test';
import assert from 'node:assert/strict';
import { routeMemoryQuery } from './memory-module-query-router.js';

test('query router maps roadmap retrieval modes deterministically', () => {
  assert.equal(routeMemoryQuery('我的 tea 偏好是什么？'), 'profile_exact');
  assert.equal(routeMemoryQuery('我现在的目标是什么？'), 'state_current');
  assert.equal(routeMemoryQuery('我在 release 这段经历里做了什么？'), 'episode_recall');
  assert.equal(routeMemoryQuery('我们之间的共同记忆是什么？'), 'relationship_recall');
  assert.equal(routeMemoryQuery('请把 preference 和 plan 关联起来，只用一跳证据'), 'bridge_candidate');
  assert.equal(routeMemoryQuery('当 current_plan 存在两个版本时应如何回答？'), 'unknown');
  assert.equal(routeMemoryQuery('current_plan'), 'unknown');
  assert.equal(routeMemoryQuery('moon_city 有什么证据？'), 'unknown');
  assert.equal(routeMemoryQuery(''), 'unknown');
});
