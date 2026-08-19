#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { getEncoding } from "js-tiktoken";

const harnessPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(harnessPath), "../..");
const command = process.argv[2] ?? "help";
const args = parseArgs(process.argv.slice(3));
const skillRoot = resolveFromRepo(
  stringOption(args, "skill-path", "skills/better-portuguese"),
);
const skillFiles = {
  skill: join(skillRoot, "SKILL.md"),
  editorial: join(skillRoot, "references", "editorial-standard.md"),
  grammarAndStyle: join(
    skillRoot,
    "references",
    "grammar-and-style.md",
  ),
  punctuation: join(skillRoot, "references", "punctuation.md"),
};
const encodingName = "o200k_base";
const claudeSystemPrompt =
  "You are a writing assistant. Follow the user request and return only the " +
  "requested artifact, without analysis or commentary.";
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (open, close) => (value) =>
  useColor ? `\u001b[${open}m${value}\u001b[${close}m` : String(value);
const styles = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  cyan: paint(36, 39),
};

try {
  if (command === "help" || flagOption(args, "help")) {
    printHelp();
  } else if (command === "tokens") {
    await reportTokens(args);
  } else if (command === "models") {
    await reportModels(args);
  } else if (command === "run") {
    await runEval(args);
  } else if (command === "try") {
    await runPrompt(args);
  } else {
    printHelp();
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${styles.red("Error:")} ${error.message}\n`);
  process.exitCode = 1;
}

async function runPrompt(options) {
  const skillMode = stringOption(options, "skill", "on").toLowerCase();
  if (!["on", "off", "both"].includes(skillMode)) {
    throw new Error("--skill must be on, off, or both.");
  }
  const load = stringOption(options, "load", "sentence").toLowerCase();
  if (!["short", "sentence"].includes(load)) {
    throw new Error("--load must be short or sentence.");
  }

  const prompt = await readAdHocPrompt(options);
  const contents = await readSkillFiles();
  const sessionDir = await mkdtemp(join(tmpdir(), "better-portuguese-try-"));

  try {
    const runner = await createAdHocRunner({
      options,
      contents,
      sessionDir,
    });
    const evalCase = {
      id: "ad-hoc",
      task: prompt,
      sources: [],
      load,
    };
    const arms =
      skillMode === "both"
        ? ["treatment", "control"]
        : [skillMode === "on" ? "treatment" : "control"];
    const jobs = arms.map((arm) => ({
      evalCase,
      repetition: 1,
      arm,
      pairId: "ad-hoc-01",
    }));
    const generate = () =>
      runPool(jobs, jobs.length, (job) => runner.run(job));
    const results =
      process.stdout.isTTY
        ? await withSpinner(
            skillMode === "both"
              ? "Generating both versions"
              : `Generating with skill ${skillMode}`,
            generate,
          )
        : await generate();

    process.stdout.write(
      `\n${styles.bold("Better Portuguese")} ${styles.dim("ad-hoc prompt")}\n`,
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const arm = arms[index];
      const label =
        arm === "treatment"
          ? "Skill on · Better Portuguese"
          : "Skill off · Control";
      if (result.exitCode !== 0) {
        printSection(label, "Generation failed.");
        process.stderr.write(`${result.log.trim()}\n`);
        process.exitCode = 1;
      } else {
        printSection(label, result.output);
      }
    }
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
}

async function createAdHocRunner({ options, contents, sessionDir }) {
  const runtime = runtimeOption(options);
  const model = stringOption(options, "model", defaultModel(runtime));
  const passthrough = options.passthrough ?? [];
  if (runtime !== "codex" && passthrough.length > 0) {
    throw new Error(
      "Arguments after -- are supported only by the Codex runtime.",
    );
  }
  if (runtime === "cursor") {
    const cwd = resolve(stringOption(options, "cwd", repoRoot));
    const modelParams = modelParamsOption(options);
    const cursor = await cursorRuntime();
    return {
      async run(job) {
        const stem = `${job.pairId}.${job.arm}`;
        const store = join(sessionDir, "cursor-stores", stem);
        const prompt = buildAdHocPrompt(
          job.evalCase.task,
          job.arm,
          contents,
          job.evalCase.load,
        );
        return runCursorArm({
          cursor,
          cwd,
          store,
          model,
          modelParams,
          prompt,
          arm: job.arm,
        });
      },
    };
  }

  if (runtime === "claude") {
    const effort = claudeEffortOption(options);
    const claude = await claudeRuntime(options);
    return {
      async run(job) {
        const stem = `${job.pairId}.${job.arm}`;
        const cwd = join(sessionDir, "claude-workspaces", stem);
        await mkdir(cwd, { recursive: true });
        const prompt = buildAdHocPrompt(
          job.evalCase.task,
          job.arm,
          contents,
          job.evalCase.load,
        );
        return runClaudeArm({
          claude,
          cwd,
          model,
          effort,
          prompt,
          arm: job.arm,
        });
      },
    };
  }

  const reasoning = stringOption(options, "reasoning", "medium");
  const codex = stringOption(options, "codex", "codex");
  const suppliesModel = hasCodexOption(passthrough, "-m", "--model");
  const suppliesSandbox = hasCodexOption(passthrough, "-s", "--sandbox");
  const suppliesCwd = hasCodexOption(passthrough, "-C", "--cd");

  return {
    async run(job) {
      const outputPath = join(sessionDir, `${job.arm}.txt`);
      const prompt = buildAdHocPrompt(
        job.evalCase.task,
        job.arm,
        contents,
        job.evalCase.load,
      );
      const codexArgs = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--strict-config",
        "-c",
        "skills.include_instructions=false",
        "--disable",
        "memories",
        ...(suppliesModel ? [] : ["-m", model]),
        "-c",
        `model_reasoning_effort="${reasoning}"`,
        ...(suppliesSandbox ? [] : ["-s", "read-only"]),
        ...(suppliesCwd ? [] : ["-C", repoRoot]),
        "--skip-git-repo-check",
        ...passthrough,
        "-o",
        outputPath,
        prompt,
      ];
      const result = await spawnCapture(codex, codexArgs, "", {
        cwd: repoRoot,
        env: process.env,
      });
      let output = "";
      try {
        output = (await readFile(outputPath, "utf8")).trim();
      } catch {
        output = result.stdout.trim();
      }
      return {
        output,
        log: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        exitCode: result.exitCode,
      };
    },
  };
}

function hasCodexOption(args, shortName, longName) {
  return args.some(
    (argument) =>
      argument === shortName ||
      argument === longName ||
      argument.startsWith(`${longName}=`),
  );
}

function buildAdHocPrompt(prompt, arm, contents, load) {
  if (arm === "control") {
    return prompt;
  }
  const bundle = buildSkillBundle(contents, load);
  return (
    `Apply the following Agent Skill and references as binding editorial ` +
    `instructions when completing the user request. Perform any source ` +
    `inspection required by the skill, then complete its separate draft and ` +
    `editorial-review passes before returning the final artifact.\n\n` +
    `${bundle}\n\n` +
    `--- USER REQUEST ---\n${prompt}`
  );
}

async function readAdHocPrompt(options) {
  const inline = options.prompt;
  const file = options.file;
  if (inline !== undefined && file !== undefined) {
    throw new Error("Use either --prompt or --file, not both.");
  }
  if (file !== undefined) {
    const contents = (await readFile(resolveFromRepo(String(file)), "utf8")).trim();
    if (!contents) {
      throw new Error("--file must contain a prompt.");
    }
    return contents;
  }
  if (inline !== undefined) {
    const value = String(inline).trim();
    if (!value) {
      throw new Error("--prompt must not be empty.");
    }
    return value;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Provide --prompt or --file when no terminal is attached.");
  }

  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const value = (
      await terminal.question(`${styles.bold("Prompt")}: `)
    ).trim();
    if (!value) {
      throw new Error("Prompt must not be empty.");
    }
    return value;
  } finally {
    terminal.close();
  }
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--") {
      parsed.passthrough = argv.slice(index + 1);
      break;
    }
    if (!item.startsWith("--")) {
      parsed._.push(item);
      continue;
    }

    const equalsAt = item.indexOf("=");
    if (equalsAt !== -1) {
      setOption(
        parsed,
        item.slice(2, equalsAt),
        item.slice(equalsAt + 1),
      );
      continue;
    }

    const name = item.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      setOption(parsed, name, true);
    } else {
      setOption(parsed, name, next);
      index += 1;
    }
  }
  return parsed;
}

function setOption(parsed, name, value) {
  if (name !== "model-param") {
    parsed[name] = value;
    return;
  }
  const existing = parsed[name];
  parsed[name] =
    existing === undefined
      ? [value]
      : [...(Array.isArray(existing) ? existing : [existing]), value];
}

async function reportModels(options) {
  const runtime = runtimeOption(options, "cursor");
  if (runtime !== "cursor") {
    throw new Error("Model discovery is available for the Cursor runtime.");
  }
  const cursor = await cursorRuntime();
  const { Cursor } = await import("@cursor/sdk");
  const models = await Cursor.models.list({
    apiKey: cursor.env.CURSOR_API_KEY,
  });
  const query = stringOption(options, "filter", "").toLowerCase();
  const selected = models.filter((model) => {
    if (!query) {
      return true;
    }
    return [model.id, model.displayName, ...(model.aliases ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  if (selected.length === 0) {
    throw new Error(`No Cursor models matched: ${query}`);
  }

  process.stdout.write(
    `${styles.bold("Cursor models")} ${styles.dim(`SDK ${cursor.sdkVersion}`)}\n\n`,
  );
  for (const model of selected) {
    const parameters = (model.parameters ?? [])
      .map((parameter) => {
        const values = parameter.values.map((entry) => entry.value).join("|");
        return `${parameter.id}=${values}`;
      })
      .join(", ");
    process.stdout.write(`${styles.cyan(model.id)}  ${model.displayName}\n`);
    if (parameters) {
      process.stdout.write(`  ${styles.dim(parameters)}\n`);
    }
  }
}

async function reportTokens(options) {
  const report = await buildTokenReport();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const rows = [
    ["Catalog frontmatter", report.catalogFrontmatter.tokens],
    ["SKILL.md", report.files.skill.tokens],
    ["Editorial standard", report.files.editorial.tokens],
    ["Grammar and style reference", report.files.grammarAndStyle.tokens],
    ["Punctuation reference", report.files.punctuation.tokens],
    ["Loaded: short artifact", report.loaded.short.tokens],
    ["Loaded: sentence-level prose", report.loaded.sentence.tokens],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));

  process.stdout.write(`Encoding: ${report.encoding}\n`);
  for (const [label, tokens] of rows) {
    process.stdout.write(`${label.padEnd(labelWidth)}  ${tokens}\n`);
  }
  process.stdout.write(
    "\nCounts cover repository file contents only. Agent wrappers, paths, and " +
      "catalog serialization add environment-specific overhead.\n",
  );
}

async function buildTokenReport() {
  const contents = await readSkillFiles();
  const encoder = getEncoding(encodingName);
  const count = (text) => encoder.encode(text).length;
  const frontmatter = extractFrontmatter(contents.skill);
  const files = {
    skill: metrics(contents.skill, count),
    editorial: metrics(contents.editorial, count),
    grammarAndStyle: metrics(contents.grammarAndStyle, count),
    punctuation: metrics(contents.punctuation, count),
  };

  return {
    encoding: encodingName,
    catalogFrontmatter: metrics(frontmatter, count),
    files,
    loaded: {
      short: combineMetrics([files.skill, files.editorial]),
      sentence: combineMetrics([
        files.skill,
        files.punctuation,
        files.grammarAndStyle,
        files.editorial,
      ]),
    },
  };
}

function metrics(text, count) {
  return {
    tokens: count(text),
    characters: [...text].length,
    bytes: Buffer.byteLength(text),
  };
}

function combineMetrics(entries) {
  return entries.reduce(
    (total, entry) => ({
      tokens: total.tokens + entry.tokens,
      characters: total.characters + entry.characters,
      bytes: total.bytes + entry.bytes,
    }),
    { tokens: 0, characters: 0, bytes: 0 },
  );
}

function extractFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error("SKILL.md does not contain YAML frontmatter.");
  }
  return match[0];
}

async function runEval(options) {
  const mode = stringOption(options, "mode", "injected");
  if (!["injected", "external"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  const interactive = !flagOption(options, "batch");
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      "Interactive review requires a terminal. Use --batch for an " +
        "unattended run.",
    );
  }

  const casePath = resolveFromRepo(
    stringOption(options, "cases", "evals/better-portuguese/cases.json"),
  );
  const suite = JSON.parse(await readFile(casePath, "utf8"));
  const selectedIds = new Set(
    stringOption(options, "ids", "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const selectedCases = suite.cases.filter(
    (entry) => selectedIds.size === 0 || selectedIds.has(entry.id),
  );
  if (selectedCases.length === 0) {
    throw new Error("No eval cases matched the requested selection.");
  }
  const cases = await Promise.all(
    selectedCases.map((entry) => loadEvalCase(entry, casePath)),
  );

  const repeat = integerOption(options, "repeat", 1);
  const concurrency = integerOption(options, "concurrency", 2);
  const seed = stringOption(options, "seed", randomBytes(8).toString("hex"));
  const runId = new Date().toISOString().replaceAll(":", "-");
  const outputDir = resolveFromRepo(
    stringOption(
      options,
      "output",
      join("evals", "better-portuguese", "runs", runId),
    ),
  );
  const rawDir = join(outputDir, "raw");
  await mkdir(rawDir, { recursive: true });

  const contents = await readSkillFiles();
  const neutralDir =
    mode === "injected"
      ? await mkdtemp(join(tmpdir(), "better-portuguese-eval-"))
      : null;
  const runner = await createRunner({
    mode,
    options,
    contents,
    neutralDir,
    rawDir,
    runId,
  });
  const jobs = [];

  for (const evalCase of cases) {
    validateCase(evalCase);
    for (let repetition = 1; repetition <= repeat; repetition += 1) {
      for (const arm of ["control", "treatment"]) {
        jobs.push({
          evalCase,
          repetition,
          arm,
          pairId: `${evalCase.id}-${String(repetition).padStart(2, "0")}`,
        });
      }
    }
  }

  const pairCount = cases.length * repeat;
  const startedAt = new Date().toISOString();
  const runJob = async (job) => {
    const result = await runner.run(job);
    const stem = `${job.pairId}.${job.arm}`;
    await writeFile(join(rawDir, `${stem}.txt`), result.output);
    await writeFile(join(rawDir, `${stem}.log`), result.log);
    if (result.metadata) {
      await writeFile(
        join(rawDir, `${stem}.runtime.json`),
        `${JSON.stringify(result.metadata, null, 2)}\n`,
      );
    }
    return { ...job, ...result };
  };
  let results = [];
  let ratings = [];
  try {
    if (interactive) {
      printInteractiveIntro({
        pairCount,
        mode,
        runner: runner.manifest,
        outputDir,
      });
      ({ results, ratings } = await runInteractiveReview({
        jobs,
        pairCount,
        concurrency,
        seed,
        outputDir,
        runJob,
      }));
    } else {
      printBatchIntro({ pairCount, mode, runner: runner.manifest, outputDir });
      const reportProgress = createPairProgress(pairCount);
      results = await runPool(jobs, concurrency, async (job) => {
        const result = await runJob(job);
        reportProgress(result);
        return result;
      });
    }
  } finally {
    if (neutralDir) {
      await rm(neutralDir, { recursive: true, force: true });
    }
  }

  const tokenReport = await buildTokenReport();
  const manifest = {
    schemaVersion: 2,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    mode,
    caseFile: relativeToRepo(casePath),
    caseCount: cases.length,
    repeat,
    concurrency,
    seed,
    reviewMode: interactive ? "interactive" : "batch",
    caseSources: buildCaseSourceManifest(cases),
    skill: {
      files: await skillFileManifest(contents),
      tokens: tokenReport,
    },
    runner: runner.manifest,
    generations: buildGenerationManifest(results),
  };
  const { review, key } = buildBlindArtifacts({
    cases,
    repeat,
    seed,
    results,
    ratings,
  });

  await writeFile(
    join(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(join(outputDir, "review.md"), review);
  await writeFile(
    join(outputDir, "key.json"),
    `${JSON.stringify(key, null, 2)}\n`,
  );
  await chmod(join(outputDir, "key.json"), 0o600);
  if (interactive) {
    await writeRatings(outputDir, ratings, pairCount, true);
  }

  const failed = results.filter((result) => result.exitCode !== 0);
  if (interactive) {
    printInteractiveSummary({ ratings, key, outputDir, failed });
  } else {
    process.stdout.write("\nRun complete.\n");
    process.stdout.write(`Run: ${relativeToRepo(outputDir)}\n`);
    process.stdout.write(`Pairs: ${pairCount}\n`);
    process.stdout.write(
      `Review: ${relativeToRepo(join(outputDir, "review.md"))}\n`,
    );
    process.stdout.write(`Key: ${relativeToRepo(join(outputDir, "key.json"))}\n`);
  }
  if (failed.length > 0) {
    process.stdout.write(`Failed arms: ${failed.length}\n`);
    process.exitCode = 1;
  }
}

async function runInteractiveReview({
  jobs,
  pairCount,
  concurrency,
  seed,
  outputDir,
  runJob,
}) {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const results = [];
  const ratings = [];

  try {
    for (let index = 0; index < jobs.length; index += 2) {
      const pairJobs = jobs.slice(index, index + 2);
      const pairNumber = index / 2 + 1;
      const pairId = pairJobs[0].pairId;
      const pairResults = await withSpinner(
        `Generating case ${pairNumber} of ${pairCount}`,
        () => runPool(pairJobs, Math.min(concurrency, 2), runJob),
      );
      results.push(...pairResults);

      const labels = blindLabels(seed, pairId);
      const pair = Object.fromEntries(
        pairResults.map((result) => [result.arm, result]),
      );
      if (outputsAreIdentical(pair)) {
        printIdenticalPair({
          pairNumber,
          pairCount,
          pairId,
          evalCase: pairJobs[0].evalCase,
          output: pair.control.output,
        });
        const rating = {
          pairId,
          preferred: "Tie",
          reason: "",
          automatic: "identical",
        };
        ratings.push(rating);
        await writeRatings(outputDir, ratings, pairCount, false);
        process.stdout.write(
          `${styles.green("Recorded automatically")} Both runs produced ` +
            `this exact output.\n\n`,
        );
        continue;
      }
      printPair({
        pairNumber,
        pairCount,
        pairId,
        evalCase: pairJobs[0].evalCase,
        labels,
        pair,
      });
      const rating = await promptForRating(terminal, pairId);
      ratings.push(rating);
      await writeRatings(outputDir, ratings, pairCount, false);
      process.stdout.write(
        `${styles.green("Recorded")} ${formatDecision(rating)}\n`,
      );
      printReveal(labels, rating);
      process.stdout.write("\n");
    }
  } finally {
    terminal.close();
  }

  return { results, ratings };
}

function printInteractiveIntro({ pairCount, mode, runner, outputDir }) {
  process.stdout.write(
    `\n${styles.bold("Better Portuguese")} ${styles.dim("blind A/B review")}\n\n`,
  );
  process.stdout.write(
    `${pairCount} ${pairCount === 1 ? "case" : "cases"} · ` +
      `${runner.model ?? mode} · ${styles.dim(relativeToRepo(outputDir))}\n`,
  );
  process.stdout.write(
    "Choose the Portuguese you would rather publish. Each case compares the " +
      "same prompt with and without the skill; the order stays hidden until " +
      "you record your choice.\n",
  );
  process.stdout.write(
    `${styles.dim("Exact matches are recorded automatically as ties.")}\n\n`,
  );
  process.stdout.write(
    `${styles.dim("Each decision is saved as soon as it is recorded.")}\n\n`,
  );
}

function printBatchIntro({ pairCount, mode, runner, outputDir }) {
  process.stdout.write(
    `Running ${pairCount} blind A/B ${pairCount === 1 ? "pair" : "pairs"} ` +
      `with ${runner.model ?? mode}.\n`,
  );
  process.stdout.write(`Output: ${relativeToRepo(outputDir)}\n\n`);
}

function createPairProgress(pairCount) {
  const completedArms = new Map();
  let completedPairs = 0;

  return (result) => {
    const count = (completedArms.get(result.pairId) ?? 0) + 1;
    completedArms.set(result.pairId, count);
    if (count === 2) {
      completedPairs += 1;
      process.stdout.write(
        `[${completedPairs}/${pairCount}] Generated ${result.pairId}\n`,
      );
    }
  };
}

async function withSpinner(message, work) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  const startedAt = Date.now();
  const render = () => {
    process.stdout.write(
      `\r\u001b[2K${styles.cyan(frames[frame])} ${message}…`,
    );
    frame = (frame + 1) % frames.length;
  };

  render();
  const timer = setInterval(render, 80);
  try {
    const result = await work();
    clearInterval(timer);
    const elapsed = formatDuration(Date.now() - startedAt);
    process.stdout.write(
      `\r\u001b[2K${styles.green("✓")} ${message} ${styles.dim(elapsed)}\n`,
    );
    return result;
  } catch (error) {
    clearInterval(timer);
    process.stdout.write(
      `\r\u001b[2K${styles.red("×")} ${message} ${styles.red("failed")}\n`,
    );
    throw error;
  }
}

function printPair({
  pairNumber,
  pairCount,
  pairId,
  evalCase,
  labels,
  pair,
}) {
  process.stdout.write(
    `\n${styles.bold(`Case ${pairNumber} of ${pairCount}`)} ` +
      `${styles.dim(pairId)}\n`,
  );
  printCaseContext(evalCase);
  for (const label of ["A", "B"]) {
    const result = pair[labels[label]];
    const output =
      result?.output ||
      styles.red("No output was produced. See the run log for details.");
    printSection(`Output ${label}`, output);
  }
}

function printIdenticalPair({
  pairNumber,
  pairCount,
  pairId,
  evalCase,
  output,
}) {
  process.stdout.write(
    `\n${styles.bold(`Case ${pairNumber} of ${pairCount}`)} ` +
      `${styles.dim(pairId)}\n`,
  );
  printCaseContext(evalCase);
  printSection("Identical output", output);
}

function printCaseContext(evalCase) {
  printSection("Task", evalCase.task);
  for (const source of evalCase.sources) {
    if (source.review === "reference") {
      printSection(
        `Source · ${source.label}`,
        `Reference: ${relativeToRepo(source.path)}`,
      );
    } else {
      printSection(`Source · ${source.label}`, source.content);
    }
  }
}

function outputsAreIdentical(pair) {
  return (
    pair?.control?.exitCode === 0 &&
    pair?.treatment?.exitCode === 0 &&
    pair.control.output === pair.treatment.output
  );
}

function printSection(title, body) {
  process.stdout.write(`\n${styles.cyan(styles.bold(title))}\n`);
  process.stdout.write(`${indent(body.trim(), "  ")}\n`);
}

async function promptForRating(terminal, pairId) {
  const preferred = await askChoice(
    terminal,
    "Which would you publish?",
    {
      a: "A",
      b: "B",
      t: "Tie",
      tie: "Tie",
    },
    "A / B / Tie",
  );

  const reason = (
    await terminal.question(`${styles.bold("Reason")} ${styles.dim("(optional)")}: `)
  ).trim();
  return { pairId, preferred, reason };
}

async function askChoice(terminal, label, choices, hint) {
  while (true) {
    const answer = (
      await terminal.question(
        `${styles.bold(label)} ${styles.dim(`[${hint}]`)}: `,
      )
    )
      .trim()
      .toLowerCase();
    if (Object.hasOwn(choices, answer)) {
      return choices[answer];
    }
    process.stdout.write(`${styles.yellow(`Enter ${hint}.`)}\n`);
  }
}

async function writeRatings(outputDir, ratings, pairCount, completed) {
  await writeFile(
    join(outputDir, "ratings.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        completed: completed && ratings.length === pairCount,
        reviewedPairs: ratings.length,
        pairCount,
        ratings,
      },
      null,
      2,
    )}\n`,
  );
}

function printInteractiveSummary({ ratings, key, outputDir, failed }) {
  const score = {
    treatment: 0,
    control: 0,
    ties: 0,
    identical: 0,
  };
  const keyByPair = new Map(key.pairs.map((pair) => [pair.pairId, pair]));
  for (const rating of ratings) {
    if (rating.automatic === "identical") {
      score.identical += 1;
      continue;
    }
    if (rating.preferred === "Tie") {
      score.ties += 1;
      continue;
    }
    const arm = keyByPair.get(rating.pairId)[rating.preferred];
    score[arm] += 1;
  }

  process.stdout.write(`\n${styles.green(styles.bold("Result"))}\n\n`);
  process.stdout.write(`Skill preferred     ${score.treatment}\n`);
  process.stdout.write(`Control preferred   ${score.control}\n`);
  process.stdout.write(`Stylistic ties      ${score.ties}\n`);
  process.stdout.write(`Identical outputs   ${score.identical}\n`);
  if (failed.length > 0) {
    process.stdout.write(`Failed generations  ${failed.length}\n`);
  }
  process.stdout.write(`\n${interpretScore(score)}\n`);
  process.stdout.write(
    `\nSaved to ${styles.cyan(relativeToRepo(outputDir))}\n`,
  );
}

function formatDecision(rating) {
  return rating.preferred;
}

function printReveal(labels, rating) {
  const names = {
    control: "Control",
    treatment: "Better Portuguese",
  };
  process.stdout.write(
    `${styles.dim("Reveal")} A = ${names[labels.A]} · ` +
      `B = ${names[labels.B]}\n`,
  );
  if (rating.preferred === "Tie") {
    process.stdout.write("You chose a tie.\n");
    return;
  }
  process.stdout.write(
    `You preferred ${styles.bold(names[labels[rating.preferred]])}.\n`,
  );
}

function interpretScore(score) {
  if (score.treatment > score.control) {
    return (
      `The skill was preferred more often in this run ` +
      `(${score.treatment} to ${score.control}).`
    );
  }
  if (score.control > score.treatment) {
    return (
      `The control was preferred more often in this run ` +
      `(${score.control} to ${score.treatment}).`
    );
  }
  if (score.treatment === 0) {
    return "This run produced no directional preference.";
  }
  return (
    `This run found no preference between the skill and control ` +
    `(${score.treatment} to ${score.control}).`
  );
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

async function createRunner({
  mode,
  options,
  contents,
  neutralDir,
  rawDir,
  runId,
}) {
  if (mode === "external") {
    const controlAdapter = requiredPathOption(options, "control-adapter");
    const treatmentAdapter = requiredPathOption(options, "treatment-adapter");
    await assertExecutable(controlAdapter);
    await assertExecutable(treatmentAdapter);

    return {
      manifest: {
        controlAdapter: await adapterManifest(controlAdapter),
        treatmentAdapter: await adapterManifest(treatmentAdapter),
      },
      async run(job) {
        const adapter =
          job.arm === "control" ? controlAdapter : treatmentAdapter;
        const result = await spawnCapture(
          adapter,
          [],
          `${buildCasePrompt(job.evalCase)}\n`,
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              BETTER_PORTUGUESE_ARM: job.arm,
              BETTER_PORTUGUESE_CASE_ID: job.evalCase.id,
              BETTER_PORTUGUESE_REPEAT: String(job.repetition),
              BETTER_PORTUGUESE_RUN_ID: runId,
            },
          },
        );
        return {
          output: result.stdout.trim(),
          log: result.stderr,
          exitCode: result.exitCode,
        };
      },
    };
  }

  const runtime = runtimeOption(options);
  const model = stringOption(options, "model", defaultModel(runtime));
  if (runtime === "cursor") {
    const modelParams = modelParamsOption(options);
    const cursor = await cursorRuntime();
    return {
      manifest: {
        runtime,
        command: "node evals/better-portuguese/cursor-agent-runner.mjs",
        sdkVersion: cursor.sdkVersion,
        model,
        modelParams,
        ambientSettingSources: [],
        sandbox: true,
        processIsolation: "one child process per arm",
        workspaceIsolation: "one empty workspace per arm",
        stateIsolation: "one JsonlLocalAgentStore per arm",
        treatment: "Skill files injected into the prompt.",
      },
      async run(job) {
        const stem = `${job.pairId}.${job.arm}`;
        const cwd = join(neutralDir, "workspaces", stem);
        const store = join(neutralDir, "cursor-stores", stem);
        await Promise.all([
          mkdir(cwd, { recursive: true }),
          mkdir(store, { recursive: true }),
        ]);
        const prompt = buildInjectedPrompt(job.evalCase, job.arm, contents);
        return runCursorArm({
          cursor,
          cwd,
          store,
          model,
          modelParams,
          prompt,
          arm: job.arm,
        });
      },
    };
  }

  if (runtime === "claude") {
    const effort = claudeEffortOption(options);
    const claude = await claudeRuntime(options);
    return {
      manifest: {
        runtime,
        command: claude.command,
        cliVersion: claude.cliVersion,
        model,
        effort,
        systemPromptSha256: sha256(claudeSystemPrompt),
        authentication: claude.authentication,
        ambientUserCustomizations: false,
        tools: "none",
        processIsolation: "one child process per arm",
        workspaceIsolation: "one empty workspace per arm",
        stateIsolation: "--no-session-persistence",
        treatment: "Skill files injected into the prompt.",
      },
      async run(job) {
        const stem = `${job.pairId}.${job.arm}`;
        const cwd = join(neutralDir, "claude-workspaces", stem);
        await mkdir(cwd, { recursive: true });
        const prompt = buildInjectedPrompt(job.evalCase, job.arm, contents);
        return runClaudeArm({
          claude,
          cwd,
          model,
          effort,
          prompt,
          arm: job.arm,
        });
      },
    };
  }

  const reasoning = stringOption(options, "reasoning", "medium");
  const codex = stringOption(options, "codex", "codex");

  return {
    manifest: {
      runtime,
      command: codex,
      model,
      reasoning,
      ambientSkillInstructions: false,
      treatment: "Skill files injected into the prompt.",
    },
    async run(job) {
      const outputPath = join(
        rawDir,
        `${job.pairId}.${job.arm}.last-message.txt`,
      );
      const prompt = buildInjectedPrompt(job.evalCase, job.arm, contents);
      const codexArgs = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
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
        neutralDir,
        "--skip-git-repo-check",
        "-o",
        outputPath,
        prompt,
      ];
      const result = await spawnCapture(codex, codexArgs, "", {
        cwd: repoRoot,
        env: process.env,
      });
      let output = "";
      try {
        output = (await readFile(outputPath, "utf8")).trim();
      } catch {
        output = result.stdout.trim();
      }
      return {
        output,
        log: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        exitCode: result.exitCode,
        metadata: {
          runtime: "codex",
          model,
          reasoning,
          promptSha256: sha256(prompt),
          promptCharacters: [...prompt].length,
          skillInjected: job.arm === "treatment",
          isolation: {
            ephemeral: true,
            ambientSkillInstructions: false,
            memories: false,
            userConfig: false,
            rules: false,
            sandbox: "read-only",
          },
        },
      };
    },
  };
}

async function runCursorArm({
  cursor,
  cwd,
  store,
  model,
  modelParams,
  prompt,
  arm,
}) {
  const result = await spawnCapture(
    process.execPath,
    [
      cursor.runner,
      "--cwd",
      cwd,
      "--store",
      store,
      "--model",
      model,
      "--params",
      JSON.stringify(modelParams),
    ],
    prompt,
    {
      cwd: repoRoot,
      env: cursor.env,
    },
  );
  let record;
  try {
    record = parseLastJsonObject(result.stdout);
  } catch (error) {
    return {
      output: "",
      log: [result.stdout, result.stderr, error.message]
        .filter(Boolean)
        .join("\n"),
      exitCode: result.exitCode || 1,
    };
  }
  return {
    output: String(record.result ?? "").trim(),
    log: result.stderr,
    exitCode: result.exitCode,
    metadata: {
      runtime: "cursor",
      sdkVersion: cursor.sdkVersion,
      agentId: record.agentId,
      runId: record.runId,
      status: record.status,
      model: record.model,
      usage: record.usage,
      isolation: record.isolation,
      promptSha256: sha256(prompt),
      promptCharacters: [...prompt].length,
      skillInjected: arm === "treatment",
    },
  };
}

async function runClaudeArm({
  claude,
  cwd,
  model,
  effort,
  prompt,
  arm,
}) {
  const result = await spawnCapture(
    claude.command,
    [
      "-p",
      "--safe-mode",
      "--no-session-persistence",
      "--no-chrome",
      "--disable-slash-commands",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--model",
      model,
      "--effort",
      effort,
      "--system-prompt",
      claudeSystemPrompt,
      "--output-format",
      "json",
    ],
    prompt,
    {
      cwd,
      env: claude.env,
    },
  );
  let record;
  try {
    record = parseLastJsonObject(result.stdout);
  } catch (error) {
    return {
      output: "",
      log: [result.stdout, result.stderr, error.message]
        .filter(Boolean)
        .join("\n"),
      exitCode: result.exitCode || 1,
    };
  }
  const failed = result.exitCode !== 0 || record.is_error === true;
  return {
    output: failed ? "" : String(record.result ?? "").trim(),
    log: [result.stderr, failed ? JSON.stringify(record) : ""]
      .filter(Boolean)
      .join("\n"),
    exitCode: failed ? result.exitCode || 1 : 0,
    metadata: {
      runtime: "claude",
      cliVersion: claude.cliVersion,
      requestedModel: model,
      effort,
      sessionId: record.session_id,
      status: record.subtype,
      stopReason: record.stop_reason,
      numTurns: record.num_turns,
      usage: record.usage,
      modelUsage: record.modelUsage,
      totalCostUsd: record.total_cost_usd,
      promptSha256: sha256(prompt),
      promptCharacters: [...prompt].length,
      skillInjected: arm === "treatment",
      isolation: {
        safeMode: true,
        noSessionPersistence: true,
        tools: "none",
        chrome: false,
        slashCommands: false,
        workspace: "per-arm-empty",
        subscriptionOnly: true,
      },
    },
  };
}

function parseLastJsonObject(output) {
  try {
    return JSON.parse(output.trim());
  } catch {
    // Some runtimes write diagnostics before a final one-line JSON record.
  }
  for (const line of output.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // Cursor may write diagnostics before the final runner record.
    }
  }
  throw new Error("Runtime did not return a JSON result.");
}

