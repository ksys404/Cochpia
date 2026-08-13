import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeConversation, maybeCompactConversation } from './compaction.js';

const fakeModel = () => ({ generate: async ({ message }) => `摘要:${message.length}` });

test('summarizeConversation returns a trimmed summary from the model', async () => {
  const summary = await summarizeConversation(fakeModel(), [{ role: 'user', content: 'hi' }], '');
  assert.match(summary, /^摘要:/);
});

test('maybeCompactConversation only compacts above the threshold and caches by summarizedCount', async () => {
  const session = { id: 's1', summary: '', summarizedCount: 0 };
  const messages = Array.from({ length: 35 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const model = fakeModel();
  const first = await maybeCompactConversation(session, messages, model);
  assert.equal(first.changed, true);
  assert.match(session.summary, /^摘要:/);
  assert.equal(session.summarizedCount, 23);

  const second = await maybeCompactConversation(session, messages, model);
  assert.equal(second.changed, false);

  const more = messages.concat(Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, role: 'user', content: `more${i}` })));
  const third = await maybeCompactConversation(session, more, model);
  assert.equal(third.changed, true);
  assert.equal(session.summarizedCount, 28);
});

test('maybeCompactConversation skips when under threshold', async () => {
  const session = { id: 's2', summary: '', summarizedCount: 0 };
  const messages = Array.from({ length: 10 }, (_, i) => ({ id: String(i), role: 'user', content: `m${i}` }));
  const result = await maybeCompactConversation(session, messages, fakeModel());
  assert.equal(result.changed, false);
  assert.equal(session.summary, '');
});
