/**
 * Universal Examination Architecture — Exam Profile Registry
 * 
 * Authoritative, declarative registry of year-specific examination profiles.
 * Provides fail-closed profile resolution, strict schema validation, 
 * and transparent source provenance tracking.
 * 
 * Conforms to Universal Examination Architecture Specification v2.8.
 */

/**
 * Valid verification statuses
 */
export const VERIFICATION_STATUS = Object.freeze({
    VERIFIED_OFFICIAL: "verified_official",
    UNVERIFIED_ARCHETYPE: "unverified_archetype",
    CUSTOM_UNVERIFIED: "custom_unverified"
});

/**
 * Valid optional question policies
 */
export const OPTIONAL_QUESTION_POLICY = Object.freeze({
    NONE: "none",
    FIRST_K_ATTEMPTED: "first_k_attempted",
    CANDIDATE_SELECTED: "candidate_selected",
    REJECT_EXCESS_ATTEMPTS: "reject_excess_attempts",
    PROFILE_DEFINED: "profile_defined"
});

/**
 * Valid dropped question policies
 */
export const DROPPED_QUESTION_POLICY = Object.freeze({
    FULL_MARKS: "full_marks",
    PRO_RATA: "pro_rata",
    ATTEMPTED_ONLY: "attempted_only",
    ZERO_MARKS: "zero_marks"
});

/**
 * Valid question types
 */
export const QUESTION_TYPES = Object.freeze([
    "mcq",
    "msq",
    "numerical",
    "nat",
    "numerical_nat",
    "descriptive",
    "mixed"
]);

/**
 * The 10 Audited Examination Profiles (Phase 2.8 Design Baseline)
 */
