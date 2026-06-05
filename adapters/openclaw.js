'use strict';
/*
 * openclaw adapter — the original ClawPanel behaviour, unchanged.
 *
 * This is the Phase-1 logic lifted verbatim out of server.js: every OpenClaw
 * call uses execFile (no shell); the LLM API key is passed on stdin and channel
 * tokens via a 0600 persistent file — never as argv that would show up in `ps`.
 * Gateway reloads use `systemctl --user restart openclaw-gateway`.
 *
 * The adapter contract (shared by every product) is documented in
 * adapters/README of intent — see server.js for how endpoints route through it:
 *
 *   capabilities                              -> which UI sections apply
 *   openProductUrl()                          -> builders only (null for agents)
 *   status()                                  -> { models, channels } raw run() blobs
 *   setPrimary(provider, apiKey, custom)      -> set the active primary LLM
 *   addFallback(provider, apiKey, custom)     -> push a fallback LLM
 *   setActivePrimary(id)                      -> switch active primary (TODO here)
 *   removePrimary(id)                         -> remove a saved primary (TODO here)
 *   addChannel(channel, token)               -> connect Telegram/Discord
 *   removeChannel(id)                         -> disconnect a channel (TODO here)
 *   addMcp({ provider, apiKey, name, url })   -> attach an MCP server
 *   removeMcp(id)                             -> detach an MCP server (TODO here)
 *   preconnectAvots(key)                      -> one-time avots auto-connect
 *   restart()                                 -> reload the gateway
 *
 * Methods return the same raw shapes the original endpoints returned so the
 * existing front-end keeps reading r.auth.ok / r.add.ok / r.set.ok unchanged.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OC = process.env.OPENCLAW_BIN || '/usr/bin/openclaw';

// Core "brain" providers selectable in the panel. Curated to the 5 the UI
// exposes as cards (Avots first, then ChatGPT / Claude / Gemini / custom).
const PROVIDERS = {
  avots:      { label: 'Avots AI', defaultModel: 'anthropic/claude-opus-4.8' },
  openai:     { label: 'ChatGPT',  defaultModel: 'openai/gpt-5.5' },
  anthropic:  { label: 'Claude',   defaultModel: 'anthropic/claude-opus-4.8' },
  google:     { label: 'Gemini',   defaultModel: 'google/gemini-2.5-pro' },
  custom:     { label: 'Add your own', defaultModel: null, custom: true },
};

const AVOTS_DEFAULT_MODEL = PROVIDERS.avots.defaultModel;
const CHANNELS = { telegram: 'Telegram', discord: 'Discord' };

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
  if (PROVIDERS[name.toLowerCase()] && name.toLowerCase() !== 'custom')
    return `name "${name}" is reserved; pick a different one`;
  return null;
}

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 90000, env: process.env, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
      }));
    if (input != null) { child.stdin.write(input); child.stdin.end(); }
  });
}

function restartGateway() {
  return run('systemctl', ['--user', 'restart', 'openclaw-gateway']);
}

async function setupCustomProvider(custom, apiKey) {
  const name = custom.name.trim();
  const baseURL = custom.baseURL.trim().replace(/\/+$/, '');
  const patchObj = { models: { providers: { [name]: { type: 'openai-compatible', baseURL } } } };
  const patch = await run(OC, ['config', 'patch', JSON.stringify(patchObj)]);
  if (!patch.ok) return { ok: false, step: 'patch', patch };
  const auth = await run(OC, ['models', 'auth', 'paste-api-key', '--provider', name], apiKey.trim() + '\n');
  if (!auth.ok) return { ok: false, step: 'auth', patch, auth };
  return { ok: true, name, modelId: custom.modelId.trim(), patch, auth };
}

// --- channel token persistence (same path/permissions as Phase 1) ---
const SECRETS_DIR = path.join(process.env.HOME || os.homedir(), '.openclaw', 'secrets');

// --- avots auto-preconnect helpers ---
async function avotsAlreadyConfigured() {
  const st = await run(OC, ['models', 'status', '--json']);
  if (!st.ok) return false;
  try {
    const j = JSON.parse(st.stdout);
    return JSON.stringify(j).toLowerCase().includes('avots');
  } catch (_) {
    return /avots/i.test(st.stdout || '');
  }
}

module.exports = {
  id: 'openclaw',
  label: 'OpenClaw',

  // Full agent surface: primary, fallback, messaging, MCP. Not a builder.
  capabilities: {
    primary: true,
    fallback: true,
    messaging: true,
    mcp: true,
    openProduct: false,
    preconnect: true,
  },

  // Catalogs the UI reads from /api/status.
  providers: PROVIDERS,
  channelTypes: CHANNELS,
  mcps: MCPS,

  // Agents have no separate product URL (the panel IS the surface).
  openProductUrl() { return null; },

  async status() {
    const models = await run(OC, ['models', 'status', '--json']);
    const channels = await run(OC, ['channels', 'list', '--json']);
    return { models, channels };
  },

  async setPrimary(provider, apiKey, custom) {
    if (!PROVIDERS[provider]) return { error: 'unknown provider' };
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8)
      return { error: 'missing api key' };

    if (provider === 'custom') {
      const err = validateCustom(custom);
      if (err) return { error: err };
      const setup = await setupCustomProvider(custom, apiKey);
      if (!setup.ok) return setup;
      const set = await run(OC, ['models', 'set', `${setup.name}/${setup.modelId}`]);
      const restart = await restartGateway();
      return { patch: setup.patch, auth: setup.auth, set, restart };
    }

    const auth = await run(OC, ['models', 'auth', 'paste-api-key', '--provider', provider], apiKey.trim() + '\n');
    if (!auth.ok) return { step: 'auth', auth };
    const set = await run(OC, ['models', 'set', PROVIDERS[provider].defaultModel]);
    const restart = await restartGateway();
    return { auth, set, restart };
  },

  async addFallback(provider, apiKey, custom) {
    if (!PROVIDERS[provider]) return { error: 'unknown provider' };
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8)
      return { error: 'missing api key' };

    if (provider === 'custom') {
      const err = validateCustom(custom);
      if (err) return { error: err };
      const setup = await setupCustomProvider(custom, apiKey);
      if (!setup.ok) return setup;
      const add = await run(OC, ['models', 'fallbacks', 'add', `${setup.name}/${setup.modelId}`]);
      const restart = await restartGateway();
      return { patch: setup.patch, auth: setup.auth, add, restart };
    }

    const auth = await run(OC, ['models', 'auth', 'paste-api-key', '--provider', provider], apiKey.trim() + '\n');
    if (!auth.ok) return { step: 'auth', auth };
    const add = await run(OC, ['models', 'fallbacks', 'add', PROVIDERS[provider].defaultModel]);
    const restart = await restartGateway();
    return { auth, add, restart };
  },

  // The Phase-1 front-end manages active-primary / removal client-side in mock
  // mode and via re-running setPrimary live, so these are exposed for the unified
  // adapter contract but not yet wired to dedicated OpenClaw subcommands.
  // TODO: map to `openclaw models set` / credential removal when those land.
  async setActivePrimary(/* id */) { return { ok: true, todo: 'setActivePrimary not yet mapped for openclaw' }; },
  async removePrimary(/* id */)   { return { ok: true, todo: 'removePrimary not yet mapped for openclaw' }; },
  async removeChannel(/* id */)   { return { ok: true, todo: 'removeChannel not yet mapped for openclaw' }; },
  async removeMcp(/* id */)       { return { ok: true, todo: 'removeMcp not yet mapped for openclaw' }; },

  async addChannel(channel, token) {
    if (!CHANNELS[channel]) return { error: 'unknown channel' };
    if (!token || typeof token !== 'string' || token.length < 8)
      return { error: 'missing token' };

    fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    const tokenFile = path.join(SECRETS_DIR, `${channel}.token`);
    fs.writeFileSync(tokenFile, token.trim(), { mode: 0o600 });
    const add = await run(OC, ['channels', 'add', '--channel', channel, '--token-file', tokenFile]);
    const restart = await restartGateway();
    return { add, restart };
  },

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
      name = customName.trim();
      url  = customUrl.trim();
    } else {
      name = provider;
      url  = MCPS[provider].url;
    }

    const add = await run(OC, [
      'mcp', 'add', '--name', name,
      '--url', url,
      '--header', `Authorization: Bearer ${apiKey.trim()}`,
    ]);
    const reload = await run(OC, ['mcp', 'reload']);
    return { add, reload };
  },

  // One-time avots auto-connect: paste key -> set default model -> restart.
  // Idempotent: if avots already has a stored credential we skip the paste and
  // just report preconnected. Returns { preconnected, skipped?, ... } so the
  // caller can flip its in-memory flag. Never throws.
  async preconnectAvots(key) {
    if (!key) return { preconnected: false, skipped: 'no-key' };
    if (await avotsAlreadyConfigured()) {
      return { preconnected: true, skipped: 'already-configured' };
    }
    const auth = await run(OC, ['models', 'auth', 'paste-api-key', '--provider', 'avots'], key + '\n');
    if (!auth.ok) {
      return { preconnected: false, step: 'auth', auth };
    }
    const set = await run(OC, ['models', 'set', AVOTS_DEFAULT_MODEL]);
    const restart = await restartGateway();
    // Auth succeeded so avots IS connected even if set/restart hiccup.
    return { preconnected: true, model: AVOTS_DEFAULT_MODEL, auth, set, restart };
  },

  restart() { return restartGateway(); },
};
