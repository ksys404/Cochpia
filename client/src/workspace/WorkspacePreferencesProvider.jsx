import React, { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import { getTypographyFont } from './typographyRegistry';

const STORAGE_KEY = 'cochpia.workspace-preferences.v1';

const defaults = {
  theme: { themeId: 'sakura', accentColor: '#C9698B', transitionEnabled: true },
  background: { mode: 'color', color: '#fff6fa', imageUrl: '', gradient: 'radial-gradient(circle at 20% 10%, rgba(201,105,139,.12), transparent 38%)', blur: 0, brightness: 1, saturation: 1, opacity: 1, overlayOpacity: 0, animationEnabled: false },
  typography: { fontFamily: 'system', fontScale: 1, fontWeight: 400, letterSpacing: 0, lineHeight: 1.55 },
  motion: { enabled: false, reducedMotion: true, animationLevel: 'low', intensity: 0, durationScale: 1 },
  sound: { musicVolume: 0.2, uiVolume: 0.08, aiVoiceVolume: 0.2, muted: false, uiSoundEnabled: false, musicEnabled: false, musicReactiveEnabled: false },
  time: { clockFormat: '24h', showSeconds: false, showDate: true, timezoneMode: 'system', timezone: null, ambientModeEnabled: true },
  language: { locale: 'zh-CN', fallbackLocale: 'zh-CN' },
  accessibility: { highContrast: false, largeText: false, keyboardMode: false, focusVisible: true },
  workspace: { layoutMode: 'freeform', snapEnabled: true, autoArrangeEnabled: false, dockVisible: true }
};

const mergeState = value => Object.keys(defaults).reduce((result, key) => {
  result[key] = { ...defaults[key], ...(value?.[key] || {}) };
  return result;
}, {});

const readState = () => {
  try { return mergeState(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')); } catch { return mergeState(); }
};

const reducer = (state, action) => {
  if (action.type === 'RESET_ALL') return mergeState();
  if (action.type === 'RESET_SLICE') return { ...state, [action.slice]: { ...defaults[action.slice] } };
  if (action.type === 'SET_SETTING') {
    let value = action.value;
    if (action.slice === 'background' && action.key === 'imageUrl') value = String(value || '').slice(0, 2048);
    if (action.slice === 'background' && action.key === 'gradient') value = String(value || '').slice(0, 1200);
    return { ...state, [action.slice]: { ...state[action.slice], [action.key]: value } };
  }
  return state;
};

const cssVariables = state => ({
  '--workspace-accent': state.theme.accentColor,
  '--workspace-background': state.theme.themeId === 'pearl' ? '#f5f0ed' : state.theme.themeId === 'blush' ? '#f4e4e8' : state.theme.themeId === 'mist' ? '#e7eef3' : state.theme.themeId === 'night' ? '#070b12' : state.theme.themeId === 'sakura' ? '#fff6fa' : state.theme.themeId === 'ember' ? '#fdf6ec' : state.theme.themeId === 'moss' ? '#f2f8f4' : state.theme.themeId === 'ink' ? '#f4f3f8' : state.background.color,
  '--workspace-background-image': state.background.imageUrl ? `url(${state.background.imageUrl})` : 'none',
  '--workspace-background-gradient': state.background.gradient || 'none',
  '--workspace-background-opacity': state.background.opacity,
  '--workspace-background-blur': `${state.background.blur}px`,
  '--workspace-background-brightness': state.background.brightness,
  '--workspace-background-saturation': state.background.saturation,
  '--workspace-surface-contrast': ['blush', 'pearl', 'mist'].includes(state.theme.themeId) ? 'rgba(255,255,255,.72)' : 'rgba(7,18,28,.42)',
  '--workspace-surface-border': ['blush', 'pearl', 'mist'].includes(state.theme.themeId) ? 'rgba(35,52,67,.22)' : 'rgba(255,255,255,.18)',
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
  '--workspace-ambient-duration': state.motion.animationLevel === 'low' ? '30s' : state.motion.animationLevel === 'high' ? '12s' : '21s',
  '--workspace-motion-duration': state.motion.reducedMotion || !state.motion.enabled ? '0ms' : `${state.motion.durationScale * 420}ms`
});

const WorkspacePreferencesContext = createContext(null);

export function WorkspacePreferencesProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, readState);
  useEffect(() => {
    Object.entries(cssVariables(state)).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    document.documentElement.dataset.theme = state.theme.themeId;
    document.documentElement.dataset.locale = state.language.locale;
    document.documentElement.dataset.contrast = state.accessibility.highContrast ? 'high' : 'normal';
    document.documentElement.dataset.largeText = state.accessibility.largeText ? 'true' : 'false';
    const reduceMotion = state.motion.reducedMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.dataset.reducedMotion = reduceMotion ? 'true' : 'false';
    document.documentElement.dataset.animation = state.motion.enabled && state.background.animationEnabled ? 'enabled' : 'disabled';
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Storage is optional. */ }
  }, [state]);
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
