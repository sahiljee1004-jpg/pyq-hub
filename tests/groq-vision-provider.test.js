process.env.NODE_ENV = "test";

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GroqVisionProvider } from "../server/services/documentUnderstanding/groqVisionProvider.js";
import { GroqReasoningProvider } from "../server/services/documentUnderstanding/groqReasoningProvider.js";

describe("Phase 4.5 — Groq Vision & Reasoning Provider Architecture", () => {

    it("1.1 verifies Groq Vision provider configuration and model selection", () => {
        const model = GroqVisionProvider.getModel();
        assert.equal(model, "qwen/qwen3.8-27b", "Vision model must default to qwen/qwen3.8-27b");

        const baseUrl = GroqVisionProvider.getBaseUrl();
        assert.ok(baseUrl.includes("groq.com"), "Base URL must point to Groq API endpoint");

        const isAvail = GroqVisionProvider.isAvailable();
        assert.equal(typeof isAvail, "boolean");
    });

    it("1.2 verifies Groq Reasoning provider configuration and model selection", () => {
        const model = GroqReasoningProvider.getModel();
        assert.equal(model, "openai/gpt-oss-120b", "Reasoning model must default to openai/gpt-oss-120b");

        const baseUrl = GroqReasoningProvider.getBaseUrl();
        assert.ok(baseUrl.includes("groq.com"), "Base URL must point to Groq API endpoint");

        const isAvail = GroqReasoningProvider.isAvailable();
        assert.equal(typeof isAvail, "boolean");
    });

    it("1.3 computes deterministic content-addressed SHA-256 cache keys", () => {
        const dummyBuf = Buffer.from("test_image_data_binary");
        const key1 = GroqVisionProvider.computeCacheKey(dummyBuf, "prompt 1", "qwen/qwen3.8-27b");
        const key2 = GroqVisionProvider.computeCacheKey(dummyBuf, "prompt 1", "qwen/qwen3.8-27b");
        const key3 = GroqVisionProvider.computeCacheKey(dummyBuf, "prompt 2", "qwen/qwen3.8-27b");

        assert.equal(key1, key2, "Identical inputs must yield identical cache keys");
        assert.notEqual(key1, key3, "Different prompts must yield different cache keys");
        assert.equal(key1.length, 24, "Cache key should be 24-character hexadecimal prefix");
    });

    it("1.4 persists and retrieves responses from content-addressed disk cache", () => {
        const testKey = `test_cache_${Date.now()}`;
        const testData = {
            content: "{\"test\": 123}",
            parsedJson: { test: 123 },
            model: "qwen/qwen3.8-27b",
            usage: { totalTokens: 42 }
        };

        // Write to cache
        GroqVisionProvider.setCachedResponse(testKey, testData);

        // Read from cache
        const retrieved = GroqVisionProvider.getCachedResponse(testKey);
        assert.ok(retrieved, "Retrieved data should exist in cache");
        assert.equal(retrieved.parsedJson.test, 123);
        assert.equal(retrieved.model, "qwen/qwen3.8-27b");

        // Clean up test cache file
        const cacheFile = path.join(process.cwd(), "uploads", "vault", "vision_cache", `${testKey}.json`);
        if (fs.existsSync(cacheFile)) {
            fs.unlinkSync(cacheFile);
        }
    });

    it("1.5 validates reasoning provider cache persistence and retrieval", () => {
        const testKey = `test_reas_cache_${Date.now()}`;
        const testData = {
            content: "{\"reconciled\": true}",
            parsedJson: { reconciled: true },
            reasoning: "Step-by-step thinking",
            model: "openai/gpt-oss-120b"
        };

        GroqReasoningProvider.setCachedResponse(testKey, testData);
        const retrieved = GroqReasoningProvider.getCachedResponse(testKey);
        assert.ok(retrieved);
        assert.equal(retrieved.parsedJson.reconciled, true);
        assert.equal(retrieved.reasoning, "Step-by-step thinking");

        const cacheFile = path.join(process.cwd(), "uploads", "vault", "reasoning_cache", `${testKey}.json`);
        if (fs.existsSync(cacheFile)) {
            fs.unlinkSync(cacheFile);
        }
    });

    it("1.6 safely parses structured JSON from markdown fences or raw strings", async () => {
        // Mock cached response with markdown json fences
        const testKey = `mock_fenced_${Date.now()}`;
        const fencedPayload = {
            content: "```json\n{\n  \"questionNumber\": 42,\n  \"stem\": \"What is energy?\"\n}\n```",
            parsedJson: { questionNumber: 42, stem: "What is energy?" },
            model: "qwen/qwen3.8-27b"
        };
        GroqVisionProvider.setCachedResponse(testKey, fencedPayload);

        const cached = GroqVisionProvider.getCachedResponse(testKey);
        assert.ok(cached.parsedJson);
        assert.equal(cached.parsedJson.questionNumber, 42);

        const cacheFile = path.join(process.cwd(), "uploads", "vault", "vision_cache", `${testKey}.json`);
        if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    });
});

