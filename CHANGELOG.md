# Changelog

## Unreleased

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