function buildInjectedPrompt(evalCase, arm, contents) {
  const common =
    "Complete the writing task below. Do not inspect files or use tools. " +
    "Return only the requested artifact, without analysis or commentary.";
  const casePrompt = buildCasePrompt(evalCase);
  if (arm === "control") {
    return `${common}\n\n${casePrompt}`;
  }

  const load = evalCase.load ?? "sentence";
  if (!["short", "sentence"].includes(load)) {
    throw new Error(`${evalCase.id} has an invalid load value: ${load}`);
  }
  const bundle = buildSkillBundle(contents, load);
  return (
    `${common}\n\nApply the following Agent Skill and references as binding ` +
    `editorial instructions. Complete its separate draft and editorial-review ` +
    `passes before returning the final artifact.\n\n${bundle}\n\n${casePrompt}`
  );
}

function buildCasePrompt(evalCase) {
  const sections = [["TASK", evalCase.task]];
  for (const source of evalCase.sources) {
    sections.push([`SOURCE MATERIAL: ${source.label}`, source.content]);
  }
  return joinSections(sections);
}

function buildSkillBundle(contents, load) {
  const sections = [["SKILL.md", contents.skill]];
  if (load === "sentence") {
    sections.push(["punctuation.md", contents.punctuation]);
    sections.push(["grammar-and-style.md", contents.grammarAndStyle]);
  }
  sections.push(["editorial-standard.md", contents.editorial]);
  return joinSections(sections);
}

