import { Model, Plugin, Provider } from "@opencode/plugin"
import type { ClineModel } from "./cline-models.ts"
import { fetchClineModels, fetchClinePassModels } from "./cline-models.ts"
import { normalizeClinePromptCachePayload } from "./cline-cache.ts"
import {
    getClineApiKey,
    isExpired,
    loginCline,
    refreshClineToken,
    type ClineCredentials,
} from "./cline-oauth.ts"
import {
    loadClineAccountChoices,
    PERSONAL_ACCOUNT_ID,
    switchClineAccountChoice,
} from "./cline-account.ts"

const API_BASE_URL = "https://api.cline.bot"

// The Cline API expects this client identifier; keep it identical to pi-cline.
const BASE_HEADERS: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "pi-cline-oauth-extension",
    "X-CLIENT-TYPE": "pi",
}

type ProviderName = "cline" | "cline-pass"
const PROVIDER_NAMES: ProviderName[] = ["cline", "cline-pass"]

type ModelBase = ReturnType<typeof Model.Info.default>

function logWarn(tag: string, error: unknown): void {
    console.warn(
        `[opencode-cline] ${tag}: ${error instanceof Error ? error.message : String(error)}`,
    )
}

function storageKey(providerName: ProviderName): string {
    return providerName === "cline" ? "oauth.cline" : "oauth.cline-pass"
}

function displayName(providerName: ProviderName): string {
    return providerName === "cline" ? "Cline" : "ClinePass"
}

function toModelInfo(providerName: ProviderName, model: ClineModel): ModelBase {
    const base = Model.Info.default(
        Provider.ID.make(providerName),
        Model.ID.make(model.id),
    )
    return {
        ...base,
        name: model.name,
        modelID: model.id,
        cost: [
            {
                input: model.cost.input,
                output: model.cost.output,
                cache: {
                    read: model.cost.cacheRead,
                    write: model.cost.cacheWrite,
                },
            },
        ] as ModelBase["cost"],
        limit: {
            context: model.contextWindow,
            input: model.contextWindow,
            output: model.maxTokens,
        } as ModelBase["limit"],
        capabilities: {
            ...base.capabilities,
            input: model.input,
            output: ["text"],
        },
    } as ModelBase
}

