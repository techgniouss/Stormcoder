# Ideas from T3 Code, batch 1: implementation plan

**Goal:** Ship desktop notifications, collapsed tool activity, composer extras and a usage view.

**Architecture:** Each feature is one commit. Pure logic goes in a small module with a
`scripts/test-*.mjs` test; UI glue stays in the files that already own that surface.

**Tech stack:** TypeScript (engine, host, Electron), one-IIFE webview JS, esbuild, node:assert tests.

**Spec:** `docs/superpowers/specs/2026-11-14-t3-ideas-batch1-design.md`

## Global constraints

- `host/` never imports `electron`.
- Tabs, single quotes, braces always, JSDoc on functions and classes.
- Colours, borders and durations only from `shell/tokens.css`; no emoji; menus from `StormMenu`.
- New settings go in `ext-package.reference.json` + `ext-package.nls.reference.json`, then `npm run gen`.
- Webview ids and message types must match both ways (`scripts/test-webview.mjs`).
- Typecheck before tests. One commit per task, after `npm run typecheck` and the unit tests pass.

## Review focus

1. A notification body leaking a command or path: body text is a fixed string per kind.
2. A burst of approvals producing a burst of notifications: throttled per kind.
3. A failed tool card hidden inside a collapsed group: failed cards are never folded.
4. Editing an earlier prompt while a run is in flight: action disabled, host refuses too.
5. A provider reporting partial usage (no cache fields): missing counts are 0, never NaN.

## Task 1: Desktop notifications

**Files:** create `host/attention.ts`, `scripts/test-attention.mjs`; modify `host/controller.ts`,
`electron/main.ts`, `ext-package.reference.json`, `ext-package.nls.reference.json`, generated JSON.

**Interfaces (produces):**
- `type AttentionKind = 'approval' | 'question' | 'done'`
- `type AttentionLevel = 'off' | 'attention' | 'all'`
- `attentionFor(message: unknown, level: AttentionLevel): AttentionKind | undefined`
- `attentionText(kind: AttentionKind): string`
- `class AttentionThrottle { constructor(windowMs: number, now?: () => number); allow(kind): boolean }`
- `ControllerOptions.attention?(kind: AttentionKind): void`

Steps: failing test (classifier per level, non-object input, throttle window, fixed strings contain
no message fields) -> implement -> wire Controller `postToView` for view `chat` -> Electron
`Notification` + `flashFrame` when the window is not focused -> typecheck, tests, commit.

## Task 2: Collapsed tool activity

**Files:** create `media/toolGroups.js` (global `StormToolGroups`, pure), `scripts/test-tool-groups.mjs`;
modify `media/main.js`, `media/main.css`, `src/webviewHtml.ts` (script tag), config files.

**Interfaces (produces):**
- `StormToolGroups.summarize(names: string[]): string` (at most two categories, then "and N more")
- `StormToolGroups.category(name: string): 'read' | 'edit' | 'command' | 'search' | 'other'`
- `StormToolGroups.MIN_GROUP = 3`

Steps: failing test for `summarize`/`category` -> implement -> in `main.js`, after `toolEnd`, fold
runs of finished successful sibling cards into a `<details class="tool-group">`; honour the setting
from the `config` message -> contract test, e2e selector check, commit.

## Task 3: Composer extras

**Files:** modify `media/main.js`, `media/main.css`, `src/chatViewProvider.ts` (truncate-and-resend
message `editPrompt`), `src/session/store.ts` (truncate helper), tests in `scripts/test-webview.mjs`
and a store test.

Steps, one sub-commit each: large paste -> quote -> stash -> edit earlier prompt (store test first).

## Task 4: Usage view

**Files:** create `src/usage/usageLog.ts`, `scripts/test-usage.mjs`, `shell/usage.js`, `shell/usage.css`;
modify `src/providers/types.ts`, `openaiCompatible.ts`, `anthropic.ts`, `gemini.ts`,
`src/agent/agentRunner.ts`, `host/controller.ts` (`usage.read` app command), `shell/index.html`, `shell/shell.js`.

**Interfaces (produces):**
- `interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }`
- `class UsageLog { constructor(file: string); record(e: UsageEntry): void; read(sinceDay: string): UsageEntry[]; prune(beforeDay: string): void }`
- `summarize(entries: UsageEntry[]): UsageSummary`

Steps: log + summarize test -> implement -> provider plumbing with fixture tests -> view -> commit.

## Self-review

Spec coverage: every numbered section has a task. Types match across tasks. Review-focus lines 1-2
are tested in Task 1, 3 in Task 2, 4 in Task 3, 5 in Task 4.
