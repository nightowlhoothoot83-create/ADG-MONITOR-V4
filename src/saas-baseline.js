export const RAVEN_SHELL_VERSION = "raven-sharp-canonical-shell-2026-08-11";

export const RAVEN_SHELL_BASELINE = {
  visual_system: {
    background: "near-black #080810 / #05050d family",
    accent_family: ["purple #7c5cbf", "violet #a78bfa", "blue #38bdf8", "gold #ffc857"],
    body_font: "Outfit",
    display_font: "Cabinet Grotesk",
    utility_font: "DM Mono"
  },
  header: [
    "Raven Sharp logo/mark",
    "RAVEN SHARP wordmark",
    "product name directly under or beside the wordmark",
    "clear product entry CTA such as Sign In, Get Started, Open, Try or Start"
  ],
  hero: [
    "centred Raven artwork with glow",
    "product-specific eyebrow/badge",
    "one product-specific H1",
    "purple/blue/gold gradient emphasis",
    "plain-language product explanation",
    "clear primary CTA"
  ],
  product_content: [
    "What it does / capabilities information",
    "multiple product-specific feature cards or sections",
    "realistic product/workspace preview or showcase",
    "useful output/workflow explanation",
    "public pricing or plan information where commercial"
  ],
  ecosystem_footer: [
    "Ascension Digital Group logo",
    "Elevating Your Digital Future tagline",
    "Raven Sharp hub link",
    "cross-links across the six Raven Sharp SaaS products",
    "ADG sister-brand navigation",
    "privacy, terms and cookie links"
  ]
};

export const SAAS_APPS = [
  {
    id: "pod",
    name: "Raven Sharp POD Automation",
    productLabel: "POD Automation",
    url: "https://pod.raven-sharp.com",
    workspacePaths: ["/login", "/register", "/dashboard", "/pipeline"],
    previewAssets: ["/product-preview.png", "/product-preview.svg"],
    protectedPaths: ["/dashboard", "/pipeline"]
  },
  {
    id: "image-optimiser",
    name: "Raven Sharp Image Optimiser & Upscaler",
    productLabel: "Image Optimiser",
    url: "https://opt.raven-sharp.com",
    workspacePaths: ["/optimiser", "/login", "/register", "/history"],
    previewAssets: ["/product-preview.png", "/product-preview.svg"],
    protectedPaths: ["/history"]
  },
  {
    id: "smart-cleaner",
    name: "Raven Sharp Smart Cleaner",
    productLabel: "Smart Cleaner",
    url: "https://cleaner.raven-sharp.com",
    workspacePaths: ["/app.html", "/app.html#login", "/app.html#register"],
    previewAssets: ["/product-preview.png", "/product-preview.svg"],
    protectedPaths: []
  },
  {
    id: "ad-manager",
    name: "Raven Sharp Ad Manager",
    productLabel: "Ad Manager",
    url: "https://ads.raven-sharp.com",
    workspacePaths: ["/", "/dashboard", "/billing.html"],
    previewAssets: ["/product-preview.svg", "/product-preview.png", "/showcase/"],
    protectedPaths: ["/dashboard"]
  },
  {
    id: "book-creator",
    name: "Raven Sharp Book Creator",
    productLabel: "Book Creator",
    url: "https://books.raven-sharp.com",
    workspacePaths: ["/studio-v2.html", "/studio-v2.html#register"],
    previewAssets: ["/book-workspace-preview.png", "/product-preview.svg", "/product-preview.png"],
    protectedPaths: []
  },
  {
    id: "content-creator",
    name: "Raven Sharp Content Creator",
    productLabel: "Content Creator",
    url: "https://content.raven-sharp.com",
    workspacePaths: ["/studio-v2.html", "/studio-v2.html#register"],
    previewAssets: ["/product-preview.svg", "/product-preview.png"],
    protectedPaths: []
  }
];

const SUITE_DOMAINS = [
  "pod.raven-sharp.com",
  "opt.raven-sharp.com",
  "cleaner.raven-sharp.com",
  "ads.raven-sharp.com",
  "books.raven-sharp.com",
  "content.raven-sharp.com"
];

