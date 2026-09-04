import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/saas-worker-v3.js";

test("SaaS monitor exposes machine-readable health without storage access", async () => {
  const response = await worker.fetch(
    new Request("https://monitor.example/health"),
    {},
    { waitUntil() {} }
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/i);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "adg-saas-monitor",
    version: 4,
    baseline_version: "raven-sharp-canonical-shell-2026-08-11",
    apps: 6,
    audit: "safe_read_only"
  });
});
