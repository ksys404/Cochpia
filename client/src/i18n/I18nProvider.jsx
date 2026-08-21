import React, { createContext, useContext, useMemo } from 'react';
import { useWorkspacePreferences } from '../workspace/WorkspacePreferencesProvider';

const messages = {
  'zh-CN': { settings: '设置', language: '语言', time: '时间', locale: '界面语言', followSystem: '跟随系统', chinese: '简体中文', english: 'English', clockFormat: '时钟格式', showSeconds: '显示秒数', showDate: '显示日期', timezone: '时区', systemTimezone: '系统时区', customTimezone: '自定义时区', twentyFourHour: '24 小时制', twelveHour: '12 小时制', reset: '重置', resetAll: '全部重置', workspaceControl: '工作区控制' },
  en: { settings: 'Settings', language: 'Language', time: 'Time', locale: 'Interface language', followSystem: 'Follow system', chinese: '简体中文', english: 'English', clockFormat: 'Clock format', showSeconds: 'Show seconds', showDate: 'Show date', timezone: 'Timezone', systemTimezone: 'System timezone', customTimezone: 'Custom timezone', twentyFourHour: '24-hour', twelveHour: '12-hour', reset: 'Reset', resetAll: 'Reset all', workspaceControl: 'Workspace control' }
};

const localeKey = locale => locale === 'en' || locale?.startsWith('en-') ? 'en' : 'zh-CN';

export function I18nProvider({ children }) {
  const { state } = useWorkspacePreferences();
  const locale = state.language.locale === 'system' ? (navigator.language || state.language.fallbackLocale || 'zh-CN') : (state.language.locale || 'zh-CN');
  const language = localeKey(locale);
  const value = useMemo(() => ({ locale, language, t: key => messages[language][key] || messages['zh-CN'][key] || key, messages: messages[language] }), [language, locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

const I18nContext = createContext(null);
export const useI18n = () => {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
};
