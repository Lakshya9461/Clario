# Deploying Clario

Three moving parts: MongoDB, the Express API (`server/`), and the React SPA (`client/`). They can
all run one way with one command, or be split across managed hosts. This guide covers both.

The one design rule that shapes everything else: **serve the client and the API from the same
origin whenever you can.** The session lives in an httpOnly cookie; same-origin cookies are
`SameSite=Lax` and work with no extra client or server configuration. A cross-domain split works,
but it forces `SameSite=None; Secure` and a client change, and one misstep reads in the browser as
"cannot reach the server" or an infinite login loop.

---

## 1. One-command local/remote stack (Docker Compose)

Verified with `docker compose config`. Requires Docker with the compose plugin.

```sh
# server/.env is where every secret lives. cp server/.env.example server/.env and fill it in:
#   - JWT_SECRET (required; the server refuses to boot without it)
#   - MONGO_URL can stay unset/empty: compose pins it to the mongo service
docker compose up --build -d
```

What that starts:

| Service  | Image / build              | Reachable at                | Notes |
| --- | --- | --- | --- |
| `mongo`  | `mongo:8`                  | not published               | Data in the `mongo_data` volume; healthchecked with `db.adminCommand('ping')`. |
| `api`    | `./server/Dockerfile`      | not published               | Refuses to boot without `MONGO_URL` and `JWT_SECRET`. Healthchecked on `/health`. |
| `proxy`  | `client/Dockerfile` (nginx)| **http://localhost:8080**   | Serves the SPA, proxies `/api/*` to `api:3000/`, SPA-fallback to `index.html`. |

The proxy is the only published service, deliberately: the API's per-address rate limit reads the
client address from `X-Forwarded-For` (one trusted hop, `app.js` sets `trust proxy 1`), so
publishing the API directly would let callers pick their own address and walk around the limit.

Environment variables compose passes through:

- `MONGO_URL` — pinned to `mongodb://mongo:27017/clario` inside the network (the value in
  `server/.env` is for local dev only).
- `CLIENT_ORIGIN` — `${CLIENT_ORIGIN:-http://localhost:8080}`. Must be the proxy origin exactly
  (scheme, host, port), or every browser request is refused by CORS.
- `JWT_SECRET`, LLM settings, `RATE_LIMIT_MAX` — from `server/.env` via `env_file` (never from
  `environment:` with a blank default, which would override the file with `""`).
- `PORT` — API listen port, from `server/.env` (default 3000).
- `VITE_API_URL` — build arg for the SPA; default `/api` (same origin through the proxy). If you
  front the API elsewhere, build with `VITE_API_URL=https://api.example.com docker compose build proxy`.

After the first `up`, create the admin account (see §6).

**Verify what is deployed:** `docker compose ps` — `api` should report `(healthy)`; then
`curl -s http://localhost:8080/api/health` → `{"status":"ok"}`.

---

## 2. Backend: Render / Railway

Both platforms run `node index.js` unchanged; the server binds all interfaces on `process.env.PORT`
(Render and Railway both inject `PORT`).

### Render (Web Service)

1. New → Web Service → connect the repo → root directory `server`.
2. Runtime: Node. Build `npm ci`, start: `npm start`. (Or Docker: set Dockerfile path to
   `server/Dockerfile`; the container listens on `$PORT`.)
3. Health check path: `/health` → `{"status":"ok"}` (Render uses it to gate deploys).
4. Environment variables (Settings → Environment): see the table below. Never paste secrets into
   the repo.
5. Region: pick the one nearest your Atlas cluster (§3) to keep round-trips cheap.

### Railway

1. New Project → Deploy from Repo → set root directory to `server` (or use the server Dockerfile).
2. Start command: `npm start`; no Dockerfile switch needed if nixpacks picks it up.
3. Networking → Generate Domain; then set it as `CLIENT_ORIGIN` goes on the **static site** side,
   and use this domain as the API base (§4).
4. Variables: same as the table below; `PORT` is injected by Railway, leave it unset.

In both cases the platform terminates TLS. Set `NODE_ENV=production` and `COOKIE_SECURE` stays
correct automatically (§5).

### Environment variables

