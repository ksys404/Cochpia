import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateMemoryRetrieval } from '../server/memory-module-eval.js';

const casesPath = path.resolve(process.cwd(), process.env.MEMORY_EVAL_CASES || 'docs/memory-module-eval-v0.2.json');
const resultsPath = process.env.MEMORY_EVAL_RESULTS ? path.resolve(process.cwd(), process.env.MEMORY_EVAL_RESULTS) : null;
const split = process.env.MEMORY_EVAL_SPLIT || 'acceptance';
const k = Math.max(1, Number(process.env.MEMORY_EVAL_K || 5));

if (!resultsPath) {
  console.error(JSON.stringify({ event: 'memory_module_evaluation_unavailable', code: 'MEMORY_EVAL_RESULTS_REQUIRED', message: 'Set MEMORY_EVAL_RESULTS to a JSON result file; no metrics were generated.' }));
  process.exit(2);
}

const parseJson = async filePath => JSON.parse(await readFile(filePath, 'utf8'));
const cases = await parseJson(casesPath);
const payload = await parseJson(resultsPath);
const selectedCases = split === 'all' ? cases : cases.filter(item => item.split === split);
const rawResults = Array.isArray(payload) ? payload : payload.results || payload;
const results = Array.isArray(rawResults)
  ? Object.fromEntries(rawResults.filter(item => item?.id).map(item => [item.id, item]))
  : rawResults;

if (!selectedCases.length) throw new Error(`No evaluation cases matched split ${split}`);
const resultRecords = Object.values(results || {});
if (!resultRecords.length || resultRecords.some(item => !item || typeof item !== 'object' || !(
  Object.hasOwn(item, 'items')
  || Object.hasOwn(item, 'answerability')
  || Object.hasOwn(item, 'policyResult')
  || Object.hasOwn(item, 'uncertainties')
  || Object.hasOwn(item, 'error')
))) {
  throw new Error('Evaluation results must contain result records with items, answerability, policyResult, uncertainties, or error');
}
const metrics = evaluateMemoryRetrieval(selectedCases, results, { k });
console.log(JSON.stringify({
  event: 'memory_module_evaluation',
  casesPath,
  resultsPath,
  split,
  k,
  metrics
}));
