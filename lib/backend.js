/* ========================================================================== 
   Supabase-only data service. Public flags never fall back to localStorage.
   Reads use the safe public_flags view; writes and moderation use Edge
   Functions. Every request has a timeout and every non-2xx response is checked.
   ========================================================================== */
(function () {
  "use strict";

  var T = (window.T = window.T || {});
  var cfg = window.TIRANGA_CONFIG || {};
  var PAGE_SIZE = 1000;
  var REQUEST_TIMEOUT = 12000;

  function isPlaceholder(value) {
    return !value || /YOUR-PROJECT|YOUR-USERNAME|YOUR-ANON|YOUR-PUBLISHABLE|REPLACE|example\.com/i.test(value);
  }

  function BackendError(code, message, cause) {
    this.name = "BackendError";
    this.code = code;
    this.message = message;
    this.cause = cause || null;
  }
  BackendError.prototype = Object.create(Error.prototype);

  function SupabaseBackend() {
    this.base = String(cfg.SUPABASE_URL || "").replace(/\/+$/, "");
    this.anon = String(cfg.SUPABASE_PUBLISHABLE_KEY || cfg.SUPABASE_ANON_KEY || "");
    this.configured = !isPlaceholder(this.base) && !isPlaceholder(this.anon);
    this.mode = "supabase";

    var self = this;
    this.admin = {
      login: function (password) {
        return self._function("admin-login", { password: password });
      },
      data: function (token, options) {
        options = options || {};
        return self._function("admin", {
          action: "data",
          q: options.q || "",
          filter: options.filter || "active"
        }, { "x-admin-token": token });
      },
      moderate: function (token, options) {
        return self._function("admin", {
          action: options.action,
          id: options.id
        }, { "x-admin-token": token });
      }
    };
  }

  SupabaseBackend.prototype._assertConfigured = function () {
    if (!this.configured) {
      throw new BackendError("config", "Supabase is not configured. Add the project URL and public key in config.js.");
    }
  };

  SupabaseBackend.prototype._restHeaders = function (extra) {
    var headers = { apikey: this.anon };
    // Legacy anon keys are JWTs and may be sent as Bearer tokens. The newer
    // sb_publishable_* keys are opaque; sending one as Authorization can make
    // the Edge gateway reject it as a malformed JWT, so use the apikey header.
    if (!/^sb_publishable_/i.test(this.anon)) headers.Authorization = "Bearer " + this.anon;
    Object.keys(extra || {}).forEach(function (key) { headers[key] = extra[key]; });
    return headers;
  };

  SupabaseBackend.prototype._fetch = function (url, options) {
    try { this._assertConfigured(); }
    catch (error) { return Promise.reject(error); }
    options = options || {};
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timeout = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT) : null;
    if (controller) options.signal = controller.signal;
    options.cache = "no-store";
    return fetch(url, options).catch(function (error) {
      var message = error && error.name === "AbortError" ? "Request timed out" : "Network request failed";
      throw new BackendError("network", message, error);
    }).finally(function () {
      if (timeout) clearTimeout(timeout);
    });
  };

  SupabaseBackend.prototype._readJson = function (response, label) {
    return response.text().then(function (text) {
      var body = null;
      try { body = text ? JSON.parse(text) : null; }
      catch (error) {
        console.error(label + " returned invalid JSON", response.status, text.slice(0, 300));
        throw new BackendError("server", "The server returned an invalid response.", error);
      }
      if (!response.ok) {
        console.error(label + " failed", response.status, body);
        throw new BackendError(body && body.code ? body.code : String(response.status),
          body && body.error ? body.error : "Request failed.");
      }
      return body;
    });
  };

  SupabaseBackend.prototype._mapRow = function (row) {
    var mapped = {
      id: Number(row.id),
      first_name: String(row.first_name || ""),
      gender: row.gender === "male" || row.gender === "female" ? row.gender : "unspecified",
      x: Number(row.x_position),
      y: Number(row.y_position),
      created_at: row.created_at
    };
    if (!Number.isSafeInteger(mapped.id) || mapped.id <= 0 ||
        !Number.isFinite(mapped.x) || !Number.isFinite(mapped.y) ||
        mapped.x < 0 || mapped.x > 612 || mapped.y < 0 || mapped.y > 696 ||
        !mapped.first_name) {
      console.error("Ignoring invalid public flag row", row);
      return null;
    }
    return mapped;
  };

  SupabaseBackend.prototype.getFlags = function (options) {
    options = options || {};
    var self = this;
    var afterId = Number(options.sinceId) || 0;
    var output = [];
    var pages = 0;

    function nextPage() {
      pages += 1;
      if (pages > 100) throw new BackendError("server", "The public flag feed is unexpectedly large.");
      var query = "select=id,first_name,gender,x_position,y_position,created_at" +
        "&id=gt." + encodeURIComponent(afterId) +
        "&order=id.asc&limit=" + PAGE_SIZE;
      return self._fetch(self.base + "/rest/v1/public_flags?" + query, {
        headers: self._restHeaders()
      }).then(function (response) {
        return self._readJson(response, "Public flags read");
      }).then(function (rows) {
        if (!Array.isArray(rows)) throw new BackendError("server", "The public flag feed is invalid.");
        rows.forEach(function (row) {
          var rawId = Number(row && row.id);
          if (Number.isSafeInteger(rawId) && rawId > afterId) afterId = rawId;
          var mapped = self._mapRow(row);
          if (mapped) {
            output.push(mapped);
          }
        });
        return rows.length === PAGE_SIZE ? nextPage() : output;
      });
    }
    return nextPage();
  };

  SupabaseBackend.prototype.getFlag = function (id) {
    var self = this;
    var safeId = Number(id);
    if (!Number.isSafeInteger(safeId) || safeId <= 0) return Promise.resolve(null);
    var query = "select=id,first_name,gender,x_position,y_position,created_at&id=eq." + encodeURIComponent(safeId) + "&limit=1";
    return this._fetch(this.base + "/rest/v1/public_flags?" + query, {
      headers: this._restHeaders()
    }).then(function (response) {
      return self._readJson(response, "Confirmed flag read");
    }).then(function (rows) {
      return Array.isArray(rows) && rows[0] ? self._mapRow(rows[0]) : null;
    });
  };

  SupabaseBackend.prototype.getCount = function () {
    var self = this;
    return this._fetch(this.base + "/rest/v1/public_flags?select=id", {
      method: "HEAD",
      headers: this._restHeaders({ Prefer: "count=exact", Range: "0-0" })
    }).then(function (response) {
      if (!response.ok) {
        console.error("Public count failed", response.status);
        throw new BackendError(String(response.status), "Could not load the Tiranga count.");
      }
      var range = response.headers.get("content-range") || "";
      var total = range.split("/")[1];
      if (!total || total === "*") throw new BackendError("server", "The Tiranga count is unavailable.");
      var count = parseInt(total, 10);
      if (!Number.isFinite(count)) throw new BackendError("server", "The Tiranga count is invalid.");
      return count;
    });
  };

  SupabaseBackend.prototype._function = function (name, payload, extraHeaders) {
    var self = this;
    var headers = this._restHeaders({ "Content-Type": "application/json" });
    Object.keys(extraHeaders || {}).forEach(function (key) { headers[key] = extraHeaders[key]; });
    try { this._assertConfigured(); }
    catch (error) {
      console.error(error.message);
      return Promise.resolve({ ok: false, code: error.code, error: error.message });
    }
    return this._fetch(this.base + "/functions/v1/" + name, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : {}; }
        catch (error) {
          console.error(name + " returned invalid JSON", response.status, text.slice(0, 300));
          return { ok: false, code: "server", error: "The server returned an invalid response." };
        }
        if (!response.ok || body.ok === false) {
          console.error(name + " failed", response.status, body);
          return {
            ok: false,
            code: body.code || String(response.status),
            error: body.error || "Request failed."
          };
        }
        body.ok = true;
        return body;
      });
    }).catch(function (error) {
      console.error(name + " request error", error);
      return {
        ok: false,
        code: error.code || "network",
        error: error.code === "config" ? error.message : "India is busy celebrating right now. Please try again."
      };
    });
  };

  SupabaseBackend.prototype.hoist = function (payload) {
    return this._function("hoist", payload);
  };

  var backend = new SupabaseBackend();
  T.BACKEND_CONFIGURED = backend.configured;
  T.USING_SUPABASE = backend.configured;
  T.backend = backend;
})();
