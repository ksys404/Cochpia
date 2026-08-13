import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createModelProvider, listModelProviders, resolveModelSelection } from './model-provider.js';

test('mock provider returns a relationship-aware response', async () => {
  const provider = createModelProvider('mock');
  assert.equal(provider.ready, true);
  const response = await provider.generate({ message: 'hello', recalled: [{ summary: 'A shared memory' }] });
  assert.match(response, /hello/);
  assert.match(response, /记得|关系/);
});

test('unsupported provider stays unavailable instead of crashing configuration', async () => {
  const provider = createModelProvider('not-configured');
  assert.equal(provider.ready, false);
  await assert.rejects(provider.generate({ message: 'hello', recalled: [] }), /Unsupported model provider/);
});

test('provider registry exposes the planned model families', () => {
  const catalog = listModelProviders();
  const providers = catalog.map(item => item.provider);
  assert.deepEqual(providers, ['mock', 'openai', 'deepseek', 'qwen', 'glm', 'kimi', 'minimax', 'siliconflow', 'anthropic', 'gemini']);
  assert.ok(catalog.every(item => item.useCases && Array.isArray(item.suggestedModels) && 'ready' in item));
});

test('model selection rejects unavailable providers and accepts configured custom models', () => {
  const unavailable = resolveModelSelection('deepseek', 'deepseek-chat');
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'MODEL_NOT_CONFIGURED');
  const originalKey = process.env.MODEL_OPENAI_API_KEY;
  const originalName = process.env.MODEL_OPENAI_NAME;
  process.env.MODEL_OPENAI_API_KEY = 'fixture';
  process.env.MODEL_OPENAI_NAME = 'custom-model';
  try {
    const configured = resolveModelSelection('openai', 'custom-model');
    assert.equal(configured.ok, true);
    assert.equal(configured.config.model, 'custom-model');
    const invalid = resolveModelSelection('openai', 'not-allowed');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'MODEL_NOT_ALLOWED');
  } finally {
    if (originalKey === undefined) delete process.env.MODEL_OPENAI_API_KEY; else process.env.MODEL_OPENAI_API_KEY = originalKey;
    if (originalName === undefined) delete process.env.MODEL_OPENAI_NAME; else process.env.MODEL_OPENAI_NAME = originalName;
  }
});

test('protocol adapters parse OpenAI-compatible, Anthropic, and Gemini responses', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/anthropic') return response.end(JSON.stringify({ content: [{ type: 'text', text: 'anthropic fixture' }] }));
    if (request.url?.includes(':generateContent')) return response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini fixture' }] } }] }));
    response.end(JSON.stringify({ choices: [{ message: { content: 'openai fixture' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const openai = createModelProvider('openai', { apiURL: `http://127.0.0.1:${port}/openai`, apiKey: 'fixture', model: 'fixture' });
    const anthropic = createModelProvider('anthropic', { apiURL: `http://127.0.0.1:${port}/anthropic`, apiKey: 'fixture', model: 'fixture' });
    const gemini = createModelProvider('gemini', { apiURL: `http://127.0.0.1:${port}`, apiKey: 'fixture', model: 'fixture' });
    assert.equal(await openai.generate({ message: 'x', recalled: [] }), 'openai fixture');
    assert.equal(await anthropic.generate({ message: 'x', recalled: [] }), 'anthropic fixture');
    assert.equal(await gemini.generate({ message: 'x', recalled: [] }), 'gemini fixture');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('protocol adapters preserve authentication and model-not-found error codes', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.statusCode = request.url === '/auth' ? 401 : 404;
    response.end(JSON.stringify({ error: { message: request.url === '/auth' ? 'bad key' : 'missing model' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const auth = createModelProvider('openai', { apiURL: `http://127.0.0.1:${port}/auth`, apiKey: 'fixture', model: 'fixture' });
    const missing = createModelProvider('openai', { apiURL: `http://127.0.0.1:${port}/missing`, apiKey: 'fixture', model: 'fixture' });
    await assert.rejects(auth.generate({ message: 'x', recalled: [] }), error => error.code === 'MODEL_AUTH_FAILED');
    await assert.rejects(missing.generate({ message: 'x', recalled: [] }), error => error.code === 'MODEL_NOT_FOUND');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('stream method yields OpenAI-compatible streaming deltas', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/event-stream');
    response.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"，我在"}}]}\n\n');
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const provider = createModelProvider('openai', { apiURL: `http://127.0.0.1:${port}/stream`, apiKey: 'fixture', model: 'fixture' });
    const parts = [];
    for await (const delta of provider.stream({ message: 'x', recalled: [] })) parts.push(delta);
    assert.equal(parts.join(''), '你好，我在');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('stream method yields Anthropic text deltas', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/event-stream');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n');
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const provider = createModelProvider('anthropic', { apiURL: `http://127.0.0.1:${port}/stream`, apiKey: 'fixture', model: 'fixture' });
    const parts = [];
    for await (const delta of provider.stream({ message: 'x', recalled: [] })) parts.push(delta);
    assert.equal(parts.join(''), 'hi there');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('gemini sends the API key in a header, never in the URL', async () => {
  let capturedUrl = '';
  let capturedKeyHeader = '';
  const server = createServer((request, response) => {
    capturedUrl = request.url || '';
    capturedKeyHeader = request.headers['x-goog-api-key'] || '';
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini header fixture' }] } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const provider = createModelProvider('gemini', { apiURL: `http://127.0.0.1:${port}`, apiKey: 'secret-key-fixture', model: 'fixture' });
    await provider.generate({ message: 'x', recalled: [] });
    assert.ok(!capturedUrl.includes('secret-key-fixture'), 'API key must not appear in the URL');
    assert.equal(capturedKeyHeader, 'secret-key-fixture');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
