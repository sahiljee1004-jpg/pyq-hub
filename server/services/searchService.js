import dotenv from "dotenv";
import { TinyfishSearchService } from "./search/tinyfishSearchService.js";
import { SerperSearchService } from "./search/serperSearchService.js";
import { CacheService } from "./cacheService.js";

dotenv.config();

/**
 * Centralized Provider-Independent Search Abstraction Service
 * Primary Provider: TinyFish Search (GET api.search.tinyfish.ai)
 * Fallback Provider: Serper Google Search (POST google.serper.dev/search)
 * Graceful Degradation: Stale Cache fallback when all providers fail
 */
export class SearchService {
    static pendingSearchesMap = new Map();

    static getPrimaryProviderName() {
        return "tinyfish";
    }

    static getSecondaryProviderName() {
        return "serper";
    }

    static isFallbackEnabled() {
        return Boolean(process.env.SERPER_API_KEY) || process.env.SEARCH_FALLBACK_ENABLED === "true";
    }

    static isSerperConfigured() {
        return SerperSearchService.isConfigured();
    }

    static getCacheTtlMinutes() {
        return parseInt(process.env.SEARCH_CACHE_TTL_MINUTES || "5", 10);
    }

    /**
     * Clean and optimize user search query for educational / exam intent
     */
    static buildSearchQuery(userMessage, context = {}) {
        if (!userMessage || typeof userMessage !== "string") return "";
        let query = userMessage.trim();

        // Strip common filler phrases
        query = query.replace(/^(can you tell me|what is|please search|find me|tell me|what was|when will|how much is|give me)\s+/i, "");

        // Enhance query with official keywords for exam-specific inquiries
        const lower = userMessage.toLowerCase();
        if ((lower.includes("cutoff") || lower.includes("cut off") || lower.includes("closing rank")) && !lower.includes("official")) {
            if (lower.includes("jee main")) query += " official cutoff NTA";
            else if (lower.includes("jee advanced")) query += " official cutoff JoSAA";
            else if (lower.includes("gate")) query += " official cutoff GATE";
            else if (lower.includes("neet")) query += " official cutoff NTA MCC";
        } else if (lower.includes("syllabus") && !lower.includes("official")) {
            query += " official syllabus pdf website";
        }

        return query;
    }

