import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  getDb,
  type ConversationDoc,
  type InboundMessageDoc,
  type OutboundMessageDoc,
} from '../db.js';
import { appendWorkspaceEvent } from '../events.js';
import { requireAuth, requireWorkspaceMember } from '../middleware/auth.js';
import { claimConversation, enqueueReply } from '../services/inbox.js';
import { kickOutboxWorker } from '../worker/outbox.js';

export const apiRouter = Router();

apiRouter.use(requireAuth);

apiRouter.get('/me', (req, res) => {
  res.status(200).json(req.user);
});

apiRouter.get('/conversations', requireWorkspaceMember, async (req, res) => {
  const workspace = String(req.query.workspace);
  const limitRaw = Number(req.query.limit ?? 20);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 20;
  const cursor = typeof req.query.cursor === 'string' ? new Date(req.query.cursor) : null;

  const filter: Record<string, unknown> = { workspace };
  if (cursor && !Number.isNaN(cursor.getTime())) {
    filter.lastActivityAt = { $lt: cursor };
  }

  const db = await getDb();
  const docs = await db
    .collection<ConversationDoc>('conversations')
    .find(filter)
    .sort({ lastActivityAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = docs.length > limit;
  const items = hasMore ? docs.slice(0, limit) : docs;
  const nextCursor = hasMore ? items[items.length - 1].lastActivityAt.toISOString() : null;

  res.status(200).json({
    conversations: items.map((c) => ({
      workspace: c.workspace,
      contact: c.contact,
      assignee: c.assignee,
      status: c.status,
      lastActivityAt: c.lastActivityAt.toISOString(),
    })),
    nextCursor,
  });
});

apiRouter.get('/conversations/:contact/messages', requireWorkspaceMember, async (req, res) => {
  const workspace = String(req.query.workspace);
  const contact = req.params.contact;
  const db = await getDb();

  const [conversation, inbound, outbound] = await Promise.all([
    db.collection<ConversationDoc>('conversations').findOne({ workspace, contact }),
    db
      .collection<InboundMessageDoc>('inbound_messages')
      .find({ workspace, contact })
      .sort({ occurredAt: 1, _id: 1 })
      .toArray(),
    db
      .collection<OutboundMessageDoc>('outbound_messages')
      .find({ workspace, contact })
      .sort({ createdAt: 1, _id: 1 })
      .toArray(),
  ]);

  const messages = [
    ...inbound.map((m) => ({
      direction: 'inbound' as const,
      id: m.messageId,
      text: m.text,
      timestamp: m.occurredAt.toISOString(),
    })),
    ...outbound.map((m) => ({
      direction: 'outbound' as const,
      id: m.clientRef,
      client_ref: m.clientRef,
      text: m.text,
      status: m.status,
      timestamp: m.createdAt.toISOString(),
    })),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  res.status(200).json({
    conversation: conversation
      ? {
          workspace: conversation.workspace,
          contact: conversation.contact,
          assignee: conversation.assignee,
          status: conversation.status,
          lastActivityAt: conversation.lastActivityAt.toISOString(),
        }
      : null,
    messages,
  });
});

apiRouter.post('/conversations/:contact/claim', requireWorkspaceMember, async (req, res) => {
  const workspace = String(req.query.workspace || req.body?.workspace);
  const contact = req.params.contact;
  const result = await claimConversation({
    workspace,
    contact,
    agent: req.user!.sub,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(200).json({ ok: true, assignee: req.user!.sub });
});

apiRouter.post('/conversations/:contact/status', requireWorkspaceMember, async (req, res) => {
  const workspace = String(req.query.workspace || req.body?.workspace);
  const contact = req.params.contact;
  const status = req.body?.status;
  if (status !== 'open' && status !== 'closed') {
    res.status(400).json({ error: 'status must be open or closed' });
    return;
  }

  const db = await getDb();
  const updated = await db.collection<ConversationDoc>('conversations').findOneAndUpdate(
    { workspace, contact },
    { $set: { status } },
    { returnDocument: 'after' },
  );
  if (!updated) {
    res.status(404).json({ error: 'conversation not found' });
    return;
  }

  await appendWorkspaceEvent(workspace, 'conversation.status', {
    contact,
    status,
  });
  res.status(200).json({ ok: true, status: updated.status });
});

apiRouter.post('/conversations/:contact/reply', requireWorkspaceMember, async (req, res) => {
  const workspace = String(req.query.workspace || req.body?.workspace);
  const contact = req.params.contact;
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const clientRef =
    typeof req.body?.client_ref === 'string' && req.body.client_ref
      ? req.body.client_ref
      : `ref_${randomUUID()}`;

  if (!text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const result = await enqueueReply({ workspace, contact, text, clientRef });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  kickOutboxWorker();
  res.status(202).json({ ok: true, client_ref: clientRef, status: 'queued' });
});
