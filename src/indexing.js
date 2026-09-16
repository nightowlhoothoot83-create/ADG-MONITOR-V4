const TOKEN_URL = "https://oauth2.googleapis.com/token";
const INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const MAX_SITEMAPS = 5;
const MAX_PAGES = 100;
const LIVE_PER_RUN = 20;
const INSPECT_PER_RUN = 8;
const MANUAL_QUEUE_PER_SITE = 5;
const MAX_BYTES = 1_000_000;
const enc = new TextEncoder();

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemBytes(pem) {
  const s = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function googleToken(raw) {
  const c = JSON.parse(raw);
  if (!c.client_email || !c.private_key) throw new Error("GSC service account JSON is missing client_email or private_key");
  const now = Math.floor(Date.now() / 1000);
  const h = b64(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: c.private_key_id })));
  const p = b64(enc.encode(JSON.stringify({
    iss: c.client_email,
    scope: "https://www.googleapis.com/auth/webmasters",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })));
  const u = `${h}.${p}`;
  const k = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(c.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, enc.encode(u));
  const assertion = `${u}.${b64(new Uint8Array(sig))}`;
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google authentication failed (${r.status}): ${j.error_description || j.error || "unknown error"}`);
  return j.access_token;
}

async function text(r) {
  const n = Number(r.headers.get("content-length") || 0);
  if (n > MAX_BYTES) throw new Error(`Response exceeds ${MAX_BYTES} bytes`);
  const t = await r.text();
  if (enc.encode(t).byteLength > MAX_BYTES) throw new Error(`Response exceeds ${MAX_BYTES} bytes`);
  return t;
}

function host(v) {
  return new URL(v).hostname.toLowerCase().replace(/^www\./, "");
}

function norm(v) {
  const u = new URL(v);
  u.hash = "";
  u.hostname = host(v);
  if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/$/, "");
  return u.href;
}

function canonical(html, url) {
  const m = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (!m) return null;
  try { return new URL(m[1], url).href; } catch { return null; }
}

function words(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(x => /[a-z0-9]/i.test(x)).length;
}

const candidate = (kind, url, message, extra = {}) => ({ kind, url, message, ...extra });

async function tracedFetch(url) {
  const seen = new Set();
  const chain = [];
  let cur = url;
  for (let i = 0; i < 8; i++) {
    if (seen.has(cur)) throw new Error(`Redirect loop detected at ${cur}`);
    seen.add(cur);
    const r = await fetch(cur, {
      redirect: "manual",
      headers: { "User-Agent": "ADG-Monitor-v4-Indexability/3.0", "Cache-Control": "no-cache" },
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return { r, final: cur, chain, error: `HTTP ${r.status} has no Location header` };
      const next = new URL(loc, cur).href;
      chain.push({ from: cur, to: next, status: r.status });
      cur = next;
      continue;
    }
    return { r, final: cur, chain, error: null };
  }
  throw new Error(`Too many redirects from ${url}`);
}

async function auditPage(url) {
  try {
    const x = await tracedFetch(url);
    const ct = x.r.headers.get("content-type") || "";
    const html = ct.includes("text/html") ? (await text(x.r)).slice(0, MAX_BYTES) : "";
    const can = canonical(html, x.final);
    const redirect = norm(url) !== norm(x.final);
    const canBad = !!can && norm(can) !== norm(x.final);
    const noindex = /<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html)
      || /(?:^|,)\s*noindex\s*(?:,|$)/i.test(x.r.headers.get("x-robots-tag") || "");
    const issues = [];
    const advisories = [];
    const rep = [];
    if (x.error) {
      issues.push(x.error);
      rep.push(candidate("redirect_error", url, x.error, { redirect_chain: x.chain }));
    }
    if (!x.r.ok) {
      const m = `HTTP ${x.r.status}`;
      issues.push(m);
      rep.push(candidate("http_error", url, m, { status: x.r.status, final_url: x.final }));
    }
    if (!ct.includes("text/html")) {
      const m = `Unexpected content type: ${ct || "missing"}`;
      issues.push(m);
      rep.push(candidate("content_type", url, m, { content_type: ct, final_url: x.final }));
    }
    if (redirect) {
      const m = `Sitemap URL redirects to ${x.final}`;
      issues.push(m);
      rep.push(candidate("redirect", url, m, { final_url: x.final, redirect_chain: x.chain }));
    }
    if (ct.includes("text/html")) {
      if (!can) {
        issues.push("Missing canonical");
        rep.push(candidate("missing_canonical", url, "Missing canonical", { final_url: x.final }));
      } else if (canBad) {
        const m = `Canonical points to ${can}`;
        issues.push(m);
        rep.push(candidate("canonical_mismatch", url, m, { canonical: can, final_url: x.final }));
      }
      if (noindex) {
        issues.push("Page is marked noindex");
        rep.push(candidate("noindex", url, "Page is marked noindex", { final_url: x.final }));
      }
      const wc = words(html);
      if (wc < 300) advisories.push(`Short page: approximately ${wc} visible words`);
    }
    return {
      url,
      final_url: x.final,
      http: x.r.status,
      canonical: can,
      redirect_chain: x.chain,
      noindex,
      passed: issues.length === 0,
      issues,
      advisories,
      repair_candidates: rep,
      audited_at: new Date().toISOString(),
    };
  } catch (e) {
    return {
      url,
      passed: false,
      issues: [e.message],
      advisories: [],
      repair_candidates: [candidate("fetch_error", url, e.message)],
      audited_at: new Date().toISOString(),
    };
  }
}

function xmlLocs(xml) {
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
    .map(m => m[1].replace(/&amp;/g, "&").trim())
    .filter(Boolean);
}

function sameSite(v, site) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && host(v) === host(site);
  } catch {
    return false;
  }
}

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function discover(site) {
  const q = [`${site.url}/sitemap.xml`];
  const seen = new Set();
  const pages = new Set();
  const errors = [];
  const sitemapBodies = [];
  try {
    const r = await fetch(`${site.url}/robots.txt`, { headers: { "User-Agent": "ADG-Monitor-v4/3.0" } });
    if (r.ok) {
      for (const m of (await text(r)).matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
        if (!q.includes(m[1])) q.push(m[1]);
      }
    }
  } catch {}

  while (q.length && seen.size < MAX_SITEMAPS && pages.size < MAX_PAGES) {
    const s = q.shift();
    if (seen.has(s)) continue;
    seen.add(s);
    try {
      const r = await fetch(s, { headers: { "User-Agent": "ADG-Monitor-v4/3.0", "Cache-Control": "no-cache" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const xml = await text(r);
      sitemapBodies.push(`${s}\n${xml}`);
      const locs = xmlLocs(xml);
      if (/<sitemapindex\b/i.test(xml)) {
        for (const l of locs) if (q.length + seen.size < MAX_SITEMAPS) q.push(l);
      } else {
        for (const l of locs) if (pages.size < MAX_PAGES && sameSite(l, site.url)) pages.add(new URL(l).href);
      }
    } catch (e) {
      errors.push({ sitemap: s, message: e.message });
    }
  }

  return {
    sitemap_urls: [...seen],
    discovered_pages: [...pages],
    errors,
    sitemap_fingerprint: await digest(sitemapBodies.join("\n---\n")),
  };
}

function prop(site) {
  return site.searchConsoleProperty || `sc-domain:${new URL(site.url).hostname}`;
}

async function submit(site, sitemap, token) {
  const r = await fetch(`${WEBMASTERS}/sites/${encodeURIComponent(prop(site))}/sitemaps/${encodeURIComponent(sitemap)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Sitemap submission failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  return true;
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

async function maybeSubmitSitemap(env, site, sitemap, fingerprint, token) {
  const key = `sitemap-submit-v2:${site.id}`;
  const previous = await env.MONITOR_KV?.get(key, "json");
  const today = utcDay();
  const unchangedToday = previous
    && previous.day === today
    && previous.sitemap === sitemap
    && previous.fingerprint === fingerprint;

  if (unchangedToday) {
    return {
      status: "unchanged_today",
      submitted: false,
      last_submitted_at: previous.submitted_at || null,
      reason: "Sitemap is unchanged and was already submitted today.",
    };
  }

  await submit(site, sitemap, token);
  const record = {
    day: today,
    sitemap,
    fingerprint,
    submitted_at: new Date().toISOString(),
  };
  await env.MONITOR_KV?.put(key, JSON.stringify(record), { expirationTtl: 1209600 });
  return {
    status: previous?.fingerprint && previous.fingerprint !== fingerprint ? "changed_and_submitted" : "submitted",
    submitted: true,
    last_submitted_at: record.submitted_at,
    reason: previous?.fingerprint && previous.fingerprint !== fingerprint
      ? "Sitemap changed, so it was resubmitted immediately."
      : "Sitemap submitted to Google Search Console.",
  };
}

async function inspect(site, url, token) {
  const r = await fetch(INSPECT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl: url, siteUrl: prop(site), languageCode: "en-AU" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`URL Inspection failed (${r.status}): ${j.error?.message || "unknown error"}`);
  const x = j.inspectionResult?.indexStatusResult || {};
  return {
    url,
    verdict: x.verdict || "VERDICT_UNSPECIFIED",
    coverage_state: x.coverageState || "Unknown",
    indexing_state: x.indexingState || "Unknown",
    robots_txt_state: x.robotsTxtState || "Unknown",
    page_fetch_state: x.pageFetchState || "Unknown",
    google_canonical: x.googleCanonical || null,
    user_canonical: x.userCanonical || null,
    last_crawl_time: x.lastCrawlTime || null,
    inspected_at: new Date().toISOString(),
  };
}

function canonicalConflict(x) {
  if (!x?.google_canonical || !x?.user_canonical) return false;
  try {
    if (norm(x.google_canonical) === norm(x.user_canonical)) return false;
    return norm(x.google_canonical) !== norm(x.url);
  } catch {
    return x.google_canonical !== x.user_canonical;
  }
}

function googleRep(x) {
  if (!x || x.verdict === "ERROR") return [];
  const a = [];
  const cov = String(x.coverage_state || "");
  const rob = String(x.robots_txt_state || "");
  const fet = String(x.page_fetch_state || "");
  const idx = String(x.indexing_state || "");
  if (/disallow|blocked/i.test(rob)) a.push(candidate("google_robots_block", x.url, `Google reports robots.txt state: ${rob}`));
  if (fet && !/successful|unknown|unspecified/i.test(fet)) a.push(candidate("google_fetch", x.url, `Google reports page fetch state: ${fet}`));
  if (/blocked|noindex/i.test(idx)) a.push(candidate("google_indexing_block", x.url, `Google reports indexing state: ${idx}`));
  if (/server error|not found|soft 404|redirect error|forbidden|unauthori|blocked/i.test(cov)) {
    a.push(candidate("google_coverage_error", x.url, `Google coverage state: ${cov}`));
  }
  if (canonicalConflict(x)) {
    a.push(candidate("google_canonical_conflict", x.url, `Google selected ${x.google_canonical} instead of ${x.user_canonical}`));
  }
  return a;
}

function googleObs(x) {
  if (!x || x.verdict === "ERROR" || googleRep(x).length || x.verdict === "PASS") return null;
  return `${x.url}: ${String(x.coverage_state || x.indexing_state || x.verdict)}`;
}

function dedupe(a) {
  const s = new Set();
  return a.filter(x => {
    const k = `${x.kind}|${x.url || x.sitemap || ""}|${x.message}`;
    if (s.has(k)) return false;
    s.add(k);
    return true;
  });
}

async function rotate(env, site, pages, count, keyName) {
  if (!pages.length || count <= 0) return [];
  const key = `${keyName}:${site.id}`;
  const p = Number(await env.MONITOR_KV?.get(key) || 0);
  const start = p % pages.length;
  const n = Math.min(count, pages.length);
  const out = Array.from({ length: n }, (_, i) => pages[(start + i) % pages.length]);
  await env.MONITOR_KV?.put(key, String((start + n) % pages.length));
  return out;
}

async function batchInspect(env, site, pages, audits, prev) {
  const pri = [];
  const add = u => { if (u && pages.includes(u) && !pri.includes(u)) pri.push(u); };
  for (const a of audits) if ((a.repair_candidates || []).length) add(a.url);
  for (const x of prev?.inspections || []) if (x.verdict !== "PASS") add(x.url);
  const out = pri.slice(0, INSPECT_PER_RUN);
  if (out.length < INSPECT_PER_RUN) {
    out.push(...await rotate(
      env,
      site,
      pages.filter(u => !out.includes(u)),
      INSPECT_PER_RUN - out.length,
      "indexing-cursor-v3",
    ));
  }
  return out;
}

async function mapLimit(values, fn) {
  const out = new Array(values.length);
  let i = 0;
  async function run() {
    while (i < values.length) {
      const n = i++;
      out[n] = await fn(values[n]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, values.length || 1) }, run));
  return out;
}

