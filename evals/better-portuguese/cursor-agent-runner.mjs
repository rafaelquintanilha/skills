#!/usr/bin/env node

import { Agent, JsonlLocalAgentStore } from "@cursor/sdk";
import { mkdir } from "node:fs/promises";

process.stdout.on("error", (error) => {
  if (error?.code !== "EPIPE") {
    throw error;
  }
});

function parseArgs(argv) {
  const parsed = {};
  for (let index = 2; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith("--") || value === undefined) {
      throw new Error(`Invalid arguments near ${name}.`);
    }
    parsed[name.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolvePromise(input));
    process.stdin.on("error", rejectPromise);
  });
}

function modelSelection(modelId, paramsJson) {
  const params = paramsJson ? JSON.parse(paramsJson) : {};
  return {
    id: modelId,
    params: Object.entries(params).map(([id, value]) => ({
      id,
      value: String(value),
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY is required.");
  }
  if (!args.cwd || !args.store || !args.model) {
    throw new Error("--cwd, --store, and --model are required.");
  }

  await Promise.all([
    mkdir(args.cwd, { recursive: true }),
    mkdir(args.store, { recursive: true }),
  ]);

  const prompt = await readStdin();
  const model = modelSelection(args.model, args.params);
  const store = new JsonlLocalAgentStore(args.store);
  const agent = await Agent.create({
    apiKey,
    model,
    local: {
      cwd: args.cwd,
      store,
      settingSources: [],
      sandboxOptions: { enabled: true },
      enableAgentRetries: true,
    },
  });

  try {
    const run = await agent.send(prompt);
    const result = await run.wait();
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        agentId: agent.agentId,
        runId: run.id,
        status: result.status,
        result: result.result ?? "",
        model: result.model ?? run.model ?? model,
        usage: result.usage ?? run.usage,
        isolation: {
          freshAgent: true,
          resumed: false,
          settingSources: [],
          sandbox: true,
          store: "per-arm-jsonl",
        },
      })}\n`,
    );
    if (result.status !== "finished") {
      process.exitCode = 1;
    }
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      name: error?.name ?? "Error",
      code: error?.code,
      operation: error?.operation,
      message: error?.message ?? String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
