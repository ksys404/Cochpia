import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrigin, parseClientOrigins, validateProductionCors } from './cors-policy.js';

test('client origins are normalized and deduplicated', () => {
  assert.deepEqual(
    parseClientOrigins(' https://app.example.com/,https://app.example.com, https://admin.example.com '),
    ['https://app.example.com', 'https://admin.example.com']
  );
});

test('production CORS requires explicit HTTPS origins', () => {
  assert.throws(
    () => validateProductionCors({ nodeEnv: 'production', clientOrigin: '' }),
    error => error.code === 'CORS_ORIGIN_REQUIRED'
  );
  assert.throws(
    () => validateProductionCors({ nodeEnv: 'production', clientOrigin: 'http://app.example.com' }),
    error => error.code === 'CORS_HTTPS_REQUIRED'
  );
  assert.deepEqual(
    validateProductionCors({ nodeEnv: 'production', clientOrigin: 'https://app.example.com,https://admin.example.com' }),
    ['https://app.example.com', 'https://admin.example.com']
  );
});

test('CORS configuration rejects wildcard and non-origin values', () => {
  assert.throws(() => normalizeOrigin('*'), error => error.code === 'CORS_WILDCARD_FORBIDDEN');
  assert.throws(() => normalizeOrigin('https://app.example.com/path'), error => error.code === 'CORS_ORIGIN_INVALID');
  assert.throws(() => normalizeOrigin('https://user:pass@app.example.com'), error => error.code === 'CORS_ORIGIN_INVALID');
});

test('development can use local HTTP origins', () => {
  assert.deepEqual(
    validateProductionCors({ nodeEnv: 'development', clientOrigin: 'http://localhost:5173' }),
    ['http://localhost:5173']
  );
});
