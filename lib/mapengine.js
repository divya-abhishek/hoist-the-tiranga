/* ==========================================================================
   lib/mapengine.js
   The interactive India map + the flag rendering engine.
     • Inline India SVG (dark, glowing) built from the licensed dataset.
     • Custom pan / zoom / pinch (no map library, no tiles, no GPS).
     • A <canvas> layer that draws thousands of tiny Tirangas efficiently
       with level-of-detail + selective name labels.
     • Point-in-India hit testing so flags can only be placed on the map.
   Coordinates are stored in the SVG viewBox space (0..612 x, 0..696 y), so a
   saved position renders at the same visual spot on every screen size.
   ========================================================================== */
(function () {
  "use strict";
  var T = (window.T = window.T || {});
  var NS = "http://www.w3.org/2000/svg";
  var VBW = 612, VBH = 696;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  T.MapEngine = function (opts) {
    var self = this;
    this.container = opts.container;
    this.onTapFlag = opts.onTapFlag || function () {};
    this.onPlaced = opts.onPlaced || function () {};
    this.onTapOutside = opts.onTapOutside || function () {};
    this.reduceMotion = opts.reduceMotion || false;

    this.flags = [];              // {id, first_name, gender, x, y, created_at}
    this.byId = {};
    this.recent = [];             // ids, most-recent first (for labels/ambience)
    this.selectedId = null;
    this.highlightUntil = {};     // id -> timestamp for glow
    this.placement = null;        // {x,y} world coords when in placement mode
    this.placing = false;
    this.interactionLocked = false;

    this.scale = 1; this.tx = 0; this.ty = 0; this.scale0 = 1;
    this._dirty = true; this._raf = null; this._anim = false;
    this._pointers = {};
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    /* ---- Build DOM --------------------------------------------------- */
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "tir-map-svg");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.innerHTML =
      '<defs>' +
        '<linearGradient id="tirLand" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#141c34"/>' +
          '<stop offset="100%" stop-color="#0e1528"/>' +
        '</linearGradient>' +
        '<radialGradient id="tirLandGlow" cx="50%" cy="42%" r="62%">' +
          '<stop offset="0%" stop-color="#17203c"/>' +
          '<stop offset="100%" stop-color="#0d1426"/>' +
        '</radialGradient>' +
      '</defs>';
    var vp = document.createElementNS(NS, "g");
    vp.setAttribute("id", "tir-viewport");
    var states = document.createElementNS(NS, "g");
    states.setAttribute("class", "tir-states");
    var M = window.INDIA_MAP;
    this.statePaths = [];
    this.hitPaths = [];
    this.hitContext = document.createElement("canvas").getContext("2d");
    for (var i = 0; i < M.locations.length; i++) {
      var p = document.createElementNS(NS, "path");
      p.setAttribute("d", M.locations[i].path);
      p.setAttribute("data-name", M.locations[i].name);
      p.setAttribute("vector-effect", "non-scaling-stroke");
      states.appendChild(p);
      this.statePaths.push(p);
      try {
        this.hitPaths.push({ path: new Path2D(M.locations[i].path), name: M.locations[i].name });
      } catch (error) {
        this.hitPaths.push(null);
      }
    }
    vp.appendChild(states);
    svg.appendChild(vp);

    var canvas = document.createElement("canvas");
    canvas.className = "tir-flag-canvas";
    var overlay = document.createElement("div");
    overlay.className = "tir-overlay";

    this.container.appendChild(svg);
    this.container.appendChild(canvas);
    this.container.appendChild(overlay);
    this.svg = svg; this.vp = vp; this.statesG = states;
    this.canvas = canvas; this.ctx = canvas.getContext("2d");
    this.overlay = overlay;

    /* ---- Interaction -------------------------------------------------- */
    this._bindEvents();
    this.resize();
    var resizeTimer = null;
    function scheduleResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { self.resize(); }, 80);
    }
    window.addEventListener("resize", scheduleResize, { passive: true });
    window.addEventListener("orientationchange", scheduleResize, { passive: true });
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(scheduleResize);
      this._resizeObserver.observe(this.container);
    }
    this._loop();
  };

  var MP = T.MapEngine.prototype;

  /* ---- Coordinate transforms ---------------------------------------- */
  MP.worldToScreen = function (x, y) {
    return { x: x * this.scale + this.tx, y: y * this.scale + this.ty };
  };
  MP.screenToWorld = function (sx, sy) {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  };

  /* ---- Sizing ------------------------------------------------------- */
  MP.resize = function () {
    var oldW = this.CW || 0, oldH = this.CH || 0;
    var oldScale0 = this.scale0 || 1;
    var centerWorld = oldW && oldH ? this.screenToWorld(oldW / 2, oldH / 2) : null;
    var zoomRatio = oldScale0 ? this.scale / oldScale0 : 1;
    var r = this.container.getBoundingClientRect();
    this.CW = Math.max(1, r.width); this.CH = Math.max(1, r.height);
    this.svg.setAttribute("viewBox", "0 0 " + this.CW + " " + this.CH);
    this.canvas.width = Math.round(this.CW * this.dpr);
    this.canvas.height = Math.round(this.CH * this.dpr);
    this.canvas.style.width = this.CW + "px";
    this.canvas.style.height = this.CH + "px";
    var fit = Math.min(this.CW / VBW, this.CH / VBH) * 0.98;
    if (!this._userMoved || !centerWorld) {
      this.scale0 = fit; this.scale = fit;
      this.tx = (this.CW - VBW * fit) / 2;
      this.ty = (this.CH - VBH * fit) / 2;
    } else {
      this.scale0 = fit;
      this.scale = fit * zoomRatio;
      this.tx = this.CW / 2 - centerWorld.x * this.scale;
      this.ty = this.CH / 2 - centerWorld.y * this.scale;
      this._clampView();
    }
    this._applyTransform();
    this._dirty = true;
  };

  MP._applyTransform = function () {
    var s = this.scale;
    this.vp.setAttribute("transform",
      "matrix(" + s + ",0,0," + s + "," + this.tx + "," + this.ty + ")");
    // reposition overlay children (preview / hoist marker)
    var kids = this.overlay.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el._wx == null) continue;
      var p = this.worldToScreen(el._wx, el._wy);
      el.style.left = p.x + "px";
      el.style.top = p.y + "px";
    }
  };

  MP._clampView = function () {
    this.scale = clamp(this.scale, this.scale0 * 0.75, this.scale0 * 9);
    // keep the map roughly in view
    var w = VBW * this.scale, h = VBH * this.scale;
    var margin = Math.min(this.CW, this.CH) * 0.4;
    this.tx = clamp(this.tx, this.CW - w - margin, margin);
    this.ty = clamp(this.ty, this.CH - h - margin, margin);
  };

  /* ---- Zoom helpers -------------------------------------------------- */
  MP.zoomAt = function (sx, sy, factor) {
    var before = this.screenToWorld(sx, sy);
    this.scale *= factor;
    this._clampView();
    var after = this.worldToScreen(before.x, before.y);
    this.tx += sx - after.x; this.ty += sy - after.y;
    this._userMoved = true;
    this._clampView(); this._applyTransform(); this._dirty = true;
  };

  /* ---- Event binding ------------------------------------------------- */
  MP._bindEvents = function () {
    var self = this, el = this.container;
    el.style.touchAction = "none";

    el.addEventListener("wheel", function (e) {
      if (self.interactionLocked) return;
      e.preventDefault();
      var r = el.getBoundingClientRect();
      var f = Math.pow(1.0015, -e.deltaY);
      self.zoomAt(e.clientX - r.left, e.clientY - r.top, f);
    }, { passive: false });

    function pos(e) {
      var r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    el.addEventListener("pointerdown", function (e) {
      if (self.interactionLocked) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      var p = pos(e);
      self._pointers[e.pointerId] = { x: p.x, y: p.y, sx: p.x, sy: p.y, t: Date.now(), moved: 0 };
      self._panning(true);
    });

    el.addEventListener("pointermove", function (e) {
      var pt = self._pointers[e.pointerId];
      if (!pt) return;
      var p = pos(e);
      var ids = Object.keys(self._pointers);
      if (ids.length >= 2) {
        // pinch
        var a = self._pointers[ids[0]], b = self._pointers[ids[1]];
        var prevDist = Math.hypot(a.x - b.x, a.y - b.y);
        pt.x = p.x; pt.y = p.y;
        var na = self._pointers[ids[0]], nb = self._pointers[ids[1]];
        var newDist = Math.hypot(na.x - nb.x, na.y - nb.y);
        var mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
        // Neither finger may become a placement tap when a pinch finishes.
        // In particular, the last finger to lift would otherwise look like a
        // stationary single-pointer tap on iOS/Android.
        na.moved = Math.max(na.moved, 10);
        nb.moved = Math.max(nb.moved, 10);
        if (prevDist > 0) self.zoomAt(mx, my, newDist / prevDist);
      } else {
        var dx = p.x - pt.x, dy = p.y - pt.y;
        pt.moved += Math.abs(dx) + Math.abs(dy);
        pt.x = p.x; pt.y = p.y;
        if (pt.moved > 4) {
          self.tx += dx; self.ty += dy;
          self._userMoved = true; self._clampView(); self._applyTransform(); self._dirty = true;
        }
      }
    });

    function up(e) {
      var pt = self._pointers[e.pointerId];
      if (!pt) return;
      var wasTap = pt.moved < 6 && (Date.now() - pt.t) < 400 && Object.keys(self._pointers).length === 1;
      var releasedAt = pos(e);
      delete self._pointers[e.pointerId];
      if (Object.keys(self._pointers).length === 0) self._panning(false);
      if (wasTap) self._handleTap(releasedAt.x, releasedAt.y);
    }
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", function (e) {
      delete self._pointers[e.pointerId];
      if (Object.keys(self._pointers).length === 0) self._panning(false);
    });
    el.addEventListener("lostpointercapture", function (e) {
      if (!self._pointers[e.pointerId]) return;
      delete self._pointers[e.pointerId];
      if (Object.keys(self._pointers).length === 0) self._panning(false);
    });
  };

  MP._panning = function (on) {
    if (on) this.statesG.classList.add("is-panning");
    else this.statesG.classList.remove("is-panning");
  };

  MP._handleTap = function (sx, sy) {
    // 1) nearest flag within threshold?
    var hit = this._flagAt(sx, sy);
    if (hit && !this.placing) {
      this.selectedId = hit.id; this._dirty = true;
      this.onTapFlag(hit, this.worldToScreen(hit.x, hit.y));
      return;
    }
    // 2) placement mode: place if inside India
    var w = this.screenToWorld(sx, sy);
    if (this.placing) {
      if (this.isInside(w.x, w.y)) {
        this.setPlacement(w.x, w.y);
        this.onPlaced({ x: w.x, y: w.y, valid: true });
      } else {
        this.onPlaced({ x: w.x, y: w.y, valid: false });
      }
      return;
    }
    // 3) tapped empty space
    if (hit) { this.selectedId = hit.id; this._dirty = true; this.onTapFlag(hit, this.worldToScreen(hit.x, hit.y)); return; }
    this.selectedId = null; this._dirty = true; this.onTapOutside(w);
  };

  MP._flagAt = function (sx, sy) {
    var best = null, bestD = 18 * 18;
    for (var i = 0; i < this.flags.length; i++) {
      var f = this.flags[i];
      var p = this.worldToScreen(f.x, f.y);
      if (p.x < -20 || p.x > this.CW + 20 || p.y < -20 || p.y > this.CH + 20) continue;
      var dx = p.x - sx, dy = p.y - sy - this._markerHeight() * 0.5;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  };

  /* ---- Point-in-India ----------------------------------------------- */
  MP.isInside = function (wx, wy) {
    if (wx < 0 || wx > VBW || wy < 0 || wy > VBH) return false;
    if (this.hitContext && this.hitPaths.length) {
      for (var h = 0; h < this.hitPaths.length; h++) {
        try {
          if (this.hitPaths[h] && this.hitContext.isPointInPath(this.hitPaths[h].path, wx, wy)) return true;
        } catch (error) {}
      }
    }
    var pt = this.svg.createSVGPoint(); pt.x = wx; pt.y = wy;
    for (var i = 0; i < this.statePaths.length; i++) {
      try { if (this.statePaths[i].isPointInFill(pt)) return true; } catch (e) {}
    }
    return false;
  };
  MP.stateAt = function (wx, wy) {
    if (this.hitContext && this.hitPaths.length) {
      for (var h = 0; h < this.hitPaths.length; h++) {
        try {
          if (this.hitPaths[h] && this.hitContext.isPointInPath(this.hitPaths[h].path, wx, wy)) {
            return this.hitPaths[h].name;
          }
        } catch (error) {}
      }
    }
    var pt = this.svg.createSVGPoint(); pt.x = wx; pt.y = wy;
    for (var i = 0; i < this.statePaths.length; i++) {
      try { if (this.statePaths[i].isPointInFill(pt)) return this.statePaths[i].getAttribute("data-name"); } catch (e) {}
    }
    return null;
  };
  /* ---- Data --------------------------------------------------------- */
  MP.setFlags = function (arr) {
    this.flags = arr.filter(function (flag) {
      return flag && Number.isSafeInteger(flag.id) && Number.isFinite(flag.x) && Number.isFinite(flag.y);
    });
    this.byId = {};
    for (var i = 0; i < this.flags.length; i++) this.byId[this.flags[i].id] = this.flags[i];
    this.recent = this.flags.slice().sort(function (a, b) { return b.id - a.id; }).slice(0, 12).map(function (f) { return f.id; });
    if (this.selectedId && !this.byId[this.selectedId]) this.selectedId = null;
    this._dirty = true;
  };
  MP.addFlags = function (arr, animate) {
    var now = Date.now();
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      if (this.byId[f.id]) continue;
      this.flags.push(f); this.byId[f.id] = f;
      this.recent.unshift(f.id);
      if (animate) { this.highlightUntil[f.id] = now + 1400; this._anim = true; }
    }
    this.recent = this.recent.slice(0, 14);
    this._dirty = true;
  };
  MP.count = function () { return this.flags.length; };

  /* ---- Placement / preview ------------------------------------------ */
  MP.enterPlacementMode = function () {
    this.interactionLocked = false;
    this.placing = true;
    this.container.classList.add("is-placing");
    this.container.setAttribute("aria-label", "Placement mode. Tap anywhere inside India to preview your Tiranga. Tap again to move it.");
  };
  MP.pausePlacementMode = function () {
    this.placing = false;
    this.interactionLocked = true;
    this.container.classList.remove("is-placing");
  };
  MP.exitPlacementMode = function () {
    this.placing = false;
    this.interactionLocked = false;
    this.container.classList.remove("is-placing");
    this.container.setAttribute("aria-label", "Interactive map of India. Drag to pan, pinch or scroll to zoom, and tap a Tiranga for details.");
    this.clearPreview();
  };
  MP.getPlacement = function () { return this.placement; };
  MP.setPlacement = function (wx, wy, meta) {
    this.placement = { x: wx, y: wy };
    if (!this._preview) {
      this._preview = T.makeMarkerEl({ width: 30, className: "is-preview", wave: true });
      this.overlay.appendChild(this._preview);
    }
    this._preview._wx = wx; this._preview._wy = wy;
    this._applyTransform();
  };
  MP.setPreviewMeta = function (name, gender) {
    if (this._preview) T.setMarkerLabel(this._preview, name, gender);
  };
  MP.lockPreview = function () {
    if (this._preview) this._preview.classList.add("is-locking");
  };
  MP.clearPreview = function () {
    if (this._preview && this._preview.parentNode) this._preview.parentNode.removeChild(this._preview);
    this._preview = null; this.placement = null;
  };

  /* ---- Camera animation (used on success) --------------------------- */
  MP.focusOn = function (wx, wy, targetScale, ms) {
    var self = this;
    if (this._focusRaf) cancelAnimationFrame(this._focusRaf);
    if (this.reduceMotion) {
      this.scale = targetScale; this._userMoved = true;
      this.tx = this.CW / 2 - wx * this.scale; this.ty = this.CH * 0.44 - wy * this.scale;
      this._clampView(); this._applyTransform(); this._dirty = true; return Promise.resolve();
    }
    var s0 = this.scale, t0x = this.tx, t0y = this.ty;
    var s1 = targetScale;
    var t1x = this.CW / 2 - wx * s1, t1y = this.CH * 0.44 - wy * s1;
    var start = performance.now(); ms = ms || 900;
    return new Promise(function (res) {
      function step(now) {
        var k = clamp((now - start) / ms, 0, 1);
        var e = 1 - Math.pow(1 - k, 3);
        self.scale = s0 + (s1 - s0) * e;
        self.tx = t0x + (t1x - t0x) * e; self.ty = t0y + (t1y - t0y) * e;
        self._userMoved = true; self._applyTransform(); self._dirty = true;
        if (k < 1) self._focusRaf = requestAnimationFrame(step);
        else { self._focusRaf = null; res(); }
      }
      self._focusRaf = requestAnimationFrame(step);
    });
  };

  /* ---- Rendering ---------------------------------------------------- */
  MP._flagW = function () {
    return clamp(6 * Math.pow(this.scale / this.scale0, 0.55), 4.5, 13);
  };
  MP._markerHeight = function () {
    return this._flagW() * 1.85;
  };

  MP._loop = function () {
    var self = this;
    function frame() {
      var now = Date.now();
      if (self._anim) {
        // keep animating while any highlight is active
        var active = false;
        for (var id in self.highlightUntil) { if (self.highlightUntil[id] > now) active = true; else delete self.highlightUntil[id]; }
        self._anim = active; self._dirty = true;
      }
      if (self._dirty) { self._render(); self._dirty = false; }
      self._raf = requestAnimationFrame(frame);
    }
    this._raf = requestAnimationFrame(frame);
  };

  MP._render = function () {
    var ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var fw = this._flagW();
    var fh = fw * 2 / 3;
    var poleTop = fw * 1.85;                // marker total height above anchor
    var zoomK = this.scale / this.scale0;
    var simple = fw < 5.6;                  // level of detail
    var total = this.flags.length;
    var now = Date.now();

    // Decide label budget (progressive disclosure)
    var labelCap = zoomK < 1.7 ? 6 : (zoomK < 3 ? 22 : 46);
    var wantLabels = {};
    var labeledCount = 0;
    // featured = most recent; plus selected + highlighted
    var i;
    for (i = 0; i < this.recent.length && labeledCount < labelCap; i++) {
      wantLabels[this.recent[i]] = true; labeledCount++;
    }
    if (this.selectedId) wantLabels[this.selectedId] = true;

    var CW = this.CW, CH = this.CH;
    var drawnLabels = [];

    for (i = 0; i < total; i++) {
      var f = this.flags[i];
      var p = this.worldToScreen(f.x, f.y);
      if (p.x < -12 || p.x > CW + 12 || p.y < -poleTop - 24 || p.y > CH + 12) continue;

      var glow = this.highlightUntil[f.id] && this.highlightUntil[f.id] > now;
      if (glow) {
        var k = (this.highlightUntil[f.id] - now) / 1400;
        ctx.save();
        ctx.globalAlpha = 0.55 * k;
        var g = ctx.createRadialGradient(p.x, p.y - poleTop + fh / 2, 1, p.x, p.y - poleTop + fh / 2, fw * 2.2);
        g.addColorStop(0, "rgba(255,214,138,0.9)");
        g.addColorStop(1, "rgba(255,214,138,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y - poleTop + fh / 2, fw * 2.2, 0, 6.2832); ctx.fill();
        ctx.restore();
      }

      this._drawFlag(ctx, p.x, p.y, fw, fh, poleTop, simple, f.id === this.selectedId);

      // labels
      if (wantLabels[f.id] || f.id === this.selectedId) {
        drawnLabels.push({ f: f, x: p.x, y: p.y - poleTop });
      }
    }

    // draw labels last (on top), with simple overlap avoidance
    var placed = [];
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.font = "600 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    for (i = 0; i < drawnLabels.length; i++) {
      var L = drawnLabels[i], name = L.f.first_name;
      var tw = ctx.measureText(name).width;
      var hasIcon = L.f.gender === "male" || L.f.gender === "female";
      var padL = hasIcon ? 15 : 8;
      var boxW = tw + padL + 8, boxH = 17;
      var bx = L.x + 6, by = L.y - fh - 8;
      // overlap check
      var ok = true;
      for (var j = 0; j < placed.length; j++) {
        var q = placed[j];
        if (Math.abs(bx - q.x) < (boxW + q.w) / 2 && Math.abs(by - q.y) < boxH + 2) { ok = false; break; }
      }
      var forced = (L.f.id === this.selectedId);
      if (!ok && !forced) continue;
      placed.push({ x: bx, y: by, w: boxW });
      // pill bg
      ctx.fillStyle = forced ? "rgba(255,153,51,0.95)" : "rgba(12,16,30,0.72)";
      roundRect(ctx, bx, by - boxH / 2, boxW, boxH, 8); ctx.fill();
      ctx.strokeStyle = forced ? "rgba(255,255,255,0.5)" : "rgba(255,214,138,0.22)";
      ctx.lineWidth = 1; roundRect(ctx, bx, by - boxH / 2, boxW, boxH, 8); ctx.stroke();
      if (hasIcon) drawGenderGlyph(ctx, L.f.gender, bx + 8, by, forced);
      ctx.fillStyle = forced ? "#1a1205" : "#f4efe6";
      ctx.fillText(name, bx + padL, by + 0.5);
    }
  };

  MP._drawFlag = function (ctx, ax, ay, fw, fh, poleTop, simple, selected) {
    var topY = ay - poleTop;
    if (simple) {
      // Compact level-of-detail marker for dense, zoomed-out maps.
      T.drawFlag(ctx, ax, topY, fw, { simple: true });
      return;
    }
    // pole
    ctx.strokeStyle = "rgba(201,178,122,0.85)"; ctx.lineWidth = Math.max(1, fw * 0.09);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax, topY - 1); ctx.stroke();
    // pole knob
    ctx.fillStyle = "#E8C77A"; ctx.beginPath(); ctx.arc(ax, topY - 1, Math.max(1, fw * 0.12), 0, 6.2832); ctx.fill();
    var fx = ax + Math.max(1, fw * 0.09);
    T.drawFlag(ctx, fx, topY, fw);
    if (selected) {
      ctx.strokeStyle = "rgba(255,214,138,0.9)"; ctx.lineWidth = 1.4;
      roundRect(ctx, fx - 2, topY - 2, fw + 4, fh + 4, 2); ctx.stroke();
    }
  };

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawGenderGlyph(ctx, g, cx, cy, forced) {
    ctx.save();
    ctx.strokeStyle = forced ? "#1a1205" : "#E8C77A";
    ctx.lineWidth = 1.1;
    if (g === "male") {
      ctx.beginPath(); ctx.arc(cx - 1, cy + 1, 2.1, 0, 6.2832); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 0.5, cy - 0.5); ctx.lineTo(cx + 3, cy - 3);
      ctx.moveTo(cx + 1, cy - 3); ctx.lineTo(cx + 3, cy - 3); ctx.lineTo(cx + 3, cy - 1); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(cx, cy - 1, 2.1, 0, 6.2832); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy + 1); ctx.lineTo(cx, cy + 3.4);
      ctx.moveTo(cx - 1.4, cy + 2.2); ctx.lineTo(cx + 1.4, cy + 2.2); ctx.stroke();
    }
    ctx.restore();
  }
})();
