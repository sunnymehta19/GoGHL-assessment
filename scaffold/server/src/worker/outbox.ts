import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb, type OutboundMessageDoc } from '../db.js';
import { getRedis } from '../redis.js';
import { recordOutboundStatus } from '../services/inbox.js';

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
const LEASE_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const MAX_CONCURRENCY = 4;
const PIGEON_TIMEOUT_MS = 5_000;

// Atomic per-workspace token bucket (capacity 8, refill 4/sec) + 429 cooldown check.
const RATE_LIMIT_LUA = `
local cooldownKey = KEYS[2]
local pttl = redis.call('PTTL', cooldownKey)
if pttl > 0 then
  return {0, pttl}
end

local bucketKey = KEYS[1]
local nowMs = tonumber(ARGV[1])
local capacity = 8
local refillRate = 4

local data = redis.call('HMGET', bucketKey, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if not tokens or not ts then
  tokens = capacity
  ts = nowMs
else
  local elapsed = math.max(0, nowMs - ts)
  tokens = math.min(capacity, tokens + (elapsed * refillRate / 1000.0))
  ts = nowMs
end

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HSET', bucketKey, 'tokens', tostring(tokens), 'ts', tostring(ts))
  redis.call('PEXPIRE', bucketKey, 60000)
  return {1, 0}
else
  local waitMs = math.ceil((1 - tokens) / refillRate * 1000)
  redis.call('HSET', bucketKey, 'tokens', tostring(tokens), 'ts', tostring(ts))
  redis.call('PEXPIRE', bucketKey, 60000)
  return {0, math.max(50, waitMs)}
end
`;

let timer: ReturnType<typeof setTimeout> | null = null;
let activeCount = 0;
let stopped = false;

async function acquireWorkspaceSlot(workspace: string): Promise<{ allowed: boolean; waitMs: number }> {
  const redis = getRedis();
  const res = (await redis.eval(
    RATE_LIMIT_LUA,
    2,
    `pigeon:tb:${workspace}`,
    `pigeon:cooldown:${workspace}`,
    String(Date.now()),
  )) as [number, number];
  return { allowed: res[0] === 1, waitMs: Number(res[1]) || 250 };
}

async function setWorkspaceCooldown(workspace: string, ms: number): Promise<void> {
  const redis = getRedis();
  await redis.set(`pigeon:cooldown:${workspace}`, '1', 'PX', Math.max(50, ms));
}

async function releaseJobForRetry(
  job: OutboundMessageDoc,
  delayMs: number,
  incrementAttempts: boolean,
): Promise<void> {
  const db = await getDb();
  const update: Record<string, unknown> = {
    $set: {
      nextAttemptAt: new Date(Date.now() + delayMs),
      lockedUntil: null,
      lockedBy: null,
      updatedAt: new Date(),
    },
  };
  if (incrementAttempts) {
    update.$inc = { attempts: 1 };
  }
  await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
    { workspace: job.workspace, clientRef: job.clientRef, lockedBy: WORKER_ID, status: 'queued' },
    update,
  );
}

async function processJob(job: OutboundMessageDoc): Promise<void> {
  const apiKey = config.pigeon.apiKeys[job.workspace];
  if (!apiKey) {
    await recordOutboundStatus({
      workspace: job.workspace,
      clientRef: job.clientRef,
      status: 'failed',
    });
    return;
  }

  const slot = await acquireWorkspaceSlot(job.workspace);
  if (!slot.allowed) {
    await releaseJobForRetry(job, slot.waitMs, false);
    return;
  }

  try {
    const response = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': job.clientRef,
      },
      body: JSON.stringify({
        to: job.contact,
        text: job.text,
        client_ref: job.clientRef,
      }),
      signal: AbortSignal.timeout(PIGEON_TIMEOUT_MS),
    });

    if (response.ok) {
      let pigeonId: string | undefined;
      try {
        const body = (await response.json()) as { id?: string };
        pigeonId = body.id;
      } catch {
        // ignore parse error on 2xx
      }
      await recordOutboundStatus({
        workspace: job.workspace,
        clientRef: job.clientRef,
        status: 'sent',
        messageId: pigeonId,
      });
      const db = await getDb();
      await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
        { workspace: job.workspace, clientRef: job.clientRef, lockedBy: WORKER_ID },
        { $set: { lockedUntil: null, lockedBy: null } },
      );
      return;
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retrySec = Number(retryAfterHeader);
      const waitMs = (Number.isFinite(retrySec) && retrySec > 0 ? retrySec * 1000 : 1000) + 50;
      await setWorkspaceCooldown(job.workspace, waitMs);
      await releaseJobForRetry(job, waitMs, false);
      return;
    }

    if (response.status >= 400 && response.status < 500) {
      await recordOutboundStatus({
        workspace: job.workspace,
        clientRef: job.clientRef,
        status: 'failed',
      });
      const db = await getDb();
      await db.collection<OutboundMessageDoc>('outbound_messages').updateOne(
        { workspace: job.workspace, clientRef: job.clientRef, lockedBy: WORKER_ID },
        { $set: { lockedUntil: null, lockedBy: null } },
      );
      return;
    }

    // 5xx (e.g., 503 outage): backoff and retry
    const backoff = Math.min(10_000, 500 * 2 ** Math.min(job.attempts, 5));
    const jitter = Math.floor(Math.random() * 250);
    await releaseJobForRetry(job, backoff + jitter, true);
  } catch {
    // Timeout or network error: backoff and retry (Idempotency-Key protects against duplicates).
    const backoff = Math.min(10_000, 500 * 2 ** Math.min(job.attempts, 5));
    const jitter = Math.floor(Math.random() * 250);
    await releaseJobForRetry(job, backoff + jitter, true);
  }
}

async function claimNextJob(): Promise<OutboundMessageDoc | null> {
  const db = await getDb();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);

  return db.collection<OutboundMessageDoc>('outbound_messages').findOneAndUpdate(
    {
      status: 'queued',
      nextAttemptAt: { $lte: now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    {
      $set: {
        lockedUntil: leaseUntil,
        lockedBy: WORKER_ID,
        updatedAt: now,
      },
    },
    {
      sort: { nextAttemptAt: 1, createdAt: 1 },
      returnDocument: 'after',
    },
  );
}

async function tick(): Promise<void> {
  if (stopped) return;
  try {
    while (!stopped && activeCount < MAX_CONCURRENCY) {
      const job = await claimNextJob();
      if (!job) break;
      activeCount++;
      processJob(job)
        .catch((err) => console.error('outbox job error:', err))
        .finally(() => {
          activeCount--;
          kickOutboxWorker();
        });
    }
  } catch (err) {
    console.error('outbox tick error:', err);
  } finally {
    if (!stopped) {
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  }
}

export function startOutboxWorker(): void {
  stopped = false;
  kickOutboxWorker();
}

export function kickOutboxWorker(): void {
  if (stopped) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  timer = setTimeout(tick, 0);
}

export function stopOutboxWorker(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
