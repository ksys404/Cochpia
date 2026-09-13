import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, supabase, apiBase } from './api';
import './styles.css';
import { MaterialPreview } from './material/MaterialPreview';
import { MaterialProvider } from './material/MaterialProvider';
import { FloatingWindow, WindowManagerProvider, useWindowManager } from './windows/WindowManager';
import { SettingsWindow } from './workspace/SettingsWindow';
import { WorkspacePreferencesProvider, useWorkspacePreferences } from './workspace/WorkspacePreferencesProvider';
import { BackgroundLayer } from './workspace/BackgroundLayer';
import WorkbenchPage from './workspace/WorkbenchPage';
import { AudioProvider, useAudio } from './audio/AudioProvider';
import { VoiceProvider, useVoice } from './audio/VoiceProvider';
import { MusicProvider } from './audio/MusicProvider';
import { MusicWindow } from './audio/MusicWindow';
import { I18nProvider } from './i18n/I18nProvider';
import { TimeProvider, useTime } from './time/TimeProvider';
import LifeCalendar from './life/LifeCalendar';
import LifeGame from './life/LifeGame';
import { ProfileProvider, useProfile } from './profile/ProfileProvider';
import CharacterProfile from './profile/CharacterProfile';
import FeatherIcon from './icons/FeatherIcon';
import { agentInitial, asArray, readAccounts, writeAccounts, describeModelError, isAuthenticationError, takeSegment, dateLabel, splitSegments } from './lib/utils';
import { AccountSwitcherModal, AgentCard, AgentFormModal, AgentProfileModal, GroupCreateModal, GroupInfoPanel } from './components/panels';
import ChatPanel from './components/ChatPanel';


