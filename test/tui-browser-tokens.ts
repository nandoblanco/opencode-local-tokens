export const TOKEN_SORT_LABELS = { billed: "Billed tokens", total: "Total w/ cache", steps: "Most steps", updated: "Recently updated", newest: "Newest created", oldest: "Oldest created", title: "Title (A-Z)", relevance: "Best match" };
export const TOKEN_SORT_MODES = Object.keys(TOKEN_SORT_LABELS);
export const CACHE_EXPIRING_IDLE_MS = 240000, CACHE_HEAVY_CONTEXT_TOKENS = 30000, CACHE_TTL_MS = 300000, STEP_LIMIT_THRESHOLD = 1000, STEP_WARNING_THRESHOLD = 800;
export const billedTokens = (tokens: any) => tokens.input + tokens.output + tokens.reasoning;
export const totalTokensWithCache = (tokens: any) => billedTokens(tokens) + tokens.cacheRead + tokens.cacheWrite;
export const fmtNum = (value: number) => value.toLocaleString("en-US");
export function prewarmTokensCache() {}
export function getSessionStepStatus() { return (window as any).tuiTest.cacheStatus; }
export function buildSessionHandoff() { return null; }
const sessions = Array.from({ length: 18 }, (_, i) => ({ id: `ses_fixture_${i}`, shortId: `fixture${i}`, project: "storefront", smartTitle: `Repair session ${String(i).padStart(2, "0")}`, tags: ["repair"], liked: false, turns: i + 1, steps: i + 1, tokens: { input: (18 - i) * 100, output: 10, reasoning: 0, cacheRead: i * 100, cacheWrite: 0 } }));
export function analyzeTokens(options: any) {
  let rows = sessions.filter(s => (!options.query || s.smartTitle.includes(options.query)) && (!options.tag || s.tags.includes(options.tag)));
  rows = [...rows];
  if (["updated", "newest", "steps"].includes(options.sort)) rows.reverse();
  if (options.sort === "title") rows.sort((a, b) => a.smartTitle.localeCompare(b.smartTitle));
  return { sessions: rows.slice(0, 14), totalSessionsMatched: rows.length, totals: { input: 17100, output: 180, reasoning: 0, cacheRead: 15300, cacheWrite: 0, turns: 171 }, sortedModels: [], sortedProjects: [], topTags: [] };
}
export function mutateSessionTag(action: string, id: string, value = "") {
  if ((window as any).tuiTest.failSave) throw new Error("Fixture disk write failed");
  const session = sessions.find(s => s.id === id)!;
  const tags = value.split(",").map(tag => tag.trim().toLowerCase());
  if (action === "tag") session.tags = [...new Set([...session.tags, ...tags])];
  if (action === "untag") session.tags = session.tags.filter(tag => !tags.includes(tag));
  if (action === "like") session.liked = true;
  if (action === "unlike") session.liked = false;
  (window as any).tuiTest.mutations.push({ action, id, value });
}
