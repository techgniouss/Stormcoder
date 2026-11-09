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

`codex exec --json` with `--sandbox read-only|workspace-write|danger-full-access`,
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
- **Parity with the built-in loop:** the user's own `stormcoder.hooks` (PreToolUse veto, PostToolUse
  feedback) run for harness calls; `agent.maxSubagents` and `maxSubagentDepth` cap the harness's
  sub-agents; `agent.commandTimeoutMs` clamps a command's timeout (through the hook's rewritten
  input); `agent.sandbox` becomes the harness's own fail-closed OS sandbox, and a request to leave
  it is refused; `Glob`/`Grep` are judged by their patterns as well as their paths.
- **The panel's messages are desktop-only:** `setEngine`, `installEngine`, `setEngineFast` and `restartApp` are in `REMOTE_DENIED`, and the engine block is stripped from the config a paired phone receives, so a phone can neither switch the engine, start a download, nor restart the app.
- **Never set:** `allowDangerouslySkipPermissions`, `bypassPermissions`, `user` settings, or any plugin other than the one Stormcoder writes itself (below).
- **MCP:** `strictMcpConfig: true`, so the harness may use only the servers Stormcoder passes in `mcpServers` and never discovers its own. See section 6a.

### 6a. MCP servers and skills in the engine

Each is loaded **by the harness alone**: the engine path never starts Stormcoder's own MCP clients and never pastes skill text into a prompt, so nothing runs or costs twice. (When the engine cannot start and the built-in agent serves the message, the built-in agent loads them itself, and the harness never ran.)

- **MCP.** `McpManager.resolveForEngine()` reads the same sources as the built-in agent (the `stormcoder.mcp.servers` setting, then `.stormcoder/mcp.json`, `.openvs/mcp.json`, `.vscode/mcp.json`) and applies the same vetting: well-formed config, trusted folder, the user's consent for a server a *project* defines (remembered against a hash of its config), `${env:NAME}` expanded only in the user's own settings. It starts nothing. The result goes to the SDK as `mcpServers` (`stdio` or `http`). Only an Agent chat in a trusted folder is given servers: that is the only place their tools may run. A server with a `cwd` is skipped with a note, because the harness cannot set a server's working directory.
- **MCP policy.** A tool named `mcp__*` passes the same bridge as every other tool: the user's `stormcoder.hooks` first, then denied in a read-only or untrusted chat, then an approval card (kind `mcp`, signature = the tool name, so "always allow" works) unless the approval policy is `yolo`. This matches the built-in loop. The harness does not tell the hook whether a tool is read-only, so there is no read-only fast path.
- **One place only, everywhere.** In engine mode the **Reconnect MCP servers**, **MCP status** and **Add MCP server** commands and the Settings list do not start servers either: they list what the engine will load. Listing never raises the consent dialog for a project's server (it says "waiting for your approval"); the question is asked when an Agent chat starts, and concurrent starts share one question.
- **Slow servers.** The harness does not wait for MCP servers at start, so with servers configured the model is also given the harness's `ToolSearch` (to load tools it defers) and `WaitForMcpServers` (to wait for one still connecting).
- **MCP status.** The harness reports each server's state at start, and again about eight seconds into the turn (most are still connecting at start); a server that `failed` or `needs-auth` is named in the chat once, until it recovers. The Settings MCP list shows the servers the engine will load (it does not start them) and why any were left out.
- **Skills.** Stormcoder's skills are written as `SKILL.md` files in a small local plugin (`<userData>/engines/skills-plugin/<digest>/`, written atomically, one folder per distinct set, the newest few kept) and passed as `plugins` with `skills: 'all'`. This is how Claude Code loads skills itself: the model sees each skill's one-line description and opens the body through the `Skill` tool only when it applies, so an unused skill costs a line, not thousands of tokens. The plugin holds skills only (no hooks, commands or MCP; `skipMcpDiscovery`), and `!`command`` in a skill body, which Claude Code would run when the skill loads, is defused. A plugin folder used within the last hour is never pruned, so a long run keeps its skills. Offered: skills the user wrote (settings, or `.stormcoder/skills`; project ones only in a trusted folder) always, and the bundled ones (Caveman, Impeccable, ...) only while switched on, as in the built-in agent. A skill switched on in Stormcoder adds one line to the harness's prompt asking it to open that skill first. A project's own `.claude/skills` loads natively when `engine.claudeCode.loadProjectSettings` is on (settings source `project`).
- **Tool names.** Providers other than Anthropic refuse a tool name longer than 64 characters or with a dot, and one refused name fails the whole request. `mcp__server__tool` names often are. The gateway shortens such a name (a hash keeps two apart) on the way out and restores it on the way back; names that already fit are untouched, and a Claude model on the Anthropic API is forwarded as is.
- **Known behaviour.** The harness starts its MCP servers for each turn, as `claude -p` does. The SDK passes `mcpServers` on the harness's command line, so a header or environment value written in a server's config can be seen by other users of the same machine in the process list; keep tokens in `${env:NAME}` references only if that matters on a shared machine, and note the expanded value is still what is passed. MCP resources and prompts are not offered, only tools.

