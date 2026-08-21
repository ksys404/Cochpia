import { useWorkspacePreferences } from './WorkspacePreferencesProvider';

// 预设色卡：每张卡展示主题的 3 个代表色（背景/主色/文字）
const PRESETS = [
  { id: 'sakura', name: '樱花', colors: ['#FBF1F4', '#B24A6E', '#4A2433'] },
  { id: 'ember', name: '余烬', colors: ['#FBF3E7', '#A2642A', '#4A2E16'] },
  { id: 'moss', name: '苔藓', colors: ['#EEF5EF', '#4A7A5D', '#274334'] },
  { id: 'ink', name: '墨', colors: ['#F2F1F6', '#4E4A66', '#343047'] },
  { id: 'va11', name: '赛博', colors: ['#160A22', '#FF6FAE', '#CBB9E2'] },
  { id: 'night', name: '夜间', colors: ['#0A0F16', '#7FB8D6', '#EFF4F8'] }
];

const CUSTOM_SLOTS = [
  { key: 'canvas', label: '背景底' },
  { key: 'panel', label: '面板' },
  { key: 'elevated', label: '卡片' },
  { key: 'textStrong', label: '标题字' },
  { key: 'textBody', label: '正文字' },
  { key: 'textMuted', label: '弱文字' },
  { key: 'border', label: '边框' },
  { key: 'action', label: '主色' },
  { key: 'actionHover', label: '主色悬停' },
  { key: 'onAction', label: '按钮文字' }
];

export function ColorCardPicker() {
  const { state, setSetting } = useWorkspacePreferences();
  const theme = state.theme || {};
  const isCustom = theme.themeId === 'custom';
  const setCustomColor = (key, value) => setSetting('theme', 'customColors', { ...(theme.customColors || {}), [key]: value });

  return (
    <div className="color-card-picker">
      <div className="color-card-grid">
        {PRESETS.map(preset => (
          <button key={preset.id} type="button" className={`color-card ${theme.themeId === preset.id ? 'active' : ''}`} onClick={() => setSetting('theme', 'themeId', preset.id)}>
            <span className="color-card-swatches">{preset.colors.map((color, i) => <i key={i} style={{ background: color }} />)}</span>
            <em>{preset.name}</em>
          </button>
        ))}
        <button type="button" className={`color-card ${isCustom ? 'active' : ''}`} onClick={() => setSetting('theme', 'themeId', 'custom')}>
          <span className="color-card-swatches custom"><i>＋</i></span>
          <em>自定义</em>
        </button>
      </div>

      {isCustom && (
        <div className="color-card-custom">
          <p className="color-card-tip">自定义色卡：点击色块调整配色，实时生效</p>
          {CUSTOM_SLOTS.map(slot => (
            <label key={slot.key} className="color-slot">
              <span>{slot.label}</span>
              <input type="color" value={theme.customColors?.[slot.key] || '#000000'} onChange={event => setCustomColor(slot.key, event.target.value)} />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
