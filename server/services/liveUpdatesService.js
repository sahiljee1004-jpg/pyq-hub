import dotenv from "dotenv";
import { CacheService } from "./cacheService.js";
import { ExamDiscoveryService } from "./examDiscoveryService.js";
import { DeduplicationService } from "./deduplicationService.js";
import { SearchService } from "./searchService.js";
import { GroqService } from "./groqService.js";
import { LIVE_UPDATES_SYSTEM_PROMPT } from "../prompts/liveUpdatesPrompt.js";

dotenv.config();

/**
 * Main Live Updates Orchestration Service
 * Production Architecture: TinyFish Search (Discovery) -> TinyFish Fetch (Source Content) -> Groq (Summarization)
 */
export class LiveUpdatesService {
    static pendingRequestsMap = new Map();
    static pendingSearchQueriesMap = new Map();
    static lastKnownGoodPayload = null;

    /**
     * Get General Live Exam Updates Feed (with shared cache, single-flight refresh, TinyFish Search, TinyFish Fetch, Groq, Last-Known-Good fallback)
     */
    static async getLiveUpdates({ forceRefresh = false, category = "ALL", clientId = "anonymous" } = {}) {
        const cacheKey = "live_updates:feed:ALL";

        // 1. Check Shared Server-Side Cache unless forceRefresh is requested
        if (!forceRefresh) {
            const cachedData = CacheService.get(cacheKey);
            if (cachedData) {
                console.log("[LiveUpdates] Cache HIT");
                return {
                    success: true,
                    cached: true,
                    lastUpdated: cachedData.lastUpdated,
                    generatedAt: cachedData.generatedAt,
                    updates: this.filterByCategory(cachedData.updates, category)
                };
            }
        }

        console.log("[LiveUpdates] Cache MISS");

        // 2. Rate Limit Guard for Forced Refresh
        if (forceRefresh) {
            const check = CacheService.canClientRefresh(clientId);
            if (!check.allowed) {
                console.log(`[LiveUpdatesService] Forced refresh rate-limited for ${clientId}.`);
                const cached = CacheService.get(cacheKey) || this.lastKnownGoodPayload;
                if (cached) {
                    return {
                        ...cached,
                        success: true,
                        cached: true,
                        rateLimited: true,
                        retryAfterSeconds: check.waitSecs,
                        rateLimitMessage: check.message,
                        message: check.message,
                        updates: this.filterByCategory(cached.updates, category)
                    };
                }
            }
        }

        // 3. Single-Flight Concurrency Lock (Converge simultaneous requests onto one refresh)
        if (this.pendingRequestsMap.has(cacheKey)) {
            console.log(`[LiveUpdates] Single-flight lock active. Converging request onto existing refresh...`);
            try {
                const pendingResult = await this.pendingRequestsMap.get(cacheKey);
                return {
                    ...pendingResult,
                    updates: this.filterByCategory(pendingResult.updates, category)
                };
            } catch (err) {
                // Fallthrough if in-flight request fails
            }
        }

        console.log("[LiveUpdates] Refresh started");

        const refreshPromise = (async () => {
            try {
                // Step 1: TinyFish Multi-Family Search Discovery
                const maxSearchQueries = parseInt(process.env.LIVE_UPDATES_MAX_SEARCHES || "20", 10);
                const queryCountToRun = Math.min(6, maxSearchQueries);

                const rawSources = await ExamDiscoveryService.executeBroadDiscovery(queryCountToRun);
                console.log(`[LiveUpdates] Search queries: ${queryCountToRun}`);
                console.log(`[LiveUpdates] Search results: ${rawSources.length}`);

                if (!rawSources || rawSources.length === 0) {
                    console.warn("[LiveUpdates] Search returned 0 results");
                    const staleFeed = CacheService.getStale(cacheKey) || this.lastKnownGoodPayload;
                    if (staleFeed) {
                        console.log("[LiveUpdates] Using stale/last-known-good cache");
                        return {
                            ...staleFeed,
                            cached: true,
                            stale: true
                        };
                    }
                    return {
                        success: true,
                        cached: false,
                        lastUpdated: new Date().toISOString(),
                        generatedAt: new Date().toISOString(),
                        updates: [],
                        message: "No recent or currently active exam updates were found."
                    };
                }

                // Step 2: Deduplicate & Prioritize Official Level 1/2 Sources
                const cleanSources = DeduplicationService.deduplicateRawSources(rawSources);
                console.log(`[LiveUpdates] Unique URLs: ${cleanSources.length}`);

                // Step 3: Select top URLs for TinyFish Fetch API
                const maxFetchUrls = parseInt(process.env.LIVE_UPDATES_MAX_FETCH_URLS || "8", 10);
                const urlsToFetch = cleanSources
                    .filter(s => s.url && s.url.startsWith("http"))
                    .slice(0, maxFetchUrls)
                    .map(s => s.url);

                console.log(`[LiveUpdates] URLs selected for fetch: ${urlsToFetch.length}`);

                if (urlsToFetch.length > 0) {
                    const fetchResults = await SearchService.fetchWebPages(urlsToFetch, {
                        maxUrls: maxFetchUrls,
                        maxChars: 1500
                    });

                    const fetchMap = new Map();
                    let successCount = 0;
                    fetchResults.forEach((res) => {
                        if (res.success && res.content) {
                            fetchMap.set(res.url, res.content);
                            successCount++;
                        }
                    });

                    console.log(`[LiveUpdates] Fetch success: ${successCount}/${urlsToFetch.length}`);

                    // Augment source snippets with clean page content
                    cleanSources.forEach((src) => {
                        const fetchedText = fetchMap.get(src.url);
                        if (fetchedText) {
                            src.snippet += "\n\nVerified Clean Source Content:\n" + fetchedText;
                        }
                    });
                } else {
                    console.log(`[LiveUpdates] Fetch success: 0/0`);
                }

                // Step 4: Groq AI Summarization & Structured JSON Generation
                console.log("[LiveUpdates] Groq summarization started");
                const structuredUpdates = await this.generateStructuredUpdatesWithGroq(cleanSources, "general live updates");

                // Step 5: Final Deduplication & Ranking
                const deduplicatedUpdates = DeduplicationService.deduplicateFinalUpdates(structuredUpdates);
                const rankedUpdates = this.rankUpdates(deduplicatedUpdates);

                const responsePayload = {
                    success: true,
                    cached: false,
                    lastUpdated: new Date().toISOString(),
                    generatedAt: new Date().toISOString(),
                    updates: rankedUpdates
                };

                // Store in Shared Server Cache (20 minutes TTL)
                CacheService.set(cacheKey, responsePayload);

                // Update Last-Known-Good Cache
                if (rankedUpdates.length > 0) {
                    this.lastKnownGoodPayload = responsePayload;
                }

                console.log("[LiveUpdates] Refresh successful");
                console.log("[LiveUpdates] Cache updated");

                return responsePayload;

            } catch (err) {
                console.error("[LiveUpdates] Refresh failed:", err.message);
                const staleFeed = CacheService.getStale(cacheKey) || this.lastKnownGoodPayload;
                if (staleFeed) {
                    console.log("[LiveUpdates] Using stale/last-known-good cache");
                    return {
                        ...staleFeed,
                        cached: true,
                        stale: true
                    };
                }
                throw err;
            }
        })();

        this.pendingRequestsMap.set(cacheKey, refreshPromise);

        try {
            const responsePayload = await refreshPromise;
            return {
                ...responsePayload,
                updates: this.filterByCategory(responsePayload.updates, category)
            };
        } catch (err) {
            const staleFeed = CacheService.getStale(cacheKey) || this.lastKnownGoodPayload;
            if (staleFeed) {
                return {
                    ...staleFeed,
                    cached: true,
                    stale: true,
                    updates: this.filterByCategory(staleFeed.updates, category)
                };
            }
            return {
                success: false,
                error: "Unable to refresh live updates right now. Please try again.",
                updates: []
            };
        } finally {
            this.pendingRequestsMap.delete(cacheKey);
        }
    }

