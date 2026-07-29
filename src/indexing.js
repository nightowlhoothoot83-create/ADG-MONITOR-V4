const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const INSPECTION_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const WEBMASTERS_API = "https://www.googleapis.com/webmasters/v3";
const MAX_SITEMAPS_PER_SITE = 5;
const MAX_PAGES_PER_SITE = 100;
const INSPECTIONS_PER_SITE_PER_RUN = 10;
const MAX_TEXT_BYTES = 1_000_000;

const encoder = new TextEncoder();

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJson(value) {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

function pemToBytes(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function googleAccessToken(rawCredentials) {
  const credentials = JSON.parse(rawCredentials);
  if (!credentials.client_email || !credentials.private_key) throw new Error("GSC service account JSON is missing client_email or private_key");
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid: credentials.private_key_id });
  const claims = encodeJson({ iss: credentials.client_email, scope: "https://www.googleapis.com/auth/webmasters", aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 });
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToBytes(credentials.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`Google authentication failed (${response.status}): ${body.error_description || body.error || "unknown error"}`);
  return body.access_token;
}

async function boundedText(response) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_TEXT_BYTES) throw new Error(`Response exceeds ${MAX_TEXT_BYTES} bytes`);
  const text = await response.text();
  if (encoder.encode(text).byteLength > MAX_TEXT_BYTES) throw new Error(`Response exceeds ${MAX_TEXT_BYTES} bytes`);
  return text;
}

function xmlLocations(xml) {
  return [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)].map(match => match[1].replace(/&amp;/g, "&").trim()).filter(Boolean);
}

function sameSiteUrl(candidate, siteUrl) {
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname === new URL(siteUrl).hostname;
  } catch {
    return false;
  }
}

async function sitemapUrls(site) {
  const candidates = new Set([`${site.url}/sitemap.xml`]);
  try {
    const robotsResponse = await fetch(`${site.url}/robots.txt`, { headers: { "User-Agent": "ADG-Monitor-v4/1.1" } });
    if (robotsResponse.ok) {
      const robots = await boundedText(robotsResponse);
      for (const match of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) candidates.add(match[1]);
    }
  } catch {}
  return [...candidates].slice(0, MAX_SITEMAPS_PER_SITE);
}