const AUDITED_EXAM_PROFILES = Object.freeze({
    // 1A. UPSC Civil Services Preliminary 2024
    "upsc-prelims-2024": {
        profileId: "upsc-prelims-2024",
        examId: "upsc-prelims",
        examName: "Union Public Service Commission (UPSC Civil Services Preliminary Paper I)",
        year: 2024,
        patternVersion: "2024.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 100,
        requiredQuestionsToAttempt: 100,
        maximumMarks: 200,
        durationSeconds: 7200,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.PRO_RATA,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "general_studies",
                name: "General Studies Paper I",
                subject: "General Studies",
                startQuestion: 1,
                endQuestion: 100,
                questionCount: 100,
                requiredCount: 100,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 2, incorrect: -2 / 3, unanswered: 0 }
            }
        ],
        sourceReferences: [
            "UPSC Civil Services Examination Gazette Notification No. 05/2024-CSP",
            "Union Public Service Commission Examination Regulations"
        ],
        sourceProvenance: {
            documentName: "UPSC Civil Services Examination Gazette Notification No. 05/2024-CSP",
            referenceId: "media_1794128311419_d4db3344.pdf / Gazette No. 05/2024-CSP",
            citation: "Section II, Sub-section A, Pages 19-21; Question Booklet Rules 1-8",
            evidenceNotes: "100 Objective MCQs, 200 Marks, 2 Hours. Marking: +2 correct, -2/3 penalty. Cancelled questions excluded from evaluation; marks rescaled to 200 base."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 1B. UPSC Civil Services Preliminary 2026
    "upsc-prelims-2026": {
        profileId: "upsc-prelims-2026",
        examId: "upsc-prelims",
        examName: "Union Public Service Commission (UPSC Civil Services Preliminary Paper I)",
        year: 2026,
        patternVersion: "2026.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 100,
        requiredQuestionsToAttempt: 100,
        maximumMarks: 200,
        durationSeconds: 7200,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.PRO_RATA,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "general_studies",
                name: "General Studies Paper I",
                subject: "General Studies",
                startQuestion: 1,
                endQuestion: 100,
                questionCount: 100,
                requiredCount: 100,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 2, incorrect: -2 / 3, unanswered: 0 }
            }
        ],
        sourceReferences: [
            "UPSC Civil Services Examination Blueprint — Preliminary Examination (Paper I)",
            "Union Public Service Commission Examination Regulations"
        ],
        sourceProvenance: {
            documentName: "UPSC Civil Services Examination Gazette Notification & Blueprint 2026",
            referenceId: "UPSC_Prelims_2026_Paper_I_Typed.pdf",
            citation: "Section II, Sub-section A, Pages 19-21; Question Booklet Rules 1-8",
            evidenceNotes: "100 Objective MCQs, 200 Marks, 2 Hours. Marking: +2 correct, -2/3 penalty. Pro-rata dropped question rescaling."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 2. BPSC 69th Combined Competitive Examination (Prelims 2023)
    "bpsc-69th-2023": {
        profileId: "bpsc-69th-2023",
        examId: "bpsc",
        examName: "Bihar Public Service Commission (BPSC 69th Integrated CCE Prelims)",
        year: 2023,
        patternVersion: "2023.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 150,
        requiredQuestionsToAttempt: 150,
        maximumMarks: 150,
        durationSeconds: 7200,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "general_studies",
                name: "General Studies",
                subject: "General Studies",
                startQuestion: 1,
                endQuestion: 150,
                questionCount: 150,
                requiredCount: 150,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 1, incorrect: -1 / 3, unanswered: 0 }
            }
        ],
        sourceReferences: [
            "BPSC 69th Integrated Combined (Preliminary) Competitive Examination Scheme & Pattern",
            "Bihar Public Service Commission Examination Regulations"
        ],
        sourceProvenance: {
            documentName: "BPSC Integrated 69th CCE Official Advertisement No. 23/2023",
            referenceId: "69TH PRELIMS M1.pdf / Advt No. 23/2023",
            citation: "Paragraph 7 (Selection Procedure), Sub-para (i), Page 4",
            evidenceNotes: "150 Objective MCQs, 150 Marks, 2 Hours. Marking: +1 correct, -1/3 penalty. Exactly 4 options (A-D) per question. Legacy 5-option format marked OUTDATED."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 3A. JEE Main 2024
    "jee-main-2024": {
        profileId: "jee-main-2024",
        examId: "jee-main",
        examName: "Joint Entrance Examination (JEE Main Paper 1 - B.E./B.Tech)",
        year: 2024,
        patternVersion: "2024.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 90,
        requiredQuestionsToAttempt: 75,
        maximumMarks: 300,
        durationSeconds: 10800,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4, 0],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.FIRST_K_ATTEMPTED,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "math_a",
                name: "Mathematics - Section A",
                subject: "Mathematics",
                startQuestion: 1,
                endQuestion: 20,
                questionCount: 20,
                requiredCount: 20,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "math_b",
                name: "Mathematics - Section B",
                subject: "Mathematics",
                startQuestion: 21,
                endQuestion: 30,
                questionCount: 10,
                requiredCount: 5,
                questionType: "numerical",
                allowedQuestionTypes: ["numerical"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 },
                optionalPolicy: { type: "first_k_attempted", maxAttempts: 5 }
            },
            {
                id: "physics_a",
                name: "Physics - Section A",
                subject: "Physics",
                startQuestion: 31,
                endQuestion: 50,
                questionCount: 20,
                requiredCount: 20,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "physics_b",
                name: "Physics - Section B",
                subject: "Physics",
                startQuestion: 51,
                endQuestion: 60,
                questionCount: 10,
                requiredCount: 5,
                questionType: "numerical",
                allowedQuestionTypes: ["numerical"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 },
                optionalPolicy: { type: "first_k_attempted", maxAttempts: 5 }
            },
            {
                id: "chemistry_a",
                name: "Chemistry - Section A",
                subject: "Chemistry",
                startQuestion: 61,
                endQuestion: 80,
                questionCount: 20,
                requiredCount: 20,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "chemistry_b",
                name: "Chemistry - Section B",
                subject: "Chemistry",
                startQuestion: 81,
                endQuestion: 90,
                questionCount: 10,
                requiredCount: 5,
                questionType: "numerical",
                allowedQuestionTypes: ["numerical"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 },
                optionalPolicy: { type: "first_k_attempted", maxAttempts: 5 }
            }
        ],
        sourceReferences: [
            "NTA JEE (Main) 2024 Information Bulletin (jeemain.nta.nic.in)"
        ],
        sourceProvenance: {
            documentName: "NTA JEE (Main) 2024 Information Bulletin",
            referenceId: "NTA Bulletin 2024",
            citation: "Chapter 3, Sub-sections 3.1 & 3.2, Pages 15-17",
            evidenceNotes: "75 questions attempted out of 90, 300 Marks, 3 Hours. Sec A: 20 MCQs (+4, -1). Sec B: 10 NATs (attempt any 5, +4, -1). First 5 attempted evaluated in Section B."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 3B. JEE Main 2026 (Compulsory Section B — Optionals Retired by NTA)
    "jee-main-2026": {
        profileId: "jee-main-2026",
        examId: "jee-main",
        examName: "Joint Entrance Examination (JEE Main Paper 1 - B.E./B.Tech)",
        year: 2026,
        patternVersion: "2026.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 75,
        requiredQuestionsToAttempt: 75,
        maximumMarks: 300,
        durationSeconds: 10800,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4, 0],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "math_a",
                name: "Mathematics - Section A",
                subject: "Mathematics",
                startQuestion: 1,
                endQuestion: 20,
                questionCount: 20,
                requiredCount: 20,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "math_b",
                name: "Mathematics - Section B",
                subject: "Mathematics",
                startQuestion: 21,
                endQuestion: 25,
                questionCount: 5,
                requiredCount: 5,
                questionType: "numerical",
                allowedQuestionTypes: ["numerical"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "physics_a",
                name: "Physics - Section A",
                subject: "Physics",
                startQuestion: 26,
                endQuestion: 45,
                questionCount: 20,
                requiredCount: 20,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "physics_b",
                name: "Physics - Section B",
                subject: "Physics",
                startQuestion: 46,
                endQuestion: 50,
                questionCount: 5,
                requiredCount: 5,
                questionType: "numerical",
                allowedQuestionTypes: ["numerical"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "chemistry_a",
                name: "Chemistry - Section A",
                subject: "Chemistry",
                startQuestion: 51,
                endQuestion: 70,
                questionCount: 20,
                requiredCount: 20,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "chemistry_b",
                name: "Chemistry - Section B",
                subject: "Chemistry",
                startQuestion: 71,
                endQuestion: 75,
                questionCount: 5,
                requiredCount: 5,
                questionType: "numerical",
                allowedQuestionTypes: ["numerical"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            }
        ],
        sourceReferences: [
            "NTA JEE (Main) 2026 Information Bulletin (jeemain.nta.nic.in)"
        ],
        sourceProvenance: {
            documentName: "NTA JEE (Main) 2026 Information Bulletin",
            referenceId: "NTA Bulletin 2026 / jeemain.nta.nic.in",
            citation: "Chapter 3, Sub-sections 3.1 & 3.2, Pages 15-17",
            evidenceNotes: "75 questions total (all compulsory), 300 Marks, 3 Hours. Optional questions in Section B discontinued starting JEE Main 2025/2026."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 4. NEET UG 2024
    "neet-ug-2024": {
        profileId: "neet-ug-2024",
        examId: "neet-ug",
        examName: "National Eligibility Cum Entrance Test (NEET UG)",
        year: 2024,
        patternVersion: "2024.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 200,
        requiredQuestionsToAttempt: 180,
        maximumMarks: 720,
        durationSeconds: 12000,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.FIRST_K_ATTEMPTED,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
        numberingRestartsPerSection: false,
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
                endQuestion: 35,
                questionCount: 35,
                requiredCount: 35,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "physics_b",
                name: "Physics - Section B",
                subject: "Physics",
                startQuestion: 36,
                endQuestion: 50,
                questionCount: 15,
                requiredCount: 10,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 },
                optionalPolicy: { type: "first_k_attempted", maxAttempts: 10 }
            },
            {
                id: "chemistry_a",
                name: "Chemistry - Section A",
                subject: "Chemistry",
                startQuestion: 51,
                endQuestion: 85,
                questionCount: 35,
                requiredCount: 35,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "chemistry_b",
                name: "Chemistry - Section B",
                subject: "Chemistry",
                startQuestion: 86,
                endQuestion: 100,
                questionCount: 15,
                requiredCount: 10,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 },
                optionalPolicy: { type: "first_k_attempted", maxAttempts: 10 }
            },
            {
                id: "botany_a",
                name: "Botany - Section A",
                subject: "Botany",
                startQuestion: 101,
                endQuestion: 135,
                questionCount: 35,
                requiredCount: 35,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "botany_b",
                name: "Botany - Section B",
                subject: "Botany",
                startQuestion: 136,
                endQuestion: 150,
                questionCount: 15,
                requiredCount: 10,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 },
                optionalPolicy: { type: "first_k_attempted", maxAttempts: 10 }
            },
            {
                id: "zoology_a",
                name: "Zoology - Section A",
                subject: "Zoology",
                startQuestion: 151,
                endQuestion: 185,
                questionCount: 35,
                requiredCount: 35,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 }
            },
            {
                id: "zoology_b",
                name: "Zoology - Section B",
                subject: "Zoology",
                startQuestion: 186,
                endQuestion: 200,
                questionCount: 15,
                requiredCount: 10,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 },
                optionalPolicy: { type: "first_k_attempted", maxAttempts: 10 }
            }
        ],
        sourceReferences: [
            "NTA NEET (UG) 2024 Information Bulletin (Chapter 3: Examination Scheme)"
        ],
        sourceProvenance: {
            documentName: "NTA NEET (UG) 2024 Information Bulletin",
            referenceId: "tests/fixtures/synthetic_neet_2024_pattern.pdf / NTA Bulletin",
            citation: "Chapter 3, Section 3.2 (Test Pattern), Pages 16-18",
            evidenceNotes: "200 Qs total, 180 required, 720 Marks, 200 minutes. Sec A: 35 MCQs compulsory (+4, -1). Sec B: 15 MCQs (attempt any 10, +4, -1). First 10 evaluated."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 5. GATE Computer Science 2024
    "gate-cs-2024": {
        profileId: "gate-cs-2024",
        examId: "gate",
        examName: "Graduate Aptitude Test in Engineering (GATE Computer Science & IT)",
        year: 2024,
        patternVersion: "2024.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 65,
        requiredQuestionsToAttempt: 65,
        maximumMarks: 100,
        durationSeconds: 10800,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4, 0],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "ga_section",
                name: "General Aptitude (GA)",
                subject: "General Aptitude",
                startQuestion: 1,
                endQuestion: 10,
                questionCount: 10,
                requiredCount: 10,
                questionType: "mixed",
                allowedQuestionTypes: ["mcq", "msq", "numerical"],
                questionTypeRules: {
                    mcq: { correct: 1, incorrect: -1 / 3 },
                    msq: { correct: 1, incorrect: 0 },
                    numerical: { correct: 1, incorrect: 0 },
                    nat: { correct: 1, incorrect: 0 }
                },
                markingScheme: { correct: 1, incorrect: -1 / 3, unanswered: 0 }
            },
            {
                id: "core_section",
                name: "Core Subject Technical",
                subject: "Computer Science & IT",
                startQuestion: 11,
                endQuestion: 65,
                questionCount: 55,
                requiredCount: 55,
                questionType: "mixed",
                allowedQuestionTypes: ["mcq", "msq", "numerical"],
                questionTypeRules: {
                    mcq: { correct: 2, incorrect: -2 / 3 },
                    msq: { correct: 2, incorrect: 0 },
                    numerical: { correct: 2, incorrect: 0 },
                    nat: { correct: 2, incorrect: 0 }
                },
                markingScheme: { correct: 2, incorrect: -2 / 3, unanswered: 0 }
            }
        ],
        sourceReferences: [
            "GATE 2024 Official Information Brochure (IISc Bangalore)"
        ],
        sourceProvenance: {
            documentName: "GATE 2024 Information Brochure (IISc Bangalore)",
            referenceId: "GATE 2024 Brochure & IISc Portal",
            citation: "Section 5 (Pattern of Examination), Pages 22-25",
            evidenceNotes: "65 Qs, 100 Marks, 3 Hours. GA: 5 of 1-m, 5 of 2-m (15 marks). CS: 25 of 1-m, 30 of 2-m (85 marks). MCQ: 1-m (-1/3), 2-m (-2/3). MSQ & NAT: ZERO negative."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 5B. GATE Computer Science 2026
    "gate-cs-2026": {
        profileId: "gate-cs-2026",
        examId: "gate",
        examName: "Graduate Aptitude Test in Engineering (GATE 2026 Computer Science & IT)",
        year: 2026,
        patternVersion: "2026.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 65,
        requiredQuestionsToAttempt: 65,
        maximumMarks: 100,
        durationSeconds: 10800,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4, 0],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "ga_section",
                name: "General Aptitude (GA)",
                subject: "General Aptitude",
                startQuestion: 1,
                endQuestion: 10,
                questionCount: 10,
                requiredCount: 10,
                questionType: "mixed",
                allowedQuestionTypes: ["mcq", "msq", "numerical", "nat", "numerical_nat"],
                questionTypeRules: {
                    mcq: { correct: 1, incorrect: -1 / 3 },
                    msq: { correct: 1, incorrect: 0 },
                    numerical: { correct: 1, incorrect: 0 },
                    nat: { correct: 1, incorrect: 0 },
                    numerical_nat: { correct: 1, incorrect: 0 }
                },
                markingScheme: { correct: 1, incorrect: -1 / 3, unanswered: 0 }
            },
            {
                id: "core_section",
                name: "Core Subject Technical",
                subject: "Computer Science & IT",
                startQuestion: 11,
                endQuestion: 65,
                questionCount: 55,
                requiredCount: 55,
                questionType: "mixed",
                allowedQuestionTypes: ["mcq", "msq", "numerical", "nat", "numerical_nat"],
                questionTypeRules: {
                    mcq: { correct: 2, incorrect: -2 / 3 },
                    msq: { correct: 2, incorrect: 0 },
                    numerical: { correct: 2, incorrect: 0 },
                    nat: { correct: 2, incorrect: 0 },
                    numerical_nat: { correct: 2, incorrect: 0 }
                },
                markingScheme: { correct: 2, incorrect: -2 / 3, unanswered: 0 }
            }
        ],
        sourceReferences: [
            "GATE 2026 Official Information Brochure & Examination Pattern"
        ],
        sourceProvenance: {
            documentName: "GATE 2026 CS Examination Pattern",
            referenceId: "uploads/vault/d0652cb155e3fa4f_1794821380657_GATE_2026_CS_Exam_Pattern.pdf",
            citation: "Pattern of Examination, Pages 1-3",
            evidenceNotes: "65 Qs, 100 Marks, 3 Hours. GA: 5 of 1-m, 5 of 2-m (15 marks). CS: 25 of 1-m, 30 of 2-m (85 marks). MCQ: 1-m (-1/3), 2-m (-2/3). MSQ & NAT: ZERO negative."
        },
        verifiedAt: "2026-11-16T00:00:00.000Z",
        schemaVersion: 2
    },

    // 6. SSC CGL Tier I 2024
    "ssc-cgl-2024": {
        profileId: "ssc-cgl-2024",
        examId: "ssc-cgl",
        examName: "Staff Selection Commission - Combined Graduate Level (SSC CGL Tier I)",
        year: 2024,
        patternVersion: "2024.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 100,
        requiredQuestionsToAttempt: 100,
        maximumMarks: 200,
        durationSeconds: 3600,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.PRO_RATA,
        numberingRestartsPerSection: true,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "general_intelligence",
                name: "General Intelligence & Reasoning",
                subject: "Reasoning",
                startQuestion: 1,
                endQuestion: 25,
                questionCount: 25,
                requiredCount: 25,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 2, incorrect: -0.5, unanswered: 0 },
                numberingRestartsPerSection: true
            },
            {
                id: "general_awareness",
                name: "General Awareness",
                subject: "General Awareness",
                startQuestion: 1,
                endQuestion: 25,
                questionCount: 25,
                requiredCount: 25,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 2, incorrect: -0.5, unanswered: 0 },
                numberingRestartsPerSection: true
            },
            {
                id: "quantitative_aptitude",
                name: "Quantitative Aptitude",
                subject: "Quantitative Aptitude",
                startQuestion: 1,
                endQuestion: 25,
                questionCount: 25,
                requiredCount: 25,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 2, incorrect: -0.5, unanswered: 0 },
                numberingRestartsPerSection: true
            },
            {
                id: "english_comprehension",
                name: "English Comprehension",
                subject: "English",
                startQuestion: 1,
                endQuestion: 25,
                questionCount: 25,
                requiredCount: 25,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 2, incorrect: -0.5, unanswered: 0 },
                numberingRestartsPerSection: true
            }
        ],
        sourceReferences: [
            "SSC CGL Examination Notice 2024 (Doc No. 3-1/2024-P&P-I)"
        ],
        sourceProvenance: {
            documentName: "SSC CGL Examination Notice 2024",
            referenceId: "Doc No. 3-1/2024-P&P-I",
            citation: "Section 13 (Scheme of Tier I), Pages 14-16",
            evidenceNotes: "100 Qs across 4 sections (25 Qs each), 200 Marks, 60 Min. Marking: +2 correct, -0.5 incorrect. Question numbering restarts at Q1-25 in each section."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 7. Banking IBPS PO Prelims 2024
    "banking-ibps-po-2024": {
        profileId: "banking-ibps-po-2024",
        examId: "banking-ibps-po",
        examName: "Institute of Banking Personnel Selection - Probationary Officers (IBPS PO Prelims)",
        year: 2024,
        patternVersion: "2024.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 100,
        requiredQuestionsToAttempt: 100,
        maximumMarks: 100,
        durationSeconds: 3600,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [5],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.PRO_RATA,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: false,
            allowQuestionReview: true,
            strictTimer: true,
            enforceSectionTimer: true
        },
        sections: [
            {
                id: "english_language",
                name: "English Language",
                subject: "English",
                startQuestion: 1,
                endQuestion: 30,
                questionCount: 30,
                requiredCount: 30,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 1, incorrect: -0.25, unanswered: 0 },
                durationSeconds: 1200
            },
            {
                id: "quantitative_aptitude",
                name: "Quantitative Aptitude",
                subject: "Quantitative Aptitude",
                startQuestion: 31,
                endQuestion: 65,
                questionCount: 35,
                requiredCount: 35,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 1, incorrect: -0.25, unanswered: 0 },
                durationSeconds: 1200
            },
            {
                id: "reasoning_ability",
                name: "Reasoning Ability",
                subject: "Reasoning",
                startQuestion: 66,
                endQuestion: 100,
                questionCount: 35,
                requiredCount: 35,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 1, incorrect: -0.25, unanswered: 0 },
                durationSeconds: 1200
            }
        ],
        sourceReferences: [
            "IBPS CWE PO/MT-XIV Official Advertisement 2024"
        ],
        sourceProvenance: {
            documentName: "IBPS CWE PO/MT-XIV Official Advertisement 2024",
            referenceId: "IBPS PO Notification 2024",
            citation: "Section 4 (Structure of Examination), Page 7",
            evidenceNotes: "100 Qs across 3 sections: English (30), Quant (35), Reasoning (35). 100 Marks, 60 Min. Sectional Timing: 20 min per section; switching prohibited. Exactly 5 options (A-E)."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 8. JEE Advanced 2024 (Paper 1 - 2024 Edition Only)
    "jee-advanced-2024": {
        profileId: "jee-advanced-2024",
        examId: "jee-advanced",
        examName: "Joint Entrance Examination Advanced (JEE Advanced Paper 1 - 2024 Edition)",
        year: 2024,
        patternVersion: "2024.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 51,
        requiredQuestionsToAttempt: 51,
        maximumMarks: 180,
        durationSeconds: 10800,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4, 0],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "physics_sec1",
                name: "Physics - Section 1 (Single Choice)",
                subject: "Physics",
                startQuestion: 1,
                endQuestion: 4,
                questionCount: 4,
                requiredCount: 4,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 3, incorrect: -1, unanswered: 0 }
            },
            {
                id: "physics_sec2",
                name: "Physics - Section 2 (MSQ Partial Marking)",
                subject: "Physics",
                startQuestion: 5,
                endQuestion: 7,
                questionCount: 3,
                requiredCount: 3,
                questionType: "msq",
                allowedQuestionTypes: ["msq"],
                markingScheme: { correct: 4, incorrect: -2, unanswered: 0 },
                partialMarkingRules: {
                    allCorrect: 4,
                    threeOfFour: 3,
                    twoOfThreeOrFour: 2,
                    oneOfTwoOrMore: 1,
                    anyIncorrect: -2
                }
            },
            {
                id: "physics_sec3",
                name: "Physics - Section 3 (Numerical Non-Negative)",
                subject: "Physics",
                startQuestion: 8,
                endQuestion: 13,
                questionCount: 6,
                requiredCount: 6,
                questionType: "numerical",
                allowedQuestionTypes: ["numerical"],
                markingScheme: { correct: 4, incorrect: 0, unanswered: 0 }
            },
            {
                id: "physics_sec4",
                name: "Physics - Section 4 (Match List)",
                subject: "Physics",
                startQuestion: 14,
                endQuestion: 17,
                questionCount: 4,
                requiredCount: 4,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 3, incorrect: -1, unanswered: 0 }
            },
            {
                id: "chemistry_sec1",
                name: "Chemistry - Section 1 (Single Choice)",
                subject: "Chemistry",
                startQuestion: 18,
                endQuestion: 21,
                questionCount: 4,
                requiredCount: 4,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 3, incorrect: -1, unanswered: 0 }
            },
            {
                id: "chemistry_sec2",
                name: "Chemistry - Section 2 (MSQ Partial Marking)",
                subject: "Chemistry",
                startQuestion: 22,
                endQuestion: 24,
                questionCount: 3,
                requiredCount: 3,
                questionType: "msq",
                allowedQuestionTypes: ["msq"],
                markingScheme: { correct: 4, incorrect: -2, unanswered: 0 }
            },
            {
                id: "chemistry_sec3",
                name: "Chemistry - Section 3 (Numerical Non-Negative)",
                subject: "Chemistry",
                startQuestion: 25,
                endQuestion: 30,
                questionCount: 6,
                requiredCount: 6,
                questionType: "numerical",
                allowedQuestionTypes: ["numerical"],
                markingScheme: { correct: 4, incorrect: 0, unanswered: 0 }
            },
            {
                id: "chemistry_sec4",
                name: "Chemistry - Section 4 (Match List)",
                subject: "Chemistry",
                startQuestion: 31,
                endQuestion: 34,
                questionCount: 4,
                requiredCount: 4,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 3, incorrect: -1, unanswered: 0 }
            },
            {
                id: "math_sec1",
                name: "Mathematics - Section 1 (Single Choice)",
                subject: "Mathematics",
                startQuestion: 35,
                endQuestion: 38,
                questionCount: 4,
                requiredCount: 4,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 3, incorrect: -1, unanswered: 0 }
            },
            {
                id: "math_sec2",
                name: "Mathematics - Section 2 (MSQ Partial Marking)",
                subject: "Mathematics",
                startQuestion: 39,
                endQuestion: 41,
                questionCount: 3,
                requiredCount: 3,
                questionType: "msq",
                allowedQuestionTypes: ["msq"],
                markingScheme: { correct: 4, incorrect: -2, unanswered: 0 }
            },
            {
                id: "math_sec3",
                name: "Mathematics - Section 3 (Numerical Non-Negative)",
                subject: "Mathematics",
                startQuestion: 42,
                endQuestion: 47,
                questionCount: 6,
                requiredCount: 6,
                questionType: "numerical",
                allowedQuestionTypes: ["numerical"],
                markingScheme: { correct: 4, incorrect: 0, unanswered: 0 }
            },
            {
                id: "math_sec4",
                name: "Mathematics - Section 4 (Match List)",
                subject: "Mathematics",
                startQuestion: 48,
                endQuestion: 51,
                questionCount: 4,
                requiredCount: 4,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 3, incorrect: -1, unanswered: 0 }
            }
        ],
        sourceReferences: [
            "JEE (Advanced) Information Brochure 2024 (IIT Madras)"
        ],
        sourceProvenance: {
            documentName: "JEE (Advanced) Information Brochure 2024 (IIT Madras)",
            referenceId: "JEE Adv Brochure 2024",
            citation: "Chapter 5 (Pattern of Examination), Pages 30-34",
            evidenceNotes: "51 Qs, 180 Marks, 3 Hours. Single Choice (+3, -1), MSQ (+4 full, partial +3/+2/+1, -2 wrong), Numerical (+4, 0). Verified for 2024 edition only due to annual pattern variability."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 9. CUET UG Domain Paper 2024
    "cuet-ug-2024": {
        profileId: "cuet-ug-2024",
        examId: "cuet",
        examName: "Common University Entrance Test (CUET UG Domain Subject)",
        year: 2024,
        patternVersion: "2024.1",
        verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
        isOfficial: true,
        totalQuestions: 50,
        requiredQuestionsToAttempt: 40,
        maximumMarks: 200,
        durationSeconds: 2700,
        negativeMarkingEnabled: true,
        allowedOptionCounts: [4],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.FIRST_K_ATTEMPTED,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "domain_section",
                name: "Domain Subject Section",
                subject: "Domain",
                startQuestion: 1,
                endQuestion: 50,
                questionCount: 50,
                requiredCount: 40,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 5, incorrect: -1, unanswered: 0 },
                optionalPolicy: { type: "first_k_attempted", maxAttempts: 40 }
            }
        ],
        sourceReferences: [
            "NTA CUET (UG) Information Bulletin 2024"
        ],
        sourceProvenance: {
            documentName: "NTA CUET (UG) Information Bulletin 2024",
            referenceId: "NTA CUET Bulletin 2024",
            citation: "Chapter 2 (Scheme of Examination), Section 2.3, Pages 10-13",
            evidenceNotes: "50 Qs per domain paper, attempt any 40. 200 Marks (+5, -1), 45 Min. Dropped: +5 awarded to all who attempted."
        },
        verifiedAt: "2026-11-09T00:00:00.000Z",
        schemaVersion: 2
    },

    // 10. State University Semester Exam Default Archetype (UNVERIFIED)
    "university-semester-default": {
        profileId: "university-semester-default",
        examId: "university-semester",
        examName: "State University Semester Examination (Illustrative Archetype)",
        year: 2024,
        patternVersion: "archetype.1",
        verificationStatus: VERIFICATION_STATUS.UNVERIFIED_ARCHETYPE,
        isOfficial: false,
        totalQuestions: 100,
        requiredQuestionsToAttempt: 100,
        maximumMarks: 100,
        durationSeconds: 10800,
        negativeMarkingEnabled: false,
        allowedOptionCounts: [4],
        optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
        droppedQuestionPolicy: DROPPED_QUESTION_POLICY.ZERO_MARKS,
        numberingRestartsPerSection: false,
        navigationRules: {
            allowSectionSwitching: true,
            allowQuestionReview: true,
            strictTimer: true
        },
        sections: [
            {
                id: "general_section",
                name: "General Semester Section",
                subject: "General",
                startQuestion: 1,
                endQuestion: 100,
                questionCount: 100,
                requiredCount: 100,
                questionType: "mcq",
                allowedQuestionTypes: ["mcq"],
                markingScheme: { correct: 1, incorrect: 0, unanswered: 0 }
            }
        ],
        sourceReferences: [
            "None (No National Source Exists)"
        ],
        sourceProvenance: {
            documentName: "None (No National Source Exists)",
            referenceId: "N/A",
            citation: "N/A - State university patterns vary across CBCS, NEP 2020, and autonomous college syllabi",
            evidenceNotes: "UNSUPPORTED AS VERIFIED OFFICIAL. Illustrative archetype only. Requires explicit institutional configuration and admin verification."
        },
        verifiedAt: null,
        schemaVersion: 2
    }
});