const BRAND_MARKERS = [
  "mystical-moments",
  "zyia",
  "spewcrew",
  "spew-crew",
  "feedthefeed",
  "feed-the-feed",
  "mycalctools",
  "mycalendartools",
  "wheelnamepicker",
  "adgdownloads",
  "adg-downloads"
];

const HEALTH_PATHS = ["/api/health", "/api/status", "/health"];
const LOGO_PATHS = ["/brands/ravenSharpLogo.png", "/raven-sharp-logo.png", "/ravenSharpLogo.png"];
const RAVEN_PATHS = ["/brands/ravenCentre.png", "/brands/ravenCentre-v2.png", "/brands/ravenCentre-v3.jpg", "/raven-centre.png"];
const ADG_PATHS = ["/brands/ascensionDigital.png", "/ascensionDigital.png", "/ascension-digital.png"];

export function textOnly(html = "") {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|quot|#39|#x27);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

function hasLink(html, pattern) {
  return new RegExp(`<a\\b[^>]*href=["'][^"']*${pattern}[^"']*["']`, "i").test(html);
}

function hasAny(value, markers) {
  const lower = String(value || "").toLowerCase();
  return markers.some(marker => lower.includes(marker.toLowerCase()));
}

async function fetchText(url, options = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: options.redirect || "follow",
      headers: {
        "User-Agent": options.userAgent || "ADG-SaaS-Monitor/4.0",
        "Accept": options.accept || "text/html,application/json,*/*",
        "Cache-Control": "no-cache"
      }
    });
    const type = response.headers.get("content-type") || "";
    const body = (type.includes("text") || type.includes("json") || type.includes("javascript") || type.includes("svg"))
      ? (await response.text()).slice(0, 900_000)
      : "";
    return {
      ok: response.ok,
      status: response.status,
      final_url: response.url,
      content_type: type,
      response_ms: Date.now() - started,
      headers: Object.fromEntries([
        "content-security-policy",
        "x-frame-options",
        "x-content-type-options",
        "referrer-policy",
        "permissions-policy",
        "strict-transport-security"
      ].map(name => [name, response.headers.get(name)])),
      body
    };
  } catch (error) {
    return { ok: false, status: 0, response_ms: Date.now() - started, error: error.message, body: "", headers: {} };
  }
}

async function firstAvailable(base, paths, options = {}) {
  const results = [];
  for (const path of paths) {
    const url = new URL(path, base).href;
    const result = await fetchText(url, options);
    results.push({ path, url, ...result, body: undefined });
    if (result.ok || (options.allowAuth && [301, 302, 303, 307, 308, 401, 403].includes(result.status))) {
      return { found: true, path, url, result, attempts: results };
    }
  }
  return { found: false, path: null, url: null, result: null, attempts: results };
}

