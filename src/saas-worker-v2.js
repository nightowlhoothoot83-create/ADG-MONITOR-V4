import { SAAS_APPS, RAVEN_SHELL_BASELINE, RAVEN_SHELL_VERSION, auditSaasApp } from "./saas-baseline.js";
import { runSafeSaasTests, readSaasTestState, approvedTestInventory } from "./saas-testing.js";

const REPORT_KEY = "saas-shell-monitor-report-v4";
const STATUS_KEY = "saas-shell-monitor-status-v4";
const MANUAL_CURSOR_KEY = "saas-shell-manual-cursor-v4";

const json = value => new Response(JSON.stringify(value, null, 2), {
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
}[c]));

async function readReport(env) {
  return await env.MONITOR_KV?.get(REPORT_KEY, "json") || {
    version: 4,
    baseline_version: RAVEN_SHELL_VERSION,
    run_at: null,
    apps: []
  };
}

async function readStatus(env) {
  return await env.MONITOR_KV?.get(STATUS_KEY, "json") || {
    status: "not_started",
    baseline_version: RAVEN_SHELL_VERSION
  };
}

async function saveAppResult(env, result) {
  const previous = await readReport(env);
  const map = new Map((previous.apps || []).map(app => [app.id, app]));
  map.set(result.id, result);
  const apps = SAAS_APPS.map(app => map.get(app.id)).filter(Boolean);
  const baselineValues = apps.map(app => app.baseline_percent || 0);
  const report = {
    version: 4,
    baseline_version: RAVEN_SHELL_VERSION,
    run_at: new Date().toISOString(),
    average_baseline_percent: baselineValues.length ? Math.round(baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length) : 0,
    passed: apps.filter(app => app.status === "passed").length,
    review: apps.filter(app => app.status === "review").length,
    needs_attention: apps.filter(app => app.status === "needs_attention").length,
    apps
  };
  await env.MONITOR_KV?.put(REPORT_KEY, JSON.stringify(report));
  return report;
}

async function runOne(env, app) {
  const startedAt = new Date().toISOString();
  await env.MONITOR_KV?.put(STATUS_KEY, JSON.stringify({
    status: "running",
    app: app.id,
    app_name: app.name,
    baseline_version: RAVEN_SHELL_VERSION,
    started_at: startedAt
  }));
  try {
    const result = await auditSaasApp(app);
    const report = await saveAppResult(env, result);
    await env.MONITOR_KV?.put(STATUS_KEY, JSON.stringify({
      status: "completed",
      app: app.id,
      app_name: app.name,
      baseline_version: RAVEN_SHELL_VERSION,
      started_at: startedAt,
      completed_at: new Date().toISOString()
    }));
    return report;
  } catch (error) {
    await env.MONITOR_KV?.put(STATUS_KEY, JSON.stringify({
      status: "failed",
      app: app.id,
      app_name: app.name,
      baseline_version: RAVEN_SHELL_VERSION,
      started_at: startedAt,
      failed_at: new Date().toISOString(),
      message: error.message
    }));
    throw error;
  }
}

async function nextManualApp(env) {
  const cursor = Number(await env.MONITOR_KV?.get(MANUAL_CURSOR_KEY) || 0) % SAAS_APPS.length;
  await env.MONITOR_KV?.put(MANUAL_CURSOR_KEY, String((cursor + 1) % SAAS_APPS.length));
  return SAAS_APPS[cursor];
}

function scheduledApp(scheduledTime) {
  const minute = new Date(scheduledTime).getUTCMinutes();
  const index = Math.max(0, [0, 10, 20, 30, 40, 50].indexOf(minute));
  return SAAS_APPS[index] || SAAS_APPS[0];
}

function issueList(app) {
  const issues = app.issues || [];
  if (!issues.length) return '<p class="quiet">No baseline or availability issues detected in this check.</p>';
  return `<ul class="issues">${issues.slice(0, 10).map(item => `<li class="${esc(item.severity)}"><b>${esc(item.severity)}</b> ${esc(item.message)}</li>`).join("")}</ul>`;
}