/**
 * Normalizes input exam identity string for registry lookup
 */
function normalizeExamSlug(raw) {
    if (typeof raw !== "string") return "";
    return raw.toLowerCase().trim().replace(/[\s\-_]+/g, "-");
}

/**
 * Deep clones an object
 */
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Exam Profile Registry Service
 */
export class ExamProfileRegistry {

    // Internal profile store initialized with audited baseline profiles
    static _profiles = new Map(Object.entries(AUDITED_EXAM_PROFILES));

    /**
     * Look up an examination profile by exact profile ID.
     * 
     * @param {string} profileId - Canonical profile identifier (e.g. 'upsc-prelims-2024')
     * @param {Object} [options]
     * @param {boolean} [options.strict=false] - If true, throws UNRECOGNIZED_EXAM_PATTERN when not found
     * @returns {Object|null} Deep clone of the profile or null
     */
    static getProfile(profileId, { strict = false } = {}) {
        if (!profileId || typeof profileId !== "string") {
            if (strict) {
                throw new TypeError("Profile ID must be a non-empty string.");
            }
            return null;
        }

        const cleanId = profileId.trim();
        const profile = this._profiles.get(cleanId);

        if (!profile) {
            if (strict) {
                const err = new Error(`UNRECOGNIZED_EXAM_PATTERN: Profile '${cleanId}' is not registered.`);
                err.code = "UNRECOGNIZED_EXAM_PATTERN";
                throw err;
            }
            return null;
        }

        return deepClone(profile);
    }

