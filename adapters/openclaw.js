'use strict';
/*
 * openclaw adapter — config-file model (mirrors the hermes adapter).
 *
 * UNLIKE the old native build, this adapter does NOT shell out to the `openclaw`
 * CLI / `systemctl --user`. The panel runs in an UNPRIVILEGED container that can
 * only WRITE the shared config dir and `touch <dir>/.apply-request`; a host-side
 * applier then runs `docker compose restart openclaw-gateway` so the gateway
 * re-reads the freshly written openclaw.json + .env at start. (See
 * /srv/ai-vms/openclaw-vm. The previous native adapter is kept as
 * openclaw.js.native.bak.)
 *
 * Source of truth for the agent is the shared OpenClaw config dir (~/.openclaw):
 *   <dir>/openclaw.json   — gateway + models.providers + agents.defaults
 *                           (model.primary + allowlist + sandbox) + tools policy
 *                           + channels (allowFrom = owner ids). Secrets are
 *                           referenced as ${VAR}.
 *   <dir>/.env            — AVOTS_API_KEY (+ other provider keys), the channel
 *                           bot tokens, and OPENCLAW_GATEWAY_TOKEN (preserved).
 *   <dir>/.apply-request  — touched after each write to signal the host applier.
 *   <dir>/panel-state.json — the panel's structured view (provider/key meta,
 *                           enabled flags, allowFrom ids); never the secret beyond
 *                           the masked keyHint shown in the UI.
 *
 * Env: OPENCLAW_DATA_DIR | OPENCLAW_CONFIG_DIR — the shared dir as the panel sees
 * it (the compose mounts the host ~/.openclaw here; default /data).
 *
 * OpenClaw access model is OWNER-LOCK, not pairing: a channel only answers the ids
 * in channels.<type>.allowFrom. So there is NO "Access requests" queue (pairing
 * capability is off); the messaging "Allowed users" field maps to allowFrom.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = process.env.OPENCLAW_DATA_DIR || process.env.OPENCLAW_CONFIG_DIR || '/data';
const CONFIG_FILE = path.join(CONFIG_DIR, 'openclaw.json');
const ENV_FILE = path.join(CONFIG_DIR, '.env');
const APPLY_REQUEST = path.join(CONFIG_DIR, '.apply-request');
const STATE_FILE = path.join(CONFIG_DIR, 'panel-state.json');

const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 32000;

// Provider id -> OpenAI-compatible base + default model. For OpenClaw the active
// model is the fully-qualified "<providerId>/<modelId>"; for avots that is e.g.
// "avots/anthropic/claude-opus-4.8" (note the doubled slash: provider id `avots`,
// model id `anthropic/claude-opus-4.8`).
const PROVIDERS = {
  avots:      { label: 'Avots AI',     baseURL: 'https://api.avots.ai/openai/v1',                            defaultModel: 'anthropic/claude-opus-4.8' },
  openai:     { label: 'ChatGPT',      baseURL: 'https://api.openai.com/v1',                                 defaultModel: 'gpt-5.5' },
  anthropic:  { label: 'Claude',       baseURL: 'https://api.anthropic.com/v1',                              defaultModel: 'claude-opus-4.8' },
  google:     { label: 'Gemini',       baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',  defaultModel: 'gemini-2.5-pro' },
  custom:     { label: 'Add your own', baseURL: null, defaultModel: null, custom: true },
};

const CHANNELS = { telegram: 'Telegram', discord: 'Discord' };

function envRefFor(providerId) {
  if (providerId === 'avots') return 'AVOTS_API_KEY';
  if (providerId === 'openai') return 'OPENAI_API_KEY';
  if (providerId === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (providerId === 'google') return 'GOOGLE_API_KEY';
  return 'PROVIDER_' + String(providerId || '').toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY';
}
function channelTokenEnv(type) {
  return type === 'discord' ? 'DISCORD_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN';
}

// --- masked key fingerprint (same as hermes) -------------------------------
function maskKey(key) {
  const k = (key == null ? '' : String(key)).trim();
  if (!k) return null;
  if (k.length <= 6) return '…' + k.slice(-Math.min(2, k.length));
  return k.slice(0, 6) + '…' + k.slice(-4);
}
function hintOf(o, fullKey) {
  if (o && o.keyHint) return o.keyHint;
  if (fullKey) return maskKey(fullKey);
  const tail = o && (o.keyTail || o.tokenTail);
  return tail ? '…' + String(tail) : null;
}

function validateCustom(custom) {
  if (!custom || typeof custom !== 'object') return 'missing custom config';
  const { name, baseURL, modelId } = custom;
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name))
    return 'invalid name (a-z, 0-9, dash, 1-32 chars)';
  if (!baseURL || !/^https?:\/\/[\w.-]+(:\d+)?(\/.*)?$/.test(baseURL))
    return 'invalid base URL (must start with http:// or https://)';
  if (!modelId || typeof modelId !== 'string' || modelId.trim().length < 1)
    return 'missing model id';
  return null;
}

// Resolve { provider, custom, modelOverride } -> a stored "entry" describing the
// provider id, model, base url, env ref, and label. `provider==='custom'` uses
// the user-supplied name/baseURL/modelId.
function resolveProvider(provider, custom, modelOverride) {
  if (provider === 'custom') {
    const err = validateCustom(custom);
    if (err) return { error: err };
    const providerId = custom.name.trim();
    return {
      providerId,
      provider: 'custom',
      label: providerId + ' (custom)',
      model: custom.modelId.trim(),
      baseURL: custom.baseURL.trim().replace(/\/+$/, ''),
      envRef: envRefFor(providerId),
    };
  }
  const p = PROVIDERS[provider];
  if (!p) return { error: 'unknown provider' };
  const model = (typeof modelOverride === 'string' && modelOverride.trim())
    ? modelOverride.trim()
    : p.defaultModel;
  return { providerId: provider, provider, label: p.label, model, baseURL: p.baseURL, envRef: envRefFor(provider) };
}

// --- state + file helpers ---------------------------------------------------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { primary: null, fallbacks: [], channels: [], mcps: [] }; }
}
function saveState(s) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch (_) {}
  return out;
}
function writeEnv(map) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const body = Object.entries(map)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
  fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
}
function touchApplyRequest(reason) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(APPLY_REQUEST, `${new Date().toISOString()} ${reason || 'apply'}\n`, { mode: 0o600 });
  return { ok: true, applyRequest: APPLY_REQUEST, reason: reason || 'apply' };
}

// Emit openclaw.json from the panel state. Static blocks (gateway, tools policy,
// sandbox) mirror the hardened openclaw-vm template; the dynamic blocks come from
// the active primary (+ enabled fallbacks) and enabled channels. Secrets are
// referenced as ${VAR}; OpenClaw resolves them from ~/.openclaw/.env.
function writeConfig(state) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const providers = {};
  const allowlist = {};
  const addProv = (p) => {
    if (!p || !p.model) return;
    const pid = p.providerId || p.provider;
    if (!providers[pid]) {
      providers[pid] = {
        baseUrl: p.baseURL,
        apiKey: '${' + (p.envRef || envRefFor(pid)) + '}',
        api: 'openai-completions',
        timeoutSeconds: 300,
        models: [],
      };
    }
    if (!providers[pid].models.some((m) => m.id === p.model)) {
      providers[pid].models.push({
        id: p.model,
        name: (p.label || pid) + ' ' + p.model,
        input: ['text', 'image'],
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        reasoning: true,
        compat: { supportsTools: true, supportsDeveloperRole: false },
      });
    }
    allowlist[`${pid}/${p.model}`] = { alias: p.label || `${pid}/${p.model}` };
  };

  const primary = (state.primary && state.primary.enabled !== false) ? state.primary : null;
  addProv(primary);
  for (const f of (state.fallbacks || []).filter((x) => x && x.enabled !== false)) addProv(f);

  const cfg = {
    gateway: { mode: 'local', bind: 'loopback', port: 18789, auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' } },
    models: { mode: 'merge', providers },
    tools: {
      profile: 'coding',
      deny: ['browser', 'canvas'],
      // OpenClaw schema: each sender maps to a POLICY OBJECT (not a bare array).
      // `{deny:[...]}` locks untrusted/unknown senders out of the high-blast tools.
      toolsBySender: { '*': { deny: ['exec', 'process', 'code_execution', 'write', 'edit', 'apply_patch'] } },
      elevated: { enabled: false },
      loopDetection: { enabled: true, historySize: 30, warningThreshold: 10, criticalThreshold: 20, globalCircuitBreakerThreshold: 30 },
    },
    agents: {
      defaults: {
        model: primary ? { primary: `${primary.providerId || primary.provider}/${primary.model}` } : {},
        models: allowlist,
        sandbox: { mode: 'all', workspaceAccess: 'none' },
      },
    },
    channels: {},
  };

  for (const c of (state.channels || []).filter((x) => x && x.enabled !== false)) {
    const ids = String(c.allowedUsers || '').split(',').map((s) => s.trim()).filter(Boolean);
    cfg.channels[c.type] = {
      enabled: true,
      botToken: '${' + channelTokenEnv(c.type) + '}',
      allowFrom: ids,
    };
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// Re-emit .env (secrets) + openclaw.json, then request apply. Single funnel for
// every mutation. OPENCLAW_GATEWAY_TOKEN and any other pre-seeded keys are
// preserved (readEnv keeps them).
function applyAll(state, reason) {
  const env = readEnv();
  const setKey = (p) => { if (p && p.apiKey) env[p.envRef || envRefFor(p.providerId || p.provider)] = p.apiKey; };
  if (state.primary && state.primary.enabled !== false) setKey(state.primary);
  for (const f of (state.fallbacks || []).filter((x) => x && x.enabled !== false)) setKey(f);

  const tg = (state.channels || []).find((c) => c.type === 'telegram' && c.enabled !== false);
  const dc = (state.channels || []).find((c) => c.type === 'discord' && c.enabled !== false);
  if (tg) env.TELEGRAM_BOT_TOKEN = tg.token; else delete env.TELEGRAM_BOT_TOKEN;
  if (dc) env.DISCORD_BOT_TOKEN = dc.token; else delete env.DISCORD_BOT_TOKEN;

  writeEnv(env);
  writeConfig(state);
  return touchApplyRequest(reason);
}

module.exports = {
  id: 'openclaw',
  label: 'OpenClaw',

  capabilities: {
    primary: true,
    fallback: true,    // recorded + allowlisted; auto-fallback chain TODO (verify on live VM)
    messaging: true,
    mcp: false,        // OpenClaw MCP config schema unverified; off until live-checked
    pairing: false,    // OpenClaw uses channel allowFrom (owner-lock), not a pairing queue
    openProduct: false,
    preconnect: true,
  },

  providers: PROVIDERS,
  channelTypes: CHANNELS,
  mcps: {},

  openProductUrl() { return null; },

  async status() {
    const st = loadState();
    const modelsJson = {
      resolvedDefault: (st.primary && st.primary.enabled !== false)
        ? `${st.primary.providerId || st.primary.provider}/${st.primary.model}` : null,
      fallbacks: (st.fallbacks || []).filter((f) => f && f.enabled !== false)
        .map((f) => `${f.providerId || f.provider}/${f.model}`),
    };
    const channelsJson = (st.channels || []).filter((c) => c.enabled !== false).map((c) => ({ type: c.type, label: c.label }));

    const configured = {
      primary: st.primary
        ? { id: st.primary.providerId || st.primary.provider, provider: st.primary.provider, label: st.primary.label, model: st.primary.model, keyHint: hintOf(st.primary, st.primary.apiKey), enabled: st.primary.enabled !== false }
        : null,
      fallbacks: (st.fallbacks || [])
        .map((f) => ({ id: f.model, label: f.label, model: f.model, keyHint: hintOf(f, f.apiKey), enabled: f.enabled !== false })),
      channels: (st.channels || [])
        .map((c) => ({ id: c.type, type: c.type, label: c.label, keyHint: hintOf(c, c.token), enabled: c.enabled !== false })),
      mcps: [],
    };

    return {
      models:   { ok: true, code: 0, stdout: JSON.stringify(modelsJson), stderr: '' },
      channels: { ok: true, code: 0, stdout: JSON.stringify(channelsJson), stderr: '' },
      mcps:     { ok: true, code: 0, stdout: '[]', stderr: '' },
      configured,
    };
  },

  // Enable/disable a configured item without removing it (panel toggle).
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
    } else {
      return { error: 'unknown kind' };
    }
    if (!found) return { error: 'not found' };
    saveState(st);
    const apply = applyAll(st, `toggle-${kind}`);
    return { ok: apply.ok, enabled: on, restart: apply };
  },

  async setPrimary(provider, apiKey, custom, model) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) return { error: 'missing api key' };
    const r = resolveProvider(provider, custom, model);
    if (r.error) return { error: r.error };
    const st = loadState();
    st.primary = { provider: r.provider, providerId: r.providerId, label: r.label, model: r.model, baseURL: r.baseURL, envRef: r.envRef, apiKey: apiKey.trim(), keyHint: maskKey(apiKey.trim()), enabled: true };
    saveState(st);
    const apply = applyAll(st, 'set-primary');
    return {
      auth: { ok: true, code: 0, stdout: 'openclaw.json + .env written', stderr: '' },
      set:  { ok: apply.ok, code: 0, stdout: `primary ${r.providerId}/${r.model}`, stderr: '' },
      restart: apply,
    };
  },

  async addFallback(provider, apiKey, custom) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) return { error: 'missing api key' };
    const r = resolveProvider(provider, custom);
    if (r.error) return { error: r.error };
    const st = loadState();
    st.fallbacks = st.fallbacks || [];
    st.fallbacks.push({ provider: r.provider, providerId: r.providerId, label: r.label, model: r.model, baseURL: r.baseURL, envRef: r.envRef, apiKey: apiKey.trim(), keyTail: apiKey.trim().slice(-3), keyHint: maskKey(apiKey.trim()), enabled: true });
    saveState(st);
    const apply = applyAll(st, 'add-fallback');
    return {
      auth: { ok: true, code: 0, stdout: 'fallback recorded', stderr: '' },
      add:  { ok: apply.ok, code: 0, stdout: `fallback ${r.providerId}/${r.model}`, stderr: '' },
      restart: apply,
      todo: 'OpenClaw auto-fallback chain not confirmed for this build; registered + allowlisted only.',
    };
  },

  async removeFallback(id) {
    const st = loadState();
    st.fallbacks = (st.fallbacks || []).filter((f) => f && f.model !== id && f.id !== id);
    saveState(st);
    const apply = applyAll(st, 'remove-fallback');
    return { ok: apply.ok, restart: apply };
  },

  async setActivePrimary(/* id */) {
    return { ok: true, todo: 'OpenClaw has a single active primary; switch by re-running setPrimary.' };
  },

  async removePrimary(/* id */) {
    const st = loadState();
    st.primary = null;
    saveState(st);
    const apply = applyAll(st, 'remove-primary');
    return { ok: apply.ok, restart: apply };
  },

  // The messaging "Allowed users" field maps to OpenClaw's channel allowFrom
  // (the owner-lock). Without it the gateway answers no one.
  async addChannel(channel, token, allowedUsers) {
    if (!CHANNELS[channel]) return { error: 'unknown channel' };
    if (!token || typeof token !== 'string' || token.length < 8) return { error: 'missing token' };
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
    st.channels = (st.channels || []).filter((c) => c.type !== id);
    saveState(st);
    const apply = applyAll(st, 'remove-channel');
    return { ok: apply.ok, restart: apply };
  },

  // Turnkey avots: set avots as primary if nothing is configured yet (idempotent).
  async preconnectAvots(key) {
    if (!key) return { preconnected: false, skipped: 'no-key' };
    const st = loadState();
    if (st.primary && st.primary.provider === 'avots' && st.primary.apiKey) {
      return { preconnected: true, skipped: 'already-configured' };
    }
    if (st.primary && st.primary.provider !== 'avots') {
      return { preconnected: false, skipped: 'other-primary-set' };
    }
    st.primary = {
      provider: 'avots', providerId: 'avots', label: PROVIDERS.avots.label,
      model: PROVIDERS.avots.defaultModel, baseURL: PROVIDERS.avots.baseURL,
      envRef: 'AVOTS_API_KEY', apiKey: key.trim(), keyHint: maskKey(key.trim()), enabled: true,
    };
    saveState(st);
    const apply = applyAll(st, 'preconnect-avots');
    return { preconnected: apply.ok, model: PROVIDERS.avots.defaultModel, restart: apply };
  },

  restart() { return touchApplyRequest('manual-restart'); },
};
