import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUploadStore, ensureUploadOwnerKey, MAX_UPLOAD_RECORDS } from './upload-store.js';

const dataUrl = content => `data:text/plain;base64,${Buffer.from(content).toString('base64')}`;

test('upload store keeps files owner-scoped and exports their payloads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cochpia-upload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createUploadStore({ rootDir: root, now: () => new Date('2026-08-24T00:00:00.000Z') });
  const record = await store.save({ userId: 'user-a', name: '../notes.txt', dataUrl: dataUrl('hello') });
  assert.equal(record.ownerId, 'user-a');
  assert.match(record.path, /^uploads\//);
  const exported = await store.exportRecords({ userId: 'user-a', records: [record] });
  assert.equal(exported[0].dataUrl, dataUrl('hello'));
  assert.deepEqual(await store.exportRecords({ userId: 'user-b', records: [record] }), []);
  const imported = await store.importRecords({ userId: 'user-b', records: exported });
  assert.equal(imported[0].ownerId, 'user-b');
  assert.equal((await store.exportRecords({ userId: 'user-b', records: imported }))[0].dataUrl, dataUrl('hello'));
});

test('upload deletion can be rolled back or committed without crossing owners', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cochpia-upload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createUploadStore({ rootDir: root });
  const record = await store.save({ userId: 'user-a', name: 'notes.txt', dataUrl: dataUrl('hello') });
  const token = await store.stageUserDeletion('user-a', 'delete-1');
  assert.equal(token.existed, true);
  await assert.rejects(() => store.exportRecords({ userId: 'user-a', records: [record] }), error => error.code === 'UPLOAD_EXPORT_FILE_MISSING');
  await store.rollbackUserDeletion(token);
  assert.equal((await store.exportRecords({ userId: 'user-a', records: [record] }))[0].dataUrl, dataUrl('hello'));

  const committed = await store.stageUserDeletion('user-a', 'delete-2');
  await store.commitUserDeletion(committed);
  await assert.rejects(() => store.exportRecords({ userId: 'user-a', records: [record] }), error => error.code === 'UPLOAD_EXPORT_FILE_MISSING');
});

test('upload owner keys are opaque, stable, and distinct per state', () => {
  const first = {};
  const second = {};
  const firstKey = ensureUploadOwnerKey(first);
  const secondKey = ensureUploadOwnerKey(second);
  assert.match(firstKey, /^[A-Za-z0-9_-]{20,100}$/);
  assert.notEqual(firstKey, secondKey);
  assert.equal(ensureUploadOwnerKey(first), firstKey);
});

test('upload store applies a bounded per-account file count before writing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cochpia-upload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createUploadStore({ rootDir: root });
  const existing = Array.from({ length: MAX_UPLOAD_RECORDS }, (_, index) => ({ ownerId: 'user-a', size: 1, id: `existing-${index}` }));
  await assert.rejects(
    () => store.save({ userId: 'user-a', name: 'too-many.txt', dataUrl: dataUrl('hello'), existingRecords: existing }),
    error => error.code === 'UPLOAD_QUOTA_COUNT_EXCEEDED' && error.status === 413
  );
});
