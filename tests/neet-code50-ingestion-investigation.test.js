process.env.NODE_ENV = "test";

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PaperFormatParser } from "../server/services/ingestion/paperFormatParser.js";
import { AnswerKeyParser } from "../server/services/ingestion/answerKeyParser.js";
import { QuestionPaperParser } from "../server/services/ingestion/questionPaperParser.js";
import { IngestionValidator } from "../server/services/ingestion/ingestionValidator.js";
import { UniversalDocumentIngestionService } from "../server/services/ingestion/universalDocumentIngestionService.js";
import { UIRTransformationService } from "../server/services/uir/uirTransformationService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { StorageVaultService } from "../server/services/admin/storageVaultService.js";

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

describe("NEET Code 50 2026 Ingestion Investigation & Generic Remediation Suite", () => {

    const qpPath = getVaultFile("Re-neet_code-50_2026.pdf");
    const akPath = getVaultFile("RE-NEET-UG-2026_Code50_Answer_Key.pdf");
    const pfPath = getVaultFile("RE-NEET-UG-2026_Exam_Pattern.pdf");

    assert.ok(qpPath && fs.existsSync(qpPath), "Question paper PDF must exist in vault");
    assert.ok(akPath && fs.existsSync(akPath), "Answer key PDF must exist in vault");
    assert.ok(pfPath && fs.existsSync(pfPath), "Exam pattern PDF must exist in vault");

    const qpBuf = fs.readFileSync(qpPath);
    const akBuf = fs.readFileSync(akPath);
    const pfBuf = fs.readFileSync(pfPath);

    // -------------------------------------------------------------
    // Test 1: Paper Format Parser Generic Remediation
    // -------------------------------------------------------------
    it("1.1 extracts exam title, paper code 50, duration, and total questions (180)", async () => {
        const pf = await PaperFormatParser.parse(pfBuf);

        assert.ok(pf);
        assert.equal(pf.paperCode.value, "50");
        assert.equal(pf.paperCode.status, "EXPLICIT");
        assert.equal(pf.durationSeconds.value, 11700); // 195 minutes
        assert.equal(pf.totalQuestions.value, 180);
        assert.equal(pf.maximumMarks.value, 720);
        assert.match(pf.examTitle.value, /NEET/i);
    });

    it("1.2 extracts +4 correct, -1 negative (Unicode en-dash), and 0 unattempted marking rules", async () => {
        const pf = await PaperFormatParser.parse(pfBuf);

        assert.equal(pf.markingRules.positiveMarks.value, 4);
        assert.equal(pf.markingRules.positiveMarks.status, "EXPLICIT");
        assert.equal(pf.markingRules.negativeMarks.value, -1);
        assert.equal(pf.markingRules.negativeMarks.status, "EXPLICIT");
        assert.equal(pf.markingRules.unansweredMarks.value, 0);
        assert.equal(pf.markingRules.unansweredMarks.status, "EXPLICIT");
        assert.equal(pf.droppedQuestionPolicy.value, "full_marks_for_all");
    });

    it("1.3 extracts 3 tabular sections (Physics 45, Chemistry 45, Biology 90) with exact question ranges", async () => {
        const pf = await PaperFormatParser.parse(pfBuf);

        assert.equal(pf.sections.length, 3);
        const [sec1, sec2, sec3] = pf.sections;

        assert.equal(sec1.sectionName, "Physics");
        assert.equal(sec1.questionCount, 45);
        assert.equal(sec1.startQuestion, 1);
        assert.equal(sec1.endQuestion, 45);

        assert.equal(sec2.sectionName, "Chemistry");
        assert.equal(sec2.questionCount, 45);
        assert.equal(sec2.startQuestion, 46);
        assert.equal(sec2.endQuestion, 90);

        assert.equal(sec3.sectionName, "Biology");
        assert.equal(sec3.questionCount, 90);
        assert.equal(sec3.startQuestion, 91);
        assert.equal(sec3.endQuestion, 180);
    });

    // -------------------------------------------------------------
    // Test 2: Answer Key Parser Generic Remediation
    // -------------------------------------------------------------
    it("2.1 extracts all 180 answers (Q1–Q180) without missing or duplicate entries", async () => {
        const ak = await AnswerKeyParser.parse(akBuf);

        assert.equal(ak.totalAnswers, 180);
        assert.equal(ak.duplicates.length, 0);
        assert.equal(ak.header.paperCode.value, "50");

        const qNums = new Set(ak.answers.map(a => a.questionNumber));
        for (let i = 1; i <= 180; i++) {
            assert.ok(qNums.has(i), `Answer key must contain question Q${i}`);
        }
    });

    it("2.2 parses Q26 as Bonus (full marks dropped) and Q38 as Multi-Option ('B', 'C')", async () => {
        const ak = await AnswerKeyParser.parse(akBuf);

        const q26 = ak.answers.find(a => a.questionNumber === 26);
        assert.ok(q26);
        assert.equal(q26.isBonus, true);
        assert.equal(q26.isDropped, true);
        assert.deepEqual(q26.acceptedAnswers, ["*"]);

        const q38 = ak.answers.find(a => a.questionNumber === 38);
        assert.ok(q38);
        assert.equal(q38.answerType, "multiple_choice");
        assert.deepEqual(q38.acceptedAnswers, ["B", "C"]);
    });

    // -------------------------------------------------------------
    // Test 3: Question Paper Parser & Scanned Reality Check
    // -------------------------------------------------------------
    it("3.1 identifies pure raster image scanned paper (0 chars/page) and halts before corrupting text", async () => {
        const qp = await QuestionPaperParser.parse(qpBuf);

        assert.equal(qp.isScanned, true);
        assert.equal(qp.scanDetection.isScanned, true);
        assert.equal(qp.scanDetection.averageCharsPerPage, 0);
        assert.equal(qp.scanDetection.totalPages, 40);
        assert.equal(qp.questions.length, 0);
        assert.match(qp.scanDetection.message, /OCR pipeline required/i);
    });

    // -------------------------------------------------------------
    // Test 4: Ingestion Manifest Validation & Gating
    // -------------------------------------------------------------
    it("4.1 produces ingestion manifest with explicit blockers for OCR requirement and denies publication", async () => {
        const manifest = await UniversalDocumentIngestionService.ingestDocuments({
            questionPaper: qpBuf,
            answerKey: akBuf,
            paperFormat: pfBuf
        }, {
            examId: "neet-ug",
            year: 2026,
            paperCode: "50"
        });

        assert.equal(manifest.validation.isValid, false);
        assert.ok(manifest.validation.blockers.some(b => b.includes("scanned bitmap")));
        assert.equal(manifest.publicationValidation.isApproved, false);
        assert.ok(manifest.publicationValidation.publicationBlockers.some(b => b.includes("scanned bitmap")));
    });

    // -------------------------------------------------------------
    // Test 5: End-to-End Pipeline Execution & Graceful Fingerprint
    // -------------------------------------------------------------
    it("5.1 executes runUniversalPipeline to completion without crashing, sets needs_review, and blocks publishing", async () => {
        const storedQp = await StorageVaultService.storeDocument({ buffer: qpBuf, originalFilename: "Re-neet code-50 2026.pdf", docType: "question_paper" });
        const storedAk = await StorageVaultService.storeDocument({ buffer: akBuf, originalFilename: "RE-NEET-UG-2026_Code50_Answer_Key.pdf", docType: "answer_key" });
        const storedEp = await StorageVaultService.storeDocument({ buffer: pfBuf, originalFilename: "RE-NEET-UG-2026_Exam_Pattern.pdf", docType: "exam_pattern" });

        const job = ImportJobPipelineService.createJob({
            examName: "NEET (UG) 2026",
            examId: "neet-ug",
            year: 2026,
            paperCode: "50"
        });

        await ImportJobPipelineService.attachDocuments(job.jobId, {
            questionPaper: storedQp,
            answerKey: storedAk,
            examPattern: storedEp
        });

        const executedJob = await ImportJobPipelineService.runUniversalPipeline(job.jobId);

        assert.equal(executedJob.status, "needs_review");
        assert.equal(executedJob.progressPercent, 100);
        assert.equal(executedJob.validationReport.canPublish, false);
        assert.equal(executedJob.validationReport.validatedFingerprint, "unvalidated_empty_content");
        assert.ok(executedJob.validationReport.blockers.length > 0);
        assert.ok(executedJob.validationReport.blockers.some(b => b.includes("scanned") || b.includes("OCR")));
    });
});
