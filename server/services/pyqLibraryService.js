import dotenv from "dotenv";
import { getFirestoreServerAuthHeaders, getFirestoreBaseUrl, validateProjectIdFormat } from "./firebaseTokenService.js";
import { PaperSearchService } from "./paperSearchService.js";

dotenv.config();

function getActiveProjectId(explicitProjectId = null) {
    const raw = explicitProjectId || process.env.FIREBASE_PROJECT_ID;
    if (!raw || typeof raw !== "string" || !raw.trim()) {
        throw new Error("[PyqLibraryService] FIREBASE_PROJECT_ID is not configured and no explicit projectId was provided. Rejecting operation to prevent ambient production fallback.");
    }
    return validateProjectIdFormat(raw.trim(), "projectId");
}

// In-Memory Caches for High-Performance & Firestore Quota Protection
let cachedTotalPapers = null;
let lastCountFetchTime = 0;
const COUNT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

let cachedRecentPapers = null;
let lastRecentFetchTime = 0;
const RECENT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

const searchResultsCache = new Map(); // query -> { data, timestamp }
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

let cachedAvailableExams = null;
let lastAvailableExamsFetchTime = 0;
const EXAMS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

const examYearsCache = new Map(); // examId -> { data, timestamp }
const EXAM_YEARS_CACHE_TTL_MS = 10 * 60 * 1000;

const papersByYearCache = new Map(); // `${examId}:${yearId}` -> { papers, timestamp }
const PAPERS_BY_YEAR_CACHE_TTL_MS = 10 * 60 * 1000;

function parseSafeTimestamp(raw) {
    if (!raw || typeof raw !== "string") return 0;
    const t = new Date(raw).getTime();
    return isNaN(t) ? 0 : t;
}

function sanitizeCursorNumber(val, defaultVal = 0, maxVal = 10000) {
    const n = parseInt(val, 10);
    if (isNaN(n) || n < 0) return defaultVal;
    return Math.min(n, maxVal);
}

// Allowed Storage Domains
const ALLOWED_STORAGE_HOSTS = [
    "res.cloudinary.com",
    "firebasestorage.googleapis.com"
];

/**
 * Check if a hostname belongs to an authorized storage provider
 */
export function isAllowedStorageHost(hostname) {
    const cleanHost = String(hostname || "").toLowerCase().trim();
    if (ALLOWED_STORAGE_HOSTS.includes(cleanHost)) return true;
    if (cleanHost.endsWith(".firebasestorage.googleapis.com")) return true;
    return false;
}

/**
 * Check if an IP or host is private, loopback, or link-local (SSRF protection)
 */
export function isPrivateIp(ipOrHost) {
    const host = String(ipOrHost || "").toLowerCase().trim();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;

    // IPv4 check
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = host.match(ipv4Regex);
    if (match) {
        const octet1 = parseInt(match[1], 10);
        const octet2 = parseInt(match[2], 10);
        if (octet1 === 127) return true; // 127.0.0.0/8 loopback
        if (octet1 === 10) return true;  // 10.0.0.0/8 private
        if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return true; // 172.16.0.0/12
        if (octet1 === 192 && octet2 === 168) return true; // 192.168.0.0/16
        if (octet1 === 169 && octet2 === 254) return true; // 169.254.0.0/16 link-local/cloud metadata
        if (octet1 === 0) return true;
    }

    // IPv6 check
    if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd") || host.includes("::1")) {
        return true;
    }
    return false;
}

/**
 * Validate storage URL against SSRF, unauthorized providers, and protocol restrictions
 */
export function validateStorageUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
        throw new Error("Invalid storage URL provided");
    }
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error("Malformed storage URL");
    }

    if (parsed.protocol !== "https:") {
        throw new Error("Insecure storage protocol: HTTPS is strictly required");
    }

    const host = parsed.hostname.toLowerCase();
    if (isPrivateIp(host)) {
        throw new Error(`Access to private or link-local network address (${host}) is blocked`);
    }

    if (!isAllowedStorageHost(host)) {
        throw new Error(`Unauthorized storage domain (${host}). Only authorized storage providers are permitted.`);
    }

    return parsed.href;
}

