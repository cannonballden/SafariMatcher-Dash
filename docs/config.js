/**
 * Dashboard config (safe to commit).
 *
 * IMPORTANT:
 * - This file must NOT contain secrets.
 * - It only points the frontend at your backend Worker.
 */
window.CONFIG = {
  // Example Worker URL:
  // "https://safarimatcher-dashboard-api.[YOUR_ACCOUNT].workers.dev"
  API_BASE_URL: "https://safarimatcher-dashboard-api.clarkbythebay.workers.dev",

  BRAND: "SafariMatcher",
  DASHBOARD_TITLE: "SafariMatcher — Super Dashboard",

  // Optional: if you host this in a subpath, set it here (usually leave blank)
  PATH_PREFIX: "",
};
