"use strict";

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "vite";
import solid from "vite-plugin-solid";

const require = createRequire(new URL("../../opencode-local-search/package.json", import.meta.url));
const { chromium } = require("playwright");
const server = await createServer({ configFile: false, plugins: [solid()], server: { host: "127.0.0.1", port: 5198, strictPort: true, hmr: false } });
await server.listen();
const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks"] });
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
  await page.route("http://127.0.0.1:5198/", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>:root{--v2-text-text-base:#e6edf3;--v2-text-text-muted:#8b949e;--v2-border-border-base:#30363d;--v2-border-border-focus:#58a6ff;--v2-surface-surface-secondary:#161b22;--v2-surface-surface-base:#21262d;--v2-syntax-syntax-warning:#fbbf24;--v2-syntax-syntax-critical:#f87171}body{background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;margin:16px}</style></head><title>Handoff command smoke test</title><body><h1>Handoff command smoke test</h1><div id="composer-slot"></div><button id="cmd-handoff" type="button">Save and copy handoff</button><p><output aria-live="polite"></output></p><script type="module" src="/test/handoff-browser.tsx"></script></body></html>' }));
  await page.goto("http://127.0.0.1:5198/");
  await page.waitForFunction(() => window.handoffTest).catch(error => { throw new Error(`${error.message}: ${errors.join(" | ")}`); });
  await page.evaluate(() => { window.fixtureHandoff = { shortId: "fixture", count: 2, checkpointPath: "fixture-checkpoint.md", handoffPrompt: "Manual handoff stays available" }; });
  await page.locator("#cmd-handoff").click();
  await page.getByText("Handoff saved and copied", { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.handoffTest.copied), "Manual handoff stays available");
  for (const cacheAlerts of [undefined, false, "true"]) {
    if (cacheAlerts !== undefined) {
      await page.goto(`http://127.0.0.1:5198/#${encodeURIComponent(JSON.stringify({ cacheAlerts }))}`);
      await page.reload();
      await page.waitForFunction(() => window.handoffTest);
    }
    await page.evaluate(() => { window.handoffTest.status = { sessionId: "ses_fixture", liveContextTokens: 84200, lastReplyAt: Date.now() - 375000, timeUpdated: Date.now() - 375000, statusReason: "Ctx 84,200/200,000" }; });
    assert.equal(await page.locator(".olu-composer-alert").count(), 0);
    assert.equal(await page.evaluate(() => window.testIntervals.includes(1000)), false);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 720 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `.screenshots/cache-disabled-${width}.png`, fullPage: true });
    }
  }
  await page.goto(`http://127.0.0.1:5198/#${encodeURIComponent(JSON.stringify({ cacheAlerts: true }))}`);
  await page.reload();
  await page.waitForFunction(() => window.handoffTest);
  assert.equal(await page.evaluate(() => window.testIntervals.includes(1000)), true);
  const fixture = { shortId: "fixture", count: 2, checkpointPath: "fixture-checkpoint.md", handoffPrompt: "Continuing from previous session `ses_fixture`.\nRead the handoff checkpoint before acting.\nUse handoff_history with a narrow query." };
  await page.evaluate(value => { window.fixtureHandoff = value; }, fixture);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await page.locator("#cmd-handoff").click();
    await page.getByText("Handoff saved and copied", { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.handoffTest.copied), fixture.handoffPrompt);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `.screenshots/handoff-command-${width}.png`, fullPage: true });
  }
  await page.evaluate(() => { window.handoffTest.mode = "empty"; });
  await page.locator("#cmd-handoff").click();
  await page.getByText("Handoff unavailable", { exact: false }).waitFor();
  await page.evaluate(() => { window.handoffTest.mode = "error"; });
  await page.locator("#cmd-handoff").click();
  await page.getByText("Failed to create handoff", { exact: false }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.handoffTest.calls), Array(4).fill("ses_fixture"));

  // Verify idle cache composer pill (expiring & expired states + dismiss)
  await page.evaluate(() => {
    window.handoffTest.mode = "success";
    window.handoffTest.status = {
      sessionId: "ses_fixture",
      shortId: "ses_fix",
      liveContextTokens: 84200,
      modelContextLimit: 200000,
      steps: 18,
      statusReason: "Ctx 84,200/200,000",
      lastReplyAt: Date.now() - 252_000,
      timeUpdated: Date.now() - 252_000,
      idleMs: 252_000,
      cacheTtlMs: 300_000,
      cacheRemainingMs: 48_000,
      cacheState: "expiring",
      cacheAlert: true,
    };
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByText("Prompt cache expiring", { exact: false }).waitFor({ timeout: 8000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: ".screenshots/cache-expiring-1280.png", fullPage: true });

  await page.evaluate(() => {
    window.handoffTest.status = {
      ...window.handoffTest.status,
      lastReplyAt: Date.now() - 375_000,
      timeUpdated: Date.now() - 375_000,
      idleMs: 375_000,
      cacheRemainingMs: 0,
      cacheState: "expired",
    };
  });
  await page.getByText("Prompt cache likely expired", { exact: false }).waitFor({ timeout: 8000 });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 720 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `.screenshots/cache-expired-${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "Dismiss cache alert" }).click();
  assert.equal(await page.locator(".olu-composer-alert").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: cache banners and clocks disabled for omitted/false/string options; boolean true opts in; manual handoff works by default; enabled alert/dismiss/error flows pass at 1280/390 without overflow or console errors. Host RPC and clipboard are stubbed.");
} finally {
  await browser.close();
  await server.close();
}
