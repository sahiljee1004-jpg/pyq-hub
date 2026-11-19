/**
 * VidyarthiAstra — Normalized Subject Service
 * 
 * Provides unified, deterministic subject identification and normalization
 * across diverse examination formats (JEE Main, NEET UG, GATE, CUET, etc.).
 * 
 * Guarantees:
 * 1. Consistent lowercase alphanumeric subjectId slugs (e.g. 'physics', 'mathematics', 'logical-reasoning')
 * 2. Clean, academic display names (e.g. 'Physics', 'Mathematics', 'Logical Reasoning')
 * 3. Safe fallback to 'unclassified' for unknown or missing subject metadata
 * 4. Case-insensitive and alias-resilient mapping
 */
export class SubjectNormalizationService {

    static CANONICAL_MAP = new Map([
        // Physics
        ["physics", { id: "physics", name: "Physics" }],
        ["phy", { id: "physics", name: "Physics" }],
        ["physic", { id: "physics", name: "Physics" }],

        // Chemistry
        ["chemistry", { id: "chemistry", name: "Chemistry" }],
        ["chem", { id: "chemistry", name: "Chemistry" }],

        // Mathematics
        ["mathematics", { id: "mathematics", name: "Mathematics" }],
        ["math", { id: "mathematics", name: "Mathematics" }],
        ["maths", { id: "mathematics", name: "Mathematics" }],

        // Biology / Life Sciences
        ["biology", { id: "biology", name: "Biology" }],
        ["bio", { id: "biology", name: "Biology" }],
        ["botany", { id: "botany", name: "Botany" }],
        ["bot", { id: "botany", name: "Botany" }],
        ["zoology", { id: "zoology", name: "Zoology" }],
        ["zoo", { id: "zoology", name: "Zoology" }],

        // General / Other Exam Disciplines
        ["general", { id: "general", name: "General" }],
        ["general awareness", { id: "general-awareness", name: "General Awareness" }],
        ["general knowledge", { id: "general-knowledge", name: "General Knowledge" }],
        ["gk", { id: "general-knowledge", name: "General Knowledge" }],
        ["logical reasoning", { id: "logical-reasoning", name: "Logical Reasoning" }],
        ["reasoning", { id: "logical-reasoning", name: "Logical Reasoning" }],
        ["quantitative aptitude", { id: "quantitative-aptitude", name: "Quantitative Aptitude" }],
        ["quant", { id: "quantitative-aptitude", name: "Quantitative Aptitude" }],
        ["english", { id: "english", name: "English" }],
        ["english comprehension", { id: "english", name: "English" }],
        ["computer science", { id: "computer-science", name: "Computer Science" }],
        ["cs", { id: "computer-science", name: "Computer Science" }]
    ]);

    /**
     * Normalize raw subject text or metadata into canonical { subjectId, subjectName }
     * @param {string|object} input - String name or object with subject/subjectId/subjectName
     * @param {string} [examId] - Optional exam context
     * @returns {{ subjectId: string, subjectName: string }}
     */
    static normalizeSubject(input, examId = null) {
        let raw = "";
        if (typeof input === "string") {
            raw = input;
        } else if (input && typeof input === "object") {
            raw = input.subjectName || input.subject || input.subjectId || "";
        }

        if (!raw || typeof raw !== "string") {
            return {
                subjectId: "unclassified",
                subjectName: "Unclassified"
            };
        }

        const trimmed = raw.trim();
        if (!trimmed || trimmed.toLowerCase() === "unclassified" || trimmed.toLowerCase() === "unknown") {
            return {
                subjectId: "unclassified",
                subjectName: "Unclassified"
            };
        }

        const lower = trimmed.toLowerCase();

        // 1. Check canonical dictionary
        if (this.CANONICAL_MAP.has(lower)) {
            const entry = this.CANONICAL_MAP.get(lower);
            return {
                subjectId: entry.id,
                subjectName: entry.name
            };
        }

        // 2. Prefix / Substring matching for compound names (e.g. "Physics - Section A")
        for (const [alias, entry] of this.CANONICAL_MAP.entries()) {
            if (alias.length >= 4 && (lower.startsWith(alias) || lower.includes(` ${alias} `) || lower.endsWith(` ${alias}`))) {
                return {
                    subjectId: entry.id,
                    subjectName: entry.name
                };
            }
        }

        // 3. Dynamic formatting for custom exam subjects
        const slug = lower
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");

        if (!slug) {
            return {
                subjectId: "unclassified",
                subjectName: "Unclassified"
            };
        }

        // Generate academic Title Case display name
        const display = trimmed
            .replace(/[-_]+/g, " ")
            .split(/\s+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(" ");

        return {
            subjectId: slug,
            subjectName: display
        };
    }
}