export class PyqLibraryService {

    // Cache Invalidation Hooks
    static invalidateCountCache() {
        cachedTotalPapers = null;
        lastCountFetchTime = 0;
    }

    static invalidateSearchCache() {
        searchResultsCache.clear();
    }

    static invalidateRecentCache() {
        cachedRecentPapers = null;
        lastRecentFetchTime = 0;
    }

    static invalidateAvailableExamsCache() {
        cachedAvailableExams = null;
        lastAvailableExamsFetchTime = 0;
        examYearsCache.clear();
        papersByYearCache.clear();
    }

    static invalidateAllCaches() {
        this.invalidateCountCache();
        this.invalidateSearchCache();
        this.invalidateRecentCache();
        this.invalidateAvailableExamsCache();
    }

    /**
     * Retrieve all examinations for which question papers actually exist in Firestore.
     * Examinations with zero available papers are strictly excluded.
     */
    static async getAvailableExams(forceRefresh = false, options = {}) {
        const opts = typeof forceRefresh === "object" && forceRefresh !== null ? forceRefresh : options;
        const shouldForceRefresh = typeof forceRefresh === "boolean" ? forceRefresh : !!opts.forceRefresh;
        const projectId = getActiveProjectId(opts.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);

        const now = Date.now();
        if (!shouldForceRefresh && cachedAvailableExams && (now - lastAvailableExamsFetchTime < EXAMS_CACHE_TTL_MS)) {
            return {
                success: true,
                count: cachedAvailableExams.length,
                exams: cachedAvailableExams,
                cached: true,
                cachedAt: new Date(lastAvailableExamsFetchTime).toISOString()
            };
        }

        try {
            const allExams = await PaperSearchService.fetchExamsFromFirestore({ projectId });
            const validExams = [];

            for (const exam of allExams) {
                try {
                    const yearsUrl = `${baseUrl}/exams/${encodeURIComponent(exam.id)}/years`;
                    const yRes = await fetch(yearsUrl);
                    if (!yRes.ok) continue;

                    const yData = await yRes.json();
                    const yearDocs = yData.documents || [];
                    const years = yearDocs.map(d => d.name.split("/").pop());

                    let totalExamPapers = 0;
                    const yearsWithPapers = [];

                    for (const yearId of years) {
                        try {
                            const papersUrl = `${baseUrl}/exams/${encodeURIComponent(exam.id)}/years/${encodeURIComponent(yearId)}/papers`;
                            const pRes = await fetch(papersUrl);
                            if (!pRes.ok) continue;

                            const pData = await pRes.json();
                            const paperDocs = pData.documents || [];
                            const paperCount = paperDocs.length;

                            if (paperCount > 0) {
                                totalExamPapers += paperCount;
                                yearsWithPapers.push({
                                    year: yearId,
                                    paperCount
                                });
                            }
                        } catch (pErr) {
                            console.warn(`[PyqLibraryService] Error fetching papers for ${exam.id}/${yearId}:`, pErr.message);
                        }
                    }

                    // NEVER display an examination that has 0 available PYQ papers
                    if (totalExamPapers > 0) {
                        // Sort years descending
                        yearsWithPapers.sort((a, b) => b.year.localeCompare(a.year, undefined, { numeric: true }));

                        // Compute year range
                        const numericYears = yearsWithPapers
                            .map(y => parseInt(y.year, 10))
                            .filter(n => !isNaN(n))
                            .sort((a, b) => a - b);

                        let yearRange = "";
                        if (numericYears.length > 0) {
                            const minYear = numericYears[0];
                            const maxYear = numericYears[numericYears.length - 1];
                            yearRange = minYear === maxYear ? `${minYear}` : `${minYear} – ${maxYear}`;
                        } else {
                            yearRange = `${yearsWithPapers.length} Year${yearsWithPapers.length > 1 ? "s" : ""}`;
                        }

                        validExams.push({
                            id: exam.id,
                            name: exam.name || exam.id,
                            paperCount: totalExamPapers,
                            yearCount: yearsWithPapers.length,
                            yearRange,
                            years: yearsWithPapers.map(y => y.year)
                        });
                    }
                } catch (examErr) {
                    console.warn(`[PyqLibraryService] Error inspecting exam ${exam.id}:`, examErr.message);
                }
            }

            // Sort valid exams: highest paperCount first, then name ascending
            validExams.sort((a, b) => {
                const pDiff = b.paperCount - a.paperCount;
                if (pDiff !== 0) return pDiff;
                return a.name.localeCompare(b.name);
            });

            cachedAvailableExams = validExams;
            lastAvailableExamsFetchTime = now;

            return {
                success: true,
                count: validExams.length,
                exams: validExams,
                cached: false,
                fetchedAt: new Date(now).toISOString()
            };
        } catch (error) {
            console.error("[PyqLibraryService] Error getting available exams:", error.message);
            if (cachedAvailableExams) {
                return {
                    success: true,
                    count: cachedAvailableExams.length,
                    exams: cachedAvailableExams,
                    cached: true,
                    stale: true,
                    error: error.message
                };
            }
            throw error;
        }
    }

