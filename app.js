/* ========================================================================== 
   Public application orchestration. Supabase is the only shared source of
   truth; success is shown only after a confirmed server row is returned/read.
   ========================================================================== */
(function () {
  "use strict";

  var T = window.T;
  var B = T.backend;
  var CFG = window.TIRANGA_CONFIG || {};
  var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var $ = function (selector) { return document.querySelector(selector); };

  var STATES = Object.freeze({
    IDLE: "IDLE",
    FORM_OPEN: "FORM_OPEN",
    PLACING: "PLACING",
    SUBMITTING: "SUBMITTING",
    ANIMATING: "ANIMATING",
    SUCCESS: "SUCCESS",
    LIMIT: "LIMIT"
  });

  var state = STATES.IDLE;
  var map;
  var sheet;
  var nameInput;
  var nameErr;
  var toPlaceBtn;
  var hoistBtn;
  var placeHint;
  var counterEl;
  var genderValue = "unspecified";
  var draft = null;
  var counterValue = 0;
  var counterRaf = null;
  var maxId = 0;
  var initialLoaded = false;
  var currentShareNumber = null;
  var browserIdMemory = null;
  var bannerTimer = null;
  var bannerRetry = null;
  var toastTimer = null;
  var pollTimer = null;
  var pollBusy = false;
  var pollCycle = 0;
  var pollFailures = 0;
  var animationSerial = 0;

  function fmt(number) {
    try { return Math.max(0, Number(number) || 0).toLocaleString("en-IN"); }
    catch (error) { return String(Math.max(0, Number(number) || 0)); }
  }

  function siteUrl() {
    var configured = String(CFG.SITE_URL || "");
    if (!configured || /YOUR-USERNAME|example\.com/i.test(configured)) return location.href.split("#")[0];
    return configured;
  }

  function randomUuid() {
    var cryptoApi = window.crypto || window.msCrypto;
    if (cryptoApi && cryptoApi.randomUUID) return cryptoApi.randomUUID();
    var bytes = new Uint8Array(16);
    if (cryptoApi && cryptoApi.getRandomValues) cryptoApi.getRandomValues(bytes);
    else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.prototype.map.call(bytes, function (byte) {
      return ("0" + byte.toString(16)).slice(-2);
    }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
      hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function getBrowserId() {
    if (browserIdMemory) return browserIdMemory;
    var key = "tir_browser_id_v1";
    try { browserIdMemory = localStorage.getItem(key); } catch (error) {}
    if (!browserIdMemory || browserIdMemory.length < 8 || browserIdMemory.length > 200) {
      browserIdMemory = randomUuid();
      try { localStorage.setItem(key, browserIdMemory); } catch (error) {
        console.warn("Browser identifier could not be persisted; the server limit still applies for this tab.");
      }
    }
    return browserIdMemory;
  }

  function relativeTime(iso) {
    var seconds = Math.max(0, (Date.now() - Number(new Date(iso))) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " hr ago";
    return Math.floor(seconds / 86400) + " d ago";
  }

  function setCounter(next, animate) {
    next = Math.max(0, Number(next) || 0);
    if (counterRaf) cancelAnimationFrame(counterRaf);
    if (!animate || reduceMotion) {
      counterValue = next;
      counterEl.textContent = fmt(next);
      return;
    }
    var from = counterValue;
    var started = performance.now();
    var duration = 620;
    counterEl.classList.remove("tick");
    void counterEl.offsetWidth;
    counterEl.classList.add("tick");
    function frame(now) {
      var progress = Math.min((now - started) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      counterEl.textContent = fmt(Math.round(from + (next - from) * eased));
      if (progress < 1) counterRaf = requestAnimationFrame(frame);
      else {
        counterRaf = null;
        counterValue = next;
        counterEl.textContent = fmt(next);
      }
    }
    counterRaf = requestAnimationFrame(frame);
  }

  function showBanner(message, retry) {
    $("#banner-msg").textContent = message;
    bannerRetry = typeof retry === "function" ? retry : null;
    $("#retry-banner").hidden = !bannerRetry;
    $("#banner").classList.add("show");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, 6500);
  }

  function hideBanner() {
    $("#banner").classList.remove("show");
    bannerRetry = null;
  }

  function showToast(message) {
    var toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 3200);
  }

  function setMapStatus(kind, message) {
    var status = $("#map-status");
    var retry = $("#map-retry");
    status.classList.toggle("show", kind !== "hidden");
    status.setAttribute("data-state", kind);
    $("#map-status-text").textContent = message || "";
    retry.hidden = kind !== "error";
  }

  function refreshEmptyState() {
    var empty = $("#empty-state");
    var show = initialLoaded && counterValue === 0;
    empty.classList.toggle("show", show);
    empty.setAttribute("aria-hidden", show ? "false" : "true");
  }

  function hidePopover() {
    var popover = $("#popover");
    if (popover) popover.classList.remove("show");
  }

  function showFlagPopover(flag, screenPoint) {
    var popover = $("#popover");
    popover.textContent = "";
    var top = document.createElement("div");
    top.className = "pop-top";
    var icon = document.createElement("span");
    icon.className = "pop-flag";
    icon.appendChild(T.flagSVG(26));
    top.appendChild(icon);
    var name = document.createElement("span");
    name.className = "pop-name";
    name.textContent = flag.first_name;
    top.appendChild(name);
    var gender = T.genderIcon(flag.gender, 15);
    if (gender) {
      gender.classList.add("pop-gender");
      top.appendChild(gender);
    }
    popover.appendChild(top);
    var meta = document.createElement("div");
    meta.className = "pop-meta";
    var region = map.stateAt(flag.x, flag.y);
    meta.textContent = "Hoisted " + relativeTime(flag.created_at) + (region ? " · " + region : "");
    popover.appendChild(meta);
    popover.classList.add("show");
    var mapRect = $("#map").getBoundingClientRect();
    var left = Math.min(Math.max(screenPoint.x - popover.offsetWidth / 2, 8), mapRect.width - popover.offsetWidth - 8);
    var topPosition = screenPoint.y - popover.offsetHeight - 44;
    if (topPosition < 8) topPosition = screenPoint.y + 20;
    popover.style.left = left + "px";
    popover.style.top = topPosition + "px";
  }

  function setState(next) {
    state = next;
    var open = next !== STATES.IDLE;
    var placing = next === STATES.PLACING || next === STATES.SUBMITTING;
    sheet.classList.toggle("open", open);
    sheet.classList.toggle("minimized", next === STATES.ANIMATING);
    sheet.classList.toggle("submitting", next === STATES.SUBMITTING);
    sheet.setAttribute("aria-hidden", open ? "false" : "true");
    sheet.setAttribute("aria-modal", placing || next === STATES.ANIMATING ? "false" : "true");
    document.body.classList.toggle("sheet-open", open);
    document.body.classList.toggle("placing", placing);
    document.body.classList.toggle("animating", next === STATES.ANIMATING);
    $("#sheet-close").disabled = next === STATES.SUBMITTING || next === STATES.ANIMATING;

    ["form", "placing", "success", "limit"].forEach(function (view) {
      var active = (view === "form" && next === STATES.FORM_OPEN) ||
        (view === "placing" && (next === STATES.PLACING || next === STATES.SUBMITTING || next === STATES.ANIMATING)) ||
        (view === "success" && next === STATES.SUCCESS) ||
        (view === "limit" && next === STATES.LIMIT);
      sheet.classList.toggle("view-" + view, active);
    });

    if (!map) return;
    if (next === STATES.PLACING) map.enterPlacementMode();
    else if (next === STATES.SUBMITTING || next === STATES.ANIMATING) map.pausePlacementMode();
    else map.exitPlacementMode();
  }

  function selectGender(value) {
    genderValue = T.validateGender(value);
    Array.prototype.forEach.call(document.querySelectorAll(".gender-opt"), function (button) {
      var selected = button.getAttribute("data-g") === genderValue;
      button.classList.toggle("sel", selected);
      button.setAttribute("aria-checked", selected ? "true" : "false");
    });
  }

  function resetDraft() {
    draft = null;
    nameInput.value = "";
    nameErr.textContent = "";
    placeHint.textContent = "Tap anywhere on India.";
    hoistBtn.disabled = true;
    hoistBtn.classList.remove("loading");
    selectGender("unspecified");
    validateNameLive();
  }

  function openSheet() {
    if (state !== STATES.IDLE) return;
    resetDraft();
    setState(STATES.FORM_OPEN);
    setTimeout(function () { if (state === STATES.FORM_OPEN) nameInput.focus(); }, 320);
  }

  function closeSheet() {
    if (state === STATES.SUBMITTING || state === STATES.ANIMATING) return;
    animationSerial += 1;
    clearCelebration();
    setState(STATES.IDLE);
    $("#cta").focus();
  }

  function validateNameLive() {
    var result = T.validateName(nameInput.value);
    toPlaceBtn.disabled = !result.ok;
    nameErr.textContent = result.ok || nameInput.value.trim().length < 2 ? "" : result.reason;
    return result;
  }

  function goToPlacement() {
    var validation = validateNameLive();
    if (!validation.ok) {
      nameErr.textContent = validation.reason;
      return;
    }
    nameInput.blur();
    draft = {
      first_name: validation.value,
      gender: genderValue,
      submission_id: randomUuid()
    };
    placeHint.textContent = "Tap anywhere on India. Tap again to move your Tiranga.";
    hoistBtn.disabled = true;
    setState(STATES.PLACING);
    requestAnimationFrame(function () { map.resize(); });
  }

  function onPlaced(result) {
    if (state !== STATES.PLACING) return;
    if (!result.valid) {
      placeHint.textContent = "That's outside India — tap inside the map.";
      return;
    }
    map.setPreviewMeta(draft.first_name, draft.gender);
    placeHint.textContent = "Your spot is ready. Tap elsewhere to move it.";
    hoistBtn.disabled = false;
    if (navigator.vibrate && !reduceMotion) {
      try { navigator.vibrate(8); } catch (error) {}
    }
  }

  function normalizeConfirmedFlag(row) {
    if (!row) return null;
    var flag = {
      id: Number(row.id),
      first_name: String(row.first_name || ""),
      gender: T.validateGender(row.gender),
      x: Number(row.x != null ? row.x : row.x_position),
      y: Number(row.y != null ? row.y : row.y_position),
      created_at: row.created_at
    };
    if (!Number.isSafeInteger(flag.id) || flag.id <= 0 || !flag.first_name ||
        !Number.isFinite(flag.x) || !Number.isFinite(flag.y) || !flag.created_at) return null;
    return flag;
  }

  function handleHoistFailure(result) {
    hoistBtn.classList.remove("loading");
    if (result.code === "limit") {
      setState(STATES.LIMIT);
      return;
    }
    if (result.code === "bad_name") {
      setState(STATES.FORM_OPEN);
      nameErr.textContent = result.error || "Please check your first name.";
      return;
    }
    setState(STATES.PLACING);
    hoistBtn.disabled = false;
    if (result.code === "bad_place" || result.code === "cooldown") {
      placeHint.textContent = result.error;
      return;
    }
    if (result.code === "config") {
      showBanner("The shared Tiranga database is not configured yet.");
      return;
    }
    if (navigator.onLine === false) {
      showBanner("A network connection is required to save your Tiranga.");
      return;
    }
    showBanner("India is busy celebrating right now. Please try again.");
  }

  function doHoist() {
    if (state !== STATES.PLACING) return;
    var placement = map.getPlacement();
    if (!placement) {
      placeHint.textContent = "Tap on India to choose your spot first.";
      return;
    }
    if (navigator.onLine === false) {
      showBanner("A network connection is required to save your Tiranga.");
      return;
    }
    hoistBtn.disabled = true;
    hoistBtn.classList.add("loading");
    setState(STATES.SUBMITTING);
    var payload = {
      first_name: draft.first_name,
      gender: draft.gender,
      x: Number(placement.x.toFixed(2)),
      y: Number(placement.y.toFixed(2)),
      browserId: getBrowserId(),
      submissionId: draft.submission_id
    };

    B.hoist(payload).then(function (result) {
      if (!result.ok) {
        handleHoistFailure(result);
        return null;
      }
      var confirmed = normalizeConfirmedFlag(result.flag);
      if (confirmed) return { flag: confirmed, count: Number(result.count) };
      if (!result.id) throw new Error("Hoist response did not include a confirmed flag.");
      return B.getFlag(result.id).then(function (flag) {
        var normalized = normalizeConfirmedFlag(flag);
        if (!normalized) throw new Error("The inserted flag could not be confirmed from Supabase.");
        return { flag: normalized, count: Number(result.count) };
      });
    }).then(function (confirmed) {
      if (!confirmed) return;
      hoistBtn.classList.remove("loading");
      if (confirmed.flag.id > maxId) maxId = confirmed.flag.id;
      return runHoistMoment(confirmed.flag, Number.isFinite(confirmed.count) ? confirmed.count : map.count() + 1);
    }).catch(function (error) {
      console.error("Hoist confirmation failed", error);
      handleHoistFailure({ code: "network", error: error.message });
    });
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function clearCelebration() {
    if (!map || !map.overlay) return;
    Array.prototype.forEach.call(map.overlay.querySelectorAll(".is-hoisting,.tir-burst,.tir-particle"), function (node) {
      node.remove();
    });
  }

  function playPoleAnimation(flag, token) {
    return new Promise(function (resolve) {
      if (token !== animationSerial) return resolve();
      clearCelebration();
      var burst = document.createElement("img");
      burst.className = "tir-burst";
      burst.alt = "";
      burst.setAttribute("aria-hidden", "true");
      burst.src = "assets/success-burst.png";
      burst._wx = flag.x;
      burst._wy = flag.y;
      burst.onerror = function () { burst.remove(); };
      map.overlay.appendChild(burst);

      var marker = T.makeMarkerEl({
        width: 40,
        className: "is-hoisting",
        name: flag.first_name,
        gender: flag.gender,
        wave: true
      });
      marker._wx = flag.x;
      marker._wy = flag.y;
      map.overlay.appendChild(marker);

      var particleVectors = [[-22,-50],[-11,-64],[8,-58],[22,-45],[-30,-34],[31,-30]];
      particleVectors.forEach(function (vector, index) {
        var particle = document.createElement("span");
        particle.className = "tir-particle p" + index;
        particle.style.setProperty("--px", vector[0] + "px");
        particle.style.setProperty("--py", vector[1] + "px");
        particle._wx = flag.x;
        particle._wy = flag.y;
        map.overlay.appendChild(particle);
      });
      map._applyTransform();
      void marker.offsetWidth;
      marker.classList.add("go");
      burst.classList.add("go");
      Array.prototype.forEach.call(map.overlay.querySelectorAll(".tir-particle"), function (particle) {
        particle.classList.add("go");
      });
      setTimeout(function () {
        clearCelebration();
        resolve();
      }, 1120);
    });
  }

  function runHoistMoment(flag, count) {
    var token = ++animationSerial;
    setState(STATES.ANIMATING);
    map.lockPreview();
    var settle = reduceMotion ? wait(20) : wait(120);
    return settle.then(function () {
      if (token !== animationSerial) return;
      map.clearPreview();
      return map.focusOn(flag.x, flag.y, Math.max(map.scale0 * 2.15, map.scale), reduceMotion ? 0 : 280);
    }).then(function () {
      if (token !== animationSerial || reduceMotion) return;
      return playPoleAnimation(flag, token);
    }).then(function () {
      if (token !== animationSerial) return;
      map.addFlags([flag], true);
      map.selectedId = flag.id;
      setCounter(count, true);
      refreshEmptyState();
      showSuccess(flag);
    });
  }

  function showSuccess(flag) {
    currentShareNumber = flag.id;
    var successFlag = $("#success-flag");
    successFlag.textContent = "";
    successFlag.appendChild(T.flagSVG(96, { wave: true }));
    $("#success-num").textContent = "You are Tiranga #" + fmt(flag.id);
    var nameLine = $("#success-name");
    nameLine.textContent = "";
    var strong = document.createElement("strong");
    strong.textContent = flag.first_name;
    nameLine.appendChild(strong);
    nameLine.appendChild(document.createTextNode(", your Tiranga now flies over India."));
    setState(STATES.SUCCESS);
  }

  function legacyCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand("copy"); } catch (error) {}
    textarea.remove();
  }

  function shareText(number) {
    return number
      ? "I just hoisted Tiranga #" + fmt(number) + " for Independence Day 🇮🇳\nAdd yours too!"
      : "Hoist your Tiranga for Independence Day 🇮🇳\nAdd yours too!";
  }

  function share(number) {
    var text = shareText(number);
    var url = siteUrl();
    if (navigator.share) {
      navigator.share({ title: "Hoist the Tiranga", text: text, url: url }).catch(function (error) {
        if (error && error.name !== "AbortError") console.error("Share failed", error);
      });
      return;
    }
    var payload = text + "\n" + url;
    var done = function () { showToast("Link copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload).then(done, function () { legacyCopy(payload); done(); });
    } else {
      legacyCopy(payload);
      done();
    }
  }

  function syncSnapshot(animateCounter) {
    return Promise.all([B.getFlags({}), B.getCount()]).then(function (values) {
      var flags = values[0];
      var count = values[1];
      maxId = 0;
      flags.forEach(function (flag) { if (flag.id > maxId) maxId = flag.id; });
      map.setFlags(flags);
      setCounter(count, !!animateCounter);
      return count;
    });
  }

  function loadInitial() {
    clearTimeout(pollTimer);
    setMapStatus("loading", "Loading the Tirangas…");
    initialLoaded = false;
    refreshEmptyState();
    Promise.resolve().then(function () {
      return syncSnapshot(false);
    }).then(function () {
      initialLoaded = true;
      setMapStatus("hidden", "");
      refreshEmptyState();
      pollFailures = 0;
      schedulePoll(10000);
    }).catch(function (error) {
      console.error("Initial Supabase load failed", error);
      setCounter(0, false);
      map.setFlags([]);
      setMapStatus("error", "Couldn’t load the Tirangas. Tap to try again.");
    });
  }

  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  function poll() {
    if (pollBusy || document.hidden || !initialLoaded) {
      schedulePoll(10000);
      return;
    }
    pollBusy = true;
    pollCycle += 1;
    Promise.all([B.getFlags({ sinceId: maxId }), B.getCount()]).then(function (values) {
      var fresh = values[0];
      var serverCount = values[1];
      fresh.forEach(function (flag) { if (flag.id > maxId) maxId = flag.id; });
      if (fresh.length) map.addFlags(fresh, true);
      var needsFullSync = serverCount !== map.count() || pollCycle % 6 === 0;
      if (needsFullSync) return syncSnapshot(serverCount !== counterValue);
      setCounter(serverCount, fresh.length > 0);
      return serverCount;
    }).then(function () {
      pollFailures = 0;
      refreshEmptyState();
    }).catch(function (error) {
      pollFailures += 1;
      console.error("Supabase polling failed", error);
      if (pollFailures === 2) showToast("Live updates are temporarily unavailable.");
    }).finally(function () {
      pollBusy = false;
      schedulePoll(10000);
    });
  }

  function boot() {
    T.mountFlagIcons(document);
    counterEl = $("#counter-num");
    sheet = $("#sheet");
    nameInput = $("#name-input");
    nameErr = $("#name-err");
    toPlaceBtn = $("#to-place");
    hoistBtn = $("#hoist-btn");
    placeHint = $("#place-hint");

    map = new T.MapEngine({
      container: $("#map"),
      reduceMotion: reduceMotion,
      onTapFlag: function (flag, point) { hidePopover(); showFlagPopover(flag, point); },
      onPlaced: onPlaced,
      onTapOutside: hidePopover
    });
    document.body.classList.toggle("reduce-motion", reduceMotion);
    window.__TIRANGA__ = {
      map: map,
      backend: B,
      states: STATES,
      state: function () { return state; }
    };

    $("#cta").addEventListener("click", openSheet);
    $("#sheet-close").addEventListener("click", closeSheet);
    $("#scrim").addEventListener("click", function () {
      if (state === STATES.FORM_OPEN || state === STATES.SUCCESS || state === STATES.LIMIT) closeSheet();
    });
    nameInput.addEventListener("input", validateNameLive);
    nameInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !toPlaceBtn.disabled) goToPlacement();
    });
    Array.prototype.forEach.call(document.querySelectorAll(".gender-opt"), function (button) {
      button.addEventListener("click", function () { selectGender(button.getAttribute("data-g")); });
    });
    toPlaceBtn.addEventListener("click", goToPlacement);
    hoistBtn.addEventListener("click", doHoist);
    $("#share-btn").addEventListener("click", function () { share(currentShareNumber); });
    $("#back-btn").addEventListener("click", closeSheet);
    $("#limit-close").addEventListener("click", closeSheet);
    $("#limit-share").addEventListener("click", function () { share(null); });
    $("#map-retry").addEventListener("click", loadInitial);
    $("#retry-banner").addEventListener("click", function () {
      var retry = bannerRetry;
      hideBanner();
      if (retry) retry();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && state !== STATES.IDLE && state !== STATES.PLACING) closeSheet();
    });
    $("#map").addEventListener("pointerdown", hidePopover);
    window.addEventListener("scroll", hidePopover, true);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && initialLoaded) schedulePoll(100);
    });
    window.addEventListener("online", function () {
      if (!initialLoaded) loadInitial();
      else schedulePoll(100);
    });

    resetDraft();
    setState(STATES.IDLE);
    loadInitial();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
