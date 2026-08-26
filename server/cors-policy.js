const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export class CorsConfigurationError extends Error {
  constructor(code, message, { status = 503 } = {}) {
    super(message);
    this.name = 'CorsConfigurationError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeOrigin(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw === '*') throw new CorsConfigurationError('CORS_WILDCARD_FORBIDDEN', 'Wildcard CLIENT_ORIGIN is not allowed');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CorsConfigurationError('CORS_ORIGIN_INVALID', `Invalid CLIENT_ORIGIN: ${raw}`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new CorsConfigurationError('CORS_ORIGIN_PROTOCOL_INVALID', 'CLIENT_ORIGIN must use http or https');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new CorsConfigurationError('CORS_ORIGIN_INVALID', 'CLIENT_ORIGIN must be an origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

export function parseClientOrigins(value) {
  const origins = String(value ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
  return [...new Set(origins)];
}

export function validateProductionCors({ nodeEnv = process.env.NODE_ENV, clientOrigin = process.env.CLIENT_ORIGIN } = {}) {
  const origins = parseClientOrigins(clientOrigin);
  if (String(nodeEnv || '').toLowerCase() !== 'production') return origins;
  if (!origins.length) {
    throw new CorsConfigurationError('CORS_ORIGIN_REQUIRED', 'CLIENT_ORIGIN with at least one HTTPS origin is required in production');
  }
  if (origins.some(origin => new URL(origin).protocol !== 'https:')) {
    throw new CorsConfigurationError('CORS_HTTPS_REQUIRED', 'HTTPS CLIENT_ORIGIN is required in production');
  }
  return origins;
}