| Variable | Required | Example | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | `production` | Turns on `Secure` cookies by default; default `lax` SameSite. |
| `PORT` | platform-injected | `10000` | Default 3000. Do not set on Render/Railway. |
| `MONGO_URL` | yes | `mongodb+srv://clario_app:***@cluster0.xxxxx.mongodb.net/clario?retryWrites=true&w=majority` | See §3 for the Atlas side. |
| `JWT_SECRET` | yes | `<48 random bytes hex>` | Generate, never invent: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. ≥32 chars. |
| `JWT_EXPIRES_IN` | no | `7d` | Cookie lifetime. |
| `COOKIE_SECURE` | no | `true` | Blank follows `NODE_ENV`. Set `true` explicitly if TLS ends at the proxy but `NODE_ENV` isn't `production`. |
| `COOKIE_SAME_SITE` | no | `none` | Blank follows `NODE_ENV` (`none` in production, `lax` otherwise). `none` ⇒ Secure is required by browsers. See §5. |
| `CLIENT_ORIGIN` | yes | `https://clario.vercel.app` | Exact origin, no wildcard. Must match the SPA origin the browser sends. |
| `LLM_BASE_URL` | yes | `https://strata.example.com/v1` | See §7. No web search/fetch is wired up anywhere. |
| `LLM_MODEL` | yes | `your-model-id` | As reported by `GET $LLM_BASE_URL/models`. |
| `LLM_API_KEY` | no | `<key>` | Omit for an open local server. Never goes to the client. |
| `LLM_TIMEOUT_MS` | no | `90000` | Raise if your model needs longer (240000 is used for the demo box). |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | no | `60` / `60000` | Raise both for a lab demo behind a shared NAT. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | one-time for §6 | — | Used by the seeding script only; not read by the request path. |

Generate `JWT_SECRET` first; everything else depends on it existing.

---

## 3. MongoDB Atlas

