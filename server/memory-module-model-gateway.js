import { randomUUID } from 'node:crypto';
import { classifyMemorySensitivity, isSecretMemoryContent } from './memory-module.js';

function gatewayError(code, message, { retryable = false } = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

const operationCode = kind => `MODEL_${String(kind).toUpperCase()}`;

function safeLabel(value, fallback = null) {
  if (value == null || value === '') return fallback;
  return String(value).trim().slice(0, 120) || fallback;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 1_000_000_000 ? number : null;
}

function normalizeTokenUsage(value) {
  const usage = value && typeof value === 'object' && !Array.isArray(value)
    ? (value.usage || value.tokenUsage || value.token_usage || null)
    : null;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const inputTokens = normalizeNonNegativeInteger(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens);
  const outputTokens = normalizeNonNegativeInteger(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens);
  const totalTokens = normalizeNonNegativeInteger(usage.totalTokens ?? usage.total_tokens);
  if (inputTokens == null && outputTokens == null && totalTokens == null) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function retryableProviderError(error) {
  if (error?.retryable === true) return true;
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'MODEL_UNAVAILABLE', 'EXTRACTION_UNAVAILABLE', 'EMBEDDING_UNAVAILABLE', 'RERANKER_UNAVAILABLE'].includes(error?.code);
}

function classifyProviderError(error, kind) {
  if (error?.code && (String(error.code).startsWith('MODEL_') || String(error.code).startsWith('EXTRACTION_') || String(error.code).startsWith('EMBEDDING_') || String(error.code).startsWith('RERANKER_'))) return error;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    const timeout = gatewayError(`${operationCode(kind)}_TIMEOUT`, 'Model gateway operation timed out', { retryable: true });
    timeout.name = 'AbortError';
    return timeout;
  }
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (status === 401 || status === 403) return gatewayError(`${operationCode(kind)}_AUTH_FAILED`, 'Model provider authentication failed');
  if (status === 402) return gatewayError(`${operationCode(kind)}_BILLING_FAILED`, 'Model provider billing is unavailable');
  if (status === 429) return gatewayError(`${operationCode(kind)}_RATE_LIMITED`, 'Model provider rate limit reached', { retryable: true });
  if (retryableProviderError(error)) return gatewayError(`${operationCode(kind)}_UNAVAILABLE`, 'Model provider is temporarily unavailable', { retryable: true });
  const classified = gatewayError(`${operationCode(kind)}_FAILED`, 'Model provider operation failed');
  classified.cause = error;
  return classified;
}

function assertModelInput(content, { allowSensitiveInput = false } = {}) {
  const normalized = String(content ?? '').trim();
  if (!normalized) throw gatewayError('MODEL_INPUT_INVALID', 'Model input must contain non-empty text');
  if (isSecretMemoryContent(normalized)) throw gatewayError('MODEL_INPUT_BLOCKED_S3', 'Model input is blocked by the S3 policy');
  if (classifyMemorySensitivity({ content: normalized }) === 'S2' && !allowSensitiveInput) throw gatewayError('MODEL_INPUT_BLOCKED_S2', 'Model input requires an explicit sensitive-input policy');
}

function normalizeStructuredData(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!encoded || encoded.length > 16_000 || isSecretMemoryContent(encoded)) return null;
  try {
    return JSON.parse(encoded);
  } catch {
    return null;
  }
}

function normalizeEmbedding(vector) {
  const values = Array.isArray(vector) ? vector : vector?.embedding ?? vector?.vector;
  if (!Array.isArray(values) || !values.length || values.length > 16_384 || values.some(value => !Number.isFinite(Number(value)))) throw gatewayError('MODEL_EMBEDDING_SCHEMA_INVALID', 'Embedding output must be a finite numeric vector');
  return values.map(Number);
}

