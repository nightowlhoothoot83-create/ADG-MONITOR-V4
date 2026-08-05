import { SITES, runRepairCycle, runScheduledRepairCycle } from "./repair.js";
import { auditIndexing, latestIndexing } from "./indexing.js";
import { auditRegressions, latestRegressionReport, resetRegressionBaseline } from "./regression.js";

const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

const htmlResponse = value => new Response(value, {
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
});

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
}[character]));

const isMonitorError = value => /too many subrequests|worker invocation|internal error|binding.*unavailable/i.test(String(value || ""));

function sameCanonical(left, right) {
  try {
    const normalize = value => {
      const url = new URL(value);
      url.hash = "";
      url.hostname = url.hostname.toLowerCase();
      if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
      return url.href;
    };
    return normalize(left) === normalize(right);
  } catch {
    return left === right;
  }
}

function flattenChecks(checks = {}, prefix = "") {
  return Object.entries(checks).flatMap(([name, value]) => {
    const label = `${prefix}${name}`.replaceAll("_", " ");
    return value && typeof value === "object" ? flattenChecks(value, `${label}: `) : [{ label, value }];
  });
}

function card(item) {
  const waiting = item.status === "awaiting_deployment";
  const healthy = item.status === "up";
  const tone = waiting ? "waiting" : healthy ? "healthy" : "error";
  const label = waiting ? "Awaiting deployment" : healthy ? "Online" : "Needs attention";
  const target = item.url || item.expected_url;
  const checks = flattenChecks(item.checks).map(check => {
    const passed = typeof check.value === "number" ? check.value === 0 : Boolean(check.value);
    return `<li class="${passed ? "pass" : "fail"}"><span>${passed ? "âœ“" : "!"}</span>${escapeHtml(check.label)}</li>`;
  }).join("");
  return `<article class="card ${tone}">
    <div class="card-head"><div><h3>${escapeHtml(item.name)}</h3><a href="${escapeHtml(target)}" target="_blank" rel="noreferrer">${escapeHtml(target)}</a></div><span class="status">${label}</span></div>
    ${item.http ? `<div class="metrics"><span>HTTP <b>${escapeHtml(item.http)}</b></span><span>Speed <b>${escapeHtml(item.response_ms)} ms</b></span></div>` : ""}
    ${item.message ? `<p class="message">${escapeHtml(item.message)}</p>` : ""}
    ${checks ? `<ul class="checks">${checks}</ul>` : `<p class="message">This app will be checked automatically once its Raven-Sharp address is live.</p>`}
  </article>`;
}

function regressionCard(site) {
  const confirmed = site.status === "regression_confirmed";
  const pending = site.status === "recheck_required";
  const tone = confirmed ? "error" : pending ? "waiting" : "healthy";
  const label = confirmed ? "Confirmed regression" : pending ? "Recheck pending" : "Protected";
  const failures = site.regression?.regressed_checks || [];
  return `<article class="card ${tone}">
    <div class="card-head"><div><h3>${escapeHtml(site.name)}</h3><p class="message">Known-good baseline comparison</p></div><span class="status">${label}</span></div>
    <div class="metrics"><span>Consecutive failures <b>${site.regression?.consecutive_failures || 0}</b></span></div>
    ${failures.length ? `<ul class="checks">${failures.map(failure => `<li class="fail"><span>!</span>${escapeHtml(failure)}</li>`).join("")}</ul>` : '<p class="message">No previously healthy check has fallen backwards.</p>'}
  </article>`;
}