    /**
     * Central Provider Execution with Caching, TinyFish Primary, Serper Fallback, and Stale Cache Degradation
     */
    static async searchWeb(query, options = {}) {
        // Step 1: Input Validation
        if (!query || typeof query !== "string" || !query.trim()) {
            return {
                success: false,
                query: "",
                error: "Search query cannot be empty",
                results: []
            };
        }

        const cleanQuery = query.trim();
        const cacheTtlMins = options.ttl || this.getCacheTtlMinutes();
        const cacheKey = `search:${cleanQuery.toLowerCase().replace(/\s+/g, "_")}:${options.time_range || "all"}`;

        // Step 2: Check Fresh Search Cache
        const cachedPayload = CacheService.get(cacheKey);
        if (cachedPayload && !options.skipCache) {
            console.log(`[SearchService] Fresh cache hit for query: "${cleanQuery}" (provider=${cachedPayload.provider || "cache"})`);
            return {
                ...cachedPayload,
                cached: true
            };
        }

        // Step 3: Single-Flight Concurrency Guard
        if (this.pendingSearchesMap.has(cacheKey)) {
            console.log(`[SearchService] Single-flight lock active. Converging simultaneous search for: "${cleanQuery}"...`);
            try {
                return await this.pendingSearchesMap.get(cacheKey);
            } catch (err) {
                // Fallthrough if in-flight request fails
            }
        }

        const searchExecutionPromise = (async () => {
            let primaryResult = null;
            let primaryAttempted = false;

            // Step 4: Primary Provider (TinyFish)
            console.log(`[SearchService] Executing TinyFish primary search for: "${cleanQuery}"`);
            try {
                primaryAttempted = true;
                primaryResult = await TinyfishSearchService.searchWeb(cleanQuery, options);
            } catch (err) {
                primaryResult = {
                    success: false,
                    provider: "tinyfish",
                    query: cleanQuery,
                    isNetworkError: true,
                    error: err.message || "TinyFish search network exception",
                    results: []
                };
            }

            // Step 5: If TinyFish succeeds with valid results, return and cache
            if (primaryResult?.success && Array.isArray(primaryResult.results) && primaryResult.results.length > 0) {
                const processed = this.processAndRankResults(primaryResult.results, options);
                const responsePayload = {
                    success: true,
                    query: cleanQuery,
                    provider: "tinyfish",
                    fallbackUsed: false,
                    results: processed,
                    rawAnswers: primaryResult.rawAnswers || [],
                    suggestions: primaryResult.suggestions || []
                };

                CacheService.set(cacheKey, responsePayload, cacheTtlMins);
                return responsePayload;
            }

            // Step 6: Evaluate Fallback Eligibility
            // Do NOT activate Serper for ordinary non-retryable invalid input
            const isInvalidInput = Boolean(primaryResult?.isInvalidInput);
            if (isInvalidInput) {
                console.warn(`[SearchService] TinyFish reported invalid input (HTTP 400). Skipping fallback.`);
                return {
                    success: false,
                    query: cleanQuery,
                    provider: "tinyfish",
                    fallbackUsed: false,
                    error: "Invalid search query parameter.",
                    results: []
                };
            }

            // Fallback is eligible for: Quota Exhaustion, Rate Limits, Timeouts, Network Drops, 5xx Server Errors, or Missing Key
            const isQuotaExhausted = Boolean(primaryResult?.isQuotaExhausted);
            const isRateLimited = Boolean(primaryResult?.isRateLimited);
            const isTimeout = Boolean(primaryResult?.isTimeout);
            const isServerError = Boolean(primaryResult?.isServerError);
            const isNetworkError = Boolean(primaryResult?.isNetworkError);
            const isConfigError = Boolean(primaryResult?.isConfigError);

            // Detailed Diagnostic Logging distinguishing quota exhaustion from temporary failures
            if (isQuotaExhausted) {
                console.warn(`[SearchService] TinyFish quota exhausted (credits/allowance depleted). Invoking Serper fallback for: "${cleanQuery}"...`);
            } else if (isRateLimited) {
                console.warn(`[SearchService] TinyFish rate-limited (HTTP 429). Invoking Serper fallback for: "${cleanQuery}"...`);
            } else if (isTimeout) {
                console.warn(`[SearchService] TinyFish query timed out. Invoking Serper fallback for: "${cleanQuery}"...`);
            } else if (isServerError) {
                console.warn(`[SearchService] TinyFish server error (${primaryResult?.status || 500}). Invoking Serper fallback for: "${cleanQuery}"...`);
            } else if (isNetworkError) {
                console.warn(`[SearchService] TinyFish network connection failure. Invoking Serper fallback for: "${cleanQuery}"...`);
            } else if (isConfigError) {
                console.warn(`[SearchService] TinyFish not configured/unauthorized. Invoking Serper fallback for: "${cleanQuery}"...`);
            } else {
                console.warn(`[SearchService] TinyFish returned empty/failed results (${primaryResult?.error || "empty"}). Checking Serper fallback for: "${cleanQuery}"...`);
            }

            // Step 7: Invoke Serper Secondary Provider
            let serperResult = null;
            if (this.isSerperConfigured() || this.isFallbackEnabled()) {
                try {
                    serperResult = await SerperSearchService.searchWeb(cleanQuery, options);

                    if (serperResult?.success && Array.isArray(serperResult.results) && serperResult.results.length > 0) {
                        console.log(`[SearchService] Serper fallback succeeded with ${serperResult.results.length} valid results`);
                        const processed = this.processAndRankResults(serperResult.results, options);
                        const responsePayload = {
                            success: true,
                            query: cleanQuery,
                            provider: "serper",
                            fallbackUsed: true,
                            results: processed,
                            rawAnswers: serperResult.answerBox ? [serperResult.answerBox] : [],
                            suggestions: serperResult.peopleAlsoAsk ? serperResult.peopleAlsoAsk.map(p => p.question) : []
                        };

                        CacheService.set(cacheKey, responsePayload, cacheTtlMins);
                        return responsePayload;
                    }

                    console.warn(`[SearchService] Serper fallback returned empty or failed: ${serperResult?.error || "No results"}`);

                } catch (err) {
                    console.error(`[SearchService] Exception during Serper fallback search:`, err.message);
                }
            } else {
                console.warn(`[SearchService] Serper fallback is not configured or disabled in environment.`);
            }

            // Step 8: Both Providers Failed -> Check for Usable Stale Cache for THIS search query
            const stalePayload = CacheService.getStale(cacheKey);
            if (stalePayload) {
                console.warn(`[SearchService] Both search providers failed. Gracefully returning stale cached results for: "${cleanQuery}"`);
                return {
                    ...stalePayload,
                    cached: true,
                    stale: true,
                    fallbackUsed: true
                };
            }

            // Step 9: No Usable Cache Exists -> Return Sanitized Error Response
            console.error(`[SearchService] Total search failure: Both TinyFish and Serper failed and no usable cache exists for: "${cleanQuery}"`);
            return {
                success: false,
                query: cleanQuery,
                provider: "none",
                fallbackUsed: true,
                error: "Web search is temporarily unavailable. Please try again shortly.",
                results: []
            };
        })();

        this.pendingSearchesMap.set(cacheKey, searchExecutionPromise);

        try {
            return await searchExecutionPromise;
        } finally {
            this.pendingSearchesMap.delete(cacheKey);
        }
    }

