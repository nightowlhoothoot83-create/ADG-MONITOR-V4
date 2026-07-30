const BASELINE_KEY = "anti-regression-baseline-v1";
const STATE_KEY = "anti-regression-state-v1";
const REPORT_KEY = "latest-regression-report-v1";
const PUBLISHER_ID = "pub-1904958390525375";

// One canonical request per check keeps the full three-site audit below Worker subrequest limits.
// Redirects are followed, so Cloudflare may resolve clean URLs to folder or .html pages.
const ENDPOINTS = [
  { id: "privacy", path: "/privacy", type: "html" },
  { id: "terms", path: "/terms", type: "html" },
  { id: "about", path: "/about", type: "html" },
  { id: "contact", path: "/contact", type: "html" },
  { id: "cookies", path: "/cookies", type: "html" },
  { id: "ads_txt", path: "/ads.txt", type: "ads" },
  { id: "robots_txt", path: "/robots.txt", type: "robots" },
  { id: "sitemap", path: "/sitemap.xml", type: "sitemap" }
];

async function readJson(env, key, fallback) {
  if (!env.MONITOR_KV) return fallback;
  return await env.MONITOR_KV.get(key, "json") || fallback;
}

async function writeJson(env, key, value) {
  if (env.MONITOR_KV) await env.MONITOR_KV.put(key, JSON.stringify(value));
}

function acceptableContent(type, text) {
  if (type === "ads") return text.includes(PUBLISHER_ID) && /google\.com/i.test(text);
  if (type === "robots") return /user-agent\s*:/i.test(text) && /sitemap\s*:/i.test(text);
  if (type === "sitemap") return /<urlset|<sitemapindex/i.test(text);
  return /<html|<!doctype html/i.test(text) && text.replace(/<[^>]+>/g, " ").trim().length > 80;
}

async function checkEndpoint(site, endpoint) {
  const url = `${site.url}${endpoint.path}`;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "ADG-Monitor-v4-AntiRegression/1.0", "Cache-Control": "no-cache" }
    });
    const text = (await response.text()).slice(0, 250_000);
    const finalHost = new URL(response.url).hostname;
    const expectedHost = new URL(site.url).hostname;
    const passed = response.ok && finalHost === expectedHost && acceptableContent(endpoint.type, text);
    return { passed, requested_path: endpoint.path, http: response.status, final_url: response.url };
  } catch (error) {
    return { passed: false, requested_path: endpoint.path, error: error.message };
  }
}

async function checkHomepage(site) {
  try {
    const response = await fetch(site.url, {
      redirect: "follow",
      headers: { "User-Agent": "ADG-Monitor-v4-AntiRegression/1.0", "Cache-Control": "no-cache" }
    });
    const html = (await response.text()).slice(0, 1_000_000);
    return {
      homepage_http_200: response.ok,
      correct_domain: new URL(response.url).hostname === new URL(site.url).hostname,
      title: /<title>[\s\S]+?<\/title>/i.test(html),
      description: /<meta\b[^>]*name=["']description["']/i.test(html),
      canonical: /<link\b[^>]*rel=["']canonical["']/i.test(html),
      h1: /<h1\b/i.test(html),
      privacy_link: /href=["'][^"']*privacy/i.test(html),
      terms_link: /href=["'][^"']*terms/i.test(html),
      about_link: /href=["'][^"']*about/i.test(html),
      contact_link: /href=["'][^"']*contact/i.test(html),
      cookie_policy_link: /href=["'][^"']*(cookies|cookie-policy)/i.test(html),
      consent_ui: /(cookie-consent|cookie banner|googlefc|privacy-messaging|consent)/i.test(html),
      adsense_identity: html.includes("ca-pub-1904958390525375")
    };
  } catch (error) {
    return { homepage_http_200: false, error: error.message };
  }
}

async function snapshotSite(site) {
  const homepage = await checkHomepage(site);
  const endpoints = {};
  for (const endpoint of ENDPOINTS) endpoints[endpoint.id] = await checkEndpoint(site, endpoint);
  return { id: site.id, name: site.name, url: site.url, homepage, endpoints };
}

function flattenPasses(snapshot) {
  const result = {};
  for (const [name, value] of Object.entries(snapshot.homepage || {})) {
    if (typeof value === "boolean") result[`homepage.${name}`] = value;
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
    "homepage.canonical", "homepage.h1", "homepage.privacy_link", "homepage.terms_link",
    "homepage.about_link", "homepage.contact_link", "homepage.cookie_policy_link",
    "endpoint.privacy", "endpoint.terms", "endpoint.about", "endpoint.contact",
    "endpoint.cookies", "endpoint.ads_txt", "endpoint.robots_txt", "endpoint.sitemap"
  ];
  return critical.every(key => checks[key] === true);
}

export async function auditRegressions(env, sites) {
  const now = new Date().toISOString();
  const baseline = await readJson(env, BASELINE_KEY, { version: 1, sites: {} });
  const previousState = await readJson(env, STATE_KEY, { version: 1, sites: {} });
  const snapshots = [];
  const nextState = { version: 1, updated_at: now, sites: {} };

  for (const site of sites) {
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
    if (healthyNow && !regressedChecks.length) baseline.sites[site.id] = current;

    const status = confirmed
      ? "regression_confirmed"
      : regressedChecks.length
        ? "recheck_required"
        : baselineAvailable || healthyNow
          ? "clean"
          : "baseline_pending";
    snapshots.push({ ...current, regression: state, status });
  }

  baseline.version = 1;
  baseline.updated_at = now;
  const report = {
    version: 1,
    run_at: now,
    request_budget: "27 live requests for three sites",
    policy: "Known-good baseline; regressions require two consecutive failures before confirmation",
    sites: snapshots,
    confirmed_count: snapshots.filter(site => site.regression.confirmed).length,
    recheck_count: snapshots.filter(site => site.status === "recheck_required").length,
    baseline_pending_count: snapshots.filter(site => site.status === "baseline_pending").length
  };

  await Promise.all([
    writeJson(env, BASELINE_KEY, baseline),
    writeJson(env, STATE_KEY, nextState),
    writeJson(env, REPORT_KEY, report)
  ]);
  return report;
}

export async function latestRegressionReport(env) {
  return readJson(env, REPORT_KEY, { status: "no_report", message: "No anti-regression check has run yet", sites: [] });
}

export async function resetRegressionBaseline(env, sites) {
  const snapshots = [];
  for (const site of sites) snapshots.push(await snapshotSite(site));
  const unhealthy = snapshots.filter(site => !allCriticalPassed(site));
  if (unhealthy.length) {
    return {
      status: "refused",
      message: "Baseline was not changed because one or more sites failed critical checks",
      unhealthy_sites: unhealthy.map(site => site.id)
    };
  }
  const baseline = { version: 1, updated_at: new Date().toISOString(), sites: Object.fromEntries(snapshots.map(site => [site.id, site])) };
  await writeJson(env, BASELINE_KEY, baseline);
  await writeJson(env, STATE_KEY, { version: 1, updated_at: baseline.updated_at, sites: {} });
  return { status: "baseline_saved", sites: snapshots.map(site => site.id), saved_at: baseline.updated_at };
}
