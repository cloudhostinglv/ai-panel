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
 *                           enabled flags, allowFrom ids). NOTE: this file DOES hold
 *                           the full API keys / bot tokens in cleartext (the panel
 *                           re-emits them into .env on every apply). Only the masked
 *                           keyHint is shown in the UI, but at rest the secret is here
 *                           too — treat it exactly like .env (0600, same care).
 *
 * Env: OPENCLAW_DATA_DIR | OPENCLAW_CONFIG_DIR — the shared dir as the panel sees
 * it (the compose mounts the host ~/.openclaw here; default /data).
 *
 * OpenClaw access model is OWNER-LOCK: a channel only answers the ids in
 * channels.<type>.allowFrom. The messaging "Allowed users" field maps directly to
 * allowFrom. ON TOP of that we also expose an "Access requests" queue (pairing
 * capability ON): OpenClaw records people who message the bot but aren't allowed
 * yet under <data>/credentials/<channel>-pairing.json; the panel lists them and
 * Approve appends their id to that channel's allowFrom (persisted in
 * state.approved[platform] so it survives config rewrites), then re-applies.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Short stable id for a config entry (fallbacks). Not a secret.
function genId() { return crypto.randomBytes(6).toString('hex'); }

const CONFIG_DIR = process.env.OPENCLAW_DATA_DIR || process.env.OPENCLAW_CONFIG_DIR || '/data';
const CONFIG_FILE = path.join(CONFIG_DIR, 'openclaw.json');
const ENV_FILE = path.join(CONFIG_DIR, '.env');
const APPLY_REQUEST = path.join(CONFIG_DIR, '.apply-request');
const STATE_FILE = path.join(CONFIG_DIR, 'panel-state.json');

// OpenClaw persists pending pairing requests (people who messaged the bot but
// aren't in allowFrom yet) under <data>/credentials/<channel>-pairing.json. We
// read them so the panel can show an "Access requests" queue and Approve =
// append the user's id to that channel's allowFrom (the owner-lock). The exact
// JSON shape varies by build, so listPairing() below is intentionally tolerant.
const PAIRING_DIR = path.join(CONFIG_DIR, 'credentials');
const PAIRING_FILE_RE = /^([a-z_][a-z0-9_]{1,30})-pairing\.json$/;
const PAIRING_PLATFORM_RE = /^[a-z_]{2,20}$/;
const PAIRING_USERID_RE = /^[A-Za-z0-9._:@-]{1,64}$/;

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

// Built-in remote MCP catalog — mirrors LOCAL_MCPS in public/index.html. A built-in
// provider posts only { provider, apiKey }; the adapter resolves the name (= provider
// id) and url from here. 'custom' carries a user-supplied name + url.
//
// Every url below was PROBED on 2026-07-17 (POST a JSON-RPC initialize):
//   avots       https://mcp.avots.ai/        -> 401 + WWW-Authenticate: Bearer  (live)
//   linear      https://mcp.linear.app/mcp   -> 401 + WWW-Authenticate: Bearer  (live)
//   sentry      https://mcp.sentry.dev/mcp   -> 401 + WWW-Authenticate: Bearer  (live)
//   browserbase https://mcp.browserbase.com/mcp -> 200                          (live)
// The inherited `/sse` urls are DEAD: Linear/Browserbase 404, and Sentry answers 410
// "SSE transport has been removed ... use the HTTP transport at /mcp instead". Composio
// is deliberately NOT here: it has no static endpoint (mcp.composio.dev redirects to
// docs), it mints a per-user server url, so it belongs under 'Other MCP'.
const MCPS = {
  avots:       { label: 'Avots.ai',    url: 'https://mcp.avots.ai/' },
  linear:      { label: 'Linear',      url: 'https://mcp.linear.app/mcp' },
  sentry:      { label: 'Sentry',      url: 'https://mcp.sentry.dev/mcp' },
  browserbase: { label: 'Browserbase', url: 'https://mcp.browserbase.com/mcp' },
  custom:      { label: 'Other MCP' },
};
// mcp name -> .env var, e.g. `avots` -> MCP_AVOTS_KEY, `my-github` -> MCP_MY_GITHUB_KEY.
function mcpEnvName(name) {
  return 'MCP_' + String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY';
}

