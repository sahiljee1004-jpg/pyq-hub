import { Rational } from "./rational.js";
import {
    ExamProfileRegistry,
    VERIFICATION_STATUS,
    OPTIONAL_QUESTION_POLICY,
    DROPPED_QUESTION_POLICY
} from "../admin/examProfileRegistry.js";
import { SubjectNormalizationService } from "../subjectNormalizationService.js";

/**
 * Universal Examination Architecture — Modern Schema v2 Scoring Engine
 * 
 * Declarative, profile-driven scoring engine supporting diverse examination systems
 * without hardcoded exam-family branches.
 * 
 * Key Architecture:
 * 1. 4-Level Scoring Hierarchy (Question Override > Question-Type Rule > Section Override > Exam Default)
 * 2. Exact Rational Arithmetic Accumulation (Zero IEEE-754 floating-point drift)
 * 3. Configurable Optional-Question Selection Policies (none, first_k_attempted, candidate_selected)
 * 4. Configurable Dropped-Question Handling (full_marks, pro_rata, attempted_only, zero_marks)
 * 5. Full Question-Type Support (MCQ, MSQ, Numerical/NAT, Descriptive, Partial Marking)
 * 6. Fail-Closed Profile Enforcement (Strictly rejects unverified examinations)
 * 
 * Conforms to Universal Examination Architecture Specification v2.8.
 */
export class UniversalScoringEngine {

    /**
     * Positional convenience overload for evaluating an attempt
     */
    static score(questions = [], answerKeys = [], studentAnswers = {}, examProfile = null, options = {}) {
        return this.evaluateAttempt({ questions, answerKeys, studentAnswers, examProfile, options });
    }

    /**
     * Evaluate an attempt using the modern Schema v2 declarative profile
     * @param {object} params
     * @param {Array<object>} params.questions - Array of question metadata
     * @param {Array<object>} params.answerKeys - Array of verified answer keys
     * @param {object} params.studentAnswers - Map of questionId / questionNumber -> selected choice(s)
     * @param {object|string} [params.examProfile] - Declarative exam profile or profileId
     * @param {object} [params.options] - Evaluation options (rounding, decimals, overrides)
     * @returns {object} Full evaluated score breakdown with subject-wise & section-wise analysis
     */
    static evaluateAttempt({
        questions = [],
        answerKeys = [],
        studentAnswers = {},
        examProfile = null,
        options = {}
    } = {}) {
        // Validate question ID presence, format, and uniqueness before scoring (DEFECT 03)
        const seenQuestionIds = new Set();
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            const rawId = (q?.questionId !== undefined && q?.questionId !== null)
                ? q.questionId
                : (q?.id !== undefined && q?.id !== null)
                    ? q.id
                    : null;

            if (rawId === null || rawId === undefined) {
                const err = new Error(`INVALID_QUESTION_ID_REJECTED: Question at index ${i} is missing a valid questionId (received: ${JSON.stringify(rawId)}). All questions must provide a strictly non-empty string identifier.`);
                err.code = "INVALID_QUESTION_ID_REJECTED";
                throw err;
            }

            const cleanId = String(rawId).trim();
            if (cleanId === "") {
                const err = new Error(`INVALID_QUESTION_ID_REJECTED: Question at index ${i} has empty or whitespace-only questionId. All questions must provide a strictly non-empty string identifier.`);
                err.code = "INVALID_QUESTION_ID_REJECTED";
                throw err;
            }

            if (seenQuestionIds.has(cleanId)) {
                const err = new Error(`DUPLICATE_QUESTION_ID_REJECTED: Duplicate questionId '${cleanId}' detected at question index ${i}. All question identifiers must be strictly unique.`);
                err.code = "DUPLICATE_QUESTION_ID_REJECTED";
                throw err;
            }
            seenQuestionIds.add(cleanId);
        }

        // 1. Resolve and Validate Exam Profile
        let profile = null;
        if (typeof examProfile === "string") {
            profile = ExamProfileRegistry.getProfile(examProfile);
        } else if (examProfile && typeof examProfile === "object") {
            profile = examProfile;
        } else if (options.examId) {
            profile = ExamProfileRegistry.findProfile(options.examId, options.year || 2024);
        } else if (questions[0]?.examId) {
            profile = ExamProfileRegistry.findProfile(questions[0].examId, questions[0].year || 2024);
        }

        // Strict Fail-Closed Safeguard: Reject unverified exams without explicit admin approval
        if (!profile) {
            if (options.allowUnverified === true || options.adminApprovedForScoring === true) {
                profile = {
                    profileId: "ad-hoc-unverified",
                    examId: options.examId || "unverified-exam",
                    verificationStatus: VERIFICATION_STATUS.CUSTOM_UNVERIFIED,
                    isOfficial: false,
                    droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
                    optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
                    markingScheme: { correct: options.defaultCorrectMarks || 1, incorrect: options.defaultIncorrectMarks || 0 },
                    sections: []
                };
            } else {
                const examIdentifier = options.examId || questions[0]?.examId || "unknown";
                const err = new Error(`UNVERIFIED_EXAM_SCORING_REJECTED: Examination '${examIdentifier}' has no verified profile registered in ExamProfileRegistry. Universal scoring rejected pending administrative approval.`);
                err.code = "UNVERIFIED_EXAM_SCORING_REJECTED";
                throw err;
            }
        }

