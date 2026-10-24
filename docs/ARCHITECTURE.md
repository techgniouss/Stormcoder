# Architecture

## Processes

- **Main process** (`electron/main.ts`) creates the window, registers the `stormcoder-asset://` protocol that serves the UI, and owns a `Controller` (`host/controller.ts`). The Controller runs the chat engine in the same process.
- **Shell page** (`shell/`) is the only renderer. It draws the rail, command palette, prompts, toasts and file editor, and hosts two iframes: `chat` and `settings`. The iframes load the chat UI (`media/`) exactly as it was written for an editor webview.
- **Preload** (`electron/preload.ts`) exposes a fixed set of named calls as `window.stormcoder`. The page has no Node access and cannot reach other IPC channels.

## Messages

A chat UI message goes iframe → `postMessage` → shell → preload → main → `Controller.handleCall('sendToView')` → the engine's `webview.onDidReceiveMessage`. Replies take the reverse path. `shell/bridge.js` gives each frame the `acquireVsCodeApi()` object the chat UI expects.

Engine requests for UI (`showInformationMessage`, `showQuickPick`, `showInputBox`, `showOpenDialog`, `showTextDocument`) become `ui:request` messages the shell answers; progress and status are `ui:event` notifications.

## The `vscode` layer

`host/vscode.ts` implements: `Uri`, `Range`/`Position`, `EventEmitter`, `Disposable`, `CancellationTokenSource`, configuration (defaults generated from the engine's manifest into `host/config-defaults.json`), `Memento` state, `SecretStorage`, `workspace` (fs, `findFiles`, `openTextDocument`, `applyEdit`, trust), `window` dialogs and output channels, `commands`, `env`, and webview objects. `workspace.findTextInFiles` is deliberately absent: `agent/tools.ts` detects that and uses its own search.

`host/env.ts` is the injection point (`HostEnvironment`). `host/` never imports `electron`, which is why the same engine runs under the browser dev host (`electron/devHost.ts`) and in tests.

## Folders, trust and state

Opening a folder asks once whether to trust it. A trusted folder lets the agent write files and run commands and lets project MCP servers start; a read-only one does not. Changing folder restarts the engine against the new folder (state such as chats is per project; settings and secrets are global). User data lives in Electron's `userData` directory: `settings.json`, `secrets.json`, `state/`, `logs/`.

## Memory

`src/memory/projectMemory.ts` holds everything. A `MemoryStore` is a folder with `memory.md` (typed, dated one-line facts, `*` after the type marks a pin; written by the `remember` tool, the panel, `/memory add`, or by hand). A project's store (`<project>/.stormcoder`) also keeps `journal.jsonl` (one line per run that changed files: goal, files, whether a verification command passed afterwards, taken from `WorkLog`) and `proposals.json` (suggestions waiting for a yes or no). The user's own store lives under the app's data folder and is shared by every project. A legacy `.openvs/memory.md` is read, never written. Read-modify-writes are queued per folder so parallel chats cannot overwrite each other.

`buildPromptBlock` assembles the system-prompt block once per chat session (the user's notes, the project's facts with pins first, the last few journal lines) and `ChatViewProvider` reuses it for the whole session, so a fact saved mid-conversation does not change the prompt prefix a caching backend matches on; it appears in the next session. The block is capped at about 1,700 tokens, the compact prompt gets a smaller cut, and the project half is skipped in an untrusted folder (a cloned repository's memory file is text anyone could have written). `recall` (read-only, so Ask and Plan have it) searches both stores, the whole journal and past chats by keyword, which is how memory can outgrow the block. `remember` goes through the normal write approval, refuses anything that looks like a credential, skips repeats, and drops the oldest agent-written lines, never pinned or hand-written ones, when the file outgrows its budget. A request that contains a credential is not quoted in the journal or in a suggestion.

With `stormcoder.memory.autoPropose` on, `ChatViewProvider.proposeMemory` makes one detached model request after a run that changed files and queues what it suggests in `proposals.json`; nothing is saved until the user accepts it in Settings > Memory. The panel and `/memory` are desktop-only (`REMOTE_DENIED`).

## Security notes

- Secrets use `safeStorage` (OS keychain). Without one, AES-256-GCM with a random key in a `0600` file: protection against copying the file, not against another process running as you.
- The asset protocol serves only `media/`, `shell/`, `skills/`, `relay-pwa/` and generated view HTML, with path traversal refused.
- The built-in file editor only opens files inside the user data directory and the project's `.stormcoder/` and `.vscode/` folders.
- Windows, navigation and `window.open` from the page are blocked; links open in the system browser.
- The agent's guardrails (`src/agent/guardrails.ts`) are enforced in code and are unchanged.

## Tests

`scripts/test-*.mjs` drive the engine through the real modules with `vscode` stubbed. `scripts/test-host.mjs` covers the compatibility layer. `test/e2e.mjs` runs the real engine and UI in Chromium against a mock OpenAI-compatible server (a chat turn, an agent run that writes a file, settings, the palette). `test/electron-smoke.mjs` launches the real Electron app, or an installed build with `MJ_PACKAGED=<path to binary>`.
