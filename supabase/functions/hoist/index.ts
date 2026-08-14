// Public hoist endpoint. Validation runs here; quota + idempotent insertion run
// atomically in the hoist_flag database function from 0001_init.sql.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const HASH_PEPPER = Deno.env.get("HASH_PEPPER") ?? "";

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
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && HASH_PEPPER.length >= 16);
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

async function sha256hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Match complete normalized words/input, not substrings: Shital and Dikshit
// are legitimate names even though their spelling contains an English slur.
const BLOCKED_WORDS = [
  "fuck", "shit", "bitch", "bastard", "asshole", "pussy", "cunt", "slut", "whore",
  "nigger", "nigga", "faggot", "retard", "rapist", "porn", "penis", "vagina",
  "chutiya", "chutia", "madarchod", "madarchoad", "behenchod", "bhenchod",
  "bhosdi", "bhosdike", "gaand", "gandu", "lund", "lauda", "randi", "harami",
  "rape", "sex", "dick", "bkl", "mc", "bc",
];

function validateName(raw: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "Please enter your first name." };
  const value = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const length = Array.from(value).length;
  if (!value) return { ok: false, reason: "Please enter your first name." };
  if (length < 2) return { ok: false, reason: "That's a bit short — use at least 2 characters." };
  if (length > 20) return { ok: false, reason: "Please keep it to 20 characters or fewer." };
  if (/[<>\\{}\[\]$`^~|=*/]|https?:|www\.|:\/\/|@|&#|&lt;|&gt;/i.test(value)) {
    return { ok: false, reason: "Letters only, please — no links or symbols." };
  }
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(value)) {
    return { ok: false, reason: "Please use letters only (spaces, - and ' are fine)." };
  }
  const letters = value.match(/[\p{L}]/gu) || [];
  if (letters.length < 2 || /(.)\1{3,}/u.test(value)) {
    return { ok: false, reason: "Please enter a real first name." };
  }
  const latin = value.toLowerCase().replace(/[’']/g, "").replace(/[^a-z\s-]/g, "");
  if (/qwerty|asdf|zxcv|hjkl|testtest|demo/i.test(latin)) {
    return { ok: false, reason: "Please enter a real first name." };
  }
  const compact = latin.replace(/[\s-]/g, "");
  if (compact.length >= 6 && new Set(compact).size <= 2) {
    return { ok: false, reason: "Please enter a real first name." };
  }
  if (BLOCKED_WORDS.includes(compact)) {
    return { ok: false, reason: "Let's keep it respectful." };
  }
  const words = latin.split(/[\s-]+/).filter(Boolean);
  if (words.some((word) => BLOCKED_WORDS.includes(word))) {
    return { ok: false, reason: "Let's keep it respectful." };
  }
  return { ok: true, value };
}

function rpcError(message: string) {
  if (message.includes("FLAG_LIMIT")) {
    return json({ ok: false, code: "limit", error: "You've already hoisted 5 Tirangas from this browser." }, 429);
  }
  if (message.includes("FLAG_COOLDOWN")) {
    return json({ ok: false, code: "cooldown", error: "One moment — please wait a few seconds." }, 429);
  }
  if (message.includes("BAD_NAME")) {
    return json({ ok: false, code: "bad_name", error: "Please check your first name." }, 400);
  }
  if (message.includes("BAD_PLACE")) {
    return json({ ok: false, code: "bad_place", error: "Please tap on India to place your Tiranga." }, 400);
  }
  if (message.includes("BAD_GENDER") || message.includes("BAD_REQUEST")) {
    return json({ ok: false, code: "bad_request", error: "Invalid request." }, 400);
  }
  return null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ ok: false, code: "method", error: "Method not allowed." }, 405);
  if (!configured()) {
    console.error("hoist function is missing SUPABASE configuration or HASH_PEPPER");
    return json({ ok: false, code: "server_config", error: "India is busy celebrating right now. Please try again." }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, code: "bad_json", error: "Invalid request." }, 400);
  }

  const name = validateName(body.first_name);
  if (!name.ok) return json({ ok: false, code: "bad_name", error: name.reason }, 400);
  const gender = body.gender === "male" || body.gender === "female" ? body.gender : "unspecified";

  if (body.x === null || body.x === undefined || body.y === null || body.y === undefined) {
    return json({ ok: false, code: "bad_place", error: "Please tap on India to place your Tiranga." }, 400);
  }
  const x = Number(body.x);
  const y = Number(body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 612 || y < 0 || y > 696) {
    return json({ ok: false, code: "bad_place", error: "Please tap on India to place your Tiranga." }, 400);
  }

  const browserId = typeof body.browserId === "string" ? body.browserId : "";
  const submissionId = typeof body.submissionId === "string" ? body.submissionId : "";
  if (browserId.length < 8 || browserId.length > 200 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) {
    return json({ ok: false, code: "bad_request", error: "Invalid request." }, 400);
  }

  const browserHash = await sha256hex(`${HASH_PEPPER}:browser:${browserId}`);
  try {
    const response = await databaseFetch("rpc/hoist_flag", {
      method: "POST",
      body: JSON.stringify({
        p_first_name: name.value,
        p_gender: gender,
        p_x: Math.round(x * 100) / 100,
        p_y: Math.round(y * 100) / 100,
        p_browser_hash: browserHash,
        p_submission_id: submissionId,
      }),
    });
    const raw = await response.text();
    let result: unknown;
    try { result = raw ? JSON.parse(raw) : null; }
    catch {
      console.error("hoist_flag returned invalid JSON", response.status, raw.slice(0, 300));
      return json({ ok: false, code: "db", error: "India is busy celebrating right now. Please try again." }, 500);
    }

    if (!response.ok) {
      const message = typeof result === "object" && result && "message" in result
        ? String((result as { message: unknown }).message)
        : raw;
      const known = rpcError(message);
      if (known) return known;
      console.error("hoist_flag failed", response.status, result);
      return json({ ok: false, code: "db", error: "India is busy celebrating right now. Please try again." }, 500);
    }

    const row = Array.isArray(result) ? result[0] : null;
    const id = Number(row?.flag_id);
    const count = Number(row?.active_count);
    if (!row || !Number.isSafeInteger(id) || !Number.isFinite(count)) {
      console.error("hoist_flag returned an invalid row", result);
      return json({ ok: false, code: "db", error: "India is busy celebrating right now. Please try again." }, 500);
    }

    return json({
      ok: true,
      id,
      count,
      flag: {
        id,
        first_name: String(row.first_name),
        gender: String(row.gender),
        x: Number(row.x_position),
        y: Number(row.y_position),
        created_at: String(row.created_at),
      },
    });
  } catch (error) {
    console.error("hoist database request failed", error);
    return json({ ok: false, code: "db", error: "India is busy celebrating right now. Please try again." }, 500);
  }
});
