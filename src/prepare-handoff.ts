import { loadHandoffState } from "./handoff.ts";

export const HANDOFF_PREPARATION_PROMPT = `Prepare a handoff so a new assistant can continue without repeating completed work or losing important constraints.
Do not continue implementation, modify project files, or start a new session. Review the conversation and evidence, then call handoff_checkpoint with:
goal: Current objective and what counts as done.
constraints: User requirements, corrections, preferences, scope and preservation boundaries, and actions needing confirmation. Preserve exact wording where meaning matters.
decisions: Important decisions and reasons, including rejected approaches worth remembering.
verified: Completed and tested work, relevant file paths, symbols, commands, results, and evidence. Separate verified facts from assumptions and untested claims.
unfinished: Remaining work, partial changes, defects, blockers, and tests not run, with paths and current state.
failures: Failed approaches and useful reasons or exact errors needed to avoid repeating them. Omit irrelevant exploration.
pendingUserRequests: Every unresolved request or question, including earlier requests still in scope. A proposal is not approval.
nextStep: The exact first action the next assistant should take, with enough context to avoid guessing.
Include critical identifiers, confirmed data shapes, dependencies, and environment details in the relevant fields. Never include credentials or secrets.
Be concise, stay within the tool's 16,000-character limit, and prioritize continuity over brevity. Do not dump the transcript or invent facts. Label uncertainty. If finished, say so rather than inventing work.
After the tool succeeds, reply only: "Checkpoint saved. Ready to export."
If saving fails, report the failure and do not claim success.`;

interface PreparationClient {
  prompt(input: { sessionID: string; text: string; delivery: "queue" }): Promise<unknown>;
  wait(input: { sessionID: string }): Promise<void>;
}

const preparing = new Set<string>();

export async function prepareHandoff(sessionId: string, client: PreparationClient, readState = loadHandoffState) {
  if (preparing.has(sessionId)) throw new Error("A handoff is already being prepared for this session.");
  preparing.add(sessionId);
  try {
    const before = readState(sessionId);
    await client.prompt({ sessionID: sessionId, text: HANDOFF_PREPARATION_PROMPT, delivery: "queue" });
    await client.wait({ sessionID: sessionId });
    const after = readState(sessionId);
    if (!after || (after.savedAt === before?.savedAt && after.messageCount === before?.messageCount)) {
      throw new Error("AI did not save a fresh handoff checkpoint. Nothing was exported; retry after checking the session.");
    }
  } finally {
    preparing.delete(sessionId);
  }
}
