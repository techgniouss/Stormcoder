# CLAUDE.md

Stormcoder is a standalone Electron desktop app. Its chat engine (`src/`) was written as a VS Code extension and runs unchanged on top of `host/vscode.ts`, a Node implementation of the slice of the `vscode` API it uses. Read `docs/ARCHITECTURE.md` first.

## Commands

- `npm run typecheck`: engine, host and Electron code (`tsc`), and the webview scripts (`tsconfig.webview.json`, `// @ts-check`, keep at zero errors).
- `npm run build`: bundles `dist/` (esbuild). `npx electron .` runs it. `npm run dev:web` serves the same engine and UI in a browser.
- `npm test`: typecheck, build, `scripts/test-*.mjs` unit tests, `test/e2e.mjs`, `test/electron-smoke.mjs`. Run single unit tests with `node scripts/build-tests.mjs && node scripts/test-<name>.mjs`.
- `npm run gen`: regenerates `host/config-defaults.json` and `host/command-list.json` from `ext-package.reference.json`. Add a setting there, then regenerate.
- Always typecheck before running tests; do not run tests while there are compile errors.

## Rules that matter

- `host/` must not import `electron`. Electron-specific code goes in `electron/`, behind `HostEnvironment` or `ControllerOptions`.
- The engine calls `vscode.*`. If it needs an API the layer lacks, add it to `host/vscode.ts` with a test in `scripts/test-host.mjs`; do not fork engine code to avoid it.
- Editor-only features are out of scope (inline completions, code actions, active text editor). Code that reads `activeTextEditor` must handle `undefined`.
- Hard guardrails (`src/agent/guardrails.ts`) and the trust model are enforced in code. Do not weaken them for convenience.
- The chat UI (`media/`) is one IIFE with a static contract test (`scripts/test-webview.mjs`): ids and message types must match in both directions.
- UI is the "Stormcoder" look built on the taste-skill app style: every colour, border and duration comes from `shell/tokens.css` (dark and light themes share names), so never hard-code colours. No emoji and no icons in tinted squares on cards. Gradients, glows and shadows are used on purpose (accent fill, ambient light, floating surfaces) and carry a `taste-skill-ignore` comment; a new gradient without one is a lint failure. Check with `node <taste-skill>/scripts/lint.mjs shell/*.css` and `inspect.mjs --app`.
- Motion must respect `prefers-reduced-motion` (tokens collapse the durations; entrance animations are switched off in `shell/theme.css`). `test/e2e.mjs` checks this.
- The mode dropdown is replaced by a segmented control in `shell/frame.js`; tests click `.seg-btn`, not the hidden `#modeSelect`.
- Native modules load with `await import(...)`, never a bare `require`, in bundled code.
- Code style: tabs, single quotes, braces always, JSDoc on functions and classes, no `any` unless unavoidable.
