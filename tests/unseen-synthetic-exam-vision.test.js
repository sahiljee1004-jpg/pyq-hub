process.env.NODE_ENV = "test";

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { QuestionReconstructionService } from "../server/services/documentUnderstanding/questionReconstructionService.js";
import { EvidenceReconciliationService } from "../server/services/documentUnderstanding/evidenceReconciliationService.js";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";
import { UniversalQuestionType } from "../server/services/ingestion/extractionSchema.js";
import { Rational } from "../server/services/scoring/rational.js";

describe("Phase 4.5 — Unseen Synthetic Examination Agnostic Verification", () => {

    const syntheticExam = {
        examId: "space-olympiad-2027",
        title: "International Space Sciences Olympiad 2027",
        totalQuestions: 4,
        durationMinutes: 90,
        sections: [
            { id: "sec_orbital", name: "Orbital Mechanics", start: 1, end: 1 },
            { id: "sec_propulsion", name: "Propulsion Systems", start: 2, end: 2 },
            { id: "sec_life_support", name: "Life Support & Habitats", start: 3, end: 3 },
            { id: "sec_astrobiology", name: "Astrobiology & Exoplanets", start: 4, end: 4 }
        ],
        markingRules: {
            positiveMarks: 3.5,
            negativeMarks: 0.875,
            unansweredMarks: 0.25
        }
    };

    // -------------------------------------------------------------------------
    // Test 1: Zero Hardcoding — Vision Layout Reconstruction on Novel Exam
    // -------------------------------------------------------------------------
    it("1.1 reconstructs questions with 2x2 option grids and LaTeX orbital formulas", () => {
        const rawVisionQuestions = [
            {
                questionNumber: 1,
                sectionId: "sec_orbital",
                sectionName: "Orbital Mechanics",
                stem: "1. The vis-viva equation for a spacecraft orbiting a planet of mass $M$ at distance $r$ with semi-major axis $a$ is $v^2 = GM \\left(\\frac{2}{r} - \\frac{1}{a}\\right)$. If $r = a$, what is the orbital speed?",
                hasDiagram: false,
                options: [
                    { label: "(1)", text: "$\\sqrt{\\frac{GM}{a}}$" },
                    { label: "(2)", text: "$\\sqrt{\\frac{2GM}{a}}$" },
                    { label: "(3)", text: "$\\sqrt{\\frac{GM}{2a}}$" },
                    { label: "(4)", text: "zero" }
                ]
            },
            {
                questionNumber: 2,
                sectionId: "sec_propulsion",
                sectionName: "Propulsion Systems",
                stem: "2. The Tsiolkovsky rocket equation relates $\\Delta v$ to exhaust velocity $v_e$ by $\\Delta v = v_e \\ln\\left(\\frac{m_0}{m_f}\\right)$.\nAns. (2)\nSol. Taking natural logarithm of mass ratio yields the ideal velocity change.",
                hasDiagram: false,
                options: [
                    { label: "(A)", text: "$\\Delta v = v_e \\left(\\frac{m_0}{m_f}\\right)$" },
                    { label: "(B)", text: "$\\Delta v = v_e \\ln\\left(\\frac{m_0}{m_f}\\right)$" },
                    { label: "(C)", text: "$\\Delta v = \\frac{1}{2} m v_e^2$" },
                    { label: "(D)", text: "$\\Delta v = v_e \\sqrt{m_0 - m_f}$" }
                ]
            }
        ];

        const reconstructed = QuestionReconstructionService.reconstructQuestions(rawVisionQuestions);
        assert.equal(reconstructed.length, 2);

        // Q1 checks
        const q1 = reconstructed[0];
        assert.equal(q1.questionNumber, 1);
        assert.equal(q1.options.length, 4);
        assert.equal(q1.options[0].text, "$\\sqrt{\\frac{GM}{a}}$");
        assert.equal(q1.sectionName, "Orbital Mechanics");

        // Q2 checks: solution text stripped from stem
        const q2 = reconstructed[1];
        assert.equal(q2.questionNumber, 2);
        assert.ok(!q2.questionText.includes("Ans."), "Q2 stem must not contain 'Ans.'");
        assert.ok(!q2.questionText.includes("Sol."), "Q2 stem must not contain 'Sol.'");
        assert.ok(q2.solutionText.includes("Taking natural logarithm"));
        assert.equal(q2.options.length, 4);
    });

    // -------------------------------------------------------------------------
    // Test 2: Unseen Three-Document Cross Verification
    // -------------------------------------------------------------------------
    it("2.1 performs macro cross-verification on novel examination metadata", async () => {
        const qpExtraction = {
            questions: [
                { questionNumber: 1, sectionId: "sec_orbital" },
                { questionNumber: 2, sectionId: "sec_propulsion" },
                { questionNumber: 3, sectionId: "sec_life_support" },
                { questionNumber: 4, sectionId: "sec_astrobiology" }
            ],
            sections: syntheticExam.sections.map(s => ({ sectionId: s.id, sectionName: s.name })),
            detectedBookletCode: "ISSO-2027-ALPHA"
        };

        const akExtraction = {
            answers: [
                { questionNumber: 1, acceptedAnswers: ["A"] },
                { questionNumber: 2, acceptedAnswers: ["B"] },
                { questionNumber: 3, acceptedAnswers: ["C"] },
                { questionNumber: 4, acceptedAnswers: ["D"] }
            ],
            header: { paperCode: { value: "ISSO-2027-ALPHA" } }
        };

        const pfExtraction = {
            totalQuestions: { value: 4 },
            sections: syntheticExam.sections.map(s => ({ name: s.name })),
            header: { paperCode: { value: "ISSO-2027-ALPHA" } },
            markingRules: {
                positiveMarks: { value: 3.5 },
                negativeMarks: { value: -0.875 },
                unansweredMarks: { value: -0.25 }
            }
        };

        const report = await EvidenceReconciliationService.crossVerifyThreeDocuments({
            questionPaperExtraction: qpExtraction,
            answerKeyExtraction: akExtraction,
            paperFormatExtraction: pfExtraction,
            options: { useAiReasoning: false }
        });

        assert.equal(report.isConsistent, true);
        assert.equal(report.questionCountMatched, true);
        assert.equal(report.bookletCodeConfirmed, true);
        assert.equal(report.bookletCode, "ISSO-2027-ALPHA");
        assert.equal(report.markingRules.positiveMarks, 3.5);
        assert.equal(report.markingRules.negativeMarks, -0.875);
    });

    // -------------------------------------------------------------------------
    // Test 3: Unconventional Rational Arithmetic Scoring (+3.5, -0.875, -0.25)
    // -------------------------------------------------------------------------
    it("3.1 computes exact rational arithmetic scoring without floating-point error", () => {
        // 3.5 = 7/2, 0.875 = 7/8, 0.25 = 1/4
        const ratPos = Rational.from(3.5);
        const ratNeg = Rational.from(0.875);
        const ratUnans = Rational.from(0.25);

        assert.equal(ratPos.toFractionString(), "7/2");
        assert.equal(ratNeg.toFractionString(), "7/8");
        assert.equal(ratUnans.toFractionString(), "1/4");

        const profile = {
            profileId: "space-olympiad-profile",
            name: "Space Olympiad",
            verificationStatus: "verified",
            markingRules: {
                default: { correct: 3.5, incorrect: 0.875, unanswered: 0.25 }
            }
        };

        const questions = [
            { questionId: "q1", questionNumber: 1, marksAwarded: 3.5, marksDeducted: 0.875 },
            { questionId: "q2", questionNumber: 2, marksAwarded: 3.5, marksDeducted: 0.875 },
            { questionId: "q3", questionNumber: 3, marksAwarded: 3.5, marksDeducted: 0.875 },
            { questionId: "q4", questionNumber: 4, marksAwarded: 3.5, marksDeducted: 0.875 }
        ];

        const answerKeys = [
            { questionId: "q1", questionNumber: 1, correctOptionIds: ["A"] },
            { questionId: "q2", questionNumber: 2, correctOptionIds: ["B"] },
            { questionId: "q3", questionNumber: 3, correctOptionIds: ["C"] },
            { questionId: "q4", questionNumber: 4, correctOptionIds: ["D"] }
        ];

        // Candidate answers:
        // Q1: A (Correct -> +3.5)
        // Q2: C (Wrong -> -0.875)
        // Q3: Unanswered -> (0)
        // Q4: D (Correct -> +3.5)
        // Expected net score: 3.5 - 0.875 + 0 + 3.5 = 6.125
        const attemptResult = UniversalScoringEngine.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: {
                q1: "A",
                q2: "C",
                // q3 is unanswered
                q4: "D"
            },
            examProfile: profile
        });

        // 3.5 + (-0.875) + 0 + 3.5 = 6.125 (49/8)
        assert.equal(attemptResult.totalScore, 6.125);
    });

    // -------------------------------------------------------------------------
    // Test 4: Question Verification Rate on Unseen Exam
    // -------------------------------------------------------------------------
    it("4.1 auto-verifies 100% clean questions on unseen synthetic exam", async () => {
        const questions = [
            {
                questionNumber: 1,
                questionText: "The vis-viva equation for a spacecraft orbiting a planet is:",
                options: [
                    { id: "A", text: "v^2 = GM(2/r - 1/a)" },
                    { id: "B", text: "v^2 = GM/r" },
                    { id: "C", text: "v^2 = 2GM/r" },
                    { id: "D", text: "v^2 = 0" }
                ],
                confidenceBreakdown: { overallConfidence: 0.95 }
            },
            {
                questionNumber: 2,
                questionText: "The Tsiolkovsky rocket equation relates delta-v to mass ratio:",
                options: [
                    { id: "A", text: "delta-v = v_e * (m0/mf)" },
                    { id: "B", text: "delta-v = v_e * ln(m0/mf)" },
                    { id: "C", text: "delta-v = 0.5 * m * v_e^2" },
                    { id: "D", text: "delta-v = v_e * sqrt(m0 - mf)" }
                ],
                confidenceBreakdown: { overallConfidence: 0.95 }
            }
        ];

        const answerKey = {
            answers: [
                { questionNumber: 1, acceptedAnswers: ["A"] },
                { questionNumber: 2, acceptedAnswers: ["B"] }
            ]
        };

        const res = await EvidenceReconciliationService.reconcileAllQuestions({ questions, answerKey });
        assert.equal(res.totalQuestions, 2);
        assert.equal(res.verifiedCount, 2);
        assert.equal(res.verificationRate, 1.0);
    });
});
