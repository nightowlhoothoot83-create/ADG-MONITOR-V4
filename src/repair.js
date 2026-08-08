const API = "https://api.github.com";

export const SITES = [
  { id: "mycalctools", name: "MyCalcTools", url: "https://mycalctools.net", repo: "Mycalctools", policyStyle: "clean" },
  { id: "mycalendartools", name: "MyCalendarTools", url: "https://mycalendartools.net", repo: "Mycalendartools", policyStyle: "folder" },
  { id: "wheel", name: "Wheel Name Picker", url: "https://wheelnamepicker.com.au", repo: "Wheelnamepicker", policyStyle: "clean" }
];

const OWNER = "nightowlhoothoot83-create";
const POLICY_NAMES = ["privacy", "terms", "about", "contact"];

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "adg-monitor-v4"
  };
}

async function github(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...headers(token), ...(init.headers || {}) } });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${body?.message || path}`);
  return body;
}

function decode(value) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function getFile(site, path, token, ref = "main") {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const file = await github(`/repos/${OWNER}/${site.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, token);
  return { path, sha: file.sha, content: decode(file.content) };
}

async function tryGetFile(site, path, token, ref = "main") {
  try { return await getFile(site, path, token, ref); }
  catch (error) {
    if (/GitHub 404/.test(error.message)) return null;
    throw error;
  }
}

function policyHref(site, name) {
  if (site.policyStyle === "html") return `/${name}.html`;
  if (site.policyStyle === "clean") return `/${name}`;
  return `/${name}/`;
}

function policyFooter(site) {
  const label = { privacy: "Privacy Policy", terms: "Terms of Use", about: "About", contact: "Contact" };
  const links = POLICY_NAMES.map(name => `<a href="${policyHref(site, name)}">${label[name]}</a>`).join(" | ");
  return `\n<footer id="adg-policy-links" aria-label="Site policies">${links}</footer>\n`;
}

function websiteSchema(site) {
  return `\n<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: site.name,
    url: `${site.url}/`
  })}</script>\n`;
}

