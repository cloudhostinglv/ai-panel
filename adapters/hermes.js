'use strict';
/*
 * hermes adapter — Hermes Agent (Nous Research) per-client VM.
 *
 * UNLIKE openclaw, this adapter does NOT shell out to a CLI. The panel runs in
 * an UNPRIVILEGED container that can only WRITE the shared data dir and then
 * `touch <data>/.apply-request`. A host-side systemd path unit watches that file
 * and runs `docker compose restart gateway`, so the agent re-reads the freshly
 * written config.yaml + .env at process start. (See /srv/ai-vms/hermes-vm.)
 *
 * Source of truth for the agent's secrets is therefore the DATA DIR:
 *   <data>/config.yaml  — non-secret model settings (provider/base_url/default),
 *                         api_key referenced as ${OPENAI_API_KEY}.
 *   <data>/.env         — OPENAI_API_KEY, OPENAI_BASE_URL, TELEGRAM_BOT_TOKEN,
 *                         TELEGRAM_ALLOWED_USERS, and (optional) DISCORD_BOT_TOKEN.
 *   <data>/.apply-request — touched after each write to signal the host applier.
 *
 * Env vars read:
 *   HERMES_DATA_DIR | DATA_DIR  — the shared data dir (default /opt/data, which is
 *                                 where docker-compose mounts ./data inside the
 *                                 panel container as /data; on the panel image the
 *                                 mount is /data, so deployments set DATA_DIR=/data).
 *
 * The agent surface (primary/messaging) maps onto the data-dir files. Fallback +
 * MCP capabilities are exposed but degrade gracefully (see notes below) because
 * upstream Hermes config support for them is not confirmed for this VM build.
 */
const fs = require('fs');
const path = require('path');

// Where the shared data dir lives from the panel's point of view. The compose
// file mounts the host ./data as /data inside the panel container; deployments
// pass DATA_DIR=/data. Default to /opt/data to match the applier docs / task.
const DATA_DIR = process.env.HERMES_DATA_DIR || process.env.DATA_DIR || '/opt/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.yaml');
const ENV_FILE = path.join(DATA_DIR, '.env');
const APPLY_REQUEST = path.join(DATA_DIR, '.apply-request');
// Native Hermes pairing: the agent persists pending approval requests under
// <data>/pairing/<platform>-pending.json; the panel reads them to list who is
// waiting. NOTE: `hermes pairing approve` takes the USER-FACING code (hashed in
// storage, so neither the panel nor `hermes pairing list` can supply it), so we
// approve by USER ID instead via the platform allowlist (TELEGRAM_ALLOWED_USERS),
// which is exactly what Hermes documents. The id is persisted in state.approved.
const PAIRING_DIR = path.join(DATA_DIR, 'pairing');
const PAIRING_FILE_RE = /^([a-z_][a-z0-9_]{1,30})-pending\.json$/;

const DEFAULT_MODEL = 'anthropic/claude-opus-4.8';
const DEFAULT_CONTEXT_LENGTH = 200000;

// Provider id -> OpenAI-compatible base URL. avots is the turnkey default.
// custom uses the user-supplied baseURL. google uses Gemini's OpenAI-compat URL.
const PROVIDERS = {
  avots:      { label: 'Avots AI', baseURL: 'https://api.avots.ai/openai/v1',                          defaultModel: 'anthropic/claude-opus-4.8' },
  openai:     { label: 'ChatGPT',  baseURL: 'https://api.openai.com/v1',                               defaultModel: 'openai/gpt-5.5' },
  anthropic:  { label: 'Claude',   baseURL: 'https://api.anthropic.com/v1/',                           defaultModel: 'anthropic/claude-opus-4.8' },
  google:     { label: 'Gemini',   baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'google/gemini-2.5-pro' },
  custom:     { label: 'Add your own', baseURL: null, defaultModel: null, custom: true },
};

const CHANNELS = { telegram: 'Telegram', discord: 'Discord' };

// MCP catalog kept identical to openclaw so the UI's MCP section renders the
// same options when the capability is on. (See MCP note in capabilities.)
const MCPS = {
  avots:       { label: 'Avots.ai',    url: 'https://mcp.avots.ai/' },
  composio:    { label: 'Composio',    url: 'https://mcp.composio.dev/composio/mcp' },
  linear:      { label: 'Linear',      url: 'https://mcp.linear.app/sse' },
  sentry:      { label: 'Sentry',      url: 'https://mcp.sentry.dev/sse' },
  browserbase: { label: 'Browserbase', url: 'https://mcp.browserbase.com/sse' },
  custom:      { label: 'Other MCP' },
};

