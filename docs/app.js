/* global Chart */

(() => {
  const cfg = window.CONFIG || window.SAFARI_DASH_CONFIG || {};
  const API_BASE_URL_RAW = (cfg.API_BASE_URL || "").trim();
  const API_BASE_URL = API_BASE_URL_RAW.replace(/\/$/, "");
  const PATH_PREFIX = (cfg.PATH_PREFIX || "").replace(/\/$/, "");

  const apiBase = () => {
    const base = API_BASE_URL && !API_BASE_URL.includes("[") ? API_BASE_URL : "";
    return (base + PATH_PREFIX).replace(/\/$/, "");
  };

  const $ = (id) => document.getElementById(id);

  // ---------- Toasts ----------
  function toast(title, body) {
    const stack = $("toastStack");
    if (!stack) return;

    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<div class="toastTitle"></div><div class="toastBody"></div>`;
    el.querySelector(".toastTitle").textContent = title;
    el.querySelector(".toastBody").textContent = body;

    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(6px)";
      el.style.transition = "opacity .2s ease, transform .2s ease";
      setTimeout(() => el.remove(), 220);
    }, 4200);
  }

  // ---------- Formatting ----------
  function fmt(n, opts = {}) {
    if (n === null || n === undefined) return "—";
    const x = Number(n);
    if (Number.isNaN(x)) return String(n);

    const { style, maxFrac } = opts;
    if (style === "percent") return `${(x * 100).toFixed(maxFrac ?? 1)}%`;
    if (style === "bytes") return fmtBytes(x);
    if (style === "money") return `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    return x.toLocaleString(undefined, {
      maximumFractionDigits: maxFrac ?? 0,
    });
  }

  function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let b = bytes;
    let i = 0;
    while (b >= 1024 && i < units.length - 1) {
      b /= 1024;
      i++;
    }
    const digits = i === 0 ? 0 : i === 1 ? 1 : 2;
    return `${b.toFixed(digits)} ${units[i]}`;
  }

  function pctDelta(cur, prev) {
    const c = Number(cur);
    const p = Number(prev);
    if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
    if (p === 0) {
      if (c === 0) return 0;
      return null; // undefined/infinite
    }
    return (c - p) / p;
  }

  function signedPct(delta) {
    if (delta === null || delta === undefined) return "—";
    const sign = delta > 0 ? "+" : "";
    return `${sign}${(delta * 100).toFixed(1)}%`;
  }

  function ymdLocal(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function parseYmd(ymd) {
    // Interpret as local date (not UTC) to avoid off-by-one confusion.
    const [y, m, d] = String(ymd).split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(ymd, days) {
    const dt = parseYmd(ymd);
    dt.setDate(dt.getDate() + days);
    return ymdLocal(dt);
  }

  function diffDaysInclusive(startYmd, endYmd) {
    const a = parseYmd(startYmd);
    const b = parseYmd(endYmd);
    const ms = b.getTime() - a.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
  }

  function defaultDates() {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 27); // inclusive 28 days
    $("startDate").value = ymdLocal(start);
    $("endDate").value = ymdLocal(end);
  }

  // ---------- API helpers ----------
  async function apiGet(path) {
    const base = apiBase();
    if (!base) throw new Error("API_BASE_URL is not set in docs/config.js");
    const r = await fetch(`${base}${path}`, { method: "GET" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `Request failed: ${r.status}`);
    return data;
  }

  async function apiPost(path, body) {
    const base = apiBase();
    if (!base) throw new Error("API_BASE_URL is not set in docs/config.js");
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `Request failed: ${r.status}`);
    return data;
  }

  // ---------- Charts ----------
  /** @type {Chart | null} */
  let gscChart = null;
  /** @type {Chart | null} */
  let cfChart = null;

  function ensureCharts() {
    if (!gscChart) {
      const ctx = $("gscChart");
      gscChart = new Chart(ctx, {
        type: "line",
        data: { labels: [], datasets: [] },
        options: {
          responsive: true,
          plugins: { legend: { labels: { color: "#EAF0FF" } } },
          scales: {
            x: { ticks: { color: "rgba(234,240,255,.7)" }, grid: { color: "rgba(255,255,255,.06)" } },
            y: { ticks: { color: "rgba(234,240,255,.7)" }, grid: { color: "rgba(255,255,255,.06)" } },
          },
        },
      });
    }

    if (!cfChart) {
      const ctx = $("cfChart");
      cfChart = new Chart(ctx, {
        type: "line",
        data: { labels: [], datasets: [] },
        options: {
          responsive: true,
          plugins: { legend: { labels: { color: "#EAF0FF" } } },
          scales: {
            x: { ticks: { color: "rgba(234,240,255,.7)" }, grid: { color: "rgba(255,255,255,.06)" } },
            y: { ticks: { color: "rgba(234,240,255,.7)" }, grid: { color: "rgba(255,255,255,.06)" } },
          },
        },
      });
    }
  }

  function setOverlay(id, show, text = "Loading…") {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("show", !!show);
  }

  // ---------- Rendering ----------
  function renderChips(health) {
    const sources = health?.sources || {};
    setChip("chipCf", sources.cloudflare);
    setChip("chipGsc", sources.gsc);
    setChip("chipGa4", sources.ga4);
    setChip("chipAi", sources.ai);
  }

  function setChip(id, on) {
    const el = $(id);
    if (!el) return;
    el.classList.remove("ok", "off");
    el.classList.add(on ? "ok" : "off");
  }

  function renderKpis(kpis) {
    const grid = $("kpiGrid");
    grid.innerHTML = "";

    for (const k of kpis) {
      const div = document.createElement("div");
      div.className = "kpi";
      div.innerHTML = `
        <div class="kpiTop">
          <div>
            <div class="kpiLabel"></div>
            <div class="kpiValue"></div>
          </div>
          <div class="badge" title=""></div>
        </div>
        <div class="kpiDelta"></div>
      `;

      div.querySelector(".kpiLabel").textContent = k.label;
      div.querySelector(".kpiValue").textContent = k.value;

      const badge = div.querySelector(".badge");
      badge.textContent = k.source || "—";
      badge.title = k.sourceHint || "";

      const deltaEl = div.querySelector(".kpiDelta");
      if (!k.deltaText || k.deltaText === "—") {
        deltaEl.textContent = "";
      } else {
        deltaEl.textContent = k.deltaText;
        deltaEl.classList.toggle("up", k.deltaClass === "up");
        deltaEl.classList.toggle("down", k.deltaClass === "down");
      }

      grid.appendChild(div);
    }
  }

  function renderTable(tableId, overlayId, rows, cols) {
    const table = $(tableId);
    const overlay = $(overlayId);
    const tbody = table.querySelector("tbody");
    tbody.innerHTML = "";

    if (!rows || !rows.length) {
      overlay.classList.remove("hide");
      overlay.textContent = "No data";
      return;
    }

    overlay.classList.add("hide");

    for (const r of rows) {
      const tr = document.createElement("tr");
      for (const c of cols) {
        const td = document.createElement("td");
        const v = c.value(r);
        td.textContent = v;
        if (c.className) td.className = c.className;
        if (c.title) td.title = c.title(r);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function renderAlerts(alerts) {
    const box = $("alertsBox");
    box.innerHTML = "";

    if (!alerts.length) {
      box.innerHTML = `<div class="empty">No alerts triggered. Either things are stable… or everything is on fire in a way that looks “normal.”</div>`;
      return;
    }

    for (const a of alerts) {
      const div = document.createElement("div");
      div.className = `alert ${a.level || ""}`;
      div.innerHTML = `<div class="alertTitle"></div><div class="alertBody"></div>`;
      div.querySelector(".alertTitle").textContent = a.title;
      div.querySelector(".alertBody").textContent = a.body;
      box.appendChild(div);
    }
  }

  // ---------- Core refresh ----------
  async function refreshAll() {
    const startDate = $("startDate").value;
    const endDate = $("endDate").value;
    const compare = $("compareToggle").checked;

    $("rangeHint").textContent = compare
      ? `${startDate} → ${endDate} (vs previous period)`
      : `${startDate} → ${endDate}`;

    setOverlay("gscChartOverlay", true);
    setOverlay("cfChartOverlay", true);

    $("queriesOverlay").classList.remove("hide");
    $("queriesOverlay").textContent = "Loading…";
    $("pagesOverlay").classList.remove("hide");
    $("pagesOverlay").textContent = "Loading…";
    $("devicesOverlay").classList.remove("hide");
    $("devicesOverlay").textContent = "Loading…";
    $("countriesOverlay").classList.remove("hide");
    $("countriesOverlay").textContent = "Loading…";

    // Clear AI output (keeps you from reading stale vibes)
    $("aiOut").textContent = "—";
    $("copyAiBtn").disabled = true;

    // Compute prev range
    let prev = null;
    if (compare) {
      const days = diffDaysInclusive(startDate, endDate);
      const prevEnd = addDays(startDate, -1);
      const prevStart = addDays(prevEnd, -(days - 1));
      prev = { startDate: prevStart, endDate: prevEnd };
    }

    // Make requests in parallel, but tolerate partial failure.
    const reqs = [
      // Health
      apiGet("/api/health").then((d) => ({ key: "health", ok: true, data: d })).catch((e) => ({ key: "health", ok: false, err: e })),

      // GSC
      apiPost("/api/gsc/summary", { startDate, endDate }).then((d) => ({ key: "gscSummary", ok: true, data: d })).catch((e) => ({ key: "gscSummary", ok: false, err: e })),
      apiPost("/api/gsc/top-queries", { startDate, endDate, limit: 10 }).then((d) => ({ key: "gscTopQueries", ok: true, data: d })).catch((e) => ({ key: "gscTopQueries", ok: false, err: e })),
      apiPost("/api/gsc/top-pages", { startDate, endDate, limit: 10 }).then((d) => ({ key: "gscTopPages", ok: true, data: d })).catch((e) => ({ key: "gscTopPages", ok: false, err: e })),
      apiPost("/api/gsc/devices", { startDate, endDate, limit: 10 }).then((d) => ({ key: "gscDevices", ok: true, data: d })).catch((e) => ({ key: "gscDevices", ok: false, err: e })),

      // Cloudflare
      apiPost("/api/cloudflare/daily", { startDate, endDate }).then((d) => ({ key: "cfDaily", ok: true, data: d })).catch((e) => ({ key: "cfDaily", ok: false, err: e })),
      apiPost("/api/cloudflare/countries", { startDate, endDate, limit: 12 }).then((d) => ({ key: "cfCountries", ok: true, data: d })).catch((e) => ({ key: "cfCountries", ok: false, err: e })),
];

      if (prev) {
      reqs.push(
        apiPost("/api/gsc/summary", prev).then((d) => ({ key: "gscSummaryPrev", ok: true, data: d })).catch((e) => ({ key: "gscSummaryPrev", ok: false, err: e })),
        apiPost("/api/cloudflare/daily", prev).then((d) => ({ key: "cfDailyPrev", ok: true, data: d })).catch((e) => ({ key: "cfDailyPrev", ok: false, err: e })),
        apiPost("/api/ga4/summary", prev).then((d) => ({ key: "ga4SummaryPrev", ok: true, data: d })).catch((e) => ({ key: "ga4SummaryPrev", ok: false, err: e }))
      );
    }

    const results = await Promise.all(reqs);
    const bag = {};
    for (const r of results) bag[r.key] = r;

    // Health / chips
    if (bag.health?.ok) {
      renderChips(bag.health.data);
      $("healthOut").textContent = JSON.stringify(bag.health.data, null, 2);
    } else {
      setChip("chipCf", false);
      setChip("chipGsc", false);
      setChip("chipGa4", false);
      setChip("chipAi", false);
      $("healthOut").textContent = `ERR: ${bag.health?.err?.message || "health check failed"}`;
      toast("API health check failed", "Check docs/config.js API_BASE_URL and that the Worker is deployed.");
    }

    // Extract provider data
    const gsc = bag.gscSummary?.ok ? bag.gscSummary.data : null;
    const gscPrev = bag.gscSummaryPrev?.ok ? bag.gscSummaryPrev.data : null;

    const cf = bag.cfDaily?.ok ? bag.cfDaily.data : null;
    const cfPrev = bag.cfDailyPrev?.ok ? bag.cfDailyPrev.data : null;

    const ga4 = bag.ga4Summary?.ok ? bag.ga4Summary.data : null;
    const ga4Prev = bag.ga4SummaryPrev?.ok ? bag.ga4SummaryPrev.data : null;

    // Charts
    ensureCharts();

    // GSC trend
    if (gsc?.rows?.length) {
      const labels = gsc.rows.map((r) => r.date);
      setOverlay("gscChartOverlay", false);

      gscChart.data.labels = labels;
      gscChart.data.datasets = [
        { label: "Clicks", data: gsc.rows.map((r) => r.clicks) },
        { label: "Impressions", data: gsc.rows.map((r) => r.impressions) },
      ];
      gscChart.update();
    } else {
      setOverlay("gscChartOverlay", true, "No Search Console data (or not connected)");
      gscChart.data.labels = [];
      gscChart.data.datasets = [];
      gscChart.update();
    }

    // Cloudflare trend
    if (cf?.series?.length) {
      const labels = cf.series.map((r) => r.date);
      const cachePct = cf.series.map((r) => {
        const req = Number(r.requests || 0);
        const cached = Number(r.cachedRequests || 0);
        return req ? Math.round((cached / req) * 100) : 0;
      });

      setOverlay("cfChartOverlay", false);

      cfChart.data.labels = labels;
      cfChart.data.datasets = [
        { label: "Requests", data: cf.series.map((r) => r.requests) },
        { label: "Cache hit %", data: cachePct },
      ];
      cfChart.update();
    } else {
      setOverlay("cfChartOverlay", true, "No Cloudflare data (or not connected)");
      cfChart.data.labels = [];
      cfChart.data.datasets = [];
      cfChart.update();
    }

    // Tables
    if (bag.gscTopQueries?.ok) {
      renderTable(
        "queriesTable",
        "queriesOverlay",
        (bag.gscTopQueries.data.rows || []).slice(0, 10),
        [
          { value: (r) => r.query || "—", title: (r) => r.query || "" },
          { className: "num", value: (r) => fmt(r.clicks) },
          { className: "num", value: (r) => fmt(r.impressions) },
          { className: "num", value: (r) => fmt(r.ctr, { style: "percent", maxFrac: 1 }) },
          { className: "num", value: (r) => fmt(r.position, { maxFrac: 1 }) },
        ]
      );
    } else {
      $("queriesOverlay").classList.remove("hide");
      $("queriesOverlay").textContent = bag.gscTopQueries?.err?.message || "Not connected";
    }

    if (bag.gscTopPages?.ok) {
      renderTable(
        "pagesTable",
        "pagesOverlay",
        (bag.gscTopPages.data.rows || []).slice(0, 10),
        [
          {
            value: (r) => shortenUrl(r.page || "—", 46),
            title: (r) => r.page || "",
          },
          { className: "num", value: (r) => fmt(r.clicks) },
          { className: "num", value: (r) => fmt(r.impressions) },
          { className: "num", value: (r) => fmt(r.ctr, { style: "percent", maxFrac: 1 }) },
          { className: "num", value: (r) => fmt(r.position, { maxFrac: 1 }) },
        ]
      );
    } else {
      $("pagesOverlay").classList.remove("hide");
      $("pagesOverlay").textContent = bag.gscTopPages?.err?.message || "Not connected";
    }

    if (bag.gscDevices?.ok) {
      renderTable(
        "devicesTable",
        "devicesOverlay",
        (bag.gscDevices.data.rows || []).slice(0, 10),
        [
          { value: (r) => (r.device || "—").toString() },
          { className: "num", value: (r) => fmt(r.clicks) },
          { className: "num", value: (r) => fmt(r.impressions) },
          { className: "num", value: (r) => fmt(r.ctr, { style: "percent", maxFrac: 1 }) },
          { className: "num", value: (r) => fmt(r.position, { maxFrac: 1 }) },
        ]
      );
    } else {
      $("devicesOverlay").classList.remove("hide");
      $("devicesOverlay").textContent = bag.gscDevices?.err?.message || "Not connected";
    }

    if (bag.cfCountries?.ok) {
      renderTable(
        "countriesTable",
        "countriesOverlay",
        (bag.cfCountries.data.countries || []).slice(0, 12),
        [
          { value: (r) => r.country || "—" },
          { className: "num", value: (r) => fmt(r.requests) },
          { className: "num", value: (r) => fmt(r.bytes, { style: "bytes" }) },
        ]
      );
    } else {
      $("countriesOverlay").classList.remove("hide");
      $("countriesOverlay").textContent = bag.cfCountries?.err?.message || "Not connected";
    }

    // Summaries
    const summary = {
      gsc: gsc?.totals || null,
      gscPrev: gscPrev?.totals || null,
      cloudflare: cf ? summarizeCf(cf) : null,
      cloudflarePrev: cfPrev ? summarizeCf(cfPrev) : null,
      ga4: ga4?.totals || null,
      ga4Prev: ga4Prev?.totals || null,
      business: summarizeLedger(),
    };

    const kpis = buildKpis(summary, compare);
    renderKpis(kpis);

    const alerts = buildAlerts(summary, compare);
    renderAlerts(alerts);

    // Save bundle for AI
    window.__SM_LATEST__ = {
      range: { startDate, endDate, compare, prev },
      summary,
      alerts,
      top: {
        queries: bag.gscTopQueries?.ok ? bag.gscTopQueries.data.rows?.slice(0, 10) : [],
        pages: bag.gscTopPages?.ok ? bag.gscTopPages.data.rows?.slice(0, 10) : [],
      },
    };

    // Encourage user on partial failures
    const softErrors = results.filter((r) => !r.ok && r.key !== "ga4Summary" && r.key !== "ga4SummaryPrev");
    if (softErrors.length) {
      toast("Some data sources failed", "Refresh worked, but one or more sources returned errors. Check the Settings / Health Check section.");
    }
  }

  function summarizeCf(cfDaily) {
    const series = cfDaily.series || [];
    const requests = series.reduce((a, r) => a + Number(r.requests || 0), 0);
    const bytes = series.reduce((a, r) => a + Number(r.bytes || 0), 0);
    const cachedRequests = series.reduce((a, r) => a + Number(r.cachedRequests || 0), 0);
    const cacheHit = requests > 0 ? cachedRequests / requests : 0;
    return { requests, bytes, cacheHit };
  }

  function buildKpis(summary, compare) {
    const gsc = summary.gsc;
    const gscPrev = summary.gscPrev;
    const cf = summary.cloudflare;
    const cfPrev = summary.cloudflarePrev;
    const ga4 = summary.ga4;
    const ga4Prev = summary.ga4Prev;
    const biz = summary.business;

    const kpis = [];

    // Helper
    const push = (label, value, prevValue, style, source, sourceHint) => {
      const delta = compare ? pctDelta(value, prevValue) : null;
      const deltaText = compare ? signedPct(delta) : "";
      const deltaClass = delta !== null && delta !== undefined ? (delta > 0 ? "up" : delta < 0 ? "down" : "") : "";
      kpis.push({
        label,
        value: style ? fmt(value, style) : fmt(value),
        deltaText: compare ? `vs prev: ${deltaText}` : "",
        deltaClass,
        source,
        sourceHint,
      });
    };

    // Search Console
    if (gsc) {
      push("GSC Clicks", gsc.clicks, gscPrev?.clicks, null, "GSC", "Google Search Console");
      push("GSC Impressions", gsc.impressions, gscPrev?.impressions, null, "GSC", "Google Search Console");
      push("GSC CTR", gsc.ctr, gscPrev?.ctr, { style: "percent", maxFrac: 1 }, "GSC", "Clicks / Impressions");
      // For position: lower is better. Still show delta but reverse meaning in alert logic, not here.
      push("Avg Position", gsc.position, gscPrev?.position, { maxFrac: 1 }, "GSC", "Weighted by impressions");
    } else {
      push("GSC Clicks", null, null, null, "GSC", "Not connected");
      push("GSC Impressions", null, null, null, "GSC", "Not connected");
      push("GSC CTR", null, null, null, "GSC", "Not connected");
      push("Avg Position", null, null, null, "GSC", "Not connected");
    }

    // Cloudflare
    if (cf) {
      push("CF Requests", cf.requests, cfPrev?.requests, null, "CF", "Cloudflare edge requests");
      push("CF Bandwidth", cf.bytes, cfPrev?.bytes, { style: "bytes" }, "CF", "Edge bytes");
      push("CF Cache Hit", cf.cacheHit, cfPrev?.cacheHit, { style: "percent", maxFrac: 1 }, "CF", "cachedRequests / requests");
    } else {
      push("CF Requests", null, null, null, "CF", "Not connected");
      push("CF Bandwidth", null, null, null, "CF", "Not connected");
      push("CF Cache Hit", null, null, null, "CF", "Not connected");
    }

    // GA4 optional
    if (ga4) {
      push("GA4 Sessions", ga4.sessions, ga4Prev?.sessions, null, "GA4", "Google Analytics 4");
      push("GA4 Users", ga4.users, ga4Prev?.users, null, "GA4", "Google Analytics 4");
      push("GA4 Pageviews", ga4.pageviews, ga4Prev?.pageviews, null, "GA4", "Google Analytics 4");
    } else {
      push("GA4 Sessions", null, null, null, "GA4", "Optional");
      push("GA4 Users", null, null, null, "GA4", "Optional");
      push("GA4 Pageviews", null, null, null, "GA4", "Optional");
    }

    // Business
    if (biz) {
      push("Ledger Profit (Total)", biz.totalProfit, null, { style: "money" }, "Biz", "From your local ledger");
      push("Ledger Revenue", biz.totalRevenue, null, { style: "money" }, "Biz", "From your local ledger");
    } else {
      push("Ledger Profit (Total)", null, null, { style: "money" }, "Biz", "Local ledger");
      push("Ledger Revenue", null, null, { style: "money" }, "Biz", "Local ledger");
    }

    return kpis;
  }

  function buildAlerts(summary, compare) {
    const alerts = [];
    if (!compare) return alerts;

    const g = summary.gsc;
    const gp = summary.gscPrev;
    const c = summary.cloudflare;
    const cp = summary.cloudflarePrev;
    const ga = summary.ga4;
    const gap = summary.ga4Prev;

    const add = (level, title, body) => alerts.push({ level, title, body });

    if (g && gp) {
      const dClicks = pctDelta(g.clicks, gp.clicks);
      const dImpr = pctDelta(g.impressions, gp.impressions);
      const dCtr = pctDelta(g.ctr, gp.ctr);

      // Position: higher is worse. Compare absolute difference rather than pct.
      const dPos = (Number(g.position) || 0) - (Number(gp.position) || 0);

      if (dClicks !== null && dClicks <= -0.2) add("bad", "Search clicks dropped", `Clicks are down ${signedPct(dClicks)} vs previous period.`);
      if (dImpr !== null && dImpr <= -0.25) add("warn", "Search impressions dropped", `Impressions are down ${signedPct(dImpr)} vs previous period.`);
      if (dCtr !== null && dCtr <= -0.15) add("warn", "CTR fell", `CTR is down ${signedPct(dCtr)}. Check titles/snippets, ranking shifts, and query mix.`);
      if (Number.isFinite(dPos) && dPos >= 1.0) add("warn", "Average position got worse", `Avg position is worse by +${dPos.toFixed(1)}. (Lower is better.)`);
      if (dClicks !== null && dClicks >= 0.25) add("good", "Search clicks jumped", `Clicks are up ${signedPct(dClicks)}. Identify what queries/pages caused it and double down.`);
    }

    if (c && cp) {
      const dReq = pctDelta(c.requests, cp.requests);
      const dCache = (c.cacheHit - cp.cacheHit);

      if (dReq !== null && dReq >= 0.6) add("warn", "Edge requests spiked", `Cloudflare requests are up ${signedPct(dReq)}. Could be growth, bots, or a new referrer.`);
      if (Number.isFinite(dCache) && dCache <= -0.1) add("warn", "Cache hit rate fell", `Cache hit rate dropped ${(dCache * 100).toFixed(1)} points. Check cache rules, bypasses, and dynamic pages.`);
    }

    // Bot heuristic: CF requests up, GA4 sessions flat/down.
    if (c && cp && ga && gap) {
      const dReq = pctDelta(c.requests, cp.requests);
      const dSess = pctDelta(ga.sessions, gap.sessions);
      if (dReq !== null && dSess !== null && dReq >= 0.5 && dSess <= 0.1) {
        add("warn", "Possible bot / non-user traffic", `Cloudflare requests surged (${signedPct(dReq)}) but GA4 sessions didn’t (${signedPct(dSess)}). Check Cloudflare bot tools + WAF.`);
      }
    }

    if (!alerts.length) {
      add("good", "No major anomalies detected", "The dashboard didn’t spot large swings. Still worth checking top queries/pages for subtle changes.");
    }

    return alerts;
  }

  function shortenUrl(url, max = 52) {
    const s = String(url || "");
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + "…";
  }

  // ---------- AI ----------
  async function runAi() {
    const bundle = window.__SM_LATEST__;
    if (!bundle) {
      toast("Nothing to analyze yet", "Hit Refresh first so the dashboard has data.");
      return;
    }

    $("aiBtn").disabled = true;
    $("aiOut").textContent = "Thinking… (in a polite, compute-efficient way)";
    $("copyAiBtn").disabled = true;

    try {
      const resp = await apiPost("/api/ai/insights", bundle);
      $("aiOut").textContent = resp.text || "(no output)";
      $("copyAiBtn").disabled = false;
    } catch (e) {
      $("aiOut").textContent = `ERR: ${e.message}`;
      toast("AI failed", e.message);
    } finally {
      $("aiBtn").disabled = false;
    }
  }

  async function copyAi() {
    const text = $("aiOut").textContent || "";
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied", "AI insights copied to clipboard.");
    } catch {
      toast("Copy failed", "Your browser blocked clipboard access.");
    }
  }

  // ---------- Business ledger ----------
  const LEDGER_KEY = "smDash_ledger_v1";

  function loadLedger() {
    try {
      const raw = localStorage.getItem(LEDGER_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveLedger(entries) {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
  }

  function computeLedger(entries) {
    let cum = 0;
    return entries.map((e) => {
      const revenue = Number(e.revenue || 0);
      const costs = Number(e.costs || 0);
      const ads = Number(e.ads || 0);
      const profit = revenue - costs - ads;
      cum += profit;
      return { ...e, revenue, costs, ads, profit, cum };
    });
  }

  function renderLedger() {
    const overlay = $("ledgerOverlay");
    const tbody = $("ledgerTable").querySelector("tbody");
    tbody.innerHTML = "";

    const entries = computeLedger(loadLedger());

    if (!entries.length) {
      overlay.classList.remove("hide");
      overlay.textContent = "No entries yet.";
      $("bizCumOut").textContent = "—";
      return;
    }

    overlay.classList.add("hide");

    for (const e of entries) {
      const tr = document.createElement("tr");

      tr.innerHTML = `
        <td class="mono"></td>
        <td></td>
        <td class="num"></td>
        <td class="num"></td>
        <td class="num"></td>
        <td class="num"></td>
        <td class="num"></td>
        <td class="num"></td>
      `;

      tr.children[0].textContent = e.date || "—";
      tr.children[1].textContent = e.label || "";
      tr.children[2].textContent = fmt(e.revenue, { style: "money" });
      tr.children[3].textContent = fmt(e.costs, { style: "money" });
      tr.children[4].textContent = fmt(e.ads, { style: "money" });
      tr.children[5].textContent = fmt(e.profit, { style: "money" });
      tr.children[6].textContent = fmt(e.cum, { style: "money" });

      const delBtn = document.createElement("button");
      delBtn.className = "btn danger";
      delBtn.textContent = "Delete";
      delBtn.style.padding = "6px 10px";
      delBtn.addEventListener("click", () => {
        const next = loadLedger().filter((x) => x.id !== e.id);
        saveLedger(next);
        renderLedger();
        renderBizSummary();
      });

      tr.children[7].appendChild(delBtn);

      tbody.appendChild(tr);
    }

    // Update cumulative
    const last = entries[entries.length - 1];
    $("bizCumOut").textContent = fmt(last.cum, { style: "money" });
  }

  function renderBizSummary() {
    const entries = computeLedger(loadLedger());
    const totalProfit = entries.reduce((a, e) => a + e.profit, 0);
    const totalRevenue = entries.reduce((a, e) => a + e.revenue, 0);

    // This is also used by AI bundle
    return { totalProfit, totalRevenue, count: entries.length };
  }

  function summarizeLedger() {
    const entries = computeLedger(loadLedger());
    if (!entries.length) return null;
    const totalProfit = entries.reduce((a, e) => a + e.profit, 0);
    const totalRevenue = entries.reduce((a, e) => a + e.revenue, 0);
    const totalCosts = entries.reduce((a, e) => a + e.costs, 0);
    const totalAds = entries.reduce((a, e) => a + e.ads, 0);
    const margin = totalRevenue > 0 ? totalProfit / totalRevenue : 0;
    return { totalProfit, totalRevenue, totalCosts, totalAds, margin, entries: entries.length };
  }

  function setupBusiness() {
    const calc = () => {
      const rev = Number($("bizRev").value || 0);
      const cost = Number($("bizCost").value || 0);
      const ads = Number($("bizAds").value || 0);

      const profit = rev - cost - ads;
      const margin = rev > 0 ? profit / rev : 0;

      $("bizProfitOut").textContent = fmt(profit, { style: "money" });
      $("bizMarginOut").textContent = fmt(margin, { style: "percent", maxFrac: 1 });
    };

    $("bizCalcBtn").addEventListener("click", calc);

    $("bizAddBtn").addEventListener("click", () => {
      const rev = Number($("bizRev").value || 0);
      const cost = Number($("bizCost").value || 0);
      const ads = Number($("bizAds").value || 0);
      const label = ($("bizLabel").value || "").trim();
      const date = ymdLocal(new Date());

      const entry = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        date,
        label,
        revenue: rev,
        costs: cost,
        ads,
      };

      const next = loadLedger();
      next.push(entry);
      saveLedger(next);
      calc();
      renderLedger();
      toast("Added to ledger", "Saved locally in this browser.");
    });

    $("bizResetBtn").addEventListener("click", () => {
      if (!confirm("Reset ledger? This deletes local business entries from this browser.")) return;
      localStorage.removeItem(LEDGER_KEY);
      renderLedger();
      toast("Ledger reset", "Local entries cleared.");
    });

    $("exportLedgerBtn").addEventListener("click", () => {
      const data = loadLedger();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "safarimatcher-ledger.json";
      a.click();
      URL.revokeObjectURL(url);
      toast("Exported", "Ledger JSON downloaded.");
    });

    $("importLedgerBtn").addEventListener("click", () => $("importLedgerFile").click());
    $("importLedgerFile").addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error("File is not a JSON array.");
        saveLedger(data);
        renderLedger();
        toast("Imported", "Ledger JSON imported.");
      } catch (e) {
        toast("Import failed", e.message || "Invalid file");
      } finally {
        ev.target.value = "";
      }
    });

    // Initial render
    renderLedger();
  }

  // ---------- Settings ----------
  async function runHealthCheck() {
    $("healthOut").textContent = "Loading…";
    try {
      const data = await apiGet("/api/health");
      $("healthOut").textContent = JSON.stringify(data, null, 2);
      renderChips(data);
      toast("Health check OK", "Backend is reachable.");
    } catch (e) {
      $("healthOut").textContent = `ERR: ${e.message}`;
      toast("Health check failed", e.message);
    }
  }

  // ---------- Boot ----------
  function boot() {
    document.title = cfg.DASHBOARD_TITLE || document.title;

    $("apiBaseOut").textContent = apiBase() || "(not set — edit docs/config.js)";

    if (!API_BASE_URL || API_BASE_URL.includes("[")) {
      toast("Setup needed", "Edit docs/config.js and set API_BASE_URL to your Worker URL.");
    }

    defaultDates();
    setupBusiness();

    $("refreshBtn").addEventListener("click", refreshAll);
    $("aiBtn").addEventListener("click", runAi);
    $("copyAiBtn").addEventListener("click", copyAi);
    $("healthBtn").addEventListener("click", runHealthCheck);

    // Auto-run
    refreshAll().catch((e) => {
      toast("Refresh failed", e.message || "Unknown error");
    });
  }

  boot();
})();
