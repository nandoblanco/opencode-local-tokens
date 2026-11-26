import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installPlugin } from "../cli.js";

test("installPlugin writes V2 plugin entry into opencode.jsonc only and preserves comments", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-local-tokens-cfg-"));
  const tmpOpts = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-local-tokens-opts-"));
  try {
    const jsoncPath = path.join(tmpDir, "opencode.jsonc");
    fs.writeFileSync(
      jsoncPath,
      '{\n  // Keep user comment\n  "plugins": [\n    "opencode-local-search"\n  ]\n}\n',
      "utf8"
    );

    const first = await installPlugin({ configDir: tmpDir });
    assert.equal(first.serverStatus, "updated");
    assert.equal(fs.existsSync(path.join(tmpDir, "cli.json")), false);

    const updated = fs.readFileSync(jsoncPath, "utf8");
    assert.ok(updated.includes("// Keep user comment"));
    assert.ok(updated.includes('"@nandoblanco/opencode-local-tokens"'));

    const second = await installPlugin({ configDir: tmpDir });
    assert.equal(second.serverStatus, "already-present");

    const withOpts = await installPlugin({ configDir: tmpOpts, cacheAlerts: true });
    assert.equal(withOpts.serverStatus, "created");
    const parsed = JSON.parse(fs.readFileSync(withOpts.serverConfigFile, "utf8"));
    assert.deepEqual(parsed.plugins, [
      { package: "@nandoblanco/opencode-local-tokens", options: { cacheAlerts: true } }
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpOpts, { recursive: true, force: true });
  }
});
