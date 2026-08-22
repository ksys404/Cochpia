import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const specPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/memory-module-openapi.yaml');

test('Memory Module OpenAPI artifact covers every V1 route and shared safety contract', async () => {
  const spec = await readFile(specPath, 'utf8');
  for (const route of [
    '/v1/events:',
    '/v1/sessions:',
    '/v1/access-grants:',
    '/v1/memories:',
    '/v1/memories/{memory_id}:',
    '/v1/memories/{memory_id}/correct:',
    '/v1/memories/{memory_id}/promote:',
    '/v1/memories/{memory_id}/pin:',
    '/v1/memories/{memory_id}/unpin:',
    '/v1/memories/{memory_id}/revoke:',
    '/v1/memories/{memory_id}/forget:',
    '/v1/governance/forget:',
    '/v1/governance/delete:',
    '/v1/retrieve:',
    '/v1/context-bundles:',
    '/v1/confirmations:',
    '/v1/confirmations/{confirmation_id}/confirm:',
    '/v1/confirmations/{confirmation_id}/reject:',
    '/v1/access-confirmations/{access_confirmation_id}/confirm:',
    '/v1/sessions/{session_id}/current-state:',
    '/v1/deletion-operations/{deletion_operation_id}:'
  ]) assert.match(spec, new RegExp(`^  ${route.replace(/[{}]/g, '\\$&')}$`, 'm'));
  assert.match(spec, /openapi: 3\.1\.0/);
  assert.match(spec, /name: Idempotency-Key/);
  assert.match(spec, /request_id: \{type: string\}/);
  assert.match(spec, /current_resource_revision/);
  assert.match(spec, /content_type: \{type: string, enum: \[plain_text, structured, tool_output, imported, quoted_content\]/);
  assert.match(spec, /storage_directive: \{type: string, enum: \[default, do_not_store\]/);
  assert.match(spec, /CurrentStateWriteRequest/);
});
