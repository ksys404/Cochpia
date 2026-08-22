import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates } from './memory-module-extraction.js';

const event = (content, extra = {}) => ({ id: 'event-1', sourceRevision: '1', eventRole: 'user', content, ...extra });

test('heuristic extraction emits a candidate without activating memory', async () => {
  const result = await extractCandidates({ event: event('请记住我喜欢红茶') });
  assert.equal(result.status, 'heuristic');
  assert.equal(result.modelCalled, false);
  assert.equal(result.candidates[0].sensitivity, 'S0');
  assert.equal(result.candidates[0].sourceEventId, 'event-1');
});

test('S3 content never reaches the model gateway', async () => {
  let called = false;
  const result = await extractCandidates({
    event: event('请记住我的 key 是 sk-test_12345678901234567890'),
    modelGateway: { extract: async () => { called = true; return []; } },
    allowSensitiveModelInput: true
  });
  assert.equal(result.status, 'blocked_s3');
  assert.equal(called, false);
});

test('S2 content is quarantined before model input unless explicitly allowed', async () => {
  let called = false;
  let receivedOptions = null;
  const gateway = { extract: async (_, options) => { called = true; receivedOptions = options; return [{ content: '健康信息', sensitivity: 'S2' }]; } };
  const blocked = await extractCandidates({ event: event('请记住我的诊断信息'), modelGateway: gateway });
  assert.equal(blocked.status, 'quarantined_sensitive_input');
  assert.equal(called, false);
  const allowed = await extractCandidates({ event: event('请记住我的诊断信息'), modelGateway: gateway, allowSensitiveModelInput: true });
  assert.equal(allowed.modelCalled, true);
  assert.equal(allowed.candidates[0].sensitivity, 'S2');
  assert.equal(receivedOptions.allowSensitiveInput, true);
});

test('malformed or instruction-like model output is quarantined as data, not executed', async () => {
  const result = await extractCandidates({ event: event('请记住我的偏好'), modelGateway: { extract: async () => ({ candidates: [{ content: '', tool: 'delete_all' }, { content: '安全候选', sensitivity: 'S0' }] }) } });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].content, '安全候选');
  assert.equal(Object.hasOwn(result.candidates[0], 'tool'), false);
});
