# Hoist the Tiranga
<img src="https://i.postimg.cc/R0kn7fwg/HTT.png" alt="website preview">
An interactive Independence Day experience for 15 August 2026. Visitors enter a first name, manually choose a point on the India map, and hoist a Tiranga that is stored in one shared Supabase database.

- Static frontend: HTML, CSS, and vanilla JavaScript
- Hosting: GitHub Pages
- Shared backend: Supabase Postgres + three Edge Functions
- No account, GPS, geolocation, or frontend service-role key
- No local flag database, sample markers, or fake-success fallback

## How the production flow works

1. The public page reads active rows from the safe `public_flags` database view.
2. The visitor enters placement mode and taps inside the India vector geometry.
3. `hoist` validates the request and hashes the anonymous browser ID with a server-only pepper.
4. The `hoist_flag` Postgres function locks that browser's quota, enforces the five-flag limit, and inserts idempotently in one transaction.
5. Only a confirmed database row triggers the hoisting animation and success sheet.
6. The page polls every 10 seconds for new data. A count change triggers a full reconciliation, so admin removals and restores propagate to open pages.

The only public browser storage is `tir_browser_id_v1`, a random anonymous ID used for the five-flag limit. Public flags are never stored in `localStorage` or `sessionStorage`.

## Project structure

```text
index.html                         Public experience
styles.css                        Responsive UI and animation
app.js                            State machine, placement, submission, polling, sharing
config.js                         Public Supabase URL/key and site URL
lib/backend.js                    Supabase-only data service
lib/mapengine.js                  SVG map, hit testing, pan/zoom, canvas markers
lib/tiranga.js                    Reusable 2:3 Tiranga and validation
admin/                            Unlinked moderation panel at /admin/
assets/                           Map data, favicon, and supplied decorative assets
supabase/migrations/0001_init.sql Complete rerunnable database setup/upgrade
supabase/functions/               hoist, admin-login, and admin Edge Functions
supabase/config.toml              Function gateway authentication settings
```

## Database and security

Run `supabase/migrations/0001_init.sql` as one script. It is safe to run over the earlier version of this project and preserves existing flag rows.

It creates or hardens:

- `public.flags`, including `submission_id` for retry safety and `updated_at` for moderation changes;
- an atomic `public.hoist_flag(...)` function with a per-browser advisory lock;
- `public.public_flags`, which exposes only active rows and the six map fields;
- `public.admin_login_attempts` for login throttling;
- RLS/revokes that block anonymous access to the base tables;
- service-role-only execution of the insertion transaction.

Anonymous visitors cannot directly insert, update, remove, restore, or read `browser_hash`. Admin operations use a signed two-hour token issued only after server-side password verification.

## Supabase setup

### 1. Create or open the project

