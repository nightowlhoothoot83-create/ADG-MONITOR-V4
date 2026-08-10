import { SAAS_APPS, RAVEN_SHELL_VERSION, runSafeRouteTest } from "./saas-baseline.js";

const TEST_REPORT_KEY = "saas-testing-report-v2";
const TEST_STATUS_KEY = "saas-testing-status-v2";
const now = () => new Date().toISOString();

export async function runSafeSaasTests(env) {
  const startedAt = now();
  await env.MONITOR_KV?.put(TEST_STATUS_KEY, JSON.stringify({
    status: "running",
    mode: "safe_read_only",
    baseline_version: RAVEN_SHELL_VERSION,
    started_at: startedAt
  }));

  try {
    const apps = [];
    for (const app of SAAS_APPS) apps.push(await runSafeRouteTest(app));

    const passed = apps.filter(app => app.passed).length;
    const report = {
      version: 2,
      baseline_version: RAVEN_SHELL_VERSION,
      mode: "safe_read_only",
      run_at: now(),
      safety: {
        mutating_requests: false,
        test_accounts: false,
        provider_generation: false,
        publishing: false,
        billing: false,
        deletion: false,
        note: "GET-only checks confirm homepage availability, a real product-entry/workspace route, any explicitly protected routes, and a safe JSON health endpoint when one exists. A separate /login plus /register page is no longer required because the current Raven Sharp products use different entry patterns."
      },
      summary: { passed, needs_attention: apps.length - passed, total: apps.length },
      apps
    };

    await env.MONITOR_KV?.put(TEST_REPORT_KEY, JSON.stringify(report));
    await env.MONITOR_KV?.put(TEST_STATUS_KEY, JSON.stringify({
      status: "completed",
      mode: "safe_read_only",
      baseline_version: RAVEN_SHELL_VERSION,
      started_at: startedAt,
      completed_at: report.run_at
    }));
    return report;
  } catch (error) {
    await env.MONITOR_KV?.put(TEST_STATUS_KEY, JSON.stringify({
      status: "failed",
      mode: "safe_read_only",
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