    /**
     * Retrieve available years for a specific examination.
     * Years with zero papers are excluded.
     */
    static async getAvailableYears(examId, forceRefresh = false, options = {}) {
        if (!examId || typeof examId !== "string") {
            throw new Error("Missing or invalid examId");
        }
        const opts = typeof forceRefresh === "object" && forceRefresh !== null ? forceRefresh : options;
        const shouldForceRefresh = typeof forceRefresh === "boolean" ? forceRefresh : !!opts.forceRefresh;
        const projectId = getActiveProjectId(opts.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);

        const cleanExamId = examId.trim();
        const now = Date.now();

        const cached = examYearsCache.get(cleanExamId);
        if (!shouldForceRefresh && cached && (now - cached.timestamp < EXAM_YEARS_CACHE_TTL_MS)) {
            return {
                success: true,
                examId: cleanExamId,
                count: cached.years.length,
                years: cached.years,
                cached: true
            };
        }

        try {
            const yearsUrl = `${baseUrl}/exams/${encodeURIComponent(cleanExamId)}/years`;
            const yRes = await fetch(yearsUrl);
            if (!yRes.ok) {
                if (yRes.status === 404) {
                    return { success: true, examId: cleanExamId, count: 0, years: [] };
                }
                throw new Error(`Failed to fetch years for exam ${cleanExamId} (${yRes.status})`);
            }

            const yData = await yRes.json();
            const yearDocs = yData.documents || [];
            const yearsWithPapers = [];

            for (const doc of yearDocs) {
                const yearId = doc.name.split("/").pop();
                try {
                    const papersUrl = `${baseUrl}/exams/${encodeURIComponent(cleanExamId)}/years/${encodeURIComponent(yearId)}/papers`;
                    const pRes = await fetch(papersUrl);
                    if (!pRes.ok) continue;

                    const pData = await pRes.json();
                    const paperDocs = pData.documents || [];
                    const paperCount = paperDocs.length;

                    if (paperCount > 0) {
                        yearsWithPapers.push({
                            year: yearId,
                            yearId,
                            paperCount
                        });
                    }
                } catch (err) {
                    console.warn(`[PyqLibraryService] Error reading papers count for ${cleanExamId}/${yearId}:`, err.message);
                }
            }

            // Sort years descending (e.g. 2026, 2025, 2021)
            yearsWithPapers.sort((a, b) => b.year.localeCompare(a.year, undefined, { numeric: true }));

            examYearsCache.set(cleanExamId, {
                timestamp: now,
                years: yearsWithPapers
            });

            return {
                success: true,
                examId: cleanExamId,
                count: yearsWithPapers.length,
                years: yearsWithPapers,
                cached: false
            };
        } catch (error) {
            console.error(`[PyqLibraryService] Error getting years for ${cleanExamId}:`, error.message);
            if (cached) {
                return {
                    success: true,
                    examId: cleanExamId,
                    count: cached.years.length,
                    years: cached.years,
                    cached: true,
                    stale: true
                };
            }
            throw error;
        }
    }

