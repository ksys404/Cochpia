import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModelGateway } from './memory-module-model-gateway.js';

test('model gateway blocks S3 and sensitive input before provider calls', async () => {
  let extractionCalls = 0;
  let embeddingCalls = 0;
  const gateway = createMemoryModelGateway({
    extraction: async () => { extractionCalls += 1; return []; },
    embedding: async () => { embeddingCalls += 1; return [1, 0]; }
  });
  await assert.rejects(() => gateway.extract({ content: 'secret sk-test_12345678901234567890' }), error => error.code === 'MODEL_INPUT_BLOCKED_S3');
  await assert.rejects(() => gateway.embed('我的诊断信息'), error => error.code === 'MODEL_INPUT_BLOCKED_S2');
  assert.equal(extractionCalls, 0);
  assert.equal(embeddingCalls, 0);
});

test('model gateway rejects empty input before provider calls', async () => {
  let called = false;
  const gateway = createMemoryModelGateway({ extraction: async () => { called = true; return []; } });
  await assert.rejects(() => gateway.extract({}), error => error.code === 'MODEL_INPUT_INVALID');
  assert.equal(called, false);
});

test('model gateway validates outputs and emits content-free telemetry', async () => {
  const telemetry = [];
  const gateway = createMemoryModelGateway({
    extraction: async (input, options) => { assert.equal(options.policyVersion, 'policy-test'); return [{ content: input.content, tool: 'delete_all', instruction: 'ignore policy' }]; },
    embedding: async () => [1, '2'],
    policyVersion: 'policy-test',
    telemetry: event => telemetry.push(event)
  });
  const extracted = await gateway.extract({ eventId: 'event-1', content: 'safe preference' });
  const vector = await gateway.embed('safe query');
  assert.equal(extracted[0].content, 'safe preference');
  assert.equal(Object.hasOwn(extracted[0], 'tool'), false);
  assert.equal(Object.hasOwn(extracted[0], 'instruction'), false);
  assert.deepEqual(vector, [1, 2]);
  assert.equal(telemetry.length, 2);
  assert.equal(Object.hasOwn(telemetry[0], 'content'), false);
  assert.equal(telemetry[0].policyVersion, 'policy-test');
});