## 7. Decisions and constraints for the owner

1. **Distribution.** The SDK is proprietary. We do not add it to `package.json` or the installer. The
   **Install Claude Code Engine** command (also reached by choosing the engine) downloads it from the
   npm registry into `<userData>/engines/claude` after a modal notice naming Anthropic's terms. Each
   download is verified against the registry's published hash, extraction refuses anything outside its
   folder, and the new install is swapped in atomically, so a failed or cancelled install leaves a
   working one untouched. `stormcoder.engine.registry` points it at a company mirror (https only). The
   loader also finds the SDK in `engine.claudeCode.sdkPath`, or in the app's own `node_modules` if the
   owner decides to bundle it. A module is cached per process, so an updated SDK takes effect after a
   restart (the install message says so).
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
| `stormcoder.engine.registry` | `""` | npm registry for the in-app installer (a company mirror). Empty = the public registry. https only. |
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
| Messages API translators, SSE writer, thinking filter, error shapes | `src/engine/anthropicWire.ts` | `scripts/test-engine-gateway.mjs` |
| Local gateway: pass-through (byte-identical, key rotation, usage tap) and translation | `src/engine/gateway.ts` | same, 51 tests against a fake Anthropic server and fake providers |
| Model aliasing, per-target capability checks | `src/engine/modelMap.ts`, `capabilities.ts` | same |
| Tool bridge: guardrails, trust, allow-list, user hooks, sub-agent caps, timeout clamp, Undo tracking | `src/engine/toolBridge.ts` | `scripts/test-engine-bridge.mjs`, 25 tests, including the same verdict as `checkCommand` under every policy |
| SDK adapter: options, scrubbed env, sandbox mapping, message mapping, wall-clock limit, SDK discovery | `src/engine/claudeEngine.ts` | `scripts/test-engine-claude.mjs`, 38 tests against a scripted fake SDK |
| Engine host: boot-once selection, routes, gateway lifecycle, preflight, start-failure circuit breaker | `src/engine/engineHost.ts` | `scripts/test-engine-host.mjs` |
| SDK installer: verified download, streaming tar extraction, atomic swap | `src/engine/installer.ts` | `scripts/test-engine-installer.mjs` (22 tests, every failure leaves the old install intact); the extractor was also compared byte for byte with system `tar` on two real npm packages |
| Routing seam, fallback, restart prompt, post-run review, `/review` | `src/chatViewProvider.ts`, `src/extension.ts`, `host/controller.ts`, `electron/main.ts` | `test/engine-e2e.mjs` |
| Settings > Agent engine panel (option cards, SDK status, install, restart, fast model) | `src/webviewHtml.ts`, `media/main.js`, `shell/frame.js`, `src/chatViewProvider.ts` | `test/engine-panel-e2e.mjs`, through the real UI; the desktop-only classification and the phone redaction are in `scripts/test-remote-policy.mjs` and `test-remote-redaction.mjs` |
| Palette commands: choose engine, install SDK | `src/extension.ts` | `test/engine-commands-e2e.mjs`, through the real UI |
| Codex read-only reviewer | `src/providers/codexCli.ts` | `scripts/test-codex-cli.mjs`, router assertions in `scripts/test-auto-router.mjs` |
| Per-file working-tree diff for reviews | `src/git/repo.ts` | `scripts/test-engine-review.mjs` against real git repositories |

`test/engine-e2e.mjs` drives the real app engine and UI in Chromium with a stand-in harness that
behaves like the real one (it calls the gateway over HTTP, runs the hooks it was given, executes
tools). It proves, by counting the requests a mock model receives: a tool turn is exactly the
harness's two requests; no compaction, memory or title request is made; the provider key never
reaches the harness; `rm -rf` is blocked; a follow-up resumes the engine session; a review costs
exactly one extra request, only when a reviewer is pinned and the run changed files, and covers only
the files that run changed; `/review` goes to the reviewer and not to the harness; the findings
reach the engine once; and when the SDK is missing or the harness cannot start, the built-in agent
answers instead and the composer stays usable. It fails (verified) when the engine setting is
`builtin`.

### Never breaking the app

The engine is an optional layer around a working app, and it is built so that it can only ever
degrade to the built-in agent, not take the app down:

- Selecting the engine without a usable SDK, a gateway that cannot start, an SDK import that hangs
  (20 second limit), or a harness that produces nothing at all: the message is served by the built-in
  agent with a one-time note. After two start failures in a row the engine is left alone for five
  minutes instead of launching a failing process on every message.
- A harness that sends nothing for 60 seconds is judged not to have started and stopped. A saved
  engine conversation the harness no longer has is replaced by a fresh one, once, with the earlier
  messages summarised; the user is not troubled with it.
