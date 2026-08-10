import test from "node:test";
import assert from "node:assert/strict";

import {
  isSmartCompressionWorthwhile,
  minimumSmartSavingsBytes,
} from "../app/compression-policy.ts";

test("smart balance keeps tiny images when savings do not justify quality loss", () => {
  const original = 4_710;
  const marginalResult = 4_587;

  assert.equal(minimumSmartSavingsBytes(original, "balanced"), 256);
  assert.equal(isSmartCompressionWorthwhile(original, marginalResult, "balanced"), false);
});

test("smart balance accepts a meaningfully smaller result", () => {
  assert.equal(isSmartCompressionWorthwhile(100_000, 94_999, "balanced"), true);
  assert.equal(isSmartCompressionWorthwhile(100_000, 95_001, "balanced"), false);
});

test("smaller-files mode uses a more aggressive savings threshold", () => {
  assert.equal(isSmartCompressionWorthwhile(100_000, 97_999, "small"), true);
  assert.equal(isSmartCompressionWorthwhile(100_000, 98_001, "small"), false);
});
