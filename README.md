# SafariMatcher Super Dashboard (Free + Fast + Pretty)

This project gives you a **single analytics dashboard** that pulls real data from:

- ✅ **Google Search Console** (required)
- ✅ **Cloudflare Analytics** (required)
- ✅ **AI Insights** via **Cloudflare Workers AI** (optional but recommended)
- ➕ **Google Analytics (GA4)** (optional)
- ⚠️ **SEMrush / GoDaddy analytics**: not included as first-class APIs because they’re not reliably free/public. (You can still add them later.)

**Architecture (recommended):**
- **Frontend (static):** GitHub Pages (from the `docs/` folder)
- **Backend (secure):** Cloudflare Worker (from the `worker/` folder)

Why: GitHub Pages can’t safely store API keys. The Worker keeps secrets on the server side and returns clean JSON to your dashboard.

---

## What’s in the ZIP

- `docs/` → the dashboard UI (HTML/CSS/JS, zero build step)
- `worker/` → a Cloudflare Worker API that:
  - calls Cloudflare + Google APIs securely
  - caches responses at the edge for a few minutes to avoid rate limits
  - generates AI insights through Workers AI

---

## Step-by-step setup (Production)

### 0) Prereqs
- A Cloudflare account (your domain already uses Cloudflare ✅)
- A GitHub account
- A computer with Node.js installed (only needed to deploy the Worker)

---

## 1) Deploy the backend (Cloudflare Worker API)

### 1A) Create a Cloudflare Analytics API token
In Cloudflare:
- Profile → **API Tokens** → **Create Token**
- Use a custom token with:
  - **Account → Account Analytics → Read**
  - **Zone Resources → Include → Specific zone → safarimatcher.com** (or all zones if you prefer)

Also grab your **Zone ID** for `safarimatcher.com` (Cloudflare dashboard → domain → Overview).

### 1B) Create a Google Service Account for Search Console (required)
In Google Cloud Console:
- Create a project
- Enable **Google Search Console API**
- Create a **Service Account**
- Create a **JSON key** for it

In Google Search Console:
- Choose your property (domain or URL-prefix)
- Add the service account email as a user with permission to view data

You will use:
- `GSC_SITE_URL` = either
  - `sc-domain:safarimatcher.com` (domain property)
  - OR `https://safarimatcher.com/` (URL-prefix property)

### 1C) (Optional) Enable GA4
Only if you want GA4:
- Enable **Google Analytics Data API**
- Add the same service account email in GA4 → **Property access management** as Viewer
- Get your GA4 Property ID

### 1D) Deploy the Worker
1) Open a terminal in the `worker/` folder
2) Install Wrangler:
   ```bash
   npm install
   ```
3) Login to Cloudflare:
   ```bash
   npx wrangler login
   ```
4) Edit `worker/wrangler.toml` and set:
   - `name = "safarimatcher-dashboard-api"` (or any name you like)
   - `CF_ZONE_ID`
   - `GSC_SITE_URL`
   - optionally `GA4_PROPERTY_ID`

5) Set secrets (DO NOT commit these):
   ```bash
   npx wrangler secret put CF_API_TOKEN
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
   ```

   When prompted for `GOOGLE_SERVICE_ACCOUNT_JSON`, paste the entire service account JSON.

6) Deploy:
   ```bash
   npx wrangler deploy
   ```

Wrangler will print a URL like:
`https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev`

That URL is your dashboard backend.

---

## 2) Deploy the frontend (GitHub Pages)

### 2A) Create a new GitHub repo
- Create a repo (public or private)
- Upload the entire project (including `docs/` and `worker/`)

### 2B) Set the API base URL
Edit:
- `docs/config.js`

Set:
```js
API_BASE_URL: "https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev"
```

Commit + push.

### 2C) Enable GitHub Pages (from `/docs`)
In GitHub:
- Repo → Settings → Pages
- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/docs`

Your dashboard will be live at:
`https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPO/`

---

## 3) Lock down CORS (recommended)
After your dashboard URL is live, lock the Worker to only allow that origin:

In `worker/wrangler.toml`:
```toml
CORS_ORIGIN = "https://YOUR-GITHUB-USERNAME.github.io"
```

Then redeploy:
```bash
npx wrangler deploy
```

---

## Local development (optional)
### Worker
Copy:
- `worker/.dev.vars.example` → `worker/.dev.vars`
Fill the values and run:
```bash
cd worker
npm install
npm run dev
```

### Frontend
Serve `docs/` locally (any static server works):
```bash
cd docs
python3 -m http.server 4173
```

Then open:
http://localhost:4173

---

## Troubleshooting

### “Invalid siteUrl” in Search Console
Your `GSC_SITE_URL` must match your Search Console property **exactly**:
- Domain property: `sc-domain:safarimatcher.com`
- URL-prefix: `https://safarimatcher.com/`

### “Not authorized” from Google
Make sure the service account email was added in:
- Search Console property permissions
- GA4 property access management (if using GA4)

### Cloudflare data is empty
Make sure:
- The zone is in Cloudflare
- The API token includes **Account Analytics: Read** and access to the zone
- The selected date range contains traffic

---

## Safe notes
- The `docs/` frontend contains **no secrets**.
- All secrets live in Cloudflare Worker environment variables (Wrangler secrets).
- Business ledger entries are **local-only** (browser localStorage).

Enjoy. Make it weird. Make it useful.
