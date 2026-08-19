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
      "Pass a Claude run manifest: " +
        "npm run eval:better-portuguese:validate-claude-isolation -- <path>",
    );
  }

  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  const runner = manifest.runner;
  assert(runner?.runtime === "claude", "Run is not a Claude CLI run.");
  assert(runner.cliVersion, "Claude CLI version was not recorded.");
  assert(
    runner.authentication?.authMethod === "claude.ai" &&
      runner.authentication?.apiProvider === "firstParty",
    "Run did not use first-party Claude subscription authentication.",
  );
  assert(
    runner.ambientUserCustomizations === false,
    "Ambient Claude user customizations were not disabled.",
  );
  assert(runner.tools === "none", "Claude tools were not disabled.");
  assert(
    runner.stateIsolation === "--no-session-persistence",
    "Claude session persistence was not disabled.",
  );

  const generations = Object.entries(manifest.generations ?? {});
  assert(generations.length > 0, "Manifest contains no generation metadata.");

  const sessionIds = new Set();
  const resolvedModels = new Set();
  const pairs = new Map();
  let totalCostUsd = 0;
  for (const [key, generation] of generations) {
    const match = key.match(/^(.*)\.(control|treatment)$/);
    assert(match, `Invalid generation key: ${key}`);
    const [, pairId, arm] = match;
    if (!pairs.has(pairId)) {
      pairs.set(pairId, {});
    }
    pairs.get(pairId)[arm] = generation;

    assert(generation.runtime === "claude", `${key} is not a Claude arm.`);
    assert(
      generation.cliVersion === runner.cliVersion,
      `${key} Claude CLI version mismatch.`,
    );
    assert(
      generation.requestedModel === runner.model,
      `${key} requested a different model.`,
    );
    assert(generation.effort === runner.effort, `${key} effort mismatch.`);
    assert(generation.status === "success", `${key} did not succeed.`);
    assert(generation.sessionId, `${key} has no session ID.`);
    assert(!sessionIds.has(generation.sessionId), `${key} reused a session ID.`);
    sessionIds.add(generation.sessionId);
    assert(
      generation.isolation?.safeMode === true,
      `${key} did not use safe mode.`,
    );
    assert(
      generation.isolation?.noSessionPersistence === true,
      `${key} allowed session persistence.`,
    );
    assert(
      generation.isolation?.tools === "none",
      `${key} allowed Claude tools.`,
    );
    assert(
      generation.isolation?.workspace === "per-arm-empty",
      `${key} did not use its own empty workspace.`,
    );
    assert(
      generation.isolation?.subscriptionOnly === true,
      `${key} did not record the subscription-only boundary.`,
    );
    assert(
      Number.isFinite(generation.totalCostUsd),
      `${key} has no equivalent cost accounting.`,
    );
    totalCostUsd += generation.totalCostUsd;
    for (const model of Object.keys(generation.modelUsage ?? {})) {
      resolvedModels.add(model);
    }
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
  }

  process.stdout.write(
    `Validated ${pairs.size} isolated Claude A/B ${
      pairs.size === 1 ? "pair" : "pairs"
    } with ${sessionIds.size} unique sessions.\n` +
      `Resolved models: ${[...resolvedModels].sort().join(", ") || "none"}.\n` +
      `Equivalent recorded cost: $${totalCostUsd.toFixed(6)}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Isolation validation failed: ${error.message}\n`);
  process.exitCode = 1;
});