async function healthProbe(base) {
  for (const path of HEALTH_PATHS) {
    const result = await fetchText(new URL(path, base).href, { accept: "application/json" });
    if (!result.ok) continue;
    let parsed = null;
    try { parsed = JSON.parse(result.body); } catch {}
    if (!parsed) continue;
    const secretLeak = /(?:sk_live_|sk_test_|Bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key["'\s:=]+[A-Za-z0-9._-]{16,})/i.test(result.body);
    return { found: !secretLeak, path, status: result.status, response_ms: result.response_ms, json: true, secret_leak_detected: secretLeak };
  }
  return { found: false, path: null, json: false, secret_leak_detected: false };
}

function securityChecks(headers) {
  const csp = headers["content-security-policy"] || "";
  return {
    content_security_policy: Boolean(csp),
    frame_protection: Boolean(headers["x-frame-options"] || csp.includes("frame-ancestors")),
    content_type_options: headers["x-content-type-options"] === "nosniff",
    referrer_policy: Boolean(headers["referrer-policy"]),
    permissions_policy: Boolean(headers["permissions-policy"]),
    strict_transport_security: Boolean(headers["strict-transport-security"])
  };
}

function staticShellChecks(app, html, copy) {
  const h1Count = count(html, /<h1\b/gi);
  const sectionCount = count(html, /<(?:section|article)\b/gi);
  const imageCount = count(html, /<img\b/gi);
  const productLabel = new RegExp(app.productLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";
  const wordCount = copy ? copy.split(/\s+/).length : 0;
  const suiteLinks = SUITE_DOMAINS.filter(domain => domain !== new URL(app.url).hostname && html.toLowerCase().includes(domain)).length;
  const brandLinks = BRAND_MARKERS.filter(marker => html.toLowerCase().includes(marker)).length;

  return {
    title,
    word_count: wordCount,
    h1_count: h1Count,
    section_count: sectionCount,
    image_count: imageCount,
    checks: {
      raven_sharp_identity: /RAVEN\s*SHARP/i.test(copy) || /ravenSharpLogo|raven-sharp-logo/i.test(html),
      product_label: productLabel.test(copy) || productLabel.test(title),
      header_logo: /ravenSharpLogo|raven-sharp-logo/i.test(html),
      centre_raven: /ravenCentre|raven-centre/i.test(html),
      fonts: /Outfit/i.test(html) && /Cabinet Grotesk|cabinet-grotesk/i.test(html) && /DM\s*Mono/i.test(html),
      dark_raven_palette: /#080810|#05050d|#050711/i.test(html) && /#7c5cbf|#a78bfa/i.test(html) && /#38bdf8/i.test(html),
      single_h1: h1Count === 1,
      useful_public_copy: wordCount >= 250,
      product_features: /what it does|features|capabilities|how it works/i.test(copy) || sectionCount >= 3,
      product_preview: /product-preview|workspace-preview|book-workspace-preview|showcase/i.test(html),
      preview_alt_text: /<img\b[^>]*src=["'][^"']*(?:product-preview|workspace-preview|book-workspace-preview)[^"']*["'][^>]*alt=["'][^"']{15,}["']/i.test(html)
        || /<img\b[^>]*alt=["'][^"']{15,}["'][^>]*src=["'][^"']*(?:product-preview|workspace-preview|book-workspace-preview)[^"']*["']/i.test(html),
      pricing: hasLink(html, "#pricing|pricing|plans") || /\bpricing\b|\bplans?\b|\$\d+/i.test(copy),
      primary_action: /get started|start (?:creating|free)|try it|try .*browser|open (?:app|optimiser)|sign in|create (?:campaign|account)|generate|upload/i.test(copy),
      adg_identity: /Ascension Digital Group/i.test(copy) || /ascensionDigital|ascension-digital/i.test(html),
      adg_tagline: /Elevating Your Digital Future/i.test(copy),
      raven_hub_link: /href=["']https:\/\/(?:www\.)?raven-sharp\.com\/?[^"']*["']/i.test(html),
      suite_navigation: suiteLinks >= 5,
      sister_brand_navigation: brandLinks >= 4,
      privacy_link: hasLink(html, "privacy"),
      terms_link: hasLink(html, "terms"),
      cookies_link: hasLink(html, "cookie")
    },
    suite_links: suiteLinks,
    brand_links: brandLinks
  };
}

function issue(severity, area, message, recommendation) {
  return { severity, area, message, recommendation };
}

export async function auditSaasApp(app) {
  const started = Date.now();
  const home = await fetchText(app.url);
  const html = home.body || "";
  const copy = textOnly(html);
  const scriptCount = count(html, /<script\b[^>]*src=/gi);
  const wordCount = copy ? copy.split(/\s+/).length : 0;
  const clientRendered = wordCount < 120 && scriptCount > 0;
  const shell = staticShellChecks(app, html, copy);

  let assets = { logo: null, centre_raven: null, preview: null, adg_logo: null };
  if (clientRendered || !shell.checks.header_logo || !shell.checks.centre_raven || !shell.checks.product_preview) {
    const [logo, centre, preview, adg] = await Promise.all([
      firstAvailable(app.url, LOGO_PATHS),
      firstAvailable(app.url, RAVEN_PATHS),
      firstAvailable(app.url, app.previewAssets || []),
      firstAvailable(app.url, ADG_PATHS)
    ]);
    assets = {
      logo: logo.found ? logo.path : null,
      centre_raven: centre.found ? centre.path : null,
      preview: preview.found ? preview.path : null,
      adg_logo: adg.found ? adg.path : null
    };
  }

  const workspace = await firstAvailable(app.url, app.workspacePaths || [], { allowAuth: true });
  const health = await healthProbe(app.url);
  const security = securityChecks(home.headers || {});

  if (assets.logo) shell.checks.header_logo = true;
  if (assets.centre_raven) shell.checks.centre_raven = true;
  if (assets.preview) shell.checks.product_preview = true;
  if (assets.adg_logo) shell.checks.adg_identity = true;

  const issues = [];
  if (!home.ok) issues.push(issue("critical", "availability", `Homepage returned HTTP ${home.status || 0}.`, "Restore the production homepage before judging the presentation baseline."));
  if (!shell.checks.raven_sharp_identity) issues.push(issue("critical", "brand shell", "Raven Sharp identity is missing from the public entry page.", "Restore the shared Raven Sharp header lockup or its rendered client equivalent."));
  if (!shell.checks.product_label) issues.push(issue("warning", "brand shell", `The ${app.productLabel} product label was not detected.`, "Keep the product name attached to the Raven Sharp wordmark and in the page title/copy."));
  if (!shell.checks.header_logo) issues.push(issue("warning", "brand shell", "Raven Sharp header logo asset was not detected.", "Use the shared Raven Sharp mark in the public header."));
  if (!shell.checks.centre_raven) issues.push(issue("warning", "brand shell", "Centred Raven hero artwork was not detected.", "Use the shared centre Raven artwork between the header and product hero."));

  if (!clientRendered) {
    if (!shell.checks.single_h1) issues.push(issue("warning", "content structure", `Expected one product H1 but found ${shell.h1_count}.`, "Keep one clear product-specific H1 in the hero."));
    if (!shell.checks.useful_public_copy) issues.push(issue("warning", "product information", `Public page has about ${shell.word_count} machine-readable words.`, "Keep enough product-specific explanation, workflow detail and use cases for a visitor to understand the tool before signing in."));
    if (!shell.checks.product_features) issues.push(issue("warning", "product information", "Product capability/What-it-does content was not detected.", "Keep the shared What it does/capabilities section with product-specific cards."));
    if (!shell.checks.product_preview) issues.push(issue("critical", "product proof", "No product/workspace preview was detected.", "Show a real or representative screenshot/mock-up of what the product actually does."));
    if (!shell.checks.preview_alt_text && shell.checks.product_preview) issues.push(issue("info", "accessibility", "Product preview does not appear to have descriptive alt text.", "Describe the workspace/output shown in the preview image."));
    if (!shell.checks.pricing) issues.push(issue("warning", "commercial", "Pricing or plan information was not detected.", "Keep the shared public pricing/plan section so visitors understand free and paid access."));
    if (!shell.checks.primary_action) issues.push(issue("critical", "feature access", "No clear product entry CTA was detected.", "Keep a prominent Sign In, Get Started, Try, Start or Open action."));
    if (!shell.checks.adg_identity || !shell.checks.adg_tagline) issues.push(issue("warning", "ecosystem footer", "Ascension Digital Group identity/tagline is incomplete.", "Use the shared ADG footer with the Ascension Digital Group logo and Elevating Your Digital Future tagline."));
    if (!shell.checks.raven_hub_link) issues.push(issue("warning", "ecosystem footer", "Raven Sharp hub link is missing.", "Link the shared footer/header back to https://raven-sharp.com."));
    if (!shell.checks.suite_navigation) issues.push(issue("warning", "ecosystem footer", `Only ${shell.suite_links} sibling Raven Sharp tool links were detected.`, "Keep the shared suite navigation linking the other Raven Sharp SaaS products."));
    if (!shell.checks.sister_brand_navigation) issues.push(issue("info", "ecosystem footer", "ADG sister-brand navigation looks incomplete.", "Keep the shared family-of-brands logos/links in the ADG footer."));
    if (!shell.checks.privacy_link || !shell.checks.terms_link || !shell.checks.cookies_link) issues.push(issue("warning", "legal", "Privacy, terms and cookie navigation is incomplete.", "Keep all three legal links in the shared footer."));
  }

  if (!workspace.found) issues.push(issue("critical", "feature access", "No configured product-entry/workspace route responded safely.", "Update the app entry path or the monitor route inventory to the actual product workspace."));
  if (!health.found) issues.push(issue("info", "health endpoint", "No safe JSON health/status endpoint was found.", "Add a read-only health endpoint when practical; do not expose provider credentials."));
  if (health.secret_leak_detected) issues.push(issue("critical", "security", "A health endpoint appears to expose a credential.", "Remove secrets from all health/configuration responses immediately."));

  for (const [name, passed] of Object.entries(security)) {
    if (!passed) issues.push(issue(name === "content_security_policy" || name === "frame_protection" ? "warning" : "info", "security headers", `${name.replaceAll("_", " ")} header is missing.`, "Apply the shared Raven Sharp security-header policy at the deployment edge."));
  }

  const baselineChecks = shell.checks;
  const applicableKeys = Object.keys(baselineChecks).filter(key => !clientRendered || [
    "raven_sharp_identity", "product_label", "header_logo", "centre_raven", "product_preview", "adg_identity"
  ].includes(key));
  const passedKeys = applicableKeys.filter(key => baselineChecks[key]).length;
  const baselinePercent = applicableKeys.length ? Math.round((passedKeys / applicableKeys.length) * 100) : 0;
  const critical = issues.filter(item => item.severity === "critical").length;
  const warnings = issues.filter(item => item.severity === "warning").length;

  return {
    id: app.id,
    name: app.name,
    product_label: app.productLabel,
    url: app.url,
    baseline_version: RAVEN_SHELL_VERSION,
    status: !home.ok || critical ? "needs_attention" : warnings ? "review" : "passed",
    homepage: {
      http: home.status,
      final_url: home.final_url,
      response_ms: home.response_ms,
      title: shell.title,
      client_rendered_shell: clientRendered,
      word_count: shell.word_count,
      script_count: scriptCount
    },
    baseline_percent: baselinePercent,
    baseline_checks: baselineChecks,
    assets,
    workspace: {
      found: workspace.found,
      path: workspace.path,
      attempts: workspace.attempts
    },
    health,
    security,
    issues,
    response_ms: Date.now() - started,
    checked_at: new Date().toISOString()
  };
}

export async function runSafeRouteTest(app) {
  const home = await fetchText(app.url, { userAgent: "ADG-SaaS-Testing-Agent/2.0" });
  const workspace = await firstAvailable(app.url, app.workspacePaths || [], { allowAuth: true, userAgent: "ADG-SaaS-Testing-Agent/2.0" });
  const health = await healthProbe(app.url);
  const protectedResults = [];
  for (const path of app.protectedPaths || []) {
    const result = await fetchText(new URL(path, app.url).href, { redirect: "manual", userAgent: "ADG-SaaS-Testing-Agent/2.0" });
    const location = result.final_url || "";
    const protectedRoute = [401, 403].includes(result.status)
      || [301, 302, 303, 307, 308].includes(result.status)
      || /login|sign-in|signin|account/i.test(location);
    protectedResults.push({ path, status: result.status, final_url: location, passed: protectedRoute });
  }
  return {
    id: app.id,
    name: app.name,
    url: app.url,
    homepage_available: home.ok,
    homepage_http: home.status,
    product_entry_available: workspace.found,
    product_entry_path: workspace.path,
    safe_health_endpoint: health.found,
    health,
    protected_routes: protectedResults,
    protected_routes_passed: protectedResults.every(item => item.passed),
    passed: home.ok && workspace.found && protectedResults.every(item => item.passed),
    checked_at: new Date().toISOString()
  };
}
