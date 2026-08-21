import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api';

// 默认：无年龄、无性别，只保留名字与头像
const DEFAULT_PROFILE = { name: 'Cochpia', gender: 'none', age: null, avatar: '✦' };

const ProfileContext = createContext(null);

export function ProfileProvider({ children }) {
  const [profile, setProfile] = useState(DEFAULT_PROFILE);

  // 挂载时从服务端加载档案（跨设备同步）
  useEffect(() => {
    let active = true;
    api('/api/profile')
      .then(loaded => { if (active && loaded && typeof loaded === 'object') setProfile({ ...DEFAULT_PROFILE, ...loaded }); })
      .catch(() => { /* 加载失败则保持默认 */ });
    return () => { active = false; };
  }, []);

  const persist = patch => {
    api('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    })
      .then(saved => { if (saved && typeof saved === 'object') setProfile({ ...DEFAULT_PROFILE, ...saved }); })
      .catch(() => { /* 保存失败保持本地乐观值 */ });
  };

  const value = {
    profile,
    setField: (field, value) => { setProfile(current => ({ ...current, [field]: value })); persist({ [field]: value }); },
    setAge: age => { setProfile(current => ({ ...current, age })); persist({ age }); },
    reset: () => { setProfile(DEFAULT_PROFILE); persist({ ...DEFAULT_PROFILE, age: null }); }
  };

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export const useProfile = () => {
  const value = useContext(ProfileContext);
  if (!value) throw new Error('useProfile must be used inside ProfileProvider');
  return value;
};