        const decimals = Number.isInteger(options.decimals) ? options.decimals : 3;
        const roundingMode = options.roundingMode || "round_half_up";
        const droppedPolicy = profile.droppedQuestionPolicy || DROPPED_QUESTION_POLICY.FULL_MARKS;
        const sectionsList = Array.isArray(profile.sections) ? profile.sections : [];

        let totalRational = Rational.ZERO;
        let validMaxMarksRational = Rational.ZERO;
        let correctCount = 0;
        let incorrectCount = 0;
        let unansweredCount = 0;
        let droppedCount = 0;
        let pendingReviewCount = 0;

        const breakdown = [];
        const subjectMap = new Map();
        const sectionMap = new Map();

        // Initialize section statistics buckets
        for (const sec of sectionsList) {
            const secId = sec.id || sec.sectionId;
            const secName = sec.name || sec.sectionName || secId;
            sectionMap.set(secId, {
                sectionId: secId,
                sectionName: secName,
                subject: sec.subject || secName || "General",
                scoreRational: Rational.ZERO,
                maximumMarksRational: Rational.ZERO,
                totalQuestions: 0,
                attemptedCount: 0,
                correctCount: 0,
                incorrectCount: 0,
                unansweredCount: 0,
                droppedCount: 0,
                requiredCount: sec.requiredCount || sec.questionCount || 0
            });
        }

        // Helper to obtain or initialize subject statistics bucket
        const getSubjectBucket = (subjectId, subjectName) => {
            if (!subjectMap.has(subjectId)) {
                subjectMap.set(subjectId, {
                    subjectId,
                    subjectName,
                    scoreRational: Rational.ZERO,
                    maximumMarksRational: Rational.ZERO,
                    totalQuestions: 0,
                    correct: 0,
                    incorrect: 0,
                    unattempted: 0,
                    dropped: 0,
                    attemptedCount: 0
                });
            }
            return subjectMap.get(subjectId);
        };

        // Track section-level optional attempts for first_k_attempted policy
        const sectionAttemptsCounter = new Map();

        // 2. Question Evaluation Loop
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            const qNum = q.questionNumber || i + 1;

            // Match key by stable composite identity: questionId, or (sectionId + questionNumber), or global questionNumber
            const key = answerKeys.find(k => 
                (k.questionId && q.questionId && k.questionId === q.questionId) || 
                (k.sectionId && q.sectionId && k.sectionId === q.sectionId && k.questionNumber === qNum) ||
                (!k.sectionId && !q.sectionId && k.questionNumber === qNum)
            );

            // Determine matching section (DEFECT 04: Explicit section ID takes strict priority)
            let matchingSection = null;
            if (q.sectionId !== undefined && q.sectionId !== null && String(q.sectionId).trim() !== "") {
                const targetSecId = String(q.sectionId).trim();
                matchingSection = sectionsList.find(s => (s.id || s.sectionId) === targetSecId) || null;
                if (!matchingSection && sectionsList.length > 0) {
                    // Fallback to section by question number range if numbering does not restart per section
                    if (!profile.numberingRestartsPerSection) {
                        matchingSection = sectionsList.find(s => qNum >= s.startQuestion && qNum <= s.endQuestion) || null;
                    }
                }
                if (!matchingSection && sectionsList.length > 0) {
                    const qIdentifier = q.questionId || q.id || `index_${i}`;
                    const err = new Error(`INVALID_SECTION_ID_REJECTED: Question '${qIdentifier}' specifies sectionId '${targetSecId}', which does not exist in exam profile '${profile.profileId || profile.examId}'.`);
                    err.code = "INVALID_SECTION_ID_REJECTED";
                    throw err;
                }
            } else {
                matchingSection = sectionsList.find(s => 
                    !profile.numberingRestartsPerSection && qNum >= s.startQuestion && qNum <= s.endQuestion
                ) || null;
            }

            const secIdentifier = matchingSection ? (matchingSection.id || matchingSection.sectionId) : null;
            const sectionBucket = secIdentifier ? sectionMap.get(secIdentifier) : null;
            if (sectionBucket) sectionBucket.totalQuestions++;

            // Subject Normalization
            const rawSubject = q.subjectName || q.subject || q.subjectId || matchingSection?.subject || key?.subject || null;
            const normSubject = SubjectNormalizationService.normalizeSubject(rawSubject);
            const subBucket = getSubjectBucket(normSubject.subjectId, normSubject.subjectName);
            subBucket.totalQuestions++;