function appCard(app) {
  const tone = app.status === "passed" ? "good" : app.status === "review" ? "review" : "bad";
  const homepage = app.homepage || {};
  const mode = homepage.client_rendered_shell ? "Client-rendered" : "Server/static HTML";
  return `<article class="card ${tone}">
    <div class="card-head"><div><h3>${esc(app.name)}</h3><a href="${esc(app.url)}" target="_blank" rel="noreferrer">${esc(app.url)}</a></div><span class="pill">${esc(app.status)}</span></div>
    <div class="score"><strong>${esc(app.baseline_percent)}%</strong><span>canonical shell match</span></div>
    <div class="metrics">
      <span>HTTP <b>${esc(homepage.http || 0)}</b></span>
      <span>Mode <b>${esc(mode)}</b></span>
      <span>Entry <b>${esc(app.workspace?.path || "not found")}</b></span>
      <span>Preview <b>${esc(app.assets?.preview || (app.baseline_checks?.product_preview ? "in page" : "not found"))}</b></span>
    </div>
    ${issueList(app)}
  </article>`;
}

function baselinePanel() {
  const groups = [
    ["Header", RAVEN_SHELL_BASELINE.header],
    ["Hero", RAVEN_SHELL_BASELINE.hero],
    ["Product information", RAVEN_SHELL_BASELINE.product_content],
    ["Ecosystem footer", RAVEN_SHELL_BASELINE.ecosystem_footer]
  ];
  return `<section><div class="section-head"><div><h2>Canonical Raven Sharp baseline</h2><p>Version: ${esc(RAVEN_SHELL_VERSION)}</p></div></div>
    <div class="baseline-grid">
      ${groups.map(([name, items]) => `<article class="baseline"><h3>${esc(name)}</h3><ul>${items.map(item => `<li>${esc(item)}</li>`).join("")}</ul></article>`).join("")}
    </div>
    <p class="visual"><b>Visual family:</b> ${esc(RAVEN_SHELL_BASELINE.visual_system.background)} · ${RAVEN_SHELL_BASELINE.visual_system.accent_family.map(esc).join(" · ")} · ${esc(RAVEN_SHELL_BASELINE.visual_system.display_font)} / ${esc(RAVEN_SHELL_BASELINE.visual_system.body_font)} / ${esc(RAVEN_SHELL_BASELINE.visual_system.utility_font)}</p>
  </section>`;
}

