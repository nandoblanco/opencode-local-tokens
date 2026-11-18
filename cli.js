#!/usr/bin/env node
"use strict";
import { runTokensCli } from "./src/tokens.ts";
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("opencode-tokens [query] [--project name] [--model name] [--tag tag] [--liked] [--limit count] [--sort mode]\nSort: billed, total, steps, updated, newest, oldest, title, relevance\nCommands: like <session>, unlike <session>, tag <session> <tags>, untag <session> <tags>, note <session> <text>\nTags: comma-separated, e.g. review,billing\nIn OpenCode: /tokens opens analytics (Ctrl+S sort, Ctrl+T add tags, Ctrl+R remove tags); /handoff creates a checkpoint for a fresh session.");
} else {
  runTokensCli(args);
}
