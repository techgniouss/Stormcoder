# Engines: the Claude Code harness over any model, and Codex as reviewer

Status: implemented and tested against fakes and a stand-in harness. Section 11 says exactly what
is built, what is verified how, and what still needs the real binary and real provider keys.

## 1. Goal

A setting, `stormcoder.engine`, chooses who runs the agent loop:

| Value | Who runs the loop |
|---|---|
| `builtin` (default) | Stormcoder's own `AgentRunner` / `AutoOrchestrator`, unchanged. |
| `claude-code` | The Claude Code harness (Claude Agent SDK). Stormcoder is its UI, its model gateway and its safety layer. |

The model picker keeps working across **every** Stormcoder provider. The harness is the engine; the
model is whatever the user picked. Claude-specific features are kept when the model is Claude and
stripped, for that model only, when it is not.

Codex is used as a **read-only reviewer** (provider `codex-cli`, pinned as the review model), not as
a second full engine. Reason: Claude Code's hook layer lets us enforce `guardrails.ts` on every tool
call; Codex gives no per-call callback in its SDK (see 2.3), so a Codex engine could not be held to
the same guarantee. A read-only sandbox, by contrast, is a guarantee the process cannot break, which
is exactly what a reviewer needs. OpenAI and Codex *models* can still drive the Claude Code harness
through the gateway like any other provider.

With the Claude Code engine selected, Auto is not used (it would be a second pipeline on the same
turn). The review step survives as an opt-in: when `stormcoder.auto.reviewModel` is **explicitly
pinned** (for example `codex-cli:default`), an Agent run that changed the working tree is reviewed
once, afterwards, and the findings are put in front of the engine at the start of the next turn.

Non-goals: running two engines on one turn; bundling the SDK in the installer (see 7.3).

## 2. Verified facts (read from the real packages, not from docs or blogs)

Read from `@anthropic-ai/claude-agent-sdk@0.3.319` type definitions and bundle, and
`@openai/codex-sdk@0.167.0`.

### 2.1 Claude Agent SDK

- `query({ prompt, options })` returns an `AsyncGenerator<SDKMessage>` with `interrupt()`,
  `setModel()`, `setPermissionMode()`, `rewindFiles()`, `streamInput()`, `close()`.
- Messages: `assistant` (Anthropic `Message`, with `parent_tool_use_id` for sub-agents), `user`
  (tool results), `stream_event` (raw Messages stream events, only with `includePartialMessages`),
  `result` (`total_cost_usd`, `modelUsage`, `is_error`, `num_turns`), `system` (init, compaction,
  API retry, ...).
- Options we rely on: `cwd`, `model`, `env`, `pathToClaudeCodeExecutable`, `permissionMode`
  (`default | acceptEdits | bypassPermissions | plan | dontAsk | auto`), `allowedTools`,
  `disallowedTools`, `tools`, `canUseTool`, `hooks` (`PreToolUse`, `PostToolUse`, ...),
  `settingSources`, `systemPrompt` (preset `claude_code` with `append`, `excludeDynamicSections`,
  `snapshot`), `thinking`, `enableFileCheckpointing`, `includePartialMessages`, `abortController`,
  `resume`, `forkSession`, `agents`, `mcpServers`, `strictMcpConfig`, `maxTurns`,
  `permissionPrompts: 'host' | 'none'`.
- `PreToolUse` hooks return `hookSpecificOutput.permissionDecision` and may rewrite `updatedInput`.
  Per the SDK documentation hooks still apply under `bypassPermissions`; `canUseTool` fires only
  when the CLI would otherwise prompt.
- Environment variables present in the bundle: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
  `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_AUTOUPDATER`.
- The native CLI binary ships in per-platform packages; `pathToClaudeCodeExecutable` overrides it.
- Licence: "All rights reserved. Use is subject to the Legal Agreements" (code.claude.com legal
  page). Not MIT. Redistribution inside our installer needs a legal decision (7.3).

