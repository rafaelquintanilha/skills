# Evals

The eval harness compares Better Portuguese against an unchanged control
without requiring a canonical answer. It asks a human reviewer which Portuguese
they would rather publish. In interactive mode, each pair's identity remains
hidden until the choice is recorded.

## Install

```sh
npm install
```

Codex runs require the `codex` CLI. Cursor runs require a Cursor API key:

```sh
export CURSOR_API_KEY=...
```

For local development, the key may instead be placed in a gitignored `.env`
file:

```sh
cp .env.example .env
```

The repository pins the Cursor Agent SDK so that a saved run identifies the
exact harness version that produced it.

Claude runs require the `claude` CLI and a first-party Claude subscription
login:

```sh
claude auth login
claude auth status --json
```

The harness accepts only `claude.ai` authentication through Anthropic's
first-party provider. It removes API-key and third-party-provider environment
variables from Claude child processes rather than silently charging an API
account. Subscription limits and any separately enabled usage credits remain
account-level concerns; consult Anthropic's
[subscription guidance](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
before a large campaign.

## Measure context cost

```sh
npm run eval:better-portuguese:tokens
```

The report uses the `o200k_base` encoding and separates:

- the frontmatter visible during skill discovery;
- each runtime file;
- the files loaded for a short artifact;
- the files loaded for sentence-level prose.

These are file-content counts. Agent-specific wrappers, paths, and skill
catalog serialization may add a small amount of context.

## Run an isolated instruction A/B

```sh
npm run eval:better-portuguese
```

The default command opens an interactive blind review. For each case, it:

1. generates the control and treatment in parallel;
2. records exact matches automatically as ties;
3. shows distinct outputs as anonymous versions A and B;
4. asks which version the reviewer would publish and accepts an optional
   reason;
5. saves the decision and reveals which version used the skill;
6. reveals the aggregate control and treatment results after the final case.

The final result separates skill preferences, control preferences, stylistic
ties, and identical outputs. It also states which side, if either, was preferred
more often in that run.

Injected mode supports Codex, Cursor, and Claude CLI. In every runtime, the
control receives the common writing instruction and task; the treatment
receives the same material plus the Better Portuguese files. The model and
remaining generation settings are identical within each pair.

Codex starts an ephemeral context with user configuration, rules, memories, and
ambient skill instructions disabled.

Cursor gives every arm:

- a new SDK agent that is never resumed;
- a separate child process;
- a separate empty working directory;
- a separate `JsonlLocalAgentStore`;
- `settingSources: []`, which excludes project, user, team, MDM, and plugin
  settings;
- the SDK sandbox, which blocks reads outside the isolated workspace and
  constrains shell, process, and network access.

Claude gives every arm:

- a separate CLI process and empty working directory;
- `--safe-mode`, which excludes ambient `CLAUDE.md` files, skills, plugins,
  hooks, MCP servers, auto-memory, and other customizations;
- `--no-session-persistence`, which prevents conversation reuse;
- an empty tool set and a fixed system prompt;
- verified first-party `claude.ai` subscription authentication, with API-key
  provider variables removed from the child environment.

Machine-administered Claude policy may still apply under `--safe-mode`; the
harness records the boundary as disabled user and project customization rather
than claiming to override administrator policy.

The temporary working directories and stores are removed after the run. This
keeps globally installed skills, including personal writing skills, out of both
arms. It also ensures that the control cannot inherit the treatment's
conversation or persisted agent state. Each arm's runtime identity, resolved
model information, usage, and isolation settings are recorded in
`manifest.json` and a corresponding `raw/*.runtime.json` file.

Validate those boundaries after any Cursor run:

```sh
npm run eval:better-portuguese:validate-isolation -- \
  evals/better-portuguese/runs/<run>/manifest.json
```

The validator requires unique agent and run IDs, empty ambient setting sources,
separate stores, identical model selections within every pair, and a skill
bundle present only in the treatment prompt.

Validate the corresponding boundaries after a Claude run:

```sh
npm run eval:better-portuguese:validate-claude-isolation -- \
  evals/better-portuguese/runs/<run>/manifest.json
```

The Claude validator requires unique sessions, disabled persistence, safe
mode, no tools, identical model and effort settings within every pair, and a
skill bundle present only in the treatment prompt. It also reports the resolved
models and API-equivalent cost accounting returned by Claude CLI. The cost
field measures consumption; subscription authentication does not by itself
prove that an additional API charge occurred.

Useful options:

```sh
npm run eval:better-portuguese -- --ids architecture-decision,release-note
npm run eval:better-portuguese -- --repeat 2 --concurrency 2
npm run eval:better-portuguese -- \
  --runtime codex \
  --model gpt-5.6-terra \
  --reasoning medium
npm run eval:better-portuguese -- \
  --runtime cursor \
  --model claude-sonnet-5 \
  --model-param thinking=true \
  --model-param context=300k \
  --model-param effort=low
npm run eval:better-portuguese -- \
  --runtime claude \
  --model claude-sonnet-5 \
  --effort low
npm run eval:better-portuguese -- --cases /absolute/path/to/private-cases.json
```

Codex runs default to medium reasoning because the treatment requires a
distinct syntactic and lexical review after drafting. Pass `--reasoning low`
explicitly when stress-testing whether a model can compress that workflow into
a shallower run.

Cursor models expose different parameters. Discover the current catalog and
allowed values instead of guessing:

```sh
npm run eval:better-portuguese:models
npm run eval:better-portuguese:models -- --filter sonnet
```

Pass each Cursor parameter explicitly with a repeatable `--model-param
name=value` option. The SDK validates the selection against Cursor's current
catalog. See the
[Cursor Agent SDK TypeScript reference](https://cursor.com/docs/sdk/typescript)
for the underlying agent, model, sandbox, and local-store APIs.

Claude uses the model names and effort levels exposed by the installed Claude
CLI. The harness records the requested model, CLI version, resolved model usage,
session ID, token usage, and equivalent cost for every arm. Claude CLI may use
auxiliary models internally, so this runtime measures the requested model
together with Claude Code's orchestration rather than a raw single-model API
call. Use a full model name instead of a moving alias when producing a durable
baseline.

For cross-model analysis, compare every model's treatment against its own
control. A Sonnet treatment versus a Gemini control does not isolate the
skill's effect. Likewise, Codex and Cursor have different agent orchestration;
a cross-runtime result measures the model together with its harness. Claude CLI
has the same qualification. Running the same model through more than one
runtime can provide a useful bridge, but does not make the harnesses identical.

`load: "short"` tells injected mode to omit the punctuation and grammar
references for an isolated short artifact. Other cases receive the complete
sentence-level bundle.

Cases may attach one or more source artifacts:

```json
{
  "id": "landing-page-faq",
  "task": "Write three questions and answers in Brazilian Portuguese.",
  "sources": [
    {
      "label": "Product-page excerpt",
      "path": "fixtures/product-page.md"
    }
  ]
}
```

Source paths are resolved relative to the case file. Both arms receive the
same task and source material. The review screen shows only the source label and
repository path before the outputs, while the run manifest records its path and
content hash.

The default review mode is `reference`, which keeps diffs, transcripts, briefs,
and other source material out of the comparison screen and `review.md`. Set
`review` to `content` only when the source itself must be visible during
judgment.

For an unattended run, generate the review files without prompting:

```sh
npm run eval:better-portuguese:batch
```

## Build a repeated baseline

[`baseline-campaign.json`](baseline-campaign.json) defines the fixed case
cohort, model settings, repetition count, and judge used by the regression
baseline. Generate each configured run with the same skill revision and use
`--repeat 5`; do not combine one-off runs produced from different skill or case
hashes.

Rate a completed run with the isolated blind judge:

```sh
npm run eval:better-portuguese:judge -- \
  evals/better-portuguese/runs/<run>
```

The judge receives anonymous A/B outputs and the source material, but not the
arm key. In addition to its preference, it records whether each output is
publishable unchanged. This keeps a relatively better but still defective
output from being counted as an absolute success.

After every configured model has a complete `ratings.auto.json`, create the
versioned baseline:

```sh
npm run eval:better-portuguese:baseline -- create \
  --output evals/better-portuguese/baselines/v1.json \
  evals/better-portuguese/runs/<sonnet-run> \
  evals/better-portuguese/runs/<grok-run> \
  evals/better-portuguese/runs/<opus-run> \
  evals/better-portuguese/runs/<glm-run> \
  evals/better-portuguese/runs/<luna-run> \
  evals/better-portuguese/runs/<terra-run> \
  evals/better-portuguese/runs/<sol-run>
```

The snapshot records the case and source cohort, skill-file hashes, runner
settings, reviewer configuration, aggregate preferences, independent
publishability judgments, and per-case results. Raw runs remain ignored.

To measure a later skill revision, repeat the campaign and compare the new runs
with the snapshot:

```sh
npm run eval:better-portuguese:baseline -- compare \
  --baseline evals/better-portuguese/baselines/v1.json \
  evals/better-portuguese/runs/<candidate-sonnet-run> \
  evals/better-portuguese/runs/<candidate-grok-run>
```

The comparison rejects mismatched cases, sources, repetitions, or model
settings. It reports aggregate changes and every per-case decrease in skill
preference or publishability. These deltas are evidence for editorial review;
the command does not invent a universal pass threshold from five samples.

## Compare installed environments

External mode sends the exact task to two executable adapters:

```sh
node evals/better-portuguese/harness.mjs run \
  --mode external \
  --control-adapter /absolute/path/to/agent-without-skill \
  --treatment-adapter /absolute/path/to/agent-with-skill
```

Each adapter must:

1. read the task from standard input;
2. run its agent in a fresh context;
3. write only the final artifact to standard output;
4. write diagnostics to standard error.

The adapters are responsible for using the same model and generation settings.
This mode validates the installed behavior, including skill discovery and
loading, rather than only the effect of the instruction text.

The harness supplies these environment variables to adapters:
`BETTER_PORTUGUESE_ARM`, `BETTER_PORTUGUESE_CASE_ID`,
`BETTER_PORTUGUESE_REPEAT`, and `BETTER_PORTUGUESE_RUN_ID`.

## Review a run

Each run is written under `evals/better-portuguese/runs/`, which is ignored by
Git:

- `review.md` contains anonymous outputs A and B and any recorded decisions;
- `ratings.json` stores interactive decisions after every reviewed case;
- `key.json` reveals which output was the control and treatment;
- `manifest.json` records the case file, seed, runner settings, skill hashes,
  context-token report, and per-arm runtime metadata;
- `raw/` contains original outputs and execution logs.

In batch mode, review `review.md` before opening `key.json`. Check every
distinct pair by asking which Portuguese you would rather publish. Consider
word choice, syntax, rhythm, cohesion, and fitness for the requested artifact.
Choose a tie when neither version is materially better.

## Avoid overfitting

`cases.json` is the development suite. Its prompts ask for concrete artifacts
from working material an agent might actually receive: small and medium Git
diffs, published video metadata, terse product requirements, pricing facts, and
UX notes. The target artifacts include PR descriptions, engineering Slack
updates, short Telegram messages for published videos, landing-page sections,
FAQs, instructions, and product microcopy.

For landing-page cases, prefer factual briefs in English or another source
format that does not supply ready-made Portuguese copy. This forces both arms
to compose the artifact instead of polishing language inherited from a public
page. Raw prose remains useful when prose is the realistic input, as with
transcripts, article summaries, and edited excerpts. When evaluating an
automation, model its real input surface: the video-sharing cases use the
published title and description, including their surrounding boilerplate,
rather than a preselected transcript summary.

An English brief may retain minimal first-party evidence for a proper name's
article or gender, such as unrelated self-references using `do`, `da`, `no` or
`na`. Injected runs cannot inspect the public origin, so removing that evidence
would turn grammatical integration into a guess. Do not include the target
sentence or a phrase that can be copied as the requested artifact.

`holdout.json` is a checkpoint suite. Do not run it after every edit or copy its
terms into runtime instructions. Run it only after a coherent revision of the
skill. For a stronger test, keep a private case file outside the repository and
pass it through `--cases`.

The public fixture inventory and its provenance live in
`fixtures/sources.json`. Preserve raw artifacts unless the provenance note
identifies a derived factual brief, and never copy material from a private
repository merely because it is locally available. Contributors may add their
own public or permissively licensed artifacts, explicitly authorized material,
or private cases passed from outside the repository.

When the control is preferred:

1. repeat the pair before treating the preference as systematic;
2. identify the general stylistic mechanism, not the preferred sentence;
3. change a runtime rule only when it improves that mechanism across contexts;
4. rerun the development suite before checking the holdout suite.

Trigger behavior remains a separate concern. `triggers.json` contains positive
and negative activation cases; installed-environment adapters can test whether
an agent actually loads the skill for those requests.

## Try an arbitrary prompt

Use the same isolated runner without adding a benchmark case:

```sh
npm run eval:better-portuguese:try -- --prompt "Write a poem in Portuguese" --skill on
npm run eval:better-portuguese:try -- --prompt "Write a poem in Portuguese" --skill off
npm run eval:better-portuguese:try -- \
  --runtime cursor \
  --model grok-4.5 \
  --model-param effort=low \
  --model-param fast=false \
  --skill both \
  --prompt "Write a poem in Portuguese"
npm run eval:better-portuguese:try -- \
  --runtime claude \
  --model claude-sonnet-5 \
  --effort low \
  --skill both \
  --prompt "Write a poem in Portuguese"
```

Use `--skill both` to print both labeled outputs in one run. If `--prompt` is
omitted in a terminal, the harness asks for it interactively. For a longer
prompt, pass `--file path/to/prompt.txt`.

With Codex, the command starts in the repository with a read-only sandbox,
permits tools and file inspection, and keeps ambient skills disabled so that
`--skill` controls the comparison. Forward additional Codex flags after `--`:

```sh
npm run eval:better-portuguese:try -- \
  --prompt "Summarize README.md in Brazilian Portuguese" \
  --skill both \
  -- -C /path/to/project -s read-only
```

With Cursor, use `--cwd` when the request needs to inspect a particular
directory:

```sh
npm run eval:better-portuguese:try -- \
  --runtime cursor \
  --model claude-sonnet-5 \
  --model-param thinking=true \
  --model-param context=300k \
  --model-param effort=low \
  --cwd /path/to/project \
  --skill both \
  --prompt "Summarize README.md in Brazilian Portuguese"
```

Ad-hoc Cursor arms still receive separate agents, processes, and stores, but
they share the requested working directory so that both can inspect the same
files. The command does not save a run or modify the eval suite. Avoid
`--skill both` with a mutating request or writable Codex options, because the
request runs once per arm.

Ad-hoc Claude arms retain the benchmark isolation boundary: safe mode, empty
tools, separate empty workspaces, and no session persistence. Include all
source material in the prompt; Claude ad-hoc mode intentionally does not read
files or browse URLs.
