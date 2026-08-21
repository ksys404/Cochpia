import { useEffect, useMemo, useRef, useState } from 'react';
import { useProfile } from '../profile/ProfileProvider';
import CharacterSprite from '../characters/CharacterSprite';
import { advanceLife, getActions, getTimeLabels, loadLifeState, resetLifeState, resolveDecision, saveLifeState } from './lifeGameEngine';
import { getLifeLocationId, getLifeSceneAssets } from './lifeSceneAssets';

const NEEDS = [['energy', '精力', '⚡'], ['mood', '心情', '☼'], ['social', '社交', '◎'], ['health', '健康', '＋']];
const PLACES = [
  ['bridge', '中央天桥', '城市通勤与偶遇发生的地方', '◇', 'walk'],
  ['cafe', '微光咖啡馆', '一盏暖灯，留给关系和停顿', '○', 'cafe'],
  ['home', '公寓', '可以恢复，也可以独处的房间', '⌂', 'home']
];

export default function LifeGame({ onChat }) {
  const { profile } = useProfile();
  const [state, setState] = useState(loadLifeState);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [direction, setDirection] = useState('down');
  const actionTimer = useRef(null);
  const actions = useMemo(() => getActions(), []);
  const timeLabels = getTimeLabels();
  const locationId = getLifeLocationId(state.location);
  const sceneAssets = useMemo(() => getLifeSceneAssets(state.location), [state.location]);

  useEffect(() => { saveLifeState(state); }, [state]);
  useEffect(() => () => {
    if (actionTimer.current !== null) window.clearTimeout(actionTimer.current);
  }, []);

  const act = actionId => {
    if (busy || state.pendingDecision) return;
    const chosenId = state.mode === 'observe' ? actions[(state.day + state.needs.mood) % actions.length].id : actionId;
    const chosenAction = actions.find(action => action.id === chosenId);
    setBusy(true);
    setAnnouncement(`行动处理中：${chosenAction?.label || '正在推进生活'}，请稍候。`);
    setDirection(chosenId === 'work' ? 'right' : chosenId === 'cafe' ? 'left' : 'down');
    actionTimer.current = window.setTimeout(() => {
      actionTimer.current = null;
      setState(current => advanceLife(current, chosenId));
      setBusy(false);
      setAnnouncement(`${chosenAction?.label || '行动'}已完成。`);
    }, 420);
  };
  const decide = optionId => {
    if (busy || !state.pendingDecision) return;
    const option = state.pendingDecision.options.find(item => item.id === optionId);
    setState(current => resolveDecision(current, optionId));
    setAnnouncement(option ? `已选择：${option.label}。状态已更新。` : '决定已处理。');
  };
  const reset = () => { if (!busy && window.confirm('重新开始这段共生人生？')) setState(resetLifeState()); };
  const controlsDisabled = busy || Boolean(state.pendingDecision);

  return <div className="life-game">
    <div className="life-status-live" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    <header className="life-game-head"><div><p className="eyebrow">SYMBIOTIC LIFE · 视觉垂直切片</p><h2>{profile.name || 'Cochpia'} 的玻璃城生活</h2><p className="life-sub">第 {state.day} 天 · {timeLabels[state.timeOfDay]} · 当前在 {state.location}</p></div><div className="life-game-head-actions"><button type="button" className={`life-mode ${state.mode}`} disabled={controlsDisabled} aria-pressed={state.mode === 'participate'} aria-label={`当前模式：${state.mode === 'participate' ? '参与模式' : '观测模式'}，点击切换模式`} title={`当前${state.mode === 'participate' ? '参与' : '观测'}模式，点击切换`} onClick={() => { const mode = state.mode === 'participate' ? 'observe' : 'participate'; setState(current => ({ ...current, mode })); setAnnouncement(`已切换为${mode === 'participate' ? '参与' : '观测'}模式。`); }}>{state.mode === 'participate' ? '参与模式' : '观测模式'}</button><button type="button" className="text-button muted-button" disabled={busy} onClick={reset}>重新开始</button></div></header>
    <section className={`life-scene life-time-${state.timeOfDay} life-location-${locationId}`} data-location={locationId} data-time={state.timeOfDay} aria-label={`玻璃城场景，当前地点：${state.location}`}>
      <div className="life-scene-layer life-scene-background" data-scene-layer="background" style={sceneAssets.background ? { backgroundImage: `url(${sceneAssets.background})` } : undefined} aria-hidden="true" />
      <div className="life-scene-layer life-scene-midground" data-scene-layer="midground" style={sceneAssets.midground ? { backgroundImage: `url(${sceneAssets.midground})` } : undefined} aria-hidden="true"><div className="life-location-art"><div className="life-skyline"><i /><i /><i /><i /><i /></div><div className="life-building building-a" /><div className="life-building building-b" /><div className="life-bridge" /><div className="life-window-wall" /><div className="life-table" /><div className="life-seat" /><div className="life-room-object" /></div></div>
      <div className="life-scene-layer life-scene-foreground" data-scene-layer="foreground" style={sceneAssets.foreground ? { backgroundImage: `url(${sceneAssets.foreground})` } : undefined} aria-hidden="true" />
      <div className="life-scene-layer life-scene-lighting" data-scene-layer="lighting" style={sceneAssets.lighting ? { backgroundImage: `url(${sceneAssets.lighting})` } : undefined} aria-hidden="true"><div className="life-scene-glow" /></div>
      <div className="life-scene-character" data-character-layer="primary">{profile.characterSheet ? <CharacterSprite sheet={profile.characterSheet} animation={profile.characterAnimation || undefined} direction={direction} walking={busy} scale={2.2} alt={profile.name} /> : profile.avatarImage ? <img src={profile.avatarImage} alt="" /> : <span aria-hidden="true">{profile.avatar}</span>}</div>
      <div className="life-scene-caption"><strong>{state.location}</strong><span>{busy ? '行动处理中…' : state.lastAction ? actions.find(item => item.id === state.lastAction)?.label : '今天会从哪里开始？'}</span></div>
    </section>
    <section className="life-places" aria-label="玻璃城地点">{PLACES.map(([id, label, description, icon, actionId]) => <button key={id} type="button" className={`life-place ${state.location === label ? 'active' : ''}`} disabled={controlsDisabled} aria-label={`${label}：${description}，点击${actions.find(action => action.id === actionId)?.label || '行动'}`} onClick={() => act(actionId)}><span aria-hidden="true">{icon}</span><span><strong>{label}</strong><small>{description}</small></span></button>)}</section>
    <section className="life-needs">{NEEDS.map(([key, label, icon]) => <div className="life-need" key={key}><div><span>{icon} {label}</span><b>{state.needs[key]}</b></div><div className="life-need-bar"><i style={{ width: `${state.needs[key]}%` }} /></div></div>)}<div className="life-relationship"><span>与你的关系</span><b>{state.relationship}</b><small>共同经历留下的变化</small></div></section>
    {state.currentEvent && <section className="life-event-card"><div><p className="eyebrow">最近事件 · DAY {state.currentEvent.day}</p><h3>{state.currentEvent.place}</h3><p>{state.currentEvent.text}</p></div><span className="life-event-mark" aria-hidden="true">{state.currentEvent.timeOfDay === 'night' ? '☾' : '✦'}</span></section>}
    {state.lastChanges?.length > 0 && <section className="life-change-summary"><div><p className="eyebrow">本次行动变化</p><strong>状态已更新</strong></div><div className="life-change-list">{state.lastChanges.map(change => <span key={change.key} className={change.value > 0 ? 'up' : 'down'}>{change.label} {change.value > 0 ? '+' : ''}{change.value}</span>)}</div></section>}
    {state.pendingDecision && <section className="life-decision"><p className="eyebrow">A MOMENT TO CHOOSE · 关键岔路</p><h3>{state.pendingDecision.title}</h3><p>{state.pendingDecision.prompt}</p><div>{state.pendingDecision.options.map(option => <button key={option.id} type="button" className="life-option" disabled={busy} onClick={() => decide(option.id)}>{option.label}</button>)}</div></section>}
    <section className="life-actions" aria-busy={busy}><div className="life-section-title"><span>下一步行动</span><small>{busy ? '行动处理中，请稍候…' : state.mode === 'observe' ? '观测模式：由它自己决定' : '选择一个行动推进一天'}</small></div><div className="life-action-grid">{actions.map(action => <button key={action.id} type="button" className="life-action" disabled={controlsDisabled} onClick={() => act(action.id)}><span className="life-action-icon">{action.icon}</span><strong>{busy ? '处理中…' : action.label}</strong><small>{action.place}</small></button>)}</div></section>
    <section className="life-events"><div className="life-section-title"><span>最近发生</span><small>状态仅保存在本机</small></div>{state.recentEvents.length === 0 ? <p className="empty-detail">推进一天后，这里会出现它的生活片段。</p> : state.recentEvents.map(event => <article className="life-event" key={event.id}><span>DAY {event.day}</span><div><strong>{event.place}</strong><p>{event.text}</p></div></article>)}</section>
    <footer className="life-game-foot"><button type="button" className="select-model" onClick={onChat}>返回聊天</button><span>游戏状态与聊天入口保持独立；可以随时回来继续。</span></footer>
  </div>;
}
