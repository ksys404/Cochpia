import React, { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import { getTypographyFont } from './typographyRegistry';
import { api, supabase } from '../api';

const STORAGE_KEY = 'cochpia.workspace-preferences.v1';

const defaults = {
  theme: { themeId: 'sakura', accentColor: '#B24A6E', transitionEnabled: true, customColors: { canvas: '#160A22', panel: '#1F1130', elevated: '#2A1A40', textStrong: '#F6EDFF', textBody: '#CBB9E2', textMuted: '#9381B0', border: '#3C2852', action: '#FF6FAE', actionHover: '#FF8FC4', onAction: '#2A0B1E' } },
  background: { mode: 'color', color: '#fff6fa', imageUrl: '', gradient: 'radial-gradient(circle at 20% 10%, rgba(201,105,139,.12), transparent 38%)', blur: 0, brightness: 1, saturation: 1, opacity: 1, overlayOpacity: 0, animationEnabled: false },
  typography: { fontFamily: 'system', fontScale: 1, fontWeight: 400, letterSpacing: 0, lineHeight: 1.55 },
  motion: { enabled: false, reducedMotion: true, animationLevel: 'low', intensity: 0, durationScale: 1 },
  sound: { musicVolume: 0.2, uiVolume: 0.08, aiVoiceVolume: 0.2, muted: false, uiSoundEnabled: false, musicEnabled: false, musicReactiveEnabled: false },
  time: { clockFormat: '24h', showSeconds: false, showDate: true, timezoneMode: 'system', timezone: null, ambientModeEnabled: true },
  language: { locale: 'zh-CN', fallbackLocale: 'zh-CN' },
  accessibility: { highContrast: false, largeText: false, keyboardMode: false, focusVisible: true },
  workspace: { layoutMode: 'freeform', snapEnabled: true, autoArrangeEnabled: false, dockVisible: true },
  appearance: { cornerRadius: 24, panelOpacity: 1.0 }
};

const mergeState = value => Object.keys(defaults).reduce((result, key) => {
  result[key] = { ...defaults[key], ...(value?.[key] || {}) };
  return result;
}, {});

const readState = (storageKey = STORAGE_KEY, legacyKey = '') => {
  try {
    const stored = window.localStorage.getItem(storageKey) || (legacyKey ? window.localStorage.getItem(legacyKey) : null);
    return mergeState(JSON.parse(stored || 'null'));
  } catch { return mergeState(); }
};

const storageKeyFor = session => session?.user?.id ? `${STORAGE_KEY}.${session.user.id}` : STORAGE_KEY;

const saveLocalState = (storageKey, state) => {
  try { window.localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Storage is optional. */ }
};

const reducer = (state, action) => {
  if (action.type === 'REPLACE_STATE') return mergeState(action.value);
  if (action.type === 'RESET_ALL') return mergeState();
  if (action.type === 'RESET_SLICE') return { ...state, [action.slice]: { ...defaults[action.slice] } };
  if (action.type === 'SET_SETTING') {
    let value = action.value;
    // 背景图：普通 URL 限长；data URL（本地上传）不截断，否则会损坏图片
    if (action.slice === 'background' && action.key === 'imageUrl') {
      value = String(value || '');
      if (!value.startsWith('data:image/')) value = value.slice(0, 2048);
    }
    if (action.slice === 'background' && action.key === 'gradient') value = String(value || '').slice(0, 1200);
    return { ...state, [action.slice]: { ...state[action.slice], [action.key]: value } };
  }
  return state;
};

const cssVariables = state => ({
  '--workspace-accent': state.theme.accentColor,
  '--workspace-background': state.theme.themeId === 'pearl' ? '#f5f0ed' : state.theme.themeId === 'blush' ? '#f4e4e8' : state.theme.themeId === 'mist' ? '#e7eef3' : state.theme.themeId === 'night' ? '#0A0F16' : state.theme.themeId === 'sakura' ? '#FBF1F4' : state.theme.themeId === 'ember' ? '#FBF3E7' : state.theme.themeId === 'moss' ? '#EEF5EF' : state.theme.themeId === 'ink' ? '#F2F1F6' : state.theme.themeId === 'va11' ? '#160A22' : state.background.color,
  '--workspace-background-image': state.background.imageUrl ? `url(${state.background.imageUrl})` : 'none',
  '--workspace-background-gradient': state.background.gradient || 'none',
  '--workspace-background-opacity': state.background.opacity,
  '--workspace-background-blur': `${state.background.blur}px`,
  '--workspace-background-brightness': state.background.brightness,
  '--workspace-background-saturation': state.background.saturation,
  '--workspace-surface-contrast': ['blush', 'pearl', 'mist', 'sakura', 'ember', 'moss', 'ink'].includes(state.theme.themeId) ? 'rgba(255,255,255,.72)' : 'rgba(7,18,28,.42)',
  '--workspace-surface-border': ['blush', 'pearl', 'mist', 'sakura', 'ember', 'moss', 'ink'].includes(state.theme.themeId) ? 'rgba(35,52,67,.22)' : 'rgba(255,255,255,.18)',
  '--workspace-font-scale': state.typography.fontScale * (state.accessibility.largeText ? 1.15 : 1),
  '--workspace-font-family': getTypographyFont(state.typography.fontFamily).stack,
  '--workspace-font-weight': state.typography.fontWeight,
  '--workspace-letter-spacing': `${state.typography.letterSpacing}px`,
  '--workspace-line-height': state.typography.lineHeight,
  '--font-size-xs': `${0.7 * state.typography.fontScale * (state.accessibility.largeText ? 1.15 : 1)}rem`,
  '--font-size-sm': `${0.8 * state.typography.fontScale * (state.accessibility.largeText ? 1.15 : 1)}rem`,
  '--font-size-md': `${0.875 * state.typography.fontScale * (state.accessibility.largeText ? 1.15 : 1)}rem`,
  '--font-size-lg': `${1.125 * state.typography.fontScale * (state.accessibility.largeText ? 1.15 : 1)}rem`,
  '--font-size-xl': `${1.5 * state.typography.fontScale * (state.accessibility.largeText ? 1.15 : 1)}rem`,
  '--font-size-display': `${2 * state.typography.fontScale * (state.accessibility.largeText ? 1.15 : 1)}rem`,
  '--app-radius': `${state.appearance.cornerRadius}px`,
  '--panel-alpha': state.appearance.panelOpacity,
  '--panel-blur': `${Math.round((1 - state.appearance.panelOpacity) * 40)}px`,
  '--workspace-ambient-duration': state.motion.animationLevel === 'low' ? '30s' : state.motion.animationLevel === 'high' ? '12s' : '21s',
  '--workspace-motion-duration': state.motion.reducedMotion || !state.motion.enabled ? '0ms' : `${state.motion.durationScale * 420}ms`
});

const WorkspacePreferencesContext = createContext(null);

export function WorkspacePreferencesProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, readState);
  const [remoteReady, setRemoteReady] = React.useState(false);
  const [activeStorageKey, setActiveStorageKey] = React.useState(STORAGE_KEY);
  const [hydrationVersion, setHydrationVersion] = React.useState(0);

  useEffect(() => {
    let active = true;
    let requestVersion = 0;
    const hydrate = async session => {
      const version = ++requestVersion;
      const storageKey = storageKeyFor(session);
      const fallback = readState(storageKey, session ? STORAGE_KEY : '');
      setRemoteReady(false);
      setActiveStorageKey(storageKey);
      try {
        const payload = await api('/api/preferences');
        if (!active || version !== requestVersion) return;
        const next = payload?.preferences ? mergeState(payload.preferences) : fallback;
        dispatch({ type: 'REPLACE_STATE', value: next });
        saveLocalState(storageKey, next);
      } catch {
        if (!active || version !== requestVersion) return;
        dispatch({ type: 'REPLACE_STATE', value: fallback });
      } finally {
        if (active && version === requestVersion) {
          setHydrationVersion(current => current + 1);
          setRemoteReady(true);
        }
      }
    };

    if (!supabase) {
      hydrate(null);
      return () => { active = false; };
    }
    supabase.auth.getSession().then(({ data }) => hydrate(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { hydrate(session); });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    Object.entries(cssVariables(state)).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    // 自定义色卡：themeId === 'custom' 时用用户自定义颜色覆盖主题变量
    if (state.theme.themeId === 'custom' && state.theme.customColors) {
      const c = state.theme.customColors;
      const overrides = {
        '--surface-canvas': c.canvas, '--surface-panel': c.panel, '--surface-elevated': c.elevated,
        '--text-strong': c.textStrong, '--text-body': c.textBody, '--text-muted': c.textMuted,
        '--border-default': c.border, '--action-primary': c.action, '--action-primary-hover': c.actionHover, '--on-action': c.onAction
      };
      Object.entries(overrides).forEach(([key, value]) => { if (value) document.documentElement.style.setProperty(key, value); });
    }
    document.documentElement.dataset.theme = state.theme.themeId;
    document.documentElement.dataset.locale = state.language.locale;
    document.documentElement.dataset.contrast = state.accessibility.highContrast ? 'high' : 'normal';
    document.documentElement.dataset.largeText = state.accessibility.largeText ? 'true' : 'false';
    const reduceMotion = state.motion.reducedMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.dataset.reducedMotion = reduceMotion ? 'true' : 'false';
    document.documentElement.dataset.animation = state.motion.enabled && state.background.animationEnabled ? 'enabled' : 'disabled';
    saveLocalState(activeStorageKey, state);
  }, [state, activeStorageKey, hydrationVersion]);

  useEffect(() => {
    if (!remoteReady) return undefined;
    const timer = window.setTimeout(() => {
      api('/api/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: state }) }).catch(() => { /* Local cache remains available offline. */ });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [state, remoteReady]);
  const value = useMemo(() => ({
    state,
    setSetting: (slice, key, value) => dispatch({ type: 'SET_SETTING', slice, key, value }),
    resetSlice: slice => dispatch({ type: 'RESET_SLICE', slice }),
    resetAll: () => dispatch({ type: 'RESET_ALL' }),
    defaults
  }), [state]);
  return <WorkspacePreferencesContext.Provider value={value}>{children}</WorkspacePreferencesContext.Provider>;
}

export const useWorkspacePreferences = () => {
  const value = useContext(WorkspacePreferencesContext);
  if (!value) throw new Error('useWorkspacePreferences must be used inside WorkspacePreferencesProvider');
  return value;
};