function manualPriority(x) {
  const coverage = String(x.coverage_state || "");
  if (/crawled.*not indexed/i.test(coverage)) return 30;
  if (/discovered.*not indexed/i.test(coverage)) return 20;
  if (/unknown to google/i.test(coverage)) return 10;
  return 1;
}

function classifyInspections(inspections, liveAudits) {
  const auditByUrl = new Map((liveAudits || []).map(a => [a.url, a]));
  const indexed = [];
  const unindexedHealthy = [];
  const technicalFault = [];
  const pendingVerification = [];

  for (const x of inspections || []) {
    if (x.verdict === "PASS") {
      indexed.push(x);
      continue;
    }
    if (x.verdict === "ERROR") {
      pendingVerification.push({ ...x, reason: x.message || "Google inspection failed" });
      continue;
    }
    const audit = auditByUrl.get(x.url);
    const googleFaults = googleRep(x);
    if (googleFaults.length || (audit && !audit.passed)) {
      technicalFault.push({
        ...x,
        faults: [
          ...googleFaults.map(item => item.message),
          ...(audit?.issues || []),
        ],
      });
      continue;
    }
    if (audit?.passed) {
      unindexedHealthy.push(x);
      continue;
    }
    pendingVerification.push({ ...x, reason: "Not indexed, but the live page has not yet been re-audited in the current 24-hour window." });
  }

  const manualQueue = [...unindexedHealthy]
    .sort((a, b) => manualPriority(b) - manualPriority(a))
    .slice(0, MANUAL_QUEUE_PER_SITE)
    .map(x => ({
      url: x.url,
      coverage_state: x.coverage_state,
      last_crawl_time: x.last_crawl_time,
      recommendation: "Request indexing manually in Google Search Console if this page is important.",
    }));

  return {
    indexed,
    unindexed_healthy: unindexedHealthy,
    technical_fault: technicalFault,
    pending_verification: pendingVerification,
    manual_request_queue: manualQueue,
  };
}

