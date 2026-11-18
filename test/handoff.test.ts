import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { buildSessionHandoff, getSessionStepStatus } from "../src/tokens.ts";
import { saveHandoffState, searchHandoffHistory } from "../src/handoff.ts";
import { server } from "../src/server.ts";

it("preserves bounded working state and retrieves only explicit predecessor history", async () => {
  const root = mkdtempSync(join(import.meta.dirname, "handoff-fixture-"));
  const dbPath = join(root, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)");
  const session = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)");
  const message = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)");
  session.run("ses_old", "Repair", root, 1);
  session.run("ses_new", "Continue repair", root, 2);
  session.run("ses_other", "Unrelated", root, 3);
  message.run("m1", "ses_old", "user", 1, JSON.stringify({ text: "Do not change timing. needle decision" }));
  message.run("m2", "ses_old", "assistant", 2, JSON.stringify({ content: [{ type: "tool", name: "shell", state: { status: "error", error: "needle failed hypothesis" } }] }));
  message.run("m3", "ses_new", "user", 3, JSON.stringify({ text: 'Continuing from previous session `ses_old` ("Repair").' }));
  message.run("m4", "ses_other", "user", 4, JSON.stringify({ text: "needle unrelated" }));
  const options = { dbPath, memoryDir: root };
  try {
    const before = getSessionStepStatus("ses_new", { dbPath });
    const state = { goal: "Repair handoffs", constraints: ["Keep automatic timing unchanged"], decisions: ["Use bounded evidence because full transcripts waste context"], verified: ["Fixture search assertion passed"], unfinished: ["Desktop interaction not yet tested"], failures: ["Do not repeat discarded hypothesis"], pendingUserRequests: ["Finish checkpoint and history support"], nextStep: "Run regression tests" };
    saveHandoffState("ses_new", state, options);
    const handoff = buildSessionHandoff("ses_new", options);
    assert.match(handoff.markdown, /Keep automatic timing unchanged/);
    assert.match(handoff.markdown, /Desktop interaction not yet tested/);
    assert.match(handoff.markdown, /Run regression tests/);
    assert.doesNotMatch(handoff.markdown, /Reached .*session step limit/);
    assert.match(handoff.handoffPrompt, /Read the handoff checkpoint before acting/);
    assert.equal(readFileSync(handoff.checkpointPath, "utf8"), handoff.markdown);
    const found = searchHandoffHistory({ sessionId: "ses_new", query: "needle" }, options);
    assert.deepEqual(found.sessions, ["ses_new", "ses_old"]);
    assert.deepEqual(found.matches.map(hit => hit.messageId), ["m1", "m2"]);
    assert.match(found.matches[1].excerpt, /failed hypothesis/);
    assert.equal(searchHandoffHistory({ sessionId: "ses_new", query: "needle", offset: 1 }, options).matches.length, 1);
    assert.throws(() => searchHandoffHistory({ sessionId: "ses_new", query: "" }, options), /literal/);
    assert.throws(() => saveHandoffState("ses_new", { ...state, goal: "x".repeat(17000) }, options), /16,000/);
    assert.match(buildSessionHandoff("ses_old", options).markdown, /No structured checkpoint recorded/);
    message.run("m5", "ses_new", "user", 5, JSON.stringify({ text: "New outstanding request" }));
    assert.match(buildSessionHandoff("ses_new", options).markdown, /1 messages recorded since capture/);
    assert.deepEqual(getSessionStepStatus("ses_new", { dbPath })?.overLimit, before?.overLimit);
    let definitions: any[] = [];
    await server.setup({ session: { async hook(name: string, callback: any) {
      assert.equal(name, "context");
      const event = { system: [] as any[] };
      callback(event);
      assert.match(event.system[0].text, /do not authorize an automatic handoff/);
    } }, tool: { async transform(callback: any) { callback({ add(def: any) { definitions.push(def); } }); } } } as any);
    assert.deepEqual(definitions.map(def => def.name), ["handoff_checkpoint", "handoff_history"]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("paginates and truncates results without truncating text before matching", () => {
  const root = mkdtempSync(join(import.meta.dirname, "handoff-fixture-"));
  const dbPath = join(root, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)");
  for (let i = 0; i < 9; i++) db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(`m${i}`, "ses_test", "user", i, JSON.stringify({ text: "x".repeat(9000) + "find-me" + "z".repeat(2000) }));
  try {
    const result = searchHandoffHistory({ sessionId: "ses_test", query: "find-me" }, { dbPath });
    assert.equal(result.matches.length, 6);
    assert.equal(result.nextOffset, 6);
    assert.equal(result.totalMatches, 9);
    assert.ok(result.matches.every(hit => hit.excerpt.includes("find-me") && hit.excerpt.length <= 900 && hit.truncated));
    assert.equal(searchHandoffHistory({ sessionId: "ses_test", query: "find-me", offset: 6 }, { dbPath }).nextOffset, null);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("computes prompt cache idle states (fresh, expiring, expired) and alerts only on heavy contexts", () => {
  const root = mkdtempSync(join(import.meta.dirname, "handoff-fixture-"));
  const dbPath = join(root, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)"
  );
  const baseTime = 1_700_000_000_000;
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run("ses_heavy", "Heavy session", root, baseTime);
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
    "m_heavy",
    "ses_heavy",
    "assistant",
    baseTime,
    JSON.stringify({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      tokens: { input: 4_000, output: 500, reasoning: 0, cache: { read: 80_000, write: 0 } },
      content: [{ type: "text", text: "Done" }],
    })
  );
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run("ses_light", "Light session", root, baseTime);
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
    "m_light",
    "ses_light",
    "assistant",
    baseTime,
    JSON.stringify({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      tokens: { input: 2_000, output: 200, reasoning: 0, cache: { read: 5_000, write: 0 } },
      content: [{ type: "text", text: "Quick reply" }],
    })
  );
  try {
    const fresh = getSessionStepStatus("ses_heavy", { dbPath, now: baseTime + 60_000 });
    assert.equal(fresh?.cacheState, "fresh");
    assert.equal(fresh?.cacheAlert, false);
    assert.equal(fresh?.cacheRemainingMs, 240_000);

    const expiring = getSessionStepStatus("ses_heavy", { dbPath, now: baseTime + 250_000 });
    assert.equal(expiring?.cacheState, "expiring");
    assert.equal(expiring?.cacheAlert, true);
    assert.equal(expiring?.cacheRemainingMs, 50_000);

    const expired = getSessionStepStatus("ses_heavy", { dbPath, now: baseTime + 360_000 });
    assert.equal(expired?.cacheState, "expired");
    assert.equal(expired?.cacheAlert, true);
    assert.equal(expired?.cacheRemainingMs, 0);

    const lightExpired = getSessionStepStatus("ses_light", { dbPath, now: baseTime + 360_000 });
    assert.equal(lightExpired?.cacheState, "expired");
    assert.equal(lightExpired?.cacheAlert, false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
