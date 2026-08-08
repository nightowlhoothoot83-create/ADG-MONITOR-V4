import baseWorker from "./index.js";
import { SITES, runRepairCycle, runScheduledRepairCycle } from "./repair.js";
import { auditIndexing, latestIndexing } from "./indexing.js";

const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

function approved(request, env) {
  return Boolean(env.REPAIR_APPROVAL_KEY) && request.headers.get("Authorization") === `Bearer ${env.REPAIR_APPROVAL_KEY}`;
}

async function runRepairWithIndexing(env, isApproved) {
  const indexing = await latestIndexing(env);
  const results = isApproved
    ? await runRepairCycle(env.GITHUB_TOKEN, indexing)
    : await runScheduledRepairCycle(env.GITHUB_TOKEN, indexing);
  const report = {
    run_at: new Date().toISOString(),
    mode: isApproved ? "approved" : "scheduled_safe",
    indexing_report_version: indexing.version || null,
    results
  };
  if (env.MONITOR_KV) await env.MONITOR_KV.put("latest-repair-report-v1", JSON.stringify(report));
  return report;
}

const INDEXING_CRONS = new Set(["*/10 21-22 * * *", "0,10,20 23 * * *"]);

function indexingSiteForScheduledTime(scheduledTime) {
  const date = new Date(scheduledTime);
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const slot = ((hour - 21) * 6) + Math.floor(minute / 10);
  return SITES[slot % SITES.length];
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/repair/scan") {
      await runRepairWithIndexing(env, false);
      return Response.redirect(`${url.origin}/report`, 303);
    }

    if (url.pathname === "/repair/run" && request.method === "POST") {
      if (!approved(request, env)) return json({ error: "Repair approval required" }, 403);
      return json(await runRepairWithIndexing(env, true));
    }

    return baseWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    if (INDEXING_CRONS.has(event.cron)) {
      const site = indexingSiteForScheduledTime(event.scheduledTime);
      ctx.waitUntil(auditIndexing(env, [site]));
      return;
    }

    if (event.cron === "40 23 * * *") {
      ctx.waitUntil(runRepairWithIndexing(env, false));
      return;
    }

    return baseWorker.scheduled(event, env, ctx);
  }
};
