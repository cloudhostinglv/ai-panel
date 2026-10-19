# ai-panel

The setup panel for the OpenClaw and Hermes AI assistant VMs from
[CloudHosting.lv](https://www.cloudhosting.lv). It is a small Node.js (Express) app with an
English web UI. Every push to `main` builds the public image `ghcr.io/cloudhostinglv/ai-panel`
(tag `latest`), which runs as the `panel` container on those VMs.

## Opening the panel

Open `https://vps-<third octet>-<fourth octet>.cloudhosting.lv:8443`. For example, a VM whose
IPv4 address ends in `.12.34` uses `https://vps-12-34.cloudhosting.lv:8443`. Log in as `admin`
with the panel password set when the VM was installed.

## What you can do in it

- **AI provider.** Choose Avots (recommended), ChatGPT, Claude, Gemini, or "Add your own" (any
  OpenAI-compatible endpoint). One primary model is active at a time. Avots can also be
  connected with the **Connect Avots** button, which signs you in at avots.ai (OAuth) instead of
  asking for a key.
- **Fallback AI.** Saved and listed in the panel. On OpenClaw it is also added to the model
  allowlist. The panel does not set an automatic fallback order, and on Hermes only the primary
  model is used.
- **Messaging.** Connect a Telegram or Discord bot and enter the user ids the agent should answer.
  On Hermes the user-id list applies to Telegram only.
- **Access requests.** People who messaged your bot and are waiting for access. Approve adds
  their user id to the allowed list.
- **MCP add-ons.** Extra tools for the agent from remote MCP servers: a built-in list (for
  example Avots, Linear, Sentry and Browserbase) or any server URL with a Bearer token.
- **Restart** restarts the agent. **Update software** appears when a newer version exists.

## How it works

The panel runs in an unprivileged container with no Docker access. It listens on port 8080
inside the Docker network, and Caddy on the VM serves it over HTTPS on port 8443.

When you save a change, the panel writes the agent's config into the data directory it shares
with the agent and then writes `.apply-request` there. A systemd path unit on the host (shipped
in the VM's own repository) sees that file and restarts the agent container.

| `PRODUCT` | VM | Files the panel writes in the data directory |
|---|---|---|
| `openclaw` (default) | OpenClaw | `openclaw.json`, `.env`, `panel-state.json` |
| `hermes` | Hermes | `config.yaml`, `.env`, `panel-state.json` |
| `flowise`, `langflow`, `dify` | none | Nothing. A reduced page with an "Open product" link. |

The Flowise, Langflow and Dify VMs do not include this panel at the moment. `.env` and
`panel-state.json` hold your API keys and bot tokens and are written with mode 0600; the UI
shows only a masked hint of each key. The panel's own state (brand name, session signing key,
Avots sign-in data) is kept in `$HOME/.config/clawpanel`.

## Updates

The panel checks GitHub for the latest commit of this repository and of the VM's repository
(`openclaw-vm` or `hermes-vm`), caching the answer for an hour. When either is newer than what
is running, the **Update software** button appears. Pressing it writes `.update-request`; the
updater on the host then pulls the VM repository and the container images (this panel
included) and recreates the containers. Nothing is updated until you press the button.

## Outgoing connections

The panel itself connects to:

- `api.github.com`: the update check, without a token;
- `api.avots.ai`: Avots model prices and model details;
- `mcp.avots.ai`: only during the Connect Avots sign-in.

Your browser loads the Inter font from Google Fonts. The AI provider, messaging and MCP
connections are made by the agent, not by the panel.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `PRODUCT` | `openclaw` | Which adapter (`adapters/<product>.js`) to load. |
| `PANEL_PORT` | `8080` (set in the image) | Listen port. |
| `PANEL_HOST` | `0.0.0.0` | Listen address. |
| `PANEL_USERNAME` | `admin` | Login name. |
| `PANEL_PASSWORD` | none | Login password. Without it the panel refuses to start. |
| `PANEL_ALLOW_OPEN` | off | `1` allows running without a password. Local testing only. |
| `PANEL_COOKIE_INSECURE` | off | `1` drops the `Secure` cookie flag for plain-HTTP local testing. |
| `PANEL_DOMAIN` | none | Public hostname, used for the Connect Avots callback URL. |
| `AVOTS_API_KEY` | none | If set, the panel connects Avots as the primary AI on startup, unless another primary is already set. |
| `OPENCLAW_DATA_DIR` | `/data` | openclaw: the shared data directory. |
| `HERMES_DATA_DIR` | `/opt/data` | hermes: the shared data directory (the Hermes VM sets `/data`). |

`.env.example` lists the common ones.

## Security

- One login for the whole panel. A successful login sets an HMAC-signed session cookie
  (HttpOnly, Secure, SameSite=Lax) that is valid for 7 days. Changing `PANEL_PASSWORD` ends
  all sessions.
- Everything except the login page requires a session.
- After 8 failed logins from one IP address, further attempts from it are refused for 5 minutes.
- In the openclaw adapter, custom provider and MCP URLs must use `https://` and may not point
  at loopback, private or link-local addresses.

## Running it locally

```
npm install
PRODUCT=hermes HERMES_DATA_DIR=./data PANEL_PORT=8080 \
  PANEL_PASSWORD='choose-a-password' PANEL_COOKIE_INSECURE=1 node server.js
```

Then open `http://localhost:8080`. `npm test` runs the offline tests for the openclaw adapter.

## License

This repository does not contain a license file.