- Edit mode (an editor feature, not an agent loop) always uses the built-in path.
- An engine turn always ends with `done`; every failure inside it is a message in the chat. A hung
  turn is stopped by `agent.maxRunMinutes`; Stop works at any point.
- The gateway cannot be crashed by a client: socket errors are handled, writes to a client that left
  are dropped, a stalled or vanished client frees its request, oversized bodies get a 413, buffers
  are bounded.
- The installer cannot damage a working install and cannot throw from a failing disk: stream errors
  are caught where they occur.
- A review is optional, bounded (git snapshots time out at 15 seconds, the Codex process at 15
  minutes) and its failure is a note, never a failed turn.
- Settings and stored state are validated, so a hand-edited file cannot start the engine in a bad state.

### What is not verified, and why

- **MCP and skills have not run against the real harness.** The options follow the SDK's types
  (`mcpServers`, `plugins`, `skills`) and the stand-in harness receives them, but three things need a
  real run: (1) the harness starts MCP servers without waiting by default, so on a one-turn process the
  first request may be built before a slow server has connected (the model has `WaitForMcpServers` for that, unverified); (2) with the gateway's local address as
  the base URL the harness may switch off its tool-search deferral for MCP tools, which would put every
  MCP tool definition in each request (more tokens than Claude Code direct for a large server set;
  `ENABLE_TOOL_SEARCH` is the knob to check); (3) that a plugin skill shows as `stormcoder:<name>` and
  opens through the `Skill` tool. Check with a real key and a small MCP server.
- **No run against the real `claude` binary or real provider APIs.** The stand-in follows the SDK
  types read from `@anthropic-ai/claude-agent-sdk@0.3.319`, but the real harness may differ in ways
  those types do not show (message ordering, hook timing, how it reacts to a stream that opens late,
  whether it accepts every key in the sandbox settings). This is the first thing to check with a real
  key: one Agent turn on a Claude model and one on a non-Claude model. If the real harness refuses to
  start, the fallback above keeps the app working while that is sorted out.
- **Windows and macOS.** Developed and tested on Linux only. The installer selects the right platform
  build and handles `.exe` and musl, but has only run here.
- **Own-login mode** is implemented (no gateway, Claude models only) but has never been run with a
  real login, and its terms question (7.2) is open.
- **Codex CLI** (checked against `@openai/codex` 0.167.0): the flags (`exec --json --sandbox read-only --skip-git-repo-check`, prompt on stdin) are accepted, and the provider was run against the real binary signed out. Its real event stream (`thread.started`, `turn.started`, retry `error` events, `turn.failed`) is replayed in `scripts/test-codex-cli.mjs`, and the failure surfaces as `exited with code 1: unexpected status 401 ... Run \`codex login\``, after about 17 seconds of the CLI's own retries. **Not verified:** a signed-in review (the `item.completed` / `agent_message` success event is taken from the SDK's types), and Windows. The old flag name `--experimental-json` was replaced by the documented `--json`; an older CLI that lacks `--json` fails with the CLI's own message.
- **The installer against the real npm registry.** It is tested against a stand-in registry serving
  real tarballs, and its extractor against two real packages; the registry's response shape is the
  documented abbreviated-metadata format.
- **Electron smoke, the update test and the Android shell** need binaries that are not in this
  environment and were not run.

### Known limits

- With the engine on: no Auto (an explicit Auto selection runs on the chat's own model, and the chat
  says so), no mid-run steering, no background commands (`run_in_background` is refused). MCP servers and
  skills work (section 6a); not offered: MCP resources and prompts, and an MCP server with a `cwd`.
- The translated path emits tool calls when a provider step completes, so a large file write is not
  shown arriving; text streams normally.
- Claude models reached through a translating provider (OpenRouter, a custom gateway) lose
  `cache_control` and thinking. Use the Anthropic provider for Claude to get exact parity with Claude Code.
- A review covers whole files the run touched; if the run edited a file that already had uncommitted
  changes, the file's earlier changes are in the diff too. Review runs only for Agent mode in a git
  repository.

## 12. Using it

1. Open **Settings > Agent engine** and pick the Claude Code engine (or run **Stormcoder: Choose Agent
   Engine** from the command palette). It offers to install the SDK first, after a notice naming
   Anthropic's terms; **Install Claude Agent SDK** on the same page does just the download. The page
   shows which engine is running, which is selected for next start, and the installed SDK version.
   Restart when asked (the page has a **Restart now** button).
2. Pick any provider and model in the model picker. For the harness's small background requests set
   `stormcoder.engine.fastModel` to a cheap `provider:model`.
3. Optional second opinion: install the Codex CLI, run `codex login`, and set
   `"stormcoder.auto.reviewModel": "codex-cli:default"`. It then reviews each Agent run that changed
   files, and `/review` goes to it directly.
4. To go back: choose the built-in agent in the same command, or set `"stormcoder.engine": "builtin"`.