function App() {
  const { state: workspacePreferences, setSetting: setWorkspaceSetting } = useWorkspacePreferences();
  const { profile } = useProfile();
  const { formatTime, formatDate } = useTime();
  const workspaceClock = <time className="workspace-clock" dateTime={new Date().toISOString()}>{workspacePreferences.time.showDate && <span>{formatDate()}</span>}<b>{formatTime()}</b></time>;
  const { playUiSound } = useAudio();
  const { state: windowState, restoreWindow, focusWindow, closeWindow } = useWindowManager();
  const { listening, interimText, finalText, speaking, error: voiceError, recognitionSupported, ttsSupported, toggleListening, setFinalText, speak, stopSpeaking, clearError } = useVoice();
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authAction, setAuthAction] = useState('sign-in');
  const [authNotice, setAuthNotice] = useState('');
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState([]);
  const [memory, setMemory] = useState({ count: 0, memories: [] });
  const [syncCursor, setSyncCursor] = useState('');
  const [models, setModels] = useState({ defaultProvider: 'mock', providers: [] });
  const [agents, setAgents] = useState([]);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);
  const [profileAgentId, setProfileAgentId] = useState(null);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [mode, setMode] = useState('companion');
  const [companionIntent, setCompanionIntent] = useState('listen');
  const [toolEvents, setToolEvents] = useState([]);
  const [dispatchedTasks, setDispatchedTasks] = useState([]);
  const [pendingApproval, setPendingApproval] = useState(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalForSession, setApprovalForSession] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState('mock');
  const [selectedModel, setSelectedModel] = useState('mock');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [tests, setTests] = useState({});
  const [actualModel, setActualModel] = useState({ provider: '', model: '' });
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingText, setEditingText] = useState('');
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const conversationRef = useRef(null);
  const nearBottomRef = useRef(true);
  const streamStateRef = useRef({ currentId: null, buffer: '', pausing: false, timer: null, counter: 0 });
  const [jumpToBottom, setJumpToBottom] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [channel, setChannel] = useState('默认');
  const [channels, setChannels] = useState([]);
  // Legacy task state is retained only to keep old imported layouts inert until redesign;
  // the calendar (纪念日 / 计划) is live and backed by /api/events.
  const [taskOpen, setTaskOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [tasks] = useState([]);
  const [events, setEvents] = useState([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newEvent, setNewEvent] = useState({ title: '', date: '', type: 'plan', note: '' });
  const [page, setPageState] = useState('splash');
  const setPage = nextPage => setPageState(currentPage => currentPage === nextPage && currentPage !== 'splash' ? 'chat' : nextPage);
  const [minimized, setMinimized] = useState(false);
  const [autoRead, setAutoRead] = useState(true);
  const [speakingId, setSpeakingId] = useState(null);
  const autoReadRef = useRef(true);
  const wasListeningRef = useRef(false);

  const toggleAutoRead = () => {
    const next = !autoRead;
    autoReadRef.current = next;
    setAutoRead(next);
    if (!next) { stopSpeaking(); setSpeakingId(null); }
  };

  // 语音识别错误 → 复用全局 toast
  useEffect(() => {
    if (voiceError) { setError(voiceError); clearError(); }
  }, [voiceError, clearError]);

  // 语音输入结束（手动停止或自动停止）→ 把识别到的最终文本回填到输入框
  useEffect(() => {
    const wasListening = wasListeningRef.current;
    wasListeningRef.current = listening;
    if (wasListening && !listening && finalText.trim()) {
      setInput(current => {
        const base = current.trim();
        const addition = finalText.trim();
        return `${base}${base ? ' ' : ''}${addition}`;
      });
      setFinalText('');
    }
  }, [listening, finalText, setFinalText]);

  const toggleSpeak = item => {
    const full = messages.find(message => message.id === item.id);
    const text = String(full?.content || item.content || '').trim();
    if (!text) return;
    if (speakingId === item.id) {
      stopSpeaking();
      setSpeakingId(null);
      return;
    }
    stopSpeaking();
    speak(text, () => setSpeakingId(current => (current === item.id ? null : current)));
    setSpeakingId(item.id);
  };

  const selectedProviderInfo = useMemo(() => models.providers.find(item => item.provider === selectedProvider), [models.providers, selectedProvider]);
  const currentSession = useMemo(() => sessions.find(item => item.id === sessionId) || null, [sessions, sessionId]);
  const currentAgent = useMemo(() => agents.find(item => item.id === currentSession?.agentId) || null, [agents, currentSession?.agentId]);
  const profileAgent = useMemo(() => agents.find(item => item.id === profileAgentId) || null, [agents, profileAgentId]);
  const messageAvatar = message => {
    if (message.senderAvatar) return message.senderAvatar;
    const sender = agents.find(agent => agent.id === message.senderId) || (currentSession?.kind === 'private' ? currentAgent : null);
    if (sender?.avatarImage) return <img src={sender.avatarImage} alt="" />;
    if (sender) return agentInitial(sender);
    return profile.avatar;
  };

  const loadModel = async id => {
    const selection = await api(`/api/sessions/${id}/model`);
    setSelectedProvider(selection.modelProvider);
    setSelectedModel(selection.modelName);
    return selection;
  };

  const loadSessionMessages = async (id, targetChannel) => {
    const nextMessages = await api(`/api/sessions/${id}/messages?channel=${encodeURIComponent(targetChannel || '默认')}`);
    const safeMessages = asArray(nextMessages).map(message => {
      const avatarImage = (typeof message.senderAvatarImage === 'string' && message.senderAvatarImage.startsWith('data:image/'))
        ? message.senderAvatarImage
        : '';
      if (avatarImage) return { ...message, senderAvatar: <img src={avatarImage} alt="" /> };
      return message.senderAvatar ? message : { ...message, senderAvatar: messageAvatar(message) };
    });
    setMessages(safeMessages);
    setChannel(targetChannel || '默认');
  };

  const load = async id => {
    setSessionId(id);
    // channels / mode / model 并行加载，减少串行等待
    const [nextChannels, modeRes] = await Promise.all([
      api(`/api/sessions/${id}/channels`),
      api(`/api/mode?sessionId=${encodeURIComponent(id)}`),
      loadModel(id)
    ]);
    setChannels(asArray(nextChannels));
    setMode(modeRes?.mode || 'companion');
    setCompanionIntent(modeRes?.companionIntent || 'listen');
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

  const updateCurrentGroup = async changes => {
    try {
      const updated = await api(`/api/sessions/${sessionId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      setSessions(current => current.map(item => item.id === updated.id ? updated : item));
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

  const orderAgents = list => [...list].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const loadAgents = async () => {
    try { setAgents(orderAgents(asArray(await api('/api/agents')))); } catch { /* Agent 列表加载失败不阻塞主流程 */ }
  };

  const loadEvents = async () => {
    try { setEvents(asArray(await api('/api/events'))); } catch { /* 日历加载失败不阻塞主流程 */ }
  };

  const refresh = async () => {
    const [nextSessions, nextMemory, modelCatalog] = await Promise.all([
      api('/api/sessions'), api('/api/memory/overview'), api('/api/models')
    ]);
    const safeSessions = asArray(nextSessions);
    setSessions(safeSessions);
    setMemory({ count: Number(nextMemory?.count) || 0, memories: asArray(nextMemory?.memories) });
    setModels(modelCatalog && Array.isArray(modelCatalog.providers) ? modelCatalog : { defaultProvider: 'mock', providers: [] });
    await loadEvents();
    if (safeSessions.some(item => item.id === sessionId)) await loadModel(sessionId);
    return safeSessions;
  };

  const syncWorkspace = async () => {
    const result = await api(`/api/sync?limit=100${syncCursor ? `&cursor=${encodeURIComponent(syncCursor)}` : ''}`);
    setSyncCursor(result.nextCursor || syncCursor);
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

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active) { setUser(data.session?.user || null); setAuthReady(true); } });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user || null));
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  // 登录成功后把当前账号记进最近账号列表（只存邮箱+名字）
  useEffect(() => {
    if (!user?.email) return;
    const list = readAccounts().filter(item => item.email !== user.email);
    list.unshift({ email: user.email, name: profile.name || user.email, lastUsedAt: Date.now() });
    writeAccounts(list.slice(0, 6));
  }, [user?.email, profile.name]);

  useEffect(() => {
    if (!authReady || (supabase && !user)) return;
    void loadAgents();
    refresh().then(() => setPageState('home')).catch(err => {
      // 登录状态切换期间的 401 是预期状态，不应在 Splash 上显示误导性的红色提示。
      if (isAuthenticationError(err) && !user) return;
      setError(err.message);
    });
  }, [authReady, user]);

  useEffect(() => {
    const openAgentModal = () => { setEditingAgent(null); setAgentModalOpen(true); };
    window.addEventListener('cochpia:create-agent', openAgentModal);
    return () => window.removeEventListener('cochpia:create-agent', openAgentModal);
  }, []);

  useEffect(() => {
    if (!authReady || (supabase && !user)) return undefined;
    const interval = window.setInterval(() => {
      syncWorkspace().catch(err => {
        // 前端认证配置尚未加载时，后台同步收到 401 不应干扰 Splash 或登录界面。
        if (isAuthenticationError(err) && !user) return;
        setError(err.message);
      });
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [authReady, user, syncCursor]);

  // 已派发任务的轻量轮询：更新状态直到进入终态
  useEffect(() => {
    const active = dispatchedTasks.filter(item => !['completed', 'failed', 'cancelled'].includes(item.status));
    if (!active.length) return undefined;
    const timer = window.setInterval(() => {
      active.forEach(item => {
        api(`/api/workbench/tasks/${item.taskId}`).then(({ task }) => {
          setDispatchedTasks(current => current.map(entry => entry.taskId === item.taskId ? { ...entry, status: task.status, message: task.message } : entry));
        }).catch(() => {});
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [dispatchedTasks]);

  const modalOpen = Boolean(pendingApproval);

  useEffect(() => {
    if (!modalOpen) return undefined;
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return;
      if (pendingApproval) respondApproval(false);
    };
    document.body.classList.add('modal-open');
    window.addEventListener('keydown', closeOnEscape);
    return () => { document.body.classList.remove('modal-open'); window.removeEventListener('keydown', closeOnEscape); };
  }, [modalOpen, pendingApproval]);

  useEffect(() => {
    if (page !== 'home') return undefined;
    const cards = Array.from(document.querySelectorAll('.aube-mini'));
    const onKeyDown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.currentTarget.click();
    };
    cards.forEach(card => {
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('keydown', onKeyDown);
    });
    return () => cards.forEach(card => {
      card.removeEventListener('keydown', onKeyDown);
      card.removeAttribute('role');
      card.removeAttribute('tabindex');
    });
  }, [page]);

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
      if (message.role === 'assistant' && !('isStreaming' in message) && mode !== 'work') {
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
  }, [messages, mode]);
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

  const newSession = () => {
    setPageState('home');
    if (!agents.length) setError('请先创建一个 Agent，再开始新的私聊。');
  };

  const saveAgent = async draft => {
    try {
      const headers = { 'Content-Type': 'application/json' };
      const saved = editingAgent?.id
        ? await api(`/api/agents/${editingAgent.id}`, { method: 'PATCH', headers, body: JSON.stringify(draft) })
        : await api('/api/agents', { method: 'POST', headers, body: JSON.stringify(draft) });
      setAgents(current => orderAgents(editingAgent?.id ? current.map(item => item.id === saved.id ? saved : item) : [...current, saved]));
      setAgentModalOpen(false);
      setEditingAgent(null);
    } catch (err) { setError(err.message); }
  };

  const deleteAgent = async agent => {
    if (!window.confirm(`确定删除角色「${agent.name}」吗？`)) return;
    try {
      await api(`/api/agents/${agent.id}`, { method: 'DELETE' });
      setAgents(current => current.filter(item => item.id !== agent.id));
    } catch (err) { setError(err.message); }
  };

  const patchAgent = (agentId, draft) => {
    // 乐观更新：立即改本地，后台持久化，避免慢 DB（约几十秒）卡住 UI。
    setAgents(current => orderAgents(current.map(item => item.id === agentId ? { ...item, ...draft } : item)));
    void api(`/api/agents/${agentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })
      .then(updated => setAgents(current => orderAgents(current.map(item => item.id === updated.id ? updated : item))))
      .catch(err => setError(err.message));
  };

  const saveAgentById = async (agentId, draft) => {
    // 群聊成员编辑走这个真正 await 的版本，保证「保存中…」状态真实。
    const updated = await api(`/api/agents/${agentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
    setAgents(current => orderAgents(current.map(item => item.id === updated.id ? updated : item)));
    return updated;
  };

  const startPrivateChat = async agent => {
    try {
      const existing = sessions.find(item => item.kind === 'private' && item.agentId === agent.id);
      // 立即切到聊天页，不阻塞在会话创建（POST/DB 较慢）
      setPage('chat');
      const session = existing || await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'private', agentId: agent.id, title: `与 ${agent.name} 的私聊` }) });
      if (!existing) setSessions(current => [session, ...current]);
      await load(session.id);
    } catch (err) { setError(err.message); }
  };

  const startGroupChat = async draft => {
    try {
      setGroupCreateOpen(false);
      setPage('chat');
      const session = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'group', title: draft.title, description: draft.description, agentIds: draft.agentIds }) });
      setSessions(current => [session, ...current]);
      await load(session.id);
    } catch (err) { setError(err.message); }
  };

  const updateGroupAgents = async (sessionTarget, patch) => {
    try {
      const updated = await api(`/api/sessions/${sessionTarget.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      setSessions(current => current.map(item => item.id === updated.id ? updated : item));
    } catch (err) { setError(err.message); }
  };

  const toggleGroupMode = () => {
    if (!currentSession || currentSession.kind !== 'group') return;
    void updateGroupAgents(currentSession, { groupMode: currentSession.groupMode === 'turn' ? 'parallel' : 'turn' });
  };

  const deleteSession = async (id, event) => {
    if (event) event.stopPropagation();
    if (!window.confirm('确定删除这个会话吗？聊天记录将一并删除，无法恢复。')) return;
    try {
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      const remaining = sessions.filter(s => s.id !== id);
      setSessions(remaining);
      if (sessionId === id) {
        if (remaining[0]?.id) await load(remaining[0].id);
        else setPageState('home');
      }
    } catch (err) { setError(err.message); }
  };

  const createTask = event => { event.preventDefault(); setNewTaskTitle(''); setTaskOpen(false); };
  const completeTask = () => {};
  const createEvent = async event => {
    event.preventDefault();
    const title = newEvent.title.trim();
    if (!title || !newEvent.date) return;
    try {
      await api('/api/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, date: newEvent.date, type: newEvent.type, note: newEvent.note })
      });
      setNewEvent({ title: '', date: '', type: 'plan', note: '' });
      setEventOpen(false);
      await loadEvents();
    } catch (err) { setError(err.message); }
  };
  const removeEvent = async id => {
    try { await api(`/api/events/${id}`, { method: 'DELETE' }); await loadEvents(); }
    catch (err) { setError(err.message); }
  };

  const sendMessage = async event => {
    event.preventDefault();
    if (!input.trim() || streaming) return;
    void playUiSound('click');
    setError('');
    setToolEvents([]);
    setDispatchedTasks([]);
    setPendingApproval(null);
    const text = input.trim();
    if (sessions.find(item => item.id === sessionId)?.kind === 'group') {
      setInput('');
      const members = agents.filter(agent => (currentSession?.agentIds || []).includes(agent.id));
      const stamp = `group-${Date.now()}`;
      setMessages(current => [...current, { id: `local-${stamp}`, role: 'user', content: text, createdAt: new Date().toISOString() }, ...members.map(agent => ({ id: `${stamp}-${agent.id}`, role: 'assistant', content: '', createdAt: new Date().toISOString(), senderId: agent.id, senderName: agent.name, senderAvatar: agentInitial(agent), isStreaming: true }))]);
      nearBottomRef.current = true;
      scrollToBottom('auto');
      setStreaming(true);
      try {
        const session = supabase ? (await supabase.auth.getSession()).data.session : null;
        const response = await fetch(`${apiBase}/api/chat/group`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
          body: JSON.stringify({ sessionId, message: text, channel })
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error?.message || payload?.error || '群聊连接失败');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          for (const part of parts) {
            const eventName = part.match(/^event:\s*(.+)$/m)?.[1];
            const dataText = part.match(/^data:\s*(.+)$/ms)?.[1];
            if (!eventName || !dataText) continue;
            let data;
            try { data = JSON.parse(dataText); } catch { continue; }
            if (eventName === 'text' && data.agentId) {
              const delta = String(data.delta || '');
              const agentId = data.agentId;
              setMessages(current => current.map(item => item.senderId === agentId && item.isStreaming ? { ...item, content: item.content + delta } : item));
            } else if (eventName === 'agent_done' && data.agentId) {
              const agentId = data.agentId;
              const finalContent = String(data.content || '');
              setMessages(current => current.map(item => item.senderId === agentId && item.isStreaming ? { ...item, content: finalContent || item.content, isStreaming: false } : item));
            } else if (eventName === 'done') {
              const finalMessages = Array.isArray(data.messages) ? data.messages : [];
              setMessages(current => current.map(item => {
                const final = finalMessages.find(message => message.senderId === item.senderId);
                return final ? { ...item, content: final.content, isStreaming: false } : item;
              }));
            }
          }
        }
      } catch (err) {
        setError(err.message);
        setInput(text);
        setMessages(current => current.filter(item => !String(item.id).startsWith(stamp) || item.role === 'user'));
      } finally {
        setStreaming(false);
        void loadSessionMessages(sessionId, channel).catch(() => {});
      }
      return;
    }
    setInput('');
    const firstId = 'streaming-0';
    streamStateRef.current = { currentId: firstId, buffer: '', pausing: false, timer: null, counter: 0 };
    const localAgentIdentity = currentSession?.kind === 'private' && currentAgent
      ? { senderId: currentAgent.id, senderName: currentAgent.name, senderAvatar: currentAgent.avatarImage ? <img src={currentAgent.avatarImage} alt="" /> : agentInitial(currentAgent) }
      : {};
    setMessages(current => [...current, { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString() }, { id: firstId, role: 'assistant', content: '', createdAt: new Date().toISOString(), ...localAgentIdentity, isStreaming: true }]);
    nearBottomRef.current = true;
    scrollToBottom('auto');
    setStreaming(true);
    let completionUnlockTimer;
    const streamProcess = () => {
      const st = streamStateRef.current;
      if (st.pausing) return;
      // 工作模式：连续流式输出，不分段、不延迟（代码含大量换行，分段会被切碎）
      if (mode === 'work') {
        setMessages(current => current.map(item => item.id === st.currentId ? { ...item, content: st.buffer } : item));
        return;
      }
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
        body: JSON.stringify({ sessionId, message: text, provider: selectedProvider, model: selectedModel, channel, companionIntent: mode === 'companion' ? companionIntent : null })
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
      let fullText = '';
      let assistantMessageId = '';
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
          if (eventName === 'text') { fullText += data.delta; streamStateRef.current.buffer += data.delta; streamProcess(); scheduleComposerUnlock(); }
          if (eventName === 'error') {
            const terminalToolLimit = data.code === 'TOOL_LOOP_LIMIT' || data.code === 'TOOL_LOOP_REPEATED';
            if (!terminalToolLimit) {
              streamError = describeModelError({ code: data.code, message: data.message || '生成失败' });
              setError(streamError);
            }
          }
          if (eventName === 'tool') { setToolEvents(current => [...current, { name: data.name, args: data.args, result: null }]); }
          if (eventName === 'tool_pending') { setApprovalForSession(false); setPendingApproval({ runId: data.runId, toolCallId: data.toolCallId, name: data.name, args: data.args, risk: data.risk || 'execute', approvalStage: 1 }); }
          if (eventName === 'tool_result') { setToolEvents(current => { const next = [...current]; for (let i = next.length - 1; i >= 0; i -= 1) { if (next[i].result === null && next[i].name === data.name) { next[i] = { ...next[i], result: data.result }; break; } } return next; }); }
          if (eventName === 'agent_task_dispatched') { setDispatchedTasks(current => [...current, { taskId: data.taskId, target: data.target, task: data.task, status: 'submitted', message: '已提交' }]); }
          if (eventName === 'done') { streamFinished = true; if (data.mode) setMode(data.mode); if (data.messageId) assistantMessageId = data.messageId; if (data.ok === false && !streamError) streamError = '模型没有完成本次回复'; }
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
      if (autoReadRef.current && fullText.trim()) { setSpeakingId(assistantMessageId || null); speak(fullText.trim(), () => setSpeakingId(null)); }
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

  // 切换账号：退出当前会话，预填目标邮箱（需重新输密码，安全起见不存 token）
  const switchAccount = async email => {
    setAccountSwitcherOpen(false);
    setAuthEmail(email || '');
    setAuthPassword('');
    setError('');
    setAuthNotice('');
    setAuthAction('sign-in');
    await supabase.auth.signOut();
  };

  const addAccount = async () => {
    setAccountSwitcherOpen(false);
    setAuthEmail('');
    setAuthPassword('');
    setError('');
    setAuthNotice('');
    setAuthAction('sign-in');
    await supabase.auth.signOut();
  };

  const toggleWindow = id => {
    const windowRecord = windowState.windows[id];
    if (windowRecord && !windowRecord.closed && !windowRecord.minimized) {
      closeWindow(id);
      return;
    }
    restoreWindow(id);
    focusWindow(id);
  };
  const openSettings = () => toggleWindow('settings');
  const openMusic = () => toggleWindow('music');
  const fileRef = useRef(null);
  const uploadFile = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    setError('');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
      });
      const result = await api('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, dataUrl }) });
      setInput(current => `${current}${current ? '\n' : ''}[上传文件：${result.path}（${Math.round(result.size / 1024)}KB）]`);
    } catch (err) { setError(err.message); }
  };
  const respondApproval = async approved => {
    if (!pendingApproval || approvalSubmitting) return;
    setApprovalSubmitting(true);
    try {
      const result = await api('/api/chat/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...pendingApproval, approved, acceptForSession: approvalForSession }) });
      if (result.awaitingSecondApproval) { setPendingApproval(current => current ? { ...current, approvalStage: 2 } : current); setApprovalForSession(false); return; }
      setPendingApproval(null);
      setApprovalForSession(false);
    } catch (err) {
      if (err.code === 'APPROVAL_ALREADY_DECIDED' || err.code === 'APPROVAL_NOT_FOUND') setPendingApproval(null);
      setError(err.message);
    } finally { setApprovalSubmitting(false); }
  };
  const toggleMode = async () => {
    const next = mode === 'companion' ? 'work' : 'companion';
    try {
      const result = await api('/api/mode', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next, sessionId, companionIntent }) });
      setMode(result.mode);
      setCompanionIntent(result.companionIntent || 'listen');
    } catch (err) { setError(err.message); }
  };

  if (supabase && !authReady) return <main className="auth-shell"><p className="auth-loading">正在检查登录状态…</p></main>;
  if (supabase && authReady && !user) return <main className="auth-shell"><form className="auth-panel" onSubmit={submitAuth}><p className="eyebrow">COCHPIA AUTH</p><h1>进入你的共同空间</h1><label>邮箱<input type="email" value={authEmail} onChange={event => setAuthEmail(event.target.value)} autoComplete="email" required /></label><label>密码<input type="password" value={authPassword} onChange={event => setAuthPassword(event.target.value)} autoComplete={authAction === 'sign-in' ? 'current-password' : 'new-password'} required /></label><button className="auth-submit" disabled={authBusy}>{authBusy ? '处理中…' : authAction === 'sign-in' ? '登录' : '创建账户'}</button><button type="button" className="auth-switch" onClick={() => { setAuthAction(authAction === 'sign-in' ? 'sign-up' : 'sign-in'); setError(''); setAuthNotice(''); }}>{authAction === 'sign-in' ? '首次使用？创建账户' : '已有账户？返回登录'}</button>{authNotice && <p className="auth-notice" role="status">{authNotice}</p>}{error && <p className="auth-error" role="alert">{error}</p>}</form></main>;

  return <><BackgroundLayer /><div className={`app-shell${minimized ? ' minimized' : ''}`}>
    <div className="workspace-clock-overlay">{workspaceClock}</div>
    {user && supabase && <button className="auth-logout" onClick={() => setAccountSwitcherOpen(true)}>切换账号</button>}
    {page !== 'splash' && <div className="aube-lights"><i className="l-red" aria-hidden="true" /><i className="l-yellow" aria-hidden="true" /><button type="button" className="l-green" onClick={() => setMinimized(true)} title="最小化" aria-label="最小化应用" /></div>}
    {page === 'splash' && <button type="button" className="aube-splash" onClick={() => setPage('home')} aria-label="进入 Cochpia"><video className="aube-splash-video" src="/306155_medium.mp4" autoPlay muted loop playsInline preload="auto" aria-hidden="true" /><span className="aube-splash-veil" aria-hidden="true" /><span className="aube-splash-center"><span className="aube-orb"><span className="aube-orb-core" /></span><span className="aube-word">Cochpia</span><span className="aube-tag">Still Blooming</span><span className="aube-divider"><i /><em>✦</em><i /></span><span className="aube-hint">轻触进入</span></span></button>}
    {page !== 'splash' && <nav className="aube-nav"><button className={`aube-nav-item ${page === 'home' ? 'active' : ''}`} onClick={() => setPage('home')}><span className="aube-nav-dot"><FeatherIcon name="home" size={18} /></span><span className="aube-nav-lbl">Sanctum</span></button><button className={`aube-nav-item ${page === 'chat' ? 'active' : ''}`} onClick={() => setPage('chat')}><span className="aube-nav-dot"><FeatherIcon name="edit3" size={18} /></span><span className="aube-nav-lbl">Chat</span></button><button className={`aube-nav-item ${page === 'life' ? 'active' : ''}`} onClick={() => setPage('life')}><span className="aube-nav-dot"><FeatherIcon name="layers" size={18} /></span><span className="aube-nav-lbl">共生</span></button><button className={`aube-nav-item ${page === 'workbench' ? 'active' : ''}`} onClick={() => setPage('workbench')}><span className="aube-nav-dot"><FeatherIcon name="grid" size={18} /></span><span className="aube-nav-lbl">工作区</span></button><button className="aube-nav-item" onClick={openMusic}><span className="aube-nav-dot"><FeatherIcon name="music" size={18} /></span><span className="aube-nav-lbl">Music</span></button><button className="aube-nav-item" onClick={() => setWorkspaceSetting('theme', 'themeId', workspacePreferences.theme.themeId === 'sakura' ? 'ink' : 'sakura')}><span className="aube-nav-dot"><FeatherIcon name="moon" size={18} /></span><span className="aube-nav-lbl">Veil</span></button><button className="aube-nav-item" onClick={openSettings}><span className="aube-nav-dot"><FeatherIcon name="settings" size={18} /></span><span className="aube-nav-lbl">设置</span></button></nav>}
    {page === 'home' && <div className="aube-page-overlay aube-home-page"><div className="aube-page-scroll"><div className="aube-card aube-profile"><div className="aube-pava">{profile.avatarImage ? <img src={profile.avatarImage} alt={profile.name} /> : profile.avatar}</div><div><div className="aube-pname">{profile.name}<button type="button" className="text-button profile-edit" onClick={() => setProfileOpen(true)}>编辑档案</button></div><div className="aube-pquote">会从共同经历中逐步形成对你的理解。</div>{user?.email && <div className="aube-account"><span className="aube-account-mail">{user.email}</span><button type="button" className="text-button" onClick={() => setAccountSwitcherOpen(true)}>切换账号</button></div>}</div></div><div className="aube-duo"><div className="aube-card aube-mini" onClick={newSession}><span className="aube-mi"><FeatherIcon name="plus" size={18} /></span><h5>新的相遇</h5><small>{sessions.length} 个会话</small></div><div className="aube-card aube-mini" onClick={() => setEventOpen(true)}><span className="aube-mi"><FeatherIcon name="calendar" size={18} /></span><h5>日历</h5><small>{events.length} 条日程</small></div></div><div className="aube-sec">Agents</div><div className="agent-grid">{[...agents].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))).map(agent => <AgentCard key={agent.id} agent={agent} onChat={startPrivateChat} onEdit={item => { setEditingAgent(item); setAgentModalOpen(true); }} onDelete={deleteAgent} onView={item => setProfileAgentId(item.id)} />)}<button type="button" className="agent-card agent-card-new" onClick={() => { setEditingAgent(null); setAgentModalOpen(true); }}><span className="agent-card-plus">＋</span><strong>新建角色</strong><small>添加一个 Agent</small></button><button type="button" className="agent-card agent-card-new" onClick={() => setGroupCreateOpen(true)}><span className="agent-card-plus">👥</span><strong>发起群聊</strong><small>选择成员建群</small></button></div><div className="aube-sec">Sessions</div><div className="aube-sessions">{sessions.map(session => <div key={session.id} className={`aube-session-row ${session.id === sessionId ? 'active' : ''}`}><button className="aube-session" onClick={() => { load(session.id); setPage('chat'); }}>{session.title}</button><button type="button" className="session-delete" onClick={event => deleteSession(session.id, event)} title="删除会话"><FeatherIcon name="x" size={16} /></button></div>)}</div></div></div>}
    {page === 'life' && <div className="aube-page-overlay"><div className="aube-page-scroll"><LifeGame onChat={() => setPage('chat')} /><details className="life-calendar-legacy"><summary>查看生命格日历</summary><LifeCalendar /></details></div></div>}
    {page === 'workbench' && <WorkbenchPage models={models} selectedProvider={selectedProvider} selectedModel={selectedModel} selectedProviderInfo={selectedProviderInfo} onSelectProvider={selectProvider} onSelectModel={selectModel} onTestProvider={testProvider} tests={tests} onSaveSelection={saveSelection} />}



    {page === 'chat' && !sessionId ? <main className={`main-panel ${page !== 'chat' ? 'is-page-hidden' : ''}`}><div className="empty-state chat-session-empty">{agents.length === 0 ? <><h2>还没有角色，去创建一个吧</h2><button type="button" className="select-model" onClick={() => { setEditingAgent(null); setAgentModalOpen(true); }}>新建角色</button></> : <h2>选择一个会话开始聊天，或回首页给角色发消息</h2>}</div></main> : <ChatPanel page={page} currentSession={currentSession} currentAgent={currentAgent} workspacePreferences={workspacePreferences} setWorkspaceSetting={setWorkspaceSetting} channels={channels} channel={channel} switchChannel={switchChannel} addChannel={addChannel} searchQuery={searchQuery} setSearchQuery={setSearchQuery} mode={mode} toggleMode={toggleMode} toggleGroupMode={toggleGroupMode} setGroupPanelOpen={setGroupPanelOpen} conversationRef={conversationRef} onConversationScroll={onConversationScroll} messages={messages} groupedMessages={groupedMessages} profile={profile} formatTime={formatTime} editingMessageId={editingMessageId} editingText={editingText} setEditingText={setEditingText} saveMessageEdit={saveMessageEdit} cancelEditingMessage={cancelEditingMessage} startEditingMessage={startEditingMessage} removeMessage={removeMessage} toggleSpeak={toggleSpeak} speakingId={speakingId} ttsSupported={ttsSupported} dispatchedTasks={dispatchedTasks} toolEvents={toolEvents} jumpToBottom={jumpToBottom} nearBottomRef={nearBottomRef} setJumpToBottom={setJumpToBottom} scrollToBottom={scrollToBottom} companionIntent={companionIntent} setCompanionIntent={setCompanionIntent} fileRef={fileRef} uploadFile={uploadFile} streaming={streaming} listening={listening} finalText={finalText} interimText={interimText} input={input} setInput={setInput} toggleListening={toggleListening} recognitionSupported={recognitionSupported} autoRead={autoRead} toggleAutoRead={toggleAutoRead} sendMessage={sendMessage} />}
    <aside className="sidebar"><div className="brand"><span className="brand-mark">{profile.avatarImage ? <img src={profile.avatarImage} alt={profile.name} /> : profile.avatar}</span><div><strong>{profile.name}</strong><span>relationship workspace</span></div></div><button className="new-chat" onClick={newSession}><span>+</span> 新的相遇</button><div className="section-label">会话</div><nav className="session-list">{sessions.map(session => <div key={session.id} className={`session-row ${session.id === sessionId ? 'active' : ''}`}><button className="session" onClick={() => load(session.id)}><span className="session-dot" />{session.title}</button><button type="button" className="session-delete" onClick={event => deleteSession(session.id, event)} title="删除会话"><FeatherIcon name="x" size={16} /></button></div>)}</nav><div className="sidebar-foot"><span className="status-dot" />本地开发模式<span className="version">v0.1</span></div></aside>


    <div className="window-layer"><FloatingWindow id="inspector" title="共同状态"><aside className="inspector"><div className="inspector-head"><div><p className="eyebrow">COGNITIVE STATE</p><h2>共同状态</h2></div><span className="live-pill">LIVE</span></div><section className="state-card"><div className="state-card-top"><span className="state-icon">✦</span><div><strong>关系正在形成</strong><span>基于共同事件持续更新</span></div></div><div className="state-line"><span>共享记忆</span><strong>{memory.count}</strong></div><div className="state-line"><span>当前设定</span><strong>会话级</strong></div></section><MaterialPreview /><section className="inspector-section"><div className="section-heading"><span>最近记忆</span><span className="count-label">{memory.count} 条</span></div>{memory.memories.slice(0, 3).map(item => <div className="memory-item" key={item.id}><span className="memory-type">{item.type === 'relationship' ? '关系' : '事件'}</span><p>{item.summary}</p><small>{Math.round(item.confidence * 100)}% 确信 · {item.source}</small></div>)}</section><section className="protocol-note"><span>◎</span><p><strong>共同经历</strong>记忆只在获得相关上下文时参与当前回复。</p></section></aside></FloatingWindow><MusicWindow /><SettingsWindow onExport={exportData} onImport={importData} /></div>


    {profileOpen && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setProfileOpen(false); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title"><CharacterProfile onClose={() => setProfileOpen(false)} /></section></div>}
    {pendingApproval && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) respondApproval(false); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="approval-title" onClick={event => event.stopPropagation()}><header className="settings-header"><div><p className="eyebrow">WORK MODE · 待确认操作</p><h2 id="approval-title">{pendingApproval.approvalStage === 2 ? '二次确认部署操作' : `确认${pendingApproval.risk === 'write' ? '写入文件' : pendingApproval.risk === 'deploy' ? '部署操作' : '执行命令'}？`}</h2><p>{pendingApproval.approvalStage === 2 ? '部署操作需要第二次确认才会放行。' : `风险等级：${pendingApproval.risk === 'write' ? '写入' : pendingApproval.risk === 'deploy' ? '部署' : '执行'}`}</p></div><button className="icon-button" disabled={approvalSubmitting} onClick={() => respondApproval(false)}><FeatherIcon name="x" size={16} /></button></header><div className="approval-body"><div className="approval-path">{pendingApproval.name === 'bash' ? '$ 命令' : '文件操作'}</div>{pendingApproval.name === 'edit' ? <div className="approval-diff"><div className="approval-old">− {String(pendingApproval.args?.oldText || '').slice(0, 500)}</div><div className="approval-new">+ {String(pendingApproval.args?.newText || '').slice(0, 500)}</div></div> : pendingApproval.name === 'bash' ? <pre className="approval-content">$ {String(pendingApproval.args?.command || '')}</pre> : <pre className="approval-content">{String(pendingApproval.args?.content || '').slice(0, 2000)}</pre>}{pendingApproval.risk === 'write' && pendingApproval.approvalStage !== 2 && <label className="approval-session-grant"><input type="checkbox" checked={approvalForSession} onChange={event => setApprovalForSession(event.target.checked)} /> 本次会话始终允许文件写入</label>}<div className="approval-actions"><button type="button" className="select-model" disabled={approvalSubmitting} onClick={() => respondApproval(true)}>{approvalSubmitting ? '处理中…' : pendingApproval.approvalStage === 2 ? '确认第二次放行' : '确认执行'}</button><button type="button" className="text-button muted-button" disabled={approvalSubmitting} onClick={() => respondApproval(false)}>拒绝</button></div></div></section></div>}

    {eventOpen && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setEventOpen(false); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="event-title"><header className="settings-header"><div><p className="eyebrow">CALENDAR · 日历</p><h2 id="event-title">纪念日与计划</h2><p>临近的事项会自动注入对话上下文。</p></div><button className="icon-button" aria-label="关闭日历" title="关闭日历" onClick={() => setEventOpen(false)}><FeatherIcon name="x" size={16} /></button></header><form className="event-form" onSubmit={createEvent}><input value={newEvent.title} onChange={event => setNewEvent(current => ({ ...current, title: event.target.value }))} placeholder="标题,例如:初次相遇" aria-label="事件标题" /><input type="date" value={newEvent.date} onChange={event => setNewEvent(current => ({ ...current, date: event.target.value }))} aria-label="日期" /><select value={newEvent.type} onChange={event => setNewEvent(current => ({ ...current, type: event.target.value }))} aria-label="类型"><option value="anniversary">纪念日</option><option value="birthday">生日</option><option value="plan">计划</option><option value="record">记录</option></select><button className="select-model" type="submit" disabled={!newEvent.title.trim() || !newEvent.date}>添加</button></form><div className="task-list">{events.length === 0 ? <p className="empty-detail">还没有日程。</p> : events.map(item => <div className="task-row" key={item.id}><div><strong>{item.title}</strong><small>{item.type === 'anniversary' ? '纪念日' : item.type === 'birthday' ? '生日' : item.type === 'plan' ? '计划' : '记录'} · {new Date(item.date).toLocaleDateString('zh-CN')}{item.note ? ' · ' + item.note : ''}</small></div><button type="button" className="t-del" title="删除" onClick={() => removeEvent(item.id)}><FeatherIcon name="x" size={16} /></button></div>)}</div></section></div>}
    {accountSwitcherOpen && <AccountSwitcherModal user={user} onClose={() => setAccountSwitcherOpen(false)} onSwitch={switchAccount} onAdd={addAccount} />}
    <AgentProfileModal agent={profileAgent} onClose={() => setProfileAgentId(null)} onChat={agent => { setProfileAgentId(null); void startPrivateChat(agent); }} onEdit={agent => { setProfileAgentId(null); setEditingAgent(agent); setAgentModalOpen(true); }} onPatch={patch => { if (profileAgent) void patchAgent(profileAgent.id, patch); }} />
    {agentModalOpen && <AgentFormModal agent={editingAgent} models={models} onClose={() => { setAgentModalOpen(false); setEditingAgent(null); }} onSave={saveAgent} />}
    {groupCreateOpen && <GroupCreateModal agents={agents} onClose={() => setGroupCreateOpen(false)} onCreate={startGroupChat} />}
    <GroupInfoPanel session={currentSession} agents={agents} open={groupPanelOpen} onClose={() => setGroupPanelOpen(false)} onSave={patch => updateGroupAgents(currentSession, patch)} onInvite={id => updateGroupAgents(currentSession, { agentIds: [...new Set([...(currentSession?.agentIds || []), id])] })} onRemove={id => updateGroupAgents(currentSession, { agentIds: (currentSession?.agentIds || []).filter(item => item !== id) })} onAgentSave={saveAgentById} />
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