    /**
     * Search Live Updates by specific query (e.g. "GATE 2027" or "JEE Main registration last date")
     */
    static async searchLiveUpdates(query, { category = "ALL" } = {}) {
        if (!query || typeof query !== "string" || !query.trim()) {
            return {
                success: false,
                error: "Search query cannot be empty",
                updates: []
            };
        }

        const normalizedQuery = query.trim().toLowerCase();
        const cacheKey = `live_updates:search:${normalizedQuery.replace(/\s+/g, "_")}`;

        // 1. Check Fresh Query Cache
        const cached = CacheService.get(cacheKey);
        if (cached) {
            console.log(`[LiveUpdates] Search Cache HIT for query: "${query}"`);
            return {
                ...cached,
                cached: true,
                updates: this.filterByCategory(cached.updates, category)
            };
        }

        // 2. Single-Flight Concurrency Guard for identical simultaneous queries
        if (this.pendingSearchQueriesMap.has(cacheKey)) {
            console.log(`[LiveUpdates] Single-flight lock active for query: "${query}". Converging...`);
            try {
                const pendingResult = await this.pendingSearchQueriesMap.get(cacheKey);
                return {
                    ...pendingResult,
                    updates: this.filterByCategory(pendingResult.updates, category)
                };
            } catch (err) {
                // Fallthrough on failure
            }
        }

        console.log(`[LiveUpdates] Executing live updates search for query: "${query}"`);

        const searchPromise = (async () => {
            try {
                // Step 1: Execute Targeted Web Search (TinyFish primary with Serper fallback)
                const rawSources = await ExamDiscoveryService.executeTargetedSearch(query);

                if (!rawSources || rawSources.length === 0) {
                    // Check if stale cached results exist specifically for THIS query
                    const stale = CacheService.getStale(cacheKey);
                    if (stale) {
                        console.log(`[LiveUpdates] Search returned 0 items. Returning query-specific stale cache for: "${query}"`);
                        return {
                            ...stale,
                            cached: true,
                            stale: true,
                            query
                        };
                    }

                    return {
                        success: true,
                        query,
                        cached: false,
                        lastUpdated: new Date().toISOString(),
                        updates: [],
                        message: `No active or recent updates found for "${query}".`
                    };
                }

                // Step 2: Deduplicate Sources
                const cleanSources = DeduplicationService.deduplicateRawSources(rawSources);

                // Step 3: TinyFish Fetch for top sources
                const maxFetchUrls = parseInt(process.env.LIVE_UPDATES_MAX_FETCH_URLS || "8", 10);
                const urlsToFetch = cleanSources
                    .filter(s => s.url && s.url.startsWith("http"))
                    .slice(0, Math.min(3, maxFetchUrls))
                    .map(s => s.url);

                if (urlsToFetch.length > 0) {
                    const fetchResults = await SearchService.fetchWebPages(urlsToFetch, { maxChars: 1500 });
                    const fetchMap = new Map();
                    fetchResults.forEach((res) => {
                        if (res.success && res.content) fetchMap.set(res.url, res.content);
                    });
                    cleanSources.forEach((src) => {
                        const text = fetchMap.get(src.url);
                        if (text) src.snippet += "\n\nVerified Clean Source Content:\n" + text;
                    });
                }

                // Step 4: Groq JSON Generation
                const structuredUpdates = await this.generateStructuredUpdatesWithGroq(cleanSources, query);

                // Step 5: Final Deduplication & Ranking
                const deduplicated = DeduplicationService.deduplicateFinalUpdates(structuredUpdates);
                const ranked = this.rankUpdates(deduplicated);

                const resultPayload = {
                    success: true,
                    query,
                    cached: false,
                    lastUpdated: new Date().toISOString(),
                    updates: ranked
                };

                CacheService.set(cacheKey, resultPayload, 15); // Search query cache 15 mins

                return resultPayload;

            } catch (err) {
                console.error(`[LiveUpdates] Search failed for "${query}":`, err.message);

                // Query-specific stale cache fallback (isolated to this exact query)
                const stale = CacheService.getStale(cacheKey);
                if (stale) {
                    console.log(`[LiveUpdates] Gracefully returning query-specific stale cache for: "${query}"`);
                    return {
                        ...stale,
                        cached: true,
                        stale: true,
                        query
                    };
                }

                return {
                    success: false,
                    query,
                    error: "Search temporarily unavailable. Please try again shortly.",
                    updates: []
                };
            }
        })();

        this.pendingSearchQueriesMap.set(cacheKey, searchPromise);

        try {
            const finalResult = await searchPromise;
            return {
                ...finalResult,
                updates: this.filterByCategory(finalResult.updates, category)
            };
        } finally {
            this.pendingSearchQueriesMap.delete(cacheKey);
        }
    }

