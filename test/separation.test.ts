import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { TokensRpc } from "../src/rpc.ts";
import { server } from "../src/server.ts";
import { resolveModelContextWindow } from "../src/tokens.ts";

it("keeps Tokens RPC analytics-only without a balance dashboard", async () => {
  let methods: string[] = [];
  await server.setup({ rpc: { async register(def: unknown, impl: object) {
    assert.equal(def, TokensRpc);
    methods = Object.keys(impl);
  } }, session: { async hook() {} }, tool: { async transform() {} } } as any);
  assert.deepEqual(methods.sort(), Object.keys(TokensRpc.methods).sort());
  assert.equal("dashboard" in TokensRpc.methods, false);
});

it("uses only exact configured model capacity, never model-name guesses", () => {
  assert.equal(resolveModelContextWindow("openai/gpt-6"), 0);
  assert.equal(resolveModelContextWindow("google/gemini"), 0);
  assert.equal(resolveModelContextWindow("openai/gpt-6", { "openai/gpt-6": 400000 }), 400000);
});
