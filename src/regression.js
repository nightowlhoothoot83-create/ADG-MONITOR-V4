const BASELINE_KEY = "anti-regression-baseline-v1";
const STATE_KEY = "anti-regression-state-v1";
const REPORT_KEY = "latest-regression-report-v1";
const AUDIT_CURSOR_KEY = "anti-regression-audit-cursor-v2";
const BASELINE_CURSOR_KEY = "anti-regression-baseline-cursor-v2";
const PUBLISHER_ID = "pub-1904958390525375";

// A complete site snapshot is intentionally kept together, but only one site is
// checked per Worker invocation. This avoids Cloudflare subrequest exhaustion
// when redirect-following adds extra network hops. Results are merged so the
// dashboard continues to show the latest known state for all three sites.
const ENDPOINTS = [
  { id: "privacy", path: "/privacy", type: "html" },
  { id: "terms", path: "/terms", type: "html" },
  { id: "about", path: "/about", type: "html" },
  { id: "contact", path: "/contact", type: "html" },
  { id: "cookies", path: "/cookies", type: "cookie" },
  { id: "ads_txt", path: "/ads.txt", type: "ads" },
  { id: "robots_txt", path: "/robots.txt", type: "robots" },
  { id: "sitemap", path: "/sitemap.xml", type: "sitemap" },
  { id: "consent_script", path: "/cookie-consent.js", type: "consent" }
];

async function readJson(env, key, fallback) {
  if (!env.MONITOR_KV) return fallback;
  return await env.MONITOR_KV.get(key, "json") || fallback;
}

async function writeJson(env, key, value) {
  if (env.MONITOR_KV) await env.MONITOR_KV.put(key, JSON.stringify(value));
}

async function rotateOne(env, sites, key) {
  if (sites.length <= 1) return sites;
  const current = Number(await env.MONITOR_KV?.get(key) || 0) % sites.length;
  await env.MONITOR_KV?.put(key, String((current + 1) % sites.length));
  return [sites[current]];
}

function acceptableContent(type, text) {
  if (type === "ads") return text.includes(PUBLISHER_ID) && /google\.com/i.test(text);
  if (type === "robots") return /user-agent\s*:/i.test(text) && /sitemap\s*:/i.test(text);
  if (type === "sitemap") return /<urlset|<sitemapindex/i.test(text);
  if (type === "consent") return /cookieConsent/i.test(text) && /(accept|granted)/i.test(text) && /(decline|denied)/i.test(text) && /(settings|preferences|reopen)/i.test(text);
  if (type === "cookie") {
    const hasCookieIdentity = /<title>[^<]*(cookie policy|cookies)[^<]*<\/title>/i.test(text)
      || /<h1\b[^>]*>[^<]*(cookie policy|cookies)[^<]*<\/h1>/i.test(text);
    const explainsConsent = /(cookie consent|cookie preferences|local storage)/i.test(text)
      && /(accept|decline|change your choice|cookie settings)/i.test(text);
    return hasCookieIdentity && explainsConsent;
  }
  return /<html|<!doctype html/i.test(text) && text.replace(/<[^>]+>/g, " ").trim().length > 80;
}

async function checkEndpoint(site, endpoint) {
  const requestedPath = endpoint.id === "cookies"
    ? site.policyStyle === "html" ? "/cookies.html" : "/cookies/"
    : endpoint.path;
  const url = `${site.url}${requestedPath}`;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "ADG-Monitor-v4-AntiRegression/1.1", "Cache-Control": "no-cache" }
    });
    const text = (await response.text()).slice(0, 250_000);
    const finalHost = new URL(response.url).hostname;
    const expectedHost = new URL(site.url).hostname;
    const passed = response.ok && finalHost === expectedHost && acceptableContent(endpoint.type, text);
    return { passed, requested_path: requestedPath, http: response.status, final_url: response.url };
  } catch (error) {
    return { passed: false, requested_path: requestedPath, error: error.message };
  }
}

