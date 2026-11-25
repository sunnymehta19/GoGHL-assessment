import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;
let indexesReady: Promise<void> | undefined;

export interface ConversationDoc {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastActivityAt: Date;
  createdAt: Date;
}

export interface InboundMessageDoc {
  workspace: string;
  messageId: string;
  contact: string;
  text: string;
  occurredAt: Date;
  createdAt: Date;
}

export type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'failed';

export interface OutboundMessageDoc {
  workspace: string;
  clientRef: string;
  contact: string;
  text: string;
  status: OutboundStatus;
  statusRank: number;
  pigeonId: string | null;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  lockedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProcessedEventDoc {
  _id: string;
  createdAt: Date;
}

export interface WorkspaceSeqDoc {
  _id: string;
  seq: number;
}

export interface WsEventDoc {
  workspace: string;
  seq: number;
  type: string;
  contact?: string;
  message_id?: string;
  client_ref?: string;
  status?: string;
  assignee?: string | null;
  text?: string;
  occurred_at?: string;
  createdAt: Date;
}

// Connects on first use. Call from anywhere: const db = await getDb();
export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUrl);
    await client.connect();
  }
  return client.db();
}

export async function ensureIndexes(): Promise<void> {
  if (!indexesReady) {
    indexesReady = (async () => {
      const db = await getDb();
      await Promise.all([
        db.collection<ConversationDoc>('conversations').createIndex(
          { workspace: 1, contact: 1 },
          { unique: true },
        ),
        db.collection<ConversationDoc>('conversations').createIndex(
          { workspace: 1, lastActivityAt: -1 },
        ),
        db.collection<InboundMessageDoc>('inbound_messages').createIndex(
          { workspace: 1, messageId: 1 },
          { unique: true },
        ),
        db.collection<InboundMessageDoc>('inbound_messages').createIndex(
          { workspace: 1, contact: 1, occurredAt: 1, _id: 1 },
        ),
        db.collection<OutboundMessageDoc>('outbound_messages').createIndex(
          { workspace: 1, clientRef: 1 },
          { unique: true },
        ),
        db.collection<OutboundMessageDoc>('outbound_messages').createIndex(
          { status: 1, nextAttemptAt: 1, lockedUntil: 1 },
        ),
        db.collection<WsEventDoc>('ws_events').createIndex(
          { workspace: 1, seq: 1 },
          { unique: true },
        ),
      ]);
    })();
  }
  return indexesReady;
}
