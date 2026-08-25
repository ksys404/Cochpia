export const SENSITIVITY_LEVELS = Object.freeze(['S0', 'S1', 'S2', 'S3']);

const sensitivityRank = { S0: 0, S1: 1, S2: 2, S3: 3 };

export function detectS3(content) {
  const text = String(content || '');
  return /(?:sk|rk)-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b\d{13,19}\b|\b\d{3}-\d{2}-\d{4}\b/i.test(text);
}

export function containsS3Content(value) {
  if (typeof value === 'string') return detectS3(value);
  if (Array.isArray(value)) return value.some(containsS3Content);
  if (value && typeof value === 'object') return Object.values(value).some(containsS3Content);
  return false;
}

export function contentCarrierHasS3(input = {}) {
  return containsS3Content([
    input.content,
    input.summary,
    input.value,
    input.structuredData,
    input.structured_data,
    input.proposedContent,
    input.proposed_content
  ]);
}

function canonicalizeFingerprint(value) {
  if (Array.isArray(value)) return value.map(canonicalizeFingerprint);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['idempotency_key', 'idempotencyKey', 'tenant_id', 'tenantId', 'user_id', 'userId'].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeFingerprint(item)]));
  }
  return value;
}

export function fingerprintForMutation(input, context, resourceId = null) {
  return JSON.stringify(canonicalizeFingerprint({
    actor: { actorType: context.actorType, actorId: context.actorId, callerAgentId: context.callerAgentId },
    resourceId: resourceId || null,
    request: input || {}
  }));
}

function detectS2(content) {
  return /健康|创伤|病史|诊断|医疗|药物|性取向|性生活|银行卡|财务|收入|债务|身份证|家庭冲突|trauma|diagnos|medical|medication|sexual|bank account|finance|income|debt|identity document/i.test(String(content || ''));
}

const maxSensitivity = (left, right) => sensitivityRank[left] >= sensitivityRank[right] ? left : right;

export function classifySensitivity(input = {}) {
  const requested = SENSITIVITY_LEVELS.includes(input.sensitivity) ? input.sensitivity : 'S0';
  if (detectS3(input.content)) return 'S3';
  if (detectS2(input.content)) return maxSensitivity(requested, 'S2');
  return requested;
}

export function classifyMemorySensitivity(input) {
  return classifySensitivity(input);
}

export function isSecretMemoryContent(content) {
  return detectS3(content);
}