// A secret that will be written verbatim into .env must not contain a control
// character — a newline would inject its own line. Reject at the INPUT boundary so a
// bad value never reaches state (writeEnvUpdates is the belt-and-braces backstop).
function badSecret(v) {
  return typeof v !== 'string' || /[\x00-\x1f\x7f]/.test(v);
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

// === vision capability =====================================================
// OpenClaw reads a model's `input` array to decide whether to pass image
// attachments NATIVELY. Declaring `image` for a TEXT-ONLY model (e.g. the avots
// free gpt-oss-120b) makes OpenClaw forward photos to a backend that rejects
// them -> "LLM request failed", then a degraded `image`-tool path that can't
// fetch the authenticated Telegram file URL. So we must declare `image` ONLY for
// genuinely vision-capable models.
//
// Source of truth is ONLINE: the avots /models catalog (OpenRouter-style) is
// queried with the configured key and we read each model's input modalities.
// When that's unavailable (non-avots provider, network error, or the field is
// absent) we fall back to a conservative name heuristic — default TEXT-ONLY
// (safe: at worst a vision model loses image support, never a crash), flag only
// known vision families.
function visionHeuristic(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  if (/gpt-oss|embed|whisper|\btts\b|moderation|rerank|\bguard\b/.test(m)) return false;
  return /claude|gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|gemini|gemma-3|llava|pixtral|qwen.*vl|-vl\b|llama-?3\.2|llama-?4|internvl|grok.*vision|grok-[34]|mistral-small-3|mistral-medium|phi-4|glm-4v|kimi-vl|deepseek-vl|nova-lite|nova-pro|aya-vision|vision|multimodal/.test(m);
}

const AVOTS_MODELS_URL = 'https://api.avots.ai/openai/v1/models';
const MODELS_TTL_MS = 60 * 60 * 1000;            // 1h, mirrors the panel's pricing cache
let _modelsCache = { at: 0, map: null };          // map: base-id(lower) -> bool (vision)

// Read image-modality out of one catalog entry across the shapes avots/OpenRouter
// use. Returns true/false when the entry declares modalities, or null if unknown
// (so the caller can fall back to the heuristic).
function entryVision(m) {
  const hasImg = (arr) => Array.isArray(arr) && arr.map(String).some((x) => /image|vision|visual|img/i.test(x));
  const a = m && m.architecture;
  if (a) {
    if (Array.isArray(a.input_modalities)) return hasImg(a.input_modalities);
    if (Array.isArray(a.inputModalities)) return hasImg(a.inputModalities);
    if (typeof a.modality === 'string') return /image|vision|\bimg\b/i.test(a.modality);
  }
  if (Array.isArray(m && m.input)) return hasImg(m.input);
  if (Array.isArray(m && m.modalities)) return hasImg(m.modalities);
  return null;
}

const baseId = (s) => String(s || '').toLowerCase().split(':')[0];   // drop :free / :nitro variant suffix

// Fetch + cache a base-id -> vision map from the avots catalog (authed). Caches
// even an empty result to avoid hammering; an empty map just means "heuristic".
async function avotsVisionMap(apiKey) {
  const now = Date.now();
  if (_modelsCache.map && (now - _modelsCache.at) < MODELS_TTL_MS) return _modelsCache.map;
  const map = new Map();
  let ok = false;
  try {
    const resp = await fetch(AVOTS_MODELS_URL, { headers: { accept: 'application/json', authorization: 'Bearer ' + apiKey } });
    if (resp && resp.ok) {
      const body = await resp.json();
      const arr = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : []);
      for (const m of arr) {
        const id = baseId(m && m.id);
        if (!id) continue;
        const v = entryVision(m);
        if (v !== null) map.set(id, v);
      }
      ok = arr.length > 0;
    }
  } catch (_) { /* offline / shape change -> fall through, DON'T cache the empty map */ }
  // Cache only a real answer for the full hour. A transient failure returns an empty
  // map used once (heuristic fallback), but is NOT cached — otherwise one blip would
  // degrade vision detection for every model for an hour.
  if (ok) _modelsCache = { at: now, map };
  return map;
}

// Resolve whether a model accepts images. Online (avots catalog) first, heuristic
// fallback. Never throws.
async function resolveVision(providerId, modelId, apiKey) {
  if (providerId === 'avots' && apiKey) {
    try {
      const map = await avotsVisionMap(apiKey);
      const bid = baseId(modelId);
      if (map.has(bid)) return map.get(bid);
    } catch (_) { /* fall through */ }
  }
  return visionHeuristic(modelId);
}

// What an entry's stored `vision` flag resolves to at config-write time (sync):
// the persisted flag if present, else the heuristic. The online lookup happens
// when the model is added (setPrimary/addFallback/preconnect), persisted to state.
function visionFor(entry) {
  return (entry && entry.vision != null) ? !!entry.vision : visionHeuristic(entry && entry.model);
}

