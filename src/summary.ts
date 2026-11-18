import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { discoverExternalCliSessions, extractExternalSessionDetails, extractSessionDetails, loadSidecar, resolveDefaultDbPath, saveSidecar } from "./tokens.ts";
export interface TokenModelRow {
  model: string;
  turns: number;
  billed: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
}
export interface TokenSummary { sessions: number; turns: number; billed: number; withCache: number; models: TokenModelRow[]; }
export function fetchLocalTokenStats(
  dbPath?: string,
  extOptions?: { claudeDir?: string; codexDir?: string; includeExternalCli?: boolean }
): {
  local30d: TokenSummary;
  localAllTime: TokenSummary;
} {
  const resolvedDb = resolveDefaultDbPath(dbPath);
  const hasDb = existsSync(resolvedDb);
  const extRefs = discoverExternalCliSessions({
    claudeDir: extOptions?.claudeDir,
    codexDir: extOptions?.codexDir,
    includeExternalCli: extOptions?.includeExternalCli,
    dbPath,
  });

  const empty = () => ({
    sessions: 0,
    turns: 0,
    billed: 0,
    withCache: 0,
    models: [] as TokenModelRow[],
  });

  if (!hasDb && extRefs.length === 0) {
    return { local30d: empty(), localAllTime: empty() };
  }

  const db = hasDb ? new DatabaseSync(resolvedDb, { readOnly: true }) : null;
  const cutoff30d = Date.now() - 30 * 86400 * 1000;
  const useSidecar = !dbPath && !extOptions?.claudeDir && !extOptions?.codexDir;
  const sidecar = useSidecar ? loadSidecar() : { version: 2, sessions: {} };
  let sidecarDirty = false;
  let msgStmt: any = null;

  try {
    const dbSessions = db ? (db.prepare("SELECT * FROM session_v2").all() as Array<any>) : [];
    const sessions: Array<any> = [...dbSessions];
    for (const ref of extRefs) {
      sessions.push({
        id: ref.id,
        title: ref.title,
        directory: ref.directory,
        time_created: ref.time_created,
        time_updated: ref.time_updated,
        _externalRef: ref,
      });
    }

    const map30: Record<string, TokenModelRow> = {};
    const mapAll: Record<string, TokenModelRow> = {};
    let sess30 = 0;
    let sessAll = 0;
    let turns30 = 0;
    let billed30 = 0;
    let cache30 = 0;
    let turnsAll = 0;
    let billedAll = 0;
    let cacheAll = 0;

    for (const s of sessions) {
      let existing = sidecar.sessions[s.id];
      if (!existing || existing.timeUpdated !== s.time_updated || !existing.models) {
        if (s._externalRef) {
          const ext = extractExternalSessionDetails(s._externalRef);
          const srcTag = s._externalRef.source === "claude" ? "claude-code" : "codex-cli";
          existing = {
            smartTitle: existing?.smartTitle || ext.rawTitle || s.title || "CLI Session",
            project: existing?.project || "general",
            autoTags: existing?.autoTags?.length ? existing.autoTags : [srcTag],
            customTags: existing?.customTags || [],
            liked: existing?.liked || false,
            note: existing?.note || "",
            models: ext.sessionModels,
            tokens: { ...ext.sessionTokens, turns: ext.turns.length },
            timeUpdated: s.time_updated,
          };
        } else if (db) {
          if (!msgStmt) {
            msgStmt = db.prepare(
              "SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY time_created ASC"
            );
          }
          const msgs = msgStmt.all(s.id) as Array<{ type: string; time_created: number; data: string }>;
          const details = extractSessionDetails(msgs, s);
          existing = {
            smartTitle: existing?.smartTitle || s.title || "Untitled Session",
            project: existing?.project || "general",
            autoTags: existing?.autoTags || [],
            customTags: existing?.customTags || [],
            liked: existing?.liked || false,
            note: existing?.note || "",
            models: details.sessionModels,
            tokens: { ...details.sessionTokens, turns: details.turns.length },
            timeUpdated: s.time_updated,
          };
        }
        if (existing && useSidecar) {
          sidecar.sessions[s.id] = existing;
          sidecarDirty = true;
        }
      }

      if (!existing) continue;
      const tok = existing.tokens;
      const sBilled = (tok?.input || 0) + (tok?.output || 0) + (tok?.reasoning || 0);
      const sCache = (tok?.cacheRead || 0) + (tok?.cacheWrite || 0);
      const sTurns = tok?.turns || 0;
      if (sBilled === 0 && sCache === 0) continue;

      sessAll++;
      turnsAll += sTurns;
      billedAll += sBilled;
      cacheAll += sCache;

      const is30d = s.time_updated >= cutoff30d;
      if (is30d) {
        sess30++;
        turns30 += sTurns;
        billed30 += sBilled;
        cache30 += sCache;
      }

      for (const [modelKey, mv] of Object.entries(existing.models || {})) {
        const mBilled = (mv.input || 0) + (mv.output || 0) + (mv.reasoning || 0);
        if (!mapAll[modelKey]) {
          mapAll[modelKey] = {
            model: modelKey,
            turns: 0,
            billed: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
          };
        }
        mapAll[modelKey].turns += mv.turns || 0;
        mapAll[modelKey].billed += mBilled;
        mapAll[modelKey].input += mv.input || 0;
        mapAll[modelKey].output += mv.output || 0;
        mapAll[modelKey].reasoning += mv.reasoning || 0;
        mapAll[modelKey].cacheRead += mv.cacheRead || 0;

        if (is30d) {
          if (!map30[modelKey]) {
            map30[modelKey] = {
              model: modelKey,
              turns: 0,
              billed: 0,
              input: 0,
              output: 0,
              reasoning: 0,
              cacheRead: 0,
            };
          }
          map30[modelKey].turns += mv.turns || 0;
          map30[modelKey].billed += mBilled;
          map30[modelKey].input += mv.input || 0;
          map30[modelKey].output += mv.output || 0;
          map30[modelKey].reasoning += mv.reasoning || 0;
          map30[modelKey].cacheRead += mv.cacheRead || 0;
        }
      }
    }

    if (useSidecar && sidecarDirty) {
      saveSidecar(sidecar);
    }

    return {
      local30d: {
        sessions: sess30,
        turns: turns30,
        billed: billed30,
        withCache: billed30 + cache30,
        models: Object.values(map30)
          .sort((a, b) => b.billed - a.billed)
          .slice(0, 10),
      },
      localAllTime: {
        sessions: sessAll,
        turns: turnsAll,
        billed: billedAll,
        withCache: billedAll + cacheAll,
        models: Object.values(mapAll)
          .sort((a, b) => b.billed - a.billed)
          .slice(0, 10),
      },
    };
  } finally {
    if (db) db.close();
  }
}
