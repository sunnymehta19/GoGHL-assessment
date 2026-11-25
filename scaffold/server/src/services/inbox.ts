import { config } from '../config.js';
import {
  getDb,
  type ConversationDoc,
  type InboundMessageDoc,
  type OutboundMessageDoc,
  type OutboundStatus,
} from '../db.js';
import { appendWorkspaceEvent } from '../events.js';

const STATUS_RANK: Record<OutboundStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
};

export function isMongoDuplicateError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: number }).code === 11000
  );
}

export async function recordInboundMessage(params: {
  workspace: string;
  messageId: string;
  from: string;
  text: string;
  occurredAt: Date;
}): Promise<void> {
  const { workspace, messageId, from, text, occurredAt } = params;
  const db = await getDb();
  const now = new Date();

  await db.collection<ConversationDoc>('conversations').updateOne(
    { workspace, contact: from },
    {
      $setOnInsert: {
        workspace,
        contact: from,
        assignee: null,
        status: 'open',
        createdAt: now,
      },
      $max: { lastActivityAt: occurredAt },
    },
    { upsert: true },
  );

  try {
    await db.collection<InboundMessageDoc>('inbound_messages').insertOne({
      workspace,
      messageId,
      contact: from,
      text,
      occurredAt,
      createdAt: now,
    });
  } catch (err) {
    if (isMongoDuplicateError(err)) {
      return;
    }
    throw err;
  }

  await appendWorkspaceEvent(workspace, 'message.inbound', {
    contact: from,
    message_id: messageId,
    text,
    occurred_at: occurredAt.toISOString(),
  });
}

export async function recordOutboundStatus(params: {
  workspace: string;
  clientRef: string;
  status: OutboundStatus;
  messageId?: string;
}): Promise<void> {
  const { workspace, clientRef, status, messageId } = params;
  const newRank = STATUS_RANK[status];
  if (newRank === undefined) return;

  const db = await getDb();
  const existing = await db
    .collection<OutboundMessageDoc>('outbound_messages')
    .findOne({ workspace, clientRef });

  // Ignore status updates for messages we never sent (per PIGEON.md).
  if (!existing) return;

  const updateFields: Partial<OutboundMessageDoc> = {
    status,
    statusRank: newRank,
    updatedAt: new Date(),
  };
  if (messageId) {
    updateFields.pigeonId = messageId;
  }

  // Only advance status forward so out-of-order webhooks never regress delivered/failed -> sent.
  const updated = await db
    .collection<OutboundMessageDoc>('outbound_messages')
    .findOneAndUpdate(
      { workspace, clientRef, statusRank: { $lt: newRank } },
      { $set: updateFields },
      { returnDocument: 'after' },
    );

  if (updated) {
    await appendWorkspaceEvent(workspace, 'message.status', {
      contact: updated.contact,
      client_ref: clientRef,
      status,
    });
  }
}

export async function claimConversation(params: {
  workspace: string;
  contact: string;
  agent: string;
}): Promise<{ ok: true } | { ok: false; status: 400 | 409; error: string }> {
  const { workspace, contact, agent } = params;
  if (!config.pigeon.apiKeys[workspace]) {
    return { ok: false, status: 400, error: 'unknown workspace' };
  }

  const db = await getDb();
  const conversations = db.collection<ConversationDoc>('conversations');
  const now = new Date();

  let before: ConversationDoc | null = null;
  try {
    before = await conversations.findOneAndUpdate(
      { workspace, contact, $or: [{ assignee: null }, { assignee: agent }] },
      {
        $set: { assignee: agent },
        $setOnInsert: {
          workspace,
          contact,
          status: 'open',
          lastActivityAt: now,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'before' },
    );
  } catch (err) {
    if (!isMongoDuplicateError(err)) throw err;
    // Concurrent upsert race: retry without upsert to see if we won or someone else did.
    before = await conversations.findOneAndUpdate(
      { workspace, contact, $or: [{ assignee: null }, { assignee: agent }] },
      { $set: { assignee: agent } },
      { returnDocument: 'before' },
    );
    if (!before) {
      return { ok: false, status: 409, error: 'conversation already claimed' };
    }
  }

  // Note: findOneAndUpdate with upsert + returnDocument:'before' returns null on insert,
  // or the previous doc if it existed. Only emit if assignee actually changed.
  if (!before || before.assignee !== agent) {
    await appendWorkspaceEvent(workspace, 'conversation.assigned', {
      contact,
      assignee: agent,
    });
  }

  return { ok: true };
}

export async function enqueueReply(params: {
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
}): Promise<{ ok: true } | { ok: false; status: 400; error: string }> {
  const { workspace, contact, text, clientRef } = params;
  if (!config.pigeon.apiKeys[workspace]) {
    return { ok: false, status: 400, error: 'unknown workspace' };
  }

  const db = await getDb();
  const now = new Date();

  await db.collection<ConversationDoc>('conversations').updateOne(
    { workspace, contact },
    {
      $setOnInsert: {
        workspace,
        contact,
        assignee: null,
        status: 'open',
        createdAt: now,
      },
      $max: { lastActivityAt: now },
    },
    { upsert: true },
  );

  try {
    await db.collection<OutboundMessageDoc>('outbound_messages').insertOne({
      workspace,
      clientRef,
      contact,
      text,
      status: 'queued',
      statusRank: STATUS_RANK.queued,
      pigeonId: null,
      attempts: 0,
      nextAttemptAt: now,
      lockedUntil: null,
      lockedBy: null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (isMongoDuplicateError(err)) {
      return { ok: true };
    }
    throw err;
  }

  return { ok: true };
}
