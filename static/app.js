/* CloudHosting AI Panel — client JS.
   - RU/EN toggle: swaps all text from window.I18N without a round-trip.
   - Renders manual bullet lists per product.
   - Submits the provider + telegram forms via fetch and shows status.
   - Polls /api/status for the live connected indicator (agents only).
   Language preference is remembered in localStorage under "chpanel.lang". */
(function () {
  "use strict";

  var I18N = window.I18N || {};
  var PANEL = window.PANEL || {};
  var LANG_KEY = "chpanel.lang";

  function currentLang() {
    var stored = null;
    try { stored = localStorage.getItem(LANG_KEY); } catch (e) {}
    if (stored && I18N[stored]) return stored;
    return I18N[PANEL.defaultLang] ? PANEL.defaultLang : "en";
  }

  function t(key) {
    var tbl = I18N[currentLang()] || {};
    return tbl[key] != null ? tbl[key] : key;
  }

  // Replace {product} (and any future {arg}) in a template string.
  function fmt(str, args) {
    if (!args) return str;
    return str.replace(/\{(\w+)\}/g, function (m, k) {
      return args[k] != null ? args[k] : m;
    });
  }

  function applyLang() {
    var lang = currentLang();
    document.documentElement.lang = lang;

    // data-i: text content.
    document.querySelectorAll("[data-i]").forEach(function (el) {
      var key = el.getAttribute("data-i");
      var val = t(key);
      if (typeof val !== "string") return;
      var arg = el.getAttribute("data-i-arg-product");
      el.textContent = arg ? fmt(val, { product: arg }) : val;
    });

    // data-i-ph: placeholder text.
    document.querySelectorAll("[data-i-ph]").forEach(function (el) {
      var key = el.getAttribute("data-i-ph");
      var val = t(key);
      if (typeof val === "string") el.setAttribute("placeholder", val);
    });

    // Provider blurbs are stored per-language on the element.
    document.querySelectorAll(".provider-blurb").forEach(function (el) {
      var v = el.getAttribute("data-blurb-" + lang);
      if (v) el.textContent = v;
    });

    // Active language button.
    document.querySelectorAll(".lang-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-lang") === lang);
    });

    renderManual();
  }

  function renderList(ulId, arr) {
    var ul = document.getElementById(ulId);
    if (!ul) return;
    ul.innerHTML = "";
    (arr || []).forEach(function (line) {
      var li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    });
  }

  function renderManual() {
    var tbl = I18N[currentLang()] || {};
    renderList("manual-generic", tbl.manual_generic);
    var key = "manual_" + (PANEL.product || "");
    renderList("manual-product", tbl[key]);
  }

  function setLang(lang) {
    if (!I18N[lang]) return;
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    applyLang();
  }

  // ---- status indicator (agents) ----
  function setStatus(state) {
    var dot = document.getElementById("status-dot");
    var txt = document.getElementById("status-text");
    if (!dot || !txt) return;
    dot.className = "dot dot-" + state; // connected | off | unknown
    if (state === "connected") txt.textContent = t("status_connected");
    else if (state === "off") txt.textContent = t("status_not_connected");
    else txt.textContent = t("status_checking");
  }

  function refreshStatus() {
    if (!PANEL.isAgent) return;
    setStatus("unknown");
    fetch("/api/status", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) { setStatus(d && d.connected ? "connected" : "off"); })
      .catch(function () { setStatus("off"); });
  }

  function msg(elId, text, ok) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.textContent = text;
    el.className = "form-msg " + (ok ? "ok" : "error");
  }

  function wireProviderForm() {
    var form = document.getElementById("provider-form");
    if (!form) return;
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var chosen = document.querySelector('input[name="provider"]:checked');
      if (!chosen) { msg("provider-msg", t("field_required"), false); return; }
      var key = document.getElementById("api_key").value.trim();
      if (!key) { msg("provider-msg", t("field_required"), false); return; }

      var body = new URLSearchParams();
      body.set("provider", chosen.value);
      body.set("api_key", key);
      body.set("model", document.getElementById("model").value.trim());

      msg("provider-msg", t("saving"), true);
      fetch("/api/provider", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
        .then(function (res) {
          if (res.d && res.d.ok) {
            msg("provider-msg", t("save_ok"), true);
            setTimeout(refreshStatus, 1500);
          } else {
            var err = res.d && res.d.error;
            var text = err === "write_failed" ? t("save_fail_write") : t("save_fail_validate");
            msg("provider-msg", text, false);
          }
        })
        .catch(function () { msg("provider-msg", t("save_fail_validate"), false); });
    });

    // Prefill the model placeholder hint from the chosen provider.
    function syncModelHint() {
      var chosen = document.querySelector('input[name="provider"]:checked');
      var inp = document.getElementById("model");
      if (chosen && inp) inp.setAttribute("data-suggest", chosen.getAttribute("data-model") || "");
    }
    form.ownerDocument.querySelectorAll('input[name="provider"]').forEach(function (r) {
      r.addEventListener("change", syncModelHint);
    });
    syncModelHint();
  }

  function wireTelegramForm() {
    var form = document.getElementById("telegram-form");
    if (!form) return;
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var token = document.getElementById("tg_token").value.trim();
      var owner = document.getElementById("tg_owner").value.trim();
      if (!token) { msg("telegram-msg", t("field_required"), false); return; }
      var body = new URLSearchParams();
      body.set("token", token);
      body.set("owner_id", owner);
      msg("telegram-msg", t("saving"), true);
      fetch("/api/telegram", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) msg("telegram-msg", t("save_ok"), true);
          else msg("telegram-msg", t("field_required"), false);
        })
        .catch(function () { msg("telegram-msg", t("field_required"), false); });
    });
  }

  function init() {
    document.querySelectorAll(".lang-btn").forEach(function (b) {
      b.addEventListener("click", function () { setLang(b.getAttribute("data-lang")); });
    });
    var recheck = document.getElementById("recheck-btn");
    if (recheck) recheck.addEventListener("click", refreshStatus);

    applyLang();
    wireProviderForm();
    wireTelegramForm();
    refreshStatus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
