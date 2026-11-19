import dotenv from "dotenv";
dotenv.config();

/**
 * TinyFish Web Search & Content Fetch Provider
 * Official Search API: GET https://api.search.tinyfish.ai?query=<encoded-query>
 * Official Fetch API:  POST https://api.fetch.tinyfish.ai
 */
export class TinyfishSearchService {
    static MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2MB maximum payload limit

    static getApiKey() {
        return process.env.TINYFISH_API_KEY || null;
    }

    static sanitizeLogSnippet(text, secretToMask = null) {
        if (!text || typeof text !== "string") return "";
        let clean = text;
        if (secretToMask) {
            clean = clean.replaceAll(secretToMask, "[REDACTED]");
        }
        clean = clean
            .replace(/(?:key|token|auth|bearer|secret)[\s:=]+([a-z0-9_-]{8,})/gi, "key=[REDACTED]")
            .replace(/sk-[a-zA-Z0-9_-]+/g, "[REDACTED]");
        return clean.substring(0, 150);
    }

    static getSearchUrl() {
        const url = process.env.TINYFISH_SEARCH_URL || "https://api.search.tinyfish.ai";
        return url.replace(/\/+$/, "");
    }

    static getFetchUrl() {
        const url = process.env.TINYFISH_FETCH_URL || "https://api.fetch.tinyfish.ai";
        return url.replace(/\/+$/, "");
    }

    static getSearchTimeoutMs() {
        return parseInt(process.env.SEARCH_TIMEOUT_MS || "10000", 10);
    }

