// Prompt-cache payload normalization for Cline's OpenAI-compatible endpoint.
// Prompt-cache payload normalization for Cline-compatible requests.

export type JsonObject = Record<string, unknown>

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const

export function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasCacheControl(value: unknown): boolean {
    return isObject(value) && isObject(value.cache_control)
}

function messageHasCacheControl(value: unknown): boolean {
    if (!isObject(value)) return false
    if (hasCacheControl(value)) return true
    return Array.isArray(value.content) && value.content.some(hasCacheControl)
}

function stripMessageCacheControl(value: unknown): unknown {
    if (!isObject(value)) return value
    const { cache_control: _cacheControl, ...message } = value
    if (!Array.isArray(message.content)) return message

    return {
        ...message,
        content: message.content.map((part) => {
            if (!isObject(part)) return part
            const { cache_control: _partCacheControl, ...rest } = part
            return rest
        }),
    }
}

function stripToolCacheControl(value: unknown): unknown {
    if (!isObject(value)) return value
    const { cache_control: _cacheControl, ...tool } = value
    return tool
}

// Avoid Array.prototype.findLastIndex so the module also runs on ES2022 hosts.
function findLastIndex(
    values: unknown[],
    predicate: (value: unknown) => boolean,
): number {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        if (predicate(values[index])) return index
    }
    return -1
}

/**
 * Rewrite cache markers so Cline sees a single ephemeral breakpoint on the
 * latest user/assistant message. Applications may carry `cache_control` keys
 * for their own purposes (for example inside tool parameter schemas or nested
 * metadata); those are left untouched.
 */
export function normalizeClinePromptCachePayload(payload: unknown): unknown {
    if (!isObject(payload)) return payload

    const messages: unknown[] = Array.isArray(payload.messages)
        ? payload.messages
        : []
    const tools: unknown[] = Array.isArray(payload.tools) ? payload.tools : []
    const hasPiCacheMarkers =
        hasCacheControl(payload) ||
        messages.some(messageHasCacheControl) ||
        tools.some(hasCacheControl)
    if (!hasPiCacheMarkers) return payload

    const markedConversationIndex = findLastIndex(
        messages,
        (message) =>
            isObject(message) &&
            (message.role === "user" || message.role === "assistant") &&
            messageHasCacheControl(message),
    )
    const fallbackConversationIndex = findLastIndex(
        messages,
        (message) =>
            isObject(message) &&
            (message.role === "user" || message.role === "assistant"),
    )
    const conversationIndex =
        markedConversationIndex >= 0
            ? markedConversationIndex
            : fallbackConversationIndex
    const normalizedMessages = messages.map(stripMessageCacheControl)
    if (
        conversationIndex >= 0 &&
        isObject(normalizedMessages[conversationIndex])
    ) {
        normalizedMessages[conversationIndex] = {
            ...normalizedMessages[conversationIndex],
            cache_control: EPHEMERAL_CACHE_CONTROL,
        }
    }

    const { cache_control: _cacheControl, ...normalized } = payload
    return {
        ...normalized,
        cache_control: EPHEMERAL_CACHE_CONTROL,
        ...(Array.isArray(payload.messages)
            ? { messages: normalizedMessages }
            : {}),
        ...(Array.isArray(payload.tools)
            ? { tools: tools.map(stripToolCacheControl) }
            : {}),
    }
}
