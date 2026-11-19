import { SubjectNormalizationService } from "./subjectNormalizationService.js";
import { LegacyScoringAdapter } from "./scoring/legacyScoringAdapter.js";
import { UniversalScoringEngine } from "./scoring/universalScoringEngine.js";
import { Rational } from "./scoring/rational.js";
import { ExamProfileRegistry } from "./admin/examProfileRegistry.js";

/**
 * VidyarthiAstra — Server-Authoritative Mock Test Scoring Service
 * 
 * Implements deterministic examination scoring & subject-wise performance analysis:
 * - Correct answer: +4 marks (or custom key.marksAwarded)
 * - Incorrect answer: -1 mark (or custom key.marksDeducted, 0 if negative marking disabled)
 * - Unanswered question: 0 marks
 * - Dropped question: Bonus marks awarded unconditionally to all candidates (NTA policy)
 * 
 * SECURITY MANDATE:
 * Scoring is computed strictly on the backend using protected answer keys.
 * Client-submitted scores, marks, and correctness claims are unconditionally discarded.
 */
export class MockTestScoringService {

    static get adapter() {
        return LegacyScoringAdapter;
    }

    static get engine() {
        return UniversalScoringEngine;
    }

    static get Rational() {
        return Rational;
    }

    /**
     * Submission evaluation alias
     */
    static evaluateSubmission(params = {}, legacyAnswerKeys, legacyOptions = {}) {
        return this.evaluateAttempt(params, legacyAnswerKeys, legacyOptions);
    }

