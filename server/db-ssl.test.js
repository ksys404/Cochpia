import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDbSsl, validateProductionDbTls } from './db-ssl.js';

test('db ssl defaults to no SSL when DATABASE_SSL is unset', () => {
  const original = process.env.DATABASE_SSL;
  delete process.env.DATABASE_SSL;
  try { assert.equal(resolveDbSsl(), undefined); }
  finally { if (original === undefined) delete process.env.DATABASE_SSL; else process.env.DATABASE_SSL = original; }
});

test('db ssl verifies certificates when DATABASE_SSL=true', () => {
  const original = process.env.DATABASE_SSL;
  process.env.DATABASE_SSL = 'true';
  try { assert.deepEqual(resolveDbSsl(), { rejectUnauthorized: true }); }
  finally { if (original === undefined) delete process.env.DATABASE_SSL; else process.env.DATABASE_SSL = original; }
});

test('db ssl allows an explicit no-verify opt-in', () => {
  const original = process.env.DATABASE_SSL;
  process.env.DATABASE_SSL = 'no-verify';
  try { assert.deepEqual(resolveDbSsl(), { rejectUnauthorized: false }); }
  finally { if (original === undefined) delete process.env.DATABASE_SSL; else process.env.DATABASE_SSL = original; }
});

test('production PostgreSQL rejects missing or no-verify TLS configuration', () => {
  assert.throws(
    () => validateProductionDbTls({ nodeEnv: 'production', storageProvider: 'postgres', databaseSsl: '' }),
    error => error.code === 'DATABASE_TLS_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => validateProductionDbTls({ nodeEnv: 'production', storageProvider: 'postgres', databaseSsl: 'no-verify' }),
    error => error.code === 'DATABASE_TLS_CONFIGURATION_INVALID'
  );
});

test('production PostgreSQL accepts certificate-verifying TLS modes', () => {
  for (const databaseSsl of ['true', 'require', 'verify-full']) {
    assert.doesNotThrow(() => validateProductionDbTls({ nodeEnv: 'production', storageProvider: 'postgres', databaseSsl }));
  }
  assert.doesNotThrow(() => validateProductionDbTls({ nodeEnv: 'development', storageProvider: 'postgres', databaseSsl: '' }));
});
