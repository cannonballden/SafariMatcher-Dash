/**
 * Dashboard config (safe to commit).
 *
 * IMPORTANT:
 * - This file must NOT contain secrets.
 * - It only points the frontend at your backend Worker.
 */
window.SAFARI_DASH_CONFIG = {
  // Example Worker URL:
  // "https://safarimatcher-dashboard-api.[YOUR_ACCOUNT].workers.dev"
  API_BASE_URL: "[PASTE_YOUR_WORKER_URL_HERE]",

  BRAND: "SafariMatcher",
  DASHBOARD_TITLE: "SafariMatcher — Super Dashboard",

  // Optional: if you host this in a subpath, set it here (usually leave blank)
  PATH_PREFIX: "",
};
