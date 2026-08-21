import { useProfile } from './ProfileProvider';
import AvatarPicker from './AvatarPicker';
import CharacterComposer from '../characters/CharacterComposer';
import { activeCharacterProvider } from '../characters/characterProvider';

const GENDERS = [
  { id: 'none', label: '无性别', note: '默认，以「它」称呼' },
  { id: 'male', label: '男', note: '以「他」称呼' },
  { id: 'female', label: '女', note: '以「她」称呼' },
  { id: 'other', label: '其他', note: '以「Ta」称呼' }
];

export default function CharacterProfile({ onClose }) {
  const { profile, setField, setAge, reset } = useProfile();

  return (
    <div className="profile-panel">
      <div className="profile-head">
        <span className="profile-avatar">{profile.avatarImage ? <img src={profile.avatarImage} alt={profile.name} /> : profile.avatar}</span>
        <div className="profile-head-main">
          <p className="eyebrow">CHARACTER PROFILE · 角色档案</p>
          <h2>{profile.name || '未命名'}</h2>
          <p>名字、性别、年龄与头像，都由你决定；不改，它便是永恒。</p>
        </div>
        {onClose && <button type="button" className="icon-button" aria-label="关闭角色档案" title="关闭角色档案" onClick={onClose}>×</button>}
      </div>

      <div className="profile-section">
        <label className="profile-label" htmlFor="profile-name">名字</label>
        <input id="profile-name" value={profile.name} onChange={event => setField('name', event.target.value.slice(0, 20))} placeholder="Cochpia" />
      </div>

      <div className="profile-section">
        <label className="profile-label">性别</label>
        <div className="profile-genders">
          {GENDERS.map(gender => (
            <button
              key={gender.id}
              type="button"
              className={`gender-option ${profile.gender === gender.id ? 'active' : ''}`}
              onClick={() => setField('gender', gender.id)}
            >
              <strong>{gender.label}</strong>
              <small>{gender.note}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="profile-section">
        <label className="profile-label">年龄</label>
        {profile.age === null ? (
          <div className="profile-age-row">
            <span className="profile-age-status">∞ 永恒（未设定）</span>
            <button type="button" className="select-model" onClick={() => setAge(0)}>设定年龄，开始计时</button>
          </div>
        ) : (
          <div className="profile-age-row">
            <input type="range" min="0" max="90" step="1" value={profile.age} onChange={event => setAge(Number(event.target.value))} aria-label="设定年龄" />
            <span className="profile-age-status"><b>{profile.age}</b> 岁</span>
            <button type="button" className="text-button muted-button" onClick={() => setAge(null)}>回到永恒</button>
          </div>
        )}
      </div>

      <div className="profile-section">
        <label className="profile-label">头像</label>
        <AvatarPicker value={profile.avatar} imageUrl={profile.avatarImage} onChange={avatar => setField('avatar', avatar)} onImageUpload={avatarImage => setField('avatarImage', avatarImage)} />
      </div>

      <div className="profile-section">
        <label className="profile-label">角色形象 · 纸娃娃</label>
        <CharacterComposer provider={activeCharacterProvider} onUseAvatar={avatarImage => setField('avatarImage', avatarImage)} onUseCharacterSheet={(characterSheet, animation) => { setField('characterSheet', characterSheet); setField('characterAnimation', animation); }} />
      </div>

      <div className="profile-foot">
        <button type="button" className="text-button muted-button" onClick={reset}>恢复默认（Cochpia · 永恒 · 无性别）</button>
      </div>
    </div>
  );
}
