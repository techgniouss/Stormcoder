# Changelog

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
