# opencode-cline

OpenCode V2 plugin that provides the **Cline** and **ClinePass** providers through the Cline
API — including WorkOS device-code OAuth, model discovery (ClinePass catalog + OpenRouter +
models.dev enrichment), prompt-cache normalization, and account/org management.

## Features

- **`/connect` support for `cline` and `cline-pass`** — both providers are registered as having a
  device-code auth flow. Choosing either in OpenCode's connect flow starts WorkOS device
  authorization, opens the browser, polls for completion, and stores the tokens.
- **Account and org management** — `/cline-org` (list/switch organizations, view credits and
  active account) and `/cline-logout` (clear stored credentials) commands, plus
  `cline_list_accounts` and `cline_switch_account` tools.
- **Prompt-cache normalization** — Cline/OpenRouter-compatible request payload rewriting so cache
  markers are normalized to the format expected by the Cline backend.

## Usage

### Connect

1. Run `/connect` in OpenCode and select **Cline** or **ClinePass**.
2. A device code and verification URL are shown; the browser is opened automatically when
   possible. Complete sign-in in the browser.
3. The plugin polls for completion and stores the resulting credentials in plugin storage.

> **ClinePass**: when the selected/default account has no active ClinePass
> subscription, the plugin falls back to the Cline (OpenRouter-backed) catalog and reports the
> reason.

### Commands

| Command | Description |
|---|---|
| `/cline-org` | Show active account, available personal/org accounts, and credit balances. |
| `/cline-org list` | Same as `/cline-org`. |
| `/cline-org switch <id>` | Switch the active account to `personal` or an organization id from `/cline-org`. |
| `/cline-logout` | Remove stored Cline credentials from plugin storage. |

### Tools

| Tool | Description |
|---|---|
| `cline_list_accounts` | Lists personal and organization accounts with active markers and credit balances. |
| `cline_switch_account` | Switches the active account (`organizationId: "personal"` or an org id). |

These tools allow account switching and inspection from within a conversation.

## Credentials and storage

- Credentials are stored in OpenCode plugin storage (durable, per-plugin). OpenCode's `/logout`
  will not clear them; use `/cline-logout`.
- Organization selection can be changed later with `/cline-org switch ...` or the
  `cline_switch_account` tool.

## Notes

- Request payloads are normalized for Cline/OpenRouter prompt-caching compatibility.
- Model catalogs are fetched live where available, with fallbacks to keep the providers usable.

MIT — see [LICENSE](./LICENSE).
