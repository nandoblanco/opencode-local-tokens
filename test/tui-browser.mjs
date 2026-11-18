"use strict";

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const require = createRequire(new URL("../../opencode-local-search/package.json", import.meta.url));
const { chromium } = require("playwright");
const local = file => fileURLToPath(new URL(file, import.meta.url));
const server = await createServer({ configFile: false, resolve: { conditions: ["browser"], alias: [
  { find: "@opentui/solid", replacement: local("./tui-browser-adapter.ts") },
  { find: "@opentui/core", replacement: "virtual:tui-core" },
] }, plugins: [{ name: "tui-fixtures", enforce: "pre", resolveId(id, importer) {
  if (id === "virtual:tui-core" || id === "virtual:tui-handoff") return id;
  if (importer?.replaceAll("\\", "/").endsWith("/src/tui.ts") && id === "./tokens.ts") return local("./tui-browser-tokens.ts");
  if (importer?.replaceAll("\\", "/").endsWith("/src/tui.ts") && id === "./prepare-handoff.ts") return "virtual:tui-handoff";
}, load(id) {
  if (id === "virtual:tui-core") return 'export const RGBA = { fromInts: (r,g,b,a) => `rgba(${r},${g},${b},${a/255})` };';
  if (id === "virtual:tui-handoff") return "export async function prepareHandoff() {}";
} }], server: { host: "127.0.0.1", port: 5197, strictPort: true, hmr: false } });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => {
  window.testIntervals = [];
  const startInterval = window.setInterval;
  window.setInterval = (callback, delay, ...args) => {
    window.testIntervals.push(delay);
    return startInterval(callback, delay, ...args);
  };
});
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
mkdirSync(".screenshots", { recursive: true });
try {
  await page.route("http://127.0.0.1:5197/", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Terminal dialog browser adapter</title><style>*{box-sizing:border-box}body{margin:0;background:#10141c;font:14px/1.4 monospace;color:#e6edf3}main{width:100%}</style><main></main><script type="module" src="/test/tui-browser-entry.ts"></script></html>' }));
  await page.goto("http://127.0.0.1:5197/");
  await page.waitForLoadState("networkidle");
  assert.equal(await page.evaluate(() => window.tuiTest.cacheSlots), 0);
  assert.equal(await page.evaluate(() => window.testIntervals.includes(1000) || window.testIntervals.includes(2500)), false);
  await page.getByText("Search or filter...", { exact: true }).waitFor({ timeout: 10000 }).catch(error => { throw new Error(`${error.message}: ${errors.join(" | ")}; ${page.url()}`); });
  for (const width of [1280, 800]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.keyboard.press("Control+s");
    await page.getByText("Sort sessions", { exact: false }).waitFor();
    await page.screenshot({ path: `.screenshots/tokens-sort-${width}.png`, fullPage: true });
    if (width === 1280) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByText("Sort: Billed tokens", { exact: false }).waitFor({ timeout: 3000 }).catch(async error => { throw new Error(`${error.message}: ${errors.join(" | ")} ${await page.locator("main").innerText()}`); });
    await page.keyboard.press("Control+t");
    await page.getByText("Add tags:", { exact: false }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByText("Enter at least one tag.", { exact: false }).waitFor();
    await page.keyboard.type("review,billing");
    await page.screenshot({ path: `.screenshots/tokens-tags-${width}.png`, fullPage: true });
    await page.keyboard.press("Enter");
    await page.getByText("Added tags: review,billing", { exact: true }).waitFor();
    await page.keyboard.press("Control+r");
    await page.keyboard.type("billing");
    await page.keyboard.press("Enter");
    await page.getByText("Removed tags: billing", { exact: true }).waitFor();
    await page.keyboard.type("no matching fixture");
    await page.getByText("No sessions matched the current filter.", { exact: true }).waitFor();
    await page.keyboard.press("Control+u");
    await page.getByText("Search or filter...", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `.screenshots/tokens-explorer-${width}.png`, fullPage: true });
  }
  await page.keyboard.press("Control+s");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await page.getByText("Sort: Billed tokens", { exact: false }).waitFor();
  const labels = ["Total w/ cache", "Most steps", "Recently updated", "Newest created", "Oldest created", "Title (A-Z)", "Best match", "Billed tokens"];
  for (const label of labels) {
    await page.keyboard.press("Control+s");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByText(`Sort: ${label}`, { exact: false }).waitFor();
  }
  await page.keyboard.press("Control+t");
  await page.keyboard.type("kept-input");
  await page.evaluate(() => { window.tuiTest.failSave = true; });
  await page.keyboard.press("Enter");
  await page.getByText("Tags not saved:", { exact: false }).waitFor();
  await page.getByText("kept-input█", { exact: true }).waitFor();
  await page.screenshot({ path: ".screenshots/tokens-tag-error-800.png", fullPage: true });
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => window.tuiTest.closed), 0);
  await page.keyboard.press("Control+t");
  await page.keyboard.type("discarded");
  await page.keyboard.press("Control+u");
  await page.getByText("Comma-separated tags█", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.tuiTest.failSave = false; });
  await page.keyboard.press("Control+l");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => window.tuiTest.navigated), "ses_fixture_0");
  assert.equal(await page.evaluate(() => window.tuiTest.mutations.length), 5);
  for (const cacheAlerts of [false, "true", true]) {
    await page.goto(`http://127.0.0.1:5197/#${encodeURIComponent(JSON.stringify({ cacheAlerts }))}`);
    await page.reload();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.evaluate(() => window.tuiTest.cacheSlots), Number(cacheAlerts === true));
    assert.equal(await page.evaluate(() => window.testIntervals.includes(1000)), cacheAlerts === true);
    assert.equal(await page.evaluate(() => window.testIntervals.includes(2500)), cacheAlerts === true);
    assert.equal(await page.getByText("Prompt cache likely expired", { exact: false }).count(), Number(cacheAlerts === true));
    await page.screenshot({ path: `.screenshots/tokens-cache-${cacheAlerts === true ? "enabled" : "disabled"}-800.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log("PASS: real TUI component in DOM adapter: cache banner/poll/clock disabled for omitted/false/string options and enabled only for true; sort, tags, search, like and navigation at 1280/800; no page overflow or console errors. Native OpenTUI rendering is not verified.");
} finally {
  await browser.close();
  await server.close();
}
