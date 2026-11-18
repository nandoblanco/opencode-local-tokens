import type { JsonSchema } from "@opencode/plugin/rpc";
import type { TokenSummary } from "./summary.ts";
import type {
  MatchedSessionRow,
  ModelTokenCounters,
  SessionHandoffResult,
  SessionStepStatus,
  SidecarSessionEntry,
  TagTokenStats,
  TokenCounters,
  TokensReport,
} from "./tokens.ts";
export type {
  MatchedSessionRow,
  ModelTokenCounters,
  SessionHandoffResult,
  SessionStepStatus,
  SidecarSessionEntry,
  TagTokenStats,
  TokenCounters,
  TokensReport,
};
export interface UsageSessionStatusInput {
  sessionId?: string;
  warnThreshold?: number;
  limit?: number;
}

export interface UsageCreateHandoffInput {
  sessionId?: string;
  note?: string;
}

export interface UsageCreateHandoffOutput {
  ok: boolean;
  handoff?: SessionHandoffResult;
  error?: string;
}

export interface UsageTokensInput {
  rawInput?: string;
  query?: string;
  project?: string;
  model?: string;
  tag?: string;
  likedOnly?: boolean;
  limit?: number;
}

export interface UsageMutateSessionInput {
  action: "like" | "unlike" | "tag" | "untag" | "note";
  sessionPrefix: string;
  value?: string;
}

export interface UsageMutateSessionOutput {
  ok: boolean;
  sessionId?: string;
  entry?: SidecarSessionEntry;
  error?: string;
}

export function parseInlineTokensFilter(raw: string): {
  query: string;
  project: string;
  model: string;
  tag: string;
  likedOnly: boolean;
} {
  let project = "";
  let model = "";
  let tag = "";
  let likedOnly = false;
  const freeTerms: string[] = [];

  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (lower.startsWith("project:") || lower.startsWith("p:")) {
      project = tok.slice(tok.indexOf(":") + 1);
    } else if (lower.startsWith("model:") || lower.startsWith("m:")) {
      model = tok.slice(tok.indexOf(":") + 1);
    } else if (lower.startsWith("tag:") || lower.startsWith("t:") || lower.startsWith("#")) {
      tag = tok.startsWith("#") ? tok.slice(1) : tok.slice(tok.indexOf(":") + 1);
    } else if (lower === "liked:true" || lower === "liked" || lower === "*") {
      likedOnly = true;
    } else {
      freeTerms.push(tok);
    }
  }
  return {
    query: freeTerms.join(" "),
    project,
    model,
    tag,
    likedOnly,
  };
}

const anyObjectSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: true,
};

const tokensInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    rawInput: { type: "string" },
    query: { type: "string" },
    project: { type: "string" },
    model: { type: "string" },
    tag: { type: "string" },
    likedOnly: { type: "boolean" },
    limit: { type: "number" },
  },
  additionalProperties: false,
} as unknown as JsonSchema.JsonSchema<UsageTokensInput>;

const mutateSessionInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    action: { type: "string", enum: ["like", "unlike", "tag", "untag", "note"] },
    sessionPrefix: { type: "string" },
    value: { type: "string" },
  },
  required: ["action", "sessionPrefix"],
  additionalProperties: false,
} as unknown as JsonSchema.JsonSchema<UsageMutateSessionInput>;

const sessionStatusInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    sessionId: { type: "string" },
    warnThreshold: { type: "number" },
    limit: { type: "number" },
  },
  additionalProperties: false,
} as unknown as JsonSchema.JsonSchema<UsageSessionStatusInput>;

const createHandoffInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    sessionId: { type: "string" },
    note: { type: "string" },
  },
  additionalProperties: false,
} as unknown as JsonSchema.JsonSchema<UsageCreateHandoffInput>;

export const TokensRpc = {
  id: "opencode-local-tokens",
  methods: {
    summary: {
      input: anyObjectSchema as unknown as JsonSchema.JsonSchema<Record<string, never>>,
      output: anyObjectSchema as unknown as JsonSchema.JsonSchema<{ local30d: TokenSummary; localAllTime: TokenSummary }>,
    },
    tokens: {
      input: tokensInputSchema,
      output: anyObjectSchema as unknown as JsonSchema.JsonSchema<TokensReport>,
    },
    mutateSession: {
      input: mutateSessionInputSchema,
      output: anyObjectSchema as unknown as JsonSchema.JsonSchema<UsageMutateSessionOutput>,
    },
    sessionStatus: {
      input: sessionStatusInputSchema,
      output: anyObjectSchema as unknown as JsonSchema.JsonSchema<SessionStepStatus | null>,
    },
    createHandoff: {
      input: createHandoffInputSchema,
      output: anyObjectSchema as unknown as JsonSchema.JsonSchema<UsageCreateHandoffOutput>,
    },
  },
  events: {},
} as const;
