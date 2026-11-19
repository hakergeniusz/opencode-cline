// WorkOS device-code OAuth against Cline's api.cline.bot endpoints.
// Ported from pi-cline with pi's OAuth types replaced by small local types.

import {
    loadClineAccountChoices,
    switchClineOrganization,
} from "./cline-account.ts"

const API_BASE_URL = "https://api.cline.bot"
const WORKOS_API_BASE_URL = "https://api.workos.com"
const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR"
const REFRESH_BUFFER_MS = 5 * 60 * 1000
const WORKOS_TOKEN_PREFIX = "workos:"

export type ClineCredentials = {
    access: string
    refresh: string
    /** Epoch milliseconds, already shifted earlier by the refresh buffer. */
    expires: number
}

export type LoginCallbacks = {
    onDeviceCode?: (info: {
        userCode: string
        verificationUri: string
        intervalSeconds: number
        expiresInSeconds: number
    }) => void
    onAuth?: (info: { url: string; instructions: string }) => void
    onProgress?: (message: string) => void
    onSelect?: (info: {
        message: string
        options: { id: string; label: string }[]
    }) => Promise<string | undefined>
}

export type LoginOptions = {
    /** ClinePass always uses the personal account. */
    forcePersonal?: boolean
    signal?: AbortSignal
}

type ClineAuthResponse = {
    success?: boolean
    data?: {
        accessToken?: string
        refreshToken?: string
        expiresAt?: string
    }
}

type WorkOSDeviceAuthorizationResponse = {
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
    error?: string
    error_description?: string
}

type WorkOSTokenResponse = {
    access_token?: string
    refresh_token?: string
    error?: string
    error_description?: string
}

function clineUrl(path: string): string {
    return new URL(path, API_BASE_URL).toString()
}

function headers(contentType = "application/json"): Record<string, string> {
    return {
        Accept: "application/json",
        "Content-Type": contentType,
        "User-Agent": "pi-cline-oauth-extension",
        "X-CLIENT-TYPE": "pi",
    }
}

async function readError(response: Response): Promise<string> {
    const text = await response.text().catch(() => "")
    if (!text) return `${response.status} ${response.statusText}`
    try {
        const json = JSON.parse(text) as {
            error?: string
            error_description?: string
            message?: string
        }
        return json.error_description ?? json.message ?? json.error ?? text
    } catch {
        return text
    }
}

function toCredentials(
    payload: ClineAuthResponse,
    fallback?: ClineCredentials,
): ClineCredentials {
    const data = payload.data
    if (!payload.success || !data?.accessToken || !data.expiresAt) {
        throw new Error("Invalid token response from Cline")
    }
    const refreshToken = data.refreshToken ?? fallback?.refresh
    if (!refreshToken)
        throw new Error("Token response did not include a refresh token")

    const expires = Date.parse(data.expiresAt)
    if (Number.isNaN(expires))
        throw new Error(
            `Invalid token expiration from Cline: ${data.expiresAt}`,
        )

    return {
        access: data.accessToken,
        refresh: refreshToken,
        expires: expires - REFRESH_BUFFER_MS,
    }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Cline device authorization cancelled"))
            return
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve()
        }, ms)
        function onAbort() {
            clearTimeout(timer)
            reject(new Error("Cline device authorization cancelled"))
        }
        signal?.addEventListener("abort", onAbort, { once: true })
    })
}

export function isExpired(credentials: ClineCredentials): boolean {
    return Date.now() >= credentials.expires
}

export function getClineApiKey(credentials: ClineCredentials): string {
    return credentials.access.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)
        ? credentials.access
        : `${WORKOS_TOKEN_PREFIX}${credentials.access}`
}

async function startDeviceAuthorization(
    signal?: AbortSignal,
): Promise<{
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete?: string
    expiresInSeconds: number
    intervalSeconds: number
}> {
    const response = await fetch(
        `${WORKOS_API_BASE_URL}/user_management/authorize/device`,
        {
            method: "POST",
            headers: headers("application/x-www-form-urlencoded"),
            body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
            signal,
        },
    )
    const data = (await response
        .json()
        .catch(() => ({}))) as WorkOSDeviceAuthorizationResponse
    if (
        !response.ok ||
        !data.device_code ||
        !data.user_code ||
        !data.verification_uri
    ) {
        throw new Error(
            `Cline device authorization failed: ${data.error_description ?? data.error ?? response.statusText}`,
        )
    }

    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        verificationUriComplete: data.verification_uri_complete,
        expiresInSeconds: data.expires_in ?? 300,
        intervalSeconds: data.interval ?? 5,
    }
}

