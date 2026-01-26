/**
 * SafariMatcher Super Dashboard API (Cloudflare Worker)
 * - Proxies provider APIs so you never expose secrets in the browser.
 * - Adds lightweight caching (Cloudflare edge cache) to avoid rate limits.
 *
 * Secrets (set via `wrangler secret put ...`):
 *   - CF_API_TOKEN
 *   - GOOGLE_SERVICE_ACCOUNT_JSON
 *
 * Non-secret vars (set in wrangler.toml [vars] or Cloudflare dashboard):
 *   - CF_ZONE_ID
 *   - GSC_SITE_URL
 *   - GA4_PROPERTY_ID (optional)
 *   - CORS_ORIGIN (optional)
 *   - AI_MODEL (optional)
 *
 * Docs:
 * - Cloudflare GraphQL Analytics endpoint: https://api.cloudflare.com/client/v4/graphql
 * - Google Search Console Search Analytics query: https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
 * - GA4 Data API runReport: https://analyticsdata.googleapis.com/v1beta/properties/{propertyId}:runReport
 */

/** @typedef {{ CF_API_TOKEN?: string, CF_ZONE_ID?: string, GOOGLE_SERVICE_ACCOUNT_JSON?: string, GSC_SITE_URL?: string, GA4_PROPERTY_ID?: string, CORS_ORIGIN?: string, AI_MODEL?: string, AI?: any }} Env */

const VERSION = "2026-01-25";

// ---------- Small utilities ----------
const encoder = new TextEncoder();

/**
 * @param {string} s
 * @returns {ArrayBuffer}
 */
function utf8ToBuf(s) {
  return encoder.encode(s).buffer;
}

/**
 * @param {ArrayBuffer} buf
 * @returns {string}
 */
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  // btoa expects "binary string"
  const b64 = btoa(str);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * @param {string} s
 * @returns {Promise<string>}
 */
async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", utf8ToBuf(s));
  const bytes = new Uint8Array(digest);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} pem
 * @returns {ArrayBuffer}
 */
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * @param {any} data
 * @param {number} status
 * @param {Record<string,string>} extraHeaders
 */
function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

/**
 * @param {Response} resp
 * @param {Request} request
 * @param {Env} env
 */
