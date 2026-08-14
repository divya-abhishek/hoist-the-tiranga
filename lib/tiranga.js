/* ========================================================================== 
   Shared Tiranga graphics, explicit icon mounting, gender icons, and name
   validation. Normal page text is never scanned, replaced, or emoji-parsed.
   ========================================================================== */
(function () {
  "use strict";

  var T = (window.T = window.T || {});
  var NS = "http://www.w3.org/2000/svg";

  T.COLORS = {
    saffron: "#FF9933",
    white: "#FFFFFF",
    green: "#138808",
    chakra: "#000080",
    pole: "#C9B27A"
  };

  function svgNode(name, attrs) {
    var node = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (key) {
      node.setAttribute(key, String(attrs[key]));
    });
    return node;
  }

  function appendChakra(svg, cx, cy, radius) {
    svg.appendChild(svgNode("circle", {
      cx: cx, cy: cy, r: radius, fill: "none",
      stroke: T.COLORS.chakra, "stroke-width": Math.max(radius * 0.13, 0.45)
    }));
    var spokes = svgNode("g", {
      stroke: T.COLORS.chakra,
      "stroke-width": Math.max(radius * 0.075, 0.32),
      "stroke-linecap": "round"
    });
    for (var i = 0; i < 24; i++) {
      var angle = i * Math.PI / 12;
      spokes.appendChild(svgNode("line", {
        x1: cx, y1: cy,
        x2: (cx + Math.cos(angle) * radius).toFixed(3),
        y2: (cy + Math.sin(angle) * radius).toFixed(3)
      }));
    }
    svg.appendChild(spokes);
    svg.appendChild(svgNode("circle", {
      cx: cx, cy: cy, r: Math.max(radius * 0.14, 0.38), fill: T.COLORS.chakra
    }));
  }

  /* Exact 2:3 Tiranga as an SVG element. */
  T.flagSVG = function (width, opts) {
    opts = opts || {};
    var W = 90;
    var H = 60;
    var svg = svgNode("svg", {
      viewBox: "0 0 " + W + " " + H,
      width: width,
      height: width * H / W,
      class: "tir-flag" + (opts.wave ? " tir-wave" : ""),
      "aria-hidden": "true",
      focusable: "false"
    });
    svg.appendChild(svgNode("rect", { x: 0, y: 0, width: W, height: 20, fill: T.COLORS.saffron }));
    svg.appendChild(svgNode("rect", { x: 0, y: 20, width: W, height: 20, fill: T.COLORS.white }));
    svg.appendChild(svgNode("rect", { x: 0, y: 40, width: W, height: 20, fill: T.COLORS.green }));
    appendChakra(svg, 45, 30, 7.5);
    svg.appendChild(svgNode("rect", {
      x: 0, y: 0, width: W, height: H, fill: "none",
      stroke: "rgba(0,0,0,0.18)", "stroke-width": 0.6
    }));
    return svg;
  };

  /* Canvas equivalent used by the dense map renderer. */
  T.drawFlag = function (ctx, x, y, width, opts) {
    opts = opts || {};
    var height = width * 2 / 3;
    var band = height / 3;
    ctx.fillStyle = T.COLORS.saffron;
    ctx.fillRect(x, y, width, band);
    ctx.fillStyle = T.COLORS.white;
    ctx.fillRect(x, y + band, width, band);
    ctx.fillStyle = T.COLORS.green;
    ctx.fillRect(x, y + band * 2, width, band);
    var cx = x + width / 2;
    var cy = y + height / 2;
    var r = height / 8;
    ctx.strokeStyle = T.COLORS.chakra;
    ctx.fillStyle = T.COLORS.chakra;
    if (width < 8 || opts.simple) {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0.7, r * 0.45), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.lineWidth = Math.max(0.42, r * 0.13);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = Math.max(0.32, r * 0.075);
    ctx.beginPath();
    for (var i = 0; i < 24; i++) {
      var angle = i * Math.PI / 12;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0.38, r * 0.14), 0, Math.PI * 2);
    ctx.fill();
  };

  /* Only deliberately marked elements receive a flag; body text is untouched. */
  T.mountFlagIcons = function (root) {
    var scope = root || document;
    var icons = scope.querySelectorAll("[data-tiranga-icon]:not([data-tiranga-mounted])");
    Array.prototype.forEach.call(icons, function (host) {
      var width = parseFloat(host.getAttribute("data-width")) || 18;
      host.textContent = "";
      host.appendChild(T.flagSVG(width, { wave: host.hasAttribute("data-wave") }));
      host.setAttribute("data-tiranga-mounted", "true");
    });
  };

  T.genderIcon = function (gender, size) {
    size = size || 14;
    if (gender !== "male" && gender !== "female") return null;
    var svg = svgNode("svg", {
      viewBox: "0 0 24 24", width: size, height: size,
      class: "tir-gender tir-gender-" + gender,
      "aria-hidden": "true", focusable: "false"
    });
    var circleAttrs = { fill: "none", stroke: "currentColor", "stroke-width": 2 };
    if (gender === "male") {
      svg.appendChild(svgNode("circle", Object.assign({ cx: 10, cy: 14, r: 5.2 }, circleAttrs)));
      svg.appendChild(svgNode("path", {
        d: "M14 10 L20 4 M15 4 H20 V9", fill: "none", stroke: "currentColor",
        "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round"
      }));
    } else {
      svg.appendChild(svgNode("circle", Object.assign({ cx: 12, cy: 9, r: 5.2 }, circleAttrs)));
      svg.appendChild(svgNode("path", {
        d: "M12 14.2 V21 M9 18 H15", fill: "none", stroke: "currentColor",
        "stroke-width": 2, "stroke-linecap": "round"
      }));
    }
    return svg;
  };

  T.makeMarkerEl = function (opts) {
    opts = opts || {};
    var width = opts.width || 34;
    var flagHeight = width * 2 / 3;
    var poleHeight = opts.poleHeight || width * 1.9;
    var marker = document.createElement("div");
    marker.className = "tir-marker" + (opts.className ? " " + opts.className : "");
    marker.style.setProperty("--fw", width + "px");
    marker.style.setProperty("--fh", flagHeight + "px");
    marker.style.setProperty("--poleH", poleHeight + "px");
    var pole = document.createElement("span");
    pole.className = "tir-pole";
    var flagWrap = document.createElement("span");
    flagWrap.className = "tir-flagwrap";
    flagWrap.appendChild(T.flagSVG(width, { wave: opts.wave !== false }));
    marker.appendChild(pole);
    marker.appendChild(flagWrap);
    if (opts.name) T.setMarkerLabel(marker, opts.name, opts.gender);
    return marker;
  };

  T.setMarkerLabel = function (marker, name, gender) {
    var previous = marker.querySelector(".tir-label");
    if (previous) previous.remove();
    var label = document.createElement("span");
    label.className = "tir-label";
    var genderIcon = T.genderIcon(gender, 12);
    if (genderIcon) label.appendChild(genderIcon);
    var nameSpan = document.createElement("span");
    nameSpan.className = "tir-name";
    nameSpan.textContent = name;
    label.appendChild(nameSpan);
    marker.appendChild(label);
  };

  // Match abusive entries as complete normalized input/words. Substring
  // matching is intentionally avoided: legitimate Indian names such as
  // Shital and Dikshit contain an English profanity as a letter sequence.
  var BLOCKED_WORDS = [
    "fuck", "shit", "bitch", "bastard", "asshole", "pussy", "cunt", "slut", "whore",
    "nigger", "nigga", "faggot", "retard", "rapist", "porn", "penis", "vagina",
    "chutiya", "chutia", "madarchod", "madarchoad", "behenchod", "bhenchod",
    "bhosdi", "bhosdike", "gaand", "gandu", "lund", "lauda", "randi", "harami",
    "rape", "sex", "dick", "bkl", "mc", "bc"
  ];
  var MIN_NAME = 2;
  var MAX_NAME = 20;

  function stripInvisible(value) {
    return value
      .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  T.validateName = function (raw) {
    if (typeof raw !== "string") return { ok: false, reason: "Please enter your first name." };
    var value = stripInvisible(raw);
    if (!value) return { ok: false, reason: "Please enter your first name." };
    var length = Array.from(value).length;
    if (length < MIN_NAME) return { ok: false, reason: "That's a bit short — use at least 2 characters." };
    if (length > MAX_NAME) return { ok: false, reason: "Please keep it to 20 characters or fewer." };
    if (/[<>\\{}\[\]$`^~|=*/]|https?:|www\.|:\/\/|@|&#|&lt;|&gt;/i.test(value)) {
      return { ok: false, reason: "Letters only, please — no links or symbols." };
    }
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(value)) {
      return { ok: false, reason: "Please use letters only (spaces, - and ' are fine)." };
    }
    var letters = value.match(/[\p{L}]/gu) || [];
    if (letters.length < 2 || /(.)\1{3,}/u.test(value)) {
      return { ok: false, reason: "Please enter a real first name." };
    }
    var latin = value.toLowerCase().replace(/[’']/g, "").replace(/[^a-z\s-]/g, "");
    if (/qwerty|asdf|zxcv|hjkl|testtest|demo/i.test(latin)) {
      return { ok: false, reason: "Please enter a real first name." };
    }
    var compact = latin.replace(/[\s-]/g, "");
    var unique = {};
    compact.split("").forEach(function (letter) { unique[letter] = true; });
    if (compact.length >= 6 && Object.keys(unique).length <= 2) {
      return { ok: false, reason: "Please enter a real first name." };
    }
    var words = latin.split(/[\s-]+/).filter(Boolean);
    if (BLOCKED_WORDS.indexOf(compact) !== -1) {
      return { ok: false, reason: "Let's keep it respectful." };
    }
    for (var i = 0; i < words.length; i++) {
      if (BLOCKED_WORDS.indexOf(words[i]) !== -1) return { ok: false, reason: "Let's keep it respectful." };
    }
    return { ok: true, value: value };
  };

  T.validateGender = function (gender) {
    return gender === "male" || gender === "female" ? gender : "unspecified";
  };
})();
