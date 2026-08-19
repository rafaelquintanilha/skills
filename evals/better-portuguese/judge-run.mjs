#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const judgeInstructions = [
  "You are the blind editorial judge for a Brazilian Portuguese writing " +
    "benchmark. You do not know which output used the evaluated skill.",
  "For every pair, choose the version whose Portuguese you would rather " +
    "publish. Judge word choice, syntax, rhythm, cohesion, and fitness for " +
    "the requested artifact. Focus on the actual Portuguese, not on how " +
    "impressive the reasoning appears.",
  "This is an opinionated stylistic benchmark, not a factual-completeness " +
    "or reasoning benchmark. Do not reward an output for including more " +
    "facts or implementation details. Do not penalize an omission that the " +
    "requested length and artifact permit. Use the source primarily to " +
    "understand terminology, protected meaning, and explicit constraints. " +
    "Let a content issue affect the preference only when the output plainly " +
    "contradicts the source, invents a material claim, or fails the requested " +
    "artifact contract. A concrete defect in Portuguese syntax, agreement, " +
    "collocation, word order, or idiom outweighs a speculative concern about " +
    "what the source might imply.",
  "Rate A and B independently as publishable or not publishable unchanged. " +
    "A preferred output may still be unpublishable. Use Tie only when " +
    "neither version is materially better. Keep each reason concise and " +
    "specific, and write reasons in English. Return one rating for every " +
    "pair ID and no additional text.",
];

async function main() {
  const [runArgument, ...arguments_] = process.argv.slice(2);
  if (!runArgument) {
    throw new Error(
      "Usage: node evals/better-portuguese/judge-run.mjs <run-directory> " +
        "[--model <model>] [--reasoning <effort>]",
    );
  }

  const options = parseOptions(arguments_);
  const model = options.model ?? "gpt-5.6-sol";
  const reasoning = options.reasoning ?? "high";
  const runDirectory = resolve(runArgument);
  const manifest = await readJson(join(runDirectory, "manifest.json"));
  const key = await readJson(join(runDirectory, "key.json"));
  const cases = await loadCases(manifest, key);
  const expectedPairIds = key.pairs.map((pair) => pair.pairId);
  const prompt = await buildJudgePrompt(runDirectory, key, cases);
  const sessionDirectory = await mkdtemp(
    join(tmpdir(), "better-portuguese-judge-"),
  );

  try {
    const schemaPath = join(sessionDirectory, "ratings.schema.json");
    const outputPath = join(sessionDirectory, "ratings.json");
    await writeFile(
      schemaPath,
      `${JSON.stringify(ratingsSchema(expectedPairIds.length), null, 2)}\n`,
    );

    const result = await spawnCapture(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "-c",
        "skills.include_instructions=false",
        "--disable",
        "memories",
        "-m",
        model,
        "-c",
        `model_reasoning_effort="${reasoning}"`,
        "-s",
        "read-only",
        "-C",
        sessionDirectory,
        "--skip-git-repo-check",
        "--output-schema",
        schemaPath,
        "-o",
        outputPath,
        "-",
      ],
      prompt,
      { cwd: repoRoot },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Judge failed with exit code ${result.exitCode}:\n${result.stderr}`,
      );
    }

    const judged = JSON.parse(await readFile(outputPath, "utf8"));
    validateRatings(judged.ratings, expectedPairIds);
    const record = {
      schemaVersion: 1,
      reviewer: {
        runtime: "codex",
        model,
        reasoning,
        isolated: true,
        protocolSha256: sha256(judgeInstructions.join("\n")),
        scriptSha256: sha256(await readFile(scriptPath)),
      },
      blind: true,
      generatedAt: new Date().toISOString(),
      ratings: judged.ratings,
    };
    const destination = join(runDirectory, "ratings.auto.json");
    await writeFile(destination, `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(
      `Saved ${record.ratings.length} blind ratings to ${destination}\n`,
    );
  } finally {
    await rm(sessionDirectory, { recursive: true, force: true });
  }
}