function validateCustom(custom) {
  if (!custom || typeof custom !== 'object') return 'missing custom config';
  const { name, baseURL, modelId } = custom;
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name))
    return 'invalid name (a-z, 0-9, dash, 1-32 chars)';
  if (!baseURL || typeof baseURL !== 'string') return 'missing base URL';
  return validateBaseUrl(baseURL) || (
    (!modelId || typeof modelId !== 'string' || modelId.trim().length < 1) ? 'missing model id' : null
  );
}

// The gateway (not the panel) calls this URL, so it must not point at the host's own
// metadata service or an internal address. Require https and block loopback,
// link-local, the cloud metadata IP, and RFC1918 ranges. A hostname we cannot judge
// statically (a real domain) is allowed — the point is to stop obvious SSRF targets.
function validateBaseUrl(baseURL) {
  let u;
  try { u = new URL(baseURL); } catch (_) { return 'invalid base URL'; }
  if (u.protocol !== 'https:') return 'base URL must use https://';
  // new URL() lower-cases the host already; normalise two things the raw string can
  // still carry: a single trailing dot (`localhost.` resolves to localhost) and the
  // brackets around an IPv6 literal (`[::1]` -> `::1`).
  let h = u.hostname.replace(/\.$/, '');
  const bracketed = h.startsWith('[') && h.endsWith(']');
  if (bracketed) h = h.slice(1, -1);
  // Any IPv6 ADDRESS LITERAL as a provider baseURL is refused outright: real providers
  // are addressed by DNS name, and a blocklist over IPv6 (loopback ::1, unspecified ::,
  // IPv4-mapped ::ffff:169.254.169.254, etc.) is too leaky to trust. The bracket test
  // above catches the URL form; the ':' test catches a bare literal defensively.
  if (bracketed || h.includes(':')) {
    return 'base URL may not be an IP-literal or internal address';
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h === '169.254.169.254' ||
      /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^0\./.test(h) || h === '0.0.0.0') {
    return 'base URL may not be an internal or loopback address';
  }
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
// Every writer goes through writeAtomic: write a sibling temp file, fsync, then
// rename into place. rename() is atomic on the same filesystem, so the gateway
// (restarted the instant .apply-request appears) never reads a half-written
// openclaw.json / .env — the old fs.writeFileSync could be caught mid-write.
function writeAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${TMP_SEQ++}`;
  const fd = fs.openSync(tmp, 'w', mode);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
let TMP_SEQ = 0;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { primary: null, fallbacks: [], channels: [], mcps: [] }; }
}
function saveState(s) {
  writeAtomic(STATE_FILE, JSON.stringify(s, null, 2), 0o600);
}

// readEnv/writeEnv preserve the ORIGINAL file. The panel manages only its own
// KEY=VALUE lines; anything else — comments, `export FOO=…`, OPENCLAW_GATEWAY_TOKEN,
// pre-seeded provider keys, blank lines — is kept verbatim. The old version
// reconstructed the file from a flat map, which silently dropped every line it did
// not recognise (and dropped any managed key whose value went empty).
function readEnv() {
  const out = {};
  try {
    for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const line = raw.replace(/^\s*export\s+/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
  } catch (_) {}
  return out;
}
// Update only the given keys in the existing .env text, in place. A key mapped to
// null/undefined is DELETED; every other line is left exactly as it was. Values are
// hard-rejected if they contain CR/LF: a newline in a pasted key/token would inject
// arbitrary lines into .env (and be read back as its own variable).
function writeEnvUpdates(updates) {
  for (const [k, v] of Object.entries(updates)) {
    if (v != null && /[\r\n]/.test(String(v))) {
      throw new Error(`refusing to write ${k}: value contains a newline`);
    }
  }
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch (_) {}
  const lines = text.length ? text.split('\n') : [];
  // strip a single trailing empty element from a file that ended in '\n'
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const bare = raw.replace(/^\s*export\s+/, '');
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(bare.trim());
    const key = m && m[1];
    // hasOwnProperty, NOT `key in updates`: `in` walks the prototype chain, so a foreign
    // line named `constructor` / `toString` / `__proto__` / `valueOf` would match a
    // built-in and be clobbered with a stringified native method.
    if (key && Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      if (updates[key] != null) out.push(`${key}=${updates[key]}`);   // else: drop the line
    } else {
      out.push(raw);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k) && v != null) out.push(`${k}=${v}`);
  }
  writeAtomic(ENV_FILE, out.join('\n') + '\n', 0o600);
}
function touchApplyRequest(reason) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(APPLY_REQUEST, `${new Date().toISOString()} ${reason || 'apply'}\n`, { mode: 0o600 });
  return { ok: true, applyRequest: APPLY_REQUEST, reason: reason || 'apply' };
}

// Software update: touch <dir>/.update-request so the host updater path-unit runs
// `git pull` the VM repo + `docker compose pull && up -d` (new panel image + any
// bumped agent pin) and re-stamps .deploy-version.json. The panel can only signal;
// the host does the privileged work (same split as the applier).
const UPDATE_REQUEST = path.join(CONFIG_DIR, '.update-request');
const DEPLOY_VERSION_FILE = path.join(CONFIG_DIR, '.deploy-version.json');
function touchUpdateRequest(reason) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(UPDATE_REQUEST, `${new Date().toISOString()} ${reason || 'update'}\n`, { mode: 0o600 });
  return { ok: true, updateRequest: UPDATE_REQUEST };
}
function readDeployVersion() {
  try { return JSON.parse(fs.readFileSync(DEPLOY_VERSION_FILE, 'utf8')); } catch (_) { return null; }
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
        // image ONLY for vision-capable models (resolved online when added,
        // heuristic fallback) — declaring it for a text model breaks photo input.
        input: visionFor(p) ? ['text', 'image'] : ['text'],
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
        // sandbox 'all' on this OpenClaw build requires a Docker backend INSIDE the
        // gateway container; we deliberately don't mount docker.sock (that = host
        // root). So 'off': the single-tenant VM/container IS the boundary (cap_drop
        // ALL, no-new-privileges, no docker.sock), like Hermes. Non-owners are blocked
        // by channel allowFrom and held read-only by tools.toolsBySender['*'].deny.
        sandbox: { mode: 'off' },
      },
    },
    channels: {},
  };

  for (const c of (state.channels || []).filter((x) => x && x.enabled !== false)) {
    // allowFrom = typed "Allowed users" (minus disabled) + ENABLED approved users.
    cfg.channels[c.type] = {
      enabled: true,
      botToken: '${' + channelTokenEnv(c.type) + '}',
      allowFrom: [...effectiveAllow(state, c.type)],
    };
  }

  // MCP servers (extra tools for the agent): one entry per ENABLED mcp.
  //
  // SCHEMA VERIFIED against the shipped openclaw 2026.6.1 image (docs/cli/mcp.md +
  // dist/zod-schema, cross-checked by running `openclaw mcp status/doctor` over a
  // generated config):
  //   * the block is `mcp.servers.<name>`, NOT a top-level `mcpServers`. The ROOT
  //     schema is STRICT: a stray `mcpServers` key fails the WHOLE config with
  //     'Unrecognized key', taking gateway/models/channels down with it.
  //   * `transport` is an enum of exactly "sse" | "streamable-http". There is no
  //     "http": that is only a CLI-native alias `openclaw mcp set` rewrites.
  //   * `headers` values ARE ${VAR}-substituted at config load (proven: a missing var
  //     reports `mcp.servers.<n>.headers.Authorization: Missing env var`), and OpenClaw
  //     reads ~/.openclaw/.env itself. So the token stays an env ref, never inline.
  // Only servers that actually carry a key are emitted: a ${VAR} with no matching .env
  // line makes OpenClaw drop the server as unavailable.
  const mcps = (state.mcps || []).filter((m) => m && m.enabled !== false && m.apiKey);
  if (mcps.length) {
    const servers = {};
    for (const m of mcps) {
      servers[m.name] = {
        enabled: true,
        transport: /\/sse\/?$/i.test(m.url || '') ? 'sse' : 'streamable-http',
        url: m.url,
        headers: { Authorization: 'Bearer ${' + mcpEnvName(m.name) + '}' },
      };
    }
    cfg.mcp = { servers };
  }

  writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 0o600);
}

// Re-emit .env (secrets) + openclaw.json, then request apply. Single funnel for
// every mutation. Only the keys the panel manages are touched; OPENCLAW_GATEWAY_TOKEN
// and any other pre-seeded lines are left verbatim by writeEnvUpdates.
function applyAll(state, reason) {
  const updates = {};
  const setKey = (p) => { if (p && p.apiKey) updates[p.envRef || envRefFor(p.providerId || p.provider)] = p.apiKey; };
  if (state.primary && state.primary.enabled !== false) setKey(state.primary);
  for (const f of (state.fallbacks || []).filter((x) => x && x.enabled !== false)) setKey(f);

  const tg = (state.channels || []).find((c) => c.type === 'telegram' && c.enabled !== false);
  const dc = (state.channels || []).find((c) => c.type === 'discord' && c.enabled !== false);
  updates.TELEGRAM_BOT_TOKEN = tg ? tg.token : null;   // null => delete the line
  updates.DISCORD_BOT_TOKEN  = dc ? dc.token : null;

  // MCP keys: one MCP_<NAME>_KEY per ENABLED mcp; delete any stale MCP_*_KEY left by a
  // removed or disabled server so a dropped secret never lingers in .env.
  const enabledMcps = (state.mcps || []).filter((m) => m && m.enabled !== false);
  const wantMcpVars = new Set(enabledMcps.map((m) => mcpEnvName(m.name)));
  for (const k of Object.keys(readEnv())) {
    if (/^MCP_.+_KEY$/.test(k) && !wantMcpVars.has(k)) updates[k] = null;
  }
  for (const m of enabledMcps) if (m.apiKey) updates[mcpEnvName(m.name)] = m.apiKey;

  writeEnvUpdates(updates);
  writeConfig(state);
  return touchApplyRequest(reason);
}

// === pairing / access (Access requests + granted users) ====================
// state.approved[platform] holds users granted via the Access-requests queue.
// Entries are objects { id, enabled, name }; legacy bare-id strings count as
// enabled. Normalizing in place lets every caller rely on the object shape and
// lets a granted user be DISABLED (remembered) and re-ENABLED, like the other
// connected lists — rather than only added/removed.
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
// Effective allowFrom id set for a platform: the channel's typed "Allowed users"
// (minus anyone explicitly disabled) plus every ENABLED approved user.
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
// enabled = currently in the effective allowFrom.
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

// Pull a user id / name / code / timestamp out of one pairing entry, tolerating
// the several shapes OpenClaw builds use (flat, nested `from`/`user`, telegram
// update style). `key` is the entry's object key (often the pairing code or id).
function normalizePairingEntry(entry, key) {
  if (!entry || typeof entry !== 'object') {
    // value might itself be a bare id/name (object keyed by code -> id)
    const v = entry == null ? '' : String(entry);
    return { userId: /^[0-9]+$/.test(v) ? v : '', userName: /^[0-9]+$/.test(v) ? '' : v, code: key || '', createdAt: 0 };
  }
  const from = (entry.from && typeof entry.from === 'object') ? entry.from
            : (entry.user && typeof entry.user === 'object') ? entry.user : {};
  const pick = (...vals) => { for (const v of vals) if (v != null && v !== '') return v; return undefined; };
  const rawId = pick(entry.user_id, entry.userId, entry.id, entry.tg_id, entry.chat_id, entry.chatId, from.id, from.user_id);
  const rawName = pick(entry.user_name, entry.userName, entry.username, entry.name, entry.display_name,
                       from.username, from.first_name, from.name);
  const rawCode = pick(entry.code, entry.pair_code, entry.pairing_code,
                       entry.hash ? String(entry.hash).slice(0, 8) : undefined, key);
  let ts = pick(entry.created_at, entry.createdAt, entry.ts, entry.timestamp, entry.time, entry.first_seen, 0);
  if (typeof ts === 'string') { const n = Date.parse(ts); ts = Number.isNaN(n) ? 0 : n; }
  // numeric key fallback for id when nothing else gave one
  let userId = rawId != null ? String(rawId) : '';
  if (!userId && key && /^[0-9]{3,}$/.test(String(key))) userId = String(key);
  return { userId, userName: rawName != null ? String(rawName) : '', code: rawCode != null ? String(rawCode) : '', createdAt: Number(ts) || 0 };
}

// Read every <data>/credentials/<platform>-pairing.json and flatten to one row
// per waiting user the UI can render. Tolerant of array / object-of-entries /
// {pending:[...]} / {requests:[...]} shapes.
function listPairing() {
  let files;
  try { files = fs.readdirSync(PAIRING_DIR); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    const m = PAIRING_FILE_RE.exec(f);
    if (!m) continue;
    const platform = m[1];
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(PAIRING_DIR, f), 'utf8')); } catch (_) { continue; }
    if (!data) continue;
    let entries = [];
    if (Array.isArray(data)) entries = data.map((e) => [null, e]);
    else if (Array.isArray(data.pending)) entries = data.pending.map((e) => [null, e]);
    else if (Array.isArray(data.requests)) entries = data.requests.map((e) => [null, e]);
    else if (typeof data === 'object') entries = Object.entries(data);
    for (const [key, entry] of entries) {
      const n = normalizePairingEntry(entry, key);
      if (!n.userId && !n.userName && !n.code) continue;   // nothing actionable
      out.push({ platform, ...n });
    }
  }
  // collapse to one row per user (or per code when no id), newest first.
  const byUser = new Map();
  for (const item of out) {
    const key = item.userId ? `${item.platform}:${item.userId}` : `${item.platform}:#${item.code}`;
    const prev = byUser.get(key);
    if (!prev || (item.createdAt || 0) > (prev.createdAt || 0)) byUser.set(key, item);
  }
  const rows = [...byUser.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // Hide anyone the panel already considers GRANTED for that platform — either
  // Approved earlier (state.approved[platform]) or listed in the channel's
  // "Allowed users". OpenClaw owns the pairing file and may leave a stale entry
  // behind even after access is granted (e.g. the owner who messaged before being
  // locked in), so without this filter an already-allowed user keeps showing up
  // with an Approve button that does nothing visible. Filter is the source of
  // truth; prunePending is just best-effort file cleanup.
  let st; try { st = loadState(); } catch (_) { st = {}; }
  const grantedCache = {};
  const grantedFor = (platform) => grantedCache[platform] || (grantedCache[platform] = effectiveAllow(st, platform));
  return rows.filter((r) => !(r.userId && grantedFor(r.platform).has(r.userId)));
}

