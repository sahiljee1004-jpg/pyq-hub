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

describe("Phase 5.6 — Universal Maximum Marks & Score Aggregation Consistency Suite", () => {
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
    // Test A: Target Examination GATE 2026 CS1 (End-to-End Ingestion + Scoring)
    // =========================================================================
    test("A. Target Examination GATE 2026 CS1: Reconciles 65 questions, 100 max marks, GA=15, Technical=85", async () => {
        assert.ok(gateQpPath && fs.existsSync(gateQpPath), "GATE QP must exist");
        assert.ok(gateAkPath && fs.existsSync(gateAkPath), "GATE AK must exist");
        assert.ok(gatePatternPath && fs.existsSync(gatePatternPath), "GATE Pattern must exist");

        const qpBuf = fs.readFileSync(gateQpPath);
        const akBuf = fs.readFileSync(gateAkPath);
        const pfBuf = fs.readFileSync(gatePatternPath);

        const { uirDocument } = await UIRTransformationService.transformDocuments(
            { questionPaper: qpBuf, answerKey: akBuf, paperFormat: pfBuf },
            { examId: "gate-2026-cs1", year: 2026 }
        );

        assert.ok(uirDocument, "UIR Document must be generated");
        assert.strictEqual(uirDocument.questions.length, 65, "Total questions must be exactly 65");
        assert.strictEqual(uirDocument.examMetadata.maximumMarks, 100, "Overall maximum marks must be 100");

        // Verify sections in UIR
        assert.strictEqual(uirDocument.sections.length, 2, "Must extract exactly 2 sections (GA and Technical)");
        const gaSec = uirDocument.sections.find(s => s.sectionId === "sec_general_aptitude");
        const techSec = uirDocument.sections.find(s => s.sectionId === "sec_technical_engg_maths_cs");

        assert.ok(gaSec, "General Aptitude section must exist");
        assert.ok(techSec, "Technical section must exist");

        assert.strictEqual(gaSec.questionCount, 10, "General Aptitude must contain 10 questions");
        assert.strictEqual(gaSec.maximumMarks, 15, "General Aptitude maximum marks must be 15");

        assert.strictEqual(techSec.questionCount, 55, "Technical section must contain 55 questions");
        assert.strictEqual(techSec.maximumMarks, 85, "Technical section maximum marks must be 85");

        // Verify Question-level weightage
        const q1 = uirDocument.questions.find(q => q.questionNumber === 1);
        const q6 = uirDocument.questions.find(q => q.questionNumber === 6);
        const q11 = uirDocument.questions.find(q => q.questionNumber === 11);
        const q36 = uirDocument.questions.find(q => q.questionNumber === 36);

        assert.strictEqual(q1.scoring.positiveMarks, 1, "Q1 must carry 1 mark");
        assert.strictEqual(q6.scoring.positiveMarks, 2, "Q6 must carry 2 marks");
        assert.strictEqual(q11.scoring.positiveMarks, 1, "Q11 must carry 1 mark");
        assert.strictEqual(q36.scoring.positiveMarks, 2, "Q36 must carry 2 marks");

        // Convert to Firestore representation and score via UniversalScoringEngine
        const { mockTestDoc, mockQuestionDocs, mockAnswerKeyDocs } = UIRToMockTestAdapter.toFirestoreDocuments(uirDocument);

        // Candidate answers Q1 correctly (+1), Q6 correctly (+2), Q11 correctly (+1), Q36 correctly (+2)
        const studentAnswers = {
            [mockQuestionDocs[0].questionId]: "B", // Q1 correct (1 mark)
            [mockQuestionDocs[5].questionId]: "B", // Q6 correct (2 marks)
            [mockQuestionDocs[10].questionId]: "B", // Q11 correct (1 mark)
            [mockQuestionDocs[35].questionId]: "C"  // Q36 correct (2 marks)
        };

        const scoreResult = UniversalScoringEngine.evaluateAttempt({
            questions: mockQuestionDocs,
            studentAnswers,
            answerKeys: mockAnswerKeyDocs,
            examProfile: mockTestDoc,
            options: { allowUnverified: true }
        });

        assert.strictEqual(scoreResult.totalQuestions, 65, "Scoring total questions must be 65");
        assert.strictEqual(scoreResult.maximumMarks, 100, "Scoring overall maximum marks must be 100");
        assert.strictEqual(scoreResult.totalScore, 6, "Total score for 1+2+1+2 must be 6");

        // Section analysis checks: NO denominator must be 65!
        const secGA = scoreResult.sectionAnalysis["sec_general_aptitude"];
        const secTech = scoreResult.sectionAnalysis["sec_technical_engg_maths_cs"];

        assert.ok(secGA, "sec_general_aptitude must be in sectionAnalysis");
        assert.ok(secTech, "sec_technical_engg_maths_cs must be in sectionAnalysis");

        assert.strictEqual(secGA.maximumMarks, 15, "GA maximum marks must be 15, NOT 65 or 10");
        assert.strictEqual(secGA.totalQuestions, 10, "GA total questions must be 10");
        assert.strictEqual(secGA.score, 3, "GA score must be 3 (1+2)");

        assert.strictEqual(secTech.maximumMarks, 85, "Technical maximum marks must be 85, NOT 65 or 55");
        assert.strictEqual(secTech.totalQuestions, 55, "Technical total questions must be 55");
        assert.strictEqual(secTech.score, 3, "Technical score must be 3 (1+2)");

        // Total of section maximum marks must equal overall maximum marks
        assert.strictEqual(secGA.maximumMarks + secTech.maximumMarks, 100, "Sum of section maximum marks must equal 100");
    });

    // =========================================================================
    // Test B: Regression Control — SSC CGL Tier-I
    // =========================================================================
    test("B. Regression Control SSC CGL Tier-I: 100 questions, 200 marks, 4 sections of 50 marks each", () => {
        const sscConfig = {
            examId: "ssc-cgl-tier1",
            totalQuestions: 100,
            maximumMarks: 200,
            sections: [
                { id: "sec_gi", name: "General Intelligence and Reasoning", questionCount: 25, maximumMarks: 50, markingScheme: { correct: 2, incorrect: 0.5 } },
                { id: "sec_ga", name: "General Awareness", questionCount: 25, maximumMarks: 50, markingScheme: { correct: 2, incorrect: 0.5 } },
                { id: "sec_qa", name: "Quantitative Aptitude", questionCount: 25, maximumMarks: 50, markingScheme: { correct: 2, incorrect: 0.5 } },
                { id: "sec_en", name: "English Comprehension", questionCount: 25, maximumMarks: 50, markingScheme: { correct: 2, incorrect: 0.5 } }
            ]
        };

        const questions = [];
        const answerKeys = [];
        const studentAnswers = {};

        for (let i = 1; i <= 100; i++) {
            const secId = i <= 25 ? "sec_gi" : i <= 50 ? "sec_ga" : i <= 75 ? "sec_qa" : "sec_en";
            const qId = `ssc_q_${i}`;
            questions.push({ questionId: qId, questionNumber: i, sectionId: secId, marksAwarded: 2, marksDeducted: 0.5 });
            answerKeys.push({ questionId: qId, questionNumber: i, sectionId: secId, acceptedAnswers: ["A"], marksAwarded: 2, marksDeducted: 0.5 });
        }

        // Candidate answers 10 questions in sec_gi correctly
        for (let i = 1; i <= 10; i++) studentAnswers[`ssc_q_${i}`] = "A";

        const scoreResult = UniversalScoringEngine.evaluateAttempt({
            questions,
            studentAnswers,
            answerKeys,
            examProfile: sscConfig,
            options: { allowUnverified: true }
        });

        assert.strictEqual(scoreResult.totalQuestions, 100);
        assert.strictEqual(scoreResult.maximumMarks, 200);
        assert.strictEqual(scoreResult.totalScore, 20);

        // Verify each section denominator is exactly 50
        for (const sec of sscConfig.sections) {
            const secData = scoreResult.sectionAnalysis[sec.id];
            assert.ok(secData, `Section ${sec.id} must be analyzed`);
            assert.strictEqual(secData.maximumMarks, 50, `Section ${sec.id} maximum marks must be 50, NOT 25`);
            assert.strictEqual(secData.totalQuestions, 25);
        }
    });

    // =========================================================================
    // Test C: Regression Control — NEET UG
    // =========================================================================
    test("C. Regression Control NEET UG: 180 questions, 720 marks, 4 subjects of 180 marks each", () => {
        const neetConfig = {
            examId: "neet-ug",
            totalQuestions: 180,
            maximumMarks: 720,
            sections: [
                { id: "sec_phy", name: "Physics", subject: "Physics", questionCount: 45, maximumMarks: 180, markingScheme: { correct: 4, incorrect: 1 } },
                { id: "sec_chem", name: "Chemistry", subject: "Chemistry", questionCount: 45, maximumMarks: 180, markingScheme: { correct: 4, incorrect: 1 } },
                { id: "sec_bot", name: "Botany", subject: "Biology", questionCount: 45, maximumMarks: 180, markingScheme: { correct: 4, incorrect: 1 } },
                { id: "sec_zoo", name: "Zoology", subject: "Biology", questionCount: 45, maximumMarks: 180, markingScheme: { correct: 4, incorrect: 1 } }
            ]
        };

        const questions = [];
        const answerKeys = [];
        for (let i = 1; i <= 180; i++) {
            const secId = i <= 45 ? "sec_phy" : i <= 90 ? "sec_chem" : i <= 135 ? "sec_bot" : "sec_zoo";
            const qId = `neet_q_${i}`;
            questions.push({ questionId: qId, questionNumber: i, sectionId: secId, marksAwarded: 4, marksDeducted: 1 });
            answerKeys.push({ questionId: qId, questionNumber: i, sectionId: secId, acceptedAnswers: ["B"], marksAwarded: 4, marksDeducted: 1 });
        }

        const scoreResult = UniversalScoringEngine.evaluateAttempt({
            questions,
            studentAnswers: { neet_q_1: "B", neet_q_2: "C" }, // Q1 correct (+4), Q2 wrong (-1)
            answerKeys,
            examProfile: neetConfig,
            options: { allowUnverified: true }
        });

        assert.strictEqual(scoreResult.totalQuestions, 180);
        assert.strictEqual(scoreResult.maximumMarks, 720);
        assert.strictEqual(scoreResult.totalScore, 3); // 4 - 1 = 3

        for (const sec of neetConfig.sections) {
            const secData = scoreResult.sectionAnalysis[sec.id];
            assert.strictEqual(secData.maximumMarks, 180, `Section ${sec.id} maximum marks must be 180, NOT 45`);
            assert.strictEqual(secData.totalQuestions, 45);
        }
    });

    // =========================================================================
    // Test D: Standard Exam with 1 Mark per Question (Equal Q count and marks)
    // =========================================================================
    test("D. Equal Question & Marks: 50 Qs, 50 Marks total, 2 sections of 25 marks", () => {
        const config = {
            examId: "equal-marks-exam",
            totalQuestions: 50,
            maximumMarks: 50,
            sections: [
                { id: "sec_1", name: "Part 1", questionCount: 25, markingScheme: { correct: 1, incorrect: 0 } },
                { id: "sec_2", name: "Part 2", questionCount: 25, markingScheme: { correct: 1, incorrect: 0 } }
            ]
        };

        const questions = [];
        const answerKeys = [];
        for (let i = 1; i <= 50; i++) {
            const secId = i <= 25 ? "sec_1" : "sec_2";
            questions.push({ questionId: `eq_q_${i}`, questionNumber: i, sectionId: secId, marksAwarded: 1 });
            answerKeys.push({ questionId: `eq_q_${i}`, questionNumber: i, sectionId: secId, acceptedAnswers: ["A"], marksAwarded: 1 });
        }

        const scoreResult = UniversalScoringEngine.evaluateAttempt({
            questions,
            studentAnswers: { eq_q_1: "A", eq_q_26: "A" },
            answerKeys,
            examProfile: config,
            options: { allowUnverified: true }
        });

        assert.strictEqual(scoreResult.totalQuestions, 50);
        assert.strictEqual(scoreResult.maximumMarks, 50);
        assert.strictEqual(scoreResult.totalScore, 2);
        assert.strictEqual(scoreResult.sectionAnalysis["sec_1"].maximumMarks, 25);
        assert.strictEqual(scoreResult.sectionAnalysis["sec_2"].maximumMarks, 25);
    });

    // =========================================================================
    // Test E: Negative Marking Distinction (MCQ penalty vs. MSQ/NAT zero penalty)
    // =========================================================================
    test("E. Mixed Question Types: 1/3 negative for MCQ, exactly 0 negative for MSQ and NAT", () => {
        const config = {
            examId: "mixed-types-gate",
            totalQuestions: 3,
            maximumMarks: 6,
            sections: [
                { id: "sec_tech", name: "Technical", questionCount: 3, maximumMarks: 6, markingScheme: { correct: 2, incorrect: 2 / 3 } }
            ]
        };

        const questions = [
            { questionId: "q_mcq", questionNumber: 1, sectionId: "sec_tech", questionType: "mcq", marksAwarded: 2, marksDeducted: 2 / 3 },
            { questionId: "q_msq", questionNumber: 2, sectionId: "sec_tech", questionType: "msq", marksAwarded: 2, marksDeducted: 0 },
            { questionId: "q_nat", questionNumber: 3, sectionId: "sec_tech", questionType: "nat", marksAwarded: 2, marksDeducted: 0 }
        ];

        const answerKeys = [
            { questionId: "q_mcq", questionNumber: 1, sectionId: "sec_tech", acceptedAnswers: ["A"], marksAwarded: 2, marksDeducted: 2 / 3 },
            { questionId: "q_msq", questionNumber: 2, sectionId: "sec_tech", acceptedAnswers: ["B", "C"], marksAwarded: 2, marksDeducted: 0 },
            { questionId: "q_nat", questionNumber: 3, sectionId: "sec_tech", numericValue: 42, marksAwarded: 2, marksDeducted: 0 }
        ];

        // All 3 answered incorrectly
        const studentAnswers = {
            q_mcq: "D",     // wrong MCQ -> deduct 2/3 (-0.667)
            q_msq: "A",     // wrong MSQ -> 0 deduction
            q_nat: "99"     // wrong NAT -> 0 deduction
        };

        const scoreResult = UniversalScoringEngine.evaluateAttempt({
            questions,
            studentAnswers,
            answerKeys,
            examProfile: config,
            options: { allowUnverified: true }
        });

        // Score must be exactly -2/3 = -0.667
        assert.strictEqual(scoreResult.totalScore, -0.667);
        assert.strictEqual(scoreResult.maximumMarks, 6);
        assert.strictEqual(scoreResult.sectionAnalysis["sec_tech"].maximumMarks, 6);
    });

    // =========================================================================
    // Test F: Dropped / Bonus Questions Handling
    // =========================================================================
    test("F. Dropped Question: Full marks awarded, maximum marks denominator invariant", () => {
        const config = {
            examId: "dropped-test-exam",
            totalQuestions: 2,
            maximumMarks: 4,
            droppedQuestionPolicy: "full_marks",
            sections: [
                { id: "sec_1", name: "Section 1", questionCount: 2, maximumMarks: 4, markingScheme: { correct: 2, incorrect: 0 } }
            ]
        };

        const questions = [
            { questionId: "q_norm", questionNumber: 1, sectionId: "sec_1", marksAwarded: 2 },
            { questionId: "q_drop", questionNumber: 2, sectionId: "sec_1", marksAwarded: 2 }
        ];

        const answerKeys = [
            { questionId: "q_norm", questionNumber: 1, sectionId: "sec_1", acceptedAnswers: ["A"], marksAwarded: 2 },
            { questionId: "q_drop", questionNumber: 2, sectionId: "sec_1", acceptedAnswers: [], isDropped: true, marksAwarded: 2 }
        ];

        // Candidate did not answer anything
        const scoreResult = UniversalScoringEngine.evaluateAttempt({
            questions,
            studentAnswers: {},
            answerKeys,
            examProfile: config,
            options: { allowUnverified: true }
        });

        assert.strictEqual(scoreResult.droppedCount, 1);
        assert.strictEqual(scoreResult.totalScore, 2); // Dropped question awarded +2
        assert.strictEqual(scoreResult.maximumMarks, 4); // Total remains 4
        assert.strictEqual(scoreResult.sectionAnalysis["sec_1"].maximumMarks, 4);
    });

    // =========================================================================
    // Test G: Optional Question Handling (e.g. choose 10 of 15)
    // =========================================================================
    test("G. Optional Policy: Max marks clamped to top K attainable marks", () => {
        const config = {
            examId: "optional-exam",
            totalQuestions: 15,
            maximumMarks: 40, // 10 * 4 = 40
            sections: [
                {
                    id: "sec_opt",
                    name: "Optional Section",
                    questionCount: 15,
                    requiredCount: 10,
                    optionalPolicy: { policyType: "choose_n_of_m", requiredCount: 10, maxAttempts: 10 },
                    markingScheme: { correct: 4, incorrect: 1 }
                }
            ]
        };

        const questions = [];
        const answerKeys = [];
        const studentAnswers = {};

        for (let i = 1; i <= 15; i++) {
            questions.push({ questionId: `opt_q_${i}`, questionNumber: i, sectionId: "sec_opt", marksAwarded: 4 });
            answerKeys.push({ questionId: `opt_q_${i}`, questionNumber: i, sectionId: "sec_opt", acceptedAnswers: ["A"], marksAwarded: 4 });
            studentAnswers[`opt_q_${i}`] = "A"; // Candidate answers all 15
        }

        const scoreResult = UniversalScoringEngine.evaluateAttempt({
            questions,
            studentAnswers,
            answerKeys,
            examProfile: config,
            options: { allowUnverified: true }
        });

        // Clamped to 10 * 4 = 40
        assert.strictEqual(scoreResult.totalScore, 40);
        assert.strictEqual(scoreResult.maximumMarks, 40);
        assert.strictEqual(scoreResult.sectionAnalysis["sec_opt"].maximumMarks, 40);
        assert.strictEqual(scoreResult.sectionAnalysis["sec_opt"].totalQuestions, 15);
    });

    // =========================================================================
    // Test H: Zero Attempts / Unanswered Candidate
    // =========================================================================
    test("H. Zero Attempts: Total score 0, maximum marks preserved exactly", () => {
        const config = {
            examId: "zero-attempt-gate",
            totalQuestions: 65,
            maximumMarks: 100,
            sections: [
                { id: "sec_ga", name: "General Aptitude", questionCount: 10, maximumMarks: 15 },
                { id: "sec_tech", name: "Technical", questionCount: 55, maximumMarks: 85 }
            ]
        };

        const questions = [];
        const answerKeys = [];
        for (let i = 1; i <= 65; i++) {
            const secId = i <= 10 ? "sec_ga" : "sec_tech";
            const marks = (i <= 5 || (i >= 11 && i <= 35)) ? 1 : 2;
            questions.push({ questionId: `q_${i}`, questionNumber: i, sectionId: secId, marksAwarded: marks });
            answerKeys.push({ questionId: `q_${i}`, questionNumber: i, sectionId: secId, acceptedAnswers: ["A"], marksAwarded: marks });
        }

        const scoreResult = UniversalScoringEngine.evaluateAttempt({
            questions,
            studentAnswers: {},
            answerKeys,
            examProfile: config,
            options: { allowUnverified: true }
        });

        assert.strictEqual(scoreResult.totalScore, 0);
        assert.strictEqual(scoreResult.maximumMarks, 100);
        assert.strictEqual(scoreResult.attemptedCount, 0);
        assert.strictEqual(scoreResult.sectionAnalysis["sec_ga"].score, 0);
        assert.strictEqual(scoreResult.sectionAnalysis["sec_ga"].maximumMarks, 15);
        assert.strictEqual(scoreResult.sectionAnalysis["sec_tech"].score, 0);
        assert.strictEqual(scoreResult.sectionAnalysis["sec_tech"].maximumMarks, 85);
    });

    // =========================================================================
    // Test I: MockTestScoringService Facade Compatibility
    // =========================================================================
    test("I. MockTestScoringService Facade handles both single-object and positional formats", () => {
        const questions = [{ questionId: "q1", questionNumber: 1, marksAwarded: 2 }];
        const answerKeys = [{ questionId: "q1", questionNumber: 1, acceptedAnswers: ["A"], marksAwarded: 2 }];
        const examConfig = { schemaVersion: 3, examId: "facade-test", totalQuestions: 1, maximumMarks: 2 };

        // Modern single-object invocation
        const resModern = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: { q1: "A" },
            examConfig
        });
        assert.strictEqual(resModern.totalScore, 2);
        assert.strictEqual(resModern.maximumMarks, 2);

        // Positional legacy invocation
        const resLegacy = MockTestScoringService.evaluateAttempt(
            { q1: "A" },
            answerKeys,
            { examConfig, questions }
        );
        assert.strictEqual(resLegacy.totalScore, 2);
    });

    // =========================================================================
    // Test J: Mathematical Rational Invariant Verification
    // =========================================================================
    test("J. Rational Arithmetic Invariant: Exact fractions throughout aggregation", () => {
        const r1 = new Rational(1, 3);
        const r2 = new Rational(2, 3);
        const sum = r1.add(r2);
        assert.strictEqual(sum.toFractionString(), "1");
        assert.strictEqual(sum.toNumber(2), 1.0);

        // 3 incorrect 1-mark questions (-1/3 each) and 1 correct 1-mark question (+1) = 0
        const neg1_3 = new Rational(-1, 3);
        const pos1 = new Rational(1, 1);
        const net = pos1.add(neg1_3).add(neg1_3).add(neg1_3);
        assert.ok(net.isZero(), "Net score must be exactly zero with Rational precision");
    });
});
