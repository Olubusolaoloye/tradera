"use strict";

/* Tradera admin dashboard.
   Security notes:
   - Every value from the server is put on the page with textContent, never
     innerHTML, so names or messages can't inject code.
   - The admin session lives in sessionStorage (gone when the tab closes),
     is sent in a header (not a cookie) and ends after 15 idle minutes. */

(function () {
  const root = document.getElementById("root");
  const KEY = "tradera-admin-session";
  const IDLE_MS = 15 * 60 * 1000;

  let session = load();
  let data = null;          // overview
  let users = null;
  let tab = "overview";
  let pendingFeatures = null;
  let idleTimer = null;

  // ----------------------------------------------------------------- utils

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      });
    }
    (Array.isArray(children) ? children : children === undefined ? [] : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function msg(kind, text) { return h("div", { class: "msg " + kind, role: kind === "error" ? "alert" : "status", text: text }); }
  function when(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function load() {
    try {
      const s = JSON.parse(sessionStorage.getItem(KEY) || "null");
      return s && s.token && s.expiresAt > Date.now() ? s : null;
    } catch (_) { return null; }
  }
  function save(s) {
    session = s;
    try { s ? sessionStorage.setItem(KEY, JSON.stringify(s)) : sessionStorage.removeItem(KEY); } catch (_) { /* private mode */ }
  }

  async function api(path, opts) {
    const o = opts || {};
    const headers = { "Content-Type": "application/json" };
    if (session) headers["X-Admin-Token"] = session.token;
    let res;
    try {
      res = await fetch(path, { method: o.method || "GET", headers: headers, body: o.body ? JSON.stringify(o.body) : undefined, cache: "no-store", credentials: "omit" });
    } catch (_) {
      throw new Error("Can't reach Tradera. Check your connection.");
    }
    let body = {};
    try { body = await res.json(); } catch (_) { /* empty */ }
    if (res.status === 401 && body.admin === "login") {
      save(null);
      renderLogin("Your admin session ended. Sign in again.");
      throw new Error("signed-out");
    }
    if (!res.ok) throw new Error(body.error || "Request failed (" + res.status + ")");
    return body;
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || "Working…"; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }

  function brand(sub) {
    return h("div", { class: "brand" }, [h("div", { class: "brand-mark", "aria-hidden": "true", text: "T" }), h("div", null, [h("b", { text: "Tradera" }), h("span", { text: sub || "Admin" })])]);
  }

  // ------------------------------------------------------------- idle lock

  function armIdle() {
    clearTimeout(idleTimer);
    if (!session) return;
    idleTimer = setTimeout(function () { logout("You were signed out after 15 minutes without activity."); }, IDLE_MS);
  }
  ["click", "keydown", "pointerdown", "scroll"].forEach(function (ev) {
    document.addEventListener(ev, function () { if (session) armIdle(); }, { passive: true });
  });
  setInterval(function () {
    if (session && session.expiresAt <= Date.now()) logout("Your admin session expired. Sign in again.");
  }, 30000);

  async function logout(note) {
    if (session) { try { await api("/api/admin/logout", { method: "POST", body: {} }); } catch (_) { /* already gone */ } }
    save(null);
    data = null; users = null;
    renderLogin(note || "Signed out.");
  }

  // ----------------------------------------------------------------- login

  function renderLogin(note, isError) {
    clear(root);
    const email = h("input", { type: "email", name: "email", autocomplete: "username", required: true, maxlength: 200 });
    const pw = h("input", { type: "password", name: "password", autocomplete: "current-password", required: true, maxlength: 200 });
    const code = h("input", { type: "text", name: "code", class: "code-input", autocomplete: "one-time-code", inputmode: "numeric", maxlength: 20, placeholder: "123 456" });
    const out = h("div");
    const btn = h("button", { class: "btn primary block", type: "submit", text: "Sign in" });
    const form = h("form", { novalidate: true }, [
      h("label", { class: "field" }, [h("span", { text: "Email" }), email]),
      h("label", { class: "field" }, [h("span", { text: "Password" }), pw]),
      h("label", { class: "field" }, [h("span", { text: "6-digit code from your authenticator app (or a recovery code)" }), code]),
      btn, out
    ]);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clear(out);
      if (!email.value || !pw.value) { out.appendChild(msg("error", "Enter your email and password.")); return; }
      busy(btn, true, "Checking…");
      try {
        const r = await api("/api/admin/login", { method: "POST", body: { email: email.value, password: pw.value, code: code.value } });
        if (r.needsSetup) {
          renderSetup(email.value, pw.value, r.needsSetupCode);
          return;
        }
        save({ token: r.token, expiresAt: r.expiresAt, email: r.email });
        pw.value = ""; code.value = "";
        if (r.recoveryLeft !== undefined && r.recoveryLeft < 3) alert("You have " + r.recoveryLeft + " recovery codes left. Make new ones under Security.");
        start();
      } catch (err) {
        out.appendChild(msg("error", err.message));
        code.value = "";
      } finally { busy(btn, false); }
    });
    root.appendChild(h("div", { class: "auth" }, h("div", { class: "auth-card" }, [
      brand("Admin dashboard"),
      h("h1", { text: "Admin sign-in" }),
      h("p", { class: "muted small", text: "For Tradera admins only. Every sign-in and change is recorded." }),
      note ? msg(isError ? "error" : "info", note) : null,
      form
    ])));
    email.focus();
  }

  function renderSetup(email, password, needsCode) {
    clear(root);
    const card = h("div", { class: "auth-card" });
    root.appendChild(h("div", { class: "auth" }, card));
    card.appendChild(brand("Two-step sign-in"));
    card.appendChild(h("h1", { text: "Set up two-step sign-in" }));
    if (!needsCode) {
      // No setup code on this site: go straight to connecting the app.
      card.appendChild(h("p", { class: "muted small", text: "Preparing your authenticator key…" }));
      api("/api/admin/setup", { method: "POST", body: { step: "start", email: email, password: password } })
        .then(function (r) { showSecret(card, email, password, "", r); })
        .catch(function (err) {
          if (err.message === "signed-out") return;
          clear(card);
          card.appendChild(msg("error", err.message));
          card.appendChild(h("button", { class: "btn block", type: "button", text: "Back to sign-in", onclick: function () { renderLogin(); } }));
        });
      return;
    }
    card.appendChild(h("p", { class: "muted small", text: "Admins need a code from an authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator…) as well as their password. Enter the setup code you saved on Netlify to begin." }));
    const setupCode = h("input", { type: "password", autocomplete: "off", maxlength: 200 });
    const out = h("div");
    const btn = h("button", { class: "btn primary block", type: "submit", text: "Continue" });
    const form = h("form", { novalidate: true }, [h("label", { class: "field" }, [h("span", { text: "Setup code (TRADERA_ADMIN_SETUP_CODE)" }), setupCode]), btn, out]);
    card.appendChild(form);
    setupCode.focus();
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clear(out);
      busy(btn, true);
      try {
        const r = await api("/api/admin/setup", { method: "POST", body: { step: "start", email: email, password: password, setupCode: setupCode.value } });
        showSecret(card, email, password, setupCode.value, r);
      } catch (err) { out.appendChild(msg("error", err.message)); }
      finally { busy(btn, false); }
    });
  }

  function showSecret(card, email, password, setupCode, r) {
    clear(card);
    card.appendChild(brand("Two-step sign-in"));
    card.appendChild(h("h1", { text: "Add Tradera to your authenticator app" }));
    card.appendChild(h("p", { class: "muted small", text: "On your phone, open the authenticator app, choose add account → enter a setup key, and type this key (time-based):" }));
    card.appendChild(h("div", { class: "secret", text: r.secret.replace(/(.{4})/g, "$1 ").trim() }));
    card.appendChild(h("p", { class: "small" }, [
      "On this phone? ",
      h("a", { href: r.uri, rel: "noopener", text: "Open in authenticator app" })
    ]));
    const code = h("input", { type: "text", class: "code-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 7, placeholder: "123456" });
    const out = h("div");
    const btn = h("button", { class: "btn primary block", type: "submit", text: "Turn on two-step sign-in" });
    const form = h("form", { novalidate: true }, [h("label", { class: "field" }, [h("span", { text: "Then type the 6-digit code it shows" }), code]), btn, out]);
    card.appendChild(form);
    code.focus();
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clear(out);
      busy(btn, true);
      try {
        const res = await api("/api/admin/setup", { method: "POST", body: { step: "confirm", email: email, password: password, setupCode: setupCode, code: code.value } });
        save({ token: res.token, expiresAt: res.expiresAt, email: res.email });
        showRecovery(res.recoveryCodes, function () { start(); });
      } catch (err) { out.appendChild(msg("error", err.message)); code.value = ""; }
      finally { busy(btn, false); }
    });
  }

  function showRecovery(codes, done) {
    clear(root);
    const ok = h("input", { type: "checkbox" });
    const btn = h("button", { class: "btn primary block", type: "button", text: "I've saved them — continue", disabled: true, onclick: done });
    ok.addEventListener("change", function () { btn.disabled = !ok.checked; });
    root.appendChild(h("div", { class: "auth" }, h("div", { class: "auth-card" }, [
      brand("Recovery codes"),
      h("h1", { text: "Save your recovery codes" }),
      h("p", { class: "muted small", text: "If you lose your phone, each of these codes signs you in once instead of the 6-digit code. Store them in a password manager or print them. They won't be shown again." }),
      h("div", { class: "codes" }, codes.map(function (c) { return h("code", { text: c }); })),
      h("button", { class: "btn small", type: "button", text: "Copy all", onclick: function () {
        try { navigator.clipboard.writeText(codes.join("\n")); this.textContent = "Copied"; } catch (_) { /* ignore */ }
      } }),
      h("label", { class: "check-line" }, [ok, h("span", { text: "I've stored these codes somewhere safe." })]),
      btn
    ])));
  }

  // ------------------------------------------------------------- dashboard

  async function start() {
    armIdle();
    clear(root);
    root.appendChild(h("div", { class: "auth" }, h("p", { class: "muted", text: "Loading…" })));
    try {
      data = await api("/api/admin/overview");
      pendingFeatures = null;
      renderShell();
    } catch (err) {
      if (err.message !== "signed-out") renderLogin(err.message, true);
    }
  }

  const TABS = [["overview", "Overview"], ["features", "Features"], ["users", "Users"], ["pro", "Pro list"], ["security", "Security"], ["audit", "Activity log"]];

  function renderShell() {
    clear(root);
    const top = h("header", { class: "top" }, [
      h("div", { class: "top-inner" }, [
        brand("Admin dashboard"),
        h("div", { class: "spacer" }),
        h("div", { class: "who" }, [h("div", { text: session.email }), h("div", { text: "Session ends " + new Date(session.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })]),
        h("a", { class: "btn small", href: "/", text: "Open app" }),
        h("button", { class: "btn small", type: "button", text: "Sign out", onclick: function () { logout(); } })
      ]),
      h("nav", { class: "tabs", "aria-label": "Admin sections" }, TABS.map(function (t) {
        return h("button", { class: "tab" + (tab === t[0] ? " active" : ""), type: "button", "aria-current": tab === t[0] ? "page" : null, text: t[1], onclick: function () { tab = t[0]; renderShell(); } });
      }))
    ]);
    const page = h("div", { class: "page" });
    root.appendChild(top);
    root.appendChild(page);
    ({ overview: renderOverview, features: renderFeatures, users: renderUsers, pro: renderPro, security: renderSecurity, audit: renderAudit })[tab](page);
  }

  function stat(label, value, warn) {
    return h("div", { class: "stat" + (warn ? " warn" : "") }, [h("b", { text: String(value) }), h("span", { text: label })]);
  }
  function pill(on, yes, no) { return h("span", { class: "pill " + (on ? "on" : "off"), text: on ? (yes || "On") : (no || "Off") }); }

  function auditList(list) {
    if (!list.length) return h("p", { class: "muted", text: "Nothing recorded yet." });
    return h("div", null, list.map(function (a) {
      const bad = /failed|denied/.test(a.action);
      return h("div", { class: "audit-row" }, [
        h("div", { class: "when", text: when(a.at) }),
        h("div", null, [
          h("span", { class: bad ? "bad" : "", text: a.action.replace(/-/g, " ") }),
          a.target ? " · " + a.target : "",
          a.detail ? " · " + a.detail : "",
          h("div", { class: "muted small", text: (a.admin || "?") + " · IP " + (a.ip || "?") })
        ])
      ]);
    }));
  }

  const aiResult = h("div");
  function testAiButton() {
    return h("button", { class: "btn small", type: "button", text: "Test", onclick: async function () {
      clear(aiResult);
      busy(this, true, "Testing…");
      const btn = this;
      try {
        const r = await api("/api/admin/test-ai", { method: "POST", body: {} });
        aiResult.appendChild(msg(r.ok ? "ok" : "error", r.message + (r.ms ? " (" + (r.ms / 1000).toFixed(1) + "s)" : "")));
      } catch (err) { if (err.message !== "signed-out") aiResult.appendChild(msg("error", err.message)); }
      finally { busy(btn, false); }
    } });
  }

  function renderOverview(page) {
    const s = data.stats, env = data.env, cfg = data.config;
    page.appendChild(h("div", { class: "stats" }, [
      stat("Accounts", s.users), stat("New today", s.newToday), stat("New in 7 days", s.new7), stat("New in 30 days", s.new30),
      stat("Signed in, last 7 days", s.active7), stat("Pro accounts", s.pro), stat("Disabled", s.disabled),
      stat("Failed admin sign-ins (24h)", s.failedAdminLogins24h, s.failedAdminLogins24h > 0)
    ]));
    const off = Object.keys(cfg.features).filter(function (k) { return !cfg.features[k]; });
    page.appendChild(h("div", { class: "grid2" }, [
      h("section", { class: "panel" }, [
        h("div", { class: "panel-head" }, h("h2", { text: "Platform" })),
        h("div", { class: "env-row" }, [h("span", { text: "Maintenance mode" }), pill(cfg.maintenance.enabled, "On — app closed", "Off")]),
        h("div", { class: "env-row" }, [h("span", { text: "Switched-off features" }), h("span", { text: off.length ? off.map(function (k) { return data.features[k].label; }).join(", ") : "None" })]),
        h("div", { class: "env-row" }, [h("span", { text: "Announcement" }), h("span", { class: "muted", text: cfg.announcement || "None" })]),
        h("div", { class: "env-row" }, [h("span", { text: "Last changed" }), h("span", { class: "muted", text: cfg.updatedAt ? when(cfg.updatedAt) + " by " + cfg.updatedBy : "Never" })])
      ]),
      h("section", { class: "panel" }, [
        h("div", { class: "panel-head" }, h("h2", { text: "Netlify settings" })),
        h("div", { class: "env-row" }, [h("span", { text: "AI chart reading key (ANTHROPIC_API_KEY)" }), h("span", null, [pill(env.aiKey, "Set", "Missing"), " ", testAiButton()])]),
        aiResult,
        h("div", { class: "env-row" }, [h("span", { text: "Pushover app token (PUSHOVER_APP_TOKEN)" }), pill(env.pushoverToken, "Set", "Missing")]),
        h("div", { class: "env-row" }, [h("span", { text: "Sign-ups closed by TRADERA_SIGNUPS" }), pill(!env.signupsClosedByEnv, "No", "Yes — overrides the switch")]),
        h("div", { class: "env-row" }, [h("span", { text: "Admins (TRADERA_ADMIN_EMAILS)" }), h("span", { text: String(env.admins) })])
      ])
    ]));
    page.appendChild(h("section", { class: "panel" }, [
      h("div", { class: "panel-head" }, [h("h2", { text: "Recent activity" }), h("div", { class: "spacer" }), h("button", { class: "btn small", type: "button", text: "Full log", onclick: function () { tab = "audit"; renderShell(); } })]),
      auditList(data.audit)
    ]));
  }

  function renderFeatures(page) {
    const cfg = data.config;
    const draft = pendingFeatures || {
      features: Object.assign({}, cfg.features),
      maintenance: Object.assign({}, cfg.maintenance),
      announcement: cfg.announcement
    };
    pendingFeatures = draft;
    const bar = h("div", { class: "dirty-bar hidden" });
    const out = h("div");
    const refreshBar = function () {
      const changed = JSON.stringify(draft.features) !== JSON.stringify(cfg.features) ||
        draft.maintenance.enabled !== cfg.maintenance.enabled || draft.maintenance.message !== cfg.maintenance.message ||
        draft.announcement !== cfg.announcement;
      bar.classList.toggle("hidden", !changed);
    };
    const toggle = function (checked, onchange, label) {
      const input = h("input", { type: "checkbox", role: "switch", "aria-label": label });
      input.checked = checked;
      input.addEventListener("change", function () { onchange(input.checked); refreshBar(); });
      return h("label", { class: "switch" }, [input, h("i")]);
    };

    page.appendChild(h("section", { class: "panel" }, [
      h("div", { class: "panel-head" }, [h("h2", { text: "Features" }), h("span", { class: "muted small", text: "Switching a feature off hides it in the app and stops it on the server for every user." })])
    ].concat(Object.keys(data.features).map(function (k) {
      const f = data.features[k];
      return h("div", { class: "toggle-row" }, [
        h("div", { class: "t-text" }, [h("b", { text: f.label }), h("span", { text: f.help })]),
        toggle(!!draft.features[k], function (v) { draft.features[k] = v; }, f.label)
      ]);
    }))));

    const mMsg = h("textarea", { maxlength: 300, placeholder: "e.g. Tradera is being upgraded. Back by 14:00 GMT." });
    mMsg.value = draft.maintenance.message || "";
    mMsg.addEventListener("input", function () { draft.maintenance.message = mMsg.value; refreshBar(); });
    const ann = h("textarea", { maxlength: 300, placeholder: "Shown as a banner at the top of the app. Leave empty for none." });
    ann.value = draft.announcement || "";
    ann.addEventListener("input", function () { draft.announcement = ann.value; refreshBar(); });

    page.appendChild(h("section", { class: "panel" }, [
      h("div", { class: "panel-head" }, h("h2", { text: "Maintenance and announcement" })),
      h("div", { class: "toggle-row" }, [
        h("div", { class: "t-text" }, [h("b", { text: "Maintenance mode" }), h("span", { text: "Closes the app for every user (this dashboard keeps working). Price alerts keep running." })]),
        toggle(!!draft.maintenance.enabled, function (v) { draft.maintenance.enabled = v; }, "Maintenance mode")
      ]),
      h("label", { class: "field" }, [h("span", { text: "Maintenance message" }), mMsg]),
      h("label", { class: "field" }, [h("span", { text: "Announcement banner" }), ann])
    ]));

    const saveBtn = h("button", { class: "btn primary", type: "button", text: "Save changes" });
    saveBtn.addEventListener("click", async function () {
      const turningOn = draft.maintenance.enabled && !cfg.maintenance.enabled;
      if (turningOn && !confirm("Turn on maintenance mode? Every user will be locked out of the app until you turn it off.")) return;
      busy(saveBtn, true, "Saving…");
      clear(out);
      try {
        const r = await api("/api/admin/config", { method: "POST", body: { features: draft.features, maintenance: draft.maintenance, announcement: draft.announcement } });
        data.config = r.config;
        pendingFeatures = null;
        renderShell();
        page = root.querySelector(".page");
        page.insertBefore(msg("ok", "Saved. Changes reach users within about 15 seconds."), page.firstChild);
      } catch (err) {
        if (err.message !== "signed-out") out.appendChild(msg("error", err.message));
        busy(saveBtn, false);
      }
    });
    bar.appendChild(h("span", { text: "You have unsaved changes." }));
    bar.appendChild(h("div", { class: "spacer" }));
    bar.appendChild(h("button", { class: "btn", type: "button", text: "Discard", onclick: function () { pendingFeatures = null; renderShell(); } }));
    bar.appendChild(saveBtn);
    page.appendChild(out);
    page.appendChild(bar);
    refreshBar();
  }

  async function renderUsers(page) {
    const search = h("input", { type: "search", placeholder: "Search by email", "aria-label": "Search users" });
    const list = h("div");
    const out = h("div");
    page.appendChild(h("section", { class: "panel" }, [
      h("div", { class: "panel-head" }, [h("h2", { text: "Users" }), h("div", { class: "spacer" }), h("button", { class: "btn small", type: "button", text: "Refresh", onclick: function () { users = null; renderShell(); } })]),
      search, out, list
    ]));
    if (!users) {
      list.appendChild(h("p", { class: "muted", text: "Loading users…" }));
      try { users = (await api("/api/admin/users")).users; } catch (err) { if (err.message !== "signed-out") out.appendChild(msg("error", err.message)); return; }
    }
    const draw = function () {
      clear(list);
      const q = search.value.trim().toLowerCase();
      const shown = users.filter(function (u) { return !q || u.email.includes(q); }).slice(0, 300);
      if (!shown.length) { list.appendChild(h("p", { class: "muted", text: "No users match." })); return; }
      const rows = shown.map(function (u) {
        const pro = u.plan === "pro" || u.proByList;
        return h("tr", null, [
          h("td", null, [h("div", { class: "email", text: u.email }), h("div", { class: "muted small" }, [
            u.admin ? h("span", { class: "pill pro", text: "Admin" }) : null, " ",
            pro ? h("span", { class: "pill pro", text: u.proByList && u.plan !== "pro" ? "Pro (list)" : "Pro" }) : h("span", { class: "pill", text: "Free" }), " ",
            u.disabled ? h("span", { class: "pill off", text: "Disabled" }) : null
          ])]),
          h("td", { class: "small" }, [h("div", { text: "Joined " + when(u.createdAt) }), h("div", { class: "muted", text: "Last sign-in " + when(u.lastLoginAt) })]),
          h("td", { class: "actions" }, [
            h("button", { class: "btn small", type: "button", text: u.plan === "pro" ? "Make free" : "Make Pro", onclick: function () { act(u, { action: "plan", plan: u.plan === "pro" ? "free" : "pro" }, out); } }),
            u.admin && u.email === session.email ? null : h("button", { class: "btn small", type: "button", text: "Sign out", onclick: function () {
              if (confirm("Sign " + u.email + " out on every device?")) act(u, { action: "logout" }, out);
            } }),
            u.admin ? null : (u.disabled
              ? h("button", { class: "btn small", type: "button", text: "Enable", onclick: function () { act(u, { action: "enable" }, out); } })
              : h("button", { class: "btn small danger", type: "button", text: "Disable", onclick: function () {
                  if (confirm("Disable " + u.email + "? They are signed out now, can't sign in, and their alerts stop.")) act(u, { action: "disable" }, out);
                } })),
            u.admin ? null : h("button", { class: "btn small danger", type: "button", text: "Delete", onclick: function () { deleteUser(u, out); } })
          ])
        ]);
      });
      list.appendChild(h("p", { class: "muted small", text: users.length + " accounts" + (shown.length < users.length ? " · showing " + shown.length : "") }));
      list.appendChild(h("table", null, [h("thead", null, h("tr", null, [h("th", { text: "Account" }), h("th", { text: "Dates" }), h("th", { text: "" })])), h("tbody", null, rows)]));
    };
    search.addEventListener("input", draw);
    draw();
  }

  async function act(u, body, out) {
    clear(out);
    try {
      const r = await api("/api/admin/users/action", { method: "POST", body: Object.assign({ ek: u.ek }, body) });
      if (r.user) {
        const i = users.findIndex(function (x) { return x.ek === u.ek; });
        if (i >= 0) users[i] = Object.assign({}, users[i], r.user);
      }
      renderShell();
      const page = root.querySelector(".page");
      page.insertBefore(msg("ok", "Done: " + u.email), page.firstChild);
    } catch (err) { if (err.message !== "signed-out") out.appendChild(msg("error", err.message)); }
  }

  function deleteUser(u, out) {
    const typed = h("input", { type: "text", autocomplete: "off", "aria-label": "Type the email to confirm" });
    const code = h("input", { type: "text", class: "code-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 20, "aria-label": "Your 6-digit code" });
    const err = h("div");
    const go = h("button", { class: "btn danger solid", type: "button", text: "Delete forever" });
    const dlg = h("dialog", null, [
      h("h2", { text: "Delete this account?" }),
      h("p", { class: "muted small", text: "This permanently deletes " + u.email + ", their journal, setups and screenshots. It can't be undone." }),
      h("label", { class: "field" }, [h("span", { text: "Type their email to confirm" }), typed]),
      h("label", { class: "field" }, [h("span", { text: "Your 6-digit code" }), code]),
      err,
      h("div", { class: "row-actions" }, [h("button", { class: "btn", type: "button", text: "Cancel", onclick: function () { dlg.close(); dlg.remove(); } }), go])
    ]);
    go.addEventListener("click", async function () {
      clear(err);
      busy(go, true, "Deleting…");
      try {
        await api("/api/admin/users/action", { method: "POST", body: { ek: u.ek, action: "delete", confirmEmail: typed.value, code: code.value } });
        dlg.close(); dlg.remove();
        users = users.filter(function (x) { return x.ek !== u.ek; });
        renderShell();
        const page = root.querySelector(".page");
        page.insertBefore(msg("ok", "Deleted " + u.email), page.firstChild);
      } catch (e) {
        if (e.message !== "signed-out") err.appendChild(msg("error", e.message));
        busy(go, false);
      }
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    typed.focus();
  }

  function renderPro(page) {
    const area = h("textarea", { rows: 10, placeholder: "one@example.com\ntwo@example.com" });
    area.value = (data.config.proEmails || []).join("\n");
    const out = h("div");
    const btn = h("button", { class: "btn primary", type: "button", text: "Save Pro list" });
    btn.addEventListener("click", async function () {
      clear(out);
      const list = area.value.split(/[\s,;]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
      const bad = list.filter(function (e) { return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); });
      if (bad.length) { out.appendChild(msg("error", "These don't look like emails: " + bad.slice(0, 5).join(", "))); return; }
      busy(btn, true, "Saving…");
      try {
        const r = await api("/api/admin/config", { method: "POST", body: { proEmails: list } });
        data.config = r.config;
        users = null;
        out.appendChild(msg("ok", "Saved " + r.config.proEmails.length + " Pro emails."));
      } catch (err) { if (err.message !== "signed-out") out.appendChild(msg("error", err.message)); }
      finally { busy(btn, false); }
    });
    page.appendChild(h("section", { class: "panel" }, [
      h("div", { class: "panel-head" }, h("h2", { text: "Pro list" })),
      h("p", { class: "muted small", text: "Everyone on this list gets Pro (AI chart reading now, phone calls later), whether or not they have signed up yet. You can also make a single account Pro from Users. Until payments are added, this is how Pro is given." }),
      area, h("div", { class: "row-actions" }, btn), out
    ]));
  }

  function renderSecurity(page) {
    // change password
    const cur = h("input", { type: "password", autocomplete: "current-password", maxlength: 200 });
    const next = h("input", { type: "password", autocomplete: "new-password", maxlength: 200 });
    const again = h("input", { type: "password", autocomplete: "new-password", maxlength: 200 });
    const code = h("input", { type: "text", class: "code-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 20 });
    const out = h("div");
    const btn = h("button", { class: "btn primary", type: "submit", text: "Change password" });
    const form = h("form", { novalidate: true }, [
      h("label", { class: "field" }, [h("span", { text: "Current password" }), cur]),
      h("label", { class: "field" }, [h("span", { text: "New password (12+ characters)" }), next]),
      h("label", { class: "field" }, [h("span", { text: "New password again" }), again]),
      h("label", { class: "field" }, [h("span", { text: "6-digit code" }), code]),
      h("div", { class: "row-actions" }, btn), out
    ]);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clear(out);
      if (next.value.length < 12) { out.appendChild(msg("error", "Admin passwords need at least 12 characters.")); return; }
      if (next.value !== again.value) { out.appendChild(msg("error", "The two new passwords don't match.")); return; }
      busy(btn, true, "Changing…");
      try {
        const r = await api("/api/admin/password", { method: "POST", body: { current: cur.value, password: next.value, code: code.value } });
        save({ token: r.token, expiresAt: r.expiresAt, email: r.email });
        cur.value = next.value = again.value = code.value = "";
        out.appendChild(msg("ok", "Password changed. You were signed out of the app and every other admin session."));
      } catch (err) { if (err.message !== "signed-out") out.appendChild(msg("error", err.message)); code.value = ""; }
      finally { busy(btn, false); }
    });

    // recovery codes
    const rc = h("input", { type: "text", class: "code-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 7 });
    const rOut = h("div");
    const rBtn = h("button", { class: "btn", type: "button", text: "Make new recovery codes" });
    rBtn.addEventListener("click", async function () {
      clear(rOut);
      if (!confirm("Make new recovery codes? Your old ones stop working.")) return;
      busy(rBtn, true);
      try {
        const r = await api("/api/admin/recovery-codes", { method: "POST", body: { code: rc.value } });
        showRecovery(r.recoveryCodes, function () { tab = "security"; renderShell(); });
      } catch (err) { if (err.message !== "signed-out") rOut.appendChild(msg("error", err.message)); }
      finally { busy(rBtn, false); rc.value = ""; }
    });

    page.appendChild(h("div", { class: "grid2" }, [
      h("section", { class: "panel" }, [h("div", { class: "panel-head" }, h("h2", { text: "Change your password" })),
        h("p", { class: "muted small", text: "Needs your current password and a fresh code. Changing it signs this account out of the app and every admin session." }), form]),
      h("section", { class: "panel" }, [h("div", { class: "panel-head" }, h("h2", { text: "Recovery codes" })),
        h("p", { class: "muted small", text: "Use one if you lose your phone. Make a new set if you've used some or think they were seen." }),
        h("label", { class: "field" }, [h("span", { text: "6-digit code" }), rc]), h("div", { class: "row-actions" }, rBtn), rOut,
        h("div", { class: "panel-head", style: null }, null),
        h("h2", { text: "Sign out everywhere" }),
        h("p", { class: "muted small", text: "Ends every admin session for your account, on every device." }),
        h("button", { class: "btn", type: "button", text: "Sign out everywhere", onclick: function () { logout("Signed out on every device."); } })
      ])
    ]));
  }

  async function renderAudit(page) {
    const box = h("section", { class: "panel" }, [h("div", { class: "panel-head" }, h("h2", { text: "Activity log" })), h("p", { class: "muted", text: "Loading…" })]);
    page.appendChild(box);
    try {
      const r = await api("/api/admin/audit");
      box.removeChild(box.lastChild);
      box.appendChild(h("p", { class: "muted small", text: "Every admin sign-in, failed attempt and change, newest first (last 500)." }));
      box.appendChild(auditList(r.audit));
    } catch (err) { if (err.message !== "signed-out") box.appendChild(msg("error", err.message)); }
  }

  // ------------------------------------------------------------------ boot
  if (session) start(); else renderLogin();
})();
