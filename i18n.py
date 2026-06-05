"""Tiny i18n loader.

Loads ``locales/{ru,en}.json`` once at import. The server renders the page with
ALL strings for both languages embedded as a JS object, and a vanilla-JS toggle
swaps them client-side (no round-trip). ``DEFAULT_LANG`` is the initial render.
"""

from __future__ import annotations

import json
from pathlib import Path

LOCALES_DIR = Path(__file__).resolve().parent / "locales"

SUPPORTED = ("ru", "en")
DEFAULT_LANG = "ru"


def _load(lang: str) -> dict:
    path = LOCALES_DIR / f"{lang}.json"
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# Loaded once at import.
STRINGS: dict[str, dict] = {lang: _load(lang) for lang in SUPPORTED}


def normalize_lang(lang: str | None) -> str:
    """Coerce an arbitrary lang code to a supported one (default otherwise)."""
    if not lang:
        return DEFAULT_LANG
    lang = lang.lower()[:2]
    return lang if lang in SUPPORTED else DEFAULT_LANG


def strings(lang: str) -> dict:
    """Return the string table for ``lang`` (normalized)."""
    return STRINGS[normalize_lang(lang)]
