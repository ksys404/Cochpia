export const REAL_MEMORY_EVALUATION_CASE_COUNT = 600;
export const REAL_MEMORY_EVALUATION_DATASET_KINDS = Object.freeze(['real', 'deidentified']);

export class MemoryEvaluationInputError extends Error {
  constructor(message, { code = 'MEMORY_EVAL_INPUT_INVALID', details = {} } = {}) {
    super(message);
    this.name = 'MemoryEvaluationInputError';
    this.code = code;
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasMeaningfulMetadata(value) {
  return Object.values(value).some(entry => {
    if (entry == null) return false;
    if (typeof entry === 'string') return entry.trim().length > 0;
    if (Array.isArray(entry)) return entry.length > 0;
    if (isRecord(entry)) return Object.keys(entry).length > 0;
    return true;
  });
}

function failInput(message, code = 'MEMORY_EVAL_INPUT_INVALID', details = {}) {
  throw new MemoryEvaluationInputError(message, { code, details });
}

function validateDatasetMetadata(payload, label) {
  if (!isRecord(payload)) {
    failInput(`${label} must be a JSON object envelope; bare arrays are not accepted for real evaluation`);
  }
  if (!REAL_MEMORY_EVALUATION_DATASET_KINDS.includes(payload.datasetKind)) {
    failInput(`${label}.datasetKind must be "real" or "deidentified"`);
  }
  if (payload.synthetic !== false) {
    failInput(`${label}.synthetic must be false; synthetic inputs cannot produce Alpha evaluation metrics`);
  }
  if (typeof payload.version !== 'string' || !payload.version.trim()) {
    failInput(`${label}.version must be a non-empty string`);
  }
  if (!isRecord(payload.provenance) || !hasMeaningfulMetadata(payload.provenance)) {
    failInput(`${label}.provenance must be a non-empty metadata object`);
  }
  return {
    datasetKind: payload.datasetKind,
    synthetic: false,
    version: payload.version,
    provenance: payload.provenance
  };
}

export function validateRealMemoryEvaluationCases(payload) {
  const metadata = validateDatasetMetadata(payload, 'evaluation cases');
  if (!Array.isArray(payload.cases)) {
    failInput('evaluation cases.cases must be an array of exactly 600 cases');
  }
  if (payload.cases.length !== REAL_MEMORY_EVALUATION_CASE_COUNT) {
    failInput(
      `evaluation cases.cases must contain exactly ${REAL_MEMORY_EVALUATION_CASE_COUNT} cases`,
      'MEMORY_EVAL_CASE_COUNT_INVALID',
      { expected: REAL_MEMORY_EVALUATION_CASE_COUNT, actual: payload.cases.length }
    );
  }

  const caseIds = new Set();
  payload.cases.forEach((item, index) => {
    if (!isRecord(item)) failInput(`evaluation cases.cases[${index}] must be an object`);
    if (typeof item.id !== 'string' || !item.id.trim()) {
      failInput(`evaluation cases.cases[${index}].id must be a non-empty string`);
    }
    if (caseIds.has(item.id)) {
      failInput(`evaluation cases contains duplicate case id at index ${index}`, 'MEMORY_EVAL_CASE_IDS_INVALID');
    }
    caseIds.add(item.id);
    if (item.synthetic !== false) {
      failInput(`evaluation cases.cases[${index}].synthetic must be false`);
    }
    if (item.version !== metadata.version) {
      failInput(`evaluation cases.cases[${index}].version must match the envelope version`);
    }
  });

  return {
    ...metadata,
    cases: payload.cases,
    caseIds
  };
}

function isUsableResultRecord(item) {
  return isRecord(item) && (
    Object.hasOwn(item, 'items')
    || Object.hasOwn(item, 'answerability')
    || Object.hasOwn(item, 'policyResult')
    || Object.hasOwn(item, 'uncertainties')
    || Object.hasOwn(item, 'error')
  );
}

function normalizeEvaluationResults(rawResults) {
  if (Array.isArray(rawResults)) {
    const resultMap = new Map();
    rawResults.forEach((item, index) => {
      if (!isRecord(item)) failInput(`evaluation results.results[${index}] must be an object`);
      if (typeof item.id !== 'string' || !item.id.trim()) {
        failInput(`evaluation results.results[${index}].id must be a non-empty string`);
      }
      if (resultMap.has(item.id)) {
        failInput(`evaluation results contains duplicate result id at index ${index}`, 'MEMORY_EVAL_RESULT_IDS_INVALID');
      }
      if (item.synthetic === true) {
        failInput(`evaluation results.results[${index}].synthetic cannot be true`);
      }
      if (!isUsableResultRecord(item)) {
        failInput(`evaluation results.results[${index}] must contain a result record`);
      }
      resultMap.set(item.id, item);
    });
    return resultMap;
  }

  if (!isRecord(rawResults)) {
    failInput('evaluation results.results must be an object map or an array of records');
  }
  const resultMap = new Map();
  for (const [id, item] of Object.entries(rawResults)) {
    if (!id.trim()) failInput('evaluation results contains an empty result id', 'MEMORY_EVAL_RESULT_IDS_INVALID');
    if (item?.synthetic === true) failInput(`evaluation results.results[${id}] cannot have synthetic=true`);
    if (!isUsableResultRecord(item)) {
      failInput(`evaluation results.results[${id}] must contain a result record`);
    }
    resultMap.set(id, item);
  }
  return resultMap;
}

export function validateRealMemoryEvaluationResults(payload, { expectedVersion, expectedDatasetKind } = {}) {
  const metadata = validateDatasetMetadata(payload, 'evaluation results');
  if (expectedVersion && metadata.version !== expectedVersion) {
    failInput('evaluation results.version must match evaluation cases.version', 'MEMORY_EVAL_VERSION_MISMATCH');
  }
  if (expectedDatasetKind && metadata.datasetKind !== expectedDatasetKind) {
    failInput('evaluation results.datasetKind must match evaluation cases.datasetKind', 'MEMORY_EVAL_DATASET_KIND_MISMATCH');
  }
  if (!Object.hasOwn(payload, 'results')) {
    failInput('evaluation results must provide a results field');
  }
  return {
    ...metadata,
    resultMap: normalizeEvaluationResults(payload.results)
  };
}

export function validateRealMemoryEvaluationInput({ casesPayload, resultsPayload, split = 'all' } = {}) {
  if (split !== 'all') {
    failInput('real/deidentified evaluation requires MEMORY_EVAL_SPLIT=all', 'MEMORY_EVAL_SPLIT_INVALID', { split });
  }
  const cases = validateRealMemoryEvaluationCases(casesPayload);
  const results = validateRealMemoryEvaluationResults(resultsPayload, {
    expectedVersion: cases.version,
    expectedDatasetKind: cases.datasetKind
  });
  const missingCaseIds = [...cases.caseIds].filter(id => !results.resultMap.has(id));
  const extraResultIds = [...results.resultMap.keys()].filter(id => !cases.caseIds.has(id));
  if (missingCaseIds.length || extraResultIds.length) {
    failInput(
      'evaluation results must contain exactly one record for every case',
      'MEMORY_EVAL_RESULT_COVERAGE_INVALID',
      { missingCount: missingCaseIds.length, extraCount: extraResultIds.length }
    );
  }
  return {
    cases: cases.cases,
    results: results.resultMap,
    version: cases.version,
    datasetKind: cases.datasetKind,
    casesProvenance: cases.provenance,
    resultsProvenance: results.provenance
  };
}

export const validateMemoryEvaluationInput = validateRealMemoryEvaluationInput;

function asResultMap(results) {
  if (results instanceof Map) return results;
  return new Map(Object.entries(results || {}));
}

function resultText(item) {
  return [item?.content, item?.summary, item?.displayText, item?.memoryId, item?.versionId]
    .filter(value => value != null)
    .join(' ')
    .toLowerCase();
}

function expectedText(item) {
  return String(item.expected || '').toLowerCase();
}

function rankedHit(testCase, result) {
  const expected = expectedText(testCase);
  return (result?.items || []).findIndex(item => resultText(item).includes(expected));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function knownMetrics(testCases, resultMap, { k = 5 } = {}) {
  const known = testCases.filter(item => (item.expectedMode || 'known') === 'known');
  const ranks = known.map(testCase => rankedHit(testCase, resultMap.get(testCase.id)));
  const hits = ranks.filter(rank => rank >= 0);
  const topKHits = ranks.filter(rank => rank >= 0 && rank < k);
  const top10Hits = ranks.filter(rank => rank >= 0 && rank < 10);
  const reciprocalRanks = ranks.map(rank => rank >= 0 ? 1 / (rank + 1) : 0);
  const ndcg = ranks.map(rank => rank >= 0 && rank < k ? 1 / Math.log2(rank + 2) : 0);
  const evidenceSupported = known.filter(testCase => {
    const result = resultMap.get(testCase.id) || {};
    const rank = rankedHit(testCase, result);
    return rank >= 0 && result.items?.[rank]?.sourceRefs?.length;
  }).length;
  return {
    totalCases: testCases.length,
    knownCases: known.length,
    recallAtK: rate(topKHits.length, known.length),
    recallAt10: rate(top10Hits.length, known.length),
    mrr: average(reciprocalRanks),
    ndcgAtK: average(ndcg),
    evidenceSupportRate: rate(evidenceSupported, known.length),
    counts: { hits: hits.length, topKHits: topKHits.length, top10Hits: top10Hits.length, evidenceSupported }
  };
}

function governanceAccuracy(testCases, resultMap) {
  const noAnswer = testCases.filter(item => item.expectedMode === 'no_answer');
  const conflict = testCases.filter(item => item.expectedMode === 'conflict');
  const authorization = testCases.filter(item => item.expectedMode === 'authorization');
  const noAnswerCorrect = noAnswer.filter(testCase => {
    const result = resultMap.get(testCase.id) || {};
    return result.answerability === 'not_found' || (result.answerability === 'filtered' && !(result.items || []).length) || !(result.items || []).length;
  }).length;
  const conflictCorrect = conflict.filter(testCase => {
    const result = resultMap.get(testCase.id) || {};
    return result.answerability === 'conflict' || (result.uncertainties || []).length > 0;
  }).length;
  const authorizationCorrect = authorization.filter(testCase => {
    const result = resultMap.get(testCase.id) || {};
    return result.policyResult === 'forbidden'
      || result.policyResult === 'filtered'
      || ['FORBIDDEN', 'SCOPE_FORBIDDEN', 'TENANT_CONTEXT_MISMATCH', 'USER_CONTEXT_MISMATCH'].includes(result.error?.code)
      || (result.answerability === 'not_found' && Array.isArray(result.items) && result.items.length === 0);
  }).length;
  return {
    noAnswerAccuracy: rate(noAnswerCorrect, noAnswer.length),
    conflictAccuracy: rate(conflictCorrect, conflict.length),
    authorizationAccuracy: rate(authorizationCorrect, authorization.length),
    scopeAccuracy: rate(authorizationCorrect, authorization.length),
    counts: { noAnswerCorrect, conflictCorrect, authorizationCorrect }
  };
}

function sensitivityGateMetrics(cases, resultMap) {
  const gated = cases.filter(item => ['S2', 'S3'].includes(String(item.sensitivity || item.expectedSensitivity || '').toUpperCase()));
  const hidden = gated.filter(item => item.expectedMode !== 'known' || item.shouldBeHidden === true);
  const leaked = hidden.filter(item => (resultMap.get(item.id)?.items || []).length > 0).length;
  return {
    available: gated.length > 0,
    cases: gated.length,
    hiddenCases: hidden.length,
    falseNegativeCount: leaked,
    falseNegativeRate: rate(leaked, hidden.length)
  };
}

function mentionMetrics(cases, resultMap) {
  const mentionCases = cases.filter(item => typeof item.expectedMention === 'boolean' || typeof item.mentionExpected === 'boolean');
  const observations = mentionCases.map(item => {
    const result = resultMap.get(item.id) || {};
    const expected = item.expectedMention ?? item.mentionExpected;
    const observed = Boolean(result.mentioned ?? result.proactiveMentioned ?? result.mentionRecorded);
    return { expected, observed };
  });
  const truePositive = observations.filter(item => item.expected && item.observed).length;
  const predictedPositive = observations.filter(item => item.observed).length;
  const actualPositive = observations.filter(item => item.expected).length;
  return {
    available: observations.length > 0,
    cases: observations.length,
    precision: rate(truePositive, predictedPositive),
    recall: rate(truePositive, actualPositive),
    truePositive,
    falsePositive: observations.filter(item => !item.expected && item.observed).length,
    falseNegative: observations.filter(item => item.expected && !item.observed).length
  };
}

export function evaluateMemoryRetrieval(cases, results, { k = 5 } = {}) {
  const resultMap = asResultMap(results);
  const known = knownMetrics(cases, resultMap, { k });
  const governance = governanceAccuracy(cases, resultMap);
  const categories = [...new Set(cases.map(item => item.category).filter(Boolean))];
  const categoryMetrics = Object.fromEntries(categories.map(category => {
    const categoryCases = cases.filter(item => item.category === category);
    const categoryKnown = knownMetrics(categoryCases, resultMap, { k });
    const categoryGovernance = governanceAccuracy(categoryCases, resultMap);
    return [category, {
      ...categoryKnown,
      noAnswerAccuracy: categoryGovernance.noAnswerAccuracy,
      conflictAccuracy: categoryGovernance.conflictAccuracy,
      authorizationAccuracy: categoryGovernance.authorizationAccuracy,
      scopeAccuracy: categoryGovernance.scopeAccuracy
    }];
  }));
  return {
    version: cases[0]?.version || null,
    totalCases: cases.length,
    knownCases: known.knownCases,
    recallAtK: known.recallAtK,
    recallAt10: known.recallAt10,
    mrr: known.mrr,
    ndcgAtK: known.ndcgAtK,
    noAnswerAccuracy: governance.noAnswerAccuracy,
    conflictAccuracy: governance.conflictAccuracy,
    authorizationAccuracy: governance.authorizationAccuracy,
    scopeAccuracy: governance.scopeAccuracy,
    evidenceSupportRate: known.evidenceSupportRate,
    categoryMetrics,
    sensitivityS2S3: sensitivityGateMetrics(cases, resultMap),
    proactiveMention: mentionMetrics(cases, resultMap),
    counts: { ...known.counts, ...governance.counts }
  };
}
