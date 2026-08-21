import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDbSsl } from './db-ssl.js';

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
