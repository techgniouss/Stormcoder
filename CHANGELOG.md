# Changelog

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
