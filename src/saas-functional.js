import { SAAS_APPS } from "./saas-baseline.js";

const REPORT_KEY = "functional-health-report-v1";
const CURSOR_KEY = "functional-health-cursor-v1";
const MAX_REQUESTS_PER_APP = 12;
const USER_AGENT = "ADG-SaaS-Functional-Guardian/1.0";

const now = () => new Date().toISOString();

async function nextApp(env) {
  const cursor = Number(await env.MONITOR_KV?.get(CURSOR_KEY) || 0) % SAAS_APPS.length;
  await env.MONITOR_KV?.put(CURSOR_KEY, String((cursor + 1) % SAAS_APPS.length));
  return SAAS_APPS[cursor];
}

async function request(url, accept = "text/html,application/json,*/*") {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: accept, "Cache-Control": "no-cache" }
    });
    const type = response.headers.get("content-type") || "";
    const body = /text|json|javascript|css/i.test(type) ? (await response.text()).slice(0, 500000) : "";
    return {
      url,
      ok: response.ok,
      status: response.status,
      final_url: response.url,
      content_type: type,
      response_ms: Date.now() - started,
      body
    };
  } catch (error) {
    return { url, ok: false, status: 0, response_ms: Date.now() - started, error: error.message, body: "" };
  }
}

function sameOrigin(url, base) {
  try { return new URL(url, base).origin === new URL(base).origin; } catch { return false; }
}

