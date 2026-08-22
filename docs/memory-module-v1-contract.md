# Memory Module V1 Contract Baseline

This document records the first executable slice of `memory-module-roadmap-v3.md`. The roadmap is treated as product and engineering requirements; it does not override repository security instructions or runtime configuration. `server/memory-module-sdk.js` is the client boundary for callers that should not know the storage model.

## Boundary

The new contract is exposed below `/v1`. The existing `/api/memories` endpoints remain temporarily available for the current Cochpia UI and are not the V1 canonical model.

The V1 service owns memory data behind an API boundary. Callers provide an authenticated subject context; `tenant_id` and `user_id` in request bodies are validated against that context and cannot replace it.

The executable SDK smoke `npm run test:memory-sdk` exercises the first external caller chain (create → retrieve → ContextBundle → forget → negative retrieve) when `MEMORY_MODULE_URL`, `MEMORY_MODULE_SDK_TENANT_ID`, and `MEMORY_MODULE_SDK_USER_ID` are configured. It is skipped without those variables and does not claim success for an unavailable service.

## Implemented endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/events` | Store an event or return `accepted_no_store` after the synchronous safety gate |
| POST | `/v1/sessions` | Create a TTL-bound memory session |
| POST | `/v1/access-grants` | Grant an Agent access to user-scope memory |
| POST | `/v1/memories` | Create an explicit S0 memory or an S2 pending confirmation |
| GET | `/v1/memories` | Scope/policy-filtered cursor list (`items`, `nextCursor`) |
| GET | `/v1/memories/{id}` | Scope/policy-filtered read |
| POST | `/v1/retrieve` | Canonical structured retrieval with a consistency token |
| POST | `/v1/context-bundles` | Deterministic static/dynamic bundle assembly with a token budget |
| POST | `/v1/memories/{id}/correct` | Create a new assertion version with optimistic concurrency |
| POST | `/v1/memories/{id}/promote` | Promote an async S0 candidate using `resource_revision` |
| POST | `/v1/memories/{id}/pin` | Pin an exact version by default |
| POST | `/v1/memories/{id}/unpin` | Remove the active pin |
| POST | `/v1/memories/{id}/revoke` | Immediately hide a memory while retaining governed history |
| POST | `/v1/memories/{id}/forget` | Immediately hide and create a redaction tombstone/epoch |
| POST | `/v1/governance/forget` | Forget a supported source event or session target |
| POST | `/v1/governance/delete` | Physically delete a source event, session, relationship, or account and return a deletion operation ID |
| DELETE | `/v1/memories/{id}` | Delete canonical data and return a deletion operation ID |
| GET | `/v1/confirmations` | Cursor list of a user's pending confirmation requests (`items`, `nextCursor`) |
| POST | `/v1/confirmations/{id}/confirm` | Confirm a candidate using `resource_revision` |
| POST | `/v1/confirmations/{id}/reject` | Reject a candidate using `resource_revision` |
| POST | `/v1/access-confirmations/{id}/confirm` | Issue a one-time, purpose/session/agent-bound direct-query token |
| POST | `/v1/mentions` | Record an actually emitted proactive mention and apply a bounded Agent/topic cooldown |
| POST | `/v1/sessions/{id}/current-state` | Write a TTL-bound session state |
| GET | `/v1/deletion-operations/{id}` | Query deletion propagation status |

## Policy baseline

- S3 patterns are rejected before raw event persistence. `do_not_store` follows the same no-content path.
- `system` and `tool` event bodies are `accepted_no_store` by default; retaining tool content requires a future allowlisted content schema and does not happen implicitly.
- `storage_directive` is an explicit enum (`default` or `do_not_store`); unknown values are rejected rather than silently treated as permission to persist.
- Numeric `source_revision` ordering is enforced: stale writes are returned as `duplicate` with `reason=superseded_revision`, and old queued revisions cannot generate derived memories.
- Outbox consumers fail closed on unknown `schemaVersion`: supported versions are processed, unknown versions become non-retryable `dead_letter` events with `UNSUPPORTED_OUTBOX_SCHEMA` before business processing.
- Independent workers accept the configured `MEMORY_MODULE_SUPPORTED_OUTBOX_SCHEMA_VERSIONS` set so expand/contract deployments can overlap current and previous schemas without weakening the unknown-version gate.
- List endpoints use a stable newest-first opaque cursor bound to tenant, subject user and active filters; callers must follow `nextCursor` rather than using unbounded offsets.
- S2 content is `pending_confirmation`, not ordinary recallable memory.
- Relationship memory is visible only to the exact `(tenant_id, user_id, agent_id)` relationship.
- Session state requires an expiry and is stored separately from long-term assertions.
- Session-scoped assertions are hard-filtered to their exact active session; they are not visible through ordinary user-scope reads, and the in-process domain exposes `sweepRetention` for deterministic TTL/retention cleanup.
- A session creates a stable profile snapshot of active user/relationship versions; each Bundle rechecks current lifecycle, privacy epoch, and grants before returning snapshot content.
- Correct/revoke/forget/delete/pin operations require `resource_revision`.
- A correction that classifies as S2 creates a proposed version and keeps the previous current version until confirmation; the confirmation is bound to the assertion revision. S1 corrections remain current-state-only.
- Memory content is returned as data and carries no instruction semantics.
- `forbidden` and `not_found` use the same external error shape; no content is returned for either.
- `auto_extract`, `auto_profile_update`, `hybrid_retrieval`, `vector_retrieval`, `episode_grouping`, and `proactive_mention` are independent feature flags; disabling any derived feature leaves explicit memory and governance available. Async retrieve/context-bundle uses hybrid/RRF or vector ranking only when enabled and supplied with an embedding gateway; missing/slow embeddings fall back to BM25.
- `proactive_mention` is fail-closed when disabled. A caller records only memory IDs already authorized for proactive mention through `/v1/mentions`; the service stores a bounded, content-free `(agent, memory, topic_key)` cooldown and filters it on later proactive retrievals.
- Retrieval and ContextBundle return a deterministic `queryRoute` hint (`profile_exact`, `state_current`, `episode_recall`, `relationship_recall`, `bridge_candidate`, or `unknown`) for downstream routing and evaluation; the hint never bypasses Scope or policy filters.
- Mutation endpoints accept `Idempotency-Key` or `idempotency_key`. The key is scoped by tenant, subject user, actor, and mutation namespace, retained for 24 hours by default, and bound to a canonical request fingerprint. Reusing a key with a different payload returns `IDEMPOTENCY_CONFLICT`; successful responses are replayed without creating a second resource. Event ingestion keeps its separate `event_id + source_revision` contract.
- Mutation idempotency records retain only safe response copies. S3 or `do_not_store` inputs are never fingerprinted or copied into an idempotency response, and content-bearing replay records are invalidated when their memory/source/session is forgotten or deleted.

## Known first-slice limits

The first slice uses deterministic BM25 retrieval and an in-process state adapter so the contract can be tested without external services. PostgreSQL DDL is included in `server/memory-module-schema.sql`; the repository and independent service now persist the canonical tables with a per-subject commit sequence guard. The independent service has a database-leased worker path for extraction, profile projection, lexical index rebuild, and episode grouping; each remains behind its own feature flag. Async hybrid/vector retrieval is now wired to the injected embedding gateway with BM25 fallback. The extraction path defaults to a safe heuristic gateway and accepts an injected structured model gateway without weakening the canonical policy checks. Physical delete is implemented for memory, source event, session, relationship, and account targets while retaining only a minimal deletion ledger.
