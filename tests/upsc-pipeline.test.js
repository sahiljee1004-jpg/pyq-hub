import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { QuestionNormalizationService } from "../server/services/admin/questionNormalizationService.js";
import { AnswerKeyReconciliationService } from "../server/services/admin/answerKeyReconciliationService.js";
import { ExamPatternService } from "../server/services/admin/examPatternService.js";
import { MetadataExtractionService } from "../server/services/admin/metadataExtractionService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { StorageVaultService } from "../server/services/admin/storageVaultService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function getVaultFile(pattern) {
    const vaultDir = path.join(rootDir, "uploads/vault");
    if (!fs.existsSync(vaultDir)) return null;
    const files = fs.readdirSync(vaultDir);
    const matches = files.filter(f => f.includes(pattern)).sort().reverse();
    return matches.length > 0 ? path.join(vaultDir, matches[0]) : null;
}

const qpPath = getVaultFile("UPSC_Prelims_2026_Paper_I_Typed.pdf") || path.join(rootDir, "uploads/vault/260d113c56c7355d_1794128007769_UPSC_Prelims_2026_Paper_I_Typed.pdf");
const akPath = getVaultFile("UPSC_Prelims_2026_Paper_I_Answer_Key.pdf") || path.join(rootDir, "uploads/vault/d7ad6b5b73dd896b_1794128007772_UPSC_Prelims_2026_Paper_I_Answer_Key.pdf");
const epPath = getVaultFile("UPSC_Prelims_2026_Paper_1_Pattern.pdf") || path.join(rootDir, "uploads/vault/16a39e689ed8edd7_1794128013694_UPSC_Prelims_2026_Paper_1_Pattern.pdf");

