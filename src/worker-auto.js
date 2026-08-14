import baseWorker from "./worker-v2.js";
import { SITES } from "./repair.js";

const API = "https://api.github.com";
const OWNER = "nightowlhoothoot83-create";

const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

function approved(request, env) {
  return Boolean(env.REPAIR_APPROVAL_KEY)
    && request.headers.get("Authorization") === `Bearer ${env.REPAIR_APPROVAL_KEY}`;
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "adg-monitor-v4-auto-merge"
  };
}

async function github(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...githubHeaders(token), ...(init.headers || {}) }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`GitHub ${response.status}: ${body?.message || path}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function graphql(query, variables, token) {
  const response = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.errors?.length) {
    const message = body?.errors?.map(error => error.message).join("; ") || `GitHub GraphQL ${response.status}`;
    throw new Error(message);
  }
  return body.data;
}

function pullNumber(url) {
  const match = String(url || "").match(/\/pull\/(\d+)(?:$|[/?#])/);
  return match ? Number(match[1]) : null;
}

async function markReady(repo, number, token, pull) {
  if (!pull?.draft) return pull;
  await graphql(
    `mutation($id: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $id }) {
        pullRequest { id isDraft }
      }
    }`,
    { id: pull.node_id },
    token
  );
  return github(`/repos/${OWNER}/${repo}/pulls/${number}`, token);
}

async function enableAutoMerge(repo, pull, token) {
  await graphql(
    `mutation($id: ID!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) {
        pullRequest { id }
      }
    }`,
    { id: pull.node_id },
    token
  );
}

async function closePull(repo, number, token) {
  return github(`/repos/${OWNER}/${repo}/pulls/${number}`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" })
  });
}

async function mergePull(site, phase, token) {
  if (!phase || !["pr_opened", "already_proposed"].includes(phase.status) || !phase.pull_request) return phase;

  const number = pullNumber(phase.pull_request);
  if (!number) return { ...phase, proposal_status: phase.status, status: "merge_failed", merge_error: "Could not determine pull request number" };

  try {
    let pull = await github(`/repos/${OWNER}/${site.repo}/pulls/${number}`, token);
    if (pull.merged) {
      return { ...phase, proposal_status: phase.status, status: "already_merged", merge_sha: pull.merge_commit_sha || null };
    }

    pull = await markReady(site.repo, number, token, pull);

    try {
      const merged = await github(`/repos/${OWNER}/${site.repo}/pulls/${number}/merge`, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merge_method: "squash",
          sha: pull.head?.sha,
          commit_title: `ADG Monitor: auto-merge approved repairs for ${site.name}`
        })
      });
      return {
        ...phase,
        proposal_status: phase.status,
        status: merged?.merged ? "merged" : "merge_failed",
        merge_sha: merged?.sha || null,
        merge_message: merged?.message || null
      };
    } catch (error) {
      try {
        await github(`/repos/${OWNER}/${site.repo}/pulls/${number}/update-branch`, token, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expected_head_sha: pull.head?.sha })
        });
        pull = await github(`/repos/${OWNER}/${site.repo}/pulls/${number}`, token);
        const merged = await github(`/repos/${OWNER}/${site.repo}/pulls/${number}/merge`, token, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            merge_method: "squash",
            sha: pull.head?.sha,
            commit_title: `ADG Monitor: auto-merge approved repairs for ${site.name}`
          })
        });
        return {
          ...phase,
          proposal_status: phase.status,
          status: merged?.merged ? "merged" : "merge_failed",
          merge_sha: merged?.sha || null,
          merge_message: merged?.message || null
        };
      } catch (retryError) {
        try {
          pull = await github(`/repos/${OWNER}/${site.repo}/pulls/${number}`, token);
          await enableAutoMerge(site.repo, pull, token);
          return {
            ...phase,
            proposal_status: phase.status,
            status: "auto_merge_queued",
            merge_message: "GitHub will merge automatically when required checks allow it."
          };
        } catch (autoError) {
          return {
            ...phase,
            proposal_status: phase.status,
            status: "merge_failed",
            merge_error: `${retryError.message}; auto-merge queue failed: ${autoError.message}`
          };
        }
      }
    }
  } catch (error) {
    return { ...phase, proposal_status: phase.status, status: "merge_failed", merge_error: error.message };
  }
}

async function parseReport(response) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { return { ok: false, response: new Response(text, { status: response.status, headers: response.headers }) }; }
  return { ok: response.ok, status: response.status, body };
}

function siteFor(result) {
  return SITES.find(site => site.id === result?.site) || null;
}

async function closeStaleApprovalPull(site, phase, token) {
  if (!site || !phase?.pull_request || !["pr_opened", "already_proposed"].includes(phase.status)) return;
  const number = pullNumber(phase.pull_request);
  if (!number) return;
  const pull = await github(`/repos/${OWNER}/${site.repo}/pulls/${number}`, token).catch(() => null);
  if (pull && !pull.merged && pull.state === "open") await closePull(site.repo, number, token);
}

async function runApprovedAutoMerge(request, env, ctx) {
  const first = await parseReport(await baseWorker.fetch(request.clone(), env, ctx));
  if (!first.ok) return json(first.body, first.status || 500);

  const report = first.body;
  report.mode = "approved_auto_merge";
  let safeMerged = false;

  for (const result of report.results || []) {
    const site = siteFor(result);
    if (!site || result.status === "error") continue;
    result.automatic = await mergePull(site, result.automatic, env.GITHUB_TOKEN);
    if (["merged", "already_merged"].includes(result.automatic?.status)) safeMerged = true;
  }

  let approvalReport = report;

  if (safeMerged) {
    for (const result of report.results || []) {
      const site = siteFor(result);
      if (!site || result.status === "error") continue;
      await closeStaleApprovalPull(site, result.approval, env.GITHUB_TOKEN).catch(() => {});
    }

    const second = await parseReport(await baseWorker.fetch(request.clone(), env, ctx));
    if (second.ok) {
      approvalReport = second.body;
      approvalReport.mode = "approved_auto_merge";
      approvalReport.first_pass_safe_repairs = report.results || [];
    }
  }

  for (const result of approvalReport.results || []) {
    const site = siteFor(result);
    if (!site || result.status === "error") continue;
    result.approval = await mergePull(site, result.approval, env.GITHUB_TOKEN);
  }

  approvalReport.completed_at = new Date().toISOString();
  if (env.MONITOR_KV) {
    await env.MONITOR_KV.put("latest-repair-report-v1", JSON.stringify(approvalReport));
  }
  return json(approvalReport);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/repair/run" && request.method === "POST") {
      if (!approved(request, env)) return json({ error: "Repair approval required" }, 403);
      if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN is missing" }, 500);
      return runApprovedAutoMerge(request, env, ctx);
    }
    return baseWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return baseWorker.scheduled(event, env, ctx);
  }
};
