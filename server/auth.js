import { createRemoteJWKSet, jwtVerify } from 'jose';

const mode = String(process.env.AUTH_MODE || 'off').toLowerCase();
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const jwks = supabaseUrl ? createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`)) : null;

export async function authenticateRequest(req) {
  if (mode === 'off') return { id: 'local-user', email: null, local: true };
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw Object.assign(new Error('Authentication is required'), { code: 'AUTH_REQUIRED', status: 401 });
  if (!supabaseUrl) throw Object.assign(new Error('SUPABASE_URL is required when AUTH_MODE=required'), { code: 'AUTH_CONFIGURATION_INVALID', status: 503 });
  try {
    const key = process.env.SUPABASE_JWT_SECRET ? new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET) : jwks;
    const { payload } = await jwtVerify(token, key, { issuer: `${supabaseUrl}/auth/v1`, audience: 'authenticated' });
    if (!payload.sub) throw new Error('Token subject is missing');
    return { id: payload.sub, email: payload.email || null, local: false };
  } catch (error) {
    throw Object.assign(new Error('Invalid or expired access token', { cause: error }), { code: 'AUTH_INVALID', status: 401 });
  }
}

export function authRequired() { return mode === 'required'; }
export function authMode() { return mode; }

export function validateAuthStorage(storageProvider) {
  if (mode !== 'required') return;
  if (String(storageProvider).toLowerCase() !== 'postgres') {
    throw Object.assign(
      new Error('STORAGE_PROVIDER=postgres is required when AUTH_MODE=required'),
      { code: 'AUTH_STORAGE_CONFIGURATION_INVALID', status: 503 }
    );
  }
}
