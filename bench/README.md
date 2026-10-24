# Agent benchmark

Fifteen small tasks that measure what the agent actually *gets done*, not whether the loop is
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
| using what project memory records: a command the code does not reveal, and unfinished work named only in the run journal | 14, 15 |

## Quick start

```sh
node bench/start.mjs
```

It asks for the provider, model, API key (typed hidden, used for that run only, never saved) and
how many times to repeat each task, builds the app if needed, runs everything, saves
`bench/results/<label>-<time>.json`, and compares with your previous run. It stops after the
first task if the key or model is rejected. Skip questions with flags, e.g. unattended:

```sh
ANTHROPIC_API_KEY=... node bench/start.mjs --provider anthropic --model claude-sonnet-5 --repeat 3 --yes
node bench/start.mjs --provider custom --base-url http://localhost:11434/v1 --model qwen3-coder --yes
node bench/start.mjs --provider oracle --yes        # no model: checks the benchmark itself
```

`--yes` asks nothing and uses defaults for anything missing (a missing API key is then an error).
A server that needs a key for `--provider custom` reads `CUSTOM_API_KEY`.

## Using the keys you already saved in the app

If you have used Stormcoder on this machine, you do not need to type or export a key. `start.mjs`
finds the app's data folder, lists the providers that have a saved API key, and offers to use
them (with the model you configured). Directly:

```sh
node bench/run.mjs --provider groq --app-data                 # default data folder for this OS
node bench/run.mjs --provider groq --app-data ~/.config/Stormcoder
node bench/start.mjs --provider groq --app-data --yes         # unattended; asks nothing
```

How it works, and what it will not do:

- The app encrypts keys with the OS keychain (or a key file), which only Electron can open. So the
  benchmark runs its engine under Electron, using the app's own secret code, against a **private
  copy** of your data. Nothing is decrypted to disk, and your original files are only read.
- **Sign-in sessions are not used.** Providers you only sign into (no API key saved) are refused
  with an explanation: refreshing a copied sign-in can rotate its token and log the real app out.
- Only provider settings are copied: default provider, models, base URLs. Your MCP servers, hooks,
  system prompt and rules are left out, so the benchmark does not start your processes and its
  results do not depend on your personalization.
- A key in an environment variable still takes precedence, exactly as in the app.
- On Linux without a display it uses `xvfb-run` if installed. On macOS the OS may ask once to let
  Electron read the "Stormcoder Safe Storage" keychain item; allow it.

Tested end to end under Electron with the app's file-key storage (`test/bench-appkeys.mjs`). The
OS-keychain path (macOS Keychain, Windows DPAPI) runs the same code as the app but has not been
exercised by that test.

## Run it directly

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

Tasks 14 and 15 only make sense with project memory on (the default). To measure what memory
buys, run them with it on and off and compare:

```sh
node bench/run.mjs --provider anthropic --model claude-sonnet-5 --tasks 14 15 --repeat 5 --label memory-on --out bench/results/mem-on.json
node bench/run.mjs --provider anthropic --model claude-sonnet-5 --tasks 14 15 --repeat 5 --setting memory.enabled=false --label memory-off --out bench/results/mem-off.json
node bench/compare.mjs bench/results/mem-off.json bench/results/mem-on.json
```

`--setting key=value` (repeatable) sets any Stormcoder setting for the run. Task 14's `npm test`
is a placeholder that always passes; only the memory says the real run is `node scripts/check.js`,
and the check verifies it ran against the final file. Task 15 says only "continue the work from
the last session": the unfinished retry support is named only in `.stormcoder/journal.jsonl`.

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
