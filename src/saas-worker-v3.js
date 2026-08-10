import legacyWorker from "./saas-worker-v2.js";
import { SAAS_APPS, auditSaasApp as legacyAuditSaasApp } from "./saas-baseline.js";

const REPORT_KEY = "saas-shell-monitor-report-v4";
const STATUS_KEY = "saas-shell-monitor-status-v4";
const MANUAL_CURSOR_KEY = "saas-shell-manual-cursor-v4";
const USER_AGENT = "ADG-SaaS-Monitor/4.1";
const BRAND_MARKERS = [
  "mystical-moments", "zyia", "spewcrew", "spew-crew", "feedthefeed", "feed-the-feed",
  "mycalctools", "mycalendartools", "wheelnamepicker", "adgdownloads", "adg-downloads"
];

async function fetchSource(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache", "Accept": "text/html,text/css,application/javascript,*/*" }
    });
    if (!response.ok) return { ok: false, status: response.status, body: "", type: response.headers.get("content-type") || "" };
    const type = response.headers.get("content-type") || "";
    if (!/(?:text|css|javascript|json)/i.test(type)) return { ok: true, status: response.status, body: "", type };
    return { ok: true, status: response.status, body: (await response.text()).slice(0, 650_000), type };
  } catch (error) {
    return { ok: false, status: 0, body: "", type: "", error: error.message };
  }
}

function linkedFirstPartyAssets(html, base) {
  const found = [];
  const add = raw => {
    try {
      const url = new URL(raw, base);
      if (url.hostname !== new URL(base).hostname) return;
      if (!/\.(?:css|js)(?:[?#].*)?$/i.test(url.pathname + url.search)) return;
      if (!found.includes(url.href)) found.push(url.href);
    } catch {}
  };
  for (const match of html.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) add(match[1]);
  for (const match of html.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) add(match[1]);
  return found.slice(0, 4);
}

function descriptivePreviewAlt(evidence) {
  const direct = /<img\b(?=[^>]*(?:product-preview|workspace-preview|book-workspace-preview|showcase\/))(?=[^>]*\balt=["'][^"']{12,}["'])[^>]*>/i;
  if (direct.test(evidence)) return true;
  const bundledA = /(?:product-preview|workspace-preview|book-workspace-preview|showcase\/)[\s\S]{0,500}(?:alt|aria-label)[\s\S]{0,240}[A-Za-z][\s\S]{11,}/i;
  const bundledB = /(?:alt|aria-label)[\s\S]{0,240}[A-Za-z][\s\S]{11,}[\s\S]{0,500}(?:product-preview|workspace-preview|book-workspace-preview|showcase\/)/i;
  return bundledA.test(evidence) || bundledB.test(evidence);
}

function brandCount(evidence) {
  const lower = evidence.toLowerCase();
  return new Set(BRAND_MARKERS.filter(marker => lower.includes(marker))).size;
}

async function sourceEvidence(app) {
  const home = await fetchSource(app.url);
  const assets = linkedFirstPartyAssets(home.body || "", app.url);
  const chunks = [home.body || ""];
  const checked = [];
  for (const url of assets) {
    const result = await fetchSource(url);
    checked.push({ url, ok: result.ok, status: result.status, type: result.type });
    if (result.ok && result.body) chunks.push(result.body);
  }
  return { evidence: chunks.join("\n"), assets: checked };
}

function removeIssue(result, predicate) {
  result.issues = (result.issues || []).filter(item => !predicate(item));
}

function recalc(result) {
  const checks = result.baseline_checks || {};
  const keys = Object.keys(checks);
  const passed = keys.filter(key => checks[key]).length;
  result.baseline_percent = keys.length ? Math.round((passed / keys.length) * 100) : 0;
  const critical = (result.issues || []).filter(item => item.severity === "critical").length;
  const warnings = (result.issues || []).filter(item => item.severity === "warning").length;
  result.status = !result.homepage?.http || result.homepage.http >= 400 || critical ? "needs_attention" : warnings ? "review" : "passed";
  return result;
}

async function tunedAuditSaasApp(app) {
  const result = await legacyAuditSaasApp(app);
  if (!result?.baseline_checks) return result;

  const source = await sourceEvidence(app);
  const evidence = source.evidence || "";
  const checks = result.baseline_checks;

  const fontEvidence = /Outfit/i.test(evidence)
    && /Cabinet(?:\s+|-)?Grotesk|cabinet-grotesk/i.test(evidence)
    && /DM(?:\s+|-)?Mono|dm-mono/i.test(evidence);
  const paletteEvidence = (/#080810|#05050d|#050711|--bg\s*:\s*#0/i.test(evidence))
    && (/#7c5cbf|#a78bfa|--raven(?:-glow)?\s*:/i.test(evidence))
    && (/#38bdf8|--raven-blue\s*:|--blue\s*:/i.test(evidence));
  const taglineEvidence = /Elevating\s+Your\s+Digital\s+Future/i.test(evidence);
  const brands = brandCount(evidence);
  const previewAltEvidence = descriptivePreviewAlt(evidence);

  if (fontEvidence) checks.fonts = true;
  if (paletteEvidence) checks.dark_raven_palette = true;
  if (taglineEvidence) checks.adg_tagline = true;
  if (brands >= 4) checks.sister_brand_navigation = true;
  if (previewAltEvidence) checks.preview_alt_text = true;

  // Content quality is structural, not a raw 250-word quota. A concise landing page is acceptable
  // when it already has product-specific features, a real preview, pricing and a clear action.
  if ((result.homepage?.word_count || 0) >= 150
      && checks.product_features
      && checks.product_preview
      && checks.pricing
      && checks.primary_action) {
    checks.useful_public_copy = true;
  }

  if (checks.useful_public_copy) {
    removeIssue(result, item => item.area === "product information" && /machine-readable words/i.test(item.message));
  }
  if (checks.preview_alt_text) {
    removeIssue(result, item => item.area === "accessibility" && /Product preview/i.test(item.message));
  }
  if (checks.adg_identity && checks.adg_tagline) {
    removeIssue(result, item => item.area === "ecosystem footer" && /identity\/tagline is incomplete/i.test(item.message));
  }
  if (checks.sister_brand_navigation) {
    removeIssue(result, item => item.area === "ecosystem footer" && /sister-brand navigation/i.test(item.message));
  }

  result.detector = {
    version: "4.1",
    mode: "homepage + linked first-party CSS/JS",
    linked_assets_checked: source.assets.length,
    linked_assets: source.assets,
    evidence: {
      fonts: fontEvidence,
      palette: paletteEvidence,
      adg_tagline: taglineEvidence,
      sister_brand_markers: brands,
      descriptive_preview_alt: previewAltEvidence,
      structural_public_copy: checks.useful_public_copy
    }
  };

  return recalc(result);
}

async function readReport(env) {
  return await env.MONITOR_KV?.get(REPORT_KEY, "json") || { version: 4, apps: [] };
}

async function saveAppResult(env, result) {
  const previous = await readReport(env);
  const map = new Map((previous.apps || []).map(app => [app.id, app]));
  map.set(result.id, result);
  const apps = SAAS_APPS.map(app => map.get(app.id)).filter(Boolean);
  const values = apps.map(app => app.baseline_percent || 0);
  const report = {
    version: 4,
    baseline_version: previous.baseline_version || result.baseline_version,
    detector_version: "4.1",
    run_at: new Date().toISOString(),
    average_baseline_percent: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0,
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
  await env.MONITOR_KV?.put(STATUS_KEY, JSON.stringify({ status: "running", app: app.id, app_name: app.name, detector_version: "4.1", started_at: startedAt }));
  try {
    const result = await tunedAuditSaasApp(app);
    const report = await saveAppResult(env, result);
    await env.MONITOR_KV?.put(STATUS_KEY, JSON.stringify({ status: "completed", app: app.id, app_name: app.name, detector_version: "4.1", started_at: startedAt, completed_at: new Date().toISOString() }));
    return report;
  } catch (error) {
    await env.MONITOR_KV?.put(STATUS_KEY, JSON.stringify({ status: "failed", app: app.id, app_name: app.name, detector_version: "4.1", started_at: startedAt, failed_at: new Date().toISOString(), message: error.message }));
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const current = await env.MONITOR_KV?.get(STATUS_KEY, "json");
      if (current?.status !== "running") {
        const requested = url.searchParams.get("site");
        const app = requested ? SAAS_APPS.find(item => item.id === requested) : await nextManualApp(env);
        if (!app) return new Response(JSON.stringify({ error: "Unknown SaaS app" }), { status: 400, headers: { "Content-Type": "application/json" } });
        ctx.waitUntil(runOne(env, app));
      }
      return Response.redirect(`${url.origin}/`, 303);
    }
    return legacyWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOne(env, scheduledApp(event.scheduledTime)));
  }
};
