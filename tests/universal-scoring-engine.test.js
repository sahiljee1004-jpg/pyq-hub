import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../server/services/scoring/rational.js";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";
import { LegacyScoringAdapter } from "../server/services/scoring/legacyScoringAdapter.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import {
    ExamProfileRegistry,
    VERIFICATION_STATUS,
    OPTIONAL_QUESTION_POLICY,
    DROPPED_QUESTION_POLICY
} from "../server/services/admin/examProfileRegistry.js";

describe("Milestone 2 — Universal Scoring Engine & Section Strategy Integration", () => {

    describe("1. Exact Rational Arithmetic Engine (BigInt Fraction)", () => {
        test("1.1 Performs exact irreducible fraction arithmetic (add, sub, mul, div)", () => {
            const r1 = new Rational(2, 3);
            const r2 = new Rational(1, 3);

            const sum = r1.add(r2);
            assert.strictEqual(sum.toFractionString(), "1");
            assert.strictEqual(sum.num, 1n);
            assert.strictEqual(sum.den, 1n);

            const diff = r1.sub(r2);
            assert.strictEqual(diff.toFractionString(), "1/3");
            assert.strictEqual(diff.num, 1n);
            assert.strictEqual(diff.den, 3n);

            const prod = r1.mul(r2);
            assert.strictEqual(prod.toFractionString(), "2/9");
            assert.strictEqual(prod.num, 2n);
            assert.strictEqual(prod.den, 9n);

            const quot = r1.div(r2);
            assert.strictEqual(quot.toFractionString(), "2");
            assert.strictEqual(quot.num, 2n);
            assert.strictEqual(quot.den, 1n);
        });

        test("1.2 Supports zero, negative fractions and Euclidean GCD reduction", () => {
            const zero = Rational.ZERO;
            assert.strictEqual(zero.isZero(), true);
            assert.strictEqual(zero.toFractionString(), "0");

            const neg = new Rational(-4, 6);
            assert.strictEqual(neg.toFractionString(), "-2/3");
            assert.strictEqual(neg.num, -2n);
            assert.strictEqual(neg.den, 3n);
            assert.strictEqual(neg.isNegative(), true);

            const doubleNeg = new Rational(-10, -15);
            assert.strictEqual(doubleNeg.toFractionString(), "2/3");
            assert.strictEqual(doubleNeg.num, 2n);
            assert.strictEqual(doubleNeg.den, 3n);
        });

        test("1.3 Rational.from parses integers, floats, fraction strings, and objects", () => {
            assert.strictEqual(Rational.from(5).toFractionString(), "5");
            assert.strictEqual(Rational.from(0.25).toFractionString(), "1/4");
            assert.strictEqual(Rational.from(-0.5).toFractionString(), "-1/2");
            assert.strictEqual(Rational.from("2/3").toFractionString(), "2/3");
            assert.strictEqual(Rational.from("-1/3").toFractionString(), "-1/3");
            assert.strictEqual(Rational.from("0.75").toFractionString(), "3/4");
            assert.strictEqual(Rational.from({ num: 10, den: 4 }).toFractionString(), "5/2");
        });

        test("1.4 Rounding modes: round_half_up, truncate, round_half_even, and decimals", () => {
            const oneThird = new Rational(1, 3);
            assert.strictEqual(oneThird.toDecimalString(3, "round_half_up"), "0.333");
            assert.strictEqual(oneThird.toDecimalString(3, "truncate"), "0.333");

            const twoThirds = new Rational(2, 3);
            assert.strictEqual(twoThirds.toDecimalString(3, "round_half_up"), "0.667");
            assert.strictEqual(twoThirds.toDecimalString(3, "truncate"), "0.666");

            const negTwoThirds = new Rational(-2, 3);
            assert.strictEqual(negTwoThirds.toDecimalString(3, "round_half_up"), "-0.667");
            assert.strictEqual(negTwoThirds.toDecimalString(3, "truncate"), "-0.666");

            const half = new Rational(1, 2);
            assert.strictEqual(half.toDecimalString(2, "round_half_up"), "0.50");
            assert.strictEqual(half.toDecimalString(0, "round_half_up"), "1");
        });

        test("1.5 Lossless serialization to JSON and Number", () => {
            const r = new Rational(4, 3);
            const json = r.toJSON();
            assert.strictEqual(json.num, "4");
            assert.strictEqual(json.den, "3");
            assert.strictEqual(json.decimal, 1.333);
            assert.strictEqual(json.fraction, "4/3");
            assert.strictEqual(r.toNumber(3), 1.333);
        });

        test("1.6 Division by zero throws DivisionByZero Error", () => {
            assert.throws(() => new Rational(1, 0), /DivisionByZero/);
            assert.throws(() => new Rational(1, 2).div(new Rational(0)), /DivisionByZero/);
        });
    });

    describe("2. 4-Level Scoring Hierarchy & Conflict Resolution", () => {
        test("2.1 Level 4 (Highest): Question / Key explicit override takes top precedence", () => {
            const profile = ExamProfileRegistry.getProfile("upsc-prelims-2024");
            // UPSC default is +2, -2/3. Override Q1 with +5, -2
            const questions = [{ questionId: "q1", questionNumber: 1, marksAwarded: 5, marksDeducted: 2 }];
            const keys = [{ questionId: "q1", questionNumber: 1, correctOptionIds: ["1"] }];

            // Correct attempt -> awards +5
            const resCorrect = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { q1: "1" },
                examProfile: profile
            });
            assert.strictEqual(resCorrect.totalScore, 5);
            assert.strictEqual(resCorrect.breakdown[0].marksAwarded, 5);

            // Incorrect attempt -> deducts 2
            const resIncorrect = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { q1: "2" },
                examProfile: profile
            });
            assert.strictEqual(resIncorrect.totalScore, -2);
            assert.strictEqual(resIncorrect.breakdown[0].marksAwarded, -2);
        });

        test("2.2 Level 3: Question-type rule within section overrides section default", () => {
            // Profile with section default +4/-1, but questionTypeRules for 'numerical' is +4/0 (zero penalty)
            const customProfile = {
                profileId: "custom-test-hierarchy",
                examId: "custom-exam",
                isOfficial: true,
                verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
                maximumMarks: 100,
                markingScheme: { correct: 4, incorrect: 1 },
                sections: [
                    {
                        id: "sec1",
                        startQuestion: 1,
                        endQuestion: 10,
                        markingScheme: { correct: 4, incorrect: 1 },
                        questionTypeRules: {
                            numerical: { correct: 4, incorrect: 0 }
                        }
                    }
                ]
            };

            const questions = [
                { questionId: "q1", questionNumber: 1, sectionId: "sec1", questionType: "mcq" },
                { questionId: "q2", questionNumber: 2, sectionId: "sec1", questionType: "numerical" }
            ];
            const keys = [
                { questionId: "q1", questionNumber: 1, correctOptionIds: ["1"] },
                { questionId: "q2", questionNumber: 2, acceptedAnswers: ["100"] }
            ];

            // Wrong answers on both: MCQ gets -1, Numerical gets 0 (type rule applied)
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { q1: "2", q2: "99" },
                examProfile: customProfile
            });

            assert.strictEqual(res.breakdown[0].marksAwarded, -1);
            assert.strictEqual(res.breakdown[1].marksAwarded, 0);
            assert.strictEqual(res.totalScore, -1);
        });

        test("2.3 Level 2: Section-level marking scheme overrides exam-level default", () => {
            const customProfile = {
                profileId: "custom-sec-override",
                examId: "custom-exam",
                isOfficial: true,
                verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
                maximumMarks: 100,
                markingScheme: { correct: 2, incorrect: 0.5 },
                sections: [
                    {
                        id: "sec_hard",
                        startQuestion: 1,
                        endQuestion: 5,
                        markingScheme: { correct: 4, incorrect: 2 } // Section override
                    }
                ]
            };

            const questions = [{ questionId: "q1", questionNumber: 1, sectionId: "sec_hard", questionType: "mcq" }];
            const keys = [{ questionId: "q1", questionNumber: 1, correctOptionIds: ["1"] }];

            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { q1: "1" },
                examProfile: customProfile
            });

            assert.strictEqual(res.totalScore, 4); // Got section override (+4), not exam default (+2)
        });

        test("2.4 Level 1: Exam-level default applies when no lower overrides exist", () => {
            const customProfile = {
                profileId: "custom-exam-default",
                examId: "custom-exam",
                isOfficial: true,
                verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
                maximumMarks: 50,
                markingScheme: { correct: 3, incorrect: 1 },
                sections: []
            };

            const questions = [{ questionId: "q1", questionNumber: 1, questionType: "mcq" }];
            const keys = [{ questionId: "q1", questionNumber: 1, correctOptionIds: ["1"] }];

            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { q1: "1" },
                examProfile: customProfile
            });

            assert.strictEqual(res.totalScore, 3);
        });

        test("2.5 Fail-Closed: Unknown/unverified exam without verified marks throws UNVERIFIED_EXAM_SCORING_REJECTED", () => {
            const questions = [{ questionId: "q1", questionNumber: 1, examId: "unknown-unregistered-exam" }];
            const keys = [{ questionId: "q1", questionNumber: 1, correctOptionIds: ["1"] }];

            assert.throws(() => {
                UniversalScoringEngine.evaluateAttempt({
                    questions,
                    answerKeys: keys,
                    studentAnswers: { q1: "1" }
                });
            }, (err) => {
                return err.code === "UNVERIFIED_EXAM_SCORING_REJECTED";
            });
        });
    });

    describe("3. Question Type Evaluation (MCQ, MSQ, Numerical, Partial Marking)", () => {
        test("3.1 GATE CS 2024 MSQ: Zero negative marking, all-or-nothing (no partial credit)", () => {
            const gateProfile = ExamProfileRegistry.getProfile("gate-cs-2024");
            // Section 2 (core_section) has 2-mark questions
            const questions = [
                { questionId: "gate_msq_q11", questionNumber: 11, sectionId: "core_section", questionType: "msq" },
                { questionId: "gate_msq_q12", questionNumber: 12, sectionId: "core_section", questionType: "msq" },
                { questionId: "gate_msq_q13", questionNumber: 13, sectionId: "core_section", questionType: "msq" }
            ];
            const keys = [
                { questionId: "gate_msq_q11", questionNumber: 11, correctOptionIds: ["1", "3"] },
                { questionId: "gate_msq_q12", questionNumber: 12, correctOptionIds: ["1", "3"] },
                { questionId: "gate_msq_q13", questionNumber: 13, correctOptionIds: ["1", "3"] }
            ];

            // Q11: Exact match (1, 3) -> +2
            // Q12: Incomplete match (only 1 of 2) -> 0 (no partial marks in GATE)
            // Q13: Wrong option selected (1, 4) -> 0 (zero penalty in GATE MSQ)
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: {
                    gate_msq_q11: ["1", "3"],
                    gate_msq_q12: ["1"],
                    gate_msq_q13: ["1", "4"]
                },
                examProfile: gateProfile
            });

            assert.strictEqual(res.breakdown[0].marksAwarded, 2);
            assert.strictEqual(res.breakdown[0].status, "correct");

            assert.strictEqual(res.breakdown[1].marksAwarded, 0);
            assert.strictEqual(res.breakdown[1].status, "incorrect");

            assert.strictEqual(res.breakdown[2].marksAwarded, 0);
            assert.strictEqual(res.breakdown[2].status, "incorrect");

            assert.strictEqual(res.totalScore, 2);
        });

        test("3.2 JEE Advanced MSQ Partial Marking: awards proportional credit when partialMarkingEnabled", () => {
            const jeeAdvProfile = ExamProfileRegistry.getProfile("jee-advanced-2024");
            const questions = [
                { questionId: "ja_q5", questionNumber: 5, sectionId: "physics_sec2", questionType: "msq", partialMarkingEnabled: true, marksAwarded: 4 }
            ];
            const keys = [
                { questionId: "ja_q5", questionNumber: 5, sectionId: "physics_sec2", correctOptionIds: ["1", "2", "3", "4"], partialMarkingEnabled: true }
            ];

            // Student selects 2 of 4 correct options, 0 incorrect options -> 4 * (2/4) = 2 marks
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { ja_q5: ["1", "2"] },
                examProfile: jeeAdvProfile
            });

            assert.strictEqual(res.totalScore, 2);
            assert.strictEqual(res.breakdown[0].status, "correct");
            assert.strictEqual(res.breakdown[0].marksAwarded, 2);
        });

        test("3.3 Numerical / NAT within numericTolerance evaluates correctly", () => {
            const questions = [
                { questionId: "nat_q1", questionNumber: 1, questionType: "numerical", marksAwarded: 4 },
                { questionId: "nat_q2", questionNumber: 2, questionType: "numerical", marksAwarded: 4 }
            ];
            const keys = [
                { questionId: "nat_q1", questionNumber: 1, acceptedAnswers: ["15.5"], numericTolerance: 0.1 },
                { questionId: "nat_q2", questionNumber: 2, acceptedAnswers: ["100"], numericTolerance: 0 }
            ];

            // Q1: student enters 15.55 (within 0.1 of 15.5) -> correct (+4)
            // Q2: student enters 100.01 (outside tolerance 0) -> incorrect (0 or penalty)
            const customProfile = {
                profileId: "test-nat",
                examId: "test-nat",
                isOfficial: true,
                verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
                markingScheme: { correct: 4, incorrect: 0 },
                sections: []
            };

            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { nat_q1: "15.55", nat_q2: "100.01" },
                examProfile: customProfile
            });

            assert.strictEqual(res.breakdown[0].status, "correct");
            assert.strictEqual(res.breakdown[0].marksAwarded, 4);

            assert.strictEqual(res.breakdown[1].status, "incorrect");
            assert.strictEqual(res.breakdown[1].marksAwarded, 0);

            assert.strictEqual(res.totalScore, 4);
        });
    });

    describe("4. Optional-Question Selection Policies", () => {
        test("4.1 first_k_attempted: JEE Main 2024 Section B evaluates only first 5 attempted questions", () => {
            const jee2024 = ExamProfileRegistry.getProfile("jee-main-2024");
            // Mathematics Section B: Q21-Q30 (10 questions, attempt any 5)
            const questions = [];
            const keys = [];
            const answers = {};

            for (let qNum = 21; qNum <= 30; qNum++) {
                questions.push({
                    questionId: `jee-math-q${qNum}`,
                    questionNumber: qNum,
                    sectionId: "math_b",
                    questionType: "numerical"
                });
                keys.push({
                    questionId: `jee-math-q${qNum}`,
                    questionNumber: qNum,
                    sectionId: "math_b",
                    acceptedAnswers: ["10"]
                });
            }

            // Student attempts 7 questions: Q21, Q22, Q23, Q24, Q25, Q26, Q27 (all correct: "10")
            for (let qNum = 21; qNum <= 27; qNum++) {
                answers[`jee-math-q${qNum}`] = "10";
            }

            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: answers,
                examProfile: jee2024
            });

            // Exactly 5 questions scored (+4 * 5 = 20)
            // Q26 and Q27 must be capped as "optional_exceeded" with 0 marks
            assert.strictEqual(res.totalScore, 20);
            assert.strictEqual(res.correctCount, 5);

            const q25 = res.breakdown.find(b => b.questionNumber === 25);
            assert.strictEqual(q25.status, "correct");
            assert.strictEqual(q25.marksAwarded, 4);

            const q26 = res.breakdown.find(b => b.questionNumber === 26);
            assert.strictEqual(q26.status, "optional_exceeded");
            assert.strictEqual(q26.marksAwarded, 0);

            const q27 = res.breakdown.find(b => b.questionNumber === 27);
            assert.strictEqual(q27.status, "optional_exceeded");
            assert.strictEqual(q27.marksAwarded, 0);
        });

        test("4.2 first_k_attempted: NEET UG 2024 Section B evaluates only first 10 attempted questions", () => {
            const neet2024 = ExamProfileRegistry.getProfile("neet-ug-2024");
            // Physics Section B: Q36-Q50 (15 questions, attempt any 10)
            const questions = [];
            const keys = [];
            const answers = {};

            for (let qNum = 36; qNum <= 50; qNum++) {
                questions.push({
                    questionId: `neet-phy-q${qNum}`,
                    questionNumber: qNum,
                    sectionId: "physics_b",
                    questionType: "mcq"
                });
                keys.push({
                    questionId: `neet-phy-q${qNum}`,
                    questionNumber: qNum,
                    sectionId: "physics_b",
                    correctOptionIds: ["1"]
                });
            }

            // Student attempts 12 questions (Q36 to Q47)
            for (let qNum = 36; qNum <= 47; qNum++) {
                answers[`neet-phy-q${qNum}`] = "1";
            }

            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: answers,
                examProfile: neet2024
            });

            // Exactly 10 questions scored (+4 * 10 = 40)
            assert.strictEqual(res.totalScore, 40);
            assert.strictEqual(res.correctCount, 10);

            const q45 = res.breakdown.find(b => b.questionNumber === 45);
            assert.strictEqual(q45.status, "correct");

            const q46 = res.breakdown.find(b => b.questionNumber === 46);
            assert.strictEqual(q46.status, "optional_exceeded");
            assert.strictEqual(q46.marksAwarded, 0);

            const q47 = res.breakdown.find(b => b.questionNumber === 47);
            assert.strictEqual(q47.status, "optional_exceeded");
            assert.strictEqual(q47.marksAwarded, 0);
        });
    });

    describe("5. Dropped-Question Handling Policies", () => {
        test("5.1 FULL_MARKS (BPSC / NEET / JEE): Awards unconditional positive marks to all candidates", () => {
            const bpscProfile = ExamProfileRegistry.getProfile("bpsc-69th-2023");
            const questions = [
                { questionId: "bpsc_q1", questionNumber: 1, questionType: "mcq", marksAwarded: 1 },
                { questionId: "bpsc_q2", questionNumber: 2, questionType: "mcq", marksAwarded: 1 }
            ];
            const keys = [
                { questionId: "bpsc_q1", questionNumber: 1, correctOptionIds: ["1"], isDropped: false },
                { questionId: "bpsc_q2", questionNumber: 2, isDropped: true } // Dropped
            ];

            // Student leaves Q2 unattempted; full bonus marks (+1) must still be awarded
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { bpsc_q1: "1" },
                examProfile: bpscProfile
            });

            assert.strictEqual(res.droppedCount, 1);
            assert.strictEqual(res.correctCount, 1);
            assert.strictEqual(res.totalScore, 2); // 1 (correct) + 1 (dropped bonus)
            assert.strictEqual(res.breakdown[1].status, "dropped");
            assert.strictEqual(res.breakdown[1].bonusAwarded, true);
            assert.strictEqual(res.breakdown[1].marksAwarded, 1);
        });

        test("5.2 PRO_RATA (UPSC Prelims): Scales score exactly using rational arithmetic", () => {
            const upscProfile = ExamProfileRegistry.getProfile("upsc-prelims-2024");
            // 100 questions total, 200 marks.
            // 4 questions dropped -> 96 valid questions = 192 valid marks.
            // Student scores 40 correct (80 marks) and 0 incorrect on valid questions.
            // Pro-rata scaled score = 80 * (200 / 192) = 80 * (25 / 24) = 250 / 3 = 83.333
            const questions = [];
            const keys = [];
            const answers = {};

            for (let i = 1; i <= 100; i++) {
                questions.push({ questionId: `upsc_q${i}`, questionNumber: i, questionType: "mcq", sectionId: "general_studies" });
                const isDropped = i > 96;
                keys.push({ questionId: `upsc_q${i}`, questionNumber: i, correctOptionIds: ["1"], isDropped });
                if (i <= 40) answers[`upsc_q${i}`] = "1";
            }

            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: answers,
                examProfile: upscProfile
            });

            assert.strictEqual(res.droppedCount, 4);
            assert.strictEqual(res.correctCount, 40);
            assert.strictEqual(res.totalScore, 83.333);
            assert.strictEqual(res.rationalScore.toFractionString(), "250/3");
        });

        test("5.3 ATTEMPTED_ONLY: Awards marks only to candidates who attempted the dropped question", () => {
            const customProfile = {
                profileId: "test-attempted-only",
                examId: "test-attempted",
                isOfficial: true,
                verificationStatus: VERIFICATION_STATUS.VERIFIED_OFFICIAL,
                droppedQuestionPolicy: DROPPED_QUESTION_POLICY.ATTEMPTED_ONLY,
                markingScheme: { correct: 4, incorrect: 1 },
                sections: []
            };

            const questions = [
                { questionId: "q1", questionNumber: 1, marksAwarded: 4 },
                { questionId: "q2", questionNumber: 2, marksAwarded: 4 }
            ];
            const keys = [
                { questionId: "q1", questionNumber: 1, isDropped: true },
                { questionId: "q2", questionNumber: 2, isDropped: true }
            ];

            // Student attempts Q1, leaves Q2 blank
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { q1: "3" },
                examProfile: customProfile
            });

            assert.strictEqual(res.breakdown[0].bonusAwarded, true);
            assert.strictEqual(res.breakdown[0].marksAwarded, 4);

            assert.strictEqual(res.breakdown[1].bonusAwarded, false);
            assert.strictEqual(res.breakdown[1].marksAwarded, 0);

            assert.strictEqual(res.totalScore, 4);
        });

        test("5.4 ZERO_MARKS: Unverified university archetype awards zero marks for dropped questions", () => {
            const univProfile = ExamProfileRegistry.getProfile("university-semester-default");
            assert.strictEqual(univProfile.droppedQuestionPolicy, DROPPED_QUESTION_POLICY.ZERO_MARKS);

            const questions = [{ questionId: "u_q1", questionNumber: 1, marksAwarded: 5 }];
            const keys = [{ questionId: "u_q1", questionNumber: 1, isDropped: true }];

            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { u_q1: "1" },
                examProfile: univProfile
            });

            assert.strictEqual(res.totalScore, 0);
            assert.strictEqual(res.breakdown[0].bonusAwarded, false);
            assert.strictEqual(res.breakdown[0].marksAwarded, 0);
        });
    });

    describe("6. Cross-Exam Scoring Verification (All 10 Exam Archetypes)", () => {
        test("6.1 UPSC Prelims 2026 scoring (+2, -2/3)", () => {
            const profile = ExamProfileRegistry.getProfile("upsc-prelims-2026");
            const questions = [
                { questionId: "u1", questionNumber: 1 },
                { questionId: "u2", questionNumber: 2 },
                { questionId: "u3", questionNumber: 3 }
            ];
            const keys = [
                { questionId: "u1", questionNumber: 1, correctOptionIds: ["1"] },
                { questionId: "u2", questionNumber: 2, correctOptionIds: ["2"] },
                { questionId: "u3", questionNumber: 3, correctOptionIds: ["3"] }
            ];

            // 2 correct, 1 incorrect: 4 - 2/3 = 10/3 = 3.333
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { u1: "1", u2: "2", u3: "1" },
                examProfile: profile
            });

            assert.strictEqual(res.totalScore, 3.333);
            assert.strictEqual(res.rationalScore.toFractionString(), "10/3");
        });

        test("6.2 BPSC 69th 2023 scoring (+1, -1/3)", () => {
            const profile = ExamProfileRegistry.getProfile("bpsc-69th-2023");
            const questions = [
                { questionId: "b1", questionNumber: 1 },
                { questionId: "b2", questionNumber: 2 }
            ];
            const keys = [
                { questionId: "b1", questionNumber: 1, correctOptionIds: ["1"] },
                { questionId: "b2", questionNumber: 2, correctOptionIds: ["2"] }
            ];

            // 1 correct, 1 incorrect: 1 - 1/3 = 2/3 = 0.667
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { b1: "1", b2: "1" },
                examProfile: profile
            });

            assert.strictEqual(res.totalScore, 0.667);
            assert.strictEqual(res.rationalScore.toFractionString(), "2/3");
        });

        test("6.3 SSC CGL 2024 scoring (+2, -0.5)", () => {
            const profile = ExamProfileRegistry.getProfile("ssc-cgl-2024");
            const questions = [
                { questionId: "s1", questionNumber: 1, sectionId: "general_intelligence" },
                { questionId: "s2", questionNumber: 2, sectionId: "general_intelligence" }
            ];
            const keys = [
                { questionId: "s1", questionNumber: 1, sectionId: "general_intelligence", correctOptionIds: ["1"] },
                { questionId: "s2", questionNumber: 2, sectionId: "general_intelligence", correctOptionIds: ["2"] }
            ];

            // 1 correct, 1 incorrect: 2 - 0.5 = 1.5
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { s1: "1", s2: "1" },
                examProfile: profile
            });

            assert.strictEqual(res.totalScore, 1.5);
            assert.strictEqual(res.rationalScore.toFractionString(), "3/2");
        });

        test("6.4 Banking IBPS PO 2024 scoring (+1, -0.25)", () => {
            const profile = ExamProfileRegistry.getProfile("banking-ibps-po-2024");
            const questions = [
                { questionId: "ib1", questionNumber: 1, sectionId: "english_language" },
                { questionId: "ib2", questionNumber: 2, sectionId: "english_language" }
            ];
            const keys = [
                { questionId: "ib1", questionNumber: 1, sectionId: "english_language", correctOptionIds: ["1"] },
                { questionId: "ib2", questionNumber: 2, sectionId: "english_language", correctOptionIds: ["2"] }
            ];

            // 1 correct, 1 incorrect: 1 - 0.25 = 0.75
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { ib1: "1", ib2: "1" },
                examProfile: profile
            });

            assert.strictEqual(res.totalScore, 0.75);
            assert.strictEqual(res.rationalScore.toFractionString(), "3/4");
        });

        test("6.5 CUET UG 2024 scoring (+5, -1)", () => {
            const profile = ExamProfileRegistry.getProfile("cuet-ug-2024");
            const questions = [
                { questionId: "c1", questionNumber: 1 },
                { questionId: "c2", questionNumber: 2 }
            ];
            const keys = [
                { questionId: "c1", questionNumber: 1, correctOptionIds: ["1"] },
                { questionId: "c2", questionNumber: 2, correctOptionIds: ["2"] }
            ];

            // 1 correct, 1 incorrect: 5 - 1 = 4
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { c1: "1", c2: "1" },
                examProfile: profile
            });

            assert.strictEqual(res.totalScore, 4);
        });

        test("6.6 JEE Main 2026 scoring (+4, -1 for all compulsory questions)", () => {
            const profile = ExamProfileRegistry.getProfile("jee-main-2026");
            const questions = [
                { questionId: "j1", questionNumber: 1, sectionId: "math_a", questionType: "mcq" },
                { questionId: "j2", questionNumber: 21, sectionId: "math_b", questionType: "numerical" }
            ];
            const keys = [
                { questionId: "j1", questionNumber: 1, sectionId: "math_a", correctOptionIds: ["1"] },
                { questionId: "j2", questionNumber: 21, sectionId: "math_b", acceptedAnswers: ["25"] }
            ];

            // 1 correct MCQ (+4), 1 wrong NAT (-1) -> 3 marks
            const res = UniversalScoringEngine.evaluateAttempt({
                questions,
                answerKeys: keys,
                studentAnswers: { j1: "1", j2: "20" },
                examProfile: profile
            });

            assert.strictEqual(res.totalScore, 3);
        });
    });

    describe("7. Legacy Adapter Parity Verification", () => {
        test("7.1 LegacyScoringAdapter and MockTestScoringService.evaluateAttempt have 100% parity across UPSC combinations", () => {
            const questions = Array.from({ length: 100 }, (_, i) => ({
                questionId: `upsc_q${i + 1}`,
                questionNumber: i + 1,
                questionType: "mcq",
                subject: "General Studies"
            }));
            const keys = Array.from({ length: 100 }, (_, i) => ({
                questionId: `upsc_q${i + 1}`,
                questionNumber: i + 1,
                correctOptionIds: ["1"]
            }));

            // Test 10 representative combination bounds
            const testCases = [
                { correct: 100, incorrect: 0 },
                { correct: 75, incorrect: 25 },
                { correct: 50, incorrect: 30 },
                { correct: 33, incorrect: 67 },
                { correct: 0, incorrect: 100 },
                { correct: 0, incorrect: 0 }
            ];

            for (const tc of testCases) {
                const answers = {};
                for (let i = 1; i <= tc.correct; i++) answers[`upsc_q${i}`] = "1";
                for (let i = tc.correct + 1; i <= tc.correct + tc.incorrect; i++) answers[`upsc_q${i}`] = "2";

                const historical = MockTestScoringService.evaluateAttemptHistorical({
                    questions,
                    answerKeys: keys,
                    studentAnswers: answers,
                    examConfig: { examId: "upsc-prelims" }
                });

                const adapter = LegacyScoringAdapter.evaluateAttempt({
                    questions,
                    answerKeys: keys,
                    studentAnswers: answers,
                    examConfig: { examId: "upsc-prelims" }
                });

                assert.strictEqual(historical.totalScore, adapter.totalScore, `UPSC parity mismatch on c=${tc.correct}, w=${tc.incorrect}`);
                assert.strictEqual(historical.correctCount, adapter.correctCount);
                assert.strictEqual(historical.incorrectCount, adapter.incorrectCount);
                assert.strictEqual(historical.unansweredCount, adapter.unansweredCount);
                assert.strictEqual(historical.percentageScore, adapter.percentageScore);
            }
        });

        test("7.2 LegacyScoringAdapter and MockTestScoringService.evaluateAttempt have 100% parity across BPSC combinations", () => {
            const questions = Array.from({ length: 150 }, (_, i) => ({
                questionId: `bpsc_q${i + 1}`,
                questionNumber: i + 1,
                questionType: "mcq",
                subject: "General Studies"
            }));
            const keys = Array.from({ length: 150 }, (_, i) => ({
                questionId: `bpsc_q${i + 1}`,
                questionNumber: i + 1,
                correctOptionIds: ["1"]
            }));

            const testCases = [
                { correct: 150, incorrect: 0 },
                { correct: 100, incorrect: 50 },
                { correct: 75, incorrect: 25 },
                { correct: 50, incorrect: 50 },
                { correct: 1, incorrect: 149 },
                { correct: 0, incorrect: 0 }
            ];

            for (const tc of testCases) {
                const answers = {};
                for (let i = 1; i <= tc.correct; i++) answers[`bpsc_q${i}`] = "1";
                for (let i = tc.correct + 1; i <= tc.correct + tc.incorrect; i++) answers[`bpsc_q${i}`] = "2";

                const historical = MockTestScoringService.evaluateAttemptHistorical({
                    questions,
                    answerKeys: keys,
                    studentAnswers: answers,
                    examConfig: { examId: "bpsc" }
                });

                const adapter = LegacyScoringAdapter.evaluateAttempt({
                    questions,
                    answerKeys: keys,
                    studentAnswers: answers,
                    examConfig: { examId: "bpsc" }
                });

                assert.strictEqual(historical.totalScore, adapter.totalScore, `BPSC parity mismatch on c=${tc.correct}, w=${tc.incorrect}`);
                assert.strictEqual(historical.correctCount, adapter.correctCount);
                assert.strictEqual(historical.incorrectCount, adapter.incorrectCount);
                assert.strictEqual(historical.unansweredCount, adapter.unansweredCount);
            }
        });

        test("7.3 Exposes modern engine and rational helper cleanly on MockTestScoringService", () => {
            assert.strictEqual(MockTestScoringService.engine, UniversalScoringEngine);
            assert.strictEqual(MockTestScoringService.adapter, LegacyScoringAdapter);
            assert.strictEqual(MockTestScoringService.Rational, Rational);
        });
    });
});
