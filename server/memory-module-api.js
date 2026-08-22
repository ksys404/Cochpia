import express from 'express';
import { randomUUID } from 'node:crypto';
import { MemoryModuleError } from './memory-module.js';

function sendError(res, error, requestId) {
  const isMemoryError = error instanceof MemoryModuleError;
  const code = isMemoryError ? error.code : error.code || 'MEMORY_MODULE_ERROR';
  const status = isMemoryError ? error.status : error.status || 500;
  const message = isMemoryError || code === 'MEMORY_STORAGE_CONFLICT' ? error.message : 'Memory Module request failed';
  res.status(status).json({
    error: {
      code,
      message,
      request_id: requestId,
      retryable: Boolean(error.retryable),
      retry_after_ms: null,
      current_resource_revision: isMemoryError ? error.currentResourceRevision : null
    }
  });
}

function bodyOrQuery(req) {
  return req.method === 'GET' ? req.query : (req.body || {});
}

function mutationInput(req) {
  const body = bodyOrQuery(req) || {};
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = body.idempotencyKey ?? body.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) {
    throw new MemoryModuleError('IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match', { status: 400 });
  }
  const key = headerKey || bodyKey;
  return key ? { ...body, idempotency_key: key } : body;
}

export function createMemoryModuleRouter({ memoryModuleForRequest, contextFromRequest }) {
  if (typeof memoryModuleForRequest !== 'function' || typeof contextFromRequest !== 'function') throw new TypeError('Memory Module router requires memoryModuleForRequest and contextFromRequest');
  const router = express.Router();
  const run = (handler, { status = 200 } = {}) => async (req, res) => {
    const requestId = req.requestId || randomUUID();
    try {
      const requestContext = contextFromRequest(req) || {};
      const result = await handler(await memoryModuleForRequest(req), { ...requestContext, requestId }, req);
      return res.status(status).json(result);
    } catch (error) {
      return sendError(res, error, requestId);
    }
  };

  router.post('/events', run((memory, context, req) => memory.recordEvent(context, req.body || {}), { status: 202 }));
  router.post('/sessions', run((memory, context, req) => memory.createSession(context, mutationInput(req)), { status: 201 }));
  router.post('/access-grants', run((memory, context, req) => memory.grantUserScope(context, mutationInput(req)), { status: 201 }));
  router.post('/memories', run((memory, context, req) => memory.hold(context, mutationInput(req)), { status: 201 }));
  router.get('/memories', run((memory, context, req) => memory.list(context, { ...bodyOrQuery(req), returnPage: true })));
  router.post('/retrieve', run((memory, context, req) => (memory.retrieveAsync || memory.retrieve).call(memory, context, req.body || {})));
  router.post('/context-bundles', run((memory, context, req) => (memory.contextBundleAsync || memory.contextBundle).call(memory, context, req.body || {})));
  router.get('/confirmations', run((memory, context, req) => memory.listConfirmations(context, { ...(req.query || {}), returnPage: true })));
  router.get('/deletion-operations/:id', run((memory, context, req) => {
    const operation = memory.getDeletionOperation(context, req.params.id);
    if (!operation) throw new MemoryModuleError('DELETION_OPERATION_NOT_FOUND', 'Deletion operation not found', { status: 404 });
    return operation;
  }));

  router.get('/memories/:id', run((memory, context, req) => {
    const item = memory.get(context, req.params.id, { purpose: req.query.purpose });
    if (!item) throw new MemoryModuleError('MEMORY_NOT_FOUND', 'Memory not found', { status: 404 });
    return item;
  }));
  router.post('/memories/:id/correct', run((memory, context, req) => memory.correct(context, req.params.id, mutationInput(req))));
  router.post('/memories/:id/promote', run((memory, context, req) => memory.promoteCandidate(context, req.params.id, mutationInput(req))));
  router.post('/memories/:id/pin', run((memory, context, req) => memory.pin(context, req.params.id, mutationInput(req))));
  router.post('/memories/:id/unpin', run((memory, context, req) => memory.unpin(context, req.params.id, mutationInput(req))));
  router.post('/memories/:id/revoke', run((memory, context, req) => memory.revoke(context, req.params.id, mutationInput(req))));
  router.post('/memories/:id/forget', run((memory, context, req) => memory.forget(context, req.params.id, mutationInput(req))));
  router.post('/governance/forget', run((memory, context, req) => {
    const body = mutationInput(req);
    if (body.target_type === 'source_event') return memory.forgetSourceEvent(context, body.target_id, body);
    if (body.target_type === 'session') return memory.forgetSession(context, body.target_id, body);
    if (body.target_type === 'relationship') return memory.forgetRelationship(context, body.target_id, body);
    if (body.target_type === 'account') return memory.forgetAccount(context, body);
    throw new MemoryModuleError('UNSUPPORTED_GOVERNANCE_TARGET', 'Unsupported forget target', { status: 400 });
  }));
  router.post('/governance/delete', run((memory, context, req) => {
    const body = mutationInput(req);
    if (body.target_type === 'source_event') return memory.deleteSourceEvent(context, body.target_id, body);
    if (body.target_type === 'session') return memory.deleteSession(context, body.target_id, body);
    if (body.target_type === 'relationship') return memory.deleteRelationship(context, body.target_id, body);
    if (body.target_type === 'account') return memory.deleteAccount(context, body);
    throw new MemoryModuleError('UNSUPPORTED_GOVERNANCE_TARGET', 'Unsupported delete target', { status: 400 });
  }));
  router.delete('/memories/:id', run((memory, context, req) => memory.remove(context, req.params.id, mutationInput(req))));
  router.post('/confirmations/:id/confirm', run((memory, context, req) => memory.confirm(context, req.params.id, mutationInput(req))));
  router.post('/confirmations/:id/reject', run((memory, context, req) => memory.reject(context, req.params.id, mutationInput(req))));
  router.post('/access-confirmations/:id/confirm', run((memory, context, req) => memory.confirmAccess(context, req.params.id, mutationInput(req))));
  router.post('/mentions', run((memory, context, req) => memory.recordMention(context, mutationInput(req))));
  router.post('/sessions/:id/current-state', run((memory, context, req) => memory.writeCurrentState(context, { ...mutationInput(req), sessionId: req.params.id })));

  return router;
}
