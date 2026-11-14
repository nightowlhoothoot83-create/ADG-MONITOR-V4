export function indexingIssueItems(site = {}) {
  const discovery = (site.discovery_errors || []).map(item => item.message || String(item));
  const live = (site.live_audits || [])
    .filter(item => !item.passed)
    .flatMap(item => (item.issues || []).map(issue => `${item.url}: ${issue}`));
  const technical = site.technical_indexing_faults || [];
  return [...new Set([...discovery, ...live, ...technical].filter(Boolean))];
}

export function indexingSiteNeedsAttention(site = {}) {
  return Boolean(
    (site.technical_indexing_fault_count || 0) > 0
    || (site.live_issue_count || 0) > 0
    || (site.canonical_conflict_count || 0) > 0
    || indexingIssueItems(site).length > 0
  );
}

// Age belongs to each site's scan, not to the newest report from another site.
export function regressionPresentation(site = {}, now = Date.now()) {
  const checked = Date.parse(site.checked_at);
  if (!Number.isFinite(checked) || checked > now + 300000 || now - checked > 36 * 60 * 60 * 1000) {
    return { tone: "waiting", label: "Check overdue", protected: false,
      message: "This site's regression check is missing or older than 36 hours. Its last result is not current protection." };
  }
  if (site.status === "regression_confirmed") return { tone: "error", label: "Confirmed regression", protected: false, message: "A change failed consecutive baseline comparisons." };
  if (site.status === "recheck_required") return { tone: "waiting", label: "Recheck pending", protected: false, message: "A baseline comparison failed and needs confirmation." };
  if (site.status === "site_check_failed") return { tone: "error", label: "Site check failed", protected: false, message: "One or more current critical site checks failed." };
  if (site.status === "baseline_pending" || !site.regression?.baseline_manifest_pages || site.regression?.baseline_complete === false) {
    return { tone: "waiting", label: "Page baseline needed", protected: false,
      message: "A complete approved page and asset baseline is missing. Homepage checks alone do not protect page content." };
  }
  if (site.status !== "clean" || site.regression?.coverage_complete !== true) {
    return { tone: "waiting", label: "Checks incomplete", protected: false,
      message: site.regression?.coverage_issue || "Fresh complete page coverage has not been verified." };
  }
  return { tone: "healthy", label: "Baseline checks passed", protected: true,
    message: "The latest completed scan matched the approved page and asset baseline. This does not verify every tool's answers or AdSense approval." };
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
    if (!regressionPresentation(site).protected) affected.add(site.id);
  }

  return {
    online: sites.filter(site => site.status === "up").length,
    waiting: sites.filter(site => site.status === "awaiting_deployment").length,
    attention: affected.size,
    confirmedRegressions: (regressionReport.sites || [])
      .filter(site => site.status === "regression_confirmed").length,
  };
}

