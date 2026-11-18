# Changelog

## Unreleased

- Removed the obsolete combined Tokens/Usage browser fixtures and their README reference. Standalone Tokens tests remain the package's verification scope.

- Disabled prompt-cache expiry banners and their countdown clocks by default in terminal and Desktop. Set plugin option `cacheAlerts: true` to opt in; manual handoff, context status, and token analytics are unchanged. Rebuilt the Desktop GUI bundle.

- Removed machine-specific tag and handoff directory fallbacks from `resolveDefaultSidecarPath`, `handoffDirectory`, and `buildSessionHandoff`; explicit paths and environment overrides retain precedence over portable home-directory defaults. Existing files are not migrated automatically.

- Added Git exclusions for dependencies, backups, screenshots, credentials, and local analytics data; corrected the GitHub repository URL in `package.json`.

- Separated terminal `/tokens` search, controls, and totals; added an inline eight-mode sort picker (`Ctrl+S`) and selected-session add/remove tag editors (`Ctrl+T` / `Ctrl+R`) with cancellation and visible save errors.
- Added shell `--sort` and `untag` commands. Explicit sorting in `analyzeTokens` runs before limiting results; existing callers without a sort retain their ordering. Documented terminal, shell, and Desktop controls separately.

- Shortened the terminal Token Audit search placeholder to `Search or filter...`.

- Declared the OpenCode V2 SDK (`@opencode/plugin`) as a runtime dependency instead of a development-only dependency, and removed the obsolete V1 SDK optional peer declaration (`@opencode-ai/plugin`).

- Desktop Save & Copy Handoff and CLI `/handoff` now request a fresh AI-authored working-state checkpoint in the original session and wait before exporting. Failed preparation does not silently export an old checkpoint. Preparation uses model tokens; CLI then sends the continuation in a new session using the V2 text input.

- Renamed OpenCode Desktop sidebar button (`vertical-tabs-tokens`), panel tab title, dialog title, and top bar header from `Tokens` / `Token Explorer` / `Token Analytics` to `Token Audit`, replaced the icon with a stacked coins SVG, and omitted the trailing shortcut badge in the left sidebar (`src/gui.tsx`).
- Added session sort controls (`billed`, `total`, `steps`, `updated`, `newest`, `oldest`, `title`, `relevance`) in the Token Audit filter bar (`src/gui.tsx`, `src/tokens.ts`).
- Added manual session tagging in the selected session detail pane (`+ Tag` inline form and removable `#tag` pills via `mutateSession` `tag` / `untag` actions in `src/tokens.ts`, `src/rpc.ts`, and `src/gui.tsx`).
- Added main lower view tabs (`Per Session` and `Per Tag`) in Token Audit (`src/gui.tsx`, `src/gui.css`, `src/tokens.ts`) with a per-tag token breakdown list, tag KPI cards, and a clickable tagged-sessions table.
- Added 5-minute prompt-cache idle tracking (`lastReplyAt`, `idleMs`, `cacheTtlMs`, `cacheRemainingMs`, `cacheState`, `cacheAlert` in `getSessionStepStatus`) and a composer-top alert pill in OpenCode Desktop (`src/gui.tsx`, `src/gui.css`) and CLI TUI (`src/tui.ts`) that stays hidden during active chatting and appears only when live context is heavy (>=30K tokens) and idle >=4 minutes, with a 1-click `Save & Copy Handoff` action and per-turn dismiss button.

## 0.1.0 (2026-11-17)

- Initial release of `@nandoblanco/opencode-local-tokens` for OpenCode V2.
- Added local token analytics (`src/tokens.ts`, `src/summary.ts`) aggregating input, output, reasoning, cache-read, and cache-write counters across OpenCode SQLite databases and local Claude Code / Codex JSONL transcripts.
- Added `/tokens` and `/handoff` TUI commands (`src/tui.ts`), OpenCode Desktop Tokens panel (`src/gui.tsx`, `src/gui.css`, `Ctrl+Shift+Y`), and session bookmark/tag/note persistence in `session-tags.json` (`mutateSessionTag`).
- Added model-aware context capacity tracking (`getSessionStepStatus`) with 75% warning and 90% high-usage thresholds against exact configured model limits.
- Added structured session handoff tools (`handoff_checkpoint` and `handoff_history` in `src/handoff.ts`) and local handoff measurement sidecars (`src/measurement.ts`).