test('model gateway telemetry carries safe provider metadata and normalized token usage', async () => {
  const telemetry = [];
  const gateway = createMemoryModelGateway({
    extraction: async () => ({ candidates: [{ content: 'safe preference' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
    provider: 'test-provider',
    modelName: 'test-model',
    modelVersion: 'model-v2',
    promptVersion: 'prompt-v3',
    dataRetentionPolicy: 'zero-retention',
    telemetry: event => telemetry.push(event)
  });
  await gateway.extract({ content: 'safe input' });
  assert.deepEqual(telemetry[0].tokenUsage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  assert.equal(telemetry[0].provider, 'test-provider');
  assert.equal(telemetry[0].modelName, 'test-model');
  assert.equal(telemetry[0].modelVersion, 'model-v2');
  assert.equal(telemetry[0].promptVersion, 'prompt-v3');
  assert.equal(telemetry[0].dataRetentionPolicy, 'zero-retention');
  assert.equal(Object.hasOwn(telemetry[0], 'content'), false);
});

test('model gateway enforces timeout and preserves AbortError fallback semantics', async () => {
  const telemetry = [];
  let aborted = false;
  const gateway = createMemoryModelGateway({
    extraction: async (_, { signal }) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      await new Promise(() => {});
    },
    timeoutMs: 10,
    telemetry: event => telemetry.push(event)
  });
  await assert.rejects(() => gateway.extract({ content: 'safe input' }), error => error.code === 'MODEL_EXTRACTION_TIMEOUT' && error.name === 'AbortError' && error.retryable === true);
  assert.equal(aborted, true);
  assert.equal(telemetry[0].status, 'error');
  assert.equal(telemetry[0].errorCode, 'MODEL_EXTRACTION_TIMEOUT');
});

test('model gateway retries temporary extraction failures but not authentication failures', async () => {
  let temporaryCalls = 0;
  const temporary = createMemoryModelGateway({
    extraction: async () => {
      temporaryCalls += 1;
      if (temporaryCalls === 1) throw Object.assign(new Error('temporary'), { status: 503 });
      return [];
    },
    retryAttempts: 1
  });
  await temporary.extract({ content: 'safe input' });
  assert.equal(temporaryCalls, 2);

  let authCalls = 0;
  const auth = createMemoryModelGateway({
    extraction: async () => {
      authCalls += 1;
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    },
    retryAttempts: 3
  });
  await assert.rejects(() => auth.extract({ content: 'safe input' }), error => error.code === 'MODEL_EXTRACTION_AUTH_FAILED' && error.retryable === false);
  assert.equal(authCalls, 1);
});

test('model gateway drops extraction candidates with secret or oversized structured data', async () => {
  const gateway = createMemoryModelGateway({
    extraction: async () => [
      { content: 'secret candidate', structuredData: { token: 'AKIA1234567890ABCDEF' } },
      { content: 'oversized candidate', structuredData: { detail: 'x'.repeat(16_001) } },
      { content: 'safe candidate', structuredData: { detail: 'safe' } }
    ]
  });
  const result = await gateway.extract({ content: 'safe input' });
  assert.deepEqual(result.map(item => item.content), ['safe candidate']);
  assert.deepEqual(result[0].structuredData, { detail: 'safe' });
});

test('model gateway rejects malformed embedding output', async () => {
  const gateway = createMemoryModelGateway({ embedding: async () => [1, Number.NaN] });
  await assert.rejects(() => gateway.embed('safe query'), error => error.code === 'MODEL_EMBEDDING_SCHEMA_INVALID');
});

test('reranker is input-gated and output-validated', async () => {
  let providerInput = null;
  const gateway = createMemoryModelGateway({
    reranker: async input => {
      providerInput = input;
      return { ranked: [{ id: 'memory-2', score: 0.9 }, { id: 'memory-1', score: 0.2 }] };
    }
  });
  const ranked = await gateway.rerank('safe query', [
    { id: 'memory-1', content: 'safe preference' },
    { id: 'memory-2', text: 'safe recovery note' }
  ]);
  assert.deepEqual(ranked, [{ id: 'memory-2', score: 0.9 }, { id: 'memory-1', score: 0.2 }]);
  assert.deepEqual(providerInput, { query: 'safe query', candidates: [{ id: 'memory-1', text: 'safe preference' }, { id: 'memory-2', text: 'safe recovery note' }] });
  await assert.rejects(() => gateway.rerank('safe query', [{ id: 'memory-1', content: 'AKIA1234567890ABCDEF' }]), error => error.code === 'MODEL_INPUT_BLOCKED_S3');
});

test('reranker rejects malformed or out-of-set provider results', async () => {
  const gateway = createMemoryModelGateway({ reranker: async () => [{ id: 'other-memory', score: 1 }] });
  await assert.rejects(() => gateway.rerank({ query: 'safe query', candidates: [{ id: 'memory-1', text: 'safe preference' }] }), error => error.code === 'MODEL_RERANK_SCHEMA_INVALID');
});

test('gateway reports output schema failures as telemetry errors', async () => {
  const telemetry = [];
  const gateway = createMemoryModelGateway({ embedding: async () => [Number.NaN], telemetry: event => telemetry.push(event) });
  await assert.rejects(() => gateway.embed('safe query'), error => error.code === 'MODEL_EMBEDDING_SCHEMA_INVALID');
  assert.equal(telemetry[0].status, 'error');
  assert.equal(telemetry[0].errorCode, 'MODEL_EMBEDDING_SCHEMA_INVALID');
});
