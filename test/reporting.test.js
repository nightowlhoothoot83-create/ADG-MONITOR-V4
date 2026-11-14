import test from "node:test";
import assert from "node:assert/strict";

import {
  dashboardSummary,
  indexingIssueItems,
  indexingSiteNeedsAttention,
  regressionPresentation,
} from "../src/reporting.js";

test("healthy but unindexed URLs do not mark the site as technically broken", () => {
  const sites = { sites: [{ id: "calendar", status: "up" }] };
  const indexing = {
    sites: [{
      id: "calendar",
      inspected_count: 8,
      indexed_count: 0,
      not_indexed_count: 8,
      unindexed_healthy_count: 8,
      manual_request_count: 5,
      technical_indexing_fault_count: 0,
      google_observations: ["https://example.test/tool: Discovered - currently not indexed"],
    }],
  };

  assert.equal(indexingSiteNeedsAttention(indexing.sites[0]), false);
  assert.deepEqual(dashboardSummary(sites, indexing), {
    online: 1,
    waiting: 0,
    attention: 0,
    confirmedRegressions: 0,
  });
});

test("Google observations stay informational instead of becoming site issues", () => {
  const issues = indexingIssueItems({
    google_observations: ["https://example.test/tool: Discovered - currently not indexed"],
  });
  assert.deepEqual(issues, []);
});

test("real technical indexing faults still require attention", () => {
  const site = {
    technical_indexing_fault_count: 1,
    technical_indexing_faults: ["https://example.test/tool: Google reports robots.txt state: BLOCKED"],
  };
  assert.equal(indexingSiteNeedsAttention(site), true);
  assert.deepEqual(indexingIssueItems(site), [
    "https://example.test/tool: Google reports robots.txt state: BLOCKED",
  ]);
});

test("attention is counted once per site across homepage, indexing and regression failures", () => {
  const summary = dashboardSummary(
    { sites: [{ id: "calc", status: "error" }] },
    { sites: [{ id: "calc", technical_indexing_fault_count: 2 }] },
    { sites: [{ id: "calc", status: "regression_confirmed" }] },
  );
  assert.equal(summary.attention, 1);
  assert.equal(summary.confirmedRegressions, 1);
});

const checkedNow = Date.parse("2026-11-13T12:00:00Z");
const protectedSite = {
  id: "calc", status: "clean", checked_at: "2026-11-13T11:50:00Z",
  regression: { baseline_manifest_pages: 57, baseline_complete: true, coverage_complete: true }
};

test("a legacy clean report with zero baseline pages cannot claim protection", () => {
  const result = regressionPresentation({ ...protectedSite, regression: { baseline_manifest_pages: 0 } }, checkedNow);
  assert.equal(result.protected, false);
  assert.equal(result.label, "Page baseline needed");
});

test("an unrelated new report cannot refresh a stale site check", () => {
  const site = { ...protectedSite, checked_at: "2026-11-10T11:50:00Z", run_at: "2026-11-13T12:00:00Z" };
  assert.equal(regressionPresentation(site, checkedNow).label, "Check overdue");
});

test("missing, invalid and future check timestamps never pass", () => {
  for (const checked_at of [undefined, "bad", "2026-11-14T12:00:00Z"]) {
    assert.equal(regressionPresentation({ ...protectedSite, checked_at }, checkedNow).protected, false);
  }
});

test("incomplete checks remain visible even with a complete baseline", () => {
  const result = regressionPresentation({ ...protectedSite, regression: { ...protectedSite.regression, coverage_complete: false } }, checkedNow);
  assert.equal(result.label, "Checks incomplete");
  assert.equal(result.protected, false);
});

test("only a fresh complete passing comparison earns a passing label", () => {
  assert.equal(regressionPresentation(protectedSite, checkedNow).protected, true);
  assert.equal(regressionPresentation({ ...protectedSite, status: "unexpected" }, checkedNow).protected, false);
});

test("a missing page baseline contributes to the dashboard attention count", () => {
  const site = { ...protectedSite, checked_at: new Date().toISOString(), regression: { baseline_manifest_pages: 0 } };
  assert.equal(dashboardSummary({ sites: [{ id: "calc", status: "up" }] }, {}, { sites: [site] }).attention, 1);
});

