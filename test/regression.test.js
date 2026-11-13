import test from "node:test";
import assert from "node:assert/strict";

import { auditRegressions, compareQualityManifests, nextRegressionState, qualityManifestForSite, resetRegressionBaseline } from "../src/regression.js";

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

test("inconsistent and duplicate page inventories cannot be approved", () => {
  const pages = [page("https://example.test/"), page("https://example.test/tool")];
  assert.equal(qualityManifestForSite(report(pages, { discovered_count: 3, known_recent_count: 3 }), "calendar", now).eligible, false);
  assert.equal(qualityManifestForSite(report([pages[0], pages[0]]), "calendar", now).eligible, false);
});

function memoryEnv(values = {}) {
  const data = new Map(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));
  return { MONITOR_KV: {
    async get(key, type) { const value = data.get(key); return value === undefined ? null : type === "json" ? JSON.parse(value) : value; },
    async put(key, value) { data.set(key, value); }
  } };
}

function mockSiteFetch(t, { publisher = true } = {}) {
  t.mock.method(globalThis, "fetch", async requested => {
    const url = new URL(requested);
    const html = `<!doctype html><html><head><title>Test calendar tool</title><meta name="description" content="Calculate dates"><link rel="canonical" href="https://example.test/"></head><body><h1>Calendar tool</h1><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/about">About</a><a href="/contact">Contact</a><a href="/cookies">Cookies</a><script src="/cookie-consent.js"></script>${publisher ? "ca-pub-1904958390525375" : ""}</body></html>`;
    const body = url.pathname === "/ads.txt" ? "google.com, pub-1904958390525375, DIRECT"
      : url.pathname === "/robots.txt" ? "User-agent: *\nSitemap: https://example.test/sitemap.xml"
      : url.pathname === "/sitemap.xml" ? "<urlset></urlset>"
      : url.pathname === "/cookie-consent.js" ? "cookieConsent accept granted decline denied settings preferences"
      : url.pathname.startsWith("/cookies") ? "<html><title>Cookie policy</title><h1>Cookie policy</h1>Cookie consent uses local storage. Accept or decline; change your choice in cookie settings.</html>" : html;
    return { ok: true, status: 200, url: `https://example.test${url.pathname}`, async text() { return body; } };
  });
}

test("the real audit flags a legacy endpoint-only baseline instead of clean", async t => {
  mockSiteFetch(t);
  const env = memoryEnv({ "anti-regression-baseline-v1": { version: 1, sites: { calendar: { homepage: {}, endpoints: {} } } } });
  const result = await auditRegressions(env, [{ id: "calendar", name: "Calendar", url: "https://example.test" }]);
  assert.equal(result.sites[0].status, "baseline_pending");
  assert.equal(result.sites[0].regression.baseline_complete, false);
  assert.equal(result.sites[0].regression.baseline_manifest_pages, 0);
});

test("missing publisher identity blocks saving an approved baseline", async t => {
  mockSiteFetch(t, { publisher: false });
  const result = await resetRegressionBaseline(memoryEnv(), [{ id: "calendar", name: "Calendar", url: "https://example.test" }]);
  assert.equal(result.status, "refused");
  assert.match(result.message, /critical checks/);
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

