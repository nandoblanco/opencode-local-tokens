import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handoffDirectory } from "./handoff.ts";
import { resolveDefaultDbPath } from "./tokens.ts";

type Options = { dbPath?: string; memoryDir?: string };
type Request = { messageId: string; timeCreated: number; model: string | null; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; context: number; historyCalls: number; readCalls: number };

function requests(db: DatabaseSync, sessionId: string, before?: number): Request[] {
  const rows = db.prepare("SELECT id, time_created, data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY time_created ASC, id ASC").all(sessionId) as Array<{ id: string; time_created: number; data: string }>;
  const result: Request[] = [];
  for (const row of rows) {
    if (before !== undefined && row.time_created > before) continue;
    const data = JSON.parse(row.data);
    const t = data.tokens;
    if (!t || !(t.input + t.output + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) > 0)) continue;
    const tools = (data.content ?? []).filter((part: any) => part.type === "tool");
    const input = t.input ?? 0, cacheRead = t.cache?.read ?? 0, cacheWrite = t.cache?.write ?? 0;
    result.push({ messageId: row.id, timeCreated: row.time_created, model: data.model ? `${data.model.providerID}/${data.model.id}` : null,
      input, output: t.output ?? 0, reasoning: t.reasoning ?? 0, cacheRead, cacheWrite, context: input + cacheRead + cacheWrite,
      historyCalls: tools.filter((part: any) => part.name === "handoff_history").length,
      readCalls: tools.filter((part: any) => part.name === "read").length });
  }
  return result;
}

function windowSummary(items: Request[], size: number) {
  return { requested: size, observed: items.length, complete: items.length === size,
    totals: Object.fromEntries(["input", "output", "reasoning", "cacheRead", "cacheWrite", "historyCalls", "readCalls"].map(key => [key, items.reduce((sum, item) => sum + Number(item[key as keyof Request]), 0)])) };
}

// Measurement errors must never prevent checkpoint saving, handoff creation, or normal execution.
export function measureHandoff(sessionId: string, phase: "checkpoint" | "handoff" | "idle", options: Options = {}, metadata: { messageCount?: number; checkpointSavedAt?: string; staleMessages?: number; modelContextLimit?: number } = {}) {
  let db: DatabaseSync | undefined;
  try {
    const directory = join(handoffDirectory(options.memoryDir), "measurements");
    if (phase === "idle" && !existsSync(directory)) return;
    db = new DatabaseSync(resolveDefaultDbPath(options.dbPath), { readOnly: true });
    const now = Date.now();
    if (phase !== "idle") {
      mkdirSync(directory, { recursive: true });
      const previous = requests(db, sessionId, now);
      const checkpointPath = join(directory, `checkpoint-${encodeURIComponent(sessionId)}.json`);
      if (phase === "checkpoint") {
        writeFileSync(checkpointPath, JSON.stringify({ schemaVersion: 1, sessionId, observedAt: now, messageCount: metadata.messageCount, baseline: previous.slice(-5) }, null, 2));
        return;
      }
      const checkpoint = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) : null;
      const id = randomUUID();
      writeFileSync(join(directory, `handoff-${id}.json`), JSON.stringify({ schemaVersion: 1, id, sessionId, savedAt: now,
        structured: Boolean(metadata.checkpointSavedAt), checkpointSavedAt: metadata.checkpointSavedAt ?? null, staleMessages: metadata.staleMessages ?? null,
        modelContextLimit: metadata.modelContextLimit || null, lastRequest: previous.at(-1) ?? null,
        checkpointObservation: checkpoint, beforeSave: previous.slice(-5),
        afterCheckpointSave: checkpoint ? previous.filter(item => item.timeCreated > checkpoint.observedAt) : null,
        children: [], outcome: "unreviewed" }, null, 2));
      return;
    }
    const first = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY time_created ASC, id ASC LIMIT 1").get(sessionId) as { data: string } | undefined;
    const parent = first && JSON.parse(first.data).text?.match(/^Continuing from previous session `(ses_[^`\r\n]+)`/)?.[1];
    if (!parent || parent === sessionId) return;
    const childRequests = requests(db, sessionId).slice(0, 10);
    for (const file of readdirSync(directory).filter(name => name.startsWith("handoff-"))) {
      const path = join(directory, file);
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record.sessionId !== parent) continue;
      const firstUser = db.prepare("SELECT time_created FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY time_created ASC, id ASC LIMIT 1").get(sessionId) as { time_created: number };
      if (firstUser.time_created < record.savedAt) continue;
      // A marker does not identify a particular save when the parent was exported repeatedly.
      const child = { sessionId, observedAt: now, linkEvidence: "first-user-continuation-marker", saveAttribution: "candidate-only",
        firstRequest: childRequests[0] ?? null,
        modelChanged: childRequests[0]?.model && record.lastRequest?.model ? childRequests[0].model !== record.lastRequest.model : null,
        requests: childRequests, firstFive: windowSummary(childRequests.slice(0, 5), 5),
        followingFive: windowSummary(childRequests.slice(1, 6), 5), firstTen: windowSummary(childRequests, 10) };
      const index = record.children.findIndex((item: any) => item.sessionId === sessionId);
      if (index >= 0) record.children[index] = child;
      else record.children.push(child);
      writeFileSync(path, JSON.stringify(record, null, 2));
    }
  } catch (error) {
    console.warn("[opencode-local-tokens] Measurement unavailable:", error instanceof Error ? error.name : "unknown error");
  } finally {
    db?.close();
  }
}
