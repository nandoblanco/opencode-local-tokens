import type { Plugin } from "@opencode/plugin";
import { fetchLocalTokenStats } from "./summary.ts";
import { saveHandoffState, searchHandoffHistory, type HandoffState } from "./handoff.ts";
import { measureHandoff } from "./measurement.ts";
import { prepareHandoff } from "./prepare-handoff.ts";
import {
  parseInlineTokensFilter,
  TokensRpc,
  type UsageCreateHandoffInput,
  type UsageCreateHandoffOutput,
  type UsageMutateSessionInput,
  type UsageMutateSessionOutput,
  type UsageSessionStatusInput,
  type UsageTokensInput,
} from "./rpc.ts";
import {
  analyzeTokens,
  buildSessionHandoff,
  emptyTokens,
  getSessionStepStatus,
  mutateSessionTag,
  prewarmTokensCache,
  type SessionStepStatus,
  type TokensReport,
} from "./tokens.ts";
export async function executeTokensQuery(
  input: UsageTokensInput = {}
): Promise<TokensReport> {
  const parsed =
    typeof input.rawInput === "string"
      ? parseInlineTokensFilter(input.rawInput)
      : {
          query: input.query ?? "",
          project: input.project ?? "",
          model: input.model ?? "",
          tag: input.tag ?? "",
          likedOnly: Boolean(input.likedOnly),
        };

  const limit = input.limit && input.limit > 0 ? input.limit : 80;
  try {
    const report = analyzeTokens({
      query: input.query ?? parsed.query,
      project: input.project ?? parsed.project,
      model: input.model ?? parsed.model,
      tag: input.tag ?? parsed.tag,
      likedOnly: input.likedOnly ?? parsed.likedOnly,
      limit,
    });
    return JSON.parse(JSON.stringify(report)) as TokensReport;
  } catch {
    return {
      totals: {
        ...emptyTokens(),
        sessions: 0,
        turns: 0,
        scopedSessions: 0,
      },
      sortedModels: [],
      sortedProjects: [],
      topTags: [],
      sessions: [],
      totalSessionsMatched: 0,
      filters: {
        query: parsed.query,
        model: parsed.model,
        project: parsed.project,
        tag: parsed.tag,
        likedOnly: parsed.likedOnly,
        limit,
      },
    };
  }
}

export async function executeMutateSession(
  input: UsageMutateSessionInput
): Promise<UsageMutateSessionOutput> {
  try {
    const res = mutateSessionTag(input.action, input.sessionPrefix, input.value);
    return JSON.parse(
      JSON.stringify({
        ok: true,
        sessionId: res.sessionId,
        entry: res.entry,
      })
    ) as UsageMutateSessionOutput;
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || String(err),
    };
  }
}

export async function executeSessionStatus(
  input: UsageSessionStatusInput = {},
  modelCapacities: Record<string, number> = {}
): Promise<SessionStepStatus | null> {
  try {
    const status = getSessionStepStatus(input.sessionId, {
      warnThreshold: input.warnThreshold,
      limit: input.limit,
      modelCapacities,
    });
    return status ? (JSON.parse(JSON.stringify(status)) as SessionStepStatus) : null;
  } catch {
    return null;
  }
}

export async function executeCreateHandoff(
  input: UsageCreateHandoffInput = {}
): Promise<UsageCreateHandoffOutput> {
  try {
    const handoff = buildSessionHandoff(input.sessionId, {
      note: input.note,
    });
    return JSON.parse(
      JSON.stringify({
        ok: true,
        handoff,
      })
    ) as UsageCreateHandoffOutput;
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || String(err),
    };
  }
}

function fmtCompactTok(n: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export const server: Plugin.Definition = {
  id: "opencode-local-tokens",
  async setup(ctx) {
    await ctx.session.hook("context", event => {
      event.system.push({ type: "text", text: "Before a requested session handoff, save working state with handoff_checkpoint (goal, constraints, decisions, verified evidence, unfinished work, failures, pending requests, nextStep); use handoff_history to search predecessor sessions. These tools do not authorize an automatic handoff." });
    });
    await ctx.tool.transform(editor => {
      editor.add({
        name: "handoff_checkpoint",
        description: "Save concise working state before a session handoff. Include decision reasons, evidence, unfinished work, failed approaches, pending user requests, and exact next action. No new session or automatic handoff is triggered.",
        input: {
          type: "object",
          properties: {
            goal: { type: "string" }, nextStep: { type: "string" },
            ...Object.fromEntries(["constraints", "decisions", "verified", "unfinished", "failures", "pendingUserRequests"].map(key => [key, { type: "array", items: { type: "string" } }])),
          },
          required: ["goal", "nextStep", "constraints", "decisions", "verified", "unfinished", "failures", "pendingUserRequests"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const saved = saveHandoffState(context.sessionID, input as HandoffState);
          return { content: `Working state saved for ${context.sessionID} at ${saved.savedAt}. The handoff button will include it. Refresh it if the task changes.` };
        },
      });
      editor.add({
        name: "handoff_history",
        description: "Search a previous OpenCode session and its explicitly linked predecessors. Literal phrase search returns bounded, paginated evidence including tool results and message IDs. Does not search unrelated sessions or invoke a model.",
        input: { type: "object", properties: { sessionId: { type: "string" }, query: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["sessionId", "query"], additionalProperties: false },
        async execute(input) {
          return { content: JSON.stringify(searchHandoffHistory(input as { sessionId: string; query: string; offset?: number })) };
        },
      });
    });
    const measurements = new AbortController();
    if (ctx.event) void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ["session.idle"], signal: measurements.signal })) {
          measureHandoff(event.data.sessionID, "idle");
        }
      } catch (error) {
        if (!measurements.signal.aborted) console.warn("[opencode-local-tokens] Measurement subscription unavailable.");
      }
    })();
    setTimeout(() => {
      try {
        prewarmTokensCache();
      } catch {}
    }, 500);

    if (ctx?.rpc?.register) {
      await ctx.rpc.register(TokensRpc, {
        async summary() {
          return fetchLocalTokenStats();
        },
        async tokens(input) {
          return executeTokensQuery(input);
        },
        async mutateSession(input) {
          return executeMutateSession(input);
        },
        async sessionStatus(input) {
          const status = await executeSessionStatus(input);
          if (!status) return null;
          try {
            const models = await ctx.model.list({ location: { directory: status.directory } });
            const capacities = Object.fromEntries(models.data.map(model => [`${model.providerID}/${model.id}`, model.limit.context]));
            return executeSessionStatus(input, capacities);
          } catch {
            return status;
          }
        },
        async createHandoff(input) {
          const status = getSessionStepStatus(input.sessionId);
          if (!status) return { ok: false, error: "No active session found to prepare a handoff." };
          try {
            await prepareHandoff(status.sessionId, ctx.session);
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          return executeCreateHandoff({ ...input, sessionId: status.sessionId });
        },
      });
    }

    return () => measurements.abort();
  },
};

export default server;
