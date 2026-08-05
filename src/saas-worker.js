import { runSafeSaasTests, readSaasTestState, approvedTestInventory } from "./saas-testing.js";

const APPS = [
  { id: "pod", name: "Raven-Sharp POD", url: "https://pod.raven-sharp.com", featurePaths: ["/register", "/login", "/pricing", "/legal/privacy", "/legal/terms", "/legal/cookies"] },
  { id: "image-optimiser", name: "Image Optimiser & Upscaler", url: "https://opt.raven-sharp.com", featurePaths: ["/optimiser", "/register", "/login", "/legal/privacy", "/legal/terms", "/legal/cookies"] },
  { id: "smart-cleaner", name: "Smart AI Cleaner", url: "https://cleaner.raven-sharp.com", featurePaths: ["/app.html"] },
  { id: "ad-manager", name: "Ad Manager", url: "https://ads.raven-sharp.com", featurePaths: [] },
  { id: "book-creator", name: "Book Creator", url: "https://books.raven-sharp.com", featurePaths: [] },
  { id: "content-creator", name: "Content Creator", url: "https://content.raven-sharp.com", featurePaths: [] }
];

const REPORT_KEY = "saas-monitor-report-v2";
const STATUS_KEY = "saas-monitor-status-v2";

const json = value => new Response(JSON.stringify(value, null, 2), {
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

const textOnly = html => html
  .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&(?:nbsp|amp|quot|#39);/gi, " ")
  .replace(/\s+/g, " ")
  .trim();

const count = (html, pattern) => (html.match(pattern) || []).length;
const hasLink = (html, pattern) => new RegExp(`<a\\b[^>]*href=["'][^"']*${pattern}[^"']*["']`, "i").test(html);

async function probe(app, path) {
  const started = Date.now();
  const target = new URL(path, app.url).href;
  try {
    const response = await fetch(target, { redirect: "follow", headers: { "User-Agent": "ADG-SaaS-Monitor/3.0" } });
    const type = response.headers.get("content-type") || "";
    const html = type.includes("text/html") ? (await response.text()).slice(0, 500_000) : "";
    return { path, url: target, final_url: response.url, status: response.status, passed: response.ok, response_ms: Date.now() - started, title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "" };
  } catch (error) {
    return { path, url: target, passed: false, response_ms: Date.now() - started, error: error.message };
  }
}

async function probeApi(app, path) {
  const started = Date.now();
  const target = new URL(path, app.url).href;
  try {
    const response = await fetch(target, { method: "GET", redirect: "manual", headers: { "Accept": "application/json", "User-Agent": "ADG-SaaS-Monitor/3.0" } });
    const type = response.headers.get("content-type") || "";
    const body = type.includes("json") ? await response.json().catch(() => null) : null;
    return { path, status: response.status, response_ms: Date.now() - started, json: Boolean(body), healthy: response.ok && Boolean(body), service_status: body?.status || body?.ok || null };
  } catch (error) {
    return { path, healthy: false, response_ms: Date.now() - started, error: error.message };
  }
}

function issue(severity, area, message, recommendation) {
  return { severity, area, message, recommendation };
}

async function check(app) {
  const started = Date.now();
  try {
    const response = await fetch(app.url, { redirect: "follow", headers: { "User-Agent": "ADG-SaaS-Monitor/2.0" } });
    const contentType = response.headers.get("content-type") || "";
    const html = contentType.includes("text/html") ? (await response.text()).slice(0, 1_000_000) : "";
    const copy = textOnly(html);
    const wordCount = copy ? copy.split(/\s+/).length : 0;
    const scriptCount = count(html, /<script\b[^>]*src=/gi);
    const clientRenderedShell = wordCount < 120 && scriptCount > 0;
    const h1Count = count(html, /<h1\b/gi);
    const sectionCount = count(html, /<(?:section|article)\b/gi);
    const imageCount = count(html, /<img\b/gi);
    const missingAltCount = count(html, /<img\b(?![^>]*\balt=["'][^"']+["'])[^>]*>/gi);
    const formCount = count(html, /<form\b/gi);
    const inputCount = count(html, /<(?:input|textarea|select)\b/gi);
    const labelCount = count(html, /<label\b/gi);
    const primaryAction = /(?:get started|start free|try it|open (?:app|optimiser)|create (?:free )?account|create campaign|generate|upload)/i.test(copy);
    const policy = { privacy: hasLink(html, "privacy"), terms: hasLink(html, "terms"), cookies: hasLink(html, "cookie") };
    const account = { login: hasLink(html, "login|sign-in|account") || /sign in/i.test(copy), register: hasLink(html, "register|sign-up|signup") || /create (?:one|account)|sign up/i.test(copy) };
    const pricing = hasLink(html, "pricing|plans|checkout|subscribe") || /\bpricing\b|\bplans\b/i.test(copy);
    const hubLink = /href=["']https:\/\/(?:www\.)?raven-sharp\.com\/?[^"']*["']/i.test(html);
    const suiteDomains = ["pod.raven-sharp.com", "opt.raven-sharp.com", "cleaner.raven-sharp.com", "ads.raven-sharp.com", "books.raven-sharp.com", "content.raven-sharp.com"];
    const suiteLinks = suiteDomains.filter(domain => domain !== new URL(app.url).hostname && html.toLowerCase().includes(domain)).length;
    const suiteBranding = /Raven Sharp/i.test(copy) && /Ascension Digital Group/i.test(copy);
    const siblingLinks = ["mystical-moments", "etsy.com", "spewcrew", "feedthefeed", "mycalctools", "mycalendartools", "wheelnamepicker"].filter(value => html.toLowerCase().includes(value)).length;
    const security = {
      content_security_policy: Boolean(response.headers.get("content-security-policy")),
      frame_protection: Boolean(response.headers.get("x-frame-options") || response.headers.get("content-security-policy")?.includes("frame-ancestors")),
      content_type_options: response.headers.get("x-content-type-options") === "nosniff",
      referrer_policy: Boolean(response.headers.get("referrer-policy")),
      permissions_policy: Boolean(response.headers.get("permissions-policy")),
      strict_transport_security: Boolean(response.headers.get("strict-transport-security"))
    };
    const seo = {
      title: /<title>[\s\S]+?<\/title>/i.test(html),
      description: /<meta\b[^>]*name=["']description["'][^>]*content=["'][^"']{50,}["']/i.test(html) || /<meta\b[^>]*content=["'][^"']{50,}["'][^>]*name=["']description["']/i.test(html),
      canonical: /<link\b[^>]*rel=["']canonical["']/i.test(html),
      viewport: /<meta\b[^>]*name=["']viewport["']/i.test(html),
      language: /<html\b[^>]*lang=["'][a-z]{2}/i.test(html),
      open_graph: /<meta\b[^>]*property=["']og:(?:title|description|image)["']/i.test(html)
    };
    const [routes, api_probes] = await Promise.all([
      Promise.all(app.featurePaths.map(path => probe(app, path))),
      Promise.all(["/api/health", "/api/status", "/health"].map(path => probeApi(app, path)))
    ]);
    const issues = [];
    if (!response.ok) issues.push(issue("critical", "availability", `Homepage returned HTTP ${response.status}.`, "Restore the production homepage before testing other checks."));
    if (clientRenderedShell) issues.push(issue("warning", "crawlability", `The initial HTML is a JavaScript shell with only about ${wordCount} words; visible content requires browser rendering.`, "Server-render the public product overview, navigation, pricing summary and policy footer so crawlers and link checkers receive meaningful content without executing JavaScript."));
    if (!clientRenderedShell) {
    if (wordCount < 120) issues.push(issue("critical", "content", `Homepage has only about ${wordCount} machine-readable words.`, "Add a public product overview, key benefits, how it works, use cases, pricing summary and FAQ before the sign-in form."));
    else if (wordCount < 250) issues.push(issue("warning", "content", `Homepage content is thin at about ${wordCount} words.`, "Expand the public explanation with workflow steps, use cases, feature details and FAQs."));
    if (h1Count !== 1) issues.push(issue("warning", "structure", `Expected one H1 but found ${h1Count}.`, "Use one descriptive product H1 and move secondary headings to H2/H3."));
    if (sectionCount < 3) issues.push(issue("warning", "content", `Only ${sectionCount} semantic content sections were detected.`, "Create distinct overview, features, how-it-works, pricing and FAQ sections."));
    if (!primaryAction) issues.push(issue("critical", "feature access", "No clear primary product action was detected.", "Add a prominent action that opens the tool, starts a free trial or creates an account."));
    if (!account.login || !account.register) issues.push(issue("warning", "accounts", "Login and registration paths are not both clearly available.", "Provide consistent Sign In and Create Account links in the header and footer."));
    if (!pricing) issues.push(issue("warning", "commercial", "No public pricing or plan information was detected.", "Add a pricing page or a clear free/paid plan summary."));
    for (const [name, passed] of Object.entries(policy)) if (!passed) issues.push(issue("critical", "policies", `${name[0].toUpperCase() + name.slice(1)} link is missing.`, `Add a crawlable ${name} link to the shared footer.`));
    if (!hubLink) issues.push(issue("critical", "suite consistency", "The Raven Sharp home-hub link is missing.", "Add a prominent crawlable link to https://raven-sharp.com in the shared header and footer."));
    if (!suiteBranding || siblingLinks < 4) issues.push(issue("warning", "suite consistency", "Shared Raven Sharp/ADG branding and brand navigation are incomplete.", "Use the same Raven Sharp logo/header, Ascension Digital Group footer and brand links across the suite."));
    if (suiteLinks < 3) issues.push(issue("warning", "suite consistency", `Only ${suiteLinks} direct links to other Raven Sharp SaaS tools were detected.`, "Add a shared Tools or Explore the Suite menu linking the hub and all six SaaS products."));
    if (imageCount && missingAltCount) issues.push(issue("warning", "accessibility", `${missingAltCount} of ${imageCount} images appear to lack useful alt text.`, "Add concise alt text to meaningful images and empty alt text to decorative images."));
    if (formCount && inputCount > labelCount) issues.push(issue("warning", "accessibility", `${inputCount} form controls but only ${labelCount} labels were detected.`, "Give every input a visible label or an accessible aria-label."));
    }
    for (const [name, passed] of Object.entries(security)) if (!passed) issues.push(issue(name === "content_security_policy" || name === "frame_protection" ? "critical" : "warning", "security", `${name.replaceAll("_", " ")} header is missing.`, "Apply the shared Raven Sharp security-header policy at the deployment edge."));
    for (const [name, passed] of Object.entries(seo)) if (!passed) issues.push(issue(name === "description" || name === "canonical" ? "warning" : "info", "discoverability", `${name.replaceAll("_", " ")} metadata is missing or incomplete.`, "Add this field to the shared document head template."));
    routes.filter(route => !route.passed).forEach(route => issues.push(issue("critical", "route test", `${route.path} failed${route.status ? ` with HTTP ${route.status}` : ""}.`, "Repair or remove the broken public navigation target.")));
    const healthyApi = api_probes.find(probe => probe.healthy);
    if (!healthyApi) issues.push(issue("warning", "API testing", "No non-destructive JSON health endpoint was found.", "Add an authenticated or public read-only /api/health endpoint that verifies configuration and upstream connectivity without generating content or charging providers."));
    const deductions = issues.reduce((total, item) => total + ({ critical: 12, warning: 5, info: 2 }[item.severity] || 0), 0);
    const score = Math.max(0, 100 - deductions);
    return { ...app, final_url: response.url, status: response.ok ? "up" : "error", http: response.status, response_ms: Date.now() - started, score, metrics: { word_count: wordCount, client_rendered_shell: clientRenderedShell, script_count: scriptCount, h1_count: h1Count, section_count: sectionCount, forms: formCount, inputs: inputCount, images: imageCount, missing_alt: missingAltCount, brand_links: siblingLinks, suite_links: suiteLinks }, checks: { policy, account, pricing, primary_action: primaryAction, raven_sharp_hub: hubLink, suite_branding: suiteBranding, seo, security }, routes, api_probes, api_health: healthyApi || null, issues };
  } catch (error) {
    return { ...app, status: "error", message: error.message, response_ms: Date.now() - started };
  }
}

async function run(env) {
  const startedAt = new Date().toISOString();
  await env.MONITOR_KV?.put(STATUS_KEY, JSON.stringify({ status: "running", started_at: startedAt }));
  try {
    const apps = await Promise.all(APPS.map(check));
    const averageScore = Math.round(apps.reduce((total, app) => total + (app.score || 0), 0) / Math.max(apps.length, 1));
    const totals = apps.flatMap(app => app.issues || []).reduce((result, item) => ({ ...result, [item.severity]: (result[item.severity] || 0) + 1 }), { critical: 0, warning: 0, info: 0 });
    const report = { version: 3, run_at: new Date().toISOString(), average_score: averageScore, totals, apps };
    await env.MONITOR_KV?.put(REPORT_KEY, JSON.stringify(report));
    await env.MONITOR_KV?.put(STATUS_KEY, JSON.stringify({ status: "completed", started_at: startedAt, completed_at: report.run_at }));
    return report;
  } catch (error) {
    await env.MONITOR_KV?.put(STATUS_KEY, JSON.stringify({ status: "failed", started_at: startedAt, failed_at: new Date().toISOString(), message: error.message }));
    throw error;
  }
}

async function readState(env) {
  const [report, status] = await Promise.all([
    env.MONITOR_KV?.get(REPORT_KEY, "json"),
    env.MONITOR_KV?.get(STATUS_KEY, "json")
  ]);
  return { report: report || { apps: [] }, status: status || { status: "not_started" } };
}

const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));

function page(report, status) {
  const running = status.status === "running";
  const cards = (report.apps || []).map(app => {
    const failures = (app.issues || []).map(item => `${item.severity.toUpperCase()} - ${item.area}: ${item.message} Fix: ${item.recommendation}`);
    return `<article class="card ${app.status === "up" ? "up" : "bad"}"><h2>${esc(app.name)}</h2><a href="${esc(app.url)}">${esc(app.url)}</a><p><b>${esc(app.status || "not checked")}</b>${app.http ? ` Â· HTTP ${app.http} Â· ${app.response_ms} ms` : ""}</p><p>${failures.length ? `Needs: ${esc(failures.join(", "))}` : "All configured checks passed."}</p></article>`;
  }).join("") || '<article class="card"><h2>No report yet</h2><p>Run the SaaS monitor to create the first report.</p></article>';
  const stateText = running ? "Running now â€” checking six SaaS appsâ€¦" : status.status === "failed" ? `Failed: ${esc(status.message)}` : status.status === "completed" ? `Completed ${esc(new Date(status.completed_at).toLocaleString("en-AU", { timeZone: "Australia/Brisbane" }))} Brisbane time` : "Not started";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADG SaaS Monitor</title><style>body{margin:0;background:#07111f;color:#f4f8ff;font:15px/1.5 system-ui}main{width:min(1100px,calc(100% - 32px));margin:auto;padding:42px 0}header{display:flex;justify-content:space-between;gap:20px;align-items:center}.button{display:inline-block;background:#67a7ff;color:#06101e;padding:11px 16px;border-radius:10px;text-decoration:none;font-weight:800}.button[aria-disabled=true]{opacity:.55;pointer-events:none}.state{margin:22px 0;padding:15px;border:1px solid #29405f;border-radius:12px;background:#101d30}.running{border-color:#f7bd58}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.card{background:#101d30;border:1px solid #29405f;border-top:4px solid #9fb0c8;border-radius:15px;padding:18px}.card.up{border-top-color:#42d392}.card.bad{border-top-color:#ff6b75}a{color:#8dbaff}p{color:#b6c4d8}</style></head><body><main><header><div><h1>ADG SaaS Monitor</h1><p>Six Raven-Sharp applications, separate from AdSense and remaining sites.</p></div><div style="display:flex;gap:10px;flex-wrap:wrap"><a class="button" href="/run" aria-disabled="${running}">${running ? "Runningâ€¦" : "Run SaaS monitor"}</a><a class="button" href="/testing/run">Run safe feature tests</a><a class="button" href="/testing/report.json">Testing report</a></div></header><div class="state ${running ? "running" : ""}" id="run-state">${stateText}</div><div class="grid">${cards}</div></main>${running ? `<script>const poll=setInterval(async()=>{const response=await fetch('/status.json',{cache:'no-store'});const data=await response.json();document.getElementById('run-state').textContent=data.status.status==='running'?'Running now â€” checking six SaaS appsâ€¦':data.status.status==='failed'?'Failed: '+data.status.message:'Completed â€” refreshing resultsâ€¦';if(data.status.status!=='running'){clearInterval(poll);setTimeout(()=>location.assign('/'),700)}},2000)</script>` : ""}</body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/testing/run") {
      const current = await readSaasTestState(env);
      if (current.status.status !== "running") ctx.waitUntil(runSafeSaasTests(env));
      return json({ status: "started", mode: "safe_read_only", report: "/testing/report.json", status_url: "/testing/status.json", safety: "GET-only; no credits, publishing, billing, deletion or external-data mutation." });
    }
    if (url.pathname === "/testing/status.json") return json(await readSaasTestState(env));
    if (url.pathname === "/testing/report.json") return json((await readSaasTestState(env)).report);
    if (url.pathname === "/testing/approved-inventory.json") return json(approvedTestInventory());
    if (url.pathname === "/testing/approved/run" && request.method === "POST") {
      if (!env.REPAIR_APPROVAL_KEY || request.headers.get("Authorization") !== `Bearer ${env.REPAIR_APPROVAL_KEY}`) {
        return new Response(JSON.stringify({ error: "Explicit testing approval is required." }, null, 2), { status: 403, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
      }
      return new Response(JSON.stringify({ error: "Approved mutating tests remain disabled until dedicated test accounts, provider sandbox credentials, hard spend limits and disposable-data cleanup rules are configured.", inventory: approvedTestInventory() }, null, 2), { status: 409, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/run") {
      const current = await readState(env);
      if (current.status.status !== "running") ctx.waitUntil(run(env));
      return new Response(page(current.report, { status: "running", started_at: new Date().toISOString() }), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/status.json") return json(await readState(env));
    if (url.pathname === "/report.json") return json((await readState(env)).report);
    if (url.pathname === "/health") return json({ ok: true, service: "adg-saas-monitor", version: 4, apps: APPS.length, audit: "launch-readiness", testing_agent: "safe_read_only" });
    const state = await readState(env);
    return new Response(page(state.report, state.status), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); }
};

