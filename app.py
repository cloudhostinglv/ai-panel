"""CloudHosting AI Panel — a bilingual (RU/EN) onboarding/setup web panel.

One container per product VM. Behavior is driven by env ``PRODUCT``:
  agents  (hermes, openclaw): show provider cards + key form, validate the key,
                              write a normalized config to the shared /data
                              volume, then signal the host-side applier.
  builders(flowise, langflow, dify): branded landing that links into the
                              product's own UI; the panel does NOT write keys.

SECURITY
  * Single password from env ``PANEL_PASSWORD`` (signed-cookie session). No
    password set => the app refuses to start (fail closed).
  * Secrets are written ONLY to the mounted /data volume (gitignored on the
    host); never into the repo.
  * Input is validated: provider must be in the registry, key non-empty and a
    sane length.

The panel speaks plain HTTP on ``PANEL_PORT``; real TLS is handled by Caddy in
front (see docker-compose.fragment.yml).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx
import yaml
from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import i18n
from providers import (
    PRODUCTS,
    PROVIDERS,
    chat_completions_url,
    get_product,
    get_provider,
    models_url,
)

# --------------------------------------------------------------------------- #
# Configuration / fail-closed startup
# --------------------------------------------------------------------------- #
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("PANEL_DATA_DIR", "/data"))
APPLY_REQUEST_FILE = DATA_DIR / ".apply-request"

PRODUCT = os.environ.get("PRODUCT", "").strip().lower()
PANEL_PASSWORD = os.environ.get("PANEL_PASSWORD", "")
PANEL_DOMAIN = os.environ.get("PANEL_DOMAIN", "").strip()

# Fail closed: no password => refuse to start. This is the only auth gate and
# the panel can write the client's API key, so an unprotected panel is unsafe.
if not PANEL_PASSWORD:
    raise RuntimeError(
        "PANEL_PASSWORD is not set. The panel refuses to start without a "
        "password (fail closed). Set PANEL_PASSWORD in the environment."
    )

# Session cookie signing. Random per process: restarting the panel logs users
# out, which is acceptable for a single-tenant setup wizard.
_SESSION_SECRET = os.environ.get("PANEL_SESSION_SECRET") or secrets.token_hex(32)
SESSION_COOKIE = "chpanel_session"
SESSION_TTL = 12 * 3600  # 12h

# Key validation bounds (sane-length guard, provider-agnostic).
MIN_KEY_LEN = 16
MAX_KEY_LEN = 512
# Telegram bot tokens look like "<digits>:<35 url-safe chars>".
TELEGRAM_TOKEN_RE = re.compile(r"^\d{6,}:[A-Za-z0-9_-]{20,}$")


def _parse_allowed_users(raw: str) -> tuple[bool, str]:
    """Parse the Telegram allowed-users field.

    Accepts a comma-separated list of numeric Telegram user ids (the value the
    client copies from @userinfobot). Returns (ok, normalized) where normalized
    is the de-duplicated, comma-joined list with no spaces (the exact format
    Hermes' TELEGRAM_ALLOWED_USERS expects). An empty input is valid (no
    allowlist change requested) and normalizes to "".
    """
    if not raw.strip():
        return True, ""
    seen: list[str] = []
    for part in raw.split(","):
        uid = part.strip()
        if not uid:
            continue
        if not uid.isdigit():
            return False, ""
        if uid not in seen:
            seen.append(uid)
    return (bool(seen), ",".join(seen))

app = FastAPI(title="CloudHosting AI Panel")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


# --------------------------------------------------------------------------- #
# Session helpers (HMAC-signed cookie; no server-side store needed)
# --------------------------------------------------------------------------- #
def _make_token() -> str:
    issued = str(int(time.time()))
    sig = hmac.new(_SESSION_SECRET.encode(), issued.encode(), hashlib.sha256).hexdigest()
    return f"{issued}.{sig}"


def _valid_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    issued, sig = token.rsplit(".", 1)
    expected = hmac.new(_SESSION_SECRET.encode(), issued.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return False
    try:
        return (time.time() - int(issued)) < SESSION_TTL
    except ValueError:
        return False


def is_authed(request: Request) -> bool:
    return _valid_token(request.cookies.get(SESSION_COOKIE))


# --------------------------------------------------------------------------- #
# Product / provider helpers
# --------------------------------------------------------------------------- #
def product_info() -> dict | None:
    return get_product(PRODUCT)


def is_agent() -> bool:
    p = product_info()
    return bool(p and p["kind"] == "agent")


def public_providers() -> list[dict]:
    """Provider list trimmed for the template (no nested mutation)."""
    return PROVIDERS


# --------------------------------------------------------------------------- #
# Key validation against the provider (OpenAI-compatible)
# --------------------------------------------------------------------------- #
async def validate_key(base_url: str, api_key: str) -> tuple[bool, str]:
    """Validate ``api_key`` against ``base_url`` using GET /models.

    Falls back to a minimal /chat/completions probe if /models is not allowed
    (some compat layers gate /models). Returns (ok, detail).
    """
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(models_url(base_url), headers=headers)
            if r.status_code == 200:
                return True, "models ok"
            if r.status_code in (401, 403):
                return False, f"auth rejected ({r.status_code})"
            # /models not available (404/405) — try a tiny chat probe instead.
            if r.status_code in (404, 405):
                probe = await client.post(
                    chat_completions_url(base_url),
                    headers={**headers, "Content-Type": "application/json"},
                    json={
                        "model": "ping",
                        "max_tokens": 1,
                        "messages": [{"role": "user", "content": "ping"}],
                    },
                )
                # 401/403 => bad key; anything else (incl. 400 model-not-found)
                # means the key authenticated.
                if probe.status_code in (401, 403):
                    return False, f"auth rejected ({probe.status_code})"
                return True, f"chat probe ok ({probe.status_code})"
            return False, f"unexpected status {r.status_code}"
    except httpx.HTTPError as exc:
        return False, f"network error: {exc.__class__.__name__}"


# --------------------------------------------------------------------------- #
# Config writers (normalized) — target the EXACT files each agent reads.
# All writes land under /data, which is the product's mounted data dir.
# --------------------------------------------------------------------------- #
def _read_env(path: Path) -> list[str]:
    if path.exists():
        return path.read_text(encoding="utf-8").splitlines()
    return []


def _merge_env(path: Path, updates: dict[str, str]) -> None:
    """Upsert KEY=VALUE lines into a .env, preserving comments/order."""
    lines = _read_env(path)
    remaining = dict(updates)
    out: list[str] = []
    for ln in lines:
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", ln)
        if m and m.group(1) in remaining:
            key = m.group(1)
            out.append(f"{key}={remaining.pop(key)}")
        else:
            out.append(ln)
    for key, val in remaining.items():
        out.append(f"{key}={val}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)  # secrets file
    except OSError:
        pass


def write_hermes(provider: dict, api_key: str, model: str) -> None:
    """Hermes reads /opt/data/config.yaml + /opt/data/.env (our /data)."""
    cfg_path = DATA_DIR / "config.yaml"
    env_path = DATA_DIR / ".env"

    cfg: dict = {}
    if cfg_path.exists():
        try:
            cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError:
            cfg = {}
    model_block = cfg.get("model") or {}
    model_block.update(
        {
            "provider": "custom",  # any OpenAI-compatible endpoint
            "default": model,
            "base_url": provider["base_url"],
            # Secret stays in .env; config references it via ${VAR}.
            "api_key": "${OPENAI_API_KEY}",
        }
    )
    model_block.setdefault("context_length", 200000)
    cfg["model"] = model_block
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(
        yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )

    # Hermes' custom-endpoint fallback reads OPENAI_API_KEY / OPENAI_BASE_URL.
    _merge_env(
        env_path,
        {
            "OPENAI_API_KEY": api_key,
            "OPENAI_BASE_URL": provider["base_url"],
            # Mirror into AVOTS_API_KEY so the avots-named ref also resolves
            # (harmless for non-avots providers; the active ref is OPENAI_API_KEY).
            "AVOTS_API_KEY": api_key,
        },
    )


def write_openclaw(provider: dict, api_key: str, model: str) -> None:
    """OpenClaw reads ~/.openclaw/openclaw.json + .env (our /data)."""
    cfg_path = DATA_DIR / "openclaw.json"
    env_path = DATA_DIR / ".env"

    cfg: dict = {}
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            cfg = {}

    prov_id = provider["id"]
    qualified = f"{prov_id}/{model}"  # e.g. avots/anthropic/claude-opus-4.8

    # STEP 1: register provider + model under models.providers.<id>.
    models = cfg.setdefault("models", {})
    models.setdefault("mode", "merge")
    providers = models.setdefault("providers", {})
    providers[prov_id] = {
        "baseUrl": provider["base_url"],
        "apiKey": "${OPENAI_API_KEY}",  # secret ref resolved from .env
        "api": "openai-completions",
        "timeoutSeconds": 300,
        "models": [
            {
                "id": model,
                "name": f"{provider['name']} {model}",
                "input": ["text", "image"],
                "contextWindow": 200000,
                "maxTokens": 32000,
                "reasoning": True,
                "compat": {"supportsTools": True, "supportsDeveloperRole": False},
            }
        ],
    }

    # STEP 2: allowlist the fully-qualified model and make it primary.
    agents = cfg.setdefault("agents", {})
    defaults = agents.setdefault("defaults", {})
    defaults.setdefault("model", {})["primary"] = qualified
    defaults.setdefault("models", {})[qualified] = {
        "alias": f"{model} ({prov_id})"
    }

    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")

    # OpenClaw resolves ${OPENAI_API_KEY} (and AVOTS_API_KEY) from .env.
    _merge_env(
        env_path,
        {
            "OPENAI_API_KEY": api_key,
            "AVOTS_API_KEY": api_key,
        },
    )


def write_agent_config(provider: dict, api_key: str, model: str) -> None:
    if PRODUCT == "hermes":
        write_hermes(provider, api_key, model)
    elif PRODUCT == "openclaw":
        write_openclaw(provider, api_key, model)
    else:
        raise RuntimeError(f"write_agent_config called for non-agent {PRODUCT!r}")


def write_telegram(token: str, allowed_users: str | None) -> None:
    """Write the Telegram bot token (+ allowed users) into the agent .env.

    ``allowed_users`` is a normalized comma-separated list of numeric ids (see
    ``_parse_allowed_users``). Hermes reads TELEGRAM_ALLOWED_USERS (CSV);
    OpenClaw reads TELEGRAM_OWNER_ID — we write the same CSV there too (OpenClaw
    accepts a comma list and the lead id remains the primary owner).
    """
    env_path = DATA_DIR / ".env"
    updates = {"TELEGRAM_BOT_TOKEN": token}
    if allowed_users:
        if PRODUCT == "hermes":
            updates["TELEGRAM_ALLOWED_USERS"] = allowed_users
        elif PRODUCT == "openclaw":
            updates["TELEGRAM_OWNER_ID"] = allowed_users
    _merge_env(env_path, updates)


def signal_apply() -> None:
    """Touch /data/.apply-request with a timestamp so the host applier fires."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    APPLY_REQUEST_FILE.write_text(str(int(time.time())) + "\n", encoding="utf-8")


