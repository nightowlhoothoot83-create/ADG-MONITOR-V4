const REPORT_KEY = "site-guardian-report-v1";
const MAX_BYTES = 700000;
const MAX_LINK_CHECKS = 16;

const VISUAL_RULES = {
  mycalctools: [
    { id: "category-colours", label: "Category colour tokens", test: text => /--finance:\s*#60A5FA/i.test(text) && /--business:\s*#FBBF24/i.test(text) },
    { id: "button-glow", label: "Calculator button glow", test: text => /\.btn-calc\s*\{[\s\S]{0,800}box-shadow\s*:/i.test(text) },
    { id: "focus-highlight", label: "Input focus highlight", test: text => /input:focus[\s\S]{0,600}box-shadow\s*:/i.test(text) }
  ],
  mycalendartools: [
    { id: "card-surface", label: "Card surface/highlight", test: text => /\.card\s*\{[\s\S]{0,700}linear-gradient/i.test(text) },
    { id: "button-glow", label: "Primary button glow", test: text => /\.btn-primary\s*\{[\s\S]{0,800}box-shadow\s*:/i.test(text) },
    { id: "focus-highlight", label: "Input focus highlight", test: text => /input:focus[\s\S]{0,600}box-shadow\s*:/i.test(text) }
  ],
  wheel: [
    { id: "affiliate-panel-style", label: "Affiliate panel styling", test: text => /\.affiliate-panel\s*\{[\s\S]{0,900}(?:background|border|display|grid|flex)/i.test(text) },
    { id: "shortcut-highlight", label: "Tool shortcut card highlight", test: text => /\.tool-shortcut-card\s*\{[\s\S]{0,900}box-shadow\s*:/i.test(text) },
    { id: "affiliate-responsive", label: "Affiliate panel responsive rule", test: text => /@media[\s\S]{0,4000}affiliate-panel/i.test(text) }
  ]
};

const FRESHNESS_RULES = [
  { id: "currency", path: /currency|exchange|money-convert/i, kind: "exchange-rate" },
  { id: "interest", path: /interest|mortgage|loan|finance/i, kind: "interest-rate" },
  { id: "insurance", path: /insurance/i, kind: "insurance-rate" },
  { id: "tax", path: /tax|stamp-duty|superannuation/i, kind: "government-rate" },
  { id: "date-time", path: /age|date|time|countdown|days-until|calendar/i, kind: "clock/date" }
];

async function readLimited(response) {
  const len = Number(response.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error(`Response exceeds ${MAX_BYTES} bytes`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error(`Response exceeds ${MAX_BYTES} bytes`);
  return text;
}

async function fetchText(url) {
  try {
    const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "ADG-Site-Guardian/1.0", "Cache-Control": "no-cache" } });
    const type = response.headers.get("content-type") || "";
    const text = response.ok && /text|html|css|javascript|xml/i.test(type) ? await readLimited(response) : "";
    return { ok: response.ok, status: response.status, type, final_url: response.url, text };
  } catch (error) {
    return { ok: false, status: 0, type: "", final_url: url, text: "", error: error.message };
  }
}

function hrefs(html, base) {
  const out = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const raw = match[1];
    if (!raw || /^(?:#|javascript:|mailto:|tel:|data:)/i.test(raw)) continue;
    try {
      const url = new URL(raw, base).href;
      if (!out.includes(url)) out.push(url);
    } catch {}
  }
  return out;
}

function imageSources(html, base) {
  const out = [];
  for (const match of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    try { out.push(new URL(match[1], base).href); } catch {}
  }
  return out;
}

async function headLike(url, { allowGetFallback = true } = {}) {
  try {
    let response = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "User-Agent": "ADG-Site-Guardian/1.0" } });
    if ((response.status === 405 || response.status === 403) && !allowGetFallback) {
      return { url, passed: false, inconclusive: true, method: "HEAD", http: response.status, final_url: response.url, content_type: response.headers.get("content-type") || "", note: "HEAD is unsupported or forbidden; GET was intentionally not sent because this may be a tracked affiliate/partner link." };
    }
    if (response.status === 405 || response.status === 403) response = await fetch(url, { method: "GET", redirect: "follow", headers: { "User-Agent": "ADG-Site-Guardian/1.0", Range: "bytes=0-2048" } });
    return { url, passed: response.ok, inconclusive: false, method: response.status === 405 || response.status === 403 ? "HEAD" : "HEAD/GET-safe", http: response.status, final_url: response.url, content_type: response.headers.get("content-type") || "" };
  } catch (error) {
    return { url, passed: false, inconclusive: false, http: 0, error: error.message };
  }
}

function currentYearRisks(text, currentYear) {
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map(m => Number(m[1]));
  const stale = [...new Set(years.filter(y => y <= currentYear - 2))].sort();
  return stale.slice(0, 8);
}

function freshnessKind(url) {
  const path = new URL(url).pathname;
  return FRESHNESS_RULES.find(rule => rule.path.test(path)) || null;
}

async function sitemapPages(site) {
  const sitemap = await fetchText(`${site.url}/sitemap.xml`);
  if (!sitemap.ok) return [];
  return [...sitemap.text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, "&").trim()).filter(Boolean);
}

async function checkVisual(site, homepage) {
  const cssUrl = site.id === "wheel" ? null : `${site.url}/style.css`;
  const source = cssUrl ? await fetchText(cssUrl) : { ok: true, text: homepage.text };
  const rules = VISUAL_RULES[site.id] || [];
  return {
    source: cssUrl || `${site.url}/ (inline CSS)`,
    source_ok: source.ok,
    checks: rules.map(rule => ({ id: rule.id, label: rule.label, passed: source.ok && rule.test(source.text) }))
  };
}

async function checkAscensionLogo(site, homepage) {
  const ascension = imageSources(homepage.text, site.url).find(url => /ascension/i.test(url));
  if (!ascension) return { passed: false, issue: "No Ascension logo/image reference found" };
  const result = await headLike(ascension);
  return { ...result, passed: result.passed && /^image\//i.test(result.content_type || "") };
}

async function checkLinks(site, homepage) {
  const all = hrefs(homepage.text, site.url);
  const priority = all.filter(url => /ventra|affiliate|partner|ascension|raven|mycalc|mycalendar/i.test(url));
  const selected = [...priority, ...all.filter(url => !priority.includes(url))].slice(0, MAX_LINK_CHECKS);
  const results = [];
  for (const url of selected) {
    const tracked = /ventra|affiliate|partner/i.test(url);
    results.push({ ...(await headLike(url, { allowGetFallback: !tracked })), tracked_link_guard: tracked });
  }
  return {
    discovered: all.length,
    checked: results.length,
    broken: results.filter(x => !x.passed && !x.inconclusive),
    inconclusive: results.filter(x => x.inconclusive),
    results
  };
}

function wheelAffiliateLayout(homepage) {
  if (!homepage.text) return null;
  const ventraLinks = [...homepage.text.matchAll(/<a\b[^>]*href=["']([^"']*ventra[^"']*)["'][^>]*>/gi)].map(m => m[1]);
  const hasPanel = /class=["'][^"']*affiliate-panel/i.test(homepage.text);
  const styledPanel = /\.affiliate-panel\s*\{[\s\S]{0,900}(?:display|grid|flex|background|border)/i.test(homepage.text);
  const responsive = /@media[\s\S]{0,5000}affiliate-panel/i.test(homepage.text);
  return {
    ventra_links_found: ventraLinks.length,
    has_affiliate_panel: hasPanel,
    affiliate_panel_styled: styledPanel,
    responsive_rule_found: responsive,
    passed: ventraLinks.length > 0 && hasPanel && styledPanel && responsive
  };
}

async function checkFreshness(site, homepage) {
  const pages = await sitemapPages(site);
  const candidates = pages.map(url => ({ url, rule: freshnessKind(url) })).filter(x => x.rule).slice(0, 12);
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const findings = [];
  for (const item of candidates) {
    const page = item.url === site.url || item.url === `${site.url}/` ? homepage : await fetchText(item.url);
    if (!page.ok) { findings.push({ url: item.url, kind: item.rule.kind, status: "unreachable" }); continue; }
    const stale_years = currentYearRisks(page.text, currentYear);
    const hasTimestamp = /(?:last updated|updated|rates? as of|effective)\s*[:\-]?\s*[^<\n]{0,80}/i.test(page.text);
    findings.push({ url: item.url, kind: item.rule.kind, stale_years, has_update_marker: hasTimestamp, status: stale_years.length || !hasTimestamp ? "verify" : "ok" });
  }
  return {
    checked_at: now.toISOString(),
    current_year: currentYear,
    policy: "Time-sensitive money/date content is verify-first. Guardian flags it for source verification instead of editing values automatically.",
    findings
  };
}

export async function runSiteGuardian(env, sites) {
  const results = [];
  for (const site of sites) {
    const homepage = await fetchText(site.url);
    if (!homepage.ok) {
      results.push({ id: site.id, name: site.name, url: site.url, status: "unreachable", homepage_http: homepage.status, error: homepage.error || null });
      continue;
    }
    const [visual, ascension_logo, links, freshness] = await Promise.all([
      checkVisual(site, homepage),
      checkAscensionLogo(site, homepage),
      checkLinks(site, homepage),
      checkFreshness(site, homepage)
    ]);
    const affiliate_layout = site.id === "wheel" ? wheelAffiliateLayout(homepage) : null;
    const visualFailures = visual.checks.filter(x => !x.passed);
    const status = visualFailures.length || !ascension_logo.passed || links.broken.length || (affiliate_layout && !affiliate_layout.passed) ? "needs_attention" : "clean";
    results.push({ id: site.id, name: site.name, url: site.url, status, homepage_http: homepage.status, visual, ascension_logo, links, affiliate_layout, freshness, checked_at: new Date().toISOString() });
  }
  const report = { version: 1, run_at: new Date().toISOString(), mode: "manual_on_demand", max_link_checks_per_site: MAX_LINK_CHECKS, sites: results };
  await env.MONITOR_KV?.put(REPORT_KEY, JSON.stringify(report));
  return report;
}

export async function latestSiteGuardian(env) {
  return await env.MONITOR_KV?.get(REPORT_KEY, "json") || { status: "no_report", message: "Run /guardian/run first", sites: [] };
}
