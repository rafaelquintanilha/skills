---
name: orchestrate
description: Coordinate Codex subagents when requested or when independent work materially improves completion time or review quality. Keep tightly coupled work with the root agent.
---

# Orchestrate

Use Codex collaboration tools to delegate independent outcomes. The root owns user communication, integration, and the final result. This skill does not override the session's delegation or action permissions.

## Decide what to delegate

Delegate when another agent can make useful progress independently or provide a valuable second judgment. Stay single-agent when coordination, duplicated context, or shared mutable state would cost more than the delegation helps. A long-running command alone does not require another agent when the available tools can run it asynchronously.

Give each agent a concrete outcome, the relevant context and evidence, its ownership boundary, permitted actions, and a definition of completion. Share enough history to avoid rediscovery, without copying unrelated context. Avoid overlapping write ownership. Further delegation needs an explicitly assigned coordination role.

## Choose the configuration

Honor the user's model and reasoning preferences. Otherwise use the current agent's configuration unless the assignment provides a concrete reason to choose differently. When selecting an alternative, weigh ambiguity, consequence, expected quality, latency, and cost using the models actually available. Do not equate a role with a fixed model or maximum reasoning effort.

Before spawning, briefly disclose the task name, role, requested model and reasoning effort, and whether configuration is inherited. Do not guess settings the runtime does not expose or present requested settings as verified runtime identity.

## Integrate the work

Keep useful work moving locally while agents run. Reuse an existing agent when its context remains relevant. Redirect or stop work when assumptions diverge, scope expands, or ownership overlaps.

Treat returned findings as evidence to assess, not automatic proof of completion. Resolve material disagreements against authoritative sources, validate the combined result, and report remaining limitations. Return a coherent answer rather than forwarding separate agent reports.
