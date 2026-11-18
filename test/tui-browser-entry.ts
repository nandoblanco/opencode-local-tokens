import { createRoot, untrack } from "solid-js";
import { render } from "./tui-browser-adapter.ts";
import { tui } from "../src/tui.ts";

const state = (window as any).tuiTest = { failSave: false, mutations: [], navigated: "", closed: 0, cacheSlots: 0, cacheStatus: null };
let keyHandler: (event: any) => void;
let commands: any[];
const context: any = {
  options: JSON.parse(decodeURIComponent(location.hash.slice(1) || "{}")),
  client: { model: { async list() { return { data: [] }; } } },
  data: { session: { status() { return "idle"; } } },
  renderer: { keyInput: { prependListener(_name: string, handler: any) { keyHandler = handler; }, removeListener() {} } },
  keymap: { layer(factory: any) { commands = factory().commands; } },
  ui: {
    slot(slot: any) {
      if (slot.append === "app") slot.render();
      if (slot.before === "session.composer.top") {
        state.cacheSlots++;
        state.cacheStatus = { sessionId: "ses_fixture", liveContextTokens: 84200, lastReplyAt: Date.now() - 375000, timeUpdated: Date.now() - 375000, statusReason: "Ctx 84,200/200,000" };
        const mount = document.createElement("div");
        document.body.prepend(mount);
        render(() => slot.render({ sessionID: "ses_fixture" }), mount);
      }
    },
    dialog: { show(factory: any) { render(() => untrack(factory), document.querySelector("main")); }, set() {}, clear() { state.closed++; } },
    router: { navigate(route: any) { state.navigated = route.sessionID; } },
  },
};
createRoot(async () => {
  await tui.setup(context);
  commands.find(command => command.id === "tokens.open").run();
  document.addEventListener("keydown", event => {
    keyHandler({ name: ({ ArrowDown: "down", ArrowUp: "up", Enter: "return", Escape: "escape", Backspace: "backspace" } as any)[event.key] || event.key.toLowerCase(), ctrl: event.ctrlKey, meta: event.metaKey, sequence: event.key.length === 1 ? event.key : "", preventDefault() { event.preventDefault(); }, stopPropagation() { event.stopPropagation(); } });
  });
});