function joinSections(sections) {
  return sections
    .map(([name, content]) => `--- ${name} ---\n${content.trim()}`)
    .join("\n\n");
}

function buildBlindArtifacts({ cases, repeat, seed, results, ratings = [] }) {
  const byPair = new Map();
  for (const result of results) {
    if (!byPair.has(result.pairId)) {
      byPair.set(result.pairId, {});
    }
    byPair.get(result.pairId)[result.arm] = result;
  }
  const ratingByPair = new Map(
    ratings.map((rating) => [rating.pairId, rating]),
  );

  const lines = [
    "# Blind A/B review",
    "",
    "Choose the version whose Portuguese you would rather publish. Consider",
    "word choice, syntax, rhythm, cohesion, and fitness for the requested",
    "artifact. Choose a tie when neither version is materially better.",
    "",
  ];
  const key = { schemaVersion: 1, seed, pairs: [] };

  for (const evalCase of cases) {
    for (let repetition = 1; repetition <= repeat; repetition += 1) {
      const pairId = `${evalCase.id}-${String(repetition).padStart(2, "0")}`;
      const pair = byPair.get(pairId);
      const labels = blindLabels(seed, pairId);
      const identical = outputsAreIdentical(pair);
      const rating =
        ratingByPair.get(pairId) ??
        (identical
          ? {
              pairId,
              preferred: "Tie",
              reason: "",
              automatic: "identical",
            }
          : undefined);
      key.pairs.push({ pairId, ...labels });

      lines.push(`## ${pairId}`, "", "### Task", "", evalCase.task, "");
      for (const source of evalCase.sources) {
        lines.push(`### Source: ${source.label}`, "");
        if (source.review === "reference") {
          lines.push(`Reference: \`${relativeToRepo(source.path)}\``, "");
        } else {
          lines.push(source.content, "");
        }
      }
      if (identical) {
        lines.push("### Identical output", "");
        lines.push(pair.control.output, "");
      } else {
        for (const label of ["A", "B"]) {
          const result = pair?.[labels[label]];
          lines.push(`### Output ${label}`, "");
          lines.push(result?.output || "*No output.*", "");
        }
      }
      lines.push(
        "### Review",
        "",
        `- Preferred: ${formatPreference(rating)}`,
        `- Reason: ${rating?.reason || ""}`,
        "",
      );
    }
  }

  return { review: `${lines.join("\n")}\n`, key };
}

