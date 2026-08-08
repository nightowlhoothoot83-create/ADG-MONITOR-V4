import baseWorker from "./index.js";
import { SITES, runRepairCycle, runScheduledRepairCycle } from "./repair.js";
import { auditIndexing, latestIndexing } from "./indexing.js";

const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

function approved(request, env) {
  return Boolean(env.REPAIR_APPROVAL_KEY) && request.headers.get("Authorization") === `Bearer ${env.REPAIR_APPROVAL_KEY}`;
}

async function runRepairWithIndexing(env, isApproved) {
  const indexing = await latestIndexing(env);
  const results = isApproved
    ? await runRepairCycle(env.GITHUB_TOKEN, indexing)
    : await runScheduledRepairCycle(env.GITHUB_TOKEN, indexing);
  const report = {
    run_at: new Date().toISOString(),
    mode: isApproved ? "approved" : "scheduled_safe",
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
    .replaceAll("Indexed <b>", "Indexed in checked set <b>");

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