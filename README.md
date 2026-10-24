<p align="center"><img src="docs/screenshots/icon.png" width="128" alt="Stormcoder"></p>

# Stormcoder

A standalone desktop AI coding workspace. Chat with any model, plan a change, or hand a task to an agent that reads, edits and runs code in your project. It is its own application: there is no VS Code underneath.

Stormcoder is the desktop home of the Stormcoder chat engine (previously an extension for a VS Code fork), rebuilt as an Electron app with its own interface.

![Stormcoder, dark theme](docs/screenshots/chat-dark.png)

## What you get

- **Many providers, one place.** OpenAI, Anthropic, Google Gemini, OpenRouter, NVIDIA, Groq, Mistral, Cloudflare Workers AI, Kimi, Qwen, Z.AI, OpenCode Zen, GitHub Copilot, Grok, Kiro, and any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM). Sign in with a ChatGPT or Claude account where the provider allows it, or paste a key. Keys rotate on rate limits and cool down on quota errors.
- **Ask, Plan and Agent modes.** The agent has file, search, shell and `fetch_url` tools, sub-agents, a todo list it must finish, and an Undo for every run. **Auto** mode routes planning, implementation and review to different models from the keys you hold.
- **Parallel chats.** Tabs stream at the same time. Type while a run is going to queue a message or steer the agent. History is kept and can be reopened.
- **Skills and rules.** Instruction packs you switch on per chat, plus always-on rules from `AGENTS.md`, `.stormcoder/rules.md` and similar files.
- **Memory.** Stormcoder remembers between chats. The agent saves short facts with `remember` (a build quirk, a convention, a decision), each run that changes files is journaled, and `recall` searches all of it, plus past chats, on demand. New chats start with your own notes, the project's saved facts and the last few runs, capped at about 1,700 tokens. Review, pin, edit, delete and add notes in Settings > Memory, or type `/memory`. Optionally the model suggests notes after a run for you to accept. Files live in `.stormcoder/` and are git-ignored by default; your personal notes live in the app's data folder. Switch it all off with `stormcoder.memory.enabled`.
- **MCP servers.** Stdio and HTTP (Streamable HTTP and legacy SSE), per project or global. Project servers ask before they start.
- **Remote control.** Pair a phone through a relay (hosted on Cloudflare, or served from your machine through a tunnel) to send messages and answer approvals away from the desk. Messages are end-to-end encrypted between the phone and the desktop; the relay only routes sealed frames (see `docs/REMOTE-E2E.md`).
- **Polished to use.** Searchable model and provider menus, an app menu, a project switcher, right-click menus, a copy button on every message, styled tooltips, a shortcuts sheet (`?`), and dark and light themes.
- **Hard guardrails.** Protected paths, denied commands, workspace confinement and untrusted-folder write blocking are enforced in code, whatever the model says.

| Light theme | Settings |
| --- | --- |
| ![Light theme](docs/screenshots/chat-light.png) | ![Settings](docs/screenshots/settings-dark.png) |

| Welcome | Command palette |
| --- | --- |
| ![Welcome screen](docs/screenshots/hero-dark.png) | ![Command palette](docs/screenshots/palette-dark.png) |

| Model menu | App menu |
| --- | --- |
| ![Model menu](docs/screenshots/model-menu-dark.png) | ![App menu](docs/screenshots/app-menu-dark.png) |

## Using it

Download an installer from the Releases page, open a project folder, and add a provider in Settings. Press `Ctrl+K` (`Cmd+K`) for the command palette. `Ctrl+1` to `Ctrl+4` jump between Chat, History, Skills and MCP servers, and `Ctrl+,` opens Settings.

Settings are in `settings.json` (palette: *Edit settings.json*). API keys are stored with your operating system's keychain; where there is none, they are encrypted in a local file and Stormcoder says so in the title bar.

## Develop

```bash
npm install
npm run build          # bundles the app into dist/
npx electron .         # run the desktop app
npm run dev:web        # same engine and UI in a browser, for quick UI work
npm test               # typecheck, unit tests, browser end-to-end, Electron smoke
npm run dist           # installers for the current OS into release/
```

Node 22 or newer. The end-to-end tests need Chromium (`npx playwright-core install chromium`) and, for the Electron smoke test, a display (`xvfb-run` on Linux CI).

## How it fits together

```
 shell page (shell/)            host (Electron main process)             engine (src/)
 rail, palette, prompts   <-->  Controller: folder, trust, requests <--> providers, agent loop,
 two frames: chat, settings     preload bridge, asset protocol           MCP, sessions, remote
        |                                  |                                   |
        +---- postMessage ---- ipc -------+---- `vscode` API slice (host/) ---+
```

The engine under `src/` was written against the VS Code extension API. Instead of forking it, `host/vscode.ts` implements the slice it uses (settings in JSON, encrypted secrets, workspace files, dialogs, webviews as frames) so the engine runs unchanged. Editor-only features (inline completions, code actions, the active text editor) are not part of this app. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Design

The interface follows the app style from [taste-skill](https://github.com/Leonxlnx/taste-skill), pushed toward something warmer than its flat default: layered surfaces, an electric blue accent used for selection and the one primary action, soft depth where things float, and motion that confirms what you did (a sliding rail indicator, crossfading views, staggered entrances, a travelling run line). Dark and light themes share one token set in `shell/tokens.css`. The typeface is Public Sans (SIL OFL), bundled for offline use.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | The chat engine: providers, agent, auto routing, MCP, sessions, remote |
| `host/` | The `vscode` API layer and the Electron-free `Controller` |
| `electron/` | Main process, preload bridge, menu, browser dev host |
| `shell/` | The desktop shell page and the theme applied to the chat frames |
| `media/` | The chat UI (transcript, composer, settings), unchanged from the extension |
| `openvs-relay/`, `relay-pwa/` | The phone relay (Cloudflare Worker) and its web app |
| `scripts/`, `test/` | Unit tests (`scripts/test-*.mjs`), end-to-end and Electron tests, build scripts |

## License

MIT. Public Sans is under the SIL Open Font License.