function blindLabels(seed, pairId) {
  return blindBit(seed, pairId) === 0
    ? { A: "control", B: "treatment" }
    : { A: "treatment", B: "control" };
}

function blindBit(seed, pairId) {
  return createHash("sha256").update(`${seed}:${pairId}`).digest()[0] & 1;
}

function formatPreference(rating) {
  if (!rating) {
    return "A / B / Tie";
  }
  return rating.automatic === "identical"
    ? "Tie (identical outputs)"
    : rating.preferred;
}

async function loadEvalCase(entry, casePath) {
  validateCase(entry);
  const sources = await Promise.all(
    (entry.sources ?? []).map(async (specification) => {
      const source =
        typeof specification === "string"
          ? { path: specification }
          : specification;
      if (!source?.path) {
        throw new Error(`${entry.id} contains a source without a path.`);
      }
      const path = isAbsolute(source.path)
        ? source.path
        : resolve(dirname(casePath), source.path);
      const content = (await readFile(path, "utf8")).trim();
      return {
        label: source.label || basename(path),
        path,
        content,
        sha256: sha256(content),
        review: source.review ?? "reference",
      };
    }),
  );
  return { ...entry, sources };
}

function buildCaseSourceManifest(cases) {
  return Object.fromEntries(
    cases
      .filter((evalCase) => evalCase.sources.length > 0)
      .map((evalCase) => [
        evalCase.id,
        evalCase.sources.map((source) => ({
          label: source.label,
          path: relativeToRepo(source.path),
          sha256: source.sha256,
          review: source.review,
        })),
      ]),
  );
}

