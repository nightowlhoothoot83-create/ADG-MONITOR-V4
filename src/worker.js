import baseWorker from "./index.js";
import { SITES, runRepairCycle, runScheduledRepairCycle } from "./repair.js";
import { auditIndexing, latestIndexing } from "./indexing.js";

const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

const GITHUB_API = "https://api.github.com";
const GITHUB_OWNER = "nightowlhoothoot83-create";

function approved(request, env) {
  return Boolean(env.REPAIR_APPROVAL_KEY) && request.headers.get("Authorization") === `Bearer ${env.REPAIR_APPROVAL_KEY}`;
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "adg-monitor-v4"
  };
}

async function githubJson(path, token, init = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...(init.headers || {})
    }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${body?.message || path}`);
  return body;
}

function pullNumberFromUrl(value) {
  const match = String(value || "").match(/\/pull\/(\d+)(?:$|[/?#])/);
  return match ? Number(match[1]) : null;
}

async function markPullReady(repo, pull, token) {
  if (!pull.draft) return;
  const query = `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}`;
  const response = await githubJson("/graphql", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { id: pull.node_id } })
  });
  if (response?.errors?.length) throw new Error(response.errors.map(error => error.message).join("; "));
}

async function mergeMonitorPull(site, pullUrl, token) {
  if (!token) throw new Error("GITHUB_TOKEN is missing");
  const pullNumber = pullNumberFromUrl(pullUrl);
  if (!pullNumber) throw new Error(`Could not identify pull request from ${pullUrl}`);

  const repo = `${GITHUB_OWNER}/${site.repo}`;
  const pull = await githubJson(`/repos/${repo}/pulls/${pullNumber}`, token);

  const safeMonitorPull =
    pull?.base?.ref === "main"
    && pull?.head?.ref?.startsWith("adg-monitor-")
    && pull?.head?.repo?.full_name === repo
    && String(pull?.title || "").startsWith("ADG Monitor:");

  if (!safeMonitorPull) {
    throw new Error(`Refusing to auto-merge PR #${pullNumber}: it is not an ADG Monitor repair pull request`);
  }

  if (pull.merged) {
    return { status: "already_merged", pull_request: pull.html_url, merge_sha: pull.merge_commit_sha || null };
  }

  await markPullReady(repo, pull, token);

  const merged = await githubJson(`/repos/${repo}/pulls/${pullNumber}/merge`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      merge_method: "squash",
      commit_title: `${pull.title} (#${pullNumber})`,
      commit_message: "Automatically merged by ADG Monitor v4 after explicit repair approval."
    })
  });

  if (!merged?.merged) throw new Error(merged?.message || `GitHub did not merge PR #${pullNumber}`);
  return { status: "merged", pull_request: pull.html_url, merge_sha: merged.sha || null };
}

async function autoMergeApprovedResults(results, token) {
  for (const result of results) {
    const site = SITES.find(item => item.id === result.site);
    if (!site) continue;

    for (const key of ["automatic", "approval"]) {
      const repair = result[key];
      if (!repair?.pull_request || !["pr_opened", "already_proposed"].includes(repair.status)) continue;

      try {
        const merge = await mergeMonitorPull(site, repair.pull_request, token);
        repair.merge = merge;
        repair.status = merge.status;
      } catch (error) {
        repair.merge = { status: "merge_failed", message: error.message, pull_request: repair.pull_request };
        repair.status = "merge_failed";
      }
    }
  }
  return results;
}

async function runRepairWithIndexing(env, isApproved) {
  const indexing = await latestIndexing(env);
  const results = isApproved
    ? await runRepairCycle(env.GITHUB_TOKEN, indexing)
    : await runScheduledRepairCycle(env.GITHUB_TOKEN, indexing);

  if (isApproved) await autoMergeApprovedResults(results, env.GITHUB_TOKEN);

  const report = {
    run_at: new Date().toISOString(),
    mode: isApproved ? "approved_auto_merge" : "scheduled_safe",
    indexing_report_version: indexing.version || null,
    results
  };
  if (env.MONITOR_KV) await env.MONITOR_KV.put("latest-repair-report-v1", JSON.stringify(report));
  return report;
}

const INDEXING_CRONS = new Set(["*/10 21-22 * * *", "0,10,20 23 * * *"]);

