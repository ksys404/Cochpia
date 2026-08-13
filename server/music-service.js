const createTrack = (query, index = 0) => ({
  id: `mock-${index + 1}`,
  title: query || 'Quiet Morning',
  artist: 'Cochpia Ambient Library',
  album: 'Local Preview',
  durationMs: 180000,
  coverUrl: '',
  source: 'mock'
});

export const musicStates = new Set(['stopped', 'playing', 'paused']);

export function createMockMusicAdapter() {
  let currentTrack = null;
  let playbackState = 'stopped';

  return {
    async checkEnvironment() { return { available: true, source: 'mock', message: 'Mock music adapter is ready' }; },
    async search(query) { return [createTrack(String(query || '').trim(), 0), createTrack(`${String(query || 'Ambient')} II`, 1)]; },
    async play(track) { currentTrack = track || createTrack(); playbackState = 'playing'; return this.status(); },
    async pause() { if (currentTrack) playbackState = 'paused'; return this.status(); },
    async resume() { if (currentTrack) playbackState = 'playing'; return this.status(); },
    async next() { currentTrack = createTrack('Next ambient track', 1); playbackState = 'playing'; return this.status(); },
    async stop() { playbackState = 'stopped'; return this.status(); },
    async status() { return { source: 'mock', state: playbackState, track: currentTrack, queue: [], updatedAt: new Date().toISOString() }; },
    async listeningContext() { return { source: 'mock', track: currentTrack, lyrics: '', aiContext: currentTrack ? `Currently listening to ${currentTrack.title} by ${currentTrack.artist}.` : '' }; }
  };
}

export function createMusicService({ adapter = createMockMusicAdapter() } = {}) {
  const call = async (method, ...args) => {
    if (typeof adapter[method] !== 'function') {
      const error = new Error(`Music adapter does not support ${method}`);
      error.code = 'MUSIC_ADAPTER_UNSUPPORTED';
      throw error;
    }
    return adapter[method](...args);
  };
  return {
    environment: () => call('checkEnvironment'),
    search: async query => { if (!String(query || '').trim()) { const error = new Error('Search query is required'); error.code = 'INVALID_MUSIC_QUERY'; throw error; } return call('search', query); },
    play: track => call('play', track),
    pause: () => call('pause'),
    resume: () => call('resume'),
    next: () => call('next'),
    stop: () => call('stop'),
    status: () => call('status'),
    listeningContext: () => call('listeningContext')
  };
}