function validateCustom(custom) {
  if (!custom || typeof custom !== 'object') return 'missing custom config';
  const { name, baseURL, modelId } = custom;
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name))
    return 'invalid name (a–z, 0–9, dash, 1–32 chars)';
  if (!baseURL || !/^https?:\/\/[\w.-]+(:\d+)?(\/.*)?$/.test(baseURL))
    return 'invalid base URL (must start with http:// or https://)';
  if (!modelId || typeof modelId !== 'string' || modelId.trim().length < 1)
    return 'missing model id';
  return null;
}

// Resolve { provider, apiKey, custom, model } -> { baseURL, model, label }.
// `modelOverride` (optional) replaces the provider's default model when set;
// for custom providers the model always comes from custom.modelId.
function resolveProvider(provider, custom, modelOverride) {
  if (provider === 'custom') {
    const err = validateCustom(custom);
    if (err) return { error: err };
    return {
      baseURL: custom.baseURL.trim().replace(/\/+$/, '') + '/',
      model: custom.modelId.trim(),
      label: custom.name.trim() + ' (custom)',
    };
  }
  const p = PROVIDERS[provider];
  if (!p) return { error: 'unknown provider' };
  const model = (typeof modelOverride === 'string' && modelOverride.trim())
    ? modelOverride.trim()
    : (p.defaultModel || DEFAULT_MODEL);
  return { baseURL: p.baseURL, model, label: p.label };
}

// Build a short, masked fingerprint of a secret so the UI can tell two keys
// apart without ever exposing the whole thing: a little of the head + the tail,
// e.g. "av_mcp…a1b2". Never returns more than head(6)+tail(4) of the original.
function maskKey(key) {
  const k = (key == null ? '' : String(key)).trim();
  if (!k) return null;
  if (k.length <= 6) return '…' + k.slice(-Math.min(2, k.length));
  return k.slice(0, 6) + '…' + k.slice(-4);
}

// Resolve a display hint for a stored item: prefer a saved keyHint, else derive
// from a full secret if we still hold it, else fall back to a saved tail.
function hintOf(o, fullKey) {
  if (o && o.keyHint) return o.keyHint;
  if (fullKey) return maskKey(fullKey);
  const tail = o && (o.keyTail || o.tokenTail);
  return tail ? '…' + String(tail) : null;
}

// --- data-dir read/merge helpers --------------------------------------------
// We keep a tiny side-car JSON (panel-state.json) holding the structured view of
// what the panel has configured, because config.yaml/.env are flat and we need
// to re-emit them whole on every change. This file never holds the secret key in
// plaintext beyond what already lives in .env (it stores only key tails + meta).
const STATE_FILE = path.join(DATA_DIR, 'panel-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return { primary: null, fallbacks: [], channels: [], mcps: [] };
  }
}
function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

// Read the existing .env into a map so we can update a few keys without clobbering
// any the autoinstall/firstboot may have set (e.g. PANEL_* are NOT here, but be safe).
function readEnv() {
  const out = {};
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch (_) {}
  return out;
}

function writeEnv(map) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const body = Object.entries(map)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
  fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
}

// Normalize an mcp name into the .env var suffix used in config.yaml, e.g.
// `avots` -> `MCP_AVOTS_KEY`, `my-github-mcp` -> `MCP_MY_GITHUB_MCP_KEY`.
function mcpEnvName(name) {
  return 'MCP_' + String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY';
}