def saved_api_key() -> str | None:
    """Read back the currently-saved key from /data/.env (for status check)."""
    env_path = DATA_DIR / ".env"
    for ln in _read_env(env_path):
        m = re.match(r"^OPENAI_API_KEY=(.*)$", ln)
        if m:
            val = m.group(1).strip()
            if val and "REPLACE_ME" not in val:
                return val
    return None


def saved_base_url() -> str | None:
    """Best-effort: figure out the saved base_url for re-validation."""
    if PRODUCT == "hermes":
        for ln in _read_env(DATA_DIR / ".env"):
            m = re.match(r"^OPENAI_BASE_URL=(.*)$", ln)
            if m and m.group(1).strip():
                return m.group(1).strip()
    elif PRODUCT == "openclaw":
        cfg_path = DATA_DIR / "openclaw.json"
        if cfg_path.exists():
            try:
                cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
                provs = cfg.get("models", {}).get("providers", {})
                for p in provs.values():
                    if p.get("baseUrl"):
                        return p["baseUrl"]
            except (json.JSONDecodeError, AttributeError):
                pass
    return None


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/healthz")
async def healthz():
    return {"ok": True, "product": PRODUCT or None}


@app.get("/login", response_class=HTMLResponse)
async def login_form(request: Request, error: int = 0):
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "login_mode": True,
            "login_error": bool(error),
            "strings_json": json.dumps(i18n.STRINGS, ensure_ascii=False),
            "default_lang": i18n.DEFAULT_LANG,
            "product": PRODUCT,
            "product_info": product_info(),
            "is_agent": False,
            "providers": [],
            "panel_domain": PANEL_DOMAIN,
        },
    )


