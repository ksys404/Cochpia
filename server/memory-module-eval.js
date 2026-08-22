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

export function evaluateMemoryRetrieval(cases, results, { k = 5 } = {}) {
  const resultMap = asResultMap(results);
  const known = cases.filter(item => (item.expectedMode || 'known') === 'known');
  const noAnswer = cases.filter(item => item.expectedMode === 'no_answer');
  const conflict = cases.filter(item => item.expectedMode === 'conflict');
  const authorization = cases.filter(item => item.expectedMode === 'authorization');
  const ranks = known.map(testCase => rankedHit(testCase, resultMap.get(testCase.id)));
  const hits = ranks.filter(rank => rank >= 0);
  const topKHits = ranks.filter(rank => rank >= 0 && rank < k);
  const reciprocalRanks = ranks.map(rank => rank >= 0 ? 1 / (rank + 1) : 0);
  const ndcg = ranks.map(rank => rank >= 0 && rank < k ? 1 / Math.log2(rank + 2) : 0);
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
    version: cases[0]?.version || null,
    totalCases: cases.length,
    knownCases: known.length,
    recallAtK: topKHits.length / (known.length || 1),
    mrr: average(reciprocalRanks),
    ndcgAtK: average(ndcg),
    noAnswerAccuracy: noAnswerCorrect / (noAnswer.length || 1),
    conflictAccuracy: conflictCorrect / (conflict.length || 1),
    authorizationAccuracy: authorizationCorrect / (authorization.length || 1),
    evidenceSupportRate: known.length ? known.filter(testCase => {
      const result = resultMap.get(testCase.id) || {};
      const rank = rankedHit(testCase, result);
      return rank >= 0 && result.items?.[rank]?.sourceRefs?.length;
    }).length / known.length : 0,
    counts: { hits: hits.length, topKHits: topKHits.length, noAnswerCorrect, conflictCorrect, authorizationCorrect }
  };
}
