import assert from "node:assert/strict";
import test from "node:test";
import { copyImageWithFeedback } from "../desktop/operation-feedback.ts";

test("floating copy reports success after the clipboard write completes", async () => {
  const events = [];
  const copied = await copyImageWithFeedback(
    async (path) => events.push(["copy", path]),
    "/tmp/result.webp",
    "zh",
    (text, tone = "success") => events.push(["notice", text, tone]),
  );

  assert.equal(copied, true);
  assert.deepEqual(events, [
    ["copy", "/tmp/result.webp"],
    ["notice", "复制成功", "success"],
  ]);
});

test("floating copy reports a visible failure instead of failing silently", async () => {
  const notices = [];
  const copied = await copyImageWithFeedback(
    async () => { throw new Error("clipboard unavailable"); },
    "/tmp/result.webp",
    "en",
    (text, tone = "success") => notices.push([text, tone]),
  );

  assert.equal(copied, false);
  assert.deepEqual(notices, [["Copy failed: clipboard unavailable", "error"]]);
});
