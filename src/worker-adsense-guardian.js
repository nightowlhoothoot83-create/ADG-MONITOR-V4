import worker from "./worker-auto.js";
import { SITES } from "./repair.js";
import { runSiteGuardian, latestSiteGuardian } from "./site-guardian.js";
import { scopeMonitorEnv } from "./scoped-kv.js";

const INDEXING_CRONS = new Set(["*/10 21-22 * * *", "0,10,20 23 * * *"]);
const DEFAULT_DAILY_INDEXING_RUN_BUDGET = 9;

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function configuredBudget(env) {
  const raw = Number(env.GSC_DAILY_RUN_BUDGET || DEFAULT_DAILY_INDEXING_RUN_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_INDEXING_RUN_BUDGET;
}

async function takeIndexingRun(env, reason) {
  if (!env.MONITOR_KV) return { allowed: true, used: 0, limit: configuredBudget(env), reason };
  const limit = configuredBudget(env);
  const key = `gsc-run-budget:${dayKey()}`;
  const used = Number(await env.MONITOR_KV.get(key) || 0);
  if (used >= limit) return { allowed: false, used, limit, reason };
  const next = used + 1;
  await env.MONITOR_KV.put(key, String(next), { expirationTtl: 172800 });
  return { allowed: true, used: next, limit, reason };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function budgetResponse(state) {
  return json({
    status: "budget_guarded",
    message: "Search Console indexing run skipped because the ADG daily safety budget has been reached.",
    used_runs: state.used,
    daily_run_budget: state.limit
  }, 429);
}

export default {
  async fetch(request, env, ctx) {
    const scoped = scopeMonitorEnv(env, "adsense");
    const url = new URL(request.url);

    if (url.pathname === "/guardian.json") return json(await latestSiteGuardian(scoped));
    if (url.pathname === "/guardian/run") {
      const siteId = url.searchParams.get("site");
      const sites = siteId ? SITES.filter(site => site.id === siteId) : SITES;
      if (!sites.length) return json({ error: "Unknown site" }, 400);
      return json(await runSiteGuardian(scoped, sites));
    }

    if (url.pathname === "/indexing/run") {
      const state = await takeIndexingRun(scoped, "manual");
      if (!state.allowed) return budgetResponse(state);
    }
    return worker.fetch(request, scoped, ctx);
  },
  async scheduled(event, env, ctx) {
    const scoped = scopeMonitorEnv(env, "adsense");
    if (INDEXING_CRONS.has(event.cron)) {
      const state = await takeIndexingRun(scoped, "scheduled");
      if (!state.allowed) return;
    }
    return worker.scheduled(event, scoped, ctx);
  }
};
