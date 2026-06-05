'use strict';
/*
 * avots-oauth.js — keyless "Connect Avots" via OAuth 2.1 (DCR + PKCE).
 *
 * The avots backend (issuer https://mcp.avots.ai) is a public OAuth 2.1 server
 * that supports Dynamic Client Registration (DCR) and the Authorization Code
 * flow with PKCE (S256). The resulting access_token is a real `av_mcp_…` key
 * that works for BOTH the OpenAI-compatible API (https://api.avots.ai/openai/v1)
 * and the MCP endpoint (https://mcp.avots.ai/). So a single browser-based login
 * gives the panel everything it needs to configure the agent — no key paste.
 *
 * This module is the pure OAuth machinery: endpoint URLs, DCR, PKCE helpers, an
 * in-memory flow store (keyed by `state`, ~10 min TTL, CSRF protection), and the
 * persisted client_id + tokens (all 0600 in the panel state dir). server.js wires
 * two routes (/oauth/avots/start, /oauth/avots/callback) onto it and hands the
 * resulting token to the active adapter.
 *
 * Security: the access_token / refresh_token / code_verifier are NEVER logged.
 * Persisted files are written 0600. State is validated on callback (a flow that
 * isn't in the store — wrong/expired/forged state — is rejected). Uses Node's
 * global fetch and the crypto module (Node 18+).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// === confirmed avots OAuth 2.1 endpoints ===================================
const ISSUER          = 'https://mcp.avots.ai';
const DISCOVERY_URL   = `${ISSUER}/.well-known/oauth-authorization-server`;
const REGISTER_URL    = `${ISSUER}/v1/oauth/register`;
const AUTHORIZE_URL   = `${ISSUER}/oauth/authorize`;
const TOKEN_URL       = `${ISSUER}/v1/oauth/token`;
const SCOPE           = 'mcp offline_access';

// === persisted state (panel state dir, all files 0600) =====================
const STATE_DIR    = path.join(process.env.HOME || os.homedir(), '.config', 'clawpanel');
const CLIENT_FILE  = path.join(STATE_DIR, 'avots-oauth.json');     // { client_id, registered_at, redirect_uri }
const TOKEN_FILE   = path.join(STATE_DIR, 'avots-token.json');     // { access_token, refresh_token, obtained_at }

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

// --- registered client persistence ------------------------------------------
function loadClient() {
  try {
    const data = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
    if (data && typeof data.client_id === 'string' && data.client_id.length > 0) return data;
  } catch (_) {}
  return null;
}

function saveClient(obj) {
  ensureStateDir();
  fs.writeFileSync(CLIENT_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

// --- token persistence (never logged) ----------------------------------------
function saveTokens({ access_token, refresh_token }) {
  ensureStateDir();
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ access_token, refresh_token: refresh_token || null, obtained_at: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  );
}

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

// === PKCE helpers ============================================================
// base64url with no padding (RFC 7636 / RFC 4648 §5).
function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// code_verifier: 43–128 chars of [A-Za-z0-9-._~]. base64url of 32 random bytes
// yields 43 chars, comfortably inside the spec range.
function makeCodeVerifier() {
  return base64url(crypto.randomBytes(32));
}

// code_challenge = BASE64URL(SHA256(ASCII(code_verifier))) for method S256.
function codeChallengeS256(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
}

function makeState() {
  return base64url(crypto.randomBytes(32));
}

// === in-memory flow store (CSRF + PKCE state), keyed by `state` =============
// Each entry: { verifier, state, model, createdAt }. Pruned on every access; a
// flow older than FLOW_TTL_MS is treated as expired/absent.
const FLOW_TTL_MS = 10 * 60 * 1000; // ~10 minutes
const flows = new Map();

function pruneFlows() {
  const now = Date.now();
  for (const [k, v] of flows) {
    if (!v || (now - v.createdAt) > FLOW_TTL_MS) flows.delete(k);
  }
}

function putFlow(state, entry) {
  pruneFlows();
  flows.set(state, entry);
}

// Look up AND delete (single-use). Returns null if missing or expired.
function takeFlow(state) {
  pruneFlows();
  if (!state || !flows.has(state)) return null;
  const entry = flows.get(state);
  flows.delete(state);
  if (!entry || (Date.now() - entry.createdAt) > FLOW_TTL_MS) return null;
  return entry;
}

// === redirect_uri =============================================================
// The callback is THIS panel's own public URL. The panel sits behind Caddy on
// :8443; Caddy proxies all paths to it, so /oauth/avots/callback is reachable.
function redirectUri(panelDomain) {
  const domain = (panelDomain || '').trim();
  if (!domain) return null;
  return `https://${domain}:8443/oauth/avots/callback`;
}

// === Dynamic Client Registration =============================================
// Ensure a registered public client exists. Reads the persisted {client_id};
// if absent (or registered against a different redirect_uri), performs DCR and
// persists the result. Returns { client_id }.
async function ensureClient(redirect_uri, panelDomain) {
  const existing = loadClient();
  if (existing && existing.client_id && existing.redirect_uri === redirect_uri) {
    return existing;
  }
  const body = {
    redirect_uris: [redirect_uri],
    client_name: `CloudHosting Panel ${(panelDomain || '').trim()}`.trim(),
    token_endpoint_auth_method: 'none', // public client
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: SCOPE,
  };
  const resp = await fetch(REGISTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    const e = new Error(`DCR failed (${resp.status})`);
    e.detail = (detail || '').slice(0, 300);
    throw e;
  }
  const data = await resp.json();
  if (!data || typeof data.client_id !== 'string' || !data.client_id) {
    throw new Error('DCR response missing client_id');
  }
  const rec = {
    client_id: data.client_id,
    redirect_uri,
    registered_at: new Date().toISOString(),
  };
  saveClient(rec);
  return rec;
}

// === authorize URL ===========================================================
function buildAuthorizeUrl({ client_id, redirect_uri, state, code_challenge }) {
  const qs = new URLSearchParams({
    client_id,
    redirect_uri,
    response_type: 'code',
    scope: SCOPE,
    state,
    code_challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${qs.toString()}`;
}

// === token exchange ==========================================================
// Public client: token_endpoint_auth_method=none, NO client_secret. Body is
// application/x-www-form-urlencoded. Returns { access_token, refresh_token,
// token_type }. The token is never logged here or by callers.
async function exchangeCode({ code, redirect_uri, client_id, code_verifier }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri,
    client_id,
    code_verifier,
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    const e = new Error(`token exchange failed (${resp.status})`);
    e.detail = (detail || '').slice(0, 300);
    throw e;
  }
  const data = await resp.json();
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('token response missing access_token');
  }
  return data;
}

// Optional: fetch the discovery doc (values above are already confirmed, so
// callers don't need this, but it's handy for diagnostics). Never throws fatally.
async function fetchDiscovery() {
  try {
    const resp = await fetch(DISCOVERY_URL, { headers: { accept: 'application/json' } });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  }
}

module.exports = {
  // constants
  ISSUER, DISCOVERY_URL, REGISTER_URL, AUTHORIZE_URL, TOKEN_URL, SCOPE,
  CLIENT_FILE, TOKEN_FILE, FLOW_TTL_MS,
  // pkce
  base64url, makeCodeVerifier, codeChallengeS256, makeState,
  // flow store
  putFlow, takeFlow, pruneFlows,
  // persistence
  loadClient, saveClient, saveTokens, loadTokens,
  // flow
  redirectUri, ensureClient, buildAuthorizeUrl, exchangeCode, fetchDiscovery,
};
