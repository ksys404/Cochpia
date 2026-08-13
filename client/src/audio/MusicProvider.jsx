import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const MusicContext = createContext(null);
const apiBase = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

const request = async (path, options) => {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const headers = new Headers({ 'Content-Type': 'application/json', ...(options?.headers || {}) });
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  const response = await fetch(`${apiBase}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) { const error = new Error(payload?.error?.message || 'Music service request failed'); error.code = payload?.error?.code || 'MUSIC_REQUEST_FAILED'; throw error; }
  return payload;
};

export function MusicProvider({ children }) {
  const [state, setState] = useState({ source: 'none', service: 'unknown', state: 'stopped', track: null, queue: [], error: null });
  const [searchResults, setSearchResults] = useState([]);

  const refreshStatus = useCallback(async () => {
    try { const status = await request('/api/music/status'); setState(current => ({ ...current, ...status, error: null })); return status; }
    catch (error) { setState(current => ({ ...current, error: { code: error.code, message: error.message } })); return null; }
  }, []);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const search = useCallback(async query => { const result = await request(`/api/music/search?q=${encodeURIComponent(query)}`); setSearchResults(result.items || []); return result.items || []; }, []);
  const checkEnvironment = useCallback(() => request('/api/music/environment'), []);
  const command = useCallback(async (method, body) => { const result = await request(`/api/music/${method}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }); setState(current => ({ ...current, ...result, error: null })); return result; }, []);
  const value = useMemo(() => ({ state, searchResults, search, refreshStatus, checkEnvironment, play: track => command('play', { track }), pause: () => command('pause'), resume: () => command('resume'), next: () => command('next'), stop: () => command('stop'), getListeningContext: () => request('/api/music/context') }), [checkEnvironment, command, refreshStatus, search, searchResults, state]);
  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
}

export const useMusic = () => {
  const value = useContext(MusicContext);
  if (!value) throw new Error('useMusic must be used inside MusicProvider');
  return value;
};
