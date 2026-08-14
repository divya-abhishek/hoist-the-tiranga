// Server-side admin password verification with per-IP throttling. The password
// and signing secret exist only in Supabase Edge Function secrets.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";
const SESSION_SECRET = Deno.env.get("SESSION_SECRET") ?? "";
const HASH_PEPPER = Deno.env.get("HASH_PEPPER") ?? "";

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_FAILURES = 8;
const WINDOW_MS = 10 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ADMIN_PASSWORD &&
    SESSION_SECRET.length >= 32 && HASH_PEPPER.length >= 16);
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

async function sha256hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function makeToken() {
  const now = Date.now();
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    iat: now,
    exp: now + TOKEN_TTL_MS,
    nonce: crypto.randomUUID(),
  })));
  return `${payload}.${await hmac(payload)}`;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ ok: false, code: "method", error: "Method not allowed." }, 405);
  if (!configured()) {
    console.error("admin-login is missing one or more required secrets");
    return json({ ok: false, code: "server_config", error: "Admin login is not configured." }, 500);
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return json({ ok: false, code: "bad_json", error: "Invalid request." }, 400); }
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length > 200) return json({ ok: false, code: "bad_pw", error: "Incorrect password." }, 401);

  const forwardedFor = request.headers.get("x-forwarded-for") || request.headers.get("cf-connecting-ip") || "unknown";
  const ip = forwardedFor.split(",")[0].trim().slice(0, 120);
  const ipHash = await sha256hex(`${HASH_PEPPER}:admin-ip:${ip}`);

  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const failuresResponse = await databaseFetch(
      `admin_login_attempts?select=id&ip_hash=eq.${ipHash}&ok=eq.false&created_at=gt.${encodeURIComponent(since)}`,
      { headers: { Prefer: "count=exact", Range: "0-0" } },
    );
    if (!failuresResponse.ok) {
      console.error("admin throttle read failed", failuresResponse.status, await failuresResponse.text());
      return json({ ok: false, code: "db", error: "Login unavailable. Please try again." }, 500);
    }
    const range = failuresResponse.headers.get("content-range") || "";
    const failures = parseInt(range.split("/")[1] || "0", 10) || 0;
    if (failures >= MAX_FAILURES) {
      return json({ ok: false, code: "throttled", error: "Too many attempts. Please wait a few minutes." }, 429);
    }

    const valid = safeEqual(password, ADMIN_PASSWORD);
    const attemptResponse = await databaseFetch("admin_login_attempts", {
      method: "POST",
      body: JSON.stringify({ ip_hash: ipHash, ok: valid }),
    });
    if (!attemptResponse.ok) {
      console.error("admin attempt audit failed", attemptResponse.status, await attemptResponse.text());
      return json({ ok: false, code: "db", error: "Login unavailable. Please try again." }, 500);
    }

    if (!valid) return json({ ok: false, code: "bad_pw", error: "Incorrect password." }, 401);
    return json({ ok: true, token: await makeToken(), expires_in: TOKEN_TTL_MS / 1000 });
  } catch (error) {
    console.error("admin login failed", error);
    return json({ ok: false, code: "db", error: "Login unavailable. Please try again." }, 500);
  }
});
