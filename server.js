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

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
app.post('/api/provider', requireCap('primary'), async (req, res) => {
  const { provider, apiKey, custom } = req.body || {};
  try {
    const r = await adapter.setPrimary(provider, apiKey, custom);
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`AI Panel (product=${PRODUCT}) listening on 127.0.0.1:${PORT}`);
  // Fire-and-forget the one-time avots auto-connect. Runs after the server is
  // up so the panel is reachable immediately even while this completes.
  preconnectAvots().catch((e) => console.error('[preconnect] unexpected error:', e));
});