function withCors(resp, request, env) {
  const origin = request.headers.get("Origin") || "";
  const allow = pickCorsOrigin(origin, env?.CORS_ORIGIN);

  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", allow);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

/**
 * @param {string} requestOrigin
 * @param {string|undefined} corsOriginVar
 */
function pickCorsOrigin(requestOrigin, corsOriginVar) {
  // Default: permissive (you can lock it down later)
  if (!corsOriginVar || corsOriginVar.trim() === "" || corsOriginVar.trim() === "*") return "*";

  const allowed = corsOriginVar
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // If request has no Origin header (curl/server), allow '*'
  if (!requestOrigin) return "*";

  return allowed.includes(requestOrigin) ? requestOrigin : allowed[0] || "*";
}

/**
 * @param {Request} request
 * @param {Env} env
 */
function handleOptions(request, env) {
  // Preflight response
  return withCors(new Response(null, { status: 204 }), request, env);
}

/**
 * @param {Request} request
 */
async function readJson(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return {};
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function mustYmd(name, value) {
  if (!isYmd(value)) throw new Error(`Invalid ${name}. Expected YYYY-MM-DD.`);
}

/**
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @returns {{ startIso: string, endIsoExclusive: string }}
 */
function ymdToIsoRange(startDate, endDate) {
  // Cloudflare uses Z timestamps; treat dates as full days.
  // endIsoExclusive = next day at 00:00Z (datetime_lt)
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const endExclusive = new Date(end.getTime() + 24 * 60 * 60 * 1000);

  return {
    startIso: start.toISOString(),
    endIsoExclusive: endExclusive.toISOString(),
  };
}

// ---------- Google service account auth (JWT -> OAuth2 access token) ----------
/**
 * In-memory token cache (per isolate).
 * key: scopesString
 * value: { access_token: string, expMs: number }
 */
const googleTokenCache = new Map();

/**
 * @param {Env} env
 */
function getServiceAccount(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    return JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
}

/**
 * @param {Env} env
 * @param {string[]} scopes
 * @returns {Promise<string>} access token
 */
async function getGoogleAccessToken(env, scopes) {
  const sa = getServiceAccount(env);
  if (!sa) throw new Error("Google is not configured (missing GOOGLE_SERVICE_ACCOUNT_JSON).");

  const scopesStr = scopes.join(" ");
  const cacheKey = scopesStr;
  const cached = googleTokenCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expMs - now > 60_000) return cached.access_token;

  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: scopesStr,
    aud: tokenUri,
    iat,
    exp,
  };

  const signingInput =
    bufToBase64Url(utf8ToBuf(JSON.stringify(header))) +
    "." +
    bufToBase64Url(utf8ToBuf(JSON.stringify(payload)));

  const keyData = pemToArrayBuffer(sa.private_key);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    utf8ToBuf(signingInput)
  );

  const jwt = signingInput + "." + bufToBase64Url(signature);

  const form = new URLSearchParams();
  form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  form.set("assertion", jwt);

  const resp = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Google token exchange failed (${resp.status}): ${data?.error || "unknown error"}`);
  }

  const access_token = data.access_token;
  const expires_in = Number(data.expires_in || 3600);
  googleTokenCache.set(cacheKey, { access_token, expMs: now + expires_in * 1000 });

  return access_token;
}

// ---------- Cloudflare GraphQL ----------
/**
 * @param {Env} env
 * @param {string} query
 * @param {any} variables
 */
async function cfGraphQL(env, query, variables) {
  if (!env.CF_API_TOKEN) throw new Error("Cloudflare is not configured (missing CF_API_TOKEN).");
  if (!env.CF_ZONE_ID) throw new Error("Cloudflare is not configured (missing CF_ZONE_ID).");

  const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "content-type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await resp.json();
  if (!resp.ok || data?.errors) {
    const msg = data?.errors?.[0]?.message || "Cloudflare GraphQL request failed";
    throw new Error(`${msg}`);
  }
  return data?.data;
}

// ---------- Caching wrapper ----------
/**
 * @param {ExecutionContext} ctx
 * @param {string} namespace
 * @param {string} bodyStr
 * @param {number} ttlSeconds
 * @param {() => Promise<any>} compute
 */
async function cached(ctx, namespace, bodyStr, ttlSeconds, compute) {
  const hash = await sha256Hex(bodyStr);
  const cacheKey = new Request(`https://cache.safarimatcher.local/${namespace}?h=${hash}`, { method: "GET" });

  const hit = await caches.default.match(cacheKey);
  if (hit) return { response: hit, cached: true };

  const data = await compute();
  const resp = json(data, 200, { "cache-control": `public, max-age=${ttlSeconds}` });
  ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
  return { response: resp, cached: false };
}

// ---------- Provider handlers ----------
async function handleCloudflareDaily(request, env, ctx) {
  const body = await readJson(request);
  const { startDate, endDate } = body;
  mustYmd("startDate", startDate);
  mustYmd("endDate", endDate);

  const bodyStr = JSON.stringify({ startDate, endDate });

  const { response, cached: wasCached } = await cached(ctx, "cf_daily", bodyStr, 300, async () => {
    const query = `
      query($zoneTag: string, $since: string, $until: string) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            httpRequests1dGroups(limit: 370, filter: { date_geq: $since, date_leq: $until }) {
              dimensions { date }
              sum { requests bytes cachedRequests cachedBytes }
            }
          }
        }
      }
    `;

    const data = await cfGraphQL(env, query, {
      zoneTag: env.CF_ZONE_ID,
      since: startDate,
      until: endDate,
    });

    const groups = data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
    const series = groups.map((g) => ({
      date: g?.dimensions?.date,
      requests: Number(g?.sum?.requests || 0),
      bytes: Number(g?.sum?.bytes || 0),
      cachedRequests: Number(g?.sum?.cachedRequests || 0),
      cachedBytes: Number(g?.sum?.cachedBytes || 0),
    }));

    return { series };
  });

  return withCors(
    responseWithMeta(response, { cached: wasCached }),
    request,
    env
  );
}