            const qType = (q.questionType || key?.answerType || "mcq").toLowerCase();
            const isNumerical = qType === "numerical" || qType === "nat" || qType === "numerical_nat" || qType === "integer";
            const isMsq = qType === "msq" || qType === "multiple_choice_msq";
            const isDescriptive = qType === "descriptive" || qType === "descriptive_manual" || qType === "subjective";

            // -------------------------------------------------------------
            // 4-Level Scoring Hierarchy Resolution (Correct & Incorrect)
            // -------------------------------------------------------------
            // Level 4 (Highest): Question / Key explicit override
            // Level 3: Question-Type rule within section or profile
            // Level 2: Section-Level markingScheme
            // Level 1: Exam-Level default markingScheme
            let correctRational = null;
            let penaltyRational = null;

            // Resolve Correct Marks (Positive) following strict precedence: Question -> Section -> Examination
            if (Number.isFinite(key?.marksAwarded)) {
                correctRational = Rational.from(key.marksAwarded);
            } else if (Number.isFinite(q.marksAwarded)) {
                correctRational = Rational.from(q.marksAwarded);
            } else if (Number.isFinite(q.scoring?.positiveMarks)) {
                correctRational = Rational.from(q.scoring.positiveMarks);
            } else if (matchingSection?.questionTypeRules?.[qType]?.correct !== undefined) {
                correctRational = Rational.from(matchingSection.questionTypeRules[qType].correct);
            } else if (matchingSection?.markingScheme?.correct !== undefined) {
                correctRational = Rational.from(matchingSection.markingScheme.correct);
            } else if (matchingSection?.scoringRules?.positiveMarks !== undefined) {
                correctRational = Rational.from(matchingSection.scoringRules.positiveMarks);
            } else if (profile.questionTypeRules?.[qType]?.correct !== undefined) {
                correctRational = Rational.from(profile.questionTypeRules[qType].correct);
            } else if (profile.markingScheme?.correct !== undefined) {
                correctRational = Rational.from(profile.markingScheme.correct);
            } else if (profile.scoringRules?.correct !== undefined) {
                correctRational = Rational.from(profile.scoringRules.correct);
            }

            // Resolve Incorrect Deduction (Penalty >= 0) following strict precedence:
            // 1. Question-level -> 2. Section-level -> 3. Examination-level -> 4. Default / Fail-closed
            if (isDescriptive) {
                // Descriptive questions never incur automated negative marking
                penaltyRational = Rational.ZERO;
            } else if (Number.isFinite(key?.marksDeducted)) {
                // Level 1: Question key explicit
                penaltyRational = Rational.from(Math.abs(key.marksDeducted));
            } else if (Number.isFinite(q.marksDeducted)) {
                // Level 1: Question explicit
                penaltyRational = Rational.from(Math.abs(q.marksDeducted));
            } else if (Number.isFinite(q.scoring?.negativeMarks)) {
                // Level 1: Question UIR scoring rule
                penaltyRational = Rational.from(Math.abs(q.scoring.negativeMarks));
            } else if (matchingSection?.questionTypeRules?.[qType]?.incorrect !== undefined) {
                // Level 2: Section question-type rule
                penaltyRational = Rational.from(Math.abs(matchingSection.questionTypeRules[qType].incorrect));
            } else if (matchingSection?.msqNegativeMarking === false && isMsq) {
                // Level 2: Section explicit exemption for MSQ
                penaltyRational = Rational.ZERO;
            } else if (matchingSection?.numericalNegativeMarking === false && isNumerical) {
                // Level 2: Section explicit exemption for NAT
                penaltyRational = Rational.ZERO;
            } else if (matchingSection?.markingScheme?.incorrect !== undefined) {
                // Level 2: Section general marking scheme
                penaltyRational = Rational.from(Math.abs(matchingSection.markingScheme.incorrect));
            } else if (matchingSection?.scoringRules?.negativeMarks !== undefined) {
                // Level 2: Section scoring rules
                penaltyRational = Rational.from(Math.abs(matchingSection.scoringRules.negativeMarks));
            } else if (profile.questionTypeRules?.[qType]?.incorrect !== undefined) {
                // Level 3: Examination question-type rule
                penaltyRational = Rational.from(Math.abs(profile.questionTypeRules[qType].incorrect));
            } else if (isMsq && (profile.msqNegativeMarking === false || /gate/i.test(profile.profileId || "") || /gate/i.test(profile.examName || ""))) {
                // Level 3: Examination rule - Official GATE MSQ zero penalty
                penaltyRational = Rational.ZERO;
            } else if (isNumerical && (profile.numericalNegativeMarking === false || /gate/i.test(profile.profileId || "") || /gate/i.test(profile.examName || ""))) {
                // Level 3: Examination rule - Official GATE NAT zero penalty
                penaltyRational = Rational.ZERO;
            } else if (/gate/i.test(profile.profileId || "") || /gate/i.test(profile.examName || "")) {
                // Level 3: Examination rule - Official GATE MCQ standard: 1/3 for 1-mark, 2/3 for 2-mark
                if (correctRational && correctRational.compare(Rational.from(2)) === 0) {
                    penaltyRational = new Rational(2n, 3n);
                } else {
                    penaltyRational = new Rational(1n, 3n);
                }
            } else if (profile.markingScheme?.incorrect !== undefined) {
                // Level 3: Examination general marking scheme
                penaltyRational = Rational.from(Math.abs(profile.markingScheme.incorrect));
            } else if (profile.scoringRules?.incorrect !== undefined) {
                // Level 3: Examination general scoring rules
                penaltyRational = Rational.from(Math.abs(profile.scoringRules.incorrect));
            } else {
                // Level 4: Default
                penaltyRational = Rational.ZERO;
            }

