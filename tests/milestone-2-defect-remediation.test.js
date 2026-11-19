process.env.NODE_ENV = "test";

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";
import { Rational } from "../server/services/scoring/rational.js";
import {
    ExamProfileRegistry,
    DROPPED_QUESTION_POLICY,
    OPTIONAL_QUESTION_POLICY,
    VERIFICATION_STATUS
} from "../server/services/admin/examProfileRegistry.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { MockTestService } from "../server/services/mockTestService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { LegacyScoringAdapter } from "../server/services/scoring/legacyScoringAdapter.js";

describe("Milestone 2 Defect Remediation Regression Suite", () => {

    beforeEach(() => {
        UniversalFirestoreService.clearLocalCache();
    });

    // =========================================================================
    // DEFECT 01 — Descriptive Question Scoring
    // =========================================================================
    describe("DEFECT 01: Descriptive Question Scoring", () => {
        const descriptiveProfile = {
            profileId: "test-descriptive-exam",
            examId: "descriptive-exam",
            verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
            isOfficial: true,
            maximumMarks: 100,
            droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
            optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
            markingScheme: { correct: 10, incorrect: -2, unanswered: 0 },
            sections: [
                {
                    id: "sec_descriptive",
                    name: "Descriptive Writing",
                    subject: "Essay",
                    startQuestion: 1,
                    endQuestion: 3,
                    questionCount: 3,
                    requiredCount: 3,
                    questionType: "descriptive",
                    allowedQuestionTypes: ["descriptive"],
                    markingScheme: { correct: 10, incorrect: -2, unanswered: 0 }
                }
            ]
        };

        it("should never apply automated positive marks or negative deductions to descriptive questions", () => {
            const questions = [
                { questionId: "q1", questionNumber: 1, sectionId: "sec_descriptive", questionType: "descriptive", marksAwarded: 10 }
            ];
            const answerKeys = [
                { questionId: "q1", questionNumber: 1, sectionId: "sec_descriptive", marksAwarded: 10, marksDeducted: 2 }
            ];
            const studentAnswers = {
                q1: "The geopolitical significance of the Indo-Pacific region lies in its maritime trade routes..."
            };

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examProfile: descriptiveProfile
            });

            assert.equal(result.totalScore, 0, "Automated totalScore must be 0 for descriptive answer pending review");
            assert.equal(result.pendingReviewCount, 1, "pendingReviewCount must be 1");
            assert.equal(result.isFinalized, false, "isFinalized must be false when descriptive answers are pending review");
            assert.equal(result.requiresManualEvaluation, true, "requiresManualEvaluation must be true");

            const qBreakdown = result.breakdown[0];
            assert.equal(qBreakdown.status, "pending_manual_review", "Status must be pending_manual_review");
            assert.equal(qBreakdown.marksAwarded, 0, "marksAwarded must be 0");
            assert.equal(qBreakdown.requiresManualEvaluation, true, "requiresManualEvaluation flag must be true on question");
        });

        it("should treat empty/null descriptive answers as unanswered without requiring manual review", () => {
            const questions = [
                { questionId: "q1", questionNumber: 1, sectionId: "sec_descriptive", questionType: "descriptive", marksAwarded: 10 }
            ];
            const answerKeys = [
                { questionId: "q1", questionNumber: 1, sectionId: "sec_descriptive", marksAwarded: 10 }
            ];
            const studentAnswers = {
                q1: "" // Unanswered
            };

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examProfile: descriptiveProfile
            });

            assert.equal(result.totalScore, 0);
            assert.equal(result.unansweredCount, 1, "Unanswered descriptive question must increment unansweredCount");
            assert.equal(result.pendingReviewCount, 0, "Unanswered question must not increment pendingReviewCount");
            assert.equal(result.isFinalized, true, "isFinalized must be true if all descriptive questions are unanswered");
            assert.equal(result.requiresManualEvaluation, false);
            assert.equal(result.breakdown[0].status, "unanswered");
        });

        it("should correctly handle mixed objective and descriptive questions", () => {
            const mixedProfile = {
                profileId: "test-mixed-exam",
                examId: "mixed-exam",
                verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
                isOfficial: true,
                maximumMarks: 20,
                droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
                optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
                markingScheme: { correct: 4, incorrect: -1, unanswered: 0 },
                sections: [
                    {
                        id: "sec_obj",
                        name: "Objective Section",
                        subject: "General Studies",
                        startQuestion: 1,
                        endQuestion: 2,
                        questionCount: 2,
                        requiredCount: 2,
                        markingScheme: { correct: 4, incorrect: -1 }
                    },
                    {
                        id: "sec_desc",
                        name: "Descriptive Section",
                        subject: "General Studies",
                        startQuestion: 3,
                        endQuestion: 3,
                        questionCount: 1,
                        requiredCount: 1,
                        questionType: "descriptive",
                        markingScheme: { correct: 12, incorrect: 0 }
                    }
                ]
            };

            const questions = [
                { questionId: "q1", questionNumber: 1, sectionId: "sec_obj", questionType: "mcq" },
                { questionId: "q2", questionNumber: 2, sectionId: "sec_obj", questionType: "mcq" },
                { questionId: "q3", questionNumber: 3, sectionId: "sec_desc", questionType: "descriptive", marksAwarded: 12 }
            ];

            const answerKeys = [
                { questionId: "q1", questionNumber: 1, sectionId: "sec_obj", correctOptionIds: ["A"], marksAwarded: 4, marksDeducted: 1 },
                { questionId: "q2", questionNumber: 2, sectionId: "sec_obj", correctOptionIds: ["B"], marksAwarded: 4, marksDeducted: 1 },
                { questionId: "q3", questionNumber: 3, sectionId: "sec_desc", marksAwarded: 12 }
            ];

            const studentAnswers = {
                q1: "A", // Correct (+4)
                q2: "C", // Incorrect (-1)
                q3: "A detailed essay answer explaining the constitutional provisions..." // Pending (0)
            };

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examProfile: mixedProfile
            });

            // 4 - 1 + 0 = 3
            assert.equal(result.totalScore, 3, "Total score must be 4 - 1 = 3");
            assert.equal(result.correctCount, 1);
            assert.equal(result.incorrectCount, 1);
            assert.equal(result.pendingReviewCount, 1);
            assert.equal(result.attemptedCount, 3);
            assert.equal(result.isFinalized, false);
            assert.equal(result.requiresManualEvaluation, true);
        });

        it("should preserve pre-existing manual marks awarded during re-evaluation", () => {
            const questions = [
                {
                    questionId: "q1",
                    questionNumber: 1,
                    sectionId: "sec_descriptive",
                    questionType: "descriptive",
                    marksAwarded: 10,
                    manualMarksAwarded: 8.5 // Evaluator awarded 8.5/10 marks
                }
            ];
            const answerKeys = [
                { questionId: "q1", questionNumber: 1, sectionId: "sec_descriptive", marksAwarded: 10 }
            ];
            const studentAnswers = {
                q1: "A comprehensive essay answer..."
            };

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examProfile: descriptiveProfile
            });

            assert.equal(result.totalScore, 8.5, "Preserved manual marks must be awarded");
            assert.equal(result.pendingReviewCount, 0, "pendingReviewCount must be 0 when already manually graded");
            assert.equal(result.isFinalized, true);
            assert.equal(result.requiresManualEvaluation, false);
            assert.equal(result.breakdown[0].status, "manually_graded");
            assert.equal(result.breakdown[0].marksAwarded, 8.5);
        });
    });

    // =========================================================================
    // DEFECT 02 — Dropped Questions in Optional Sections
    // =========================================================================
    describe("DEFECT 02: Dropped Questions in Optional Sections", () => {
        const optionalProfile = {
            profileId: "test-optional-exam",
            examId: "optional-exam",
            verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
            isOfficial: true,
            maximumMarks: 20, // 5 questions * 4 marks
            droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
            optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.FIRST_K_ATTEMPTED,
            markingScheme: { correct: 4, incorrect: -1, unanswered: 0 },
            sections: [
                {
                    id: "sec_b",
                    name: "Section B (Attempt any 5 of 10)",
                    subject: "Mathematics",
                    startQuestion: 1,
                    endQuestion: 10,
                    questionCount: 10,
                    requiredCount: 5,
                    markingScheme: { correct: 4, incorrect: -1, unanswered: 0 },
                    optionalPolicy: { type: "first_k_attempted", maxAttempts: 5 }
                }
            ]
        };

        const create10Questions = () => Array.from({ length: 10 }, (_, i) => ({
            questionId: `q${i + 1}`,
            questionNumber: i + 1,
            sectionId: "sec_b",
            questionType: "numerical"
        }));

        it("should clamp section score to maximum allowed marks when dropped question pushes score above ceiling", () => {
            const questions = create10Questions();
            // Q1 is dropped (FULL_MARKS awards +4)
            const answerKeys = Array.from({ length: 10 }, (_, i) => ({
                questionId: `q${i + 1}`,
                questionNumber: i + 1,
                sectionId: "sec_b",
                correctAnswers: ["10"],
                marksAwarded: 4,
                marksDeducted: 0,
                isDropped: i === 0 // Q1 dropped
            }));

            // Candidate attempts Q2, Q3, Q4, Q5, Q6 (5 non-dropped questions) and gets all 5 correct = 20 marks
            // Without clamping, Q1 dropped (+4) would inflate score to 24 marks!
            const studentAnswers = {
                q2: "10",
                q3: "10",
                q4: "10",
                q5: "10",
                q6: "10"
            };

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examProfile: optionalProfile
            });

            assert.equal(result.sectionScores.sec_b, 20, "Section B score must be clamped to ceiling of 20 marks (5 * 4)");
            assert.equal(result.totalScore, 20, "Total score must not exceed 20 marks");
        });

        it("should count candidate's attempt on a dropped question toward optional attempt limit", () => {
            const questions = create10Questions();
            // Q1 is dropped
            const answerKeys = Array.from({ length: 10 }, (_, i) => ({
                questionId: `q${i + 1}`,
                questionNumber: i + 1,
                sectionId: "sec_b",
                correctAnswers: ["10"],
                marksAwarded: 4,
                marksDeducted: 1,
                isDropped: i === 0 // Q1 dropped
            }));

            // Candidate attempts Q1 (dropped), Q2, Q3, Q4, Q5 (total 5 attempts), and Q6 (6th attempt)
            const studentAnswers = {
                q1: "99", // Attempted dropped Q1 -> should count as Attempt 1
                q2: "10", // Correct -> Attempt 2
                q3: "10", // Correct -> Attempt 3
                q4: "10", // Correct -> Attempt 4
                q5: "10", // Correct -> Attempt 5
                q6: "10"  // 6th Attempt -> MUST BE CAPPED (optional_exceeded)
            };

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examProfile: optionalProfile
            });

            const q6Breakdown = result.breakdown.find(b => b.questionId === "q6");
            assert.equal(q6Breakdown.status, "optional_exceeded", "Q6 must be capped because candidate already made 5 attempts (including Q1)");
            assert.equal(q6Breakdown.marksAwarded, 0, "Capped Q6 must award 0 marks");
            assert.equal(result.sectionScores.sec_b, 20, "Section score must be exactly 20 marks (Q1 bonus + 4 correct)");
        });

        it("should clamp section score to 20 marks even if ALL 10 questions in optional section are dropped", () => {
            const questions = create10Questions();
            // All 10 questions dropped
            const answerKeys = Array.from({ length: 10 }, (_, i) => ({
                questionId: `q${i + 1}`,
                questionNumber: i + 1,
                sectionId: "sec_b",
                correctAnswers: ["10"],
                marksAwarded: 4,
                marksDeducted: 0,
                isDropped: true
            }));

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: {},
                examProfile: optionalProfile
            });

            assert.equal(result.sectionScores.sec_b, 20, "Section score must clamp to 20 marks even if all questions are dropped");
            assert.equal(result.totalScore, 20, "Total score must clamp to 20 marks");
        });

        it("should correctly calculate score when candidate attempts fewer questions than section limit", () => {
            const questions = create10Questions();
            const answerKeys = Array.from({ length: 10 }, (_, i) => ({
                questionId: `q${i + 1}`,
                questionNumber: i + 1,
                sectionId: "sec_b",
                correctAnswers: ["10"],
                marksAwarded: 4,
                marksDeducted: 1,
                isDropped: i === 0 // Q1 dropped
            }));

            // Candidate attempts 2 non-dropped questions correctly: 2 * 4 = 8 marks + Q1 dropped (+4) = 12 marks <= 20
            const studentAnswers = {
                q2: "10",
                q3: "10"
            };

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examProfile: optionalProfile
            });

            assert.equal(result.sectionScores.sec_b, 12, "Section score must be 12 (no clamping when below ceiling)");
            assert.equal(result.totalScore, 12);
        });
    });

    // =========================================================================
    // DEFECT 03 — CUET UG 2024 Policy Conflict
    // =========================================================================
    describe("DEFECT 03: CUET UG 2024 Dropped-Question Policy", () => {
        it("should verify cuet-ug-2024 profile has ATTEMPTED_ONLY policy registered", () => {
            const profile = ExamProfileRegistry.getProfile("cuet-ug-2024");
            assert.ok(profile, "cuet-ug-2024 profile must exist");
            assert.equal(
                profile.droppedQuestionPolicy,
                DROPPED_QUESTION_POLICY.ATTEMPTED_ONLY,
                "CUET UG 2024 droppedQuestionPolicy must be ATTEMPTED_ONLY per NTA Bulletin Section 2.3"
            );
            assert.ok(
                profile.sourceProvenance?.citation?.includes("Section 2.3"),
                "Source provenance must cite Section 2.3 of official NTA CUET UG 2024 Bulletin"
            );
        });

        it("should award +5 marks to candidate who attempted the dropped question in CUET UG 2024", () => {
            const profile = ExamProfileRegistry.getProfile("cuet-ug-2024");
            const questions = [
                { questionId: "cuet_q1", questionNumber: 1, sectionId: "domain_section", questionType: "mcq" }
            ];
            const answerKeys = [
                { questionId: "cuet_q1", questionNumber: 1, sectionId: "domain_section", isDropped: true, marksAwarded: 5, marksDeducted: 1 }
            ];

            // Candidate A attempted the dropped question
            const resultAttempted = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: { cuet_q1: "B" },
                examProfile: profile
            });

            assert.equal(resultAttempted.totalScore, 5, "Candidate who attempted dropped question must receive +5 marks");
            assert.equal(resultAttempted.breakdown[0].bonusAwarded, true);

            // Candidate B did NOT attempt the dropped question
            const resultUnattempted = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: {},
                examProfile: profile
            });

            assert.equal(resultUnattempted.totalScore, 0, "Candidate who did NOT attempt dropped question must receive 0 marks");
            assert.equal(resultUnattempted.breakdown[0].bonusAwarded, false);
        });
    });

    // =========================================================================
    // DEFECT 04 — JEE Advanced MSQ Discrete Marking
    // =========================================================================
    describe("DEFECT 04: JEE Advanced MSQ Discrete Partial Marking", () => {
        const jeeAdvProfile = ExamProfileRegistry.getProfile("jee-advanced-2024");

        it("should verify jee-advanced-2024 profile configures discrete MSQ partial marking rules in all 3 subjects", () => {
            assert.ok(jeeAdvProfile, "jee-advanced-2024 profile must exist");
            const msqSections = ["physics_sec2", "chemistry_sec2", "math_sec2"];
            for (const secId of msqSections) {
                const sec = jeeAdvProfile.sections.find(s => s.id === secId);
                assert.ok(sec, `Section ${secId} must exist`);
                assert.equal(sec.partialMarkingEnabled, true, `${secId} must have partialMarkingEnabled: true`);
                assert.deepEqual(sec.partialMarkingRules, {
                    allCorrect: 4,
                    threeOfFour: 3,
                    twoOfThreeOrFour: 2,
                    oneOfTwoOrMore: 1,
                    anyIncorrect: -2
                }, `${secId} must configure exact discrete JEE Advanced rubric`);
            }
        });

        it("should score all 4 correct options as +4 full marks", () => {
            const questions = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", questionType: "msq" }];
            const answerKeys = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", correctOptionIds: ["A", "B", "C", "D"], marksAwarded: 4, marksDeducted: 2 }];

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: { q1: ["A", "B", "C", "D"] },
                examProfile: jeeAdvProfile
            });

            assert.equal(result.totalScore, 4);
            assert.equal(result.breakdown[0].status, "correct");
            assert.equal(result.breakdown[0].marksAwarded, 4);
        });

        it("should award +3 marks when 3 of 4 correct options are chosen (no wrong option)", () => {
            const questions = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", questionType: "msq" }];
            const answerKeys = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", correctOptionIds: ["A", "B", "C", "D"], marksAwarded: 4, marksDeducted: 2 }];

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: { q1: ["A", "B", "C"] },
                examProfile: jeeAdvProfile
            });

            assert.equal(result.totalScore, 3, "3 of 4 correct must receive +3 marks (not continuous 3.0 or 2.667)");
            assert.equal(result.breakdown[0].status, "correct");
            assert.equal(result.breakdown[0].marksAwarded, 3);
        });

        it("should award +2 marks when 2 of 3 (or 4) correct options are chosen (no wrong option)", () => {
            const questions = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", questionType: "msq" }];
            const answerKeys = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", correctOptionIds: ["A", "B", "C"], marksAwarded: 4, marksDeducted: 2 }];

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: { q1: ["A", "B"] },
                examProfile: jeeAdvProfile
            });

            assert.equal(result.totalScore, 2, "2 of 3 correct must receive +2 marks");
            assert.equal(result.breakdown[0].status, "correct");
            assert.equal(result.breakdown[0].marksAwarded, 2);
        });

        it("should award +1 mark when 1 of 2 (or more) correct options is chosen (no wrong option)", () => {
            const questions = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", questionType: "msq" }];
            const answerKeys = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", correctOptionIds: ["A", "B"], marksAwarded: 4, marksDeducted: 2 }];

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: { q1: ["A"] },
                examProfile: jeeAdvProfile
            });

            assert.equal(result.totalScore, 1, "1 of 2 correct must receive +1 mark");
            assert.equal(result.breakdown[0].status, "correct");
            assert.equal(result.breakdown[0].marksAwarded, 1);
        });

        it("should apply -2 deduction when any incorrect option is chosen", () => {
            const questions = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", questionType: "msq" }];
            const answerKeys = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", correctOptionIds: ["A", "B", "C"], marksAwarded: 4, marksDeducted: 2 }];

            // Student selects 2 correct options (A, B) PLUS 1 wrong option (D)
            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: { q1: ["A", "B", "D"] },
                examProfile: jeeAdvProfile
            });

            assert.equal(result.totalScore, -2, "Selecting any wrong option must deduct 2 marks (-2)");
            assert.equal(result.breakdown[0].status, "incorrect");
            assert.equal(result.breakdown[0].marksAwarded, -2);
        });

        it("should award 0 marks when question is unanswered", () => {
            const questions = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", questionType: "msq" }];
            const answerKeys = [{ questionId: "q1", questionNumber: 5, sectionId: "physics_sec2", correctOptionIds: ["A", "B", "C"], marksAwarded: 4, marksDeducted: 2 }];

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: {},
                examProfile: jeeAdvProfile
            });

            assert.equal(result.totalScore, 0);
            assert.equal(result.breakdown[0].status, "unanswered");
            assert.equal(result.breakdown[0].marksAwarded, 0);
        });
    });

    // =========================================================================
    // DEFECT 05 — Duplicate Question IDs
    // =========================================================================
    describe("DEFECT 05: Duplicate Question ID Rejection", () => {
        it("should reject attempt with duplicate question IDs with DUPLICATE_QUESTION_ID_REJECTED", () => {
            const questions = [
                { questionId: "dup_q1", questionNumber: 1, sectionId: "sec1" },
                { questionId: "dup_q2", questionNumber: 2, sectionId: "sec1" },
                { questionId: "dup_q1", questionNumber: 3, sectionId: "sec1" } // Duplicate ID
            ];

            assert.throws(() => {
                UniversalScoringEngine.evaluateAttempt({
                    questions,
                    answerKeys: [],
                    studentAnswers: {},
                    examProfile: "upsc-prelims-2024"
                });
            }, (err) => {
                assert.equal(err.code, "DUPLICATE_QUESTION_ID_REJECTED", "Error code must be DUPLICATE_QUESTION_ID_REJECTED");
                assert.ok(err.message.includes("dup_q1"), "Error message must specify duplicate question ID");
                return true;
            });
        });

        it("should reject duplicate question IDs across different sections", () => {
            const questions = [
                { questionId: "cross_sec_dup", questionNumber: 1, sectionId: "sec_a" },
                { questionId: "cross_sec_dup", questionNumber: 1, sectionId: "sec_b" } // Duplicate ID across sections
            ];

            assert.throws(() => {
                UniversalScoringEngine.evaluateAttempt({
                    questions,
                    answerKeys: [],
                    studentAnswers: {},
                    examProfile: "upsc-prelims-2024"
                });
            }, (err) => {
                assert.equal(err.code, "DUPLICATE_QUESTION_ID_REJECTED");
                return true;
            });
        });

        it("should accept valid questions with distinct unique IDs", () => {
            const questions = [
                { questionId: "unique_1", questionNumber: 1, sectionId: "general_studies", questionType: "mcq" },
                { questionId: "unique_2", questionNumber: 2, sectionId: "general_studies", questionType: "mcq" }
            ];
            const answerKeys = [
                { questionId: "unique_1", questionNumber: 1, sectionId: "general_studies", correctOptionIds: ["A"] },
                { questionId: "unique_2", questionNumber: 2, sectionId: "general_studies", correctOptionIds: ["B"] }
            ];

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: { unique_1: "A", unique_2: "B" },
                examProfile: "upsc-prelims-2024"
            });

            assert.equal(result.totalQuestions, 2);
            assert.equal(result.correctCount, 2);
        });
    });

    // =========================================================================
    // DEFECT 06 — Firestore Submission Concurrency
    // =========================================================================
    describe("DEFECT 06: Firestore Submission Concurrency & Idempotency", () => {
        const testId = "test_exam_mock_1";
        const userId = "student_user_123";
        const attemptId = "attempt_race_test_1";

        beforeEach(async () => {
            UniversalFirestoreService.clearLocalCache();

            // Set up test metadata
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                title: "Mock Test 1",
                examId: "jee-main",
                questionIds: ["q_test_1", "q_test_2"]
            });

            await UniversalFirestoreService.setDocument("mockQuestions", "q_test_1", {
                questionId: "q_test_1",
                testId,
                questionNumber: 1,
                questionType: "mcq"
            });
            await UniversalFirestoreService.setDocument("mockQuestions", "q_test_2", {
                questionId: "q_test_2",
                testId,
                questionNumber: 2,
                questionType: "mcq"
            });

            await UniversalFirestoreService.setDocument("mockAnswerKeys", "ak_1", {
                questionId: "q_test_1",
                testId,
                correctOptionIds: ["A"],
                marksAwarded: 4,
                marksDeducted: 1
            });
            await UniversalFirestoreService.setDocument("mockAnswerKeys", "ak_2", {
                questionId: "q_test_2",
                testId,
                correctOptionIds: ["B"],
                marksAwarded: 4,
                marksDeducted: 1
            });

            // Set up active in-progress attempt
            await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
                attemptId,
                testId,
                userId,
                status: "in_progress",
                startedAt: new Date(Date.now() - 60000).toISOString(),
                deadlineAt: new Date(Date.now() + 3600000).toISOString(),
                answers: {
                    q_test_1: "A",
                    q_test_2: "B"
                }
            });
        });

        it("should handle race condition idempotently when concurrent submissions collide on mockResults write", async () => {
            // Simulate two simultaneous calls to submitAttempt
            const [res1, res2] = await Promise.all([
                MockTestService.submitAttempt({ attemptId, userId }),
                MockTestService.submitAttempt({ attemptId, userId })
            ]);

            assert.ok(res1, "First submission must succeed");
            assert.ok(res2, "Second concurrent submission must succeed idempotently without error");
            assert.equal(res1.resultId, `result_${attemptId}`);
            assert.equal(res2.resultId, `result_${attemptId}`);
            assert.equal(res1.totalScore, 8);
            assert.equal(res2.totalScore, 8);
        });

        it("should return existing result with alreadySubmitted flag on subsequent submission call", async () => {
            const firstSubmission = await MockTestService.submitAttempt({ attemptId, userId });
            assert.equal(firstSubmission.totalScore, 8);

            const secondSubmission = await MockTestService.submitAttempt({ attemptId, userId });
            assert.equal(secondSubmission.alreadySubmitted, true, "alreadySubmitted flag must be true on repeated submission");
            assert.equal(secondSubmission.resultId, `result_${attemptId}`);
            assert.equal(secondSubmission.totalScore, 8);
        });

        it("should recover and persist result if attempt was marked submitted but mockResults write failed", async () => {
            // Simulate transient failure: attempt marked submitted, but mockResults does NOT exist
            await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
                attemptId,
                testId,
                userId,
                status: "submitted", // Interrupted state
                startedAt: new Date(Date.now() - 60000).toISOString(),
                deadlineAt: new Date(Date.now() + 3600000).toISOString(),
                answers: {
                    q_test_1: "A",
                    q_test_2: "B"
                }
            });

            // Calling submitAttempt in interrupted state must recover and generate the missing result record
            const recoveredResult = await MockTestService.submitAttempt({ attemptId, userId });
            assert.ok(recoveredResult);
            assert.equal(recoveredResult.resultId, `result_${attemptId}`);
            assert.equal(recoveredResult.totalScore, 8);

            // Verify result is now persisted
            const persistedDoc = await UniversalFirestoreService.getDocument("mockResults", `result_${attemptId}`);
            assert.ok(persistedDoc, "Recovered result must be persisted in mockResults");
            assert.equal(persistedDoc.totalScore, 8);
        });
    });

    // =========================================================================
    // DEFECT 01 (Post-Audit Remediation): Production Descriptive Integration
    // =========================================================================
    describe("DEFECT 01 (Post-Audit Remediation): Production Descriptive Integration", () => {
        it("should route schemaVersion 2 to UniversalScoringEngine and legacy to LegacyScoringAdapter", () => {
            const v2Config = {
                examId: "jee-main",
                year: 2024,
                schemaVersion: 2
            };
            const legacyConfig = {
                examId: "jee-main",
                year: 2024
            };

            const questions = [
                { questionId: "q_route_1", questionNumber: 1, sectionId: "math_a", marksAwarded: 4 }
            ];
            const answerKeys = [
                { questionId: "q_route_1", questionNumber: 1, sectionId: "math_a", marksAwarded: 4, correctOptionIds: ["A"] }
            ];
            const studentAnswers = { q_route_1: "A" };

            const v2Result = MockTestScoringService.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examConfig: v2Config
            });
            assert.equal(v2Result.totalScore, 4);
            assert.ok(v2Result.isFinalized !== undefined, "UniversalScoringEngine result must have isFinalized");

            const legacyResult = MockTestScoringService.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examConfig: legacyConfig
            });
            assert.equal(legacyResult.totalScore, 4);
        });

        it("LegacyScoringAdapter should never deduct MCQ penalty for descriptive questions", () => {
            const questions = [
                { questionId: "q_desc_leg", questionNumber: 1, questionType: "descriptive", marksAwarded: 10 }
            ];
            const answerKeys = [
                { questionId: "q_desc_leg", questionNumber: 1, marksAwarded: 10, marksDeducted: 2 }
            ];
            const studentAnswers = {
                q_desc_leg: "Descriptive response submitted by student..."
            };

            const result = LegacyScoringAdapter.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers,
                examConfig: { examId: "upsc-prelims", adminApprovedForScoring: true }
            });

            assert.equal(result.totalScore, 0, "No automated score should be awarded to unreviewed descriptive answer");
            assert.equal(result.incorrectCount, 0, "Descriptive question must never increment incorrectCount");
            assert.equal(result.pendingReviewCount, 1, "pendingReviewCount must be 1");
            assert.equal(result.isFinalized, false, "isFinalized must be false");
            assert.equal(result.requiresManualEvaluation, true, "requiresManualEvaluation must be true");
            assert.equal(result.breakdown[0].status, "pending_manual_review");
            assert.equal(result.breakdown[0].marksAwarded, 0);
        });

        it("MockTestService.submitAttempt should persist review metadata and update attempt atomically", async () => {
            const testId = "test_desc_prod_1";
            const attemptId = "att_desc_prod_1";
            const userId = "student_desc_1";

            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                examId: "descriptive-prod-exam",
                schemaVersion: 2,
                status: "published",
                maximumMarks: 100,
                adminApprovedForScoring: true
            });

            await UniversalFirestoreService.setDocument("mockQuestions", "q_desc_1", {
                questionId: "q_desc_1",
                testId,
                questionNumber: 1,
                questionType: "descriptive",
                marksAwarded: 20
            });

            await UniversalFirestoreService.setDocument("mockAnswerKeys", "ak_desc_1", {
                questionId: "q_desc_1",
                testId,
                questionNumber: 1,
                marksAwarded: 20,
                marksDeducted: 0
            });

            await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
                attemptId,
                testId,
                userId,
                status: "in_progress",
                startedAt: new Date(Date.now() - 60000).toISOString(),
                deadlineAt: new Date(Date.now() + 3600000).toISOString(),
                answers: {
                    q_desc_1: "Analytical essay on constitutional separation of powers."
                }
            });

            const result = await MockTestService.submitAttempt({ attemptId, userId });

            assert.equal(result.totalScore, 0, "Objective score must be 0 pending review");
            assert.equal(result.pendingReviewCount, 1, "resultRecord must include pendingReviewCount");
            assert.equal(result.requiresManualEvaluation, true, "resultRecord must require manual evaluation");
            assert.equal(result.isFinalized, false, "resultRecord must not be finalized");

            // Verify attempt document in Firestore was updated with review metadata
            const attemptDoc = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
            assert.equal(attemptDoc.status, "submitted");
            assert.equal(attemptDoc.isFinalized, false, "attempt document must have isFinalized: false");
            assert.equal(attemptDoc.requiresManualEvaluation, true, "attempt document must have requiresManualEvaluation: true");
            assert.equal(attemptDoc.pendingReviewCount, 1);
        });
    });

    // =========================================================================
    // DEFECT 02 (Post-Audit Remediation): Variable-Marks Optional Section Ceiling
    // =========================================================================
    describe("DEFECT 02 (Post-Audit Remediation): Variable-Marks Optional Section Ceiling", () => {
        it("should calculate attainable ceiling summing top K question values for variable-mark questions", () => {
            const profile = {
                profileId: "var-marks-exam",
                examId: "var-marks-exam",
                verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
                isOfficial: true,
                maximumMarks: 100,
                droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
                optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
                markingScheme: { correct: 1, incorrect: 0 },
                sections: [
                    {
                        id: "sec_var",
                        name: "Variable Marks Section",
                        subject: "Advanced",
                        startQuestion: 1,
                        endQuestion: 10,
                        questionCount: 10,
                        requiredCount: 2,
                        optionalPolicy: { type: "first_k_attempted", maxAttempts: 2 },
                        markingScheme: { correct: 5, incorrect: 0 } // default if not overridden
                    }
                ]
            };

            // 5 questions with 10 marks each, 5 questions with 5 marks each
            const questions = [];
            const answerKeys = [];
            for (let i = 1; i <= 10; i++) {
                const marks = i <= 5 ? 10 : 5;
                questions.push({
                    questionId: `q_var_${i}`,
                    questionNumber: i,
                    sectionId: "sec_var",
                    questionType: "numerical",
                    marksAwarded: marks
                });
                answerKeys.push({
                    questionId: `q_var_${i}`,
                    questionNumber: i,
                    sectionId: "sec_var",
                    acceptedAnswers: ["42"],
                    marksAwarded: marks
                });
            }

            // Candidate attempts first two questions (both 10-mark questions, both correct)
            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: {
                    q_var_1: "42",
                    q_var_2: "42"
                },
                examProfile: profile
            });

            // Attainable maximum is top 2: 10 + 10 = 20.
            // Previously was clamped to 2 * 5 = 10!
            assert.equal(result.totalScore, 20, "Score of 20 must NOT be clamped to 10 for variable-mark questions");
        });

        it("should respect questionTypeRules positive marks when determining attainable ceiling", () => {
            const profile = {
                profileId: "type-rules-exam",
                examId: "type-rules-exam",
                verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
                isOfficial: true,
                maximumMarks: 100,
                droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
                optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
                markingScheme: { correct: 1, incorrect: 0 }, // Exam default is 1
                sections: [
                    {
                        id: "sec_type_rule",
                        name: "Type Rules Section",
                        subject: "Physics",
                        startQuestion: 1,
                        endQuestion: 5,
                        questionCount: 5,
                        requiredCount: 2,
                        optionalPolicy: { type: "first_k_attempted", maxAttempts: 2 },
                        markingScheme: { correct: 1, incorrect: 0 }, // Section default is 1
                        questionTypeRules: {
                            numerical: { correct: 4, incorrect: 0 } // Numerical is +4
                        }
                    }
                ]
            };

            const questions = [];
            const answerKeys = [];
            for (let i = 1; i <= 5; i++) {
                questions.push({
                    questionId: `q_tr_${i}`,
                    questionNumber: i,
                    sectionId: "sec_type_rule",
                    questionType: "numerical"
                });
                answerKeys.push({
                    questionId: `q_tr_${i}`,
                    questionNumber: i,
                    sectionId: "sec_type_rule",
                    acceptedAnswers: ["100"]
                });
            }

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: {
                    q_tr_1: "100",
                    q_tr_2: "100"
                },
                examProfile: profile
            });

            // Attainable ceiling for 2 numerical questions = 2 * 4 = 8.
            // Previously clamped to 2 * 1 = 2!
            assert.equal(result.totalScore, 8, "Score of 8 must NOT be clamped to 2 when questionTypeRules defines +4");
        });
    });

    // =========================================================================
    // DEFECT 03 (Post-Audit Remediation): Missing and Invalid Question IDs
    // =========================================================================
    describe("DEFECT 03 (Post-Audit Remediation): Missing and Invalid Question IDs", () => {
        const dummyProfile = {
            profileId: "dummy-id-exam",
            examId: "dummy-id-exam",
            verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
            isOfficial: true,
            maximumMarks: 10,
            droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
            optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
            markingScheme: { correct: 1, incorrect: 0 },
            sections: []
        };

        it("should reject question with undefined questionId with INVALID_QUESTION_ID_REJECTED", () => {
            assert.throws(() => {
                UniversalScoringEngine.evaluateAttempt({
                    questions: [{ questionNumber: 1, marksAwarded: 1 }],
                    answerKeys: [{ questionNumber: 1, correctOptionIds: ["A"] }],
                    studentAnswers: {},
                    examProfile: dummyProfile
                });
            }, (err) => {
                return err.code === "INVALID_QUESTION_ID_REJECTED" && err.message.includes("missing a valid questionId");
            });
        });

        it("should reject question with null questionId with INVALID_QUESTION_ID_REJECTED", () => {
            assert.throws(() => {
                UniversalScoringEngine.evaluateAttempt({
                    questions: [{ questionId: null, questionNumber: 1, marksAwarded: 1 }],
                    answerKeys: [{ questionNumber: 1, correctOptionIds: ["A"] }],
                    studentAnswers: {},
                    examProfile: dummyProfile
                });
            }, (err) => {
                return err.code === "INVALID_QUESTION_ID_REJECTED";
            });
        });

        it("should reject question with empty string questionId with INVALID_QUESTION_ID_REJECTED", () => {
            assert.throws(() => {
                UniversalScoringEngine.evaluateAttempt({
                    questions: [{ questionId: "", questionNumber: 1, marksAwarded: 1 }],
                    answerKeys: [{ questionNumber: 1, correctOptionIds: ["A"] }],
                    studentAnswers: {},
                    examProfile: dummyProfile
                });
            }, (err) => {
                return err.code === "INVALID_QUESTION_ID_REJECTED";
            });
        });

        it("should reject question with whitespace-only questionId with INVALID_QUESTION_ID_REJECTED", () => {
            assert.throws(() => {
                UniversalScoringEngine.evaluateAttempt({
                    questions: [{ questionId: "   ", questionNumber: 1, marksAwarded: 1 }],
                    answerKeys: [{ questionNumber: 1, correctOptionIds: ["A"] }],
                    studentAnswers: {},
                    examProfile: dummyProfile
                });
            }, (err) => {
                return err.code === "INVALID_QUESTION_ID_REJECTED";
            });
        });
    });

    // =========================================================================
    // DEFECT 04 (Post-Audit Remediation): Explicit Section ID Priority
    // =========================================================================
    describe("DEFECT 04 (Post-Audit Remediation): Explicit Section ID Priority", () => {
        const multiSecProfile = {
            profileId: "multi-sec-priority-exam",
            examId: "multi-sec-priority-exam",
            verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
            isOfficial: true,
            maximumMarks: 100,
            droppedQuestionPolicy: DROPPED_QUESTION_POLICY.FULL_MARKS,
            optionalQuestionPolicy: OPTIONAL_QUESTION_POLICY.NONE,
            markingScheme: { correct: 1, incorrect: 0 },
            numberingRestartsPerSection: false,
            sections: [
                {
                    id: "sec_alpha",
                    name: "Section Alpha",
                    subject: "Alpha",
                    startQuestion: 1,
                    endQuestion: 10,
                    questionCount: 10,
                    requiredCount: 10,
                    markingScheme: { correct: 2, incorrect: 0 }
                },
                {
                    id: "sec_beta",
                    name: "Section Beta",
                    subject: "Beta",
                    startQuestion: 11,
                    endQuestion: 20,
                    questionCount: 10,
                    requiredCount: 10,
                    markingScheme: { correct: 5, incorrect: 0 }
                }
            ]
        };

        it("should match section by explicit sectionId even if numberingRestartsPerSection might overlap", () => {
            const questions = [
                { questionId: "q_beta_1", questionNumber: 1, sectionId: "sec_beta", questionType: "mcq" }
            ];
            const answerKeys = [
                { questionId: "q_beta_1", questionNumber: 1, sectionId: "sec_beta", correctOptionIds: ["A"] }
            ];

            const result = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers: { q_beta_1: "A" },
                examProfile: multiSecProfile
            });

            assert.equal(result.totalScore, 5, "Question with sectionId 'sec_beta' must resolve to Section Beta (+5), not Section Alpha (+2)");
            assert.equal(result.breakdown[0].sectionId, "sec_beta");
        });

        it("should reject with INVALID_SECTION_ID_REJECTED when explicit sectionId does not exist", () => {
            const questions = [
                { questionId: "q_ghost", questionNumber: 1, sectionId: "non_existent_section", questionType: "mcq" }
            ];
            const answerKeys = [
                { questionId: "q_ghost", questionNumber: 1, correctOptionIds: ["A"] }
            ];

            assert.throws(() => {
                UniversalScoringEngine.evaluateAttempt({
                    questions,
                    answerKeys,
                    studentAnswers: { q_ghost: "A" },
                    examProfile: multiSecProfile
                });
            }, (err) => {
                return err.code === "INVALID_SECTION_ID_REJECTED" && err.message.includes("non_existent_section");
            });
        });
    });
});
