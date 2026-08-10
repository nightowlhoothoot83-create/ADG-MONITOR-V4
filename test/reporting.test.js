import test from "node:test";
import assert from "node:assert/strict";

import {
  dashboardSummary,
  indexingIssueItems,
  indexingSiteNeedsAttention,
} from "../src/reporting.js";

test("an online homepage still needs attention when Google has not indexed checked URLs", () => {
  const sites = { sites: [{ id: "calendar", status: "up" }] };
  const indexing = {
    sites: [{
      id: "calendar",
      inspected_count: 8,
      indexed_count: 0,
      not_indexed_count: 8,
      google_observations: ["https://example.test/tool: URL is unknown to Google"],
    }],
  };

  assert.equal(indexingSiteNeedsAttention(indexing.sites[0]), true);
  assert.deepEqual(dashboardSummary(sites, indexing), {
    online: 1,
    waiting: 0,
    attention: 1,
    confirmedRegressions: 0,
  });
});

test("Google observations are rendered as actionable indexing issues", () => {
  const issues = indexingIssueItems({
    google_observations: ["https://example.test/tool: Discovered - currently not indexed"],
  });
  assert.deepEqual(issues, ["https://example.test/tool: Discovered - currently not indexed"]);
});

test("attention is counted once per site across homepage, indexing and regression failures", () => {
  const summary = dashboardSummary(
    { sites: [{ id: "calc", status: "error" }] },
    { sites: [{ id: "calc", not_indexed_count: 2 }] },
    { sites: [{ id: "calc", status: "regression_confirmed" }] },
  );
  assert.equal(summary.attention, 1);
  assert.equal(summary.confirmedRegressions, 1);
});