function dashboard(siteReport, indexingReport = {}, repairReport = {}, regressionReport = {}) {
  const sites = siteReport.sites || [];
  const online = sites.filter(item => item.status === "up").length;
  const waiting = sites.filter(item => item.status === "awaiting_deployment").length;
  const attention = sites.length - online - waiting;
  const lastRun = [siteReport.run_at, indexingReport.run_at, repairReport.run_at, regressionReport.run_at].filter(Boolean).sort().at(-1);
  const indexingSites = indexingReport.sites || [];
  const discovered = indexingSites.reduce((total, site) => total + (site.discovered_count || 0), 0);
  const inspected = indexingSites.reduce((total, site) => total + (site.inspected_count || 0), 0);
  const indexed = indexingSites.reduce((total, site) => total + (site.indexed_count || 0), 0);
  const repairItems = (repairReport.results || []).flatMap(result => result.approval?.status === "approval_required" ? [{ site: result.site, changes: result.approval.changes || [] }] : []);
  const regressionSites = regressionReport.sites || [];
  const confirmedRegressions = regressionSites.filter(site => site.status === "regression_confirmed").length;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ADG AdSense Monitor</title><style>
  :root{color-scheme:dark;--bg:#07111f;--panel:#101d30;--line:#243650;--text:#f4f8ff;--muted:#9fb0c8;--green:#42d392;--amber:#f7bd58;--red:#ff6b75;--blue:#67a7ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#142b4c 0,#07111f 48%);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--text)}main{width:min(1180px,calc(100% - 32px));margin:auto;padding:42px 0 70px}header{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:24px}h1{font-size:clamp(30px,5vw,50px);line-height:1;margin:0 0 10px}.subtitle,.updated{color:var(--muted);margin:0}.actions{display:flex;gap:10px;flex-wrap:wrap}.button{background:var(--blue);color:#06101e;text-decoration:none;padding:10px 15px;border-radius:10px;font-weight:800}.button.secondary{background:#1a2a42;color:var(--text);border:1px solid var(--line)}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0 34px}.summary div{padding:20px;border:1px solid var(--line);border-radius:16px;background:#0c1829}.summary b{display:block;font-size:30px}.summary span{color:var(--muted)}section{margin-top:34px}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}h2{margin:0;font-size:23px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.card{background:linear-gradient(145deg,#122238,#0c1829);border:1px solid var(--line);border-top:4px solid var(--red);border-radius:16px;padding:19px}.card.healthy{border-top-color:var(--green)}.card.waiting{border-top-color:var(--amber)}.card-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.card h3{margin:0 0 4px;font-size:19px}.card a{color:#8dbaff;font-size:13px;word-break:break-all}.status{white-space:nowrap;padding:5px 9px;border-radius:99px;background:#3a1921;color:#ffb2b7;font-size:12px;font-weight:800}.healthy .status{background:#123729;color:#91ebbf}.waiting .status{background:#3a2d15;color:#f8d28b}.metrics{display:flex;gap:20px;margin:17px 0 7px;color:var(--muted)}.metrics b{color:var(--text)}.checks{display:grid;grid-template-columns:1fr 1fr;gap:7px 12px;list-style:none;padding:15px 0 0;margin:12px 0 0;border-top:1px solid var(--line)}.checks li{color:var(--muted);font-size:13px;text-transform:capitalize}.checks span{display:inline-grid;place-items:center;width:19px;height:19px;margin-right:7px;border-radius:50%;font-weight:900}.pass span{background:#174b36;color:#70e1ab}.fail span{background:#51242a;color:#ff9299}.message{color:var(--muted)}footer{margin-top:42px;color:var(--muted);text-align:center}@media(max-width:800px){header{align-items:start;flex-direction:column}.summary{grid-template-columns:1fr 1fr}.checks{grid-template-columns:1fr}}@media(max-width:480px){.summary{grid-template-columns:1fr}}
  </style></head><body><main><header><div><h1>ADG AdSense Monitor</h1><p class="subtitle">AdSense sites only: compliance, indexing, regression protection and controlled repairs.</p></div><div class="actions"><a class="button" href="/adsense/run">Run AdSense monitor</a><a class="button secondary" href="/regression/run">Check regressions</a><a class="button secondary" href="/indexing/run">Index next site</a><a class="button secondary" href="/repair/scan">Check repairs</a><a class="button secondary" href="/report.json">Raw data</a><a class="button secondary" href="https://adg-saas-monitor.ascensiondigitalagency.workers.dev/">Open SaaS monitor</a></div></header>
  <p class="updated">Last updated: ${lastRun ? escapeHtml(new Date(lastRun).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", dateStyle: "medium", timeStyle: "short" })) : "No report yet"} Brisbane time</p>
  <div class="summary"><div><b>${online}</b><span>Online</span></div><div><b>${attention}</b><span>Need attention</span></div><div><b>${waiting}</b><span>Awaiting deployment</span></div><div><b>${confirmedRegressions}</b><span>Confirmed regressions</span></div></div>
  <section><div class="section-head"><h2>Anti-regression guard</h2><span>${regressionSites.length} protected sites</span></div><div class="grid">${regressionSites.map(regressionCard).join("") || '<article class="card waiting"><div class="card-head"><div><h3>No baseline report yet</h3><p class="message">Run the anti-regression check to establish healthy known-good snapshots.</p></div><span class="status">Not started</span></div></article>'}</div></section>
  <section><div class="section-head"><h2>AdSense sites</h2><span>${sites.length} sites</span></div><div class="grid">${sites.map(card).join("") || "<p>No AdSense report yet.</p>"}</div></section>
  <section><div class="section-head"><h2>Page indexing</h2><span>${discovered} pages discovered</span></div><div class="actions" style="margin:0 0 14px">${SITES.map(site => `<a class="button secondary" href="/indexing/run?site=${encodeURIComponent(site.id)}">Check ${escapeHtml(site.name)}</a>`).join("")}</div><div class="grid">
    <article class="card ${indexingReport.google_configured ? "healthy" : "waiting"}"><div class="card-head"><div><h3>Google Search Console</h3><p class="message">${indexingReport.google_configured ? "Connected" : "Setup required: add the GSC service account secret"}</p></div><span class="status">${indexingReport.google_configured ? "Active" : "Setup required"}</span></div><div class="metrics"><span>Inspected <b>${inspected}</b></span><span>Indexed <b>${indexed}</b></span></div>${indexingReport.authentication_error ? `<p class="message">${escapeHtml(indexingReport.authentication_error)}</p>` : ""}</article>
    ${indexingSites.map(site => {
      const allItems = [
        ...(site.discovery_errors || []).map(item => item.message),
        ...(site.live_audits || []).filter(item => !item.passed).flatMap(item => item.issues.map(issue => `${item.url}: ${issue}`)),
        ...(site.inspections || []).filter(item => item.google_canonical && !sameCanonical(item.google_canonical, item.url)).map(item => `${item.url}: Google selected a different page: ${item.google_canonical}`)
      ];
      const monitorErrors = allItems.filter(isMonitorError);
      const issueItems = allItems.filter(item => !isMonitorError(item));
      const issueCount = issueItems.length;
      return `<article class="card ${issueCount ? "error" : monitorErrors.length ? "waiting" : "healthy"}"><div class="card-head"><div><h3>${escapeHtml(site.name)}</h3><a href="${escapeHtml(site.sitemap_urls?.[0] || site.url)}" target="_blank" rel="noreferrer">${escapeHtml(site.sitemap_urls?.[0] || "No sitemap found")}</a></div><span class="status">${issueCount ? `${issueCount} site issue(s)` : monitorErrors.length ? `${monitorErrors.length} monitor error(s)` : `${site.discovered_count || 0} pages`}</span></div><div class="metrics"><span>Google checked <b>${site.inspected_count || 0}</b></span><span>Indexed <b>${site.indexed_count || 0}</b></span><span>Live audited <b>${site.live_audited_count || 0}</b></span></div>${monitorErrors.length ? `<p class="message">Monitor execution error: ${escapeHtml(monitorErrors[0])}</p>` : ""}${issueItems.length ? `<ul class="checks">${issueItems.slice(0, 8).map(issue => `<li class="fail"><span>!</span>${escapeHtml(issue)}</li>`).join("")}</ul>` : ""}</article>`;
    }).join("")}
  </div></section>
  <section><div class="section-head"><h2>Approval queue</h2><span>${repairItems.length} waiting</span></div>${repairItems.length ? '<div class="actions" style="margin:0 0 14px"><button class="button" type="button" id="approve-repairs">Approve queued repairs</button><span id="approval-status" class="message" role="status"></span></div>' : ''}<div class="grid">${repairItems.map(item => `<article class="card waiting"><div class="card-head"><div><h3>${escapeHtml(item.site)}</h3><p class="message">These changes require your approval before a repair pull request is created.</p></div><span class="status">Approval required</span></div><ul class="checks">${item.changes.map(change => `<li class="fail"><span>!</span>${escapeHtml(change)}</li>`).join("")}</ul></article>`).join("") || '<article class="card healthy"><div class="card-head"><div><h3>No changes waiting</h3><p class="message">Safe basic corrections run automatically. Consequential fixes wait for approval.</p></div><span class="status">Clear</span></div></article>'}</div></section>
  <footer>Regressions are confirmed only after two consecutive failures. Baseline resets and consequential repairs require the approval key.</footer></main>
  <script>
  (() => {
    const button = document.getElementById('approve-repairs');
    if (!button) return;
    const status = document.getElementById('approval-status');
    button.addEventListener('click', async () => {
      const key = window.prompt('Enter the ADG Monitor repair approval key. It is sent only to this Worker and is not saved in the page.');
      if (!key) return;
      button.disabled = true;
      status.textContent = 'Submitting approved repairsâ€¦';
      try {
        const response = await fetch('/repair/run', { method: 'POST', headers: { Authorization: 'Bearer ' + key } });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Approval failed');
        status.textContent = 'Approved. Repair pull requests have been prepared; refreshing the reportâ€¦';
        window.setTimeout(() => window.location.assign('/repair/scan'), 1200);
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
      }
    });
  })();
  </script></body></html>`;
}

async function checkSite(site) {
  const started = Date.now();
  try {
    const response = await fetch(site.url, { headers: { "User-Agent": "ADG-Monitor-v4/1.0" } });
    const html = await response.text();
    const checks = {
        title: /<title>[\s\S]+?<\/title>/i.test(html),
        description: /<meta\b[^>]*name=["']description["']/i.test(html),
        canonical: /<link\b[^>]*rel=["']canonical["']/i.test(html),
        canonical_target: canonicalMatches(html, response.url),
        indexable: !/<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html),
        redirect_target: normalizedHost(response.url) === normalizedHost(site.url),
        schema: /<script\b[^>]*type=["']application\/ld\+json["']/i.test(html),
        h1: /<h1\b/i.test(html),
        privacy: /href=["'][^"']*privacy/i.test(html),
        terms: /href=["'][^"']*terms/i.test(html),
        about: /href=["'][^"']*about/i.test(html),
        contact: /href=["'][^"']*contact/i.test(html),
        cookies: /href=["'][^"']*(cookies|cookie-policy)/i.test(html),
        consent_ui: /<script\b[^>]*src=["'][^"']*cookie-consent\.js/i.test(html),
        suspicious_links: (html.match(/<a\b[^>]*href=["']#["'][^>]*>/gi) || []).length
      };
    const criticalPassed = response.ok && ["title", "description", "canonical", "canonical_target", "indexable", "redirect_target", "h1", "privacy", "terms", "about", "contact", "cookies", "consent_ui"].every(name => checks[name] === true);
    return {
      id: site.id,
      name: site.name,
      url: site.url,
      final_url: response.url,
      status: criticalPassed ? "up" : "error",
      http: response.status,
      response_ms: Date.now() - started,
      checks
    };
  } catch (error) {
    return { id: site.id, name: site.name, url: site.url, status: "error", message: error.message, response_ms: Date.now() - started };
  }
}

function normalizedHost(value) {
  return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
}

function canonicalMatches(html, pageUrl) {
  const match = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (!match) return false;
  try {
    const expected = new URL(pageUrl); expected.hash = "";
    const actual = new URL(match[1], pageUrl); actual.hash = "";
    if (expected.pathname !== "/") expected.pathname = expected.pathname.replace(/\/$/, "");
    if (actual.pathname !== "/") actual.pathname = actual.pathname.replace(/\/$/, "");
    return expected.href === actual.href;
  } catch { return false; }
}

async function audit(env) {
  const sites = await Promise.all(SITES.map(checkSite));
  const report = { version: 5, run_at: new Date().toISOString(), sites };
  if (env.MONITOR_KV) await env.MONITOR_KV.put("latest-report-v5", JSON.stringify(report));
  return report;
}

async function latest(env) {
  return env.MONITOR_KV && await env.MONITOR_KV.get("latest-report-v5", "json") || { status: "no_report", message: "Run /run first" };
}

async function repair(env, approved = false) {
  const results = approved ? await runRepairCycle(env.GITHUB_TOKEN) : await runScheduledRepairCycle(env.GITHUB_TOKEN);
  const report = { run_at: new Date().toISOString(), mode: approved ? "approved" : "scheduled_safe", results };
  if (env.MONITOR_KV) await env.MONITOR_KV.put("latest-repair-report-v1", JSON.stringify(report));
  return report;
}

async function latestRepair(env) {
  return env.MONITOR_KV && await env.MONITOR_KV.get("latest-repair-report-v1", "json") || { status: "no_report", message: "No repair cycle has run yet" };
}

async function nextIndexingSite(env) {
  const key = "indexing-site-cursor-v1";
  const prior = Number(await env.MONITOR_KV?.get(key) || 0);
  const site = SITES[prior % SITES.length];
  await env.MONITOR_KV?.put(key, String((prior + 1) % SITES.length));
  return site;
}

function approved(request, env) {
  return Boolean(env.REPAIR_APPROVAL_KEY) && request.headers.get("Authorization") === `Bearer ${env.REPAIR_APPROVAL_KEY}`;
}

async function renderDashboard(env, overrides = {}) {
  return dashboard(
    overrides.sites || await latest(env),
    overrides.indexing || await latestIndexing(env),
    overrides.repairs || await latestRepair(env),
    overrides.regressions || await latestRegressionReport(env)
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "adg-monitor-v4", monitor: "adsense-only", github_configured: Boolean(env.GITHUB_TOKEN), anti_regression: true, sites: SITES.length });
    if (url.pathname === "/run" || url.pathname === "/adsense/run") {
      const sites = await audit(env);
      return htmlResponse(await renderDashboard(env, { sites }));
    }
    if (url.pathname === "/run-all") return Response.redirect(`${url.origin}/report`, 302);
    if (url.pathname === "/report") return htmlResponse(await renderDashboard(env));
    if (url.pathname.startsWith("/saas/")) return Response.redirect("https://adg-saas-monitor.ascensiondigitalagency.workers.dev/", 302);
    if (url.pathname === "/report.json") return json({ sites: await latest(env), indexing: await latestIndexing(env), repairs: await latestRepair(env), regressions: await latestRegressionReport(env) });
    if (url.pathname === "/indexing/run") {
      const requestedSite = url.searchParams.get("site");
      const site = requestedSite ? SITES.find(item => item.id === requestedSite) : await nextIndexingSite(env);
      if (!site) return json({ error: "Unknown AdSense site", valid_sites: SITES.map(item => item.id) }, 400);
      const indexing = await auditIndexing(env, [site]);
      return htmlResponse(await renderDashboard(env, { indexing }));
    }
    if (url.pathname === "/indexing/report.json") return json(await latestIndexing(env));
    if (url.pathname === "/repair/report.json") return json(await latestRepair(env));
    if (url.pathname === "/repair/scan") {
      const repairs = await repair(env, false);
      return htmlResponse(await renderDashboard(env, { repairs }));
    }
    if (url.pathname === "/repair/run" && request.method === "POST") {
      if (!approved(request, env)) return json({ error: "Repair approval required" }, 403);
      return json(await repair(env, true));
    }
    if (url.pathname === "/regression/run") {
      const regressions = await auditRegressions(env, SITES);
      return htmlResponse(await renderDashboard(env, { regressions }));
    }
    if (url.pathname === "/regression/report.json") return json(await latestRegressionReport(env));
    if (url.pathname === "/regression/baseline" && request.method === "POST") {
      if (!approved(request, env)) return json({ error: "Baseline reset approval required" }, 403);
      return json(await resetRegressionBaseline(env, SITES));
    }
    if (url.pathname === "/") return Response.redirect(`${url.origin}/report`, 302);
    return json({ service: "ADG AdSense Monitor", endpoints: ["/health", "/adsense/run", "/report", "/report.json", "/regression/run", "/regression/report.json", "POST /regression/baseline", "/indexing/run?site=mycalctools", "/indexing/report.json", "/repair/scan", "POST /repair/run"] });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "0 21 * * *") {
      ctx.waitUntil(nextIndexingSite(env).then(site => auditIndexing(env, [site])));
      return;
    }
    if (event.cron === "0 23 * * *") {
      ctx.waitUntil(repair(env, false));
      return;
    }
    ctx.waitUntil(Promise.all([audit(env), auditRegressions(env, SITES)]));
  }
};