export function proposeHomepageRepairs(site, html) {
  let output = html;
  const changes = [];
  const missingPolicies = POLICY_NAMES.filter(name => !new RegExp(`href=["']${policyHref(site, name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i").test(output));
  if (missingPolicies.length && /<\/body>/i.test(output)) {
    output = output.replace(/<\/body>/i, `${policyFooter(site)}</body>`);
    changes.push(`Add crawlable policy links (${missingPolicies.join(", ")})`);
  }
  const emptyLinks = (output.match(/<a\b[^>]*href=["']#["'][^>]*>/gi) || []).length;
  if (emptyLinks) {
    output = output.replace(/(<a\b[^>]*href=)["']#["']/gi, '$1"/"');
    changes.push(`Replace ${emptyLinks} empty # link(s)`);
  }
  if (!/<script\b[^>]*type=["']application\/ld\+json["']/i.test(output) && /<\/head>/i.test(output)) {
    output = output.replace(/<\/head>/i, `${websiteSchema(site)}</head>`);
    changes.push("Add basic WebSite structured data");
  }
  return { content: output, changes, changed: output !== html };
}

export function proposeRobotsRepair(site, robots) {
  const sitemap = `Sitemap: ${site.url}/sitemap.xml`;
  if (new RegExp(`^${sitemap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mi").test(robots)) return { content: robots, changes: [], changed: false };
  return { content: `${robots.trim()}\n${sitemap}\n`, changes: ["Add canonical sitemap reference"], changed: true };
}

export function proposeCanonicalRepair(site, html) {
  const expected = `${site.url}/`;
  const existing = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i)
    || html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i);
  if (existing) return existing[1] === expected ? { content: html, status: "clean", changes: [] } : { content: html, status: "approval_required", changes: [`Change canonical from ${existing[1]} to ${expected}`] };
  if (!/<\/head>/i.test(html)) return { content: html, status: "approval_required", changes: ["Add a canonical URL after repairing the document head"] };
  return { content: html.replace(/<\/head>/i, `  <link rel="canonical" href="${expected}">\n</head>`), status: "repaired", changes: [`Add self-referencing canonical ${expected}`] };
}

function normalizedHost(value) { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
function normalizeUrl(value) { const url = new URL(value); url.hash = ""; url.hostname = normalizedHost(url.href); if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, ""); return url.href; }
function indexingSiteFor(report, site) { return report?.sites?.find(item => item.id === site.id) || null; }
function candidateMessage(candidate) { return candidate?.message ? `${candidate.url || candidate.sitemap || "Site"}: ${candidate.message}` : String(candidate || "Unknown indexing defect"); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }

async function createBranch(site, token, branch) {
  const repo = `/repos/${OWNER}/${site.repo}`;
  const main = await github(`${repo}/git/ref/heads/main`, token);
  await github(`${repo}/git/refs`, token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: main.object.sha }) });
}

async function updateFile(site, file, content, token, branch, message) {
  const path = file.path.split("/").map(encodeURIComponent).join("/");
  return github(`/repos/${OWNER}/${site.repo}/contents/${path}`, token, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, content: encode(content), sha: file.sha, branch }) });
}

async function openPullRequest(site, token, branch, changes, title) {
  return github(`/repos/${OWNER}/${site.repo}/pulls`, token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    title, head: branch, base: "main", draft: true,
    body: `Automated repair proposal from ADG Monitor v4.\n\nChanges:\n${changes.map(x => `- ${x}`).join("\n")}\n\nThis is a draft. Review and merge approval is still required before Cloudflare Pages can deploy it.`
  }) });
}

async function existingMonitorPull(site, token, title) {
  const pulls = await github(`/repos/${OWNER}/${site.repo}/pulls?state=open&per_page=100`, token);
  return pulls.find(pull => pull.title === title) || null;
}

async function commitPlannedFiles(site, token, title, filePlans, changes) {
  if (!filePlans.length) return { status: "clean", changes: [] };
  const existing = await existingMonitorPull(site, token, title);
  if (existing) return { status: "already_proposed", pull_request: existing.html_url, changes };
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const branch = `adg-monitor-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
  await createBranch(site, token, branch);
  for (const plan of filePlans) await updateFile(site, plan.file, plan.content, token, branch, `ADG Monitor: ${plan.message}`);
  const pull = await openPullRequest(site, token, branch, changes, title);
  return { status: "pr_opened", branch, pull_request: pull.html_url, changes };
}

async function planSafeRepairs(site, token) {
  const filePlans = [], changes = [];
  const robots = await tryGetFile(site, "robots.txt", token);
  if (robots) {
    const proposal = proposeRobotsRepair(site, robots.content);
    if (proposal.changed) { filePlans.push({ file: robots, content: proposal.content, message: `add sitemap reference for ${site.name}` }); changes.push(...proposal.changes); }
  }
  const homepage = await getFile(site, "index.html", token);
  const canonical = proposeCanonicalRepair(site, homepage.content);
  if (canonical.status === "repaired") { filePlans.push({ file: homepage, content: canonical.content, message: `add homepage canonical for ${site.name}` }); changes.push(...canonical.changes); }
  return { filePlans, changes };
}

async function prepareSafeRepairPullRequest(site, token) {
  if (!token) return { status: "skipped", reason: "GITHUB_TOKEN is missing", changes: [] };
  const plan = await planSafeRepairs(site, token);
  return commitPlannedFiles(site, token, `ADG Monitor: safe indexing repairs for ${site.name}`, plan.filePlans, plan.changes);
}

function sourceCandidatesForUrl(site, pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (normalizedHost(url.href) !== normalizedHost(site.url)) return [];
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!path) return ["index.html"];
    if (path.endsWith("/")) return [`${path}index.html`];
    if (/\.html?$/i.test(path)) return [path];
    return [`${path}.html`, `${path}/index.html`];
  } catch { return []; }
}

async function findPageFile(site, pageUrl, token) {
  for (const path of sourceCandidatesForUrl(site, pageUrl)) { const file = await tryGetFile(site, path, token); if (file) return file; }
  return null;
}

function setCanonical(html, expected) {
  const relFirst = /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i;
  const hrefFirst = /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i;
  if (relFirst.test(html)) return html.replace(relFirst, match => match.replace(/href=["'][^"']+["']/i, `href="${expected}"`));
  if (hrefFirst.test(html)) return html.replace(hrefFirst, match => match.replace(/href=["'][^"']+["']/i, `href="${expected}"`));
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `  <link rel="canonical" href="${expected}">\n</head>`);
  return null;
}

async function planApprovedRepairs(site, token, indexingSite) {
  const fileMap = new Map(), changes = [], unresolved = [];
  const loadPlanFile = async path => {
    if (fileMap.has(path)) return fileMap.get(path);
    const file = await tryGetFile(site, path, token);
    if (!file) return null;
    const plan = { file, content: file.content };
    fileMap.set(path, plan);
    return plan;
  };
  const homepage = await getFile(site, "index.html", token);
  const homepageProposal = proposeHomepageRepairs(site, homepage.content);
  if (homepageProposal.changed) { fileMap.set("index.html", { file: homepage, content: homepageProposal.content }); changes.push(...homepageProposal.changes); }

  for (const c of indexingSite?.repair_candidates || []) {
    if (c.kind === "redirect" && c.final_url && normalizedHost(c.final_url) === normalizedHost(site.url)) {
      const sitemap = await loadPlanFile("sitemap.xml");
      if (sitemap && sitemap.content.includes(c.url)) { sitemap.content = sitemap.content.split(c.url).join(c.final_url); changes.push(`Replace redirected sitemap URL ${c.url} with ${c.final_url}`); }
      else unresolved.push(candidateMessage(c));
      continue;
    }
    if (["missing_canonical", "canonical_mismatch"].includes(c.kind)) {
      const file = await findPageFile(site, c.url, token);
      if (!file) { unresolved.push(`${candidateMessage(c)} (source file not mapped automatically)`); continue; }
      const plan = await loadPlanFile(file.path), expected = c.final_url || c.url, updated = setCanonical(plan.content, expected);
      if (!updated) { unresolved.push(`${candidateMessage(c)} (document head could not be edited safely)`); continue; }
      plan.content = updated; changes.push(`Set canonical for ${c.url} to ${expected}`); continue;
    }
    if (c.kind === "redirect" && c.final_url && normalizeUrl(c.url) === normalizeUrl(c.final_url)) continue;
    unresolved.push(candidateMessage(c));
  }
  return { filePlans: [...fileMap.values()].filter(plan => plan.content !== plan.file.content).map(plan => ({ ...plan, message: `repair ${plan.file.path} for ${site.name}` })), changes: unique(changes), unresolved: unique(unresolved) };
}

export async function prepareRepairPullRequest(site, token, indexingSite = null) {
  if (!token) return { site: site.id, status: "skipped", reason: "GITHUB_TOKEN is missing" };
  const plan = await planApprovedRepairs(site, token, indexingSite);
  const result = await commitPlannedFiles(site, token, `ADG Monitor: approved repairs for ${site.name}`, plan.filePlans, plan.changes);
  return { site: site.id, ...result, unresolved: plan.unresolved };
}

function approvalPlan(site, homepage, indexingSite) {
  const homepageProposal = proposeHomepageRepairs(site, homepage.content);
  const indexingChanges = (indexingSite?.repair_candidates || []).filter(c => !(c.kind === "missing_canonical" && normalizeUrl(c.url) === normalizeUrl(site.url))).map(candidateMessage);
  const changes = unique([...homepageProposal.changes, ...indexingChanges]);
  return changes.length ? { status: "approval_required", changes } : { status: "clean", changes: [] };
}

export async function runScheduledRepairCycle(token, indexingReport = null) {
  const results = [];
  for (const site of SITES) {
    try {
      const automatic = await prepareSafeRepairPullRequest(site, token);
      const homepage = await getFile(site, "index.html", token);
      const approval = approvalPlan(site, homepage, indexingSiteFor(indexingReport, site));
      results.push({ site: site.id, automatic, approval });
    } catch (error) { results.push({ site: site.id, status: "error", message: error.message }); }
  }
  return results;
}

export async function runRepairCycle(token, indexingReport = null) {
  const results = [];
  for (const site of SITES) {
    try {
      const automatic = await prepareSafeRepairPullRequest(site, token);
      const approval = await prepareRepairPullRequest(site, token, indexingSiteFor(indexingReport, site));
      results.push({ site: site.id, automatic, approval });
    } catch (error) { results.push({ site: site.id, status: "error", message: error.message }); }
  }
  return results;
}