// Emit config.yaml from the panel state. The model block comes from the active
// primary (provider="custom" selects any OpenAI-compatible endpoint; api_key is
// referenced from .env via ${OPENAI_API_KEY}). Every ENABLED mcp in the state is
// emitted under `mcp_servers:` with its Authorization header referencing a
// per-mcp .env var (e.g. ${MCP_AVOTS_KEY}). Hermes expands ${VAR} in config.yaml
// from its loaded .env.
function writeConfig(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const primary = state && state.primary;
  const model = (primary && primary.model) || DEFAULT_MODEL;
  const baseURL = (primary && primary.baseURL) || PROVIDERS.avots.baseURL;
  const yaml = [
    '# Written by the CloudHosting AI Panel (hermes adapter). Do not edit by hand;',
    '# the panel rewrites this file whole on every change.',
    'model:',
    '  # "custom" = any OpenAI-compatible endpoint; set base_url.',
    '  provider: "custom"',
    `  default: "${model}"`,
    `  base_url: "${baseURL}"`,
    '  # Secret lives in .env; referenced here. Hermes also falls back to OPENAI_API_KEY.',
    '  api_key: "${OPENAI_API_KEY}"',
    `  context_length: ${DEFAULT_CONTEXT_LENGTH}`,
    '',
    'approvals:',
    '  mode: "manual"',
    '  timeout: 60',
    '  cron_mode: "deny"',
    '',
    'platform_toolsets:',
    '  telegram: [hermes-telegram]',
    '',
    'session_reset:',
    '  mode: both',
    '  idle_minutes: 1440',
    '  at_hour: 4',
    'group_sessions_per_user: true',
    '',
  ];

  // Remote MCP servers: one entry per ENABLED mcp. The key is referenced from
  // .env so the secret never lands in config.yaml in plaintext.
  const mcps = (state && state.mcps || []).filter((m) => m && m.enabled !== false);
  if (mcps.length) {
    yaml.push('mcp_servers:');
    for (const m of mcps) {
      yaml.push(`  ${m.name}:`);
      yaml.push(`    url: "${m.url}"`);
      yaml.push('    headers:');
      yaml.push(`      Authorization: "Bearer \${${mcpEnvName(m.name)}}"`);
    }
    yaml.push('');
  }

  fs.writeFileSync(CONFIG_FILE, yaml.join('\n'), { mode: 0o600 });
}

// Signal the host applier: it watches this file via a systemd .path unit and
// runs `docker compose restart gateway`. We write a fresh timestamp so mtime
// always changes (a bare touch on an existing file is enough for the path unit,
// but writing content makes the trigger unambiguous and the action auditable).
function touchApplyRequest(reason) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(APPLY_REQUEST, `${new Date().toISOString()} ${reason || 'apply'}\n`, { mode: 0o600 });
  return { ok: true, applyRequest: APPLY_REQUEST, reason: reason || 'apply' };
}

// Re-emit config.yaml + .env from the current panel-state, then request apply.
// This is the single funnel every mutation goes through.
function applyAll(state, reason) {
  // .env: provider key + base url + telegram + (optional) discord.
  // A DISABLED primary (enabled === false) is treated as no active model: we drop
  // the key/base so the agent has nothing to call (the "off" state) but keep the
  // saved entry in panel-state so it can be re-enabled.
  const env = readEnv();
  const primaryActive = state.primary && state.primary.enabled !== false;
  if (primaryActive) {
    if (state.primary.apiKey) env.OPENAI_API_KEY = state.primary.apiKey;
    env.OPENAI_BASE_URL = state.primary.baseURL;
  } else {
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
  }
  // Telegram is the canonical messaging channel; Discord is mapped too if added.
  // Only ENABLED channels are wired (a disabled channel disconnects but stays saved).
  const tg = (state.channels || []).find((c) => c.type === 'telegram' && c.enabled !== false);
  const dc = (state.channels || []).find((c) => c.type === 'discord' && c.enabled !== false);
  if (tg) {
    env.TELEGRAM_BOT_TOKEN = tg.token;
    // Allowlist = typed "Allowed users" (minus disabled) + ENABLED approved users.
    // Empty => Hermes denies all.
    env.TELEGRAM_ALLOWED_USERS = [...effectiveAllow(state, 'telegram')].join(',');
  } else {
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.TELEGRAM_ALLOWED_USERS;
  }
  if (dc) env.DISCORD_BOT_TOKEN = dc.token; else delete env.DISCORD_BOT_TOKEN;

  // Per-mcp keys: drop any stale MCP_*_KEY first (so removed mcps don't linger),
  // then set one for every enabled mcp from its stored full key.
  for (const k of Object.keys(env)) {
    if (/^MCP_[A-Z0-9_]+_KEY$/.test(k)) delete env[k];
  }
  for (const m of (state.mcps || []).filter((x) => x && x.enabled !== false)) {
    if (m.apiKey) env[mcpEnvName(m.name)] = m.apiKey;
  }

  writeEnv(env);
  writeConfig(state);
  return touchApplyRequest(reason);
}

