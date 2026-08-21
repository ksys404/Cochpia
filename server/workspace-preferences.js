const sliceKeys = {
  theme: ['themeId', 'accentColor', 'transitionEnabled', 'customColors'],
  background: ['mode', 'color', 'imageUrl', 'gradient', 'blur', 'brightness', 'saturation', 'opacity', 'overlayOpacity', 'animationEnabled'],
  typography: ['fontFamily', 'fontScale', 'fontWeight', 'letterSpacing', 'lineHeight'],
  motion: ['enabled', 'reducedMotion', 'animationLevel', 'intensity', 'durationScale'],
  sound: ['musicVolume', 'uiVolume', 'aiVoiceVolume', 'muted', 'uiSoundEnabled', 'musicEnabled', 'musicReactiveEnabled'],
  time: ['clockFormat', 'showSeconds', 'showDate', 'timezoneMode', 'timezone', 'ambientModeEnabled'],
  language: ['locale', 'fallbackLocale'],
  accessibility: ['highContrast', 'largeText', 'keyboardMode', 'focusVisible'],
  workspace: ['layoutMode', 'snapEnabled', 'autoArrangeEnabled', 'dockVisible'],
  appearance: ['cornerRadius', 'panelOpacity']
};

const stringLimits = {
  imageUrl: 500000,
  gradient: 1200,
  timezone: 128,
  default: 128
};

export const MAX_PREFERENCES_BYTES = 600000;

const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);

function sanitizeValue(key, value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value === null && key === 'timezone') return null;
  if (typeof value === 'string') return value.slice(0, stringLimits[key] || stringLimits.default);
  return undefined;
}

export function sanitizeWorkspacePreferences(input) {
  if (!isRecord(input)) throw new Error('Preferences must be an object');
  if (JSON.stringify(input).length > MAX_PREFERENCES_BYTES) throw new Error('Preferences are too large');

  const result = {};
  for (const [slice, keys] of Object.entries(sliceKeys)) {
    if (!isRecord(input[slice])) continue;
    const next = {};
    for (const key of keys) {
      const value = input[slice][key];
      if (key === 'customColors') {
        if (!isRecord(value)) continue;
        const colors = {};
        for (const colorKey of ['canvas', 'panel', 'elevated', 'textStrong', 'textBody', 'textMuted', 'border', 'action', 'actionHover', 'onAction']) {
          if (typeof value[colorKey] === 'string') colors[colorKey] = value[colorKey].slice(0, 32);
        }
        if (Object.keys(colors).length) next[key] = colors;
        continue;
      }
      const sanitized = sanitizeValue(key, value);
      if (sanitized !== undefined) next[key] = sanitized;
    }
    if (Object.keys(next).length) result[slice] = next;
  }
  return result;
}