function buildGenerationManifest(results) {
  const entries = results
    .filter((result) => result.metadata)
    .map((result) => [
      `${result.pairId}.${result.arm}`,
      result.metadata,
    ]);
  return Object.fromEntries(entries);
}

async function readSkillFiles() {
  return {
    skill: await readFile(skillFiles.skill, "utf8"),
    editorial: await readFile(skillFiles.editorial, "utf8"),
    grammarAndStyle: await readFile(skillFiles.grammarAndStyle, "utf8"),
    punctuation: await readFile(skillFiles.punctuation, "utf8"),
  };
}

async function skillFileManifest(contents) {
  return Object.fromEntries(
    Object.entries(skillFiles).map(([name, path]) => [
      name,
      {
        path: relativeToRepo(path),
        sha256: sha256(contents[name]),
      },
    ]),
  );
}

async function adapterManifest(path) {
  const contents = await readFile(path);
  return {
    path,
    sha256: sha256(contents),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runWorker(),
    ),
  );
  return results;
}

function spawnCapture(commandName, commandArgs, input, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(commandName, commandArgs, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => {
      resolvePromise({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
    child.stdin.end(input);
  });
}

function validateCase(evalCase) {
  if (!evalCase.id || !evalCase.task) {
    throw new Error("Every case needs id and task.");
  }
  if (evalCase.sources !== undefined && !Array.isArray(evalCase.sources)) {
    throw new Error(`${evalCase.id} sources must be an array.`);
  }
  for (const source of evalCase.sources ?? []) {
    if (
      typeof source === "object" &&
      source.review !== undefined &&
      !["content", "reference"].includes(source.review)
    ) {
      throw new Error(
        `${evalCase.id} source review must be content or reference.`,
      );
    }
  }
}

function stringOption(options, name, fallback) {
  const value = options[name];
  return value === undefined ? fallback : String(value);
}

function runtimeOption(options, fallback = "codex") {
  const runtime = stringOption(options, "runtime", fallback).toLowerCase();
  if (!["codex", "cursor", "claude"].includes(runtime)) {
    throw new Error("--runtime must be codex, cursor, or claude.");
  }
  return runtime;
}

function defaultModel(runtime) {
  if (runtime === "cursor") {
    return "composer-2.5";
  }
  if (runtime === "claude") {
    return "sonnet";
  }
  return "gpt-5.6-terra";
}

function claudeEffortOption(options) {
  return stringOption(options, "effort", "medium").toLowerCase();
}

function modelParamsOption(options) {
  const values = options["model-param"] ?? [];
  const entries = Array.isArray(values) ? values : [values];
  const params = {};
  for (const entry of entries) {
    const separator = String(entry).indexOf("=");
    if (separator <= 0 || separator === String(entry).length - 1) {
      throw new Error("--model-param must use name=value.");
    }
    const name = String(entry).slice(0, separator);
    const value = String(entry).slice(separator + 1);
    params[name] = value;
  }
  return params;
}

async function cursorRuntime() {
  const runner = join(
    repoRoot,
    "evals",
    "better-portuguese",
    "cursor-agent-runner.mjs",
  );
  const packagePath = join(
    repoRoot,
    "node_modules",
    "@cursor",
    "sdk",
    "package.json",
  );
  let sdkVersion;
  try {
    sdkVersion = JSON.parse(await readFile(packagePath, "utf8")).version;
  } catch {
    throw new Error(
      "Cursor SDK is not installed. Run npm install before using Cursor.",
    );
  }

  const env = { ...process.env };
  if (!env.CURSOR_API_KEY) {
    try {
      const localEnv = await readFile(join(repoRoot, ".env"), "utf8");
      env.CURSOR_API_KEY = envValue(localEnv, "CURSOR_API_KEY");
    } catch {
      // The explicit environment remains the primary configuration.
    }
  }
  if (!env.CURSOR_API_KEY) {
    throw new Error(
      "CURSOR_API_KEY is required. Export it or add it to the repository .env.",
    );
  }
  return { runner, sdkVersion, env };
}

async function claudeRuntime(options) {
  const command = stringOption(options, "claude", "claude");
  const env = { ...process.env };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]) {
    delete env[name];
  }

  const versionResult = await spawnCapture(command, ["--version"], "", {
    cwd: repoRoot,
    env,
  });
  if (versionResult.exitCode !== 0) {
    throw new Error(
      `Claude CLI is unavailable: ${versionResult.stderr.trim() || command}`,
    );
  }
  const cliVersion = versionResult.stdout.trim();

  const authResult = await spawnCapture(
    command,
    ["auth", "status", "--json"],
    "",
    { cwd: repoRoot, env },
  );
  if (authResult.exitCode !== 0) {
    throw new Error(
      `Claude authentication check failed: ${authResult.stderr.trim()}`,
    );
  }
  let auth;
  try {
    auth = parseLastJsonObject(authResult.stdout);
  } catch (error) {
    throw new Error(`Claude authentication status was invalid: ${error.message}`);
  }
  if (
    auth.loggedIn !== true ||
    auth.authMethod !== "claude.ai" ||
    auth.apiProvider !== "firstParty"
  ) {
    throw new Error(
      "Claude runtime requires a first-party claude.ai subscription login. " +
        "Run `claude auth login` and do not use an API-key provider.",
    );
  }

  return {
    command,
    cliVersion,
    env,
    authentication: {
      authMethod: auth.authMethod,
      apiProvider: auth.apiProvider,
      subscriptionType: auth.subscriptionType ?? null,
    },
  };
}

