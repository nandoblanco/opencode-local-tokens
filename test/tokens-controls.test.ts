import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { analyzeTokens, mutateSessionTag, sortTokenSessions, TOKEN_SORT_MODES, type MatchedSessionRow } from "../src/tokens.ts";

it("sorts every supported mode with deterministic ties", () => {
  const rows = [
    { id: "a", smartTitle: "Zulu", tokens: { input: 500, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, steps: 1, turns: 1, score: 3, timeUpdated: 200, timeCreated: 100 },
    { id: "b", smartTitle: "Alpha", tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 900, cacheWrite: 0 }, steps: 3, turns: 3, score: 1, timeUpdated: 300, timeCreated: 200 },
    { id: "c", smartTitle: "Beta", tokens: { input: 200, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, steps: 2, turns: 2, score: 2, timeUpdated: 100, timeCreated: 300 },
  ] as MatchedSessionRow[];
  const orders = { billed: "acb", total: "bac", steps: "bca", updated: "bac", newest: "cba", oldest: "abc", title: "bca", relevance: "acb" };
  for (const mode of TOKEN_SORT_MODES) {
    const sorted = [...rows];
    sortTokenSessions(sorted, mode);
    assert.equal(sorted.map(row => row.id).join(""), orders[mode]);
  }
  const tied = [{ ...rows[0], id: "z" }, { ...rows[0], id: "a" }];
  sortTokenSessions(tied, "billed");
  assert.deepEqual(tied.map(row => row.id), ["a", "z"]);
});

it("sorts before limiting and persists normalized tag additions, removals, and inferred-tag suppression", () => {
  const root = mkdtempSync(join(import.meta.dirname, "controls-fixture-"));
  const dbPath = join(root, "opencode.db");
  const sidecarPath = join(root, "tags.json");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER, time_created INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)");
  for (let i = 1; i <= 18; i++) {
    const id = `ses_controls_${String(i).padStart(2, "0")}`;
    db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)").run(id, `Repair ${i}`, root, i, i);
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(`m${i}`, id, "assistant", i, JSON.stringify({ providerID: "fixture", modelID: "fixture", tokens: { input: (19 - i) * 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, content: [{ type: "text", text: "Repair complete" }] }));
  }
  const options = { dbPath, sidecarPath, includeExternalCli: false, claudeDir: join(root, "claude"), codexDir: join(root, "codex"), tagRules: [{ tag: "repair", pattern: "repair" }] };
  try {
    const billed = analyzeTokens({ ...options, sort: "billed", limit: 14 });
    assert.equal(billed.sessions[0].id, "ses_controls_01");
    const updated = analyzeTokens({ ...options, sort: "updated", limit: 14 });
    assert.equal(updated.sessions[0].id, "ses_controls_18");
    assert.equal(updated.totalSessionsMatched, 18);
    assert.equal(updated.totals.input, billed.totals.input);
    assert.equal(analyzeTokens({ ...options, sort: "oldest", limit: 1 }).sessions[0].id, "ses_controls_01");
    const id = "ses_controls_18";
    assert.ok(updated.sessions[0].tags.includes("repair"));
    mutateSessionTag("tag", id, "#Review, BILLING,review", options);
    let session = analyzeTokens({ ...options, tag: "review" }).sessions[0];
    assert.equal(session.id, id);
    assert.deepEqual(session.customTags, ["review", "billing"]);
    mutateSessionTag("untag", id, "review,repair", options);
    session = analyzeTokens({ ...options, sort: "updated" }).sessions[0];
    assert.equal(session.tags.includes("review"), false);
    assert.equal(session.tags.includes("repair"), false);
    assert.ok(session.tags.includes("billing"));
    mutateSessionTag("tag", id, "repair", options);
    assert.ok(analyzeTokens({ ...options, sort: "updated" }).sessions[0].tags.includes("repair"));
    assert.equal(JSON.parse(readFileSync(sidecarPath, "utf8")).sessions[id].removedTags.includes("repair"), false);
    const env = { ...process.env, OPENCODE_DB_PATH: dbPath, OPENCODE_SESSION_TAGS: sidecarPath, CLAUDE_PROJECTS_DIR: options.claudeDir, CODEX_SESSIONS_DIR: options.codexDir };
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "../cli.js"), ...args], { env, encoding: "utf8" });
    const sortedCli = cli("--sort", "updated", "--limit", "1");
    assert.equal(sortedCli.status, 0, sortedCli.stderr);
    assert.match(sortedCli.stdout, /Repair 18/);
    assert.equal(cli("--sort", "invalid").status, 1);
    assert.equal(cli("tag", id, "shell-tag").status, 0);
    assert.ok(analyzeTokens({ ...options, sort: "updated" }).sessions[0].tags.includes("shell-tag"));
    assert.equal(cli("untag", id, "shell-tag").status, 0);
    assert.equal(analyzeTokens({ ...options, sort: "updated" }).sessions[0].tags.includes("shell-tag"), false);
    assert.equal(db.prepare("SELECT count(*) AS count FROM session_v2").get()?.count, 18);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
