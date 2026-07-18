import { SITES, runRepairCycle } from "./repair.js";

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
    if (url.pathname === "/health") return json({ ok: true, service: "adg-monitor-v4", github_configured: Boolean(env.GITHUB_TOKEN) });
    if (url.pathname === "/run") return json(await audit(env));
    if (url.pathname === "/report") return json(await latest(env));
    if (url.pathname === "/repair/run" && request.method === "POST") {
      if (!env.REPAIR_APPROVAL_KEY || request.headers.get("Authorization") !== `Bearer ${env.REPAIR_APPROVAL_KEY}`) {
        return json({ error: "Repair approval required" }, 403);
      }
      return json({ run_at: new Date().toISOString(), results: await runRepairCycle(env.GITHUB_TOKEN) });
    }
    return json({ service: "ADG Monitor v4", endpoints: ["/health", "/run", "/report", "POST /repair/run"] });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(audit(env));
  }
};

