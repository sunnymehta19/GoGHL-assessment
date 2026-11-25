import express from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
import { ensureIndexes, getDb } from './db.js';
import { getRedis } from './redis.js';
import { webhooksRouter } from './routes/webhooks.js';
import { graderRouter } from './routes/grader.js';
import { startOutboxWorker } from './worker/outbox.js';

const app = express();

app.get('/healthz', async (_req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    await getRedis().ping();
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: String(err) });
  }
});

// Mount webhook route before express.json() so HMAC verification sees the raw body.
app.use('/webhooks', webhooksRouter);

app.use(express.json());
app.use('/__grader', graderRouter);

const server = createServer(app);

async function main() {
  await ensureIndexes();
  startOutboxWorker();
  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('failed to start server:', err);
  process.exit(1);
});
