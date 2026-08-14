/* ==========================================================================
   Hoist the Tiranga — configuration
   --------------------------------------------------------------------------
   1. Copy this file to a new file named  config.js  (same folder).
   2. Paste in your Supabase values (see README, Supabase setup).
   3. Set SITE_URL to your live GitHub Pages address (see README, deployment).

   Everything in this file is PUBLIC and safe to publish. The anon key is
   meant to live in the browser. Never put the service-role key or the
   admin password here — those stay on the server (Supabase secrets).

   If placeholders remain, database reads and submissions show a setup error.
   There is no local flag database and no fake-success fallback.
   ========================================================================== */
window.TIRANGA_CONFIG = {
  // From Supabase → Project Settings → Data API / API
  SUPABASE_URL: "https://YOUR-PROJECT-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "YOUR-PUBLISHABLE-OR-ANON-KEY",

  // Your public website address, WITH trailing slash.
  // e.g. "https://your-username.github.io/hoist-the-tiranga/"
  SITE_URL: "https://YOUR-USERNAME.github.io/hoist-the-tiranga/"
};
