import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { UIRTransformationService } from "../server/services/uir/uirTransformationService.js";
import { UIRToMockTestAdapter } from "../server/services/uir/uirAdapters.js";
import { Rational } from "../server/services/scoring/rational.js";

describe("Phase 5.6.2 — Negative-Marking Mathematical Discrepancy Investigation Suite", () => {
    process.env.NODE_ENV = "test";

    const findVaultFile = (suffix) => {
        const files = fs.readdirSync("uploads/vault");
        const found = files.find(f => f.endsWith(suffix));
        return found ? path.join("uploads/vault", found) : null;
    };

    const gateQpPath = findVaultFile("GATE_2026_CS1_Typed.pdf");
    const gateAkPath = findVaultFile("GATE_2026_CS1_Answer_Key.pdf");
    const gatePatternPath = findVaultFile("GATE_2026_CS_Exam_Pattern.pdf");

    // =========================================================================
    // 1. Exact Rational Arithmetic Proof (Q1-5 @ 1/3, Q6-10 @ 2/3)
    // =========================================================================
    describe("1. Exact Rational Arithmetic Proof", () => {
        test("1.1 Five 1-mark MCQ errors produce exactly -5/3", () => {
            const oneThirdPenalty = new Rational(1n, 3n).neg(); // -1/3
            const fiveOneMarkErrors = oneThirdPenalty.mul(new Rational(5n, 1n));
            assert.strictEqual(fiveOneMarkErrors.num, -5n);
            assert.strictEqual(fiveOneMarkErrors.den, 3n);
            assert.strictEqual(fiveOneMarkErrors.toFractionString(), "-5/3");
            assert.strictEqual(fiveOneMarkErrors.toNumber(3, "round_half_up"), -1.667);
        });

        test("1.2 Five 2-mark MCQ errors produce exactly -10/3", () => {
            const twoThirdPenalty = new Rational(2n, 3n).neg(); // -2/3
            const fiveTwoMarkErrors = twoThirdPenalty.mul(new Rational(5n, 1n));
            assert.strictEqual(fiveTwoMarkErrors.num, -10n);
            assert.strictEqual(fiveTwoMarkErrors.den, 3n);
            assert.strictEqual(fiveTwoMarkErrors.toFractionString(), "-10/3");
            assert.strictEqual(fiveTwoMarkErrors.toNumber(3, "round_half_up"), -3.333);
        });

        test("1.3 Combined sum of all ten errors is exactly -5/1 (integer -5)", () => {
            const fiveOneMark = new Rational(1n, 3n).neg().mul(new Rational(5n, 1n));
            const fiveTwoMark = new Rational(2n, 3n).neg().mul(new Rational(5n, 1n));
            const totalRational = fiveOneMark.add(fiveTwoMark);

            assert.strictEqual(totalRational.num, -5n, "Numerator must be -5n after GCD reduction");
            assert.strictEqual(totalRational.den, 1n, "Denominator must be 1n after GCD reduction");
            assert.strictEqual(totalRational.toNumber(3, "round_half_up"), -5, "Numeric value must be exactly -5");
            assert.strictEqual(totalRational.toFractionString(), "-5");
        });

        test("1.4 Mathematical impossibility of -3.333 for the combined 10-question error set", () => {
            // Note: -3.333 is exactly 10 * (-1/3) or 5 * (-2/3)
            const tenOneMarkErrors = new Rational(1n, 3n).neg().mul(new Rational(10n, 1n));
            assert.strictEqual(tenOneMarkErrors.toFractionString(), "-10/3");
            assert.strictEqual(tenOneMarkErrors.toNumber(3, "round_half_up"), -3.333);

            // The actual 10-question fixture has FIVE 1-mark and FIVE 2-mark questions
            // Therefore, -3.333 represents either:
            // a) Erroneously treating all 10 questions as 1-mark questions (10 * -1/3 = -3.333)
            // b) Only summing the second group (5 * -2/3 = -3.333)
            // c) A transcription mistake in the report prose
            const actualTotal = new Rational(1n, 3n).neg().mul(new Rational(5n, 1n)).add(
                new Rational(2n, 3n).neg().mul(new Rational(5n, 1n))
            );
            assert.notStrictEqual(actualTotal.toNumber(3, "round_half_up"), -3.333);
            assert.strictEqual(actualTotal.toNumber(3, "round_half_up"), -5);
        });
    });

    // =========================================================================
    // 2. Fixture vs. Engine Comparison
    // =========================================================================
    describe("2. Fixture vs. Engine Execution Comparison", () => {
        const fixtureQuestions = [];
        const fixtureAnswerKeys = [];

        for (let i = 1; i <= 10; i++) {
            const marksAwarded = i <= 5 ? 1 : 2;
            const marksDeducted = i <= 5 ? (1 / 3) : (2 / 3);
            const qId = `test_q_${i}`;
            fixtureQuestions.push({
                questionId: qId,
                questionNumber: i,
                sectionId: "sec_ga",
                subject: "General Aptitude",
                questionType: "mcq",
                marksAwarded,
                marksDeducted
            });
            fixtureAnswerKeys.push({
                questionId: qId,
                questionNumber: i,
                sectionId: "sec_ga",
                correctOptionIds: ["A"],
                marksAwarded,
                marksDeducted,
                verificationStatus: "verified"
            });
        }

        const profile = {
            profileId: "gate_ga_fixture",
            examId: "gate_ga",
            verificationStatus: "official_verified",
            maximumMarks: 15,
            sections: [
                {
                    id: "sec_ga",
                    sectionId: "sec_ga",
                    name: "General Aptitude",
                    subject: "General Aptitude",
                    startQuestion: 1,
                    endQuestion: 10,
                    questionCount: 10,
                    maximumMarks: 15
                }
            ]
        };

        test("2.1 Engine produces -5 for all-incorrect scenario (reproducing real execution)", () => {
            const allIncorrect = {};
            for (let i = 1; i <= 10; i++) allIncorrect[`test_q_${i}`] = "B";

            const result = UniversalScoringEngine.score(fixtureQuestions, fixtureAnswerKeys, allIncorrect, profile);

            assert.strictEqual(result.totalScore, -5, "Engine must return exactly -5");
            assert.strictEqual(result.rationalScore.num, -5n);
            assert.strictEqual(result.rationalScore.den, 1n);
            assert.strictEqual(result.sectionScores["sec_ga"], -5);
            assert.strictEqual(result.sectionAnalysis["sec_ga"].score, -5);
            assert.strictEqual(result.sectionAnalysis["sec_ga"].maximumMarks, 15);
            assert.strictEqual(result.maximumMarks, 15);
        });

        test("2.2 Engine question breakdown confirms 5 x -0.333 and 5 x -0.667", () => {
            const allIncorrect = {};
            for (let i = 1; i <= 10; i++) allIncorrect[`test_q_${i}`] = "B";

            const result = UniversalScoringEngine.score(fixtureQuestions, fixtureAnswerKeys, allIncorrect, profile);

            for (let i = 1; i <= 5; i++) {
                const b = result.breakdown.find(x => x.questionNumber === i);
                assert.strictEqual(b.marksAwarded, -0.333, `Q${i} must be awarded -0.333`);
                assert.strictEqual(b.rationalScore.toFractionString(), "-1/3");
            }

            for (let i = 6; i <= 10; i++) {
                const b = result.breakdown.find(x => x.questionNumber === i);
                assert.strictEqual(b.marksAwarded, -0.667, `Q${i} must be awarded -0.667`);
                assert.strictEqual(b.rationalScore.toFractionString(), "-2/3");
            }
        });

        test("2.3 Re-run All 4 Response Scenarios against Engine Output", () => {
            // Scenario 1: All correct
            const allCorrect = {};
            for (let i = 1; i <= 10; i++) allCorrect[`test_q_${i}`] = "A";
            const res1 = UniversalScoringEngine.score(fixtureQuestions, fixtureAnswerKeys, allCorrect, profile);
            assert.strictEqual(res1.totalScore, 15);
            assert.strictEqual(res1.maximumMarks, 15);
            assert.strictEqual(res1.sectionAnalysis["sec_ga"].maximumMarks, 15);

            // Scenario 2: All incorrect
            const allIncorrect = {};
            for (let i = 1; i <= 10; i++) allIncorrect[`test_q_${i}`] = "B";
            const res2 = UniversalScoringEngine.score(fixtureQuestions, fixtureAnswerKeys, allIncorrect, profile);
            assert.strictEqual(res2.totalScore, -5);
            assert.strictEqual(res2.maximumMarks, 15);
            assert.strictEqual(res2.sectionAnalysis["sec_ga"].maximumMarks, 15);

            // Scenario 3: All unanswered
            const res3 = UniversalScoringEngine.score(fixtureQuestions, fixtureAnswerKeys, {}, profile);
            assert.strictEqual(res3.totalScore, 0);
            assert.strictEqual(res3.maximumMarks, 15);
            assert.strictEqual(res3.sectionAnalysis["sec_ga"].maximumMarks, 15);

            // Scenario 4: Mixed (Q1, Q2, Q6 correct; Q3, Q7 incorrect; rest blank)
            const mixedAnswers = {
                test_q_1: "A", // +1
                test_q_2: "A", // +1
                test_q_3: "B", // -1/3
                test_q_6: "A", // +2
                test_q_7: "C"  // -2/3
            };
            const res4 = UniversalScoringEngine.score(fixtureQuestions, fixtureAnswerKeys, mixedAnswers, profile);
            // (+1 + 1 + 2) - (1/3 + 2/3) = 4 - 1 = 3
            assert.strictEqual(res4.totalScore, 3);
            assert.strictEqual(res4.maximumMarks, 15);
            assert.strictEqual(res4.sectionAnalysis["sec_ga"].maximumMarks, 15);
        });
    });

    // =========================================================================
    // 3. Full GATE 2026 CS1 Full-Paper Verification (65 Questions, 100 Marks)
    // =========================================================================
    describe("3. Full GATE 2026 CS1 Paper Verification", () => {
        let uirDocument;
        let firestoreDocs;

        test("3.1 Ingest GATE 2026 CS1 and verify structural markers", async () => {
            const qpBuf = fs.readFileSync(gateQpPath);
            const akBuf = fs.readFileSync(gateAkPath);
            const pfBuf = fs.readFileSync(gatePatternPath);

            const result = await UIRTransformationService.transformDocuments(
                { questionPaper: qpBuf, answerKey: akBuf, paperFormat: pfBuf },
                { examId: "gate-2026-cs1", year: 2026 }
            );
            uirDocument = result.uirDocument;
            firestoreDocs = UIRToMockTestAdapter.toFirestoreDocuments(uirDocument);

            assert.strictEqual(uirDocument.questions.length, 65);
            assert.strictEqual(uirDocument.examMetadata.maximumMarks, 100);

            const gaSec = uirDocument.sections.find(s => s.sectionId === "sec_general_aptitude");
            const techSec = uirDocument.sections.find(s => s.sectionId === "sec_technical_engg_maths_cs");

            assert.strictEqual(gaSec.maximumMarks, 15);
            assert.strictEqual(gaSec.questionCount, 10);
            assert.strictEqual(techSec.maximumMarks, 85);
            assert.strictEqual(techSec.questionCount, 55);
        });

        test("3.2 Full-paper all-incorrect attempt: GA receives exactly -5.000", async () => {
            // Answer all 65 questions with wrong option
            const allWrong = {};
            for (const q of firestoreDocs.mockQuestionDocs) {
                allWrong[q.questionId] = "Z_WRONG";
            }

            const result = await MockTestScoringService.evaluateSubmission({
                testId: "gate_all_wrong",
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: allWrong,
                examConfig: firestoreDocs.mockTestDoc
            });

            // GA section has 10 MCQs: 5 @ -1/3 + 5 @ -2/3 = -5
            const ga = result.sectionAnalysis["sec_general_aptitude"];
            assert.strictEqual(ga.maximumMarks, 15, "GA maximum marks must remain 15");
            assert.strictEqual(ga.score, -5, "GA all incorrect score must be exactly -5");

            // Technical section: MSQ and NAT have 0 penalty; only MCQs incur negative marks
            const tech = result.sectionAnalysis["sec_technical_engg_maths_cs"];
            assert.strictEqual(tech.maximumMarks, 85, "Technical maximum marks must remain 85");
            assert.ok(tech.score < 0, "Technical score must be negative due to MCQ errors");

            // Denominators invariant
            assert.strictEqual(result.maximumMarks, 100);
            assert.notStrictEqual(ga.maximumMarks, 65);
            assert.notStrictEqual(tech.maximumMarks, 65);
            assert.strictEqual(ga.maximumMarks + tech.maximumMarks, 100);
        });

        test("3.3 Verification of zero denominators equal to 65 across all metrics", async () => {
            const result = await MockTestScoringService.evaluateSubmission({
                testId: "gate_check_denominators",
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: {},
                examConfig: firestoreDocs.mockTestDoc
            });

            for (const [secId, secData] of Object.entries(result.sectionAnalysis)) {
                assert.notStrictEqual(secData.maximumMarks, 65, `Section ${secId} denominator must NEVER be 65`);
                assert.notStrictEqual(secData.maximumPossibleMarks, 65, `Section ${secId} maximumPossibleMarks must NEVER be 65`);
            }
        });
    });

    // =========================================================================
    // 4. Cross-Examination Negative Marking Override Regression
    // =========================================================================
    describe("4. Cross-Examination Negative Marking Overrides", () => {
        test("4.1 Question-level negative marking override strictly enforced", () => {
            const questions = [{
                questionId: "q_explicit_neg",
                questionNumber: 1,
                sectionId: "sec_1",
                marksAwarded: 3,
                marksDeducted: 1.25 // Explicit
            }];
            const answerKeys = [{
                questionId: "q_explicit_neg",
                questionNumber: 1,
                correctOptionIds: ["A"],
                verificationStatus: "verified"
            }];
            const profile = {
                profileId: "override_test",
                markingScheme: { correct: 3, incorrect: 0.5 },
                sections: [{ id: "sec_1" }]
            };

            const res = UniversalScoringEngine.score(questions, answerKeys, { q_explicit_neg: "B" }, profile);
            assert.strictEqual(res.totalScore, -1.25, "Explicit question-level penalty of 1.25 must be enforced");
        });

        test("4.2 Section-level negative marking override strictly enforced", () => {
            const questions = [{
                questionId: "q_sec_override",
                questionNumber: 1,
                sectionId: "sec_special",
                marksAwarded: 2
            }];
            const answerKeys = [{
                questionId: "q_sec_override",
                questionNumber: 1,
                correctOptionIds: ["A"],
                verificationStatus: "verified"
            }];
            const profile = {
                profileId: "sec_override_test",
                markingScheme: { correct: 2, incorrect: 0.25 },
                sections: [{
                    id: "sec_special",
                    markingScheme: { correct: 2, incorrect: 0.75 }
                }]
            };

            const res = UniversalScoringEngine.score(questions, answerKeys, { q_sec_override: "B" }, profile);
            assert.strictEqual(res.totalScore, -0.75, "Section-level penalty of 0.75 must override profile 0.25");
        });

        test("4.3 SSC CGL: -0.5 mark deduction per wrong answer", () => {
            const questions = [{ questionId: "ssc_1", questionNumber: 1, sectionId: "sec_1", marksAwarded: 2, marksDeducted: 0.5 }];
            const answerKeys = [{ questionId: "ssc_1", questionNumber: 1, correctOptionIds: ["A"], verificationStatus: "verified" }];
            const profile = { profileId: "ssc-cgl", sections: [{ id: "sec_1", maximumMarks: 50 }] };
            const res = UniversalScoringEngine.score(questions, answerKeys, { ssc_1: "B" }, profile);
            assert.strictEqual(res.totalScore, -0.5);
        });

        test("4.4 NEET UG: -1.0 mark deduction per wrong answer", () => {
            const questions = [{ questionId: "neet_1", questionNumber: 1, sectionId: "sec_1", marksAwarded: 4, marksDeducted: 1 }];
            const answerKeys = [{ questionId: "neet_1", questionNumber: 1, correctOptionIds: ["A"], verificationStatus: "verified" }];
            const profile = { profileId: "neet-ug", sections: [{ id: "sec_1", maximumMarks: 180 }] };
            const res = UniversalScoringEngine.score(questions, answerKeys, { neet_1: "B" }, profile);
            assert.strictEqual(res.totalScore, -1);
        });

        test("4.5 JEE Main: NAT questions retain explicit -1.0 mark negative deduction", () => {
            const questions = [{ questionId: "jee_1", questionNumber: 1, sectionId: "sec_1", questionType: "nat", marksAwarded: 4, marksDeducted: 1 }];
            const answerKeys = [{ questionId: "jee_1", questionNumber: 1, numericValue: 42, marksAwarded: 4, marksDeducted: 1, verificationStatus: "verified" }];
            const profile = { profileId: "jee-main", sections: [{ id: "sec_1", maximumMarks: 100 }] };
            const res = UniversalScoringEngine.score(questions, answerKeys, { jee_1: "99" }, profile);
            assert.strictEqual(res.totalScore, -1);
        });

        test("4.6 UPSC Prelims: -2/3 mark deduction per wrong answer", () => {
            const questions = [{ questionId: "upsc_1", questionNumber: 1, sectionId: "sec_1", marksAwarded: 2, marksDeducted: 2 / 3 }];
            const answerKeys = [{ questionId: "upsc_1", questionNumber: 1, correctOptionIds: ["A"], verificationStatus: "verified" }];
            const profile = { profileId: "upsc-prelims", sections: [{ id: "sec_1", maximumMarks: 200 }] };
            const res = UniversalScoringEngine.score(questions, answerKeys, { upsc_1: "B" }, profile);
            assert.strictEqual(res.totalScore, -0.667);
        });

        test("4.7 BPSC 69th: -1/3 mark deduction per wrong answer", () => {
            const questions = [{ questionId: "bpsc_1", questionNumber: 1, sectionId: "sec_1", marksAwarded: 1, marksDeducted: 1 / 3 }];
            const answerKeys = [{ questionId: "bpsc_1", questionNumber: 1, correctOptionIds: ["A"], verificationStatus: "verified" }];
            const profile = { profileId: "bpsc-69th", sections: [{ id: "sec_1", maximumMarks: 150 }] };
            const res = UniversalScoringEngine.score(questions, answerKeys, { bpsc_1: "B" }, profile);
            assert.strictEqual(res.totalScore, -0.333);
        });
    });
});