    /**
     * Find a profile by exam family and year.
     * 
     * @param {string} examId - Exam family identifier or alias (e.g. 'upsc-prelims', 'jee-main', 'bpsc')
     * @param {number|string} year - Examination year (e.g. 2024, 2026)
     * @param {Object} [options]
     * @param {boolean} [options.strict=false] - If true, throws when not found
     * @returns {Object|null} Deep clone of matching profile or null
     */
    static findProfile(examId, year, { strict = false } = {}) {
        if (!examId || typeof examId !== "string" || !year) {
            if (strict) {
                const err = new Error("MISSING_EXAM_IDENTITY: Both examId and year are required for profile resolution.");
                err.code = "MISSING_EXAM_IDENTITY";
                throw err;
            }
            return null;
        }

        const numYear = Number(year);
        if (!Number.isInteger(numYear) || numYear < 2000 || numYear > 2100) {
            if (strict) {
                const err = new Error(`INVALID_YEAR: Year must be an integer between 2000 and 2100. Received: ${year}`);
                err.code = "INVALID_YEAR";
                throw err;
            }
            return null;
        }

        const slug = normalizeExamSlug(examId);

        // 1. Direct profileId match
        const directId = `${slug}-${numYear}`;
        if (this._profiles.has(directId)) {
            return deepClone(this._profiles.get(directId));
        }

        // 2. Exam alias mapping
        let canonicalFamily = slug;
        if (/^(upsc|upsc-prelims|union-public-service-commission)/.test(slug)) {
            canonicalFamily = "upsc-prelims";
        } else if (/^(bpsc|bihar-public-service-commission)/.test(slug)) {
            canonicalFamily = "bpsc";
        } else if (/^(jee-main|jee)/.test(slug) && !slug.includes("adv")) {
            canonicalFamily = "jee-main";
        } else if (/^(jee-adv|jee-advanced)/.test(slug)) {
            canonicalFamily = "jee-advanced";
        } else if (/^(neet|neet-ug|national-eligibility)/.test(slug)) {
            canonicalFamily = "neet-ug";
        } else if (/^gate/.test(slug)) {
            canonicalFamily = "gate-cs";
        } else if (/^(ssc|ssc-cgl)/.test(slug)) {
            canonicalFamily = "ssc-cgl";
        } else if (/^(banking|ibps|ibps-po|banking-ibps-po)/.test(slug)) {
            canonicalFamily = "banking-ibps-po";
        } else if (/^(cuet|cuet-ug)/.test(slug)) {
            canonicalFamily = "cuet-ug";
        } else if (/^(university|university-semester)/.test(slug)) {
            canonicalFamily = "university-semester-default";
        }

        // Try mapped candidate IDs
        const candidateKeys = [
            `${canonicalFamily}-${numYear}`,
            canonicalFamily,
            // Specific known variant IDs
            canonicalFamily === "bpsc" && numYear === 2023 ? "bpsc-69th-2023" : null,
            canonicalFamily === "gate-cs" ? `gate-cs-${numYear}` : null,
            canonicalFamily === "gate-cs" ? "gate-cs-2024" : null,
            canonicalFamily === "university-semester-default" ? "university-semester-default" : null
        ].filter(Boolean);

        for (const key of candidateKeys) {
            if (this._profiles.has(key)) {
                return deepClone(this._profiles.get(key));
            }
        }

        // Search through profiles where examId and year match
        for (const profile of this._profiles.values()) {
            if (profile.examId === canonicalFamily && profile.year === numYear) {
                return deepClone(profile);
            }
            if (profile.examId === slug && profile.year === numYear) {
                return deepClone(profile);
            }
        }

        if (strict) {
            const err = new Error(`UNRECOGNIZED_EXAM_PATTERN: No registered exam profile found for '${examId}' (${year}).`);
            err.code = "UNRECOGNIZED_EXAM_PATTERN";
            throw err;
        }

        return null;
    }

