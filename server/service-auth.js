import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const SERVICE_AUTH_VERSION = 'v1';
export const DEFAULT_SERVICE_AUTH_AUDIENCE = 'cochpia-memory-module';
export const DEFAULT_SERVICE_AUTH_ISSUER = 'cochpia-api';
export const DEFAULT_SERVICE_AUTH_MAX_SKEW_MS = 30_000;

export class ServiceAuthError extends Error {
  constructor(code, message, { status = 401 } = {}) {
    super(message);
    this.name = 'ServiceAuthError';
    this.code = code;
    this.status = status;
  }
}

function readHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
  const target = String(name).toLowerCase();
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === target);
  return String(key ? headers[key] || '' : '').trim();
}

function normalizedMode(mode) {
  const value = String(mode || 'static').trim().toLowerCase();
  if (!['disabled', 'static', 'signed'].includes(value)) {
    throw new ServiceAuthError('SERVICE_AUTH_MODE_INVALID', `Unsupported service auth mode: ${value}`, { status: 503 });
  }
  return value;
}

function normalizedText(value, field, { status = 503 } = {}) {
  const result = String(value ?? '').trim();
  if (!result || result.includes('\n') || result.includes('\r')) throw new ServiceAuthError(`SERVICE_AUTH_${field.toUpperCase()}_INVALID`, `${field} is required and must be a single line`, { status });
  return result;
}

function normalizedTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new ServiceAuthError('SERVICE_AUTH_TIMESTAMP_INVALID', 'Service auth timestamp is invalid');
  return timestamp;
}

function normalizedMaxSkew(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1_000 && number <= 300_000 ? number : DEFAULT_SERVICE_AUTH_MAX_SKEW_MS;
}

function signingString({ method, path, audience, issuer, timestamp, nonce, tenantId, subjectUserId, callerAgentId, actorType }) {
  return [
    SERVICE_AUTH_VERSION,
    String(method || 'GET').toUpperCase(),
    String(path || '/'),
    audience,
    issuer,
    String(timestamp),
    nonce,
    tenantId,
    subjectUserId,
    callerAgentId,
    actorType
  ].join('\n');
}

function signatureFor(token, input) {
  return createHmac('sha256', String(token)).update(signingString(input), 'utf8').digest('base64url');
}

function tokensEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function buildServiceAuthHeaders({
  token,
  method = 'GET',
  path = '/',
  audience = DEFAULT_SERVICE_AUTH_AUDIENCE,
  issuer = DEFAULT_SERVICE_AUTH_ISSUER,
  tenantId,
  subjectUserId,
  userId,
  callerAgentId,
  agentId,
  actorType = 'agent',
  timestamp = Date.now(),
  nonce = randomUUID()
} = {}) {
  const serviceToken = normalizedText(token, 'token');
  const normalized = {
    method,
    path,
    audience: normalizedText(audience, 'audience'),
    issuer: normalizedText(issuer, 'issuer'),
    timestamp: normalizedTimestamp(timestamp),
    nonce: normalizedText(nonce, 'nonce'),
    tenantId: normalizedText(tenantId, 'tenant_id'),
    subjectUserId: normalizedText(subjectUserId ?? userId, 'subject_user_id'),
    callerAgentId: normalizedText(callerAgentId ?? agentId, 'caller_agent_id'),
    actorType: normalizedText(actorType, 'actor_type')
  };
  return {
    Authorization: `Bearer ${serviceToken}`,
    'x-memory-service-auth-version': SERVICE_AUTH_VERSION,
    'x-memory-service-audience': normalized.audience,
    'x-memory-service-issuer': normalized.issuer,
    'x-memory-service-timestamp': String(normalized.timestamp),
    'x-memory-service-nonce': normalized.nonce,
    'x-memory-service-signature': signatureFor(serviceToken, normalized),
    'x-memory-tenant-id': normalized.tenantId,
    'x-memory-user-id': normalized.subjectUserId,
    'x-memory-agent-id': normalized.callerAgentId,
    'x-memory-actor-type': normalized.actorType
  };
}

export function validateServiceAuthConfig({ nodeEnv = process.env.NODE_ENV, token = process.env.MEMORY_MODULE_SERVICE_TOKEN, mode = process.env.MEMORY_MODULE_SERVICE_AUTH_MODE, audience = process.env.MEMORY_MODULE_SERVICE_AUDIENCE || DEFAULT_SERVICE_AUTH_AUDIENCE, issuer = process.env.MEMORY_MODULE_SERVICE_ISSUER || DEFAULT_SERVICE_AUTH_ISSUER } = {}) {
  const environment = String(nodeEnv || '').toLowerCase();
  const selectedMode = normalizedMode(mode || (environment === 'production' ? 'signed' : 'static'));
  if (environment === 'production' && selectedMode !== 'signed') {
    throw new ServiceAuthError('SERVICE_AUTH_SIGNED_REQUIRED', 'Signed service authentication is required in production', { status: 503 });
  }
  if (selectedMode !== 'disabled' && !String(token || '').trim()) {
    if (environment === 'production' || selectedMode === 'signed') throw new ServiceAuthError('SERVICE_AUTH_TOKEN_REQUIRED', 'MEMORY_MODULE_SERVICE_TOKEN is required for service authentication', { status: 503 });
  }
  if (selectedMode === 'signed') {
    normalizedText(audience, 'audience');
    normalizedText(issuer, 'issuer');
  }
  return { mode: selectedMode, audience: String(audience), issuer: String(issuer) };
}