    /**
     * Retrieve question papers for a specific examination and year with pagination.
     * Raw pdfUrl is strictly redacted.
     */
    static async getPapersByExamAndYear(examId, yearId, options = {}) {
        if (!examId || !yearId || typeof examId !== "string" || typeof yearId !== "string") {
            throw new Error("Missing or invalid examId or yearId");
        }
        const cleanExamId = examId.trim();
        const cleanYearId = yearId.trim();
        const projectId = getActiveProjectId(options?.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);

        const limit = Math.min(Math.max(parseInt(options.limit || "20", 10), 1), 50);
        const offset = sanitizeCursorNumber(options.cursor || options.offset || 0, 0, 10000);

        const cacheKey = `${cleanExamId}:${cleanYearId}`;
        const now = Date.now();
        let allPapers = null;

        const cached = papersByYearCache.get(cacheKey);
        if (!options.forceRefresh && cached && (now - cached.timestamp < PAPERS_BY_YEAR_CACHE_TTL_MS)) {
            allPapers = cached.papers;
        } else {
            const papersUrl = `${baseUrl}/exams/${encodeURIComponent(cleanExamId)}/years/${encodeURIComponent(cleanYearId)}/papers`;
            const res = await fetch(papersUrl);
            if (!res.ok) {
                if (res.status === 404) {
                    return {
                        success: true,
                        examId: cleanExamId,
                        yearId: cleanYearId,
                        totalPapers: 0,
                        count: 0,
                        limit,
                        offset,
                        hasMore: false,
                        nextCursor: null,
                        papers: []
                    };
                }
                throw new Error(`Failed to fetch papers for ${cleanExamId}/${cleanYearId} (${res.status})`);
            }

            const data = await res.json();
            const docs = data.documents || [];

            allPapers = docs.map(doc => this._formatPaperDoc(doc, { includeInternalUrl: false }));

            // Deterministic sorting: date DESC -> shift ASC -> title ASC
            allPapers.sort((a, b) => {
                const dateA = a.date || "";
                const dateB = b.date || "";
                const dDiff = dateB.localeCompare(dateA);
                if (dDiff !== 0) return dDiff;

                const shiftA = a.shift || "";
                const shiftB = b.shift || "";
                const sDiff = shiftA.localeCompare(shiftB);
                if (sDiff !== 0) return sDiff;

                return (a.title || "").localeCompare(b.title || "");
            });

            papersByYearCache.set(cacheKey, {
                timestamp: now,
                papers: allPapers
            });
        }

        const pagedPapers = allPapers.slice(offset, offset + limit);
        const hasMore = (offset + limit) < allPapers.length;
        const nextCursor = hasMore ? String(offset + limit) : null;

        return {
            success: true,
            examId: cleanExamId,
            yearId: cleanYearId,
            totalPapers: allPapers.length,
            count: pagedPapers.length,
            limit,
            offset,
            hasMore,
            nextCursor,
            papers: pagedPapers
        };
    }