function safeApiPaths(html, base) {
  const found = [];
  const add = raw => {
    try {
      const url = new URL(raw, base);
      if (url.origin !== new URL(base).origin) return;
      if (!/^\/api\//i.test(url.pathname)) return;
      if (/(delete|remove|publish|charge|checkout|payment|create|generate|send|upload|write|update|save)/i.test(url.pathname)) return;
      if (!found.includes(url.href)) found.push(url.href);
    } catch {}
  };
  for (const m of html.matchAll(/["'`](\/api\/[A-Za-z0-9_./?=&%-]+)["'`]/g)) add(m[1]);
  return found.slice(0, 4);
}

function firstPartyScripts(html, base) {
  const found = [];
  for (const m of html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(m[1], base);
      if (sameOrigin(url.href, base) && !found.includes(url.href)) found.push(url.href);
    } catch {}
  }
  return found.slice(0, 2);
}

function formInventory(html) {
  const forms = [...html.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map(match => match[0]);
  return {
    form_count: forms.length,
    login_form: forms.some(form => /password/i.test(form) && /(login|sign in|email)/i.test(form)),
    register_form: forms.some(form => /password/i.test(form) && /(register|sign up|create account)/i.test(form)),
    file_upload_control: /<input\b[^>]*type=["']file["']/i.test(html),
    submit_controls: (html.match(/<(?:button|input)\b[^>]*(?:type=["']submit["']|>[^<]*(?:generate|create|save|upload|run|start|continue|sign in|register))/gi) || []).length,
    empty_form_actions: forms.filter(form => /action=["']\s*["']/i.test(form)).length
  };
}

function featureSignals(html) {
  return {
    pricing_or_plan: /pricing|plans?|subscription/i.test(html),
    auth_ui: /login|sign in|register|sign up/i.test(html),
    upload_ui: /type=["']file["']|drag.{0,20}drop|upload/i.test(html),
    generation_ui: /generate|optimise|upscale|create|pipeline|campaign|book|content/i.test(html),
    billing_ui: /billing|stripe|checkout|payment/i.test(html)
  };
}

async function auditApp(app) {
  let used = 0;
  const probe = async (url, accept) => {
    if (used >= MAX_REQUESTS_PER_APP) return { url, skipped: true, reason: "request_budget" };
    used += 1;
    return request(url, accept);
  };

  const home = await probe(app.url);
  const html = home.body || "";
  const routes = [];
  for (const path of (app.workspacePaths || []).slice(0, 3)) {
    const result = await probe(new URL(path, app.url).href);
    routes.push({ path, ...result, body: undefined });
  }

  const protectedRoutes = [];
  for (const path of (app.protectedPaths || []).slice(0, 2)) {
    const result = await probe(new URL(path, app.url).href);
    const authProtected = [401, 403].includes(result.status) || /login|sign in|auth/i.test(result.final_url || "");
    protectedRoutes.push({ path, ...result, body: undefined, auth_protected: authProtected });
  }

  const apiResults = [];
  for (const url of safeApiPaths(html, app.url)) {
    const result = await probe(url, "application/json,*/*");
    let validJson = false;
    if (result.body) { try { JSON.parse(result.body); validJson = true; } catch {} }
    apiResults.push({ ...result, body: undefined, valid_json: validJson });
  }

  const scriptResults = [];
  for (const url of firstPartyScripts(html, app.url)) {
    const result = await probe(url, "application/javascript,text/javascript,*/*");
    scriptResults.push({ ...result, body: undefined });
  }

  const forms = formInventory(html);
  const signals = featureSignals(html);
  const issues = [];
  if (!home.ok) issues.push(`Homepage HTTP ${home.status || 0}`);
  for (const route of routes) if (!route.ok && ![401,403].includes(route.status)) issues.push(`Feature/workspace route ${route.path} returned HTTP ${route.status || 0}`);
  for (const route of protectedRoutes) if (route.ok && !route.auth_protected) issues.push(`Protected route ${route.path} appears publicly accessible`);
  for (const api of apiResults) {
    if (!api.ok) issues.push(`Safe API probe ${new URL(api.url).pathname} returned HTTP ${api.status || 0}`);
    else if (/json/i.test(api.content_type || "") && !api.valid_json) issues.push(`API ${new URL(api.url).pathname} returned invalid JSON`);
  }
  for (const script of scriptResults) if (!script.ok) issues.push(`First-party script failed: ${new URL(script.url).pathname}`);
  if (forms.empty_form_actions) issues.push(`${forms.empty_form_actions} form(s) have an empty action`);

  return {
    id: app.id,
    name: app.name,
    url: app.url,
    checked_at: now(),
    request_budget: { used, limit: MAX_REQUESTS_PER_APP },
    homepage: { ok: home.ok, status: home.status, final_url: home.final_url, response_ms: home.response_ms, content_type: home.content_type },
    feature_routes: routes,
    protected_routes: protectedRoutes,
    api_checks: apiResults,
    first_party_script_checks: scriptResults,
    forms,
    feature_signals: signals,
    issues,
    passed: issues.length === 0,
    safety: {
      methods: ["GET"],
      mutations: false,
      account_creation: false,
      billing: false,
      provider_generation: false,
      uploads: false,
      destructive_actions: false
    }
  };
}

export async function runFunctionalSaasAudit(env, requestedId = null) {
  const app = requestedId ? SAAS_APPS.find(item => item.id === requestedId) : await nextApp(env);
  if (!app) return { status: "error", message: "Unknown SaaS app" };
  const current = await auditApp(app);
  const previous = await env.MONITOR_KV?.get(REPORT_KEY, "json") || { version: 1, apps: [] };
  const map = new Map((previous.apps || []).map(item => [item.id, item]));
  map.set(app.id, current);
  const apps = SAAS_APPS.map(item => map.get(item.id)).filter(Boolean);
  const report = {
    version: 1,
    mode: "safe_get_only_functional",
    run_at: now(),
    last_app: app.id,
    apps,
    summary: {
      checked: apps.length,
      total: SAAS_APPS.length,
      passed: apps.filter(item => item.passed).length,
      needs_attention: apps.filter(item => !item.passed).length
    }
  };
  await env.MONITOR_KV?.put(REPORT_KEY, JSON.stringify(report));
  return report;
}

export async function latestFunctionalSaasAudit(env) {
  return await env.MONITOR_KV?.get(REPORT_KEY, "json") || { version: 1, mode: "safe_get_only_functional", apps: [], status: "not_started" };
}