async function pollDeviceAuthorization(params: {
    deviceCode: string
    expiresInSeconds: number
    intervalSeconds: number
    signal?: AbortSignal
}): Promise<{ accessToken: string; refreshToken: string }> {
    const deadline = Date.now() + params.expiresInSeconds * 1000
    let intervalSeconds = Math.max(1, params.intervalSeconds)

    while (Date.now() <= deadline) {
        const response = await fetch(
            `${WORKOS_API_BASE_URL}/user_management/authenticate`,
            {
                method: "POST",
                headers: headers("application/x-www-form-urlencoded"),
                body: new URLSearchParams({
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    device_code: params.deviceCode,
                    client_id: WORKOS_CLIENT_ID,
                }),
                signal: params.signal,
            },
        )
        const data = (await response
            .json()
            .catch(() => ({}))) as WorkOSTokenResponse
        if (response.ok && data.access_token && data.refresh_token) {
            return {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
            }
        }

        if (data.error === "authorization_pending") {
            await sleep(intervalSeconds * 1000, params.signal)
            continue
        }
        if (data.error === "slow_down") {
            intervalSeconds += 1
            await sleep(intervalSeconds * 1000, params.signal)
            continue
        }
        throw new Error(
            `Cline device authorization failed: ${data.error_description ?? data.error ?? response.statusText}`,
        )
    }

    throw new Error("Cline device authorization timed out")
}

async function registerWorkOSTokens(tokens: {
    accessToken: string
    refreshToken: string
}): Promise<ClineCredentials> {
    const response = await fetch(clineUrl("/api/v1/auth/register"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(tokens),
    })
    if (!response.ok)
        throw new Error(
            `Cline token registration failed: ${await readError(response)}`,
        )
    return toCredentials((await response.json()) as ClineAuthResponse)
}

export async function refreshClineToken(
    credentials: ClineCredentials,
    signal?: AbortSignal,
): Promise<ClineCredentials> {
    const response = await fetch(clineUrl("/api/v1/auth/refresh"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
            refreshToken: credentials.refresh,
            grantType: "refresh_token",
        }),
        signal,
    })
    if (!response.ok)
        throw new Error(
            `Cline token refresh failed: ${await readError(response)}`,
        )
    return toCredentials(
        (await response.json()) as ClineAuthResponse,
        credentials,
    )
}

export async function loginCline(
    callbacks: LoginCallbacks,
    options: LoginOptions = {},
): Promise<ClineCredentials> {
    const signal = options.signal
    const device = await startDeviceAuthorization(signal)
    const authUrl = device.verificationUriComplete ?? device.verificationUri
    // Some hosts implement onAuth but not onDeviceCode; both are optional.
    callbacks.onDeviceCode?.({
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        intervalSeconds: device.intervalSeconds,
        expiresInSeconds: device.expiresInSeconds,
    })
    if (typeof callbacks.onAuth === "function") {
        callbacks.onAuth({
            url: authUrl,
            instructions: `Continue with Google. If asked for a device code, enter ${device.userCode}`,
        })
    } else {
        callbacks.onProgress?.(
            `Open ${authUrl} and continue with Google (code ${device.userCode})`,
        )
    }

    const workosTokens = await pollDeviceAuthorization({
        deviceCode: device.deviceCode,
        expiresInSeconds: device.expiresInSeconds,
        intervalSeconds: device.intervalSeconds,
        signal,
    })
    const credentials = await registerWorkOSTokens(workosTokens)
    const token = getClineApiKey(credentials)

    if (options.forcePersonal) {
        await switchClineOrganization(token, null, signal)
        callbacks.onProgress?.("Cline active account: Personal account")
        return credentials
    }

    // Org-aware login: mirror the pi flow. When an interactive selector is
    // available, use it; otherwise keep the account Cline currently has active.
    const choices = await loadClineAccountChoices(token, signal)
    if (choices.length <= 1) return credentials
    if (typeof callbacks.onSelect !== "function") {
        callbacks.onProgress?.(
            "Cline login complete. Use /cline-org to switch accounts if needed.",
        )
        return credentials
    }

    const selectedId = await callbacks.onSelect({
        message: "Choose your active Cline account",
        options: choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
        })),
    })
    if (!selectedId) return credentials
    const choice = choices.find((choice) => choice.id === selectedId)
    if (!choice) return credentials

    const organizationId = choice.organization?.organizationId?.trim() ?? null
    await switchClineOrganization(token, organizationId, signal)
    callbacks.onProgress?.(
        `Cline active account: ${
            organizationId
                ? (choice.organization?.name?.trim() ?? organizationId)
                : "Personal account"
        }`,
    )
    return credentials
}
