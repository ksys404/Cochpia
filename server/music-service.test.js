import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockMusicAdapter, createMusicService } from './music-service.js';

test('music service mock adapter follows play, pause, resume, next, and stop flow', async () => {
  const service = createMusicService({ adapter: createMockMusicAdapter() });
  const results = await service.search('rain');
  assert.equal(results.length, 2);
  assert.equal((await service.play(results[0])).state, 'playing');
  assert.equal((await service.pause()).state, 'paused');
  assert.equal((await service.resume()).state, 'playing');
  assert.equal((await service.next()).state, 'playing');
  assert.equal((await service.stop()).state, 'stopped');
});

test('music service rejects empty searches and exposes listening context', async () => {
  const service = createMusicService();
  await assert.rejects(service.search(''), error => error.code === 'INVALID_MUSIC_QUERY');
  assert.equal((await service.listeningContext()).aiContext, '');
});
