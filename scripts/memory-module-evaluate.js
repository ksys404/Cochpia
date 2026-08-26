import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateMemoryRetrieval, validateRealMemoryEvaluationInput } from '../server/memory-module-eval.js';

const casesPath = process.env.MEMORY_EVAL_CASES ? path.resolve(process.cwd(), process.env.MEMORY_EVAL_CASES) : null;
const resultsPath = process.env.MEMORY_EVAL_RESULTS ? path.resolve(process.cwd(), process.env.MEMORY_EVAL_RESULTS) : null;
const split = process.env.MEMORY_EVAL_SPLIT || 'all';
const k = Math.max(1, Number(process.env.MEMORY_EVAL_K || 5));

const parseJson = async filePath => JSON.parse(await readFile(filePath, 'utf8'));

async function main() {
  if (!casesPath) {
    throw Object.assign(new Error('Set MEMORY_EVAL_CASES to a real or deidentified 600-case JSON envelope; the synthetic scaffold is not an acceptance input'), { code: 'MEMORY_EVAL_CASES_REQUIRED' });
  }
  if (!resultsPath) {
    throw Object.assign(new Error('Set MEMORY_EVAL_RESULTS to a JSON result envelope; no metrics were generated'), { code: 'MEMORY_EVAL_RESULTS_REQUIRED' });
  }

  const casesPayload = await parseJson(casesPath);
  const resultsPayload = await parseJson(resultsPath);
  const validated = validateRealMemoryEvaluationInput({ casesPayload, resultsPayload, split });
  const metrics = evaluateMemoryRetrieval(validated.cases, validated.results, { k });
  console.log(JSON.stringify({
    event: 'memory_module_evaluation',
    casesPath,
    resultsPath,
    split,
    k,
    version: validated.version,
    datasetKind: validated.datasetKind,
    caseCount: validated.cases.length,
    casesProvenance: validated.casesProvenance,
    resultsProvenance: validated.resultsProvenance,
    metrics
  }));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    event: 'memory_module_evaluation_failed',
    code: error?.code || 'MEMORY_EVAL_FAILED',
    message: error?.message || 'Memory evaluation failed',
    details: error?.details || undefined
  }));
  process.exitCode = 2;
}
