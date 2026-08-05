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
  if (new RegExp(`^${sitemap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mi").test(robots)) {
    return { content: robots, changes: [], changed: false };
  }
  return { content: `${robots.trim()}\n${sitemap}\n`, changes: ["Add canonical sitemap reference"], changed: true };
}

export function proposeCanonicalRepair(site, html) {
  const expected = `${site.url}/`;
  const existing = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i)
    || html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i);

  if (existing) {
    return existing[1] === expected
      ? { content: html, status: "clean", changes: [] }
      : { content: html, status: "approval_required", changes: [`Change canonical from ${existing[1]} to ${expected}`] };
  }

  if (!/<\/head>/i.test(html)) {
    return { content: html, status: "approval_required", changes: ["Add a canonical URL after repairing the document head"] };
  }

  return {
    content: html.replace(/<\/head>/i, `  <link rel="canonical" href="${expected}">\n</head>`),
    status: "repaired",
    changes: [`Add self-referencing canonical ${expected}`]
  };
}

async function createBranch(site, token, branch) {
  const repo = `/repos/${OWNER}/${site.repo}`;
  const main = await github(`${repo}/git/ref/heads/main`, token);
  await github(`${repo}/git/refs`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: main.object.sha })
  });
}

async function updateFile(site, file, content, token, branch, message) {
  const path = file.path.split("/").map(encodeURIComponent).join("/");
  return github(`/repos/${OWNER}/${site.repo}/contents/${path}`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: encode(content), sha: file.sha, branch })
  });
}

async function applySafeRepairs(site, token) {
  if (!token) return { status: "skipped", reason: "GITHUB_TOKEN is missing", changes: [] };

  const changes = [];
  const needsApproval = [];

  try {
    const robots = await getFile(site, "robots.txt", token);
    const proposal = proposeRobotsRepair(site, robots.content);
    if (proposal.changed) {
      await updateFile(site, robots, proposal.content, token, "main", `ADG Monitor: safe robots.txt repair for ${site.name}`);
      changes.push(...proposal.changes);
    }
  } catch (error) {
    needsApproval.push(`Review robots.txt: ${error.message}`);
  }

  try {
    const homepage = await getFile(site, "index.html", token);
    const canonical = proposeCanonicalRepair(site, homepage.content);
    if (canonical.status === "repaired") {
      await updateFile(site, homepage, canonical.content, token, "main", `ADG Monitor: add canonical URL for ${site.name}`);
      changes.push(...canonical.changes);
    } else if (canonical.status === "approval_required") {
      needsApproval.push(...canonical.changes);
    }
  } catch (error) {
    needsApproval.push(`Review canonical page: ${error.message}`);
  }

  return {
    status: changes.length ? "repaired" : needsApproval.length ? "approval_required" : "clean",
    changes,
    approval_required: needsApproval
  };
}

async function openPullRequest(site, token, branch, changes) {
  return github(`/repos/${OWNER}/${site.repo}/pulls`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `ADG Monitor: safe SEO repairs for ${site.name}`,
      head: branch,
      base: "main",
      body: `Automated repair proposal from ADG Monitor v4.\n\nChanges:\n${changes.map(x => `- ${x}`).join("\n")}\n\nThis pull request must be reviewed before merging.`
    })
  });
}

export async function prepareRepairPullRequest(site, token) {
  if (!token) return { site: site.id, status: "skipped", reason: "GITHUB_TOKEN is missing" };
  const homepage = await getFile(site, "index.html", token);
  const proposal = proposeHomepageRepairs(site, homepage.content);
  if (!proposal.changed) return { site: site.id, status: "clean", changes: [] };

  const timestamp = new Date().toISOString().replace(/\\D/g, "").slice(0, 14);\n  const branch = `adg-auto-repair-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await createBranch(site, token, branch);
  } catch (error) {
    if (!/Reference already exists/i.test(error.message)) throw error;
    return { site: site.id, status: "already_proposed", branch, changes: proposal.changes };
  }

  await updateFile(site, homepage, proposal.content, token, branch, `ADG Monitor: safe homepage repairs for ${site.name}`);
  const pull = await openPullRequest(site, token, branch, proposal.changes);
  return { site: site.id, status: "pr_opened", branch, pull_request: pull.html_url, changes: proposal.changes };
}

export async function runScheduledRepairCycle(token) {
  const results = [];
  for (const site of SITES) {
    try {
      const automatic = await applySafeRepairs(site, token);
      const homepage = await getFile(site, "index.html", token);
      const proposal = proposeHomepageRepairs(site, homepage.content);
      results.push({
        site: site.id,
        automatic,
        approval: proposal.changed
          ? { status: "approval_required", changes: proposal.changes }
          : { status: "clean", changes: [] }
      });
    } catch (error) {
      results.push({ site: site.id, status: "error", message: error.message });
    }
  }
  return results;
}

export async function runRepairCycle(token) {
  const results = [];
  for (const site of SITES) {
    try {
      const automatic = await applySafeRepairs(site, token);
      const approval = await prepareRepairPullRequest(site, token);
      results.push({ site: site.id, automatic, approval });
    } catch (error) {
      results.push({ site: site.id, status: "error", message: error.message });
    }
  }
  return results;
}

