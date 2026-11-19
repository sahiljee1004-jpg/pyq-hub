/**
 * Service to filter, classify, deduplicate and prioritize sources for Live Updates
 */
export class DeduplicationService {
    /**
     * Priority map for source classification
     */
    static SOURCE_PRIORITY = {
        official: 1,      // Level 1: Government, official NTA, UPSC, SSC, JoSAA, Universities
        educational: 2,   // Level 2: Trusted education portals, Wikipedia
        news: 3,          // Level 2/3: Major news organizations
        coaching: 4,      // Level 3: Coaching institutes
        unknown: 5,       // Level 4: Generic websites
        forum: 6          // Level 4: Forums, social media
    };

    /**
     * Deduplicate raw web search items based on URL, exam name, title similarity, and event overlap
     */
    static deduplicateRawSources(sources) {
        if (!Array.isArray(sources) || sources.length === 0) return [];

        const urlMap = new Map();
        const cleanedSources = [];

        // 1. Remove exact duplicate URLs & blank titles
        for (const item of sources) {
            if (!item.url || !item.title) continue;
            const normalizedUrl = item.url.split("#")[0].replace(/\/+$/, "").toLowerCase();
            if (urlMap.has(normalizedUrl)) continue;

            urlMap.set(normalizedUrl, true);
            cleanedSources.push(item);
        }

        // 2. Sort items so Level 1 Official sources come first
        cleanedSources.sort((a, b) => {
            const priorityA = this.SOURCE_PRIORITY[a.sourceType] || 5;
            const priorityB = this.SOURCE_PRIORITY[b.sourceType] || 5;
            if (priorityA !== priorityB) return priorityA - priorityB;

            // Recency priority if publication date is available
            if (a.publicationDate && b.publicationDate) {
                return new Date(b.publicationDate) - new Date(a.publicationDate);
            }
            return 0;
        });

        // 3. Cluster highly similar articles by exam topic + key event keywords
        const uniqueClusters = [];
        for (const source of cleanedSources) {
            const isDuplicate = uniqueClusters.some((existing) => this.areSourcesSimilar(existing, source));
            if (!isDuplicate) {
                uniqueClusters.push(source);
            }
        }

        console.log(`[DeduplicationService] Deduplicated ${sources.length} raw sources down to ${uniqueClusters.length} distinct high-quality sources`);
        return uniqueClusters.slice(0, 15); // Limit context size for Groq token optimization
    }

    /**
     * Check if two sources are reporting the exact same announcement
     */
    static areSourcesSimilar(s1, s2) {
        const title1 = (s1.title || "").toLowerCase();
        const title2 = (s2.title || "").toLowerCase();

        // Extract key exam names
        const exam1 = this.extractExamKeyword(title1 + " " + s1.snippet);
        const exam2 = this.extractExamKeyword(title2 + " " + s2.snippet);

        if (exam1 && exam2 && exam1 === exam2) {
            // Extract key event types (e.g. admit card, result, registration, answer key)
            const event1 = this.extractEventKeyword(title1);
            const event2 = this.extractEventKeyword(title2);

            if (event1 && event2 && event1 === event2) {
                return true;
            }
        }

        // Jaccard similarity on titles
        return this.calculateJaccardSimilarity(title1, title2) > 0.6;
    }

    static extractExamKeyword(text) {
        const lower = text.toLowerCase();
        if (lower.includes("jee main")) return "jee_main";
        if (lower.includes("jee adv")) return "jee_advanced";
        if (lower.includes("neet")) return "neet";
        if (lower.includes("gate")) return "gate";
        if (lower.includes("upsc") || lower.includes("civil services")) return "upsc";
        if (lower.includes("ssc cgl")) return "ssc_cgl";
        if (lower.includes("ssc chsl")) return "ssc_chsl";
        if (lower.includes("ibps po") || lower.includes("ibps clk")) return "ibps";
        if (lower.includes("sbi po") || lower.includes("sbi clk")) return "sbi";
        if (lower.includes("rrb ntpc") || lower.includes("rrb alp") || lower.includes("railway")) return "rrb";
        if (lower.includes("cuet")) return "cuet";
        if (lower.includes("cat 20")) return "cat";
        if (lower.includes("clat")) return "clat";
        if (lower.includes("nda") || lower.includes("cds")) return "defence";
        return null;
    }

    static extractEventKeyword(title) {
        const t = title.toLowerCase();
        if (t.includes("admit card") || t.includes("hall ticket")) return "admit_card";
        if (t.includes("result") || t.includes("merit list") || t.includes("scorecard")) return "result";
        if (t.includes("answer key") || t.includes("response sheet")) return "answer_key";
        if (t.includes("registration") || t.includes("apply online") || t.includes("application form")) return "registration";
        if (t.includes("counseling") || t.includes("counselling") || t.includes("seat allocation")) return "counselling";
        if (t.includes("postponed") || t.includes("rescheduled") || t.includes("cancel")) return "schedule_change";
        if (t.includes("cutoff") || t.includes("cut off") || t.includes("qualifying marks")) return "cutoff";
        return null;
    }

    static calculateJaccardSimilarity(str1, str2) {
        const words1 = new Set(str1.replace(/[^\w\s]/gi, "").split(/\s+/).filter((w) => w.length > 3));
        const words2 = new Set(str2.replace(/[^\w\s]/gi, "").split(/\s+/).filter((w) => w.length > 3));
        if (words1.size === 0 || words2.size === 0) return 0;

        let intersection = 0;
        words1.forEach((w) => {
            if (words2.has(w)) intersection++;
        });

        const union = words1.size + words2.size - intersection;
        return union > 0 ? intersection / union : 0;
    }

    /**
     * Deduplicate final structured Groq update cards
     */
    static deduplicateFinalUpdates(updates) {
        if (!Array.isArray(updates) || updates.length === 0) return [];

        const seen = new Map();
        const result = [];

        for (const item of updates) {
            if (!item.examName || !item.title) continue;

            // Generate key from examName + updateType + importantDate
            const key = `${item.examName.toLowerCase()}_${item.updateType || "OTHER"}_${item.importantDate || "NO_DATE"}`;
            if (seen.has(key)) {
                // If existing isn't official but current is official, swap them
                const existingIndex = seen.get(key);
                if (item.source?.type === "official" && result[existingIndex]?.source?.type !== "official") {
                    result[existingIndex] = item;
                }
                continue;
            }

            seen.set(key, result.length);
            result.push(item);
        }

        return result;
    }
}
