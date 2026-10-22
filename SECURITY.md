# Security

Report vulnerabilities privately through GitHub's "Report a vulnerability" button on the Security tab, not in a public issue.

What Stormcoder protects, and where the limits are:

- **API keys** are stored with the OS keychain (Electron `safeStorage`). On a system without one they are encrypted with a random key in a `0600` file; that stops a copied file being read, not another process running as you.
- **The agent** can only write inside the open folder, cannot touch protected paths, and cannot run denied commands. These checks are in code (`src/agent/guardrails.ts`) and do not depend on the model. A folder you did not trust is read-only.
- **The UI** runs sandboxed with no Node access, loads only bundled assets, and refuses every web permission request. Links open in your browser.
- **Fetched pages and MCP output** are treated as untrusted data, and `fetch_url` asks per host.
- Providers that call another vendor's internal client API (Copilot, Grok, Kiro, Antigravity, the Gemini web provider) carry a risk of account action by that vendor. Each says so where you enable it.
