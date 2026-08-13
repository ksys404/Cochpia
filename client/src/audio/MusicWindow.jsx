import React, { useState } from 'react';
import { FloatingWindow } from '../windows/WindowManager';
import { useMusic } from './MusicProvider';

export function MusicWindow() {
  const { state, searchResults, search, play, pause, resume, next, stop, refreshStatus, checkEnvironment, getListeningContext } = useMusic();
  const [query, setQuery] = useState('');
  const [environment, setEnvironment] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async action => { setBusy(true); try { await action(); } finally { setBusy(false); } };
  const handleSearch = event => { event.preventDefault(); if (query.trim()) void run(() => search(query.trim())); };
  const handleEnvironmentCheck = () => void run(async () => { setEnvironment(await checkEnvironment()); });
  const handleContext = () => void run(async () => { const context = await getListeningContext(); window.dispatchEvent(new CustomEvent('cochpia:music-context', { detail: context })); });
  return <FloatingWindow id="music" title="音乐"><div className="music-window">
    <header className="music-window-heading"><div><p className="eyebrow">音乐桥接</p><h2>{state.track?.title || '当前没有播放曲目'}</h2><p>{state.track?.artist || '连接本地音乐来源'}</p></div><span className={`music-state music-state-${state.state}`}>{state.state}</span></header>
    <form className="music-search" onSubmit={handleSearch}><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索歌曲" aria-label="搜索歌曲" /><button type="submit" disabled={busy || !query.trim()}>搜索</button></form>
    <div className="music-results">{searchResults.map(track => <button type="button" className="music-result" key={track.id} onClick={() => void run(() => play(track))}><strong>{track.title || '未命名曲目'}</strong><span>{track.artist || '未知艺人'}</span></button>)}</div>
    <div className="music-controls"><button type="button" onClick={() => void run(state.state === 'playing' ? pause : resume)} disabled={busy || !state.track}>{state.state === 'playing' ? '暂停' : '继续'}</button><button type="button" onClick={() => void run(next)} disabled={busy}>下一首</button><button type="button" onClick={() => void run(stop)} disabled={busy || !state.track}>停止</button></div>
    <div className="music-actions"><button type="button" className="text-button" onClick={handleEnvironmentCheck}>检查环境</button><button type="button" className="text-button" onClick={() => void run(refreshStatus)}>刷新</button><button type="button" className="text-button" onClick={handleContext}>读取上下文</button></div>
    {environment && <p className={`music-note ${environment.available ? 'is-ready' : 'is-unready'}`}>{environment.message}</p>}
    {state.error && <p className="music-note is-unready">{state.error.message}</p>}
  </div></FloatingWindow>;
}