// === native pairing (approval) =============================================
// Read every <data>/pairing/<platform>-pending.json and flatten to a list the
// UI can render. The admin-facing "Code" (what `hermes pairing approve` and
// `hermes pairing list` use) is the first 8 hex chars of each entry's `hash`.
function listPairing() {
  let files;
  try { files = fs.readdirSync(PAIRING_DIR); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    const m = PAIRING_FILE_RE.exec(f);
    if (!m) continue;                       // skip _rate_limits.json etc.
    const platform = m[1];
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(PAIRING_DIR, f), 'utf8')); } catch (_) { continue; }
    if (!data || typeof data !== 'object') continue;
    for (const entry of Object.values(data)) {
      if (!entry || typeof entry !== 'object' || !entry.hash) continue;
      out.push({
        platform,
        code: String(entry.hash).slice(0, 8),
        userId: entry.user_id != null ? String(entry.user_id) : '',
        userName: entry.user_name || '',
        createdAt: entry.created_at || null,
      });
    }
  }
  // One person can have several pending requests (each unapproved message mints a
  // fresh code), so collapse to ONE row per user (platform+id), keeping the most
  // recent. Without a user id, fall back to deduping by code.
  const byUser = new Map();
  for (const item of out) {
    const key = item.userId ? `${item.platform}:${item.userId}` : `${item.platform}:#${item.code}`;
    const prev = byUser.get(key);
    if (!prev || (item.createdAt || 0) > (prev.createdAt || 0)) byUser.set(key, item);
  }
  const rows = [...byUser.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  // Hide anyone the panel already considers granted (effective allowlist) so an
  // already-allowed user (e.g. the owner who messaged before being added) stops
  // showing in Access requests with a no-op Approve.
  let st; try { st = loadState(); } catch (_) { st = {}; }
  const grantedCache = {};
  const grantedFor = (platform) => grantedCache[platform] || (grantedCache[platform] = effectiveAllow(st, platform));
  return rows.filter((r) => !(r.userId && grantedFor(r.platform).has(r.userId)));
}

const PAIRING_PLATFORM_RE = /^[a-z_]{2,20}$/;
const PAIRING_USERID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

// Drop a user's pending entries from <platform>-pending.json so the Access
// requests card clears once they've been approved (best effort; the agent owns
// this file but re-reads it on restart, which the approve triggers).
function prunePending(platform, userId) {
  const file = path.join(PAIRING_DIR, `${platform}-pending.json`);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return; }
  if (!data || typeof data !== 'object') return;
  let changed = false;
  for (const [k, e] of Object.entries(data)) {
    if (e && String(e.user_id) === String(userId)) { delete data[k]; changed = true; }
  }
  if (changed) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); } catch (_) {} }
}

