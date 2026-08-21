import { execFileSync } from 'node:child_process';
import { createStdioMcpClient } from './stdio-mcp-client.js';

const textFromResult = result => result?.content?.find(item => item.type === 'text')?.text || '';
const parseResult = result => { const text = textFromResult(result); try { return text ? JSON.parse(text) : result; } catch { return { text }; } };
const normalizeTrack = (track = {}) => ({ id: String(track.id || track.songId || ''), title: track.title || track.name || '', artist: track.artist || track.artists?.map(item => item.name).join(', ') || '', album: track.album || track.albumName || '', durationMs: Number(track.durationMs || track.duration || 0), coverUrl: track.coverUrl || track.picUrl || '', source: 'netease' });

export const checkLocalMusicEnvironment = ({ command = 'neteasecli', mpvCommand = 'mpv' } = {}) => {
  const check = value => { try { execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [value], { stdio: 'ignore' }); return true; } catch { return false; } };
  return { available: check(command) && check(mpvCommand), source: 'netease', neteaseCliAvailable: check(command), mpvAvailable: check(mpvCommand), message: check(command) && check(mpvCommand) ? 'NetEase local player dependencies are available' : 'neteasecli and mpv are required' };
};

export function createNeteaseMusicAdapter({ client, command = 'neteasecli', mpvCommand = 'mpv' } = {}) {
  let current = null;
  let state = 'stopped';
  const mcp = client || createStdioMcpClient({ command: process.env.MUSIC_MCP_COMMAND || 'node', args: process.env.MUSIC_MCP_ARGS ? JSON.parse(process.env.MUSIC_MCP_ARGS) : [process.env.MUSIC_MCP_SERVER || 'src/server.js'] });
  const call = async (name, args) => parseResult(await mcp.call(name, args));
  return {
    async checkEnvironment() { return checkLocalMusicEnvironment({ command, mpvCommand }); },
    async search(query) { const result = await call('search_song', { query }); return (result.items || result.songs || result.results || []).map(normalizeTrack); },
    async play(track) { const result = await call(track?.id ? 'play_track' : 'play_song', track?.id ? { id: track.id, songId: track.id } : { query: track?.title || track?.query || '' }); current = normalizeTrack(result.track || track); state = 'playing'; return this.status(); },
    async pause() { await call('pause'); state = 'paused'; return this.status(); },
    async resume() { await call('resume'); state = 'playing'; return this.status(); },
    async next() { const result = await call('next_song'); current = normalizeTrack(result.track || result); state = 'playing'; return this.status(); },
    async stop() { await call('stop'); state = 'stopped'; return this.status(); },
    async status() { const result = await call('get_status'); return { source: 'netease', state: result.state || state, track: normalizeTrack(result.track || current), queue: result.queue || [], updatedAt: new Date().toISOString() }; },
    async listeningContext() { return call('get_listening_context'); },
    close() { mcp.close?.(); }
  };
}