Open [Supabase](https://supabase.com/dashboard), create a free project if needed, and wait for it to finish provisioning.

### 2. Run the SQL

1. Open **SQL Editor**.
2. Choose **New query**.
3. Copy all of `supabase/migrations/0001_init.sql` into the editor.
4. Click **Run**.

The script retains existing Tirangas. It does not seed or delete flag rows.

### 3. Set Edge Function secrets

In **Edge Functions → Secrets**, create these three secrets:

| Secret | Value |
|---|---|
| `ADMIN_PASSWORD` | The private admin password chosen for this project |
| `SESSION_SECRET` | A unique random value of at least 32 characters |
| `HASH_PEPPER` | A different unique random value of at least 16 characters |

Do not put any of these values in `config.js`, GitHub, HTML, or frontend JavaScript. Hosted Supabase functions already receive `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; do not copy the service-role key into this repository.

You can generate strong random strings locally with:

```bash
openssl rand -hex 32
```

### 4. Deploy the functions

Install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started), then run from this project folder:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy hoist
supabase functions deploy admin-login
supabase functions deploy admin
```

Supabase also supports deploying an Edge Function from its dashboard. If using that route, create functions named exactly `hoist`, `admin-login`, and `admin`, and paste the corresponding `index.ts` file into each one.

### 5. Add the public website configuration

Open **Project Settings → API Keys**. Copy:

- the Project URL;
- the publishable key (preferred), or the legacy `anon` public key.

Edit `config.js`:

```js
window.TIRANGA_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_REF.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "YOUR_PUBLISHABLE_OR_ANON_KEY",
  SITE_URL: "https://YOUR_USERNAME.github.io/YOUR_REPOSITORY/"
};
```

The publishable/anon key is intended for browser use when RLS and grants are correct. Never substitute a secret or service-role key.

## Local verification

Do not open `index.html` with a `file://` URL. Serve the folder so browser networking and paths behave like production:

```bash
python -m http.server 8080
```

Open `http://localhost:8080/`. Because the site has no local database fallback, it must use the configured Supabase project even during local testing.

Expected failure behavior:

- If initial reading fails: **Couldn’t load the Tirangas. Tap to try again.**
- If insertion fails: **India is busy celebrating right now. Please try again.**
- No failed request produces a permanent marker or success screen.

## Admin moderation

The admin panel is at `/admin/` and is intentionally not linked on the public page. It is marked `noindex,nofollow` and supports:

- server-side password login;
- active and removed counts;
- name search;
- soft removal and restoration.

Removal updates the shared row. Public pages reconcile the change through Supabase polling; removed flags still count toward that browser's lifetime limit of five.

## GitHub Pages deployment

1. Commit the entire project, including `.nojekyll`.
2. Push it to the `main` branch of a GitHub repository.
3. In the repository, open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Choose `main` and `/ (root)`, then save.
6. Set `SITE_URL` in `config.js` to the exact Pages URL, including the trailing slash, commit, and push again.

All application asset paths are relative, so they work at a GitHub Pages repository subpath.

## Production acceptance checklist

1. In Supabase Table Editor, confirm `flags` has no rows if this is meant to be a clean launch.
2. Open the site at 390 px width, select **Hoist Your Tiranga**, enter `Aarav`, choose a point, and submit.
3. In browser DevTools → Network, confirm the POST to `/functions/v1/hoist` returns `200` with `ok: true` and a `flag` object.
4. In Supabase Table Editor, confirm the new row exists.
5. Open a second device or incognito window. Confirm Aarav appears after load or within roughly 10 seconds.
6. Refresh and clear localStorage. The public Aarav row must still appear because it comes from Supabase.
7. Tap a second point before submission and confirm only the preview moves.
8. Submit five flags from one browser, then attempt a sixth. The Edge Function/database must return the limit response.
9. In `/admin/`, remove a flag. Confirm it disappears publicly; restore it and confirm it returns.
10. Simulate an offline/failed insert and confirm the preview remains retryable with no success animation.

## Test-data safety

This repository contains zero frontend seeds, sample names, random markers, or database seed inserts. The migration never deletes data. Because legitimate users can have common names, do not delete rows by name alone. Review suspected test records in Table Editor or remove them through `/admin/`; only delete rows in SQL after identifying their exact IDs.

# EXACT STEPS FOR ME

1. Open **Supabase Dashboard → your project → SQL Editor → New query**.
2. Paste and run the complete contents of `supabase/migrations/0001_init.sql` once.
3. Open **Edge Functions → Secrets** and set `ADMIN_PASSWORD`, `SESSION_SECRET`, and `HASH_PEPPER`. Keep every value private.
4. Deploy `hoist`, `admin-login`, and `admin` from `supabase/functions/` using the three CLI commands shown above, or deploy the same files in the dashboard.
5. Open **Project Settings → API Keys**. Put the Project URL and publishable/anon public key into `config.js`; put no server secret there.
6. Serve the folder locally, hoist one test flag, verify the successful network request, and verify the real row in **Table Editor → flags**.
7. Open the site in an incognito window or a second phone and confirm the same test flag loads from the shared database.
8. Push the repaired files to GitHub, select **Settings → Pages → Deploy from a branch → main → / (root)**, then update `SITE_URL` to the final Pages address and push once more.

Official references: [Supabase Edge Function deployment](https://supabase.com/docs/guides/functions/deploy), [Supabase function secrets](https://supabase.com/docs/guides/functions/secrets), [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys), and [GitHub Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
