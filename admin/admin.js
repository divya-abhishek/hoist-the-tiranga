/* ==========================================================================
   admin.js — moderation panel logic.
   Auth is server-side: the password is verified by the admin-login Edge
   Function and is never present in this file. We only keep a short-lived
   session token (in sessionStorage, cleared when the tab closes).
   ========================================================================== */
(function () {
  "use strict";
  var T = window.T, B = T.backend;
  var $ = function (s) { return document.querySelector(s); };
  var TOKKEY = "tir_admin_token";
  var state = { token: null, filter: "active", q: "" };
  var confirmCb = null;

  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  /* ---- Login ---------------------------------------------------------- */
  function showLogin() {
    $("#dash").hidden = true; $("#login").hidden = false;
    $("#login-note").textContent = B.configured
      ? "Enter the admin password to moderate the shared live map."
      : "Supabase is not configured in config.js. Admin access is unavailable.";
    $("#login-btn").disabled = !B.configured;
    if (B.configured) $("#pw").focus();
  }
  function doLogin() {
    var pw = $("#pw").value;
    $("#login-err").textContent = "";
    if (!B.configured) return;
    var loginButton = $("#login-btn");
    loginButton.disabled = true;
    loginButton.textContent = "Logging in…";
    B.admin.login(pw).then(function (r) {
      loginButton.disabled = false;
      loginButton.textContent = "Log in";
      if (!r.ok) { $("#login-err").textContent = r.error || "Login failed."; return; }
      state.token = r.token;
      try { sessionStorage.setItem(TOKKEY, r.token); } catch (e) {}
      openDash();
    }).catch(function (error) {
      console.error("Admin login request failed", error);
      loginButton.disabled = false; loginButton.textContent = "Log in";
      $("#login-err").textContent = "Login unavailable. Try again.";
    });
  }

  function openDash() {
    $("#login").hidden = true; $("#dash").hidden = false;
    loadData();
  }
  function logout() {
    state.token = null;
    try { sessionStorage.removeItem(TOKKEY); } catch (e) {}
    $("#pw").value = "";
    showLogin();
  }

  /* ---- Data ----------------------------------------------------------- */
  function loadData() {
    $("#dash").setAttribute("aria-busy", "true");
    B.admin.data(state.token, { q: state.q, filter: state.filter }).then(function (r) {
      $("#dash").setAttribute("aria-busy", "false");
      if (!r.ok) {
        if (r.code === "unauth") { toast("Session expired"); logout(); return; }
        toast(r.error || "Could not load"); return;
      }
      $("#s-active").textContent = r.stats.active;
      $("#s-removed").textContent = r.stats.removed;
      $("#s-today").textContent = r.stats.today;
      render(r.flags);
    }).catch(function (error) {
      console.error("Admin data request failed", error);
      $("#dash").setAttribute("aria-busy", "false");
      toast("Could not load data");
    });
  }

  function render(flags) {
    var list = $("#list"); list.textContent = "";
    $("#empty").hidden = flags.length > 0;
    flags.forEach(function (f) {
      var row = document.createElement("div"); row.className = "row";

      var flag = document.createElement("div"); flag.className = "flag";
      flag.appendChild(T.flagSVG(30, { wave: false })); row.appendChild(flag);

      var who = document.createElement("div"); who.className = "who";
      var name = document.createElement("div"); name.className = "name";
      var nt = document.createElement("span"); nt.textContent = f.first_name; name.appendChild(nt);
      var gi = T.genderIcon(f.gender, 14); if (gi) { gi.classList.add("g"); name.appendChild(gi); }
      who.appendChild(name);
      var meta = document.createElement("div"); meta.className = "meta";
      meta.textContent = fmtTime(f.created_at) + " · " + Math.round(f.x) + ", " + Math.round(f.y)
        + (f.gender && f.gender !== "unspecified" ? " · " + f.gender : "");
      who.appendChild(meta);
      row.appendChild(who);

      var status = document.createElement("span");
      status.className = "status " + (f.is_removed ? "removed" : "active");
      status.textContent = f.is_removed ? "Removed" : "Active";
      row.appendChild(status);

      var act = document.createElement("div"); act.className = "act";
      var btn = document.createElement("button");
      if (f.is_removed) {
        btn.className = "btn small"; btn.textContent = "Restore";
        btn.addEventListener("click", function () { moderate(f.id, "restore", f.first_name); });
      } else {
        btn.className = "btn small danger"; btn.textContent = "Remove";
        btn.addEventListener("click", function () {
          askConfirm("Remove " + f.first_name + "’s Tiranga from the public map?", "Remove", function () {
            moderate(f.id, "remove", f.first_name);
          });
        });
      }
      act.appendChild(btn); row.appendChild(act);
      list.appendChild(row);
    });
  }

  function moderate(id, action, name) {
    B.admin.moderate(state.token, { id: id, action: action }).then(function (r) {
      if (!r.ok) { if (r.code === "unauth") { logout(); return; } toast(r.error || "Failed"); return; }
      toast(action === "remove" ? name + "’s Tiranga removed" : name + "’s Tiranga restored");
      loadData();
    }).catch(function (error) { console.error("Moderation request failed", error); toast("Action failed"); });
  }

  /* ---- Confirm modal -------------------------------------------------- */
  function askConfirm(msg, yesLabel, cb) {
    $("#confirm-msg").textContent = msg;
    $("#confirm-yes").textContent = yesLabel || "Confirm";
    confirmCb = cb; $("#confirm").hidden = false;
  }
  function closeConfirm() { $("#confirm").hidden = true; confirmCb = null; }

  /* ---- Wire up -------------------------------------------------------- */
  function boot() {
    $("#login-btn").addEventListener("click", doLogin);
    $("#pw").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
    $("#logout").addEventListener("click", logout);
    var searchT;
    $("#search").addEventListener("input", function (e) {
      state.q = e.target.value; clearTimeout(searchT); searchT = setTimeout(loadData, 250);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
      tab.addEventListener("click", function () {
        Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
          t.classList.toggle("active", t === tab); t.setAttribute("aria-selected", t === tab ? "true" : "false");
        });
        state.filter = tab.getAttribute("data-f"); loadData();
      });
    });
    $("#confirm-yes").addEventListener("click", function () { var c = confirmCb; closeConfirm(); if (c) c(); });
    $("#confirm-no").addEventListener("click", closeConfirm);
    $("#confirm").addEventListener("click", function (e) { if (e.target === $("#confirm")) closeConfirm(); });

    // resume session if a token is present
    var tok = null; try { tok = sessionStorage.getItem(TOKKEY); } catch (e) {}
    if (tok && B.configured) { state.token = tok; openDash(); } else { showLogin(); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
