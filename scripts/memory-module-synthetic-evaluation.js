import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMemoryModule, createMemoryModuleState } from '../server/memory-module.js';
import { evaluateMemoryRetrieval } from '../server/memory-module-eval.js';

const casesPath = path.resolve(process.cwd(), process.env.MEMORY_EVAL_CASES || 'docs/memory-module-eval-v0.2.json');
const outputPath = path.resolve(process.cwd(), process.env.MEMORY_EVAL_SYNTHETIC_RESULTS || 'docs/memory-module-eval-v0.2-synthetic-results.json');
const tenantId = 'synthetic-eval-tenant';
const userId = 'synthetic-eval-user';

const userContext = (overrides = {}) => ({ tenantId, subjectUserId: userId, actorType: 'user', actorId: userId, ...overrides });
const agentContext = (agentId = 'cochpia', overrides = {}) => ({ tenantId, subjectUserId: userId, actorType: 'agent', actorId: agentId, callerAgentId: agentId, ...overrides });

async function makeMemory(caseItem) {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  const user = userContext();
  const querySignal = caseItem.query.replace(/[^\p{L}\p{N}_-]+/gu, ' ');

  if (caseItem.expectedMode === 'known') {
    if (caseItem.scope === 'relationship') {
      await memory.hold(user, {
        content: `${caseItem.expected} ${querySignal}`,
        memoryType: 'relationship',
        scopeType: 'relationship',
        relationshipAgentId: caseItem.agent || 'cochpia',
        canonicalKey: `synthetic:${caseItem.expected}`
      });
    } else {
      await memory.hold(user, { content: `${caseItem.expected} ${querySignal}`, memoryType: caseItem.category, canonicalKey: `synthetic:${caseItem.expected}` });
    }
  } else if (caseItem.expectedMode === 'conflict') {
    const canonicalKey = `synthetic:${caseItem.expected}`;
    await memory.hold(user, { content: `${caseItem.expected}:old ${querySignal}`, canonicalKey });
    await memory.hold(user, { content: `${caseItem.expected}:new ${querySignal}`, canonicalKey });
  } else if (caseItem.expectedMode === 'authorization') {
    if (caseItem.query.includes('cross_agent')) {
      await memory.hold(user, { content: 'synthetic-cross_agent-secret', scopeType: 'relationship', relationshipAgentId: 'other-agent', memoryType: 'relationship' });
    } else if (caseItem.query.includes('missing_grant')) {
      await memory.hold(user, { content: 'synthetic-missing_grant-secret', memoryType: 'fact' });
    } else if (caseItem.query.includes('forged_user')) {
      await memory.hold(userContext({ subjectUserId: 'other-user', actorId: 'other-user' }), { content: 'synthetic-forged_user-secret', memoryType: 'fact' });
    } else {
      await memory.hold(userContext({ tenantId: 'other-tenant', subjectUserId: 'other-user', actorId: 'other-user' }), { content: `synthetic-${caseItem.expected}-secret`, memoryType: 'fact' });
    }
  }

  const context = caseItem.expectedMode === 'authorization' && (caseItem.query.includes('cross_agent') || caseItem.query.includes('missing_grant'))
    ? agentContext('cochpia')
    : caseItem.scope === 'relationship' ? agentContext(caseItem.agent || 'cochpia') : userContext();
  const result = memory.retrieve(context, { query: caseItem.query, purpose: 'answer_user_query' });
  return {
    answerability: result.answerability,
    policyResult: result.policyResult,
    items: result.items.map(item => ({
      memoryId: item.memoryId,
      versionId: item.versionId,
      content: item.content,
      sourceRefs: item.sourceRefs,
      scope: item.scope
    })),
    uncertainties: result.uncertainties || []
  };
}

const cases = JSON.parse(await readFile(casesPath, 'utf8'));
if (!Array.isArray(cases) || cases.length !== 600 || cases.some(item => item.synthetic !== true)) throw new Error('Synthetic evaluation requires the versioned 600-case synthetic scaffold');

const results = {};
for (const caseItem of cases) results[caseItem.id] = await makeMemory(caseItem);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({ version: 'v0.2', synthetic: true, acceptanceReady: false, results }, null, 2)}\n`);

const metrics = evaluateMemoryRetrieval(cases, results, { k: 5 });
console.log(JSON.stringify({
  event: 'memory_module_synthetic_evaluation',
  casesPath,
  resultsPath: outputPath,
  synthetic: true,
  acceptanceReady: false,
  metrics
}));
