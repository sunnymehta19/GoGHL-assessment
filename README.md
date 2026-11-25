# Switchboard

A shared team inbox built for the Switchboard build round.

## Stack

- **Server:** Node.js 22 + Express + TypeScript (compiled to `dist/`)
- **Frontend:** React 19 + Vite
- **Database:** MongoDB (conversations, inbound messages, outbound outbox, events)
- **Cache / Pub-Sub:** Redis (sessions, rate-limit token buckets, WebSocket fanout)

## Prerequisites

- Node.js ≥ 22
- Docker (for MongoDB, Redis, and the simulators) **or** existing MongoDB/Redis instances

## Running from a clean clone

```bash
# 1. Start services (MongoDB, Redis, Pigeon, IdP)
npm run up          # Docker
# or
npm run mocks       # plain Node, no Docker

# 2. Install dependencies and compile the server
npm run scaffold:install
npm --prefix scaffold/server run build

# 3. Start the server  (listens on PORT, default 4000)
npm run scaffold:server    # dev (tsx watch)
# or
sh start.sh                # production (compiled dist)

# 4. Start the React app  (port 5173, proxies /api /auth /ws to :4000)
npm run scaffold:web
```

Open `http://localhost:5173`, click **Sign in with OIDC**, choose a test user, and the inbox appears.

## Running the checker

```bash
# Stop your own server first — the checker starts it itself
npm run check             # Level 1 (~90 s)
node harness/check.js --full    # Levels 1, 2, 3, 5 (~4 min) → CHECK_REPORT.json
node harness/check.js --levels 5    # one level
```

## Environment variables

Defaults match the harness. Copy `.env.example` to `.env` and edit only what differs:

| Variable | Default |
|---|---|
| `PORT` | `4000` |
| `MONGO_URL` | `mongodb://localhost:27017/switchboard` |
| `REDIS_URL` | `redis://localhost:6379` |
| `PIGEON_URL` | `http://localhost:4010` |
| `PIGEON_WEBHOOK_SECRET` | `whsec_pigeon_dev` |
| `OIDC_ISSUER` | `http://localhost:4020` |
| `GRADER_TOKEN` | `grader-dev-token` |

## Key design decisions

See `DECISIONS.md`.