    /**
     * Get total count of all papers across all exams and years using Firestore count aggregation.
     * Uses runAggregationQuery on collectionGroup('papers').
     */
    static async getTotalPapersCount(forceRefresh = false, options = {}) {
        const opts = typeof forceRefresh === "object" && forceRefresh !== null ? forceRefresh : options;
        const shouldForceRefresh = typeof forceRefresh === "boolean" ? forceRefresh : !!opts.forceRefresh;
        const projectId = getActiveProjectId(opts.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);

        const now = Date.now();
        if (!shouldForceRefresh && cachedTotalPapers !== null && (now - lastCountFetchTime < COUNT_CACHE_TTL_MS)) {
            return {
                totalPapers: cachedTotalPapers,
                cached: true,
                cachedAt: new Date(lastCountFetchTime).toISOString()
            };
        }

        try {
            const authHeaders = (await getFirestoreServerAuthHeaders(projectId)) || {};
            const aggregationBody = {
                structuredAggregationQuery: {
                    structuredQuery: {
                        from: [{ collectionId: "papers", allDescendants: true }]
                    },
                    aggregations: [
                        { alias: "totalPapers", count: {} }
                    ]
                }
            };

            const url = `${baseUrl}:runAggregationQuery`;
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...authHeaders
                },
                body: JSON.stringify(aggregationBody)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Firestore aggregation failed (${response.status}): ${errText}`);
            }

            const data = await response.json();
            const firstResult = Array.isArray(data) ? data[0] : data;
            const countStr = firstResult?.result?.aggregateFields?.totalPapers?.integerValue;
            const count = countStr ? parseInt(countStr, 10) : 0;

            cachedTotalPapers = count;
            lastCountFetchTime = now;

            return {
                totalPapers: count,
                cached: false,
                fetchedAt: new Date(now).toISOString()
            };
        } catch (error) {
            console.error("[PyqLibraryService] Error getting total paper count:", error.message);
            if (cachedTotalPapers !== null) {
                return {
                    totalPapers: cachedTotalPapers,
                    cached: true,
                    stale: true,
                    error: error.message
                };
            }
            throw error;
        }
    }

    /**
     * Get recent 5 available papers.
     * Orders by server-generated uploadedAt timestamp descending with fallback to createTime/date
     * and deterministic title tie-breaking.
     */
    static async getRecentPapers(limitCount = 5, forceRefresh = false, options = {}) {
        const opts = typeof forceRefresh === "object" && forceRefresh !== null ? forceRefresh : options;
        const shouldForceRefresh = typeof forceRefresh === "boolean" ? forceRefresh : !!opts.forceRefresh;
        const projectId = getActiveProjectId(opts.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);

        const now = Date.now();
        if (!shouldForceRefresh && cachedRecentPapers && (now - lastRecentFetchTime < RECENT_CACHE_TTL_MS)) {
            return {
                papers: cachedRecentPapers,
                cached: true,
                sortingNote: "Ordered by server uploadedAt timestamp with legacy fallback to createTime/date and deterministic title tie-breaking"
            };
        }

        try {
            const authHeaders = (await getFirestoreServerAuthHeaders(projectId)) || {};

            // 1. Attempt collection group query ordered by uploadedAt DESC
            const queryBody = {
                structuredQuery: {
                    from: [{ collectionId: "papers", allDescendants: true }],
                    orderBy: [{ field: { fieldPath: "uploadedAt" }, direction: "DESCENDING" }],
                    limit: limitCount
                }
            };

            const url = `${baseUrl}:runQuery`;
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...authHeaders
                },
                body: JSON.stringify(queryBody)
            });

            if (response.ok) {
                const results = await response.json();
                const papers = (results || [])
                    .filter(item => item.document && item.document.fields)
                    .map(item => this._formatPaperDoc(item.document, { includeInternalUrl: false }));

                if (papers.length > 0) {
                    cachedRecentPapers = papers;
                    lastRecentFetchTime = now;
                    return {
                        papers,
                        cached: false,
                        sortingNote: "Ordered by server uploadedAt timestamp with legacy fallback to createTime/date and deterministic title tie-breaking"
                    };
                }
            }

            // 2. Resilient Fallback: If COLLECTION_GROUP index is missing or empty,
            // fetch latest papers across major published exams and sort deterministically
            console.log("[PyqLibraryService] Collection group query fallback, using multi-exam discovery for recent papers...");
            const fallbackPapers = await this._getRecentPapersFallback(limitCount, { projectId });
            cachedRecentPapers = fallbackPapers;
            lastRecentFetchTime = now;

            return {
                papers: fallbackPapers,
                cached: false,
                sortingNote: "Ordered by server uploadedAt timestamp with legacy fallback to createTime/date and deterministic title tie-breaking"
            };
        } catch (error) {
            console.error("[PyqLibraryService] Error getting recent papers:", error.message);
            if (cachedRecentPapers) {
                return {
                    papers: cachedRecentPapers,
                    cached: true,
                    stale: true
                };
            }
            throw error;
        }
    }

    /**
     * Fallback to retrieve latest papers by inspecting recent years across top exams.
     * Deterministically orders by uploadedAt -> createTime -> date, then title.
     */
    static async _getRecentPapersFallback(limitCount = 5, options = {}) {
        const projectId = getActiveProjectId(options?.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);
        const topExams = ["jee-main", "NEET", "Gate", "ssc cgl", "JEE Advanced", "BPSC", "upsc"];
        const collected = [];

        for (const examId of topExams) {
            try {
                const yearsUrl = `${baseUrl}/exams/${encodeURIComponent(examId)}/years`;
                const yRes = await fetch(yearsUrl);
                if (!yRes.ok) continue;

                const yData = await yRes.json();
                const years = (yData.documents || [])
                    .map(d => d.name.split("/").pop())
                    .sort((a, b) => b.localeCompare(a)); // Newest year first

                if (years.length === 0) continue;

                for (const y of years.slice(0, 2)) {
                    const papersUrl = `${baseUrl}/exams/${encodeURIComponent(examId)}/years/${encodeURIComponent(y)}/papers`;
                    const pRes = await fetch(papersUrl);
                    if (!pRes.ok) continue;

                    const pData = await pRes.json();
                    const docs = pData.documents || [];
                    for (const doc of docs) {
                        const parsed = this._formatPaperDoc(doc, { includeInternalUrl: false });
                        collected.push(parsed);
                    }
                    if (collected.length >= limitCount * 4) break;
                }
            } catch (err) {
                // Ignore per-exam errors in fallback
            }
            if (collected.length >= limitCount * 4) break;
        }

        // Deterministic sort: uploadedAt descending -> createTime -> date, then stable title & id tie-break
        collected.sort((a, b) => {
            const timeA = parseSafeTimestamp(a.uploadedAt) || parseSafeTimestamp(a.createTime) || parseSafeTimestamp(a.date) || 0;
            const timeB = parseSafeTimestamp(b.uploadedAt) || parseSafeTimestamp(b.createTime) || parseSafeTimestamp(b.date) || 0;
            const diff = timeB - timeA;
            if (diff !== 0) return diff;

            const titleA = String(a.title || a.id || "");
            const titleB = String(b.title || b.id || "");
            const tDiff = titleA.localeCompare(titleB);
            if (tDiff !== 0) return tDiff;

            return String(a.id || "").localeCompare(String(b.id || ""));
        });

        return collected.slice(0, limitCount);
    }

    /**
     * Search papers by examination name with genuine cursor pagination.
     * Queries only the necessary batch of papers, groups results by year, and returns an opaque cursor token.
     */
    static async searchPapers(examSearchQuery, options = {}) {
        if (!examSearchQuery || typeof examSearchQuery !== "string") {
            return {
                success: false,
                error: "Please enter an examination name to search."
            };
        }

        const cleanQuery = examSearchQuery.trim();
        if (!cleanQuery) {
            return {
                success: false,
                error: "Search query cannot be empty."
            };
        }

        const limit = Math.min(Math.max(parseInt(options.limit || "10", 10), 1), 50);
        const rawCursor = options.cursor;

        // Parse cursor state
        let cursorData = null;
        if (rawCursor && typeof rawCursor === "string" && rawCursor !== "0") {
            try {
                // Try base64 decoded cursor object
                const decoded = Buffer.from(rawCursor, "base64url").toString("utf8");
                cursorData = JSON.parse(decoded);
            } catch {
                // Handle numeric offset cursor for backward compatibility
                const numericOffset = parseInt(rawCursor, 10);
                if (!isNaN(numericOffset) && numericOffset >= 0) {
                    cursorData = { legacyOffset: numericOffset };
                }
            }
        }

        const projectId = getActiveProjectId(options?.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);

        const normQuery = cleanQuery.toLowerCase().replace(/[-_\s]+/g, "");
        const allExams = await PaperSearchService.fetchExamsFromFirestore({ projectId });

        // Find matching exams (exact, alias, or substring)
        const matchingExams = allExams.filter(e => {
            const normId = e.id.toLowerCase().replace(/[-_\s]+/g, "");
            const normName = e.name.toLowerCase().replace(/[-_\s]+/g, "");
            return normId.includes(normQuery) || normName.includes(normQuery) ||
                   normQuery.includes(normId) || normQuery.includes(normName);
        });

        if (matchingExams.length === 0) {
            return {
                success: true,
                query: cleanQuery,
                matchingExams: [],
                totalMatches: 0,
                years: [],
                hasMore: false,
                nextCursor: null,
                message: "No question papers found for this examination."
            };
        }

        // Cache matching exam hierarchy (exam -> years list) to avoid re-fetching year lists on every page
        const cacheKey = `search_meta:${normQuery}`;
        let examYearsMeta = searchResultsCache.get(cacheKey);

        if (!examYearsMeta || (Date.now() - examYearsMeta.timestamp > SEARCH_CACHE_TTL_MS)) {
            const structure = [];
            for (const exam of matchingExams) {
                try {
                    const yearsUrl = `${baseUrl}/exams/${encodeURIComponent(exam.id)}/years`;
                    const yRes = await fetch(yearsUrl);
                    if (!yRes.ok) continue;

                    const yData = await yRes.json();
                    const years = (yData.documents || [])
                        .map(d => d.name.split("/").pop())
                        .sort((a, b) => b.localeCompare(a)); // Descending years

                    structure.push({
                        examId: exam.id,
                        examName: exam.name || exam.id,
                        years
                    });
                } catch (err) {
                    console.warn(`[PyqLibraryService] Error fetching years for exam ${exam.id}:`, err.message);
                }
            }
            examYearsMeta = {
                timestamp: Date.now(),
                structure
            };
            searchResultsCache.set(cacheKey, examYearsMeta);
        }

        // Genuine cursor traversal across (examIndex, yearIndex, paperOffset)
        const collected = [];
        let hasMore = false;
        let nextCursor = null;

        let startExamIdx = sanitizeCursorNumber(cursorData?.examIdx, 0, examYearsMeta.structure.length);
        let startYearIdx = sanitizeCursorNumber(cursorData?.yearIdx, 0, 1000);
        let startPaperOffset = sanitizeCursorNumber(cursorData?.paperOffset, 0, 10000);

        // If legacy numeric offset is provided, traverse until skipping legacyOffset items
        let skipRemaining = sanitizeCursorNumber(cursorData?.legacyOffset, 0, 10000);

        const structure = examYearsMeta.structure;

        examLoop:
        for (let eIdx = startExamIdx; eIdx < structure.length; eIdx++) {
            const examEntry = structure[eIdx];
            const yStart = (eIdx === startExamIdx) ? startYearIdx : 0;

            for (let yIdx = yStart; yIdx < examEntry.years.length; yIdx++) {
                const year = examEntry.years[yIdx];
                const papersUrl = `${baseUrl}/exams/${encodeURIComponent(examEntry.examId)}/years/${encodeURIComponent(year)}/papers`;
                
                try {
                    const pRes = await fetch(papersUrl);
                    if (!pRes.ok) continue;

                    const pData = await pRes.json();
                    const docs = pData.documents || [];

                    // Sort documents within the year deterministically: date DESC -> shift ASC -> id ASC
                    docs.sort((a, b) => {
                        const dateA = a.fields?.date?.stringValue || "";
                        const dateB = b.fields?.date?.stringValue || "";
                        const dDiff = dateB.localeCompare(dateA);
                        if (dDiff !== 0) return dDiff;
                        const shiftA = a.fields?.shift?.stringValue || "";
                        const shiftB = b.fields?.shift?.stringValue || "";
                        return shiftA.localeCompare(shiftB);
                    });

                    let pStart = (eIdx === startExamIdx && yIdx === startYearIdx) ? startPaperOffset : 0;

                    for (let pIdx = pStart; pIdx < docs.length; pIdx++) {
                        if (skipRemaining > 0) {
                            skipRemaining--;
                            continue;
                        }

                        if (collected.length >= limit) {
                            // Found boundary for next page
                            hasMore = true;
                            nextCursor = Buffer.from(JSON.stringify({
                                examIdx: eIdx,
                                yearIdx: yIdx,
                                paperOffset: pIdx
                            })).toString("base64url");
                            break examLoop;
                        }

                        const parsed = this._formatPaperDoc(docs[pIdx], { includeInternalUrl: false });
                        parsed.examName = examEntry.examName;
                        collected.push(parsed);
                    }
                } catch (err) {
                    console.warn(`[PyqLibraryService] Error reading papers for ${examEntry.examId}/${year}:`, err.message);
                }
            }
        }

        // Group paged papers by year for clean UI display
        const yearGroupsMap = new Map();
        for (const p of collected) {
            const yr = p.year || "Other";
            if (!yearGroupsMap.has(yr)) {
                yearGroupsMap.set(yr, []);
            }
            yearGroupsMap.get(yr).push(p);
        }

        const years = [];
        for (const [yr, papers] of yearGroupsMap.entries()) {
            years.push({
                year: yr,
                papers
            });
        }

        return {
            success: true,
            query: cleanQuery,
            matchingExams: matchingExams.map(e => ({ id: e.id, name: e.name })),
            count: collected.length,
            limit,
            years,
            hasMore,
            nextCursor
        };
    }

    /**
     * Retrieve paper metadata for authorized download or preview (INTERNAL USE).
     * Includes upstream pdfUrl strictly for internal server verification and streaming.
     */
    static async getPaperInternal(examId, yearId, paperId, options = {}) {
        if (!examId || !yearId || !paperId) {
            throw new Error("Missing examId, yearId, or paperId");
        }

        const projectId = getActiveProjectId(options?.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);
        const docUrl = `${baseUrl}/exams/${encodeURIComponent(examId)}/years/${encodeURIComponent(yearId)}/papers/${encodeURIComponent(paperId)}`;
        const res = await fetch(docUrl);
        if (res.status === 404 || !res.ok) {
            return null;
        }

        const doc = await res.json();
        return this._formatPaperDoc(doc, { includeInternalUrl: true });
    }

    /**
     * Backward-compatible alias for getPaperInternal
     */
    static async getPaperForDownload(examId, yearId, paperId, options = {}) {
        return this.getPaperInternal(examId, yearId, paperId, options);
    }

    /**
     * Helper to format raw Firestore REST document into normalized paper object.
     * Strictly redacts raw pdfUrl from public responses unless options.includeInternalUrl is true.
     */
    static _formatPaperDoc(doc, options = {}) {
        const fullPath = doc.name || "";
        const parts = fullPath.split("/");
        // Path: projects/.../databases/(default)/documents/exams/{examId}/years/{yearId}/papers/{paperId}
        const examIdx = parts.indexOf("exams");
        const examId = examIdx >= 0 && parts[examIdx + 1] ? parts[examIdx + 1].trim() : "";
        const yearIdx = parts.indexOf("years");
        const yearId = yearIdx >= 0 && parts[yearIdx + 1] ? parts[yearIdx + 1].trim() : "";
        const paperId = parts[parts.length - 1] ? parts[parts.length - 1].trim() : "";

        const fields = doc.fields || {};

        const rawTitle = fields.title?.stringValue || fields["title "]?.stringValue || "";
        const date = fields.date?.stringValue || "";
        const shift = fields.shift?.stringValue || "";
        const subject = fields.subject?.stringValue || "";
        const rawPdfUrl = fields.pdfUrl?.stringValue || fields.pdfurl?.stringValue || "";
        const viewCount = parseInt(fields.viewCount?.integerValue || "0", 10);
        const downloadCount = parseInt(fields.downloadCount?.integerValue || "0", 10);
        const uploadedAt = fields.uploadedAt?.stringValue || undefined;

        const cleanTitle = rawTitle.trim() || (date && shift ? `${date} — ${shift}` : paperId);

        const formatted = {
            id: paperId,
            paperId,
            examId,
            year: yearId,
            yearId,
            title: cleanTitle,
            date,
            shift,
            subject,
            hasPdf: Boolean(rawPdfUrl),
            viewCount,
            downloadCount,
            createTime: doc.createTime || null,
            updateTime: doc.updateTime || null
        };

        if (uploadedAt) {
            formatted.uploadedAt = uploadedAt;
        }

        // STRICT SECURITY BOUNDARY: Never leak upstream storage URL to public clients.
        // Include pdfUrl ONLY when explicitly requested for internal server-side streaming.
        if (options.includeInternalUrl === true) {
            formatted.pdfUrl = rawPdfUrl;
        }

        return formatted;
    }
}
