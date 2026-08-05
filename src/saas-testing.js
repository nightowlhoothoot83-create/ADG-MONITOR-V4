const TEST_REPORT_KEY = "saas-testing-report-v1";
const TEST_STATUS_KEY = "saas-testing-status-v1";

const TEST_APPS = [
  { id: "pod", name: "Raven-Sharp POD", url: "https://pod.raven-sharp.com", publicRoutes: ["/", "/login", "/register", "/pricing", "/legal/privacy", "/legal/terms", "/legal/cookies"], protectedRoutes: ["/dashboard", "/pipeline"], healthRoutes: ["/api/health", "/api/status", "/health"] },
  { id: "image-optimiser", name: "Image Optimiser & Upscaler", url: "https://opt.raven-sharp.com", publicRoutes: ["/", "/optimiser", "/login", "/register", "/legal/privacy", "/legal/terms", "/legal/cookies"], protectedRoutes: ["/history"], healthRoutes: ["/api/health", "/api/status", "/health"] },
  { id: "smart-cleaner", name: "Smart AI Cleaner", url: "https://cleaner.raven-sharp.com", publicRoutes: ["/", "/app.html"], protectedRoutes: [], healthRoutes: ["/api/health", "/api/status", "/health"] },
  { id: "ad-manager", name: "Ad Manager", url: "https://ads.raven-sharp.com", publicRoutes: ["/"], protectedRoutes: ["/dashboard"], healthRoutes: ["/api/health", "/api/status", "/health"] },
  { id: "book-creator", name: "Book Creator", url: "https://books.raven-sharp.com", publicRoutes: ["/"], protectedRoutes: [], healthRoutes: ["/api/health", "/api/status", "/health"] },
  { id: "content-creator", name: "Content Creator", url: "https://content.raven-sharp.com", publicRoutes: ["/"], protectedRoutes: [], healthRoutes: ["/api/health", "/api/status", "/health"] }
];

const USER_AGENT = "ADG-SaaS-Testing-Agent/1.0";
const now = () => new Date().toISOString();

async function request(url, options = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      redirect: options.redirect || "follow",
      method: "GET",
      headers: { "User-Agent": USER_AGENT, "Accept": options.accept || "text/html,application/json", "Cache-Control": "no-cache" }
    });
    const type = response.headers.get("content-type") || "";
    const body = (type.includes("text/") || type.includes("json")) ? (await response.text()).slice(0, 200_000) : "";
    return {
      ok: response.ok,
      status: response.status,
      final_url: response.url,
      content_type: type,
      response_ms: Date.now() - started,
      body
    };
  } catch (error) {
    return { ok: false, status: 0, response_ms: Date.now() - started, error: error.message, body: "" };
  }
}

function publicRouteResult(app, path, result) {
  const title = result.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";
  const signInVisible = /(?:sign in|log in|login)/i.test(result.body);
  const registerVisible = /(?:create account|register|sign up|start free)/i.test(result.body);
  return {
    path,
    url: new URL(path, app.url).href,
    passed: result.ok,
    status: result.status,
    final_url: result.final_url,
    response_ms: result.response_ms,
    title,
    sign_in_visible: signInVisible,
    register_visible: registerVisible,
    error: result.error
  };
}

function protectedRouteResult(app, path, result) {
  const location = result.final_url || "";
  const redirectedToAuth = /(?:login|sign-in|signin|account)/i.test(location);
  const rejected = result.status === 401 || result.status === 403;
  const protectedRoute = rejected || redirectedToAuth;
  return {
    path,
    url: new URL(path, app.url).href,
    passed: protectedRoute,
    status: result.status,
    final_url: location,
    protection_detected: protectedRoute,
    note: protectedRoute ? "Unauthenticated access was blocked or redirected." : "No server-side protection was detected. A client-rendered shell may still enforce access after load.",
    error: result.error
  };
}

