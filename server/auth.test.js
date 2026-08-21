import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthStorage } from './auth.js';

test('required auth rejects shared JSON storage', { skip: process.env.AUTH_MODE !== 'required' && 'requires AUTH_MODE=required' }, () => {
  assert.throws(() => validateAuthStorage('json'), /STORAGE_PROVIDER=postgres/);
});

test('required auth accepts PostgreSQL storage', { skip: process.env.AUTH_MODE !== 'required' && 'requires AUTH_MODE=required' }, () => {
  assert.doesNotThrow(() => validateAuthStorage('postgres'));
});
