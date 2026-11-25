import type { NextFunction, Request, Response } from 'express';
import { getRedis } from '../redis.js';

export interface WorkspaceMembership {
  id: string;
  role: 'admin' | 'agent' | string;
}

export interface SessionUser {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceMembership[];
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      sessionId?: string;
    }
  }
}

export const SESSION_COOKIE = 'switchboard_sid';

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

export async function loadSessionUser(cookieHeader: string | undefined): Promise<{
  sid: string;
  user: SessionUser;
} | null> {
  const cookies = parseCookies(cookieHeader);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;

  const raw = await getRedis().get(`session:${sid}`);
  if (!raw) return null;

  try {
    const user = JSON.parse(raw) as SessionUser;
    if (!user || typeof user.sub !== 'string' || !Array.isArray(user.workspaces)) {
      return null;
    }
    return { sid, user };
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const loaded = await loadSessionUser(req.header('cookie'));
  if (!loaded) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.sessionId = loaded.sid;
  req.user = loaded.user;
  next();
}

export function requireWorkspaceMember(req: Request, res: Response, next: NextFunction): void {
  const workspace =
    (typeof req.query.workspace === 'string' && req.query.workspace) ||
    (typeof req.body?.workspace === 'string' && req.body.workspace) ||
    '';

  if (!workspace) {
    res.status(400).json({ error: 'workspace is required' });
    return;
  }

  const isMember = req.user?.workspaces.some((w) => w.id === workspace);
  if (!isMember) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  next();
}
