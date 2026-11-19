import crypto from "node:crypto";
import {
    ExamProfileRegistry,
    VERIFICATION_STATUS,
    OPTIONAL_QUESTION_POLICY,
    DROPPED_QUESTION_POLICY
} from "./examProfileRegistry.js";

/**
 * Exam Pattern Service
 * 
 * Manages configuration-driven schemas for exam patterns (stored in `examConfigs/{configId}`).
 * Reusable across NEET UG, JEE Main, GATE, CUET, NDA, and custom user-entered exams.
 * Integrates with declarative ExamProfileRegistry as the authoritative source of truth.
 */
export class ExamPatternService {

    /**
     * Expose registry reference
     */
    static get registry() {
        return ExamProfileRegistry;
    }

    /**
     * Resolve and validate a user-supplied exam name into a safe internal examId and canonical display name.
     * Prevents arbitrary Firestore document path injection, traversal, and collisions.
     */
    static resolveExamIdentity(rawInput) {
        if (typeof rawInput !== "string") {
            throw new Error("Target Exam name must be a valid string.");
        }
        const trimmed = rawInput.trim();
        if (!trimmed) {
            throw new Error("Target Exam name cannot be empty or contain only whitespace.");
        }
        if (trimmed.length > 150) {
            throw new Error("Target Exam name cannot exceed 150 characters.");
        }
        // Reject dangerous characters that could attempt path traversal or injection
        if (/[\x00-\x1F\x7F\\\/]|\.\./.test(trimmed)) {
            throw new Error("Target Exam name contains invalid characters or unsafe path traversal sequences.");
        }

        // Canonical mapping for recognized standard exams (unambiguous & compatible)
        const normalized = trimmed.toLowerCase().replace(/[\s\-_]+/g, " ");
        if (/^(neet(\s*ug)?|national eligibility cum entrance test)(\s*\d{4})?$/i.test(normalized)) {
            return {
                examId: "neet-ug",
                examName: trimmed,
                isKnown: true
            };
        }
        if (/^(jee(\s*main)?|joint entrance examination(\s*main)?)(\s*\d{4})?$/i.test(normalized) && !normalized.includes("adv")) {
            return {
                examId: "jee-main",
                examName: trimmed,
                isKnown: true
            };
        }
        if (/^(jee\s*adv(anced)?|joint\s*entrance\s*examination\s*advanced)(\s*\d{4})?$/i.test(normalized)) {
            return {
                examId: "jee-advanced",
                examName: trimmed,
                isKnown: true
            };
        }
        if (/^gate(\s*(cs|computer science|engineering))?(\s*\d{4})?$/i.test(normalized)) {
            return {
                examId: "gate",
                examName: trimmed,
                isKnown: true
            };
        }
        if (/^nda(\s*(na|national defence academy))?(\s*\d{4})?$/i.test(normalized)) {
            return {
                examId: "nda",
                examName: trimmed,
                isKnown: true
            };
        }
        if (/^cuet(\s*ug)?(\s*\d{4})?$/i.test(normalized)) {
            return {
                examId: "cuet",
                examName: trimmed,
                isKnown: true
            };
        }
        if (/^(bpsc|bihar public service commission)(\s+(\d{1,2}(th|st|nd|rd)?|cce|prelims|combined|competitive|\d{4})){0,4}$/i.test(normalized)) {
            return {
                examId: "bpsc",
                examName: trimmed,
                isKnown: true
            };
        }
        if (/^(upsc|union public service commission)(\s+(civil\s+services|prelims|cse|ias|paper\s*[\-I1-2]|preliminary|\d{4})){0,4}$/i.test(normalized) || normalized === "upsc prelims" || normalized.startsWith("upsc")) {
            return {
                examId: "upsc-prelims",
                examName: trimmed,
                isKnown: true
            };
        }
        if (/^(ssc|staff\s*selection\s*commission)(\s+(cgl|combined\s*graduate\s*level|\d{4})){0,4}$/i.test(normalized)) {
            return {
                examId: "ssc-cgl",
                examName: trimmed,
                isKnown: true
            };
        }
        if (/^(banking|ibps|ibps\s*po|cwe\s*po)(\s+(\d{4}|prelims)){0,4}$/i.test(normalized)) {
            return {
                examId: "banking-ibps-po",
                examName: trimmed,
                isKnown: true
            };
        }

        // Custom / previously unsupported exam
        // Build a safe slug (only alphanumeric and hyphens)
        const slug = trimmed
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40);