async function handleCloudflareCountries(request, env, ctx) {
  const body = await readJson(request);
  const { startDate, endDate, limit } = body;
  mustYmd("startDate", startDate);
  mustYmd("endDate", endDate);

  const lim = Math.min(Math.max(Number(limit || 10), 1), 50);

  const bodyStr = JSON.stringify({ startDate, endDate, lim });

  const { response, cached: wasCached } = await cached(ctx, "cf_countries", bodyStr, 900, async () => {
    const { startIso, endIsoExclusive } = ymdToIsoRange(startDate, endDate);

    const query = `
      query($zoneTag: string, $start: Time, $end: Time, $limit: Int) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            series: httpRequestsAdaptiveGroups(
              limit: $limit
              orderBy: [count_DESC]
              filter: { datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball" }
            ) {
              count
              sum { edgeResponseBytes }
              dimensions { clientCountryName }
            }
          }
        }
      }
    `;

    const data = await cfGraphQL(env, query, {
      zoneTag: env.CF_ZONE_ID,
      start: startIso,
      end: endIsoExclusive,
      limit: lim,
    });

    const rows = data?.viewer?.zones?.[0]?.series || [];
    const countries = rows
      .map((r) => ({
        country: r?.dimensions?.clientCountryName || "Unknown",
        requests: Number(r?.count || 0),
        bytes: Number(r?.sum?.edgeResponseBytes || 0),
      }))
      .filter((r) => r.requests > 0);

    return { countries };
  });

  return withCors(
    responseWithMeta(response, { cached: wasCached }),
    request,
    env
  );
}

/**
 * @param {string} endpoint
 * @param {Env} env
 * @param {any} payload
 * @param {string[]} scopes
 */
async function googlePostJson(endpoint, env, payload, scopes) {
  const token = await getGoogleAccessToken(env, scopes);
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  if (!resp.ok) {
    const msg = data?.error?.message || `Google API request failed (${resp.status})`;
    throw new Error(msg);
  }
  return data;
}

