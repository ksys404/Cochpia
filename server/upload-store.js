import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_RECORDS = 100;
export const MAX_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024;

const safeName = value => String(value || 'file')
  .replace(/[^\w.\-\u4e00-\u9fff]/g, '_')
  .slice(0, 100) || 'file';

const fallbackOwnerKey = userId => Buffer.from(String(userId || 'local-user'), 'utf8').toString('base64url').slice(0, 200) || 'local-user';
const normalizeStorageKey = value => String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'local-user';

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,\s]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw Object.assign(new Error('Invalid data URL'), { code: 'INVALID_UPLOAD', status: 400 });
  const mimeType = match[1].toLowerCase();
  const encoded = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length) throw Object.assign(new Error('Uploaded file is empty'), { code: 'INVALID_UPLOAD', status: 400 });
  if (buffer.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('文件过大（最大 5MB）'), { code: 'FILE_TOO_LARGE', status: 400 });
  return { mimeType, buffer };
}

export function createUploadStore({ rootDir = process.env.COCHPIA_UPLOAD_DIR || path.join(process.cwd(), 'uploads'), now = () => new Date() } = {}) {
  const root = path.resolve(rootDir);
  const deletionRoot = path.join(root, '.deletions');

  const ownerDirectory = (userId, storageKey = null) => path.join(root, normalizeStorageKey(storageKey || fallbackOwnerKey(userId)));
  const resolveRecordPath = record => {
    const candidate = path.resolve(root, String(record?.path || '').replace(/^uploads[\\/]/, ''));
    if (!isWithin(root, candidate) || candidate === root || candidate.startsWith(`${deletionRoot}${path.sep}`)) {
      throw Object.assign(new Error('Upload path is outside the managed store'), { code: 'UPLOAD_PATH_INVALID', status: 400 });
    }
    return candidate;
  };

  const save = async ({ userId, name, dataUrl, sourceId = null, storageKey = null, existingRecords = [] }) => {
    const { mimeType, buffer } = parseDataUrl(dataUrl);
    const expectedOwner = String(userId || 'local-user');
    const ownedRecords = existingRecords.filter(record => String(record?.ownerId || '') === expectedOwner);
    if (ownedRecords.length >= MAX_UPLOAD_RECORDS) throw Object.assign(new Error('Too many uploaded files for this account'), { code: 'UPLOAD_QUOTA_COUNT_EXCEEDED', status: 413 });
    const currentBytes = ownedRecords.reduce((total, record) => total + Math.max(0, Number(record?.size) || 0), 0);
    if (currentBytes + buffer.length > MAX_UPLOAD_TOTAL_BYTES) throw Object.assign(new Error('Uploaded file quota exceeded for this account'), { code: 'UPLOAD_QUOTA_BYTES_EXCEEDED', status: 413 });
    const owner = ownerDirectory(userId, storageKey);
    const storedName = `${randomUUID()}-${safeName(name)}`;
    const absolutePath = path.join(owner, storedName);
    await fs.mkdir(owner, { recursive: true, mode: 0o700 });
    await fs.writeFile(absolutePath, buffer, { flag: 'wx', mode: 0o600 });
    return {
      id: randomUUID(),
      ownerId: String(userId || 'local-user'),
      sourceId: sourceId ? String(sourceId) : null,
      name: safeName(name),
      mimeType,
      path: path.posix.join('uploads', normalizeStorageKey(storageKey || fallbackOwnerKey(userId)), storedName),
      size: buffer.length,
      createdAt: new Date(now()).toISOString()
    };
  };

  const removeRecord = async record => {
    const absolutePath = resolveRecordPath(record);
    await fs.rm(absolutePath, { force: true });
  };

  const exportRecords = async ({ userId, records = [] } = {}) => {
    const expectedOwner = String(userId || 'local-user');
    const owned = records.filter(record => String(record?.ownerId || '') === expectedOwner);
    if (owned.length > MAX_UPLOAD_RECORDS) throw Object.assign(new Error('Too many uploaded files for export'), { code: 'UPLOAD_EXPORT_COUNT_EXCEEDED', status: 413 });
    const result = [];
    let totalBytes = 0;
    for (const record of owned) {
      const absolutePath = resolveRecordPath(record);
      let buffer;
      try {
        buffer = await fs.readFile(absolutePath);
      } catch (error) {
        throw Object.assign(new Error(`Uploaded file is unavailable: ${record.path}`), {
          code: 'UPLOAD_EXPORT_FILE_MISSING',
          status: 503,
          cause: error
        });
      }
      totalBytes += buffer.length;
      if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) throw Object.assign(new Error('Uploaded export exceeds the account quota'), { code: 'UPLOAD_EXPORT_BYTES_EXCEEDED', status: 413 });
      result.push({ ...structuredClone(record), dataUrl: `data:${record.mimeType || 'application/octet-stream'};base64,${buffer.toString('base64')}` });
    }
    return result;
  };

  const importRecords = async ({ userId, records = [], storageKey = null, existingRecords = [] } = {}) => {
    if (records.length > MAX_UPLOAD_RECORDS) throw Object.assign(new Error('Too many uploaded files for import'), { code: 'UPLOAD_IMPORT_COUNT_EXCEEDED', status: 413 });
    const imported = [];
    try {
      for (const record of records) {
        if (!record?.dataUrl) throw Object.assign(new Error('Uploaded file payload is required for import'), { code: 'UPLOAD_IMPORT_PAYLOAD_REQUIRED', status: 400 });
        imported.push(await save({ userId, name: record.name, dataUrl: record.dataUrl, sourceId: record.id, storageKey, existingRecords: [...existingRecords, ...imported] }));
      }
      return imported;
    } catch (error) {
      await Promise.all(imported.map(item => removeRecord(item).catch(() => {})));
      throw error;
    }
  };

  const stageUserDeletion = async (userId, operationId = randomUUID(), storageKey = null) => {
    const owner = ownerDirectory(userId, storageKey);
    const exists = await fs.stat(owner).then(stat => stat.isDirectory()).catch(() => false);
    if (!exists) return { userId: String(userId || 'local-user'), operationId: String(operationId), existed: false, owner, staged: null };
    const staged = path.join(deletionRoot, `${normalizeStorageKey(storageKey || fallbackOwnerKey(userId))}-${String(operationId).replace(/[^\w.-]/g, '_')}-${randomUUID()}`);
    await fs.mkdir(deletionRoot, { recursive: true, mode: 0o700 });
    await fs.rename(owner, staged);
    return { userId: String(userId || 'local-user'), operationId: String(operationId), existed: true, owner, staged };
  };

  const rollbackUserDeletion = async token => {
    if (!token?.existed || !token.staged) return;
    const ownerExists = await fs.stat(token.owner).then(stat => stat.isDirectory()).catch(() => false);
    if (ownerExists) throw Object.assign(new Error('Cannot restore uploads because the owner directory already exists'), { code: 'UPLOAD_DELETE_ROLLBACK_CONFLICT', status: 503 });
    await fs.mkdir(path.dirname(token.owner), { recursive: true, mode: 0o700 });
    await fs.rename(token.staged, token.owner);
  };

  const commitUserDeletion = async token => {
    if (token?.staged) await fs.rm(token.staged, { recursive: true, force: true });
  };

  return { save, removeRecord, exportRecords, importRecords, stageUserDeletion, rollbackUserDeletion, commitUserDeletion, ownerDirectory };
}

export function ensureUploadOwnerKey(state) {
  if (!state || typeof state !== 'object') throw new TypeError('State is required to resolve an upload owner key');
  state.companion ||= {};
  const current = String(state.companion.uploadOwnerKey || '').trim();
  if (current && /^[A-Za-z0-9_-]{20,100}$/.test(current)) return current;
  const next = randomUUID();
  state.companion.uploadOwnerKey = next;
  return next;
}

export { parseDataUrl, safeName };
