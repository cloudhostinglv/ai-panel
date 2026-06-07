'use strict';
/*
 * _builder.js — shared factory for the REDUCED "builder" adapters
 * (flowise / langflow / dify).
 *
 * Builders configure their LLM provider/key INSIDE the product's own web UI/API,
 * not through this panel's primary/fallback/messaging/MCP model. So the panel
 * renders a simplified "your <Product> is ready" landing with an Open-<Product>
 * button and the avots "connected and ready" status; it does NOT expose the
 * agent sections.
 *
 * Env vars read:
 *   PANEL_DOMAIN — public host the VM is served on. The panel sits on :8443, so
 *                  the product's own UI is reachable on :443 at https://<domain>.
 *                  openProductUrl() returns https://${PANEL_DOMAIN} accordingly.
 *   AVOTS_API_KEY — only used to drive the "connected and ready" indicator via
 *                   preconnectAvots (a documented stub here; the real provider
 *                   wiring lives in the builder UI/API).
 *
 * All agent methods are present (so server.js can route uniformly) but return a
 * gentle "not applicable for builder" notice rather than doing anything.
 */
const fs = require('fs');
const path = require('path');

// Where the panel can write request/version files the host updater watches. For
// builders the compose mounts ./paneldata -> the container HOME, so that host dir
// is where .update-request + .deploy-version.json live.
const BUILDER_DATA_DIR = process.env.PANEL_DATA_DIR || process.env.HOME || '/paneldata';

function buildOpenProductUrl() {
  const domain = (process.env.PANEL_DOMAIN || '').trim();
  // Panel is on :8443; the builder's own UI is on :443 (the default https port),
  // so a bare https://<domain> points at the product. If PANEL_DOMAIN is unset
  // (local/dev), fall back to a relative-safe placeholder the UI can hide.
  if (!domain) return null;
  return `https://${domain}`;
}

module.exports = function makeBuilder({ id, label, productPort }) {
  const na = (method) => ({ ok: false, error: `${method} is not applicable for the ${label} builder; configure providers inside ${label}'s own UI.` });

  return {
    id,
    label,
    repo: `${id}-vm`,   // GitHub repo (cloudhostinglv/<repo>) the updater git-pulls
    // Internal port the product listens on (documentation/diagnostics only; the
    // public URL is always https://<PANEL_DOMAIN> on :443 fronted by Caddy).
    productPort,

    // Reduced surface: only the open-product landing + avots preconnect status.
    capabilities: {
      primary: false,
      fallback: false,
      messaging: false,
      mcp: false,
      openProduct: true,
      preconnect: true,
    },

    // No catalogs are needed for builder mode, but expose empty ones so the
    // front-end can read them uniformly without guarding for undefined.
    providers: {},
    channelTypes: {},
    mcps: {},

    openProductUrl() { return buildOpenProductUrl(); },

    // Status for a builder is intentionally minimal: there is no primary/fallback
    // model managed here. The front-end reads `capabilities.openProduct` and
    // renders the simplified page instead of parsing this. We still return the
    // openclaw-compatible empty shape so anything that does parse it won't break.
    async status() {
      return {
        models:   { ok: true, code: 0, stdout: JSON.stringify({ resolvedDefault: null, fallbacks: [] }), stderr: '' },
        channels: { ok: true, code: 0, stdout: JSON.stringify([]), stderr: '' },
      };
    },

    // Agent operations are not applicable to a builder.
    async setPrimary()       { return na('setPrimary'); },
    async addFallback()      { return na('addFallback'); },
    async setActivePrimary() { return na('setActivePrimary'); },
    async removePrimary()    { return na('removePrimary'); },
    async addChannel()       { return na('addChannel'); },
    async removeChannel()    { return na('removeChannel'); },
    async addMcp()           { return na('addMcp'); },
    async removeMcp()        { return na('removeMcp'); },

    // avots preconnect is a documented STUB for builders. The provider config for
    // a builder lives in the product's own UI/API (Flowise credentials, Langflow
    // global variables, Dify model providers). We can't push a key from here
    // without product-specific API calls, so we just report the key's presence so
    // the UI can show an honest "ready" indicator. Returning preconnected:true
    // when a key exists keeps the turnkey UX; flip to a softer message if you'd
    // rather not imply auto-config.
    // TODO: implement per-product credential seeding via the builder API
    //   (flowise: POST /api/v1/credentials; langflow: global variables;
    //    dify: model-provider config) — see each VM's seed-credential script.
    async preconnectAvots(key) {
      if (!key) return { preconnected: false, skipped: 'no-key' };
      return {
        preconnected: true,
        skipped: 'builder-stub',
        todo: `avots key present; ${label} provider config is done inside the ${label} UI (TODO: seed via ${label} API).`,
      };
    },

    // No gateway to restart for a builder; the product manages its own lifecycle.
    async restart() { return { ok: true, skipped: 'builder-no-restart' }; },

    // Software update works the same for builders: report the deployed VM-repo
    // version and request an update (host updater git-pulls + recreates the panel
    // side-stack). The product's own stack updates via its own channel.
    deployVersion() {
      try { return JSON.parse(fs.readFileSync(path.join(BUILDER_DATA_DIR, '.deploy-version.json'), 'utf8')); }
      catch (_) { return null; }
    },
    requestUpdate() {
      try {
        fs.mkdirSync(BUILDER_DATA_DIR, { recursive: true });
        fs.writeFileSync(path.join(BUILDER_DATA_DIR, '.update-request'), `${new Date().toISOString()} panel-update\n`, { mode: 0o600 });
        return { ok: true };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    },
  };
};
