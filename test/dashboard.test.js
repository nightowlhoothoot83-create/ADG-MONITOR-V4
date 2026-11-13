import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("dashboard never renders an endpoint-only baseline as Protected", async () => {
  const report = { sites: [{ id: "calc", name: "Calculator", status: "clean", checked_at: new Date().toISOString(), regression: { baseline_manifest_pages: 0 } }] };
  const env = { MONITOR_KV: { async get(key) { return key === "latest-regression-report-v1" ? report : null; } } };
  const response = await worker.fetch(new Request("https://monitor.test/report"), env, {});
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Page baseline needed/);
  assert.match(html, /0 sites with current passing baseline checks/);
  assert.match(html, /Last site check:/);
  assert.doesNotMatch(html, />Protected</);
});
