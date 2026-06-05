"""Provider registry for the CloudHosting AI Panel.

Data-driven so the UI and the apply logic share one source of truth. avots is
listed FIRST and flagged ``recommended`` so the template can render the
"Рекомендуем / Recommended" badge and pre-select it.

Each provider exposes:
  id            stable machine id (also written into product configs)
  name          human display name
  base_url      OpenAI-compatible base; MUST end at /v1 (or /v1/) so that
                "<base_url>/chat/completions" and "<base_url>/models" resolve.
  key_prefix    hint shown in the UI + used for a soft validation nudge.
  signup_url    where the client gets a key.
  default_model suggested model id to seed into the agent config.
  recommended   True only for avots (badge + default selection).
  blurb         {"ru": ..., "en": ...} short marketing/explainer line.

The product / agent wiring (which config files to touch) lives in app.py, not
here; this module is intentionally pure data.
"""

from __future__ import annotations

# Ordered: avots is first on purpose (recommended + default).
PROVIDERS: list[dict] = [
    {
        "id": "avots",
        "name": "Avots AI",
        "base_url": "https://api.avots.ai/openai/v1",
        "key_prefix": "av_mcp_",
        "signup_url": "https://avots.ai",
        "default_model": "anthropic/claude-opus-4.8",
        "recommended": True,
        "blurb": {
            "ru": (
                "Один баланс на все модели (Claude, GPT, Gemini и другие). "
                "OpenAI-совместимый, проще всего подключить. Рекомендуем."
            ),
            "en": (
                "One balance for every model (Claude, GPT, Gemini and more). "
                "OpenAI-compatible and the easiest to connect. Recommended."
            ),
        },
    },
    {
        "id": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "key_prefix": "sk-",
        "signup_url": "https://platform.openai.com",
        "default_model": "gpt-4o",
        "recommended": False,
        "blurb": {
            "ru": "Модели ChatGPT / GPT напрямую от OpenAI. Нужен ключ OpenAI.",
            "en": "ChatGPT / GPT models straight from OpenAI. Requires an OpenAI key.",
        },
    },
    {
        "id": "anthropic",
        "name": "Anthropic (Claude)",
        # OpenAI-compatibility layer (verified 2026-06-05): base_url ends at /v1/.
        # The native API is /v1/messages; this compat layer exposes
        # /v1/chat/completions + /v1/models. See README "Anthropic note".
        "base_url": "https://api.anthropic.com/v1/",
        "key_prefix": "sk-ant-",
        "signup_url": "https://console.anthropic.com",
        "default_model": "claude-opus-4-8",
        "recommended": False,
        "blurb": {
            "ru": (
                "Модели Claude напрямую от Anthropic через OpenAI-совместимый слой. "
                "Для некоторых агентов может потребоваться нативный режим Anthropic."
            ),
            "en": (
                "Claude models straight from Anthropic via its OpenAI-compatible layer. "
                "Some agents may instead need a native-Anthropic mode."
            ),
        },
    },
]

# Fast lookup by id.
PROVIDERS_BY_ID: dict[str, dict] = {p["id"]: p for p in PROVIDERS}


def get_provider(provider_id: str) -> dict | None:
    """Return the provider dict for ``provider_id`` or None if unknown."""
    return PROVIDERS_BY_ID.get(provider_id)


def default_provider() -> dict:
    """The recommended/default provider (avots), falling back to the first."""
    for p in PROVIDERS:
        if p.get("recommended"):
            return p
    return PROVIDERS[0]


def models_url(base_url: str) -> str:
    """Build the ``/models`` URL from a base that may or may not end in '/'."""
    return base_url.rstrip("/") + "/models"


def chat_completions_url(base_url: str) -> str:
    """Build the ``/chat/completions`` URL from a base url."""
    return base_url.rstrip("/") + "/chat/completions"


# ---------------------------------------------------------------------------
# Product registry: which products are agents (panel writes config) vs builders
# (panel only links into their own UI). Config paths / compose service names are
# taken from the sibling product repos under /srv/ai-vms/*-vm (verified 2026-06-05).
# ---------------------------------------------------------------------------
PRODUCTS: dict[str, dict] = {
    "hermes": {
        "kind": "agent",
        "name": "Hermes Agent",
        # data dir mounted at /opt/data inside the container; panel writes /data.
        "config_file": "config.yaml",
        "env_file": ".env",
        "compose_service": "gateway",
        "telegram": True,
    },
    "openclaw": {
        "kind": "agent",
        "name": "OpenClaw",
        # ~/.openclaw is the data dir; panel writes /data.
        "config_file": "openclaw.json",
        "env_file": ".env",
        "compose_service": "openclaw-gateway",
        "telegram": True,
    },
    "flowise": {
        "kind": "builder",
        "name": "Flowise",
        # provider set inside Flowise's own UI (ChatOpenAI node Base Path).
    },
    "langflow": {
        "kind": "builder",
        "name": "Langflow",
    },
    "dify": {
        "kind": "builder",
        "name": "Dify",
    },
}


def get_product(product_id: str) -> dict | None:
    return PRODUCTS.get(product_id)