// === access (granted users) ================================================
// state.approved[platform] holds users granted via the Access-requests queue.
// Entries are objects { id, enabled, name }; legacy bare-id strings count as
// enabled. Normalizing in place lets a granted user be DISABLED (remembered) and
// re-ENABLED, like the other connected lists — not only added/removed.
function normApprovedList(arr) {
  return (Array.isArray(arr) ? arr : []).map((e) =>
    (e && typeof e === 'object')
      ? { id: String(e.id || '').trim(), enabled: e.enabled !== false, name: e.name || '' }
      : { id: String(e).trim(), enabled: true, name: '' }
  ).filter((e) => e.id);
}
function approvedFor(state, platform) {
  state.approved = (state.approved && typeof state.approved === 'object') ? state.approved : {};
  state.approved[platform] = normApprovedList(state.approved[platform]);
  return state.approved[platform];
}
// Effective allowlist id set for a platform: the channel's typed "Allowed users"
// (minus anyone explicitly disabled) plus every ENABLED approved user. Hermes
// joins this to a csv for TELEGRAM_ALLOWED_USERS.
function effectiveAllow(state, platform) {
  const appr = approvedFor(state, platform);
  const disabled = new Set(appr.filter((e) => !e.enabled).map((e) => e.id));
  const set = new Set();
  const ch = (state.channels || []).find((c) => c.type === platform);
  if (ch && typeof ch.allowedUsers === 'string')
    for (const s of ch.allowedUsers.split(',')) { const v = s.trim(); if (v && !disabled.has(v)) set.add(v); }
  for (const e of appr) if (e.enabled) set.add(e.id);
  return set;
}
// One row per granted user (typed field ∪ approved) for the UI. id is composite
// "<platform>:<uid>" so the shared toggle/remove handlers carry the platform;
// enabled = currently in the effective allowlist.
function listGranted(state) {
  const platforms = new Set();
  for (const c of (state.channels || [])) if (c && c.type) platforms.add(c.type);
  for (const k of Object.keys((state.approved && typeof state.approved === 'object') ? state.approved : {})) platforms.add(k);
  const rows = [];
  for (const platform of platforms) {
    const appr = approvedFor(state, platform);
    const allow = effectiveAllow(state, platform);
    const nameById = new Map(appr.map((e) => [e.id, e.name]));
    const ids = new Set();
    const ch = (state.channels || []).find((c) => c.type === platform);
    if (ch && typeof ch.allowedUsers === 'string') for (const s of ch.allowedUsers.split(',')) { const v = s.trim(); if (v) ids.add(v); }
    for (const e of appr) ids.add(e.id);
    for (const id of ids) rows.push({
      id: `${platform}:${id}`, platform, userId: id,
      label: nameById.get(id) || ('User ' + id),
      detail: `${platform} · ID ${id}`,
      enabled: allow.has(id),
    });
  }
  return rows;
}
// Accept either { id:"<platform>:<uid>" } (shared toggle/remove handlers) or an
// explicit { platform, userId } (the Approve button).
function parseUserRef(body) {
  let platform = body && body.platform, userId = body && body.userId;
  const id = body && body.id;
  if ((!platform || !userId) && typeof id === 'string' && id.includes(':')) {
    const i = id.indexOf(':'); platform = id.slice(0, i); userId = id.slice(i + 1);
  }
  return { platform: String(platform || '').trim(), userId: String(userId || '').trim() };
}