// Best-effort: drop a user's pending entries from <platform>-pairing.json so the
// Access-requests card clears after Approve. The gateway owns this file but
// re-reads it on the restart that Approve triggers.
function prunePending(platform, userId) {
  const file = path.join(PAIRING_DIR, `${platform}-pairing.json`);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return; }
  const uid = String(userId);
  const matches = (entry, key) => normalizePairingEntry(entry, key).userId === uid;
  let changed = false;
  if (Array.isArray(data)) {
    const kept = data.filter((e) => !matches(e, null));
    if (kept.length !== data.length) { data = kept; changed = true; }
  } else if (data && Array.isArray(data.pending)) {
    const kept = data.pending.filter((e) => !matches(e, null));
    if (kept.length !== data.pending.length) { data.pending = kept; changed = true; }
  } else if (data && typeof data === 'object') {
    for (const [k, e] of Object.entries(data)) if (matches(e, k)) { delete data[k]; changed = true; }
  }
  if (changed) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); } catch (_) {} }
}

module.exports = {
  id: 'openclaw',
  label: 'OpenClaw',
  repo: 'openclaw-vm',   // GitHub repo (cloudhostinglv/<repo>) the updater git-pulls

  capabilities: {
    primary: true,
    fallback: true,    // recorded + allowlisted; auto-fallback chain TODO (verify on live VM)
    messaging: true,
    mcp: true,         // remote MCP servers -> mcpServers block in openclaw.json (schema verified live)
    pairing: true,     // Access requests: read <data>/credentials/<ch>-pairing.json, Approve -> allowFrom
    openProduct: false,
    preconnect: true,
  },

  providers: PROVIDERS,
  channelTypes: CHANNELS,
  mcps: MCPS,

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
    const mcpsJson = (st.mcps || []).filter((m) => m && m.enabled !== false).map((m) => ({ name: m.name, url: m.url }));

    const configured = {
      primary: st.primary
        ? { id: st.primary.providerId || st.primary.provider, provider: st.primary.provider, label: st.primary.label, model: st.primary.model, keyHint: hintOf(st.primary, st.primary.apiKey), enabled: st.primary.enabled !== false }
        : null,
      fallbacks: (st.fallbacks || [])
        .map((f) => ({ id: f.id || f.model, label: f.label, model: f.model, keyHint: hintOf(f, f.apiKey), enabled: f.enabled !== false })),
      channels: (st.channels || [])
        .map((c) => ({ id: c.type, type: c.type, label: c.label, keyHint: hintOf(c, c.token), enabled: c.enabled !== false })),
      mcps: (st.mcps || [])
        .map((m) => ({ id: m.name, name: m.name, url: m.url, keyHint: hintOf(m, m.apiKey), enabled: m.enabled !== false })),
    };

    return {
      models:   { ok: true, code: 0, stdout: JSON.stringify(modelsJson), stderr: '' },
      channels: { ok: true, code: 0, stdout: JSON.stringify(channelsJson), stderr: '' },
      mcps:     { ok: true, code: 0, stdout: JSON.stringify(mcpsJson), stderr: '' },
      configured,
      // Access-requests queue: people who messaged the bot but aren't in allowFrom
      // yet (Approve), plus the granted users (on/off + remove). The shared UI
      // renders both in the "Access requests" card.
      pairing: { pending: listPairing(), granted: listGranted(st) },
    };
  },

  // List pending pairing requests (also surfaced inside status().pairing).
  listPairing() { return listPairing(); },

  // Approve a waiting user by id: append the id to state.approved[platform] (so it
  // survives config rewrites), prune the pending entry, and re-apply. writeConfig
  // merges state.approved[type] into channels.<type>.allowFrom, so the gateway
  // admits that user after the applier restarts it. Requires that channel to exist
  // (the bot token must already be connected for there to be a channel to join).
  async approvePairing({ platform, userId } = {}) {
    if (!PAIRING_PLATFORM_RE.test(platform || '')) return { error: 'invalid platform' };
    const uid = String(userId == null ? '' : userId).trim();
    if (!PAIRING_USERID_RE.test(uid)) return { error: 'invalid user id' };
    const st = loadState();
    if (!(st.channels || []).some((c) => c.type === platform)) {
      return { error: `connect the ${platform} bot first (no channel to grant access to)` };
    }
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

  // Enable/disable a configured item without removing it (panel toggle).
  async setEnabled({ kind, id, enabled } = {}) {
    const on = !(enabled === false || enabled === 'false' || enabled === 0 || enabled === '0');
    const st = loadState();
    let found = false;
    if (kind === 'primary') {
      if (st.primary) { st.primary.enabled = on; found = true; }
    } else if (kind === 'fallback') {
      for (const f of (st.fallbacks || [])) if (f && (f.id || f.model) === id) { f.enabled = on; found = true; }
    } else if (kind === 'channel') {
      for (const c of (st.channels || [])) if (c && c.type === id) { c.enabled = on; found = true; }
    } else if (kind === 'mcp') {
      for (const m of (st.mcps || [])) if (m && m.name === id) { m.enabled = on; found = true; }
    } else if (kind === 'user') {
      // Granted-user on/off. id is "<platform>:<uid>". Off keeps the user in
      // state.approved with enabled:false so allowFrom drops them but they stay in
      // the list to flip back on. A csv-origin user (typed in "Allowed users") is
      // recorded into approved on first toggle so the off state persists.
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
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) return { error: 'missing api key' };
    if (badSecret(apiKey)) return { error: 'api key contains an invalid character' };
    const r = resolveProvider(provider, custom, model);
    if (r.error) return { error: r.error };
    const primKey = apiKey.trim();
    // Same-family guard (mirrors addFallback): a primary and a fallback of the same
    // provider family share ONE env var, and applyAll writes fallbacks LAST, so a primary
    // set after a same-family fallback would silently run on the FALLBACK's key. Refuse so
    // the operator removes the stale fallback first (the OAuth "Connect Avots" turnkey also
    // lands here, so this closes that path too).
    const st0 = loadState();
    if ((st0.fallbacks || []).some((e) => e && e.envRef === r.envRef && e.apiKey && e.apiKey !== primKey)) {
      return { error: `a different ${r.providerId} key is already configured as a fallback; remove it first` };
    }
    const vision = await resolveVision(r.providerId, r.model, primKey);
    const st = loadState();
    st.primary = { provider: r.provider, providerId: r.providerId, label: r.label, model: r.model, baseURL: r.baseURL, envRef: r.envRef, apiKey: primKey, keyHint: maskKey(primKey), vision, enabled: true };
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
    if (badSecret(apiKey)) return { error: 'api key contains an invalid character' };
    const r = resolveProvider(provider, custom);
    if (r.error) return { error: r.error };
    const key = apiKey.trim();
    // Two entries of the same provider family share ONE env var (envRefFor keys by
    // family), and one openclaw.json provider block, so a second key would silently
    // overwrite the first. Refuse it instead of losing a key with no sign.
    const st0 = loadState();
    const clashes = (e) => e && e.envRef === r.envRef && e.apiKey && e.apiKey !== key;
    if (clashes(st0.primary) || (st0.fallbacks || []).some(clashes)) {
      return { error: `a different ${r.providerId} key is already configured; remove it first` };
    }
    const vision = await resolveVision(r.providerId, r.model, key);
    const st = loadState();
    st.fallbacks = st.fallbacks || [];
    // Unique id per entry: removeFallback/setEnabled used to match by f.model, so two
    // fallbacks sharing a model (same model, different provider/key) were removed or
    // toggled together. Key operations off this id instead.
    st.fallbacks.push({ id: genId(), provider: r.provider, providerId: r.providerId, label: r.label, model: r.model, baseURL: r.baseURL, envRef: r.envRef, apiKey: key, keyTail: key.slice(-3), keyHint: maskKey(key), vision, enabled: true });
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
    st.fallbacks = (st.fallbacks || []).filter((f) => f && (f.id || f.model) !== id);
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
    if (badSecret(token)) return { error: 'token contains an invalid character' };
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

  // Attach a remote MCP server (extra agent tools). Built-in providers post only
  // { provider, apiKey } and the name/url come from MCPS; 'custom' carries its own
  // name + url. The full key is stored in state and applyAll wires it into .env as
  // MCP_<NAME>_KEY, referenced from openclaw.json's mcpServers.<name> Bearer header.
  async addMcp({ provider, apiKey, name: customName, url: customUrl } = {}) {
    if (!MCPS[provider]) return { error: 'unknown mcp' };
    // Reuse-the-key: the avots MCP with no pasted key falls back to the avots primary's
    // key (the same av_mcp_ token serves both the model API and the MCP surface).
    if (provider === 'avots' && (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8)) {
      const st0 = loadState();
      if (st0.primary && st0.primary.provider === 'avots' && st0.primary.apiKey) apiKey = st0.primary.apiKey;
    }
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) return { error: 'missing api key' };
    if (badSecret(apiKey)) return { error: 'api key contains an invalid character' };
    let name, url;
    if (provider === 'custom') {
      if (!customName || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(customName)) return { error: 'invalid name (a-z, 0-9, dash, 1-32 chars)' };
      url = String(customUrl || '').trim();
      // The gateway (not the panel) calls this URL, so it gets the SAME SSRF guard as a
      // custom provider baseURL: https only, no loopback / RFC1918 / link-local / metadata
      // / IP-literal. This also stops a Bearer token going out over cleartext http.
      const urlErr = validateBaseUrl(url);
      if (urlErr) return { error: urlErr };
      name = customName.trim().toLowerCase();
    } else {
      name = provider; url = MCPS[provider].url;
    }
    const key = apiKey.trim();
    const st = loadState();
    // A name that normalizes to an already-used env var (e.g. 'my-github' vs 'my_github'
    // both -> MCP_MY_GITHUB_KEY) would make two servers share one key, and one would be
    // sent the other's token. Refuse unless it's an exact re-add of the same name.
    const envName = mcpEnvName(name);
    if ((st.mcps || []).some((x) => x && x.name !== name && mcpEnvName(x.name) === envName)) {
      return { error: 'that name collides with an existing MCP; pick a different name' };
    }
    // Dedupe by name: re-adding the same MCP REPLACES the prior entry (else applyAll
    // would emit a duplicate mcpServers.<name> key / a stale MCP_<NAME>_KEY).
    st.mcps = (st.mcps || []).filter((x) => x && x.name !== name);
    st.mcps.push({ name, url, apiKey: key, keyTail: key.slice(-3), keyHint: maskKey(key), enabled: true });
    saveState(st);
    const apply = applyAll(st, 'add-mcp');
    return { add: { ok: apply.ok, code: 0, stdout: `${name} connected`, stderr: '' }, reload: apply };
  },

  async removeMcp(id) {
    const st = loadState();
    const before = (st.mcps || []).length;
    st.mcps = (st.mcps || []).filter((m) => m && m.name !== id);
    if (st.mcps.length === before) return { error: 'unknown mcp' };
    saveState(st);
    const apply = applyAll(st, 'remove-mcp');
    return { ok: apply.ok, restart: apply };
  },

  // Turnkey avots: set avots as primary if nothing is configured yet (idempotent).
  async preconnectAvots(key) {
    if (!key) return { preconnected: false, skipped: 'no-key' };
    if (badSecret(key)) return { preconnected: false, skipped: 'bad-key' };
    let st = loadState();
    if (st.primary && st.primary.provider === 'avots' && st.primary.apiKey) {
      return { preconnected: true, skipped: 'already-configured' };
    }
    if (st.primary && st.primary.provider !== 'avots') {
      return { preconnected: false, skipped: 'other-primary-set' };
    }
    const vision = await resolveVision('avots', PROVIDERS.avots.defaultModel, key.trim());
    // Re-read AFTER the await: preconnect runs fire-and-forget at boot and could race a
    // user's setPrimary. Re-check on the fresh state so we never clobber a primary the
    // user just set (the load->save below is then synchronous, so it cannot interleave).
    st = loadState();
    if (st.primary && st.primary.apiKey) {
      return { preconnected: st.primary.provider === 'avots', skipped: 'primary-set-meanwhile' };
    }
    st.primary = {
      provider: 'avots', providerId: 'avots', label: PROVIDERS.avots.label,
      model: PROVIDERS.avots.defaultModel, baseURL: PROVIDERS.avots.baseURL,
      envRef: 'AVOTS_API_KEY', apiKey: key.trim(), keyHint: maskKey(key.trim()), vision, enabled: true,
    };
    saveState(st);
    const apply = applyAll(st, 'preconnect-avots');
    return { preconnected: apply.ok, model: PROVIDERS.avots.defaultModel, restart: apply };
  },

  restart() { return touchApplyRequest('manual-restart'); },

  // Software update: report the deployed VM-repo version, and request an update.
  deployVersion() { return readDeployVersion(); },
  requestUpdate() { return touchUpdateRequest('panel-update'); },
};
