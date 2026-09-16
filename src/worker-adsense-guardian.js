import worker from "./worker-auto.js";
import { SITES } from "./repair.js";
import { latestIndexing } from "./indexing.js";
import { runSiteGuardian, latestSiteGuardian } from "./site-guardian.js";
import { scopeMonitorEnv } from "./scoped-kv.js";

const INDEXING_CRONS = new Set(["*/10 21-22 * * *", "0,10,20 23 * * *"]);
const REPAIR_CRONS = new Set(["0 23 * * *", "40 23 * * *"]);
const REPAIR_PATHS = new Set(["/repair/scan", "/repair/run"]);
const DEFAULT_DAILY_INDEXING_RUN_BUDGET = 9;
const REVIEW_FREEZE = Object.freeze({
  active: true,
  started: "2026-09-17",
  reason: "AdSense review freeze: keep the submitted site versions unchanged while Google reviews them.",
  sites: SITES.map(site => ({ id: site.id, name: site.name, url: site.url })),
  automated_site_repairs: "disabled",
  automated_repair_merges: "disabled",
  audits_and_indexing: "enabled"
});

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

function reviewFreezeResponse() {
  return json({
    status: "review_frozen",
    message: "Site-changing repair actions are locked while the three AdSense sites are under review. Audit-only checks remain available.",
    review_freeze: REVIEW_FREEZE
  }, 423);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[c]));
}

function indexingManagerSection(report = {}) {
  const sites = report.sites || [];
  if (!sites.length) return "";
  const totals = sites.reduce((acc, site) => {
    acc.indexed += site.indexed_count || 0;
    acc.healthy += site.unindexed_healthy_count || 0;
    acc.faults += site.technical_indexing_fault_count || 0;
    acc.manual += site.manual_request_count || 0;
    return acc;
  }, { indexed: 0, healthy: 0, faults: 0, manual: 0 });

  const cards = sites.map(site => {
    const queue = site.manual_request_queue || [];
    const sitemap = site.sitemap_submission_status || "unknown";
    const tone = (site.technical_indexing_fault_count || 0) ? "error" : queue.length ? "waiting" : "healthy";
    const label = (site.technical_indexing_fault_count || 0)
      ? `${site.technical_indexing_fault_count} technical fault(s)`
      : queue.length ? `${queue.length} manual request(s)` : "No indexing fault";
    const queueHtml = queue.length
      ? `<ul class="checks">${queue.map(item => `<li class="advisory"><span>↗</span><a href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(item.url)}</a><br><small>${esc(item.coverage_state || "Not indexed")}. Request indexing manually in Search Console if this page matters.</small></li>`).join("")}</ul>`
      : `<p class="message">No healthy unindexed URL currently needs a manual Request Indexing nudge.</p>`;
    return `<article class="card ${tone}">
      <div class="card-head"><div><h3>${esc(site.name)}</h3><p class="message">Sitemap: ${esc(sitemap.replaceAll("_", " "))}</p></div><span class="status">${esc(label)}</span></div>
      <div class="metrics"><span>Indexed <b>${site.indexed_count || 0}</b></span><span>Healthy unindexed <b>${site.unindexed_healthy_count || 0}</b></span><span>Technical faults <b>${site.technical_indexing_fault_count || 0}</b></span></div>
      ${queueHtml}
    </article>`;
  }).join("");

  return `<section id="indexing-manager"><div class="section-head"><h2>Indexing manager</h2><span>Google-safe workflow</span></div>
    <p class="message">Sitemaps are submitted at most once a day unless they change. Google URL Inspection is used to classify pages, not to pretend we can API-submit ordinary pages for indexing.</p>
    <div class="metrics"><span>Indexed <b>${totals.indexed}</b></span><span>Healthy but unindexed <b>${totals.healthy}</b></span><span>Technical faults <b>${totals.faults}</b></span><span>Manual request queue <b>${totals.manual}</b></span></div>
    <div class="grid">${cards}</div>
  </section>`;
}

async function decorateMonitorResponse(response, pathname, env) {
  const type = response.headers.get("content-type") || "";

  if (type.includes("application/json") && ["/health", "/report.json", "/quality.json", "/repair/report.json"].includes(pathname)) {
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); }
    catch { return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }); }
    return json({ ...body, review_freeze: REVIEW_FREEZE }, response.status);
  }

  if (!type.includes("text/html")) return response;

  let html = await response.text();
  const banner = `<section id="adsense-review-freeze" style="margin:18px 0 26px;padding:16px 18px;border:1px solid #5a4a22;border-radius:14px;background:#2b2414;color:#f8d28b"><strong>🔒 AdSense review freeze active</strong><p style="margin:7px 0 0;color:#e9d7ae">MyCalcTools, MyCalendarTools and Wheel Name Picker are pinned to their submitted review versions. Automated repair PRs and automatic repair merges are disabled. Audits, ads.txt checks, regression checks and indexing checks stay on. Content-quality results are ADG monitor diagnostics, not a Google AdSense decision.</p></section>`;

  if (!html.includes('id="adsense-review-freeze"')) {
    html = html.replace(/<main([^>]*)>/i, `<main$1>${banner}`);
  }

  if (pathname === "/report" && !html.includes('id="indexing-manager"')) {
    const indexing = await latestIndexing(env);
    const manager = indexingManagerSection(indexing);
    if (manager) {
      html = html.replace(
        '<section><div class="section-head"><h2>Page indexing</h2>',
        `${manager}<section><div class="section-head"><h2>Page indexing</h2>`,
      );
    }
  }

  html = html
    .replaceAll("thin-content advisory item(s) are informational, not automatic failures.", "short-page word-count note(s) are informational and are not an AdSense policy verdict.")
    .replaceAll("Thin-content advisory:", "Short-page word-count note:")
    .replaceAll(">Index next site<", ">Check next site's indexing<")
    .replace(/<a class="button secondary" href="\/repair\/scan">Check repairs<\/a>/g, '<span class="button secondary" aria-disabled="true" title="Locked during AdSense review">Repairs locked</span>')
    .replace("</head>", "<style>#approve-repairs{display:none!important}#indexing-manager .checks{grid-template-columns:1fr}#indexing-manager .checks li{text-transform:none}#indexing-manager small{color:var(--muted)}</style></head>");

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("Cache-Control", "no-store");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const scoped = scopeMonitorEnv(env, "adsense");
    const url = new URL(request.url);

    if (REPAIR_PATHS.has(url.pathname)) return reviewFreezeResponse();

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

    return decorateMonitorResponse(await worker.fetch(request, scoped, ctx), url.pathname, scoped);
  },
  async scheduled(event, env, ctx) {
    const scoped = scopeMonitorEnv(env, "adsense");

    if (REPAIR_CRONS.has(event.cron)) {
      if (scoped.MONITOR_KV) {
        ctx.waitUntil(scoped.MONITOR_KV.put("latest-review-freeze-event-v1", JSON.stringify({
          run_at: new Date().toISOString(),
          status: "review_frozen",
          cron: event.cron,
          message: "Scheduled site repair cycle skipped during AdSense review freeze."
        })));
      }
      return;
    }

    if (INDEXING_CRONS.has(event.cron)) {
      const state = await takeIndexingRun(scoped, "scheduled");
      if (!state.allowed) return;
    }
    return worker.scheduled(event, scoped, ctx);
  }
};
