# Skills

Independent Agent Skills by Rafael Quintanilha. Each directory under `skills/`
is a self-contained skill that can be installed separately.

## Install

Use the [`skills`](https://skills.sh/) CLI to choose and install skills from
this repository:

```sh
npx skills@latest add rafaelquintanilha/skills
```

To install a specific skill:

```sh
npx skills@latest add rafaelquintanilha/skills --skill better-portuguese
```

Orchestrate is built for Codex and its collaboration tools. Install it globally
for Codex with:

```sh
npx skills@latest add rafaelquintanilha/skills --skill orchestrate --agent codex --global
```

## Available skills

| Skill | Purpose |
| --- | --- |
| [`better-portuguese`](skills/better-portuguese) | Write, rewrite, translate, edit, and review natural Brazilian Portuguese. |
| [`orchestrate`](skills/orchestrate) | Coordinate independent Codex work with clear ownership and integrated results. |

## Repository structure

```text
skills/<skill-name>/       Installable skill and optional runtime resources
evals/<skill-name>/        Optional development-only evaluations
scripts/                   Shared repository tooling
```

A skill only needs a `SKILL.md`. It may also include `agents/`, `references/`,
`scripts/`, or `assets/` when those resources are useful at runtime. Evaluations
and their fixtures stay outside the installable skill directory and are not
required for every skill.

## Validate

```sh
npm ci
npm run validate
```
