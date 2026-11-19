import dotenv from "dotenv";
dotenv.config();

/**
 * Serper (Google Search) Secondary Search Provider Adapter
 * Official Endpoint: POST https://google.serper.dev/search
 * Documentation: https://google.serper.dev/
 */
export class SerperSearchService {
    static MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2MB maximum payload limit

    static getApiKey() {
        return process.env.SERPER_API_KEY || null;
    }

    static getSearchUrl() {
        const url = process.env.SERPER_SEARCH_URL || "https://google.serper.dev/search";
        return url.replace(/\/+$/, "");
    }

    static getTimeoutMs() {
        return parseInt(process.env.SEARCH_TIMEOUT_MS || "10000", 10);
    }

    /**
     * Check if Serper is configured with an API key
     */
    static isConfigured() {
        return Boolean(this.getApiKey());
    }

    /**
     * Sanitize log snippets to prevent credential or secret leaks
     */
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

    /**
     * Execute web search via Serper Google Search API
     */
    static async searchWeb(query, options = {}) {
        const apiKey = this.getApiKey();
        const searchUrl = this.getSearchUrl();
        const timeoutMs = this.getTimeoutMs();
        const numResults = options.num || parseInt(process.env.SEARCH_MAX_RESULTS || "10", 10);

        if (!apiKey) {
            return {
                success: false,
                provider: "serper",
                query,
                error: "SERPER_API_KEY not configured",
                isAuthError: true,
                isConfigError: true,
                results: []
            };
        }

        try {
            console.log(`[SerperSearchService] Executing Serper search for query: "${query}" -> (${searchUrl})`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const payload = {
                q: query,
                num: Math.min(Math.max(numResults, 1), 20),
                gl: options.gl || "in", // Google Search region: India
                hl: options.hl || "en"
            };

            const response = await fetch(searchUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-KEY": apiKey
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // Guard against unbounded payload sizes
            const contentLength = parseInt(response.headers?.get("content-length") || "0", 10);
            if (contentLength > this.MAX_PAYLOAD_BYTES) {
                throw new Error(`Serper response exceeded maximum payload limit (${this.MAX_PAYLOAD_BYTES} bytes)`);
            }

            if (!response.ok) {
                const status = response.status;
                const errBody = await response.text().catch(() => "");
                
                // Distinguish exact error categories
                const isAuthError = status === 401 || status === 403;
                const isInvalidRequest = status === 400;
                const isQuotaExhausted = status === 402 || 
                    (status === 429 && /credit|quota|balance/i.test(errBody)) ||
                    /not enough credits|credit limit|out of credits|insufficient credits/i.test(errBody);
                const isRateLimited = status === 429 && !isQuotaExhausted;
                const isServerError = status >= 500 && status <= 599;

                let logMsg = `Serper Search HTTP ${status}`;
                if (isQuotaExhausted) {
                    logMsg = `Serper Search quota exhausted (HTTP ${status})`;
                } else if (isRateLimited) {
                    logMsg = `Serper Search rate-limited (HTTP 429)`;
                } else if (isAuthError) {
                    logMsg = `Serper Search unauthorized/forbidden (HTTP ${status})`;
                } else if (isInvalidRequest) {
                    logMsg = `Serper Search invalid request (HTTP 400)`;
                } else if (isServerError) {
                    logMsg = `Serper Search server error (HTTP ${status})`;
                }

                console.error(`[SerperSearchService] ${logMsg}:`, this.sanitizeLogSnippet(errBody, apiKey));

                return {
                    success: false,
                    provider: "serper",
                    query,
                    status,
                    isQuotaExhausted,
                    isRateLimited,
                    isAuthError,
                    isInvalidRequest,
                    isServerError,
                    error: logMsg,
                    results: []
                };
            }

            const data = await response.json();
            const rawOrganic = Array.isArray(data.organic) ? data.organic.slice(0, 20) : [];
            const normalizedResults = this.normalizeResults(rawOrganic, numResults);

            console.log(`[SerperSearchService] Fetched ${normalizedResults.length} normalized results from Serper Search`);

            return {
                success: true,
                provider: "serper",
                query,
                results: normalizedResults,
                answerBox: data.answerBox || null,
                peopleAlsoAsk: data.peopleAlsoAsk || []
            };

        } catch (err) {
            const isTimeout = err.name === "AbortError";
            const errMsg = isTimeout
                ? `Serper search query timed out after ${timeoutMs}ms`
                : (err.message || "Network error communicating with Serper");

            console.error(`[SerperSearchService] Error during search:`, this.sanitizeLogSnippet(errMsg, apiKey));

            return {
                success: false,
                provider: "serper",
                query,
                isTimeout,
                isNetworkError: !isTimeout,
                error: errMsg,
                results: []
            };
        }
    }

    /**
     * Normalize Serper organic results into application-wide schema
     */
    static normalizeResults(rawItems, maxCount = 10) {
        if (!Array.isArray(rawItems)) return [];

        const validResults = [];
        const seenUrls = new Set();

        for (let idx = 0; idx < rawItems.length; idx++) {
            const item = rawItems[idx];
            if (!item || typeof item !== "object") continue;

            const rawUrl = item.link || item.url || "";
            const sanitizedUrl = this.sanitizeAndValidateUrl(rawUrl);
            if (!sanitizedUrl) continue;

            if (seenUrls.has(sanitizedUrl)) continue;
            seenUrls.add(sanitizedUrl);

            const domain = this.extractDomain(sanitizedUrl);
            const sourceType = this.classifySourceType(domain);

            validResults.push({
                title: item.title ? String(item.title).trim() : "Untitled Search Result",
                url: sanitizedUrl,
                domain: domain,
                snippet: item.snippet ? String(item.snippet).trim() : "",
                source: "serper",
                sourceType: sourceType,
                publishedDate: item.date || null,
                publishedAt: item.date || null,
                position: item.position || (validResults.length + 1),
                provider: "serper",
                metadata: {
                    sitelinks: Array.isArray(item.sitelinks) ? item.sitelinks : []
                }
            });

            if (validResults.length >= maxCount) break;
        }

        return validResults;
    }

    /**
     * URL sanitization and SSRF validation
     */
    static sanitizeAndValidateUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== "string") return null;

        try {
            const parsed = new URL(rawUrl.trim());
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

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

            if (isPrivateOrLoopback) return null;

            // Strip tracking query params
            const trackingKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
            trackingKeys.forEach(k => parsed.searchParams.delete(k));

            // Clean hash and trailing slash
            return parsed.href.split("#")[0].replace(/\/+$/, "");
        } catch (e) {
            return null;
        }
    }

    static extractDomain(urlStr) {
        try {
            const parsed = new URL(urlStr);
            return parsed.hostname.replace(/^www\./, "");
        } catch (e) {
            return "unknown";
        }
    }

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
}