async function discoverPages(site) {
  const queue = await sitemapUrls(site);
  const visitedSitemaps = new Set();
  const pages = new Set();
  const errors = [];
  while (queue.length && visitedSitemaps.size < MAX_SITEMAPS_PER_SITE && pages.size < MAX_PAGES_PER_SITE) {
    const sitemapUrl = queue.shift();
    if (visitedSitemaps.has(sitemapUrl)) continue;
    visitedSitemaps.add(sitemapUrl);
    try {
      const response = await fetch(sitemapUrl, { headers: { "User-Agent": "ADG-Monitor-v4/1.1" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xml = await boundedText(response);
      const locations = xmlLocations(xml);
      if (/<sitemapindex\b/i.test(xml)) {
        for (const location of locations) {
          if (queue.length + visitedSitemaps.size >= MAX_SITEMAPS_PER_SITE) break;
          queue.push(location);
        }
      } else {
        for (const location of locations) {
          if (pages.size >= MAX_PAGES_PER_SITE) break;
          if (sameSiteUrl(location, site.url)) pages.add(new URL(location).href);
        }
      }
    } catch (error) {
      errors.push({ sitemap: sitemapUrl, message: error.message });
    }
  }
  return { sitemap_urls: [...visitedSitemaps], discovered_pages: [...pages], errors };
}

function searchConsoleProperty(site) {
  return site.searchConsoleProperty || `sc-domain:${new URL(site.url).hostname}`;
}

async function submitSitemap(site, sitemapUrl, accessToken) {
  const endpoint = `${WEBMASTERS_API}/sites/${encodeURIComponent(searchConsoleProperty(site))}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
  const response = await fetch(endpoint, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Sitemap submission failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return true;
}

async function inspectUrl(site, pageUrl, accessToken) {
  const response = await fetch(INSPECTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl: searchConsoleProperty(site), languageCode: "en-AU" })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`URL Inspection failed (${response.status}): ${body.error?.message || "unknown error"}`);
  const result = body.inspectionResult?.indexStatusResult || {};
  return {
    url: pageUrl,
    verdict: result.verdict || "VERDICT_UNSPECIFIED",
    coverage_state: result.coverageState || "Unknown",
    indexing_state: result.indexingState || "Unknown",
    robots_txt_state: result.robotsTxtState || "Unknown",
    page_fetch_state: result.pageFetchState || "Unknown",
    google_canonical: result.googleCanonical || null,
    user_canonical: result.userCanonical || null,
    last_crawl_time: result.lastCrawlTime || null
  };
}

async function nextInspectionBatch(env, site, pages) {
  if (!pages.length) return [];
  const key = `indexing-cursor-v1:${site.id}`;
  const prior = Number(await env.MONITOR_KV?.get(key) || 0);
  const start = prior % pages.length;
  const count = Math.min(INSPECTIONS_PER_SITE_PER_RUN, pages.length);
  const batch = Array.from({ length: count }, (_, offset) => pages[(start + offset) % pages.length]);
  await env.MONITOR_KV?.put(key, String((start + count) % pages.length));
  return batch;
}

export async function auditIndexing(env, sites) {
  const credentialsConfigured = Boolean(env.GSC_SERVICE_ACCOUNT_JSON);
  let accessToken = null;
  let authenticationError = null;
  if (credentialsConfigured) {
    try { accessToken = await googleAccessToken(env.GSC_SERVICE_ACCOUNT_JSON); }
    catch (error) { authenticationError = error.message; }
  }
  const results = [];
  for (const site of sites) {
    const discovery = await discoverPages(site);
    const entry = {
      id: site.id, name: site.name, url: site.url,
      search_console_property: searchConsoleProperty(site),
      sitemap_urls: discovery.sitemap_urls,
      discovered_count: discovery.discovered_pages.length,
      discovered_pages: discovery.discovered_pages,
      discovery_errors: discovery.errors,
      google_configured: credentialsConfigured,
      sitemap_submitted: false,
      inspected_count: 0, indexed_count: 0, not_indexed_count: 0, inspections: []
    };
    if (accessToken && discovery.sitemap_urls.length) {
      try { entry.sitemap_submitted = await submitSitemap(site, discovery.sitemap_urls[0], accessToken); }
      catch (error) { entry.google_error = error.message; }
      const batch = await nextInspectionBatch(env, site, discovery.discovered_pages);
      for (const pageUrl of batch) {
        try { entry.inspections.push(await inspectUrl(site, pageUrl, accessToken)); }
        catch (error) { entry.inspections.push({ url: pageUrl, verdict: "ERROR", message: error.message }); }
      }
      entry.inspected_count = entry.inspections.length;
      entry.indexed_count = entry.inspections.filter(item => item.verdict === "PASS").length;
      entry.not_indexed_count = entry.inspections.filter(item => item.verdict !== "PASS" && item.verdict !== "ERROR").length;
    }
    results.push(entry);
  }
  const report = {
    version: 1,
    run_at: new Date().toISOString(),
    google_configured: credentialsConfigured,
    authentication_error: authenticationError,
    inspection_policy: `${INSPECTIONS_PER_SITE_PER_RUN} rotating URLs per site per indexing run`,
    sites: results
  };
  await env.MONITOR_KV?.put("latest-indexing-report-v1", JSON.stringify(report));
  return report;
}

export async function latestIndexing(env) {
  return await env.MONITOR_KV?.get("latest-indexing-report-v1", "json") || { status: "no_report", message: "Run /indexing/run first" };
}