function normalizeExtractionOutput(value) {
  const candidates = Array.isArray(value) ? value : value?.candidates;
  if (!Array.isArray(candidates)) throw gatewayError('MODEL_EXTRACTION_SCHEMA_INVALID', 'Extraction output must contain a candidates array');
  if (candidates.length > 10) throw gatewayError('MODEL_EXTRACTION_SCHEMA_INVALID', 'Extraction output exceeds the candidate limit');
  return candidates.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const content = String(candidate.content || '').trim().slice(0, 1_000);
    if (!content || isSecretMemoryContent(content)) return null;
    const sensitivity = classifyMemorySensitivity({ content, sensitivity: candidate.sensitivity });
    if (sensitivity === 'S3') return null;
    const structuredData = normalizeStructuredData(candidate.structuredData);
    if (structuredData === null) return null;
    return {
      content,
      structuredData,
      memoryType: String(candidate.memoryType || 'fact').slice(0, 80),
      scopeType: ['user', 'relationship', 'session'].includes(candidate.scopeType) ? candidate.scopeType : 'user',
      relationshipAgentId: candidate.relationshipAgentId ? String(candidate.relationshipAgentId).slice(0, 200) : null,
      sessionId: candidate.sessionId ? String(candidate.sessionId).slice(0, 200) : null,
      sensitivity,
      confidence: Number.isFinite(Number(candidate.confidence)) ? Math.max(0, Math.min(1, Number(candidate.confidence))) : 0,
      importance: Number.isFinite(Number(candidate.importance)) ? Math.max(0, Math.min(1, Number(candidate.importance))) : 0,
      assertionType: ['observed_fact', 'inferred_fact', 'relationship_signal'].includes(candidate.assertionType) ? candidate.assertionType : 'observed_fact',
      extractionMethod: String(candidate.extractionMethod || 'model').slice(0, 80)
    };
  }).filter(Boolean);
}

function normalizeRerankInput(queryOrInput, candidates, options = {}) {
  const input = queryOrInput && typeof queryOrInput === 'object' && !Array.isArray(queryOrInput) && candidates === undefined
    ? queryOrInput
    : { query: queryOrInput, candidates };
  const query = String(input.query || '').trim();
  if (!query || !Array.isArray(input.candidates) || input.candidates.length > 200) throw gatewayError('MODEL_RERANK_INPUT_INVALID', 'Rerank input requires a query and at most 200 candidates');
  assertModelInput(query, options);
  const normalizedCandidates = input.candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw gatewayError('MODEL_RERANK_INPUT_INVALID', `Rerank candidate ${index} is invalid`);
    const id = String(candidate.id ?? candidate.memoryId ?? candidate.documentId ?? '').trim();
    const text = String(candidate.text ?? candidate.content ?? candidate.summary ?? candidate.displayText ?? '').trim();
    if (!id || !text) throw gatewayError('MODEL_RERANK_INPUT_INVALID', `Rerank candidate ${index} requires id and text`);
    assertModelInput(text, options);
    return { id, text };
  });
  return { query, candidates: normalizedCandidates };
}

function normalizeRerankOutput(value, candidateIds) {
  const ranked = Array.isArray(value) ? value : value?.items ?? value?.ranked;
  if (!Array.isArray(ranked) || ranked.length > candidateIds.size) throw gatewayError('MODEL_RERANK_SCHEMA_INVALID', 'Reranker output must be a bounded array');
  const seen = new Set();
  return ranked.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw gatewayError('MODEL_RERANK_SCHEMA_INVALID', `Reranker result ${index} is invalid`);
    const id = String(item.id ?? item.memoryId ?? item.documentId ?? '').trim();
    const score = Number(item.score);
    if (!id || !candidateIds.has(id) || seen.has(id) || !Number.isFinite(score)) throw gatewayError('MODEL_RERANK_SCHEMA_INVALID', `Reranker result ${index} is invalid`);
    seen.add(id);
    return { id, score };
  });
}