    /**
     * Fetch webpage content via TinyFish Fetch API
     */
    static async fetchWebPage(urlStr, options = {}) {
        return TinyfishSearchService.fetchWebPage(urlStr, options);
    }

    /**
     * Fetch clean content for multiple URLs via TinyFish Fetch API
     */
    static async fetchWebPages(urls, options = {}) {
        return TinyfishSearchService.fetchWebPages(urls, options);
    }

    /**
     * Extract clean domain from URL string
     */
    static extractDomain(urlStr) {
        try {
            const parsed = new URL(urlStr);
            return parsed.hostname.replace(/^www\./, "");
        } catch (e) {
            return "unknown";
        }
    }

    /**
     * Classify source trust level (Official > Educational > News > Coaching > Forum > Unknown)
     */
    static classifySourceType(domain) {
        if (!domain || typeof domain !== "string") return "unknown";
        const d = domain.toLowerCase();

        if (
            d.endsWith(".gov.in") ||
            d.endsWith(".nic.in") ||
            d.endsWith(".ac.in") ||
            d.includes("nta.ac.in") ||
            d.includes("jeemain.nta") ||
            d.includes("jeeadv.ac.in") ||
            d.includes("josaa.nic.in") ||
            d.includes("gate2026") ||
            d.includes("gate2027") ||
            d.includes("iitg.ac.in") ||
            d.includes("iitb.ac.in") ||
            d.includes("iitd.ac.in") ||
            d.includes("iitm.ac.in") ||
            d.includes("upsc.gov.in") ||
            d.includes("ssc.gov.in") ||
            d.includes("nirfindia.org")
        ) {
            return "official";
        }

        if (d.endsWith(".edu") || d.endsWith(".edu.in") || d.includes("wikipedia.org")) {
            return "educational";
        }

        if (
            d.includes("indianexpress.com") ||
            d.includes("timesofindia") ||
            d.includes("hindustantimes") ||
            d.includes("ndtv.com") ||
            d.includes("news18.com") ||
            d.includes("livemint.com")
        ) {
            return "news";
        }

        if (
            d.includes("careers360.com") ||
            d.includes("shiksha.com") ||
            d.includes("collegedunia.com") ||
            d.includes("allen.ac.in") ||
            d.includes("resonance.ac.in") ||
            d.includes("fiitjee") ||
            d.includes("physicswallah")
        ) {
            return "coaching";
        }

        if (d.includes("reddit.com") || d.includes("quora.com")) {
            return "forum";
        }

        return "unknown";
    }

    /**
     * Process, Deduplicate, and Priority-Sort search results
     */
    static processAndRankResults(results, options = {}) {
        if (!Array.isArray(results)) return [];

        // 1. Normalize & Deduplicate URLs
        const deduplicatedMap = new Map();
        results.forEach((item, idx) => {
            if (!item || typeof item !== "object") return;
            const rawUrl = item.url || item.link || "";
            if (!rawUrl) return;

            const cleanUrl = this.cleanUrl(rawUrl);
            const domain = item.domain || this.extractDomain(cleanUrl);
            const sourceType = item.sourceType || this.classifySourceType(domain);
            const provider = item.provider || item.source || "search";

            if (!deduplicatedMap.has(cleanUrl)) {
                deduplicatedMap.set(cleanUrl, {
                    title: item.title || "Untitled Source",
                    url: cleanUrl,
                    domain: domain,
                    snippet: item.snippet || item.content || "",
                    source: provider,
                    sourceType: sourceType,
                    publishedDate: item.publishedDate || item.publishedAt || item.date || null,
                    publishedAt: item.publishedAt || item.publishedDate || item.date || null,
                    position: item.position || (idx + 1),
                    provider: provider,
                    metadata: item.metadata || {}
                });
            }
        });

        const cleanList = Array.from(deduplicatedMap.values());

        // 2. Priority Ranking: Official > Educational > News > Coaching > Unknown > Forum
        const priorityScore = {
            official: 1,
            educational: 2,
            news: 3,
            coaching: 4,
            unknown: 5,
            forum: 6
        };

        cleanList.sort((a, b) => {
            const scoreA = priorityScore[a.sourceType] || 5;
            const scoreB = priorityScore[b.sourceType] || 5;
            if (scoreA !== scoreB) return scoreA - scoreB;
            return a.position - b.position;
        });

        const limit = options.num || parseInt(process.env.SEARCH_MAX_RESULTS || "10", 10);
        return cleanList.slice(0, limit);
    }

    /**
     * Clean tracking parameters from URL while preserving canonical path
     */
    static cleanUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== "string") return "";
        try {
            const parsed = new URL(rawUrl.trim());
            // Remove common tracking search params
            const trackingKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
            trackingKeys.forEach(k => parsed.searchParams.delete(k));
            return parsed.toString();
        } catch (e) {
            return rawUrl;
        }
    }
}
