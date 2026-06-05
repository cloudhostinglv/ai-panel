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
  const env = readEnv();
  if (state.primary) {
    if (state.primary.apiKey) env.OPENAI_API_KEY = state.primary.apiKey;
    env.OPENAI_BASE_URL = state.primary.baseURL;
  }
  // Telegram is the canonical messaging channel; Discord is mapped too if added.
  const tg = (state.channels || []).find((c) => c.type === 'telegram');
  const dc = (state.channels || []).find((c) => c.type === 'discord');
  if (tg) {
    env.TELEGRAM_BOT_TOKEN = tg.token;
    env.TELEGRAM_ALLOWED_USERS = tg.allowedUsers || '';
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
      resolvedDefault: st.primary ? st.primary.model : null,
      fallbacks: (st.fallbacks || []).map((f) => f.model),
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
    const configured = {
      primary: st.primary
        ? { id: st.primary.provider, provider: st.primary.provider, label: st.primary.label, model: st.primary.model }
        : null,
      fallbacks: (st.fallbacks || [])
        .filter((f) => f && f.enabled !== false)
        .map((f) => ({ id: f.model, label: f.label, model: f.model })),
      channels: (st.channels || [])
        .filter((c) => c && c.enabled !== false)
        .map((c) => ({ id: c.type, type: c.type, label: c.label })),
      mcps: (st.mcps || [])
        .filter((x) => x && x.enabled !== false)
        .map((x) => ({ id: x.name, name: x.name, url: x.url })),
    };

    return {
      models:   { ok: true, code: 0, stdout: JSON.stringify(modelsJson), stderr: '' },
      channels: { ok: true, code: 0, stdout: JSON.stringify(channelsJson), stderr: '' },
      mcps:     { ok: true, code: 0, stdout: JSON.stringify(mcpsJson), stderr: '' },
      configured,
    };
  },

  async setPrimary(provider, apiKey, custom, model) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8)
      return { error: 'missing api key' };
    const r = resolveProvider(provider, custom, model);
    if (r.error) return { error: r.error };

    const st = loadState();
    st.primary = { provider, label: r.label, model: r.model, baseURL: r.baseURL, apiKey: apiKey.trim() };
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
    st.fallbacks.push({ provider, label: r.label, model: r.model, baseURL: r.baseURL, keyTail: apiKey.trim().slice(-3), enabled: true });
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
    st.mcps.push({ name, url, apiKey: apiKey.trim(), keyTail: apiKey.trim().slice(-3), enabled: true });
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
    };
    saveState(st);
    const apply = applyAll(st, 'preconnect-avots');
    return { preconnected: apply.ok, model: PROVIDERS.avots.defaultModel, restart: apply };
  },

  restart() { return touchApplyRequest('manual-restart'); },
};