    /**
     * Check if a profile exists
     */
    static hasProfile(profileId) {
        if (!profileId || typeof profileId !== "string") return false;
        return this._profiles.has(profileId.trim());
    }

    /**
     * List registered profiles
     * 
     * @param {Object} [filter]
     * @param {string} [filter.verificationStatus] - Optional filter by status
     * @returns {Object[]}
     */
    static listProfiles({ verificationStatus } = {}) {
        const list = Array.from(this._profiles.values()).map(deepClone);
        if (verificationStatus) {
            return list.filter(p => p.verificationStatus === verificationStatus);
        }
        return list;
    }

    /**
     * Check if a profile is officially verified
     */
    static isOfficialVerified(profileId) {
        const p = this.getProfile(profileId);
        return Boolean(p && p.verificationStatus === VERIFICATION_STATUS.VERIFIED_OFFICIAL && p.isOfficial === true);
    }

    /**
     * Register a new profile after strict schema validation
     * 
     * @param {Object} profile - Examination profile object
     * @returns {Object} Deep clone of registered profile
     */
    static registerProfile(profile) {
        this.validateProfileSchema(profile);

        // Security check: Cannot register as verified_official without official provenance
        if (profile.verificationStatus === VERIFICATION_STATUS.VERIFIED_OFFICIAL) {
            if (!profile.sourceProvenance || !profile.sourceProvenance.documentName || profile.sourceProvenance.documentName === "None" || profile.sourceProvenance.documentName === "N/A") {
                const err = new Error("SECURITY_BLOCKER: Profile claiming 'verified_official' status must provide valid official sourceProvenance.");
                err.code = "INVALID_OFFICIAL_PROVENANCE";
                throw err;
            }
        }

        const clone = deepClone(profile);
        this._profiles.set(clone.profileId, clone);
        return deepClone(clone);
    }