function dashboard(report, status, testState) {
  const running = status.status === "running";
  const known = new Map((report.apps || []).map(app => [app.id, app]));
  const cards = SAAS_APPS.map(app => known.get(app.id)
    ? appCard(known.get(app.id))
    : `<article class="card pending"><div class="card-head"><div><h3>${esc(app.name)}</h3><a href="${esc(app.url)}" target="_blank" rel="noreferrer">${esc(app.url)}</a></div><span class="pill">not checked</span></div><p class="quiet">Waiting for its first canonical-shell audit.</p></article>`).join("");
  const stateText = running
    ? `Checking ${status.app_name || status.app} against the canonical Raven Sharp shell…`
    : status.status === "failed"
      ? `Last check failed: ${status.message || "Unknown error"}`
      : status.status === "completed"
        ? `Last checked ${status.app_name || status.app} at ${new Date(status.completed_at).toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })} Brisbane time.`
        : "No canonical-shell check has run yet.";
  const testText = testState.status?.status === "running"
    ? "Safe feature tests are running."
    : testState.status?.status === "completed"
      ? `Safe feature tests completed ${new Date(testState.status.completed_at).toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })} Brisbane time.`
      : "Safe feature tests have not run under the new route model yet.";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADG SaaS Monitor</title><style>
  :root{color-scheme:dark;--bg:#080810;--panel:#10101d;--panel2:#17172b;--line:#2a2a4f;--text:#f4f4ff;--muted:#9ba3d9;--purple:#7c5cbf;--glow:#a78bfa;--blue:#38bdf8;--gold:#ffc857;--green:#4ade80;--red:#fb7185}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% 0,rgba(124,92,191,.18),transparent 34%),var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{width:min(1180px,calc(100% - 32px));margin:auto;padding:42px 0 70px}header{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;margin-bottom:22px}h1{margin:0;font-size:clamp(32px,5vw,52px);letter-spacing:-.04em}h2{margin:0 0 4px}.sub,.quiet,.visual,.section-head p{color:var(--muted)}.actions{display:flex;gap:9px;flex-wrap:wrap}.button{display:inline-block;background:linear-gradient(135deg,var(--purple),var(--blue));color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:800}.button.secondary{background:#17172b;border:1px solid var(--line)}.state{padding:14px 16px;border:1px solid var(--line);border-radius:13px;background:#10101d;margin:18px 0}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0 32px}.summary div{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:18px}.summary b{display:block;font-size:28px}.summary span{color:var(--muted)}section{margin-top:34px}.section-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}.card,.baseline{background:linear-gradient(145deg,var(--panel2),var(--panel));border:1px solid var(--line);border-top:4px solid #6b7280;border-radius:17px;padding:18px}.card.good{border-top-color:var(--green)}.card.review{border-top-color:var(--gold)}.card.bad{border-top-color:var(--red)}.card-head{display:flex;justify-content:space-between;gap:12px}.card h3,.baseline h3{margin:0 0 4px}.card a{color:#9bc7ff;font-size:12px}.pill{padding:5px 8px;border-radius:999px;background:#22223f;color:#ddd;font-size:11px;height:max-content}.score{display:flex;align-items:baseline;gap:8px;margin:16px 0}.score strong{font-size:34px}.score span{color:var(--muted)}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;color:var(--muted)}.metrics b{color:var(--text);word-break:break-word}.issues{list-style:none;padding:12px 0 0;margin:14px 0 0;border-top:1px solid var(--line)}.issues li{padding:5px 0;color:var(--muted)}.issues b{font-size:10px;text-transform:uppercase;margin-right:6px}.issues .critical b{color:var(--red)}.issues .warning b{color:var(--gold)}.issues .info b{color:var(--blue)}.baseline-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.baseline ul{padding-left:18px;color:var(--muted);font-size:13px}.visual{padding:14px;border:1px solid var(--line);border-radius:12px}@media(max-width:900px){.baseline-grid{grid-template-columns:1fr 1fr}.summary{grid-template-columns:1fr 1fr}}@media(max-width:600px){header{align-items:flex-start;flex-direction:column}.baseline-grid,.summary{grid-template-columns:1fr}.metrics{grid-template-columns:1fr}}
  </style></head><body><main><header><div><h1>ADG SaaS Monitor</h1><p class="sub">Raven Sharp suite consistency, public product information and safe functional entry checks.</p></div><div class="actions"><a class="button" href="/run">Check next app</a><a class="button secondary" href="/testing/run">Run safe feature tests</a><a class="button secondary" href="/report.json">Raw report</a></div></header>
  <div class="state">${esc(stateText)}<br><span class="quiet">${esc(testText)}</span></div>
  <div class="summary"><div><b>${esc(report.average_baseline_percent || 0)}%</b><span>Average shell match</span></div><div><b>${esc(report.passed || 0)}</b><span>Passed</span></div><div><b>${esc(report.review || 0)}</b><span>Review</span></div><div><b>${esc(report.needs_attention || 0)}</b><span>Need attention</span></div></div>
  ${baselinePanel()}
  <section><div class="section-head"><div><h2>Six Raven Sharp products</h2><p>Each product keeps its own information and workspace while sharing the same presentation system.</p></div><div class="actions">${SAAS_APPS.map(app => `<a class="button secondary" href="/run?site=${encodeURIComponent(app.id)}">${esc(app.productLabel)}</a>`).join("")}</div></div><div class="grid">${cards}</div></section>
  </main>${running ? `<script>const poll=setInterval(async()=>{const r=await fetch('/status.json',{cache:'no-store'});const d=await r.json();if(d.status.status!=='running'){clearInterval(poll);location.reload()}},1800)</script>` : ""}</body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/report.json") return json(await readReport(env));
    if (url.pathname === "/status.json") return json({ status: await readStatus(env) });
    if (url.pathname === "/baseline.json") return json({ version: RAVEN_SHELL_VERSION, baseline: RAVEN_SHELL_BASELINE });

    if (url.pathname === "/testing/report.json") return json((await readSaasTestState(env)).report);
    if (url.pathname === "/testing/status.json") return json((await readSaasTestState(env)).status);
    if (url.pathname === "/testing/inventory.json") return json(approvedTestInventory());
    if (url.pathname === "/testing/run") {
      const state = await readSaasTestState(env);
      if (state.status.status !== "running") ctx.waitUntil(runSafeSaasTests(env));
      return Response.redirect(`${url.origin}/`, 303);
    }

    if (url.pathname === "/run") {
      const current = await readStatus(env);
      if (current.status !== "running") {
        const requested = url.searchParams.get("site");
        const app = requested ? SAAS_APPS.find(item => item.id === requested) : await nextManualApp(env);
        if (!app) return json({ error: "Unknown SaaS app" });
        ctx.waitUntil(runOne(env, app));
      }
      return Response.redirect(`${url.origin}/`, 303);
    }

    const [report, status, testState] = await Promise.all([readReport(env), readStatus(env), readSaasTestState(env)]);
    return new Response(dashboard(report, status, testState), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOne(env, scheduledApp(event.scheduledTime)));
  }
};
