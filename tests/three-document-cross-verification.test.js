process.env.NODE_ENV = "test";

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EvidenceReconciliationService } from "../server/services/documentUnderstanding/evidenceReconciliationService.js";

describe("Phase 4.5 — Three-Document Cross-Verification & Auto-Verification", () => {

    it("1.1 performs macro cross-verification across QP, AK, and Exam Pattern", async () => {
        const qp = {
            questions: new Array(180).fill({}),
            sections: [
                { sectionId: "sec_1", sectionName: "Physics Section A" },
                { sectionId: "sec_2", sectionName: "Chemistry Section A" }
            ],
            isScanned: true,
            detectedBookletCode: "Code 50"
        };

        const ak = {
            answers: new Array(180).fill({ acceptedAnswers: ["A"] }),
            header: { paperCode: { value: "Code 50" } }
        };

        const pf = {
            totalQuestions: { value: 180 },
            sections: [
                { name: "Physics Section A" },
                { name: "Chemistry Section A" }
            ],
            header: { paperCode: { value: "Code 50" } },
            markingRules: {
                positiveMarks: { value: 4 },
                negativeMarks: { value: -1 },
                unansweredMarks: { value: 0 }
            }
        };

        const report = await EvidenceReconciliationService.crossVerifyThreeDocuments({
            questionPaperExtraction: qp,
            answerKeyExtraction: ak,
            paperFormatExtraction: pf,
            options: { useAiReasoning: false }
        });

        assert.equal(report.isConsistent, true, "All three documents must be consistent");
        assert.equal(report.questionCountMatched, true);
        assert.equal(report.sectionDistributionMatched, true);
        assert.equal(report.bookletCodeConfirmed, true);
        assert.equal(report.bookletCode, "Code 50");
        assert.equal(report.discrepancies.length, 0);
    });

    it("1.2 detects question count discrepancy between Question Paper and Answer Key", async () => {
        const qp = {
            questions: new Array(175).fill({}),
            sections: []
        };
        const ak = {
            answers: new Array(180).fill({ acceptedAnswers: ["A"] }),
            header: { paperCode: { value: "Code 50" } }
        };
        const pf = {
            totalQuestions: { value: 180 },
            header: { paperCode: { value: "Code 50" } },
            markingRules: { positiveMarks: { value: 4 } }
        };

        const report = await EvidenceReconciliationService.crossVerifyThreeDocuments({
            questionPaperExtraction: qp,
            answerKeyExtraction: ak,
            paperFormatExtraction: pf,
            options: { useAiReasoning: false }
        });

        assert.equal(report.isConsistent, false);
        assert.equal(report.questionCountMatched, false);
        assert.ok(report.discrepancies.some(d => d.includes("count mismatch")));
    });

    it("1.3 detects booklet code mismatch between Answer Key and Paper Pattern", async () => {
        const qp = { questions: new Array(100).fill({}) };
        const ak = { answers: new Array(100).fill({}), header: { paperCode: { value: "Code A" } } };
        const pf = { totalQuestions: { value: 100 }, header: { paperCode: { value: "Code B" } }, markingRules: { positiveMarks: { value: 2 } } };

        const report = await EvidenceReconciliationService.crossVerifyThreeDocuments({
            questionPaperExtraction: qp,
            answerKeyExtraction: ak,
            paperFormatExtraction: pf,
            options: { useAiReasoning: false }
        });

        assert.equal(report.isConsistent, false);
        assert.equal(report.bookletCodeConfirmed, false);
        assert.ok(report.discrepancies.some(d => d.includes("Booklet code conflict")));
    });

    it("1.4 auto-verifies clean 4-option questions matching official answer key", async () => {
        const visionQ = {
            questionNumber: 1,
            questionText: "An electric dipole of moment $\\vec{p}$ is placed in uniform field $\\vec{E}$. The torque is:",
            options: [
                { id: "A", label: "(1)", text: "\\vec{p} \\times \\vec{E}" },
                { id: "B", label: "(2)", text: "\\vec{p} \\cdot \\vec{E}" },
                { id: "C", label: "(3)", text: "zero" },
                { id: "D", label: "(4)", text: "\\vec{p} + \\vec{E}" }
            ],
            confidenceBreakdown: { overallConfidence: 0.96 }
        };

        const akEntry = {
            questionNumber: 1,
            acceptedAnswers: ["A"],
            isDropped: false
        };

        const reconciled = await EvidenceReconciliationService.reconcileQuestion({
            questionNumber: 1,
            visionQuestion: visionQ,
            answerKeyEntry: akEntry
        });

        assert.equal(reconciled.verificationStatus, "VERIFIED");
        assert.equal(reconciled.autoVerified, true);
        assert.equal(reconciled.reviewReasons.length, 0);
        assert.equal(reconciled.options.length, 4);
    });

    it("1.5 flags questions requiring human review when options are incomplete", async () => {
        const incompleteQ = {
            questionNumber: 2,
            questionText: "Which of the following undergoes SN1 reaction faster?",
            options: [
                { id: "A", label: "(1)", text: "Tertiary halide" },
                { id: "B", label: "(2)", text: "Primary halide" }
            ],
            confidenceBreakdown: { overallConfidence: 0.60 }
        };

        const akEntry = {
            questionNumber: 2,
            acceptedAnswers: ["A"],
            isDropped: false
        };

        const reconciled = await EvidenceReconciliationService.reconcileQuestion({
            questionNumber: 2,
            visionQuestion: incompleteQ,
            answerKeyEntry: akEntry
        });

        assert.equal(reconciled.verificationStatus, "NEEDS_REVIEW");
        assert.equal(reconciled.autoVerified, false);
        assert.ok(reconciled.reviewReasons.some(r => r.includes("Expected 4 options")));
    });

    it("1.6 auto-verifies dropped / bonus questions without requiring option matches", async () => {
        const droppedQ = {
            questionNumber: 3,
            questionText: "This question had an ambiguity in question formulation.",
            options: [
                { id: "A", text: "Option A" },
                { id: "B", text: "Option B" }
            ]
        };

        const droppedAkEntry = {
            questionNumber: 3,
            acceptedAnswers: [],
            isDropped: true,
            rationale: "Question dropped by National Testing Agency"
        };

        const reconciled = await EvidenceReconciliationService.reconcileQuestion({
            questionNumber: 3,
            visionQuestion: droppedQ,
            answerKeyEntry: droppedAkEntry
        });

        assert.equal(reconciled.verificationStatus, "VERIFIED");
        assert.equal(reconciled.autoVerified, true);
        assert.equal(reconciled.isDropped, true);
    });

    it("1.7 batch reconciles questions and computes overall verification rate", async () => {
        const questions = [
            {
                questionNumber: 1,
                questionText: "Standard full question with clear stem text.",
                options: [{ id: "A", text: "1" }, { id: "B", text: "2" }, { id: "C", text: "3" }, { id: "D", text: "4" }],
                confidenceBreakdown: { overallConfidence: 0.95 }
            },
            {
                questionNumber: 2,
                questionText: "Another standard full question.",
                options: [{ id: "A", text: "1" }, { id: "B", text: "2" }, { id: "C", text: "3" }, { id: "D", text: "4" }],
                confidenceBreakdown: { overallConfidence: 0.95 }
            },
            {
                questionNumber: 3,
                questionText: "Partial question",
                options: [{ id: "A", text: "1" }]
            }
        ];

        const answerKey = {
            answers: [
                { questionNumber: 1, acceptedAnswers: ["A"] },
                { questionNumber: 2, acceptedAnswers: ["B"] },
                { questionNumber: 3, acceptedAnswers: ["C"] }
            ]
        };

        const batchResult = await EvidenceReconciliationService.reconcileAllQuestions({
            questions,
            answerKey
        });

        assert.equal(batchResult.totalQuestions, 3);
        assert.equal(batchResult.verifiedCount, 2);
        assert.equal(batchResult.needsReviewCount, 1);
        assert.equal(batchResult.verificationRate, 0.67);
    });
});

