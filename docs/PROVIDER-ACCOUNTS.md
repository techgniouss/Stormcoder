# Provider accounts and fallback

Settings > Providers accepts multiple credentials for each provider. **Add key** adds one
key without replacing saved keys or logins. Repeating a supported sign-in adds a separate
account; when the provider returns an account identifier, signing into the same account
again updates that account. The command palette uses the same additive behavior.

Claude has two explicit choices:

- **Add Claude account (browser)** opens the system browser and receives the result through
  a one-shot localhost callback. Return to Stormcoder after approving access.
- **Use authorization code** opens the provider's confirmation page and asks you to paste
  its code. Use this when the browser cannot reach the local callback.

Both choices use PKCE and independent random state. The browser callback listens only on
loopback, checks the callback path and state, and closes on success, error, cancellation,
or timeout. The code input is masked. A configured custom `anthropic.authUrl` continues to
use its own web sign-in flow.

Antigravity signs in with Google. Stormcoder asks Google to show its account chooser each time, so
a second Google account is added by picking it there. Each account is stored with its address, and
signing into an account that is already saved updates it. The sign-in needs Antigravity's OAuth
client secret. Official releases carry it: the release workflow passes the repository secret
`ANTIGRAVITY_CLIENT_SECRET` to the build, which compiles it into the app, so nothing needs setting up.
It is not protection (a value inside an app can be read out of it) and it is never committed. A value
in the environment, or in a `.env` file in Stormcoder's user data folder, takes precedence over the
built-in one. A build made without the secret says so when you try to sign in.

GitHub Copilot, Grok and Kiro sign-ins are stored as named accounts too (`@login` for GitHub, the
address in the token for Grok and Kiro when it has one). Copilot and Grok use a device-code page, which
signs in whichever account the browser has open on that site: switch accounts there first to add a
second. Kiro imports the account Kiro's own IDE or CLI is signed into, so sign in there as the other
account and import again.

ChatGPT uses its existing browser callback. OpenRouter, Copilot, Grok, Kiro and custom web
sign-in providers retain their existing authorization or import mechanisms; repeating them
retains earlier credentials. Providers without an account sign-in flow accept multiple API
keys. Local CLI providers continue to use the CLI's own session. Cloudflare tokens still
use the configured Cloudflare account ID; tokens for a different Cloudflare account need
that matching account ID. A provider-wide base URL applies to the whole credential pool.

To use a different browser account, select it on the provider's login page. If the browser
automatically reuses a login, sign out on that page before adding the other account.
Stormcoder does not copy browser cookies or the desktop application's private credentials.

## Selection and recovery

The newly added credential becomes active. On restart, an environment credential takes
initial precedence, then saved API keys, then saved sign-ins. An environment credential
can fall back to saved accounts, and cannot be removed from Settings. Clearing saved
credentials leaves the environment variable alone.

Authentication failures, payment refusals, rate limits and recognized quota errors move
the failed account into a cooldown and select another available credential for the same
provider. Each request tries distinct credentials with a bounded retry budget. A normal
OAuth access-token expiry is refreshed before the account is treated as exhausted. Refreshes
are single-flight per account, so parallel chats cannot spend the same rotating refresh
token twice. One dead refresh session does not remove other accounts.

Pooled credentials surface HTTP 429 immediately rather than waiting through the single-key
transport's backoff. Exchanged wire tokens inherit that behavior. Token-window pacing is
also separate for each credential, so an exhausted account cannot delay its replacement.

Cooldowns last at least one minute, or fifteen minutes for recognized allowance/billing
exhaustion. A longer reported retry/reset delay is honored up to one day. Cooldowns are
kept in memory and expire automatically; a successful request on another account does not
clear them. When every account is unavailable, the request stops and reports the failure.
No fallback replays a visible response that has already started, or repeats executed tools.
Provider model permissions are still enforced: changing accounts cannot grant access to a
model that the account does not support.

Each provider's accounts are listed in a collapsible section on its card, showing which account is in use and which are cooling down.
The account list supports individual removal. Use **Refresh status** to update the displayed
active account and cooldown deadlines after a run. **Additional API keys > Replace backup keys**
replaces the existing backup-key list; use **Add key** to append one key. **Remove all saved
accounts** clears saved keys and sign-ins for that provider.

## Storage and compatibility

The existing `stormcoder.apiKey.<provider>`, `stormcoder.apiKeysExtra.<provider>`, and
`stormcoder.oauth.<provider>` secrets remain readable. Additional OAuth sessions are stored
in `stormcoder.oauth.accounts.<provider>` in the same encrypted SecretStorage. Each session
has a stable slot and refresh token. Account changes are serialized; a late refresh cannot
restore a removed account or overwrite a newer authorization.

Settings receives only opaque account IDs, display names, credential kinds and cooldown
state. Keys, access tokens and refresh tokens are never sent to the webview. Credential
administration stays desktop-only and is denied to paired remote clients.

## Verification

`scripts/test-multi-account.mjs` covers mixed API/OAuth pools, legacy sessions, concurrent
additions and refreshes, exhausted pools, cooldown recovery, environment fallback, account
removal, exchanged-token retry behavior, and both Claude authorization flows against local
callbacks and mocked token endpoints. `scripts/test-agent-loop.mjs` covers reaching the
fifth account, stopping after exhaustion, and avoiding partial-response replay.
`test/multi-account-e2e.mjs` runs the real settings UI and engine against a local provider,
including Ask/Agent fallback and individual account removal. The normal `npm test` includes
these tests alongside the existing regression suites.

These automated authorization tests do not use live Claude or ChatGPT accounts. Provider
consent screens, account entitlement, and production token issuance require verification
with the account owner before release.
