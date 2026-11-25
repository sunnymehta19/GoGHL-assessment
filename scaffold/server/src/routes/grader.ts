import { Router } from 'express';
import { config } from '../config.js';
import {
  getDb,
  type ConversationDoc,
  type InboundMessageDoc,
  type OutboundMessageDoc,
} from '../db.js';
import { getRedis } from '../redis.js';
import { claimConversation, enqueueReply } from '../services/inbox.js';
import { kickOutboxWorker } from '../worker/outbox.js';

export const graderRouter = Router();

graderRouter.use((req, res, next) => {
  if (req.header('x-grader-token') !== config.graderToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

graderRouter.post('/reset', async (_req, res) => {
  const db = await getDb();
  await Promise.all([
    db.collection('conversations').deleteMany({}),
    db.collection('inbound_messages').deleteMany({}),
    db.collection('outbound_messages').deleteMany({}),
    db.collection('processed_events').deleteMany({}),
    db.collection('workspace_seqs').deleteMany({}),
    db.collection('ws_events').deleteMany({}),
  ]);

  const redis = getRedis();
  const keys = await redis.keys('pigeon:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }

  res.status(200).json({ ok: true });
});

graderRouter.get('/snapshot', async (_req, res) => {
  const db = await getDb();

  const [conversations, inboundMessages, outboundMessages] = await Promise.all([
    db.collection<ConversationDoc>('conversations').find({}).toArray(),
    db
      .collection<InboundMessageDoc>('inbound_messages')
      .find({})
      .sort({ occurredAt: 1, _id: 1 })
      .toArray(),
    db.collection<OutboundMessageDoc>('outbound_messages').find({}).toArray(),
  ]);

  const workspaces: Record<
    string,
    {
      contacts: Record<string, { inbound: string[]; assignee: string | null }>;
      outbound: Record<string, string>;
    }
  > = {};

  const ensureWorkspace = (ws: string) => {
    if (!workspaces[ws]) {
      workspaces[ws] = { contacts: {}, outbound: {} };
    }
    return workspaces[ws];
  };

  for (const conv of conversations) {
    const ws = ensureWorkspace(conv.workspace);
    ws.contacts[conv.contact] = {
      inbound: [],
      assignee: conv.assignee ?? null,
    };
  }

  for (const msg of inboundMessages) {
    const ws = ensureWorkspace(msg.workspace);
    if (!ws.contacts[msg.contact]) {
      ws.contacts[msg.contact] = { inbound: [], assignee: null };
    }
    ws.contacts[msg.contact].inbound.push(msg.messageId);
  }

  for (const out of outboundMessages) {
    const ws = ensureWorkspace(out.workspace);
    ws.outbound[out.clientRef] = out.status;
  }

  res.status(200).json({ workspaces });
});

graderRouter.post('/reply', async (req, res) => {
  const { workspace, contact, text, client_ref } = (req.body ?? {}) as Record<string, unknown>;
  if (
    typeof workspace !== 'string' ||
    typeof contact !== 'string' ||
    typeof text !== 'string' ||
    typeof client_ref !== 'string' ||
    !workspace ||
    !contact ||
    !client_ref
  ) {
    res.status(400).json({ error: 'invalid reply payload' });
    return;
  }

  const result = await enqueueReply({
    workspace,
    contact,
    text,
    clientRef: client_ref,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  kickOutboxWorker();
  res.status(202).json({ ok: true, client_ref });
});

graderRouter.post('/claim', async (req, res) => {
  const { workspace, contact, agent } = (req.body ?? {}) as Record<string, unknown>;
  if (
    typeof workspace !== 'string' ||
    typeof contact !== 'string' ||
    typeof agent !== 'string' ||
    !workspace ||
    !contact ||
    !agent
  ) {
    res.status(400).json({ error: 'invalid claim payload' });
    return;
  }

  const result = await claimConversation({ workspace, contact, agent });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(200).json({ ok: true, assignee: agent });
});
