import worker from "./saas-worker-v3.js";
import { SAAS_APPS } from "./saas-baseline.js";
import { scopeMonitorEnv } from "./scoped-kv.js";
import { runFunctionalSaasAudit, latestFunctionalSaasAudit } from "./saas-functional.js";
import { runSaasAlertWatch, latestSaasAlerts } from "./saas-alerts.js";

const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

function scheduledApp(scheduledTime) {
  const minute = new Date(scheduledTime).getUTCMinutes();
  const index = Math.max(0, [0, 10, 20, 30, 40, 50].indexOf(minute));
  return SAAS_APPS[index] || SAAS_APPS[0];
}

export default {
  async fetch(request, env, ctx) {
    const scoped = scopeMonitorEnv(env, "saas");
    const url = new URL(request.url);

    if (url.pathname === "/functional.json") {
      return json(await latestFunctionalSaasAudit(scoped));
    }

    if (url.pathname === "/functional/run") {
      const site = url.searchParams.get("site");
      const report = await runFunctionalSaasAudit(scoped, site);
      return json(report, report.status === "error" ? 400 : 200);
    }

    if (url.pathname === "/alerts.json") {
      return json(await latestSaasAlerts(scoped));
    }

    if (url.pathname === "/alerts/run") {
      const requested = url.searchParams.get("site");
      const app = requested ? SAAS_APPS.find(item => item.id === requested) : SAAS_APPS[0];
      if (!app) return json({ status: "error", message: "Unknown SaaS app" }, 400);
      return json(await runSaasAlertWatch(scoped, app));
    }

    return worker.fetch(request, scoped, ctx);
  },
  scheduled(event, env, ctx) {
    const scoped = scopeMonitorEnv(env, "saas");
    const app = scheduledApp(event.scheduledTime);
    ctx.waitUntil(runSaasAlertWatch(scoped, app));
    return worker.scheduled(event, scoped, ctx);
  }
};
