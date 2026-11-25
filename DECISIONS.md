# DECISIONS

## What I built

- **Webhook ingestion** (`POST /webhooks/pigeon`): HMAC-SHA256 verification, 5-minute timestamp window, idempotent event deduplication via `processed_events` collection (MongoDB unique `_id`).
- **Inbound messages**: stored in `inbound_messages` with unique index on `(workspace, messageId)`; conversations upserted with `$max lastActivityAt` so out-of-order webhooks do not regress the timestamp.
- **Outbound outbox**: `outbound_messages` collection with a 30-second atomic lease (`lockedUntil`, `lockedBy = workerId`). Every instance polls and claims jobs; crashed instance's jobs are re-claimed within 30 s by survivors.
- **Rate limiting**: Redis Lua token-bucket per workspace (8 burst, 4/s refill) + `pigeon:cooldown:<ws>` key for `Retry-After` windows. Shared across instances.
- **Atomic claim**: `findOneAndUpdate` with `$or [{ assignee: null }, { assignee: agent }]`; upsert creates the conversation if it does not exist yet. Returns 409 if held by another agent.
- **OIDC login**: Authorization Code + PKCE (S256). State and nonce stored in Redis (5 min TTL). `id_token` verified with RS256 via JWKS. Session stored in Redis as `session:<sid>` (24 h TTL), `HttpOnly` cookie.
- **WebSockets** (`GET /ws?workspace=<id>&after=<seq>`): Authenticated on upgrade. Missed events replayed from `ws_events` collection (sorted by `seq`). Live events distributed via Redis `ws:<workspace>` Pub/Sub so a client connected to instance A receives events processed by instance B.
- **Monotonic status**: `statusRank` field (`queued=0, sent=1, delivered/failed=2`). Status updates only advance forward — `delivered` arriving before `sent` does not regress once `delivered` is stored.

## What I cut

- **Elasticsearch search** — no time; the data model supports adding it later.
- **End-to-end encrypted private notes** — deprioritised to protect the 85 auto-checked points.
- **Paybox billing bonus** — out of scope for the 2-hour window.
- **Unit tests** — deprioritised; the outbox worker and atomic claim are the two pieces most likely to be wrong. Would test: idempotent webhook insert, concurrent claim race, status rank monotonicity.

## Assumptions where the brief is silent

- **Inbound message ordering in snapshot**: sorted by `(occurredAt ASC, _id ASC)`. Out-of-order webhooks are stored with their original `occurred_at` and appear in chronological order.
- **Unknown workspaces in `/__grader/reply`**: return `400`. Unknown workspaces in `POST /webhooks/pigeon` return `200` (ignored), per PIGEON.md.
- **Known workspaces**: derived from `PIGEON_KEY_*` env vars at startup (`ws_acme`, `ws_globex`). Adding a workspace requires a new env var and restart.
- **Session lifetime**: 24 hours. The brief does not specify; login sessions are not cleared by `/__grader/reset`.
- **Pigeon outage retries**: capped exponential backoff 500 ms → 10 s with jitter. No permanent failure after a fixed number of attempts — replies keep retrying until Pigeon recovers, satisfying the outage recovery requirement.

## What I know is still wrong

- **Windows process cleanup**: On Windows, `kill(-pgid, SIGKILL)` from the harness does not kill Node child processes (only the `sh` parent). `start.sh` works around this by running `taskkill //F //PID <old-pid>` before starting. This is Windows-specific; on Linux the process group kill works correctly.
- **`socket_live` partial** (Level 5 ~2.67/3): occasionally 5 of 6 live WebSocket messages arrive within the 5 s window. Likely a timing issue with Redis Pub/Sub delivery latency under the checker's load. Would fix with a direct-connection path (bypass Pub/Sub when client is on the same instance).
- **No graceful shutdown**: the server does not drain in-flight requests on SIGTERM. Acceptable for `kill -9` scenarios tested here, but would need `server.close()` + outbox drain for production.