    /**
     * Validate an examination profile against the Universal Schema specification.
     * Throws descriptive Error on any violation.
     * 
     * @param {Object} profile
     * @returns {{ valid: boolean }}
     */
    static validateProfileSchema(profile) {
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
            const err = new Error("INVALID_PROFILE_SCHEMA: Profile must be a non-null object.");
            err.code = "INVALID_PROFILE_SCHEMA";
            throw err;
        }

        // 1. profileId
        if (typeof profile.profileId !== "string" || !/^[a-z0-9\-]{3,60}$/.test(profile.profileId)) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'profileId' must be a lowercase alphanumeric hyphenated slug (3-60 chars).");
            err.code = "INVALID_PROFILE_ID";
            throw err;
        }

        // 2. examId
        if (typeof profile.examId !== "string" || !/^[a-z0-9\-]{2,50}$/.test(profile.examId)) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'examId' must be a lowercase alphanumeric hyphenated slug (2-50 chars).");
            err.code = "INVALID_EXAM_ID";
            throw err;
        }

        // 3. examName
        if (typeof profile.examName !== "string" || profile.examName.trim().length < 3) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'examName' must be a non-empty string (>= 3 chars).");
            err.code = "INVALID_EXAM_NAME";
            throw err;
        }

        // 4. year
        if (!Number.isInteger(profile.year) || profile.year < 2000 || profile.year > 2100) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'year' must be an integer between 2000 and 2100.");
            err.code = "INVALID_YEAR";
            throw err;
        }

        // 5. patternVersion
        if (typeof profile.patternVersion !== "string" || !profile.patternVersion.trim()) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'patternVersion' must be a non-empty string.");
            err.code = "INVALID_PATTERN_VERSION";
            throw err;
        }

        // 6. verificationStatus
        const validStatuses = Object.values(VERIFICATION_STATUS);
        if (!validStatuses.includes(profile.verificationStatus)) {
            const err = new Error(`INVALID_PROFILE_SCHEMA: 'verificationStatus' must be one of [${validStatuses.join(", ")}].`);
            err.code = "INVALID_VERIFICATION_STATUS";
            throw err;
        }

        // 7. isOfficial
        if (typeof profile.isOfficial !== "boolean") {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'isOfficial' must be a boolean.");
            err.code = "INVALID_IS_OFFICIAL";
            throw err;
        }
        if (profile.isOfficial === true && profile.verificationStatus !== VERIFICATION_STATUS.VERIFIED_OFFICIAL) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'isOfficial' can only be true when verificationStatus is 'verified_official'.");
            err.code = "CONTRADICTORY_OFFICIAL_STATUS";
            throw err;
        }

        // 8. totalQuestions & requiredQuestionsToAttempt
        if (!Number.isInteger(profile.totalQuestions) || profile.totalQuestions < 1) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'totalQuestions' must be a positive integer.");
            err.code = "INVALID_TOTAL_QUESTIONS";
            throw err;
        }
        if (!Number.isInteger(profile.requiredQuestionsToAttempt) || profile.requiredQuestionsToAttempt < 1) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'requiredQuestionsToAttempt' must be a positive integer.");
            err.code = "INVALID_REQUIRED_QUESTIONS";
            throw err;
        }
        if (profile.requiredQuestionsToAttempt > profile.totalQuestions) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'requiredQuestionsToAttempt' cannot exceed 'totalQuestions'.");
            err.code = "EXCESS_REQUIRED_QUESTIONS";
            throw err;
        }

        // 9. maximumMarks & durationSeconds
        if (!Number.isFinite(profile.maximumMarks) || profile.maximumMarks <= 0) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'maximumMarks' must be a positive number.");
            err.code = "INVALID_MAXIMUM_MARKS";
            throw err;
        }
        if (!Number.isInteger(profile.durationSeconds) || profile.durationSeconds <= 0) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'durationSeconds' must be a positive integer.");
            err.code = "INVALID_DURATION";
            throw err;
        }

        // 10. negativeMarkingEnabled
        if (typeof profile.negativeMarkingEnabled !== "boolean") {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'negativeMarkingEnabled' must be a boolean.");
            err.code = "INVALID_NEGATIVE_MARKING_FLAG";
            throw err;
        }

        // 11. allowedOptionCounts
        if (!Array.isArray(profile.allowedOptionCounts) || profile.allowedOptionCounts.length === 0) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'allowedOptionCounts' must be a non-empty array of numbers.");
            err.code = "INVALID_ALLOWED_OPTION_COUNTS";
            throw err;
        }
        for (const count of profile.allowedOptionCounts) {
            if (!Number.isInteger(count) || count < 0) {
                const err = new Error("INVALID_PROFILE_SCHEMA: Each item in 'allowedOptionCounts' must be a non-negative integer.");
                err.code = "INVALID_OPTION_COUNT_ITEM";
                throw err;
            }
        }

        // 12. optionalQuestionPolicy & droppedQuestionPolicy
        const validOptPolicies = Object.values(OPTIONAL_QUESTION_POLICY);
        if (!validOptPolicies.includes(profile.optionalQuestionPolicy)) {
            const err = new Error(`INVALID_PROFILE_SCHEMA: 'optionalQuestionPolicy' must be one of [${validOptPolicies.join(", ")}].`);
            err.code = "INVALID_OPTIONAL_POLICY";
            throw err;
        }
        const validDropPolicies = Object.values(DROPPED_QUESTION_POLICY);
        if (!validDropPolicies.includes(profile.droppedQuestionPolicy)) {
            const err = new Error(`INVALID_PROFILE_SCHEMA: 'droppedQuestionPolicy' must be one of [${validDropPolicies.join(", ")}].`);
            err.code = "INVALID_DROPPED_POLICY";
            throw err;
        }

        // 13. navigationRules
        if (!profile.navigationRules || typeof profile.navigationRules !== "object") {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'navigationRules' must be an object.");
            err.code = "INVALID_NAVIGATION_RULES";
            throw err;
        }
        if (typeof profile.navigationRules.allowSectionSwitching !== "boolean" ||
            typeof profile.navigationRules.allowQuestionReview !== "boolean" ||
            typeof profile.navigationRules.strictTimer !== "boolean") {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'navigationRules' must contain boolean flags for allowSectionSwitching, allowQuestionReview, and strictTimer.");
            err.code = "INVALID_NAVIGATION_RULES_FIELDS";
            throw err;
        }

        // 14. sections
        if (!Array.isArray(profile.sections) || profile.sections.length === 0) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'sections' must be a non-empty array.");
            err.code = "MISSING_SECTIONS";
            throw err;
        }

        const sectionIds = new Set();
        let totalSectionQuestions = 0;
        const numberingRestarts = Boolean(profile.numberingRestartsPerSection);

        for (let i = 0; i < profile.sections.length; i++) {
            const s = profile.sections[i];
            if (!s || typeof s !== "object") {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section at index ${i} must be an object.`);
                err.code = "INVALID_SECTION_OBJECT";
                throw err;
            }
            if (typeof s.id !== "string" || !s.id.trim()) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section at index ${i} has invalid or missing 'id'.`);
                err.code = "INVALID_SECTION_ID";
                throw err;
            }
            if (sectionIds.has(s.id)) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Duplicate section id '${s.id}' detected.`);
                err.code = "DUPLICATE_SECTION_ID";
                throw err;
            }
            sectionIds.add(s.id);

            if (typeof s.name !== "string" || !s.name.trim()) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' has missing 'name'.`);
                err.code = "INVALID_SECTION_NAME";
                throw err;
            }
            if (typeof s.subject !== "string" || !s.subject.trim()) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' has missing 'subject'.`);
                err.code = "INVALID_SECTION_SUBJECT";
                throw err;
            }
            if (!Number.isInteger(s.startQuestion) || s.startQuestion < 1) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' has invalid 'startQuestion'.`);
                err.code = "INVALID_START_QUESTION";
                throw err;
            }
            if (!Number.isInteger(s.endQuestion) || s.endQuestion < s.startQuestion) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' has endQuestion < startQuestion.`);
                err.code = "INVALID_END_QUESTION";
                throw err;
            }

            const expectedCount = s.endQuestion - s.startQuestion + 1;
            if (s.questionCount !== expectedCount) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' questionCount (${s.questionCount}) does not match endQuestion - startQuestion + 1 (${expectedCount}).`);
                err.code = "SECTION_COUNT_MISMATCH";
                throw err;
            }

            if (!Number.isInteger(s.requiredCount) || s.requiredCount < 1 || s.requiredCount > s.questionCount) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' requiredCount must be between 1 and questionCount.`);
                err.code = "INVALID_SECTION_REQUIRED_COUNT";
                throw err;
            }

            if (!QUESTION_TYPES.includes(s.questionType)) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' has unknown questionType '${s.questionType}'. Allowed: [${QUESTION_TYPES.join(", ")}].`);
                err.code = "INVALID_QUESTION_TYPE";
                throw err;
            }

            if (!s.markingScheme || typeof s.markingScheme !== "object") {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' is missing 'markingScheme'.`);
                err.code = "MISSING_MARKING_SCHEME";
                throw err;
            }
            if (!Number.isFinite(s.markingScheme.correct) || s.markingScheme.correct <= 0) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' markingScheme.correct must be a positive number.`);
                err.code = "INVALID_CORRECT_MARK";
                throw err;
            }
            if (!Number.isFinite(s.markingScheme.incorrect) || s.markingScheme.incorrect > 0) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' markingScheme.incorrect must be non-positive (<= 0).`);
                err.code = "INVALID_INCORRECT_MARK";
                throw err;
            }
            if (!Number.isFinite(s.markingScheme.unanswered)) {
                const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' markingScheme.unanswered must be a number.`);
                err.code = "INVALID_UNANSWERED_MARK";
                throw err;
            }

            // Sequence continuity check (if numbering does not restart per section)
            if (!numberingRestarts && !s.numberingRestartsPerSection && i > 0) {
                const prev = profile.sections[i - 1];
                if (s.startQuestion !== prev.endQuestion + 1) {
                    const err = new Error(`INVALID_PROFILE_SCHEMA: Section '${s.id}' startQuestion (${s.startQuestion}) is not contiguous with preceding section endQuestion (${prev.endQuestion}).`);
                    err.code = "NON_CONTIGUOUS_SECTIONS";
                    throw err;
                }
            }

            totalSectionQuestions += s.questionCount;
        }

        if (totalSectionQuestions !== profile.totalQuestions) {
            const err = new Error(`INVALID_PROFILE_SCHEMA: Sum of section question counts (${totalSectionQuestions}) does not equal profile totalQuestions (${profile.totalQuestions}).`);
            err.code = "TOTAL_QUESTIONS_SUM_MISMATCH";
            throw err;
        }

        // 15. sourceProvenance
        if (!profile.sourceProvenance || typeof profile.sourceProvenance !== "object") {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'sourceProvenance' must be an object.");
            err.code = "MISSING_SOURCE_PROVENANCE";
            throw err;
        }
        if (typeof profile.sourceProvenance.documentName !== "string" || !profile.sourceProvenance.documentName.trim()) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'sourceProvenance.documentName' must be a non-empty string.");
            err.code = "MISSING_PROVENANCE_DOC_NAME";
            throw err;
        }
        if (typeof profile.sourceProvenance.citation !== "string" || !profile.sourceProvenance.citation.trim()) {
            const err = new Error("INVALID_PROFILE_SCHEMA: 'sourceProvenance.citation' must be a non-empty string.");
            err.code = "MISSING_PROVENANCE_CITATION";
            throw err;
        }

        return { valid: true };
    }
}
