import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PREFERENCES_BYTES, sanitizeWorkspacePreferences } from './workspace-preferences.js';

test('workspace preferences keep supported fields and drop unknown values', () => {
  const result = sanitizeWorkspacePreferences({
    theme: { themeId: 'ink', customColors: { canvas: '#111111', ignored: 'drop' } },
    appearance: { cornerRadius: 18 },
    privateData: { token: 'should not persist' }
  });
  assert.deepEqual(result, { theme: { themeId: 'ink', customColors: { canvas: '#111111' } }, appearance: { cornerRadius: 18 } });
});

test('workspace preferences enforce the payload size limit', () => {
  assert.throws(() => sanitizeWorkspacePreferences({ background: { imageUrl: 'x'.repeat(MAX_PREFERENCES_BYTES) } }), /too large/);
});

test('workspace preferences preserve null timezone and finite values only', () => {
  const result = sanitizeWorkspacePreferences({ time: { timezone: null, showSeconds: true }, typography: { fontScale: Infinity } });
  assert.deepEqual(result, { time: { timezone: null, showSeconds: true } });
});
