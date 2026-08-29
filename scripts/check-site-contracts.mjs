const SITES = [
  {
    id: 'mycalctools',
    origin: 'https://mycalctools.net',
    critical: ['/bmi-calculator', '/calorie-calculator'],
    pageMarkers: ['id="brand-strip"', 'id="nav"', '/cookie-consent.js'],
    shared: [
      ['/cookie-consent.js', ['ensureShellMounts', 'site-footer', 'group-footer', 'mct-approved-shell-style', 'mycalendartools.net/assets/perf/ascension-digital.webp']],
      ['/style.css', ['.btn-calc', 'box-shadow:', '.calc-card', '.result-box.health', '.result-box.finance', '.result-box.kitchen', '.result-box.lifestyle', '.result-box.business', '.result-box.eco']]
    ]
  },
  {
    id: 'mycalendartools',
    origin: 'https://mycalendartools.net',
    critical: ['/days-between/', '/date-calculator/', '/world-clock/', '/privacy/', '/days-until-christmas/'],
    pageMarkers: ['id="brand-strip"', 'id="nav"', 'id="site-footer"', 'id="group-footer"', '/components.js'],
    shared: [
      ['/components.js', ['renderNav', 'renderSiteFooter', 'renderGroupFooter', '/assets/perf/ascension-digital.webp', '/assets/perf/mycalendartools-logo.webp']],
      ['/style.css', ['.card', 'linear-gradient(135deg', '.btn-primary', 'box-shadow:', '.btn-secondary']]
    ]
  },
  {
    id: 'wheel',
    origin: 'https://wheelnamepicker.com.au',
    critical: ['/coin-toss', '/dice-roller', '/lucky-dip'],
    pageMarkers: ['X-ADG-Visual-Shell'],
    shared: []
  }
];

const MAX_REDIRECTS = 6;
const UA = 'ADG-Monitor-v4-Contract/1.0';
const failures = [];
const checkedTargets = new Map();

function norm(value) {
  const u = new URL(value);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/$/, '');
  return u.href;
}

function canonical(html, base) {
  const m = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (!m) return null;
  try { return new URL(m[1], base).href; } catch { return null; }
}

