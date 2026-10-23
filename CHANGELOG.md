# Changelog

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
