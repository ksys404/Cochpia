import { Router } from 'express';

// 与记忆模块 toLegacyMemory 的可见性规则保持一致:这些状态下的记忆正文不再交还,
// 否则用户此前「忘记/撤销」过的内容会借导出重新暴露。
export const HIDDEN_MEMORY_STATUSES = Object.freeze(['revoked', 'forgotten', 'deleted', 'rejected', 'expired', 'superseded']);
// 纯内部标记,不属于「我们持有的关于你的数据」。
const INTERNAL_STATE_KEYS = ['__userId'];
const ERASURE_BLOCKING_CODES = new Set(['ACCOUNT_USER_ID_REQUIRED', 'ACCOUNT_LOCAL_NOT_ERASABLE', 'ACCOUNT_ERASURE_UNSUPPORTED']);

/** 把隐藏状态记忆的正文抹掉,保留结构与元数据(仅拷贝被改动的字段,不改动入参)。 */
export function redactHiddenMemoryContent(memoryModule) {
  if (!memoryModule || typeof memoryModule !== 'object') return memoryModule;
  const assertions = Array.isArray(memoryModule.assertions) ? memoryModule.assertions : [];
  const hiddenIds = new Set(assertions.filter(item => HIDDEN_MEMORY_STATUSES.includes(item.status)).map(item => item.id));
  if (!hiddenIds.size) return memoryModule;
  const versions = Array.isArray(memoryModule.assertionVersions) ? memoryModule.assertionVersions : [];
  return {
    ...memoryModule,
    assertionVersions: versions.map(version => hiddenIds.has(version.assertionId) ? { ...version, content: null, redacted: true } : version)
  };
}

const visibleMemoryCount = memoryModule => {
  const assertions = Array.isArray(memoryModule?.assertions) ? memoryModule.assertions : [];
  return assertions.filter(item => !HIDDEN_MEMORY_STATUSES.includes(item.status)).length;
};

const summarize = snapshot => ({
  sessions: Array.isArray(snapshot.sessions) ? snapshot.sessions.length : 0,
  messages: Object.values(snapshot.messages || {}).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0),
  agents: Array.isArray(snapshot.agents) ? snapshot.agents.length : 0,
  events: Array.isArray(snapshot.events) ? snapshot.events.length : 0,
  evidence: Array.isArray(snapshot.evidence) ? snapshot.evidence.length : 0,
  memories: visibleMemoryCount(snapshot.memoryModule)
});

export function createRouter(deps) {
  const { state, fail, currentUserId, compatibilityMemoryForRequest, deleteUserState, storageProvider } = deps;
  const router = Router();
  const ownerOf = req => req.cochpiaUserId || currentUserId();

  // 账号级完整导出:不挑字段,把该用户名下的整个状态原样交还(隐藏记忆的正文除外)。
  router.get('/api/account/export', (req, res) => {
    const userId = ownerOf(req);
    const snapshot = { ...state };
    for (const key of INTERNAL_STATE_KEYS) delete snapshot[key];
    if (snapshot.memoryModule) snapshot.memoryModule = redactHiddenMemoryContent(snapshot.memoryModule);
    res.set('Content-Disposition', 'attachment; filename="cochpia-account.json"');
    res.json({ exportedAt: new Date().toISOString(), version: 2, userId, storageProvider, summary: summarize(snapshot), state: snapshot });
  });

  // 账号级擦除。必须显式 confirm —— 这个接口不可撤销,不能被一次手滑的 DELETE 打中。
  router.delete('/api/account', async (req, res) => {
    const userId = ownerOf(req);
    const confirm = String(req.query.confirm ?? req.body?.confirm ?? '').trim();
    if (confirm !== 'erase' && confirm !== userId) {
      return fail(res, 400, 'ACCOUNT_ERASE_CONFIRMATION_REQUIRED', 'Pass confirm=erase to acknowledge that this permanently erases every record held for this account');
    }
    const mode = req.query.mode === 'forget' ? 'forget' : 'delete';
    // 治理记录(墓碑 / deletionOperation / redactionEpoch)是「尽力而为」:
    // 它提供可审计的删除凭证,但即使失败也不能挡住宿主真正抹掉数据。
    const memory = { ok: false, mode, deletionOperationId: null, status: null, redactionEpoch: null, code: null };
    try {
      const memoryRuntime = compatibilityMemoryForRequest(req);
      const receipt = mode === 'forget' ? await memoryRuntime.forgetAccount({}) : await memoryRuntime.deleteAccount({});
      Object.assign(memory, { ok: true, deletionOperationId: receipt?.deletionOperationId || null, status: receipt?.status || null, redactionEpoch: receipt?.redactionEpoch ?? null });
    } catch (error) {
      memory.code = error.code || 'MEMORY_GOVERNANCE_FAILED';
      console.error(JSON.stringify({ event: 'account_erase_memory_failed', mode, code: memory.code }));
    }
    try {
      const storage = await deleteUserState(userId);
      const receipt = { ok: true, userId, mode, deletedAt: new Date().toISOString(), memory, storage };
      console.log(JSON.stringify({ event: 'account_erased', mode, memoryGovernanceRecorded: memory.ok, memoryDeletionId: memory.deletionOperationId, storage }));
      res.json(receipt);
    } catch (error) {
      fail(res, ERASURE_BLOCKING_CODES.has(error.code) ? 409 : 500, error.code || 'ACCOUNT_ERASURE_FAILED', error.message);
    }
  });

  return router;
}
