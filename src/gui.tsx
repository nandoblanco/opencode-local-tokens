import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  Slot,
  Style,
  type MenuEntry,
  type PanelTab,
  type PluginContext,
} from "@opencode/plugin/gui";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import css from "./gui.css?inline";
import {
  TokensRpc,
  type MatchedSessionRow,
  type SessionStepStatus,
  type TagTokenStats,
  type TokenCounters,
  type TokensReport,
} from "./rpc.ts";
import type { TokenSummary } from "./summary.ts";

export type TokenSortMode =
  | "billed"
  | "total"
  | "steps"
  | "updated"
  | "newest"
  | "oldest"
  | "title"
  | "relevance";

const TOKEN_SORT_LABELS: Record<TokenSortMode, string> = {
  billed: "Billed tokens",
  total: "Total w/ cache",
  steps: "Most steps",
  updated: "Recently updated",
  newest: "Newest created",
  oldest: "Oldest created",
  title: "Title (A-Z)",
  relevance: "Best match",
};

const COINS_ICON_SVG =
  '<svg data-slot="icon-svg" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" class="shrink-0" aria-hidden="true">' +
  '<ellipse cx="6.5" cy="4.25" rx="4.25" ry="1.85" stroke="currentColor" stroke-width="1.25"/>' +
  '<path d="M2.25 4.25v3.1c0 1.02 1.9 1.85 4.25 1.85s4.25-.83 4.25-1.85v-3.1" stroke="currentColor" stroke-width="1.25"/>' +
  '<path d="M2.25 7.35v3.1c0 1.02 1.9 1.85 4.25 1.85 1.05 0 2.01-.16 2.75-.43" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
  '<ellipse cx="10.75" cy="9.15" rx="3.25" ry="1.5" stroke="currentColor" stroke-width="1.25"/>' +
  '<path d="M7.5 9.15v2.7c0 .83 1.46 1.5 3.25 1.5s3.25-.67 3.25-1.5v-2.7" stroke="currentColor" stroke-width="1.25"/>' +
  "</svg>";
