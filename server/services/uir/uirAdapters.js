import {
    UIR_SCHEMA_VERSION,
    UIR_APPROVAL_STATUS,
    UIR_QUESTION_TYPES,
    UIR_ANSWER_TYPES,
    createUIRDocument,
    createUIRSection,
    createUIRQuestion,
    createUIRScoringRule
} from "./uirSchema.js";
import { Rational } from "../scoring/rational.js";

/**
 * Universal Intermediate Representation (UIR v3.0) — Downstream & Backward Compatibility Adapters
 * 
 * Provides bi-directional translation between UIR v3.0 and:
 * 1. UniversalScoringEngine (Modern Schema v2 scoring payload)
 * 2. LegacyScoringAdapter (Historical Schema v1 attempt scoring)
 * 3. MockTestService (Firestore document storage models)
 * 4. LegacyToUIR (Migration of historical records to UIR v3.0)
 */

export class UIRToScoringAdapter {

    /**
     * Converts a UIR v3.0 Document into the exact input shape required by UniversalScoringEngine.evaluateAttempt
     * 
     * @param {object} uirDocument 
     * @param {object} [studentAnswers={}] 
     * @param {object} [options={}] 
     * @returns {{ questions: object[], answerKeys: object[], studentAnswers: object, examProfile: object, options: object }}
     */
    static toScoringPayload(uirDocument, studentAnswers = {}, options = {}) {
        if (!uirDocument || !uirDocument.questions) {
            throw new Error("[UIRToScoringAdapter] Invalid UIR document: missing questions.");
        }

        const questions = uirDocument.questions.map(q => {
            let scoringType = "mcq";
            if (q.questionType === UIR_QUESTION_TYPES.NUMERICAL_NAT) scoringType = "numerical";
            else if (q.questionType === UIR_QUESTION_TYPES.MULTIPLE_CHOICE_MSQ) scoringType = "msq";
            else if (q.questionType === UIR_QUESTION_TYPES.DESCRIPTIVE_MANUAL) scoringType = "descriptive";

            return {
                questionId: q.questionId,
                id: q.questionId,
                questionNumber: q.questionNumber,
                sectionId: q.sectionId,
                subject: q.sectionName || "General",
                subjectName: q.sectionName || "General",
                questionType: scoringType,
                markingScheme: {
                    correct: q.scoring.positiveMarks,
                    incorrect: q.scoring.negativeMarks,
                    unanswered: q.scoring.unansweredMarks
                },
                options: q.options
            };
        });

        const answerKeys = uirDocument.questions.map(q => {
            const ans = q.correctAnswer || {};
            let ansType = "single_choice";
            if (q.questionType === UIR_QUESTION_TYPES.NUMERICAL_NAT) ansType = "numerical";
            else if (q.questionType === UIR_QUESTION_TYPES.MULTIPLE_CHOICE_MSQ) ansType = "multiple_choice";

            let acceptedAnswers = Array.isArray(ans.acceptedAnswers) ? [...ans.acceptedAnswers] : [];
            let tolerance = ans.tolerance ?? null;

            if (ans.numericValue !== null && ans.numericValue !== undefined && !acceptedAnswers.includes(String(ans.numericValue))) {
                acceptedAnswers.push(String(ans.numericValue));
            }

            if (ans.numericRange && Number.isFinite(ans.numericRange.min) && Number.isFinite(ans.numericRange.max)) {
                const mid = (ans.numericRange.min + ans.numericRange.max) / 2;
                const halfSpan = Math.abs(ans.numericRange.max - ans.numericRange.min) / 2;
                if (!acceptedAnswers.includes(String(mid))) {
                    acceptedAnswers.push(String(mid));
                }
                if (tolerance === null || tolerance === undefined) {
                    tolerance = halfSpan;
                }
            }

            return {
                answerKeyId: `ak_${q.questionId}`,
                questionId: q.questionId,
                questionNumber: q.questionNumber,
                sectionId: q.sectionId,
                answerType: ansType,
                acceptedAnswers,
                correctAnswers: acceptedAnswers,
                correctOptionIds: acceptedAnswers,
                numericValue: ans.numericValue ?? null,
                numericRange: ans.numericRange ?? null,
                numericTolerance: tolerance,
                tolerance: tolerance,
                isDropped: Boolean(ans.isDropped),
                isBonus: Boolean(ans.isBonus),
                marksAwarded: q.scoring.positiveMarks,
                marksDeducted: q.scoring.negativeMarks
            };
        });

        const examProfile = {
            profileId: uirDocument.examMetadata.examId,
            examId: uirDocument.examMetadata.examId,
            examName: uirDocument.examMetadata.examTitle,
            year: uirDocument.examMetadata.year,
            totalQuestions: uirDocument.examMetadata.totalQuestions,
            maximumMarks: uirDocument.examMetadata.maximumMarks,
            durationSeconds: uirDocument.examMetadata.durationSeconds,
            isOfficial: true,
            verificationStatus: "verified_official",
            markingScheme: {
                correct: uirDocument.scoringConfig.defaultPositiveMarks,
                incorrect: uirDocument.scoringConfig.defaultNegativeMarks,
                unanswered: uirDocument.scoringConfig.defaultUnansweredMarks
            },
            optionalQuestionPolicy: uirDocument.scoringConfig.optionalQuestionPolicy,
            droppedQuestionPolicy: uirDocument.scoringConfig.droppedQuestionPolicy,
            sections: uirDocument.sections.map(s => ({
                id: s.sectionId,
                name: s.sectionName,
                subject: s.sectionName,
                questionCount: s.questionCount,
                requiredCount: s.optionalPolicy?.requiredCount || s.questionCount,
                markingScheme: {
                    correct: s.scoringRules.positiveMarks,
                    incorrect: s.scoringRules.negativeMarks,
                    unanswered: s.scoringRules.unansweredMarks
                },
                optionalPolicy: s.optionalPolicy?.policyType || "none"
            }))
        };

        return {
            questions,
            answerKeys,
            studentAnswers,
            examProfile,
            options: {
                ...options,
                allowUnverified: true
            }
        };
    }
}

