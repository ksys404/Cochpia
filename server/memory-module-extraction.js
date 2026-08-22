import { classifyMemorySensitivity, isSecretMemoryContent } from './memory-module.js';

const rememberPattern = /记住|记得|以后|我喜欢|我不喜欢|我的偏好|remember|i like|i dislike/i;

function heuristicCandidates(event) {
  const content = String(event.content || '').trim();
  if (!rememberPattern.test(content)) return [];
  const sensitivity = classifyMemorySensitivity({ content });
  if (sensitivity === 'S3') return [];
  return [{
    content: content.slice(0, 1000),
    memoryType: sensitivity === 'S1' ? 'state' : 'fact',
    scopeType: 'user',
    sensitivity,
    confidence: 0.62,
    importance: 0.5,
    assertionType: 'observed_fact',
    sourceEventId: event.id,
    extractionMethod: 'heuristic-v1'
  }];
}

function validateCandidate(candidate, event) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const content = String(candidate.content || '').trim().slice(0, 1000);
  if (!content || isSecretMemoryContent(content)) return null;
  const sensitivity = classifyMemorySensitivity({ content, sensitivity: candidate.sensitivity });
  if (!['S0', 'S1', 'S2'].includes(sensitivity)) return null;
  const scopeType = ['user', 'relationship', 'session'].includes(candidate.scopeType) ? candidate.scopeType : 'user';
  if (scopeType === 'relationship' && !String(candidate.relationshipAgentId || '').trim()) return null;
  if (scopeType === 'session' && !String(candidate.sessionId || event.sessionId || '').trim()) return null;
  return {
    content,
    structuredData: candidate.structuredData && typeof candidate.structuredData === 'object' && !Array.isArray(candidate.structuredData) ? candidate.structuredData : {},
    memoryType: String(candidate.memoryType || 'fact').slice(0, 80),
    scopeType,
    relationshipAgentId: candidate.relationshipAgentId || null,
    sessionId: candidate.sessionId || event.sessionId || null,
    sensitivity,
    confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)),
    importance: Math.max(0, Math.min(1, Number(candidate.importance) || 0)),
    assertionType: ['observed_fact', 'inferred_fact', 'relationship_signal'].includes(candidate.assertionType) ? candidate.assertionType : 'observed_fact',
    sourceEventId: event.id,
    extractionMethod: String(candidate.extractionMethod || 'model').slice(0, 80)
  };
}

export async function extractCandidates({ event, modelGateway = null, allowSensitiveModelInput = false } = {}) {
  if (!event || !event.id || !event.content) return { status: 'invalid_event', candidates: [], modelCalled: false };
  if (isSecretMemoryContent(event.content)) return { status: 'blocked_s3', candidates: [], modelCalled: false };
  const eventSensitivity = classifyMemorySensitivity({ content: event.content });
  if (eventSensitivity === 'S2' && !allowSensitiveModelInput) return { status: 'quarantined_sensitive_input', candidates: [], modelCalled: false };
  if (!modelGateway) return { status: 'heuristic', candidates: heuristicCandidates(event).map(candidate => validateCandidate(candidate, event)).filter(Boolean), modelCalled: false };
  if (typeof modelGateway.extract !== 'function') return { status: 'invalid_model_gateway', candidates: [], modelCalled: false };
  const modelResult = await modelGateway.extract({
    eventId: event.id,
    content: event.content,
    eventRole: event.eventRole,
    sessionId: event.sessionId,
    sourceRevision: event.sourceRevision
  }, { allowSensitiveInput: allowSensitiveModelInput });
  const rawCandidates = Array.isArray(modelResult) ? modelResult : modelResult?.candidates;
  if (!Array.isArray(rawCandidates)) return { status: 'quarantined_schema', candidates: [], modelCalled: true };
  const candidates = rawCandidates.slice(0, 10).map(candidate => validateCandidate(candidate, event)).filter(Boolean);
  return { status: 'model', candidates, modelCalled: true };
}
