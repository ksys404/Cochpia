import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentService } from './agent-service.js';

test('agent service creates, updates, and removes agents', async () => {
  const state = {};
  const service = createAgentService(state, async () => {});
  const agent = await service.create({ name: 'Aria', persona: '温柔', provider: 'deepseek', model: 'deepseek-chat', avatar: '✦' });
  assert.equal(agent.name, 'Aria');
  assert.equal(service.list().length, 1);
  const updated = await service.update(agent.id, { relationship: '挚友' });
  assert.equal(updated.relationship, '挚友');
  assert.equal(await service.remove(agent.id), true);
  assert.equal(service.list().length, 0);
});

test('agent service rejects empty names', () => {
  const service = createAgentService({}, async () => {});
  assert.throws(() => service.create({ name: '' }), /name/);
});
