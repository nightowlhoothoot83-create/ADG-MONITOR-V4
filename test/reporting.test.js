import test from "node:test";
import assert from "node:assert/strict";

import {
  dashboardSummary,
  indexingIssueItems,
  indexingSiteNeedsAttention,
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
