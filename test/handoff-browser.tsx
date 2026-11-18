import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import { Slot, Style } from "@opencode/plugin/gui";
import plugin from "../src/gui.tsx";

// Real GUI command, composer slot, and copy handler; only the Desktop host boundary is stubbed.
const commands = new Map();
const slots: any[] = [];
const state = { calls: [] as string[], copied: "", mode: "success", status: null as any };
const rpc = {
  async createHandoff(input: any) {
    state.calls.push(input.sessionId);
    if (state.mode === "error") throw new Error("Fixture checkpoint unavailable");
    return state.mode === "empty" ? { ok: false } : { ok: true, handoff: (window as any).fixtureHandoff };
  },
  async sessionStatus() { return state.status; },
};
const ctx = {
  options: JSON.parse(decodeURIComponent(location.hash.slice(1) || "{}")),
  id: "opencode-local-tokens", ui: {},
  t: (key: string) => key,
  sessions: { current: () => ({ id: "ses_fixture", server: { id: "fixture", client: { rpc: () => rpc } } }) },
  servers: { list: () => [] },
  layout: { state: () => "closed" },
  system: { async copy(text: string) { state.copied = text; } },
  toast: { show(value: any) {
    const output = document.querySelector("output")!;
    output.textContent = `${value.title}\n${value.description}`;
  } },
  add(registry: any, value: any) {
    if (registry === Style) {
      const styleEl = document.createElement("style");
      styleEl.textContent = String(value || "");
      document.head.appendChild(styleEl);
      return;
    }
    const item = typeof value === "function" ? value() : value;
    if (registry === Slot && item?.render) {
      slots.push(item);
      return;
    }
    if (item?.run) commands.set(item.id, item);
  },
};
createRoot(() => plugin.setup!(ctx as any));
const slotMount = document.getElementById("composer-slot");
if (slotMount) {
  for (const s of slots) {
    if (s.at === "session.composer.top") {
      render(() => s.render(), slotMount);
    }
  }
}
document.querySelector("button")!.addEventListener("click", () => commands.get("handoff").run());
(window as any).handoffTest = state;