export class UIRToLegacyAdapter {

    /**
     * Converts a UIR v3.0 Document into the input shape required by LegacyScoringAdapter.evaluateAttempt
     */
    static toLegacyPayload(uirDocument, studentAnswers = {}) {
        const payload = UIRToScoringAdapter.toScoringPayload(uirDocument, studentAnswers);
        return {
            questions: payload.questions,
            answerKeys: payload.answerKeys,
            studentAnswers: payload.studentAnswers,
            examConfig: {
                examId: uirDocument.examMetadata.examId,
                totalQuestions: uirDocument.examMetadata.totalQuestions,
                maximumMarks: uirDocument.examMetadata.maximumMarks
            }
        };
    }

    /**
     * Alias for toLegacyPayload
     */
    static toLegacyAttemptPayload(uirDocument, studentAnswers = {}) {
        return this.toLegacyPayload(uirDocument, studentAnswers);
    }
}

export class UIRToMockTestAdapter {

    /**
     * Converts a UIR v3.0 Document into Firestore documents (mockTests & mockQuestions)
     * 
     * @param {object} uirDocument 
     * @returns {{ mockTestDoc: object, mockQuestionDocs: object[] }}
     */
    static toFirestoreDocuments(uirDocument) {
        if (!uirDocument || !uirDocument.examMetadata) {
            throw new Error("[UIRToMockTestAdapter] Invalid UIR document: missing examMetadata.");
        }

        const meta = uirDocument.examMetadata;
        const testId = meta.examId;

        const mockTestDoc = {
            testId,
            examId: meta.examId,
            examName: meta.examTitle,
            title: meta.examTitle,
            year: meta.year,
            paperCode: meta.paperCode,
            shift: meta.shift,
            durationSeconds: meta.durationSeconds,
            totalQuestions: meta.totalQuestions,
            maximumMarks: meta.maximumMarks,
            availableLanguages: meta.languages,
            status: meta.approvalStatus === UIR_APPROVAL_STATUS.APPROVED ? "published" : "draft",
            publishedWithDiscrepancies: Boolean(uirDocument.auditTrail?.publishedWithOverrides),
            schemaVersion: UIR_SCHEMA_VERSION,
            questionIds: uirDocument.questions.map(q => q.questionId),
            sections: uirDocument.sections,
            scoringConfig: uirDocument.scoringConfig,
            auditTrail: uirDocument.auditTrail,
            createdAt: uirDocument.auditTrail?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const mockQuestionDocs = uirDocument.questions.map(q => {
            const translations = {};
            if (q.languageVariants) {
                for (const [lang, variant] of Object.entries(q.languageVariants)) {
                    translations[lang] = {
                        questionText: variant.stemText || variant.text || "",
                        options: variant.options || []
                    };
                }
            }

            return {
                questionId: q.questionId,
                testId,
                questionNumber: q.questionNumber,
                originalNumbering: q.originalNumbering,
                sectionId: q.sectionId,
                sectionName: q.sectionName,
                questionType: q.questionType || (q.options?.length === 0 ? "numerical" : "mcq"),
                legacyQuestionType: q.questionType === UIR_QUESTION_TYPES.NUMERICAL_NAT ? "numerical" : "mcq",
                subject: q.sectionName || "General",
                subjectName: q.sectionName || "General",
                topic: "",
                questionText: q.stem.text,
                options: (q.options || []).map(opt => ({
                    id: opt.id,
                    label: opt.label,
                    text: opt.text,
                    diagramUrl: opt.diagramUrl,
                    diagramId: opt.diagramId,
                    hasDiagram: Boolean(opt.diagramUrl || opt.diagramId)
                })),
                translations,
                hasDiagram: q.stem.diagrams && q.stem.diagrams.length > 0,
                diagramUrl: q.stem.diagrams?.[0]?.url || null,
                media: q.stem.diagrams || [],
                tables: q.stem.tables || [],
                formulas: q.stem.formulas || [],
                sourcePage: q.sourceReference?.pageNumber || 1,
                qualityFlags: q.qualityFlags,
                scoring: q.scoring,
                markingScheme: q.scoring ? {
                    correct: q.scoring.positiveMarks,
                    incorrect: q.scoring.negativeMarks,
                    unanswered: q.scoring.unansweredMarks
                } : null,
                passageText: q.stem.passageText || null,
                statements: q.stem.statements || [],
                tableData: q.stem.tableData || null,
                leftItems: q.stem.leftItems || [],
                rightItems: q.stem.rightItems || [],
                subQuestions: q.stem.subQuestions || [],
                instructions: q.instructions || null
            };
        });

        const mockAnswerKeyDocs = uirDocument.questions.map(q => {
            const ans = q.correctAnswer || {};
            let accepted = Array.isArray(ans.acceptedAnswers) ? [...ans.acceptedAnswers] : [];
            if (ans.numericValue !== null && ans.numericValue !== undefined && !accepted.includes(String(ans.numericValue))) {
                accepted.push(String(ans.numericValue));
            }
            let ansType = "single_choice";
            if (q.questionType === UIR_QUESTION_TYPES.NUMERICAL_NAT) ansType = "numerical";
            else if (q.questionType === UIR_QUESTION_TYPES.MULTIPLE_CHOICE_MSQ) ansType = "multiple_choice";
            else if (q.questionType === UIR_QUESTION_TYPES.DESCRIPTIVE_MANUAL) ansType = "descriptive";

            return {
                answerKeyId: `ak_${q.questionId}`,
                questionId: q.questionId,
                questionNumber: q.questionNumber,
                sectionId: q.sectionId,
                testId,
                answerType: ansType,
                acceptedAnswers: accepted,
                correctAnswers: accepted,
                correctOptionIds: accepted,
                numericValue: ans.numericValue ?? null,
                numericRange: ans.numericRange ?? null,
                numericTolerance: ans.tolerance ?? null,
                isDropped: Boolean(ans.isDropped),
                isBonus: Boolean(ans.isBonus),
                marksAwarded: q.scoring?.positiveMarks ?? 4,
                marksDeducted: q.scoring?.negativeMarks ?? 0,
                scoringRuleId: "uir_v3",
                verificationStatus: "verified",
                explanation: q.explanation || null
            };
        });

        return {
            mockTestDoc,
            mockQuestionDocs,
            mockAnswerKeyDocs
        };
    }
}

export class LegacyToUIRAdapter {

