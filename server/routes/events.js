import { Router } from 'express';

export function createRouter(deps) {
  const { events, agents, fail, currentUserId } = deps;
  const router = Router();
  const ownerOf = req => req.cochpiaUserId || currentUserId();

  // Agent 绑定可选:传了就必须存在,避免留下指向已删 Agent 的孤儿日程。
  const assertAgentExists = agentId => {
    if (!agentId) return null;
    const normalized = String(agentId).slice(0, 100);
    if (!agents.get(normalized)) {
      throw Object.assign(new Error('The selected agent no longer exists'), { code: 'AGENT_NOT_FOUND', status: 404 });
    }
    return normalized;
  };

  router.get('/api/events', (req, res) => {
    res.json(events.list({ ownerId: ownerOf(req), limit: Number(req.query.limit) || 200 }));
  });

  router.get('/api/events/upcoming', (req, res) => {
    res.json(events.listUpcoming({ ownerId: ownerOf(req), agentId: req.query.agentId ? String(req.query.agentId) : null, days: req.query.days }));
  });

  router.post('/api/events', async (req, res) => {
    try {
      const agentId = assertAgentExists(req.body?.agentId);
      const created = await events.create({ ...(req.body || {}), agentId }, { ownerId: ownerOf(req) });
      res.status(201).json(created);
    } catch (error) {
      fail(res, error.status || 400, error.code || 'INVALID_EVENT', error.message);
    }
  });

  router.patch('/api/events/:id', async (req, res) => {
    try {
      const payload = { ...(req.body || {}) };
      if (payload.agentId !== undefined) payload.agentId = assertAgentExists(payload.agentId);
      const updated = await events.update(req.params.id, payload, { ownerId: ownerOf(req) });
      updated ? res.json(updated) : fail(res, 404, 'EVENT_NOT_FOUND', 'Event not found');
    } catch (error) {
      fail(res, error.status || 400, error.code || 'INVALID_EVENT', error.message);
    }
  });

  router.delete('/api/events/:id', async (req, res) => {
    const removed = await events.remove(req.params.id, { ownerId: ownerOf(req) });
    removed ? res.status(204).end() : fail(res, 404, 'EVENT_NOT_FOUND', 'Event not found');
  });

  return router;
}