function hrefs(html) {
  return [...html.matchAll(/\bhref=(["'])([^"']+)\1/gi)].map(m => m[2]);
}

async function trace(url) {
  const chain = [];
  const seen = new Set();
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (seen.has(current)) throw new Error(`redirect loop at ${current}`);
    seen.add(current);
    const response = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status} without Location at ${current}`);
      const next = new URL(location, current).href;
      chain.push({ from: current, to: next, status: response.status });
      current = next;
      continue;
    }
    return { response, finalUrl: current, chain };
  }
  throw new Error(`too many redirects from ${url}`);
}

async function readHtmlExact(url, requireExact = true) {
  const traced = await trace(url);
  const type = traced.response.headers.get('content-type') || '';
  if (!traced.response.ok) throw new Error(`HTTP ${traced.response.status}`);
  if (!type.includes('text/html')) throw new Error(`expected HTML, got ${type || 'unknown content type'}`);
  if (requireExact && norm(traced.finalUrl) !== norm(url)) throw new Error(`resolved to ${traced.finalUrl}`);
  const html = await traced.response.text();
  const can = canonical(html, traced.finalUrl);
  if (!can) throw new Error('missing canonical');
  if (norm(can) !== norm(traced.finalUrl)) throw new Error(`canonical points to ${can}`);
  return { html, response: traced.response, finalUrl: traced.finalUrl, chain: traced.chain };
}

async function sitemap(site) {
  const response = await fetch(`${site.origin}/sitemap.xml`, { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`sitemap HTTP ${response.status}`);
  const xml = await response.text();
  const urls = [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&').trim());
  if (!urls.length) throw new Error('sitemap contains no URLs');
  return urls;
}

function sameSite(raw, base, site) {
  if (!raw || /^(?:#|mailto:|tel:|javascript:|data:)/i.test(raw)) return null;
  try {
    const u = new URL(raw, base);
    const a = u.hostname.toLowerCase().replace(/^www\./, '');
    const b = new URL(site.origin).hostname.toLowerCase().replace(/^www\./, '');
    return a === b ? u.href : null;
  } catch { return null; }
}

async function checkTarget(site, target) {
  const key = `${site.id}:${norm(target)}`;
  if (checkedTargets.has(key)) return checkedTargets.get(key);
  const promise = (async () => {
    const page = await readHtmlExact(target, true);
    return page.finalUrl;
  })();
  checkedTargets.set(key, promise);
  return promise;
}

async function checkShared(site) {
  for (const [path, markers] of site.shared) {
    const response = await fetch(`${site.origin}${path}`, { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
    if (!response.ok) { failures.push(`${site.id} ${path}: HTTP ${response.status}`); continue; }
    const text = await response.text();
    for (const marker of markers) if (!text.includes(marker)) failures.push(`${site.id} ${path}: missing contract marker ${marker}`);
  }
}

function checkPageShell(site, url, html, response) {
  if (site.id === 'wheel') {
    if (response.headers.get('X-ADG-Visual-Shell') !== 'wheel-shell-fix-v1') failures.push(`${site.id} ${url}: visual-shell response marker missing`);
    if (!html.includes('id="adg-wheel-shell-fix"')) failures.push(`${site.id} ${url}: injected shell CSS missing`);
    if (!/<footer\b/i.test(html)) failures.push(`${site.id} ${url}: footer missing`);
    if (!html.includes('/assets/perf/logo-ascension-digital.webp')) failures.push(`${site.id} ${url}: approved Ascension logo reference missing`);
    if (norm(url) === norm(site.origin + '/')) {
      if (!html.includes('class="hero-logo"')) failures.push('wheel homepage: hero logo missing');
      if (!/\.hero-logo\{[^}]*height:auto!important[^}]*object-fit:contain!important/i.test(html)) failures.push('wheel homepage: hero logo proportion protection missing');
    }
    return;
  }
  for (const marker of site.pageMarkers) if (!html.includes(marker)) failures.push(`${site.id} ${url}: missing shell marker ${marker}`);
  if (site.id === 'mycalctools' && !/<footer\b[^>]*id=["']static-policy-footer["']/i.test(html)) failures.push(`${site.id} ${url}: footer fallback missing`);
}

async function auditSite(site) {
  let urls;
  try { urls = await sitemap(site); }
  catch (error) { failures.push(`${site.id}: ${error.message}`); return; }

  const sitemapSet = new Set(urls.map(norm));
  sitemapSet.add(norm(site.origin + '/'));

  for (const route of site.critical) {
    try { await readHtmlExact(`${site.origin}${route}`, true); }
    catch (error) { failures.push(`${site.id} critical ${route}: ${error.message}`); }
  }

  for (const url of urls) {
    let page;
    try { page = await readHtmlExact(url, true); }
    catch (error) { failures.push(`${site.id} ${url}: ${error.message}`); continue; }
    checkPageShell(site, url, page.html, page.response);

    for (const raw of hrefs(page.html)) {
      const internal = sameSite(raw, page.finalUrl, site);
      if (!internal) continue;
      const u = new URL(internal); u.hash = '';
      if (/\.(?:css|js|png|jpe?g|webp|svg|ico|xml|txt|pdf)$/i.test(u.pathname)) continue;
      if (/\.html$/i.test(u.pathname) || /\/index\.html$/i.test(u.pathname)) failures.push(`${site.id} ${url}: legacy internal link ${raw}`);
      try { await checkTarget(site, u.href); }
      catch (error) { failures.push(`${site.id} link ${raw} from ${url}: ${error.message}`); }
    }
  }

  await checkShared(site);
}

for (const site of SITES) {
  console.log(`Auditing ${site.id}...`);
  await auditSite(site);
}

if (failures.length) {
  console.error(`\nContract audit failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`\nAll site contracts passed. Checked ${checkedTargets.size} unique internal HTML targets plus every sitemap URL and critical route.`);
