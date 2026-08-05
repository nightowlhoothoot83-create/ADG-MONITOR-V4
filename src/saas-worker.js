const APPS = [
  { id: "pod", name: "Raven-Sharp POD", url: "https://pod.raven-sharp.com" },
  { id: "image-optimiser", name: "Image Optimiser & Upscaler", url: "https://opt.raven-sharp.com" },
  { id: "smart-cleaner", name: "Smart AI Cleaner", url: "https://cleaner.raven-sharp.com" },
  { id: "ad-manager", name: "Ad Manager", url: "https://ads.raven-sharp.com" },
  { id: "book-creator", name: "Book Creator", url: "https://books.raven-sharp.com" },
  { id: "content-creator", name: "Content Creator", url: "https://content.raven-sharp.com" }
];

const REPORT_KEY = "saas-monitor-report-v2";
const STATUS_KEY = "saas-monitor-status-v2";

const json = value => new Response(JSON.stringify(value, null, 2), {
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

async function check(app) {
  const started = Date.now();
  try {
    const response = await fetch(app.url, { redirect: "follow", headers: { "User-Agent": "ADG-SaaS-Monitor/2.0" } });
    const contentType = response.headers.get("content-type") || "";
    const html = contentType.includes("text/html") ? (await response.text()).slice(0, 1_000_000) : "";
    const checks = {
      title: /<title>[\s\S]+?<\/title>/i.test(html),
      description: /<meta\b[^>]*name=["']description["']/i.test(html),
      login_or_account: /href=["'][^"']*(login|sign-in|account)/i.test(html),
      pricing_or_checkout: /href=["'][^"']*(pricing|plans|checkout|subscribe)/i.test(html),
      privacy: /href=["'][^"']*privacy/i.test(html),
      terms: /href=["'][^"']*terms/i.test(html),
      content_security_policy: Boolean(response.headers.get("content-security-policy")),
      frame_protection: Boolean(response.headers.get("x-frame-options") || response.headers.get("content-security-policy")?.includes("frame-ancestors")),
      content_type_options: response.headers.get("x-content-type-options") === "nosniff",
      referrer_policy: Boolean(response.headers.get("referrer-policy"))
    };
    return { ...app, final_url: response.url, status: response.ok ? "up" : "error", http: response.status, response_ms: Date.now() - started, checks };
  } catch (error) {
    return { ...app, status: "error", message: error.message, response_ms: Date.now() - started };
  }
}

async function run(env) {
  const startedAt = new Date().toISOString();
  await env.MONITOR_KV?.put(STATUS_KEY, JSON.stringify({ status: "running", started_at: startedAt }));
  try {
    const apps = await Promise.all(APPS.map(check));
    const report = { version: 2, run_at: new Date().toISOString(), apps };
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
    const failures = Object.entries(app.checks || {}).filter(([, passed]) => !passed).map(([name]) => name.replaceAll("_", " "));
    return `<article class="card ${app.status === "up" ? "up" : "bad"}"><h2>${esc(app.name)}</h2><a href="${esc(app.url)}">${esc(app.url)}</a><p><b>${esc(app.status || "not checked")}</b>${app.http ? ` Â· HTTP ${app.http} Â· ${app.response_ms} ms` : ""}</p><p>${failures.length ? `Needs: ${esc(failures.join(", "))}` : "All configured checks passed."}</p></article>`;
  }).join("") || '<article class="card"><h2>No report yet</h2><p>Run the SaaS monitor to create the first report.</p></article>';
  const stateText = running ? "Running now â€” checking six SaaS appsâ€¦" : status.status === "failed" ? `Failed: ${esc(status.message)}` : status.status === "completed" ? `Completed ${esc(new Date(status.completed_at).toLocaleString("en-AU", { timeZone: "Australia/Brisbane" }))} Brisbane time` : "Not started";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADG SaaS Monitor</title><style>body{margin:0;background:#07111f;color:#f4f8ff;font:15px/1.5 system-ui}main{width:min(1100px,calc(100% - 32px));margin:auto;padding:42px 0}header{display:flex;justify-content:space-between;gap:20px;align-items:center}.button{display:inline-block;background:#67a7ff;color:#06101e;padding:11px 16px;border-radius:10px;text-decoration:none;font-weight:800}.button[aria-disabled=true]{opacity:.55;pointer-events:none}.state{margin:22px 0;padding:15px;border:1px solid #29405f;border-radius:12px;background:#101d30}.running{border-color:#f7bd58}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.card{background:#101d30;border:1px solid #29405f;border-top:4px solid #9fb0c8;border-radius:15px;padding:18px}.card.up{border-top-color:#42d392}.card.bad{border-top-color:#ff6b75}a{color:#8dbaff}p{color:#b6c4d8}</style></head><body><main><header><div><h1>ADG SaaS Monitor</h1><p>Six Raven-Sharp applications, separate from AdSense and remaining sites.</p></div><a class="button" href="/run" aria-disabled="${running}">${running ? "Runningâ€¦" : "Run SaaS monitor"}</a></header><div class="state ${running ? "running" : ""}" id="run-state">${stateText}</div><div class="grid">${cards}</div></main>${running ? `<script>const poll=setInterval(async()=>{const response=await fetch('/status.json',{cache:'no-store'});const data=await response.json();document.getElementById('run-state').textContent=data.status.status==='running'?'Running now â€” checking six SaaS appsâ€¦':data.status.status==='failed'?'Failed: '+data.status.message:'Completed â€” refreshing resultsâ€¦';if(data.status.status!=='running'){clearInterval(poll);setTimeout(()=>location.assign('/'),700)}},2000)</script>` : ""}</body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const current = await readState(env);
      if (current.status.status !== "running") ctx.waitUntil(run(env));
      return new Response(page(current.report, { status: "running", started_at: new Date().toISOString() }), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/status.json") return json(await readState(env));
    if (url.pathname === "/health") return json({ ok: true, service: "adg-saas-monitor", apps: APPS.length });
    const state = await readState(env);
    return new Response(page(state.report, state.status), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); }
};

