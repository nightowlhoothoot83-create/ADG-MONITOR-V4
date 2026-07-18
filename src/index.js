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
    if (url.pathname === "/report") return json(await latest(env));
    if (url.pathname === "/saas/run") return json(await auditSaas(env));
    if (url.pathname === "/saas/report") return json(await latestSaas(env));
    if (url.pathname === "/repair/run" && request.method === "POST") {
      if (!env.REPAIR_APPROVAL_KEY || request.headers.get("Authorization") !== `Bearer ${env.REPAIR_APPROVAL_KEY}`) {
        return json({ error: "Repair approval required" }, 403);
      }
      return json({ run_at: new Date().toISOString(), results: await runRepairCycle(env.GITHUB_TOKEN) });
    }
    return json({ service: "ADG Monitor v4", endpoints: ["/health", "/run", "/report", "/saas/run", "/saas/report", "POST /repair/run"] });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([audit(env), auditSaas(env)]));
  }
};

