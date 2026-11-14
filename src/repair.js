const API = "https://api.github.com";

export const SITES = [
  { id: "mycalctools", name: "MyCalcTools", url: "https://mycalctools.net", repo: "Mycalctools", policyStyle: "clean", projectStatus: "done", baselineApproved: true },
  { id: "mycalendartools", name: "MyCalendarTools", url: "https://mycalendartools.net", repo: "Mycalendartools", policyStyle: "folder", projectStatus: "done", baselineApproved: true },
  { id: "wheel", name: "Wheel Name Picker", url: "https://wheelnamepicker.com.au", repo: "Wheelnamepicker", policyStyle: "clean", projectStatus: "done", baselineApproved: true }
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
    changes.push("Add WebSite structured data");
  }
  return { changed: changes.length > 0, content: output, changes };
}

async function createRepairBranch(site, token, branchName) {
  const ref = await github(`/repos/${OWNER}/${site.repo}/git/ref/heads/main`, token);
  await github(`/repos/${OWNER}/${site.repo}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: ref.object.sha })
  });
  return ref.object.sha;
}

async function updateFile(site, file, content, token, branchName, message) {
  return await github(`/repos/${OWNER}/${site.repo}/contents/${file.path}`, token, {
    method: "PUT",
    body: JSON.stringify({ message, content: encode(content), sha: file.sha, branch: branchName })
  });
}

async function openPullRequest(site, token, branchName, title, body) {
  return await github(`/repos/${OWNER}/${site.repo}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({ title, body, head: branchName, base: "main" })
  });
}

export async function runRepairCycle(env, siteId, { approve = false } = {}) {
  const site = SITES.find(item => item.id === siteId);
  if (!site) throw new Error(`Unknown site: ${siteId}`);
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");

  const homepage = await getFile(site, "index.html", env.GITHUB_TOKEN);
  const proposal = proposeHomepageRepairs(site, homepage.content);
  const report = {
    version: 1,
    run_at: new Date().toISOString(),
    site: site.id,
    repo: `${OWNER}/${site.repo}`,
    project_status: site.projectStatus || "active",
    baseline_approved: Boolean(site.baselineApproved),
    proposal
  };

  if (!proposal.changed) {
    report.status = site.baselineApproved ? "baseline_healthy" : "no_changes";
    await env.MONITOR_KV?.put("latest-repair-report-v1", JSON.stringify({ version: 1, run_at: report.run_at, results: [report] }));
    return report;
  }

  if (!approve) {
    report.status = "approval_required";
    report.approval = { status: "approval_required", changes: proposal.changes };
    await env.MONITOR_KV?.put("latest-repair-report-v1", JSON.stringify({ version: 1, run_at: report.run_at, results: [report] }));
    return report;
  }

  const branchName = `repair/${site.id}-${Date.now()}`;
  await createRepairBranch(site, env.GITHUB_TOKEN, branchName);
  await updateFile(site, homepage, proposal.content, env.GITHUB_TOKEN, branchName, `Repair ${site.name} homepage compliance`);
  const pr = await openPullRequest(site, env.GITHUB_TOKEN, branchName, `Repair ${site.name} homepage compliance`, `Automated proposal from ADG Monitor.\n\nChanges:\n${proposal.changes.map(change => `- ${change}`).join("\n")}\n\nNo production deployment is performed by this monitor.`);
  report.status = "pull_request_created";
  report.pull_request = { number: pr.number, url: pr.html_url, branch: branchName };
  await env.MONITOR_KV?.put("latest-repair-report-v1", JSON.stringify({ version: 1, run_at: report.run_at, results: [report] }));
  return report;
}

export async function runScheduledRepairCycle(env) {
  const results = [];
  for (const site of SITES) {
    try {
      results.push(await runRepairCycle(env, site.id, { approve: false }));
    } catch (error) {
      results.push({ site: site.id, status: "error", error: error.message });
    }
  }
  const report = { version: 1, run_at: new Date().toISOString(), results };
  await env.MONITOR_KV?.put("latest-repair-report-v1", JSON.stringify(report));
  return report;
}