Nothing in the code is Atlas-specific — mongoose speaks `mongodb+srv://` (that's the Node mongodb
driver's SRV support) — but the cluster needs three things set correctly:

1. **Cluster.** Atlas → Build a Database → **M0 free tier** is enough for the demo. Region nearest
   the API host.
2. **Network access.** Atlas → Network Access → Add IP Address. Render and Railway do not publish
   stable egress IPs, so the usual answer is `0.0.0.0/0`. That is acceptable **because** the
   database user below is scoped and TLS is mandatory — it is not acceptable with the default
   `atlasAdmin` user or a weak password. If your platform offers private egress (Render static IP
   add-on, Railway with an egress service), restrict the rule to that CIDR instead.
3. **Dedicated database user.** Atlas → Database Access → Add New Database User. Name it
   `clario_app`, auth method *Password* (generated by Atlas), role **`readWrite` on the `clario`
   database only** (never "atlasAdmin", never "readWriteAnyDatabase"). Copy the connection string
   it offers and flip the placeholder password:

   ```
   mongodb+srv://clario_app:<password>@cluster0.xxxxx.mongodb.net/clario?retryWrites=true&w=majority
   ```

   Put it in the backend host's env vars as `MONGO_URL` and nowhere else. The server logs the URL
   only through `redactUrl()` (never with the password), so a missing password shows up as
   `auth failed` at boot, not as a leaked credential.

The free tier pauses after inactivity on some configs — check the Atlas cluster state if the first
request of the day hangs until the API's reconnect logic catches up.

---

## 4. Frontend: Vercel / Netlify

Build-time variable only: `VITE_API_URL` is baked into the bundle by Vite and cannot be changed
without a rebuild.

### Vercel

1. Import the repo → set **Root Directory** to `client`.
2. Framework preset: Vite. Build `npm run build`, output `dist`.
3. Environment variable: `VITE_API_URL=https://<your-render-api>.onrender.com` (no trailing slash).
4. **SPA rewrite** — `client/vercel.json` (create it in the client repo):
   ```json
   { "rewrites": [{ "source": "/((?!api).*)", "destination": "/index.html" }] }
   ```
   Without it, a hard refresh on `/plan/abc` 404s because there is no such file.

   Better when possible: keep the API same-origin instead of cross-domain —
   ```json
   {
     "rewrites": [
       { "source": "/api/:path*", "destination": "https://<your-render-api>.onrender.com/:path*" },
       { "source": "/((?!api).*)", "destination": "/index.html" }
     ]
   }
   ```
   and set `VITE_API_URL=/api`. Then cookies are same-origin `SameSite=Lax` and no cookie settings
   need to change. This is the recommended path.

### Netlify

1. Base directory `client`, build `npm run build`, publish `dist`.
2. Environment variable: `VITE_API_URL` as above (`/api` for the same-origin option, full URL otherwise).
3. **SPA rewrite** — `client/public/_redirects`:
   ```
   /api/*  https://<your-render-api>.onrender.com/:splat  200
   /*      /index.html                                      200
   ```
   (Delete the `/api/*` line and keep only the SPA fallback to force full cross-domain mode.)

---

## 5. Cross-site cookies: `SameSite=None; Secure`

The login cookie (`clario_token`) is httpOnly. Its privacy policy is set server-side and is
already environment-configurable — there is code for this; you only flip variables:

| Variable | Effect |
| --- | --- |
| `COOKIE_SECURE=true` | adds `Secure` (browser sends the cookie only over HTTPS). |
| `COOKIE_SAME_SITE=none` | allows the cookie on cross-site requests. Requires Secure in all modern browsers. |
| `NODE_ENV=production` | alone flips both to their cross-site-safe values (`Secure`, `SameSite=None`). |

And on the API, CORS (`app.js`) is `origin: CLIENT_ORIGIN, credentials: true` — the browser then
accepts the cookie only when the exact origin matches and the fetch is made with credentials.

Non-negotiable pair, or the browser silently drops the cookie:
`SameSite=None` **must** come with `Secure`, and the page must be HTTPS end to end.

**The client half is not optional.** `client/src/api.js` currently calls `fetch(url, init)` with no
`credentials: "include"`. On the **same-origin** topology (nginx proxy in compose, or the Vercel/
Netlify `/api` rewrite above) the browser sends the cookie anyway because it is same-origin — that
is the path this repo is known to work on. A truly cross-domain deployment (`app.vercel.app`
fetching `api.onrender.com` directly) additionally requires the client to send every request with
`credentials: "include"`, e.g.:

```js
const response = await fetch(`${BASE}${path}`, { ...init, credentials: "include" });
```

and the `CLIENT_ORIGIN` on the backend to be exactly the Vercel origin. That is a client code
change (Milestone R3), call it out in the demo notes rather than "fixing" it on either side
unilaterally. If you cannot change the client before the demo, use the same-origin topology.

`logout` clears the cookie with the same flags, so a `SameSite=None; Secure` session is actually
deleted, not shadowed.

---

## 6. Health checks and admin seeding

**Health:** `GET /health` → `200 {"status":"ok"}`. It is mounted *before* the rate limiter, so a
monitor cannot be throttled, and both Docker healthchecks (server image and compose `api`) and the
Render/Railway health checks hit it. `curl -i https://<api>/health` after every deploy.

**Seeding the admin:** the database starts empty. Once `MONGO_URL` points at a reachable Mongo and
the API is up, create the admin user the roles are checked against:

```sh
# in server/, with .env (or the platform's env) containing ADMIN_EMAIL and ADMIN_PASSWORD
npm run seed-admin
```

- It creates (or resets) one account with `role: "admin"` and a bcrypt hash.
- Plain-text password is read from the environment, printed **never**, and only stored hashed.
- Run it once per environment. Re-run to reset the password; it does not touch students.
- Leave `ADMIN_EMAIL`/`ADMIN_PASSWORD` blank everywhere afterwards if you don't want re-runs to
  change anything (the script refuses to run without both).
- Sign in at the SPA, and the admin views (`/admin/packs`, `/admin/users`, `/admin/analytics`) open.

---

## 7. LLM connectivity (Strata) for the demo

`llm.js` streams from any OpenAI-compatible `POST $LLM_BASE_URL/chat/completions`; only the base URL,
model id and optional key are configured. The demo must reach its model without opening it to the
public internet.

**Option A — self-hosted Strata behind a protected tunnel (what the demo rig uses):**

1. Strata runs on the machine with the model (localhost:8080 or similar). It has **no auth of its
   own** — never publish its port directly.
2. Expose it through an authenticating tunnel — Cloudflare Tunnel with Access (email/OIDC) is the
   path already in use (`strata.lakshya9461.in`); ngrok with OAuth/basic-auth or a Tailscale Funnel +
   ACLs is equivalent. The tunnel, not Strata, asks for credentials.
3. Point the backend at it: `LLM_BASE_URL=https://strata.lakshya9461.in/v1`,
   `LLM_MODEL=<id from GET $LLM_BASE_URL/models>`, `LLM_API_KEY` only when the tunnel issues one
   (never commit it; it lives in the backend env only).

**Option B — hosted provider:** OpenAI/Anthropic-compatible endpoint, same variables; keep
`LLM_MODEL` exact and raise `LLM_TIMEOUT_MS` for the big generation prompts.

Facts that make or break the demo:

- Streaming is required; the Strata proxy kills a completion that is silent for ~100 s, which is why
  every call sets `stream: true` (`LLM_TIMEOUT_MS` covers the rest).
- `LLM_TIMEOUT_MS=240000` is used on the demo box for whole-pack generation.
- 2 requests in flight / queue of 3; beyond that the API answers `503 busy`, not a degraded reply —
  that is a full-queue signal, retry, do not "fix" it by retrying faster.
- A tunnel that answers 524 (~100 s) will fail whole-pack generation; pre-generate packs before the
  demo with `npm run generate:preview` rather than generating in front of the room.
- Bring-your-own-key for hosted providers is out of scope for the beta.

---

## 8. Smoke-test checklist before the demo

- [ ] `docker compose config` on the checkout that deploys.
- [ ] `curl https://<api>/health` → `{"status":"ok"}`.
- [ ] SPA loads at the public URL, hard refresh on `/` and on a deep link (`/plan/x`) works (SPA rewrite).
- [ ] Register a student; log out; log in; wrong password gives a JSON 401, not an HTML error page.
- [ ] `npm run seed-admin` done; admin opens packs/users/analytics; student gets 403 on `/admin/*`.
- [ ] One full session: plan → lesson → check → model, watching for `degraded: true` banners.
- [ ] Load page with dev tools → Network: `clario_token` cookie is `HttpOnly`, `Secure`, and
      `SameSite` per the topology you chose (`Lax` same-origin / `None` cross-domain).
- [ ] Server logs show `Mongo connected` / connection failures with the URL **redacted** — if you
      ever see credentials in a log, rotate them.
