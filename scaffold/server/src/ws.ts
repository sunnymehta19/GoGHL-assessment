import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { getDb, type WsEventDoc } from './db.js';
import { loadSessionUser } from './middleware/auth.js';
import { getRedis } from './redis.js';

interface ClientState {
  ws: WebSocket;
  workspace: string;
  ready: boolean;
  lastSentSeq: number;
  buffer: WsEventDoc[];
}

function formatFrame(doc: WsEventDoc): string {
  const frame: Record<string, unknown> = {
    seq: doc.seq,
    type: doc.type,
    workspace: doc.workspace,
  };
  if (doc.contact !== undefined) frame.contact = doc.contact;
  if (doc.message_id !== undefined) frame.message_id = doc.message_id;
  if (doc.client_ref !== undefined) frame.client_ref = doc.client_ref;
  if (doc.status !== undefined) frame.status = doc.status;
  if (doc.assignee !== undefined) frame.assignee = doc.assignee;
  if (doc.text !== undefined) frame.text = doc.text;
  if (doc.occurred_at !== undefined) frame.occurred_at = doc.occurred_at;
  return JSON.stringify(frame);
}

export function attachWebSocketServer(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const clientsByWorkspace = new Map<string, Set<ClientState>>();

  const sub = getRedis().duplicate();
  sub.psubscribe('ws:*').catch((err) => {
    console.error('redis psubscribe error:', err);
  });

  sub.on('pmessage', (_pattern, channel, message) => {
    const workspace = channel.slice(3);
    const clients = clientsByWorkspace.get(workspace);
    if (!clients || clients.size === 0) return;

    let doc: WsEventDoc;
    try {
      doc = JSON.parse(message) as WsEventDoc;
    } catch {
      return;
    }

    const payload = formatFrame(doc);
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (!client.ready) {
        client.buffer.push(doc);
      } else if (doc.seq > client.lastSentSeq) {
        client.lastSentSeq = doc.seq;
        client.ws.send(payload);
      }
    }
  });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      const loaded = await loadSessionUser(req.headers.cookie);
      if (!loaded) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const workspace = url.searchParams.get('workspace') || '';
      const isMember = loaded.user.workspaces.some((w) => w.id === workspace);
      if (!workspace || !isMember) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const afterParam = url.searchParams.get('after');
      const hasAfter = afterParam !== null && afterParam !== '' && /^\d+$/.test(afterParam);
      const afterSeq = hasAfter ? Number(afterParam) : null;

      wss.handleUpgrade(req, socket, head, async (ws) => {
        const state: ClientState = {
          ws,
          workspace,
          ready: false,
          lastSentSeq: afterSeq ?? 0,
          buffer: [],
        };

        let set = clientsByWorkspace.get(workspace);
        if (!set) {
          set = new Set();
          clientsByWorkspace.set(workspace, set);
        }
        set.add(state);

        ws.on('close', () => {
          set?.delete(state);
          if (set && set.size === 0) {
            clientsByWorkspace.delete(workspace);
          }
        });

        try {
          if (afterSeq !== null) {
            const db = await getDb();
            const missed = await db
              .collection<WsEventDoc>('ws_events')
              .find({ workspace, seq: { $gt: afterSeq } })
              .sort({ seq: 1 })
              .toArray();

            for (const doc of missed) {
              if (ws.readyState !== WebSocket.OPEN) return;
              if (doc.seq > state.lastSentSeq) {
                state.lastSentSeq = doc.seq;
                ws.send(formatFrame(doc));
              }
            }
          }

          state.buffer.sort((a, b) => a.seq - b.seq);
          for (const doc of state.buffer) {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (doc.seq > state.lastSentSeq) {
              state.lastSentSeq = doc.seq;
              ws.send(formatFrame(doc));
            }
          }
          state.buffer = [];
          state.ready = true;
        } catch (err) {
          console.error('ws replay error:', err);
          ws.close();
        }
      });
    } catch {
      socket.destroy();
    }
  });
}