export async function auditIndexing(env, sites, { merge = sites.length === 1 } = {}) {
  const prev = await env.MONITOR_KV?.get("latest-indexing-report-v1", "json");
  const raw = env.GSC_SERVICE_ACCOUNT_JSON || env.GSC_SERVICE_ACCOUNT_KEY;
  const configured = !!raw;
  let token = null;
  let authErr = null;
  if (configured) {
    try { token = await googleToken(raw); } catch (e) { authErr = e.message; }
  }

  const results = [];
  for (const site of sites) {
    const old = prev?.sites?.find(x => x.id === site.id);
    const d = await discover(site);
    const entry = {
      id: site.id,
      name: site.name,
      url: site.url,
      search_console_property: prop(site),
      sitemap_urls: d.sitemap_urls,
      sitemap_fingerprint: d.sitemap_fingerprint,
      discovered_count: d.discovered_pages.length,
      discovered_pages: d.discovered_pages,
      discovery_errors: d.errors,
      google_configured: configured,
      sitemap_submitted: false,
      sitemap_submission_status: configured ? "pending" : "not_configured",
      sitemap_last_submitted_at: old?.sitemap_last_submitted_at || null,
      inspected_count: 0,
      indexed_count: 0,
      not_indexed_count: 0,
      unindexed_healthy_count: 0,
      technical_indexing_fault_count: 0,
      pending_verification_count: 0,
      manual_request_count: 0,
      manual_request_queue: [],
      inspections: [],
      live_audited_count: 0,
      live_issue_count: 0,
      live_audits: [],
      repair_candidates: [],
      technical_indexing_faults: [],
      google_observations: [],
    };

    const liveBatch = await rotate(env, site, d.discovered_pages, LIVE_PER_RUN, "live-audit-cursor-v3");
    const currentAudits = await mapLimit(liveBatch, auditPage);
    const byUrl = new Map((old?.live_audits || []).map(x => [x.url, x]));
    for (const a of currentAudits) byUrl.set(a.url, a);
    const dayAgo = Date.now() - 86400000;
    entry.live_audits = d.discovered_pages
      .map(u => byUrl.get(u))
      .filter(x => x?.audited_at && Date.parse(x.audited_at) >= dayAgo);
    entry.live_audit_batch_count = currentAudits.length;
    entry.live_audit_known_count = entry.live_audits.length;
    entry.live_audited_count = entry.live_audits.length;
    entry.full_daily_crawl_complete = d.discovered_pages.length > 0 && entry.live_audited_count === d.discovered_pages.length;
    entry.live_issue_count = entry.live_audits.filter(x => !x.passed).length;

    const discoveryCandidates = d.errors.map(x => candidate(
      "sitemap_error",
      site.url,
      `Sitemap ${x.sitemap}: ${x.message}`,
      { sitemap: x.sitemap },
    ));

    if (token && d.sitemap_urls.length) {
      try {
        const sitemapResult = await maybeSubmitSitemap(
          env,
          site,
          d.sitemap_urls[0],
          d.sitemap_fingerprint,
          token,
        );
        entry.sitemap_submitted = sitemapResult.submitted;
        entry.sitemap_submission_status = sitemapResult.status;
        entry.sitemap_submission_reason = sitemapResult.reason;
        entry.sitemap_last_submitted_at = sitemapResult.last_submitted_at;
      } catch (e) {
        entry.google_error = e.message;
        entry.sitemap_submission_status = "error";
      }

      const batch = await batchInspect(env, site, d.discovered_pages, entry.live_audits, old);
      const currentInspections = await Promise.all(batch.map(async u => {
        try { return await inspect(site, u, token); }
        catch (e) { return { url: u, verdict: "ERROR", message: e.message, inspected_at: new Date().toISOString() }; }
      }));
      const inspectionMap = new Map((old?.inspections || []).map(x => [x.url, x]));
      for (const x of currentInspections) inspectionMap.set(x.url, x);
      entry.inspections = d.discovered_pages
        .map(u => inspectionMap.get(u))
        .filter(x => x?.inspected_at && Date.parse(x.inspected_at) >= dayAgo);
      entry.inspection_batch_count = currentInspections.length;
      entry.inspected_count = entry.inspections.length;

      const buckets = classifyInspections(entry.inspections, entry.live_audits);
      entry.indexed_count = buckets.indexed.length;
      entry.not_indexed_count = entry.inspections.filter(x => x.verdict !== "PASS" && x.verdict !== "ERROR").length;
      entry.unindexed_healthy_count = buckets.unindexed_healthy.length;
      entry.technical_indexing_fault_count = buckets.technical_fault.length;
      entry.pending_verification_count = buckets.pending_verification.length;
      entry.manual_request_queue = buckets.manual_request_queue;
      entry.manual_request_count = buckets.manual_request_queue.length;
      entry.indexing_buckets = {
        indexed: buckets.indexed.map(x => x.url),
        unindexed_healthy: buckets.unindexed_healthy.map(x => x.url),
        technical_fault: buckets.technical_fault.map(x => ({ url: x.url, faults: x.faults || [] })),
        pending_verification: buckets.pending_verification.map(x => ({ url: x.url, reason: x.reason })),
      };
      entry.canonical_conflict_count = entry.inspections.filter(canonicalConflict).length;
      entry.technical_indexing_faults = buckets.technical_fault.flatMap(x =>
        (x.faults || []).map(message => `${x.url}: ${message}`),
      );
    }

    entry.google_observations = entry.inspections.map(googleObs).filter(Boolean);
    entry.repair_candidates = dedupe([
      ...discoveryCandidates,
      ...entry.live_audits.flatMap(x => x.repair_candidates || []),
      ...entry.inspections.flatMap(googleRep),
    ]);
    results.push(entry);
  }

  const merged = merge
    ? [...(prev?.sites || []).filter(x => !results.some(r => r.id === x.id)), ...results]
    : results;
  const report = {
    version: 4,
    run_at: new Date().toISOString(),
    google_configured: configured,
    authentication_error: authErr,
    inspection_policy: `Scheduled slices audit ${LIVE_PER_RUN} sitemap URLs and ${INSPECT_PER_RUN} Google URL states per invocation. Unindexed pages are only recommended for manual Request Indexing after a fresh live audit finds no technical blocker.`,
    sitemap_policy: "Submit each site's sitemap at most once per UTC day unless its sitemap content changes, in which case resubmit immediately.",
    manual_request_policy: `Keep a maximum of ${MANUAL_QUEUE_PER_SITE} healthy-but-unindexed URLs per site in the manual Search Console Request Indexing queue.`,
    sites: merged,
  };
  await env.MONITOR_KV?.put("latest-indexing-report-v1", JSON.stringify(report));
  return report;
}

export async function latestIndexing(env) {
  return await env.MONITOR_KV?.get("latest-indexing-report-v1", "json")
    || { status: "no_report", message: "Run /indexing/run first" };
}