async function handleGsc(request, env, ctx, mode) {
  if (!env.GSC_SITE_URL) throw new Error("Missing GSC_SITE_URL (Search Console property).");

  const body = await readJson(request);
  const { startDate, endDate, limit, searchType } = body;
  mustYmd("startDate", startDate);
  mustYmd("endDate", endDate);

  const lim = Math.min(Math.max(Number(limit || 10), 1), 250);
  const type = (searchType || "web").toLowerCase(); // web | image | video | news | discover, etc.

  let dimensions = ["date"];
  if (mode === "topQueries") dimensions = ["query"];
  if (mode === "topPages") dimensions = ["page"];
  if (mode === "devices") dimensions = ["device"];

  const bodyStr = JSON.stringify({ startDate, endDate, lim, type, dimensions });

  const cacheNs = `gsc_${mode}`;
  const ttl = mode === "summary" ? 300 : 1800;

  const { response, cached: wasCached } = await cached(ctx, cacheNs, bodyStr, ttl, async () => {
    const siteUrl = env.GSC_SITE_URL;

    const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
      siteUrl
    )}/searchAnalytics/query`;

    const payload = {
      startDate,
      endDate,
      dimensions,
      rowLimit: mode === "summary" ? 1000 : lim,
      type,
      dataState: "final",
    };

    const data = await googlePostJson(endpoint, env, payload, [
      "https://www.googleapis.com/auth/webmasters.readonly",
    ]);

    const rows = (data?.rows || []).map((r) => ({
      keys: r.keys || [],
      clicks: Number(r.clicks || 0),
      impressions: Number(r.impressions || 0),
      ctr: Number(r.ctr || 0),
      position: Number(r.position || 0),
    }));

    if (mode === "summary") {
      const daily = rows.map((r) => ({
        date: r.keys?.[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }));

      const totals = summarizeGscRows(daily);

      return { rows: daily, totals };
    }

    if (mode === "topQueries") {
      return {
        rows: rows.map((r) => ({
          query: r.keys?.[0],
          ...r,
        })),
      };
    }

    if (mode === "topPages") {
      return {
        rows: rows.map((r) => ({
          page: r.keys?.[0],
          ...r,
        })),
      };
    }

    if (mode === "devices") {
      return {
        rows: rows.map((r) => ({
          device: r.keys?.[0],
          ...r,
        })),
      };
    }

    return { rows };
  });

  return withCors(
    responseWithMeta(response, { cached: wasCached }),
    request,
    env
  );
}

function summarizeGscRows(rows) {
  const clicks = rows.reduce((a, r) => a + (Number(r.clicks) || 0), 0);
  const impressions = rows.reduce((a, r) => a + (Number(r.impressions) || 0), 0);
  const ctr = impressions > 0 ? clicks / impressions : 0;

  // Weighted avg position by impressions (more honest than arithmetic mean).
  const weightedPosNum = rows.reduce((a, r) => a + (Number(r.position) || 0) * (Number(r.impressions) || 0), 0);
  const weightedPos = impressions > 0 ? weightedPosNum / impressions : 0;

  return { clicks, impressions, ctr, position: weightedPos };
}

async function handleGa4Summary(request, env, ctx) {
  if (!env.GA4_PROPERTY_ID || !String(env.GA4_PROPERTY_ID).trim()) {
    return withCors(json({ error: "GA4 not configured (set GA4_PROPERTY_ID)." }, 400), request, env);
  }

  const body = await readJson(request);
  const { startDate, endDate } = body;
  mustYmd("startDate", startDate);
  mustYmd("endDate", endDate);

  const bodyStr = JSON.stringify({ startDate, endDate });

  const { response, cached: wasCached } = await cached(ctx, "ga4_summary", bodyStr, 300, async () => {
    const propertyId = String(env.GA4_PROPERTY_ID).trim();
    const endpoint = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(
      propertyId
    )}:runReport`;

    const payload = {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }],
      keepEmptyRows: false,
    };

    const data = await googlePostJson(endpoint, env, payload, [
      "https://www.googleapis.com/auth/analytics.readonly",
    ]);

    const rows = (data?.rows || []).map((r) => ({
      date: r?.dimensionValues?.[0]?.value,
      sessions: Number(r?.metricValues?.[0]?.value || 0),
      users: Number(r?.metricValues?.[1]?.value || 0),
      pageviews: Number(r?.metricValues?.[2]?.value || 0),
    }));

    const totals = {
      sessions: rows.reduce((a, r) => a + r.sessions, 0),
      users: rows.reduce((a, r) => a + r.users, 0),
      pageviews: rows.reduce((a, r) => a + r.pageviews, 0),
    };

    return { rows, totals };
  });

  return withCors(
    responseWithMeta(response, { cached: wasCached }),
    request,
    env
  );
}

async function handleAiInsights(request, env, ctx) {
  const body = await readJson(request);
  const payload = body || {};

  if (!env.AI) {
    return withCors(json({ error: "Workers AI binding is not configured on this Worker." }, 400), request, env);
  }

  const model = (env.AI_MODEL && String(env.AI_MODEL).trim()) || "@cf/meta/llama-3.1-8b-instruct-fast";

  const prompt = buildInsightsPrompt(payload);

  const bodyStr = JSON.stringify({ model, prompt });

  const { response, cached: wasCached } = await cached(ctx, "ai_insights", bodyStr, 900, async () => {
    const messages = [
      {
        role: "system",
        content:
          "You are a pragmatic analytics & growth strategist. Be direct, prioritize impact, and avoid fluff.",
      },
      { role: "user", content: prompt },
    ];

    const result = await env.AI.run(model, { messages });

    // Cloudflare's return shape can vary by model; normalize to text.
    const text =
      (typeof result === "string" ? result : null) ||
      result?.response ||
      result?.result?.response ||
      result?.output_text ||
      JSON.stringify(result);

    return { text };
  });

  return withCors(
    responseWithMeta(response, { cached: wasCached }),
    request,
    env
  );
}

