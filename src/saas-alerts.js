import { SAAS_APPS } from "./saas-baseline.js";

const ALERT_REPORT_KEY = "saas-alert-report-v1";
const USER_AGENT = "ADG-SaaS-Alert-Watch/1.0";
const MAX_REQUESTS_PER_WATCH = 4;
const now = () => new Date().toISOString();

async function get(url, accept = "text/html,application/json,*/*") {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept, "Cache-Control": "no-cache" }
    });
    const type = response.headers.get("content-type") || "";
    const body = /text|json|javascript|css/i.test(type) ? (await response.text()).slice(0, 250000) : "";
    return { ok: response.ok, status: response.status, final_url: response.url, content_type: type, response_ms: Date.now() - started, body };
  } catch (error) {
    return { ok: false, status: 0, response_ms: Date.now() - started, error: error.message, body: "" };
  }
}

function issue(code, severity, area, message, why, next_check) {
  return { code, severity, area, message, why, next_check };
}

function loginSignals(html = "") {
  const hasPassword = /<input\b[^>]*type=["']password["']/i.test(html);
  const hasEmail = /<input\b[^>]*(?:type=["']email["']|name=["'][^"']*(?:email|username)[^"']*["'])/i.test(html);
  const hasSubmit = /<(?:button|input)\b[^>]*(?:type=["']submit["']|>[^<]*(?:sign in|log in|login))/i.test(html);
  const authApi = [...html.matchAll(/["'`](\/api\/[A-Za-z0-9_./?=&%-]*(?:login|auth|session|signin)[A-Za-z0-9_./?=&%-]*)["'`]/gi)].map(m => m[1])[0] || null;
  return { has_password: hasPassword, has_identity_field: hasEmail, has_submit: hasSubmit, auth_api_path: authApi, login_form_ready: hasPassword && hasEmail && hasSubmit };
}

function chooseLoginPath(app) {
  return (app.workspacePaths || []).find(path => /login|signin|sign-in/i.test(path)) || null;
}

function chooseWorkspacePath(app) {
  return (app.workspacePaths || []).find(path => !/register|signup|sign-up/i.test(path)) || app.workspacePaths?.[0] || null;
}

export async function runSaasAlertWatch(env, app) {
  let used = 0;
  const probe = async (url, accept) => {
    if (used >= MAX_REQUESTS_PER_WATCH) return { skipped: true, reason: "request_budget" };
    used += 1;
    return get(url, accept);
  };

  const alerts = [];
  const home = await probe(app.url);
  if (!home.ok) {
    alerts.push(issue("homepage_down", "critical", "availability", `${app.name} homepage returned HTTP ${home.status || 0}.`, home.error || "The public app entry point is unavailable or returning an error.", "Check deployment status, DNS and the most recent production change."));
  }

  const loginPath = chooseLoginPath(app);
  let login = null;
  if (loginPath) {
    login = await probe(new URL(loginPath, app.url).href);
    if (!login.ok && ![401,403].includes(login.status)) {
      alerts.push(issue("login_route_failed", "critical", "login", `Login route ${loginPath} returned HTTP ${login.status || 0}.`, "Users may be unable to reach the login screen.", "Check the login route, deployment redirects and authentication frontend bundle."));
    } else if (login.ok) {
      const signals = loginSignals(login.body || "");
      login.signals = signals;
      if (!signals.login_form_ready) {
        alerts.push(issue("login_ui_incomplete", "warning", "login", "Login page loads but expected login controls were not all detected.", `Password field: ${signals.has_password}; identity/email field: ${signals.has_identity_field}; submit control: ${signals.has_submit}.`, "Check the rendered login form and client-side authentication component."));
      }
      if (signals.auth_api_path && used < MAX_REQUESTS_PER_WATCH) {
        const authProbe = await probe(new URL(signals.auth_api_path, app.url).href, "application/json,*/*");
        login.auth_api_probe = { path: signals.auth_api_path, status: authProbe.status, ok: authProbe.ok, final_url: authProbe.final_url, response_ms: authProbe.response_ms };
        if ([404,500,502,503,504].includes(authProbe.status)) {
          alerts.push(issue("auth_api_failed", "critical", "login", `Authentication API ${signals.auth_api_path} returned HTTP ${authProbe.status}.`, "The login form may render correctly while its backend authentication endpoint is broken.", "Check the auth worker/API deployment, environment variables and database/session connectivity."));
        }
      }
    }
  }

  const workspacePath = chooseWorkspacePath(app);
  let workspace = null;
  if (workspacePath && used < MAX_REQUESTS_PER_WATCH) {
    workspace = await probe(new URL(workspacePath, app.url).href);
    const loginRedirect = /login|signin|sign-in|auth/i.test(workspace.final_url || "");
    const acceptableProtected = [401,403].includes(workspace.status) || loginRedirect;
    if (!workspace.ok && !acceptableProtected) {
      alerts.push(issue("feature_entry_failed", "critical", "feature", `Primary feature/workspace route ${workspacePath} returned HTTP ${workspace.status || 0}.`, "The tool entry route is unavailable and users may not be able to reach the core feature.", "Check the route, frontend bundle and latest deployment."));
    }
  }

  const result = {
    id: app.id,
    name: app.name,
    checked_at: now(),
    request_budget: { used, limit: MAX_REQUESTS_PER_WATCH },
    login_test_scope: loginPath ? "route + rendered login controls + safe GET auth endpoint probe when discoverable" : "no dedicated login route configured",
    login_transaction_verified: false,
    login_transaction_note: "A real credential submission is intentionally not performed without a dedicated test account and non-production-safe auth policy.",
    homepage: { status: home.status, ok: home.ok, response_ms: home.response_ms, final_url: home.final_url },
    login: login ? { path: loginPath, status: login.status, ok: login.ok, response_ms: login.response_ms, final_url: login.final_url, signals: login.signals || null, auth_api_probe: login.auth_api_probe || null } : null,
    workspace: workspace ? { path: workspacePath, status: workspace.status, ok: workspace.ok, response_ms: workspace.response_ms, final_url: workspace.final_url } : null,
    alerts,
    alert_count: alerts.length,
    highest_severity: alerts.some(a => a.severity === "critical") ? "critical" : alerts.some(a => a.severity === "warning") ? "warning" : "ok",
    passed: alerts.length === 0
  };

  const previous = await env.MONITOR_KV?.get(ALERT_REPORT_KEY, "json") || { version: 1, apps: [] };
  const map = new Map((previous.apps || []).map(item => [item.id, item]));
  map.set(app.id, result);
  const apps = SAAS_APPS.map(item => map.get(item.id)).filter(Boolean);
  const report = {
    version: 1,
    mode: "low_call_failure_watch",
    run_at: now(),
    last_app: app.id,
    apps,
    summary: {
      checked: apps.length,
      total: SAAS_APPS.length,
      critical: apps.filter(item => item.highest_severity === "critical").length,
      warning: apps.filter(item => item.highest_severity === "warning").length,
      healthy: apps.filter(item => item.highest_severity === "ok").length
    }
  };
  await env.MONITOR_KV?.put(ALERT_REPORT_KEY, JSON.stringify(report));
  return report;
}

export async function latestSaasAlerts(env) {
  return await env.MONITOR_KV?.get(ALERT_REPORT_KEY, "json") || { version: 1, mode: "low_call_failure_watch", apps: [], status: "not_started" };
}
