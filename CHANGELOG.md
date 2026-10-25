# Changelog

## Unreleased

- Settings > Remote control redesigned from a taste-skill review. The pairing card is a two-column card: the QR code on the left, the pairing key set large with a line that shortens as the two minutes run out, and the link below at full width. The panel uses the app's colour tokens instead of VS Code fallbacks, the on/off control is a real switch placed before the state it controls, the error line keeps its space so nothing jumps, and paired devices show when they were paired and last seen with a quiet Revoke. The relay explanation moved into "Which relay is used?".
- Phone app and Android app: the provider and model pickers open an in-app sheet on touch phones, listing every name in full (the OS popup clipped long model ids). The controls are laid out with the mode and provider on one row and the model below it, whether there is one provider or several. Desktop browsers keep the styled dropdown.
- Phone and Android app polish from a taste-skill review. Pairing: scanning is the main action in the Android app, with the pasted link beneath it, a line saying where the code is on the desktop, and no shouted uppercase placeholder. Header: "Connected · <desktop folder>" and icon-only History and New; a single chat shows no tab strip, and only the open chat has a close button. Composer: Ask / Plan / Agent as a segmented control, the provider picker hidden when there is only one provider, and the attach buttons say Image, File and Improve. Tool rows read "Running npm test" instead of `run_command`, and code blocks have a Copy button. Android: Stormcoder launcher icon and launch screen (light and dark), Back button handling, and explicit system-bar handling.
- Android app for remote control, in its own `android/` folder (Capacitor; see `android/README.md`). It bundles the phone app, so the relay no longer delivers the app's code. Nothing else in the repo depends on it. The phone app gained a small seam for it: inside the shell it takes the relay address from the pairing link, can scan the QR code, and skips the service worker; in a browser nothing changes. Tested here: the bundle, and pairing and encrypted traffic in a browser with the shell's contract. Not tested here: the Gradle build, the APK, the camera and native HTTP on a real device. No push notifications in the app yet.
- Remote control is now end-to-end encrypted. A paired phone and the desktop share keys the relay never sees, so the local relay, a Cloudflare tunnel and your own Worker can route messages but cannot read, change, replay or forge them (including an approval). The pairing key travels only in the QR code or link fragment, which is never sent to a server; it also stands in for the old typed code. There is no unencrypted fallback and push notifications carry only generic text. Specification: `docs/REMOTE-E2E.md`. What this does not cover: the relay still serves the phone app's own code, so a malicious relay could serve a modified app. Phones paired before this change must pair again, a self-hosted Worker relay must be redeployed, and clearing a phone's site data means pairing again. A link too long for the QR encoder now says so and keeps the link and key on screen.
- Remote control, checked end to end and hardened. A new `test/remote-e2e.mjs` (now part of `npm test`) runs the real engine and local relay with a phone-sized browser: pairing, a streamed reply, an agent run with approve and deny, a question card, steer and stop, slash commands (`/undo` and `/compact` work, `/memory`, `/mcp` and `/skill new` are refused), 15 desktop-only messages rejected, reconnect after the link drops, revoke, and secret redaction. Fixes from it and from a security review:
  - The local relay no longer crashes or leaks a socket on a malformed or hostile upgrade request (`//`, `room=__proto__`), and has request timeouts.
  - Every message to a phone is scrubbed for credentials, not only tool output (streamed replies, replayed transcripts, MCP status and more), with new patterns for `*_SECRET=` variables, URL passwords and `mysql -p`, and a size cap per string.
  - An approval too long to read on a phone keeps both ends of the command and says how much is hidden; the phone then offers only Deny. Previously the tail was silently cut off while Allow stayed enabled.
  - A run started from a phone can no longer write skills or MCP config, message a chat started on the desktop, or crash another session's run with a malformed message; `setModel` accepts only real providers and `fetchTranscript` is capped.
  - The phone app is served with a strict Content-Security-Policy, bounds its markdown parsing (a hostile reply could freeze the page), clears its stored copies on revoke, and names each device ("iPhone · Safari") instead of every phone being the same string. The hosted relay rejects room ids that are not the desktop's 52-character form.
  - The phone app now has the Stormcoder look: shared colour tokens, a light theme, 44px touch targets, safe-area handling, the Stormcoder icons, and screen-reader fixes.
  - Settings > Remote control now shows the connection coming up (the Settings tab was not receiving the status message).
