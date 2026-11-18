import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { handoffDirectory, saveHandoffState } from "../src/handoff.ts";
import { buildSessionHandoff, resolveDefaultSidecarPath } from "../src/tokens.ts";

it("resolves portable defaults and preserves explicit and environment path precedence", () => {
  const tags = process.env.OPENCODE_SESSION_TAGS;
  const memory = process.env.OPENCODE_MEMORY_DIR;
  try {
    delete process.env.OPENCODE_SESSION_TAGS;
    delete process.env.OPENCODE_MEMORY_DIR;
    assert.equal(resolveDefaultSidecarPath(), join(homedir(), ".local", "share", "opencode", "session-tags.json"));
    assert.equal(handoffDirectory(), join(homedir(), ".opencode", "memory", "handoffs"));
    process.env.OPENCODE_SESSION_TAGS = join(import.meta.dirname, "environment-tags.json");
    process.env.OPENCODE_MEMORY_DIR = join(import.meta.dirname, "environment-memory");
    assert.equal(resolveDefaultSidecarPath(), process.env.OPENCODE_SESSION_TAGS);
    assert.equal(handoffDirectory(), join(process.env.OPENCODE_MEMORY_DIR, "handoffs"));
    assert.equal(resolveDefaultSidecarPath("explicit-tags.json"), "explicit-tags.json");
    assert.equal(handoffDirectory("explicit-memory"), join("explicit-memory", "handoffs"));
  } finally {
    if (tags === undefined) delete process.env.OPENCODE_SESSION_TAGS;
    else process.env.OPENCODE_SESSION_TAGS = tags;
    if (memory === undefined) delete process.env.OPENCODE_MEMORY_DIR;
    else process.env.OPENCODE_MEMORY_DIR = memory;
  }
});

it("keeps working state, exports, and measurements under the configured memory root", () => {
  const root = mkdtempSync(join(import.meta.dirname, "paths-fixture-"));
  const dbPath = join(root, "opencode.db");
  const db = new DatabaseSync(dbPath);
  const memory = process.env.OPENCODE_MEMORY_DIR;
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)");
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run("ses_paths", "Portable paths", root, 1);
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run("m_paths", "ses_paths", "user", 1, JSON.stringify({ text: "Keep path configuration portable" }));
  const state = { goal: "Portable storage", constraints: [], decisions: [], verified: [], unfinished: [], failures: [], pendingUserRequests: [], nextStep: "Check export" };
  try {
    process.env.OPENCODE_MEMORY_DIR = join(root, "environment-memory");
    for (const memoryDir of [undefined, join(root, "explicit-memory")]) {
      const options = { dbPath, memoryDir };
      const expected = memoryDir || process.env.OPENCODE_MEMORY_DIR;
      saveHandoffState("ses_paths", state, options);
      const handoff = buildSessionHandoff("ses_paths", options);
      assert.equal(handoff.checkpointPath.startsWith(join(expected, "sessions")), true);
      assert.match(readFileSync(handoff.checkpointPath, "utf8"), /Portable storage/);
      assert.equal(JSON.parse(readFileSync(join(expected, "handoffs", "ses_paths.json"), "utf8")).state.goal, state.goal);
      assert.equal(JSON.parse(readFileSync(join(expected, "handoffs", "measurements", "checkpoint-ses_paths.json"), "utf8")).sessionId, "ses_paths");
    }
  } finally {
    if (memory === undefined) delete process.env.OPENCODE_MEMORY_DIR;
    else process.env.OPENCODE_MEMORY_DIR = memory;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
