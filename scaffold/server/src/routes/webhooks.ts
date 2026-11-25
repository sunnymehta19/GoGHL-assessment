import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { config } from '../config.js';
import { getDb, type OutboundStatus, type ProcessedEventDoc } from '../db.js';
import {
  isMongoDuplicateError,
  recordInboundMessage,
  recordOutboundStatus,
} from '../services/inbox.js';

const MAX_TIMESTAMP_AGE_SECONDS = 300;
const VALID_OUTBOUND_STATUSES = new Set<string>(['sent', 'delivered', 'failed']);

function verifyPigeonSignature(
  header: string | undefined,
  rawBody: Buffer,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: 'missing signature' };

  let timestampStr: string | undefined;
  let v1Hex: string | undefined;
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't') timestampStr = v;
    else if (k === 'v1') v1Hex = v;
  }

  if (!timestampStr || !v1Hex || !/^\d+$/.test(timestampStr) || !/^[0-9a-f]+$/i.test(v1Hex)) {
    return { ok: false, reason: 'malformed signature' };
  }

  const timestamp = Number(timestampStr);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_AGE_SECONDS) {
    return { ok: false, reason: 'timestamp expired' };
  }

  const expectedHex = createHmac('sha256', secret)
    .update(`${timestampStr}.${rawBody.toString('utf8')}`)
    .digest('hex');

  const actualBuf = Buffer.from(v1Hex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return { ok: false, reason: 'invalid signature' };
  }

  return { ok: true };
}

export const webhooksRouter = Router();

webhooksRouter.post(
  '/pigeon',
  express.raw({ type: '*/*', limit: '2mb' }),
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : '');

    const sigCheck = verifyPigeonSignature(
      req.header('x-pigeon-signature'),
      rawBody,
      config.pigeon.webhookSecret,
    );
    if (!sigCheck.ok) {
      res.status(401).json({ error: sigCheck.reason });
      return;
    }

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        res.status(400).json({ error: 'invalid JSON object' });
        return;
      }
      event = parsed as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: 'invalid JSON' });
      return;
    }

    const workspace = typeof event.workspace === 'string' ? event.workspace : '';
    if (!workspace || !config.pigeon.apiKeys[workspace]) {
      res.status(200).json({ ok: true, ignored: 'unknown_workspace' });
      return;
    }

    const eventId =
      req.header('x-pigeon-event-id') ||
      (typeof event.id === 'string' ? event.id : '');
    if (!eventId) {
      res.status(400).json({ error: 'missing event id' });
      return;
    }

    const db = await getDb();
    try {
      await db.collection<ProcessedEventDoc>('processed_events').insertOne({
        _id: eventId,
        createdAt: new Date(),
      });
    } catch (err) {
      if (isMongoDuplicateError(err)) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      res.status(500).json({ error: 'db error' });
      return;
    }

    try {
      const type = typeof event.type === 'string' ? event.type : '';
      const data =
        event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : null;

      if (type === 'message.inbound') {
        if (
          !data ||
          typeof data.message_id !== 'string' ||
          typeof data.from !== 'string' ||
          typeof data.text !== 'string'
        ) {
          res.status(400).json({ error: 'invalid message.inbound payload' });
          return;
        }
        const occurredAtRaw =
          typeof event.occurred_at === 'string' ? new Date(event.occurred_at) : new Date();
        const occurredAt = Number.isNaN(occurredAtRaw.getTime()) ? new Date() : occurredAtRaw;

        await recordInboundMessage({
          workspace,
          messageId: data.message_id,
          from: data.from,
          text: data.text,
          occurredAt,
        });
      } else if (type === 'message.status') {
        if (
          !data ||
          typeof data.client_ref !== 'string' ||
          typeof data.status !== 'string' ||
          !VALID_OUTBOUND_STATUSES.has(data.status)
        ) {
          res.status(400).json({ error: 'invalid message.status payload' });
          return;
        }
        await recordOutboundStatus({
          workspace,
          clientRef: data.client_ref,
          status: data.status as OutboundStatus,
          messageId: typeof data.message_id === 'string' ? data.message_id : undefined,
        });
      } else {
        // Unknown event types must return 2xx so Pigeon does not retry.
        res.status(200).json({ ok: true, ignored: 'unknown_type' });
        return;
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      // Remove idempotency record so Pigeon can retry if storage failed.
      await db.collection<ProcessedEventDoc>('processed_events').deleteOne({ _id: eventId }).catch(() => {});
      console.error('webhook processing error:', err);
      res.status(500).json({ error: 'processing failed' });
    }
  },
);
