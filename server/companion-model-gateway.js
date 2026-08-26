import { createModelProvider } from './model-provider.js';
import { isSecretMemoryContent } from './memory-module.js';

function gatewayError(code, message) {
  return Object.assign(new Error(message), { code, status: 400, retryable: false });
}

function containsSecret(value, seen = new WeakSet()) {
  if (typeof value === 'string') return isSecretMemoryContent(value);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsSecret(item, seen));
  return Object.values(value).some(item => containsSecret(item, seen));
}

export function assertCompanionModelInput(value) {
  if (containsSecret(value)) throw gatewayError('MODEL_INPUT_BLOCKED_S3', 'Model input is blocked by the S3 policy');
  return true;
}

export function assertCompanionModelOutput(value) {
  if (containsSecret(value)) throw gatewayError('MODEL_OUTPUT_BLOCKED_S3', 'Model output is blocked by the S3 policy');
  return value;
}

export function createCompanionModelGateway(provider = process.env.MODEL_PROVIDER || 'mock', overrides = {}, { providerFactory = createModelProvider } = {}) {
  if (typeof providerFactory !== 'function') throw new TypeError('Companion Model Gateway providerFactory is required');
  const model = providerFactory(provider, overrides);
  const generate = async (input = {}) => {
    assertCompanionModelInput({ message: input.message, recalled: input.recalled, runtimeContext: input.runtimeContext });
    return assertCompanionModelOutput(await model.generate(input));
  };
  const stream = async function* (input = {}) {
    assertCompanionModelInput({ message: input.message, recalled: input.recalled, runtimeContext: input.runtimeContext });
    let pending = '';
    for await (const chunk of model.stream(input)) {
      const text = String(chunk ?? '');
      pending += text;
      assertCompanionModelOutput(pending);
      if (pending.length > 128) {
        const releaseLength = pending.length - 128;
        yield pending.slice(0, releaseLength);
        pending = pending.slice(releaseLength);
      }
    }
    if (pending) yield assertCompanionModelOutput(pending);
  };
  const generateWithTools = async (input = {}) => {
    assertCompanionModelInput({ system: input.system, messages: input.messages });
    return assertCompanionModelOutput(await model.generateWithTools(input));
  };
  const composeSystemPrompt = (input = {}) => {
    assertCompanionModelInput({ recalled: input.recalled, runtimeContext: input.runtimeContext });
    return assertCompanionModelOutput(model.composeSystemPrompt(input));
  };
  return { ...model, generate, stream, generateWithTools, composeSystemPrompt };
}

function eventTextChunk(event) {
  if (event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    return event.assistantMessageEvent.delta;
  }
  return null;
}

function isPiToolEvent(event) {
  return event?.type === 'tool_execution_start'
    || event?.type === 'tool_execution_update'
    || event?.type === 'tool_execution_end'
    || event?.type === 'bash_execution_update';
}

// Adapter for model engines that expose event callbacks instead of the provider API.
// It keeps the same input/output policy boundary as the regular model gateway.
export function createCompanionPiGateway({ clientFactory, outputWindowSize = 128 } = {}) {
  if (typeof clientFactory !== 'function') throw new TypeError('Companion Pi Gateway clientFactory is required');
  if (!Number.isInteger(outputWindowSize) || outputWindowSize < 16) throw new TypeError('Companion Pi Gateway outputWindowSize must be an integer >= 16');

  return {
    async prompt(input = {}, onEvent = () => {}) {
      const normalizedInput = typeof input === 'string' ? { message: input } : input;
      assertCompanionModelInput(normalizedInput);
      const client = clientFactory();
      if (!client?.prompt) throw new TypeError('Companion Pi Gateway client must expose prompt');

      let pendingText = '';
      let pendingTextEvent = null;
      let gateError = null;
      const gateEvent = event => {
        if (gateError) return;
        try {
          assertCompanionModelOutput(event);
          if (isPiToolEvent(event)) throw gatewayError('MODEL_TOOL_EXECUTION_BLOCKED', 'Pi tool execution is not allowed through the Companion Model Gateway');
          const textChunk = eventTextChunk(event);
          if (textChunk !== null) {
            pendingTextEvent = event;
            pendingText += String(textChunk ?? '');
            assertCompanionModelOutput(pendingText);
            if (pendingText.length > outputWindowSize) {
              const releaseLength = pendingText.length - outputWindowSize;
              const release = pendingText.slice(0, releaseLength);
              pendingText = pendingText.slice(releaseLength);
              onEvent({
                ...event,
                assistantMessageEvent: {
                  ...event.assistantMessageEvent,
                  delta: release
                }
              });
            }
            return;
          }
          onEvent(event);
        } catch (error) {
          gateError = error;
        }
      };

      try {
        await client.prompt(String(normalizedInput.message || ''), gateEvent);
        if (!gateError && pendingText && pendingTextEvent) {
          try {
            assertCompanionModelOutput(pendingText);
            onEvent({
              ...pendingTextEvent,
              assistantMessageEvent: {
                ...pendingTextEvent.assistantMessageEvent,
                delta: pendingText
              }
            });
          } catch (error) {
            gateError = error;
          }
        }
      } finally {
        if (gateError && typeof client.close === 'function') client.close();
      }
      if (gateError) throw gateError;
    }
  };
}
