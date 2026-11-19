import { Rational } from "./rational.js";
import { SubjectNormalizationService } from "../subjectNormalizationService.js";
import { ExamProfileRegistry } from "../admin/examProfileRegistry.js";

/**
 * Universal Examination Architecture — Legacy Scoring Adapter
 * 
 * Bridges historical attempt evaluation requests to the universal scoring architecture
 * while guaranteeing 100% mathematical and behavioral parity with historical attempts.
 * 
 * Employs exact Rational arithmetic internally, serializing with exact historical rounding.
 * Conforms to Universal Examination Architecture Specification v2.8.
 */
export class LegacyScoringAdapter {

    /**
     * Deterministically evaluate a student's attempt preserving historical behavior
     * Supports both positional and object overload signatures.
     */
    static evaluateAttempt(params = {}, legacyAnswerKeys, legacyOptions = {}) {
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

        let totalRational = Rational.ZERO;
        let correctCount = 0;
        let incorrectCount = 0;
        let unansweredCount = 0;
        let droppedCount = 0;
        let pendingReviewCount = 0;

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
                    scoreRational: Rational.ZERO,
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

        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            const qNum = q.questionNumber || i + 1;

            // Match key by stable composite identity: questionId, or (sectionId + questionNumber), or global questionNumber
            const key = answerKeys.find(k => 
                (k.questionId && q.questionId && k.questionId === q.questionId) || 
                (k.sectionId && q.sectionId && k.sectionId === q.sectionId && k.questionNumber === qNum) ||
                (!k.sectionId && !q.sectionId && k.questionNumber && k.questionNumber === qNum)
            );

            // Normalize subject metadata using hybrid resolution
            const rawSubject = q.subjectName || q.subject || q.subjectId || key?.subject || null;
            const normSubject = SubjectNormalizationService.normalizeSubject(rawSubject);
            const subBucket = getSubjectBucket(normSubject.subjectId, normSubject.subjectName);
            subBucket.totalQuestions++;

            const isNumericalQuestion = q.questionType === "numerical" || key?.answerType === "numerical";
            const isMsqQuestion = q.questionType === "msq" || key?.answerType === "msq";
            const isDescriptive = q.questionType === "descriptive" || q.questionType === "subjective" || key?.answerType === "descriptive" || key?.answerType === "subjective";

            // 1. Examination-specific marks awarded for correct answer
            let qMaxRational = null;
            if (Number.isFinite(key?.marksAwarded)) {
                qMaxRational = Rational.from(key.marksAwarded);
            } else if (Number.isFinite(q.marksAwarded)) {
                qMaxRational = Rational.from(q.marksAwarded);
            } else if (isGateExam) {
                // In GATE: Questions 1-5 (GA) & 11-35 (Tech) are 1 mark; 6-10 (GA) & 36-65 (Tech) are 2 marks
                qMaxRational = (qNum <= 5 || (qNum >= 11 && qNum <= 35)) ? Rational.from(1) : Rational.from(2);
            } else if (isBpscExam) {
                qMaxRational = Rational.from(1);
            } else if (isUpscExam) {
                qMaxRational = Rational.from(2);
            } else if (isSscExam) {
                qMaxRational = Rational.from(2);
            } else if (isIbpsExam) {
                qMaxRational = Rational.from(1);
            } else if (isCuetExam) {
                qMaxRational = Rational.from(5);
            } else if (isNeetExam || isJeeExam) {
                qMaxRational = Rational.from(4);
            } else if (examConfig && Array.isArray(examConfig.sections)) {
                const sec = examConfig.sections.find(s => 
                    (q.sectionId && s.id === q.sectionId) || 
                    (qNum >= s.startQuestion && qNum <= s.endQuestion)
                );
                if (Number.isFinite(sec?.markingScheme?.correct)) {
                    qMaxRational = Rational.from(sec.markingScheme.correct);
                }
            } else if (Number.isFinite(examConfig?.scoringRules?.correct)) {
                qMaxRational = Rational.from(examConfig.scoringRules.correct);
            } else if (Number.isFinite(examConfig?.markingScheme?.correct)) {
                qMaxRational = Rational.from(examConfig.markingScheme.correct);
            }

            // Unknown or unverified profiles must not silently receive +4/-1
            if (qMaxRational === null) {
                if (examConfig?.adminApprovedForScoring === true) {
                    qMaxRational = Rational.from(examConfig.defaultMarks || 1);
                } else {
                    const err = new Error(`UNVERIFIED_EXAM_SCORING_REJECTED: Examination '${examId || "unknown"}' is unverified and has no explicit marking scheme. Scoring rejected pending administrative approval.`);
                    err.code = "UNVERIFIED_EXAM_SCORING_REJECTED";
                    throw err;
                }
            }
            subBucket.maximumMarks += qMaxRational.toNumber(3);

            // 2. Examination-specific negative deduction penalty
            let qPenaltyRational = Rational.ZERO;
            if (isDescriptive) {
                // Descriptive questions never incur negative deductions
                qPenaltyRational = Rational.ZERO;
            } else if (Number.isFinite(key?.marksDeducted)) {
                qPenaltyRational = Rational.from(Math.abs(key.marksDeducted));
            } else if (Number.isFinite(key?.negativeMarks)) {
                qPenaltyRational = Rational.from(Math.abs(key.negativeMarks));
            } else if (Number.isFinite(q.marksDeducted)) {
                qPenaltyRational = Rational.from(Math.abs(q.marksDeducted));
            } else if (Number.isFinite(q.negativeMarks)) {
                qPenaltyRational = Rational.from(Math.abs(q.negativeMarks));
            } else if (isGateExam) {
                if (isMsqQuestion || isNumericalQuestion) {
                    qPenaltyRational = Rational.ZERO;
                } else {
                    qPenaltyRational = qMaxRational.equals(Rational.from(1)) ? new Rational(1, 3) : new Rational(2, 3);
                }
            } else if (isBpscExam) {
                qPenaltyRational = new Rational(1, 3);
            } else if (isUpscExam) {
                qPenaltyRational = new Rational(2, 3);
            } else if (isSscExam) {
                qPenaltyRational = new Rational(1, 2);
            } else if (isIbpsExam) {
                qPenaltyRational = new Rational(1, 4);
            } else if (isJeeExam || isNeetExam || isCuetExam) {
                qPenaltyRational = Rational.from(1);
            } else if (isMsqQuestion) {
                qPenaltyRational = Rational.ZERO;
            } else if (examConfig && Array.isArray(examConfig.sections)) {
                const sec = examConfig.sections.find(s => 
                    (q.sectionId && s.id === q.sectionId) || 
                    (qNum >= s.startQuestion && qNum <= s.endQuestion)
                );
                if (Number.isFinite(sec?.markingScheme?.incorrect)) {
                    qPenaltyRational = Rational.from(Math.abs(sec.markingScheme.incorrect));
                }
            } else if (Number.isFinite(examConfig?.scoringRules?.incorrect)) {
                qPenaltyRational = Rational.from(Math.abs(examConfig.scoringRules.incorrect));
            } else if (Number.isFinite(examConfig?.markingScheme?.incorrect)) {
                qPenaltyRational = Rational.from(Math.abs(examConfig.markingScheme.incorrect));
            }

            const studentChoice = (studentAnswers[q.questionId] !== undefined
                ? studentAnswers[q.questionId]
                : (q.sectionId && studentAnswers[`${q.sectionId}_${qNum}`] !== undefined)
                    ? studentAnswers[`${q.sectionId}_${qNum}`]
                    : studentAnswers[qNum] !== undefined
                        ? studentAnswers[qNum]
                        : studentAnswers[String(qNum)]);

            // Historical Dropped Question Policy: Unconditional bonus marks awarded to all candidates
            if (key?.isDropped) {
                droppedCount++;
                subBucket.dropped++;
                totalRational = totalRational.add(qMaxRational);
                subBucket.scoreRational = subBucket.scoreRational.add(qMaxRational);
                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: qNum,
                    sectionId: q.sectionId || key?.sectionId || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: "dropped",
                    studentAnswer: studentChoice !== undefined && studentChoice !== null ? String(studentChoice) : null,
                    marksAwarded: qMaxRational.toNumber(3),
                    rationalScore: qMaxRational,
                    bonusAwarded: true
                });
                continue;
            }

            // Unanswered Question
            if (studentChoice === undefined || studentChoice === null || studentChoice === "") {
                unansweredCount++;
                subBucket.unattempted++;
                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: qNum,
                    sectionId: q.sectionId || key?.sectionId || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: "unanswered",
                    studentAnswer: null,
                    marksAwarded: 0,
                    rationalScore: Rational.ZERO,
                    bonusAwarded: false
                });
                continue;
            }

            // Descriptive Question Safeguard: Never score objectively or apply MCQ penalties
            if (isDescriptive) {
                const manualAwarded = Number.isFinite(q.manualMarksAwarded) ? Rational.from(q.manualMarksAwarded) : null;
                if (manualAwarded !== null) {
                    correctCount++;
                    subBucket.correct++;
                    subBucket.attemptedCount++;
                    totalRational = totalRational.add(manualAwarded);
                    subBucket.scoreRational = subBucket.scoreRational.add(manualAwarded);
                    breakdown.push({
                        questionId: q.questionId,
                        questionNumber: qNum,
                        sectionId: q.sectionId || key?.sectionId || null,
                        subject: normSubject.subjectName,
                        subjectId: normSubject.subjectId,
                        subjectName: normSubject.subjectName,
                        status: "manually_graded",
                        studentAnswer: String(studentChoice),
                        marksAwarded: manualAwarded.toNumber(3),
                        rationalScore: manualAwarded,
                        bonusAwarded: false,
                        requiresManualEvaluation: false,
                        manualMarksAwarded: manualAwarded.toNumber(3)
                    });
                } else {
                    pendingReviewCount++;
                    subBucket.attemptedCount++;
                    breakdown.push({
                        questionId: q.questionId,
                        questionNumber: qNum,
                        sectionId: q.sectionId || key?.sectionId || null,
                        subject: normSubject.subjectName,
                        subjectId: normSubject.subjectId,
                        subjectName: normSubject.subjectName,
                        status: "pending_manual_review",
                        studentAnswer: String(studentChoice),
                        marksAwarded: 0,
                        rationalScore: Rational.ZERO,
                        bonusAwarded: false,
                        requiresManualEvaluation: true
                    });
                }
                continue;
            }

            // Answer Evaluation
            let isCorrect = false;
            let partialMarksRational = null;

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
                    isCorrect = true;
                    partialMarksRational = Rational.from(Math.min(qMaxRational.toNumber(3), uniqueStudent.length));
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
                const awarded = partialMarksRational !== null ? partialMarksRational : qMaxRational;
                totalRational = totalRational.add(awarded);
                subBucket.scoreRational = subBucket.scoreRational.add(awarded);
                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: qNum,
                    sectionId: q.sectionId || key?.sectionId || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: "correct",
                    studentAnswer: String(studentChoice),
                    marksAwarded: awarded.toNumber(3),
                    rationalScore: awarded,
                    bonusAwarded: false
                });
            } else {
                incorrectCount++;
                subBucket.incorrect++;
                subBucket.attemptedCount++;
                const deduction = qPenaltyRational.neg();
                totalRational = totalRational.add(deduction);
                subBucket.scoreRational = subBucket.scoreRational.add(deduction);
                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: qNum,
                    sectionId: q.sectionId || key?.sectionId || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: "incorrect",
                    studentAnswer: String(studentChoice),
                    marksAwarded: deduction.toNumber(3),
                    rationalScore: deduction,
                    bonusAwarded: false
                });
            }
        }

        const totalScore = totalRational.toNumber(3);

        // Subject Analysis Calculation with historical rounding
        const subjectAnalysis = {};
        for (const [subId, subData] of subjectMap.entries()) {
            const attempted = subData.attemptedCount;
            subData.score = subData.scoreRational.toNumber(3);
            delete subData.scoreRational;
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

        const attemptedCount = correctCount + incorrectCount + pendingReviewCount;
        const accuracyPercent = attemptedCount > 0 
            ? Number(((correctCount / attemptedCount) * 100).toFixed(2)) 
            : 0;

        const totalMaximumMarks = Array.from(subjectMap.values()).reduce((sum, s) => sum + s.maximumMarks, 0);
        const percentageScore = totalMaximumMarks > 0 
            ? Number(((totalScore / totalMaximumMarks) * 100).toFixed(2)) 
            : 0;

        return {
            totalScore,
            rationalScore: totalRational,
            maximumMarks: totalMaximumMarks,
            percentageScore,
            totalQuestions: questions.length,
            correctCount,
            incorrectCount,
            unansweredCount,
            droppedCount,
            attemptedCount,
            pendingReviewCount,
            requiresManualEvaluation: pendingReviewCount > 0,
            isFinalized: pendingReviewCount === 0,
            accuracyPercent,
            subjectAnalysis,
            sectionScores,
            breakdown
        };
    }
}