createRoot(document.getElementById('root')).render(<AppErrorBoundary><WorkspacePreferencesProvider><I18nProvider><TimeProvider><MusicProvider><AudioProvider><VoiceProvider><MaterialProvider><WindowManagerProvider><ProfileProvider><App /></ProfileProvider></WindowManagerProvider></MaterialProvider></VoiceProvider></AudioProvider></MusicProvider></TimeProvider></I18nProvider></WorkspacePreferencesProvider></AppErrorBoundary>);

// PWA：生产环境注册 Service Worker；开发地址主动注销历史 SW，避免旧缓存接管页面。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    if (!import.meta.env.PROD) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(cacheName => caches.delete(cacheName)));
      }
      // 旧 SW 可能已经控制了本次页面；清缓存后只 reload 一次，确保旧 JS/CSS 不再运行。
      if (navigator.serviceWorker.controller && !sessionStorage.getItem('cochpia-sw-cleaned')) {
        sessionStorage.setItem('cochpia-sw-cleaned', '1');
        window.location.reload();
      }
      return;
    }
    try {
      const registration = await navigator.serviceWorker.register('/sw.js?v=20260901-cache-v24', { updateViaCache: 'none' });
      await registration.update();
    } catch {
      /* SW 注册失败不影响主流程 */
    }
  });
}
