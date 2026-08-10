export function indexingIssueItems(site = {}) {
  const discovery = (site.discovery_errors || []).map(item => item.message || String(item));
  const live = (site.live_audits || [])
    .filter(item => !item.passed)
    .flatMap(item => (item.issues || []).map(issue => `${item.url}: ${issue}`));
  const observations = site.google_observations || [];
  return [...new Set([...discovery, ...live, ...observations].filter(Boolean))];
}

export function indexingSiteNeedsAttention(site = {}) {
  return Boolean(
    (site.not_indexed_count || 0) > 0
    || (site.live_issue_count || 0) > 0
    || (site.canonical_conflict_count || 0) > 0
    || indexingIssueItems(site).length > 0
  );
}

export function dashboardSummary(
  siteReport = {},
  indexingReport = {},
  regressionReport = {},
) {
  const sites = siteReport.sites || [];
  const affected = new Set(
    sites.filter(site => !["up", "awaiting_deployment"].includes(site.status)).map(site => site.id),
  );

  for (const site of indexingReport.sites || []) {
    if (indexingSiteNeedsAttention(site)) affected.add(site.id);
  }

  for (const site of regressionReport.sites || []) {
    if (["regression_confirmed", "recheck_required"].includes(site.status)) affected.add(site.id);
  }

  return {
    online: sites.filter(site => site.status === "up").length,
    waiting: sites.filter(site => site.status === "awaiting_deployment").length,
    attention: affected.size,
    confirmedRegressions: (regressionReport.sites || [])
      .filter(site => site.status === "regression_confirmed").length,
  };
}
