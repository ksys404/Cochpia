import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryService } from './memory-service.js';

test('memory revoke hides a memory from the default list but preserves export data', async () => {
  const state = { memories: [{ id: 'm-1', summary: 'private note', type: 'event', visibility: 'shared' }], evidence: [] };
  const service = createMemoryService(state, async () => {});
  const revoked = await service.revoke('m-1');
  assert.equal(revoked.visibility, 'revoked');
  assert.equal((await service.list()).length, 0);
  assert.equal(service.exportMemories()[0].revokedAt !== undefined, true);
});