function envValue(contents, name) {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1 || trimmed.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function integerOption(options, name, fallback) {
  const value = Number.parseInt(stringOption(options, name, String(fallback)), 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return value;
}

function flagOption(options, name) {
  const value = options[name];
  if (value === undefined || value === false || value === "false") {
    return false;
  }
  if (value === true || value === "true") {
    return true;
  }
  throw new Error(`--${name} does not accept a value.`);
}

function requiredPathOption(options, name) {
  const value = options[name];
  if (!value) {
    throw new Error(`--${name} is required in external mode.`);
  }
  return resolve(String(value));
}

async function assertExecutable(path) {
  const details = await stat(path);
  if (!details.isFile()) {
    throw new Error(`Adapter is not a file: ${path}`);
  }
  await access(path, fsConstants.X_OK);
}

function resolveFromRepo(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function relativeToRepo(path) {
  const absolute = resolve(path);
  return absolute.startsWith(`${repoRoot}/`)
    ? absolute.slice(repoRoot.length + 1)
    : absolute;
}

function printHelp() {
  process.stdout.write(`Better Portuguese eval harness

Usage:
  node evals/better-portuguese/harness.mjs tokens [--json]
  node evals/better-portuguese/harness.mjs models [--filter <text>]
  node evals/better-portuguese/harness.mjs run [options]
  node evals/better-portuguese/harness.mjs try [options]

Ad-hoc prompt options:
  --prompt <text>                Prompt to run
  --file <path>                  Read the prompt from a file
  --skill on|off|both            Default: on
  --load short|sentence          Default: sentence
  --runtime codex|cursor|claude  Default: codex
  --model <model>                Runtime-specific default
  --reasoning <effort>           Codex only; default: medium
  --effort <level>               Claude only; default: medium
  --model-param <name=value>     Cursor only; repeatable
  --cwd <path>                   Cursor workspace; default: repository
  --codex <path>                 Default: codex
  --claude <path>                Default: claude
  --skill-path <path>            Default: skills/better-portuguese
  -- <codex exec flags>          Forward additional flags to codex exec

Run options:
  --mode injected|external       Default: injected
  --cases <path>                 Default: evals/better-portuguese/cases.json
  --ids <id,id>                  Run selected cases
  --repeat <number>              Default: 1
  --concurrency <number>         Default: 2
  --batch                        Generate files without interactive review
  --seed <value>                 Reproduce blind A/B labels
  --output <directory>           Default: evals/better-portuguese/runs/<timestamp>

Injected mode:
  --runtime codex|cursor|claude  Default: codex
  --model <model>                Codex: gpt-5.6-terra; Cursor: composer-2.5;
                                 Claude: sonnet
  --reasoning <effort>           Codex only; default: medium
  --effort <level>               Claude only; default: medium
  --model-param <name=value>     Cursor only; repeatable
  --codex <path>                 Default: codex
  --claude <path>                Default: claude

External mode:
  --control-adapter <executable>
  --treatment-adapter <executable>

An external adapter reads the exact task from stdin, writes only the final
artifact to stdout, and writes diagnostics to stderr.
`);
}
