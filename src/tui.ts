import type { TuiPluginContext } from "@opencode/plugin/tui";
import { prepareHandoff } from "./prepare-handoff.ts";
import { RGBA } from "@opentui/core";
import {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  setProp,
  use,
} from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  analyzeTokens,
  billedTokens,
  buildSessionHandoff,
  CACHE_EXPIRING_IDLE_MS,
  CACHE_HEAVY_CONTEXT_TOKENS,
  CACHE_TTL_MS,
  fmtNum,
  getSessionStepStatus,
  type MatchedSessionRow,
  mutateSessionTag,
  prewarmTokensCache,
  type SessionStepStatus,
  STEP_LIMIT_THRESHOLD,
  STEP_WARNING_THRESHOLD,
  totalTokensWithCache,
  TOKEN_SORT_LABELS,
  TOKEN_SORT_MODES,
  type TokenSortMode,
} from "./tokens.ts";

function fmtDurationShort(ms: number): string {
  if (!ms || ms <= 0) return "0s";
  if (ms < 60_000) return `${Math.max(1, Math.ceil(ms / 1000))}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return s > 0 && m < 10 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function el(tag: string, props: Record<string, any> | null, ...children: any[]) {
  const node = createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      if (k === "ref") {
        use(props.ref, node);
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(props, k);
      if (desc?.get) {
        effect(() => setProp(node, k, desc.get!()));
      } else if (typeof props[k] === "function" && !k.startsWith("on") && k !== "renderBefore") {
        effect(() => setProp(node, k, props[k]()));
      } else {
        setProp(node, k, props[k]);
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "function") {
      insert(node, child);
    } else if (typeof child === "string" || typeof child === "number") {
      insertNode(node, createTextNode(String(child)));
    } else {
      insertNode(node, child);
    }
  }
  return node;
}

let activeContext: TuiPluginContext | null = null;

const FALLBACK_C = {
  bg: RGBA.fromInts(16, 20, 28, 255),
  cardBg: RGBA.fromInts(23, 29, 40, 255),
  cardAlt: RGBA.fromInts(20, 25, 35, 255),
  selectedBg: RGBA.fromInts(32, 46, 68, 255),
  border: RGBA.fromInts(46, 58, 78, 255),
  accent: RGBA.fromInts(88, 166, 255, 255),
  good: RGBA.fromInts(63, 185, 80, 255),
  warn: RGBA.fromInts(210, 153, 34, 255),
  bad: RGBA.fromInts(248, 81, 73, 255),
  text: RGBA.fromInts(230, 237, 243, 255),
  muted: RGBA.fromInts(139, 148, 158, 255),
  dim: RGBA.fromInts(88, 96, 105, 255),
};

function dialogSurface(): any {
  try {
    return activeContext?.theme?.surface("dialog");
  } catch {
    return undefined;
  }
}

const C = {
  bg: () => dialogSurface()?.background?.base ?? FALLBACK_C.bg,
  cardBg: () =>
    dialogSurface()?.background?.raised?.base ??
    dialogSurface()?.background?.base ??
    FALLBACK_C.cardBg,
  cardAlt: () =>
    dialogSurface()?.background?.raised?.base ??
    dialogSurface()?.background?.base ??
    FALLBACK_C.cardAlt,
  selectedBg: () =>
    dialogSurface()?.background?.action?.primary?.focused ?? FALLBACK_C.selectedBg,
  selectedText: () =>
    dialogSurface()?.text?.action?.primary?.focused ??
    dialogSurface()?.text?.base ??
    FALLBACK_C.accent,
  border: () => dialogSurface()?.border?.base ?? FALLBACK_C.border,
  accent: () => dialogSurface()?.text?.action?.primary?.base ?? FALLBACK_C.accent,
  cyan: () => dialogSurface()?.text?.action?.primary?.base ?? FALLBACK_C.accent,
  purple: () => dialogSurface()?.text?.action?.primary?.base ?? FALLBACK_C.accent,
  good: () => dialogSurface()?.text?.feedback?.success?.base ?? FALLBACK_C.good,
  warn: () => dialogSurface()?.text?.feedback?.warning?.base ?? FALLBACK_C.warn,
  bad: () => dialogSurface()?.text?.feedback?.error?.base ?? FALLBACK_C.bad,
  text: () => dialogSurface()?.text?.base ?? FALLBACK_C.text,
  muted: () => dialogSurface()?.text?.muted ?? FALLBACK_C.muted,
  dim: () => dialogSurface()?.text?.subtle ?? dialogSurface()?.text?.muted ?? FALLBACK_C.dim,
};

function statusColor(s: "good" | "warn" | "bad" | "neutral") {
  if (s === "good") return C.good;
  if (s === "warn") return C.warn;
  if (s === "bad") return C.bad;
  return C.accent;
}

function renderBar(pct: number, width = 18): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(100, pct));
  const fillCount = Math.round((clamped / 100) * width);
  return {
    filled: "█".repeat(fillCount),
    empty: "░".repeat(Math.max(0, width - fillCount)),
  };
}

function fmtCompact(n: number) { return fmtNum(n); }
const [sharedStepStatus, setSharedStepStatus] = createSignal<SessionStepStatus | null>(null);
const warnedSessions = new Set<string>();
const promptedOverLimitTurnKeys = new Set<string>();

function getActiveTuiSessionId(context: TuiPluginContext): string | undefined {
  try {
    const route = context.ui.router.current();
    if (route && route.type === "session" && typeof route.sessionID === "string") {
      return route.sessionID;
    }
  } catch {}
  return undefined;
}

async function runTuiSessionHandoff(context: TuiPluginContext, explicitSessionId?: string) {
  const sid = explicitSessionId || getActiveTuiSessionId(context);
  if (!sid) return;
  try {
    context.ui.toast.show({ title: "Preparing handoff with AI", message: "Saving a fresh checkpoint before export. This uses model tokens.", variant: "info", duration: 6000 });
    await prepareHandoff(sid, context.client.session);
  } catch (error) {
    context.ui.toast.show({ title: "Handoff preparation failed", message: String(error), variant: "warning", duration: 6000 });
    return;
  }
  const handoff = buildSessionHandoff(sid);
  if (!handoff) {
    context.ui.toast.show({
      title: "Handoff unavailable",
      message: "No active session found to generate a handoff.",
      variant: "warning",
      duration: 4000,
    });
    return;
  }

  context.ui.toast.show({
    title: "Handoff checkpoint saved",
    message: `Saved ${handoff.shortId} (${handoff.count} steps) → ${handoff.checkpointPath}`,
    variant: "success",
    duration: 6000,
  });

  try {
    const created: any = await (context.client as any).session.create({
      directory: handoff.directory || undefined,
      title: `Handoff: ${handoff.title}`.slice(0, 80),
    });
    const newId = created?.id || created?.data?.id;
    if (newId) {
      context.ui.router.navigate({ type: "session", sessionID: newId });
      try {
        await (context.client as any).session.prompt({
          sessionID: newId,
          text: handoff.handoffPrompt,
        });
      } catch {}
    }
  } catch {}
}

async function checkSessionStepAlerts(context: TuiPluginContext, explicitSessionId?: string) {
  const sid = explicitSessionId || getActiveTuiSessionId(context);
  if (!sid) {
    setSharedStepStatus(null);
    return;
  }
  let st = getSessionStepStatus(sid);
  if (st) {
    try {
      const models = await context.client.model.list({ location: { directory: st.directory } });
      const capacities = Object.fromEntries(models.data.map(model => [`${model.providerID}/${model.id}`, model.limit.context]));
      st = getSessionStepStatus(sid, { modelCapacities: capacities });
    } catch {}
  }
  setSharedStepStatus(st);
}

function SessionStepComposerBanner(props: { context: TuiPluginContext; sessionID: string }) {
  const [tuiNow, setTuiNow] = createSignal(Date.now());

  onMount(() => {
    checkSessionStepAlerts(props.context, props.sessionID);
    const timer = setInterval(() => {
      checkSessionStepAlerts(props.context, props.sessionID);
    }, 2500);
    const clock = setInterval(() => {
      setTuiNow(Date.now());
    }, 1000);
    onCleanup(() => {
      clearInterval(timer);
      clearInterval(clock);
    });
  });

  const info = createMemo(() => {
    const st = sharedStepStatus();
    if (!st || st.sessionId !== props.sessionID) return null;
    if ((st.liveContextTokens ?? 0) < CACHE_HEAVY_CONTEXT_TOKENS) return null;
    try {
      if (props.context.data.session.status(st.sessionId) === "running") return null;
    } catch {}
    const refTime = st.lastReplyAt || st.timeUpdated || 0;
    if (refTime <= 0) return null;
    const ttlMs = st.cacheTtlMs || CACHE_TTL_MS;
    const idleMs = Math.max(st.idleMs ?? 0, tuiNow() - refTime);
    if (idleMs < CACHE_EXPIRING_IDLE_MS) return null;
    const remMs = Math.max(0, ttlMs - idleMs);
    const state: "expiring" | "expired" = idleMs >= ttlMs ? "expired" : "expiring";
    return { st, idleMs, remMs, state };
  });

  return createComponent(Show, {
    get when() {
      return info();
    },
    children: (item: () => { st: SessionStepStatus; idleMs: number; remMs: number; state: "expiring" | "expired" }) =>
      el(
        "box",
        {
          flexDirection: "row",
          justifyContent: "space-between",
          paddingLeft: 1,
          paddingRight: 1,
          width: "100%",
          get backgroundColor() {
            return C.cardBg();
          },
          border: true,
          get borderColor() {
            return item().state === "expired" ? C.bad() : C.warn();
          },
        },
        el(
          "text",
          {
            get fg() {
              return item().state === "expired" ? C.bad() : C.warn();
            },
          },
          () =>
            item().state === "expired"
              ? `Prompt cache likely expired (idle ${fmtDurationShort(item().idleMs)} · ${item().st.statusReason}). Reply re-sends ${fmtNum(item().st.liveContextTokens)} uncached; consider /handoff.`
              : `Prompt cache expiring (${fmtDurationShort(item().remMs)} left · ${item().st.statusReason}). Reply soon or run /handoff.`
        ),
        el("text", { fg: C.cyan }, "[/handoff]")
      ),
  });
}
function parseInlineTokensFilter(raw: string): {
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

function TokensDialog(props: {
  context: TuiPluginContext;
  initialInput?: string;
  onClose: () => void;
}) {
  activeContext = props.context;
  const [input, setInput] = createSignal(props.initialInput || "");
  const [debouncedInput, setDebouncedInput] = createSignal(props.initialInput || "");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [sortMode, setSortMode] = createSignal<TokenSortMode>("relevance");
  const [editing, setEditing] = createSignal<"sort" | "tag" | "untag" | null>(null);
  const [sortIndex, setSortIndex] = createSignal(0);
  const [tagInput, setTagInput] = createSignal("");
  const [tagSession, setTagSession] = createSignal<MatchedSessionRow | null>(null);
  const [feedback, setFeedback] = createSignal("");
  const [actionError, setActionError] = createSignal(false);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    const val = input();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!val) {
      setDebouncedInput("");
      return;
    }
    debounceTimer = setTimeout(() => {
      setDebouncedInput(val);
    }, 35);
  });

  const report = createMemo(() => {
    refreshTick();
    const parsed = parseInlineTokensFilter(debouncedInput());
    try {
      return analyzeTokens({
        query: parsed.query,
        project: parsed.project,
        model: parsed.model,
        tag: parsed.tag,
        likedOnly: parsed.likedOnly,
        sort: sortMode(),
        limit: 14,
      });
    } catch {
      return null;
    }
  });

  createEffect(() => {
    debouncedInput();
    sortMode();
    setSelectedIndex(0);
  });

  onMount(() => {
    setTimeout(() => {
      try {
        prewarmTokensCache();
      } catch {}
    }, 10);
    const keyInput = props.context.renderer.keyInput as any;
    const handler = (key: any) => {
      const rows = report()?.sessions || [];
      const enter = key.name === "return" || key.name === "enter" || key.name === "kpenter";
      if (editing()) {
        key.preventDefault?.();
        key.stopPropagation?.();
        if (key.name === "escape") {
          setEditing(null);
        } else if (editing() === "sort") {
          if (key.name === "down") setSortIndex((i) => (i + 1) % TOKEN_SORT_MODES.length);
          else if (key.name === "up") setSortIndex((i) => (i + TOKEN_SORT_MODES.length - 1) % TOKEN_SORT_MODES.length);
          else if (enter) {
            setSortMode(TOKEN_SORT_MODES[sortIndex()]);
            setEditing(null);
          }
        } else if (enter) {
          const session = tagSession();
          const value = tagInput().split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean).join(",");
          if (!value) {
            setActionError(true);
            setFeedback("Enter at least one tag. Separate multiple tags with commas.");
          } else if (session) {
            try {
              mutateSessionTag(editing() as "tag" | "untag", session.id, value);
              setFeedback(`${editing() === "tag" ? "Added" : "Removed"} tags: ${value}`);
              setActionError(false);
              setEditing(null);
              setRefreshTick((t) => t + 1);
              setSelectedIndex((i) => Math.max(0, Math.min(i, (report()?.sessions.length || 1) - 1)));
            } catch (error) {
              setActionError(true);
              setFeedback(`Tags not saved: ${String(error)}`);
            }
          }
        } else if (key.ctrl && key.name === "u") {
          setTagInput("");
          setFeedback("");
        } else if (key.name === "backspace") {
          setTagInput((value) => Array.from(value).slice(0, -1).join(""));
          setFeedback("");
        } else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && key.sequence.charCodeAt(0) >= 32) {
          setTagInput((value) => value + key.sequence);
          setFeedback("");
        }
        return;
      }
      if (key.ctrl && (key.name === "s" || key.name === "t" || key.name === "r")) {
        key.preventDefault?.();
        key.stopPropagation?.();
        setFeedback("");
        setActionError(false);
        if (key.name === "s") {
          setSortIndex(TOKEN_SORT_MODES.indexOf(sortMode()));
          setEditing("sort");
        } else {
          const picked = rows[selectedIndex()];
          if (picked) {
            setTagSession(picked);
            setTagInput("");
            setEditing(key.name === "t" ? "tag" : "untag");
          }
        }
        return;
      }
      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        key.preventDefault?.();
        key.stopPropagation?.();
        if (rows.length > 0) setSelectedIndex((i) => Math.min(rows.length - 1, i + 1));
      } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
        key.preventDefault?.();
        key.stopPropagation?.();
        if (rows.length > 0) setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (key.name === "return" || key.name === "enter" || key.name === "kpenter") {
        const picked = rows[selectedIndex()];
        if (picked) {
          key.preventDefault?.();
          key.stopPropagation?.();
          props.onClose();
          props.context.ui.router.navigate({
            type: "session",
            sessionID: picked.id,
          });
        }
      } else if (key.ctrl && key.name === "l") {
        const picked = rows[selectedIndex()];
        if (picked) {
          key.preventDefault?.();
          key.stopPropagation?.();
          try {
            mutateSessionTag(picked.liked ? "unlike" : "like", picked.id);
            setRefreshTick((t) => t + 1);
          } catch {}
        }
      } else if (key.ctrl && key.name === "u") {
        key.preventDefault?.();
        key.stopPropagation?.();
        setInput("");
      } else if (key.name === "backspace") {
        key.preventDefault?.();
        key.stopPropagation?.();
        setInput((prev) => prev.slice(0, -1));
      } else if (
        key.sequence &&
        key.sequence.length === 1 &&
        !key.ctrl &&
        !key.meta &&
        key.sequence.charCodeAt(0) >= 32
      ) {
        key.preventDefault?.();
        key.stopPropagation?.();
        setInput((prev) => prev + key.sequence);
      }
    };
    if (typeof keyInput.prependListener === "function") {
      keyInput.prependListener("keypress", handler);
    } else {
      keyInput.on?.("keypress", handler);
    }
    onCleanup(() => {
      if (typeof keyInput.removeListener === "function") {
        keyInput.removeListener("keypress", handler);
      } else {
        keyInput.off?.("keypress", handler);
      }
    });
  });

  return el(
    "box",
    {
      flexDirection: "column",
      width: "100%",
      backgroundColor: C.bg,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      gap: 1,
    },
    el(
      "box",
      {
        flexDirection: "column",
        justifyContent: "space-between",
        border: ["bottom"],
        borderColor: C.border,
        paddingBottom: 1,
      },
      el("text", { fg: C.accent }, "opencode / tokens"),
      el(
        "text",
        { fg: C.muted },
        "[↑↓] select  [Enter] open  [Ctrl+L] like  [Ctrl+U] clear  [Esc] close"
      )
    ),
    el(
      "box",
      {
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: C.cardBg,
        border: true,
        borderColor: C.accent,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 0,
        paddingBottom: 0,
      },
      el(
      "box",
        {
          flexDirection: "row",
          gap: 1,
          width: "100%",
        },
        el("text", { fg: C.cyan }, "Filter:"),
        el(
          "text",
          {
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            wrapMode: "none",
            truncate: true,
            get fg() {
              return input() ? C.text() : C.dim();
            },
          },
          () =>
            input()
              ? `${input()}█`
              : "Search or filter..."
        )
      ),
      el(
        "text",
        { fg: C.muted },
        () => `Sort: ${TOKEN_SORT_LABELS[sortMode()]}  [Ctrl+S] sort  [Ctrl+T] add tags  [Ctrl+R] remove tags`
      ),
      el(
        "box",
        { flexDirection: "row" },
        createComponent(Show, {
          get when() {
            return report();
          },
          children: (r: () => NonNullable<ReturnType<typeof report>>) =>
            el(
              "text",
              { fg: C.good },
              () =>
                `${r().totalSessionsMatched} sessions · ${r().totals.turns.toLocaleString()} steps · Billed: ${fmtNum(
                  billedTokens(r().totals)
                )} · w/Cache: ${fmtNum(totalTokensWithCache(r().totals))}`
            ),
        })
      )
    ),
    createComponent(Show, {
      get when() { return editing(); },
      children: () => el(
        "box",
        { flexDirection: "column", border: true, borderColor: C.accent, paddingLeft: 1, paddingRight: 1 },
        createComponent(Show, {
          get when() { return editing() === "sort"; },
          get fallback() {
            return el(
              "box",
              { flexDirection: "column" },
              el("text", { fg: C.accent, wrapMode: "none", truncate: true }, () => `${editing() === "tag" ? "Add" : "Remove"} tags: ${tagSession()?.smartTitle}`),
              el("text", { fg: C.muted }, () => `Current: ${tagSession()?.tags.map((tag) => `#${tag}`).join(", ") || "none"}`),
              el("text", { fg: C.text, wrapMode: "none", truncate: true }, () => `${tagInput() || "Comma-separated tags"}█`),
              el("text", { fg: C.muted }, "[Enter] save  [Esc] cancel  [Ctrl+U] clear")
            );
          },
          children: () => el(
            "box",
            { flexDirection: "column" },
            el("text", { fg: C.accent }, "Sort sessions  [↑↓] choose  [Enter] apply  [Esc] cancel"),
            ...TOKEN_SORT_MODES.map((mode, index) => el(
              "text",
              { get fg() { return index === sortIndex() ? C.accent() : C.muted(); } },
              () => `${index === sortIndex() ? "> " : "  "}${TOKEN_SORT_LABELS[mode]}${mode === sortMode() ? " (active)" : ""}`
            ))
          ),
        })
      ),
    }),
    createComponent(Show, {
      get when() { return feedback(); },
      children: () => el("text", { get fg() { return actionError() ? C.bad() : C.good(); } }, feedback),
    }),
    el(
      "box",
      { flexDirection: "column", width: "100%" },
      createComponent(Show, {
        get when() {
          return report();
        },
        children: (r: () => NonNullable<ReturnType<typeof report>>) =>
          el(
            "box",
            {
              flexDirection: "row",
              gap: 2,
              width: "100%",
            },
            el(
              "box",
              {
                flexDirection: "column",
                flexGrow: 1,
                flexBasis: 0,
                backgroundColor: C.cardAlt,
                border: true,
                borderColor: C.border,
                paddingLeft: 2,
                paddingRight: 2,
                paddingTop: 1,
                paddingBottom: 1,
              },
              el("text", { fg: C.purple }, "TOP MODELS (MATCHED SCOPE)"),
              createComponent(For, {
                get each() {
                  return r().sortedModels.slice(0, 5);
                },
                children: ([m, v]: [string, any]) => {
                  const grand = billedTokens(r().totals) || 1;
                  const pct = Math.round((v.total / grand) * 100);
                  return el(
                    "box",
                    {
                      flexDirection: "row",
                      justifyContent: "space-between",
                    },
                    el("text", { fg: C.text }, m.slice(0, 32)),
                    el("text", { fg: C.cyan }, `${fmtNum(v.total)} (${pct}%) · ${v.turns} steps`)
                  );
                },
              })
            ),
            el(
              "box",
              {
                flexDirection: "column",
                flexGrow: 1,
                flexBasis: 0,
                backgroundColor: C.cardAlt,
                border: true,
                borderColor: C.border,
                paddingLeft: 2,
                paddingRight: 2,
                paddingTop: 1,
                paddingBottom: 1,
              },
              el("text", { fg: C.purple }, "TOP PROJECTS & TAGS"),
              createComponent(For, {
                get each() {
                  return r().sortedProjects.slice(0, 4);
                },
                children: ([proj, v]: [string, any]) =>
                  el(
                    "box",
                    {
                      flexDirection: "row",
                      justifyContent: "space-between",
                    },
                    el("text", { fg: C.text }, proj.slice(0, 24)),
                    el("text", { fg: C.good }, `${fmtNum(v.billed)} (${v.sessions} sess / ${v.turns} steps)`)
                  ),
              }),
              el("text", { fg: C.muted }, () =>
                r()
                  .topTags.slice(0, 5)
                  .map(([t, v]) => `#${t}(${v.count})`)
                  .join("  ")
              )
            )
          ),
      })
    ),
    el(
      "box",
      {
        flexDirection: "column",
        backgroundColor: C.cardBg,
        border: true,
        borderColor: C.border,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
      },
      el(
        "box",
        { flexDirection: "row", border: ["bottom"], borderColor: C.border },
        el("text", { fg: C.muted }, "   ID".padEnd(13) + "Project".padEnd(19) + "Billed".padStart(9) + "w/Cache".padStart(10) + "Steps".padStart(6) + "  Session Title & Tags")
      ),
      (() => {
        const VIEWPORT = 8;
        return el(
          "box",
          { flexDirection: "column", width: "100%" },
          createComponent(Show, {
            get when() {
              return report()?.sessions.length;
            },
            get fallback() {
              return el("text", { fg: C.dim }, "No sessions matched the current filter.");
            },
            get children() {
              const rows = report()?.sessions || [];
              const sel = selectedIndex();
              const offset = Math.max(0, Math.min(sel - (VIEWPORT - 1), Math.max(0, rows.length - VIEWPORT)));
              const visible = rows.slice(offset, offset + VIEWPORT);
              return visible.map((s: MatchedSessionRow, vIdx: number) => {
                  const absIdx = offset + vIdx;
                  const isSel = absIdx === selectedIndex();
                  const stepsStr = s.turnScoped ? `${s.turns}/${s.totalSessionTurns}` : String(s.steps || s.turns);
                  const tagsPreview = s.tags.length
                    ? ` [${s.tags
                        .slice(0, 2)
                        .map((t) => `#${t}`)
                        .join(" ")}]`
                    : "";
                  const line =
                    `${s.liked ? "★ " : isSel ? "▸ " : "  "}${s.shortId.padEnd(11)}` +
                    `${s.project.slice(0, 18).padEnd(19)}` +
                    `${fmtNum(billedTokens(s.tokens)).padStart(9)}` +
                    `${fmtNum(totalTokensWithCache(s.tokens)).padStart(10)}` +
                    `${stepsStr.padStart(6)}` +
                    `  ${s.smartTitle.slice(0, 44)}${tagsPreview}`;
                  return el(
                    "box",
                    {
                      flexDirection: "row",
                      width: "100%",
                      get backgroundColor() {
                        return isSel ? C.selectedBg() : undefined;
                      },
                      onMouseOver: () => setSelectedIndex(absIdx),
                    },
                    el(
                      "text",
                      {
                        wrapMode: "none",
                        truncate: true,
                        get fg() {
                          return isSel ? C.selectedText() : s.liked ? C.warn() : C.text();
                        },
                      },
                      line
                    )
                  );
                }).concat(
                  el(
                    "text",
                    { fg: C.dim },
                    rows.length > VIEWPORT
                      ? `  (${offset + 1}-${Math.min(offset + VIEWPORT, rows.length)} of ${rows.length})  [↑↓ scroll]`
                      : ""
                  )
                );
            },
          })
        );
      })()
    )
  );
}

export const tui = {
  id: "opencode-local-tokens",
  async setup(context: TuiPluginContext) {
    activeContext = context;
    setTimeout(() => {
      try {
        prewarmTokensCache();
      } catch {}
    }, 500);

    const openTokensDialog = (initialInput = "") => {
      context.ui.dialog.show(
        () =>
          createComponent(TokensDialog, {
            context,
            initialInput,
            onClose: () => context.ui.dialog.clear(),
          }),
        () => {}
      );
      context.ui.dialog.set({
        size: "xlarge",
        centered: true,
      });
    };
    if (context.options.cacheAlerts === true) context.ui.slot({
      before: "session.composer.top",
      render(props: { sessionID: string }) {
        return createComponent(SessionStepComposerBanner, {
          context,
          sessionID: props.sessionID,
        });
      },
    });
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            {
              id: "tokens.open",
              title: "Token & Topic Analytics Explorer (/tokens)",
              section: "System",
              slash: {
                name: "tokens",
              },
              run() {
                openTokensDialog("");
              },
            },
            {
              id: "tokens.session.handoff",
              title: "Save Session Handoff Checkpoint & Start Fresh Session (/handoff)",
              section: "System",
              slash: {
                name: "handoff",
              },
              run() {
                void runTuiSessionHandoff(context);
              },
            },
          ],
        }));
        return null;
      },
    });
  },
};

export default tui;