- Settings > Remote control: a fresh install no longer opens on a red "not connected yet" error. "Pair a device" and Refresh are off, with the reason beside them, until Remote is on and connected; the device list is requested once the connection comes up. The pairing card now shows the link as text with a Copy link button (the QR needs a camera), and the status and error lines are announced to screen readers.
- Fixed in the rename: stored data kept under the old `openvsChat.` prefix (API keys, sign-in sessions, chat history, the active skill, remote-control secrets, MCP consent decisions) would have been orphaned. All of it is now moved to the new names on first start, values untouched and secrets still encrypted, in the app's state, per-project state, secret store and `settings.json`. The benchmark's app-key reading handles an app folder that predates the rename. The phone app and relay say Stormcoder in their visible text (names that deployed services depend on are unchanged).
- Project memory files can no longer be written with `write_file`/`edit_file` or by shell redirection (`remember` and Settings > Memory are the ways in), so a prompt injection cannot skip the approval and credential check. Memory panel styling fixed: the kind badge was a full-width bar and the chosen scope/kind was not distinguishable.
- `remember` asks for approval under `auto-edits` too (only full auto-approve skips the question): saved notes steer every later session, so a fetched page must not be able to plant one silently. The memory folder's `.gitignore` now ignores itself, so journaling a run never leaves an untracked `.stormcoder/` in `git status`. Other agents' names for the tools (`save_memory`, `search_memory`, …) work, and a refinement that says more than a saved fact is no longer rejected as a repeat.
- Memory, completed. Your own notes (kept in the app's data folder, shared by every project) join the project's facts in the block new chats start with, up to about 1,700 tokens in all. Settings > Memory lists everything with pin, edit, delete and add, shows the token cost, and holds the on/off switch. Pinned notes are never evicted and are the last to be cut from the prompt. `/memory` shows what is remembered, `/memory add [user] [kind] <text>` saves a note, `/memory on|off` switches it. `recall` now also searches past chats. With `stormcoder.memory.autoPropose` on (off by default), the model suggests notes after a run that changed files and you accept or dismiss each one; it costs one extra request per such run. Saves from parallel chats no longer overwrite each other, and a credential pasted into a request is not written to the journal or a suggestion. New benchmark tasks 14 and 15 measure what memory buys, with `--setting memory.enabled=false` for the comparison run.
- Project memory can be switched off from Settings > Memory, with a setting for how many recent runs are listed. When it is off, nothing is added to new chats, `remember` saves nothing and `recall` searches nothing. The toggle is desktop-only (a paired phone cannot change it) and applies to chats started afterwards.
- `recall` tool: a read-only keyword search over all saved project facts and the whole run journal, available in Ask and Plan as well as Agent. The prompt block carries only the newest items, so memory can grow well past it without costing tokens until the model asks. Results are ranked by matching words (newest first among equals) and capped at about 2,500 characters.
- Project memory. A `remember` tool saves short typed facts to `.stormcoder/memory.md` (deduplicated, capped, never credentials, asks for approval), every run that changes files is journaled in `.stormcoder/journal.jsonl`, and new chats start with the saved facts and the last few runs in the system prompt, at most about 1,500 tokens. The block is read once per chat so it does not break prompt caching, nothing is read in an untrusted workspace, and the folder is git-ignored by default. Settings: `stormcoder.memory.enabled`, `stormcoder.memory.recentRuns`. A legacy `.openvs/memory.md` is still read.
- Fixed: Agent mode never attached its tool-activity digest to the transcript, so a follow-up turn did not know which files the previous run had read or changed. It does now.
- Renamed the remaining OpenVS wording to Stormcoder: product name in menus and messages, the settings namespace (`openvsChat.*` is now `stormcoder.*`) and the project folder (`.openvs/` is now `.stormcoder/`). Existing installs are migrated: saved settings are moved to the new keys on first start, and skills, MCP config, rules and memory in a legacy `.openvs/` folder are still read. The pre-rename relay, extension id and sign-in callback names are unchanged because deployed services depend on them.
- Auto Routing pickers (plan, code, review) list only the models the provider reports, loaded live like the chat model picker. The hardcoded suggestions are no longer shown, and switching provider pins the first live model once the catalog arrives.
Agent effectiveness audit.

- Code discovery: `search_files` and `glob_files` now honour `.gitignore`, walk breadth-first (project source before deep trees) and skip `venv`, `env`, `site-packages`, `Pods`, `obj`, `.terraform` and similar. In a Python project with a `venv/`, searching for a symbol that existed returned "No matches". `search_files` also takes `caseSensitive`, `context` and `filesOnly`.
- Follow-up turns keep the previous run's tool activity (files read and changed, commands run and the end of their output) as a hidden digest on the assistant turn, instead of only the prose.
- Auto: the planner reads the repository with read-only tools before planning, and a review that ends `VERDICT: ISSUES` sends the implementer back for one fix round.
- Safety: the default approval policy is `auto-edits` (commands ask). The deny-list now covers `git reset --hard`, `git clean -f`, `git checkout -- .`, interpreter one-liners that delete trees, `npm/cargo publish`, piping secrets or files to `curl`/`nc`, and shell writes to `.env`, `*.pem`, `*.key`, `.git/` and `.ssh/`.
- `run_command` takes `background: true` for servers and watchers, with a new `command_output` tool to read or stop them. New `web_search` tool (DuckDuckGo, through the same per-host approval as `fetch_url`).
- `CLAUDE.md` is read as a rules file by default. Anthropic models get a 16k output allowance when `maxTokens` is left at the 8192 default.
- Slash commands: `/init` (the agent writes an `AGENTS.md`), `/review` (read-only review of uncommitted changes) and `/compact` (summarize older turns now).
- Per-directory rules: a subfolder's `AGENTS.md` / `CLAUDE.md` is delivered the first time the agent touches a file under it. `.openvs/memory.md` is loaded into every conversation, and the agent is told to append durable project facts to it.
- Hooks: `openvsChat.hooks` runs commands before and after tool calls (`PreToolUse` exit code 2 blocks the call; `PostToolUse` exit code 2 feeds text back to the model).
- Notebooks: `read_file` shows `.ipynb` as numbered cells and `edit_notebook` replaces, inserts or deletes a cell, keeping the file's format. `read_file` also shows pictures to vision models and reads PDFs through `pdftotext` when installed.
- Sandbox: `openvsChat.agent.sandbox` (`workspace` or `workspace-offline`) runs commands in bubblewrap on Linux or `sandbox-exec` on macOS, read-only outside the workspace, temp and tool caches; secrets in the workspace stay read-only. Off by default; it fails closed when requested but unavailable.
- Benchmark: `bench/` has 13 tasks with objective checks, a headless runner over the real engine (`node bench/run.mjs --provider anthropic --model ...`), a comparison tool and a validator that proves the tasks can neither be passed untouched nor by known shortcuts. `npm run bench:go` (or `node bench/start.mjs`) is a guided runner that asks for provider, model and key. `custom` providers can take a key from `CUSTOM_API_KEY`. `--app-data` runs the benchmark with the API keys and provider settings already saved in the app (read from a sanitized private copy under Electron; sign-in sessions, MCP servers and hooks are never carried over). The secret codec moved from `electron/main.ts` to `electron/secrets.ts` unchanged. `npm run bench:validate` and a three-task oracle run are part of `npm test`.
- Tests: `scripts/test-discovery.mjs`; the browser test helper also finds `chrome-linux64`.

## 1.3.6

Full audit of every section; each fix has a regression test.

- Safety: ask and plan modes refuse tools they were not offered. "Always allow" for a command no longer approves anything chained after it. The dangerous-command list covers more bypasses, writes through a dangling symlink are refused, `fetch_url` asks before reaching private hosts, and tool calls cut off at the token limit are not run. Non-UTF-8 and binary files are no longer corrupted by edits.
- Remote control: a phone can no longer queue or steer prompts that run under the desktop's looser approval policy. A connected client cannot evict the desktop host from the relay, revoked devices lose access to the pending and push endpoints, and failed pairing guesses no longer withdraw every code. Outbound data is scrubbed of credentials, the cloudflared download is checksum-verified, and the WebSocket server enforces control-frame and backpressure rules.
- Settings and data: a typo in `settings.json` no longer resets your settings or overwrites the file, and corrupt state files are renamed aside. The built-in editor is limited to settings, logs, MCP config and project skills. OAuth sign-in URLs are no longer corrupted when the browser opens them. 17 numeric settings now have bounds.
- Providers: concurrent OAuth refreshes share one request and no longer wipe a valid sign-in. Kiro calls work, the thinking block closes after a reasoning-then-tools turn, Antigravity tool results are matched to the right call, key rotation no longer double-rotates, and sign-in requests time out.
- MCP and skills: a bad server entry is skipped instead of failing every run, a streaming reply that never ends times out, and shutdown and reconnect no longer leak a server process. The consent dialog lists environment variable names, header names and the working directory. Project-level MCP headers no longer expand `${env:...}`.
- Auto mode: the reviewer no longer sees writes that were refused or failed, plan and review text is saved with the session, and a failed step stops the run.
- Chat: links in messages open in the system browser, the tab strip and dialogs handle keyboard focus, and hard-coded colours use tokens.

## 1.3.5

Audit pass over the thinking-line work.

- Finished tool cards no longer keep their glyph animating; only a running call does, so a long transcript is not hundreds of live loops. Tool cards also draw only from the Asgard and storm sets, never a skull or a web next to `read_file`.
- A missing or blocked `glyphs.js` now costs the drawings only; before, the chat script would have failed to start.
- The web glyph had white strands that vanished on the light theme; it now has a slate underlay.
- New `scripts/test-glyphs.mjs` checks every glyph (well-formed, only defined gradients, no ids, an animation rule, at least two per set), the six word lists (non-empty, no word in two lists, every list reachable), the missing-script fallback, tool-card rules and reduced motion.

## 1.3.4

- Character lines get their own drawings. Doctor Doom lines ("Consulting Doctor Doom", "Forging Doombots", "Snapping the gauntlet") show Doom's green-hooded iron mask or a gem-set gauntlet; a new Spider-Man set ("Spinning a web", "Tingling spider-sense", "Thwip!", "Swinging between skyscrapers") shows a spider, a web or the red mask. Six word lists now share the line: plain 24%, Asgard 20%, storm 16%, doomsday 16%, Doom 12%, Spider-Man 12%.

## 1.3.3

- The thinking-line drawings are now rendered as lit objects instead of flat icons: brushed steel with a polished horizon reflection, gold, grained wood, glass, bone and lava, each with a specular edge and a glowing part that animates (the hammer's rune, the axe's charged edge, the skull's ember eyes, the cracks in a dying planet, falling sand). They are drawn 26px, up from 20.
- New doomsday set: a skull, a falling meteor, a black hole, an hourglass and a cracking planet, paired with 22 new lines ("Counting down to doomsday", "Reading the Doomsday Clock", "Feeding the black hole", "Ragnarok incoming", "Bracing for impact" and more). Plain verbs never draw a doom glyph.
- The storm set is redrawn the same way: a thundercloud, a star, a ringed planet, glowing code brackets and a plasma bolt.

## 1.3.2

- The thinking-line drawings are redrawn: a war hammer with a lightning rune, a bearded axe with a glowing edge, a winged helm and a golden bolt, all on one grid with steel, gold and wood gradients that read on both themes. No raster artwork is used; they are inline SVG in the new `media/glyphs.js`.
- The words and drawings are now paired. Asgard and Avengers lines ("Charging Stormbreaker", "Opening the Bifrost", "Assembling the Avengers") get the Asgard set, the storm-and-code lines get the line glyphs, and plain verbs draw from both. Every original line is kept; a pick is 35% plain, 35% Asgard, 30% storm.

## 1.3.1

- The original Asgard and Avengers thinking lines and the helm, hammer and Stormbreaker artwork are back, kept alongside the new storm-and-code lines and glyphs. A pick is a coin flip between the plain verbs ("Thinking", "Pondering") and the flavour lines, so the plain verbs stay at half of what is shown, and the glyph rotates through all eight drawings.

## 1.3.0

- A new app icon: a glowing lightning bolt between code brackets, legible from 1024px down to 16px. The same mark is used in the rail, the welcome screen, the browser tab and the reasoning blocks.
- The agent's "thinking" line is now entirely Stormcoder's own. The Marvel-derived wording (Avengers, Stormbreaker, Asgard, Loki and so on) and the Thor helm, hammer and Stormbreaker artwork are gone, replaced by original storm-and-code wording ("Charging the coil", "Chasing lightning", "Tempering the diff") and four drawn glyphs (bolt, code brackets, orbit, storm cloud) that follow the theme accent.
- The agent introduces itself as Stormcoder instead of Thor, and the old raster artwork was removed from the app.

## 1.2.1

Engine fixes imported from OpenVS Thor (branch `ccr-6b7439fd-4bim5m`, twelve commits).

- Agent loop: fixed batching of parallel tool calls, sub-agent card ids and a command timeout that could hang a run; `spawn_subagent` is refused where it is not offered; parallel tool calls that share an index are split.
- Safer files: `write_file` without content no longer truncates the file, and a UTF-8 byte-order mark is kept on edits.
- Guardrails: the command lists fail closed when the setting is not supplied, and Windows destructive commands (`rmdir /s`, `del /s`, `format`, recursive `Remove-Item`) and split-flag `rm -r -f` are denied by default.
- MCP: stdio servers launch `.cmd` shims on Windows and answer requests the server sends.
- Tool-call repair: undoubled Windows path backslashes and bare keys in malformed JSON.
- `fetch_url` asks again before following a redirect to another host.
- Markdown: links with parentheses, and code fences nested in list items.
- The agent is taught when to delegate to sub-agents; the page nonce now comes from `crypto`.

## 1.2.0

Menus, and the motion that goes with them.

- Provider, model and permission dropdowns are now popover menus. The model menu searches as you type, shows `tools` and `free` as badges, and the permission menu explains each level.
- An app menu on the brand mark (New chat, Open project, Recent projects, navigation, theme, zoom, updates, logs, Quit), so Windows and Linux, where the menu bar is hidden, have one.
- A project switcher under the project chip, replacing the full-screen palette for that job.
- A keyboard shortcuts sheet (press `?`).
- Right-click menus on messages, code blocks and chat tabs; the usual Cut / Copy / Paste menu in text fields, which Electron does not provide by default.
- A copy button on every message, with a drawn check on success.
- Styled tooltips everywhere, replacing the operating system's, with shortcuts shown (and Command on macOS).
- Designed empty states for History and MCP servers; a shimmer on the agent's working line.
- Menus open with a short scale-and-fade, list items stagger in, the selected item's check draws itself, and all of it is off under reduced motion.

## 1.1.0

A new look and feel.

- Dark and light themes (follows the system on first run; the rail's last button switches). Both use one set of design tokens.
- Chat redesigned around a centred reading column: avatars, a raised bubble for your messages, a floating composer with a focus glow, and a segmented Ask / Plan / Agent switch with a sliding thumb.
- Syntax highlighting in code blocks (TypeScript, JavaScript, Python, Go, Rust, Java and C-family, shell, SQL, JSON, YAML, CSS, HTML, diff), with copy and insert in a header.
- A welcome screen with action cards, recent chats and keyboard hints.
- Settings rebuilt: provider cards with tinted monograms in a grid, icon navigation, redesigned skill and MCP rows.
- Motion: a sliding rail indicator, view crossfades, staggered entrances, a travelling run line while any chat works, toasts that slide in, and press feedback on every control. All of it is removed under reduced-motion.
- Command palette with match highlighting and key hints.

## 1.0.0

First release of Stormcoder as a standalone desktop application.

- Electron app with its own interface (rail, command palette, prompts, built-in file editor); no VS Code dependency.
- The full OpenVS Thor chat engine: 15+ providers, Ask / Plan / Agent / Auto modes, parallel chats and history, skills and rules, MCP servers (stdio and HTTP), phone remote control.
- Per-folder trust, OS-keychain secrets, hard agent guardrails.
- Installers for Windows, macOS and Linux; auto-update from GitHub Releases.
- Not carried over from the extension: inline completions and editor code actions (there is no editor).
