import { useEffect, useMemo, useRef, useState } from 'react';
import { useProfile } from '../profile/ProfileProvider';
import { api } from '../api';
import CharacterSprite from '../characters/CharacterSprite';
import { getActions, getTimeLabels, makeLifeCommandKey } from './lifeGameEngine';
import { createLifeCommandQueue, isRetryableLifeError } from './lifeCommandQueue';
import { getLifeLocationId, getLifeSceneAssets } from './lifeSceneAssets';

const NEEDS = [['energy', '精力', '⚡'], ['mood', '心情', '☼'], ['social', '社交', '◎'], ['health', '健康', '＋']];
const PLACES = [
  ['bridge', '中央天桥', '城市通勤与偶遇发生的地方', '◇', 'walk'],
  ['cafe', '微光咖啡馆', '一盏暖灯，留给关系和停顿', '○', 'cafe'],
  ['home', '公寓', '可以恢复，也可以独处的房间', '⌂', 'home']
];

export default function LifeGame({ onChat, sessionId = null, subjectId = 'local-user' }) {
  const { profile } = useProfile();
  const [state, setState] = useState(null);
  const [companionContext, setCompanionContext] = useState(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [loadError, setLoadError] = useState('');
  const [direction, setDirection] = useState('down');
  const [queuedCount, setQueuedCount] = useState(0);
  const actionTimer = useRef(null);
  const actions = useMemo(() => getActions(), []);
  const subjectScope = String(subjectId || 'local-user').trim() || 'local-user';
  const commandQueue = useMemo(() => createLifeCommandQueue(undefined, subjectScope), [subjectScope]);
  const timeLabels = getTimeLabels();

  const applyCanonicalState = nextState => {
    if (!nextState || typeof nextState !== 'object') return;
    setState(current => {
      const currentRevision = Number(current?.resourceRevision || 0);
      const nextRevision = Number(nextState.resourceRevision || 0);
      return nextRevision >= currentRevision ? nextState : current;
    });
  };

  const refreshQueueCount = () => setQueuedCount(commandQueue.size());
  const lifeSessionId = sessionId || null;
  const lifeContextPath = lifeSessionId ? `/api/life/context?sessionId=${encodeURIComponent(lifeSessionId)}` : '/api/life/context';
  const refreshCompanionContext = async () => {
    const payload = await api(lifeContextPath);
    setCompanionContext(payload.context || null);
    return payload;
  };

  const replayQueuedCommands = async () => {
    let replayRevision = null;
    for (const command of commandQueue.list()) {
      try {
        const body = replayRevision == null
          ? command.body
          : { ...command.body, expectedRevision: replayRevision, resourceRevision: replayRevision };
        const payload = await api(command.path, {
          method: 'POST',
          headers: { 'Idempotency-Key': command.idempotencyKey },
          body: JSON.stringify(body)
        });
        applyCanonicalState(payload.state);
        refreshCompanionContext().catch(() => {});
        if (['pending', 'processing'].includes(payload.event?.status)) {
          setAnnouncement('生活状态已更新，但共同经历仍在等待同步；会继续自动重试。');
          break;
        }
        commandQueue.remove(command.idempotencyKey);
        replayRevision = payload.state?.resourceRevision ?? replayRevision;
      } catch (error) {
        if (error?.status === 409) {
          commandQueue.remove(command.idempotencyKey);
          try { applyCanonicalState((await api('/api/life/state')).state); } catch { /* keep the last canonical state */ }
          setAnnouncement('离线行动与其他设备的状态冲突，已刷新为服务端状态。');
          break;
        }
        if (isRetryableLifeError(error)) break;
        commandQueue.remove(command.idempotencyKey);
      }
    }
    refreshQueueCount();
  };

  useEffect(() => {
    let active = true;
    api('/api/life/state')
      .then(payload => { if (active) applyCanonicalState(payload.state); })
      .catch(error => { if (active) setLoadError(error.message || '无法读取服务端生活状态'); });
    refreshCompanionContext().catch(() => {});
    return () => { active = false; };
  }, [lifeContextPath]);
  useEffect(() => {
    replayQueuedCommands();
    window.addEventListener('online', replayQueuedCommands);
    return () => window.removeEventListener('online', replayQueuedCommands);
  }, [commandQueue]);
  useEffect(() => () => {
    if (actionTimer.current !== null) window.clearTimeout(actionTimer.current);
  }, []);
  const locationId = getLifeLocationId(state?.location);
  const sceneAssets = useMemo(() => getLifeSceneAssets(state?.location), [state?.location]);

  const submit = async (path, body, key, successMessage) => {
    const command = {
      path,
      body: { ...body, sessionId: lifeSessionId, idempotencyKey: key },
      idempotencyKey: key
    };
    try {
      const payload = await api(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify(command.body)
      });
      applyCanonicalState(payload.state);
      refreshCompanionContext().catch(() => {});
      if (['pending', 'processing'].includes(payload.event?.status)) {
        commandQueue.enqueue(command);
        refreshQueueCount();
        setAnnouncement('状态已更新，但共同经历仍在等待同步；恢复连接后会自动重试。');
        return { queued: true, payload };
      }
      setAnnouncement(successMessage);
      return payload;
    } catch (error) {
      if (!isRetryableLifeError(error)) throw error;
      commandQueue.enqueue(command);
      refreshQueueCount();
      setAnnouncement('网络暂时不可用，行动已排队；恢复连接后会自动重放。');
      return { queued: true };
    }
  };

  const act = actionId => {
    if (!state || busy || state.pendingDecision) return;
    const chosenId = state.mode === 'observe' ? actions[(state.day + state.needs.mood) % actions.length].id : actionId;
    const chosenAction = actions.find(action => action.id === chosenId);
    const key = makeLifeCommandKey(`life-action-${chosenId}`);
    setBusy(true);
    setAnnouncement(`行动处理中：${chosenAction?.label || '正在推进生活'}，请稍候。`);
    setDirection(chosenId === 'work' ? 'right' : chosenId === 'cafe' ? 'left' : 'down');
    actionTimer.current = window.setTimeout(async () => {
      actionTimer.current = null;
      try {
        await submit('/api/life/actions', { actionId: chosenId, expectedRevision: state.resourceRevision }, key, `${chosenAction?.label || '行动'}已完成。`);
      } catch (error) {
        setAnnouncement(error.code === 'LIFE_STATE_REVISION_CONFLICT' ? '生活状态已在其他设备更新，请重新读取。' : (error.message || '行动未能提交，请稍后重试。'));
      } finally { setBusy(false); }
    }, 420);
  };
  const decide = async optionId => {
    if (!state || busy || !state.pendingDecision) return;
    const option = state.pendingDecision.options.find(item => item.id === optionId);
    const key = makeLifeCommandKey(`life-decision-${optionId}`);
    setBusy(true);
    try {
      await submit('/api/life/decisions', { optionId, expectedRevision: state.resourceRevision }, key, option ? `已选择：${option.label}。状态已更新。` : '决定已处理。');
    } catch (error) { setAnnouncement(error.message || '决定未能提交，请稍后重试。'); }
    finally { setBusy(false); }
  };
  const toggleMode = async () => {
    if (!state || busy) return;
    const mode = state.mode === 'participate' ? 'observe' : 'participate';
    const key = makeLifeCommandKey(`life-mode-${mode}`);
    setBusy(true);
    try { await submit('/api/life/mode', { mode, expectedRevision: state.resourceRevision }, key, `已切换为${mode === 'participate' ? '参与' : '观测'}模式。`); }
    catch (error) { setAnnouncement(error.message || '模式切换未能提交，请稍后重试。'); }
    finally { setBusy(false); }
  };
  const reset = async () => {
    if (!state || busy || !window.confirm('重新开始这段共生人生？')) return;
    const key = makeLifeCommandKey('life-reset');
    setBusy(true);
    try { await submit('/api/life/reset', { expectedRevision: state.resourceRevision }, key, '共生人生已重新开始。'); }
    catch (error) { setAnnouncement(error.message || '重置未能提交，请稍后重试。'); }
    finally { setBusy(false); }
  };
  if (!state) {
    return <div className="life-game"><div className="life-status-live" role="status" aria-live="polite">{loadError || '正在读取服务端生活状态…'}</div>{loadError && <button type="button" className="select-model" onClick={() => window.location.reload()}>重新读取</button>}</div>;
  }
  const controlsDisabled = busy || Boolean(state.pendingDecision);
  const visibleMemoryCount = ['coreMemory', 'userProfile', 'relationshipProfile', 'currentState', 'relevantEpisodes']
    .reduce((count, key) => count + (Array.isArray(companionContext?.memoryBundle?.[key]) ? companionContext.memoryBundle[key].length : 0), 0);

  return <div className="life-game">
    <div className="life-status-live" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    <header className="life-game-head"><div><p className="eyebrow">SYMBIOTIC LIFE · 服务端状态</p><h2>{profile.name || 'Cochpia'} 的玻璃城生活</h2><p className="life-sub">第 {state.day} 天 · {timeLabels[state.timeOfDay]} · 当前在 {state.location}{queuedCount > 0 ? ` · ${queuedCount} 个行动待同步` : ''}</p></div><div className="life-game-head-actions"><button type="button" className={`life-mode ${state.mode}`} disabled={controlsDisabled} aria-pressed={state.mode === 'participate'} aria-label={`当前模式：${state.mode === 'participate' ? '参与模式' : '观测模式'}，点击切换模式`} title={`当前${state.mode === 'participate' ? '参与' : '观测'}模式，点击切换`} onClick={toggleMode}>{state.mode === 'participate' ? '参与模式' : '观测模式'}</button><button type="button" className="text-button muted-button" disabled={busy} onClick={reset}>重新开始</button></div></header>
    <section className={`life-scene life-time-${state.timeOfDay} life-location-${locationId}`} data-location={locationId} data-time={state.timeOfDay} aria-label={`玻璃城场景，当前地点：${state.location}`}>
      <div className="life-scene-layer life-scene-background" data-scene-layer="background" style={sceneAssets.background ? { backgroundImage: `url(${sceneAssets.background})` } : undefined} aria-hidden="true" />
      <div className="life-scene-layer life-scene-midground" data-scene-layer="midground" style={sceneAssets.midground ? { backgroundImage: `url(${sceneAssets.midground})` } : undefined} aria-hidden="true"><div className="life-location-art"><div className="life-skyline"><i /><i /><i /><i /><i /></div><div className="life-building building-a" /><div className="life-building building-b" /><div className="life-bridge" /><div className="life-window-wall" /><div className="life-table" /><div className="life-seat" /><div className="life-room-object" /></div></div>
      <div className="life-scene-layer life-scene-foreground" data-scene-layer="foreground" style={sceneAssets.foreground ? { backgroundImage: `url(${sceneAssets.foreground})` } : undefined} aria-hidden="true" />
      <div className="life-scene-layer life-scene-lighting" data-scene-layer="lighting" style={sceneAssets.lighting ? { backgroundImage: `url(${sceneAssets.lighting})` } : undefined} aria-hidden="true"><div className="life-scene-glow" /></div>
      <div className="life-scene-character" data-character-layer="primary">{profile.characterSheet ? <CharacterSprite sheet={profile.characterSheet} animation={profile.characterAnimation || undefined} direction={direction} walking={busy} scale={2.2} alt={profile.name} /> : profile.avatarImage ? <img src={profile.avatarImage} alt="" /> : <span aria-hidden="true">{profile.avatar}</span>}</div>
      <div className="life-scene-caption"><strong>{state.location}</strong><span>{busy ? '行动处理中…' : state.lastAction ? actions.find(item => item.id === state.lastAction)?.label : '今天会从哪里开始？'}</span></div>
    </section>
    <section className="life-places" aria-label="玻璃城地点">{PLACES.map(([id, label, description, icon, actionId]) => <button key={id} type="button" className={`life-place ${state.location === label ? 'active' : ''}`} disabled={controlsDisabled} aria-label={`${label}：${description}，点击${actions.find(action => action.id === actionId)?.label || '行动'}`} onClick={() => act(actionId)}><span aria-hidden="true">{icon}</span><span><strong>{label}</strong><small>{description}</small></span></button>)}</section>
    <section className="life-needs">{NEEDS.map(([key, label, icon]) => <div className="life-need" key={key}><div><span>{icon} {label}</span><b>{state.needs[key]}</b></div><div className="life-need-bar"><i style={{ width: `${state.needs[key]}%` }} /></div></div>)}<div className="life-relationship"><span>与你的关系</span><b>{state.relationship}</b><small>{companionContext?.relationship?.stage ? `关系阶段：${companionContext.relationship.stage}` : '共同经历留下的变化'}</small></div></section>
    {state.currentEvent && <section className="life-event-card"><div><p className="eyebrow">最近事件 · DAY {state.currentEvent.day}</p><h3>{state.currentEvent.place}</h3><p>{state.currentEvent.text}</p></div><span className="life-event-mark" aria-hidden="true">{state.currentEvent.timeOfDay === 'night' ? '☾' : '✦'}</span></section>}
    {state.lastChanges?.length > 0 && <section className="life-change-summary"><div><p className="eyebrow">本次行动变化</p><strong>状态已更新</strong></div><div className="life-change-list">{state.lastChanges.map(change => <span key={change.key} className={change.value > 0 ? 'up' : 'down'}>{change.label} {change.value > 0 ? '+' : ''}{change.value}</span>)}</div></section>}
    {state.pendingDecision && <section className="life-decision"><p className="eyebrow">A MOMENT TO CHOOSE · 关键岔路</p><h3>{state.pendingDecision.title}</h3><p>{state.pendingDecision.prompt}</p><div>{state.pendingDecision.options.map(option => <button key={option.id} type="button" className="life-option" disabled={busy} onClick={() => decide(option.id)}>{option.label}</button>)}</div></section>}
    <section className="life-actions" aria-busy={busy}><div className="life-section-title"><span>下一步行动</span><small>{busy ? '行动处理中，请稍候…' : state.mode === 'observe' ? '观测模式：由它自己决定' : '选择一个行动推进一天'}</small></div><div className="life-action-grid">{actions.map(action => <button key={action.id} type="button" className="life-action" disabled={controlsDisabled} onClick={() => act(action.id)}><span className="life-action-icon">{action.icon}</span><strong>{busy ? '处理中…' : action.label}</strong><small>{action.place}</small></button>)}</div></section>
    <section className="life-events"><div className="life-section-title"><span>最近发生</span><small>服务端 canonical state · 可跨设备继续</small></div>{state.recentEvents.length === 0 ? <p className="empty-detail">推进一天后，这里会出现它的生活片段。</p> : state.recentEvents.map(event => <article className="life-event" key={event.id}><span>DAY {event.day}</span><div><strong>{event.place}</strong><p>{event.text}</p></div></article>)}</section>
    <footer className="life-game-foot"><button type="button" className="select-model" onClick={onChat}>返回聊天</button><span>{companionContext ? `已载入 ${visibleMemoryCount} 条经过策略过滤的共同语境；游戏状态与聊天入口保持独立。` : '正在读取经过策略过滤的共同语境…'}</span></footer>
  </div>;
}
