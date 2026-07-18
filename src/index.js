import { SITES, runRepairCycle } from "./repair.js";

const SAAS_APPS = [
  { id: "pod", name: "Raven-Sharp POD", repo: "Raven-Sharp-POD", url: "https://pod.raven-sharp.com", deployed: true },
  { id: "image-optimiser", name: "Image Optimiser & Upscaler", repo: "raven-sharp-image-optimiser-and-upscaler", url: "https://opt.raven-sharp.com", deployed: true },
  { id: "smart-cleaner", name: "Smart AI Cleaner", repo: "Raven-Sharp-Smart-AI-Cleaner", url: "https://cleaner.raven-sharp.com", deployed: false },
  { id: "ad-manager", name: "Ad Manager", repo: "Raven-Sharp-Ad-Manager", url: "https://ads.raven-sharp.com", deployed: false },
  { id: "book-creator", name: "Book Creator", repo: "Raven-Sharp-Book-Creator", url: "https://books.raven-sharp.com", deployed: false },
  { id: "content-creator", name: "Content Creator", repo: "Raven-Sharp-Content-Creator", url: "https://content.raven-sharp.com", deployed: false }
];

const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
}[character]));

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

function dashboard(siteReport, saasReport) {
  const sites = siteReport.sites || [];
  const apps = saasReport.apps || [];
  const all = [...sites, ...apps];
  const online = all.filter(item => item.status === "up").length;
  const waiting = all.filter(item => item.status === "awaiting_deployment").length;
  const attention = all.length - online - waiting;
  const lastRun = [siteReport.run_at, saasReport.run_at].filter(Boolean).sort().at(-1);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ADG Monitor V4</title><style>
  :root{color-scheme:dark;--bg:#07111f;--panel:#101d30;--line:#243650;--text:#f4f8ff;--muted:#9fb0c8;--green:#42d392;--amber:#f7bd58;--red:#ff6b75;--blue:#67a7ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#142b4c 0,#07111f 48%);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--text)}main{width:min(1180px,calc(100% - 32px));margin:auto;padding:42px 0 70px}header{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:24px}h1{font-size:clamp(30px,5vw,50px);line-height:1;margin:0 0 10px}.subtitle,.updated{color:var(--muted);margin:0}.actions{display:flex;gap:10px;flex-wrap:wrap}.button{background:var(--blue);color:#06101e;text-decoration:none;padding:10px 15px;border-radius:10px;font-weight:800}.button.secondary{background:#1a2a42;color:var(--text);border:1px solid var(--line)}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:22px 0 34px}.summary div{padding:20px;border:1px solid var(--line);border-radius:16px;background:#0c1829}.summary b{display:block;font-size:30px}.summary span{color:var(--muted)}section{margin-top:34px}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}h2{margin:0;font-size:23px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.card{background:linear-gradient(145deg,#122238,#0c1829);border:1px solid var(--line);border-top:4px solid var(--red);border-radius:16px;padding:19px}.card.healthy{border-top-color:var(--green)}.card.waiting{border-top-color:var(--amber)}.card-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.card h3{margin:0 0 4px;font-size:19px}.card a{color:#8dbaff;font-size:13px;word-break:break-all}.status{white-space:nowrap;padding:5px 9px;border-radius:99px;background:#3a1921;color:#ffb2b7;font-size:12px;font-weight:800}.healthy .status{background:#123729;color:#91ebbf}.waiting .status{background:#3a2d15;color:#f8d28b}.metrics{display:flex;gap:20px;margin:17px 0 7px;color:var(--muted)}.metrics b{color:var(--text)}.checks{display:grid;grid-template-columns:1fr 1fr;gap:7px 12px;list-style:none;padding:15px 0 0;margin:12px 0 0;border-top:1px solid var(--line)}.checks li{color:var(--muted);font-size:13px;text-transform:capitalize}.checks span{display:inline-grid;place-items:center;width:19px;height:19px;margin-right:7px;border-radius:50%;font-weight:900}.pass span{background:#174b36;color:#70e1ab}.fail span{background:#51242a;color:#ff9299}.message{color:var(--muted)}footer{margin-top:42px;color:var(--muted);text-align:center}@media(max-width:700px){header{align-items:start;flex-direction:column}.summary{grid-template-columns:1fr}.checks{grid-template-columns:1fr}}
  </style></head><body><main><header><div><h1>ADG Monitor V4</h1><p class="subtitle">Clear health checks for your AdSense sites and Raven-Sharp SaaS apps.</p></div><div class="actions"><a class="button" href="/run-all">Run all checks</a><a class="button secondary" href="/report.json">Raw data</a></div></header>
  <p class="updated">Last updated: ${lastRun ? escapeHtml(new Date(lastRun).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", dateStyle: "medium", timeStyle: "short" })) : "No report yet"} Brisbane time</p>
  <div class="summary"><div><b>${online}</b><span>Online</span></div><div><b>${attention}</b><span>Need attention</span></div><div><b>${waiting}</b><span>Awaiting deployment</span></div></div>
  <section><div class="section-head"><h2>AdSense sites</h2><span>${sites.length} sites</span></div><div class="grid">${sites.map(card).join("") || "<p>No AdSense report yet.</p>"}</div></section>
  <section><div class="section-head"><h2>Raven-Sharp SaaS</h2><span>${apps.length} apps</span></div><div class="grid">${apps.map(card).join("") || "<p>No SaaS report yet.</p>"}</div></section>
  <footer>Checks run automatically each day. â€œRun all checksâ€ uses one request per deployed site.</footer></main></body></html>`;
}

const html = value => new Response(value, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

async function checkSite(site) {
  const started = Date.now();
  try {
    const response = await fetch(site.url, { headers: { "User-Agent": "ADG-Monitor-v4/1.0" } });
    const html = await response.text();
    return {
      id: site.id,
      name: site.name,
      url: site.url,
      status: response.ok ? "up" : "error",
      http: response.status,
      response_ms: Date.now() - started,
      checks: {
        title: /<title>[\s\S]+?<\/title>/i.test(html),
        description: /<meta\b[^>]*name=["']description["']/i.test(html),
        canonical: /<link\b[^>]*rel=["']canonical["']/i.test(html),
        schema: /<script\b[^>]*type=["']application\/ld\+json["']/i.test(html),
        h1: /<h1\b/i.test(html),
        privacy: /href=["'][^"']*privacy/i.test(html),
        terms: /href=["'][^"']*terms/i.test(html),
        about: /href=["'][^"']*about/i.test(html),
        contact: /href=["'][^"']*contact/i.test(html),
        suspicious_links: (html.match(/<a\b[^>]*href=["']#["']/gi) || []).length
      }
    };
  } catch (error) {
    return { id: site.id, name: site.name, url: site.url, status: "error", message: error.message, response_ms: Date.now() - started };
  }
}

async function checkSaas(app) {
  if (!app.deployed) {
    return { id: app.id, name: app.name, repo: `nightowlhoothoot83-create/${app.repo}`, expected_url: app.url, status: "awaiting_deployment" };
  }

  const started = Date.now();
  try {
    const response = await fetch(app.url, { redirect: "follow", headers: { "User-Agent": "ADG-SaaS-Monitor/1.0" } });
    const contentType = response.headers.get("content-type") || "";
    const html = contentType.includes("text/html") ? (await response.text()).slice(0, 1_000_000) : "";
    return {
      id: app.id, name: app.name, repo: `nightowlhoothoot83-create/${app.repo}`, url: app.url,
      final_url: response.url, status: response.ok ? "up" : "error", http: response.status, response_ms: Date.now() - started,
      checks: {
        custom_domain: new URL(response.url).hostname.endsWith("raven-sharp.com"),
        title: /<title>[\s\S]+?<\/title>/i.test(html),
        description: /<meta\b[^>]*name=["']description["']/i.test(html),
        login_or_account: /href=["'][^"']*(login|sign-in|account)/i.test(html),
        pricing_or_checkout: /href=["'][^"']*(pricing|plans|checkout|subscribe)/i.test(html),
        privacy: /href=["'][^"']*privacy/i.test(html),
        terms: /href=["'][^"']*terms/i.test(html),
        security_headers: {
          content_security_policy: Boolean(response.headers.get("content-security-policy")),
          frame_protection: Boolean(response.headers.get("x-frame-options") || response.headers.get("content-security-policy")?.includes("frame-ancestors")),
          content_type_options: response.headers.get("x-content-type-options") === "nosniff",
          referrer_policy: Boolean(response.headers.get("referrer-policy"))
        }
      }
    };
  } catch (error) {
    return { id: app.id, name: app.name, repo: `nightowlhoothoot83-create/${app.repo}`, url: app.url, status: "error", message: error.message, response_ms: Date.now() - started };
  }
}

async function auditSaas(env) {
  const apps = await Promise.all(SAAS_APPS.map(checkSaas));
  const report = { version: 1, run_at: new Date().toISOString(), call_policy: "one homepage request per deployed app per daily run", apps };
  if (env.MONITOR_KV) await env.MONITOR_KV.put("latest-saas-report-v1", JSON.stringify(report));
  return report;
}

async function latestSaas(env) {
  const report = env.MONITOR_KV && await env.MONITOR_KV.get("latest-saas-report-v1", "json");
  return report || { status: "no_report", message: "Run /saas/run first" };
}

async function audit(env) {
  const sites = await Promise.all(SITES.map(checkSite));
  const report = { version: 4, run_at: new Date().toISOString(), sites };
  if (env.MONITOR_KV) await env.MONITOR_KV.put("latest-report-v5", JSON.stringify(report));
  return report;
}

async function latest(env) {
  const report = env.MONITOR_KV && await env.MONITOR_KV.get("latest-report-v5", "json");
  return report || { status: "no_report", message: "Run /run first" };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "adg-monitor-v4", github_configured: Boolean(env.GITHUB_TOKEN), saas_apps: SAAS_APPS.length });
    if (url.pathname === "/run") return json(await audit(env));
    if (url.pathname === "/run-all") {
      const [sites, apps] = await Promise.all([audit(env), auditSaas(env)]);
      return html(dashboard(sites, apps));
    }
    if (url.pathname === "/report" || url.pathname === "/saas/report") return html(dashboard(await latest(env), await latestSaas(env)));
    if (url.pathname === "/report.json") return json({ sites: await latest(env), saas: await latestSaas(env) });
    if (url.pathname === "/saas/run") return json(await auditSaas(env));
    if (url.pathname === "/saas/report.json") return json(await latestSaas(env));
    if (url.pathname === "/repair/run" && request.method === "POST") {
      if (!env.REPAIR_APPROVAL_KEY || request.headers.get("Authorization") !== `Bearer ${env.REPAIR_APPROVAL_KEY}`) {
        return json({ error: "Repair approval required" }, 403);
      }
      return json({ run_at: new Date().toISOString(), results: await runRepairCycle(env.GITHUB_TOKEN) });
    }
    if (url.pathname === "/") return Response.redirect(`${url.origin}/report`, 302);
    return json({ service: "ADG Monitor v4", endpoints: ["/health", "/run-all", "/report", "/report.json", "/saas/run", "/saas/report.json", "POST /repair/run"] });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([audit(env), auditSaas(env)]));
  }
};

