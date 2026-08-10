import { SAAS_APPS, RAVEN_SHELL_VERSION, runSafeRouteTest } from "./saas-baseline.js";

const TEST_REPORT_KEY = "saas-testing-report-v2";
const TEST_STATUS_KEY = "saas-testing-status-v2";
const TEST_CURSOR_KEY = "saas-testing-cursor-v2";
const now = () => new Date().toISOString();

async function nextApp(env) {
  const cursor = Number(await env.MONITOR_KV?.get(TEST_CURSOR_KEY) || 0) % SAAS_APPS.length;
  await env.MONITOR_KV?.put(TEST_CURSOR_KEY, String((cursor + 1) % SAAS_APPS.length));
  return SAAS_APPS[cursor];
}

async function previousReport(env) {
  return await env.MONITOR_KV?.get(TEST_REPORT_KEY, "json") || {
    version: 2,
    baseline_version: RAVEN_SHELL_VERSION,
    mode: "safe_read_only",
    apps: []
  };
}

export async function runSafeSaasTests(env) {
  const startedAt = now();
  const app = await nextApp(env);
  await env.MONITOR_KV?.put(TEST_STATUS_KEY, JSON.stringify({
    status: "running",
    mode: "safe_read_only",
    app: app.id,
    app_name: app.name,
    baseline_version: RAVEN_SHELL_VERSION,
    started_at: startedAt
  }));

  try {
    const current = await runSafeRouteTest(app);
    const old = await previousReport(env);
    const map = new Map((old.apps || []).map(item => [item.id, item]));
    map.set(current.id, current);
    const apps = SAAS_APPS.map(item => map.get(item.id)).filter(Boolean);
    const passed = apps.filter(item => item.passed).length;
    const report = {
      version: 2,
      baseline_version: RAVEN_SHELL_VERSION,
      mode: "safe_read_only",
      run_at: now(),
      last_app: app.id,
      safety: {
        mutating_requests: false,
        test_accounts: false,
        provider_generation: false,
        publishing: false,
        billing: false,
        deletion: false,
        note: "GET-only checks confirm homepage availability, a real product-entry/workspace route, any explicitly protected routes, and a safe JSON health endpoint when one exists. One product is checked per run to stay comfortably inside Worker request limits. A separate /login plus /register page is not required because the current Raven Sharp products use different entry patterns."
      },
      summary: { passed, needs_attention: apps.length - passed, checked: apps.length, total: SAAS_APPS.length },
      apps
    };

    await env.MONITOR_KV?.put(TEST_REPORT_KEY, JSON.stringify(report));
    await env.MONITOR_KV?.put(TEST_STATUS_KEY, JSON.stringify({
      status: "completed",
      mode: "safe_read_only",
      app: app.id,
      app_name: app.name,
      baseline_version: RAVEN_SHELL_VERSION,
      started_at: startedAt,
      completed_at: report.run_at
    }));
    return report;
  } catch (error) {
    await env.MONITOR_KV?.put(TEST_STATUS_KEY, JSON.stringify({
      status: "failed",
      mode: "safe_read_only",
      app: app.id,
      app_name: app.name,
      baseline_version: RAVEN_SHELL_VERSION,
      started_at: startedAt,
      failed_at: now(),
      message: error.message
    }));
    throw error;
  }
}

export async function readSaasTestState(env) {
  const [report, status] = await Promise.all([
    env.MONITOR_KV?.get(TEST_REPORT_KEY, "json"),
    env.MONITOR_KV?.get(TEST_STATUS_KEY, "json")
  ]);
  return {
    report: report || { version: 2, baseline_version: RAVEN_SHELL_VERSION, mode: "safe_read_only", apps: [] },
    status: status || { status: "not_started", baseline_version: RAVEN_SHELL_VERSION }
  };
}

export function approvedTestInventory() {
  return {
    enabled: false,
    reason: "No spending or mutating tests are enabled by default.",
    prerequisites: [
      "Explicit approval",
      "Dedicated test accounts",
      "Provider sandbox/test-mode credentials",
      "Per-app spend limits",
      "Disposable test data and cleanup rules"
    ],
    gated_tests: [
      "Register and verify a disposable test account when the product uses account registration",
      "Exercise authenticated plan gates",
      "Run one provider-backed generation with a hard spend ceiling",
      "Exercise workflow or pipeline transitions using disposable drafts",
      "Publish only to an isolated sandbox destination",
      "Run billing only with Stripe test-mode payment methods",
      "Delete only data created by the same approved test run"
    ]
  };
}