function fmtCompact(n: number): string {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function billedTokens(t: TokenCounters): number {
  return (t.input || 0) + (t.output || 0) + (t.reasoning || 0);
}

function totalTokensWithCache(t: TokenCounters): number {
  return billedTokens(t) + (t.cacheRead || 0) + (t.cacheWrite || 0);
}

function formatDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function resolveServerId(ctx: PluginContext): string {
  const active = ctx.sessions.current();
  if (active?.server?.id) return active.server.id;
  const list = ctx.servers.list();
  for (const id of list) {
    if (ctx.servers.get(id)?.builtin) return id;
  }
  return list[0] ?? "sidecar";
}

function getRpcClient(ctx: PluginContext) {
  const activeSession = ctx.sessions.current();
  if (activeSession?.server?.client) {
    return activeSession.server.client.rpc(TokensRpc);
  }
  const serverIds = ctx.servers?.list?.() ?? [];
  const server =
    serverIds.map((id) => ctx.servers.get(id)).find((s) => s?.builtin) ??
    serverIds.map((id) => ctx.servers.get(id)).find((s) => s?.local) ??
    serverIds.map((id) => ctx.servers.get(id)).find((s) => s !== undefined);
  const client = server?.client ?? ctx.client;
  return client.rpc(TokensRpc);
}
interface TokensSurfaceProps { ctx: PluginContext; initialTokensInput?: string; variant: "panel" | "modal"; onClose?: () => void; }
const [oltPanelTokensInput, setOltPanelTokensInput] = createSignal("");
let tokensFallbackDialog: { close(): void } | undefined;

function openTokensPanel(ctx: PluginContext, tokensInput = "") {
  setOltPanelTokensInput(tokensInput);
  const session = ctx.sessions.current();
  if (!session) {
    if (tokensFallbackDialog) return;
    const ui = ctx.ui;
    tokensFallbackDialog = ctx.dialogs.open((dialog) => {
      onCleanup(() => { tokensFallbackDialog = undefined; });
      return (
        <ui.Dialog title="Token Audit" size="x-large">
          <TokensSurface ctx={ctx} variant="modal" initialTokensInput={tokensInput} onClose={dialog.close} />
        </ui.Dialog>
      );
    });
    return;
  }
  tokensFallbackDialog?.close();
  try {
    // Always select the tab so it becomes the focused panel even if another
    // panel (search, memory, backups) is already open.
    ctx.layout.open(`${ctx.id}:tokens`, session);
  } catch {
    // Layout not ready; the auto-open effect will surface it.
  }
}
function TokensSurface(props: TokensSurfaceProps) {
  const ui = props.ctx.ui;

  const [tokensInput, setTokensInput] = createSignal(props.initialTokensInput ?? "");
  const [likedOnly, setLikedOnly] = createSignal(false);
  const [sortMode, setSortMode] = createSignal<TokenSortMode>("billed");
  const [lowerViewTab, setLowerViewTab] = createSignal<"sessions" | "tags">("sessions");
  const [selectedTagIndex, setSelectedTagIndex] = createSignal(0);
  const [newTagInput, setNewTagInput] = createSignal("");
  const [mutatingTag, setMutatingTag] = createSignal(false);
  const [report, setReport] = createSignal<TokensReport | null>(null);
  const [loadingTokens, setLoadingTokens] = createSignal(false);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [summary, setSummary] = createSignal<{ local30d: TokenSummary; localAllTime: TokenSummary }>();
  const [range, setRange] = createSignal<"local30d" | "localAllTime">("local30d");
  void getRpcClient(props.ctx).summary({}).then(setSummary).catch(error => {
    props.ctx.toast.show({ title: "Failed to load token totals", description: String(error), variant: "error" });
  });
  createEffect(() => {
    const input = oltPanelTokensInput();
    if (input) setTokensInput(input);
  });

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  async function loadTokensReport() {
    setLoadingTokens(true);
    try {
      const raw = tokensInput().trim();
      const effectiveRaw = likedOnly() && !/\bliked\b|\*/i.test(raw) ? `${raw} liked`.trim() : raw;
      const res = await getRpcClient(props.ctx).tokens({
        rawInput: effectiveRaw,
        limit: 80,
      });
      if (res && Array.isArray(res.sessions)) {
        setReport({
          ...res,
          sessions: res.sessions.map((s) => ({
            ...s,
            tags: [...(s.tags || [])],
            customTags: [...(s.customTags || [])],
          })),
        });
        setSelectedIndex((prev) =>
          Math.max(0, Math.min(prev, Math.max(0, res.sessions.length - 1)))
        );
        setSelectedTagIndex((prev) =>
          Math.max(0, Math.min(prev, Math.max(0, (res.topTags?.length ?? 1) - 1)))
        );
      }
    } catch {
      // Ignore transient errors
    } finally {
      setLoadingTokens(false);
    }
  }
  createEffect(() => {
    void tokensInput();
    void likedOnly();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void loadTokensReport();
    }, 35);
  });

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });
  const matchedSessions = createMemo<MatchedSessionRow[]>(() => {
    const rows = [...(report()?.sessions ?? [])];
    const mode = sortMode();
    rows.sort((a, b) => {
      if (mode === "billed") {
        const diff = billedTokens(b.tokens) - billedTokens(a.tokens);
        if (diff !== 0) return diff;
      } else if (mode === "total") {
        const diff = totalTokensWithCache(b.tokens) - totalTokensWithCache(a.tokens);
        if (diff !== 0) return diff;
      } else if (mode === "steps") {
        const diff = (b.steps || b.turns || 0) - (a.steps || a.turns || 0);
        if (diff !== 0) return diff;
      } else if (mode === "updated") {
        const diff = (b.timeUpdated || 0) - (a.timeUpdated || 0);
        if (diff !== 0) return diff;
      } else if (mode === "newest") {
        const diff = (b.timeCreated || b.timeUpdated || 0) - (a.timeCreated || a.timeUpdated || 0);
        if (diff !== 0) return diff;
      } else if (mode === "oldest") {
        const diff = (a.timeCreated || a.timeUpdated || 0) - (b.timeCreated || b.timeUpdated || 0);
        if (diff !== 0) return diff;
      } else if (mode === "title") {
        const cmp = (a.smartTitle || "").localeCompare(b.smartTitle || "", undefined, {
          sensitivity: "base",
        });
        if (cmp !== 0) return cmp;
      } else if (mode === "relevance") {
        const diff = (b.score || 0) - (a.score || 0);
        if (Math.abs(diff) > 0.01) return diff;
      }
      return billedTokens(b.tokens) - billedTokens(a.tokens);
    });
    return rows;
  });
  const selectedSession = createMemo<MatchedSessionRow | undefined>(
    () => matchedSessions()[selectedIndex()] ?? matchedSessions()[0]
  );

  const tagRows = createMemo<Array<{ tag: string; info: TagTokenStats }>>(() =>
    (report()?.topTags ?? []).map(([tag, info]) => ({ tag, info }))
  );
  const selectedTag = createMemo<{ tag: string; info: TagTokenStats } | undefined>(
    () => tagRows()[selectedTagIndex()] ?? tagRows()[0]
  );
  const selectedTagSessions = createMemo<MatchedSessionRow[]>(() => {
    const cur = selectedTag();
    if (!cur) return [];
    const target = cur.tag.toLowerCase();
    return matchedSessions().filter((s) =>
      (s.tags || []).some((t) => t.toLowerCase() === target)
    );
  });

  const sortMenuItems = createMemo<MenuEntry[]>(() => {
    const active = sortMode();
    const modes: TokenSortMode[] = [
      "billed",
      "total",
      "steps",
      "updated",
      "newest",
      "oldest",
      "title",
      "relevance",
    ];
    return modes.map((mode) => ({
      id: `sort-${mode}`,
      label: TOKEN_SORT_LABELS[mode],
      checked: active === mode,
      onSelect: () => {
        setSortMode(mode);
        setSelectedIndex(0);
      },
    }));
  });

  async function addSessionTag(s: MatchedSessionRow | undefined, rawTag: string) {
    const cleaned = rawTag.replace(/^#/, "").trim().toLowerCase();
    if (!s || !cleaned || mutatingTag()) return;
    setMutatingTag(true);
    try {
      const res = await getRpcClient(props.ctx).mutateSession({
        action: "tag",
        sessionPrefix: s.id,
        value: cleaned,
      });
      if (res.ok) {
        setNewTagInput("");
        await loadTokensReport();
      } else if (res.error) {
        props.ctx.toast.show({ title: "Tag failed", description: res.error, variant: "error" });
      }
    } catch (err) {
      props.ctx.toast.show({ title: "Tag failed", description: String(err), variant: "error" });
    } finally {
      setMutatingTag(false);
    }
  }

  async function removeSessionTag(s: MatchedSessionRow | undefined, tag: string) {
    if (!s || !tag || mutatingTag()) return;
    setMutatingTag(true);
    try {
      const res = await getRpcClient(props.ctx).mutateSession({
        action: "untag",
        sessionPrefix: s.id,
        value: tag,
      });
      if (res.ok) {
        await loadTokensReport();
      }
    } catch {} finally {
      setMutatingTag(false);
    }
  }

  function applyQuickTokenFilter(token: string) {
    const cur = tokensInput().trim();
    if (cur.toLowerCase().includes(token.toLowerCase())) {
      setTokensInput(
        cur
          .split(/\s+/)
          .filter((t) => t.toLowerCase() !== token.toLowerCase())
          .join(" ")
      );
    } else {
      setTokensInput(cur ? `${cur} ${token}` : token);
    }
    setSelectedIndex(0);
  }

  async function toggleLikeSession(s: MatchedSessionRow | undefined) {
    if (!s) return;
    try {
      const res = await getRpcClient(props.ctx).mutateSession({
        action: s.liked ? "unlike" : "like",
        sessionPrefix: s.id,
      });
      if (res.ok) {
        void loadTokensReport();
      }
    } catch {}
  }

  function openSession(s: MatchedSessionRow | undefined) {
    if (!s) return;
    if (s.id.startsWith("claude_") || s.id.startsWith("codex_")) {
      props.ctx.toast.show({
        title: `External CLI session (${s.shortId})`,
        variant: "info",
      });
      return;
    }
    const serverId = resolveServerId(props.ctx);
    props.ctx.tabs.open({ server: serverId, id: s.id }, { focus: true });
    props.onClose?.();
  }

  function handleKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const inInput =
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.isContentEditable;

    {
      const rows = matchedSessions();
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "n")) {
        e.preventDefault();
        if (rows.length > 0) setSelectedIndex((i) => Math.min(rows.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "p")) {
        e.preventDefault();
        if (rows.length > 0) setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        const picked = selectedSession();
        if (picked) {
          e.preventDefault();
          e.stopPropagation();
          openSession(picked);
        }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (target?.classList?.contains("olu-tag-add-input")) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (inInput) {
          if (target && "value" in target && typeof (target as HTMLInputElement).value === "string") {
            setTokensInput((target as HTMLInputElement).value);
          }
          if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
          }
          setSelectedIndex(0);
          void loadTokensReport();
          return;
        }
        const picked = selectedSession();
        if (picked) {
          openSession(picked);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void toggleLikeSession(selectedSession());
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
        e.preventDefault();
        setTokensInput("");
        setLikedOnly(false);
        return;
      }
    }
  }
  return (
    <div class={`olt-scope olu-root olu-root--${props.variant}`} onKeyDown={handleKeyDown}>
<div class="olu-top-bar"><strong>Token Audit</strong><div class="olu-segmented" role="group" aria-label="Token totals range"><button type="button" class="olu-segment" aria-pressed={range() === "local30d"} onClick={() => setRange("local30d")}>30 Days</button><button type="button" class="olu-segment" aria-pressed={range() === "localAllTime"} onClick={() => setRange("localAllTime")}>All-Time</button></div></div>
<Show when={summary()}>{data => <div class="olu-kpi-row" aria-live="polite"><div class="olu-kpi-card"><span class="olu-kpi-label">Sessions</span><span class="olu-kpi-value">{data()[range()].sessions}</span></div><div class="olu-kpi-card"><span class="olu-kpi-label">Steps</span><span class="olu-kpi-value">{data()[range()].turns}</span></div><div class="olu-kpi-card"><span class="olu-kpi-label">Billed Tokens</span><span class="olu-kpi-value">{fmtCompact(data()[range()].billed)}</span></div><div class="olu-kpi-card"><span class="olu-kpi-label">Total w/ Cache</span><span class="olu-kpi-value">{fmtCompact(data()[range()].withCache)}</span></div></div>}</Show>
        <div class="olu-tokens-layout">
          <div class="olu-filter-bar">
            <div class="olu-filter-input">
              <ui.TextInput
                autofocus
                size="small"
                type="search"
                placeholder="Search topics or filter: project:cms model:claude #playwright * ..."
                value={tokensInput()}
                onInput={(val) => {
                  const next =
                    typeof val === "string"
                      ? val
                      : (val as unknown as { currentTarget?: { value?: string } })?.currentTarget
                          ?.value ?? "";
                  setTokensInput(next);
                  setSelectedIndex(0);
                }}
              />
            </div>
            <ui.Menu
              label={`Sort: ${TOKEN_SORT_LABELS[sortMode()]}`}
              trigger="button"
              items={sortMenuItems()}
            />
            <button
              type="button"
              class={`olu-chip ${likedOnly() ? "olu-chip--active" : ""}`}
              onClick={() => setLikedOnly((v) => !v)}
            >
              <span>★ Liked</span>
            </button>
            <Show when={tokensInput().trim().length > 0 || likedOnly()}>
              <ui.Button
                variant="ghost"
                size="small"
                onClick={() => {
                  setTokensInput("");
                  setLikedOnly(false);
                }}
              >
                Clear
              </ui.Button>
            </Show>
          </div>

          <Show when={report()}>
            {(r) => (
              <div class="olu-chip-row">
                <div class="olu-chips">
                  <For each={r().sortedProjects.slice(0, 4)}>
                    {([proj, info]) => (
                      <button
                        type="button"
                        class="olu-chip"
                        onClick={() => applyQuickTokenFilter(`project:${proj}`)}
                      >
                        <span>{proj}</span>
                        <span>({fmtCompact(info.billed)})</span>
                      </button>
                    )}
                  </For>
                  <For each={r().topTags.slice(0, 5)}>
                    {([tag, info]) => (
                      <button
                        type="button"
                        class="olu-chip"
                        onClick={() => applyQuickTokenFilter(`#${tag}`)}
                      >
                        <span>#{tag}</span>
                        <span>({info.count})</span>
                      </button>
                    )}
                  </For>
                </div>
                <div class="olu-lower-tabs-right">
                  <span class="olu-updated-label">
                    {loadingTokens()
                      ? "Filtering..."
                      : `${r().totalSessionsMatched} sessions · ${r().totals.turns.toLocaleString()} steps · Billed: ${fmtCompact(
                          billedTokens(r().totals)
                        )} · w/Cache: ${fmtCompact(totalTokensWithCache(r().totals))}`}
                  </span>
                  <div class="olu-segmented" role="tablist" aria-label="Lower breakdown view">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={lowerViewTab() === "sessions"}
                      class={`olu-segment ${lowerViewTab() === "sessions" ? "olu-segment--active" : ""}`}
                      onClick={() => setLowerViewTab("sessions")}
                    >
                      Per Session ({matchedSessions().length})
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={lowerViewTab() === "tags"}
                      class={`olu-segment ${lowerViewTab() === "tags" ? "olu-segment--active" : ""}`}
                      onClick={() => setLowerViewTab("tags")}
                    >
                      Per Tag ({tagRows().length})
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Show>

          <Show
            when={lowerViewTab() === "sessions"}
            fallback={
              <div class="olu-split" data-view="per-tag">
                <div class="olu-col olu-col--list">
                  <div class="olu-scroll">
                    <Show
                      when={tagRows().length > 0}
                      fallback={<div class="olu-empty">No tags matched the current filter.</div>}
                    >
                      <div class="olu-session-list">
                        <For each={tagRows()}>
                          {(row, idx) => {
                            const sharePct = () => {
                              const grand = billedTokens(report()?.totals ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
                              if (!grand || grand <= 0) return 0;
                              return Math.min(100, Math.round((row.info.billed / grand) * 100));
                            };
                            return (
                              <button
                                type="button"
                                class={`olu-session-row ${
                                  idx() === selectedTagIndex() ? "olu-session-row--selected" : ""
                                }`}
                                onClick={() => setSelectedTagIndex(idx())}
                              >
                                <div class="olu-session-top">
                                  <div class="olu-session-title-wrap">
                                    <span class="olu-session-title">#{row.tag}</span>
                                    <span class="olu-badge">{sharePct()}%</span>
                                  </div>
                                  <span class="olu-session-billed">
                                    {fmtCompact(row.info.billed)}
                                  </span>
                                </div>
                                <div class="olu-session-sub">
                                  <span>
                                    {row.info.count} {row.info.count === 1 ? "session" : "sessions"} ·{" "}
                                    {(row.info.steps ?? 0).toLocaleString()} steps
                                  </span>
                                  <span>
                                    w/Cache {fmtCompact(row.info.total ?? row.info.billed)}
                                  </span>
                                </div>
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>

                <div class="olu-col">
                  <div class="olu-scroll">
                    <Show
                      when={selectedTag()}
                      fallback={<div class="olu-empty">Select a tag to inspect its token breakdown.</div>}
                    >
                      {(selTag) => (
                        <div class="olu-detail-pane">
                          <div class="olu-detail-header">
                            <div>
                              <h4 class="olu-detail-title">#{selTag().tag}</h4>
                              <div class="olu-detail-meta">
                                {selTag().info.count} tagged sessions · {(selTag().info.steps ?? 0).toLocaleString()} steps
                              </div>
                            </div>
                            <div class="olu-detail-actions">
                              <ui.Button
                                variant="secondary"
                                size="small"
                                onClick={() => {
                                  applyQuickTokenFilter(`#${selTag().tag}`);
                                  setLowerViewTab("sessions");
                                }}
                              >
                                Filter Per Session (#{selTag().tag})
                              </ui.Button>
                            </div>
                          </div>

                          <div class="olu-kpi-row">
                            <div class="olu-kpi-card">
                              <span class="olu-kpi-label">Billed Tokens</span>
                              <span class="olu-kpi-value">{fmtCompact(selTag().info.billed)}</span>
                            </div>
                            <div class="olu-kpi-card">
                              <span class="olu-kpi-label">Total w/ Cache</span>
                              <span class="olu-kpi-value">
                                {fmtCompact(selTag().info.total ?? selTag().info.billed)}
                              </span>
                            </div>
                            <div class="olu-kpi-card">
                              <span class="olu-kpi-label">Sessions / Steps</span>
                              <span class="olu-kpi-value">
                                {selTag().info.count} / {(selTag().info.steps ?? 0).toLocaleString()}
                              </span>
                            </div>
                            <div class="olu-kpi-card">
                              <span class="olu-kpi-label">Input / Output</span>
                              <span class="olu-kpi-value">
                                {fmtCompact(selTag().info.input ?? 0)} / {fmtCompact(selTag().info.output ?? 0)}
                              </span>
                            </div>
                          </div>

                          <div class="olu-section-card">
                            <span class="olu-section-title">
                              Sessions Tagged #{selTag().tag} ({selectedTagSessions().length})
                            </span>
                            <Show
                              when={selectedTagSessions().length > 0}
                              fallback={<div class="olu-empty">No loaded sessions for this tag.</div>}
                            >
                              <div class="olu-table-wrap">
                                <table class="olu-table">
                                  <thead>
                                    <tr>
                                      <th>Session</th>
                                      <th>Project</th>
                                      <th>Steps</th>
                                      <th>Billed</th>
                                      <th>w/Cache</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <For each={selectedTagSessions()}>
                                      {(s) => (
                                        <tr
                                          class="olu-clickable-row"
                                          onClick={() => {
                                            const idx = matchedSessions().findIndex((m) => m.id === s.id);
                                            if (idx >= 0) setSelectedIndex(idx);
                                            setLowerViewTab("sessions");
                                          }}
                                          onDblClick={() => openSession(s)}
                                        >
                                          <td class="olu-model-cell" title={s.smartTitle}>
                                            {s.smartTitle}
                                          </td>
                                          <td>{s.project}</td>
                                          <td>{s.steps || s.turns}</td>
                                          <td>{fmtCompact(billedTokens(s.tokens))}</td>
                                          <td>{fmtCompact(totalTokensWithCache(s.tokens))}</td>
                                        </tr>
                                      )}
                                    </For>
                                  </tbody>
                                </table>
                              </div>
                            </Show>
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>
                </div>
              </div>
            }
          >
          <div class="olu-split" data-view="per-session">
            <div class="olu-col olu-col--list">
              <div class="olu-scroll">
                <Show
                  when={matchedSessions().length > 0}
                  fallback={
                    <div class="olu-empty">No sessions matched the current filter.</div>
                  }
                >
                  <div class="olu-session-list">
                    <For each={matchedSessions()}>
                      {(s, idx) => (
                        <button
                          type="button"
                          class={`olu-session-row ${
                            idx() === selectedIndex() ? "olu-session-row--selected" : ""
                          }`}
                          onClick={() => setSelectedIndex(idx())}
                          onDblClick={() => openSession(s)}
                        >
                          <div class="olu-session-top">
                            <div class="olu-session-title-wrap">
                              <Show when={s.liked}>
                                <span class="olu-star">★</span>
                              </Show>
                              <span class="olu-session-title">{s.smartTitle}</span>
                            </div>
                            <span class="olu-session-billed">
                              {fmtCompact(billedTokens(s.tokens))}
                            </span>
                          </div>
                          <div class="olu-session-sub">
                            <span>
                              {s.shortId} · {s.project}
                            </span>
                            <span>
                              {s.turnScoped
                                ? `${s.turns}/${s.totalSessionTurns} turns`
                                : `${s.steps || s.turns} steps`}{" "}
                              · w/Cache {fmtCompact(totalTokensWithCache(s.tokens))}
                            </span>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>

            <div class="olu-col">
              <div class="olu-scroll">
                <Show
                  when={selectedSession()}
                  fallback={
                    <div class="olu-empty">Select a session to inspect token breakdown.</div>
                  }
                >
                  {(sel) => (
                    <div class="olu-detail-pane">
                      <div class="olu-detail-header">
                        <div>
                          <h4 class="olu-detail-title">{sel().smartTitle}</h4>
                          <div class="olu-detail-meta">
                            {sel().shortId} · {sel().project} · {formatDate(sel().timeUpdated)}
                          </div>
                        </div>
                        <div class="olu-detail-actions">
                          <ui.Button
                            variant="secondary"
                            size="small"
                            onClick={() => void toggleLikeSession(sel())}
                          >
                            {sel().liked ? "★ Liked" : "☆ Like"}
                          </ui.Button>
                          <ui.Button
                            variant="primary"
                            size="small"
                            onClick={() => openSession(sel())}
                          >
                            Open Session
                          </ui.Button>
                        </div>
                      </div>

                      <div class="olu-kpi-row">
                        <div class="olu-kpi-card">
                          <span class="olu-kpi-label">Billed Tokens</span>
                          <span class="olu-kpi-value">
                            {fmtCompact(billedTokens(sel().tokens))}
                          </span>
                        </div>
                        <div class="olu-kpi-card">
                          <span class="olu-kpi-label">Total w/ Cache</span>
                          <span class="olu-kpi-value">
                            {fmtCompact(totalTokensWithCache(sel().tokens))}
                          </span>
                        </div>
                        <div class="olu-kpi-card">
                          <span class="olu-kpi-label">Steps</span>
                          <span class="olu-kpi-value">
                            {sel().turnScoped
                              ? `${sel().turns} / ${sel().totalSessionTurns}`
                              : sel().turns}
                          </span>
                        </div>
                        <div class="olu-kpi-card">
                          <span class="olu-kpi-label">Input / Output</span>
                          <span class="olu-kpi-value">
                            {fmtCompact(sel().tokens.input)} / {fmtCompact(sel().tokens.output)}
                          </span>
                        </div>
                      </div>

                      <div class="olu-session-tags-bar">
                        <div class="olu-chips">
                          <For each={sel().tags}>
                            {(t) => (
                              <span class="olu-tag-pill">
                                <button
                                  type="button"
                                  class="olu-tag-pill-label"
                                  title={`Filter by #${t}`}
                                  onClick={() => applyQuickTokenFilter(`#${t}`)}
                                >
                                  #{t}
                                </button>
                                <button
                                  type="button"
                                  class="olu-tag-pill-remove"
                                  aria-label={`Remove tag ${t}`}
                                  title={`Remove #${t}`}
                                  disabled={mutatingTag()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void removeSessionTag(sel(), t);
                                  }}
                                >
                                  ×
                                </button>
                              </span>
                            )}
                          </For>
                        </div>
                        <form
                          class="olu-tag-add-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void addSessionTag(sel(), newTagInput());
                          }}
                        >
                          <input
                            type="text"
                            class="olu-tag-add-input"
                            placeholder="Add tag..."
                            aria-label="Add session tag"
                            value={newTagInput()}
                            onInput={(e) => setNewTagInput(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                e.stopPropagation();
                                void addSessionTag(sel(), newTagInput());
                              }
                            }}
                          />
                          <button
                            type="submit"
                            class="olu-chip olu-tag-add-btn"
                            disabled={mutatingTag() || !newTagInput().trim()}
                          >
                            + Tag
                          </button>
                        </form>
                      </div>

                      <div class="olu-section-card">
                        <span class="olu-section-title">Session Model Breakdown</span>
                        <div class="olu-table-wrap">
                          <table class="olu-table">
                            <thead>
                              <tr>
                                <th>Model</th>
                                <th>Steps</th>
                                <th>Input</th>
                                <th>Output</th>
                                <th>Cache Read</th>
                              </tr>
                            </thead>
                            <tbody>
                              <For each={Object.entries(sel().modelBreakdown)}>
                                {([modelName, mb]) => (
                                  <tr>
                                    <td class="olu-model-cell" title={modelName}>
                                      {modelName}
                                    </td>
                                    <td>{mb.turns}</td>
                                    <td>{fmtCompact(mb.input)}</td>
                                    <td>{fmtCompact(mb.output)}</td>
                                    <td>{fmtCompact(mb.cacheRead)}</td>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            </div>
          </div>
          </Show>
        </div>
    </div>
  );
}



const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_EXPIRING_IDLE_MS = 4 * 60 * 1000;
const CACHE_HEAVY_CONTEXT_TOKENS = 30_000;

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

const [guiStepStatus, setGuiStepStatus] = createSignal<SessionStepStatus | null>(null);
const [guiNow, setGuiNow] = createSignal(Date.now());
const [guiDismissedCacheKeys, setGuiDismissedCacheKeys] = createSignal<Set<string>>(new Set());
const guiWarnedSessions = new Set<string>();
const guiPromptedOverLimitTurnKeys = new Set<string>();
const guiPreparingHandoffs = new Set<string>();

async function startGuiSessionHandoff(ctx: PluginContext, explicitSessionId?: string) {
  const active = ctx.sessions.current();
  const sessionId = explicitSessionId || active?.id;
  if (!sessionId || guiPreparingHandoffs.has(sessionId)) return;
  guiPreparingHandoffs.add(sessionId);
  try {
    ctx.toast.show({ title: "Preparing handoff with AI", description: "Saving a fresh checkpoint before export. This uses model tokens.", variant: "success" });
    const rpc = getRpcClient(ctx);
    const result = await rpc.createHandoff({ sessionId });
    const handoff = result.ok ? result.handoff : undefined;
    if (!handoff) {
      ctx.toast.show({
        title: "Handoff unavailable",
        description: result.error || "No active session found to generate a handoff.",
        variant: "warning",
      });
      return;
    }

    await ctx.system.copy(handoff.handoffPrompt);
    ctx.toast.show({
      title: "Handoff saved and copied",
      description: `Saved ${handoff.shortId} (${handoff.count} steps) to ${handoff.checkpointPath}. Open a new chat, paste, and send.`,
      variant: "success",
    });

  } catch (err) {
    ctx.toast.show({
      title: "Failed to create handoff",
      description: String(err),
      variant: "error",
    });
  } finally {
    guiPreparingHandoffs.delete(sessionId);
  }
}
async function pollGuiSessionSteps(ctx: PluginContext) {
  const active = ctx.sessions.current();
  if (!active?.id) {
    setGuiStepStatus(null);
    return;
  }

  try {
    const rpc = getRpcClient(ctx);
    const st = await rpc.sessionStatus({ sessionId: active.id });
    setGuiStepStatus(st);
    setGuiNow(Date.now());
  } catch {}
}
export default Plugin.define({
 i18n: { en: {
      "tokens.command.title": "Token Audit...",
      "tokens.command.description": "Search sessions by topic, project, model, and token consumption",
      "handoff.command.title": "Save & Copy Session Handoff...",
      "handoff.command.description": "Save a checkpoint and copy continuation text to paste into a new chat",
"tokens.panel": "Token Audit", "tokens.panel.toggle": "Open Token Audit Panel"
 } },
 setup(ctx) {
 ctx.add(Style, css);
    ctx.add(Command, () => ({
      id: "tokens",
      title: ctx.t("tokens.command.title"),
      description: ctx.t("tokens.command.description"),
      keywords: "tokens analytics sessions models projects tags search",
      group: "Session",
      section: "session",
      bind: "mod+shift+y",
      slash: {
        name: "tokens",
        arguments: true,
      },
      featured: true,
      run(input) {
        openTokensPanel(ctx, input ?? "");
      },
    }));

    ctx.add(Command, () => ({
      id: "handoff",
      title: ctx.t("handoff.command.title"),
      description: ctx.t("handoff.command.description"),
      keywords: "handoff checkpoint new session context uncached steps limit",
      group: "Session",
      section: "session",
      slash: {
        name: "handoff",
      },
      featured: true,
      run() {
        void startGuiSessionHandoff(ctx);
      },
    }));
    const panelTabKey = `${ctx.id}:tokens`;
    const tokensTab: PanelTab = {
      id: "tokens",
      get title() {
        return ctx.t("tokens.panel");
      },
      closable: "compact",
    };

    const contextHeader = {
      at: "session.header",
      order: 16,
      render: () => {
        const ui = ctx.ui;
        const st = createMemo(() => {
          const cur = guiStepStatus();
          const active = ctx.sessions.current();
          if (!cur || !active || cur.sessionId !== active.id) return null;
          return cur;
        });
        return (
          <div class="olt-scope olu-header-slot-group">
            <Show when={st()}>
              {(s) => {
                const pct = () => Math.max(0, Math.min(100, s().handoffPct ?? 0));
                const status = () => (s().overLimit ? "bad" : s().approaching ? "warn" : "good");
                return (
                  <button
                    type="button"
                    class={`olu-step-pill olu-usage-pill olu-step-pill--${status()}`}
                     title={`Latest recorded request: ${s().statusReason}. Percentage of configured model context, not a required handoff limit. Click for Token Analytics.`}
                    onClick={() => {
                       openTokensPanel(ctx);
                    }}
                  >
                    <span>
                       Context
                    </span>
                     <span class="olu-usage-pill-pct">{s().modelContextLimit > 0 ? `${pct()}%` : "unknown"}</span>
                    <span class="olu-usage-pill-bar">
                      <span
                        class={`olu-usage-pill-bar-fill olu-progress-fill--${status()}`}
                        style={{ width: `${pct()}%` }}
                      />
                    </span>
                  </button>
                );
              }}
            </Show>
          </div>
        );
      },
    };

    const contextNotice = {
      at: "session.composer.top",
      order: 5,
      render: () => {
        const info = createMemo(() => {
          const cur = guiStepStatus();
          const active = ctx.sessions.current();
          if (!cur || !active || cur.sessionId !== active.id) return null;
          if ((cur.liveContextTokens ?? 0) < CACHE_HEAVY_CONTEXT_TOKENS) return null;
          const refTime = cur.lastReplyAt || cur.timeUpdated || 0;
          if (refTime <= 0) return null;
          const dismissKey = `${cur.sessionId}:${refTime}`;
          if (guiDismissedCacheKeys().has(dismissKey)) return null;
          const ttlMs = cur.cacheTtlMs || CACHE_TTL_MS;
          const idleMs = Math.max(cur.idleMs ?? 0, guiNow() - refTime);
          if (idleMs < CACHE_EXPIRING_IDLE_MS) return null;
          const remMs = Math.max(0, ttlMs - idleMs);
          const state: "expiring" | "expired" = idleMs >= ttlMs ? "expired" : "expiring";
          return { status: cur, idleMs, remMs, state, dismissKey };
        });
        return (
          <Show when={info()}>
            {(item) => (
              <div
                class={`olt-scope olu-composer-alert ${
                  item().state === "expired" ? "olu-composer-alert--bad" : "olu-composer-alert--warn"
                }`}
              >
                <div class="olu-composer-alert-text">
                  <strong>
                    {item().state === "expired"
                      ? `Prompt cache likely expired (idle ${fmtDurationShort(item().idleMs)}) · ${item().status.statusReason}`
                      : `Prompt cache expiring (${fmtDurationShort(item().remMs)} left) · ${item().status.statusReason}`}
                  </strong>
                  <span>
                    {item().state === "expired"
                      ? `5m cache window passed. Replying now may re-send ${fmtCompact(item().status.liveContextTokens)} uncached tokens (${item().status.steps} steps).`
                      : `Idle ${fmtDurationShort(item().idleMs)} since last reply. Reply within ${fmtDurationShort(item().remMs)} while ${fmtCompact(item().status.liveContextTokens)} context is still cached, or start a handoff.`}
                  </span>
                </div>
                <div class="olu-composer-alert-actions">
                  <button
                    type="button"
                    class="olu-composer-alert-btn"
                    onClick={() => void startGuiSessionHandoff(ctx, item().status.sessionId)}
                  >
                    Save & Copy Handoff
                  </button>
                  <button
                    type="button"
                    class="olu-composer-alert-dismiss"
                    aria-label="Dismiss cache alert"
                    title="Dismiss for this turn"
                    onClick={() => {
                      const next = new Set(guiDismissedCacheKeys());
                      next.add(item().dismissKey);
                      setGuiDismissedCacheKeys(next);
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            )}
          </Show>
        );
      },
    };
    if (ctx.options.cacheAlerts === true) ctx.add(Slot, contextNotice);
    createEffect(() => {
      const activeId = ctx.sessions.current()?.id;
      if (activeId) {
        void pollGuiSessionSteps(ctx);
      } else {
        setGuiStepStatus(null);
      }
    });
    const stepPollTimer = setInterval(() => {
      void pollGuiSessionSteps(ctx);
    }, 5000);
    const clockTimer = ctx.options.cacheAlerts === true ? setInterval(() => {
      if (guiStepStatus()) {
        setGuiNow(Date.now());
      }
    }, 1000) : undefined;
    onCleanup(() => {
      clearInterval(stepPollTimer);
      clearInterval(clockTimer);
    });

    ctx.add(Command, () => ({
      id: "tokens-panel",
      title: ctx.t("tokens.panel.toggle"),
      description: "Toggle the persistent Token Analytics side panel",
      keywords: "tokens analytics panel sidebar sessions",
      group: "Session",
      section: "session",
      bind: "mod+alt+y",
      run() {
        openTokensPanel(ctx);
      },
    }));

    ctx.add(MenuItem, () => {
      const session = ctx.sessions.current();
      return {
        menu: "session.panel",
        id: "tokens",
        title: ctx.t("tokens.panel"),
        description: ctx.t("tokens.command.description"),
        icon: "models",
        keybind: `${ctx.id}.tokens-panel`,
        opened: !!session && ctx.layout.state(panelTabKey, session) !== "closed",
        run() {
          openTokensPanel(ctx);
        },
      };
    });
    if (typeof document !== "undefined") {
      const ensureTopLeftUsageButton = () => {
        const searchBtn = document.querySelector<HTMLButtonElement>(
          'header[data-slot="titlebar-v2"] button[aria-label*="Search"]'
        );
        if (searchBtn && searchBtn.parentElement) {
          const container = searchBtn.parentElement;
          if (!container.querySelector('[data-action="titlebar-tokens"]')) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.setAttribute("data-action", "titlebar-tokens");
            btn.setAttribute("aria-label", "Token Audit (Ctrl+Shift+Y)");
            btn.setAttribute("title", "Token Audit (Ctrl+Shift+Y)");
            btn.className = "olt-scope olu-titlebar-quick-btn";
            btn.innerHTML = COINS_ICON_SVG;
            btn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              openTokensPanel(ctx);
            });
            container.appendChild(btn);
          }
        }

        const vertAnchor =
          document.querySelector<HTMLButtonElement>('button[data-action="vertical-tabs-usage"]') ??
          document.querySelector<HTMLButtonElement>('button[data-action="vertical-tabs-memories"]') ??
          document.querySelector<HTMLButtonElement>('button[data-action="vertical-tabs-search"]');
        if (vertAnchor && vertAnchor.parentElement) {
          const vertContainer = vertAnchor.parentElement;
          const existingTokensBtn = vertContainer.querySelector<HTMLButtonElement>('[data-action="vertical-tabs-tokens"]');
          if (!existingTokensBtn) {
            const vBtn = document.createElement("button");
            vBtn.type = "button";
            vBtn.setAttribute("data-titlebar-tab-action", "");
            vBtn.setAttribute("data-action", "vertical-tabs-tokens");
            vBtn.setAttribute("aria-label", "Token Audit (Ctrl+Shift+Y)");
            vBtn.className =
              "group flex h-7 w-full shrink-0 items-center gap-1.5 rounded-[6px] ps-1.5 pe-2 text-[13px] leading-4 text-v2-text-text-faint hover:text-v2-text-text-base";
            vBtn.innerHTML =
              COINS_ICON_SVG +
              '<span class="min-w-0 truncate whitespace-nowrap">Token Audit</span>';
            vBtn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              openTokensPanel(ctx);
            });
            vertAnchor.insertAdjacentElement("afterend", vBtn);
          } else if (
            vertAnchor.getAttribute("data-action") === "vertical-tabs-usage" &&
            existingTokensBtn.nextElementSibling === vertAnchor
          ) {
            vertAnchor.insertAdjacentElement("afterend", existingTokensBtn);
          }
        }
      };

      ensureTopLeftUsageButton();
      const observer = new MutationObserver(() => {
        ensureTopLeftUsageButton();
      });
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
      onCleanup(() => {
        observer.disconnect();
        document
          .querySelectorAll('[data-action="titlebar-tokens"], [data-action="vertical-tabs-tokens"]')
          .forEach((el) => el.remove());
      });
    }


    ctx.add(Panel, {
      id: "tokens",
      region: "side",
      list: (input) => (input.open.includes("tokens") ? [tokensTab] : []),
      render: () => <TokensSurface ctx={ctx} variant="panel" />,
    });
 },
});