export function createMemoryModelGateway({ extraction = null, embedding = null, reranker = null, policyVersion = 'memory-policy-v1', provider = 'injected', modelName = 'unknown', modelVersion = 'unknown', promptVersion = null, embeddingVersion = null, dataRetentionPolicy = 'unknown', timeoutMs = 5_000, retryAttempts = 0, telemetry = () => {} } = {}) {
  const telemetryMetadata = options => ({
    provider: safeLabel(options.provider, safeLabel(provider, 'injected')),
    modelName: safeLabel(options.modelName, safeLabel(modelName, 'unknown')),
    modelVersion: safeLabel(options.modelVersion, safeLabel(modelVersion, 'unknown')),
    promptVersion: safeLabel(options.promptVersion, safeLabel(promptVersion)),
    embeddingVersion: safeLabel(options.embeddingVersion, safeLabel(embeddingVersion)),
    dataRetentionPolicy: safeLabel(options.dataRetentionPolicy, safeLabel(dataRetentionPolicy, 'unknown')),
    policyVersion: safeLabel(options.policyVersion, policyVersion)
  });
  const emitTelemetry = event => {
    try { telemetry(event); } catch { /* telemetry must not affect memory behavior */ }
  };
  const call = async (kind, operation, input, options = {}, normalize = value => value) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const boundedTimeoutMs = Math.max(1, Math.min(60_000, Number(options.timeoutMs ?? timeoutMs) || 5_000));
    const maxRetries = Math.max(0, Math.min(5, Number(options.retryAttempts ?? retryAttempts) || 0));
    const metadata = telemetryMetadata(options);
    let attempts = 0;
    while (attempts <= maxRetries) {
      attempts += 1;
      const controller = new AbortController();
      const externalSignal = options.signal;
      let externalAbortHandler = null;
      let timeoutHandle = null;
      let rejectAbort;
      const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          const timeout = gatewayError(`${operationCode(kind)}_TIMEOUT`, 'Model gateway operation timed out', { retryable: true });
          timeout.name = 'AbortError';
          reject(timeout);
        }, boundedTimeoutMs);
      });
      try {
        if (externalSignal) {
          externalAbortHandler = () => {
            controller.abort();
            const aborted = gatewayError('MODEL_OPERATION_ABORTED', 'Model gateway operation was aborted');
            aborted.name = 'AbortError';
            rejectAbort(aborted);
          };
          if (externalSignal.aborted) externalAbortHandler();
          else externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
        }
        const rawValue = await Promise.race([
          Promise.resolve().then(() => operation(input, { ...options, requestId, policyVersion: metadata.policyVersion, signal: controller.signal })),
          timeoutPromise,
          abortPromise
        ]);
        const value = normalize(rawValue);
        emitTelemetry({ requestId, kind, ...metadata, attempts, timeoutMs: boundedTimeoutMs, tokenUsage: normalizeTokenUsage(rawValue), latencyMs: performance.now() - startedAt, status: 'ok' });
        return value;
      } catch (rawError) {
        const error = classifyProviderError(rawError, kind);
        if (attempts <= maxRetries && error.retryable) continue;
        emitTelemetry({ requestId, kind, ...metadata, attempts, timeoutMs: boundedTimeoutMs, latencyMs: performance.now() - startedAt, status: 'error', errorCode: error.code || 'MODEL_GATEWAY_ERROR' });
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
        if (externalSignal && externalAbortHandler) externalSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
    throw gatewayError(`${operationCode(kind)}_FAILED`, 'Model gateway operation failed');
  };

  return {
    policyVersion,
    async extract(input, options = {}) {
      if (typeof extraction !== 'function') throw gatewayError('MODEL_GATEWAY_UNAVAILABLE', 'Extraction gateway is not configured', { retryable: true });
      assertModelInput(input?.content, options);
      return call('extraction', extraction, input, options, normalizeExtractionOutput);
    },
    async embed(text, options = {}) {
      if (typeof embedding !== 'function') throw gatewayError('EMBEDDING_GATEWAY_UNAVAILABLE', 'Embedding gateway is not configured', { retryable: true });
      assertModelInput(text, options);
      return call('embedding', embedding, text, options, normalizeEmbedding);
    },
    async rerank(queryOrInput, candidatesOrOptions, maybeOptions = {}) {
      if (typeof reranker !== 'function') throw gatewayError('RERANKER_GATEWAY_UNAVAILABLE', 'Reranker is not configured', { retryable: true });
      const usesInputObject = queryOrInput && typeof queryOrInput === 'object' && !Array.isArray(queryOrInput) && candidatesOrOptions && !Array.isArray(candidatesOrOptions);
      const candidates = usesInputObject ? undefined : candidatesOrOptions;
      const options = usesInputObject ? candidatesOrOptions : maybeOptions;
      const input = normalizeRerankInput(queryOrInput, candidates, options);
      return call('reranker', reranker, input, options, result => normalizeRerankOutput(result, new Set(input.candidates.map(candidate => candidate.id))));
    }
  };
}