    /**
     * Send search evidence to Groq and parse structured JSON updates array
     */
    static async generateStructuredUpdatesWithGroq(sources, contextQuery) {
        const apiKey = GroqService.getApiKey();
        if (!apiKey) {
            console.warn("[LiveUpdatesService] Groq API Key missing. Falling back to basic search objects.");
            return this.buildFallbackUpdatesFromSources(sources);
        }

        // Limit evidence items to top 8 to stay well within token limits
        const safeSources = sources.slice(0, 8);

        let userPrompt = `Context Query: "${contextQuery}"\n\nRetrieved Web Search Evidence:\n`;
        safeSources.forEach((item, idx) => {
            userPrompt += `[Evidence Item ${idx + 1}]:\n`;
            userPrompt += `Title: ${item.title}\n`;
            userPrompt += `URL: ${item.url} (Domain: ${item.domain}, Type: ${item.sourceType})\n`;
            userPrompt += `Published Date: ${item.publicationDate || item.publishedAt || "Unknown"}\n`;
            userPrompt += `Content Snippet: ${item.snippet}\n\n`;
        });
        userPrompt += `Extract all valid, recent or currently active examination announcements from the above evidence. Output a valid JSON object with an "updates" array matching the requested schema strictly.`;

        try {
            const baseUrl = GroqService.getBaseUrl();
            const endpoint = `${baseUrl}/chat/completions`;
            const model = GroqService.getModel();

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout

            const requestBody = {
                model: model,
                messages: [
                    { role: "system", content: LIVE_UPDATES_SYSTEM_PROMPT },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.1,
                max_tokens: 2500
            };

            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errBody = await response.text();
                console.error(`[LiveUpdatesService] Groq returned HTTP ${response.status}:`, errBody.substring(0, 200));
                return this.buildFallbackUpdatesFromSources(sources);
            }

            const data = await response.json();
            const rawContent = data.choices && data.choices[0] && data.choices[0].message
                ? data.choices[0].message.content
                : null;

            if (!rawContent) {
                return this.buildFallbackUpdatesFromSources(sources);
            }

            // Parse JSON response safely
            let parsed = null;
            try {
                parsed = JSON.parse(rawContent);
            } catch (e) {
                // Controlled recovery attempt for JSON substring
                const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try { parsed = JSON.parse(jsonMatch[0]); } catch (e2) {}
                }
            }

            if (parsed && Array.isArray(parsed.updates)) {
                return parsed.updates.map((item, index) => this.normalizeUpdateObject(item, sources, index));
            }

            return this.buildFallbackUpdatesFromSources(sources);

        } catch (err) {
            console.error("[LiveUpdatesService] Exception during Groq update generation:", err.message);
            return this.buildFallbackUpdatesFromSources(sources);
        }
    }

    /**
     * Normalize Groq update object fields to guarantee API contract stability
     */
    static normalizeUpdateObject(item, originalSources, index) {
        let matchedSource = originalSources.find((s) => s.url === item.source?.url) || originalSources[0] || {};

        const examName = item.examName || "Competitive Exam Notification";
        const idBase = (examName + "_" + (item.updateType || "INFO") + "_" + index).toLowerCase().replace(/[^\w]/g, "_");

        return {
            id: item.id || idBase,
            examName: examName,
            category: (item.category || "OTHER").toUpperCase(),
            updateType: (item.updateType || "IMPORTANT_NOTIFICATION").toUpperCase(),
            title: item.title || `${examName} Latest Announcement`,
            summary: item.summary || "Latest examination notification released. Visit the official portal for full details.",
            importantDate: item.importantDate || null,
            status: item.status || "active",
            publishedAt: item.publishedAt || matchedSource.publicationDate || matchedSource.publishedAt || new Date().toISOString().split("T")[0],
            source: {
                title: item.source?.title || matchedSource.title || "Official Examination Portal",
                url: item.source?.url || matchedSource.url || "#",
                domain: item.source?.domain || matchedSource.domain || "official",
                type: item.source?.type || matchedSource.sourceType || "official"
            }
        };
    }

    /**
     * Fallback update object builder when Groq fails or is unconfigured
     */
    static buildFallbackUpdatesFromSources(sources) {
        return sources.slice(0, 8).map((s, idx) => {
            const domain = s.domain || "official";
            return {
                id: `update_fallback_${idx}`,
                examName: s.title ? s.title.split("-")[0].trim() : "Exam Notification",
                category: "OTHER",
                updateType: "IMPORTANT_NOTIFICATION",
                title: s.title || "Exam Notification",
                summary: s.snippet || "Latest examination update retrieved from source.",
                importantDate: null,
                status: "active",
                publishedAt: s.publicationDate || s.publishedAt || new Date().toISOString().split("T")[0],
                source: {
                    title: s.title || "Official Source",
                    url: s.url || "#",
                    domain: domain,
                    type: s.sourceType || "official"
                }
            };
        });
    }

    /**
     * Rank updates by Active Status > Recency > Official Priority > Deadline Proximity
     */
    static rankUpdates(updates) {
        if (!Array.isArray(updates)) return [];

        const statusWeight = {
            closing_soon: 10,
            active: 9,
            new: 8,
            upcoming: 7,
            informational: 5,
            completed: 1
        };

        const updateTypeWeight = {
            APPLICATION_DEADLINE: 10,
            REGISTRATION_CLOSING: 9,
            REGISTRATION_OPEN: 8,
            APPLICATION_CORRECTION: 8,
            ADMIT_CARD: 7,
            EXAM_DATE: 7,
            RESULT: 7,
            ANSWER_KEY: 6,
            COUNSELLING: 6,
            EXAM_POSTPONED: 6,
            IMPORTANT_NOTIFICATION: 5
        };

        return [...updates].sort((a, b) => {
            const weightA = (statusWeight[a.status] || 5) + (updateTypeWeight[a.updateType] || 5) + (a.source?.type === "official" ? 3 : 0);
            const weightB = (statusWeight[b.status] || 5) + (updateTypeWeight[b.updateType] || 5) + (b.source?.type === "official" ? 3 : 0);
            return weightB - weightA;
        });
    }

    /**
     * Filter updates by category chip
     */
    static filterByCategory(updates, category) {
        if (!category || category.toUpperCase() === "ALL") {
            return updates;
        }

        const catUpper = category.toUpperCase();
        return updates.filter((u) => {
            if (u.category && u.category.toUpperCase() === catUpper) return true;

            if (catUpper === "ENGINEERING" && (u.examName.includes("JEE") || u.examName.includes("GATE") || u.examName.includes("BITSAT"))) return true;
            if (catUpper === "MEDICAL" && (u.examName.includes("NEET") || u.examName.includes("AIIMS") || u.examName.includes("INICET"))) return true;
            if (catUpper === "GOVERNMENT" && (u.examName.includes("UPSC") || u.examName.includes("SSC") || u.examName.includes("PSC"))) return true;
            if (catUpper === "RECRUITMENT" && (u.examName.includes("SSC") || u.examName.includes("RRB") || u.examName.includes("IBPS") || u.examName.includes("SBI"))) return true;
            if (catUpper === "UNIVERSITY" && (u.examName.includes("CUET") || u.examName.includes("DU") || u.examName.includes("JNU"))) return true;

            return false;
        });
    }
}

