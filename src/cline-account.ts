// Cline account / organization helpers.
// Account/organization API helpers for the OpenCode plugin; the
// Interactive command logic lives in src/index.ts.

const API_BASE_URL = "https://api.cline.bot"
export const PERSONAL_ACCOUNT_ID = "__personal__"

export type ClineAccountOrganization = {
    active?: boolean
    memberId?: string
    name?: string
    organizationId?: string
    roles?: string[]
}

export type ClineAccountUser = {
    email?: string
    id?: string
    organizations?: ClineAccountOrganization[]
}

type ClineAccountBalance = {
    balance?: number
}

export type ClineAccountChoice = {
    id: string
    label: string
    organization: ClineAccountOrganization | null
}

function clineUrl(path: string): string {
    return new URL(path, API_BASE_URL).toString()
}

function headers(): Record<string, string> {
    return {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "pi-cline-oauth-extension",
        "X-CLIENT-TYPE": "pi",
    }
}

function authHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, ...headers() }
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

async function readErrorFromParsed(
    response: Response,
    text: string,
    parsed: unknown,
): Promise<string> {
    if (typeof parsed === "object" && parsed !== null) {
        const json = parsed as {
            error?: string
            error_description?: string
            message?: string
        }
        return json.error_description ?? json.message ?? json.error ?? text
    }
    return text || `${response.status} ${response.statusText}`
}

async function readJson<T>(response: Response): Promise<T> {
    const text = await response.text()
    let parsed: unknown
    try {
        parsed = text.trim() ? (JSON.parse(text) as unknown) : undefined
    } catch {
        if (!response.ok) throw new Error(text || response.statusText)
        throw new Error("Cline account response was not valid JSON")
    }
    if (!response.ok) {
        throw new Error(await readErrorFromParsed(response, text, parsed))
    }
    if (typeof parsed === "object" && parsed !== null && "success" in parsed) {
        const envelope = parsed as {
            success?: boolean
            error?: string
            data?: T
        }
        if (envelope.success === false) {
            throw new Error(envelope.error ?? "Cline account request failed")
        }
        return envelope.data as T
    }
    return parsed as T
}

async function fetchClineMe(
    token: string,
    signal?: AbortSignal,
): Promise<ClineAccountUser> {
    const response = await fetch(clineUrl("/api/v1/users/me"), {
        headers: authHeaders(token),
        signal,
    })
    return readJson<ClineAccountUser>(response)
}

export async function switchClineOrganization(
    token: string,
    organizationId: string | null,
    signal?: AbortSignal,
): Promise<void> {
    const response = await fetch(clineUrl("/api/v1/users/active-account"), {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ organizationId }),
        signal,
    })
    if (!response.ok) {
        throw new Error(
            `Cline organization switch failed: ${await readError(response)}`,
        )
    }
}

function formatCreditBalance(value: number | undefined): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined
    return `$${(value / 1_000_000).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`
}

async function fetchPersonalBalance(
    token: string,
    userId: string,
    signal?: AbortSignal,
): Promise<number | undefined> {
    const response = await fetch(
        clineUrl(`/api/v1/users/${encodeURIComponent(userId)}/balance`),
        { headers: authHeaders(token), signal },
    )
    return (await readJson<ClineAccountBalance>(response)).balance
}

async function fetchOrganizationBalance(
    token: string,
    organizationId: string,
    signal?: AbortSignal,
): Promise<number | undefined> {
    const response = await fetch(
        clineUrl(
            `/api/v1/organizations/${encodeURIComponent(organizationId)}/balance`,
        ),
        { headers: authHeaders(token), signal },
    )
    return (await readJson<ClineAccountBalance>(response)).balance
}

async function fetchBalanceText(
    fetchBalance: () => Promise<number | undefined>,
): Promise<string | undefined> {
    try {
        return formatCreditBalance(await fetchBalance())
    } catch {
        return undefined
    }
}

function formatOrganizationLabel(
    organization: ClineAccountOrganization,
    balanceText?: string,
): string | undefined {
    const organizationId = organization.organizationId?.trim()
    if (!organizationId) return undefined
    const name = organization.name?.trim() || organizationId
    const roleText = organization.roles?.length
        ? ` (${organization.roles.join(", ")})`
        : ""
    const balance = balanceText ? ` — ${balanceText}` : ""
    return `${
        organization.active ? "✓" : " "
    } ${name}${roleText}${balance} — ${organizationId}`
}

function personalAccountLabel(active: boolean, balanceText?: string): string {
    const balance = balanceText ? ` — ${balanceText}` : ""
    return `${active ? "✓" : " "} Personal account${balance}`
}

export async function loadClineAccountChoices(
    token: string,
    signal?: AbortSignal,
): Promise<ClineAccountChoice[]> {
    const me = await fetchClineMe(token, signal)
    const organizations = me.organizations ?? []
    const activeOrganization =
        organizations.find((organization) => organization.active) ?? null
    const userId = me.id?.trim()
    const [personalBalanceText, organizationBalanceTexts] = await Promise.all([
        userId
            ? fetchBalanceText(() =>
                  fetchPersonalBalance(token, userId, signal),
              )
            : Promise.resolve(undefined),
        Promise.all(
            organizations.map(async (organization) => {
                const organizationId = organization.organizationId?.trim()
                if (!organizationId) return undefined
                return fetchBalanceText(() =>
                    fetchOrganizationBalance(token, organizationId, signal),
                )
            }),
        ),
    ])
    const organizationChoices = organizations.flatMap<ClineAccountChoice>(
        (organization, index) => {
            const organizationId = organization.organizationId?.trim()
            const label = formatOrganizationLabel(
                organization,
                organizationBalanceTexts[index],
            )
            if (!organizationId || !label) return []
            return [{ id: organizationId, label, organization }]
        },
    )

    return [
        {
            id: PERSONAL_ACCOUNT_ID,
            label: personalAccountLabel(
                !activeOrganization,
                personalBalanceText,
            ),
            organization: null,
        },
        ...organizationChoices,
    ]
}

export async function switchClineAccountChoice(
    token: string,
    choice: ClineAccountChoice,
    signal?: AbortSignal,
): Promise<string> {
    const organizationId =
        choice.id === PERSONAL_ACCOUNT_ID
            ? null
            : choice.organization?.organizationId?.trim()
    if (choice.id !== PERSONAL_ACCOUNT_ID && !organizationId) {
        throw new Error(
            "Selected organization did not include an organization id",
        )
    }

    await switchClineOrganization(token, organizationId ?? null, signal)
    return organizationId
        ? (choice.organization?.name?.trim() ?? organizationId)
        : "Personal account"
}