function indexingSiteForScheduledTime(scheduledTime) {
  const date = new Date(scheduledTime);
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const slot = ((hour - 21) * 6) + Math.floor(minute / 10);
  return SITES[slot % SITES.length];
}

async function enhanceDashboardResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;

  let html = await response.text();
  html = html
    .replaceAll("Google checked <b>", "Google checked (24h sample) <b>")
    .replaceAll("Indexed <b>", "Indexed in checked set <b>")
    .replaceAll(
      "These changes require your approval before a repair pull request is created.",
      "Approve these changes once. ADG Monitor will create the repair pull request, merge it automatically, and let Cloudflare Pages deploy from main."
    );

  const styles = `<style>
    .button.task-active{outline:2px solid var(--green);box-shadow:0 0 0 4px rgba(66,211,146,.12);background:#163b31;color:#c8ffe2}
    .button.task-busy{cursor:progress;opacity:.95}
    .task-spinner{display:inline-block;width:13px;height:13px;margin-right:8px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:-2px;animation:adg-spin .7s linear infinite}
    .task-state{display:none;margin:10px 0 0;color:var(--green);font-weight:700}
    .task-state.visible{display:block}
    .checks li.advisory{color:var(--amber);text-transform:none}
    .checks li.advisory span{background:#4a3818;color:#ffd987}
    @keyframes adg-spin{to{transform:rotate(360deg)}}
  </style>`;

  const script = `<script>
  (() => {
    const taskSelector = [
      'a.button[href^="/adsense/run"]',
      'a.button[href^="/regression/run"]',
      'a.button[href^="/indexing/run"]',
      'a.button[href^="/repair/scan"]'
    ].join(',');
    const buttons = [...document.querySelectorAll(taskSelector)];
    let state = document.querySelector('.task-state');
    if (!state) {
      state = document.createElement('p');
      state.className = 'task-state';
      state.setAttribute('role', 'status');
      const header = document.querySelector('header');
      if (header) header.insertAdjacentElement('afterend', state);
    }
    buttons.forEach(button => {
      button.addEventListener('click', () => {
        buttons.forEach(other => other.classList.remove('task-active','task-busy'));
        button.classList.add('task-active','task-busy');
        const original = button.textContent.trim();
        button.innerHTML = '<span class="task-spinner" aria-hidden="true"></span>' + original + '…';
        button.setAttribute('aria-busy','true');
        state.textContent = original + ' is running. The dashboard will refresh when it finishes.';
        state.classList.add('visible');
      });
    });

    document.querySelectorAll('.checks li.fail').forEach(item => {
      if (/Thin Page:/i.test(item.textContent || '')) {
        item.classList.remove('fail');
        item.classList.add('advisory');
        const icon = item.querySelector('span');
        if (icon) icon.textContent = 'i';
        item.innerHTML = item.innerHTML.replace(/Thin Page:/i, 'Content advisory:');
      }
    });

    document.querySelectorAll('article.card').forEach(card => {
      const advisories = card.querySelectorAll('.checks li.advisory');
      const remainingFailures = card.querySelectorAll('.checks li.fail');
      if (advisories.length && !remainingFailures.length) {
        const status = card.querySelector('.status');
        if (status && /site issue/i.test(status.textContent || '')) {
          status.textContent = advisories.length + ' content advisory' + (advisories.length === 1 ? '' : 'ies');
          card.classList.remove('error');
          card.classList.add('waiting');
        }
      }
    });
  })();
  </script>`;

  html = html.replace("</head>", `${styles}</head>`).replace("</body>", `${script}</body>`);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/repair/scan") {
      await runRepairWithIndexing(env, false);
      return Response.redirect(`${url.origin}/report`, 303);
    }

    if (url.pathname === "/repair/run" && request.method === "POST") {
      if (!approved(request, env)) return json({ error: "Repair approval required" }, 403);
      return json(await runRepairWithIndexing(env, true));
    }

    const response = await baseWorker.fetch(request, env, ctx);
    return enhanceDashboardResponse(response);
  },

  async scheduled(event, env, ctx) {
    if (INDEXING_CRONS.has(event.cron)) {
      const site = indexingSiteForScheduledTime(event.scheduledTime);
      ctx.waitUntil(auditIndexing(env, [site]));
      return;
    }

    if (event.cron === "40 23 * * *") {
      ctx.waitUntil(runRepairWithIndexing(env, false));
      return;
    }

    return baseWorker.scheduled(event, env, ctx);
  }
};
