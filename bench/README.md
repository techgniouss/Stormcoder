# Agent benchmark

Thirteen small tasks that measure what the agent actually *gets done*, not whether the loop is
correct (the unit tests do that). Each task is a throwaway git repo, a prompt, and an objective
check that inspects the result on disk. The model's own claims are never believed.

| area | tasks |
|---|---|
| bug fixing from failing tests | 01 |
| feature in the existing style / across code, docs, tests | 02, 13 |
| refactors: rename, extract | 03, 09 |
| finding code among hundreds of files and an ignored dependency tree | 04 |
| a follow-up that depends on what the previous run read | 05 |
| a rule that lives only in a subfolder's `AGENTS.md` | 06 |
| editing JSON without disturbing it, and a Jupyter notebook | 07, 08 |
| answering a question without changing anything (Ask mode) | 10 |
| a one-line change in a 900-function file | 11 |
| starting a server, calling it, stopping it | 12 |

## Run it

The runner drives the real engine (the dev host) over its WebSocket, the way the chat UI does.

```sh
npm run build
ANTHROPIC_API_KEY=... node bench/run.mjs --provider anthropic --model claude-sonnet-5 --repeat 3 --out bench/results/sonnet.json
OPENAI_API_KEY=...    node bench/run.mjs --provider openai --model gpt-5 --repeat 3 --out bench/results/gpt.json
node bench/run.mjs --provider custom --base-url http://localhost:11434/v1 --model qwen3-coder
node bench/compare.mjs bench/results/sonnet.json bench/results/gpt.json
```

Use `--repeat 3` or more: one run of a model on one task is an anecdote. Options: `--tasks 04 06`
(substring filter), `--approval auto-edits`, `--max-steps`, `--timeout-scale`, `--label`.

To measure what a change bought, build the older revision in a worktree and run the same tasks
against both:

```sh
git worktree add ../stormcoder-before b80d765 && (cd ../stormcoder-before && npm ci && npm run build)
node bench/run.mjs --provider anthropic --model claude-sonnet-5 --repeat 3 --engine ../stormcoder-before --label before --out bench/results/before.json
node bench/run.mjs --provider anthropic --model claude-sonnet-5 --repeat 3 --label after --out bench/results/after.json
node bench/compare.mjs bench/results/before.json bench/results/after.json
```

To compare against Claude Code or Codex, give them the same prompt in a copy of the same
workspace (`node -e` with `bench/lib/tasks.mjs` `materialize` makes one), then run
`node bench/check.mjs <task-id> <dir>` on what they leave behind.

## Is the benchmark itself trustworthy?

`npm run bench:validate` needs no model. For every task it asserts the untouched repo **fails**,
the reference solution **passes**, and a set of plausible shortcuts are **rejected** (editing the
tests instead of the code, breaking the subfolder rule, reformatting a manifest, touching
unrelated files, a helper nobody uses). `node bench/run.mjs --provider oracle` replays the
reference solutions through the real engine and must score 100%; `--oracle idle` (claims success,
changes nothing) must score 0%. `npm test` runs the validation and a three-task oracle run; run the full oracle and idle passes by hand after changing the harness.

## Reading the results

Pass rate is the headline. Steps, tool calls and estimated input tokens are only comparable on
runs that passed. "Estimated" is the engine's own 4-characters-per-token count, not the
provider's bill. Flags call out runs that stopped to ask the user, timed out, or hit a provider
error: a provider error is not a model failure, so rerun those before drawing conclusions.
