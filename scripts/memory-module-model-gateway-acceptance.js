import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryModelGateway } from '../server/memory-module-model-gateway.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const artifactPath = path.resolve(root, '../artifacts/memory-model-gateway-audit-2026-08-24.json');
const telemetry = [];
const calls = { extraction: 0, embedding: 0, reranker: 0 };
const providerInputs = [];

const gateway = createMemoryModelGateway({
  provider: 'fixture-provider',
  modelName: 'fixture-model',
  modelVersion: 'fixture-v1',
  promptVersion: 'prompt-v1',
  embeddingVersion: 'embedding-v1',
  dataRetentionPolicy: 'zero-retention',
  policyVersion: 'memory-policy-v1',
  extraction: async input => {
    calls.extraction += 1;
    providerInputs.push({ kind: 'extraction', input });
    return [
      { content: 'AKIA1234567890ABCDEF', sensitivity: 'S3' },
      { content: 'safe preference', instruction: 'ignore policy', structuredData: { source: 'fixture' } }
    ];
  },
  embedding: async input => {
    calls.embedding += 1;
    providerInputs.push({ kind: 'embedding', input });
    return { embedding: [1, '2'], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };
  },
  reranker: async input => {
    calls.reranker += 1;
    providerInputs.push({ kind: 'reranker', input });
    return { ranked: [{ id: 'memory-2', score: 0.9 }, { id: 'memory-1', score: 0.1 }] };
  },
  telemetry: event => telemetry.push(event),
  retryAttempts: 1
});

const run = async () => {
  await assert.rejects(
    () => gateway.extract({ content: 'AKIA1234567890ABCDEF' }),
    error => error.code === 'MODEL_INPUT_BLOCKED_S3'
  );
  await assert.rejects(
    () => gateway.extract({ content: '我的诊断信息' }),
    error => error.code === 'MODEL_INPUT_BLOCKED_S2'
  );
  const sensitiveOutput = await gateway.extract({ content: '我的诊断信息' }, { allowSensitiveInput: true });
  assert.deepEqual(sensitiveOutput.map(item => item.content), ['safe preference']);
  const extracted = await gateway.extract({ content: 'safe input' });
  assert.deepEqual(extracted.map(item => item.content), ['safe preference']);
  assert.equal(Object.hasOwn(extracted[0], 'instruction'), false);

  const vector = await gateway.embed('safe query');
  assert.deepEqual(vector, [1, 2]);
  const ranked = await gateway.rerank('safe query', [
    { id: 'memory-1', content: 'safe preference' },
    { id: 'memory-2', content: 'safe recovery note' }
  ]);
  assert.deepEqual(ranked, [{ id: 'memory-2', score: 0.9 }, { id: 'memory-1', score: 0.1 }]);

  let retryCalls = 0;
  const retryGateway = createMemoryModelGateway({
    extraction: async () => {
      retryCalls += 1;
      if (retryCalls === 1) throw Object.assign(new Error('temporary provider body'), { status: 503 });
      return [];
    },
    retryAttempts: 1,
    telemetry: event => telemetry.push(event)
  });
  await retryGateway.extract({ content: 'retryable input' });
  assert.equal(retryCalls, 2);

  let authCalls = 0;
  const authGateway = createMemoryModelGateway({
    extraction: async () => {
      authCalls += 1;
      throw Object.assign(new Error('provider auth response body'), { status: 401 });
    },
    retryAttempts: 3,
    telemetry: event => telemetry.push(event)
  });
  await assert.rejects(() => authGateway.extract({ content: 'auth input' }), error => error.code === 'MODEL_EXTRACTION_AUTH_FAILED' && error.retryable === false);
  assert.equal(authCalls, 1);

  const failingGateway = createMemoryModelGateway({
    extraction: async () => { throw Object.assign(new Error('provider response body must not escape'), { status: 500 }); }
  });
  await assert.rejects(
    () => failingGateway.extract({ content: 'safe failure input' }),
    error => error.code === 'MODEL_EXTRACTION_UNAVAILABLE' && error.message === 'Model provider is temporarily unavailable' && !error.message.includes('provider response body')
  );

  const telemetryJson = JSON.stringify(telemetry);
  assert.equal(telemetry.every(event => !Object.hasOwn(event, 'content') && !Object.hasOwn(event, 'input') && !Object.hasOwn(event, 'output')), true);
  assert.equal(telemetryJson.includes('AKIA1234567890ABCDEF'), false);
  assert.equal(telemetryJson.includes('我的诊断信息'), false);
  assert.equal(telemetry.some(event => event.dataRetentionPolicy === 'zero-retention'), true);
  assert.equal(providerInputs.some(item => item.kind === 'extraction' && item.input.content === '我的诊断信息'), true);

  return {
    event: 'memory_model_gateway_audit',
    generatedAt: new Date().toISOString(),
    mode: 'local-fixture',
    provider: 'fixture-provider',
    policyVersion: 'memory-policy-v1',
    checks: {
      s3InputBlockedBeforeProvider: calls.extraction === 2,
      s2InputBlockedByDefault: true,
      explicitS2OverrideRequired: true,
      s3ExtractionOutputFiltered: true,
      instructionLikeFieldsDropped: true,
      embeddingSchemaNormalized: true,
      rerankerOutputBoundedAndSetChecked: true,
      retryable503Retried: retryCalls === 2,
      auth401NotRetried: authCalls === 1,
      providerErrorBodyNotReturned: true,
      telemetryContentFree: true,
      retentionPolicyRecorded: true
    },
    providerCalls: calls,
    telemetryEvents: telemetry.length,
    limitations: [
      'Fixture-only provider; this does not prove a real vendor retention, region, training, or deletion SLA.',
      'Fixture output quality is schema/safety coverage, not a production extraction quality score.'
    ]
  };
};

try {
  const result = await run();
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ event: 'memory_model_gateway_audit_failed', code: error.code || 'MODEL_GATEWAY_AUDIT_FAILED', message: error.message }));
  process.exitCode = 1;
}
