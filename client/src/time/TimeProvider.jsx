import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useWorkspacePreferences } from '../workspace/WorkspacePreferencesProvider';

const TimeContext = createContext(null);

const resolveTimeZone = time => {
  if (time.timezoneMode !== 'custom' || !time.timezone) return undefined;
  try { new Intl.DateTimeFormat('en', { timeZone: time.timezone }).format(); return time.timezone; } catch { return undefined; }
};
const resolveLocale = locale => locale === 'system' ? (navigator.language || 'zh-CN') : (locale || 'zh-CN');
const safeDateParts = (date, time, locale) => {
  const options = { hour: '2-digit', minute: '2-digit', hour12: time.clockFormat === '12h', timeZone: resolveTimeZone(time) };
  if (time.showSeconds) options.second = '2-digit';
  return new Intl.DateTimeFormat(locale, options).format(date);
};

export function TimeProvider({ children }) {
  const { state } = useWorkspacePreferences();
  const [now, setNow] = useState(() => new Date());
  const intervalMs = state.time.showSeconds ? 1000 : 30000;
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), intervalMs); return () => window.clearInterval(timer); }, [intervalMs]);
  const value = useMemo(() => ({ now, time: state.time, formatTime: (date = now, locale = state.language.locale) => safeDateParts(new Date(date), state.time, resolveLocale(locale)), formatDate: (date = now, locale = state.language.locale) => new Intl.DateTimeFormat(resolveLocale(locale), { dateStyle: 'medium', timeZone: resolveTimeZone(state.time) }).format(new Date(date)), formatDateTime: (date = now, locale = state.language.locale) => new Intl.DateTimeFormat(resolveLocale(locale), { dateStyle: 'medium', timeStyle: state.time.showSeconds ? 'medium' : 'short', timeZone: resolveTimeZone(state.time) }).format(new Date(date)) }), [now, state.language.locale, state.time]);
  return <TimeContext.Provider value={value}>{children}</TimeContext.Provider>;
}

export const useTime = () => {
  const value = useContext(TimeContext);
  if (!value) throw new Error('useTime must be used inside TimeProvider');
  return value;
};
