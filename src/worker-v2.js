import monitorWorker from "./worker.js";
import { SITES } from "./repair.js";
import { auditSiteQuality, latestSiteQuality } from "./quality.js";

const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

const QUALITY_CRON = "10,20,30 20 * * *";

function siteForQualityCron(scheduledTime) {
  const minute = new Date(scheduledTime).getUTCMinutes();
  const index = minute === 10 ? 0 : minute === 20 ? 1 : 2;
  return SITES[index] || SITES[0];
}

async function nextManualSite(env) {
  const key = "quality-manual-site-v1";
  const current = Number(await env.MONITOR_KV?.get(key) || 0) % SITES.length;
  await env.MONITOR_KV?.put(key, String((current + 1) % SITES.length));
  return SITES[current];
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[c]));
}

function qualitySection(report) {
  const sites = report?.sites || [];
  const cards = sites.map(site => {
    const bad = site.status === "needs_attention";
    const monitorError = site.status === "monitor_error";
    const tone = bad ? "error" : monitorError ? "waiting" : "healthy";
    const label = bad ? "Needs attention" : monitorError ? "Monitor error" : "Clean";
    const metrics = monitorError ? "" : `<div class="metrics">
      <span>Recent pages <b>${site.known_recent_count || 0}/${site.discovered_count || 0}</b></span>
      <span>Legacy links <b>${(site.legacy_internal_link_count || 0) + (site.shared_source_legacy_reference_count || 0)}</b></span>
      <span>Generic copy <b>${site.generic_content_pattern_count || 0}</b></span>
      <span>Missing unique info <b>${site.missing_unique_content_count || 0}</b></span>
    </div>`;
    const issues = [];
    if (site.error) issues.push(site.error);
    if (site.shared_source_legacy_reference_count) issues.push(`${site.shared_source.path}: ${site.shared_source_legacy_reference_count} .html reference(s)`);
    for (const page of site.pages || []) {
      for (const issue of page.issues || []) {
        if (issues.length >= 8) break;
        issues.push(`${page.url}: ${issue}`);
      }
      if (issues.length >= 8) break;
    }
    return `<article class="card ${tone}">
      <div class="card-head"><div><h3>${esc(site.name)}</h3><a href="${esc(site.url)}" target="_blank" rel="noreferrer">${esc(site.url)}</a></div><span class="status">${label}</span></div>
      ${metrics}
      ${site.thin_content_advisory_count ? `<p class="message">${site.thin_content_advisory_count} thin-content advisory item(s) are informational, not automatic failures.</p>` : ""}
      ${issues.length ? `<ul class="checks">${issues.map(issue => `<li class="fail"><span>!</span>${esc(issue)}</li>`).join("")}</ul>` : `<p class="message">No legacy internal links, canonical defects or generic-content patterns found in the recent checked set.</p>`}
    </article>`;
  }).join("");

  return `<section id="quality-audit"><div class="section-head"><h2>Content &amp; URL quality</h2><span>${sites.length} sites tracked</span></div>
    <div class="actions" style="margin:0 0 14px"><a class="button secondary" href="/quality/run">Check next quality site</a>${SITES.map(site => `<a class="button secondary" href="/quality/run?site=${encodeURIComponent(site.id)}">Check ${esc(site.name)}</a>`).join("")}<a class="button secondary" href="/quality.json">Quality JSON</a></div>
    <div class="grid">${cards || `<article class="card waiting"><div class="card-head"><div><h3>No quality report yet</h3><p class="message">Run the quality audit to check internal links and repeated content.</p></div><span class="status">Not started</span></div></article>`}</div>
  </section>`;
}

async function injectQuality(response, env) {
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;
  const report = await latestSiteQuality(env);
  let html = await response.text();
  const section = qualitySection(report);
  if (html.includes('<section><div class="section-head"><h2>Approval queue</h2>')) {
    html = html.replace('<section><div class="section-head"><h2>Approval queue</h2>', `${section}<section><div class="section-head"><h2>Approval queue</h2>`);
  } else {
    html = html.replace("</main>", `${section}</main>`);
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/quality.json") return json(await latestSiteQuality(env));
    if (url.pathname === "/report.json") {
      const response = await monitorWorker.fetch(request, env, ctx);
      if (!response.ok) return response;
      const report = await response.json();
      return json({ ...report, quality: await latestSiteQuality(env) });
    }
    if (url.pathname === "/quality/run") {
      const siteId = url.searchParams.get("site");
      const sites = siteId ? SITES.filter(site => site.id === siteId) : [await nextManualSite(env)];
      if (!sites.length) return json({ error: "Unknown site" }, 400);
      await auditSiteQuality(env, sites);
      return Response.redirect(`${url.origin}/report`, 303);
    }
    return injectQuality(await monitorWorker.fetch(request, env, ctx), env);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === QUALITY_CRON) {
      ctx.waitUntil(auditSiteQuality(env, [siteForQualityCron(event.scheduledTime)]));
      return;
    }
    return monitorWorker.scheduled(event, env, ctx);
  }
};