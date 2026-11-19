process.env.NODE_ENV = "test";

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DiagramVerificationService } from "../server/services/documentUnderstanding/diagramVerificationService.js";
import { UniversalPdfPageProcessor } from "../server/services/documentUnderstanding/universalPdfPageProcessor.js";
import { EvidenceReconciliationService } from "../server/services/documentUnderstanding/evidenceReconciliationService.js";
import { IngestionValidator } from "../server/services/ingestion/ingestionValidator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

describe("Phase 4.5.2 — Diagram Verification & Automated Review Reduction Suite", () => {

    const ocrDir = path.join(rootDir, "uploads", "vault", "ocr_cache", "b3b2e1a36018ba3d");
    const diagramsDir = path.join(rootDir, "uploads", "vault", "diagrams");

    // -------------------------------------------------------------------------
    // Test 1: Diagram Boundary Detection & Option Exclusion
    // -------------------------------------------------------------------------
    it("1.1 detects diagram boundary and verifies options are strictly excluded from crop", () => {
        const page1Path = path.join(ocrDir, "page_1.json");
        assert.ok(fs.existsSync(page1Path), "Page 1 OCR JSON must exist");
        const page1Json = JSON.parse(fs.readFileSync(page1Path, "utf8"));
        const rasterPath = path.join(diagramsDir, "diag_neet-ug-2026-38dc44b4_2026_50_p1_img1.png");

        const res = DiagramVerificationService.verifyAndExtractQuestionDiagram({
            questionNumber: 3,
            pageNum: 1,
            pageJson: page1Json,
            pageRasterPath: rasterPath,
            docId: "neet_code50"
        });

        assert.equal(res.hasDiagram, true, "Question 3 must be detected as having a diagram");
        assert.equal(res.hasVisualRef, true, "Question 3 stem must reference figure");
        assert.equal(res.isVerified, true, "Diagram crop must be verified");
        assert.equal(res.stemExcluded, true, "Question stem lines must be above crop");
        assert.equal(res.optionsExcluded, true, "Question options must be below crop");
        assert.ok(res.width >= 32 && res.height >= 32, "Crop dimensions must be valid");
        assert.ok(fs.existsSync(res.localPath), "Cropped diagram PNG file must be saved on disk");
    });

    // -------------------------------------------------------------------------
    // Test 2: Non-Diagram Question Detection
    // -------------------------------------------------------------------------
    it("2.1 returns NO_DIAGRAM for purely textual questions without visual references", () => {
        const page1Path = path.join(ocrDir, "page_1.json");
        const page1Json = JSON.parse(fs.readFileSync(page1Path, "utf8"));

        const res = DiagramVerificationService.verifyAndExtractQuestionDiagram({
            questionNumber: 1,
            pageNum: 1,
            pageJson: page1Json,
            docId: "neet_code50"
        });

        assert.equal(res.hasDiagram, false);
        assert.equal(res.diagramStatus, "NO_DIAGRAM");
    });

    // -------------------------------------------------------------------------
    // Test 3: Column-End Diagram Detection (e.g. Q69)
    // -------------------------------------------------------------------------
    it("3.1 successfully bounds and extracts column-end diagrams (Q69 on Page 21)", () => {
        const page21Path = path.join(ocrDir, "page_21.json");
        assert.ok(fs.existsSync(page21Path), "Page 21 OCR JSON must exist");
        const page21Json = JSON.parse(fs.readFileSync(page21Path, "utf8"));
        const rasterPath = path.join(diagramsDir, "diag_neet-ug-2026-38dc44b4_2026_50_p21_img1.png");

        const res = DiagramVerificationService.verifyAndExtractQuestionDiagram({
            questionNumber: 69,
            pageNum: 21,
            pageJson: page21Json,
            pageRasterPath: rasterPath,
            docId: "neet_code50"
        });

        assert.equal(res.hasDiagram, true);
        assert.equal(res.isVerified, true);
        assert.equal(res.optionsExcluded, true);
    });

    // -------------------------------------------------------------------------
    // Test 4: Evidence-Based Review Decisions (7 Criteria)
    // -------------------------------------------------------------------------
    it("4.1 auto-verifies clean question when all 7 evidence criteria are satisfied", async () => {
        const cleanQuestion = {
            questionNumber: 10,
            questionText: "Which of the following electronic configurations corresponds to a noble gas?",
            questionType: "single_choice_mcq",
            sectionId: "sec_chemistry",
            options: [
                { id: "A", text: "1s2 2s2 2p6" },
                { id: "B", text: "1s2 2s2 2p5" },
                { id: "C", text: "1s2 2s2 2p4" },
                { id: "D", text: "1s2 2s2 2p3" }
            ],
            diagram: null
        };

        const akEntry = {
            questionNumber: 10,
            acceptedAnswers: ["A"],
            isDropped: false
        };

        const rec = await EvidenceReconciliationService.reconcileQuestion({
            questionNumber: 10,
            visionQuestion: cleanQuestion,
            answerKeyEntry: akEntry
        });

        assert.equal(rec.verificationStatus, "VERIFIED");
        assert.equal(rec.autoVerified, true);
        assert.equal(rec.evidenceChecklist.stemSupported, true);
        assert.equal(rec.evidenceChecklist.optionsAccurate, true);
        assert.equal(rec.evidenceChecklist.mathPreserved, true);
        assert.equal(rec.evidenceChecklist.sectionAndTypeValid, true);
        assert.equal(rec.evidenceChecklist.answerKeyValid, true);
        assert.equal(rec.evidenceChecklist.diagramPreserved, true);
        assert.equal(rec.reviewReasons.length, 0);
    });

    // -------------------------------------------------------------------------
    // Test 5: Unresolved Diagram Retention in Review Queue
    // -------------------------------------------------------------------------
    it("5.1 flags question for review when associated diagram has unresolved boundaries", async () => {
        const unresolvedDiagQuestion = {
            questionNumber: 42,
            questionText: "Consider the circuit diagram with diodes shown below. Find the depletion width ratio.",
            questionType: "single_choice_mcq",
            sectionId: "sec_physics",
            options: [
                { id: "A", text: "W1 > W2 > W3" },
                { id: "B", text: "W1 = W2 = W3" },
                { id: "C", text: "W1 < W2 < W3" },
                { id: "D", text: "W1 > W3 > W2" }
            ],
            diagram: {
                diagramStatus: "UNRESOLVED_DIAGRAM",
                isVerified: false,
                reason: "Crop vertical height too small"
            }
        };

        const akEntry = {
            questionNumber: 42,
            acceptedAnswers: ["C"],
            isDropped: false
        };

        const rec = await EvidenceReconciliationService.reconcileQuestion({
            questionNumber: 42,
            visionQuestion: unresolvedDiagQuestion,
            answerKeyEntry: akEntry
        });

        assert.equal(rec.verificationStatus, "NEEDS_REVIEW");
        assert.equal(rec.autoVerified, false);
        assert.equal(rec.evidenceChecklist.diagramPreserved, false);
        assert.ok(rec.reviewReasons.some(r => r.includes("Associated diagram requires manual review")));
    });

    // -------------------------------------------------------------------------
    // Test 6: Document-Level Publication Gate Separation
    // -------------------------------------------------------------------------
    it("6.1 reports READY_FOR_APPROVAL status when all three documents are structurally sound but scanned paper requires admin sign-off", () => {
        const qpExtraction = {
            isScanned: true,
            questions: new Array(180).fill(0).map((_, i) => ({ questionNumber: i + 1, options: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }] })),
            ocrManifest: {
                averageConfidence: 78,
                requiresAdminReview: true
            }
        };

        const akExtraction = {
            answers: new Array(180).fill(0).map((_, i) => ({ questionNumber: i + 1, acceptedAnswers: ["A"], correctOption: "A" }))
        };

        const pfExtraction = {
            totalQuestions: { value: 180 },
            maximumMarks: { value: 720 },
            markingRules: {
                positiveMarks: { value: 4 },
                negativeMarks: { value: 1 }
            },
            durationSeconds: { value: 11700 }
        };

        // Without manual verification: READY_FOR_APPROVAL (canPublish: false)
        const unapprovedVal = IngestionValidator.validatePublication({
            questionPaperExtraction: qpExtraction,
            answerKeyExtraction: akExtraction,
            paperFormatExtraction: pfExtraction,
            options: { manualVerification: false }
        });

        assert.equal(unapprovedVal.publicationStatus, "READY_FOR_APPROVAL");
        assert.equal(unapprovedVal.isApproved, false);
        assert.equal(unapprovedVal.canPublish, false);
        assert.ok(unapprovedVal.publicationBlockers.some(b => b.includes("administrative review and verification")));

        // With manual verification: APPROVED (canPublish: true)
        const approvedVal = IngestionValidator.validatePublication({
            questionPaperExtraction: qpExtraction,
            answerKeyExtraction: akExtraction,
            paperFormatExtraction: pfExtraction,
            options: { manualVerification: true }
        });

        assert.equal(approvedVal.publicationStatus, "APPROVED");
        assert.equal(approvedVal.isApproved, true);
        assert.equal(approvedVal.canPublish, true);
        assert.equal(approvedVal.publicationBlockers.length, 0);
    });

    // -------------------------------------------------------------------------
    // Test 7: Fatal Structural Discrepancy Gate (BLOCKED)
    // -------------------------------------------------------------------------
    it("7.1 strictly reports BLOCKED status when question count mismatch or missing answers exist", () => {
        const mismatchVal = IngestionValidator.validatePublication({
            questionPaperExtraction: {
                isScanned: false,
                questions: new Array(150).fill({})
            },
            answerKeyExtraction: {
                answers: new Array(180).fill({})
            },
            paperFormatExtraction: {
                totalQuestions: { value: 180 }
            }
        });

        assert.equal(mismatchVal.publicationStatus, "BLOCKED");
        assert.equal(mismatchVal.canPublish, false);
        assert.ok(mismatchVal.publicationBlockers.some(b => b.includes("does not match Answer Key count")));
    });
});
