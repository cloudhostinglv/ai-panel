# CloudHosting AI Panel

A small, bilingual (RU/EN) branded onboarding/setup web panel — one unified
front door for the five self-hosted AI-appliance products CloudHosting sells as
per-client single-tenant VMs:

| Product | Kind | What the panel does |
|---|---|---|
| **Hermes Agent** | agent | provider cards + key form → writes `config.yaml` + `.env`, signals restart |
| **OpenClaw** | agent | provider cards + key form → writes `openclaw.json` + `.env`, signals restart |
| **Flowise** | builder | branded landing + "Open Flowise" + manual (provider set in Flowise's own UI) |
| **Langflow** | builder | branded landing + "Open Langflow" + manual (provider set in Langflow's own UI) |
| **Dify** | builder | branded landing + "Open Dify" + manual (provider set in Dify's own console) |

One panel container runs per VM. Behaviour is selected by the `PRODUCT` env var.

Stack: **Python + FastAPI + uvicorn**, server-rendered HTML (Jinja2) + a little
vanilla JS for the RU/EN toggle. One slim non-root Docker image. No frontend
framework.

---

## How it plugs into each product

The config file names, data-dir mount paths, and docker compose **service
names** below were read directly from the sibling product repos under
`/srv/ai-vms/*-vm/` (verified 2026-06-05) so the apply logic targets the right
files/containers.

### Agents — the panel writes a normalized config to the shared `/data` volume

**Hermes** (`/srv/ai-vms/hermes-vm/`) — data dir is mounted `./data → /opt/data`.
From its README/`config.yaml`: avots is wired in two places, the secret only in
`.env`. The panel writes:

- `config.yaml` →
  ```yaml
  model:
    provider: "custom"          # any OpenAI-compatible endpoint
    default: "<model id>"
    base_url: "<provider base_url>"
    api_key: "${OPENAI_API_KEY}"  # secret ref, expanded from .env
    context_length: 200000
  ```
- `.env` → `OPENAI_API_KEY=<key>`, `OPENAI_BASE_URL=<base_url>` (Hermes' documented
  custom-endpoint env fallback), plus `AVOTS_API_KEY` mirrored.
- Compose service to restart: **`gateway`**.

> Hermes README quote: *"`model.provider == "custom"` selects any OpenAI-compatible
> endpoint; set `base_url`. … Hermes also falls back to `OPENAI_API_KEY` for custom
> endpoints."*

**OpenClaw** (`/srv/ai-vms/openclaw-vm/`) — data dir is `~/.openclaw` (host dir
bind-mounted). avots is a **two-step** registration; doing one half silently
fails. The panel writes:

- `openclaw.json`:
  - **Step 1** — `models.providers.<id>` with `baseUrl`, `apiKey: "${OPENAI_API_KEY}"`,
    `api: "openai-completions"`, and a model entry with
    `compat.supportsTools: true`. `models.mode: "merge"` keeps OpenClaw's bundled
    catalogs.
  - **Step 2** — allowlist the **fully-qualified `<provider-id>/<model-id>`** key
    under `agents.defaults.models` and set `agents.defaults.model.primary` to it.
- `.env` → `OPENAI_API_KEY=<key>` (+ `AVOTS_API_KEY`).
- Compose service to restart: **`openclaw-gateway`**.

> OpenClaw README quote: *"`models.providers.*` registers the runtime model but
> does not make agents use it. You must also add the fully-qualified
> `<provider-id>/<model-id>` key to the agent allowlist and set it primary."* and
> *"`api: "openai-completions"` is correct for avots `/v1/chat/completions`."* The
> doubled slash (`avots/anthropic/claude-opus-4.8`) is preserved exactly.

The writers **merge** into any existing config (they don't clobber the
channels/sandbox/tool-policy blocks the product ships), then `signal_apply()`.

### Builders — the panel writes NO keys

Flowise / Langflow / Dify configure their provider **inside their own UI**, so
the panel only renders a branded landing with avots-first provider guidance, a
prominent **"Open `<Product>` / Открыть `<Product>`"** button (links to
`https://$PANEL_DOMAIN`), and the manual. The `POST /api/provider` route returns
`not_an_agent` for builders. This is stated in the UI (`builder_intro`).

The discovered builder facts (for the manual + Open link):

- **Flowise** — UI on `flowise:3000` behind Caddy. Provider via the **ChatOpenAI**
  node: set **Base Path** to the provider endpoint, attach the `openAIApi`
  credential, type a model id (e.g. `anthropic/claude-opus-4.8`).
- **Langflow** — UI on `langflow:7860` behind Caddy. Drop an OpenAI/Language-Model
  component, point it at the provider endpoint; avots key preloaded as a
  Credential global var if provisioned.
- **Dify** — UI behind Caddy → Dify's own nginx on `127.0.0.1:8080`. **Settings →
  Model Provider → OpenAI-API-Compatible → Add Model**, and set **Function
  calling = `Tool Call`** (load-bearing, or tools never reach the provider).

---

## Provider registry (`providers.py`)

avots is **first** and flagged `recommended` → the UI shows a "Рекомендуем /
Recommended" badge and pre-selects it.

| id | base_url | key prefix | signup | default model |
|---|---|---|---|---|
| **avots** *(recommended)* | `https://api.avots.ai/openai/v1` | `av_mcp_` | https://avots.ai | `anthropic/claude-opus-4.8` |
| openai | `https://api.openai.com/v1` | `sk-` | https://platform.openai.com | `gpt-4o` |
| anthropic | `https://api.anthropic.com/v1/` | `sk-ant-` | https://console.anthropic.com | `claude-opus-4-8` |

Each entry carries a short bilingual blurb (RU/EN). avots blurb: "one balance for
all models, OpenAI-compatible, easiest."

### Anthropic base_url note (verify before baking)

`https://api.anthropic.com/v1/` is Anthropic's **OpenAI-compatibility layer**
(confirmed 2026-06-05 against the Claude API docs, "OpenAI SDK compatibility"):
the OpenAI SDK base URL is `https://api.anthropic.com/v1/` and requests go to
`/v1/chat/completions`; `/v1/models` also works. Anthropic positions this as a
**compatibility/testing** layer, not the full-feature path — for production
Claude you may want a **native-Anthropic mode** instead (the agents here speak
OpenAI-completions, so the compat layer is what they need). Re-verify per agent
before promising Anthropic-direct to a client. avots remains the recommended,
simplest path (one balance, Claude/GPT/Gemini through one OpenAI-compatible key).

---

## The apply flow (no docker.sock on the web panel)

```
 [browser] --POST /api/provider--> [ai-panel container (unprivileged)]
                                        |  writes config to /data
                                        |  touches /data/.apply-request (timestamp)
                                        v
              /data/.apply-request changes on the HOST
                                        |
                 systemd  cloudhosting-applier.path  (watches the file)
                                        |
                 systemd  cloudhosting-applier.service  --> applier/apply.sh
                                        |
                 docker compose -f <product compose> restart <agent service>
```

- The **panel container is unprivileged**: it mounts only the shared product
  data dir as `/data`, has **no docker.sock**, drops all caps, `no-new-privileges`.
  It can write files and touch `.apply-request` — nothing else.
- `applier/apply.sh` runs **on the host**, maps `PRODUCT` → the compose service
  (`hermes→gateway`, `openclaw→openclaw-gateway`), and restarts it so the agent
  re-reads the new config. Builders: nothing to restart → exits 0.
- `applier/cloudhosting-applier.path` watches `/data/.apply-request`;
  `applier/cloudhosting-applier.service` (oneshot) runs `apply.sh`. Docker control
  stays on the host, off the web surface. Install steps are in the header comment
  of `cloudhosting-applier.path`; per-VM `PRODUCT` + `COMPOSE_FILE` go in
  `/etc/cloudhosting-panel.env`.

> **Reload behaviour — verify per product.** A `docker compose restart` makes the
> agent re-read `config.yaml`/`openclaw.json` + `.env` on boot. Both products are
> pre-1.0 / fast-moving; confirm that a plain restart is sufficient (vs. `up -d`
> to re-evaluate env_file, or a config hot-reload) against the pinned image
> before baking the golden image.

---

## Security

- **Password-protected (fail closed).** A single password from `PANEL_PASSWORD`
  gates everything (login form → HMAC-signed session cookie, 12 h TTL). **If
  `PANEL_PASSWORD` is empty the app refuses to start.** The panel can set the
  client's API key, so it must never be open.
- **Secrets never touch the repo.** The key is written only to the gitignored
  `/data` volume (`.env` is `chmod 600`). `.gitignore` excludes `**/.env` and
  `data/`. The Docker image bakes in no secrets.
- **Input validation.** Provider must be in the registry; key non-empty and
  16–512 chars; the key is **validated against the provider** (`GET /models`,
  falling back to a tiny `/chat/completions` probe) and is **not saved if
  validation fails**. Telegram tokens are regex-checked; owner id must be numeric.
- **TLS in front.** The panel serves **plain HTTP** on `PANEL_PORT` (default
  8080); Caddy terminates TLS and reverse-proxies. Don't publish the panel port
  on `0.0.0.0` — keep it on the compose network behind Caddy (or an SSH tunnel
  for the outbound-only agent VMs). See `docker-compose.fragment.yml`.

---

## Run / deploy

### Local dev

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export PRODUCT=hermes PANEL_PASSWORD=changeme PANEL_DATA_DIR=./_data
uvicorn app:app --reload --port 8080
# open http://localhost:8080
```

### As a container alongside a product

Copy the service block from `docker-compose.fragment.yml` into the product's
`docker-compose.yml`, mounting the **same** host data dir the agent uses as
`/data`, set `PRODUCT` / `PANEL_PASSWORD` / `PANEL_PORT` / `PANEL_DOMAIN`, and add
the commented Caddy route (the fragment shows `/setup`-prefix and own-subdomain
options). Then install the host applier (see `applier/`).

---

## Files

| File | Purpose |
|---|---|
| `app.py` | FastAPI app: `GET /`, `GET/POST /login`, `/logout`, `POST /api/provider`, `POST /api/telegram`, `GET /api/status`, `/healthz`. Auth, validation, config writers, apply signal. |
| `providers.py` | Provider registry (avots-first, recommended) + product registry (agent vs builder, config filenames, compose services). |
| `i18n.py` + `locales/{ru,en}.json` | All UI strings in RU + EN. |
| `templates/index.html` | Server-rendered bilingual page (login / agent / builder), provider cards, key form, Telegram guide, manual, logo slot. |
| `static/style.css` | Brand styling (cloudhosting.lv palette: primary `#024ad8`, Inter/JetBrains Mono). |
| `static/app.js` | RU/EN toggle, manual rendering, fetch form submits, live status polling. |
| `static/logo.svg` | Placeholder CloudHosting logo (brand blue). Replace with the real asset. |
| `requirements.txt`, `Dockerfile` | Pinned deps; `python:3.12-slim`, non-root user (uid 10001). |
| `applier/apply.sh` | Host-side: PRODUCT → compose service → `docker compose restart`. |
| `applier/cloudhosting-applier.path` / `.service` | systemd path+service watching `/data/.apply-request`. |
| `docker-compose.fragment.yml` | How to add the panel to a product stack + Caddy route example. |
| `.env.example` | `PRODUCT`, `PANEL_PASSWORD=REPLACE_ME`, `PANEL_PORT=8080`, `PANEL_DOMAIN`. |

---

## How to brand / translate

- **Translate:** edit `locales/ru.json` / `locales/en.json` (same keys in both).
  The server embeds both tables in the page; the RU/EN toggle swaps them
  client-side with no round-trip. Default language is `ru` (`i18n.DEFAULT_LANG`).
  Add a language by adding `locales/<xx>.json` and listing it in
  `i18n.SUPPORTED` + a `.lang-btn` in the template.
- **Brand:** replace `static/logo.svg` with the real CloudHosting logo and adjust
  the palette variables at the top of `static/style.css`.
- **Add a provider:** append a dict to `PROVIDERS` in `providers.py` (id, name,
  base_url, key_prefix, signup_url, default_model, bilingual blurb). The cards,
  validation, and writers pick it up automatically.

---

## Version notes / uncertainties to verify before baking

- **Anthropic base_url** — `https://api.anthropic.com/v1/` is the OpenAI-compat
  layer (verified 2026-06-05); it's a compat/testing path. Some agents may need a
  native-Anthropic mode. avots stays recommended.
- **Agent reload behaviour** — `docker compose restart` is assumed sufficient for
  Hermes/OpenClaw to re-read config+`.env`. Confirm against the pinned images;
  switch to `up -d` if env_file changes need re-evaluation.
- **uid/gid on `/data`** — the panel runs as uid 10001 and must be able to write
  the shared data dir. The agents expect their own owner (Hermes default 10000;
  OpenClaw `node` uid 1000). The simplest path is to make the data dir
  group-writable by both, or align uids at provision time; verify ownership so
  both the panel (write) and the agent (read) work.
- **Validation probe** — `/models` is preferred; the `/chat/completions` fallback
  treats any non-401/403 as "key authenticated". Confirm each provider returns
  401/403 (not 200/400) for a bad key so validation can't false-pass.
- **Dep pins** — re-verify `requirements.txt` versions at bake time.

### Validation done

`python -m py_compile` (app/providers/i18n) ✔, `bash -n applier/apply.sh` ✔,
locale JSON parse ✔. Functional tests run in a throwaway venv: fail-closed
startup, login/session, unauth 401, Hermes + OpenClaw config writers (incl.
merge-preserving existing blocks), `.env` upsert, Telegram per-product owner
mapping, input validation (unknown provider / bad length / failed validation not
saved / bad token / non-numeric owner), `/api/status`, and builder mode (Open
button rendered, key-write refused) — all passing.