    /**
     * Converts legacy Firestore mockTests & mockQuestions documents into a valid UIR v3.0 Document
     * 
     * @param {object} mockTestDoc 
     * @param {object[]} mockQuestionDocs 
     * @param {object[]} [answerKeyDocs=[]] 
     * @returns {object} Canonical UIR v3.0 Document
     */
    static fromFirestoreDocuments(mockTestDoc, mockQuestionDocs = [], answerKeyDocs = []) {
        if (!mockTestDoc || typeof mockTestDoc !== "object") {
            throw new Error("[LegacyToUIRAdapter] Invalid mockTestDoc.");
        }

        const akMap = new Map((answerKeyDocs || []).map(ak => [ak.questionNumber || ak.questionId, ak]));

        const questions = mockQuestionDocs
            .sort((a, b) => (a.questionNumber || 0) - (b.questionNumber || 0))
            .map((q, idx) => {
                const qNum = q.questionNumber || (idx + 1);
                const qId = q.questionId || `${mockTestDoc.testId || 'test'}_q_${qNum}`;
                const matchedAk = akMap.get(qNum) || akMap.get(qId);

                let correctAnswer = null;
                if (matchedAk) {
                    correctAnswer = {
                        answerType: matchedAk.answerType || "single_choice",
                        acceptedAnswers: matchedAk.acceptedAnswers || (matchedAk.correctOption ? [matchedAk.correctOption] : []),
                        numericValue: matchedAk.numericValue ?? null,
                        numericRange: matchedAk.numericRange ?? null,
                        isDropped: Boolean(matchedAk.isDropped),
                        isBonus: Boolean(matchedAk.isBonus),
                        rationale: matchedAk.rationale || null
                    };
                }

                let uirQType = UIR_QUESTION_TYPES.SINGLE_CHOICE_MCQ;
                if (Object.values(UIR_QUESTION_TYPES).includes(q.questionType)) {
                    uirQType = q.questionType;
                } else if (q.questionType === "numerical" || q.questionType === "nat") {
                    uirQType = UIR_QUESTION_TYPES.NUMERICAL_NAT;
                } else if (q.questionType === "msq") {
                    uirQType = UIR_QUESTION_TYPES.MULTIPLE_CHOICE_MSQ;
                } else if (q.questionType === "descriptive") {
                    uirQType = UIR_QUESTION_TYPES.DESCRIPTIVE_MANUAL;
                }

                return createUIRQuestion({
                    questionId: qId,
                    questionNumber: qNum,
                    originalNumbering: q.originalNumbering || String(qNum),
                    orderIndex: idx,
                    sectionId: q.sectionId || "sec_1",
                    sectionName: q.sectionName || q.subject || "General",
                    questionType: uirQType,
                    stem: {
                        text: q.questionText || "",
                        diagrams: q.media || [],
                        tables: q.tables || [],
                        formulas: q.formulas || []
                    },
                    options: (q.options || []).map(o => ({
                        id: o.id,
                        label: o.label || `(${o.id})`,
                        text: o.text || "",
                        diagramUrl: o.diagramUrl || null
                    })),
                    correctAnswer,
                    scoring: createUIRScoringRule({
                        positiveMarks: matchedAk?.marksAwarded || 4,
                        negativeMarks: matchedAk?.marksDeducted !== undefined ? matchedAk.marksDeducted : -1
                    }),
                    sourceReference: {
                        documentId: "legacy_migration",
                        pageNumber: q.sourcePage || 1
                    }
                });
            });

        let sections = [];
        if (Array.isArray(mockTestDoc.sections) && mockTestDoc.sections.length > 0) {
            sections = mockTestDoc.sections.map(s => createUIRSection(s));
        } else {
            const secMap = new Map();
            questions.forEach((q, idx) => {
                const sId = q.sectionId || "sec_1";
                const sName = q.sectionName || "General";
                if (!secMap.has(sId)) {
                    secMap.set(sId, {
                        sectionId: sId,
                        sectionName: sName,
                        orderIndex: secMap.size,
                        questionIds: []
                    });
                }
                secMap.get(sId).questionIds.push(q.questionId);
            });
            sections = Array.from(secMap.values()).map(s => createUIRSection({
                ...s,
                questionCount: s.questionIds.length
            }));
        }

        return createUIRDocument({
            schemaVersion: UIR_SCHEMA_VERSION,
            examMetadata: {
                examId: mockTestDoc.examId || mockTestDoc.testId || "migrated-test",
                examTitle: mockTestDoc.title || mockTestDoc.examName || "Migrated Mock Test",
                year: mockTestDoc.year || new Date().getFullYear(),
                paperCode: mockTestDoc.paperCode || null,
                shift: mockTestDoc.shift || null,
                durationSeconds: mockTestDoc.durationSeconds || 7200,
                maximumMarks: mockTestDoc.maximumMarks || (questions.length * 4),
                totalQuestions: questions.length,
                languages: mockTestDoc.availableLanguages || ["English"],
                approvalStatus: mockTestDoc.status === "published" ? UIR_APPROVAL_STATUS.APPROVED : UIR_APPROVAL_STATUS.UNAPPROVED
            },
            sections,
            questions,
            scoringConfig: {
                defaultPositiveMarks: 4,
                defaultNegativeMarks: -1,
                defaultUnansweredMarks: 0
            }
        });
    }
}
