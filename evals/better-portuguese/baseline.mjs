#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "create") {
    await createBaseline(arguments_);
    return;
  }
  if (command === "compare") {
    await compareBaseline(arguments_);
    return;
  }
  throw new Error(
    "Usage:\n" +
      "  node evals/better-portuguese/baseline.mjs create " +
        "--output <file> <run>...\n" +
      "  node evals/better-portuguese/baseline.mjs compare " +
        "--baseline <file> <run>...",
  );
}

async function createBaseline(arguments_) {
  const { options, positional } = parseArguments(arguments_);
  if (!options.output || positional.length === 0) {
    throw new Error("create requires --output and at least one run.");
  }
  const campaignPath = resolve(
    options.campaign ?? "evals/better-portuguese/baseline-campaign.json",
  );
  const campaign = await readJson(campaignPath);
  const runs = await Promise.all(positional.map(loadRunSummary));
  validateCampaignRuns(campaign, runs);
  validateSharedCohort(runs);

  const baseline = {
    schemaVersion: 1,
    id: campaign.id,
    createdAt: new Date().toISOString(),
    campaign: {
      path: relativeToRepo(campaignPath),
      sha256: await fileSha256(campaignPath),
    },
    cohort: cohortRecord(runs[0]),
    skill: runs[0].skill,
    reviewer: runs[0].reviewer,
    models: Object.fromEntries(
      campaign.models.map((configuration) => {
        const fingerprint = fingerprintConfiguration(configuration);
        const run = runs.find(
          (candidate) => candidate.runnerFingerprint === fingerprint,
        );
        return [
          configuration.id,
          {
            runner: run.runner,
            runnerFingerprint: run.runnerFingerprint,
            manifestSha256: run.manifestSha256,
            results: run.results,
          },
        ];
      }),
    ),
  };
  const outputPath = resolve(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(baseline, null, 2)}\n`);
  const reportPath = outputPath.endsWith(".json")
    ? `${outputPath.slice(0, -5)}.md`
    : `${outputPath}.md`;
  await writeFile(reportPath, buildBaselineReport(baseline));
  process.stdout.write(
    `Created baseline ${baseline.id} at ${outputPath}\n` +
      `Human-readable report: ${reportPath}\n\n`,
  );
  printSummaryTable(baseline.models);
}

async function compareBaseline(arguments_) {
  const { options, positional } = parseArguments(arguments_);
  if (!options.baseline || positional.length === 0) {
    throw new Error("compare requires --baseline and at least one run.");
  }
  const baseline = await readJson(resolve(options.baseline));
  const runs = await Promise.all(positional.map(loadRunSummary));
  validateSharedCohort(runs);
  validateCandidateCohort(baseline, runs);

  const candidates = {};
  for (const run of runs) {
    const match = Object.entries(baseline.models).find(
      ([, model]) => model.runnerFingerprint === run.runnerFingerprint,
    );
    if (!match) {
      throw new Error(
        `No baseline model matches ${run.runnerFingerprint}.`,
      );
    }
    const [modelId, model] = match;
    candidates[modelId] = { baseline: model.results, candidate: run.results };
  }

  process.stdout.write(
    "| Model | Skill preference | Delta | Skill publishable | Delta |\n" +
      "|---|---:|---:|---:|---:|\n",
  );
  for (const [modelId, comparison] of Object.entries(candidates)) {
    const baselineResults = comparison.baseline.overall;
    const candidateResults = comparison.candidate.overall;
    process.stdout.write(
      `| ${modelId} | ${candidateResults.skillPreferred}/` +
        `${candidateResults.samples} | ` +
        `${signed(candidateResults.skillPreferred - baselineResults.skillPreferred)} | ` +
        `${candidateResults.skillPublishable}/${candidateResults.samples} | ` +
        `${signed(candidateResults.skillPublishable - baselineResults.skillPublishable)} |\n`,
    );
  }

  const regressions = [];
  for (const [modelId, comparison] of Object.entries(candidates)) {
    for (const [caseId, candidate] of Object.entries(
      comparison.candidate.cases,
    )) {
      const baselineCase = comparison.baseline.cases[caseId];
      const preferenceDelta =
        candidate.skillPreferred - baselineCase.skillPreferred;
      const publishableDelta =
        candidate.skillPublishable - baselineCase.skillPublishable;
      if (preferenceDelta < 0 || publishableDelta < 0) {
        regressions.push({
          modelId,
          caseId,
          preferenceDelta,
          publishableDelta,
        });
      }
    }
  }

  if (regressions.length === 0) {
    process.stdout.write("\nNo per-case decreases observed.\n");
    return;
  }
  process.stdout.write("\nPer-case decreases to review:\n\n");
  process.stdout.write("| Model | Case | Preference delta | Publishable delta |\n");
  process.stdout.write("|---|---|---:|---:|\n");
  for (const regression of regressions) {
    process.stdout.write(
      `| ${regression.modelId} | ${regression.caseId} | ` +
        `${signed(regression.preferenceDelta)} | ` +
        `${signed(regression.publishableDelta)} |\n`,
    );
  }
}

async function loadRunSummary(argument) {
  const runDirectory = resolve(argument);
  const manifestPath = resolve(runDirectory, "manifest.json");
  const manifest = await readJson(manifestPath);
  const key = await readJson(resolve(runDirectory, "key.json"));
  const expectedGenerationCount = key.pairs.length * 2;
  const generationCount = Object.keys(manifest.generations ?? {}).length;
  if (generationCount !== expectedGenerationCount) {
    throw new Error(
      `${runDirectory} has ${generationCount}/${expectedGenerationCount} ` +
        "generation records.",
    );
  }
  const ratingsPath = resolve(runDirectory, "ratings.auto.json");
  const ratingRecord = await readJson(ratingsPath);
  const ratings = ratingRecord.ratings;
  const expectedPairs = new Set(key.pairs.map((pair) => pair.pairId));
  if (
    ratings.length !== expectedPairs.size ||
    ratings.some((rating) => !expectedPairs.has(rating.pairId))
  ) {
    throw new Error(`${ratingsPath} does not cover the complete run.`);
  }

  const keyByPair = new Map(key.pairs.map((pair) => [pair.pairId, pair]));
  const results = emptyResults();
  for (const rating of ratings) {
    const pair = keyByPair.get(rating.pairId);
    const caseId = caseIdFromPairId(rating.pairId);
    const caseResults = (results.cases[caseId] ??= emptyCounts());
    const counts = [results.overall, caseResults];
    for (const count of counts) {
      count.samples += 1;
      if (rating.preferred === "Tie") {
        count.ties += 1;
      } else if (pair[rating.preferred] === "treatment") {
        count.skillPreferred += 1;
      } else {
        count.controlPreferred += 1;
      }

      const skillLabel = pair.A === "treatment" ? "A" : "B";
      const controlLabel = skillLabel === "A" ? "B" : "A";
      if (rating[`publishable${skillLabel}`]) {
        count.skillPublishable += 1;
      }
      if (rating[`publishable${controlLabel}`]) {
        count.controlPublishable += 1;
      }
    }
  }

  return {
    manifest,
    manifestSha256: await fileSha256(manifestPath),
    runner: runnerRecord(manifest.runner),
    runnerFingerprint: fingerprintRunner(manifest.runner),
    reviewer: ratingRecord.reviewer,
    skill: manifest.skill,
    caseIds: Object.keys(results.cases),
    caseSources: manifest.caseSources,
    caseFile: manifest.caseFile,
    repeat: manifest.repeat,
    results,
  };
}

function validateCampaignRuns(campaign, runs) {
  if (runs.length !== campaign.models.length) {
    throw new Error(
      `Expected ${campaign.models.length} runs, received ${runs.length}.`,
    );
  }
  const expectedCases = [...campaign.caseIds].sort();
  for (const run of runs) {
    if (run.repeat !== campaign.repeat) {
      throw new Error(
        `${run.runnerFingerprint} used repeat ${run.repeat}; ` +
          `expected ${campaign.repeat}.`,
      );
    }
    if (JSON.stringify([...run.caseIds].sort()) !== JSON.stringify(expectedCases)) {
      throw new Error(`${run.runnerFingerprint} used a different case cohort.`);
    }
  }
  const expectedRunners = new Set(
    campaign.models.map(fingerprintConfiguration),
  );
  const receivedRunners = new Set(runs.map((run) => run.runnerFingerprint));
  for (const fingerprint of expectedRunners) {
    if (!receivedRunners.has(fingerprint)) {
      throw new Error(`Missing configured runner: ${fingerprint}`);
    }
  }
}

function validateSharedCohort(runs) {
  const reference = cohortRecord(runs[0]);
  const skillHash = JSON.stringify(runs[0].skill.files);
  const reviewer = JSON.stringify(runs[0].reviewer);
  for (const run of runs.slice(1)) {
    if (JSON.stringify(cohortRecord(run)) !== JSON.stringify(reference)) {
      throw new Error("Runs do not share the same cases and source hashes.");
    }
    if (JSON.stringify(run.skill.files) !== skillHash) {
      throw new Error("Runs do not share the same skill hashes.");
    }
    if (JSON.stringify(run.reviewer) !== reviewer) {
      throw new Error("Runs were not rated by the same reviewer configuration.");
    }
  }
}

function validateCandidateCohort(baseline, runs) {
  for (const run of runs) {
    const cohort = cohortRecord(run);
    if (JSON.stringify(cohort) !== JSON.stringify(baseline.cohort)) {
      throw new Error(
        `${run.runnerFingerprint} does not match the baseline cohort.`,
      );
    }
    if (JSON.stringify(run.reviewer) !== JSON.stringify(baseline.reviewer)) {
      throw new Error(
        `${run.runnerFingerprint} used a different judge protocol.`,
      );
    }
  }
}

function cohortRecord(run) {
  return {
    caseFile: run.caseFile,
    repeat: run.repeat,
    caseIds: [...run.caseIds].sort(),
    caseSources: sortObject(run.caseSources),
  };
}

function runnerRecord(runner) {
  if (runner.runtime === "cursor") {
    return {
      runtime: "cursor",
      sdkVersion: runner.sdkVersion,
      model: runner.model,
      modelParams: sortObject(runner.modelParams),
    };
  }
  if (runner.runtime === "claude") {
    return {
      runtime: "claude",
      cliVersion: runner.cliVersion,
      model: runner.model,
      effort: runner.effort,
      systemPromptSha256: runner.systemPromptSha256,
    };
  }
  return {
    runtime: "codex",
    model: runner.model,
    reasoning: runner.reasoning,
  };
}

function fingerprintRunner(runner) {
  return JSON.stringify(runnerRecord(runner));
}

function fingerprintConfiguration(configuration) {
  if (configuration.runtime === "cursor") {
    return JSON.stringify({
      runtime: "cursor",
      sdkVersion: configuration.sdkVersion,
      model: configuration.model,
      modelParams: sortObject(configuration.modelParams),
    });
  }
  if (configuration.runtime === "claude") {
    return JSON.stringify({
      runtime: "claude",
      cliVersion: configuration.cliVersion,
      model: configuration.model,
      effort: configuration.effort,
      systemPromptSha256: configuration.systemPromptSha256,
    });
  }
  return JSON.stringify({
    runtime: "codex",
    model: configuration.model,
    reasoning: configuration.reasoning,
  });
}

function emptyResults() {
  return { overall: emptyCounts(), cases: {} };
}

function emptyCounts() {
  return {
    samples: 0,
    skillPreferred: 0,
    controlPreferred: 0,
    ties: 0,
    skillPublishable: 0,
    controlPublishable: 0,
  };
}

function printSummaryTable(models) {
  process.stdout.write(
    "| Model | Skill | Control | Tie | Skill publishable | Control publishable |\n" +
      "|---|---:|---:|---:|---:|---:|\n",
  );
  for (const [modelId, model] of Object.entries(models)) {
    const result = model.results.overall;
    process.stdout.write(
      `| ${modelId} | ${result.skillPreferred} | ` +
        `${result.controlPreferred} | ${result.ties} | ` +
        `${result.skillPublishable}/${result.samples} | ` +
        `${result.controlPublishable}/${result.samples} |\n`,
    );
  }
}

function buildBaselineReport(baseline) {
  const lines = [
    `# Better Portuguese ${baseline.id}`,
    "",
    "This baseline measures the relative effect of the Better Portuguese skill",
    "against an otherwise identical no-skill control. Each model generated five",
    "independent A/B pairs for every case in the fixed cohort.",
    "",
    "The blind judge rated preference and whether each arm was publishable",
    "unchanged. Preference is relative; publishability is an independent",
    "absolute editorial judgment.",
    "",
    "## Aggregate results",
    "",
    "| Model | Skill | Control | Tie | Skill publishable | Control publishable |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const [modelId, model] of Object.entries(baseline.models)) {
    const result = model.results.overall;
    lines.push(
      `| ${modelId} | ${result.skillPreferred} | ` +
        `${result.controlPreferred} | ${result.ties} | ` +
        `${result.skillPublishable}/${result.samples} | ` +
        `${result.controlPublishable}/${result.samples} |`,
    );
  }

  lines.push(
    "",
    "## Telegram cases",
    "",
    "| Model | Kimi preference | Kimi publishable | Cursor preference | Cursor publishable |",
    "|---|---:|---:|---:|---:|",
  );
  for (const [modelId, model] of Object.entries(baseline.models)) {
    const kimi = model.results.cases["video-telegram-kimi-k3"];
    const cursor = model.results.cases["video-telegram-cursor"];
    lines.push(
      `| ${modelId} | ${pairScore(kimi)} | ${publishableScore(kimi)} | ` +
        `${pairScore(cursor)} | ${publishableScore(cursor)} |`,
    );
  }

  const totals = {};
  for (const model of Object.values(baseline.models)) {
    for (const [caseId, result] of Object.entries(model.results.cases)) {
      const total = (totals[caseId] ??= emptyCounts());
      for (const key of Object.keys(total)) {
        total[key] += result[key];
      }
    }
  }
  lines.push(
    "",
    "## Cohort totals",
    "",
    "| Case | Skill | Control | Tie | Skill publishable | Control publishable |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const [caseId, result] of Object.entries(totals)) {
    lines.push(
      `| ${caseId} | ${result.skillPreferred} | ` +
        `${result.controlPreferred} | ${result.ties} | ` +
        `${result.skillPublishable}/${result.samples} | ` +
        `${result.controlPublishable}/${result.samples} |`,
    );
  }

  lines.push(
    "",
    "## Reproducibility",
    "",
    `- Campaign: \`${baseline.campaign.path}\``,
    `- Campaign SHA-256: \`${baseline.campaign.sha256}\``,
    `- Repetitions per case and model: ${baseline.cohort.repeat}`,
    `- Judge: \`${baseline.reviewer.model}\` at ` +
      `\`${baseline.reviewer.reasoning}\` reasoning`,
    `- Judge protocol SHA-256: \`${baseline.reviewer.protocolSha256}\``,
    `- Judge script SHA-256: \`${baseline.reviewer.scriptSha256}\``,
    "",
    "The JSON file beside this report contains runner fingerprints, per-case",
    "counts, source hashes, and skill-file hashes used by the regression",
    "comparison command.",
    "",
  );
  return lines.join("\n");
}

function pairScore(result) {
  return `${result.skillPreferred}-${result.controlPreferred}`;
}

function publishableScore(result) {
  return `${result.skillPublishable}-${result.controlPublishable}`;
}

function parseArguments(arguments_) {
  const options = {};
  const positional = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    options[name] = value;
    index += 1;
  }
  return { options, positional };
}

function caseIdFromPairId(pairId) {
  return pairId.replace(/-\d{2}$/, "");
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])]),
  );
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativeToRepo(path) {
  const absolute = isAbsolute(path) ? path : resolve(path);
  return absolute.startsWith(`${repoRoot}/`)
    ? absolute.slice(repoRoot.length + 1)
    : absolute;
}

main().catch((error) => {
  process.stderr.write(`Baseline error: ${error.message}\n`);
  process.exitCode = 1;
});
