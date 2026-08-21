import test from 'node:test';
import assert from 'node:assert/strict';
import { createNeteaseMusicAdapter } from './netease-music-adapter.js';

const fakeClient = calls => ({
  async call(name, args) {
    calls.push({ name, args });
    if (name === 'search_song') return { content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 7, name: 'Rain', artist: 'C' }] }) }] };
    if (name === 'get_status') return { content: [{ type: 'text', text: JSON.stringify({ state: 'playing', track: { id: 7, title: 'Rain' } }) }] };
    return { content: [{ type: 'text', text: '{}' }] };
  }
});

test('netease adapter maps MCP search and playback tools', async () => {
  const calls = [];
  const adapter = createNeteaseMusicAdapter({ client: fakeClient(calls) });
  const results = await adapter.search('rain');
  assert.equal(results[0].source, 'netease');
  await adapter.play(results[0]);
  await adapter.pause();
  assert.deepEqual(calls.map(item => item.name), ['search_song', 'play_track', 'get_status', 'pause', 'get_status']);
});