async function loadCases(manifest, key) {
  const casePath = isAbsolute(manifest.caseFile)
    ? manifest.caseFile
    : resolve(repoRoot, manifest.caseFile);
  const suite = await readJson(casePath);
  const requestedIds = new Set(
    key.pairs.map((pair) => caseIdFromPairId(pair.pairId)),
  );
  const selected = suite.cases.filter((entry) => requestedIds.has(entry.id));
  if (selected.length !== requestedIds.size) {
    throw new Error("The run key and case file do not contain the same cases.");
  }

  return Promise.all(
    selected.map(async (entry) => ({
      ...entry,
      sources: await Promise.all(
        (entry.sources ?? []).map(async (specification) => {
          const source =
            typeof specification === "string"
              ? { path: specification }
              : specification;
          const path = isAbsolute(source.path)
            ? source.path
            : resolve(dirname(casePath), source.path);
          return {
            label: source.label ?? source.path,
            content: (await readFile(path, "utf8")).trim(),
          };
        }),
      ),
    })),
  );
}

async function buildJudgePrompt(runDirectory, key, cases) {
  const pairsByCase = new Map();
  for (const pair of key.pairs) {
    const caseId = caseIdFromPairId(pair.pairId);
    if (!pairsByCase.has(caseId)) {
      pairsByCase.set(caseId, []);
    }
    const [outputA, outputB] = await Promise.all([
      readFile(join(runDirectory, "raw", `${pair.pairId}.${pair.A}.txt`), "utf8"),
      readFile(join(runDirectory, "raw", `${pair.pairId}.${pair.B}.txt`), "utf8"),
    ]);
    if (!outputA.trim() || !outputB.trim()) {
      throw new Error(`${pair.pairId} contains an empty output.`);
    }
    pairsByCase.get(caseId).push({
      pairId: pair.pairId,
      A: outputA.trim(),
      B: outputB.trim(),
    });
  }

  const sections = [...judgeInstructions];

  for (const evalCase of cases) {
    sections.push(`\n# ${evalCase.id}\n\n## Task\n\n${evalCase.task}`);
    for (const source of evalCase.sources) {
      sections.push(
        `\n## Source material: ${source.label}\n\n${source.content}`,
      );
    }
    for (const pair of pairsByCase.get(evalCase.id) ?? []) {
      sections.push(
        `\n## ${pair.pairId}\n\n### Output A\n\n${pair.A}` +
          `\n\n### Output B\n\n${pair.B}`,
      );
    }
  }

  return `${sections.join("\n")}\n`;
}

function ratingsSchema(pairCount) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["ratings"],
    properties: {
      ratings: {
        type: "array",
        minItems: pairCount,
        maxItems: pairCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "pairId",
            "preferred",
            "publishableA",
            "publishableB",
            "reason",
          ],
          properties: {
            pairId: { type: "string" },
            preferred: { type: "string", enum: ["A", "B", "Tie"] },
            publishableA: { type: "boolean" },
            publishableB: { type: "boolean" },
            reason: { type: "string" },
          },
        },
      },
    },
  };
}

function validateRatings(ratings, expectedPairIds) {
  if (!Array.isArray(ratings)) {
    throw new Error("Judge output does not contain a ratings array.");
  }
  const expected = new Set(expectedPairIds);
  const received = new Set();
  for (const rating of ratings) {
    if (!expected.has(rating.pairId)) {
      throw new Error(`Unexpected pair ID from judge: ${rating.pairId}`);
    }
    if (received.has(rating.pairId)) {
      throw new Error(`Duplicate pair ID from judge: ${rating.pairId}`);
    }
    received.add(rating.pairId);
  }
  if (received.size !== expected.size) {
    const missing = [...expected].filter((pairId) => !received.has(pairId));
    throw new Error(`Judge omitted pairs: ${missing.join(", ")}`);
  }
}

function caseIdFromPairId(pairId) {
  return pairId.replace(/-\d{2}$/, "");
}

function parseOptions(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function spawnCapture(command, arguments_, input, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error) => {
  process.stderr.write(`Judge failed: ${error.message}\n`);
  process.exitCode = 1;
});
