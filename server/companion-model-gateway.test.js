import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompanionModelInput, assertCompanionModelOutput, createCompanionModelGateway, createCompanionPiGateway } from './companion-model-gateway.js';

function fakeProvider(overrides = {}) {
  return {
    provider: 'fixture',
    model: 'fixture-model',
    protocol: 'fixture',
    ready: true,
    async generate() { return overrides.generate ?? 'safe response'; },
    async *stream() { for (const chunk of overrides.stream || ['safe ', 'response']) yield chunk; },
    async generateWithTools() { return overrides.generateWithTools ?? { content: 'safe response', toolCalls: [] }; },
    composeSystemPrompt() { return overrides.system || 'safe system'; }
  };
}

test('Companion Model Gateway blocks secret input before provider calls', async () => {
  let calls = 0;
  const gateway = createCompanionModelGateway('fixture', {}, { providerFactory: () => ({
    ...fakeProvider(),
    async generate() { calls += 1; return 'should not run'; }
  }) });
  await assert.rejects(() => gateway.generate({ message: 'token sk-test_12345678901234567890' }), error => error.code === 'MODEL_INPUT_BLOCKED_S3');
  await assert.rejects(() => gateway.generate({ message: 'safe', runtimeContext: { messages: [{ content: 'AKIA1234567890ABCDEF' }] } }), error => error.code === 'MODEL_INPUT_BLOCKED_S3');
  assert.equal(calls, 0);
});

test('Companion Model Gateway blocks secret output and tool payloads', async () => {
  const output = createCompanionModelGateway('fixture', {}, { providerFactory: () => fakeProvider({ generate: 'leaked 1234567890123' }) });
  await assert.rejects(() => output.generate({ message: 'safe' }), error => error.code === 'MODEL_OUTPUT_BLOCKED_S3');

  const tools = createCompanionModelGateway('fixture', {}, {
    providerFactory: () => fakeProvider({ generateWithTools: { content: 'safe', toolCalls: [{ function: { arguments: '{"token":"AKIA1234567890ABCDEF"}' } }] } })
  });
  await assert.rejects(() => tools.generateWithTools({ system: 'safe', messages: [] }), error => error.code === 'MODEL_OUTPUT_BLOCKED_S3');
});

test('Companion Model Gateway fences a secret split across stream chunks', async () => {
  const gateway = createCompanionModelGateway('fixture', {}, { providerFactory: () => fakeProvider({ stream: ['prefix sk-test_1234567890', '1234567890 suffix'] }) });
  const chunks = [];
  await assert.rejects(async () => {
    for await (const chunk of gateway.stream({ message: 'safe' })) chunks.push(chunk);
  }, error => error.code === 'MODEL_OUTPUT_BLOCKED_S3');
  assert.deepEqual(chunks, []);
});

test('Companion Model Gateway exposes explicit input/output assertions', () => {
  assert.equal(assertCompanionModelInput({ message: 'safe' }), true);
  assert.equal(assertCompanionModelOutput('safe'), 'safe');
  assert.throws(() => assertCompanionModelInput('AKIA1234567890ABCDEF'), error => error.code === 'MODEL_INPUT_BLOCKED_S3');
  assert.throws(() => assertCompanionModelOutput('1234567890123'), error => error.code === 'MODEL_OUTPUT_BLOCKED_S3');
});

test('Companion Pi Gateway blocks input before spawning the engine', async () => {
  let spawned = 0;
  const gateway = createCompanionPiGateway({ clientFactory: () => {
    spawned += 1;
    return { prompt: async () => {} };
  } });
  await assert.rejects(() => gateway.prompt({ message: 'token sk-test_12345678901234567890' }), error => error.code === 'MODEL_INPUT_BLOCKED_S3');
  assert.equal(spawned, 0);
});

test('Companion Pi Gateway blocks secrets split across events and does not leak callbacks', async () => {
  let callbacks = 0;
  const gateway = createCompanionPiGateway({ clientFactory: () => ({
    prompt: async (_message, onEvent) => {
      onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'prefix sk-test_1234567890' } });
      onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '1234567890 suffix' } });
    }
  }) });
  await assert.rejects(() => gateway.prompt('safe', () => { callbacks += 1; }), error => error.code === 'MODEL_OUTPUT_BLOCKED_S3');
  assert.equal(callbacks, 0);
});

test('Companion Pi Gateway flushes only safe text after the stream closes', async () => {
  const events = [];
  const gateway = createCompanionPiGateway({ clientFactory: () => ({
    prompt: async (_message, onEvent) => onEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'safe response' }
    })
  }) });
  await gateway.prompt('safe', event => events.push(event));
  assert.deepEqual(events.map(event => event.assistantMessageEvent.delta), ['safe response']);
});

test('Companion Pi Gateway gates tool payloads and callback failures', async () => {
  const toolGateway = createCompanionPiGateway({ clientFactory: () => ({
    prompt: async (_message, onEvent) => onEvent({
      type: 'tool_execution_start',
      toolName: 'write_file',
      args: { path: 'notes.txt' }
    })
  }) });
  await assert.rejects(() => toolGateway.prompt('safe'), error => error.code === 'MODEL_TOOL_EXECUTION_BLOCKED');

  const secretToolGateway = createCompanionPiGateway({ clientFactory: () => ({
    prompt: async (_message, onEvent) => onEvent({
      type: 'tool_execution_start',
      toolName: 'write_file',
      args: { token: 'AKIA1234567890ABCDEF' }
    })
  }) });
  await assert.rejects(() => secretToolGateway.prompt('safe'), error => error.code === 'MODEL_OUTPUT_BLOCKED_S3');

  const callbackGateway = createCompanionPiGateway({ clientFactory: () => ({
    prompt: async (_message, onEvent) => onEvent({ type: 'safe_event' })
  }) });
  await assert.rejects(() => callbackGateway.prompt('safe', () => { throw new Error('consumer failed'); }), /consumer failed/);
});