export function createNonceReplayGuard({ now = () => Date.now(), maxEntries = 10_000 } = {}) {
  const seen = new Map();
  return async (nonce, expiresAt = now() + DEFAULT_SERVICE_AUTH_MAX_SKEW_MS) => {
    const timestamp = Number(now());
    for (const [key, expiry] of seen) if (expiry <= timestamp) seen.delete(key);
    if (seen.has(nonce)) return false;
    if (seen.size >= Math.max(100, Number(maxEntries) || 10_000)) {
      const first = seen.keys().next().value;
      if (first) seen.delete(first);
    }
    seen.set(nonce, Number(expiresAt));
    return true;
  };
}

export async function verifyServiceAuth({
  headers,
  method = 'GET',
  path = '/',
  expectedToken = process.env.MEMORY_MODULE_SERVICE_TOKEN,
  mode = process.env.MEMORY_MODULE_SERVICE_AUTH_MODE,
  audience = process.env.MEMORY_MODULE_SERVICE_AUDIENCE || DEFAULT_SERVICE_AUTH_AUDIENCE,
  issuer = process.env.MEMORY_MODULE_SERVICE_ISSUER || DEFAULT_SERVICE_AUTH_ISSUER,
  now = Date.now(),
  maxSkewMs = process.env.MEMORY_MODULE_SERVICE_AUTH_MAX_SKEW_MS,
  consumeNonce = async () => true
} = {}) {
  const selectedMode = normalizedMode(mode || (String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'signed' : 'static'));
  if (selectedMode === 'disabled') return { authenticated: false, signed: false, context: null };
  const token = String(expectedToken || '').trim();
  if (!token) {
    if (selectedMode === 'static') return { authenticated: false, signed: false, context: null };
    throw new ServiceAuthError('SERVICE_AUTH_TOKEN_REQUIRED', 'Service authentication is not configured', { status: 503 });
  }
  const authorization = readHeader(headers, 'authorization');
  if (!authorization.startsWith('Bearer ') || !tokensEqual(authorization.slice(7).trim(), token)) {
    throw new ServiceAuthError('SERVICE_AUTH_REQUIRED', 'Valid service authentication is required');
  }
  if (selectedMode === 'static') return { authenticated: true, signed: false, context: null };

  const version = readHeader(headers, 'x-memory-service-auth-version');
  const signedAudience = readHeader(headers, 'x-memory-service-audience');
  const signedIssuer = readHeader(headers, 'x-memory-service-issuer');
  const timestamp = normalizedTimestamp(readHeader(headers, 'x-memory-service-timestamp'));
  const nonce = normalizedText(readHeader(headers, 'x-memory-service-nonce'), 'nonce', { status: 401 });
  const tenantId = normalizedText(readHeader(headers, 'x-memory-tenant-id'), 'tenant_id', { status: 401 });
  const subjectUserId = normalizedText(readHeader(headers, 'x-memory-user-id') || readHeader(headers, 'x-subject-user-id'), 'subject_user_id', { status: 401 });
  const callerAgentId = normalizedText(readHeader(headers, 'x-memory-agent-id') || readHeader(headers, 'x-caller-agent-id'), 'caller_agent_id', { status: 401 });
  const actorType = normalizedText(readHeader(headers, 'x-memory-actor-type') || 'agent', 'actor_type', { status: 401 });
  if (version !== SERVICE_AUTH_VERSION) throw new ServiceAuthError('SERVICE_AUTH_VERSION_INVALID', 'Unsupported service auth version');
  if (signedAudience !== String(audience) || signedIssuer !== String(issuer)) throw new ServiceAuthError('SERVICE_AUTH_CLAIMS_INVALID', 'Service auth audience or issuer is invalid');
  const timestampNow = Number(now);
  const skew = normalizedMaxSkew(maxSkewMs);
  if (!Number.isSafeInteger(timestampNow) || Math.abs(timestampNow - timestamp) > skew) throw new ServiceAuthError('SERVICE_AUTH_EXPIRED', 'Service authentication is expired or not yet valid');
  const expectedSignature = signatureFor(token, { method, path, audience: signedAudience, issuer: signedIssuer, timestamp, nonce, tenantId, subjectUserId, callerAgentId, actorType });
  if (!tokensEqual(readHeader(headers, 'x-memory-service-signature'), expectedSignature)) throw new ServiceAuthError('SERVICE_AUTH_SIGNATURE_INVALID', 'Service authentication signature is invalid');
  let accepted;
  try {
    accepted = await consumeNonce(nonce, timestampNow + skew);
  } catch (error) {
    throw new ServiceAuthError('SERVICE_AUTH_REPLAY_STORE_UNAVAILABLE', 'Service authentication replay store is unavailable', { status: 503, cause: error });
  }
  if (!accepted) throw new ServiceAuthError('SERVICE_AUTH_REPLAYED', 'Service authentication nonce has already been used');
  return {
    authenticated: true,
    signed: true,
    nonce,
    context: { tenantId, subjectUserId, callerAgentId, actorType, actorId: actorType === 'user' ? subjectUserId : callerAgentId }
  };
}

export { signingString };
