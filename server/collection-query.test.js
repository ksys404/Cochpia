import test from 'node:test';
import assert from 'node:assert/strict';
import { queryCollection } from './collection-query.js';

test('collection query filters, searches, and paginates deterministically', () => {
  const result = queryCollection([{ title: 'First' }, { title: 'Second' }, { title: 'Third' }], { search: 'i', limit: 1, offset: 1 });
  assert.deepEqual(result.items, [{ title: 'Third' }]);
  assert.equal(result.total, 2);
  assert.equal(result.limit, 1);
  assert.equal(result.offset, 1);
});
