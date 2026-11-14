# Ideas from T3 Code, batch 1: design

Four small features taken from a review of T3 Code. Each ships as its own commit on `t3-ideas`.
Five larger ones (worktree per chat, several models at once, scratch chats, visual replies, voice
input) get their own design later. Worktrees are opt-in per chat: the user decided that.

## Why

Stormcoder runs long agent turns in parallel tabs. Today nothing tells the user a run is waiting
on them unless they are looking at the window, a long run buries its answer under tool cards,
there is no way to see what a provider was asked to spend, and the composer lacks a few things
people reach for daily.

## Non-goals

- No change to guardrails, trust or the approval floor.
- No phone-side changes; remote push is unchanged.
- No "Zen" mode, no per-machine environments, no cost guessing.

## 1. Desktop notifications

- Fires when the window is not focused and a chat posts `approvalRequest` or `askRequest`
  (level `attention`), and also on `done` at level `all`.
- Setting `stormcoder.notifications`: `off | attention | all`, default `attention`.
- Title is the app name; body is fixed text ("A chat needs your approval", "A chat has a question",
  "A run finished"). No command, path, prompt or model output: a notification is shown on the lock
  screen and in the OS history.
- Clicking focuses the window and the chat view. Taskbar flashes until focus.
- At most one notification per kind every 5 seconds.

### Approaches

1. **Tap in the Controller** (chosen): `host/controller.ts` already sees every engine-to-view
   message in `postToView`. A pure classifier in `host/attention.ts` turns a message into an
   attention kind; the Controller calls an optional `ControllerOptions.attention`. The engine is
   untouched and `host/` stays Electron-free.
2. New `UiEvent` raised by the engine: needs a `vscode` API that does not exist, for no gain.
3. Web `Notification` in the shell page: the app refuses every permission request on purpose.

## 2. Collapsed tool activity

- Consecutive finished, successful top-level tool cards fold into one group with a summary:
  "Read 4 files, ran 2 commands". Click to expand.
- A running card and a failed card are never folded. Cards nested under a sub-agent are untouched.
  Approval and question cards are not tool cards and are unaffected.
- A group needs at least 3 cards; fewer stay as they are.
- Setting `stormcoder.chat.toolCalls`: `grouped | all | hideSuccessful`, default `grouped`.
  `hideSuccessful` removes a card when it ends without error.
- Applies to live runs and to rebuilt transcripts alike.

## 3. Composer extras

- **Large paste.** Plain text over 32,768 characters becomes a context chip ("Pasted text, N
  lines") through the existing context-attachment path, not text in the box.
- **Quote.** Selecting text inside an assistant message shows a "Quote" action that inserts it as
  a Markdown quote at the caret.
- **Edit an earlier prompt.** An "Edit" action on a user message loads its text into the composer
  and, on send, truncates the chat to before that message and sends the new text. Files are not
  rolled back; the existing Undo stays the only thing that changes files. Disabled while a run is
  in flight.
- **Prompt stash.** `Ctrl/Cmd+Shift+S` parks the draft (one slot per chat, persisted with the
  queue) and clears the box; pressing it on an empty box restores it.

## 4. Usage view

- Finding: the built-in providers record no token counts. Only the Claude Code engine gateway does.
- `StreamChatResult` and `AgentStep` gain optional `usage: { input, output, cacheRead, cacheWrite }`.
  Filled by the OpenAI-compatible base, Anthropic and Gemini. A provider that reports nothing
  records nothing; the view says "not reported" and never estimates.
- One line per model request in `<userData>/usage.jsonl`: day, provider, model, the four counts.
  No prompt, no path, no project name. Lines older than 90 days are dropped on start.
- Rail view "Usage": totals for today, 7 days, 30 days; table by provider and model; cache hit
  rate. Cost only when the model catalog has a price; otherwise tokens only.
- Desktop-only (`REMOTE_DENIED`).

## Left to the builder

Exact copy, CSS, and where each helper lives inside `media/main.js`.