### 2.2 Findings that changed the plan

1. `settingSources` omitted loads **user, project and local** settings. (An earlier source said the
   opposite.) We always pass it explicitly.
2. A session may start in `permissionMode: 'auto'`, a model classifier. That is extra, hidden model
   spend. We always pass an explicit mode and `permissionPrompts: 'host'`.
3. `canUseTool` is not a safe enforcement point (it is skipped when rules or the mode decide). The
   enforcement point is a `PreToolUse` hook.
4. The SDK has built-in file checkpointing, but it only covers the harness's file tools. We use our
   own `RunCheckpoint` so Undo behaves identically in both engines.

### 2.3 Codex SDK

`codex exec --experimental-json` with `--sandbox read-only|workspace-write|danger-full-access`,
`--cd`, `--skip-git-repo-check`, `--model`, `--config approval_policy="..."`. Events are JSONL
(`item.completed` with `agent_message`, `turn.completed` with usage). There is a sandbox and an
approval policy but no per-tool-call callback in the SDK. A read-only sandbox is a hard guarantee
(the process cannot write), which is exactly what a reviewer needs.

## 3. Architecture

```
                      +-------------------- Stormcoder (Electron main / host) --------------------+
 chat UI  <--post-->  | ChatViewProvider.handleSend                                                |
                      |     engine=builtin  -> AgentRunner / AutoOrchestrator   (unchanged)        |
                      |     engine=claude   -> ClaudeEngine ----------------------+                |
                      |                          |  hooks: PreToolUse -> ToolBridge -> guardrails  |
                      |                          |  PostToolUse -> RunCheckpoint                   |
                      |                          v                                                 |
                      |                   Claude Agent SDK  (child process, scrubbed env)          |
                      |                          |  ANTHROPIC_BASE_URL=http://127.0.0.1:<port>     |
                      |                          |  ANTHROPIC_AUTH_TOKEN=<per-session token>       |
                      |                          v                                                 |
                      |   AnthropicGateway (127.0.0.1)                                             |
                      |     upstream = Anthropic API key  -> PASS-THROUGH (byte-faithful)          |
                      |     upstream = anything else      -> TRANSLATE -> ProviderRegistry         |
                      +-----------------------------------------------------------------------------+
```

The engine never holds a real provider key. It holds a random per-session token that only the
gateway understands.

## 4. Cost rules (invariants, each has a test)

The requirement: using Claude through Stormcoder must never cost more than using Claude directly.

| # | Rule | Mechanism |
|---|---|---|
| C1 | One model path per turn. | In engine mode `AgentRunner` and `AutoOrchestrator` are never constructed. Test: a fake provider whose `streamChat`/`runAgentStep` fail the test if called. |
| C2 | Anthropic upstream is a byte-faithful pass-through. | The request body is forwarded unparsed (only the auth headers change), so `cache_control`, thinking, betas, server tools, citations and every future field reach Anthropic exactly as the harness built them. Same tokens, same cache hits, same cost as direct. Test: forwarded body is byte-identical. |
| C3 | No Stormcoder text is added to the harness prompt by default. | `engine.appendProjectMemory` is off. The harness's own prompt, tool list and CLAUDE.md handling are untouched, so its cache prefix is stable. |
| C4 | No hidden classifier or extra permission calls. | Explicit `permissionMode`, never `auto`. |
| C5 | Auxiliary calls are mapped, never improvised. | `haiku`/`sonnet`/`opus` aliases map to the user's main and fast model. An unmapped alias is a loud 404, never a silent fall-through to a pricier model. |
| C6 | Stormcoder's own side calls cannot double bill. | In engine mode Stormcoder compaction and memory auto-propose are off. User-initiated actions (commit message) use the selected model. |
| C7 | Translated requests keep a stable prefix. | The translation is deterministic and never reorders system, tools or history, so providers with automatic prompt caching still hit. |
| C8 | Spend is visible. | The gateway meters input, output and cache tokens per session; the result message carries `total_cost_usd`. |
| C9 | Claude subscription users pay nothing extra. | `engine.claudeCode.auth = own-login` runs the user's installed Claude Code login directly, with no gateway and Claude models only. Hooks and guardrails still apply. Off by default pending a terms check (7.2). |

