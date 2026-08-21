# PHASE 8 Production Readiness

The local API now exposes:

- `GET /api/health`: dependency health and model readiness.
- `GET /api/ready`: readiness check for a load balancer; returns `503` while storage or model is not ready.
- `GET /api/version`: service version and runtime metadata.
- `GET /api/metrics`: in-memory request count, errors, rate limits, and latency.

Every request receives `X-Request-ID` and `X-Trace-ID`. API responses are rate limited by client address. Secrets are never returned by these endpoints or logged.

For a real deployment, configure HTTPS, a custom domain, server-only secrets, PostgreSQL, required Auth, remote MCP, backups, and log retention in the hosting platform. Railway templates exist in this directory, but no cloud service is claimed as deployed until a real environment passes health, readiness, Auth isolation, backup/restore, and HTTPS checks.

Before production release:

1. Set `AUTH_MODE=required` and `STORAGE_PROVIDER=postgres`.
2. Configure `CLIENT_ORIGIN` to the HTTPS web origin.
3. Keep model and MCP credentials only in API-service variables.
4. Configure scheduled PostgreSQL backups and perform a restore drill.
5. Set an external log/metric retention policy; the local `/api/metrics` counters reset on restart.