@app.post("/login")
async def login_submit(password: str = Form(...)):
    if hmac.compare_digest(password, PANEL_PASSWORD):
        resp = RedirectResponse(url="/", status_code=303)
        resp.set_cookie(
            SESSION_COOKIE,
            _make_token(),
            max_age=SESSION_TTL,
            httponly=True,
            samesite="lax",
            secure=False,  # TLS terminated by Caddy in front; cookie crosses HTTP internally
        )
        return resp
    return RedirectResponse(url="/login?" + urlencode({"error": 1}), status_code=303)


@app.get("/logout")
async def logout():
    resp = RedirectResponse(url="/login", status_code=303)
    resp.delete_cookie(SESSION_COOKIE)
    return resp


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    if not is_authed(request):
        return RedirectResponse(url="/login", status_code=303)
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "login_mode": False,
            "login_error": False,
            "strings_json": json.dumps(i18n.STRINGS, ensure_ascii=False),
            "default_lang": i18n.DEFAULT_LANG,
            "product": PRODUCT,
            "product_info": product_info(),
            "is_agent": is_agent(),
            "providers": public_providers(),
            "panel_domain": PANEL_DOMAIN,
        },
    )


@app.post("/api/provider")
async def api_provider(
    request: Request,
    provider: str = Form(...),
    api_key: str = Form(...),
    model: str = Form(""),
):
    if not is_authed(request):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
    if not is_agent():
        return JSONResponse(
            {"ok": False, "error": "not_an_agent"}, status_code=400
        )

    prov = get_provider(provider)
    if prov is None:
        return JSONResponse({"ok": False, "error": "unknown_provider"}, status_code=400)

    api_key = api_key.strip()
    if not api_key:
        return JSONResponse({"ok": False, "error": "empty_key"}, status_code=400)
    if not (MIN_KEY_LEN <= len(api_key) <= MAX_KEY_LEN):
        return JSONResponse({"ok": False, "error": "bad_key_length"}, status_code=400)

    model = (model or "").strip() or prov["default_model"]

    ok, detail = await validate_key(prov["base_url"], api_key)
    if not ok:
        return JSONResponse(
            {"ok": False, "error": "validation_failed", "detail": detail},
            status_code=400,
        )

    try:
        write_agent_config(prov, api_key, model)
        signal_apply()
    except OSError as exc:
        return JSONResponse(
            {"ok": False, "error": "write_failed", "detail": str(exc)},
            status_code=500,
        )

    return JSONResponse(
        {"ok": True, "provider": prov["id"], "model": model, "detail": detail}
    )


