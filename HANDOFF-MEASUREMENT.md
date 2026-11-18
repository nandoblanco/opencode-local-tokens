# Handoff measurement

## Implemented functionality

`src/measurement.ts` collects local observations without model calls or additional agent tools. `src/handoff.ts` records a checkpoint-save observation after saving working state. `buildSessionHandoff` records a separate observation after writing the handoff Markdown. The server subscribes to `session.idle` to refresh recovery windows for explicitly linked child sessions. Cleanup aborts the subscription.

| Observation | Recorded data | Boundary |
| :--- | :--- | :--- |
| Checkpoint save | Session ID, timestamp, message count, previous five usage-bearing assistant records | After the checkpoint write, not the start of preparation |
| Handoff save | Structured/fallback status, checkpoint timestamp, stale-message count, last request context and model, configured capacity if known, previous five records | After the handoff Markdown write |
| After checkpoint save | Usage records between the observed checkpoint save and handoff save | Does not measure checkpoint composition or its generating request reliably |
| Linked recovery | First request, first five, following five (requests 2 through 6), first ten, model-change flag | Refreshed on child-session idle; incomplete windows are labeled |
| Review status | `outcome: "unreviewed"` | No automatic correctness or quality judgment |

Each request observation contains message ID, timestamp, model key, input/output/reasoning/cache-read/cache-write counters, context (input plus both cache counters), and counts of direct `read` and `handoff_history` tool parts. Windows include observed counts and totals. These are usage-bearing assistant records, not a claim that every possible auxiliary model call is represented. No dollar savings are calculated.

## Storage and privacy

Files are written under the existing memory directory at `handoffs/measurements/`. `checkpoint-<session-id>.json` holds the latest checkpoint observation. Each handoff save creates `handoff-<uuid>.json`, preserving repeated exports as separate observations. Records contain IDs, timestamps, model identifiers, counters, and status fields. Prompt bodies, checkpoint prose, file paths, tool arguments, and tool outputs are not copied into analytics. The collector reads message JSON locally to extract counters and the continuation marker. The existing working-state JSON and handoff Markdown still contain their normal content.

The source OpenCode database is opened with `readOnly: true`. Analytics never change source messages. Collection errors emit a warning with the error class, without message content, and do not block handoff creation or normal execution. No network requests or additional model calls are made by the collector. Existing checkpoint generation, tool schemas, and history results still consume ordinary context tokens.

## Attribution and limitations

A child is linked only when its first user message begins with the existing `Continuing from previous session` marker and the exact parent ID. No heuristic matching of titles, directories, or text similarity is used. This is evidence of a parent link, not proof that the checkpoint was read or that recovery succeeded. A repeated parent export cannot be identified uniquely from that marker, so matching saves are explicitly labeled `candidate-only`. Saves later than the child's first user message are excluded.

There is no historical backfill. Measurement begins with newly observed checkpoint and handoff saves. Idle collection is not a streaming completion detector. It reads the first ten usage-bearing records available at idle. Counts of direct tool parts miss calls nested inside Code Mode or wrappers. Unknown model capacity is stored as `null`; historical capacities are not inferred from current model names. The five/ten request windows are exploratory conventions, not validated thresholds, and do not represent equal work before and after handoff.

## Unchanged behavior

Manual handoff controls, generated continuation prompts, session creation behavior, checkpoint text, context alerts, model selection, and automatic compaction are unchanged. The collector neither creates sessions nor recommends or triggers handoffs. Existing context warnings use 75% and 90% of the resolved model context capacity. Measurement does not change those values.

## Proposed functionality, not implemented

| Proposal | Current boundary |
| :--- | :--- |
| Explicit preparation-start observation | Checkpoint-save is the first observation; preparation overhead remains unmeasured |
| Reviewed recovery milestone with correct / needed correction / unclear outcomes | Only `unreviewed` is initialized; no review command or UI exists |
| Aggregate report and review after ten additional handoffs | Raw local JSON observations only; ten is a practical review point, not statistical proof |
| Recovery completeness and retained-quality assessment | Requires human evidence; token reductions cannot establish quality |
| Automatic timing or different thresholds | Outside this pass; requires separate approval and evidence |

## Verification

Run `npm test` from this package. `test/measurement.test.ts` covers window sizes and totals, partial recovery, model switches, repeated-idle deduplication, explicit links, privacy, fallback metadata, unchanged source rows, and non-blocking collection errors. Existing handoff tests cover working-state inclusion and unchanged alert status. Browser smoke tests exercise the existing GUI command handler with a stubbed host; they do not prove actual Desktop or TUI session creation.