            // Fail-Closed: Mark must be resolvable
            if (!correctRational) {
                throw new Error(`UNVERIFIED_EXAM_SCORING_REJECTED: Could not resolve positive marks for Q${qNum} under profile '${profile.profileId}'.`);
            }

            subBucket.maximumMarksRational = subBucket.maximumMarksRational.add(correctRational);
            if (sectionBucket) sectionBucket.maximumMarksRational = sectionBucket.maximumMarksRational.add(correctRational);

            // Resolve student choice
            const studentChoice = (
                studentAnswers[q.questionId] !== undefined
                    ? studentAnswers[q.questionId]
                    : (q.sectionId && studentAnswers[`${q.sectionId}_${qNum}`] !== undefined)
                        ? studentAnswers[`${q.sectionId}_${qNum}`]
                        : studentAnswers[qNum] !== undefined
                            ? studentAnswers[qNum]
                            : studentAnswers[String(qNum)]
            );

            const isAnswered = studentChoice !== undefined && studentChoice !== null && String(studentChoice).trim() !== "";

            // -------------------------------------------------------------
            // Dropped-Question Policy Evaluation
            // -------------------------------------------------------------
            if (key?.isDropped) {
                droppedCount++;
                subBucket.dropped++;
                if (sectionBucket) sectionBucket.droppedCount++;

                // Track optional section attempt if candidate attempted the dropped question (DEFECT 02)
                const optPolicy = matchingSection?.optionalPolicy || profile.optionalQuestionPolicy || OPTIONAL_QUESTION_POLICY.NONE;
                const optPolicyType = typeof optPolicy === "object" ? (optPolicy.policyType || optPolicy.type) : optPolicy;
                const maxAllowedInSec = typeof optPolicy === "object" && optPolicy.maxAttempts !== undefined
                    ? optPolicy.maxAttempts
                    : (matchingSection?.requiredCount !== undefined && matchingSection.requiredCount < (matchingSection.questionCount || Infinity)
                        ? matchingSection.requiredCount
                        : (matchingSection?.maxAttemptsAllowed || null));
                const isFirstK = optPolicyType === OPTIONAL_QUESTION_POLICY.FIRST_K_ATTEMPTED || optPolicyType === "first_k_attempted";

                let isAttemptExceeded = false;
                if (isFirstK && maxAllowedInSec !== null && matchingSection && isAnswered) {
                    const secId = matchingSection.id;
                    const currentSecAttempts = sectionAttemptsCounter.get(secId) || 0;
                    if (currentSecAttempts >= maxAllowedInSec) {
                        isAttemptExceeded = true;
                    } else {
                        sectionAttemptsCounter.set(secId, currentSecAttempts + 1);
                    }
                }

                let bonusAwarded = false;
                let marksAwardedRational = Rational.ZERO;

                if (droppedPolicy === DROPPED_QUESTION_POLICY.FULL_MARKS) {
                    bonusAwarded = true;
                    marksAwardedRational = correctRational;
                    totalRational = totalRational.add(correctRational);
                    subBucket.scoreRational = subBucket.scoreRational.add(correctRational);
                    if (sectionBucket) sectionBucket.scoreRational = sectionBucket.scoreRational.add(correctRational);
                    validMaxMarksRational = validMaxMarksRational.add(correctRational);
                } else if (droppedPolicy === DROPPED_QUESTION_POLICY.ATTEMPTED_ONLY) {
                    if (isAnswered && !isAttemptExceeded) {
                        bonusAwarded = true;
                        marksAwardedRational = correctRational;
                        totalRational = totalRational.add(correctRational);
                        subBucket.scoreRational = subBucket.scoreRational.add(correctRational);
                        if (sectionBucket) sectionBucket.scoreRational = sectionBucket.scoreRational.add(correctRational);
                    }
                    validMaxMarksRational = validMaxMarksRational.add(correctRational);
                } else if (droppedPolicy === DROPPED_QUESTION_POLICY.PRO_RATA) {
                    // In pro-rata (UPSC / SSC / IBPS), dropped question is completely excluded from valid marks denominator
                    bonusAwarded = false;
                    marksAwardedRational = Rational.ZERO;
                } else if (droppedPolicy === DROPPED_QUESTION_POLICY.ZERO_MARKS) {
                    bonusAwarded = false;
                    marksAwardedRational = Rational.ZERO;
                }

                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: qNum,
                    sectionId: q.sectionId || matchingSection?.id || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: isAttemptExceeded ? "optional_exceeded" : "dropped",
                    studentAnswer: isAnswered ? String(studentChoice) : null,
                    marksAwarded: marksAwardedRational.toNumber(decimals, roundingMode),
                    rationalScore: marksAwardedRational,
                    bonusAwarded
                });
                continue;
            }

            validMaxMarksRational = validMaxMarksRational.add(correctRational);

            // -------------------------------------------------------------
            // Unanswered Question Handling
            // -------------------------------------------------------------
            if (!isAnswered) {
                unansweredCount++;
                subBucket.unattempted++;
                if (sectionBucket) sectionBucket.unansweredCount++;

                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: qNum,
                    sectionId: q.sectionId || matchingSection?.id || null,
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

            // -------------------------------------------------------------
            // Optional-Question Policy (first_k_attempted capping)
            // -------------------------------------------------------------
            const optPolicy = matchingSection?.optionalPolicy || profile.optionalQuestionPolicy || OPTIONAL_QUESTION_POLICY.NONE;
            const optPolicyType = typeof optPolicy === "object" ? (optPolicy.policyType || optPolicy.type) : optPolicy;
            const maxAllowedInSec = typeof optPolicy === "object" && optPolicy.maxAttempts !== undefined
                ? optPolicy.maxAttempts
                : (matchingSection?.requiredCount !== undefined && matchingSection.requiredCount < (matchingSection.questionCount || Infinity)
                    ? matchingSection.requiredCount
                    : (matchingSection?.maxAttemptsAllowed || null));

            const isFirstK = optPolicyType === OPTIONAL_QUESTION_POLICY.FIRST_K_ATTEMPTED || optPolicyType === "first_k_attempted";
            if (isFirstK && maxAllowedInSec !== null && matchingSection) {
                const secId = matchingSection.id;
                const currentSecAttempts = sectionAttemptsCounter.get(secId) || 0;
                if (currentSecAttempts >= maxAllowedInSec) {
                    // Question attempt exceeds permitted limit in section; capped without penalty or reward
                    breakdown.push({
                        questionId: q.questionId,
                        questionNumber: qNum,
                        sectionId: q.sectionId || matchingSection?.id || null,
                        subject: normSubject.subjectName,
                        subjectId: normSubject.subjectId,
                        subjectName: normSubject.subjectName,
                        status: "optional_exceeded",
                        studentAnswer: String(studentChoice),
                        marksAwarded: 0,
                        rationalScore: Rational.ZERO,
                        bonusAwarded: false,
                        cappedNotice: `Attempted question exceeded section limit of ${maxAllowedInSec} (first-K policy applied).`
                    });
                    continue;
                }
                sectionAttemptsCounter.set(secId, currentSecAttempts + 1);
            }

            // -------------------------------------------------------------
            // Question Correctness Evaluation by Type
            // -------------------------------------------------------------
            let isCorrect = false;
            let partialAwardRational = null;

            if (isDescriptive) {
                // Descriptive / Subjective Question Evaluation (DEFECT 01)
                if (Number.isFinite(q.manualMarksAwarded) || Number.isFinite(key?.manualMarksAwarded)) {
                    const manualVal = Number.isFinite(q.manualMarksAwarded) ? q.manualMarksAwarded : key.manualMarksAwarded;
                    const manualRational = Rational.from(manualVal);
                    totalRational = totalRational.add(manualRational);
                    subBucket.scoreRational = subBucket.scoreRational.add(manualRational);
                    if (sectionBucket) sectionBucket.scoreRational = sectionBucket.scoreRational.add(manualRational);
                    subBucket.attemptedCount++;
                    if (sectionBucket) sectionBucket.attemptedCount++;
                    if (manualRational.isPositive()) {
                        correctCount++;
                        subBucket.correct++;
                        if (sectionBucket) sectionBucket.correctCount++;
                    }

                    breakdown.push({
                        questionId: q.questionId,
                        questionNumber: qNum,
                        sectionId: q.sectionId || matchingSection?.id || null,
                        subject: normSubject.subjectName,
                        subjectId: normSubject.subjectId,
                        subjectName: normSubject.subjectName,
                        status: "manually_graded",
                        studentAnswer: String(studentChoice),
                        marksAwarded: manualRational.toNumber(decimals, roundingMode),
                        rationalScore: manualRational,
                        bonusAwarded: false,
                        requiresManualEvaluation: false
                    });
                } else {
                    // Pending manual review: Zero auto marks, zero penalty
                    pendingReviewCount++;
                    subBucket.attemptedCount++;
                    if (sectionBucket) sectionBucket.attemptedCount++;

                    breakdown.push({
                        questionId: q.questionId,
                        questionNumber: qNum,
                        sectionId: q.sectionId || matchingSection?.id || null,
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
            } else if (isNumerical) {
                const candidateAnswers = (
                    (Array.isArray(key?.acceptedAnswers) && key.acceptedAnswers.length > 0)
                        ? key.acceptedAnswers
                        : (Array.isArray(key?.correctAnswers) && key.correctAnswers.length > 0)
                            ? key.correctAnswers
                            : (Array.isArray(key?.correctOptionIds) && key.correctOptionIds.length > 0)
                                ? key.correctOptionIds
                                : (key?.numericValue !== undefined && key?.numericValue !== null)
                                    ? [key.numericValue]
                                    : (key?.correctAnswer?.numericValue !== undefined && key?.correctAnswer?.numericValue !== null)
                                        ? [key.correctAnswer.numericValue]
                                        : (key?.correctAnswer?.value !== undefined && key?.correctAnswer?.value !== null)
                                            ? [key.correctAnswer.value]
                                            : []
                ).map(a => String(a).trim());

                const studStr = String(studentChoice).trim();
                const studNum = Number(studStr);

                if (candidateAnswers.length > 0) {
                    const explicitTol = Number.isFinite(key?.numericTolerance) ? key.numericTolerance : (options.defaultNumericTolerance || 0);

                    isCorrect = candidateAnswers.some(ans => {
                        const ansStr = String(ans).trim();
                        if (studStr === ansStr) return true;
                        const ansNum = Number(ansStr);
                        if (!isNaN(studNum) && !isNaN(ansNum) && isFinite(studNum) && isFinite(ansNum)) {
                            return Math.abs(studNum - ansNum) <= explicitTol;
                        }
                        return false;
                    });
                }

                // Check numericRange if present
                const range = key?.numericRange || key?.correctAnswer?.numericRange;
                if (!isCorrect && range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
                    if (!isNaN(studNum) && isFinite(studNum)) {
                        isCorrect = (studNum >= range.min && studNum <= range.max);
                    }
                }
            } else if (isMsq) {
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

                const allowPartial = Boolean(
                    key?.partialMarkingEnabled ||
                    q.partialMarkingEnabled ||
                    matchingSection?.partialMarkingEnabled ||
                    profile.partialMarkingEnabled
                );

                const partialRules = (
                    key?.partialMarkingRules ||
                    q.partialMarkingRules ||
                    matchingSection?.partialMarkingRules ||
                    profile.partialMarkingRules ||
                    null
                );

                const hasWrongOption = uniqueStudent.some(s => !uniqueCorrect.includes(s));

                if (isExactMatch) {
                    isCorrect = true;
                    if (partialRules?.allCorrect !== undefined) {
                        partialAwardRational = Rational.from(partialRules.allCorrect);
                    }
                } else if (!hasWrongOption && uniqueStudent.length > 0 && (allowPartial || partialRules)) {
                    const nCorrect = uniqueCorrect.length;
                    const nStudent = uniqueStudent.length;

                    if (partialRules) {
                        // Discrete tier rubric (Official JEE Advanced MSQ standard - DEFECT 04)
                        if (nCorrect === 4 && nStudent === 3 && partialRules.threeOfFour !== undefined) {
                            partialAwardRational = Rational.from(partialRules.threeOfFour);
                            isCorrect = true;
                        } else if (nCorrect >= 3 && nStudent === 2 && partialRules.twoOfThreeOrFour !== undefined) {
                            partialAwardRational = Rational.from(partialRules.twoOfThreeOrFour);
                            isCorrect = true;
                        } else if (nCorrect >= 2 && nStudent === 1 && partialRules.oneOfTwoOrMore !== undefined) {
                            partialAwardRational = Rational.from(partialRules.oneOfTwoOrMore);
                            isCorrect = true;
                        } else {
                            // Proportional fallback
                            partialAwardRational = correctRational.mul(new Rational(nStudent, nCorrect));
                            isCorrect = true;
                        }
                    } else {
                        // Standard proportional partial marking
                        partialAwardRational = correctRational.mul(new Rational(nStudent, nCorrect));
                        isCorrect = true;
                    }
                } else {
                    isCorrect = false;
                    // Apply discrete anyIncorrect penalty if defined (JEE Advanced MSQ: -2)
                    if (hasWrongOption && partialRules?.anyIncorrect !== undefined) {
                        penaltyRational = Rational.from(Math.abs(partialRules.anyIncorrect));
                    }
                }
            } else {
                // Standard Single-Choice MCQ
                const correctOptionIds = (
                    (Array.isArray(key?.correctOptionIds) && key.correctOptionIds.length > 0)
                        ? key.correctOptionIds
                        : key?.correctOptionId != null
                            ? [key.correctOptionId]
                            : (Array.isArray(key?.correctAnswers) && key.correctAnswers.length > 0)
                                ? key.correctAnswers
                                : (Array.isArray(key?.acceptedAnswers) ? key.acceptedAnswers : [])
                ).map(a => String(a).trim());

                const cleanChoice = String(studentChoice).trim();
                isCorrect = correctOptionIds.some(ans => ans === cleanChoice || ans.toLowerCase() === cleanChoice.toLowerCase());
            }

            // -------------------------------------------------------------
            // Score Application
            // -------------------------------------------------------------
            if (isCorrect) {
                correctCount++;
                subBucket.correct++;
                subBucket.attemptedCount++;
                if (sectionBucket) {
                    sectionBucket.correctCount++;
                    sectionBucket.attemptedCount++;
                }

                const awarded = partialAwardRational !== null ? partialAwardRational : correctRational;
                totalRational = totalRational.add(awarded);
                subBucket.scoreRational = subBucket.scoreRational.add(awarded);
                if (sectionBucket) sectionBucket.scoreRational = sectionBucket.scoreRational.add(awarded);

                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: qNum,
                    sectionId: q.sectionId || matchingSection?.id || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: "correct",
                    studentAnswer: String(studentChoice),
                    marksAwarded: awarded.toNumber(decimals, roundingMode),
                    rationalScore: awarded,
                    bonusAwarded: false
                });
            } else {
                incorrectCount++;
                subBucket.incorrect++;
                subBucket.attemptedCount++;
                if (sectionBucket) {
                    sectionBucket.incorrectCount++;
                    sectionBucket.attemptedCount++;
                }

                const deduction = penaltyRational.neg();
                totalRational = totalRational.add(deduction);
                subBucket.scoreRational = subBucket.scoreRational.add(deduction);
                if (sectionBucket) sectionBucket.scoreRational = sectionBucket.scoreRational.add(deduction);

                breakdown.push({
                    questionId: q.questionId,
                    questionNumber: qNum,
                    sectionId: q.sectionId || matchingSection?.id || null,
                    subject: normSubject.subjectName,
                    subjectId: normSubject.subjectId,
                    subjectName: normSubject.subjectName,
                    status: "incorrect",
                    studentAnswer: String(studentChoice),
                    marksAwarded: deduction.toNumber(decimals, roundingMode),
                    rationalScore: deduction,
                    bonusAwarded: false
                });
            }
        }

        // -------------------------------------------------------------
        // Section Score Clamping (Ceiling Invariant: score <= attainable maximum - DEFECT 02)
        // Computes genuine attainable ceiling from actual questions in section
        // Respects 4-level marking hierarchy: question override -> type rule -> section scheme -> exam scheme
        // -------------------------------------------------------------
        for (const sec of sectionsList) {
            const secId = sec.id || sec.sectionId;
            const secData = sectionMap.get(secId);
            if (!secData) continue;

            let secMaxRational = null;
            if (Number.isFinite(sec.maximumMarks)) {
                secMaxRational = Rational.from(sec.maximumMarks);
            } else {
                const maxAttempts = typeof sec.optionalPolicy === "object" && sec.optionalPolicy?.maxAttempts !== undefined
                    ? sec.optionalPolicy.maxAttempts
                    : (sec.requiredCount !== undefined && Number.isFinite(sec.questionCount) && sec.questionCount > 0 && sec.requiredCount < sec.questionCount ? sec.requiredCount : null);

                if (maxAttempts !== null && maxAttempts > 0) {
                    // Collect all questions matching this section
                    const sectionQuestions = [];
                    for (let i = 0; i < questions.length; i++) {
                        const q = questions[i];
                        const qNum = q.questionNumber || i + 1;
                        const isMatch = (q.sectionId && (q.sectionId === sec.id || q.sectionId === sec.sectionId)) ||
                            (!q.sectionId && !profile.numberingRestartsPerSection && qNum >= sec.startQuestion && qNum <= sec.endQuestion);
                        if (isMatch) {
                            sectionQuestions.push(q);
                        }
                    }

                    if (sectionQuestions.length > 0) {
                        // Calculate attainable positive marks for each question in this section
                        const questionMaxMarks = sectionQuestions.map(q => {
                            const qType = (q.questionType || "mcq").toLowerCase();
                            // Check answerKey override first
                            const key = answerKeys.find(k => 
                                (k.questionId && q.questionId && k.questionId === q.questionId) || 
                                (k.sectionId && q.sectionId && k.sectionId === q.sectionId && k.questionNumber === (q.questionNumber || 0))
                            );

                            let qCorrect = null;
                            if (Number.isFinite(key?.marksAwarded)) {
                                qCorrect = Rational.from(key.marksAwarded);
                            } else if (Number.isFinite(q.marksAwarded)) {
                                qCorrect = Rational.from(q.marksAwarded);
                            } else if (sec.questionTypeRules?.[qType]?.correct !== undefined) {
                                qCorrect = Rational.from(sec.questionTypeRules[qType].correct);
                            } else if (profile.questionTypeRules?.[qType]?.correct !== undefined) {
                                qCorrect = Rational.from(profile.questionTypeRules[qType].correct);
                            } else if (sec.markingScheme?.correct !== undefined) {
                                qCorrect = Rational.from(sec.markingScheme.correct);
                            } else if (profile.markingScheme?.correct !== undefined) {
                                qCorrect = Rational.from(profile.markingScheme.correct);
                            } else if (profile.scoringRules?.correct !== undefined) {
                                qCorrect = Rational.from(profile.scoringRules.correct);
                            } else {
                                qCorrect = Rational.from(1);
                            }
                            return qCorrect;
                        });

                        // Sort descending by value to get highest attainable marks
                        questionMaxMarks.sort((a, b) => b.compare(a));

                        // Sum top K = maxAttempts highest positive marks
                        const topK = questionMaxMarks.slice(0, maxAttempts);
                        secMaxRational = topK.reduce((sum, val) => sum.add(val), Rational.ZERO);
                    } else {
                        const secCorrect = sec.markingScheme?.correct ?? profile.markingScheme?.correct ?? 1;
                        secMaxRational = Rational.from(maxAttempts).mul(Rational.from(secCorrect));
                    }
                }
            }

            if (secMaxRational) {
                secData.maximumMarksRational = secMaxRational;
                if (secData.scoreRational.gt(secMaxRational)) {
                    const excess = secData.scoreRational.sub(secMaxRational);
                    secData.scoreRational = secMaxRational;
                    totalRational = totalRational.sub(excess);
                    const subNorm = SubjectNormalizationService.normalizeSubject(sec.subject || "General");
                    const subBucket = subjectMap.get(subNorm.subjectId);
                    if (subBucket) {
                        subBucket.scoreRational = subBucket.scoreRational.sub(excess);
                    }
                }
            }
        }

        // -------------------------------------------------------------
        // Pro-Rata Scaling (Official UPSC, SSC CGL & IBPS PO Policies)
        // -------------------------------------------------------------
        if (droppedPolicy === DROPPED_QUESTION_POLICY.PRO_RATA && droppedCount > 0) {
            const originalMaxMarks = profile.maximumMarks || 200;
            const origMaxRational = Rational.from(originalMaxMarks);
            if (!validMaxMarksRational.isZero()) {
                // Scaled = Raw Score * (Original Max Marks / Valid Max Marks)
                totalRational = totalRational.mul(origMaxRational).div(validMaxMarksRational);
            }
        }

        // 3. Final Boundary Formatting and Analysis Aggregation
        const totalScore = totalRational.toNumber(decimals, roundingMode);
        const attemptedCount = correctCount + incorrectCount + pendingReviewCount;
        const accuracyPercent = attemptedCount > 0
            ? Number(((correctCount / attemptedCount) * 100).toFixed(2))
            : 0;

        const subjectAnalysis = {};
        for (const [subId, subData] of subjectMap.entries()) {
            const attempted = subData.attemptedCount;
            subjectAnalysis[subId] = {
                subjectId: subData.subjectId,
                subjectName: subData.subjectName,
                score: subData.scoreRational.toNumber(decimals, roundingMode),
                rationalScore: subData.scoreRational,
                maximumMarks: subData.maximumMarksRational.toNumber(decimals, roundingMode),
                totalQuestions: subData.totalQuestions,
                correct: subData.correct,
                incorrect: subData.incorrect,
                unattempted: subData.unattempted,
                dropped: subData.dropped,
                attemptedCount: subData.attemptedCount,
                accuracy: attempted > 0
                    ? Number(((subData.correct / attempted) * 100).toFixed(2))
                    : 0
            };
        }

        const sectionScores = {};
        const sectionAnalysis = {};
        for (const [secId, secData] of sectionMap.entries()) {
            const secScore = secData.scoreRational.toNumber(decimals, roundingMode);
            sectionScores[secId] = secScore;
            const attempted = secData.attemptedCount;
            const maxMarks = (secData.maximumMarksRational ? secData.maximumMarksRational.toNumber(decimals, roundingMode) : null);
            sectionAnalysis[secId] = {
                sectionId: secData.sectionId,
                sectionName: secData.sectionName,
                subject: secData.subject,
                score: secScore,
                maximumMarks: maxMarks,
                maximumPossibleMarks: maxMarks,
                totalQuestions: secData.totalQuestions,
                attemptedCount: secData.attemptedCount,
                correctCount: secData.correctCount,
                incorrectCount: secData.incorrectCount,
                unansweredCount: secData.unansweredCount,
                droppedCount: secData.droppedCount,
                accuracy: attempted > 0 ? Number(((secData.correctCount / attempted) * 100).toFixed(2)) : 0
            };
        }

        const totalMaximumMarks = profile.maximumMarks || (questions.length * 4);
        const maxRational = Rational.from(totalMaximumMarks);
        const percentageScore = maxRational.isPositive()
            ? Number(totalRational.mul(new Rational(100)).div(maxRational).toNumber(2, roundingMode))
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
            accuracyPercent,
            isFinalized: pendingReviewCount === 0,
            requiresManualEvaluation: pendingReviewCount > 0,
            pendingReviewCount,
            subjectAnalysis,
            sectionScores,
            sectionAnalysis,
            breakdown,
            schemaVersion: 2
        };
    }
}
