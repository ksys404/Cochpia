import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModelGateway } from './memory-module-model-gateway.js';
import { createMemoryHttpEmbeddingAdapter, createMemoryHttpExtractionAdapter, resolveMemoryEmbeddingConfig, resolveMemoryExtractionConfig, validateMemoryExternalProviderConfig } from './memory-module-http-gateway.js';

const originalApiKey = process.env.MEMORY_EMBEDDING_API_KEY;
const originalExtractionApiKey = process.env.MEMORY_EXTRACTION_API_KEY;

test.after(() => {
  if (originalApiKey == null) delete process.env.MEMORY_EMBEDDING_API_KEY;
  else process.env.MEMORY_EMBEDDING_API_KEY = originalApiKey;
  if (originalExtractionApiKey == null) delete process.env.MEMORY_EXTRACTION_API_KEY;
  else process.env.MEMORY_EXTRACTION_API_KEY = originalExtractionApiKey;
});

test('HTTP embedding adapter uses the OpenAI-compatible response and server-only API key', async () => {
  process.env.MEMORY_EMBEDDING_API_KEY = 'test-server-key';
  const calls = [];
  const adapter = createMemoryHttpEmbeddingAdapter({
    url: 'https://embedding.example/v1/',
    model: 'embed-test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return { model: 'embed-test', data: [{ embedding: [1, 0.5] }], usage: { total_tokens: 3 } }; } };
    }
  });
  const gateway = createMemoryModelGateway({ embedding: adapter, provider: 'test', embeddingVersion: 'v1', dataRetentionPolicy: 'no-store' });
  const vector = await gateway.embed('喜欢红茶');
  assert.deepEqual(vector, [1, 0.5]);
  assert.equal(calls[0].url, 'https://embedding.example/v1/embeddings');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-server-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { input: '喜欢红茶', model: 'embed-test' });
});

test('HTTP embedding adapter does not expose provider error bodies', async () => {
  const adapter = createMemoryHttpEmbeddingAdapter({
    url: 'https://embedding.example/v1/embeddings',
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async json() { return { error: { message: 'secret provider response' } }; }
    })
  });
  await assert.rejects(() => adapter('safe text'), error => {
    assert.equal(error.code, 'EMBEDDING_UNAVAILABLE');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /secret provider response/);
    return true;
  });
});

test('HTTP embedding configuration is disabled without a URL and exposes no key material', () => {
  const config = resolveMemoryEmbeddingConfig({ MEMORY_EMBEDDING_API_KEY: 'should-not-appear' });
  assert.deepEqual(config, { enabled: false, url: null, model: null, timeoutMs: 5_000 });
  assert.equal(Object.hasOwn(config, 'apiKey'), false);
});

test('HTTP extraction adapter sends event data as untrusted input and parses structured JSON', async () => {
  process.env.MEMORY_EXTRACTION_API_KEY = 'extraction-test-key';
  const calls = [];
  const adapter = createMemoryHttpExtractionAdapter({
    url: 'https://model.example/v1/',
    model: 'structured-test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content: '{"candidates":[{"content":"喜欢红茶","sensitivity":"S0"}]}' } }] }; } };
    }
  });
  const result = await adapter({ eventId: 'event-a', content: 'untrusted event data' });
  assert.equal(calls[0].url, 'https://model.example/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, 'Bearer extraction-test-key');
  assert.equal(JSON.parse(calls[0].options.body).messages[1].content.includes('untrusted event data'), true);
  assert.deepEqual(result.candidates[0].content, '喜欢红茶');
});

test('HTTP extraction adapter does not expose provider error bodies', async () => {
  const adapter = createMemoryHttpExtractionAdapter({
    url: 'https://model.example/v1/chat/completions',
    fetchImpl: async () => ({ ok: false, status: 500, async json() { return { error: { message: 'provider secret' } }; } })
  });
  await assert.rejects(() => adapter({ content: 'safe text' }), error => {
    assert.equal(error.code, 'EXTRACTION_UNAVAILABLE');
    assert.doesNotMatch(error.message, /provider secret/);
    return true;
  });
});

test('HTTP extraction adapter classifies network failures as retryable without exposing transport details', async () => {
  const adapter = createMemoryHttpExtractionAdapter({
    url: 'https://model.example/v1/chat/completions',
    fetchImpl: async () => { throw new TypeError('socket details should not escape'); }
  });
  await assert.rejects(() => adapter({ content: 'safe text' }), error => {
    assert.equal(error.code, 'EXTRACTION_UNAVAILABLE');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /socket details/);
    return true;
  });
});

test('HTTP extraction configuration is disabled without an extraction URL', () => {
  const config = resolveMemoryExtractionConfig({ MEMORY_EXTRACTION_API_KEY: 'should-not-appear' });
  assert.equal(config.enabled, false);
  assert.equal(Object.hasOwn(config, 'apiKey'), false);
});

test('production external model configuration requires an explicit retention policy', () => {
  assert.throws(() => validateMemoryExternalProviderConfig({
    nodeEnv: 'production',
    embeddingConfig: { enabled: true, retentionPolicy: 'unknown' },
    extractionConfig: { enabled: false }
  }), error => error.code === 'MEMORY_EXTERNAL_POLICY_REQUIRED');
  assert.deepEqual(validateMemoryExternalProviderConfig({
    nodeEnv: 'production',
    embeddingConfig: { enabled: true, retentionPolicy: 'no-training-30d' },
    extractionConfig: { enabled: true, retentionPolicy: 'no-training-30d' }
  }), { valid: true });
});
