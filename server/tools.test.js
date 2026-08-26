import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspacePath } from './tools.js';

test('workspace tool paths stay inside the repository', () => {
  assert.equal(resolveWorkspacePath('server/tools.js').endsWith('/server/tools.js'), true);
  assert.throws(() => resolveWorkspacePath('/etc/passwd', { mustExist: true }), /outside the workspace|resolves outside/);
});

test('workspace tool paths reject symlink escapes and missing required files', () => {
  assert.throws(() => resolveWorkspacePath('server/does-not-exist.txt', { mustExist: true }), /does not exist/);
  assert.throws(() => resolveWorkspacePath('uploads/.deletions/pending.txt'), /restricted/);
});