export default Plugin.define({
    id: "opencode-cline",
    async setup(ctx) {
        // Model discovery mirrors the pi extension: start with whatever we can
        // fetch, and still register the providers if both catalogs fail.
        let clineModels: ClineModel[] = []
        let passModels: ClineModel[] = []
        try {
            clineModels = await fetchClineModels()
        } catch (error) {
            logWarn("model catalog", error)
        }
        try {
            passModels = await fetchClinePassModels()
        } catch (error) {
            logWarn("ClinePass model catalog", error)
        }

        async function readCredentials(
            providerName: ProviderName,
        ): Promise<ClineCredentials | undefined> {
            const stored = await ctx.storage.get(storageKey(providerName))
            if (!stored || typeof stored !== "object") return undefined
            const candidate = stored as Record<string, unknown>
            if (
                typeof candidate.access !== "string" ||
                typeof candidate.refresh !== "string" ||
                typeof candidate.expires !== "number"
            ) {
                return undefined
            }
            return candidate as unknown as ClineCredentials
        }

        // Refresh proactively, 5 minutes before expiry (the buffer is already
        // baked into credentials.expires by the OAuth module).
        async function validCredentials(
            providerName: ProviderName,
            signal?: AbortSignal,
        ): Promise<ClineCredentials | undefined> {
            let credentials = await readCredentials(providerName)
            if (!credentials) return undefined
            if (!isExpired(credentials)) return credentials
            try {
                credentials = await refreshClineToken(credentials, signal)
                await ctx.storage.set(
                    storageKey(providerName),
                    credentials as unknown as Parameters<
                        typeof ctx.storage.set
                    >[1],
                )
                return credentials
            } catch (error) {
                logWarn(`token refresh (${providerName})`, error)
                return credentials
            }
        }

        async function requireCredentials(
            providerName: ProviderName,
            signal?: AbortSignal,
        ): Promise<ClineCredentials> {
            const credentials = await validCredentials(providerName, signal)
            if (!credentials) {
                throw new Error(
                    `No Cline OAuth credentials found for ${displayName(providerName)}. Run /cline-login${
                        providerName === "cline-pass" ? "-pass" : ""
                    } first.`,
                )
            }
            return credentials
        }

        // pi's before_provider_request hook + provider apiKey/authHeader map to
        // an http.request hook: inject the bearer token and rewrite cache
        // markers on outgoing Cline requests.
        async function applyClineRequest(
            event: { request: Request },
            providerName: ProviderName,
        ): Promise<void> {
            const credentials = await validCredentials(providerName)
            if (credentials) {
                event.request.headers.set(
                    "Authorization",
                    `Bearer ${getClineApiKey(credentials)}`,
                )
            }

            const contentType = event.request.headers.get("content-type") ?? ""
            if (!contentType.includes("json")) return
            if (
                event.request.method === "GET" ||
                event.request.method === "HEAD"
            ) {
                return
            }
            try {
                const original = (await event.request.clone().json()) as unknown
                const normalized = normalizeClinePromptCachePayload(original)
                if (normalized !== original) {
                    event.request = new Request(event.request, {
                        body: JSON.stringify(normalized),
                    })
                }
            } catch {
                // Not a parseable JSON body; leave it untouched.
            }
        }

        await ctx.provider.transform((editor) => {
            for (const providerName of PROVIDER_NAMES) {
                const models =
                    providerName === "cline" ? clineModels : passModels
                editor.add({
                    info: {
                        ...Provider.Info.empty(Provider.ID.make(providerName)),
                        name: displayName(providerName),
                        activation: "enabled",
                        package: "@opencode/ai/providers/openai-compatible",
                        settings: {
                            baseURL: `${API_BASE_URL}/api/v1`,
                            apiKey: "{env:CLINE_API_KEY}",
                        },
                        headers: BASE_HEADERS,
                    },
                    models: models.map((model) =>
                        toModelInfo(providerName, model),
                    ),
                })
            }
        })

        for (const providerName of PROVIDER_NAMES) {
            await ctx.session.hook(
                "http.request",
                (event) => applyClineRequest(event, providerName),
                { providerID: providerName },
            )
        }

        async function notify(sessionID: string, text: string): Promise<void> {
            await ctx.session.synthetic({ sessionID, text })
        }

        async function runLogin(
            sessionID: string,
            providerName: ProviderName,
        ): Promise<void> {
            try {
                const credentials = await loginCline(
                    {
                        onAuth: ({ url, instructions }) => {
                            void notify(
                                sessionID,
                                `Cline device login — open ${url}\n${instructions}`,
                            ).catch((error) => logWarn("notify", error))
                        },
                        onProgress: (message) => {
                            void notify(sessionID, message).catch((error) =>
                                logWarn("notify", error),
                            )
                        },
                    },
                    { forcePersonal: providerName === "cline-pass" },
                )
                await ctx.storage.set(
                    storageKey(providerName),
                    credentials as unknown as Parameters<
                        typeof ctx.storage.set
                    >[1],
                )
                await notify(
                    sessionID,
                    `Logged in to ${displayName(providerName)}. Use /cline-org to choose the active Cline account.`,
                )
            } catch (error) {
                await notify(
                    sessionID,
                    `${displayName(providerName)} login failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                )
            }
        }

        await ctx.command.transform((editor) => {
            editor.add({
                name: "cline-login",
                description: "Log in to Cline with WorkOS device code",
                execute: async ({ sessionID }) => {
                    await runLogin(sessionID, "cline")
                },
            })
            editor.add({
                name: "cline-login-pass",
                description: "Log in to ClinePass with WorkOS device code",
                execute: async ({ sessionID }) => {
                    await runLogin(sessionID, "cline-pass")
                },
            })
            editor.add({
                name: "cline-logout",
                description: "Clear stored Cline / ClinePass credentials",
                execute: async ({ sessionID }) => {
                    await ctx.storage.remove(storageKey("cline"))
                    await ctx.storage.remove(storageKey("cline-pass"))
                    await notify(sessionID, "Cline credentials cleared.")
                },
            })
            editor.add({
                name: "cline-org",
                description: "Choose the active Cline personal or organization account",
                execute: async ({ sessionID, delivery }) => {
                    // OpenCode server commands cannot open a native selection
                    // dialog. Drive the same flow through the two tools below.
                    await ctx.session.prompt({
                        sessionID,
                        delivery,
                        text:
                            "Use cline_list_accounts to show me the available Cline accounts and balances, " +
                            "ask me which one should be active, then call cline_switch_account with the " +
                            "chosen organizationId (or 'personal' for the personal account).",
                    })
                },
            })
        })

        await ctx.tool.transform((editor) => {
            editor.add({
                name: "cline_list_accounts",
                description:
                    "List the active Cline personal/organization accounts with credit balances",
                input: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                options: { codemode: true },
                execute: async (_input, context) => {
                    const credentials = await requireCredentials(
                        "cline",
                        context.signal,
                    )
                    const choices = await loadClineAccountChoices(
                        getClineApiKey(credentials),
                        context.signal,
                    )
                    return {
                        content: choices.length
                            ? choices
                                  .map((choice) => `- ${choice.id}: ${choice.label}`)
                                  .join("\n")
                            : "No Cline accounts found.",
                    }
                },
            })
            editor.add({
                name: "cline_switch_account",
                description:
                    "Switch the active Cline account between personal and an organization",
                input: {
                    type: "object",
                    properties: {
                        organizationId: {
                            type: "string",
                            description:
                                "An organization id from cline_list_accounts, or 'personal'",
                        },
                    },
                    required: ["organizationId"],
                    additionalProperties: false,
                },
                options: { codemode: true },
                execute: async (input, context) => {
                    const organizationId = (
                        input as { organizationId: string }
                    ).organizationId
                    const credentials = await requireCredentials(
                        "cline",
                        context.signal,
                    )
                    const token = getClineApiKey(credentials)
                    const choices = await loadClineAccountChoices(
                        token,
                        context.signal,
                    )
                    const normalizedId =
                        organizationId === "personal"
                            ? PERSONAL_ACCOUNT_ID
                            : organizationId
                    const choice = choices.find(
                        (candidate) => candidate.id === normalizedId,
                    )
                    if (!choice) {
                        return {
                            content: `Unknown Cline account id: ${organizationId}`,
                        }
                    }
                    const name = await switchClineAccountChoice(
                        token,
                        choice,
                        context.signal,
                    )
                    return { content: `Cline active account: ${name}` }
                },
            })
        })
    },
})
