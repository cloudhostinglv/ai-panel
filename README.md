# ai-panel — CloudHosting AI control panel

A small Node/Express, English-only, branded control panel a client uses to set up
their AI appliance. One codebase, **product-aware** via the `PRODUCT` env var and
`adapters/<product>.js`. Ships as `ghcr.io/cloudhostinglv/ai-panel` and runs behind
Caddy on `:8443`.

## What the client does in it
- **Pick an AI provider** from cards: **Avots (Recommended)**, ChatGPT, Claude, Gemini,
  or **Add your own** (any OpenAI-compatible endpoint). Multiple can be saved; one is the
  active **primary**, with an optional **fallback**.
- **Messaging** (agents): connect Telegram / Discord bots (multiple).
- **MCP add-ons** (agents): avots by default, or any Bearer/URL MCP server.
- **Status dashboard** at the top with "Set up →" CTAs that scroll to what's missing.

## Turnkey avots
If `AVOTS_API_KEY` (env) or `~/.openclaw/secrets/avots.key` is present, the panel
auto-connects avots as the primary on startup (idempotent). The provisioner mints a
per-client avots key and sets it, so the VM ships pre-connected and the client does
nothing by default.

## Products (adapters)
| PRODUCT | type | how it applies config | capabilities |
|---|---|---|---|
| `openclaw` | agent | `openclaw` CLI + `systemctl --user` (NATIVE host deploy) | primary, fallback, messaging, mcp |
| `hermes` | agent | writes `config.yaml`+`.env` to the data dir, touches `.apply-request` (host applier restarts the agent) | primary, fallback, messaging, mcp |
| `flowise` / `langflow` / `dify` | builder | reduced: "Open product" + avots preconnect; providers are set in the product's own UI | openProduct, preconnect |

## Run
```
PRODUCT=hermes PANEL_PORT=8080 PANEL_DOMAIN=vps-60-156.cloudhosting.lv node server.js
```
`npm install` first (deps not vendored). The Docker image runs `node server.js`.

## Notes
- `openclaw` adapter needs the host CLI + a user systemd unit, so for OpenClaw the panel
  is deployed **natively** (not this container image); the image suits hermes/builders.
- Login is username/password (set out of band). OAuth (device flow) is a later phase.