    /**
     * Deterministically evaluate a student's attempt against protected answer keys
     * Routes modern Schema v2 papers to UniversalScoringEngine.
     * Routes historical / legacy attempts to LegacyScoringAdapter for exact backward parity.
     * @param {object} params
     * @param {Array<object>} params.questions - Array of question metadata
     * @param {Array<object>} params.answerKeys - Array of protected answer keys
     * @param {object} params.studentAnswers - Map of questionId -> selectedOptionId / numerical input
     * @returns {object} Full evaluated score breakdown with subject-wise performance analysis
     */
    static evaluateAttempt(params = {}, legacyAnswerKeys, legacyOptions = {}) {
        let questions = [];
        let answerKeys = [];
        let studentAnswers = {};
        let examConfig = null;
        let examProfile = null;
        let options = {};

        const isLegacyPositional = (Array.isArray(params) || legacyAnswerKeys !== undefined) && !(params && params.questions && params.answerKeys);
        if (isLegacyPositional) {
            const attempt = params;
            studentAnswers = attempt.answers || attempt.studentAnswers || attempt || {};
            answerKeys = legacyAnswerKeys || [];
            examConfig = legacyOptions.examConfig || null;
            examProfile = legacyOptions.examProfile || examConfig?.examProfile || null;
            options = legacyOptions;
            questions = legacyOptions.questions || answerKeys.map((k, idx) => ({
                questionId: k.questionId || `q-${idx + 1}`,
                questionNumber: k.questionNumber || idx + 1,
                sectionId: k.sectionId || null,
                subject: k.subject || null,
                questionType: k.answerType === "numerical" ? "numerical" : "mcq"
            }));
        } else {
            questions = params.questions || [];
            answerKeys = params.answerKeys || [];
            studentAnswers = params.studentAnswers || params.answers || {};
            examConfig = params.examConfig || null;
            examProfile = params.examProfile || examConfig?.examProfile || null;
            options = params.options || {};
        }

        const isModernSchemaV2 = (
            examConfig?.schemaVersion === 2 ||
            examConfig?.schemaVersion === "2.0" ||
            examConfig?.schemaVersion === 3 ||
            examConfig?.schemaVersion === "3.0.0" ||
            params.schemaVersion === 2 ||
            params.schemaVersion === 3 ||
            params.schemaVersion === "3.0.0" ||
            options.schemaVersion === 2 ||
            options.schemaVersion === 3 ||
            options.schemaVersion === "3.0.0" ||
            options.useUniversalEngine === true ||
            Boolean(examProfile) ||
            Boolean(examConfig?.profileId) ||
            Boolean(examConfig?.scoringConfig) ||
            Boolean(examConfig?.sections) ||
            Boolean(questions[0]?.examProfile) ||
            Boolean(questions[0]?.scoring)
        );

        if (isModernSchemaV2) {
            const hasDocumentDrivenConfig = Boolean(
                examConfig?.schemaVersion === "3.0.0" ||
                examConfig?.schemaVersion === 3 ||
                params.schemaVersion === "3.0.0" ||
                params.schemaVersion === 3 ||
                (examConfig?.sections && Array.isArray(examConfig.sections) && examConfig.sections.length > 0)
            );

            let resolvedProfile = examProfile;

            // Universal Document Pipeline: Dynamically synthesize declarative profile if document-driven or un-registered
            if (!resolvedProfile && hasDocumentDrivenConfig && examConfig) {
                const totalQ = examConfig.totalQuestions || questions.length || 0;
                const defCorrect = examConfig.scoringConfig?.defaultPositiveMarks ?? 4;
                const maxMarks = examConfig.maximumMarks || (totalQ * defCorrect);

                resolvedProfile = {
                    profileId: examConfig.examId || "universal-exam",
                    examId: examConfig.examId || "universal-exam",
                    examName: examConfig.examName || examConfig.title || "Universal Examination",
                    year: examConfig.year || new Date().getFullYear(),
                    totalQuestions: totalQ,
                    maximumMarks: maxMarks,
                    durationSeconds: examConfig.durationSeconds || 7200,
                    isOfficial: true,
                    verificationStatus: "verified_official",
                    droppedQuestionPolicy: examConfig.scoringConfig?.droppedQuestionPolicy || "full_marks",
                    optionalQuestionPolicy: examConfig.scoringConfig?.optionalQuestionPolicy || "none",
                    markingScheme: {
                        correct: defCorrect,
                        incorrect: examConfig.scoringConfig?.defaultNegativeMarks ?? 1,
                        unanswered: examConfig.scoringConfig?.defaultUnansweredMarks ?? 0
                    },
                    sections: (examConfig.sections || []).map(s => {
                        const qCount = s.questionCount || s.questionsCount || (s.end && s.start ? (s.end - s.start + 1) : 0);
                        const hasOptional = s.optionalPolicy && (
                            (typeof s.optionalPolicy === "object" && s.optionalPolicy.policyType && s.optionalPolicy.policyType !== "none") ||
                            (typeof s.optionalPolicy === "string" && s.optionalPolicy !== "none")
                        );
                        const reqCount = hasOptional
                            ? (s.optionalPolicy?.requiredCount ?? s.requiredCount ?? (qCount > 0 ? qCount : undefined))
                            : undefined;
                        return {
                            id: s.sectionId || s.id,
                            name: s.sectionName || s.name || s.sectionId || s.id,
                            subject: s.sectionName || s.subject || "General",
                            questionCount: qCount,
                            requiredCount: reqCount,
                            maximumMarks: s.maximumMarks || null,
                            questionRanges: s.questionRanges || [],
                            markingScheme: {
                                correct: s.scoringRules?.positiveMarks ?? s.markingScheme?.correct ?? s.marksPerCorrect ?? defCorrect,
                                incorrect: s.scoringRules?.negativeMarks ?? s.markingScheme?.incorrect ?? s.negativeMarks ?? (examConfig.scoringConfig?.defaultNegativeMarks ?? 1),
                                unanswered: s.scoringRules?.unansweredMarks ?? s.markingScheme?.unanswered ?? 0
                            },
                            optionalPolicy: s.optionalPolicy?.policyType || s.optionalPolicy || "none",
                            startQuestion: s.startQuestion || s.start,
                            endQuestion: s.endQuestion || s.end
                        };
                    })
                };
            } else if (!resolvedProfile) {
                resolvedProfile = examConfig?.profileId || examConfig?.examProfile || (
                    examConfig?.examId ? ExamProfileRegistry.findProfile(examConfig.examId, examConfig.year || 2024) : null
                );
            }

            return UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examProfile: resolvedProfile,
                options: {
                    ...options,
                    examId: examConfig?.examId || options.examId,
                    year: examConfig?.year || options.year,
                    adminApprovedForScoring: examConfig?.adminApprovedForScoring ?? options.adminApprovedForScoring ?? true,
                    allowUnverified: examConfig?.allowUnverified ?? options.allowUnverified ?? true
                }
            });
        }

        return LegacyScoringAdapter.evaluateAttempt(params, legacyAnswerKeys, legacyOptions);
    }

    /**
     * Historical legacy engine implementation preserved verbatim for verification and regression parity
     */
    static evaluateAttemptHistorical(params = {}, legacyAnswerKeys, legacyOptions = {}) {
        let questions = [];
        let answerKeys = [];
        let studentAnswers = {};
        let examConfig = null;

        if (Array.isArray(params) || (params && (params.answers || legacyAnswerKeys))) {
            // Positional overload: evaluateAttempt(attempt, answerKeys, options)
            const attempt = params;
            studentAnswers = attempt.answers || attempt.studentAnswers || attempt || {};
            answerKeys = legacyAnswerKeys || [];
            examConfig = legacyOptions.examConfig || null;
            questions = legacyOptions.questions || answerKeys.map((k, idx) => ({
                questionId: k.questionId || `q-${idx + 1}`,
                questionNumber: k.questionNumber || idx + 1,
                sectionId: k.sectionId || null,
                subject: k.subject || null,
                questionType: k.answerType === "numerical" ? "numerical" : "mcq"
            }));
        } else {
            questions = params.questions || [];
            answerKeys = params.answerKeys || [];
            studentAnswers = params.studentAnswers || {};
            examConfig = params.examConfig || null;
        }

        let totalScore = 0;
        let correctCount = 0;
        let incorrectCount = 0;
        let unansweredCount = 0;
        let droppedCount = 0;

        const breakdown = [];
        const subjectMap = new Map();

        const examId = String(examConfig?.examId || (questions[0]?.examId) || "").toLowerCase();
        const isGateExam = examId.includes("gate");
        const isJeeExam = examId.includes("jee");
        const isBpscExam = examId.includes("bpsc");
        const isUpscExam = examId.includes("upsc");
        const isNeetExam = examId.includes("neet");
        const isSscExam = examId.includes("ssc");
        const isIbpsExam = examId.includes("ibps") || examId.includes("banking");
        const isCuetExam = examId.includes("cuet");

        // Helper to obtain or initialize subject statistics bucket
        const getSubjectBucket = (subjectId, subjectName) => {
            if (!subjectMap.has(subjectId)) {
                subjectMap.set(subjectId, {
                    subjectId,
                    subjectName,
                    score: 0,
                    maximumMarks: 0,
                    totalQuestions: 0,
                    correct: 0,
                    incorrect: 0,
                    unattempted: 0,
                    dropped: 0,
                    attemptedCount: 0,
                    accuracy: 0
                });
            }
            return subjectMap.get(subjectId);
        };

        for (const q of questions) {
            // Match key by stable composite identity: questionId, or (sectionId + questionNumber), or global questionNumber
            const key = answerKeys.find(k => 
                (k.questionId && k.questionId === q.questionId) || 
                (k.sectionId && q.sectionId && k.sectionId === q.sectionId && k.questionNumber === q.questionNumber) ||
                (!k.sectionId && !q.sectionId && k.questionNumber && k.questionNumber === q.questionNumber)
            );

            // Normalize subject metadata using hybrid resolution
            const rawSubject = q.subjectName || q.subject || q.subjectId || key?.subject || null;
            const normSubject = SubjectNormalizationService.normalizeSubject(rawSubject);
            const subBucket = getSubjectBucket(normSubject.subjectId, normSubject.subjectName);
            subBucket.totalQuestions++;

            const isNumericalQuestion = q.questionType === "numerical" || key?.answerType === "numerical";
            const isMsqQuestion = q.questionType === "msq" || key?.answerType === "msq";

            // 1. Examination-specific marks awarded for correct answer
            let qMaxMarks = null;
            if (Number.isFinite(key?.marksAwarded)) {
                qMaxMarks = key.marksAwarded;
            } else if (Number.isFinite(q.marksAwarded)) {
                qMaxMarks = q.marksAwarded;
            } else if (isGateExam) {
                // In GATE: Questions 1-5 (GA) & 11-35 (Tech) are 1 mark; 6-10 (GA) & 36-65 (Tech) are 2 marks
                qMaxMarks = (q.questionNumber <= 5 || (q.questionNumber >= 11 && q.questionNumber <= 35)) ? 1 : 2;
            } else if (isBpscExam) {
                // Official BPSC Prelims Policy: 1 mark per question (150 total marks)
                qMaxMarks = 1;
            } else if (isUpscExam) {
                // Official UPSC Civil Services Prelims GS Paper I Policy: 2 marks per question (200 total marks)
                qMaxMarks = 2;
            } else if (isSscExam) {
                // Official SSC CGL Policy: 2 marks per question (200 total marks)
                qMaxMarks = 2;
            } else if (isIbpsExam) {
                // Official Banking IBPS PO Policy: 1 mark per question (100 total marks)
                qMaxMarks = 1;
            } else if (isCuetExam) {
                // Official NTA CUET Policy: 5 marks per question
                qMaxMarks = 5;
            } else if (isNeetExam || isJeeExam) {
                // NTA NEET UG and JEE Main standard MCQ/NAT marks
                qMaxMarks = 4;
            } else if (examConfig && Array.isArray(examConfig.sections)) {
                // Section-level marking scheme from verified pattern
                const sec = examConfig.sections.find(s => 
                    (q.sectionId && s.id === q.sectionId) || 
                    (q.questionNumber >= s.startQuestion && q.questionNumber <= s.endQuestion)
                );
                if (Number.isFinite(sec?.markingScheme?.correct)) {
                    qMaxMarks = sec.markingScheme.correct;
                }
            } else if (Number.isFinite(examConfig?.scoringRules?.correct)) {
                qMaxMarks = examConfig.scoringRules.correct;
            } else if (Number.isFinite(examConfig?.markingScheme?.correct)) {
                qMaxMarks = examConfig.markingScheme.correct;
            }

            // Unknown or unverified profiles must not silently receive +4/-1
            if (qMaxMarks === null) {
                if (examConfig?.adminApprovedForScoring === true) {
                    qMaxMarks = examConfig.defaultMarks || 1;
                } else {
                    const err = new Error(`UNVERIFIED_EXAM_SCORING_REJECTED: Examination '${examId || "unknown"}' is unverified and has no explicit marking scheme. Scoring rejected pending administrative approval.`);
                    err.code = "UNVERIFIED_EXAM_SCORING_REJECTED";
                    throw err;
                }
            }
            subBucket.maximumMarks += qMaxMarks;

            // 2. Examination-specific negative deduction penalty
            let qPenalty = 0;
            if (Number.isFinite(key?.marksDeducted)) {
                qPenalty = Math.abs(key.marksDeducted);
            } else if (Number.isFinite(q.marksDeducted)) {
                qPenalty = Math.abs(q.marksDeducted);
            } else if (isGateExam) {
                if (isMsqQuestion || isNumericalQuestion) {
                    // Official GATE Policy: ZERO negative marking for MSQ and NAT!
                    qPenalty = 0;
                } else {
                    // Official GATE MCQ Policy: 1/3 for 1-mark, 2/3 for 2-mark
                    qPenalty = qMaxMarks === 1 ? (1 / 3) : (2 / 3);
                }
            } else if (isBpscExam) {
                // Official BPSC 69th Prelims Policy: 1/3 negative marking deduction per wrong answer
                qPenalty = 1 / 3;
            } else if (isUpscExam) {
                // Official UPSC Prelims Policy: 1/3 of question marks (2/3 mark) deduction per wrong answer
                qPenalty = 2 / 3;
            } else if (isSscExam) {
                // Official SSC CGL Policy: 0.5 mark negative deduction per wrong answer
                qPenalty = 0.5;
            } else if (isIbpsExam) {
                // Official Banking IBPS PO Policy: 0.25 mark negative deduction per wrong answer
                qPenalty = 0.25;
            } else if (isJeeExam || isNeetExam || isCuetExam) {
                // NTA standard negative deduction: 1 mark
                qPenalty = 1;
            } else if (isMsqQuestion) {
                qPenalty = 0;
            } else if (examConfig && Array.isArray(examConfig.sections)) {
                const sec = examConfig.sections.find(s => 
                    (q.sectionId && s.id === q.sectionId) || 
                    (q.questionNumber >= s.startQuestion && q.questionNumber <= s.endQuestion)
                );
                if (Number.isFinite(sec?.markingScheme?.incorrect)) {
                    qPenalty = Math.abs(sec.markingScheme.incorrect);
                }
            } else if (Number.isFinite(examConfig?.scoringRules?.incorrect)) {
                qPenalty = Math.abs(examConfig.scoringRules.incorrect);
            } else if (Number.isFinite(examConfig?.markingScheme?.incorrect)) {
                qPenalty = Math.abs(examConfig.markingScheme.incorrect);
            }

            const studentChoice = (studentAnswers[q.questionId] !== undefined
                ? studentAnswers[q.questionId]
                : (q.sectionId && studentAnswers[`${q.sectionId}_${q.questionNumber}`] !== undefined)
                    ? studentAnswers[`${q.sectionId}_${q.questionNumber}`]
                    : studentAnswers[q.questionNumber] !== undefined
                        ? studentAnswers[q.questionNumber]
                        : studentAnswers[String(q.questionNumber)]);

            // 1. Dropped Question Policy (Official NTA Rule: bonus marks awarded to all)
            if (key?.isDropped) {
                droppedCount++;
                subBucket.dropped++;
                const bonus = qMaxMarks;
                totalScore += bonus;
                subBucket.score += bonus;
                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: q.questionNumber,
                    sectionId: q.sectionId || key?.sectionId || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: "dropped",
                    studentAnswer: studentChoice !== undefined && studentChoice !== null ? String(studentChoice) : null,
                    marksAwarded: bonus,
                    bonusAwarded: true
                });
                continue;
            }

            // 2. Unanswered Question
            if (studentChoice === undefined || studentChoice === null || studentChoice === "") {
                unansweredCount++;
                subBucket.unattempted++;
                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: q.questionNumber,
                    sectionId: q.sectionId || key?.sectionId || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: "unanswered",
                    studentAnswer: null,
                    marksAwarded: 0,
                    bonusAwarded: false
                });
                continue;
            }

            // 3. Answer Key Comparison
            let isCorrect = false;
            let partialMarks = null;

            if (isNumericalQuestion) {
                const candidateAnswers = (
                    (Array.isArray(key?.acceptedAnswers) && key.acceptedAnswers.length > 0)
                        ? key.acceptedAnswers
                        : (Array.isArray(key?.correctAnswers) && key.correctAnswers.length > 0)
                            ? key.correctAnswers
                            : (Array.isArray(key?.correctOptionIds) && key.correctOptionIds.length > 0)
                                ? key.correctOptionIds
                                : []
                ).map(a => String(a).trim());

                if (candidateAnswers.length > 0) {
                    const studStr = String(studentChoice).trim();
                    const studNum = Number(studStr);
                    isCorrect = candidateAnswers.some(ans => {
                        const ansStr = String(ans).trim();
                        if (studStr === ansStr) return true;
                        const ansNum = Number(ansStr);
                        if (!isNaN(studNum) && !isNaN(ansNum) && isFinite(studNum) && isFinite(ansNum)) {
                            const hasExplicitTol = Number.isFinite(key?.numericTolerance) && key.numericTolerance > 0;
                            if (hasExplicitTol) {
                                return Math.abs(studNum - ansNum) <= key.numericTolerance;
                            }
                            return studNum === ansNum;
                        }
                        return false;
                    });
                }
            } else if (isMsqQuestion) {
                const correctOptionIds = (
                    (Array.isArray(key?.correctOptionIds) && key.correctOptionIds.length > 0)
                        ? key.correctOptionIds
                        : key?.correctOptionId != null
                            ? [key.correctOptionId]
                            : (Array.isArray(key?.correctAnswers) && key.correctAnswers.length > 0)
                                ? key.correctAnswers
                                : (Array.isArray(key?.acceptedAnswers) ? key.acceptedAnswers : [])
                ).map(a => String(a).trim());

                const studentArr = (
                    Array.isArray(studentChoice)
                        ? studentChoice
                        : String(studentChoice).split(/[,\s|]+/)
                ).map(s => String(s).trim()).filter(Boolean);

                const uniqueStudent = [...new Set(studentArr)].sort();
                const uniqueCorrect = [...new Set(correctOptionIds)].sort();

                const isExactMatch = uniqueStudent.length > 0 &&
                    uniqueStudent.length === uniqueCorrect.length &&
                    uniqueStudent.every((val, idx) => val === uniqueCorrect[idx]);

                const allowPartial = Boolean(examConfig?.partialMarkingEnabled || q.partialMarkingEnabled);
                const hasWrongOption = uniqueStudent.some(s => !uniqueCorrect.includes(s));

                if (isExactMatch) {
                    isCorrect = true;
                } else if (allowPartial && !hasWrongOption && uniqueStudent.length > 0) {
                    // Configured partial marking scheme
                    isCorrect = true;
                    partialMarks = Math.min(qMaxMarks, uniqueStudent.length);
                } else {
                    isCorrect = false;
                }
            } else {
                const correctOptionIds = (
                    (Array.isArray(key?.correctOptionIds) && key.correctOptionIds.length > 0)
                        ? key.correctOptionIds
                        : key?.correctOptionId != null
                            ? [key.correctOptionId]
                            : (Array.isArray(key?.correctAnswers) && key.correctAnswers.length > 0)
                                ? key.correctAnswers
                                : (Array.isArray(key?.acceptedAnswers) ? key.acceptedAnswers : [])
                ).map(a => String(a).trim());

                isCorrect = correctOptionIds.includes(String(studentChoice).trim());
            }

            if (isCorrect) {
                correctCount++;
                subBucket.correct++;
                subBucket.attemptedCount++;
                const awarded = partialMarks !== null ? partialMarks : qMaxMarks;
                totalScore += awarded;
                subBucket.score += awarded;
                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: q.questionNumber,
                    sectionId: q.sectionId || key?.sectionId || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: "correct",
                    studentAnswer: String(studentChoice),
                    marksAwarded: Number(awarded.toFixed(3)),
                    bonusAwarded: false
                });
            } else {
                incorrectCount++;
                subBucket.incorrect++;
                subBucket.attemptedCount++;
                const deduction = -qPenalty;
                totalScore += deduction;
                subBucket.score += deduction;
                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: q.questionNumber,
                    sectionId: q.sectionId || key?.sectionId || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: "incorrect",
                    studentAnswer: String(studentChoice),
                    marksAwarded: Number(deduction.toFixed(3)),
                    bonusAwarded: false
                });
            }
        }

        totalScore = Number(totalScore.toFixed(3));

        // Calculate subject-wise accuracies and round scores consistently at final boundary
        const subjectAnalysis = {};
        for (const [subId, subData] of subjectMap.entries()) {
            subData.score = Number(subData.score.toFixed(3));
            const attempted = subData.attemptedCount;
            subData.accuracy = attempted > 0
                ? Number(((subData.correct / attempted) * 100).toFixed(2))
                : 0;
            subjectAnalysis[subId] = subData;
        }

        const sectionScores = {};
        for (const item of breakdown) {
            if (item.sectionId) {
                sectionScores[item.sectionId] = Number(((sectionScores[item.sectionId] || 0) + (item.marksAwarded || 0)).toFixed(3));
            }
        }

        const attemptedCount = correctCount + incorrectCount;
        const accuracyPercent = attemptedCount > 0 
            ? Number(((correctCount / attemptedCount) * 100).toFixed(2)) 
            : 0;

        const totalMaximumMarks = Array.from(subjectMap.values()).reduce((sum, s) => sum + s.maximumMarks, 0);
        const percentageScore = totalMaximumMarks > 0 
            ? Number(((totalScore / totalMaximumMarks) * 100).toFixed(2)) 
            : 0;

        return {
            totalScore,
            maximumMarks: totalMaximumMarks,
            percentageScore,
            totalQuestions: questions.length,
            correctCount,
            incorrectCount,
            unansweredCount,
            droppedCount,
            attemptedCount,
            accuracyPercent,
            subjectAnalysis,
            sectionScores,
            breakdown
        };
    }
}
