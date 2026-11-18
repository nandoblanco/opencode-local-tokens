import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { measureHandoff } from "../src/measurement.ts";
import { server } from "../src/server.ts";

it("measures bounded recovery windows without copying bodies or changing the source database", () => {
  const root = mkdtempSync(join(import.meta.dirname, "measurement-fixture-"));
  const dbPath = join(root, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)");
  const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)");
  const start = Date.now() - 10000;
  const request = (session: string, i: number, at: number, model = "old") => insert.run(`${session}-${i}`, session, "assistant", at, JSON.stringify({ model: { providerID: "fixture", id: model }, tokens: { input: i + 100, output: 20, reasoning: 3, cache: { read: 50, write: 4 } }, content: [{ type: "text", text: "PRIVATE_BODY" }, { type: "tool", name: "read", state: { input: "PRIVATE_PATH", output: "PRIVATE_BODY" } }, { type: "tool", name: "handoff_history", state: {} }] }));
  const options = { dbPath, memoryDir: root };
  const directory = join(root, "handoffs", "measurements");
  try {
    for (let i = 0; i < 7; i++) request("ses_parent", i, start + i);
    measureHandoff("ses_parent", "checkpoint", options, { messageCount: 7 });
    measureHandoff("ses_parent", "handoff", options, { checkpointSavedAt: new Date().toISOString(), staleMessages: 2, modelContextLimit: 1000 });
    const file = join(directory, readdirSync(directory).find(name => name.startsWith("handoff-"))!);
    let record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(record.beforeSave.length, 5);
    assert.equal(record.checkpointObservation.baseline.length, 5);
    assert.equal(record.staleMessages, 2);
    assert.equal(record.lastRequest.context, 160);
    insert.run("child-user", "ses_child", "user", record.savedAt + 1, JSON.stringify({ text: "Continuing from previous session `ses_parent` (\"PRIVATE_BODY\")." }));
    for (let i = 0; i < 3; i++) request("ses_child", i, record.savedAt + 2 + i, "new");
    measureHandoff("ses_child", "idle", options);
    record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(record.children[0].firstFive.complete, false);
    for (let i = 3; i < 12; i++) request("ses_child", i, record.savedAt + 2 + i, "new");
    const before = db.prepare("SELECT * FROM session_message ORDER BY id").all();
    measureHandoff("ses_child", "idle", options);
    measureHandoff("ses_child", "idle", options);
    record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(record.children.length, 1);
    const child = record.children[0];
    assert.equal(child.requests.length, 10);
    assert.equal(child.modelChanged, true);
    assert.equal(child.firstFive.complete, true);
    assert.equal(child.followingFive.totals.input, 515);
    assert.equal(child.firstTen.totals.historyCalls, 10);
    assert.equal(child.firstTen.totals.readCalls, 10);
    assert.equal(record.outcome, "unreviewed");
    assert.doesNotMatch(readFileSync(file, "utf8"), /PRIVATE_BODY|PRIVATE_PATH/);
    assert.deepEqual(db.prepare("SELECT * FROM session_message ORDER BY id").all(), before);
    insert.run("unrelated", "ses_other", "user", Date.now(), JSON.stringify({ text: "Discuss ses_parent without a continuation marker" }));
    measureHandoff("ses_other", "idle", options);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).children.length, 1);
    measureHandoff("ses_parent", "handoff", options);
    const fallback = readdirSync(directory).filter(name => name.startsWith("handoff-")).map(name => JSON.parse(readFileSync(join(directory, name), "utf8"))).find(item => !item.structured);
    assert.equal(fallback.staleMessages, null);
    assert.equal(fallback.modelContextLimit, null);
    assert.doesNotThrow(() => measureHandoff("ses_child", "idle", { ...options, dbPath: join(root, "missing.db") }));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("subscribes only to idle observations and aborts on plugin cleanup", async () => {
  let signal: AbortSignal | undefined;
  let consumed = false;
  const cleanup = await server.setup({
    session: { async hook() {} }, tool: { async transform() {} },
    event: { async *subscribe(options: any) {
      assert.deepEqual(options.types, ["session.idle"]);
      signal = options.signal;
      consumed = true;
    } },
  } as any);
  assert.equal(consumed, true);
  assert.equal(signal?.aborted, false);
  (cleanup as () => void)();
  assert.equal(signal?.aborted, true);
});
