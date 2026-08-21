import { randomUUID } from 'node:crypto';

export function createRateLimiter({ windowMs = 60_000, max = 120, now = () => Date.now() } = {}) {
  const buckets = new Map();
  return {
    consume(key) {
      const current = now();
      const bucket = buckets.get(key);
      if (!bucket || current - bucket.startedAt >= windowMs) {
        buckets.set(key, { startedAt: current, count: 1 });
        return { allowed: true, remaining: Math.max(0, max - 1), retryAfterMs: 0 };
      }
      bucket.count += 1;
      const allowed = bucket.count <= max;
      return { allowed, remaining: Math.max(0, max - bucket.count), retryAfterMs: Math.max(0, windowMs - (current - bucket.startedAt)) };
    },
    clear() { buckets.clear(); }
  };
}

export function createObservability({ rateLimitMax = 120, logger = console } = {}) {
  const rateLimiter = createRateLimiter({ max: rateLimitMax });
  const metrics = { requests: 0, errors: 0, rateLimited: 0, totalLatencyMs: 0 };
  const middleware = (req, res, next) => {
    const startedAt = Date.now();
    const requestId = String(req.get('x-request-id') || randomUUID()).slice(0, 128);
    const traceId = String(req.get('x-trace-id') || requestId).slice(0, 128);
    req.requestId = requestId;
    req.traceId = traceId;
    res.set({ 'X-Request-ID': requestId, 'X-Trace-ID': traceId });
    metrics.requests += 1;
    res.on('finish', () => {
      const latencyMs = Date.now() - startedAt;
      metrics.totalLatencyMs += latencyMs;
      if (res.statusCode >= 500) metrics.errors += 1;
      logger.info(JSON.stringify({ event: 'request_complete', requestId, traceId, method: req.method, path: req.path, status: res.statusCode, latencyMs }));
    });
    const isPublic = req.path === '/api/health' || req.path === '/api/ready' || req.path === '/api/version' || req.path === '/api/metrics' || req.path === '/api/models';
    const isApi = req.path.startsWith('/api/') || req.path === '/mcp';
    if (isApi && !isPublic) {
      const result = rateLimiter.consume(req.ip || req.socket.remoteAddress || 'unknown');
      res.set('X-RateLimit-Remaining', String(result.remaining));
      if (!result.allowed) {
        metrics.rateLimited += 1;
        res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
        return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' }, requestId, traceId });
      }
    }
    return next();
  };
  return { middleware, getMetrics: () => ({ ...metrics, averageLatencyMs: metrics.requests ? Math.round(metrics.totalLatencyMs / metrics.requests) : 0 }) };
}