module.exports = {
  id: 'hermes',
  label: 'Hermes',

  // Agent surface. Primary + messaging are fully implemented via the data-dir
  // mechanism. Fallback + MCP are exposed but degrade gracefully (TODO upstream).
  capabilities: {
    primary: true,
    fallback: true,   // exposed; see addFallback TODO (no confirmed Hermes mapping yet)
    messaging: true,
    mcp: true,        // wired: addMcp writes mcp_servers + MCP_<NAME>_KEY env
    pairing: true,    // native Hermes approval: list pending + approve via applier
    openProduct: false,
    preconnect: true,
  },

  providers: PROVIDERS,
  channelTypes: CHANNELS,
  mcps: MCPS,

  openProductUrl() { return null; },

  // Hermes has no status CLI reachable from the unprivileged panel. We synthesize
  // a status blob from panel-state.json shaped like the openclaw `models status`
  // JSON the front-end already parses (resolvedDefault + fallbacks[]). On top of
  // that raw blob we ALSO return a clean structured `configured` object the UI
  // renders the "what's connected" lists from (see the contract in openclaw.js).
  async status() {
    const st = loadState();
    const modelsJson = {
      resolvedDefault: (st.primary && st.primary.enabled !== false) ? st.primary.model : null,
      fallbacks: (st.fallbacks || []).filter((f) => f && f.enabled !== false).map((f) => f.model),
    };
    const channelsJson = (st.channels || [])
      .filter((c) => c.enabled !== false)
      .map((c) => ({ type: c.type, label: c.label }));
    const mcpsJson = (st.mcps || [])
      .filter((x) => x.enabled !== false)
      .map((x) => ({ name: x.name, url: x.url }));

    // Structured view for the UI lists. ids are the same values removeX() filters
    // by: primary id = provider, fallback id = model, channel id = type, mcp id =
    // name. Empty arrays / null where nothing is configured.
    // Show ALL items (enabled AND disabled) with an `enabled` flag so the UI can
    // render a per-row on/off toggle next to remove. The top status counts above
    // still reflect only the ENABLED ones (modelsJson/channelsJson/mcpsJson).
    const configured = {
      primary: st.primary
        ? { id: st.primary.provider, provider: st.primary.provider, label: st.primary.label, model: st.primary.model, keyHint: hintOf(st.primary, st.primary.apiKey), enabled: st.primary.enabled !== false }
        : null,
      fallbacks: (st.fallbacks || [])
        .map((f) => ({ id: f.model, label: f.label, model: f.model, keyHint: hintOf(f, f.apiKey), enabled: f.enabled !== false })),
      channels: (st.channels || [])
        .map((c) => ({ id: c.type, type: c.type, label: c.label, keyHint: hintOf(c, c.token), enabled: c.enabled !== false })),
      mcps: (st.mcps || [])
        .map((x) => ({ id: x.name, name: x.name, url: x.url, keyHint: hintOf(x, x.apiKey), enabled: x.enabled !== false })),
    };

    return {
      models:   { ok: true, code: 0, stdout: JSON.stringify(modelsJson), stderr: '' },
      channels: { ok: true, code: 0, stdout: JSON.stringify(channelsJson), stderr: '' },
      mcps:     { ok: true, code: 0, stdout: JSON.stringify(mcpsJson), stderr: '' },
      configured,
      // Access requests: people who messaged the bot but aren't approved yet
      // (Approve), plus the granted users (on/off + remove). The shared UI renders
      // both in the "Access requests" card.
      pairing: { pending: listPairing(), granted: listGranted(st) },
    };
  },

  // List pending pairing requests (also surfaced inside status().pairing).
  listPairing() { return listPairing(); },

  // Approve a pending request by USER ID: add the id to the platform allowlist
  // (persisted in state.approved so it survives config rewrites) and re-apply.
  // The host applier restarts the gateway, which then admits that user. We can't
  // use `hermes pairing approve <code>` because the code is the user-facing one,
  // stored only as a salted hash; the allowlist-by-id is Hermes' documented path.
  async approvePairing({ platform, userId } = {}) {
    if (!PAIRING_PLATFORM_RE.test(platform || '')) return { error: 'invalid platform' };
    const uid = String(userId == null ? '' : userId).trim();
    if (!PAIRING_USERID_RE.test(uid)) return { error: 'invalid user id' };
    const st = loadState();
    const appr = approvedFor(st, platform);
    const ex = appr.find((e) => e.id === uid);
    if (ex) ex.enabled = true;
    else {
      const pend = listPairing().find((p) => p.platform === platform && p.userId === uid);
      appr.push({ id: uid, enabled: true, name: (pend && pend.userName) || '' });
    }
    prunePending(platform, uid);
    saveState(st);
    const apply = applyAll(st, 'approve-user');
    return { ok: apply.ok, queued: true, restart: apply };
  },

  // Remove a granted user entirely: drop from state.approved AND from the
  // channel's typed "Allowed users", then re-apply. Accepts { id:"<plat>:<uid>" }
  // (trash button) or { platform, userId }.
  async revokePairing(body = {}) {
    const { platform, userId } = parseUserRef(body);
    if (!PAIRING_PLATFORM_RE.test(platform || '')) return { error: 'invalid platform' };
    if (!PAIRING_USERID_RE.test(userId || '')) return { error: 'invalid user id' };
    const st = loadState();
    st.approved[platform] = approvedFor(st, platform).filter((e) => e.id !== userId);
    for (const c of (st.channels || [])) {
      if (c.type === platform && typeof c.allowedUsers === 'string') {
        c.allowedUsers = c.allowedUsers.split(',').map((s) => s.trim()).filter((s) => s && s !== userId).join(',');
      }
    }
    saveState(st);
    const apply = applyAll(st, 'revoke-user');
    return { ok: apply.ok, restart: apply };
  },

  // Enable/disable a configured item WITHOUT removing it (panel toggle). kind is
  // 'primary' | 'fallback' | 'channel' | 'mcp'; id matches status().configured ids
  // (primary→provider, fallback→model, channel→type, mcp→name). Persists the flag
  // and re-applies (applyAll only wires ENABLED items into config.yaml + .env).
  async setEnabled({ kind, id, enabled } = {}) {
    const on = !(enabled === false || enabled === 'false' || enabled === 0 || enabled === '0');
    const st = loadState();
    let found = false;
    if (kind === 'primary') {
      if (st.primary) { st.primary.enabled = on; found = true; }
    } else if (kind === 'fallback') {
      for (const f of (st.fallbacks || [])) if (f && (f.model === id || f.id === id)) { f.enabled = on; found = true; }
    } else if (kind === 'channel') {
      for (const c of (st.channels || [])) if (c && c.type === id) { c.enabled = on; found = true; }
    } else if (kind === 'mcp') {
      for (const m of (st.mcps || [])) if (m && m.name === id) { m.enabled = on; found = true; }
    } else if (kind === 'user') {
      // Granted-user on/off. id is "<platform>:<uid>". Off keeps the user in
      // state.approved with enabled:false so the allowlist drops them but they stay
      // in the list to flip back on. A csv-origin user (typed in "Allowed users")
      // is recorded into approved on first toggle so the off state persists.
      const { platform, userId } = parseUserRef({ id });
      if (!platform || !userId) return { error: 'invalid user ref' };
      const appr = approvedFor(st, platform);
      const ex = appr.find((e) => e.id === userId);
      if (ex) ex.enabled = on; else appr.push({ id: userId, enabled: on, name: '' });
      found = true;
    } else {
      return { error: 'unknown kind' };
    }
    if (!found) return { error: 'not found' };
    saveState(st);
    const apply = applyAll(st, `toggle-${kind}`);
    return { ok: apply.ok, enabled: on, restart: apply };
  },

  async setPrimary(provider, apiKey, custom, model) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8)
      return { error: 'missing api key' };
    const r = resolveProvider(provider, custom, model);
    if (r.error) return { error: r.error };

    const st = loadState();
    st.primary = { provider, label: r.label, model: r.model, baseURL: r.baseURL, apiKey: apiKey.trim(), keyHint: maskKey(apiKey.trim()), enabled: true };
    saveState(st);
    const apply = applyAll(st, 'set-primary');
    // Shape mirrors openclaw: front-end checks r.auth.ok && (!r.set || r.set.ok).
    return {
      auth: { ok: true, code: 0, stdout: 'config.yaml + .env written', stderr: '' },
      set:  { ok: apply.ok, code: 0, stdout: `default model ${r.model}`, stderr: '' },
      restart: apply,
    };
  },

  // Hermes (this VM build) has no confirmed multi-model fallback chain like the
  // OpenClaw gateway. We persist the fallback in panel-state so the UI reflects it
  // and re-apply, but mark it a TODO: until upstream support is confirmed, only the
  // primary model is wired into config.yaml. The capability is left ON so the
  // section renders; the response carries `todo` so the operator knows.
  async addFallback(provider, apiKey, custom) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8)
      return { error: 'missing api key' };
    const r = resolveProvider(provider, custom);
    if (r.error) return { error: r.error };

    const st = loadState();
    st.fallbacks = st.fallbacks || [];
    st.fallbacks.push({ provider, label: r.label, model: r.model, baseURL: r.baseURL, keyTail: apiKey.trim().slice(-3), keyHint: maskKey(apiKey.trim()), enabled: true });
    saveState(st);
    const apply = applyAll(st, 'add-fallback');
    return {
      auth: { ok: true, code: 0, stdout: 'fallback recorded', stderr: '' },
      add:  { ok: apply.ok, code: 0, stdout: `fallback ${r.model} recorded`, stderr: '' },
      restart: apply,
      todo: 'Hermes fallback chain not confirmed for this VM; recorded in panel-state only.',
    };
  },

  // Remove a recorded fallback. The UI passes the fallback's model id (which is
  // also what status().configured exposes as the fallback id), so filter by model
  // (fall back to a stored id if one is ever present), persist, then re-apply.
  async removeFallback(id) {
    const st = loadState();
    st.fallbacks = (st.fallbacks || []).filter((f) => f && f.model !== id && f.id !== id);
    saveState(st);
    const apply = applyAll(st, 'remove-fallback');
    return { ok: apply.ok, restart: apply };
  },

  async setActivePrimary(/* id */) {
    return { ok: true, todo: 'Hermes has a single active primary; switching is done by re-running setPrimary.' };
  },

  async removePrimary(/* id */) {
    const st = loadState();
    st.primary = null;
    saveState(st);
    const apply = applyAll(st, 'remove-primary');
    return { ok: apply.ok, restart: apply };
  },

  async addChannel(channel, token, allowedUsers) {
    if (!CHANNELS[channel]) return { error: 'unknown channel' };
    if (!token || typeof token !== 'string' || token.length < 8)
      return { error: 'missing token' };
    const st = loadState();
    st.channels = (st.channels || []).filter((c) => c.type !== channel);
    st.channels.push({
      type: channel,
      label: CHANNELS[channel],
      token: token.trim(),
      tokenTail: token.trim().slice(-3),
      keyHint: maskKey(token.trim()),
      allowedUsers: typeof allowedUsers === 'string' ? allowedUsers.trim() : '',
      enabled: true,
    });
    saveState(st);
    const apply = applyAll(st, 'add-channel');
    return { add: { ok: apply.ok, code: 0, stdout: `${CHANNELS[channel]} connected`, stderr: '' }, restart: apply };
  },

  async removeChannel(id) {
    const st = loadState();
    st.channels = (st.channels || []).filter((c) => (c.type + ':' + (c.tokenTail || '')) !== id && c.type !== id);
    saveState(st);
    const apply = applyAll(st, 'remove-channel');
    return { ok: apply.ok, restart: apply };
  },

  // MCP: Hermes supports remote MCP servers in config.yaml under `mcp_servers`.
  // We store the full key in panel-state and applyAll wires it into .env (as
  // MCP_<NAME>_KEY) + config.yaml (mcp_servers.<name> with a Bearer header that
  // references that env var). The agent picks it up on the next restart.
  async addMcp({ provider, apiKey, name: customName, url: customUrl }) {
    if (!MCPS[provider]) return { error: 'unknown mcp' };
    // Reuse-the-key: when adding the Avots MCP and no key is supplied, fall back
    // to the avots primary's key — the same av_mcp_ token works for BOTH the
    // OpenAI API surface and the MCP surface, so the client needn't paste it twice.
    if (provider === 'avots' && (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8)) {
      const st0 = loadState();
      if (st0.primary && st0.primary.provider === 'avots' && st0.primary.apiKey) {
        apiKey = st0.primary.apiKey;
      }
    }
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8)
      return { error: 'missing api key' };
    let name, url;
    if (provider === 'custom') {
      if (!customName || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(customName))
        return { error: 'invalid name (a-z, 0-9, dash, 1-32 chars)' };
      if (!customUrl || !/^https?:\/\//.test(customUrl))
        return { error: 'invalid URL (must start with http:// or https://)' };
      name = customName.trim(); url = customUrl.trim();
    } else {
      name = provider; url = MCPS[provider].url;
    }
    const st = loadState();
    // Dedupe by name: re-adding/re-connecting the same MCP REPLACES the prior
    // entry (otherwise a stale keyless entry + the new one would emit a duplicate
    // `<name>:` key under mcp_servers in config.yaml).
    st.mcps = (st.mcps || []).filter((x) => x.name !== name);
    st.mcps.push({ name, url, apiKey: apiKey.trim(), keyTail: apiKey.trim().slice(-3), keyHint: maskKey(apiKey.trim()), enabled: true });
    saveState(st);
    const apply = applyAll(st, 'add-mcp');
    return {
      add: { ok: apply.ok, code: 0, stdout: `${name} connected`, stderr: '' },
      reload: apply,
    };
  },

  async removeMcp(id) {
    const st = loadState();
    st.mcps = (st.mcps || []).filter((x) => ((x.name || '').toLowerCase() + ':' + (x.keyTail || '')) !== id && (x.name || '') !== id);
    saveState(st);
    const apply = applyAll(st, 'remove-mcp');
    return { ok: apply.ok, restart: apply };
  },

  // Turnkey avots: write config.yaml (provider=custom, avots base) + .env
  // (OPENAI_API_KEY + OPENAI_BASE_URL) then request apply. Idempotent — if the
  // primary is already set to an avots-backed config we skip rewriting the key.
  async preconnectAvots(key) {
    if (!key) return { preconnected: false, skipped: 'no-key' };
    const st = loadState();
    if (st.primary && st.primary.provider === 'avots' && st.primary.apiKey) {
      return { preconnected: true, skipped: 'already-configured' };
    }
    // Only set avots as primary if nothing else is configured (don't clobber a
    // client's explicit choice). If a non-avots primary exists, leave it.
    if (st.primary && st.primary.provider !== 'avots') {
      return { preconnected: false, skipped: 'other-primary-set' };
    }
    st.primary = {
      provider: 'avots',
      label: PROVIDERS.avots.label,
      model: PROVIDERS.avots.defaultModel,
      baseURL: PROVIDERS.avots.baseURL,
      apiKey: key.trim(),
      keyHint: maskKey(key.trim()),
      enabled: true,
    };
    saveState(st);
    const apply = applyAll(st, 'preconnect-avots');
    return { preconnected: apply.ok, model: PROVIDERS.avots.defaultModel, restart: apply };
  },

  restart() { return touchApplyRequest('manual-restart'); },
};
