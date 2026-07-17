'use strict';
/*
 * Panel authentication - a single shared login for the AI Panel.
 *
 * The panel configures API keys / providers and is published on a PUBLIC :8443,
 * so it must not be open. Auth is one shared credential:
 *   username  PANEL_USERNAME  (default "admin")
 *   password  PANEL_PASSWORD  (the provisioner writes this into the compose .env)
 * A successful POST /login mints a stateless, HMAC-signed session cookie; the
 * gate() middleware rejects every other request until that cookie is valid.
 *
 * No external deps: the cookie is signed with a per-VM secret persisted 0600 in
 * the state dir (so sessions survive panel restarts) and parsed/serialised by
 * hand. The password compare is constant-time and a per-IP throttle slows brute
 * force, but the real guarantee is the signed cookie - there is no oracle beyond
 * a 401.
 *
 * Fail-safe: when PANEL_PASSWORD is unset the gate logs a loud warning and runs
 * OPEN (so local dev / preview still works). Every real deployment sets it, so
 * production is closed by default. Set PANEL_REQUIRE_AUTH=1 to hard-fail boot
 * instead of running open.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'claw_sess';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILS = 8;                 // failed logins per IP before a lockout
const LOCK_MS = 5 * 60 * 1000;       // lockout window after MAX_FAILS

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// Compare two strings without leaking length or content via timing. Both sides
// are hashed to a fixed width first so timingSafeEqual never throws on length.
function constantEq(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function createAuth({ stateDir }) {
  const username = (process.env.PANEL_USERNAME || 'admin').trim() || 'admin';
  const password = process.env.PANEL_PASSWORD || '';
  const enabled = password.length > 0;
  const secureCookie = !truthy(process.env.PANEL_COOKIE_INSECURE); // Secure unless local plain-HTTP dev

  if (!enabled) {
    // Fail CLOSED by default: the panel sets API keys and is published on a public
    // :8443, so "no password" must not silently mean "no login". Running open now
    // requires an explicit opt-in (PANEL_ALLOW_OPEN=1), which local dev/preview sets;
    // every provisioned VM writes PANEL_PASSWORD, so production is never affected.
    if (!truthy(process.env.PANEL_ALLOW_OPEN)) {
      console.error('[auth] PANEL_PASSWORD is not set - refusing to start open. ' +
        'Set PANEL_PASSWORD, or set PANEL_ALLOW_OPEN=1 for a trusted local run.');
      process.exit(1);
    }
    console.warn('[auth] *** PANEL_ALLOW_OPEN=1 and no PANEL_PASSWORD - running OPEN (no login). ' +
      'Never do this on a public host. ***');
  }

  // Per-VM signing secret, persisted so a restart does not drop every session.
  const secret = loadOrCreateSecret(stateDir);

  // A short fingerprint of the current password, stamped into every session and
  // checked on verify. Rotating PANEL_PASSWORD changes this, so all outstanding
  // cookies (7-day TTL) stop validating the moment the password changes — otherwise
  // a leaked or shared session survived a password rotation for a week.
  const passEpoch = crypto.createHmac('sha256', secret).update('pw:' + password).digest('hex').slice(0, 12);

  function loadOrCreateSecret(dir) {
    const file = path.join(dir, 'session.key');
    try {
      const s = fs.readFileSync(file);
      if (s && s.length >= 32) return s;
    } catch (_) {}
    const buf = crypto.randomBytes(32);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, buf, { mode: 0o600 });
    } catch (e) {
      console.error('[auth] could not persist session secret (sessions reset on restart):', (e && e.message) || e);
    }
    return buf;
  }

  // --- session token: base64url(payload).base64url(hmac) ---
  function sign(payloadObj) {
    const payload = b64url(JSON.stringify(payloadObj));
    const mac = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
    return payload + '.' + mac;
  }
  function verify(token) {
    if (typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i <= 0) return null;
    const payload = token.slice(0, i);
    const mac = token.slice(i + 1);
    const expect = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
    const a = Buffer.from(mac);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let obj;
    try { obj = JSON.parse(b64urlToBuf(payload).toString('utf8')); } catch (_) { return null; }
    if (!obj || typeof obj.exp !== 'number' || Date.now() > obj.exp) return null;
    if (obj.pv !== passEpoch) return null;   // password rotated since this cookie was issued
    return obj;
  }

  // --- cookies (hand-parsed; no cookie-parser dep) ---
  function parseCookies(req) {
    const out = {};
    const h = req.headers && req.headers.cookie;
    if (!h) return out;
    for (const part of h.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      const k = part.slice(0, idx).trim();
      if (!k) continue;
      // A malformed percent-sequence in ANY cookie makes decodeURIComponent throw; without
      // this guard one bad cookie in the request would 500 the whole auth path. Fall back to
      // the raw value (our own session cookie is base64url, so it never needs decoding).
      const rawVal = part.slice(idx + 1).trim();
      try { out[k] = decodeURIComponent(rawVal); } catch (_) { out[k] = rawVal; }
    }
    return out;
  }
  function cookieHeader(value, maxAgeSec) {
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (secureCookie) attrs.push('Secure');
    attrs.push('Max-Age=' + maxAgeSec);
    return `${COOKIE}=${encodeURIComponent(value)}; ${attrs.join('; ')}`;
  }
  function setSession(res, token) {
    res.append('Set-Cookie', cookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)));
  }
  function clearSession(res) {
    res.append('Set-Cookie', cookieHeader('', 0));
  }

  function isAuthed(req) {
    if (!enabled) return true;
    return !!verify(parseCookies(req)[COOKIE]);
  }

  // --- per-IP brute-force throttle (best effort, in memory) ---
  const attempts = new Map(); // ipKey -> { count, until }
  function ipKey(req) {
    // Behind exactly one trusted proxy (Caddy), the real client IP is the LAST
    // entry of X-Forwarded-For; a client-injected XFF is to its left.
    const xff = req.headers && req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }
  function throttled(req) {
    const e = attempts.get(ipKey(req));
    return !!(e && e.until && Date.now() < e.until);
  }
  function recordFail(req) {
    const k = ipKey(req);
    const e = attempts.get(k) || { count: 0, until: 0 };
    e.count += 1;
    if (e.count >= MAX_FAILS) { e.until = Date.now() + LOCK_MS; e.count = 0; }
    attempts.set(k, e);
  }
  function recordSuccess(req) { attempts.delete(ipKey(req)); }

  // --- handlers ---
  function handleLogin(req, res) {
    if (!enabled) return res.json({ ok: true }); // auth disabled: accept, no cookie needed
    if (throttled(req)) {
      return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
    }
    const body = req.body || {};
    const okUser = constantEq(body.username || '', username);
    const okPass = constantEq(body.password || '', password);
    if (!okUser || !okPass) {
      recordFail(req);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    recordSuccess(req);
    setSession(res, sign({ u: username, pv: passEpoch, exp: Date.now() + SESSION_TTL_MS }));
    return res.json({ ok: true });
  }

  function handleLogout(_req, res) {
    clearSession(res);
    return res.status(204).end();
  }

  // Gate: allow the login assets + any authed request; 401 JSON for /api/*,
  // otherwise bounce a top-level navigation to the login page.
  const PUBLIC_PATHS = new Set(['/login', '/login.html', '/logout', '/favicon.ico']);
  function gate(req, res, next) {
    if (!enabled) return next();
    if (isAuthed(req)) return next();
    if (PUBLIC_PATHS.has(req.path)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect(302, '/login');
  }

  return { enabled, username, gate, handleLogin, handleLogout, isAuthed, COOKIE };
}

module.exports = { createAuth };