    static getFetchTimeoutMs() {
        return parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);
    }

    static getMaxFetchUrls() {
        return parseInt(process.env.LIVE_UPDATES_MAX_FETCH_URLS || "8", 10);
    }

    /**
     * Execute web search via TinyFish Search API
     */
    static async searchWeb(query, options = {}) {
        const apiKey = this.getApiKey();
        const searchUrl = this.getSearchUrl();
        const timeoutMs = this.getSearchTimeoutMs();
        const numResults = options.num || parseInt(process.env.SEARCH_MAX_RESULTS || "10", 10);

        if (!apiKey) {
            console.warn("[TinyfishSearchService] TINYFISH_API_KEY is not configured in environment");
            return {
                success: false,
                provider: "tinyfish",
                query,
                status: null,
                isQuotaExhausted: false,
                isRateLimited: false,
                isServerError: false,
                isInvalidInput: false,
                isTimeout: false,
                isNetworkError: false,
                isConfigError: true,
                error: "TINYFISH_API_KEY not configured",
                results: []
            };
        }

        try {
            console.log(`[TinyfishSearchService] Search query: "${query}" -> (${searchUrl})`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const requestUrl = `${searchUrl}?query=${encodeURIComponent(query)}`;
            const headers = {
                "X-API-Key": apiKey
            };

            const response = await fetch(requestUrl, {
                method: "GET",
                headers: headers,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // Guard against unbounded payload sizes
            const contentLength = parseInt(response.headers?.get("content-length") || "0", 10);
            if (contentLength > this.MAX_PAYLOAD_BYTES) {
                throw new Error(`TinyFish response exceeded maximum payload limit (${this.MAX_PAYLOAD_BYTES} bytes)`);
            }

            if (!response.ok) {
                const status = response.status;
                const errText = await response.text().catch(() => "");
                
                const isQuotaExhausted = status === 402 || 
                    /INSUFFICIENT_CREDITS|FREE_ALLOWANCE_EXHAUSTED|quota exceeded|out of credits|wallet balance/i.test(errText) ||
                    (status === 429 && /quota|credit/i.test(errText));
                const isRateLimited = status === 429 && !isQuotaExhausted;
                const isServerError = status >= 500 && status <= 599;
                const isInvalidInput = status === 400 || /INVALID_INPUT/i.test(errText);

                let logMsg = `TinyFish Search HTTP ${status}`;
                if (isQuotaExhausted) {
                    logMsg = `TinyFish Search quota exhausted (HTTP ${status})`;
                } else if (isRateLimited) {
                    logMsg = `TinyFish Search rate-limited (HTTP 429)`;
                } else if (isServerError) {
                    logMsg = `TinyFish Search server error (HTTP ${status})`;
                } else if (isInvalidInput) {
                    logMsg = `TinyFish Search invalid input (HTTP 400)`;
                }

                console.error(`[TinyfishSearchService] ${logMsg}:`, this.sanitizeLogSnippet(errText, apiKey));
                return {
                    success: false,
                    provider: "tinyfish",
                    query,
                    status,
                    isQuotaExhausted,
                    isRateLimited,
                    isServerError,
                    isInvalidInput,
                    isTimeout: false,
                    isNetworkError: false,
                    isConfigError: status === 401,
                    error: logMsg,
                    results: []
                };
            }

            const data = await response.json();
            const rawResults = data.results || data.data || data.organic || (Array.isArray(data) ? data : []);
            const safeRawResults = Array.isArray(rawResults) ? rawResults.slice(0, 20) : [];
            const normalizedResults = this.normalizeResults(safeRawResults, numResults);

            console.log(`[TinyfishSearchService] Fetched ${normalizedResults.length} normalized results from TinyFish Search`);

            return {
                success: true,
                provider: "tinyfish",
                query,
                results: normalizedResults
            };

        } catch (err) {
            const isTimeout = err.name === "AbortError";
            const errMsg = isTimeout ? `TinyFish search query timed out after ${timeoutMs}ms` : (err.message || "Network error communicating with TinyFish");
            console.error(`[TinyfishSearchService] Error during search:`, this.sanitizeLogSnippet(errMsg, apiKey));

            return {
                success: false,
                provider: "tinyfish",
                query,
                status: null,
                isQuotaExhausted: false,
                isRateLimited: false,
                isServerError: false,
                isInvalidInput: false,
                isTimeout,
                isNetworkError: !isTimeout,
                error: errMsg,
                results: []
            };
        }
    }

    /**
     * Fetch clean content for a list of URLs via TinyFish Fetch API (with fallback handling per URL)
     */
    static async fetchWebPages(urls, options = {}) {
        if (!Array.isArray(urls) || urls.length === 0) return [];

        const apiKey = this.getApiKey();
        const fetchUrl = this.getFetchUrl();
        const timeoutMs = this.getFetchTimeoutMs();
        const maxUrls = options.maxUrls || this.getMaxFetchUrls();
        const maxChars = options.maxChars || 2500;

        // 1. Sanitize & Deduplicate input URLs
        const validUrls = [];
        const seenMap = new Set();

        for (const raw of urls) {
            if (!raw || typeof raw !== "string") continue;
            try {
                const parsed = new URL(raw);
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;

                // SSRF check: Block loopbacks, private networks, cloud metadata IPs
                const hostname = parsed.hostname.toLowerCase();
                const isPrivateOrLoopback = 
                    hostname === "localhost" ||
                    hostname === "127.0.0.1" ||
                    hostname === "0.0.0.0" ||
                    hostname === "::" ||
                    hostname === "::1" ||
                    hostname.endsWith(".localhost") ||
                    hostname.endsWith(".local") ||
                    hostname.endsWith(".internal") ||
                    /^10\./.test(hostname) ||
                    /^192\.168\./.test(hostname) ||
                    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
                    /^169\.254\./.test(hostname) ||
                    /^127\./.test(hostname) ||
                    /^0\./.test(hostname) ||
                    /^\d+$/.test(hostname) ||
                    /^0x[0-9a-f]+$/i.test(hostname);

                if (isPrivateOrLoopback) continue;

                // Normalize URL
                const clean = parsed.href.split("#")[0].replace(/\/+$/, "");
                if (!seenMap.has(clean)) {
                    seenMap.add(clean);
                    validUrls.push(clean);
                }
            } catch (e) {
                // Invalid URL string
            }
        }

        const selectedUrls = validUrls.slice(0, maxUrls);
        if (selectedUrls.length === 0) return [];

        console.log(`[TinyfishSearchService] Fetching clean content for ${selectedUrls.length} URLs via TinyFish Fetch API...`);

        // If TinyFish API key is available, call POST https://api.fetch.tinyfish.ai
        if (apiKey) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                const response = await fetch(fetchUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-Key": apiKey
                    },
                    body: JSON.stringify({ urls: selectedUrls }),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (response && response.ok) {
                    const data = await response.json().catch(() => null);
                    if (data) {
                        const items = Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : [data]);
                        const fetchedMap = new Map();

                        items.forEach((item) => {
                            const itemUrl = item.url || item.link;
                            const text = this.cleanAndValidateText(
                                item.text || item.markdown || item.content || item.html || "",
                                maxChars
                            );
                            if (itemUrl && text) {
                                fetchedMap.set(itemUrl, text);
                            }
                        });

                        // Return results array in order
                        const results = selectedUrls.map((u) => ({
                            url: u,
                            content: fetchedMap.get(u) || null,
                            success: Boolean(fetchedMap.get(u))
                        }));

                        const successCount = results.filter(r => r.success).length;
                        console.log(`[TinyfishSearchService] Fetch API completed: ${successCount}/${selectedUrls.length} URLs successful`);
                        return results;
                    }
                } else {
                    const status = response ? response.status : "No response";
                    console.warn(`[TinyfishSearchService] Fetch API returned HTTP ${status}. Falling back to per-URL direct fetch...`);
                }
            } catch (err) {
                console.warn(`[TinyfishSearchService] Fetch API batch request failed: ${err.message}. Falling back to per-URL direct fetch...`);
            }
        }

        // Fallback or per-URL direct fetch handling if batch Fetch API is unavailable or fails
        const perUrlPromises = selectedUrls.map(async (urlStr) => {
            const text = await this.fetchSingleWebPageDirect(urlStr, { maxChars, timeoutMs });
            return {
                url: urlStr,
                content: text,
                success: Boolean(text)
            };
        });

        const results = await Promise.all(perUrlPromises);
        const successCount = results.filter(r => r.success).length;
        console.log(`[TinyfishSearchService] Direct fetch completed: ${successCount}/${selectedUrls.length} URLs successful`);
        return results;
    }

    /**
     * Single URL fetch wrapper
     */
    static async fetchWebPage(urlStr, options = {}) {
        const results = await this.fetchWebPages([urlStr], options);
        return results[0]?.content || null;
    }

    /**
     * Helper for fetching single web page directly with HTML stripping & validation
     */
    static async fetchSingleWebPageDirect(urlStr, { maxChars = 2500, timeoutMs = 10000 } = {}) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(urlStr, {
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,text/plain"
                },
                signal: controller.signal
            }).catch(() => null);

            clearTimeout(timeoutId);

            if (!response || !response.ok) return null;

            const rawText = await response.text().catch(() => "");
            return this.cleanAndValidateText(rawText, maxChars);
        } catch (e) {
            return null;
        }
    }

    /**
     * Validate & clean fetched webpage content
     */
    static cleanAndValidateText(rawText, maxChars = 2500) {
        if (!rawText || typeof rawText !== "string") return null;

        let text = rawText;
        if (text.trim().startsWith("{")) {
            try {
                const parsed = JSON.parse(text);
                const first = Array.isArray(parsed.results) ? parsed.results[0] : parsed;
                text = first?.text || first?.markdown || first?.content || first?.html || parsed.text || parsed.content || text;
            } catch (e) {}
        }

        // Strip HTML & script/style tags
        text = text
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/\s+/g, " ")
            .trim();

        // Check if content is meaningful (not generic error page or empty)
        if (text.length < 50) return null;

        const lower = text.toLowerCase();
        if (
            lower.includes("404 not found") ||
            lower.includes("access denied") ||
            lower.includes("403 forbidden") ||
            lower.includes("enable javascript to continue") ||
            lower.includes("page you requested could not be found")
        ) {
            return null;
        }

        return text.substring(0, maxChars);
    }

    /**
     * Normalize TinyFish raw search results into standard application schema
     */
    static normalizeResults(rawItems, maxCount = 10) {
        if (!Array.isArray(rawItems)) return [];

        const results = [];
        for (let idx = 0; idx < rawItems.length; idx++) {
            const item = rawItems[idx];
            if (!item || typeof item !== "object") continue;

            const urlStr = item.url || item.link || "";
            const domain = this.extractDomain(urlStr);

            results.push({
                title: item.title || "Untitled Search Result",
                url: urlStr,
                domain: domain,
                snippet: item.snippet || item.content || item.description || "",
                source: "tinyfish",
                sourceType: item.sourceType || null,
                publishedDate: item.publishedDate || item.date || item.published_date || null,
                publishedAt: item.publishedDate || item.date || item.published_date || null,
                position: item.position || (idx + 1),
                provider: "tinyfish",
                metadata: item.metadata || {}
            });

            if (results.length >= maxCount) break;
        }

        return results;
    }

    static extractDomain(urlStr) {
        try {
            const parsed = new URL(urlStr);
            return parsed.hostname.replace(/^www\./, "");
        } catch (e) {
            return "unknown";
        }
    }
}


