'use strict';
/*
 * AI Panel - product-aware branded control panel for a single-tenant AI VM.
 *
 * The panel is PRODUCT-AWARE: the PRODUCT env var selects an adapter under
 * adapters/<product>.js that implements the active product's behaviour:
 *
 *   PRODUCT=openclaw (default) -> OpenClaw agent (CLI via execFile)
 *   PRODUCT=hermes             -> Hermes agent (data-dir config + .apply-request)
 *   PRODUCT=flowise|langflow|dify -> builders (reduced: link into the product UI)
 *
 * server.js stays thin: it loads the adapter at boot and routes every /api/*
 * endpoint through it, surfacing the adapter's `capabilities` + `product` in
 * /api/status so the UI can render only the sections that apply. The avots
 * auto-preconnect and the local mock mode (front-end) are preserved.
 *
 * Security: each adapter is responsible for its own safety (openclaw uses
 * execFile with the key on stdin / tokens in 0600 files; hermes only writes the
 * unprivileged data dir; builders touch nothing). server.js never shells out.
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const avotsOAuth = require('./avots-oauth');
const { createAuth } = require('./auth');

const app = express();
app.use(express.json({ limit: '64kb' }));
// NOTE: static is mounted AFTER the auth gate further down, so unauthenticated
// requests can't read index.html / the app assets. Only the login page is public.

const PORT = Number(process.env.PANEL_PORT || 19000);

// === product adapter selection =============================================
const KNOWN_PRODUCTS = ['openclaw', 'hermes', 'flowise', 'langflow', 'dify'];
const PRODUCT = (process.env.PRODUCT || 'openclaw').trim().toLowerCase();
if (!KNOWN_PRODUCTS.includes(PRODUCT)) {
  console.error(`[boot] unknown PRODUCT="${PRODUCT}"; valid: ${KNOWN_PRODUCTS.join(', ')}`);
  process.exit(1);
}
let adapter;
try {
  adapter = require(path.join(__dirname, 'adapters', `${PRODUCT}.js`));
} catch (e) {
  console.error(`[boot] failed to load adapter adapters/${PRODUCT}.js:`, (e && e.message) || e);
  process.exit(1);
}
const CAP = adapter.capabilities || {};

// === panel-local state (brand name) ========================================
// Lives outside the code directory so code-only updates don't wipe it.
const STATE_DIR = path.join(process.env.HOME || os.homedir(), '.config', 'clawpanel');
const BRAND_FILE = path.join(STATE_DIR, 'brand.json');
const DEFAULT_BRAND_NAME = 'Your AI Assistant';
const BRAND_MAX_LEN = 60;

function loadBrandName() {
  try {
    const data = JSON.parse(fs.readFileSync(BRAND_FILE, 'utf8'));
    if (data && typeof data.name === 'string' && data.name.trim().length > 0) {
      return data.name.trim().slice(0, BRAND_MAX_LEN);
    }
  } catch (_) {}
  return DEFAULT_BRAND_NAME;
}

function saveBrandName(name) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(BRAND_FILE, JSON.stringify({ name }, null, 2), { mode: 0o600 });
}

// === authentication ========================================================
// The panel sets API keys and is public on :8443, so everything below the gate
// requires a session. Only the login page + /login + /logout are public; the
// gate 401s /api/* and redirects any other unauthenticated navigation to /login.
const auth = createAuth({ stateDir: STATE_DIR });
const LOGIN_PAGE = path.join(__dirname, 'public', 'login.html');

// GET /login (and /login.html): serve the login page; if already signed in,
// skip it and go to the panel.
app.get(['/login', '/login.html'], (req, res) => {
  if (auth.isAuthed(req)) return res.redirect(302, '/');
  res.sendFile(LOGIN_PAGE);
});
app.post('/login', (req, res) => auth.handleLogin(req, res));
app.post('/logout', (req, res) => auth.handleLogout(req, res));

// Everything registered after this line is protected.
app.use(auth.gate);
app.use(express.static(path.join(__dirname, 'public')));

// === avots auto-preconnect (turnkey) =======================================
// Same two hooks as Phase 1, in order:
//   1. process.env.AVOTS_API_KEY        - set by the systemd unit / provisioner.
//   2. ~/.openclaw/secrets/avots.key    - a 0600 file dropped on disk.
// The actual connect work is delegated to adapter.preconnectAvots(key); each
// product implements it appropriately (openclaw: CLI; hermes: data-dir write;
// builders: documented stub). Failures are logged, never crash the panel.
const AVOTS_KEY_FILE = path.join(process.env.HOME || os.homedir(), '.openclaw', 'secrets', 'avots.key');
let avotsPreconnected = false;

function readAvotsKey() {
  const envKey = (process.env.AVOTS_API_KEY || '').trim();
  if (envKey.length >= 8) return envKey;
  try {
    const fileKey = fs.readFileSync(AVOTS_KEY_FILE, 'utf8').trim();
    if (fileKey.length >= 8) return fileKey;
  } catch (_) {}
  return null;
}

async function preconnectAvots() {
  if (!CAP.preconnect || typeof adapter.preconnectAvots !== 'function') {
    console.log(`[preconnect] product "${PRODUCT}" does not support avots preconnect; skipping`);
    return;
  }
  const key = readAvotsKey();
  if (!key) {
    console.log('[preconnect] no AVOTS_API_KEY env or avots.key file; skipping avots auto-connect');
    return;
  }
  try {
    const r = await adapter.preconnectAvots(key);
    avotsPreconnected = !!(r && r.preconnected);
    if (avotsPreconnected) {
      console.log(`[preconnect] avots preconnected via "${PRODUCT}" adapter` + (r.skipped ? ` (${r.skipped})` : ''));
    } else {
      console.log(`[preconnect] avots not preconnected` + (r && r.skipped ? ` (${r.skipped})` : '') + (r && r.todo ? ` — ${r.todo}` : ''));
    }
  } catch (e) {
    console.error('[preconnect] adapter.preconnectAvots threw:', (e && e.message) || e);
  }
}

// === routes ================================================================

// /api/status — the UI's single source of truth. Includes the active product,
// its capability flags, and (for agents) the model/channel status the adapter
// reports plus the catalogs the UI renders.
app.get('/api/status', async (_req, res) => {
  let base = {};
  try {
    base = (await adapter.status()) || {};
  } catch (e) {
    base = { error: String((e && e.message) || e) };
  }
  res.json({
    ...base,
    product: PRODUCT,
    productLabel: adapter.label || PRODUCT,
    capabilities: CAP,
    openProductUrl: typeof adapter.openProductUrl === 'function' ? adapter.openProductUrl() : null,
    providers: adapter.providers || {},
    channelTypes: adapter.channelTypes || {},
    mcps: adapter.mcps || {},
    brandName: loadBrandName(),
    preconnected: avotsPreconnected,
  });
});

// Lightweight flag-only endpoint (mirrors the `preconnected` field).
app.get('/api/preconnect/status', (_req, res) => {
  res.json({ preconnected: avotsPreconnected, product: PRODUCT });
});

// Rename the panel's hero title. Cosmetic only - no product impact.
app.post('/api/brand', (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  const cleaned = name.trim().slice(0, BRAND_MAX_LEN);
  if (cleaned.length < 1) return res.status(400).json({ error: 'name too short' });
  try {
    saveBrandName(cleaned);
    res.json({ ok: true, name: cleaned });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Guard agent-only endpoints behind the capability flag so a builder can't be
// driven into agent operations. Returns 404 with a clear message when off.
function requireCap(cap) {
  return (req, res, next) => {
    if (!CAP[cap]) return res.status(404).json({ error: `'${cap}' is not available for product '${PRODUCT}'` });
    next();
  };
}

// Set the active primary LLM (+ optional custom OpenAI-compatible endpoint).
// `model` is optional: when present it overrides the provider's default model.
app.post('/api/provider', requireCap('primary'), async (req, res) => {
  const { provider, apiKey, custom, model } = req.body || {};
  try {
    const r = await adapter.setPrimary(provider, apiKey, custom, model);
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Add a fallback (secondary) AI.
app.post('/api/fallback', requireCap('fallback'), async (req, res) => {
  const { provider, apiKey, custom } = req.body || {};
  try {
    const r = await adapter.addFallback(provider, apiKey, custom);
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Connect a messaging channel (Telegram/Discord).
app.post('/api/channel', requireCap('messaging'), async (req, res) => {
  const { channel, token, allowedUsers } = req.body || {};
  try {
    const r = await adapter.addChannel(channel, token, allowedUsers);
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Attach an MCP server (extra tools for the agent).
app.post('/api/mcp', requireCap('mcp'), async (req, res) => {
  try {
    const r = await adapter.addMcp(req.body || {});
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// === remove routes =========================================================
// The "what's connected" lists in the UI render from status().configured and
// each row has a trash button that POSTs here with the configured row's id. Each
// route is gated by the SAME capability as its add counterpart and delegates to
// the adapter; the UI re-runs loadStatus() afterwards to refresh the lists.

// Remove the active primary AI.
app.post('/api/primary/remove', requireCap('primary'), async (req, res) => {
  const { id } = req.body || {};
  try {
    const r = await adapter.removePrimary(id);
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Remove a saved fallback AI (by model id).
app.post('/api/fallback/remove', requireCap('fallback'), async (req, res) => {
  const { id } = req.body || {};
  try {
    const r = await adapter.removeFallback(id);
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Disconnect a messaging channel (by channel id/type).
app.post('/api/channel/remove', requireCap('messaging'), async (req, res) => {
  const { id } = req.body || {};
  try {
    const r = await adapter.removeChannel(id);
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Detach an MCP server (by name id).
app.post('/api/mcp/remove', requireCap('mcp'), async (req, res) => {
  const { id } = req.body || {};
  try {
    const r = await adapter.removeMcp(id);
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// === enable/disable toggle =================================================
// Flip a configured item on/off without removing it. Body: {kind,id,enabled}.
// kind maps to the section capability so a builder/agent can't toggle a section
// it doesn't have. Delegates to adapter.setEnabled; the UI re-runs loadStatus().
app.post('/api/toggle', async (req, res) => {
  const kind = (req.body && req.body.kind) || '';
  const capByKind = { primary: 'primary', fallback: 'fallback', channel: 'messaging', mcp: 'mcp', user: 'pairing' };
  const cap = capByKind[kind];
  if (!cap) return res.status(400).json({ error: `unknown kind '${kind}'` });
  if (!CAP[cap]) return res.status(404).json({ error: `'${kind}' is not available for product '${PRODUCT}'` });
  if (typeof adapter.setEnabled !== 'function') {
    return res.status(404).json({ error: `toggle is not available for product '${PRODUCT}'` });
  }
  try {
    const r = await adapter.setEnabled(req.body || {});
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// === restart the agent =====================================================
// Bounce the agent (gateway) when it gets stuck (provider hiccup, Telegram
// flood-control backoff, etc.). The adapter touches .apply-request; the host
// applier restarts the agent container. Agent products only (builders have no
// restart). Behind the auth gate like everything else.
app.post('/api/restart', async (_req, res) => {
  if (typeof adapter.restart !== 'function') {
    return res.status(404).json({ error: `restart is not available for product '${PRODUCT}'` });
  }
  try {
    const r = await adapter.restart();
    res.json({ ok: !(r && r.ok === false), ...(r && typeof r === 'object' ? r : {}) });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// === pairing (native approval queue) =======================================
// Users who message the agent but aren't approved show up in status().pairing
// .pending (read straight from the data dir). Approving one delegates to the
// adapter, which hands the host applier a request to run the gateway's
// `hermes pairing approve <platform> <code>`. Gated by the 'pairing' capability.
app.post('/api/pairing/approve', requireCap('pairing'), async (req, res) => {
  if (typeof adapter.approvePairing !== 'function') {
    return res.status(404).json({ error: `pairing approve is not available for product '${PRODUCT}'` });
  }
  try {
    const r = await adapter.approvePairing(req.body || {});
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.post('/api/pairing/revoke', requireCap('pairing'), async (req, res) => {
  if (typeof adapter.revokePairing !== 'function') {
    return res.status(404).json({ error: `pairing revoke is not available for product '${PRODUCT}'` });
  }
  try {
    const r = await adapter.revokePairing(req.body || {});
    if (r && r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// === Feature 1: "Connect Avots" via OAuth 2.1 (DCR + PKCE) — keyless =======
// avots issues a real `av_mcp_…` access_token that works for BOTH the
// OpenAI-compatible API and MCP, so one browser login configures the whole
// agent without the user pasting a key. Agents only (capabilities.primary).
// The redirect_uri is THIS panel's own public callback, reachable via Caddy:
//   https://${PANEL_DOMAIN}:8443/oauth/avots/callback
// Security: tokens/verifier are never logged; persisted files are 0600; the
// `state` is validated on callback (CSRF). See avots-oauth.js for the machinery.
const PANEL_DOMAIN = (process.env.PANEL_DOMAIN || '').trim();

// GET /oauth/avots/start?model=<optional avots model id>
//  1. ensure a registered DCR client (persisted client_id),
//  2. mint PKCE verifier/challenge + state, stash the flow in memory (TTL),
//  3. 302 the browser to the avots authorize URL.
app.get('/oauth/avots/start', async (req, res) => {
  if (!CAP.primary) {
    return res.status(404).json({ error: `avots OAuth is not available for product '${PRODUCT}'` });
  }
  const redirect_uri = avotsOAuth.redirectUri(PANEL_DOMAIN);
  if (!redirect_uri) {
    return res.status(500).json({ error: 'PANEL_DOMAIN is not set; cannot build the OAuth redirect URL. Set PANEL_DOMAIN to this panel\'s public host.' });
  }
  const model = (typeof req.query.model === 'string' && req.query.model.trim()) ? req.query.model.trim() : undefined;
  try {
    const client = await avotsOAuth.ensureClient(redirect_uri, PANEL_DOMAIN);
    const verifier = avotsOAuth.makeCodeVerifier();
    const challenge = avotsOAuth.codeChallengeS256(verifier);
    const state = avotsOAuth.makeState();
    avotsOAuth.putFlow(state, { verifier, state, model, createdAt: Date.now() });
    const url = avotsOAuth.buildAuthorizeUrl({
      client_id: client.client_id,
      redirect_uri,
      state,
      code_challenge: challenge,
    });
    return res.redirect(302, url);
  } catch (e) {
    // Never include token/verifier here (none exist yet at this stage anyway).
    console.error('[avots-oauth] start failed:', (e && e.message) || e);
    return res.redirect(302, '/?avots_error=start');
  }
});

// GET /oauth/avots/callback?code&state  (also handles ?error=)
//  1. validate + consume the flow by `state` (CSRF / replay protection),
//  2. exchange the code for the av_mcp_ token (PKCE),
//  3. persist {access_token, refresh_token} 0600,
//  4. configure BOTH surfaces via the active adapter (primary + MCP),
//  5. 302 back to the panel with ?connected=avots.
app.get('/oauth/avots/callback', async (req, res) => {
  if (!CAP.primary) {
    return res.status(404).json({ error: `avots OAuth is not available for product '${PRODUCT}'` });
  }
  const { code, state, error: oauthError } = req.query;

  // avots reported an error (e.g. user denied) — surface it gracefully.
  if (oauthError) {
    const safe = String(oauthError).replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'denied';
    return res.redirect(302, `/?avots_error=${encodeURIComponent(safe)}`);
  }

  const flow = avotsOAuth.takeFlow(typeof state === 'string' ? state : '');
  if (!flow) {
    // Missing/expired/forged state → reject (do not exchange the code).
    return res.redirect(302, '/?avots_error=state');
  }
  if (!code || typeof code !== 'string') {
    return res.redirect(302, '/?avots_error=code');
  }

  const redirect_uri = avotsOAuth.redirectUri(PANEL_DOMAIN);
  const client = avotsOAuth.loadClient();
  if (!redirect_uri || !client || !client.client_id) {
    return res.redirect(302, '/?avots_error=client');
  }

  let tokens;
  try {
    tokens = await avotsOAuth.exchangeCode({
      code,
      redirect_uri,
      client_id: client.client_id,
      code_verifier: flow.verifier,
    });
  } catch (e) {
    // Log only the (token-free) error message, never the code/verifier.
    console.error('[avots-oauth] token exchange failed:', (e && e.message) || e);
    return res.redirect(302, '/?avots_error=token');
  }

  const accessToken = tokens.access_token;
  try {
    avotsOAuth.saveTokens(tokens);
  } catch (e) {
    console.error('[avots-oauth] could not persist tokens:', (e && e.message) || e);
    // Non-fatal: we still configure the adapter below with the in-memory token.
  }

  // Configure BOTH surfaces with the av_mcp_ token via the active adapter:
  //   primary → OpenAI provider (base_url maps to https://api.avots.ai/openai/v1)
  //   MCP     → https://mcp.avots.ai/
  try {
    if (typeof adapter.setPrimary === 'function') {
      await adapter.setPrimary('avots', accessToken, null, flow.model || undefined);
    }
  } catch (e) {
    console.error('[avots-oauth] adapter.setPrimary failed:', (e && e.message) || e);
  }
  try {
    if (CAP.mcp && typeof adapter.addMcp === 'function') {
      await adapter.addMcp({ provider: 'avots', apiKey: accessToken });
    }
  } catch (e) {
    console.error('[avots-oauth] adapter.addMcp failed:', (e && e.message) || e);
  }

  // Reflect the turnkey "connected and ready" indicator like the preconnect path.
  avotsPreconnected = true;
  return res.redirect(302, '/?connected=avots');
});

// === Feature 2: pricing in the model dropdown ==============================
// GET /api/pricing — proxies the public avots pricing JSON with a ~1h in-memory
// cache. On any fetch failure returns { data: [] } so the UI degrades to plain
// model ids. Pricing applies to avots only (other providers bill direct).
const PRICING_URL = 'https://api.avots.ai/openai/v1/pricing';
const PRICING_TTL_MS = 60 * 60 * 1000; // ~1h
let pricingCache = { at: 0, body: null };

app.get('/api/pricing', async (_req, res) => {
  const now = Date.now();
  if (pricingCache.body && (now - pricingCache.at) < PRICING_TTL_MS) {
    return res.json(pricingCache.body);
  }
  try {
    const resp = await fetch(PRICING_URL, { headers: { accept: 'application/json' } });
    if (!resp.ok) throw new Error(`pricing fetch ${resp.status}`);
    const body = await resp.json();
    if (!body || !Array.isArray(body.data)) throw new Error('pricing shape');
    pricingCache = { at: now, body };
    return res.json(body);
  } catch (e) {
    console.error('[pricing] fetch failed:', (e && e.message) || e);
    // Serve a stale cache if we have one; otherwise degrade to empty.
    if (pricingCache.body) return res.json(pricingCache.body);
    return res.json({ data: [] });
  }
});

const HOST = process.env.PANEL_HOST || '0.0.0.0';  // 0.0.0.0 so Caddy (separate container) can reach panel:8080; set PANEL_HOST=127.0.0.1 for a native host deploy
app.listen(PORT, HOST, () => {
  console.log(`AI Panel (product=${PRODUCT}) listening on ${HOST}:${PORT}`);
  // Fire-and-forget the one-time avots auto-connect. Runs after the server is
  // up so the panel is reachable immediately even while this completes.
  preconnectAvots().catch((e) => console.error('[preconnect] unexpected error:', e));
});
