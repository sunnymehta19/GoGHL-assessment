import { getDb, type WorkspaceSeqDoc, type WsEventDoc } from './db.js';
import { getRedis } from './redis.js';

export async function appendWorkspaceEvent(
  workspace: string,
  type: string,
  fields: Omit<WsEventDoc, 'workspace' | 'seq' | 'type' | 'createdAt'>,
): Promise<WsEventDoc> {
  const db = await getDb();
  const seqDoc = await db.collection<WorkspaceSeqDoc>('workspace_seqs').findOneAndUpdate(
    { _id: workspace },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );

  const seq = seqDoc?.seq ?? 1;
  const eventDoc: WsEventDoc = {
    workspace,
    seq,
    type,
    ...fields,
    createdAt: new Date(),
  };

  await db.collection<WsEventDoc>('ws_events').insertOne(eventDoc);

  // Publish to Redis for cross-instance WebSocket fanout (best effort; replay covers gaps).
  try {
    const redis = getRedis();
    await redis.publish(`ws:${workspace}`, JSON.stringify(eventDoc));
  } catch {
    // Client reconnect with ?after=seq will recover missed events from MongoDB.
  }

  return eventDoc;
}