function buildInsightsPrompt(payload) {
  const { range, summary, alerts, top } = payload || {};
  const safe = (x) => (x === undefined ? null : x);

  return `
SafariMatcher analytics dashboard.

Your job:
1) Explain what changed vs the previous period (if provided).
2) List 5 high-impact actions for the next 7 days.
3) List 5 high-impact actions for the next 30 days.
4) Provide 3 "watch-outs" (risks / measurement pitfalls).
5) Suggest ONE north-star metric and why.

Rules:
- Be concise.
- Use bullets.
- Be specific: mention metrics, percentages, and where the change came from.
- If data is missing, say what's missing and how to instrument it.

INPUT (JSON):
${JSON.stringify({ range: safe(range), summary: safe(summary), alerts: safe(alerts), top: safe(top) }, null, 2)}
`.trim();
}

/**
 * Adds meta fields without losing the body stream.
 * @param {Response} resp
 * @param {any} meta
 */
async function responseWithMeta(resp, meta) {
  // resp.body might be locked; easiest: read + rebuild.
  const data = await resp.json().catch(() => ({}));
  return json({ ...data, __meta: meta }, resp.status, Object.fromEntries(resp.headers.entries()));
}

// ---------- Router ----------
export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return handleOptions(request, env);

      if (url.pathname === "/api/health") {
        const sources = {
          cloudflare: Boolean(env.CF_ZONE_ID && env.CF_API_TOKEN),
          gsc: Boolean(env.GSC_SITE_URL && env.GOOGLE_SERVICE_ACCOUNT_JSON),
          ga4: Boolean(env.GA4_PROPERTY_ID && env.GOOGLE_SERVICE_ACCOUNT_JSON),
          ai: Boolean(env.AI),
        };

        return withCors(
          json({
            ok: true,
            version: VERSION,
            worker: { version: VERSION, compatibility: env?.CF_COMPAT_DATE || null },
            sources,
          }),
          request,
          env
        );
      }

      // Only handle /api/*
      if (!url.pathname.startsWith("/api/")) {
        return withCors(json({ error: "Not found" }, 404), request, env);
      }

      // Basic method gating
      const isPost = request.method === "POST";
      const isGet = request.method === "GET";
      if (!isPost && !isGet) return withCors(json({ error: "Method not allowed" }, 405), request, env);

      // Routes
      if (url.pathname === "/api/cloudflare/daily" && isPost) return await handleCloudflareDaily(request, env, ctx);
      if (url.pathname === "/api/cloudflare/countries" && isPost) return await handleCloudflareCountries(request, env, ctx);

      if (url.pathname === "/api/gsc/summary" && isPost) return await handleGsc(request, env, ctx, "summary");
      if (url.pathname === "/api/gsc/top-queries" && isPost) return await handleGsc(request, env, ctx, "topQueries");
      if (url.pathname === "/api/gsc/top-pages" && isPost) return await handleGsc(request, env, ctx, "topPages");
      if (url.pathname === "/api/gsc/devices" && isPost) return await handleGsc(request, env, ctx, "devices");

      if (url.pathname === "/api/ga4/summary" && isPost) return await handleGa4Summary(request, env, ctx);

      if (url.pathname === "/api/ai/insights" && isPost) return await handleAiInsights(request, env, ctx);

      return withCors(json({ error: "Not found" }, 404), request, env);
    } catch (e) {
      const msg = e?.message || "Unknown error";
      return withCors(json({ error: msg }, 500), request, env);
    }
  },
};