Honest limit: a non-Claude model reached through the translated path pays the harness's large
prompt prefix on every step. Providers with automatic caching make that cheap; providers without it
do not. The model picker shows a caching note for those.

## 5. Capability matrix

Features are decided per **upstream**, per request, in `src/engine/capabilities.ts`.

| Feature in the request | Anthropic upstream | Translated upstream |
|---|---|---|
| `cache_control` markers | kept (pass-through) | dropped |
| `thinking` / signed thinking blocks | kept | dropped, reasoning disabled |
| `anthropic-beta` headers | kept | dropped |
| Anthropic-hosted tools (`web_search`, `web_fetch`, code execution) | kept | removed from the tool list; the harness's `WebSearch`/`WebFetch` are denied for these sessions unless a local replacement is configured |
| Citations, document blocks, other unknown blocks | kept | dropped, with a one-time notice |
| Images | kept | sent when the model has vision; otherwise left out, with a one-time notice |
| Parallel tool calls | kept | kept where the provider returns several |
| Tool-call argument streaming | kept | tool calls are emitted when the provider step completes |

## 6. Security model

- **Gateway:** binds `127.0.0.1` on a random port; requires `Authorization: Bearer <session token>`
  or `x-api-key` (constant-time compare); rejects any `Host` that is not `127.0.0.1:<port>` or
  `localhost:<port>` (DNS rebinding); sends no CORS headers; caps request bodies; never logs bodies
  or keys; closes on shutdown.
- **Keys:** provider keys stay in `ProviderRegistry`/SecretStorage. The engine child gets a scrubbed
  environment (allowlist plus the gateway variables). `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`
  and friends are removed.
- **Trust:** untrusted folder => tools limited to read-only, project settings not loaded.
  Trusted folder => `settingSources: ['project']` only when `engine.claudeCode.loadProjectSettings`
  is on. `user` and `local` are never loaded.
- **Enforcement:** a `PreToolUse` hook runs every tool call through `ToolBridge`, which maps it to
  the equivalent Stormcoder tool and applies `checkCommand`/`checkPath`, protected paths, workspace
  confinement and the approval policy (including the remote approval floor). Unknown tools are
  denied. Sub-agent calls (`agent_id` set) go through the same hook.
- **Never set:** `allowDangerouslySkipPermissions`, `bypassPermissions`, plugins, `user` settings.
- **MCP:** `strictMcpConfig: true`; only servers Stormcoder itself started (trusted folders).

## 7. Decisions and constraints for the owner

1. **Distribution (7.3).** The SDK is proprietary. We do not add it to `package.json` or the
   installer. The loader finds it in `engine.claudeCode.sdkPath`, then
   `<userData>/engines/claude/node_modules`, then the app's own `node_modules` if the owner chooses
   to bundle. An in-app installer that downloads it into `<userData>` (integrity-checked) is the
   follow-up that gives "keeps itself updated" without redistributing it.
2. **Subscription login.** Third-party use of a Claude subscription login is a terms question. The
   gateway path needs no Claude login at all. `own-login` stays off until reviewed.
3. **Gateway wire support is a moving target.** Anthropic adds request fields and block types. The
   pass-through path is immune; the translated path ignores unknown fields and is covered by
   fixtures. Engine updates are applied only after the fixture suite passes.

## 8. Settings

