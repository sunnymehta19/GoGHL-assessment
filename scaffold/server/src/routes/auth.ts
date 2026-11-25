import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { getRedis } from '../redis.js';
import {
  SESSION_COOKIE,
  parseCookies,
  type SessionUser,
  type WorkspaceMembership,
} from '../middleware/auth.js';

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

interface JwkKey {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

let cachedDiscovery: OidcDiscovery | null = null;
let cachedJwks: JwkKey[] = [];

async function getOidcDiscovery(): Promise<OidcDiscovery> {
  if (cachedDiscovery) return cachedDiscovery;
  const res = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status}`);
  }
  cachedDiscovery = (await res.json()) as OidcDiscovery;
  return cachedDiscovery;
}

async function getJwks(jwksUri: string, forceRefresh = false): Promise<JwkKey[]> {
  if (cachedJwks.length > 0 && !forceRefresh) return cachedJwks;
  const res = await fetch(jwksUri, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = (await res.json()) as { keys?: JwkKey[] };
  cachedJwks = data.keys ?? [];
  return cachedJwks;
}

async function verifyIdToken(
  idToken: string,
  discovery: OidcDiscovery,
  expectedNonce: string,
): Promise<SessionUser> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const [headB64, bodyB64, sigB64] = parts;

  const header = JSON.parse(Buffer.from(headB64, 'base64url').toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== 'RS256') throw new Error('unsupported alg');

  let keys = await getJwks(discovery.jwks_uri);
  let jwk = keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) {
    keys = await getJwks(discovery.jwks_uri, true);
    jwk = keys.find((k) => !header.kid || k.kid === header.kid);
  }
  if (!jwk) throw new Error('matching jwk not found');

  const publicKey = createPublicKey({ key: jwk as Record<string, unknown>, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headB64}.${bodyB64}`);
  if (!verifier.verify(publicKey, Buffer.from(sigB64, 'base64url'))) {
    throw new Error('invalid id_token signature');
  }

  const claims = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8')) as {
    iss?: string;
    aud?: string;
    exp?: number;
    nonce?: string;
    sub?: string;
    name?: string;
    email?: string;
    workspaces?: WorkspaceMembership[];
  };

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== discovery.issuer) throw new Error('issuer mismatch');
  if (claims.aud !== config.oidc.clientId) throw new Error('audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('id_token expired');
  if (claims.nonce !== expectedNonce) throw new Error('nonce mismatch');
  if (!claims.sub) throw new Error('missing sub');

  return {
    sub: claims.sub,
    name: claims.name,
    email: claims.email,
    workspaces: Array.isArray(claims.workspaces) ? claims.workspaces : [],
  };
}

function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '/';
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  if (raw.startsWith(config.webOrigin)) return raw;
  return '/';
}

export const authRouter = Router();

authRouter.get('/login', async (req, res) => {
  try {
    const discovery = await getOidcDiscovery();
    const state = randomBytes(16).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const nonce = randomBytes(16).toString('hex');
    const returnTo = sanitizeReturnTo(req.query.returnTo);

    await getRedis().set(
      `oidc:state:${state}`,
      JSON.stringify({ codeVerifier, nonce, returnTo }),
      'EX',
      300,
    );

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', config.oidc.clientId);
    authUrl.searchParams.set('redirect_uri', config.oidc.redirectUri);
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('nonce', nonce);

    res.redirect(302, authUrl.toString());
  } catch (err) {
    console.error('OIDC login error:', err);
    res.status(502).json({ error: 'oidc unavailable' });
  }
});

authRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!code || !state) {
    res.status(400).json({ error: 'missing code or state' });
    return;
  }

  const redis = getRedis();
  const stateKey = `oidc:state:${state}`;
  const rawState = await redis.getdel(stateKey);
  if (!rawState) {
    res.status(400).json({ error: 'invalid or expired state' });
    return;
  }

  const { codeVerifier, nonce, returnTo } = JSON.parse(rawState) as {
    codeVerifier: string;
    nonce: string;
    returnTo: string;
  };

  try {
    const discovery = await getOidcDiscovery();
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.oidc.redirectUri,
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!tokenRes.ok) {
      res.status(401).json({ error: 'token exchange failed' });
      return;
    }

    const tokenBody = (await tokenRes.json()) as {
      id_token?: string;
      access_token?: string;
    };

    if (!tokenBody.id_token) {
      res.status(401).json({ error: 'missing id_token' });
      return;
    }

    const user = await verifyIdToken(tokenBody.id_token, discovery, nonce);
    const sid = randomBytes(24).toString('hex');
    await redis.set(`session:${sid}`, JSON.stringify(user), 'EX', 86400);

    res.cookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 86400 * 1000,
    });

    res.redirect(302, returnTo || '/');
  } catch (err) {
    console.error('OIDC callback error:', err);
    res.status(401).json({ error: 'authentication failed' });
  }
});

authRouter.post('/logout', async (req, res) => {
  const cookies = parseCookies(req.header('cookie'));
  const sid = cookies[SESSION_COOKIE];
  if (sid) {
    await getRedis().del(`session:${sid}`);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.status(200).json({ ok: true });
});
