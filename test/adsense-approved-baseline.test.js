import test from "node:test";
import assert from "node:assert/strict";
import { SITES } from "../src/repair.js";

test("all three AdSense sites are marked done with approved baselines", () => {
  assert.equal(SITES.length, 3);
  for (const site of SITES) {
    assert.equal(site.projectStatus, "done", `${site.name} should be marked done`);
    assert.equal(site.baselineApproved, true, `${site.name} should use the approved baseline`);
  }
});

test("the approved AdSense baseline contains the expected properties", () => {
  assert.deepEqual(SITES.map(site => site.id).sort(), ["mycalctools", "mycalendartools", "wheel"]);
});