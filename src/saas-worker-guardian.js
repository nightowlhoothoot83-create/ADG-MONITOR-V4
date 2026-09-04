import worker from "./saas-worker-v3.js";
import { scopeMonitorEnv } from "./scoped-kv.js";
import { runFunctionalSaasAudit, latestFunctionalSaasAudit } from "./saas-functional.js";

const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

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

    return worker.fetch(request, scoped, ctx);
  },
  scheduled(event, env, ctx) {
    return worker.scheduled(event, scopeMonitorEnv(env, "saas"), ctx);
  }
};