        const hash = crypto.createHash("sha256")
            .update(trimmed.toLowerCase())
            .digest("hex")
            .slice(0, 8);

        const examId = slug ? `${slug}-${hash}` : `custom-exam-${hash}`;

        return {
            examId,
            examName: trimmed,
            isKnown: false
        };
    }

    /**
     * Get or build verified pattern configuration.
     * Checks declarative ExamProfileRegistry first. Falls back to draft configuration
     * for unrecognized exams with explicit review flags (no silent NEET-style defaults).
     */
    static getVerifiedPattern({ examId, examName = null, year, extractedMetadata = {}, isSample, paperType } = {}) {
        const cleanExam = (examId || "").toLowerCase().trim();
        const numYear = Number(year) || 2024;
        const configId = `${cleanExam}-${numYear}`;

        // 1. Check declarative ExamProfileRegistry
        const registeredProfile = ExamProfileRegistry.findProfile(cleanExam, numYear);

        if (registeredProfile) {
            // Backward-compatibility: Explicit NEET custom sample override
            if (cleanExam.includes("neet") && numYear === 2024) {
                const docTotalQ = extractedMetadata.totalQuestions?.value;
                const isExplicitSample = Boolean(
                    isSample === true ||
                    paperType === "sample" ||
                    extractedMetadata.isSample === true ||
                    extractedMetadata.isSample?.value === true ||
                    extractedMetadata.paperType === "sample" ||
                    extractedMetadata.paperType?.value === "sample" ||
                    extractedMetadata.isSyntheticSample === true ||
                    extractedMetadata.sampleMode === true
                );
                if (isExplicitSample && docTotalQ && docTotalQ !== registeredProfile.totalQuestions) {
                    const totalQuestions = docTotalQ;
                    const maxMarks = extractedMetadata.maximumMarks?.value || (totalQuestions * 4);
                    return {
                        configId: `neet-ug-2024-sample-${totalQuestions}`,
                        examId: "neet-ug",
                        examName: "National Eligibility Cum Entrance Test (NEET UG)",
                        year: 2024,
                        patternVersion: "2024.sample",
                        status: "verified",
                        verificationStatus: registeredProfile.verificationStatus,
                        isOfficial: registeredProfile.isOfficial,
                        durationSeconds: extractedMetadata.durationSeconds?.value || (totalQuestions * 60),
                        totalQuestions: totalQuestions,
                        requiredQuestionsToAttempt: totalQuestions,
                        maximumMarks: maxMarks,
                        negativeMarkingEnabled: true,
                        allowedOptionCounts: [4],
                        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
                        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
                        navigationRules: {
                            allowSectionSwitching: true,
                            allowQuestionReview: true,
                            strictTimer: true
                        },
                        sections: [
                            {
                                id: "physics_a",
                                name: "Physics - Section A",
                                subject: "Physics",
                                startQuestion: 1,
                                endQuestion: totalQuestions,
                                questionCount: totalQuestions,
                                requiredCount: totalQuestions,
                                questionType: "mcq",
                                allowedQuestionTypes: ["mcq"],
                                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
                            }
                        ],
                        sourceReferences: [
                            "NTA NEET (UG) 2024 Information Bulletin (Chapter 3: Examination Scheme)"
                        ],
                        sourceProvenance: { ...registeredProfile.sourceProvenance },
                        verifiedAt: new Date().toISOString(),
                        schemaVersion: 1
                    };
                }
            }

            // Map declarative profile into API response contract
            const durationSeconds = extractedMetadata.durationSeconds?.value || registeredProfile.durationSeconds;
            const maxMarks = extractedMetadata.maximumMarks?.value || registeredProfile.maximumMarks;

            return {
                configId: registeredProfile.profileId,
                examId: registeredProfile.examId,
                examName: examName || registeredProfile.examName,
                year: registeredProfile.year,
                patternVersion: registeredProfile.patternVersion,
                status: registeredProfile.isOfficial ? "verified" : "draft",
                verificationStatus: registeredProfile.verificationStatus,
                isOfficial: registeredProfile.isOfficial,
                durationSeconds,
                totalQuestions: registeredProfile.totalQuestions,
                requiredQuestionsToAttempt: registeredProfile.requiredQuestionsToAttempt,
                maximumMarks: maxMarks,
                negativeMarkingEnabled: registeredProfile.negativeMarkingEnabled,
                allowedOptionCounts: [...registeredProfile.allowedOptionCounts],
                optionalQuestionPolicy: registeredProfile.optionalQuestionPolicy,
                droppedQuestionPolicy: registeredProfile.droppedQuestionPolicy,
                numberingRestartsPerSection: Boolean(registeredProfile.numberingRestartsPerSection),
                navigationRules: { ...registeredProfile.navigationRules },
                sections: registeredProfile.sections.map(s => ({
                    id: s.id,
                    name: s.name,
                    subject: s.subject,
                    startQuestion: s.startQuestion,
                    endQuestion: s.endQuestion,
                    questionCount: s.questionCount,
                    requiredCount: s.requiredCount,
                    questionType: s.questionType,
                    allowedQuestionTypes: s.allowedQuestionTypes || [s.questionType],
                    markingScheme: { ...s.markingScheme },
                    ...(s.optionalPolicy ? { optionalPolicy: { ...s.optionalPolicy } } : {}),
                    ...(s.numberingRestartsPerSection ? { numberingRestartsPerSection: true } : {}),
                    ...(s.durationSeconds ? { durationSeconds: s.durationSeconds } : {}),
                    ...(s.partialMarkingRules ? { partialMarkingRules: { ...s.partialMarkingRules } } : {})
                })),
                sourceReferences: [...registeredProfile.sourceReferences],
                sourceProvenance: { ...registeredProfile.sourceProvenance },
                verifiedAt: registeredProfile.verifiedAt || new Date().toISOString(),
                schemaVersion: 1
            };
        }

        // 2. Unregistered / Custom Examination Fallback
        // Do NOT apply generic NEET-style defaults (+4, -1) to unknown examinations.
        // Unknown new examinations require explicit administrative review.
        const extractedCorrect = extractedMetadata.markingScheme?.correct?.value;
        const extractedIncorrect = extractedMetadata.markingScheme?.incorrect?.value;
        const hasExplicitMarking = Number.isFinite(extractedCorrect) && Number.isFinite(extractedIncorrect);

        const totalQuestions = extractedMetadata.totalQuestions?.value || 100;
        const sections = extractedMetadata.sections && extractedMetadata.sections.length > 0
            ? extractedMetadata.sections
            : [
                {
                    id: "general_section",
                    name: "General Section",
                    subject: "General",
                    startQuestion: 1,
                    endQuestion: totalQuestions,
                    questionCount: totalQuestions,
                    requiredCount: totalQuestions,
                    questionType: "mcq",
                    markingScheme: {
                        correct: hasExplicitMarking ? extractedCorrect : 0,
                        incorrect: hasExplicitMarking ? extractedIncorrect : 0,
                        unanswered: 0
                    }
                }
            ];

        return {
            configId,
            examId: cleanExam,
            examName: examName || extractedMetadata.examName?.value || cleanExam.toUpperCase(),
            year: numYear,
            patternVersion: `${numYear}.draft`,
            status: "draft",
            verificationStatus: VERIFICATION_STATUS.CUSTOM_UNVERIFIED,
            isOfficial: false,
            requiresAdministrativeReview: true,
            reviewRequiredReason: "Unknown or unverified examination pattern requires explicit administrative review and profile verification.",
            durationSeconds: extractedMetadata.durationSeconds?.value || 10800,
            totalQuestions,
            requiredQuestionsToAttempt: totalQuestions,
            maximumMarks: extractedMetadata.maximumMarks?.value || (hasExplicitMarking ? totalQuestions * extractedCorrect : 100),
            negativeMarkingEnabled: hasExplicitMarking ? extractedIncorrect < 0 : false,
            allowedOptionCounts: [4],
            optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
            droppedQuestionPolicy: DROPPED_QUESTION_POLICY.ZERO_MARKS,
            navigationRules: {
                allowSectionSwitching: true,
                allowQuestionReview: true,
                strictTimer: true
            },
            sections,
            sourceReferences: ["Uploaded Unverified Exam Pattern Document"],
            sourceProvenance: {
                documentName: "Unregistered Custom Input",
                referenceId: "N/A",
                citation: "Awaiting administrative profile configuration and gazette verification"
            },
            verifiedAt: new Date().toISOString(),
            schemaVersion: 1
        };
    }

    /**
     * Helper to get pattern by examId (used in pipeline re-validation)
     */
    static getPattern(examId, year = 2024) {
        return this.getVerifiedPattern({ examId, year });
    }

    /**
     * Validate an extracted question set against the verified pattern
     */
    static validateQuestionsAgainstPattern(questions, pattern) {
        const issues = [];
        const questionMap = new Map();
        const numberingRestarts = Boolean(pattern?.numberingRestartsPerSection);

        // Fail-Closed Gate: Deterministic uniqueness of questionId
        const seenQuestionIds = new Set();
        const duplicateQuestionIds = [];
        for (const q of (questions || [])) {
            if (q.questionId) {
                if (seenQuestionIds.has(q.questionId)) {
                    duplicateQuestionIds.push(q.questionId);
                }
                seenQuestionIds.add(q.questionId);
            }
        }
        if (duplicateQuestionIds.length > 0) {
            issues.push(`Duplicate questionId detected in question package: [${[...new Set(duplicateQuestionIds)].join(", ")}]`);
        }

        let missingNumbers = [];
        let unexpectedQuestions = [];
        const expectedTotal = pattern.totalQuestions || 200;

        if (!numberingRestarts) {
            questions.forEach(q => {
                if (questionMap.has(q.questionNumber)) {
                    issues.push(`Duplicate question number detected: Q${q.questionNumber}`);
                }
                questionMap.set(q.questionNumber, q);
            });

            // Check for missing questions in sequence
            for (let i = 1; i <= expectedTotal; i++) {
                if (!questionMap.has(i)) {
                    missingNumbers.push(i);
                }
            }

            if (missingNumbers.length > 0) {
                issues.push(`Missing ${missingNumbers.length} questions in sequence: [${missingNumbers.slice(0, 10).join(", ")}${missingNumbers.length > 10 ? '...' : ''}]`);
            }

            // Check for unexpected out-of-range question numbers (e.g. Q120 when exam has 75 questions)
            for (const [qNum] of questionMap.entries()) {
                if (qNum > expectedTotal) {
                    unexpectedQuestions.push(qNum);
                }
            }
            if (unexpectedQuestions.length > 0) {
                issues.push(`Unexpected question numbers beyond exam total of ${expectedTotal}: [${unexpectedQuestions.join(", ")}]`);
            }
        }

        // Validate section distribution and question types
        for (const section of (pattern.sections || [])) {
            let sectionCount = 0;
            if (numberingRestarts) {
                const sectionQuestions = questions.filter(q => (q.subject && q.subject === section.subject) || (q.sectionId && q.sectionId === section.id));
                sectionCount = sectionQuestions.length;
                const seenSecNums = new Set();
                for (const q of sectionQuestions) {
                    if (seenSecNums.has(q.questionNumber)) {
                        issues.push(`Duplicate question number detected in section '${section.name || section.id}': Q${q.questionNumber}`);
                    }
                    seenSecNums.add(q.questionNumber);
                    if (section.questionType === "mcq" && q.questionType === "mcq") {
                        if (!Array.isArray(q.options) || q.options.length < 2) {
                            issues.push(`Question Q${q.questionNumber} in ${section.name} is missing options (expected 4 options, found ${q.options?.length || 0})`);
                        }
                    }
                }
            } else {
                for (let qNum = section.startQuestion; qNum <= section.endQuestion; qNum++) {
                    const q = questionMap.get(qNum);
                    if (q) {
                        sectionCount++;
                        // Check question type specific requirements
                        if (section.questionType === "mcq" && q.questionType === "mcq") {
                            if (!Array.isArray(q.options) || q.options.length < 2) {
                                issues.push(`Question Q${qNum} in ${section.name} is missing options (expected 4 options, found ${q.options?.length || 0})`);
                            }
                        }
                    }
                }
            }
            if (sectionCount < section.questionCount) {
                issues.push(`Section ${section.name} expected ${section.questionCount} questions, but only ${sectionCount} were extracted`);
            }
        }

        return {
            valid: issues.length === 0,
            issues,
            totalExpected: expectedTotal,
            totalPresent: questions.length,
            missingCount: missingNumbers.length,
            unexpectedCount: unexpectedQuestions.length
        };
    }
}