| Setting | Default | Meaning |
|---|---|---|
| `stormcoder.engine` | `builtin` | `builtin` or `claude-code`. Read once at start; changing it prompts for a restart. |
| `stormcoder.engine.fastModel` | `""` | `provider:model` for the harness's small/background calls. Empty = same as the main model. |
| `stormcoder.engine.claudeCode.cliPath` | `""` | Path to the `claude` binary (empty = the SDK's own). |
| `stormcoder.engine.claudeCode.sdkPath` | `""` | Folder containing `@anthropic-ai/claude-agent-sdk`. |
| `stormcoder.engine.claudeCode.auth` | `gateway` | `gateway` or `own-login`. |
| `stormcoder.engine.claudeCode.loadProjectSettings` | `true` | Load `.claude/settings.json` and `CLAUDE.md` in trusted folders. |
| `stormcoder.engine.appendProjectMemory` | `false` | Append Stormcoder's memory block to the harness prompt (costs tokens). |

## 9. Lifecycle

Boot reads `stormcoder.engine` once. If the user changes it, an info message offers "Restart now"
(`app.relaunch`). Nothing switches mid-run. Chats created under the other engine keep their
history; the first engine turn on such a chat starts a fresh engine session and sends a short excerpt
of the earlier messages (the last few, clipped; built without a model call, so it costs no extra
request). Switching engines mid-conversation therefore keeps the gist, not the full history.

## 10. Self-review: gaps found in the earlier plan and their fixes

| Gap | Fix |
|---|---|
| Translating Anthropic traffic would lose `cache_control` and thinking, making Claude cost more than direct. | Pass-through for Anthropic upstreams (C2). Translation only for others. |
| "Auto-update the engine" could silently break the gateway. | Pin and fixture-gate updates (7.3). |
| Default `settingSources` loads user settings. | Always explicit (2.2). |
| Default permission mode may be a classifier. | Always explicit (C4). |
| `canUseTool` is not authoritative. | `PreToolUse` hook is the enforcement point (6). |
| Provider keys could leak to the engine's shell. | Scrubbed env, gateway token only (6). |
| Background `haiku` calls could fail or bill a surprise model. | Alias map with loud failure (C5). |
| Stormcoder side calls would hit a second provider. | Disabled or routed through the selected model (C6). |
| Context-window mismatch (harness assumes 200k). | Gateway sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from the real window and answers over-long prompts with Anthropic's own `prompt is too long` error. |
| Remote approval floor could be bypassed by an engine. | The bridge takes the run's already-resolved `Guardrails` (6). |
| Undo would miss engine edits. | `PreToolUse` records "before", `PostToolUse` records "after" into `RunCheckpoint`. |
| Old chats have no engine session. | Summary seeding (9). |
| Large SSE streams and client aborts. | Backpressure-aware pipe; upstream aborted when the client disconnects. |
| 429/401 from a key. | Registry rotation and cooldown reused, replayed from the buffered body before any byte is sent. |
| Telemetry or auto-update traffic from the engine. | `DISABLE_TELEMETRY`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set. |
| Testing needs a real binary. | The SDK `query` function is injected; tests use a scripted fake. |

## 11. Status

### What exists

| Piece | Where | Verified by |
|---|---|---|
| Messages API translators, SSE writer, error shapes | `src/engine/anthropicWire.ts` | `scripts/test-engine-gateway.mjs` |
| Local gateway: pass-through (byte-identical, key rotation, usage tap) and translation | `src/engine/gateway.ts` | same, 42 tests against a fake Anthropic server and fake providers |
| Model aliasing, per-target capability checks | `src/engine/modelMap.ts`, `capabilities.ts` | same |
| Tool bridge: guardrail parity, trust, allow-list, Undo tracking | `src/engine/toolBridge.ts` | `scripts/test-engine-bridge.mjs`, 16 tests, including the same verdict as `checkCommand` under every policy |
| SDK adapter: options, scrubbed env, message mapping, SDK discovery | `src/engine/claudeEngine.ts` | `scripts/test-engine-claude.mjs`, 26 tests against a scripted fake SDK |
| Engine host: boot-once selection, routes, gateway lifecycle | `src/engine/engineHost.ts` | `scripts/test-engine-host.mjs` |
| Routing seam, restart prompt, post-run review | `src/chatViewProvider.ts`, `src/extension.ts`, `host/controller.ts`, `electron/main.ts` | `test/engine-e2e.mjs` |
| Codex read-only reviewer | `src/providers/codexCli.ts` | `scripts/test-codex-cli.mjs`, router assertions in `scripts/test-auto-router.mjs` |
| Working-tree diff for reviews | `src/git/repo.ts` | `scripts/test-engine-review.mjs` against real git repositories |

`test/engine-e2e.mjs` drives the real app engine and UI in Chromium with a stand-in harness that
behaves like the real one (it calls the gateway over HTTP, runs the hooks it was given, executes
tools). It proves, by counting the requests a mock model receives: a tool turn is exactly the
harness's two requests; no compaction, memory or title request is made; the provider key never
reaches the harness; `rm -rf` is blocked; a follow-up resumes the engine session; a review costs
exactly one extra request and only when a reviewer is pinned and the run changed files; and its
findings reach the engine once. It fails (verified) when the engine setting is `builtin`.

### What is not verified, and why

- **No run against the real `claude` binary or real provider APIs.** The stand-in follows the SDK
  types read from `@anthropic-ai/claude-agent-sdk@0.3.319`, but the real harness may differ in ways
  those types do not show (message ordering, hook timing, how it reacts to a stream that opens late).
  This is the first thing to check with a real key: one Agent turn on a Claude model and one on a
  non-Claude model.
- **Windows and macOS.** Developed and tested on Linux only.
- **The SDK installer** (download into `<userData>/engines/claude`, integrity-checked, update
  prompts). Until then the SDK is installed by hand (`npm install --prefix ... @anthropic-ai/claude-agent-sdk`)
  or pointed to with `stormcoder.engine.claudeCode.sdkPath`.
- **Own-login mode** is implemented (no gateway, Claude models only) but has never been run with a
  real login, and its terms question (7.2) is open.
- **Codex CLI** flags and event names follow `@openai/codex-sdk@0.167.0`; not run against the real
  CLI.
- **Electron smoke, the update test and the Android shell** need binaries that are not in this
  environment and were not run.

### Known limits

- No Settings-panel row for `stormcoder.engine` and its siblings yet (they are in `settings.json`);
  a panel row is a UI change and needs the taste-skill pass.
- In engine mode: no Auto, no inline Edit mode, no mid-run steering, no background commands
  (`run_in_background` is refused), no MCP servers from Stormcoder's list, no Stormcoder skills, and
  `/review` still runs as a normal chat turn rather than through the pinned reviewer.
- Stormcoder's OS-level command sandbox (`agent.sandbox`) does not wrap the harness's `Bash`; the
  hook's guardrails, trust and approvals do.
- A review sees the whole diff against the last commit, so uncommitted work from before the run is
  included. Review runs only for Agent mode in a git repository.
- The translated path emits tool calls when a provider step completes, so a large file write is not
  shown arriving; text streams normally.
- Claude models reached through a translating provider (OpenRouter, a custom gateway) lose
  `cache_control` and thinking. Use the Anthropic provider for Claude to get exact parity with
  Claude Code.

## 12. Using it

1. Install the SDK: `npm install --prefix "<user data>/engines/claude" @anthropic-ai/claude-agent-sdk`
   (or set `stormcoder.engine.claudeCode.sdkPath`).
2. Set `"stormcoder.engine": "claude-code"` in settings and restart when asked.
3. Pick any provider and model in the model picker. For the harness's small background requests set
   `stormcoder.engine.fastModel` to a cheap `provider:model`.
4. Optional second opinion: install the Codex CLI, run `codex login`, and set
   `"stormcoder.auto.reviewModel": "codex-cli:default"`.
