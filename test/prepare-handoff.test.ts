import assert from "node:assert/strict";
import test from "node:test";
import { HANDOFF_PREPARATION_PROMPT, prepareHandoff } from "../src/prepare-handoff.ts";

test("preparation queues the detailed prompt, waits, and requires a fresh checkpoint", async () => {
  let state: any = { savedAt: "old", messageCount: 10 };
  const calls: string[] = [];
  await prepareHandoff("ses_prepare", {
    async prompt(input) {
      calls.push("prompt");
      assert.equal(input.delivery, "queue");
      assert.equal(input.text, HANDOFF_PREPARATION_PROMPT);
      assert.match(input.text, /pendingUserRequests/);
    },
    async wait() { calls.push("wait"); state = { savedAt: "new", messageCount: 12 }; },
  }, () => state);
  assert.deepEqual(calls, ["prompt", "wait"]);
});

test("missing and unchanged checkpoints fail closed", async () => {
  for (const state of [null, { savedAt: "old", messageCount: 10 }]) {
    await assert.rejects(prepareHandoff("ses_stale", {
      async prompt() {}, async wait() {},
    }, () => state as any), /did not save a fresh/);
  }
});

test("model errors release the guard; overlapping preparations are rejected", async () => {
  let finish!: () => void;
  const pending = prepareHandoff("ses_busy", {
    async prompt() { await new Promise<void>(resolve => { finish = resolve; }); throw new Error("Cancelled"); },
    async wait() {},
  }, () => null);
  await assert.rejects(prepareHandoff("ses_busy", { async prompt() {}, async wait() {} }, () => null), /already being prepared/);
  finish();
  await assert.rejects(pending, /Cancelled/);
  await assert.rejects(prepareHandoff("ses_busy", { async prompt() {}, async wait() {} }, () => null), /did not save a fresh/);
});
