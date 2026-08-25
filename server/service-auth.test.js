import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceAuthHeaders, createNonceReplayGuard, validateServiceAuthConfig, verifyServiceAuth } from './service-auth.js';

const base = {
  token: 'service-secret-for-tests',
  method: 'POST',
  path: '/v1/memories',
  audience: 'memory-test',
  issuer: 'api-test',
  tenantId: 'tenant-a',
  userId: 'user-a',
  agentId: 'cochpia',
  actorType: 'user',
  timestamp: 1_700_000_000_000,
  nonce: 'nonce-a'
};

test('signed service auth binds identity, route, audience, and issuer', async () => {
  const headers = buildServiceAuthHeaders(base);
  const verified = await verifyServiceAuth({
    headers,
    method: base.method,
    path: base.path,
    expectedToken: base.token,
    mode: 'signed',
    audience: base.audience,
    issuer: base.issuer,
    now: base.timestamp,
    consumeNonce: async () => true
  });
  assert.equal(verified.signed, true);
  assert.deepEqual(verified.context, { tenantId: 'tenant-a', subjectUserId: 'user-a', callerAgentId: 'cochpia', actorType: 'user', actorId: 'user-a' });

  const tampered = { ...headers, 'x-memory-user-id': 'user-b' };
  await assert.rejects(
    () => verifyServiceAuth({ headers: tampered, method: base.method, path: base.path, expectedToken: base.token, mode: 'signed', audience: base.audience, issuer: base.issuer, now: base.timestamp, consumeNonce: async () => true }),
    error => error.code === 'SERVICE_AUTH_SIGNATURE_INVALID'
  );
  await assert.rejects(
    () => verifyServiceAuth({ headers, method: 'GET', path: base.path, expectedToken: base.token, mode: 'signed', audience: base.audience, issuer: base.issuer, now: base.timestamp, consumeNonce: async () => true }),
    error => error.code === 'SERVICE_AUTH_SIGNATURE_INVALID'
  );
});

test('signed service auth rejects expiry and replay', async () => {
  const headers = buildServiceAuthHeaders(base);
  await assert.rejects(
    () => verifyServiceAuth({ headers, method: base.method, path: base.path, expectedToken: base.token, mode: 'signed', audience: base.audience, issuer: base.issuer, now: base.timestamp + 31_000, maxSkewMs: 30_000, consumeNonce: async () => true }),
    error => error.code === 'SERVICE_AUTH_EXPIRED'
  );
  const guard = createNonceReplayGuard({ now: () => base.timestamp });
  assert.equal(await guard('nonce-a', base.timestamp + 30_000), true);
  assert.equal(await guard('nonce-a', base.timestamp + 30_000), false);
});

test('static service auth remains a development-only compatibility mode', async () => {
  const verified = await verifyServiceAuth({
    headers: { authorization: 'Bearer service-secret-for-tests' },
    expectedToken: 'service-secret-for-tests',
    mode: 'static'
  });
  assert.equal(verified.authenticated, true);
  assert.equal(verified.signed, false);
  assert.throws(
    () => validateServiceAuthConfig({ nodeEnv: 'production', token: 'secret', mode: 'static' }),
    error => error.code === 'SERVICE_AUTH_SIGNED_REQUIRED'
  );
  assert.throws(
    () => validateServiceAuthConfig({ nodeEnv: 'production', token: '', mode: 'signed' }),
    error => error.code === 'SERVICE_AUTH_TOKEN_REQUIRED'
  );
});
