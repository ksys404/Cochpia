#!/usr/bin/env node
// 一次性回填:把 importance 缺失 / 为 0 的历史记忆按内容重新判定。
//
// 背景:两条 legacy 导入路径都把 item.importance 原样传给 hold(),
// 而老记忆没有这个字段 → clamp(undefined, 0, 1) = 0。
// 结果是一批记忆被永久打成「毫无价值」,后续的生命周期 / Room 准入门槛会直接把它们筛掉。
//
// 默认 dry-run(只打印分布,不写库);加 --apply 才写回。
// ⚠️ 必须在服务停止时执行:服务内存里有 userStateCache,跑着的实例会把旧值刷回去。
//
//   node scripts/backfill-memory-importance.js                 # 预览
//   node scripts/backfill-memory-importance.js --apply         # 写回
//   node scripts/backfill-memory-importance.js --include-constants  # 连旧常量 0.5/0.6 一起重算
import 'dotenv/config';
import { Pool } from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';
import { assessMemoryImportance, levelForScore, IMPORTANCE_RETAIN_THRESHOLD } from '../server/memory-importance.js';

const APPLY = process.argv.includes('--apply');
const INCLUDE_CONSTANTS = process.argv.includes('--include-constants');
// v1 时期写死的两个常量值,不是真实判定结果。
const LEGACY_CONSTANTS = new Set([0.5, 0.6]);
const MISSING_VALUE = Symbol('missing');

const needsRescore = value => {
  if (value === MISSING_VALUE || value === null || value === undefined || value === '') return true;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return true;
  return INCLUDE_CONSTANTS && LEGACY_CONSTANTS.has(number);
};

const histogram = counts => Object.entries(counts)
  .sort(([left], [right]) => Number(left) - Number(right))
  .map(([key, count]) => `${key}×${count}`)
  .join('  ');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 未配置,无法回填。');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: resolveDbSsl(), max: 2, connectionTimeoutMillis: 10_000 });
const rows = (await pool.query("SELECT user_id, state FROM cochpia_user_states WHERE state ? 'memoryModule'")).rows;

const before = {};
const after = {};
let scanned = 0;
let rescored = 0;
const samples = [];

for (const row of rows) {
  const module = row.state?.memoryModule;
  const assertions = Array.isArray(module?.assertions) ? module.assertions : [];
  if (!assertions.length) continue;
  const versions = new Map((module.assertionVersions || []).map(version => [version.id, version]));
  let changed = 0;

  for (const assertion of assertions) {
    scanned += 1;
    const original = 'importance' in assertion ? assertion.importance : MISSING_VALUE;
    const key = original === MISSING_VALUE ? '缺失' : String(original);
    before[key] = (before[key] || 0) + 1;

    if (needsRescore(original)) {
      const content = versions.get(assertion.currentVersionId)?.content || '';
      const assessment = assessMemoryImportance(content, { memoryType: assertion.memoryType });
      assertion.importance = assessment.score;
      changed += 1;
      if (samples.length < 5) samples.push({ from: key, to: assessment.score, level: assessment.level, content: content.slice(0, 40) });
    }
    const next = 'importance' in assertion ? String(assertion.importance) : '缺失';
    after[next] = (after[next] || 0) + 1;
  }

  if (changed) {
    rescored += changed;
    if (APPLY) {
      await pool.query('UPDATE cochpia_user_states SET state = $2::jsonb, updated_at = now() WHERE user_id = $1', [row.user_id, JSON.stringify(row.state)]);
    }
  }
}

console.log(`模式: ${APPLY ? '写回(--apply)' : '预览(dry-run)'}${INCLUDE_CONSTANTS ? ' + 重算旧常量' : ''}`);
console.log(`扫描记忆: ${scanned} 条,需要重算: ${rescored} 条`);
console.log(`  回填前 importance: ${histogram(before)}`);
console.log(`  回填后 importance: ${histogram(after)}`);
if (samples.length) {
  console.log('  样例:');
  for (const sample of samples) console.log(`    ${sample.from} → ${sample.to} (${sample.level})  ${sample.content}`);
}
const retainable = Object.entries(after).reduce((total, [key, count]) => total + (Number(key) >= IMPORTANCE_RETAIN_THRESHOLD ? count : 0), 0);
console.log(`  达到长期保留线(${IMPORTANCE_RETAIN_THRESHOLD})的记忆: ${retainable} 条`);
await pool.end();
if (!APPLY && rescored) console.log('\n确认无误后加 --apply 写回(请先停掉服务)。');