async function checkHomepage(site) {
  try {
    const response = await fetch(site.url, {
      redirect: "follow",
      headers: { "User-Agent": "ADG-Monitor-v4-AntiRegression/1.1", "Cache-Control": "no-cache" }
    });
    const html = (await response.text()).slice(0, 1_000_000);
    return {
      homepage_http_200: response.ok,
      correct_domain: new URL(response.url).hostname === new URL(site.url).hostname,
      title: /<title>[\s\S]+?<\/title>/i.test(html),
      description: /<meta\b[^>]*name=["']description["']/i.test(html),
      canonical: /<link\b[^>]*rel=["']canonical["']/i.test(html),
      canonical_target: canonicalMatches(html, response.url),
      indexable: !/<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html),
      h1: /<h1\b/i.test(html),
      privacy_link: /href=["'][^"']*privacy/i.test(html),
      terms_link: /href=["'][^"']*terms/i.test(html),
      about_link: /href=["'][^"']*about/i.test(html),
      contact_link: /href=["'][^"']*contact/i.test(html),
      cookie_policy_link: /href=["'][^"']*(cookies|cookie-policy)/i.test(html),
      consent_ui: /<script\b[^>]*src=["'][^"']*cookie-consent\.js/i.test(html),
      adsense_identity: html.includes("ca-pub-1904958390525375")
    };
  } catch (error) {
    return { homepage_http_200: false, error: error.message };
  }
}

function normalizedUrl(value) {
  const url = new URL(value);
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.href;
}

function canonicalMatches(html, pageUrl) {
  const match = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (!match) return false;
  try { return normalizedUrl(new URL(match[1], pageUrl)) === normalizedUrl(pageUrl); }
  catch { return false; }
}

async function snapshotSite(site) {
  const homepage = await checkHomepage(site);
  const redirects = await checkRedirectPolicy(site);
  const endpoints = {};
  for (const endpoint of ENDPOINTS) endpoints[endpoint.id] = await checkEndpoint(site, endpoint);
  return { id: site.id, name: site.name, url: site.url, homepage, redirects, endpoints, checked_at: new Date().toISOString() };
}

async function checkRedirectPolicy(site) {
  const expected = new URL(site.url);
  const candidates = [`http://${expected.hostname}/`, `https://www.${expected.hostname.replace(/^www\./, "")}/`];
  const results = await Promise.all(candidates.map(async requested => {
    try {
      const response = await fetch(requested, { redirect: "follow", headers: { "User-Agent": "ADG-Monitor-v4-Redirects/1.1", "Cache-Control": "no-cache" } });
      const final = new URL(response.url);
      return { requested, final_url: response.url, passed: response.ok && final.protocol === "https:" && final.hostname === expected.hostname && final.pathname === "/" };
    } catch (error) { return { requested, passed: false, error: error.message }; }
  }));
  return { http_to_https: results[0].passed, www_to_non_www: results[1].passed, details: results };
}

function flattenPasses(snapshot) {
  const result = {};
  for (const [name, value] of Object.entries(snapshot.homepage || {})) {
    if (typeof value === "boolean") result[`homepage.${name}`] = value;
  }
  for (const [name, value] of Object.entries(snapshot.redirects || {})) {
    if (typeof value === "boolean") result[`redirect.${name}`] = value;
  }
  for (const [name, value] of Object.entries(snapshot.endpoints || {})) result[`endpoint.${name}`] = Boolean(value?.passed);
  return result;
}

function compareKnownGood(baselineSite, currentSite) {
  if (!baselineSite) return [];
  const baseline = flattenPasses(baselineSite);
  const current = flattenPasses(currentSite);
  return Object.entries(baseline)
    .filter(([, passed]) => passed)
    .filter(([key]) => current[key] === false)
    .map(([key]) => key);
}

function allCriticalPassed(site) {
  const checks = flattenPasses(site);
  const critical = [
    "homepage.homepage_http_200", "homepage.correct_domain", "homepage.title", "homepage.description",
    "homepage.canonical", "homepage.canonical_target", "homepage.indexable", "homepage.h1", "homepage.privacy_link", "homepage.terms_link",
    "homepage.about_link", "homepage.contact_link", "homepage.cookie_policy_link", "homepage.consent_ui",
    "redirect.http_to_https", "redirect.www_to_non_www",
    "endpoint.privacy", "endpoint.terms", "endpoint.about", "endpoint.contact",
    "endpoint.cookies", "endpoint.ads_txt", "endpoint.robots_txt", "endpoint.sitemap", "endpoint.consent_script"
  ];
  return critical.every(key => checks[key] === true);
}

function mergeSnapshots(previousSites, refreshedSites, preferredOrder) {
  const map = new Map((previousSites || []).map(site => [site.id, site]));
  for (const site of refreshedSites) map.set(site.id, site);
  const ordered = preferredOrder.map(site => map.get(site.id)).filter(Boolean);
  for (const site of map.values()) if (!ordered.some(item => item.id === site.id)) ordered.push(site);
  return ordered;
}

export async function auditRegressions(env, sites) {
  const now = new Date().toISOString();
  const targets = await rotateOne(env, sites, AUDIT_CURSOR_KEY);
  const baseline = await readJson(env, BASELINE_KEY, { version: 1, sites: {} });
  const previousState = await readJson(env, STATE_KEY, { version: 1, sites: {} });
  const previousReport = await readJson(env, REPORT_KEY, { version: 1, sites: [] });
  const refreshed = [];
  const nextState = { version: 1, updated_at: now, sites: { ...(previousState.sites || {}) } };

  for (const site of targets) {
    const current = await snapshotSite(site);
    const baselineSite = baseline.sites?.[site.id];
    const baselineAvailable = Boolean(baselineSite);
    const regressedChecks = compareKnownGood(baselineSite, current);
    const previous = previousState.sites?.[site.id] || {};
    const consecutiveFailures = regressedChecks.length ? (previous.consecutive_failures || 0) + 1 : 0;
    const confirmed = regressedChecks.length > 0 && consecutiveFailures >= 2;

    const state = {
      baseline_available: baselineAvailable,
      consecutive_failures: consecutiveFailures,
      first_failed_at: regressedChecks.length ? previous.first_failed_at || now : null,
      last_failed_at: regressedChecks.length ? now : null,
      regressed_checks: regressedChecks,
      confirmed
    };
    nextState.sites[site.id] = state;

    const healthyNow = allCriticalPassed(current);

    const status = confirmed
      ? "regression_confirmed"
      : regressedChecks.length
        ? "recheck_required"
        : baselineAvailable
          ? "clean"
          : "baseline_pending";
    refreshed.push({ ...current, regression: state, status });
  }

  const mergedSites = mergeSnapshots(previousReport.sites, refreshed, sites);
  const report = {
    version: 2,
    run_at: now,
    checked_sites: targets.map(site => site.id),
    request_budget: "One complete site snapshot per Worker invocation; three-site report is merged across rotations",
    policy: "User-approved known-good baseline only; healthy scans never replace it automatically; regressions require two consecutive failures for confirmation",
    sites: mergedSites,
    confirmed_count: mergedSites.filter(site => site.regression?.confirmed).length,
    recheck_count: mergedSites.filter(site => site.status === "recheck_required").length,
    baseline_pending_count: mergedSites.filter(site => site.status === "baseline_pending").length
  };

  await Promise.all([
    writeJson(env, STATE_KEY, nextState),
    writeJson(env, REPORT_KEY, report)
  ]);
  return report;
}

export async function latestRegressionReport(env) {
  return readJson(env, REPORT_KEY, { status: "no_report", message: "No anti-regression check has run yet", sites: [] });
}

export async function resetRegressionBaseline(env, sites) {
  const targets = await rotateOne(env, sites, BASELINE_CURSOR_KEY);
  const site = targets[0];
  if (!site) return { status: "refused", message: "No site was supplied for baseline reset" };

  const snapshot = await snapshotSite(site);
  if (!allCriticalPassed(snapshot)) {
    return {
      status: "refused",
      message: "Baseline was not changed because the checked site failed one or more critical checks",
      unhealthy_sites: [site.id]
    };
  }

  const savedAt = new Date().toISOString();
  const baseline = await readJson(env, BASELINE_KEY, { version: 1, sites: {} });
  baseline.version = 1;
  baseline.updated_at = savedAt;
  baseline.sites = { ...(baseline.sites || {}), [site.id]: snapshot };

  const state = await readJson(env, STATE_KEY, { version: 1, sites: {} });
  state.version = 1;
  state.updated_at = savedAt;
  state.sites = { ...(state.sites || {}) };
  delete state.sites[site.id];

  await Promise.all([
    writeJson(env, BASELINE_KEY, baseline),
    writeJson(env, STATE_KEY, state)
  ]);

  return {
    status: "baseline_saved",
    site: site.id,
    saved_at: savedAt,
    note: sites.length > 1 ? "Baseline reset is rotated one site per approved call to stay within the Worker request budget." : undefined
  };
}
