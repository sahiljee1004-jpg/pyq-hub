import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { UniversalDocumentIngestionService } from "../server/services/ingestion/universalDocumentIngestionService.js";
import { UIRTransformationService } from "../server/services/uir/uirTransformationService.js";
import { UIRToMockTestAdapter } from "../server/services/uir/uirAdapters.js";
import { Rational } from "../server/services/scoring/rational.js";
import { ExamProfileRegistry } from "../server/services/admin/examProfileRegistry.js";

describe("Phase 5.6.1 — Scoring Maximum Verification & Final GATE Results Acceptance", () => {
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
    // 1. Verify maximumMarksRational Independence
    // =========================================================================
    describe("1. maximumMarksRational Independence Verification", () => {
        const sectionQuestions = [];
        const answerKeys = [];

        // 10 questions: 5 of 1 mark, 5 of 2 marks = 15 total maximum marks
        for (let i = 1; i <= 10; i++) {
            const marksAwarded = i <= 5 ? 1 : 2;
            const marksDeducted = i <= 5 ? (1 / 3) : (2 / 3);
            const qId = `test_q_${i}`;
            sectionQuestions.push({
                questionId: qId,
                questionNumber: i,
                sectionId: "sec_ga",
                subject: "General Aptitude",
                questionType: "mcq",
                marksAwarded,
                marksDeducted
            });
            answerKeys.push({
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
            profileId: "test-exam-profile",
            examId: "test-exam",
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

        test("1.1 Scenario A: All questions correctly answered -> maximumMarks = 15", () => {
            const allCorrect = {};
            for (let i = 1; i <= 10; i++) allCorrect[`test_q_${i}`] = "A";

            const res = UniversalScoringEngine.score(sectionQuestions, answerKeys, allCorrect, profile);
            assert.strictEqual(res.totalScore, 15, "Score must be 15 when all are correct");
            assert.strictEqual(res.sectionAnalysis["sec_ga"].maximumMarks, 15, "Section maximumMarks must be 15");
            assert.strictEqual(res.sectionAnalysis["sec_ga"].maximumPossibleMarks, 15, "Section maximumPossibleMarks must be 15");
            assert.strictEqual(res.maximumMarks, 15, "Overall maximumMarks must be 15");
        });

        test("1.2 Scenario B: All questions incorrectly answered -> score = -5, maximumMarks = 15", () => {
            const allIncorrect = {};
            for (let i = 1; i <= 10; i++) allIncorrect[`test_q_${i}`] = "B";

            const res = UniversalScoringEngine.score(sectionQuestions, answerKeys, allIncorrect, profile);
            assert.strictEqual(res.totalScore, -5, "Score must be exactly -5 when all 10 questions are incorrect (5 * -1/3 + 5 * -2/3 = -5)");
            assert.strictEqual(res.rationalScore.num, -5n, "Rational numerator must be -5n");
            assert.strictEqual(res.rationalScore.den, 1n, "Rational denominator must be 1n");
            assert.strictEqual(res.sectionAnalysis["sec_ga"].maximumMarks, 15, "Section maximumMarks must remain 15");
            assert.strictEqual(res.sectionAnalysis["sec_ga"].maximumPossibleMarks, 15, "Section maximumPossibleMarks must remain 15");
            assert.strictEqual(res.maximumMarks, 15, "Overall maximumMarks must remain 15");
        });

        test("1.3 Scenario C: All questions left unanswered -> maximumMarks = 15", () => {
            const allUnanswered = {};

            const res = UniversalScoringEngine.score(sectionQuestions, answerKeys, allUnanswered, profile);
            assert.strictEqual(res.totalScore, 0, "Score must be 0 when all are unanswered");
            assert.strictEqual(res.sectionAnalysis["sec_ga"].maximumMarks, 15, "Section maximumMarks must remain 15");
            assert.strictEqual(res.sectionAnalysis["sec_ga"].maximumPossibleMarks, 15, "Section maximumPossibleMarks must remain 15");
            assert.strictEqual(res.maximumMarks, 15, "Overall maximumMarks must remain 15");
        });

        test("1.4 Scenario D: Mixture of correct, incorrect, and unanswered -> maximumMarks = 15", () => {
            const mixedAnswers = {
                test_q_1: "A", // Q1 correct (1 mark)
                test_q_2: "A", // Q2 correct (1 mark)
                test_q_3: "B", // Q3 incorrect (-1/3 mark)
                test_q_6: "A", // Q6 correct (2 marks)
                test_q_7: "C"  // Q7 incorrect (-2/3 mark)
                // Q4, Q5, Q8, Q9, Q10 unanswered
            };

            const res = UniversalScoringEngine.score(sectionQuestions, answerKeys, mixedAnswers, profile);
            // Expected score: 1 + 1 - (1/3) + 2 - (2/3) = 4 - 1 = 3 marks
            assert.strictEqual(res.totalScore, 3, "Mixed score must be exactly 3");
            assert.strictEqual(res.sectionAnalysis["sec_ga"].maximumMarks, 15, "Section maximumMarks must remain strictly 15");
            assert.strictEqual(res.sectionAnalysis["sec_ga"].maximumPossibleMarks, 15, "Section maximumPossibleMarks must remain strictly 15");
            assert.strictEqual(res.maximumMarks, 15, "Overall maximumMarks must remain strictly 15");
        });

        test("1.5 Mathematical Independence Invariant holds across all four scenarios", () => {
            const run = (ans) => UniversalScoringEngine.score(sectionQuestions, answerKeys, ans, profile);
            const rA = run({ test_q_1: "A", test_q_2: "A", test_q_3: "A", test_q_4: "A", test_q_5: "A", test_q_6: "A", test_q_7: "A", test_q_8: "A", test_q_9: "A", test_q_10: "A" });
            const rB = run({ test_q_1: "B", test_q_2: "B", test_q_3: "B", test_q_4: "B", test_q_5: "B", test_q_6: "B", test_q_7: "B", test_q_8: "B", test_q_9: "B", test_q_10: "B" });
            const rC = run({});
            const rD = run({ test_q_1: "A", test_q_6: "A" });

            assert.strictEqual(rA.sectionAnalysis["sec_ga"].maximumMarks, rB.sectionAnalysis["sec_ga"].maximumMarks);
            assert.strictEqual(rB.sectionAnalysis["sec_ga"].maximumMarks, rC.sectionAnalysis["sec_ga"].maximumMarks);
            assert.strictEqual(rC.sectionAnalysis["sec_ga"].maximumMarks, rD.sectionAnalysis["sec_ga"].maximumMarks);
            assert.strictEqual(rA.maximumMarks, rB.maximumMarks);
            assert.strictEqual(rB.maximumMarks, rC.maximumMarks);
            assert.strictEqual(rC.maximumMarks, rD.maximumMarks);
        });
    });

    // =========================================================================
    // 2. Verify Negative-Marking Precedence
    // =========================================================================
    describe("2. Negative-Marking Precedence Verification", () => {
        test("2.1 Level 1 (Question-level override) takes strict priority over Section and Exam", () => {
            const questions = [
                {
                    questionId: "q_override_penalty",
                    questionNumber: 1,
                    sectionId: "sec_1",
                    questionType: "msq", // Even though question is MSQ!
                    marksAwarded: 2,
                    marksDeducted: 1.5 // Explicit question-level penalty
                }
            ];
            const answerKeys = [
                {
                    questionId: "q_override_penalty",
                    questionNumber: 1,
                    correctOptionIds: ["A", "B"],
                    verificationStatus: "verified"
                }
            ];
            const profile = {
                profileId: "custom_override_exam",
                msqNegativeMarking: false, // Exam says MSQ has 0 penalty
                sections: [
                    {
                        id: "sec_1",
                        msqNegativeMarking: false // Section says MSQ has 0 penalty
                    }
                ]
            };

            // Student answers wrong option "C"
            const res = UniversalScoringEngine.score(questions, answerKeys, { q_override_penalty: "C" }, profile);
            assert.strictEqual(res.totalScore, -1.5, "Explicit question-level penalty of 1.5 must be applied, ignoring MSQ type defaults");
        });

        test("2.2 Level 2 (Section-level configuration) takes priority over Exam-level defaults", () => {
            const questions = [
                {
                    questionId: "q_sec_override",
                    questionNumber: 1,
                    sectionId: "sec_special",
                    questionType: "mcq",
                    marksAwarded: 2
                }
            ];
            const answerKeys = [
                {
                    questionId: "q_sec_override",
                    questionNumber: 1,
                    correctOptionIds: ["A"],
                    verificationStatus: "verified"
                }
            ];
            const profile = {
                profileId: "exam_level_scheme",
                markingScheme: { correct: 2, incorrect: 0.25 }, // Exam says 0.25 penalty
                sections: [
                    {
                        id: "sec_special",
                        markingScheme: { correct: 2, incorrect: 0.75 } // Section overrides to 0.75 penalty
                    }
                ]
            };

            const res = UniversalScoringEngine.score(questions, answerKeys, { q_sec_override: "B" }, profile);
            assert.strictEqual(res.totalScore, -0.75, "Section-level penalty of 0.75 must override exam-level default 0.25");
        });

        test("2.3 Level 3 (Exam-level configuration) applies when question and section do not override", () => {
            const questions = [
                {
                    questionId: "q_exam_default",
                    questionNumber: 1,
                    sectionId: "sec_default",
                    questionType: "mcq",
                    marksAwarded: 1
                }
            ];
            const answerKeys = [
                {
                    questionId: "q_exam_default",
                    questionNumber: 1,
                    correctOptionIds: ["A"],
                    verificationStatus: "verified"
                }
            ];
            const profile = {
                profileId: "exam_default_scheme",
                markingScheme: { correct: 1, incorrect: 0.25 },
                sections: [
                    {
                        id: "sec_default"
                    }
                ]
            };

            const res = UniversalScoringEngine.score(questions, answerKeys, { q_exam_default: "B" }, profile);
            assert.strictEqual(res.totalScore, -0.25, "Exam-level default penalty must apply");
        });

        test("2.4 Level 4 (Fail-Closed) blocks scoring for unverified profiles without approval", () => {
            const questions = [{ questionId: "q_unv", questionNumber: 1, examId: "unknown-rogue-exam" }];
            const answerKeys = [{ questionId: "q_unv", questionNumber: 1, correctOptionIds: ["A"] }];

            assert.throws(() => {
                UniversalScoringEngine.score(questions, answerKeys, {}, null);
            }, /UNVERIFIED_EXAM_SCORING_REJECTED/);
        });

        test("2.5 Official GATE 2026 CS1 rules preserved: MCQ 1-mark = -1/3, 2-mark = -2/3, MSQ = 0, NAT = 0", () => {
            const questions = [
                { questionId: "q_mcq_1", questionNumber: 1, sectionId: "sec_tech", questionType: "mcq", marksAwarded: 1 },
                { questionId: "q_mcq_2", questionNumber: 2, sectionId: "sec_tech", questionType: "mcq", marksAwarded: 2 },
                { questionId: "q_msq", questionNumber: 3, sectionId: "sec_tech", questionType: "msq", marksAwarded: 2 },
                { questionId: "q_nat", questionNumber: 4, sectionId: "sec_tech", questionType: "nat", marksAwarded: 2 }
            ];
            const answerKeys = [
                { questionId: "q_mcq_1", questionNumber: 1, correctOptionIds: ["A"], verificationStatus: "verified" },
                { questionId: "q_mcq_2", questionNumber: 2, correctOptionIds: ["A"], verificationStatus: "verified" },
                { questionId: "q_msq", questionNumber: 3, correctOptionIds: ["A", "B"], verificationStatus: "verified" },
                { questionId: "q_nat", questionNumber: 4, numericValue: 42, verificationStatus: "verified" }
            ];
            const profile = {
                profileId: "gate-2026-cs1",
                examName: "GATE 2026 Computer Science",
                msqNegativeMarking: false,
                numericalNegativeMarking: false,
                sections: [
                    {
                        id: "sec_tech",
                        sectionId: "sec_tech",
                        name: "Technical"
                    }
                ]
            };

            // Student answers all 4 questions incorrectly
            const wrongAnswers = {
                q_mcq_1: "B",
                q_mcq_2: "B",
                q_msq: ["C"],
                q_nat: "99"
            };

            const res = UniversalScoringEngine.score(questions, answerKeys, wrongAnswers, profile);
            const breakdown = res.breakdown;
            const bMcq1 = breakdown.find(b => b.questionId === "q_mcq_1");
            const bMcq2 = breakdown.find(b => b.questionId === "q_mcq_2");
            const bMsq = breakdown.find(b => b.questionId === "q_msq");
            const bNat = breakdown.find(b => b.questionId === "q_nat");

            // GATE rules: 1-mark MCQ deduction = -0.333, 2-mark MCQ deduction = -0.667, MSQ = 0, NAT = 0
            assert.strictEqual(bMcq1.marksAwarded, -0.333, "1-mark MCQ penalty must be -1/3 (-0.333)");
            assert.strictEqual(bMcq2.marksAwarded, -0.667, "2-mark MCQ penalty must be -2/3 (-0.667)");
            assert.strictEqual(bMsq.marksAwarded, 0, "MSQ penalty must be exactly 0");
            assert.strictEqual(bNat.marksAwarded, 0, "NAT penalty must be exactly 0");
            assert.strictEqual(res.totalScore, -1, "Total score = -1/3 + -2/3 + 0 + 0 = -1");
        });
    });

    // =========================================================================
    // 3. Verify Section & Overall Score Reconciliation (GATE 2026 CS1)
    // =========================================================================
    describe("3. Section & Overall Score Reconciliation for GATE 2026 CS1", () => {
        let uirDocument;
        let firestoreDocs;

        test("3.1 Ingest GATE 2026 CS1 and generate canonical UIR v3.0", async () => {
            const qpBuf = fs.readFileSync(gateQpPath);
            const akBuf = fs.readFileSync(gateAkPath);
            const pfBuf = fs.readFileSync(gatePatternPath);

            const result = await UIRTransformationService.transformDocuments(
                { questionPaper: qpBuf, answerKey: akBuf, paperFormat: pfBuf },
                { examId: "gate-2026-cs1", year: 2026 }
            );

            uirDocument = result.uirDocument;
            assert.ok(uirDocument, "UIR document must be created");
            assert.strictEqual(uirDocument.questions.length, 65, "Total questions must be 65");
            assert.strictEqual(uirDocument.examMetadata.maximumMarks, 100, "Exam metadata max marks must be 100");

            firestoreDocs = UIRToMockTestAdapter.toFirestoreDocuments(uirDocument);
            assert.strictEqual(firestoreDocs.mockQuestionDocs.length, 65, "Firestore question docs must be 65");
        });

        test("3.2 Section Maximum Marks Reconciliation: GA=15, Technical=85, Total=100", () => {
            const gaSec = uirDocument.sections.find(s => s.sectionId === "sec_general_aptitude");
            const techSec = uirDocument.sections.find(s => s.sectionId === "sec_technical_engg_maths_cs");

            assert.strictEqual(gaSec.maximumMarks, 15, "GA maximum marks must be 15");
            assert.strictEqual(gaSec.questionCount, 10, "GA question count must be 10");
            assert.strictEqual(techSec.maximumMarks, 85, "Technical maximum marks must be 85");
            assert.strictEqual(techSec.questionCount, 55, "Technical question count must be 55");

            assert.strictEqual(gaSec.maximumMarks + techSec.maximumMarks, 100, "Sum of section maximum marks must equal 100");
            assert.strictEqual(gaSec.questionCount + techSec.questionCount, 65, "Sum of section questions must equal 65");
        });

        test("3.3 Controlled Attempt 1: All questions unanswered", () => {
            const emptyAnswers = {};
            const res = UniversalScoringEngine.evaluateAttempt({
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: emptyAnswers,
                examProfile: firestoreDocs.mockTestDoc,
                options: { allowUnverified: true }
            });

            assert.strictEqual(res.totalScore, 0, "Score must be 0 for zero attempts");
            assert.strictEqual(res.maximumMarks, 100, "Total maximum marks must be 100");
            assert.strictEqual(res.percentageScore, 0, "Percentage must be 0%");
            assert.strictEqual(res.accuracyPercent, 0, "Accuracy must be 0% when attempted=0");

            const gaAnalysis = res.sectionAnalysis["sec_general_aptitude"];
            const techAnalysis = res.sectionAnalysis["sec_technical_engg_maths_cs"];

            assert.strictEqual(gaAnalysis.maximumMarks, 15, "GA maximumMarks must be 15");
            assert.strictEqual(techAnalysis.maximumMarks, 85, "Technical maximumMarks must be 85");
            assert.strictEqual(gaAnalysis.score, 0, "GA score must be 0");
            assert.strictEqual(techAnalysis.score, 0, "Technical score must be 0");

            // Sum of section scores equals total score
            assert.strictEqual(gaAnalysis.score + techAnalysis.score, res.totalScore);
        });

        test("3.4 Controlled Attempt 2: Mixture of correct and incorrect answers", () => {
            // Attempt 2 GA questions: Q1 (1-mark, correct), Q2 (1-mark, incorrect)
            // Attempt 2 Tech questions: Q11 (1-mark, correct), Q36 (2-mark, correct)
            const mixedAnswers = {
                [firestoreDocs.mockQuestionDocs[0].questionId]: "B", // Q1 correct -> +1
                [firestoreDocs.mockQuestionDocs[1].questionId]: "D", // Q2 incorrect -> -1/3 (-0.333)
                [firestoreDocs.mockQuestionDocs[10].questionId]: "B", // Q11 correct -> +1
                [firestoreDocs.mockQuestionDocs[35].questionId]: "C"  // Q36 correct -> +2
            };

            const res = UniversalScoringEngine.evaluateAttempt({
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: mixedAnswers,
                examProfile: firestoreDocs.mockTestDoc,
                options: { allowUnverified: true }
            });

            assert.strictEqual(res.maximumMarks, 100, "Maximum marks must remain 100");
            assert.strictEqual(res.totalQuestions, 65, "Total questions must remain 65");
            assert.strictEqual(res.attemptedCount, 4, "Attempted count must be 4");
            assert.strictEqual(res.correctCount, 3, "Correct count must be 3");
            assert.strictEqual(res.incorrectCount, 1, "Incorrect count must be 1");

            // GA score: +1 - 1/3 = +0.667
            const ga = res.sectionAnalysis["sec_general_aptitude"];
            assert.strictEqual(ga.maximumMarks, 15, "GA maximum marks must remain 15");
            assert.strictEqual(ga.score, 0.667, "GA score must be 0.667");
            assert.strictEqual(ga.attemptedCount, 2, "GA attempted must be 2");
            assert.strictEqual(ga.accuracy, 50, "GA accuracy must be 50%");

            // Tech score: +1 + 2 = 3
            const tech = res.sectionAnalysis["sec_technical_engg_maths_cs"];
            assert.strictEqual(tech.maximumMarks, 85, "Technical maximum marks must remain 85");
            assert.strictEqual(tech.score, 3, "Technical score must be 3");
            assert.strictEqual(tech.attemptedCount, 2, "Technical attempted must be 2");
            assert.strictEqual(tech.accuracy, 100, "Technical accuracy must be 100%");

            // Sum of section scores equals total score
            assert.strictEqual(Number((ga.score + tech.score).toFixed(3)), res.totalScore);

            // Accuracy uses attempted questions: 3 / 4 * 100 = 75%
            assert.strictEqual(res.accuracyPercent, 75, "Overall accuracy must be 75%");

            // Score percentage uses maximum marks: 3.667 / 100 * 100 = 3.67%
            assert.strictEqual(res.percentageScore, 3.67, "Percentage score must use maximumMarks (100)");
        });

        test("3.5 Controlled Attempt 3: All 65 questions answered correctly -> Score = 100 / 100", () => {
            const allCorrect = {};
            for (let i = 0; i < firestoreDocs.mockQuestionDocs.length; i++) {
                const q = firestoreDocs.mockQuestionDocs[i];
                const ak = firestoreDocs.mockAnswerKeyDocs.find(k => k.questionId === q.questionId);
                if (ak) {
                    if (ak.numericValue !== undefined && ak.numericValue !== null) {
                        allCorrect[q.questionId] = String(ak.numericValue);
                    } else if (Array.isArray(ak.correctOptionIds) && ak.correctOptionIds.length > 0) {
                        allCorrect[q.questionId] = ak.correctOptionIds;
                    } else if (Array.isArray(ak.acceptedAnswers) && ak.acceptedAnswers.length > 0) {
                        allCorrect[q.questionId] = ak.acceptedAnswers[0];
                    }
                }
            }

            const res = UniversalScoringEngine.evaluateAttempt({
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: allCorrect,
                examProfile: firestoreDocs.mockTestDoc,
                options: { allowUnverified: true }
            });

            assert.strictEqual(res.totalScore, 100, "Perfect score must be exactly 100");
            assert.strictEqual(res.maximumMarks, 100, "Maximum marks must be 100");
            assert.strictEqual(res.percentageScore, 100, "Percentage score must be 100%");
            assert.strictEqual(res.accuracyPercent, 100, "Accuracy must be 100%");
            assert.strictEqual(res.correctCount, 65, "All 65 questions must be correct");

            const ga = res.sectionAnalysis["sec_general_aptitude"];
            const tech = res.sectionAnalysis["sec_technical_engg_maths_cs"];

            assert.strictEqual(ga.score, 15, "GA score must be exactly 15");
            assert.strictEqual(ga.maximumMarks, 15, "GA maximum marks must be 15");
            assert.strictEqual(tech.score, 85, "Technical score must be exactly 85");
            assert.strictEqual(tech.maximumMarks, 85, "Technical maximum marks must be 85");

            assert.strictEqual(ga.score + tech.score, res.totalScore);
        });

        test("3.6 Score Percentage and Accuracy Metric Formulation Invariants", () => {
            // Check that score percentage formula is score / maximumPossibleMarks * 100
            // and accuracy formula is correctCount / attemptedCount * 100
            const sampleAnswers = {
                [firestoreDocs.mockQuestionDocs[0].questionId]: "B", // Q1 correct (1 mark)
                [firestoreDocs.mockQuestionDocs[1].questionId]: "D"  // Q2 incorrect (-1/3 mark)
            };

            const res = UniversalScoringEngine.evaluateAttempt({
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: sampleAnswers,
                examProfile: firestoreDocs.mockTestDoc,
                options: { allowUnverified: true }
            });

            // Attempted = 2, Correct = 1. Accuracy = (1 / 2) * 100 = 50.00%
            assert.strictEqual(res.accuracyPercent, 50.00, "Accuracy must use attempted count: 1 / 2 = 50%");
            
            // Score = 0.667. Max marks = 100. Percentage score = (0.667 / 100) * 100 = 0.67%
            assert.strictEqual(res.percentageScore, 0.67, "Score percentage must use max marks: 0.667 / 100 = 0.67%");
        });
    });

    // =========================================================================
    // 4. Actual Application Runtime Verification
    // =========================================================================
    describe("4. Actual Application Runtime Verification", () => {
        let uirDocument;
        let firestoreDocs;

        test("4.1 Setup runtime environment from ingested GATE 2026 CS1 test", async () => {
            const qpBuf = fs.readFileSync(gateQpPath);
            const akBuf = fs.readFileSync(gateAkPath);
            const pfBuf = fs.readFileSync(gatePatternPath);

            const result = await UIRTransformationService.transformDocuments(
                { questionPaper: qpBuf, answerKey: akBuf, paperFormat: pfBuf },
                { examId: "gate-2026-cs1", year: 2026 }
            );
            uirDocument = result.uirDocument;
            firestoreDocs = UIRToMockTestAdapter.toFirestoreDocuments(uirDocument);
        });

        test("4.2 Controlled Attempt 1 (Unanswered): Section and overall denominators are 15, 85, 100", async () => {
            const result = await MockTestScoringService.evaluateSubmission({
                testId: "test_gate_runtime_1",
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: {},
                examConfig: firestoreDocs.mockTestDoc
            });

            assert.strictEqual(result.maximumMarks, 100, "Overall maximum marks must be 100");
            assert.strictEqual(result.totalQuestions, 65, "Total questions must be 65");
            assert.strictEqual(result.totalScore, 0, "Score must be 0");

            const gaSec = result.sectionAnalysis["sec_general_aptitude"];
            const techSec = result.sectionAnalysis["sec_technical_engg_maths_cs"];

            assert.strictEqual(gaSec.maximumMarks, 15, "GA maximum marks must be 15");
            assert.strictEqual(techSec.maximumMarks, 85, "Technical maximum marks must be 85");
            assert.notStrictEqual(gaSec.maximumMarks, 65, "GA maximum marks must NEVER be 65");
            assert.notStrictEqual(techSec.maximumMarks, 65, "Technical maximum marks must NEVER be 65");
        });

        test("4.3 Controlled Attempt 2 (Mixed): Section and overall denominators remain strictly 15, 85, 100", async () => {
            const mixedAnswers = {
                [firestoreDocs.mockQuestionDocs[0].questionId]: "B", // Q1 correct (1 mark)
                [firestoreDocs.mockQuestionDocs[5].questionId]: "B", // Q6 correct (2 marks)
                [firestoreDocs.mockQuestionDocs[10].questionId]: "B", // Q11 correct (1 mark)
                [firestoreDocs.mockQuestionDocs[35].questionId]: "C"  // Q36 correct (2 marks)
            };

            const result = await MockTestScoringService.evaluateSubmission({
                testId: "test_gate_runtime_2",
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: mixedAnswers,
                examConfig: firestoreDocs.mockTestDoc
            });

            assert.strictEqual(result.maximumMarks, 100, "Overall maximum marks must be 100");
            assert.strictEqual(result.totalScore, 6, "Total score must be 6");

            const gaSec = result.sectionAnalysis["sec_general_aptitude"];
            const techSec = result.sectionAnalysis["sec_technical_engg_maths_cs"];

            assert.strictEqual(gaSec.maximumMarks, 15, "GA maximum marks must be 15");
            assert.strictEqual(techSec.maximumMarks, 85, "Technical maximum marks must be 85");
            assert.strictEqual(gaSec.score, 3, "GA score must be 3");
            assert.strictEqual(techSec.score, 3, "Technical score must be 3");
        });

        test("4.4 Controlled Attempt 3 (All Answered): Denominators remain strictly consistent", async () => {
            const allCorrect = {};
            for (let i = 0; i < firestoreDocs.mockQuestionDocs.length; i++) {
                const q = firestoreDocs.mockQuestionDocs[i];
                const ak = firestoreDocs.mockAnswerKeyDocs.find(k => k.questionId === q.questionId);
                if (ak) {
                    if (ak.numericValue !== undefined && ak.numericValue !== null) {
                        allCorrect[q.questionId] = String(ak.numericValue);
                    } else if (Array.isArray(ak.correctOptionIds) && ak.correctOptionIds.length > 0) {
                        allCorrect[q.questionId] = ak.correctOptionIds;
                    } else if (Array.isArray(ak.acceptedAnswers) && ak.acceptedAnswers.length > 0) {
                        allCorrect[q.questionId] = ak.acceptedAnswers[0];
                    }
                }
            }

            const result = await MockTestScoringService.evaluateSubmission({
                testId: "test_gate_runtime_3",
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: allCorrect,
                examConfig: firestoreDocs.mockTestDoc
            });

            assert.strictEqual(result.maximumMarks, 100, "Overall maximum marks must be 100");
            assert.strictEqual(result.totalScore, 100, "Total score must be 100");

            const gaSec = result.sectionAnalysis["sec_general_aptitude"];
            const techSec = result.sectionAnalysis["sec_technical_engg_maths_cs"];

            assert.strictEqual(gaSec.maximumMarks, 15, "GA maximum marks must be 15");
            assert.strictEqual(techSec.maximumMarks, 85, "Technical maximum marks must be 85");
        });

        test("4.5 Idempotence / Refresh Verification: Re-evaluating or retrieving yields identical denominators", async () => {
            const runA = await MockTestScoringService.evaluateSubmission({
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: { [firestoreDocs.mockQuestionDocs[0].questionId]: "B" },
                examConfig: firestoreDocs.mockTestDoc
            });
            const runB = await MockTestScoringService.evaluateSubmission({
                questions: firestoreDocs.mockQuestionDocs,
                answerKeys: firestoreDocs.mockAnswerKeyDocs,
                studentAnswers: { [firestoreDocs.mockQuestionDocs[0].questionId]: "B" },
                examConfig: firestoreDocs.mockTestDoc
            });

            assert.deepStrictEqual(runA.sectionAnalysis, runB.sectionAnalysis, "Section analysis must be completely idempotent");
            assert.strictEqual(runA.maximumMarks, runB.maximumMarks, "Overall maximum marks must be completely idempotent");
        });
    });

    // =========================================================================
    // 5. Cross-Examination Regression Suite
    // =========================================================================
    describe("5. Cross-Examination Regression Suite", () => {
        test("5.1 SSC CGL Tier-I: 100 Qs, 200 Marks, 4 sections of 50 Marks, 0.5 negative penalty", () => {
            const questions = [];
            const answerKeys = [];
            for (let i = 1; i <= 100; i++) {
                const secNum = Math.ceil(i / 25);
                const qId = `ssc_q_${i}`;
                questions.push({
                    questionId: qId,
                    questionNumber: i,
                    sectionId: `sec_${secNum}`,
                    subject: `Subject ${secNum}`,
                    questionType: "mcq",
                    marksAwarded: 2,
                    marksDeducted: 0.5
                });
                answerKeys.push({
                    questionId: qId,
                    questionNumber: i,
                    sectionId: `sec_${secNum}`,
                    correctOptionIds: ["A"],
                    marksAwarded: 2,
                    marksDeducted: 0.5,
                    verificationStatus: "verified"
                });
            }

            const profile = {
                profileId: "ssc-cgl-tier1",
                examId: "ssc-cgl",
                verificationStatus: "official_verified",
                maximumMarks: 200,
                markingScheme: { correct: 2, incorrect: 0.5 },
                sections: [1, 2, 3, 4].map(s => ({
                    id: `sec_${s}`,
                    sectionId: `sec_${s}`,
                    name: `Section ${s}`,
                    subject: `Subject ${s}`,
                    startQuestion: (s - 1) * 25 + 1,
                    endQuestion: s * 25,
                    questionCount: 25,
                    maximumMarks: 50
                }))
            };

            // Answer 1 question in section 1 incorrectly
            const res = UniversalScoringEngine.score(questions, answerKeys, { ssc_q_1: "B" }, profile);
            assert.strictEqual(res.maximumMarks, 200, "SSC CGL maximum marks must be 200");
            assert.strictEqual(res.totalScore, -0.5, "Negative penalty must be -0.5");
            for (let s = 1; s <= 4; s++) {
                assert.strictEqual(res.sectionAnalysis[`sec_${s}`].maximumMarks, 50, `SSC section ${s} max marks must be 50`);
            }
        });

        test("5.2 NEET UG: 180 Qs, 720 Marks, 4 subjects of 180 Marks, 1.0 negative penalty", () => {
            const questions = [];
            const answerKeys = [];
            const subjects = ["Physics", "Chemistry", "Botany", "Zoology"];
            for (let i = 1; i <= 180; i++) {
                const subIdx = Math.floor((i - 1) / 45);
                const qId = `neet_q_${i}`;
                questions.push({
                    questionId: qId,
                    questionNumber: i,
                    sectionId: `sec_${subIdx + 1}`,
                    subject: subjects[subIdx],
                    questionType: "mcq",
                    marksAwarded: 4,
                    marksDeducted: 1
                });
                answerKeys.push({
                    questionId: qId,
                    questionNumber: i,
                    sectionId: `sec_${subIdx + 1}`,
                    correctOptionIds: ["A"],
                    marksAwarded: 4,
                    marksDeducted: 1,
                    verificationStatus: "verified"
                });
            }

            const profile = {
                profileId: "neet-ug-standard",
                examId: "neet-ug",
                verificationStatus: "official_verified",
                maximumMarks: 720,
                markingScheme: { correct: 4, incorrect: 1 },
                sections: subjects.map((sub, idx) => ({
                    id: `sec_${idx + 1}`,
                    sectionId: `sec_${idx + 1}`,
                    name: sub,
                    subject: sub,
                    startQuestion: idx * 45 + 1,
                    endQuestion: (idx + 1) * 45,
                    questionCount: 45,
                    maximumMarks: 180
                }))
            };

            const res = UniversalScoringEngine.score(questions, answerKeys, { neet_q_1: "A", neet_q_2: "B" }, profile);
            assert.strictEqual(res.maximumMarks, 720, "NEET maximum marks must be 720");
            assert.strictEqual(res.totalScore, 3, "NEET score: +4 - 1 = 3");
            for (let s = 1; s <= 4; s++) {
                assert.strictEqual(res.sectionAnalysis[`sec_${s}`].maximumMarks, 180, `NEET section ${s} max marks must be 180`);
            }
        });

        test("5.3 JEE Main: Question type defaults do NOT override explicit numerical negative marking", () => {
            // In JEE Main (NTA), numerical questions DO carry negative marking (-1)
            const questions = [
                {
                    questionId: "jee_q_1",
                    questionNumber: 1,
                    sectionId: "sec_math",
                    questionType: "nat",
                    marksAwarded: 4,
                    marksDeducted: 1 // Explicitly has negative marking!
                }
            ];
            const answerKeys = [
                {
                    questionId: "jee_q_1",
                    questionNumber: 1,
                    numericValue: 10,
                    marksAwarded: 4,
                    marksDeducted: 1,
                    verificationStatus: "verified"
                }
            ];
            const profile = {
                profileId: "jee-main-nta",
                examId: "jee-main",
                verificationStatus: "official_verified",
                markingScheme: { correct: 4, incorrect: 1 },
                sections: [{ id: "sec_math", name: "Mathematics", maximumMarks: 100 }]
            };

            const res = UniversalScoringEngine.score(questions, answerKeys, { jee_q_1: "99" }, profile);
            // Must incur -1 penalty because JEE Main explicit rule defines negative deduction for NAT!
            assert.strictEqual(res.totalScore, -1, "JEE Main NAT question must incur negative marking penalty (-1)");
        });

        test("5.4 UPSC Prelims: 100 Qs, 200 Marks, 1/3 deduction (-0.667)", () => {
            const questions = [
                { questionId: "upsc_q_1", questionNumber: 1, sectionId: "sec_gs", marksAwarded: 2, marksDeducted: 2 / 3 }
            ];
            const answerKeys = [
                { questionId: "upsc_q_1", questionNumber: 1, correctOptionIds: ["A"], verificationStatus: "verified" }
            ];
            const profile = {
                profileId: "upsc-prelims-gs1",
                examId: "upsc-prelims",
                verificationStatus: "official_verified",
                markingScheme: { correct: 2, incorrect: 2 / 3 },
                sections: [{ id: "sec_gs", name: "General Studies", maximumMarks: 200 }]
            };

            const res = UniversalScoringEngine.score(questions, answerKeys, { upsc_q_1: "B" }, profile);
            assert.strictEqual(res.totalScore, -0.667, "UPSC negative deduction must be -2/3 (-0.667)");
        });

        test("5.5 BPSC 69th Prelims: 150 Qs, 150 Marks, 1/3 deduction (-0.333)", () => {
            const questions = [
                { questionId: "bpsc_q_1", questionNumber: 1, sectionId: "sec_bpsc", marksAwarded: 1, marksDeducted: 1 / 3 }
            ];
            const answerKeys = [
                { questionId: "bpsc_q_1", questionNumber: 1, correctOptionIds: ["A"], verificationStatus: "verified" }
            ];
            const profile = {
                profileId: "bpsc-69th-prelims",
                examId: "bpsc-prelims",
                verificationStatus: "official_verified",
                markingScheme: { correct: 1, incorrect: 1 / 3 },
                sections: [{ id: "sec_bpsc", name: "General Studies", maximumMarks: 150 }]
            };

            const res = UniversalScoringEngine.score(questions, answerKeys, { bpsc_q_1: "B" }, profile);
            assert.strictEqual(res.totalScore, -0.333, "BPSC negative deduction must be -1/3 (-0.333)");
        });
    });
});

