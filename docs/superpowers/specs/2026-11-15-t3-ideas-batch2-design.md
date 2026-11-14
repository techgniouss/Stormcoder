# Ideas from T3 Code, batch 2: design

Five larger features. Each one moves a line the app currently enforces in code (which folder the
agent is confined to, what a folder-less chat may do, what the page may load, whether the page may
use the microphone), so each needs a decision before it is built. Recommended choices are marked.

Status: proposed, not built.

## 5. Worktree per chat (opt-in, decided)

### What was found

The agent's working folder is process-wide: `vscode.workspace.workspaceFolders`, read in 30 places
(`guardrails.ts` confinement, `tools.ts` path resolution, shell cwd, sandbox writable roots,
verification commands, rules, skills, memory, MCP, the engine). Parallel chats share it, which is
why two agents can edit the same file today.

### Approach (recommended)

A run scope, not a rewrite of 30 call sites.

- `host/vscode.ts` keeps an `AsyncLocalStorage<{ folder: string }>`. `workspace.workspaceFolders`
  returns the scoped folder while a run for a worktree chat is in flight, and the open project
  otherwise. Every confinement check, path resolution, command cwd and sandbox root then sees the
  worktree as the workspace for that run, and the original project as outside it. Confinement is
  unchanged in strength: one folder, a different one.
- A second accessor, `projectFolders()`, always returns the open project. Memory, project rules in
  `.stormcoder/`, skills and MCP use it, because those files are git-ignored and do not exist in a
  worktree.
- Worktrees live in `<userData>/worktrees/<project key>/<chat id>`, on branch
  `stormcoder/<short title>-<id>`, created with `git worktree add -b` from the current `HEAD`.
  Created only in a trusted folder with a git repository; the worktree inherits that trust.
- The chat tab shows the branch. The Changes view follows the active chat's folder.
- Closing the chat removes the worktree folder when it has no uncommitted changes and keeps the
  branch; with changes it asks. Nothing is ever force-removed.

### Other approaches considered

- Thread a `root` parameter through every tool and guardrail call: the most explicit, but it is a
  change to every line of the confinement code, and one missed call site silently escapes to the
  project folder.
- One engine process per chat: clean isolation, but the engine, MCP servers and memory are
  process-wide by design and would all start once per chat.

### Not in scope

The Claude Code engine (it takes its own `cwd`; a follow-up), merging a worktree branch back, and
worktrees for sub-agents.

## 6. Same prompt to several models

Needs 5. Shift-clicking models in the model menu of a new chat selects several; sending starts one
chat per model, each in its own worktree, each as an ordinary tab. No comparison view in the first
version. Capped at 4 models per send. Requires a git project; without one the option is not offered.

## 7. Scratch chats

A chat with no project folder. **Decision needed: what may it do?**

- **Recommended: Ask and Plan only, in a folder under `<userData>/scratch/<date>-<words>-<id>`
  that is trusted by construction** (the app created it, nothing was cloned into it), with Agent
  allowed there. "Turn into project" opens that folder as a normal project.
- Alternative: Ask only, no folder at all. Smaller, but the agent cannot write the file you asked
  it to make, which is most of why T3 Code has this.

Today opening a folder restarts the engine against it, so a scratch chat is its own project in
practice: this is mostly a "New scratch chat" command that creates the folder and opens it.

## 8. Visual replies

The agent answers with a self-contained HTML page (chart, table, mockup) shown in the thread.

- New tool `show_page` (title, html). The page is saved under `.stormcoder/pages/` and shown in an
  `<iframe sandbox="allow-scripts">` with no `allow-same-origin`, loaded from a new
  `stormcoder-page://` protocol whose responses carry a CSP of `default-src 'none'; script-src
  'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`. No network, no access to the app,
  its storage or the parent frame. Links do nothing.
- **Decision needed: allow CDN scripts?** Recommended: no. Charts are drawn with inline script or
  SVG. Allowing a CDN lets a page (which may be written by a model that read an untrusted web
  page) send data out.
- Size cap 512 KB per page. Local images are embedded as data URIs at save time, 2 MB cap.
- Counts as a file write for approvals, like any other write under `.stormcoder/`.

## 9. Voice input

Dictation into the composer. The transcript lands in the box for review; nothing is sent to a
model until the user presses Send.

- **Decision needed: the app refuses every permission request on purpose (`electron/main.ts`).**
  Voice needs the microphone. Recommended: allow `media` for audio only, only from the app's own
  origin, only while the setting is on (default off).
- Transcription through a provider the user already holds a key for: OpenAI, Groq or a custom
  OpenAI-compatible endpoint (`/audio/transcriptions`). No on-device model in the first version.
- Audio is sent to that provider and not kept. The setting names which provider receives it.

## Order

5, 6, 7, 8, 9. Each is its own commit with tests, as in batch 1.
