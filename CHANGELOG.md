# Changelog

## 0.1.2 (2026-11-26)

- Added `install` (`init` / `setup`) CLI subcommand (`installPlugin` in `cli.js`, tested in `test/install.test.ts`) writing a V2 entry to `opencode.jsonc` only, without requiring TypeScript execution.
- Aligned `package.json` `"author"` to `"nandoblanco"` and standardized `README.md` Installation with all 4 install options (`opencode plugin add`, manual `opencode.jsonc`, `npx ... install`, and local directory) matching the other public OpenCode plugins.

## 0.1.1 (2026-11-26)

- Removed eager startup `prewarmTokensCache()` timers from `src/server.ts` and `src/tui.ts` so OpenCode server and TUI startup are not blocked by synchronous SQLite scans on large `opencode.db` files; `/tokens` still prewarms and caches on demand when opened.
- Fixed every session being labeled project `general`: the header summary created sidecar entries without running project inference, and the report never recomputed them. Entries now carry a `projectVersion` (including a hash of `tokens.json`) so existing sessions are relabeled automatically whenever the rules change (`src/summary.ts`, `src/tokens.ts`).
- New `~/.config/opencode/tokens.json` (or `OPENCODE_TOKENS_CONFIG`) with `ignoreFolders` and `keywords`. Project is now every folder of the session directory minus ignored folder names and the home folder prefix (e.g. `/workspace/git/agency/clients/acme/storefront` -> `acme/storefront`); when nothing is left it is `general` (`src/tokens.ts`).
- Removed all built-in project and tag keyword rules. Automatic tags now come only from the configured `keywords` map (tag -> list of words matched in the title and first prompts) plus `#claude-code` / `#codex-cli` source tags; keywords never change the project. The unused `projectRules` / `tagRules` options were replaced by `config` / `configPath` (`src/tokens.ts`, `test/tokens-controls.test.ts`).
- Fixed mislabeled counts: header KPI and summary values are user turns, now labeled `Turns`; the summary line is prefixed `All time:` so it no longer appears to contradict the 30-day header; the session detail card shows `Steps / Turns` instead of the turn count labeled as steps (`src/gui.tsx`, `src/tui.ts`).
- Tag chips show billed tokens like project chips instead of session counts.
- Token totals of one billion or more format as `B` (e.g. `4.39B` instead of `4353.97M`) (`src/tokens.ts`).
- Desktop panel now uses a container query: list and detail sit side by side at 640px and wider, and below that the list fills the panel and a row opens the detail with a `Back` button (Escape returns to the list) (`src/gui.css`).
- TUI `/tokens` lists 80 sessions instead of 14 and tag chips no longer wrap mid-token.
- TUI `/tokens` header now uses the same single-row title and key-hint layout as `/search`, `/memory` and `/backups`; model and project rows stay on one line, top tags list as aligned rows, table values are no longer truncated, and the dialog fits a 32-row terminal (`src/tui.ts`).
- Desktop dialog fills its height, the duplicate `Token Audit` heading inside it now reads `Totals`, and the `Add tag` input is larger and easier to see (`src/gui.tsx`, `src/gui.css`).
- Desktop arrow-key navigation scrolls the selected session into view.
- Desktop `Like`, `Open Session` and `Filter Per Session` buttons use valid button variants, and the empty per-tag view explains that only the loaded sessions are searched and points to `Filter Per Session`.

- Expanded the README introduction and background around auditing token totals by project folder or tag; removed references to the separate account-quota plugin from the README.
- Explained how manual session handoff complements token auditing and model-context status, preserving structured working state and linked history when continuing in a fresh session without promising token savings.

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
