import { useRef } from 'react';
import { fileToDataUrl } from './image';

// 通用头像选择器：预设符号/emoji + 自定义字符 + 上传图片。用于主角色与所有 Agent。
const PRESETS = ['✦', '✿', '◈', '☾', '♪', '⚘', '☁', '☆', '♥', '◆', '☀', '❋', '✧', '☂', '❄', '✎', '❀', '⚜', '🌙', '🐚'];

export default function AvatarPicker({ value = '✦', onChange, imageUrl, onImageUpload }) {
  const current = String(value || '✦');
  const fileRef = useRef(null);

  const handleFile = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file, 256, 0.85);
      onImageUpload?.(dataUrl);
    } catch { /* 忽略无效图片 */ }
    event.target.value = '';
  };

  return (
    <div className="avatar-picker">
      {imageUrl && (
        <div className="avatar-picker-preview">
          <img src={imageUrl} alt="当前头像" />
          <button type="button" className="text-button muted-button" onClick={() => onImageUpload?.(null)}>移除图片</button>
        </div>
      )}
      <div className="avatar-picker-presets" role="listbox" aria-label="选择头像">
        {PRESETS.map(avatar => (
          <button
            key={avatar}
            type="button"
            role="option"
            aria-selected={current === avatar}
            className={`avatar-option ${current === avatar && !imageUrl ? 'active' : ''}`}
            onClick={() => onChange(avatar)}
            title={`选择 ${avatar}`}
          >{avatar}</button>
        ))}
      </div>
      <input
        className="avatar-picker-input"
        value={current}
        onChange={event => onChange(event.target.value.slice(0, 4))}
        placeholder="或输入自定义字符 / emoji"
        aria-label="自定义头像"
      />
      <div className="avatar-picker-actions">
        <button type="button" className="avatar-upload" onClick={() => fileRef.current?.click()}>上传图片作为头像</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
      </div>
    </div>
  );
}
