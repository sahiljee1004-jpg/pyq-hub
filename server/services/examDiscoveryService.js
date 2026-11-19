import { SearchService } from "./searchService.js";

/**
 * Service to execute multi-family automated search and discovery for Indian exam updates
 */
export class ExamDiscoveryService {
    /**
     * Define Extensible Search Strategy Families for Broad Live Discovery
     */
    static SEARCH_FAMILIES = [
        { family: "ALL_GENERAL", query: "latest exam notifications India 2026 2027" },
        { family: "COMPETITIVE", query: "latest competitive exam notifications India" },
        { family: "ENTRANCE", query: "latest entrance exam notifications India 2026" },
        { family: "GOVT", query: "latest government exam notifications India" },
        { family: "ENGINEERING", query: "latest engineering entrance exam notification NTA JEE GATE 2026" },
        { family: "MEDICAL", query: "latest medical entrance exam notification NEET NBE NTA" },
        { family: "RECRUITMENT", query: "latest recruitment exam notification India" },
        { family: "BANKING", query: "latest banking exam notification IBPS SBI RRB" },
        { family: "RAILWAY", query: "latest railway exam notification RRB ALP NTPC" },
        { family: "SSC", query: "latest SSC exam notification CGL CHSL GD" },
        { family: "UPSC", query: "latest UPSC exam notification CSE NDA CDS" },
        { family: "STATE_PSC", query: "latest state PSC exam notification India" },
        { family: "REGISTRATION_OPEN", query: "exam registration open India 2026" },
        { family: "DEADLINES", query: "exam application deadline approaching India" },
        { family: "ADMIT_CARD", query: "exam admit card released India NTA UPSC SSC" },
        { family: "RESULTS", query: "exam result declared India NTA UPSC SSC IBPS" },
        { family: "ANSWER_KEYS", query: "exam answer key released India NTA GATE" },
        { family: "COUNSELLING", query: "exam counselling notification JoSAA MCC CSAB 2026" },
        { family: "UNIVERSITY", query: "latest CUET university entrance exam notification" },
        { family: "SCHEDULE_UPDATES", query: "exam schedule date announced postponed India" }
    ];

    /**
     * Execute parallel discovery search across a curated subset of search families
     */
    static async executeBroadDiscovery(maxFamilies = 6) {
        const configuredMax = parseInt(process.env.LIVE_UPDATES_MAX_SEARCHES || "20", 10);
        const limitCount = Math.min(maxFamilies, Math.max(1, configuredMax));

        console.log(`[ExamDiscoveryService] Starting broad multi-family exam discovery (limit=${limitCount} families)...`);

        const selectedFamilies = this.selectFamilies(limitCount);
        const searchPromises = selectedFamilies.map((f) =>
            SearchService.searchWeb(f.query, { num: 6, time_range: "day" })
                .then((res) => ({ family: f.family, query: f.query, res }))
                .catch((err) => ({ family: f.family, query: f.query, res: { success: false, results: [], error: err.message } }))
        );

        const rawResults = await Promise.all(searchPromises);
        const allFailed = rawResults.length > 0 && rawResults.every(({ res }) => !res?.success);
        if (allFailed) {
            throw new Error("All search providers failed during broad discovery");
        }

        let aggregatedSources = [];
        rawResults.forEach(({ family, res }) => {
            if (res.success && Array.isArray(res.results)) {
                res.results.forEach((item) => {
                    aggregatedSources.push({
                        ...item,
                        discoveryFamily: family
                    });
                });
            }
        });

        console.log(`[ExamDiscoveryService] Broad discovery fetched ${aggregatedSources.length} raw search items across ${selectedFamilies.length} families`);
        return aggregatedSources;
    }

    /**
     * Execute focused query search for specific user search bar entries
     */
    static async executeTargetedSearch(userQuery) {
        console.log(`[ExamDiscoveryService] Executing targeted query search for: "${userQuery}"`);

        const trimmed = userQuery.trim();
        const queriesToRun = [
            trimmed,
            `${trimmed} official notification website 2026 2027`,
            `${trimmed} latest update announcement date`
        ];

        const searchPromises = queriesToRun.map((q) =>
            SearchService.searchWeb(q, { num: 6 })
                .then((res) => ({ success: Boolean(res.success), results: res.results || [] }))
                .catch(() => ({ success: false, results: [] }))
        );

        const resultsArrays = await Promise.all(searchPromises);
        const allFailed = resultsArrays.length > 0 && resultsArrays.every(r => !r.success);
        if (allFailed) {
            throw new Error("All search providers failed to return results");
        }

        const combined = resultsArrays.flatMap(r => r.results);

        console.log(`[ExamDiscoveryService] Targeted search returned ${combined.length} items`);
        return combined;
    }

    /**
     * Helper to select key families for balanced coverage
     */
    static selectFamilies(count) {
        const priorityKeys = ["ALL_GENERAL", "ENGINEERING", "MEDICAL", "GOVT", "REGISTRATION_OPEN", "DEADLINES", "ADMIT_CARD", "RESULTS"];
        const priorityFamilies = this.SEARCH_FAMILIES.filter((f) => priorityKeys.includes(f.family));

        const remaining = this.SEARCH_FAMILIES.filter((f) => !priorityKeys.includes(f.family));
        const shuffled = remaining.sort(() => 0.5 - Math.random());

        const merged = [...priorityFamilies, ...shuffled];
        return merged.slice(0, count);
    }
}

