import test from "node:test";
import assert from "node:assert/strict";

import { compareQualityManifests, nextRegressionState, qualityManifestForSite } from "../src/regression.js";

const now = Date.parse("2026-08-25T00:00:00Z");
const page = (url, overrides = {}) => ({
  url,
  final_url: url,
  canonical: url,
  passed: true,
  word_count: 400,
  audited_at: "2026-08-24T23:00:00Z",
  signature: {
    content_sha256: "abc",
    h1_count: 1,
    heading_count: 5,
    footer_count: 1,
    image_count: 2,
    internal_link_count: 10,
    form_control_count: 3
  },
  ...overrides
});

function report(pages, overrides = {}) {
  return { version: 2, run_at: "2026-08-24T23:10:00Z", sites: [{
    id: "calendar", status: "clean", issue_page_count: 0,
    shared_source_legacy_reference_count: 0, discovered_count: pages.length,
    known_recent_count: pages.length, full_recent_coverage: true, pages,
    shared_assets: [{ path: "/style.css", http: 200, content_type: "text/css", content_sha256: "css", byte_length: 1000, passed: true }],
    ...overrides
  }] };
}

test("baseline eligibility requires complete clean signed coverage", () => {
  assert.equal(qualityManifestForSite(report([page("https://example.test/")]), "calendar", now).eligible, true);
  assert.match(qualityManifestForSite(report([page("https://example.test/")], { full_recent_coverage: false }), "calendar", now).reason, /every sitemap page/);
  assert.match(qualityManifestForSite(report([page("https://example.test/", { signature: null })]), "calendar", now).reason, /structural signature/);
  assert.match(qualityManifestForSite(report([page("https://example.test/")], { shared_assets: [] }), "calendar", now).reason, /shared visual/);
});

test("manifest comparison detects page, content and structural regressions", () => {
  const baseline = qualityManifestForSite(report([
    page("https://example.test/"), page("https://example.test/tool")
  ]), "calendar", now);
  const current = qualityManifestForSite(report([
    page("https://example.test/", { word_count: 350, signature: { ...page("x").signature, content_sha256: "changed", footer_count: 0 } }),
    page("https://example.test/new")
  ]), "calendar", now);
  const failures = compareQualityManifests(baseline, current);
  assert.ok(failures.includes("quality.content_sha256:https://example.test/"));
  assert.ok(failures.includes("quality.footer_count:https://example.test/"));
  assert.ok(failures.includes("quality.word_count_reduced:https://example.test/"));
  assert.ok(failures.includes("quality.page_removed:https://example.test/tool"));
  assert.ok(failures.includes("quality.page_added:https://example.test/new"));
});

test("manifest comparison detects shared stylesheet regression", () => {
  const baseline = qualityManifestForSite(report([page("https://example.test/")]), "calendar", now);
  const current = qualityManifestForSite(report([page("https://example.test/")], {
    shared_assets: [{ path: "/style.css", http: 200, content_type: "text/css", content_sha256: "changed", byte_length: 1100, passed: true }]
  }), "calendar", now);
  const failures = compareQualityManifests(baseline, current);
  assert.ok(failures.includes("quality.asset_content_sha256:/style.css"));
  assert.ok(failures.includes("quality.asset_byte_length:/style.css"));
});

test("missing current quality coverage is a regression, not a clean result", () => {
  const baseline = qualityManifestForSite(report([page("https://example.test/")]), "calendar", now);
  assert.deepEqual(compareQualityManifests(baseline, { eligible: false, reason: "stale" }), ["quality.manifest_unavailable: stale"]);
});

test("regressions require two consecutive failures and clear after recovery", () => {
  const first = nextRegressionState({}, ["quality.footer_count:https://example.test/"], "2026-08-25T00:00:00Z");
  assert.equal(first.consecutive_failures, 1);
  assert.equal(first.confirmed, false);
  const second = nextRegressionState(first, first.regressed_checks, "2026-08-25T00:10:00Z");
  assert.equal(second.consecutive_failures, 2);
  assert.equal(second.confirmed, true);
  assert.equal(second.first_failed_at, first.first_failed_at);
  const recovered = nextRegressionState(second, [], "2026-08-25T00:20:00Z");
  assert.equal(recovered.consecutive_failures, 0);
  assert.equal(recovered.confirmed, false);
  assert.equal(recovered.first_failed_at, null);
});
