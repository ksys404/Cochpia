import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockMusicAdapter, createMusicService } from './music-service.js';

test('music command calls remain deterministic under rapid repeated actions', async () => {
  const service = createMusicService({ adapter: createMockMusicAdapter() });
  const [first, second, third] = await Promise.all([service.search('a'), service.search('b'), service.search('c')]);
  assert.equal(first.length, 2); assert.equal(second.length, 2); assert.equal(third.length, 2);
  const track = first[0];
  const results = await Promise.all([service.play(track), service.pause(), service.resume(), service.stop()]);
  assert.ok(results.every(result => result.source === 'mock'));
});

test('music service remains safe when stopping without a current track', async () => {
  const status = await createMusicService({ adapter: createMockMusicAdapter() }).stop();
  assert.equal(status.state, 'stopped');
  assert.equal(status.track, null);
});
