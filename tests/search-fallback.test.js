import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SearchService } from "../server/services/searchService.js";
import { TinyfishSearchService } from "../server/services/search/tinyfishSearchService.js";
import { SerperSearchService } from "../server/services/search/serperSearchService.js";
import { CacheService } from "../server/services/cacheService.js";
import { DeduplicationService } from "../server/services/deduplicationService.js";
import { LiveUpdatesService } from "../server/services/liveUpdatesService.js";

describe("TinyFish + Serper Fallback Test Suite", () => {
    let originalFetch;
    let originalEnv;
    let fetchCalls = [];

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalEnv = { ...process.env };
        fetchCalls = [];
        CacheService.invalidate();
        LiveUpdatesService.lastKnownGoodPayload = null;

        // Ensure mock environment keys
        process.env.TINYFISH_API_KEY = "mock_tinyfish_key_123";
        process.env.SERPER_API_KEY = "mock_serper_key_456";
        process.env.SEARCH_FALLBACK_ENABLED = "true";
        process.env.LIVE_UPDATES_CACHE_TTL_MINUTES = "20";
        process.env.SEARCH_CACHE_TTL_MINUTES = "5";
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        process.env = originalEnv;
        CacheService.invalidate();
    });

    function setupFetchMock({ tinyfishHandler, serperHandler, groqHandler, fetchApiHandler }) {
        globalThis.fetch = async (url, options = {}) => {
            const urlStr = String(url);
            fetchCalls.push({ url: urlStr, method: options.method || "GET", headers: options.headers, body: options.body });

            if (urlStr.includes("api.search.tinyfish.ai")) {
                if (tinyfishHandler) return tinyfishHandler(urlStr, options);
                return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            if (urlStr.includes("google.serper.dev")) {
                if (serperHandler) return serperHandler(urlStr, options);
                return new Response(JSON.stringify({ organic: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            if (urlStr.includes("api.fetch.tinyfish.ai")) {
                if (fetchApiHandler) return fetchApiHandler(urlStr, options);
                return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            if (urlStr.includes("api.groq.com")) {
                if (groqHandler) return groqHandler(urlStr, options);
                return new Response(JSON.stringify({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                updates: [{
                                    id: "mock_update_1",
                                    examName: "JEE Main 2027",
                                    category: "ENGINEERING",
                                    updateType: "IMPORTANT_NOTIFICATION",
                                    title: "JEE Main 2027 Registration Open",
                                    summary: "Online application form is now active on the official portal.",
                                    importantDate: "15 Jan 2027",
                                    status: "active",
                                    publishedAt: "2026-10-16",
                                    source: {
                                        title: "NTA Official",
                                        url: "https://jeemain.nta.nic.in",
                                        domain: "jeemain.nta.nic.in",
                                        type: "official"
                                    }
                                }]
                            })
                        }
                    }]
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            // Generic web page fetch
            return new Response("<html><body>Exam notification announcement details</body></html>", {
                status: 200,
                headers: { "Content-Type": "text/html" }
            });
        };
    }

    // -------------------------------------------------------------
    // Test 1: Fresh cache hit calls neither provider
    // -------------------------------------------------------------
    test("1. Fresh cache hit calls neither provider", async () => {
        const query = "NEET 2027 notification";
        const cacheKey = `search:neet_2027_notification:all`;
        const preCached = {
            success: true,
            query,
            provider: "tinyfish",
            results: [{
                title: "Pre-cached NEET update",
                url: "https://neet.nta.nic.in/update",
                domain: "neet.nta.nic.in",
                snippet: "Cached snippet",
                sourceType: "official",
                position: 1
            }]
        };

        CacheService.set(cacheKey, preCached, 10);

        setupFetchMock({
            tinyfishHandler: () => assert.fail("TinyFish should not be called on fresh cache hit"),
            serperHandler: () => assert.fail("Serper should not be called on fresh cache hit")
        });

        const result = await SearchService.searchWeb(query);
        assert.equal(result.success, true);
        assert.equal(result.cached, true);
        assert.equal(result.results[0].title, "Pre-cached NEET update");
        assert.equal(fetchCalls.length, 0, "No network calls made");
    });

    // -------------------------------------------------------------
    // Test 2: TinyFish success calls Serper zero times
    // -------------------------------------------------------------
    test("2. TinyFish success calls Serper zero times", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response(JSON.stringify({
                results: [
                    {
                        title: "JEE Main 2027 Information Bulletin",
                        url: "https://jeemain.nta.nic.in/bulletin",
                        snippet: "Official JEE Main bulletin published",
                        date: "2026-10-16",
                        position: 1
                    }
                ]
            }), { status: 200, headers: { "Content-Type": "application/json" } }),
            serperHandler: () => assert.fail("Serper should NOT be called when TinyFish succeeds")
        });

        const result = await SearchService.searchWeb("JEE Main 2027 Information Bulletin");
        assert.equal(result.success, true);
        assert.equal(result.provider, "tinyfish");
        assert.equal(result.fallbackUsed, false);
        assert.equal(result.results.length, 1);
        assert.equal(result.results[0].domain, "jeemain.nta.nic.in");
        assert.equal(result.results[0].sourceType, "official");

        const serperCalls = fetchCalls.filter(c => c.url.includes("google.serper.dev"));
        assert.equal(serperCalls.length, 0);
    });

    // -------------------------------------------------------------
    // Test 3: TinyFish quota exhaustion activates Serper
    // -------------------------------------------------------------
    test("3. TinyFish quota exhaustion (HTTP 402 / INSUFFICIENT_CREDITS) activates Serper", async () => {
        let tinyfishAttempted = false;
        let serperAttempted = false;

        setupFetchMock({
            tinyfishHandler: () => {
                tinyfishAttempted = true;
                return new Response(JSON.stringify({
                    error: {
                        code: "INSUFFICIENT_CREDITS",
                        message: "TinyFish wallet balance is zero. Daily allowance exhausted."
                    }
                }), { status: 402, headers: { "Content-Type": "application/json" } });
            },
            serperHandler: () => {
                serperAttempted = true;
                return new Response(JSON.stringify({
                    organic: [
                        {
                            title: "GATE 2027 Registration Closing Date",
                            link: "https://gate2027.iitg.ac.in/dates",
                            snippet: "Last date to apply for GATE 2027 announced.",
                            date: "14 Oct 2026",
                            position: 1
                        }
                    ]
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
        });

        const result = await SearchService.searchWeb("GATE 2027 Registration Closing Date");
        assert.equal(tinyfishAttempted, true);
        assert.equal(serperAttempted, true);
        assert.equal(result.success, true);
        assert.equal(result.provider, "serper");
        assert.equal(result.fallbackUsed, true);
        assert.equal(result.results.length, 1);
        assert.equal(result.results[0].url, "https://gate2027.iitg.ac.in/dates");
        assert.equal(result.results[0].sourceType, "official");
    });

    // -------------------------------------------------------------
    // Test 4: TinyFish rate limit, timeout, network failure, and retryable server errors activate Serper
    // -------------------------------------------------------------
    test("4A. TinyFish rate limit (HTTP 429) activates Serper", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response(JSON.stringify({
                error: { code: "RATE_LIMIT_EXCEEDED", message: "Limit 30 req/min" }
            }), { status: 429, headers: { "Content-Type": "application/json" } }),
            serperHandler: () => new Response(JSON.stringify({
                organic: [{ title: "UPSC CSE 2027 Notification", link: "https://upsc.gov.in/cse2027", snippet: "UPSC CSE details", position: 1 }]
            }), { status: 200, headers: { "Content-Type": "application/json" } })
        });

        const result = await SearchService.searchWeb("UPSC CSE 2027 Notification");
        assert.equal(result.success, true);
        assert.equal(result.provider, "serper");
        assert.equal(result.fallbackUsed, true);
    });

    test("4B. TinyFish retryable server error (HTTP 503) activates Serper", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response("Backend Unavailable", { status: 503 }),
            serperHandler: () => new Response(JSON.stringify({
                organic: [{ title: "SSC CGL 2027 Admit Card", link: "https://ssc.gov.in/cgl", snippet: "SSC CGL admit card released", position: 1 }]
            }), { status: 200, headers: { "Content-Type": "application/json" } })
        });

        const result = await SearchService.searchWeb("SSC CGL 2027 Admit Card");
        assert.equal(result.success, true);
        assert.equal(result.provider, "serper");
        assert.equal(result.fallbackUsed, true);
    });

    test("4C. TinyFish timeout / AbortError activates Serper", async () => {
        setupFetchMock({
            tinyfishHandler: () => {
                const err = new Error("This operation was aborted");
                err.name = "AbortError";
                throw err;
            },
            serperHandler: () => new Response(JSON.stringify({
                organic: [{ title: "CAT 2027 Result Declared", link: "https://iimcat.ac.in/result", snippet: "CAT scorecard link active", position: 1 }]
            }), { status: 200, headers: { "Content-Type": "application/json" } })
        });

        const result = await SearchService.searchWeb("CAT 2027 Result Declared");
        assert.equal(result.success, true);
        assert.equal(result.provider, "serper");
        assert.equal(result.fallbackUsed, true);
    });

    test("4D. TinyFish network error (fetch failed) activates Serper", async () => {
        setupFetchMock({
            tinyfishHandler: () => {
                throw new Error("fetch failed: ECONNRESET");
            },
            serperHandler: () => new Response(JSON.stringify({
                organic: [{ title: "NDA 2027 Notification", link: "https://upsc.gov.in/nda", snippet: "NDA exam notice", position: 1 }]
            }), { status: 200, headers: { "Content-Type": "application/json" } })
        });

        const result = await SearchService.searchWeb("NDA 2027 Notification");
        assert.equal(result.success, true);
        assert.equal(result.provider, "serper");
        assert.equal(result.fallbackUsed, true);
    });

    // -------------------------------------------------------------
    // Test 5: Non-retryable invalid input does not activate Serper
    // -------------------------------------------------------------
    test("5A. Non-retryable empty/invalid query does not call either provider", async () => {
        setupFetchMock({
            tinyfishHandler: () => assert.fail("TinyFish should not be called for empty query"),
            serperHandler: () => assert.fail("Serper should not be called for empty query")
        });

        const result1 = await SearchService.searchWeb("");
        assert.equal(result1.success, false);
        assert.equal(result1.error, "Search query cannot be empty");

        const result2 = await SearchService.searchWeb("   ");
        assert.equal(result2.success, false);
        assert.equal(result2.error, "Search query cannot be empty");
        assert.equal(fetchCalls.length, 0);
    });

    test("5B. TinyFish HTTP 400 (INVALID_INPUT) does NOT activate Serper", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response(JSON.stringify({
                error: { code: "INVALID_INPUT", message: "Malformed search query parameter" }
            }), { status: 400, headers: { "Content-Type": "application/json" } }),
            serperHandler: () => assert.fail("Serper should NOT be called when TinyFish rejects bad user input with HTTP 400")
        });

        const result = await SearchService.searchWeb("bad_query_syntax");
        assert.equal(result.success, false);
        assert.equal(result.provider, "tinyfish");
        assert.equal(result.fallbackUsed, false);

        const serperCalls = fetchCalls.filter(c => c.url.includes("google.serper.dev"));
        assert.equal(serperCalls.length, 0, "Serper was not called on HTTP 400");
    });

    // -------------------------------------------------------------
    // Test 6: Serper success uses existing normalization and deduplication
    // -------------------------------------------------------------
    test("6. Serper success uses existing normalization, URL sanitization, and priority ranking", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response("Rate limited", { status: 429 }),
            serperHandler: () => new Response(JSON.stringify({
                organic: [
                    {
                        title: "News Report: JEE Main 2027",
                        link: "https://ndtv.com/education/jee-main-2027?utm_source=facebook&utm_medium=cpc",
                        snippet: "News report on JEE",
                        position: 1
                    },
                    {
                        title: "Official NTA JEE Portal",
                        link: "https://jeemain.nta.nic.in/latest-announcement#top",
                        snippet: "Official JEE Main announcement",
                        position: 2
                    },
                    {
                        title: "Coaching Guide",
                        link: "https://shiksha.com/jee-main-guide",
                        snippet: "Coaching tips for JEE",
                        position: 3
                    }
                ]
            }), { status: 200, headers: { "Content-Type": "application/json" } })
        });

        const result = await SearchService.searchWeb("JEE Main 2027 announcement");
        assert.equal(result.success, true);
        assert.equal(result.provider, "serper");

        // Official should be ranked ahead of News and Coaching
        assert.equal(result.results[0].sourceType, "official");
        assert.equal(result.results[0].url, "https://jeemain.nta.nic.in/latest-announcement"); // Hash removed
        assert.equal(result.results[1].sourceType, "news");
        assert.equal(result.results[1].url, "https://ndtv.com/education/jee-main-2027"); // Tracking params removed
        assert.equal(result.results[2].sourceType, "coaching");
    });

    // -------------------------------------------------------------
    // Test 7: Both providers fail and stale cache exists -> cached results returned
    // -------------------------------------------------------------
    test("7. Both providers fail and stale cache exists: returns stale cache with freshness metadata", async () => {
        const query = "BITSAT 2027 application date";
        const cacheKey = `search:bitsat_2027_application_date:all`;

        // Store item and artificially expire it
        CacheService.set(cacheKey, {
            success: true,
            query,
            provider: "tinyfish",
            results: [{
                title: "BITSAT 2027 Application Form",
                url: "https://bitsadmission.com/bitsat",
                domain: "bitsadmission.com",
                snippet: "Application opens Dec 2026",
                sourceType: "official",
                position: 1
            }]
        }, 1);

        // Manually expire the item in cache map
        const item = CacheService.cache.get(cacheKey);
        item.expiresAt = Date.now() - 5000; // Expired 5 seconds ago

        // Verify fresh get returns null
        assert.equal(CacheService.get(cacheKey), null);

        // Setup both providers to fail
        setupFetchMock({
            tinyfishHandler: () => new Response("TinyFish 500", { status: 500 }),
            serperHandler: () => new Response("Serper 503", { status: 503 })
        });

        const result = await SearchService.searchWeb(query);
        assert.equal(result.success, true);
        assert.equal(result.cached, true);
        assert.equal(result.stale, true);
        assert.equal(result.results.length, 1);
        assert.equal(result.results[0].title, "BITSAT 2027 Application Form");
    });

    // -------------------------------------------------------------
    // Test 8: Both providers fail and no cache exists -> clean error response
    // -------------------------------------------------------------
    test("8. Both providers fail and no cache exists: returns clean sanitized error", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response("TinyFish quota exhausted", { status: 402 }),
            serperHandler: () => new Response("Serper unauthorized", { status: 401 })
        });

        const result = await SearchService.searchWeb("Uncached Nonexistent Exam");
        assert.equal(result.success, false);
        assert.equal(result.results.length, 0);
        assert.equal(result.error, "Web search is temporarily unavailable. Please try again shortly.");
        // Ensure no internal stack trace or raw HTTP body leaked
        assert.ok(!JSON.stringify(result).includes("mock_tinyfish_key"));
        assert.ok(!JSON.stringify(result).includes("mock_serper_key"));
    });

    // -------------------------------------------------------------
    // Test 9: Malformed provider payloads do not crash the server
    // -------------------------------------------------------------
    test("9A. Malformed TinyFish payload handles safely and triggers Serper", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response("NOT VALID JSON {{{", { status: 200, headers: { "Content-Type": "application/json" } }),
            serperHandler: () => new Response(JSON.stringify({
                organic: [{ title: "Valid Serper Result", link: "https://nta.ac.in", snippet: "NTA home", position: 1 }]
            }), { status: 200, headers: { "Content-Type": "application/json" } })
        });

        const result = await SearchService.searchWeb("Test Malformed Payload");
        assert.equal(result.success, true);
        assert.equal(result.provider, "serper");
    });

    test("9B. Malformed Serper organic items are filtered without crashing", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response("Down", { status: 503 }),
            serperHandler: () => new Response(JSON.stringify({
                organic: [
                    null,
                    undefined,
                    "not an object",
                    { link: "invalid-url-not-http" },
                    { link: "http://127.0.0.1/admin" }, // SSRF blocked
                    { title: "Valid Result", link: "https://jeemain.nta.nic.in/updates", snippet: "Valid" }
                ]
            }), { status: 200, headers: { "Content-Type": "application/json" } })
        });

        const result = await SearchService.searchWeb("Test Malformed Serper Items");
        assert.equal(result.success, true);
        assert.equal(result.provider, "serper");
        assert.equal(result.results.length, 1);
        assert.equal(result.results[0].title, "Valid Result");
        assert.equal(result.results[0].url, "https://jeemain.nta.nic.in/updates");
    });

    // -------------------------------------------------------------
    // Test 10: Duplicate URLs/results are deduplicated as before
    // -------------------------------------------------------------
    test("10. Deduplication handles identical URLs and redundant announcements", () => {
        const rawSources = [
            { title: "JEE Main 2027 Registration Open", url: "https://jeemain.nta.nic.in/register", sourceType: "official" },
            { title: "JEE Main 2027 Registration Form", url: "https://jeemain.nta.nic.in/register#anchor", sourceType: "official" }, // Duplicate URL
            { title: "JEE Main 2027 Application Form Out", url: "https://jeemain.nta.nic.in/register/", sourceType: "official" }, // Duplicate with trailing slash
            { title: "NEET 2027 Notice", url: "https://neet.nta.nic.in/notice", sourceType: "official" }
        ];

        const clean = DeduplicationService.deduplicateRawSources(rawSources);
        assert.equal(clean.length, 2, "Duplicate URLs properly collapsed to unique entries");
    });

    // -------------------------------------------------------------
    // Test 11: Groq summarization fallback behavior remains intact
    // -------------------------------------------------------------
    test("11. Groq summarization failure falls back to source-based cards gracefully", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response(JSON.stringify({
                results: [{
                    title: "JEE Main 2027 Notification",
                    url: "https://jeemain.nta.nic.in/notice",
                    snippet: "NTA has released the exam dates for JEE Main 2027 Session 1.",
                    position: 1
                }]
            }), { status: 200, headers: { "Content-Type": "application/json" } }),
            groqHandler: () => new Response("Groq 500 Internal Error", { status: 500 }) // Groq failure
        });

        const sources = [{
            title: "JEE Main 2027 Notification",
            url: "https://jeemain.nta.nic.in/notice",
            snippet: "NTA has released the exam dates for JEE Main 2027 Session 1.",
            domain: "jeemain.nta.nic.in",
            sourceType: "official"
        }];

        const updates = await LiveUpdatesService.generateStructuredUpdatesWithGroq(sources, "JEE Main 2027");
        assert.equal(Array.isArray(updates), true);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].title, "JEE Main 2027 Notification");
        assert.equal(updates[0].source.domain, "jeemain.nta.nic.in");
    });

    // -------------------------------------------------------------
    // Test 12: API keys are never included in response bodies or logs
    // -------------------------------------------------------------
    test("12. Provider API keys are never included in search or live update response objects", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response("402", { status: 402 }),
            serperHandler: () => new Response(JSON.stringify({
                organic: [{ title: "Result", link: "https://nta.ac.in", snippet: "Sample" }]
            }), { status: 200, headers: { "Content-Type": "application/json" } })
        });

        const searchRes = await SearchService.searchWeb("Check Secret Exposure");
        const serializedSearch = JSON.stringify(searchRes);
        assert.ok(!serializedSearch.includes("mock_tinyfish_key_123"), "TINYFISH_API_KEY must not leak in search result");
        assert.ok(!serializedSearch.includes("mock_serper_key_456"), "SERPER_API_KEY must not leak in search result");

        // Verify request headers sent the key securely to upstream, not in body
        const serperCall = fetchCalls.find(c => c.url.includes("google.serper.dev"));
        assert.equal(serperCall.headers["X-API-KEY"], "mock_serper_key_456");
        assert.ok(!serperCall.body.includes("mock_serper_key_456"));
    });

    // -------------------------------------------------------------
    // Test 13: Live Updates query-specific stale cache isolation
    // -------------------------------------------------------------
    test("13. Targeted search failure does NOT return unrelated general feed cache", async () => {
        // Pre-populate general feed cache with JEE updates
        LiveUpdatesService.lastKnownGoodPayload = {
            success: true,
            cached: true,
            updates: [{
                id: "general_jee_card",
                examName: "JEE Main 2027",
                category: "ENGINEERING",
                title: "JEE Main General Update",
                summary: "General JEE feed"
            }]
        };

        // Targeted search for "UPSC NDA 2027" fails
        setupFetchMock({
            tinyfishHandler: () => new Response("Down", { status: 503 }),
            serperHandler: () => new Response("Down", { status: 503 })
        });

        const searchRes = await LiveUpdatesService.searchLiveUpdates("UPSC NDA 2027");
        assert.equal(searchRes.success, false);
        assert.equal(searchRes.query, "UPSC NDA 2027");
        assert.equal(searchRes.updates.length, 0, "Must NOT return general feed JEE card for an NDA search query");
    });

    // -------------------------------------------------------------
    // Test 14: Stale grace period boundary enforcement
    // -------------------------------------------------------------
    test("14. Stale cache entry exceeding bounded grace period is purged and returns null", () => {
        const key = "test:stale:grace:key";
        CacheService.set(key, { data: "test" }, 1); // 1 min TTL

        const item = CacheService.cache.get(key);
        // Set expiry to 3 hours ago (default grace period is 2 hours = 120 mins)
        item.expiresAt = Date.now() - (3 * 60 * 60 * 1000);

        const staleResult = CacheService.getStale(key);
        assert.equal(staleResult, null, "Item exceeding bounded grace period must return null");
        assert.equal(CacheService.cache.has(key), false, "Ancient item must be purged from cache Map");
    });

    // -------------------------------------------------------------
    // Test 15: Maximum cache capacity LRU eviction
    // -------------------------------------------------------------
    test("15. Cache strictly enforces MAX_CACHE_ENTRIES with LRU eviction", () => {
        CacheService.invalidate();
        const maxLimit = CacheService.MAX_CACHE_ENTRIES;

        // Insert maxLimit + 5 entries
        for (let i = 0; i < maxLimit + 5; i++) {
            CacheService.set(`key_${i}`, { index: i }, 10);
        }

        assert.equal(CacheService.cache.size, maxLimit, `Cache size must not exceed ${maxLimit}`);
        // Oldest entries (key_0 through key_4) should have been evicted
        assert.equal(CacheService.cache.has("key_0"), false, "Oldest key_0 should have been evicted");
        assert.equal(CacheService.cache.has("key_4"), false, "Oldest key_4 should have been evicted");
        // Newest entry should exist
        assert.equal(CacheService.cache.has(`key_${maxLimit + 4}`), true, "Newest entry must exist");
    });

    // -------------------------------------------------------------
    // Test 16: Oversized response payload rejection
    // -------------------------------------------------------------
    test("16. Oversized response payloads (> 2MB) are rejected safely", async () => {
        setupFetchMock({
            tinyfishHandler: () => new Response("OK", {
                status: 200,
                headers: { "Content-Type": "application/json", "Content-Length": "3145728" } // 3MB header
            }),
            serperHandler: () => new Response(JSON.stringify({
                organic: [{ title: "Serper Safe", link: "https://nta.ac.in", snippet: "Fallback ok" }]
            }), { status: 200, headers: { "Content-Type": "application/json" } })
        });

        // TinyFish should be rejected due to oversized header, falling back to Serper
        const result = await SearchService.searchWeb("Oversized payload test");
        assert.equal(result.success, true);
        assert.equal(result.provider, "serper");
    });
});
