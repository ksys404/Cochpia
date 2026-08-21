import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;
export const apiBase = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

// 统一 API 请求：附带 Supabase 会话 token，统一错误结构。
export async function api(url, options = {}) {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const headers = new Headers(options.headers || {});
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  const response = await fetch(`${apiBase}${url}`, { ...options, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error || 'Request failed');
    error.code = payload?.error?.code || 'REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return payload;
}
