import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { checkRecoveryState } from '../server/memory-module-recovery-check.js';

const statePath = process.env.MEMORY_RECOVERY_STATE;
const ledgerPath = process.env.MEMORY_RECOVERY_LEDGER;

if (!statePath || !ledgerPath) {
  console.log(JSON.stringify({ event: 'memory_module_recovery_check_skipped', reason: 'MEMORY_RECOVERY_STATE_and_MEMORY_RECOVERY_LEDGER_required' }));
  process.exit(0);
}

const parseJson = async path => JSON.parse(await readFile(path, 'utf8'));
const normalizeState = value => value?.state && typeof value.state === 'object' ? value.state : value;
const normalizeLedger = value => Array.isArray(value) ? value : value?.tombstones || value?.entries || [];

try {
  const state = normalizeState(await parseJson(statePath));
  const ledger = normalizeLedger(await parseJson(ledgerPath));
  const result = checkRecoveryState(state, ledger);
  console.log(JSON.stringify({ event: 'memory_module_recovery_check_passed', statePath, ledgerPath, ...result }));
} catch (error) {
  console.error(JSON.stringify({ event: 'memory_module_recovery_check_failed', code: error.code || 'MEMORY_RECOVERY_CHECK_FAILED', message: error.message }));
  process.exitCode = 1;
}
