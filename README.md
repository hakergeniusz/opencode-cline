# opencode-cline

A native **OpenCode V2** plugin that adds the **Cline** and **ClinePass** providers. It is a rewrite of
[`pi-cline`](https://github.com/maxpaulus43/pi-cline) (`@maxpaulus/pi-cline`) for OpenCode's plugin API —
no pi runtime package is imported or needed.

## What it does

- Registers two OpenAI-compatible providers:
  - `cline` — organization-aware Cline account, full model catalog
  - `cline-pass` — personal-account ClinePass model set
- Both point at `https://api.cline.bot/api/v1` with the headers the Cline API expects
  (`X-CLIENT-TYPE: pi`, `User-Agent: pi-cline-oauth-extension`).
- Loads models from Cline's `recommended-models` endpoint and from the models.dev catalog (3-hour local
  cache). If those fail, `cline-pass` falls back to a bundled catalog; `cline` still registers.
- Implements WorkOS **device-code OAuth** against Cline (`/auth/register`, `/auth/refresh`), stores tokens
  in OpenCode plugin storage, and refreshes them 5 minutes before expiry.
- Injects `Authorization: Bearer workos:<token>` into provider requests and rewrites cache markers into
  Cline's ephemeral prompt-cache format.
- Provides commands and tools for login, logout, and switching the active personal/organization account.

## Install / load

Local directory (no publish needed):

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-cline"]
}
```

Or drop it into `.opencode/plugins/opencode-cline/` and it loads automatically. After loading, pick a
model with `/models` (IDs look like `cline/<model>` and `cline-pass/<model>`).

### Credentials

Two ways to supply credentials:

1. Run `/cline-login` (Cline) or `/cline-login-pass` (ClinePass). The plugin prints a verification URL
   and device code, completes the device flow, and saves the tokens in durable plugin storage.
2. Or set `CLINE_API_KEY` in the OpenCode server environment. The providers declare
   `settings.apiKey: "{env:CLINE_API_KEY}"`; include the `workos:` prefix yourself if the API requires it.
   Stored OAuth tokens take precedence because the `http.request` hook overwrites the Authorization header.

Run `/cline-logout` to clear stored tokens.

### Commands and tools

| Name | Kind | Purpose |
|------|------|---------|
| `/cline-login` | command | WorkOS device login for the `cline` provider (keeps Cline's currently active account) |
| `/cline-login-pass` | command | Same, and forces the personal account after login |
| `/cline-logout` | command | Remove stored Cline and ClinePass tokens |
| `/cline-org` | command | Prompt that drives account selection through the tools below |
| `cline_list_accounts` | tool | List personal/org accounts with credit balances and ids |
| `cline_switch_account` | tool | Switch to an account by id (`personal` for the personal account) |

## How the pi features map to OpenCode V2

| pi | OpenCode V2 here |
|----|------------------|
| `pi.registerProvider("cline"/"cline-pass", …)` | `ctx.provider.transform` → `editor.add({ info: Provider.Info.empty(...), models: Model.Info.default(...) })` |
| provider `api`, `baseUrl`, `headers` | `package: "@opencode/ai/providers/openai-compatible"`, `settings.baseURL`, `info.headers` |
| provider `oauth: { login, refreshToken, getApiKey }` | WorkOS device flow implemented in `src/cline-oauth.ts`; tokens in `ctx.storage`; bearer header set by a scoped `http.request` hook |
| `pi.on("before_provider_request", …)` | `ctx.session.hook("http.request", …, { providerID })` calling `normalizeClinePromptCachePayload` |
| model catalog fetch + disk cache | `src/cline-models.ts` (unchanged behavior, cache path moved under the user cache dir) |
| `pi.registerCommand("cline-org")` with `ctx.ui.select` | `ctx.command.transform` + `ctx.tool.transform` (`cline_list_accounts` / `cline_switch_account`), described below |
| `ctx.ui.notify` | `ctx.session.synthetic` messages |

## Known gaps / differences

- **`/connect` integration:** OpenCode's integration OAuth API only exposes generic authorize/form methods;
  it cannot host Cline's custom WorkOS device exchange. Login is therefore provided as the explicit
  `/cline-login` and `/cline-login-pass` commands rather than as entries in OpenCode's provider picker.
- **Account selection UI:** OpenCode server commands cannot open a native selection dialog. `/cline-org`
  injects a prompt that asks the model to call `cline_list_accounts` and then `cline_switch_account`;
  the user picks the account in chat. No TUI part was added. A TUI dialog with an RPC contract could
  reproduce pi's `ctx.ui.select` exactly if desired.
- **Credential storage:** tokens live in `ctx.storage` (per-plugin durable JSON), not pi's
  `~/.pi/agent/auth.json`. OpenCode's `/logout` will not clear them; use `/cline-logout`.
- **Post-login org picker:** pi could prompt during login when `onSelect` was available. OpenCode commands
  do not expose that callback, so login leaves Cline's active account unchanged and points you to
  `/cline-org`. ClinePass still forces the personal account, as in the original.
- **Model `reasoning` flag:** pi models carry a `reasoning` boolean. OpenCode's registered
  `Model.Info.capabilities` schema has no `reasoning` field, so that flag is not preserved (reasoning
  behavior is up to OpenCode's model configuration).
- **Cache markers:** OpenCode, not the plugin, decides when to emit cache breakpoints. The normalization
  hook only rewrites markers when they are present in the outgoing JSON body; it does not make OpenCode
  start caching a model. pi's `compat.cacheControlFormat` metadata has no OpenCode equivalent.
- **Client identifier:** `X-CLIENT-TYPE: pi` and the `pi-cline-oauth-extension` User-Agent are kept
  deliberately so the Cline API sees the same client as the original extension.

## Files

```
package.json
src/index.ts          # plugin entry: providers, hooks, commands, tools, credential storage
src/cline-oauth.ts    # WorkOS device-code login, token register/refresh
src/cline-account.ts  /users/me, balances, active-account switching
src/cline-models.ts   # model catalog fetch + models.dev cache + ClinePass fallback
src/cline-cache.ts    # prompt-cache payload normalization
test/cline-cache.test.ts
README.md
LICENSE
.gitignore
```

## Tests

`bun test` runs the ported prompt-cache normalization tests. The original `cline-account.test.ts` mocked
pi's `registerCommand` API and a pi-specific `ExtensionAPI`; it has no meaningful equivalent without pi
dependencies, so it was not ported.

## License

MIT — 2026 hakergeniusz.
