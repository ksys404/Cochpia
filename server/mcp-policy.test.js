import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMcpWriteAuthorized } from './mcp-policy.js';

test('MCP read tools remain available through the subject-authenticated path', () => {
  assert.deepEqual(assertMcpWriteAuthorized({ name: 'breath', expectedToken: 'service-token' }), { write: false, authorized: true });
});

test('MCP write tools fail closed without a service boundary', () => {
  assert.throws(() => assertMcpWriteAuthorized({ name: 'hold', expectedToken: '' }), error => error.code === 'MCP_WRITE_BOUNDARY_NOT_CONFIGURED');
  assert.throws(() => assertMcpWriteAuthorized({ name: 'grow', providedToken: 'wrong', expectedToken: 'service-token' }), error => error.code === 'MCP_WRITE_SERVICE_AUTH_REQUIRED');
  assert.deepEqual(assertMcpWriteAuthorized({ name: 'hold', providedToken: 'service-token', expectedToken: 'service-token' }), { write: true, authorized: true });
});
