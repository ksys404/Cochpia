import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import './styles.css';
import { MaterialPreview } from './material/MaterialPreview';
import { MaterialProvider } from './material/MaterialProvider';
import { FloatingWindow, WindowDock, WindowManagerProvider, useWindowManager } from './windows/WindowManager';
import { SettingsWindow } from './workspace/SettingsWindow';
import { WorkspacePreferencesProvider, useWorkspacePreferences } from './workspace/WorkspacePreferencesProvider';
import { BackgroundLayer } from './workspace/BackgroundLayer';
import { AudioProvider, useAudio } from './audio/AudioProvider';
import { MusicProvider } from './audio/MusicProvider';
import { MusicWindow } from './audio/MusicWindow';
import { I18nProvider } from './i18n/I18nProvider';
import { TimeProvider, useTime } from './time/TimeProvider';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;
const apiBase = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

const api = async (url, options) => {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const headers = new Headers(options?.headers || {});
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  const response = await fetch(`${apiBase}${url}`, { ...options, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error || 'Request failed');
    error.code = payload?.error?.code || 'REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return payload;
};

const asArray = value => Array.isArray(value) ? value : [];

const providerModelOptions = provider => {
  if (!provider) return [];
  return [...new Set([...(provider.model ? [provider.model] : []), ...(provider.suggestedModels || [])])];
};

const modelErrorLabels = {
  MODEL_NOT_CONFIGURED: '服务端尚未配置密钥',
  MODEL_AUTH_FAILED: '鉴权失败，请检查服务端密钥',
  MODEL_NOT_FOUND: '模型不存在或当前账号无权访问',
  MODEL_TIMEOUT: '请求超时，请稍后重试',
  MODEL_CONNECTION_FAILED: '服务暂时不可达'
};
const describeModelError = error => modelErrorLabels[error.code] ? `${modelErrorLabels[error.code]}：${error.message}` : error.message;

function takeSegment(buffer) {
  const text = String(buffer || '');
  if (!text.trim()) return null;
  const match = text.match(/\r?\n+/);
  if (match) {
    return { segment: text.slice(0, match.index).trim(), rest: text.slice(match.index + match[0].length).trimStart() };
  }
  return null;
}

function dateLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return '今天';
  if (same(d, yest)) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function splitSegments(text) {
  const segments = [];
  let rest = String(text || '');
  let guard = 0;
  while (rest.trim() && guard < 200) {
    const taken = takeSegment(rest);
    if (!taken) { segments.push(rest.trim()); break; }
    if (taken.segment) segments.push(taken.segment);
    rest = taken.rest;
    guard += 1;
  }
  return segments.length ? segments : [String(text || '').trim()].filter(Boolean);
}

function App() {
  const { state: workspacePreferences, setSetting: setWorkspaceSetting } = useWorkspacePreferences();
  const { formatTime, formatDate } = useTime();
  const workspaceClock = <time className="workspace-clock" dateTime={new Date().toISOString()}>{workspacePreferences.time.showDate && <span>{formatDate()}</span>}<b>{formatTime()}</b></time>;
  const { playUiSound } = useAudio();
  const { restoreWindow, focusWindow } = useWindowManager();
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authAction, setAuthAction] = useState('sign-in');
  const [authNotice, setAuthNotice] = useState('');
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState('welcome');
  const [messages, setMessages] = useState([]);
  const [memory, setMemory] = useState({ count: 0, memories: [] });
  const [personality, setPersonality] = useState(null);
  const [growthEvidence, setGrowthEvidence] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [syncCursor, setSyncCursor] = useState('');
  const [personalityHistory, setPersonalityHistory] = useState([]);
  const [models, setModels] = useState({ defaultProvider: 'mock', providers: [] });
  const [selectedProvider, setSelectedProvider] = useState('mock');
  const [selectedModel, setSelectedModel] = useState('mock');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tests, setTests] = useState({});
  const [actualModel, setActualModel] = useState({ provider: '', model: '' });
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingText, setEditingText] = useState('');
  const [growthOpen, setGrowthOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const conversationRef = useRef(null);
  const nearBottomRef = useRef(true);
  const streamStateRef = useRef({ currentId: null, buffer: '', pausing: false, timer: null, counter: 0 });
  const [jumpToBottom, setJumpToBottom] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [channel, setChannel] = useState('默认');
  const [channels, setChannels] = useState([]);
  const [events, setEvents] = useState([]);
  const [atmosphere, setAtmosphere] = useState('');
  const [atmospherePresets, setAtmospherePresets] = useState([]);
  const [persona, setPersona] = useState('');
  const [personaDraft, setPersonaDraft] = useState('');
  const [eventOpen, setEventOpen] = useState(false);
  const [newEvent, setNewEvent] = useState({ title: '', date: '', type: 'plan', note: '' });
  const [agents, setAgents] = useState([]);
  const [agentDraft, setAgentDraft] = useState({ name: '', persona: '', provider: '', model: '' });
  const [page, setPage] = useState('splash');
  const [minimized, setMinimized] = useState(false);

  const selectedProviderInfo = useMemo(() => models.providers.find(item => item.provider === selectedProvider), [models.providers, selectedProvider]);

  const loadModel = async id => {
    const selection = await api(`/api/sessions/${id}/model`);
    setSelectedProvider(selection.modelProvider);
    setSelectedModel(selection.modelName);
    return selection;
  };

  const loadSessionMessages = async (id, targetChannel) => {
    const nextMessages = await api(`/api/sessions/${id}/messages?channel=${encodeURIComponent(targetChannel || '默认')}`);
    setMessages(nextMessages);
    setChannel(targetChannel || '默认');
  };

  const load = async id => {
    setSessionId(id);
    const [nextChannels, personaRes, atmosphereRes] = await Promise.all([
      api(`/api/sessions/${id}/channels`),
      api(`/api/sessions/${id}/persona`),
      api(`/api/sessions/${id}/atmosphere`)
    ]);
    setChannels(asArray(nextChannels));
    setPersona(personaRes?.persona || '');
    setPersonaDraft(personaRes?.persona || '');
    setAtmosphere(atmosphereRes?.atmosphere || '');
    await loadModel(id);
    const list = asArray(nextChannels);
    const target = list.find(item => item.name === '默认') ? '默认' : (list[0]?.name || '默认');
    await loadSessionMessages(id, target);
  };

  const switchChannel = async name => { if (!sessionId || streaming) return; await loadSessionMessages(sessionId, name); };

  const addChannel = async () => {
    const name = String(window.prompt('新频道名称') || '').trim().slice(0, 60);
    if (!name) return;
    await switchChannel(name);
    setChannels(current => [...current.filter(item => item.name !== name), { name, count: 0 }]);
  };

  const savePersona = async () => {
    try {
      const saved = await api(`/api/sessions/${sessionId}/persona`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona: personaDraft }) });
      setPersona(saved.persona); setError('');
    } catch (err) { setError(err.message); }
  };

  const saveAtmosphere = async presetId => {
    try {
      const saved = await api(`/api/sessions/${sessionId}/atmosphere`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ atmosphere: presetId }) });
      setAtmosphere(saved.atmosphere);
    } catch (err) { setError(err.message); }
  };

  const createEvent = async event => {
    event.preventDefault();
    if (!newEvent.title.trim() || !newEvent.date) return;
    try {
      const created = await api('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newEvent) });
      setEvents(current => [...current, created].sort((a, b) => new Date(a.date) - new Date(b.date)));
      setNewEvent({ title: '', date: '', type: 'plan', note: '' });
    } catch (err) { setError(err.message); }
  };

  const removeEvent = async id => {
    try { await api(`/api/events/${id}`, { method: 'DELETE' }); setEvents(current => current.filter(item => item.id !== id)); }
    catch (err) { setError(err.message); }
  };

  const createAgent = async event => {
    event.preventDefault();
    if (!agentDraft.name.trim()) return;
    try {
      const agent = await api('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(agentDraft) });
      setAgents(current => [...current, agent]);
      setAgentDraft({ name: '', persona: '', provider: '', model: '' });
    } catch (err) { setError(err.message); }
  };

  const removeAgent = async id => {
    try { await api(`/api/agents/${id}`, { method: 'DELETE' }); setAgents(current => current.filter(item => item.id !== id)); }
    catch (err) { setError(err.message); }
  };

  const createGroupSession = async () => {
    if (!agents.length) { setError('请先在 Arcana 添加好友 Agent'); return; }
    try {
      const session = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '群聊', kind: 'group', agentIds: agents.map(item => item.id) }) });
      setSessions(current => [session, ...current]);
      await load(session.id);
      setPage('chat');
    } catch (err) { setError(err.message); }
  };

  const exportData = async () => {
    try {
      const data = await api('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'cochpia-export.json';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { setError(err.message); }
  };

  const importData = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: payload.state || payload }) });
      await refresh();
      await load(sessionId);
      setError('');
    } catch (err) { setError(err.message || '导入失败'); }
    event.target.value = '';
  };

  const refresh = async () => {
    const [nextSessions, nextMemory, nextPersonality, nextEvidence, nextHistory, nextTasks, modelCatalog, nextEvents, nextPresets, nextAgents] = await Promise.all([
      api('/api/sessions'), api('/api/memory/overview'), api('/api/personality'), api('/api/growth/evidence'), api('/api/personality/history'), api('/api/tasks'), api('/api/models'), api('/api/events'), api('/api/psychology/presets'), api('/api/agents')
    ]);
    const safeSessions = asArray(nextSessions);
    setSessions(safeSessions);
    setMemory({ count: Number(nextMemory?.count) || 0, memories: asArray(nextMemory?.memories) });
    setPersonality(nextPersonality && typeof nextPersonality === 'object' ? nextPersonality : null);
    setGrowthEvidence(asArray(nextEvidence));
    setTasks(asArray(nextTasks));
    setPersonalityHistory(asArray(nextHistory));
    setModels(modelCatalog && Array.isArray(modelCatalog.providers) ? modelCatalog : { defaultProvider: 'mock', providers: [] });
    setEvents(asArray(nextEvents));
    setAtmospherePresets(asArray(nextPresets));
    setAgents(asArray(nextAgents));
    if (safeSessions.some(item => item.id === sessionId)) await loadModel(sessionId);
  };

  const syncWorkspace = async () => {
    const result = await api(`/api/sync?limit=100${syncCursor ? `&cursor=${encodeURIComponent(syncCursor)}` : ''}`);
    setSyncCursor(result.nextCursor || syncCursor);
    const changedTasks = asArray(result.changes).filter(item => item.entity === 'task').map(item => item.data);
    if (changedTasks.length) setTasks(current => [...changedTasks, ...current.filter(item => !changedTasks.some(next => next.id === item.id))]);
    return result;
  };

  const startEditingMessage = message => {
    const original = messages.find(item => item.id === message.id) || message;
    setEditingMessageId(original.id);
    setEditingText(original.content);
    setError('');
  };

  const cancelEditingMessage = () => {
    setEditingMessageId(null);
    setEditingText('');
  };

  const saveMessageEdit = async messageId => {
    const content = editingText.trim();
    if (!content) return setError('消息内容不能为空');
    try {
      const updated = await api(`/api/sessions/${sessionId}/messages/${messageId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content })
      });
      setMessages(current => current.map(item => item.id === messageId ? updated : item));
      cancelEditingMessage();
    } catch (err) { setError(err.message); }
  };

  const removeMessage = async messageId => {
    if (!window.confirm('确定删除这条消息吗？')) return;
    try {
      await api(`/api/sessions/${sessionId}/messages/${messageId}`, { method: 'DELETE' });
      setMessages(current => current.filter(item => item.id !== messageId));
    } catch (err) { setError(err.message); }
  };

  const currentVersion = asArray(personalityHistory)[0];
  const previousVersion = asArray(personalityHistory)[1];
  const versionChanges = currentVersion && previousVersion
    ? currentVersion.traits.map(trait => ({ ...trait, previous: previousVersion.traits.find(item => item.key === trait.key)?.value ?? trait.value, delta: trait.value - (previousVersion.traits.find(item => item.key === trait.key)?.value ?? trait.value) }))
    : [];

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active) { setUser(data.session?.user || null); setAuthReady(true); } });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user || null));
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!authReady || (supabase && !user)) return;
    refresh().then(() => load('welcome')).catch(err => setError(err.message));
  }, [authReady, user]);

  useEffect(() => {
    if (!authReady || (supabase && !user)) return undefined;
    const interval = window.setInterval(() => { syncWorkspace().catch(err => setError(err.message)); }, 30_000);
    return () => window.clearInterval(interval);
  }, [authReady, user, syncCursor]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const closeOnEscape = event => { if (event.key === 'Escape') setSettingsOpen(false); };
    document.body.classList.add('modal-open');
    window.addEventListener('keydown', closeOnEscape);
    return () => { document.body.classList.remove('modal-open'); window.removeEventListener('keydown', closeOnEscape); };
  }, [settingsOpen]);

  const scrollToBottom = behavior => {
    const el = conversationRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: behavior || 'auto' });
  };
  const onConversationScroll = () => {
    const el = conversationRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    nearBottomRef.current = near;
    setJumpToBottom(!near);
  };
  const displayMessages = useMemo(() => {
    const flat = [];
    messages.forEach(message => {
      if (message.role === 'assistant' && !('isStreaming' in message)) {
        const segments = splitSegments(message.content);
        if (segments.length > 1) {
          segments.forEach((seg, i) => flat.push({ ...message, key: `${message.id}:${i}`, content: seg, lastInGroup: i === segments.length - 1 }));
        } else {
          flat.push({ ...message, key: message.id, grouped: false, lastInGroup: true });
        }
      } else {
        flat.push({ ...message, key: message.id, grouped: false, lastInGroup: true });
      }
    });
    return flat;
  }, [messages]);
  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return displayMessages;
    return displayMessages.filter(item => String(item.content || '').toLowerCase().includes(q));
  }, [displayMessages, searchQuery]);
  const groupedMessages = useMemo(() => {
    const result = [];
    let last = '';
    for (const item of filteredMessages) {
      const label = dateLabel(item.createdAt);
      if (label !== last) { result.push({ type: 'date', key: `d:${label}`, label }); last = label; }
      result.push(item);
    }
    return result;
  }, [filteredMessages]);
  useEffect(() => {
    if (nearBottomRef.current) {
      const el = conversationRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const saveSelection = async (provider, model) => {
    if (streaming) return;
    setError('');
    try {
      const saved = await api(`/api/sessions/${sessionId}/model`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model })
      });
      setSelectedProvider(saved.modelProvider);
      setSelectedModel(saved.modelName);
      setSessions(current => current.map(item => item.id === sessionId ? { ...item, modelProvider: saved.modelProvider, modelName: saved.modelName } : item));
    } catch (err) { setError(err.message); }
  };

  const selectProvider = event => {
    const nextProvider = models.providers.find(item => item.provider === event.target.value);
    if (!nextProvider) return;
    const nextModel = nextProvider.model || nextProvider.suggestedModels?.[0] || '';
    if (nextProvider.ready) saveSelection(nextProvider.provider, nextModel);
  };

  const selectModel = event => saveSelection(selectedProvider, event.target.value);

  const testProvider = async provider => {
    const model = provider.model || provider.suggestedModels?.[0] || '';
    setTests(current => ({ ...current, [provider.provider]: { state: 'testing' } }));
    try {
      const result = await api(`/api/models/${provider.provider}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model })
      });
      setTests(current => ({ ...current, [provider.provider]: { state: 'success', result } }));
    } catch (err) {
      setTests(current => ({ ...current, [provider.provider]: { state: 'error', code: err.code, message: describeModelError(err) } }));
    }
  };

  const newSession = async () => {
    try {
      const session = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      setSessions(current => [session, ...current]);
      await load(session.id);
    } catch (err) { setError(err.message); }
  };

  const createTask = async event => {
    event.preventDefault();
    const title = newTaskTitle.trim();
    if (!title) return;
    try {
      const task = await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, sessionId }) });
      setTasks(current => [task, ...current]);
      setNewTaskTitle('');
    } catch (err) { setError(err.message); }
  };

  const completeTask = async task => {
    try {
      const updated = await api(`/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
      setTasks(current => current.map(item => item.id === updated.id ? updated : item));
    } catch (err) { setError(err.message); }
  };

  const sendMessage = async event => {
    event.preventDefault();
    if (!input.trim() || streaming) return;
    void playUiSound('click');
    setError('');
    const text = input.trim();
    if (sessions.find(item => item.id === sessionId)?.kind === 'group') {
      setInput('');
      setMessages(current => [...current, { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString() }]);
      setStreaming(true);
      try {
        const result = await api('/api/chat/group', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, message: text, channel }) });
        setMessages(current => [...current, ...(result.messages || [])]);
      } catch (err) { setError(err.message); setInput(text); }
      finally { setStreaming(false); }
      return;
    }
    setInput('');
    const firstId = 'streaming-0';
    streamStateRef.current = { currentId: firstId, buffer: '', pausing: false, timer: null, counter: 0 };
    setMessages(current => [...current, { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString() }, { id: firstId, role: 'assistant', content: '', createdAt: new Date().toISOString(), isStreaming: true }]);
    nearBottomRef.current = true;
    scrollToBottom('auto');
    setStreaming(true);
    let completionUnlockTimer;
    const streamProcess = () => {
      const st = streamStateRef.current;
      if (st.pausing) return;
      const taken = takeSegment(st.buffer);
      if (taken && taken.segment) {
        st.buffer = taken.rest;
        const finalizeId = st.currentId;
        st.counter += 1;
        st.currentId = `streaming-${st.counter}`;
        setMessages(current => {
          const next = current.map(item => item.id === finalizeId ? { ...item, content: taken.segment, isStreaming: false } : item);
          next.push({ id: st.currentId, role: 'assistant', content: '', createdAt: new Date().toISOString(), isStreaming: true });
          return next;
        });
        st.pausing = true;
        st.timer = setTimeout(() => { st.pausing = false; streamProcess(); }, 420 + Math.random() * 380);
      } else {
        setMessages(current => current.map(item => item.id === st.currentId ? { ...item, content: st.buffer } : item));
      }
    };
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const streamHeaders = { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) };
      let response = await fetch(`${apiBase}/api/chat/stream`, {
        method: 'POST', headers: streamHeaders,
        body: JSON.stringify({ sessionId, message: text, provider: selectedProvider, model: selectedModel, channel })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || payload?.error || '流式连接失败');
      }
      let buffer = '';
      let streamError = '';
      let streamFinished = false;
      let runId = '';
      let lastEventId = '';
      let reconnectAttempts = 0;
      const scheduleComposerUnlock = () => {
        clearTimeout(completionUnlockTimer);
        completionUnlockTimer = setTimeout(() => setStreaming(false), 1200);
      };
      const consumeSse = chunk => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        parts.forEach(part => {
          const eventName = part.match(/^event:\s*(.+)$/m)?.[1];
          const eventId = part.match(/^id:\s*(.+)$/m)?.[1];
          const dataText = part.match(/^data:\s*(.+)$/ms)?.[1];
          if (!eventName || !dataText) return;
          if (eventId) lastEventId = eventId;
          const data = JSON.parse(dataText);
          if (eventName === 'meta') { runId = data.runId || runId; if (data.provider) setActualModel({ provider: data.provider, model: data.model }); }
          if (eventName === 'text') { streamStateRef.current.buffer += data.delta; streamProcess(); scheduleComposerUnlock(); }
          if (eventName === 'error') { streamError = data.message || '生成失败'; setError(streamError); }
          if (eventName === 'done') { streamFinished = true; if (data.ok === false && !streamError) streamError = '模型没有完成本次回复'; }
        });
      };
      const readStream = async currentResponse => {
        if (!currentResponse.ok) {
          const payload = await currentResponse.json().catch(() => null);
          throw new Error(payload?.error?.message || payload?.error || '流式连接失败');
        }
        const reader = currentResponse.body.getReader();
        const decoder = new TextDecoder();
        while (true) { const { value, done } = await reader.read(); if (done) break; consumeSse(decoder.decode(value, { stream: true })); if (streamFinished) { await reader.cancel(); break; } }
      };
      while (!streamFinished) {
        await readStream(response);
        if (streamFinished || !runId || reconnectAttempts >= 3) break;
        reconnectAttempts += 1;
        await new Promise(resolve => setTimeout(resolve, 250 * reconnectAttempts));
        response = await fetch(`${apiBase}/api/chat/stream/${encodeURIComponent(runId)}`, { headers: { ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}), ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) } });
      }
      if (!streamFinished && !streamError) streamError = 'SSE 连接中断，且无法恢复';
      if (streamError) throw new Error(streamError);
      const st = streamStateRef.current;
      if (st.timer) clearTimeout(st.timer);
      if (st.buffer.trim()) {
        setMessages(current => current.map(item => item.id === st.currentId ? { ...item, content: st.buffer, isStreaming: false } : item));
      } else {
        setMessages(current => current.filter(item => item.id !== st.currentId));
      }
      setStreaming(false);
      await loadSessionMessages(sessionId, channel).catch(() => {});
      void refresh().catch(err => setError(err.message));
    } catch (err) {
      const st = streamStateRef.current;
      if (st.timer) clearTimeout(st.timer);
      setError(err.message);
      setInput(text);
      setMessages(current => current.filter(item => !item.id.startsWith('streaming-')));
    } finally { clearTimeout(completionUnlockTimer); setStreaming(false); }
  };

  const submitAuth = async event => {
    event.preventDefault();
    if (!supabase || !authEmail || !authPassword || authBusy) return;
    setAuthBusy(true); setError(''); setAuthNotice('');
    try {
      const result = authAction === 'sign-up'
        ? await supabase.auth.signUp({ email: authEmail, password: authPassword })
        : await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
      const { data, error: authError } = result;
      if (authError) {
        setError(authError.message);
      } else if (authAction === 'sign-up' && !data.session) {
        setAuthNotice('账户已创建。请查收邮箱中的确认链接，确认后再登录。');
        setAuthAction('sign-in');
        setAuthPassword('');
      } else {
        setUser(data.user);
      }
    } catch (authException) {
      setError(authException.message || '认证服务暂时不可用');
    } finally {
      setAuthBusy(false);
    }
  };

  const openSettings = () => { restoreWindow('settings'); focusWindow('settings'); };
  const openMusic = () => { restoreWindow('music'); focusWindow('music'); };

  if (supabase && !authReady) return <main className="auth-shell"><p className="auth-loading">正在检查登录状态…</p></main>;
  if (supabase && authReady && !user) return <main className="auth-shell"><form className="auth-panel" onSubmit={submitAuth}><p className="eyebrow">COCHPIA AUTH</p><h1>进入你的共同空间</h1><label>邮箱<input type="email" value={authEmail} onChange={event => setAuthEmail(event.target.value)} autoComplete="email" required /></label><label>密码<input type="password" value={authPassword} onChange={event => setAuthPassword(event.target.value)} autoComplete={authAction === 'sign-in' ? 'current-password' : 'new-password'} required /></label><button className="auth-submit" disabled={authBusy}>{authBusy ? '处理中…' : authAction === 'sign-in' ? '登录' : '创建账户'}</button><button type="button" className="auth-switch" onClick={() => { setAuthAction(authAction === 'sign-in' ? 'sign-up' : 'sign-in'); setError(''); setAuthNotice(''); }}>{authAction === 'sign-in' ? '首次使用？创建账户' : '已有账户？返回登录'}</button>{authNotice && <p className="auth-notice" role="status">{authNotice}</p>}{error && <p className="auth-error" role="alert">{error}</p>}</form></main>;

  return <><BackgroundLayer /><div className="workspace-clock-overlay">{workspaceClock}</div><div className={`app-shell${minimized ? ' minimized' : ''}`}>
    {user && supabase && <button className="auth-logout" onClick={() => supabase.auth.signOut()}>退出</button>}
    {page !== 'splash' && <div className="aube-lights"><i className="l-red" /><i className="l-yellow" /><i className="l-green" onClick={() => setMinimized(true)} title="最小化" /></div>}
    {page === 'splash' && <div className="aube-splash" onClick={() => setPage('home')}><div className="aube-splash-center"><div className="aube-orb"><span className="aube-orb-core" /></div><div className="aube-word">COCHPIA</div><div className="aube-tag">Still Blooming</div><div className="aube-divider"><i /><em>✦</em><i /></div><div className="aube-hint">轻触进入</div></div></div>}
    {page !== 'splash' && <nav className="aube-nav"><button className={`aube-nav-item ${page === 'home' ? 'active' : ''}`} onClick={() => setPage('home')}><span className="aube-nav-dot">⌂</span><span className="aube-nav-lbl">Sanctum</span></button><button className={`aube-nav-item ${page === 'chat' ? 'active' : ''}`} onClick={() => setPage('chat')}><span className="aube-nav-dot">✎</span><span className="aube-nav-lbl">Chat</span></button><button className={`aube-nav-item ${page === 'arcana' ? 'active' : ''}`} onClick={() => setPage('arcana')}><span className="aube-nav-dot">⌗</span><span className="aube-nav-lbl">Arcana</span></button><button className="aube-nav-item" onClick={openMusic}><span className="aube-nav-dot">♫</span><span className="aube-nav-lbl">Music</span></button><button className="aube-nav-item" onClick={() => setWorkspaceSetting('theme', 'themeId', workspacePreferences.theme.themeId === 'sakura' ? 'ink' : 'sakura')}><span className="aube-nav-dot">◐</span><span className="aube-nav-lbl">Veil</span></button><button className="aube-nav-item" onClick={openSettings}><span className="aube-nav-dot">⚙</span><span className="aube-nav-lbl">设置</span></button></nav>}
    {page === 'home' && <div className="aube-page-overlay"><div className="aube-page-scroll"><div className="aube-card aube-profile"><div className="aube-pava">✦</div><div><div className="aube-pname">Cochpia</div><div className="aube-pquote">{personality?.summary || '温和、好奇，正在学习如何更准确地陪伴。'}</div><div className="aube-tags">{(personality?.traits || []).slice(0, 4).map(trait => <span key={trait.key}>{trait.label} {Math.round(trait.value * 100)}%</span>)}</div></div></div><div className="aube-duo"><div className="aube-card aube-mini" onClick={newSession}><span className="aube-mi">＋</span><h5>新的相遇</h5><small>{sessions.length} 个会话</small></div><div className="aube-card aube-mini" onClick={() => setEventOpen(true)}><span className="aube-mi">☾</span><h5>日历</h5><small>{events.length} 条日程</small></div></div><div className="aube-sec">Sessions</div><div className="aube-sessions">{sessions.map(session => <button key={session.id} className={`aube-session ${session.id === sessionId ? 'active' : ''}`} onClick={() => { load(session.id); setPage('chat'); }}>{session.title}</button>)}</div><div className="aube-sec">Pulse</div><div className="aube-card aube-pulse">{(personality?.traits || []).map(trait => <div className="aube-prow" key={trait.key}><span className="aube-pl">{trait.label}</span><div className="aube-pbar"><i style={{ width: `${trait.value * 100}%` }} /></div><span className="aube-pv">{Math.round(trait.value * 100)}</span></div>)}</div></div></div>}
    {page === 'arcana' && <div className="aube-page-overlay"><div className="aube-page-scroll"><div className="aube-ptitle">Arcana</div><div className="aube-sect">Persona · 人格</div><textarea className="persona-input" value={personaDraft} onChange={event => setPersonaDraft(event.target.value)} rows="4" placeholder="自定义本会话 Cochpia 的人格与语气,留空使用默认人格…" /><button className="select-model" style={{ marginTop: 10 }} onClick={savePersona}>保存人格</button><div className="aube-sect">Veil · 主题</div><div className="aube-veils">{[['sakura', '樱花'], ['ember', '余烬'], ['moss', '苔藓'], ['ink', '墨']].map(([id, name]) => <button key={id} className={`aube-veil ${workspacePreferences.theme.themeId === id ? 'active' : ''}`} onClick={() => setWorkspaceSetting('theme', 'themeId', id)}>{name}</button>)}</div><div className="aube-sect">Atmosphere · 氛围</div><select value={atmosphere} onChange={event => saveAtmosphere(event.target.value)}><option value="">默认</option>{atmospherePresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name} · {preset.description}</option>)}</select><div className="aube-sect">Model · 模型</div><select value={selectedProvider} onChange={selectProvider}><option value="">选择供应商</option>{models.providers.map(provider => <option key={provider.provider} value={provider.provider} disabled={!provider.ready}>{provider.label}{provider.ready ? '' : ' · 未配置'}</option>)}</select><select value={selectedModel} onChange={selectModel} style={{ marginTop: 8 }}><option value="">选择模型</option>{providerModelOptions(selectedProviderInfo).map(model => <option key={model} value={model}>{model}</option>)}</select><div className="aube-sect" style={{ marginTop: 16 }}>Providers</div>{models.providers.map(provider => <div className="aube-row" key={provider.provider}><span>{provider.label}</span><span className="aube-row-rv">{provider.ready ? '已配置' : '未配置'}</span></div>)}<div className="aube-sect">Agents · 好友</div>{agents.length === 0 ? <div className="aube-row"><span style={{ color: 'var(--text-muted)' }}>还没有好友 Agent,添加一个试试</span></div> : agents.map(agent => <div className="aube-row" key={agent.id}><span>{agent.avatar} {agent.name}</span><span className="aube-row-rv">{agent.provider ? `${agent.provider}/${agent.model || '默认'}` : '默认模型'}</span><button type="button" className="text-button" onClick={() => removeAgent(agent.id)}>删</button></div>)}<form className="agent-form" onSubmit={createAgent}><input value={agentDraft.name} onChange={event => setAgentDraft(current => ({ ...current, name: event.target.value }))} placeholder="名称" /><input value={agentDraft.persona} onChange={event => setAgentDraft(current => ({ ...current, persona: event.target.value }))} placeholder="人格(可选)" /><select value={agentDraft.provider} onChange={event => setAgentDraft(current => ({ ...current, provider: event.target.value }))}><option value="">默认模型</option>{models.providers.filter(provider => provider.ready).map(provider => <option key={provider.provider} value={provider.provider}>{provider.label}</option>)}</select><input value={agentDraft.model} onChange={event => setAgentDraft(current => ({ ...current, model: event.target.value }))} placeholder="模型名" /><button type="submit">添加</button></form><button className="select-model" style={{ marginTop: 10, width: '100%' }} onClick={createGroupSession}>创建群聊(含全部好友)</button><div className="aube-sect">Data · 数据</div><div className="aube-row"><button className="text-button" onClick={exportData}>导出数据</button><label className="text-button" style={{ marginLeft: 16, cursor: 'pointer' }}>导入数据<input type="file" accept="application/json,.json" onChange={importData} hidden /></label></div></div></div>}
    <div className="model-dock">
      <label htmlFor="model-provider">模型供应商</label>
      <select id="model-provider" value={selectedProvider} onChange={selectProvider} disabled={streaming}>
        {models.providers.map(item => <option key={item.provider} value={item.provider} disabled={!item.ready}>{item.label}{item.ready ? '' : ' · 未配置'}</option>)}
      </select>
      <select aria-label="选择模型" value={selectedModel} onChange={selectModel} disabled={streaming || !selectedProviderInfo?.ready}>
        {providerModelOptions(selectedProviderInfo).map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      <select aria-label="互动氛围" value={atmosphere} onChange={event => saveAtmosphere(event.target.value)} disabled={streaming}>
        <option value="">氛围</option>
        {atmospherePresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
      </select>
      <div className="model-dock-info"><strong>{selectedProviderInfo?.useCases || '等待模型目录加载'}</strong><span>{selectedProviderInfo?.ready ? '当前会话模型已保存' : '当前模型尚未配置'}</span>{actualModel.model && <small>实际：{actualModel.provider} / {actualModel.model}</small>}</div>
      <button className="icon-button compact" aria-label="Open music" title="Open music" onClick={openMusic}>♫</button><button className="icon-button compact" aria-label="打开设置" title="打开设置" onClick={openSettings}>⚙</button>
    </div>

    <aside className="sidebar"><div className="brand"><span className="brand-mark">C</span><div><strong>Cochpia</strong><span>relationship workspace</span></div></div><button className="new-chat" onClick={newSession}><span>+</span> 新的相遇</button><div className="section-label">会话</div><nav className="session-list">{sessions.map(session => <button key={session.id} className={session.id === sessionId ? 'session active' : 'session'} onClick={() => load(session.id)}><span className="session-dot" />{session.title}</button>)}</nav><div className="sidebar-foot"><span className="status-dot" />本地开发模式<span className="version">v0.1</span><button type="button" className="text-button" onClick={exportData}>导出</button><label className="text-button import-label">导入<input type="file" accept="application/json,.json" onChange={importData} hidden /></label></div></aside>

    <main className="main-panel"><header className="topbar"><div><p className="eyebrow">LIVE RELATIONSHIP LOG</p><h1>与你共同成长的空间</h1></div><div className="top-actions"><button className="icon-button" aria-label="切换主题" title="切换主题" onClick={() => setWorkspaceSetting('theme', 'themeId', workspacePreferences.theme.themeId === 'sakura' ? 'ink' : 'sakura')}>◐</button><span className="connection"><span className="status-dot" /> SSE 已连接</span></div></header><div className="channel-bar">{channels.map(item => <button type="button" key={item.name} className={item.name === channel ? 'channel-tab active' : 'channel-tab'} onClick={() => switchChannel(item.name)}>{item.name}<span className="channel-count">{item.count}</span></button>)}<button type="button" className="channel-tab channel-add" aria-label="新建频道" title="新建频道" onClick={addChannel}>＋</button><input className="chat-search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="搜索聊天记录" /></div><div className="conversation" ref={conversationRef} onScroll={onConversationScroll}>{messages.length === 0 && <div className="empty-state"><span className="empty-mark">01</span><h2>从一段真实的分享开始</h2><p>每次对话都会成为可审计的共同经历，只有重要的内容才会进入长期记忆。</p></div>}{groupedMessages.map(item => item.type === 'date' ? <div key={item.key} className="date-sep"><span>{item.label}</span></div> : <article key={item.key} className={`message ${item.role}${item.grouped ? ' grouped' : ''}`}><div className="avatar">{item.role === 'assistant' ? (item.senderAvatar || 'C') : '你'}</div><div className="message-content"><div className="message-meta">{item.role === 'assistant' ? (item.senderName || 'Cochpia') : '你'}<time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time></div>{editingMessageId === item.id && item.lastInGroup ? <div className="message-edit"><textarea value={editingText} onChange={event => setEditingText(event.target.value)} autoFocus /><div><button type="button" className="text-button" onClick={() => saveMessageEdit(item.id)}>保存</button><button type="button" className="text-button muted-button" onClick={cancelEditingMessage}>取消</button></div></div> : <><div className="bubble">{item.content || <span className="typing">正在形成回应<span>.</span><span>.</span><span>.</span></span>}{item.isStreaming && item.content ? <span className="typing-cursor" /> : null}</div>{item.lastInGroup && !('isStreaming' in item) && <div className="message-actions"><button type="button" className="text-button" onClick={() => startEditingMessage(item)}>编辑</button><button type="button" className="text-button danger-button" onClick={() => removeMessage(item.id)}>删除</button></div>}</>}</div></article>)}{jumpToBottom && <button className="jump-bottom" onClick={() => { nearBottomRef.current = true; setJumpToBottom(false); scrollToBottom('smooth'); }} aria-label="回到底部" title="回到底部">↓</button>}</div><form className="composer" onSubmit={sendMessage}><textarea value={input} onChange={event => setInput(event.target.value)} disabled={streaming} placeholder="写下此刻想分享的事…" rows="1" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(event); } }} /><button className="send-button" disabled={streaming || !input.trim()} aria-label="发送消息" title="发送消息">↑</button><div className="composer-note">Enter 发送 · Shift + Enter 换行</div></form></main>

    <div className="window-layer"><FloatingWindow id="inspector" title="共同状态"><aside className="inspector"><div className="inspector-head"><div><p className="eyebrow">COGNITIVE STATE</p><h2>共同状态</h2></div><span className="live-pill">LIVE</span></div><section className="state-card"><div className="state-card-top"><span className="state-icon">✦</span><div><strong>关系正在形成</strong><span>基于共同事件持续更新</span></div></div><div className="state-line"><span>共享记忆</span><strong>{memory.count}</strong></div><div className="state-line"><span>人格版本</span><strong>v{personality?.version || 1}</strong></div></section><MaterialPreview /><section className="inspector-section"><div className="section-heading"><span>人格趋势</span><button type="button" className="text-button" onClick={() => setHistoryOpen(true)}>查看版本</button></div>{(personality?.traits || []).map(trait => <div className="trait" key={trait.key}><div><span>{trait.label}</span><b>{Math.round(trait.value * 100)}%</b></div><div className="progress"><i style={{ width: `${trait.value * 100}%` }} /></div></div>)}</section><section className="inspector-section"><div className="section-heading"><span>最近记忆</span><span className="count-label">{memory.count} 条</span></div>{memory.memories.slice(0, 3).map(item => <div className="memory-item" key={item.id}><span className="memory-type">{item.type === 'relationship' ? '关系' : '事件'}</span><p>{item.summary}</p><small>{Math.round(item.confidence * 100)}% 确信 · {item.source}</small></div>)}</section><section className="inspector-section"><div className="section-heading"><span>成长证据</span><button type="button" className="text-button" onClick={() => setGrowthOpen(true)}>查看时间线</button></div>{growthEvidence.slice(0, 2).map(item => <div className="memory-item" key={item.id}><span className="memory-type">{item.status || 'draft'}</span><p>{item.claim}</p><small>{item.evidence}</small></div>)}</section><section className="protocol-note"><span>◎</span><p><strong>可验证成长</strong>每次人格变化都保留证据和版本，后续可回滚。</p></section></aside></FloatingWindow></div><WindowDock />

    {growthOpen && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setGrowthOpen(false); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="growth-title"><header className="settings-header"><div><p className="eyebrow">AUDITABLE GROWTH</p><h2 id="growth-title">成长证据时间线</h2><p>每条证据都关联到共同经历，可追溯、确认或拒绝。</p></div><button className="icon-button" aria-label="关闭成长时间线" title="关闭成长时间线" onClick={() => setGrowthOpen(false)}>×</button></header><div className="timeline">{growthEvidence.length === 0 ? <p className="empty-detail">暂时没有成长证据。</p> : growthEvidence.map(item => <article className="timeline-item" key={item.id}><div className="timeline-marker" /><div><div className="timeline-meta"><span>{item.status || 'draft'}</span><time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></div><h3>{item.claim}</h3><p>{item.evidence}</p><small>{item.sourceMessageId ? `来源消息：${item.sourceMessageId}` : '暂无来源消息'}</small></div></article>)}</div></section></div>}
    {historyOpen && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setHistoryOpen(false); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="history-title"><header className="settings-header"><div><p className="eyebrow">PERSONALITY HISTORY</p><h2 id="history-title">人格版本差异</h2><p>{currentVersion && previousVersion ? `v${previousVersion.version} → v${currentVersion.version}` : '等待第二个版本后显示差异'}</p></div><button className="icon-button" aria-label="关闭人格版本" title="关闭人格版本" onClick={() => setHistoryOpen(false)}>×</button></header>{currentVersion && previousVersion ? <div className="version-diff">{versionChanges.map(trait => <div className="diff-row" key={trait.key}><div><strong>{trait.label}</strong><span>{Math.round(trait.previous * 100)}% → {Math.round(trait.value * 100)}%</span></div><b className={trait.delta > 0 ? 'delta-up' : trait.delta < 0 ? 'delta-down' : ''}>{trait.delta > 0 ? '+' : ''}{Math.round(trait.delta * 100)}%</b></div>)}</div> : <p className="empty-detail">当前只有一个人格版本，完成下一次对话后会生成可比较的版本。</p>}</section></div>}
    {settingsOpen && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header className="settings-header"><div><p className="eyebrow">MODEL DIRECTORY</p><h2 id="settings-title">模型设置</h2><p>查看适用场景并测试服务端连接。密钥不会进入浏览器。</p></div><button className="icon-button" aria-label="关闭模型设置" title="关闭模型设置" onClick={() => setSettingsOpen(false)}>×</button></header><div className="persona-panel"><div className="section-heading"><span>人格 Persona</span><button type="button" className="text-button" onClick={savePersona}>保存人格</button></div><textarea className="persona-input" value={personaDraft} onChange={event => setPersonaDraft(event.target.value)} placeholder="自定义本会话 Cochpia 的人格与语气,留空使用默认人格…" rows="4" /><div className="persona-hint">只影响当前会话,长度不超过 2000 字。</div></div><div className="settings-list">{models.providers.map(provider => { const test = tests[provider.provider]; return <article className={`provider-row ${provider.provider === selectedProvider ? 'selected' : ''}`} key={provider.provider}><div className="provider-main"><div><strong>{provider.label}</strong><span className={`provider-status ${provider.ready ? 'ready' : 'unready'}`}>{provider.ready ? '已配置' : '未配置'}</span></div><p>{provider.useCases}</p><small>{provider.protocol} · 建议：{provider.suggestedModels.join(' / ')}</small>{test?.state === 'success' && <small className="test-success">连接成功 · {test.result.latencyMs}ms</small>}{test?.state === 'error' && <small className="test-error">{test.message}</small>}</div><div className="provider-actions"><button className="text-button" disabled={!provider.ready || test?.state === 'testing'} onClick={() => testProvider(provider)}>{test?.state === 'testing' ? '测试中…' : '测试连接'}</button><button className="select-model" disabled={!provider.ready} onClick={() => { saveSelection(provider.provider, provider.model || provider.suggestedModels[0]); setSettingsOpen(false); }}>{provider.provider === selectedProvider ? '当前会话' : '用于本会话'}</button></div></article>; })}</div></section></div>}
    <button type="button" className="task-launcher event-launcher" aria-label="打开日历" title="打开日历" onClick={() => setEventOpen(true)}>日历</button>
    <button type="button" className="task-launcher" aria-label="打开任务面板" title="打开任务面板" onClick={() => setTaskOpen(true)}>任务 <span>{tasks.filter(item => item.status !== 'completed').length}</span></button>
    {taskOpen && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setTaskOpen(false); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="task-title"><header className="settings-header"><div><p className="eyebrow">TASK WORKSPACE</p><h2 id="task-title">共同任务</h2><p>任务状态会通过增量同步保持最新。</p></div><button className="icon-button" aria-label="关闭任务面板" title="关闭任务面板" onClick={() => setTaskOpen(false)}>×</button></header><form className="task-form" onSubmit={createTask}><input value={newTaskTitle} onChange={event => setNewTaskTitle(event.target.value)} placeholder="添加一个想继续的事项" aria-label="任务标题" /><button className="select-model" type="submit" disabled={!newTaskTitle.trim()}>添加任务</button></form><div className="task-list">{tasks.length === 0 ? <p className="empty-detail">还没有任务。</p> : tasks.map(item => <article className={`task-row ${item.status === 'completed' ? 'completed' : ''}`} key={item.id}><button type="button" className="task-check" aria-label={`完成任务：${item.title}`} title="标记完成" onClick={() => item.status !== 'completed' && completeTask(item)}>{item.status === 'completed' ? '✓' : '○'}</button><div><strong>{item.title}</strong><small>{item.status === 'completed' ? '已完成' : item.dueAt ? new Date(item.dueAt).toLocaleString('zh-CN') : '待处理'}</small></div></article>)}</div></section></div>}
    {eventOpen && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setEventOpen(false); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="event-title"><header className="settings-header"><div><p className="eyebrow">CALENDAR · 日历</p><h2 id="event-title">纪念日与计划</h2><p>临近的事项会自动注入对话上下文。</p></div><button className="icon-button" aria-label="关闭日历" title="关闭日历" onClick={() => setEventOpen(false)}>×</button></header><form className="event-form" onSubmit={createEvent}><input value={newEvent.title} onChange={event => setNewEvent(current => ({ ...current, title: event.target.value }))} placeholder="标题,例如:初次相遇" aria-label="事件标题" /><input type="date" value={newEvent.date} onChange={event => setNewEvent(current => ({ ...current, date: event.target.value }))} aria-label="日期" /><select value={newEvent.type} onChange={event => setNewEvent(current => ({ ...current, type: event.target.value }))} aria-label="类型"><option value="anniversary">纪念日</option><option value="birthday">生日</option><option value="plan">计划</option><option value="record">记录</option></select><button className="select-model" type="submit" disabled={!newEvent.title.trim() || !newEvent.date}>添加</button></form><div className="task-list">{events.length === 0 ? <p className="empty-detail">还没有日程。</p> : events.map(item => <div className="task-row" key={item.id}><div><strong>{item.title}</strong><small>{item.type === 'anniversary' ? '纪念日' : item.type === 'birthday' ? '生日' : item.type === 'plan' ? '计划' : '记录'} · {new Date(item.date).toLocaleDateString('zh-CN')}{item.note ? ' · ' + item.note : ''}</small></div><button type="button" className="t-del" title="删除" onClick={() => removeEvent(item.id)}>×</button></div>)}</div></section></div>}
    <MusicWindow /><SettingsWindow />
    {error && <div className="toast" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
  </div>{minimized && <button className="aube-minimize-btn" onClick={() => setMinimized(false)} title="展开 Cochpia">C</button>}</>;
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error) { console.error('Cochpia UI runtime error', error); }

  render() {
    if (this.state.error) return <main className="auth-shell"><section className="auth-panel"><p className="eyebrow">COCHPIA UI ERROR</p><h1>页面暂时无法加载</h1><p className="auth-error">{this.state.error.message}</p><button className="auth-submit" onClick={() => window.location.reload()}>重新加载</button></section></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(<AppErrorBoundary><WorkspacePreferencesProvider><I18nProvider><TimeProvider><MusicProvider><AudioProvider><MaterialProvider><WindowManagerProvider><App /></WindowManagerProvider></MaterialProvider></AudioProvider></MusicProvider></TimeProvider></I18nProvider></WorkspacePreferencesProvider></AppErrorBoundary>);