test("UPSC Civil Services Preliminary 2026 Paper I — Pipeline & Verification Test Suite", async (t) => {
    process.env.NODE_ENV = "test";
    process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

    const qpExists = fs.existsSync(qpPath);
    const akExists = fs.existsSync(akPath);
    const epExists = fs.existsSync(epPath);

    assert.ok(qpExists, `UPSC Question Paper PDF must exist in vault: ${qpPath}`);
    assert.ok(akExists, `UPSC Answer Key PDF must exist in vault: ${akPath}`);
    assert.ok(epExists, `UPSC Exam Pattern PDF must exist in vault: ${epPath}`);

    const qpBuf = fs.readFileSync(qpPath);
    const akBuf = fs.readFileSync(akPath);
    const epBuf = fs.readFileSync(epPath);

    let pattern = null;
    let normResult = null;
    let akResult = null;
    let reconciled = null;

    await t.test("1. Exam Identity Resolution and Authoritative Exam Pattern Registration", () => {
        const id1 = ExamPatternService.resolveExamIdentity("UPSC");
        assert.equal(id1.examId, "upsc-prelims");
        assert.equal(id1.isKnown, true);

        const id2 = ExamPatternService.resolveExamIdentity("UPSC Civil Services Preliminary 2026");
        assert.equal(id2.examId, "upsc-prelims");
        assert.equal(id2.isKnown, true);

        pattern = ExamPatternService.getVerifiedPattern({ examId: "upsc-prelims", year: 2026 });
        assert.equal(pattern.examId, "upsc-prelims");
        assert.equal(pattern.totalQuestions, 100);
        assert.equal(pattern.maximumMarks, 200);
        assert.equal(pattern.durationSeconds, 7200);
        assert.equal(pattern.negativeMarkingEnabled, true);
        assert.equal(pattern.sections.length, 1);
        assert.equal(pattern.sections[0].id, "general_studies");
        assert.equal(pattern.sections[0].markingScheme.correct, 2);
        assert.ok(Math.abs(pattern.sections[0].markingScheme.incorrect - (-2 / 3)) < 1e-6);
        assert.equal(pattern.sections[0].markingScheme.unanswered, 0);
    });

    await t.test("2. Metadata Extraction from 3 Authoritative Source Documents", async () => {
        const extractedMeta = await MetadataExtractionService.extractAllMetadata({
            questionPaperBuffer: qpBuf,
            answerKeyBuffer: akBuf,
            examPatternBuffer: epBuf,
            userHints: { examId: "upsc-prelims", year: 2026 }
        });

        assert.equal(extractedMeta.examId.value, "upsc-prelims");
        assert.equal(extractedMeta.year.value, 2026);
        assert.equal(extractedMeta.totalQuestions.value, 100);
        assert.equal(extractedMeta.maximumMarks.value, 200);
        assert.equal(extractedMeta.durationSeconds.value, 7200);
        assert.equal(extractedMeta.paperCode.value, "A");
        assert.equal(extractedMeta.warnings.length, 0, "No warnings or code mismatch should occur");
    });

    await t.test("3. Question Normalization extracts exactly 100 questions (Q1 to Q100) with 0 omissions", async () => {
        normResult = await QuestionNormalizationService.extractAndNormalizeQuestions({
            pdfBuffer: qpBuf,
            examId: "upsc-prelims",
            year: 2026,
            paperCode: "A",
            language: "en",
            pattern
        });

        assert.equal(normResult.totalExtracted, 100, "Must extract exactly 100 questions");
        assert.equal(normResult.questions.length, 100);

        const qNums = normResult.questions.map(q => q.questionNumber);
        const expectedNums = Array.from({ length: 100 }, (_, i) => i + 1);
        assert.deepEqual(qNums, expectedNums, "Questions must be sequential from 1 to 100 without gaps");
    });

    await t.test("4. Option Completeness: all 100 questions have exactly 4 options parsed", () => {
        assert.ok(normResult && normResult.questions.length === 100);
        const defectiveQuestions = [];

        normResult.questions.forEach(q => {
            if (!Array.isArray(q.options) || q.options.length !== 4) {
                defectiveQuestions.push({
                    qNum: q.questionNumber,
                    optionCount: q.options ? q.options.length : 0,
                    textPreview: q.questionText.slice(0, 50)
                });
            }
        });

        assert.equal(defectiveQuestions.length, 0, `All 100 questions must have exactly 4 options. Found defective: ${JSON.stringify(defectiveQuestions)}`);

        // Check option IDs and labels
        for (const q of normResult.questions) {
            const labels = q.options.map(o => o.label);
            const ids = q.options.map(o => o.id);
            assert.deepEqual(labels, ["A", "B", "C", "D"], `Q${q.questionNumber} labels must be A, B, C, D`);
            assert.deepEqual(ids, ["1", "2", "3", "4"], `Q${q.questionNumber} ids must be 1, 2, 3, 4`);
        }
    });

    await t.test("5. Numbered Statements & Complex Questions Disambiguation", () => {
        // Q3 has Roman statements I, II and numbered options 1, 2
        const q3 = normResult.questions.find(q => q.questionNumber === 3);
        assert.ok(q3, "Q3 must exist");
        assert.ok(q3.questionText.includes("Pali texts"), "Q3 stem must retain Statement I");
        assert.ok(q3.questionText.includes("punch-marked coins"), "Q3 stem must retain Statement II");
        assert.ok(q3.questionText.includes("Emergence of urban life"), "Q3 stem must retain statement 1");
        assert.ok(q3.questionText.includes("Transition to money economy"), "Q3 stem must retain statement 2");
        assert.equal(q3.options.length, 4);

        // Q4 has temples 1, 2, 3, 4
        const q4 = normResult.questions.find(q => q.questionNumber === 4);
        assert.ok(q4, "Q4 must exist");
        assert.ok(q4.questionText.includes("Malegitti Shivalaya"), "Q4 must retain temple 1");
        assert.ok(q4.questionText.includes("Virupaksha Temple"), "Q4 must retain temple 4");
        assert.equal(q4.options.length, 4);

        // Q7 has statements 1, 2, 3
        const q7 = normResult.questions.find(q => q.questionNumber === 7);
        assert.ok(q7, "Q7 must exist");
        assert.ok(q7.questionText.includes("Mankani plates"), "Q7 must retain statement 1");
        assert.equal(q7.options.length, 4);

        // Q8 has statements I, II, III and inferences 1, 2, 3
        const q8 = normResult.questions.find(q => q.questionNumber === 8);
        assert.ok(q8, "Q8 must exist");
        assert.ok(q8.questionText.includes("spindle-whorls"), "Q8 must retain statement I");
        assert.equal(q8.options.length, 4);

        // Q100 exists and has 4 options
        const q100 = normResult.questions.find(q => q.questionNumber === 100);
        assert.ok(q100, "Q100 must exist");
        assert.equal(q100.options.length, 4);
    });

    await t.test("6. Official Answer Key Parsing & Booklet Code Verification", async () => {
        akResult = await AnswerKeyReconciliationService.parseAnswerKeyDocument(akBuf);
        assert.equal(akResult.totalParsed, 100, "Must parse all 100 answers from answer key");
        assert.equal(akResult.keyMetadata.bookletSeries, "A");
        assert.equal(akResult.keyMetadata.bookletCode, "TDMN-A-ASO");
        assert.equal(akResult.keyMetadata.isOfficialKey, true);

        // Verify sample answers against official key document
        // 1(d), 2(a), 3(c), 4(b), 5(b), 6(a), 7(d), 8(a), 9(c), 10(b)
        assert.deepEqual(akResult.answers.get(1).correctOptionIds, ["4"]);
        assert.deepEqual(akResult.answers.get(2).correctOptionIds, ["1"]);
        assert.deepEqual(akResult.answers.get(3).correctOptionIds, ["3"]);
        assert.deepEqual(akResult.answers.get(4).correctOptionIds, ["2"]);
        assert.deepEqual(akResult.answers.get(5).correctOptionIds, ["2"]);
        assert.deepEqual(akResult.answers.get(6).correctOptionIds, ["1"]);
        assert.deepEqual(akResult.answers.get(7).correctOptionIds, ["4"]);
        assert.deepEqual(akResult.answers.get(8).correctOptionIds, ["1"]);
        assert.deepEqual(akResult.answers.get(9).correctOptionIds, ["3"]);
        assert.deepEqual(akResult.answers.get(10).correctOptionIds, ["2"]);
        // 100(a)
        assert.deepEqual(akResult.answers.get(100).correctOptionIds, ["1"]);
    });

    await t.test("7. Mandatory Scored-Test Gate Reconciliation", () => {
        reconciled = AnswerKeyReconciliationService.reconcileAnswerKeys({
            questions: normResult.questions,
            answerMap: akResult.answers,
            sourceReference: "UPSC CSE Prelims 2026 Paper I Official Key",
            keyMetadata: akResult.keyMetadata
        });

        assert.equal(reconciled.gatePassed, true, "Scored-Test Gate must pass");
        assert.equal(reconciled.totalQuestions, 100);
        assert.equal(reconciled.verifiedCount, 100);
        assert.equal(reconciled.matchCoveragePercent, 100);
        assert.equal(reconciled.missingAnswers.length, 0);
        assert.equal(reconciled.conflicts.length, 0);
        assert.equal(reconciled.reconciledKeys.length, 100);

        // Content fidelity evaluation: 0 flagged questions
        const flagged = normResult.questions.filter(q => q.validationStatus === "flagged");
        assert.equal(flagged.length, 0, "No questions should have unresolved fidelity flags");
    });

    await t.test("8. Deterministic Examination Scoring (+2 correct, -2/3 incorrect, 0 unattempted)", () => {
        const questions = normResult.questions;
        const answerKeys = reconciled.reconciledKeys;

        // Scenario A: Perfect score (100 correct)
        const perfectAnswers = {};
        questions.forEach(q => {
            const key = answerKeys.find(k => k.questionId === q.questionId);
            perfectAnswers[q.questionId] = key.correctOptionIds[0];
        });

        const perfectScore = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: perfectAnswers,
            examConfig: { examId: "upsc-prelims" }
        });

        assert.equal(perfectScore.totalScore, 200, "100 correct answers must yield exactly 200 marks");
        assert.equal(perfectScore.correctCount, 100);
        assert.equal(perfectScore.incorrectCount, 0);
        assert.equal(perfectScore.unansweredCount, 0);

        // Scenario B: Realistic mix: 60 correct, 30 incorrect, 10 unattempted
        // Expected score: 60 * 2 = 120; penalty = 30 * (2/3) = 20; net score = 100.
        const mixedAnswers = {};
        for (let i = 0; i < 60; i++) {
            const q = questions[i];
            const key = answerKeys.find(k => k.questionId === q.questionId);
            mixedAnswers[q.questionId] = key.correctOptionIds[0];
        }
        for (let i = 60; i < 90; i++) {
            const q = questions[i];
            const key = answerKeys.find(k => k.questionId === q.questionId);
            const wrongOpt = q.options.find(o => o.id !== key.correctOptionIds[0]);
            mixedAnswers[q.questionId] = wrongOpt ? wrongOpt.id : "99";
        }

        const mixedScore = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: mixedAnswers,
            examConfig: { examId: "upsc-prelims" }
        });

        assert.equal(mixedScore.correctCount, 60);
        assert.equal(mixedScore.incorrectCount, 30);
        assert.equal(mixedScore.unansweredCount, 10);
        assert.ok(Math.abs(mixedScore.totalScore - 100) < 1e-6, `Score must be 100, got ${mixedScore.totalScore}`);

        // Scenario C: Negative score check: 0 correct, 3 incorrect, 97 unattempted
        // Expected: 0 - 3 * (2/3) = -2
        const penaltyAnswers = {};
        for (let i = 0; i < 3; i++) {
            const q = questions[i];
            const key = answerKeys.find(k => k.questionId === q.questionId);
            const wrongOpt = q.options.find(o => o.id !== key.correctOptionIds[0]);
            penaltyAnswers[q.questionId] = wrongOpt ? wrongOpt.id : "99";
        }

        const penaltyScore = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: penaltyAnswers,
            examConfig: { examId: "upsc-prelims" }
        });

        assert.equal(penaltyScore.correctCount, 0);
        assert.equal(penaltyScore.incorrectCount, 3);
        assert.equal(penaltyScore.unansweredCount, 97);
        assert.ok(Math.abs(penaltyScore.totalScore - (-2)) < 1e-6, `Score must be -2, got ${penaltyScore.totalScore}`);
    });

    await t.test("9. Full Automated Import Pipeline & Admin Publication Execution", async () => {
        const qpDoc = await StorageVaultService.storeDocument({
            buffer: qpBuf,
            originalFilename: "UPSC_Prelims_2026_Paper_I_Typed.pdf",
            docType: "question_paper"
        });
        const akDoc = await StorageVaultService.storeDocument({
            buffer: akBuf,
            originalFilename: "UPSC_Prelims_2026_Paper_I_Answer_Key.pdf",
            docType: "answer_key"
        });
        const epDoc = await StorageVaultService.storeDocument({
            buffer: epBuf,
            originalFilename: "UPSC_Prelims_2026_Paper_1_Pattern.pdf",
            docType: "exam_pattern"
        });

        const job = ImportJobPipelineService.createJob({
            examName: "UPSC Civil Services Preliminary 2026",
            examId: "upsc-prelims",
            year: 2026,
            paperType: "pyq",
            language: "English",
            paperCode: "A",
            actor: "admin_test"
        });

        await ImportJobPipelineService.attachDocuments(job.jobId, {
            questionPaper: qpDoc,
            answerKey: akDoc,
            examPattern: epDoc
        });

        const processedJob = await ImportJobPipelineService.runPipeline(job.jobId);

        assert.equal(processedJob.status, "ready_to_publish", "Job status must reach ready_to_publish");
        assert.equal(processedJob.extractedQuestionCount, 100);
        assert.equal(processedJob.verifiedAnswerCount, 100);
        assert.equal(processedJob.flaggedQuestionCount, 0);
        assert.equal(processedJob.validationReport.canPublish, true);
        assert.equal(processedJob.validationReport.blockers.length, 0);

        // Publish test through official workflow
        const publishResult = await ImportJobPipelineService.publishTest({
            jobId: job.jobId,
            actor: "admin_test"
        });

        assert.equal(publishResult.status, "published");
        assert.equal(publishResult.testId, "mock-upsc-prelims-2026-a");

        const updatedJob = await ImportJobPipelineService.getJob(job.jobId);
        assert.equal(updatedJob.status, "published");
    });
});