function healthResult(path, result) {
  let parsed = null;
  try { parsed = JSON.parse(result.body); } catch {}
  const secretLeak = /(?:sk_live_|sk_test_|Bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key["'\s:=]+[A-Za-z0-9._-]{16,})/i.test(result.body);
  return {
    path,
    status: result.status,
    passed: result.ok && Boolean(parsed) && !secretLeak,
    json: Boolean(parsed),
    secret_leak_detected: secretLeak,
    configuration: parsed && typeof parsed === "object" ? {
      status: parsed.status ?? parsed.ok ?? null,
      service: parsed.service ?? null,
      configured: parsed.configured ?? parsed.providers ?? parsed.integrations ?? null
    } : null,
    response_ms: result.response_ms,
    error: result.error
  };
}

async function testApp(app) {
  const started = Date.now();
  const publicRoutes = await Promise.all(app.publicRoutes.map(async path =>
    publicRouteResult(app, path, await request(new URL(path, app.url).href))
  ));
  const protectedRoutes = await Promise.all(app.protectedRoutes.map(async path =>
    protectedRouteResult(app, path, await request(new URL(path, app.url).href, { redirect: "manual" }))
  ));
  const healthRoutes = await Promise.all(app.healthRoutes.map(async path =>
    healthResult(path, await request(new URL(path, app.url).href, { accept: "application/json" }))
  ));
  const homepage = publicRoutes.find(item => item.path === "/");
  const loginAvailable = publicRoutes.some(item => /login|sign-in/i.test(item.path) && item.passed) || Boolean(homepage?.sign_in_visible);
  const registerAvailable = publicRoutes.some(item => /register|sign-up/i.test(item.path) && item.passed) || Boolean(homepage?.register_visible);
  const publicPassed = publicRoutes.every(item => item.passed);
  const gatingPassed = protectedRoutes.length === 0 || protectedRoutes.every(item => item.passed);
  const healthyEndpoint = healthRoutes.find(item => item.passed) || null;
  const issues = [];
  if (!publicPassed) issues.push("One or more public routes failed.");
  if (!loginAvailable) issues.push("No working or visible login entry point was detected.");
  if (!registerAvailable) issues.push("No working or visible registration entry point was detected.");
  if (!gatingPassed) issues.push("One or more protected routes did not demonstrate server-side unauthenticated gating.");
  if (!healthyEndpoint) issues.push("No safe JSON health/configuration endpoint passed.");
  if (healthRoutes.some(item => item.secret_leak_detected)) issues.push("A health response may expose a credential and must be reviewed immediately.");
  return {
    id: app.id,
    name: app.name,
    url: app.url,
    status: issues.length ? "needs_attention" : "passed",
    response_ms: Date.now() - started,
    checks: { public_routes: publicPassed, login_available: loginAvailable, register_available: registerAvailable, plan_gating: gatingPassed, safe_health_endpoint: Boolean(healthyEndpoint) },
    public_routes: publicRoutes,
    protected_routes: protectedRoutes,
    health_routes: healthRoutes,
    issues
  };
}

export async function runSafeSaasTests(env) {
  const startedAt = now();
  await env.MONITOR_KV?.put(TEST_STATUS_KEY, JSON.stringify({ status: "running", mode: "safe_read_only", started_at: startedAt }));
  try {
    const apps = await Promise.all(TEST_APPS.map(testApp));
    const passed = apps.filter(app => app.status === "passed").length;
    const report = {
      version: 1,
      mode: "safe_read_only",
      run_at: now(),
      safety: {
        mutating_requests: false,
        test_accounts: false,
        provider_generation: false,
        publishing: false,
        billing: false,
        deletion: false,
        note: "This run performs GET-only availability, route, access-gating and health/configuration checks."
      },
      summary: { passed, needs_attention: apps.length - passed, total: apps.length },
      apps
    };
    await env.MONITOR_KV?.put(TEST_REPORT_KEY, JSON.stringify(report));
    await env.MONITOR_KV?.put(TEST_STATUS_KEY, JSON.stringify({ status: "completed", mode: "safe_read_only", started_at: startedAt, completed_at: report.run_at }));
    return report;
  } catch (error) {
    await env.MONITOR_KV?.put(TEST_STATUS_KEY, JSON.stringify({ status: "failed", mode: "safe_read_only", started_at: startedAt, failed_at: now(), message: error.message }));
    throw error;
  }
}

export async function readSaasTestState(env) {
  const [report, status] = await Promise.all([
    env.MONITOR_KV?.get(TEST_REPORT_KEY, "json"),
    env.MONITOR_KV?.get(TEST_STATUS_KEY, "json")
  ]);
  return { report: report || { version: 1, mode: "safe_read_only", apps: [] }, status: status || { status: "not_started" } };
}

export function approvedTestInventory() {
  return {
    enabled: false,
    reason: "No spending or mutating tests are enabled by default.",
    prerequisites: ["Explicit approval", "Dedicated test accounts", "Provider sandbox/test-mode credentials", "Per-app spend limits", "Disposable test data and cleanup rules"],
    gated_tests: [
      "Register and verify a disposable test account",
      "Exercise authenticated plan gates",
      "Run one provider-backed generation with a hard spend ceiling",
      "Exercise pipeline transitions using disposable drafts",
      "Publish only to an isolated sandbox destination",
      "Run billing only with Stripe test-mode payment methods",
      "Delete only data created by the same approved test run"
    ]
  };
}
