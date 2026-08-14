// Token-protected shared moderation API. All reads and soft remove/restore
// operations run with the service role only after HMAC session verification.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SESSION_SECRET = Deno.env.get("SESSION_SECRET") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && SESSION_SECRET.length >= 32);
}

function databaseFetch(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64Url(new Uint8Array(signature));
}

function safeEqual(left: string, right: string) {
  const size = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < size; i++) {
    difference |= (left.charCodeAt(i % Math.max(left.length, 1)) || 0) ^
      (right.charCodeAt(i % Math.max(right.length, 1)) || 0);
  }
  return difference === 0;
}

async function verifyToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expected = await hmac(parts[0]);
  if (!safeEqual(expected, parts[1])) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    return typeof payload.iat === "number" && typeof payload.exp === "number" &&
      typeof payload.nonce === "string" && payload.iat <= Date.now() + 60000 &&
      payload.exp > Date.now() && payload.exp - payload.iat <= 2 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function publicAdminRow(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    first_name: String(row.first_name || ""),
    gender: String(row.gender || "unspecified"),
    x: Number(row.x_position),
    y: Number(row.y_position),
    created_at: String(row.created_at),
    is_removed: Boolean(row.is_removed),
    removed_at: row.removed_at ? String(row.removed_at) : null,
  };
}

async function countWhere(query: string) {
  const response = await databaseFetch(`flags?select=id&${query}`, {
    method: "HEAD",
    headers: { Prefer: "count=exact", Range: "0-0" },
  });
  if (!response.ok) {
    console.error("admin count failed", response.status, await response.text());
    throw new Error("Admin count failed");
  }
  const total = (response.headers.get("content-range") || "").split("/")[1];
  const count = parseInt(total || "", 10);
  if (!Number.isFinite(count)) throw new Error("Admin count response was invalid");
  return count;
}

function indiaTodayStartUtc() {
  const offsetMinutes = 330;
  const indiaNow = new Date(Date.now() + offsetMinutes * 60000);
  return new Date(Date.UTC(
    indiaNow.getUTCFullYear(), indiaNow.getUTCMonth(), indiaNow.getUTCDate(), 0, 0, 0, 0,
  ) - offsetMinutes * 60000).toISOString();
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ ok: false, code: "method", error: "Method not allowed." }, 405);
  if (!configured()) {
    console.error("admin function is missing required Supabase configuration or SESSION_SECRET");
    return json({ ok: false, code: "server_config", error: "Admin moderation is not configured." }, 500);
  }

  const token = request.headers.get("x-admin-token") || "";
  if (!(await verifyToken(token))) {
    return json({ ok: false, code: "unauth", error: "Session expired. Please log in again." }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return json({ ok: false, code: "bad_json", error: "Invalid request." }, 400); }
  const action = String(body.action || "");

  try {
    if (action === "data") {
      const filter = body.filter === "removed" ? "removed" : body.filter === "all" ? "all" : "active";
      const search = String(body.q || "")
        .replace(/[^\p{L}\p{M} .'’-]/gu, "")
        .trim()
        .slice(0, 40);
      let where = "";
      if (filter === "active") where = "is_removed=eq.false";
      if (filter === "removed") where = "is_removed=eq.true";
      if (search) where += (where ? "&" : "") + `first_name=ilike.*${encodeURIComponent(search)}*`;

      const listResponse = await databaseFetch(
        `flags?select=id,first_name,gender,x_position,y_position,created_at,is_removed,removed_at` +
        `${where ? "&" + where : ""}&order=created_at.desc&limit=1000`,
      );
      if (!listResponse.ok) {
        console.error("admin list failed", listResponse.status, await listResponse.text());
        return json({ ok: false, code: "db", error: "Could not load moderation data." }, 500);
      }
      const rows = await listResponse.json();
      if (!Array.isArray(rows)) throw new Error("Admin list response was invalid");

      const [active, removed, today] = await Promise.all([
        countWhere("is_removed=eq.false"),
        countWhere("is_removed=eq.true"),
        countWhere(`created_at=gte.${encodeURIComponent(indiaTodayStartUtc())}`),
      ]);
      return json({
        ok: true,
        stats: { active, removed, today },
        flags: rows.map(publicAdminRow),
      });
    }

    if (action === "remove" || action === "restore") {
      const id = typeof body.id === "number" ? body.id : Number(body.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return json({ ok: false, code: "bad_id", error: "Invalid Tiranga id." }, 400);
      }
      const patch = action === "remove"
        ? { is_removed: true, removed_at: new Date().toISOString() }
        : { is_removed: false, removed_at: null };
      const updateResponse = await databaseFetch(`flags?id=eq.${id}&select=id`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(patch),
      });
      const raw = await updateResponse.text();
      if (!updateResponse.ok) {
        console.error("admin update failed", updateResponse.status, raw);
        return json({ ok: false, code: "db", error: "Moderation update failed." }, 500);
      }
      let rows: unknown;
      try { rows = raw ? JSON.parse(raw) : []; }
      catch { rows = []; }
      if (!Array.isArray(rows) || !rows.length) {
        return json({ ok: false, code: "not_found", error: "Tiranga not found." }, 404);
      }
      return json({ ok: true, id, action });
    }

    return json({ ok: false, code: "bad_action", error: "Unknown action." }, 400);
  } catch (error) {
    console.error("admin request failed", error);
    return json({ ok: false, code: "db", error: "Admin request failed. Please try again." }, 500);
  }
});
