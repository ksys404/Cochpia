import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthStorage, validateProductionAuth } from './auth.js';

test('required auth rejects shared JSON storage', { skip: process.env.AUTH_MODE !== 'required' && 'requires AUTH_MODE=required' }, () => {
  assert.throws(() => validateAuthStorage('json'), /STORAGE_PROVIDER=postgres/);
});

test('required auth accepts PostgreSQL storage', { skip: process.env.AUTH_MODE !== 'required' && 'requires AUTH_MODE=required' }, () => {
  assert.doesNotThrow(() => validateAuthStorage('postgres'));
});

test('production auth rejects auth-off and accepts required auth', () => {
  assert.throws(
    () => validateProductionAuth({ nodeEnv: 'production', mode: 'off' }),
    error => error.code === 'AUTH_PRODUCTION_CONFIGURATION_INVALID'
  );
  assert.doesNotThrow(() => validateProductionAuth({ nodeEnv: 'production', mode: 'required' }));
  assert.doesNotThrow(() => validateProductionAuth({ nodeEnv: 'development', mode: 'off' }));
});
