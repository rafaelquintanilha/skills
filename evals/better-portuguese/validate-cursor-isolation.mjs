#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error(
      "Pass a Cursor run manifest: " +
        "npm run eval:better-portuguese:validate-isolation -- <path>",
    );
  }

  const manifest = JSON.parse(
    await readFile(resolve(manifestPath), "utf8"),
  );
  assert(manifest.runner?.runtime === "cursor", "Run is not a Cursor run.");
  assert(
    Array.isArray(manifest.runner.ambientSettingSources) &&
      manifest.runner.ambientSettingSources.length === 0,
    "Ambient Cursor setting sources were not disabled.",
  );
  assert(
    manifest.runner.stateIsolation === "one JsonlLocalAgentStore per arm",
    "Per-arm Cursor stores were not recorded.",
  );

  const generations = Object.entries(manifest.generations ?? {});
  assert(generations.length > 0, "Manifest contains no generation metadata.");

  const agentIds = new Set();
  const runIds = new Set();
  const pairs = new Map();
  for (const [key, generation] of generations) {
    const match = key.match(/^(.*)\.(control|treatment)$/);
    assert(match, `Invalid generation key: ${key}`);
    const [, pairId, arm] = match;
    if (!pairs.has(pairId)) {
      pairs.set(pairId, {});
    }
    pairs.get(pairId)[arm] = generation;

    assert(generation.runtime === "cursor", `${key} is not a Cursor arm.`);
    assert(
      generation.sdkVersion === manifest.runner.sdkVersion,
      `${key} SDK mismatch.`,
    );
    assert(generation.agentId, `${key} has no agent ID.`);
    assert(generation.runId, `${key} has no run ID.`);
    assert(!agentIds.has(generation.agentId), `${key} reused an agent ID.`);
    assert(!runIds.has(generation.runId), `${key} reused a run ID.`);
    agentIds.add(generation.agentId);
    runIds.add(generation.runId);
    assert(generation.isolation?.freshAgent === true, `${key} was not fresh.`);
    assert(generation.isolation?.resumed === false, `${key} resumed an agent.`);
    assert(
      Array.isArray(generation.isolation?.settingSources) &&
        generation.isolation.settingSources.length === 0,
      `${key} loaded ambient setting sources.`,
    );
    assert(
      generation.isolation?.store === "per-arm-jsonl",
      `${key} did not use its own JSONL store.`,
    );
  }

  for (const [pairId, pair] of pairs) {
    assert(pair.control && pair.treatment, `${pairId} is missing an arm.`);
    assert(
      pair.control.skillInjected === false &&
        pair.treatment.skillInjected === true,
      `${pairId} has an invalid skill boundary.`,
    );
    assert(
      pair.control.promptSha256 !== pair.treatment.promptSha256,
      `${pairId} has identical treatment and control prompts.`,
    );
    assert(
      pair.treatment.promptCharacters > pair.control.promptCharacters,
      `${pairId} treatment did not add the skill bundle.`,
    );
    assert(
      JSON.stringify(pair.control.model) ===
        JSON.stringify(pair.treatment.model),
      `${pairId} used different model selections.`,
    );
  }

  process.stdout.write(
    `Validated ${pairs.size} isolated Cursor A/B ${
      pairs.size === 1 ? "pair" : "pairs"
    } with ${agentIds.size} unique agents and ${runIds.size} unique runs.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Isolation validation failed: ${error.message}\n`);
  process.exitCode = 1;
});
