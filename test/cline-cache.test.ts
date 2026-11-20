import { describe, expect, it } from "bun:test"
import { normalizeClinePromptCachePayload } from "../src/cline-cache.ts"

const noCacheCost = { cacheRead: 0, cacheWrite: 0 }

describe("Cline prompt-cache normalization", () => {
    it("leaves payloads unchanged when no cache markers are present", () => {
        const payload = {
            model: "anthropic/claude-fable-5",
            messages: [{ role: "user", content: "Hello" }],
        }

        expect(normalizeClinePromptCachePayload(payload)).toBe(payload)
    })

    it("normalizes cache markers to Cline's request format", () => {
        const payload = {
            model: "anthropic/claude-fable-5",
            messages: [
                {
                    role: "system",
                    content: [
                        {
                            type: "text",
                            text: "System prompt",
                            cache_control: { type: "ephemeral", ttl: "1h" },
                        },
                    ],
                },
                { role: "user", content: "First request" },
                { role: "assistant", content: "First response" },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Latest request",
                            cache_control: { type: "ephemeral", ttl: "1h" },
                        },
                    ],
                },
            ],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "read",
                        parameters: {
                            properties: { cache_control: { type: "string" } },
                        },
                    },
                    cache_control: { type: "ephemeral", ttl: "1h" },
                },
            ],
            metadata: { cache_control: "preserve nested application data" },
        }

        expect(normalizeClinePromptCachePayload(payload)).toEqual({
            model: "anthropic/claude-fable-5",
            cache_control: { type: "ephemeral" },
            messages: [
                {
                    role: "system",
                    content: [{ type: "text", text: "System prompt" }],
                },
                { role: "user", content: "First request" },
                { role: "assistant", content: "First response" },
                {
                    role: "user",
                    content: [{ type: "text", text: "Latest request" }],
                    cache_control: { type: "ephemeral" },
                },
            ],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "read",
                        parameters: {
                            properties: { cache_control: { type: "string" } },
                        },
                    },
                },
            ],
            metadata: { cache_control: "preserve nested application data" },
        })
    })

    it("keeps non-object payloads intact", () => {
        expect(normalizeClinePromptCachePayload(undefined)).toBe(undefined)
        expect(normalizeClinePromptCachePayload("payload")).toBe("payload")
        expect(noCacheCost).toEqual({ cacheRead: 0, cacheWrite: 0 })
    })
})
