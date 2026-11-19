process.env.NODE_ENV = "test";

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OcrEngineService } from "../server/services/ocr/ocrEngineService.js";
import { LayoutReconstructionService } from "../server/services/ocr/layoutReconstructionService.js";
import { QuestionPaperParser } from "../server/services/ingestion/questionPaperParser.js";
import { IngestionValidator } from "../server/services/ingestion/ingestionValidator.js";
import { UniversalDocumentIngestionService } from "../server/services/ingestion/universalDocumentIngestionService.js";
import { UIRTransformationService } from "../server/services/uir/uirTransformationService.js";
import { UIRValidator } from "../server/services/uir/uirValidator.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const vaultDir = path.join(rootDir, "uploads/vault");

function getVaultFile(pattern) {
    if (!fs.existsSync(vaultDir)) return null;
    const files = fs.readdirSync(vaultDir);
    const matches = files.filter(f => f.includes(pattern)).sort().reverse();
    return matches.length > 0 ? path.join(vaultDir, matches[0]) : null;
}

describe("Phase 4.4 — Universal OCR Engine & Scanned Examination Document Support", () => {

    const neetQpPath = getVaultFile("Re-neet_code-50_2026.pdf");
    const upscQpPath = getVaultFile("UPSC_CSE_Prelims_2026_GS1.pdf");
    const bpscQpPath = getVaultFile("BPSC_69th_Prelims_General_Studies.pdf");
    const jeeQpPath = getVaultFile("JEE_Main_21_Jan_2026_Shift1_QP.pdf");

    // -------------------------------------------------------------
    // Test 1: Engine Availability & Local Offline Environment
    // -------------------------------------------------------------
    it("1.1 verifies OCR engine is locally available with offline language models", () => {
        const available = OcrEngineService.isAvailable();
        assert.equal(available, true, "Tesseract.js engine and traineddata must be present locally");

        const hasEng = fs.existsSync(path.join(rootDir, "eng.traineddata"));
        const hasHin = fs.existsSync(path.join(rootDir, "hin.traineddata"));
        assert.ok(hasEng, "eng.traineddata must exist in workspace root");
        assert.ok(hasHin, "hin.traineddata must exist in workspace root");
    });

    // -------------------------------------------------------------
    // Test 2: Hybrid Page-Level Classification (Zero OCR on Searchable)
    // -------------------------------------------------------------
    it("2.1 accurately classifies scanned PDF vs searchable digital PDFs", async () => {
        assert.ok(neetQpPath, "NEET Question Paper must exist");
        const neetBuf = fs.readFileSync(neetQpPath);

        const neetClass = await OcrEngineService.classifyPdfPages(neetBuf);
        assert.equal(neetClass.isScanned, true, "NEET Code 50 must be classified as isScanned: true");
        assert.equal(neetClass.digitalCount, 0, "NEET Code 50 has 0 digital text pages");
        assert.equal(neetClass.scannedCount, 40, "NEET Code 50 has 40 scanned pages");

        // Verify searchable PDFs continue using digital extraction (0 scanned pages)
        if (upscQpPath && fs.existsSync(upscQpPath)) {
            const upscBuf = fs.readFileSync(upscQpPath);
            const upscClass = await OcrEngineService.classifyPdfPages(upscBuf);
            assert.equal(upscClass.isScanned, false, "UPSC must NOT be classified as scanned");
            assert.ok(upscClass.digitalCount > 0, "UPSC has digital text pages");
        }

        if (jeeQpPath && fs.existsSync(jeeQpPath)) {
            const jeeBuf = fs.readFileSync(jeeQpPath);
            const jeeClass = await OcrEngineService.classifyPdfPages(jeeBuf);
            assert.equal(jeeClass.isScanned, false, "JEE Main must NOT be classified as scanned");
        }
    });

    // -------------------------------------------------------------
    // Test 3: Multi-Column Gutter Detection
    // -------------------------------------------------------------
    it("3.1 detects vertical dividing gutter on multi-column scanned exam page", async () => {
        const neetBuf = fs.readFileSync(neetQpPath);
        const p1Raster = await OcrEngineService.extractPageRaster(neetBuf, 1);
        assert.ok(p1Raster, "Page 1 raster must be extractable");
        assert.ok(p1Raster.width >= 1000, "Page 1 width should be high-resolution (>1000px)");

        const layout = await OcrEngineService.detectLayoutColumns(p1Raster.localPath, p1Raster.width, p1Raster.height);
        assert.equal(layout.columnsCount, 2, "NEET Page 1 must be detected as 2 columns");
        assert.ok(layout.gutters.length >= 1, "Must detect at least 1 vertical gutter");
        // Central gutter should be near 50% width (~550-610 on 1177px width)
        const gutterX = layout.gutters[0];
        assert.ok(gutterX >= 500 && gutterX <= 650, `Gutter position (${gutterX}) should be near the center`);
    });

    // -------------------------------------------------------------
    // Test 4: Question Reconstruction & Sub-Statement Protection
    // -------------------------------------------------------------
    it("4.1 reconstructs questions sequentially and separates solutions cleanly", async () => {
        const neetBuf = fs.readFileSync(neetQpPath);
        const pdfHash = OcrEngineService.computeHash(neetBuf);

        // Recognize Page 1 and Page 2
        const p1Raster = await OcrEngineService.extractPageRaster(neetBuf, 1);
        const p1Ocr = await OcrEngineService.recognizePage({
            imagePath: p1Raster.localPath,
            pageNumber: 1,
            width: p1Raster.width,
            height: p1Raster.height,
            pdfHash
        });

        const p2Raster = await OcrEngineService.extractPageRaster(neetBuf, 2);
        const p2Ocr = await OcrEngineService.recognizePage({
            imagePath: p2Raster.localPath,
            pageNumber: 2,
            width: p2Raster.width,
            height: p2Raster.height,
            pdfHash
        });

        const reconstructed = LayoutReconstructionService.reconstructQuestions([p1Ocr, p2Ocr]);
        assert.ok(reconstructed.questions.length >= 6, `Expected at least 6 questions across pages 1-2, got ${reconstructed.questions.length}`);

        // Verify questions 1, 2, 3 on page 1
        const q1 = reconstructed.questions.find(q => q.questionNumber === 1);
        const q2 = reconstructed.questions.find(q => q.questionNumber === 2);
        const q3 = reconstructed.questions.find(q => q.questionNumber === 3);

        assert.ok(q1, "Question 1 must be detected");
        assert.ok(q2, "Question 2 must be detected");
        assert.ok(q3, "Question 3 must be detected");

        // Verify solution text is separated from question stem
        assert.ok(q1.solutionText, "Q1 should have separated solutionText");
        assert.ok(!q1.questionText.includes("W.D. by kinetic friction"), "Q1 stem must NOT be polluted by solution derivations");
    });

    // -------------------------------------------------------------
    // Test 5: Full Provenance Tracking
    // -------------------------------------------------------------
    it("5.1 records full provenance with engine, bounding box, confidence, and page references", async () => {
        const neetBuf = fs.readFileSync(neetQpPath);
        const parsed = await QuestionPaperParser.parse(neetBuf, { maxOcrPages: 2 });

        assert.equal(parsed.isScanned, true);
        assert.ok(parsed.ocrManifest, "OCR manifest must be attached");
        assert.equal(parsed.ocrManifest.engine, "tesseract.js");
        assert.equal(parsed.ocrManifest.version, "6.0.1");

        const q1 = parsed.questions.find(q => q.questionNumber === 1);
        assert.ok(q1, "Q1 must exist");
        assert.ok(q1.provenance, "Q1 must have provenance");
        assert.equal(q1.provenance.sourceDocId, "question_paper");
        assert.equal(q1.provenance.originalPdfPage, 1);
        assert.equal(q1.provenance.ocrPageNumber, 1);
        assert.equal(q1.provenance.ocrEngine, "tesseract.js");
        assert.ok(Array.isArray(q1.provenance.bbox), "Q1 must have bounding box array");
        assert.equal(q1.provenance.bbox.length, 4, "Bounding box must be [x0, y0, x1, y1]");
        assert.ok(q1.provenance.confidence > 0.60, "Q1 confidence should be > 60%");
        assert.equal(q1.provenance.extractionMethod, "ocr_layout_reconstruction");
    });

    // -------------------------------------------------------------
    // Test 6: UIR Schema v3.0 Compatibility
    // -------------------------------------------------------------
    it("6.1 validates UIR transformation retains OCR provenance without schema errors", async () => {
        const neetBuf = fs.readFileSync(neetQpPath);
        const akPath = getVaultFile("RE-NEET-UG-2026_Code50_Answer_Key.pdf");
        const pfPath = getVaultFile("RE-NEET-UG-2026_Exam_Pattern.pdf");

        const akBuf = fs.readFileSync(akPath);
        const pfBuf = fs.readFileSync(pfPath);

        const manifest = await UniversalDocumentIngestionService.ingestDocuments({
            questionPaper: neetBuf,
            answerKey: akBuf,
            paperFormat: pfBuf
        }, { maxOcrPages: 2 });

        const uirResult = UIRTransformationService.transformIngestionManifest(manifest);
        assert.ok(uirResult.uirDocument, "UIR document must be produced");

        const uirQ1 = uirResult.uirDocument.questions.find(q => q.questionNumber === 1);
        assert.ok(uirQ1, "UIR Q1 must exist");
        assert.ok(uirQ1.provenance, "UIR Q1 must have provenance");
        assert.equal(uirQ1.provenance.ocrEngine, "tesseract.js");
        assert.equal(uirQ1.provenance.extractionMethod, "ocr_layout_reconstruction");
    });

    // -------------------------------------------------------------
    // Test 7: OCR Quality Gates Enforcement
    // -------------------------------------------------------------
    it("7.1 enforces strict publication blocker when scanned paper has not completed admin verification", () => {
        const mockQp = {
            isScanned: true,
            ocrManifest: {
                averageConfidence: 75,
                requiresAdminReview: true
            },
            questions: [{ questionNumber: 1, questionText: "Test", options: [{ id: "A", text: "opt" }] }]
        };
        const mockAk = {
            answers: [{ questionNumber: 1, correctOption: "A" }]
        };
        const mockPf = {
            totalQuestions: { value: 1 }
        };

        // Without manual verification -> BLOCKED
        const pubValBlocked = IngestionValidator.validatePublication({
            questionPaperExtraction: mockQp,
            answerKeyExtraction: mockAk,
            paperFormatExtraction: mockPf,
            options: {}
        });
        assert.equal(pubValBlocked.isApproved, false, "Scanned paper without admin verification must be blocked");
        assert.ok(pubValBlocked.publicationBlockers.some(b => b.includes("administrative review")), "Must cite admin review requirement");

        // With low confidence (< 65%) -> BLOCKED even with manual verification
        const lowConfQp = {
            ...mockQp,
            ocrManifest: { averageConfidence: 58, requiresAdminReview: true }
        };
        const pubValLowConf = IngestionValidator.validatePublication({
            questionPaperExtraction: lowConfQp,
            answerKeyExtraction: mockAk,
            paperFormatExtraction: mockPf,
            options: { manualVerification: { completed: true } }
        });
        assert.equal(pubValLowConf.isApproved, false, "Low OCR confidence (<65%) must block publication");
    });

    // -------------------------------------------------------------
    // Test 8: Fingerprint and Publication Security (No unvalidated_empty_content bypass)
    // -------------------------------------------------------------
    it("8.1 prevents publication bypass and rejects unvalidated_empty_content fingerprint", () => {
        const mockJob = {
            examId: "neet-scanned",
            contentFingerprint: null,
            validationReport: {
                validatedFingerprint: "unvalidated_empty_content"
            },
            draftPackage: {
                questions: [],
                answerKeys: []
            }
        };

        const result = ImportJobPipelineService.canPublish(mockJob);
        assert.equal(result.canPublish, false, "Must NEVER permit publication with unvalidated_empty_content");
        assert.ok(result.blockers.some(b => b.code === "MISSING_FINGERPRINT" || b.title.includes("Fingerprint")), "Must flag missing or invalid validation fingerprint");
    });

    // -------------------------------------------------------------
    // Test 9: Human Correction Audit Trail
    // -------------------------------------------------------------
    it("9.1 records human corrections with audit trail and preserves raw OCR text", () => {
        const rawOcrText = "1. Particle moves with velocity v";
        const correction = {
            questionNumber: 1,
            field: "questionText",
            previousValue: rawOcrText,
            newValue: "1. A particle of mass M moves along a horizontal x axis",
            reason: "Corrected initial OCR character omission",
            modifiedBy: "admin@vidyarthiastra.com",
            modifiedAt: new Date().toISOString()
        };

        const qWithCorrection = LayoutReconstructionService.compileReconstructedQuestion({
            num: 1,
            pageNum: 1,
            lines: [rawOcrText],
            lineObjects: [{ text: rawOcrText, confidence: 85 }],
            rawOptions: [{ id: "A", text: "Option A", confidence: 85 }],
            solutionLines: []
        }, { sectionId: "sec_1", sectionName: "Physics" });

        assert.equal(qWithCorrection.provenance.originalOcrText, rawOcrText);
        assert.equal(qWithCorrection.provenance.normalizedText, rawOcrText);

        // Verify UIR accepts the correction in humanCorrectionHistory
        const transformed = UIRTransformationService.transformIngestionManifest({
            extractions: {
                questionPaper: { questions: [qWithCorrection], sections: [] },
                answerKey: { answers: [{ questionNumber: 1, correctOption: "A" }] },
                paperFormat: { totalQuestions: { value: 1 } }
            }
        });

        UIRTransformationService.applyHumanCorrection(transformed.uirDocument, {
            questionNumber: 1,
            field: "stem.text",
            newValue: "1. A particle of mass M moves along a horizontal x axis",
            reason: "Corrected initial OCR character omission",
            modifiedBy: "admin@vidyarthiastra.com"
        });

        const uirQ1 = transformed.uirDocument.questions[0];
        assert.equal(uirQ1.humanCorrectionHistory.length, 1);
        assert.equal(uirQ1.humanCorrectionHistory[0].modifiedBy, "admin@vidyarthiastra.com");
        assert.equal(uirQ1.humanCorrectionHistory[0].reason, "Corrected initial OCR character omission");
        assert.equal(uirQ1.stem.text, "1. A particle of mass M moves along a horizontal x axis");
    });
});