@app.post("/api/telegram")
async def api_telegram(
    request: Request,
    token: str = Form(...),
    allowed_users: str = Form(""),
):
    if not is_authed(request):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
    if not is_agent():
        return JSONResponse({"ok": False, "error": "not_an_agent"}, status_code=400)

    token = token.strip()
    if not TELEGRAM_TOKEN_RE.match(token):
        return JSONResponse({"ok": False, "error": "bad_token"}, status_code=400)

    ok_users, allowed_norm = _parse_allowed_users(allowed_users)
    if not ok_users:
        return JSONResponse({"ok": False, "error": "bad_allowed_users"}, status_code=400)

    try:
        write_telegram(token, allowed_norm or None)
        signal_apply()
    except OSError as exc:
        return JSONResponse(
            {"ok": False, "error": "write_failed", "detail": str(exc)},
            status_code=500,
        )
    return JSONResponse({"ok": True})


@app.get("/api/status")
async def api_status(request: Request):
    if not is_authed(request):
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401)
    if not is_agent():
        return JSONResponse({"connected": False, "agent": False})

    key = saved_api_key()
    if not key:
        return JSONResponse({"connected": False, "agent": True})
    base = saved_base_url() or get_provider("avots")["base_url"]
    ok, detail = await validate_key(base, key)
    return JSONResponse(
        {"connected": ok, "agent": True, "base_url": base, "detail": detail}
    )
