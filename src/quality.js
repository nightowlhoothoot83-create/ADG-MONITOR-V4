const REPORT_KEY = "latest-quality-report-v1";
const MAX_BYTES = 900000;
const PAGE_LIMIT = 45;
const GENERIC_PATTERNS = [
  /MyCalcTools calculators are designed for quick everyday estimates/i,
  /Checking a quick estimate before making a decision/i,
  /Comparing two or more everyday scenarios side by side/i,
  /Enter the values requested in the calculator fields/i,
  /Enter the dates, numbers or options requested/i,
  /when you need a quick answer without creating an account/i,
  /This page is written so the main purpose of the tool/i,
  /household planning, school or work tasks, content planning/i
];

const SHARED_SOURCES = {
  mycalctools: "/script.js",
  mycalendartools: "/components.js"
};

function host(value) {
  return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
}

function norm(value) {
  const u = new URL(value);
  u.hash = "";
  u.hostname = host(value);
  if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/$/, "");
  return u.href;
}

function stripHtml(value) {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(html) {
  return stripHtml(html).split(/\s+/).filter(Boolean).length;
}

function canonical(html, pageUrl) {
  const m = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (!m) return null;
  try { return new URL(m[1], pageUrl).href; } catch { return null; }
}

function hrefs(html) {
  return [...html.matchAll(/\bhref=(["'])([^"']+)\1/gi)].map(m => m[2]);
}

function sameSite(value, site) {
  try { return host(value) === host(site.url); } catch { return false; }
}

function legacyLink(raw, base, site) {
  if (!raw || /^(?:#|mailto:|tel:|javascript:|data:)/i.test(raw)) return null;
  try {
    const u = new URL(raw, base);
    if (!sameSite(u.href, site)) return null;
    const reasons = [];
    if (u.protocol !== "https:") reasons.push("http");
    if (/\/index\.html$/i.test(u.pathname)) reasons.push("index.html");
    else if (/\.html$/i.test(u.pathname)) reasons.push(".html");
    if (u.hostname.toLowerCase().startsWith("www.")) reasons.push("www");
    return reasons.length ? { raw, resolved: u.href, reasons } : null;
  } catch {
    return null;
  }
}

async function readBody(response) {
  const len = Number(response.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error(`Response exceeds ${MAX_BYTES} bytes`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error(`Response exceeds ${MAX_BYTES} bytes`);
  return text;
}

async function tracedFetch(url) {
  const chain = [];
  const seen = new Set();
  let current = url;
  for (let i = 0; i < 6; i++) {
    if (seen.has(current)) throw new Error(`Redirect loop at ${current}`);
    seen.add(current);
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": "ADG-Monitor-v4-Quality/1.0", "Cache-Control": "no-cache" }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { response, finalUrl: current, chain, error: `HTTP ${response.status} without Location` };
      const next = new URL(location, current).href;
      chain.push({ from: current, to: next, status: response.status });
      current = next;
      continue;
    }
    return { response, finalUrl: current, chain, error: null };
  }
  throw new Error(`Too many redirects from ${url}`);
}

async function sitemapPages(site) {
  const sitemap = `${site.url}/sitemap.xml`;
  const response = await fetch(sitemap, {
    headers: { "User-Agent": "ADG-Monitor-v4-Quality/1.0", "Cache-Control": "no-cache" }
  });
  if (!response.ok) throw new Error(`Sitemap HTTP ${response.status}`);
  const xml = await readBody(response);
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
    .map(m => m[1].replace(/&amp;/g, "&").trim())
    .filter(url => {
      try { return new URL(url).protocol === "https:" && sameSite(url, site); } catch { return false; }
    });
}

async function rotate(env, site, pages) {
  if (!pages.length) return [];
  const key = `quality-cursor-v1:${site.id}`;
  const cursor = Number(await env.MONITOR_KV?.get(key) || 0) % pages.length;
  const count = Math.min(PAGE_LIMIT, pages.length);
  const batch = Array.from({ length: count }, (_, i) => pages[(cursor + i) % pages.length]);
  await env.MONITOR_KV?.put(key, String((cursor + count) % pages.length));
  return batch;
}

function toolLike(site, url) {
  if (site.id !== "mycalctools") return false;
  const path = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
  if (!path) return false;
  return !/^(?:about|contact|privacy|terms|cookies|sitemap|converters)$/.test(path);
}

async function auditPage(site, url) {
  try {
    const traced = await tracedFetch(url);
    const ct = traced.response.headers.get("content-type") || "";
    const html = traced.response.ok && ct.includes("text/html") ? await readBody(traced.response) : "";
    const issues = [];
    const advisories = [];

    if (traced.error) issues.push(traced.error);
    if (!traced.response.ok) issues.push(`HTTP ${traced.response.status}`);
    if (norm(url) !== norm(traced.finalUrl)) issues.push(`Sitemap URL redirects to ${traced.finalUrl}`);
    if (html) {
      const can = canonical(html, traced.finalUrl);
      if (!can) issues.push("Missing canonical");
      else if (norm(can) !== norm(traced.finalUrl)) issues.push(`Canonical points to ${can}`);

      const badLinks = hrefs(html).map(raw => legacyLink(raw, traced.finalUrl, site)).filter(Boolean);
      if (badLinks.length) issues.push(`${badLinks.length} legacy/non-canonical internal link(s)`);

      const genericMatches = GENERIC_PATTERNS.filter(pattern => pattern.test(stripHtml(html))).map(pattern => pattern.source);
      if (genericMatches.length) issues.push(`${genericMatches.length} generic/repeated content pattern(s)`);

      const uniqueMarker = /data-adg-unique-info=["']true["']/i.test(html);
      if (toolLike(site, traced.finalUrl) && !uniqueMarker) issues.push("Tool page missing ADG unique-content marker");

      const words = wordCount(html);
      if (toolLike(site, traced.finalUrl) && words < 300) advisories.push(`Thin-content advisory: approximately ${words} visible words`);

      return {
        url,
        final_url: traced.finalUrl,
        http: traced.response.status,
        redirect_chain: traced.chain,
        canonical: can,
        legacy_internal_links: badLinks.slice(0, 20),
        legacy_internal_link_count: badLinks.length,
        generic_pattern_count: genericMatches.length,
        unique_content_marker: uniqueMarker,
        word_count: words,
        issues,
        advisories,
        passed: issues.length === 0,
        audited_at: new Date().toISOString()
      };
    }

    return {
      url,
      final_url: traced.finalUrl,
      http: traced.response.status,
      redirect_chain: traced.chain,
      issues,
      advisories,
      passed: issues.length === 0,
      audited_at: new Date().toISOString()
    };
  } catch (error) {
    return { url, passed: false, issues: [error.message], advisories: [], audited_at: new Date().toISOString() };
  }
}

async function auditSharedSource(site) {
  const path = SHARED_SOURCES[site.id];
  if (!path) return null;
  try {
    const response = await fetch(`${site.url}${path}`, {
      headers: { "User-Agent": "ADG-Monitor-v4-Quality/1.0", "Cache-Control": "no-cache" }
    });
    const text = response.ok ? await readBody(response) : "";
    const htmlRefs = [...text.matchAll(/(?:\/|["'`])[^"'`\s]*\.html(?:[#?"'`]|\b)/gi)].map(m => m[0]).slice(0, 50);
    return {
      path,
      http: response.status,
      legacy_html_reference_count: htmlRefs.length,
      examples: htmlRefs.slice(0, 12),
      passed: response.ok && htmlRefs.length === 0
    };
  } catch (error) {
    return { path, passed: false, error: error.message, legacy_html_reference_count: 0, examples: [] };
  }
}

async function readReport(env) {
  return await env.MONITOR_KV?.get(REPORT_KEY, "json") || { version: 1, sites: [] };
}

async function writeReport(env, report) {
  await env.MONITOR_KV?.put(REPORT_KEY, JSON.stringify(report));
}

export async function auditSiteQuality(env, sites) {
  const previous = await readReport(env);
  const freshAfter = Date.now() - 48 * 60 * 60 * 1000;
  const updates = [];

  for (const site of sites) {
    try {
      const pages = await sitemapPages(site);
      const batch = await rotate(env, site, pages);
      const current = [];
      for (const url of batch) current.push(await auditPage(site, url));

      const old = previous.sites?.find(item => item.id === site.id);
      const map = new Map((old?.pages || []).filter(p => p.audited_at && Date.parse(p.audited_at) >= freshAfter).map(p => [p.url, p]));
      for (const page of current) map.set(page.url, page);
      const known = pages.map(url => map.get(url)).filter(Boolean);
      const shared = await auditSharedSource(site);

      const issuePages = known.filter(page => !page.passed);
      const legacyLinks = known.reduce((n, page) => n + (page.legacy_internal_link_count || 0), 0);
      const genericCount = known.reduce((n, page) => n + (page.generic_pattern_count || 0), 0);
      const missingUnique = known.filter(page => toolLike(site, page.url) && page.unique_content_marker === false).length;
      const thin = known.reduce((n, page) => n + (page.advisories?.filter(x => /Thin-content/i.test(x)).length || 0), 0);
      const sharedLegacy = shared?.legacy_html_reference_count || 0;

      updates.push({
        id: site.id,
        name: site.name,
        url: site.url,
        discovered_count: pages.length,
        checked_this_run: current.length,
        known_recent_count: known.length,
        full_recent_coverage: known.length === pages.length,
        issue_page_count: issuePages.length,
        legacy_internal_link_count: legacyLinks,
        shared_source_legacy_reference_count: sharedLegacy,
        generic_content_pattern_count: genericCount,
        missing_unique_content_count: missingUnique,
        thin_content_advisory_count: thin,
        shared_source: shared,
        pages: known,
        status: issuePages.length || sharedLegacy ? "needs_attention" : "clean",
        run_at: new Date().toISOString()
      });
    } catch (error) {
      updates.push({
        id: site.id,
        name: site.name,
        url: site.url,
        status: "monitor_error",
        error: error.message,
        pages: [],
        run_at: new Date().toISOString()
      });
    }
  }

  const merged = [
    ...(previous.sites || []).filter(old => !updates.some(next => next.id === old.id)),
    ...updates
  ];

  const report = {
    version: 1,
    run_at: new Date().toISOString(),
    policy: "Checks sitemap pages for redirect/canonical hygiene, internal .html links, generic repeated copy, MyCalcTools unique-content markers and thin-content advisories. Shared navigation scripts are scanned separately for legacy .html references.",
    sites: merged
  };
  await writeReport(env, report);
  return report;
}

export async function latestSiteQuality(env) {
  return readReport(env);
}
