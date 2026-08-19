# Skills

A collection of independent Agent Skills by Rafael Quintanilha. Each directory
under `skills/` is a self-contained skill that can be installed separately.

## Install

Use the [`skills`](https://skills.sh/) CLI to inspect the repository and choose
which skills to install:

```sh
npx skills@latest add rafaelquintanilha/skills
```

To install one skill directly, pass its name:

```sh
npx skills@latest add rafaelquintanilha/skills \
  --skill better-portuguese
```

The installer can also target every supported agent and make the skill
available globally:

```sh
npx skills@latest add rafaelquintanilha/skills \
  --skill better-portuguese \
  --agent '*' \
  --global \
  --yes
```

## Available skills

### Better Portuguese

Better Portuguese produces written Brazilian Portuguese that reads as if it
was composed in Portuguese, even when the agent operates and receives source
material in English. It covers documentation, summaries, edited transcripts,
product copy, help text, email, titles, subtitles, commercial copy, and other
written artifacts.

The skill preserves technical terms when translating them would reduce
precision, while integrating retained terms into Portuguese syntax. It applies
an editorial review after drafting and distinguishes grammatical correction
from its opinionated house style.

- Skill: [`skills/better-portuguese`](skills/better-portuguese)
- Evaluation guide:
  [`evals/better-portuguese/README.md`](evals/better-portuguese/README.md)

On clients that support explicit skill invocation, reference
`$better-portuguese` in the prompt.

## Repository structure

```text
skills/
└── <skill-name>/
    ├── SKILL.md
    ├── agents/
    ├── references/
    ├── scripts/
    └── assets/
evals/
└── <skill-name>/
    ├── cases and fixtures
    ├── evaluation scripts
    └── baselines
```

Only files required while using a skill belong under `skills/<skill-name>/`.
Runtime scripts belong inside that skill's `scripts/` directory. Evaluation
harnesses, development fixtures, generated comparisons, and contributor-only
dependencies remain under `evals/<skill-name>/` so that installing a skill does
not include its development environment.

Skills do not depend on sibling skill directories. Shared development tooling
may live at the repository root when more than one skill genuinely uses it.

## Develop Better Portuguese

Install the evaluation dependencies:

```sh
npm install
```

Measure the skill's context cost:

```sh
npm run eval:better-portuguese:tokens
```

Run the guided blind comparison:

```sh
npm run eval:better-portuguese
```

The evaluator compares the skill against an unchanged control and keeps the
two outputs anonymous until the reviewer records a preference. See the
[evaluation guide](evals/better-portuguese/README.md) for batch execution,
runtime isolation, model selection, baselines, and private cases.

The canonical grammar references include public bibliographic metadata,
prescriptions, examples, and paragraph locators. Research scans are not part
of the repository.
