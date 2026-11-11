// Accounts: Supabase Auth (see ACCOUNTSETUP.md). The browser signs in with Supabase directly and
// sends its access token (a JWT) to Rose: "Authorization: Bearer <jwt>" on /api calls, and as a
// WebSocket subprotocol "rose.auth.<jwt>" on /ws (never in the URL, so it can't land in logs).
// Rose verifies the token itself: ES256/RS256 against the project's public JWKS, or (legacy HS256
// projects) by asking Supabase's /auth/v1/user, cached briefly. No dependencies: node:crypto only.
import crypto from 'node:crypto';

const env = (k, d = '') => (process.env[k] ?? d).trim();
export const authConfig = {
  required: /^(1|true|yes|on)$/i.test(env('REQUIRE_ACCOUNT')),
  url: env('SUPABASE_URL').replace(/\/+$/, ''),
  key: env('SUPABASE_KEY'),
  jwtSecret: env('SUPABASE_JWT_SECRET'),
  providers: env('AUTH_PROVIDERS').split(',').map(s => s.trim().toLowerCase()).filter(p => /^[a-z0-9_]{2,24}$/.test(p)),
  allowed: new Set(env('ALLOWED_EMAILS').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)),
};
const ok = () => /^https:\/\/[^/]+$|^http:\/\/[^/]+$/.test(authConfig.url) && authConfig.key.length > 10;
export const authOn = () => authConfig.required;
export const authReady = () => authConfig.required && ok();
const ISS = () => `${authConfig.url}/auth/v1`;

/** What the sign-in screen needs. The publishable key is public by design. */
export const publicAuthConfig = () => ({
  required: authConfig.required,
  configured: ok(),
  url: authConfig.required && ok() ? authConfig.url : '',
  key: authConfig.required && ok() ? authConfig.key : '',
  providers: authConfig.providers,
});

const b64u = s => Buffer.from(s, 'base64url');
const fail = (msg, status = 401) => Object.assign(new Error(msg), { status });

// ---- JWKS (asymmetric signing keys) ----
let jwks = new Map(), jwksAt = 0, jwksLoading = null;
async function loadJwks(force) {
  if (!force && Date.now() - jwksAt < 10 * 60_000 && jwks.size) return;
  if (force && Date.now() - jwksAt < 30_000) return;   // unknown kid: refetch at most every 30 s
  jwksLoading ??= (async () => {
    try {
      const r = await fetch(`${ISS()}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`JWKS ${r.status}`);
      const { keys = [] } = await r.json();
      const next = new Map();
      for (const k of keys) {
        if (!k.kid || !['EC', 'RSA'].includes(k.kty)) continue;
        try { next.set(k.kid, { alg: k.alg, key: crypto.createPublicKey({ key: k, format: 'jwk' }) }); } catch {}
      }
      jwks = next; jwksAt = Date.now();
    } finally { jwksLoading = null; }
  })();
  await jwksLoading;
}

// ---- legacy HS256 projects: ask Supabase (cached by token hash) ----
const userCache = new Map();   // sha256(token) -> { user, until }
async function askSupabase(token) {
  const h = crypto.createHash('sha256').update(token).digest('hex');
  const c = userCache.get(h);
  if (c && c.until > Date.now()) return c.user;
  const r = await fetch(`${ISS()}/user`, { headers: { apikey: authConfig.key, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  if (r.status === 401 || r.status === 403) throw fail('Your sign-in expired. Sign in again.');
  if (!r.ok) throw fail('Couldn’t reach the account server. Try again.', 503);
  const u = await r.json();
  const user = { id: u.id, email: (u.email || '').toLowerCase(), role: u.role || u.aud };
  if (userCache.size > 5000) userCache.clear();
  userCache.set(h, { user, until: Date.now() + 60_000 });
  return user;
}

/** Verify a Supabase access token. Resolves { id, email } or throws { status: 401 }. */
export async function verifyToken(token) {
  if (!authReady()) throw fail('Accounts aren’t set up on this server yet.', 503);
  if (typeof token !== 'string' || token.length > 8192) throw fail('Sign in first.');
  const parts = token.split('.');
  if (parts.length !== 3) throw fail('Sign in first.');
  let head, claims;
  try { head = JSON.parse(b64u(parts[0])); claims = JSON.parse(b64u(parts[1])); } catch { throw fail('Sign in first.'); }
  const now = Math.floor(Date.now() / 1000);
  let user;
  if (head.alg === 'ES256' || head.alg === 'RS256') {
    await loadJwks();
    let k = jwks.get(head.kid);
    if (!k) { await loadJwks(true); k = jwks.get(head.kid); }
    if (!k || (k.alg && k.alg !== head.alg)) throw fail('Sign in first.');
    const data = Buffer.from(`${parts[0]}.${parts[1]}`), sig = b64u(parts[2]);
    const good = head.alg === 'ES256'
      ? crypto.verify('sha256', data, { key: k.key, dsaEncoding: 'ieee-p1363' }, sig)
      : crypto.verify('sha256', data, k.key, sig);
    if (!good) throw fail('Sign in first.');
    user = { id: claims.sub, email: String(claims.email || '').toLowerCase(), role: claims.role };
  } else if (head.alg === 'HS256') {
    if (authConfig.jwtSecret) {
      const mac = crypto.createHmac('sha256', authConfig.jwtSecret).update(`${parts[0]}.${parts[1]}`).digest();
      const sig = b64u(parts[2]);
      if (sig.length !== mac.length || !crypto.timingSafeEqual(sig, mac)) throw fail('Sign in first.');
      user = { id: claims.sub, email: String(claims.email || '').toLowerCase(), role: claims.role };
    } else {
      user = await askSupabase(token);   // Supabase checks the signature, revocation included
    }
  } else throw fail('Sign in first.');   // "none" and anything else
  // Claims (checked for every path, including the one Supabase verified).
  if (typeof claims.exp !== 'number' || claims.exp < now - 30) throw fail('Your sign-in expired. Sign in again.');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 30) throw fail('Sign in first.');
  if (claims.iss !== ISS()) throw fail('Sign in first.');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes('authenticated') || claims.role !== 'authenticated') throw fail('Sign in first.');
  if (!user.id || !/^[0-9a-f-]{16,64}$/i.test(user.id)) throw fail('Sign in first.');
  if (authConfig.allowed.size && !authConfig.allowed.has(user.email)) throw fail('This account isn’t allowed on this Rose server.', 403);
  return user;
}

const bearer = req => {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

/**
 * Express middleware for /api: with accounts required, every call needs a valid token, except the
 * config the sign-in screen loads. req.user is set either way (null when accounts are off).
 */
export function requireAccount(req, res, next) {
  req.user = null;
  if (!authConfig.required) return next();
  if (req.path === '/auth-config') return next();
  verifyToken(bearer(req)).then(u => { req.user = u; next(); }, e => {
    res.status(e.status || 401).json({ error: e.message, needAccount: true, ...(e.status === 503 ? { notConfigured: !ok() } : {}) });
  });
}

/** For the /ws upgrade: token from the "rose.auth.<jwt>" subprotocol. Resolves the user or null (accounts off). */
export async function wsUser(req) {
  if (!authConfig.required) return null;
  const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
  const t = protos.find(p => p.startsWith('rose.auth.'))?.slice('rose.auth.'.length) || '';
  return verifyToken(t);
}
/** WebSocketServer handleProtocols: always answer the plain "rose" protocol, never echo the token. */
export const handleProtocols = protocols => (protocols.has('rose') ? 'rose' : false);
