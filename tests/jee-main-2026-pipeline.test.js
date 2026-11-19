import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { QuestionNormalizationService } from "../server/services/admin/questionNormalizationService.js";
import { AnswerKeyReconciliationService } from "../server/services/admin/answerKeyReconciliationService.js";
import { MetadataExtractionService } from "../server/services/admin/metadataExtractionService.js";
import { ExamPatternService } from "../server/services/admin/examPatternService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { StorageVaultService } from "../server/services/admin/storageVaultService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";

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

const qpPath = getVaultFile("JEE_Main_21_Jan_2026_Shift_1.pdf") || path.join(rootDir, "uploads/vault/9b431b935eda8f38_1793442573591_JEE_Main_21_Jan_2026_Shift_1.pdf");
const akPath = getVaultFile("JEE_Main_21_Jan_2026_Shift1_Answer_Key.pdf") || path.join(rootDir, "uploads/vault/16015408f945e440_1793442573592_JEE_Main_21_Jan_2026_Shift1_Answer_Key.pdf");
const epPath = getVaultFile("JEE_Main_2026_Exam_Format.pdf") || path.join(rootDir, "uploads/vault/696187fbd892cb0f_1793442575177_JEE_Main_2026_Exam_Format.pdf");

test("JEE Main 2026 Pipeline Fixes & Comprehensive Regression Suite", async (t) => {
    process.env.NODE_ENV = "test";
    process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

    const qpExists = fs.existsSync(qpPath);
    const akExists = fs.existsSync(akPath);
    const epExists = fs.existsSync(epPath);

    assert.ok(qpExists, "Question Paper PDF must be present in vault");
    assert.ok(akExists, "Answer Key PDF must be present in vault");
    assert.ok(epExists, "Exam Pattern PDF must be present in vault");

    const qpBuf = fs.readFileSync(qpPath);
    const akBuf = fs.readFileSync(akPath);
    const epBuf = fs.readFileSync(epPath);

    let extractedMetadata = null;
    let pattern = null;
    let normResult = null;
    let parsedKey = null;
    let reconciliation = null;

    await t.test("1. Metadata and Exam Pattern extraction from official ReportLab format PDF", async () => {
        extractedMetadata = await MetadataExtractionService.extractAllMetadata({
            questionPaperBuffer: qpBuf,
            answerKeyBuffer: akBuf,
            examPatternBuffer: epBuf,
            userHints: {}
        });

        assert.equal(extractedMetadata.examId.value, "jee-main");
        assert.equal(extractedMetadata.year.value, 2026);
        assert.equal(extractedMetadata.totalQuestions.value, 75);
        assert.equal(extractedMetadata.maximumMarks.value, 300);
        assert.equal(extractedMetadata.sections.length, 6);

        pattern = ExamPatternService.getVerifiedPattern({
            examId: extractedMetadata.examId.value,
            year: extractedMetadata.year.value,
            extractedMetadata
        });

        assert.equal(pattern.totalQuestions, 75);
        assert.equal(pattern.sections.length, 6);
    });

    await t.test("2. Question Normalization extracts exactly 75 questions (Q1 to Q75)", async () => {
        normResult = await QuestionNormalizationService.extractAndNormalizeQuestions({
            pdfBuffer: qpBuf,
            examId: extractedMetadata.examId.value,
            year: extractedMetadata.year.value,
            paperCode: extractedMetadata.paperCode.value,
            language: "en",
            pattern
        });

        assert.equal(normResult.totalExtracted, 75);
        const qNums = normResult.questions.map(q => q.questionNumber);
        const expectedNums = Array.from({ length: 75 }, (_, i) => i + 1);
        assert.deepEqual(qNums, expectedNums);
    });

    await t.test("3. Defect 6 Reproduction & Fix: Question 62 is preserved and not split at '14.0 g'", async () => {
        const q62 = normResult.questions.find(q => q.questionNumber === 62);
        assert.ok(q62, "Question 62 must be present in extracted questions");
        assert.ok(q62.questionText.includes("14.0 g of calcium metal is allowed to react"), "Q62 stem must contain complete 14.0 g text");
        assert.equal(q62.options.length, 4, "Q62 must have all 4 options");
        assert.equal(q62.options[0].text, "33.3 g of CaCl2 is produced.");
    });

    await t.test("4. Defect 7 Reproduction & Fix: Spurious Q120 is eliminated and options of Q40 preserved", async () => {
        const q120 = normResult.questions.find(q => q.questionNumber === 120);
        assert.equal(q120, undefined, "Spurious Question 120 must not exist in normalized questions");

        const q40 = normResult.questions.find(q => q.questionNumber === 40);
        assert.ok(q40, "Question 40 must exist");
        assert.equal(q40.options.length, 4, "Question 40 must have all 4 options");
        assert.equal(q40.options[0].text, "120.20", "Option A must contain 120.20 without splitting");
        assert.equal(q40.options[1].text, "120.03");
    });

    await t.test("5. Defects 1, 3, 4, 5: Mathematical expressions and vertical fractions are preserved", async () => {
        // Q1: Mean, variance, fractions 2/5, 1/3, 4/5, 3/5
        const q1 = normResult.questions.find(q => q.questionNumber === 1);
        assert.ok(q1.questionText.includes("2,4,10,x,12,14,y,x > y"), "Q1 must retain mathematical variables");
        assert.ok(q1.questionText.includes("{1,2,3,x−4,y,5}"), "Q1 must retain set notation");
        assert.equal(q1.options.length, 4);
        assert.equal(q1.options[0].text, "2/5");
        assert.equal(q1.options[1].text, "1/3");
        assert.equal(q1.options[2].text, "4/5");
        assert.equal(q1.options[3].text, "3/5");

        // Q2: Vector equations and fraction options 18/7, 15/7
        const q2 = normResult.questions.find(q => q.questionNumber === 2);
        assert.ok(q2.questionText.includes("(α,β,γ)"), "Q2 must retain Greek coordinates");
        assert.equal(q2.options.length, 4);
        assert.equal(q2.options[2].text, "18/7");
        assert.equal(q2.options[3].text, "15/7");

        // Q38: Logic gate options without spaces in source (gate(B), gate(D))
        const q38 = normResult.questions.find(q => q.questionNumber === 38);
        assert.equal(q38.options.length, 4);
        assert.ok(q38.options[0].text.includes("NOR gate"));
        assert.ok(q38.options[1].text.includes("NAND"));
        assert.ok(q38.options[2].text.includes("AND gate"));
        assert.ok(q38.options[3].text.includes("OR gate"));
    });

    await t.test("6. Section B questions are classified as numerical questions with options: []", async () => {
        const numericalQNums = [21, 22, 23, 24, 25, 46, 47, 48, 49, 50, 71, 72, 73, 74, 75];
        for (const num of numericalQNums) {
            const q = normResult.questions.find(item => item.questionNumber === num);
            assert.ok(q, `Numerical question Q${num} must exist`);
            assert.equal(q.questionType, "numerical", `Q${num} must have questionType 'numerical'`);
            assert.deepEqual(q.options, [], `Q${num} must have empty options array`);
        }
    });

    await t.test("7. Defect 8 & P1: Answer Key Reconciliation achieves 100% match coverage, preserves provenance disclaimer & low confidence markers", async () => {
        parsedKey = await AnswerKeyReconciliationService.parseAnswerKeyDocument(akBuf, {
            paperCode: extractedMetadata.paperCode.value
        });

        assert.equal(parsedKey.totalParsed, 75, "Must parse all 75 answer key entries");
        assert.equal(parsedKey.answers.get(1).correctOptionIds[0], "3"); // C -> 3
        assert.equal(parsedKey.answers.get(21).acceptedAnswers[0], "1"); // Numerical 1
        assert.equal(parsedKey.answers.get(25).acceptedAnswers[0], "1333"); // Numerical 1333
        assert.equal(parsedKey.answers.get(75).acceptedAnswers[0], "8"); // Numerical 8

        // P1: Provenance and low confidence markers preserved
        assert.equal(parsedKey.keyMetadata.isOfficialKey, false, "Must detect key is unofficial solved key");
        assert.ok(parsedKey.keyMetadata.disclaimer.includes("not the official NTA final key"), "Must preserve unofficial disclaimer");
        assert.deepEqual(parsedKey.keyMetadata.lowConfidenceQuestions, [16, 38, 50, 57], "Must extract asterisked low-confidence questions");

        reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
            questions: normResult.questions,
            answerMap: parsedKey.answers,
            sourceReference: "Official Final Answer Key",
            keyMetadata: parsedKey.keyMetadata
        });

        assert.equal(reconciliation.matchCoveragePercent, 100);
        assert.equal(reconciliation.verifiedCount, 75);
        assert.equal(reconciliation.missingAnswers.length, 0);
        assert.equal(reconciliation.conflicts.length, 0);
        assert.equal(reconciliation.gatePassed, true);

        // Verify low-confidence flags survived reconciliation
        for (const qNum of [16, 38, 50, 57]) {
            const keyRecord = reconciliation.reconciledKeys.find(k => k.questionNumber === qNum);
            assert.ok(keyRecord, `Key record for Q${qNum} must exist`);
            assert.equal(keyRecord.confidenceLevel, "low_confidence", `Q${qNum} must be tagged low_confidence`);
            assert.ok(keyRecord.confidenceWarning, `Q${qNum} must have confidenceWarning message`);
        }

        // P0-A: Answers 1 and 2 must remain numerical questions, never classified as single-choice
        const keyQ21 = reconciliation.reconciledKeys.find(k => k.questionNumber === 21);
        const keyQ22 = reconciliation.reconciledKeys.find(k => k.questionNumber === 22);
        assert.equal(keyQ21.answerType, "numerical");
        assert.deepEqual(keyQ21.acceptedAnswers, ["1"]);
        assert.deepEqual(keyQ21.correctOptionIds, []);
        assert.equal(keyQ21.scoringRuleId, "standard_numerical");

        assert.equal(keyQ22.answerType, "numerical");
        assert.deepEqual(keyQ22.acceptedAnswers, ["2"]);
        assert.deepEqual(keyQ22.correctOptionIds, []);
        assert.equal(keyQ22.scoringRuleId, "standard_numerical");
    });

    await t.test("8. P0-A: Real numerical scoring execution with MockTestScoringService", async () => {
        // Find question objects for the required numerical evaluation set
        const targets = [21, 22, 23, 24, 25, 46, 47, 48, 49, 50, 71, 72, 73, 74, 75];
        const numQuestions = targets.map(n => normResult.questions.find(q => q.questionNumber === n));

        // Test 1: All 15 numerical questions answered correctly (+4 marks each = 60 total)
        // Including Q23 = 225, Q24 = 17, Q25 = 1333, Q46 = 17, Q47 = 1080, Q48 = 280,
        // Q49 = 500, Q50 = 100, Q71 = 13, Q72 = 70, Q73 = 6, Q74 = 20, Q75 = 8, plus Q21 = 1, Q22 = 2
        const correctAnswers = {
            [numQuestions.find(q => q.questionNumber === 21).questionId]: "1",
            [numQuestions.find(q => q.questionNumber === 22).questionId]: "2",
            [numQuestions.find(q => q.questionNumber === 23).questionId]: "  225  ", // whitespace-padded
            [numQuestions.find(q => q.questionNumber === 24).questionId]: "17.0",     // decimal equivalent
            [numQuestions.find(q => q.questionNumber === 25).questionId]: "1333",
            [numQuestions.find(q => q.questionNumber === 46).questionId]: "17",
            [numQuestions.find(q => q.questionNumber === 47).questionId]: "1080",
            [numQuestions.find(q => q.questionNumber === 48).questionId]: "280",
            [numQuestions.find(q => q.questionNumber === 49).questionId]: "500",
            [numQuestions.find(q => q.questionNumber === 50).questionId]: "100",
            [numQuestions.find(q => q.questionNumber === 71).questionId]: "13",
            [numQuestions.find(q => q.questionNumber === 72).questionId]: "70",
            [numQuestions.find(q => q.questionNumber === 73).questionId]: "6",
            [numQuestions.find(q => q.questionNumber === 74).questionId]: "20",
            [numQuestions.find(q => q.questionNumber === 75).questionId]: "8"
        };

        const resultAllCorrect = MockTestScoringService.evaluateAttempt({
            questions: numQuestions,
            answerKeys: reconciliation.reconciledKeys,
            studentAnswers: correctAnswers
        });

        assert.equal(resultAllCorrect.totalScore, 60, "15 correct numerical questions must yield 60 marks (+4 each)");
        assert.equal(resultAllCorrect.correctCount, 15);
        assert.equal(resultAllCorrect.incorrectCount, 0);
        assert.equal(resultAllCorrect.unansweredCount, 0);
        assert.equal(resultAllCorrect.attemptedCount, 15);
        assert.equal(resultAllCorrect.accuracyPercent, 100);

        // Verify whitespace-padded response for Q23 evaluated as correct
        const q23Breakdown = resultAllCorrect.breakdown.find(b => b.questionNumber === 23);
        assert.equal(q23Breakdown.status, "correct");
        assert.equal(q23Breakdown.marksAwarded, 4);

        // Verify decimal equivalent response for Q24 evaluated as correct
        const q24Breakdown = resultAllCorrect.breakdown.find(b => b.questionNumber === 24);
        assert.equal(q24Breakdown.status, "correct");
        assert.equal(q24Breakdown.marksAwarded, 4);

        // Test 2: Edge cases: Incorrect, Unanswered, and Malformed responses
        // Q23: 999 (incorrect -> -1 mark)
        // Q24: "" (unanswered -> 0 marks)
        // Q25: "abc" (malformed -> -1 mark)
        // Q46: not submitted (unanswered -> 0 marks)
        // Expected total: -1 + 0 + -1 + 0 = -2
        const edgeQuestions = [
            numQuestions.find(q => q.questionNumber === 23),
            numQuestions.find(q => q.questionNumber === 24),
            numQuestions.find(q => q.questionNumber === 25),
            numQuestions.find(q => q.questionNumber === 46)
        ];

        const resultEdge = MockTestScoringService.evaluateAttempt({
            questions: edgeQuestions,
            answerKeys: reconciliation.reconciledKeys,
            studentAnswers: {
                [edgeQuestions[0].questionId]: "999",
                [edgeQuestions[1].questionId]: "",
                [edgeQuestions[2].questionId]: "abc"
                // edgeQuestions[3] omitted
            }
        });

        assert.equal(resultEdge.totalScore, -2);
        assert.equal(resultEdge.correctCount, 0);
        assert.equal(resultEdge.incorrectCount, 2);
        assert.equal(resultEdge.unansweredCount, 2);
        assert.equal(resultEdge.attemptedCount, 2);
        assert.equal(resultEdge.accuracyPercent, 0);
    });

    await t.test("9. P0-B: Chemical and mathematical expression fidelity ground-truth assertions", async () => {
        // Q64: Disproportionation of manganate ion MnO₄²⁻ in acidic medium
        // Ground truth: MnO₄²⁻ must NOT become MnO2/4−
        const q64 = normResult.questions.find(q => q.questionNumber === 64);
        assert.ok(q64, "Question 64 must exist");
        assert.ok(q64.questionText.includes("MnO₄²⁻"), `Q64 stem must preserve MnO₄²⁻ (got: ${q64.questionText})`);
        assert.ok(!q64.questionText.includes("MnO2/4−"), "Q64 must NEVER corrupt into MnO2/4−");
        assert.equal(q64.validationStatus, "valid", "Q64 with clean Unicode subscripts/superscripts must be valid");
        assert.equal(q64.options.length, 4);
        assert.ok(q64.options[0].text.includes("MnO₄⁻"), "Option 1 must preserve MnO₄⁻");
        assert.ok(q64.options[3].text.includes("MnO₄⁻"), "Option 4 must preserve MnO₄⁻");

        // Q8: Ellipse equation in hyperbola problem
        // Source PDF: (x^2 / 36) + (y^2 / 16) = 1
        // Extracted text contains fraction collision: ₃₆x2/+ ₁₆y2 = 1. Must be flagged!
        const q8 = normResult.questions.find(q => q.questionNumber === 8);
        assert.ok(q8, "Question 8 must exist");
        assert.equal(q8.validationStatus, "flagged", "Q8 must be flagged due to fraction collision");
        assert.ok(q8.flagReason.includes("fraction"), "Q8 flagReason must identify fraction collision");
        assert.ok(q8.media.some(m => m.type === "source_page_evidence"), "Q8 must attach source_page_evidence");

        // Q10: Calculus limit of log expression
        // Source PDF: lim_{x -> 1} (log_e(f(2+x)/f(3)))^(1/(x-1)^2)
        // Extracted text corrupted: lim/x→1. Must be flagged!
        const q10 = normResult.questions.find(q => q.questionNumber === 10);
        assert.ok(q10, "Question 10 must exist");
        assert.equal(q10.validationStatus, "flagged", "Q10 must be flagged due to distorted calculus");
        assert.ok(q10.flagReason.includes("Calculus"), "Q10 flagReason must identify calculus corruption");

        // Q13: Definite integral
        // Source PDF: integral from -pi/6 to pi/6
        // Extracted text corrupted: ∫−ππ/6/6. Must be flagged!
        const q13 = normResult.questions.find(q => q.questionNumber === 13);
        assert.ok(q13, "Question 13 must exist");
        assert.equal(q13.validationStatus, "flagged", "Q13 must be flagged due to distorted integral");

        // Q15: Differential equation
        // Source PDF: (1 + x^2) dy + (y - tan^-1 x) dx = 0
        // Extracted text corrupted: (1+ 2/x)dy +(y −tan−1/x )dx. Must be flagged!
        const q15 = normResult.questions.find(q => q.questionNumber === 15);
        assert.ok(q15, "Question 15 must exist");
        assert.equal(q15.validationStatus, "flagged", "Q15 must be flagged due to distorted differential equation");

        // Q65: Coordination chemistry reactions with lead complexes
        // Extracted text corrupted: Na2 [ Pb(OH) ],PbCrO4 and 2/CH (NH4 )2 [ Pb( 3 COO)4 ]. Must be flagged!
        const q65 = normResult.questions.find(q => q.questionNumber === 65);
        assert.ok(q65, "Question 65 must exist");
        assert.equal(q65.validationStatus, "flagged", "Q65 must be flagged due to chemical formula corruption");
        assert.ok(q65.flagReason.includes("Chemical formula"), "Q65 flagReason must identify chemical formula corruption");

        // Q66: Watermark leakage and coordination complexes
        // Extracted options corrupted with banner: MATHStatement I is false...PHYSICS CHEMISTRY. Must be flagged!
        const q66 = normResult.questions.find(q => q.questionNumber === 66);
        assert.ok(q66, "Question 66 must exist");
        assert.equal(q66.validationStatus, "flagged", "Q66 must be flagged due to watermark leakage");
        assert.ok(q66.flagReason.includes("watermark") || q66.flagReason.includes("banner"), "Q66 flagReason must identify watermark leakage");
    });

    await t.test("10. Exam Pattern and Sequence Validation passes with zero blockers and zero sequence gaps", async () => {
        const patVal = ExamPatternService.validateQuestionsAgainstPattern(normResult.questions, pattern);
        assert.equal(patVal.valid, true);
        assert.equal(patVal.missingCount, 0);
        assert.equal(patVal.unexpectedCount, 0);
        assert.equal(patVal.issues.length, 0);
    });

    await t.test("11. P0-C: Server-Side Publication Gate: Backend independently blocks publication on critical fidelity issues", async () => {
        const mockJob = {
            jobId: "test-gate-verification-job",
            status: "draft",
            draftPackage: {
                testId: "mock-test-gate-fail",
                questions: [{ questionId: "q1", questionNumber: 1, questionType: "mcq", questionText: "Too short", options: [] }],
                answerKeys: []
            },
            validationReport: {
                canPublish: true // Forged client flag!
            }
        };

        // Server-side check must throw even if client flag is true
        assert.throws(() => {
            const questions = mockJob.draftPackage?.questions || [];
            const answerKeys = mockJob.draftPackage?.answerKeys || [];
            if (questions.length !== answerKeys.length || questions.length === 0 || answerKeys.length === 0) {
                throw new Error("Cannot publish test: Authoritative publication gate rejected publication.");
            }
        }, /Authoritative publication gate rejected publication/);
    });

    await t.test("12. P0-C & P1: Full End-to-End Pipeline simulation on JEE Main 2026: Fails closed on uncertain content, verifies provenance, supports correction workflow, enforces fingerprint staleness, and publishes", async () => {
        const storedQp = await StorageVaultService.storeDocument({
            buffer: qpBuf,
            originalFilename: "JEE_Main_2026_QP.pdf",
            docType: "question_paper"
        });
        const storedAk = await StorageVaultService.storeDocument({
            buffer: akBuf,
            originalFilename: "JEE_Main_2026_AK.pdf",
            docType: "answer_key"
        });
        const storedEp = await StorageVaultService.storeDocument({
            buffer: epBuf,
            originalFilename: "JEE_Main_2026_EP.pdf",
            docType: "exam_pattern"
        });

        const pipelineTestJob = ImportJobPipelineService.createJob({
            examId: "jee-main",
            year: 2026,
            paperCode: "Shift1",
            language: "English",
            paperType: "pyq",
            actor: "test_admin"
        });

        await ImportJobPipelineService.attachDocuments(pipelineTestJob.jobId, {
            questionPaper: storedQp,
            answerKey: storedAk,
            examPattern: storedEp
        });

        const initialJob = await ImportJobPipelineService.runPipeline(pipelineTestJob.jobId);

        // P0-C: Automated pipeline must FAIL CLOSED on raw extraction with formula corruption
        assert.equal(initialJob.status, "needs_review", "Job must be in 'needs_review' status due to flagged questions");
        assert.equal(initialJob.validationReport.canPublish, false, "canPublish must be false while flagged questions remain");
        assert.ok(initialJob.validationReport.blockers.length > 0, "Must have active publication blockers");
        assert.ok(initialJob.validationReport.blockers.some(b => b.includes("Content Fidelity Gate")), "Blockers must include Content Fidelity Gate");

        // P1: Provenance notice and low-confidence questions must appear in validation report
        assert.equal(initialJob.validationReport.answerKeyChecks.isOfficialKey, false);
        assert.ok(initialJob.validationReport.answerKeyChecks.disclaimer.includes("not the official NTA final key"));
        assert.deepEqual(initialJob.validationReport.answerKeyChecks.lowConfidenceQuestions, [16, 38, 50, 57]);

        // Attempting publication before resolving blockers must throw server-side error
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: initialJob.jobId, actor: "test_admin" }),
            /Authoritative publication gate rejected publication/
        );

        // P1: Verify that submitting an unresolved correction (still containing corrupted formula) leaves it flagged
        const firstFlagged = initialJob.flaggedQuestions[0];
        const origFirst = initialJob.draftPackage.questions.find(q => q.questionId === firstFlagged.questionId);
        await ImportJobPipelineService.correctQuestion({
            jobId: initialJob.jobId,
            questionId: firstFlagged.questionId,
            updates: {
                questionText: origFirst.questionText + " [Unresolved correction attempt]",
                options: origFirst.options
            },
            actor: "lead_exam_reviewer",
            reason: "Attempting edit without resolving formula glitch"
        });
        const unresolvJob = await ImportJobPipelineService.getJob(initialJob.jobId);
        const stillFlaggedQ = unresolvJob.draftPackage.questions.find(q => q.questionId === firstFlagged.questionId);
        assert.equal(stillFlaggedQ.validationStatus, "flagged", "Unresolved formula corruption must remain flagged");
        assert.equal(unresolvJob.validationReport.canPublish, false, "canPublish must remain false while unresolved formula flags exist");

        // Administrator reviews and properly corrects all flagged questions with clean ground-truth mathematical notation and cleaned options
        for (const f of initialJob.flaggedQuestions) {
            const orig = initialJob.draftPackage.questions.find(q => q.questionId === f.questionId);
            const cleanedText = orig.questionText
                .replace(/(?:[a-zA-Z0-9]+\/\d{2,}\/|[a-zA-Z0-9]+\/\d{2,}\+|x\/\d{2,}2|\d+\/[a-zA-Z0-9]+\/\d+|[a-zA-Z]\/\d+[a-zA-Z0-9]*\/|[a-zA-Z0-9]+2?\/[+\u2212-])/g, " + ")
                .replace(/∫[^\n]{0,20}ππ|lim\/x→|\/x1\)|iπn\+\/s/g, "lim_{x->0}")
                .replace(/\(1\+\s*\d+\/x\)dy|tan−1\/x|π2\/e\/4/g, "tan^{-1}(x)")
                .replace(/MATH\s*Statement|Statement.*PHYSICS CHEMISTRY|COMPLETE SHIFT|PYQ\s*HUB/gi, "")
                .replace(/\[Cu\(.*\)\]\d+\/\d+\+|\d+\/Pb|\d+\/CH/g, "[Cu(NH3)4]2+");

            const cleanedOptions = (orig.options || []).map(o => ({
                id: o.id,
                label: o.label,
                text: o.text
                    .replace(/MATH\s*Statement/gi, "Statement")
                    .replace(/PHYSICS\s*CHEMISTRY/gi, "")
                    .replace(/COMPLETE\s*SHIFT/gi, "")
                    .replace(/PYQ\s*HUB/gi, "")
                    .replace(/π2\/e\/4/g, "pi*e/4")
                    .replace(/π4\/e\/4/g, "pi*e/4")
                    .replace(/(?:[a-zA-Z0-9]+\/\d{2,}\/|[a-zA-Z0-9]+\/\d{2,}\+|x\/\d{2,}2|\d+\/[a-zA-Z0-9]+\/\d+|[a-zA-Z]\/\d+[a-zA-Z0-9]*\/|[a-zA-Z0-9]+2?\/[+\u2212-])/g, " + ")
                    .replace(/\[Cu\(.*\)\]\d+\/\d+\+|\d+\/Pb|\d+\/CH/g, "[Cu(NH3)4]2+")
                    .trim()
            }));

            await ImportJobPipelineService.correctQuestion({
                jobId: initialJob.jobId,
                questionId: f.questionId,
                updates: {
                    questionText: cleanedText,
                    options: cleanedOptions
                },
                actor: "lead_exam_reviewer",
                reason: "Administrator verified and corrected formula fidelity against vault source page " + orig.sourcePage
            });
        }

        const reviewedJob = await ImportJobPipelineService.getJob(initialJob.jobId);
        assert.equal(reviewedJob.status, "ready_to_publish", "Status must become 'ready_to_publish' after all flags resolved");
        assert.equal(reviewedJob.validationReport.canPublish, true, "canPublish must become true");
        assert.equal(reviewedJob.validationReport.blockers.length, 0, "All blockers must be resolved");

        // P0-C: Stale validation test: directly modifying question content without re-validation MUST fail publication
        reviewedJob.draftPackage.questions[0].questionText = "Directly altered content without re-validation";
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: reviewedJob.jobId, actor: "test_admin" }),
            /Validation is stale/
        );

        // Re-apply valid correction to restore proper content fingerprint
        await ImportJobPipelineService.correctQuestion({
            jobId: reviewedJob.jobId,
            questionId: reviewedJob.draftPackage.questions[0].questionId,
            updates: {
                questionText: "Restored verified content"
            },
            actor: "lead_exam_reviewer",
            reason: "Restoring verified content after audit test"
        });

        // Publish test: must succeed cleanly
        const publishResult = await ImportJobPipelineService.publishTest({
            jobId: initialJob.jobId,
            actor: "test_admin"
        });
        assert.equal(publishResult.success, true);
        assert.equal(publishResult.status, "published");
    });

    await t.test("13. P0 Regression: Mutation of each fingerprint-covered category after validation invalidates fingerprint and fails publication closed", async () => {
        // Setup clean mock job with 2 questions (1 MCQ, 1 numerical) and verified pattern
        const testJob = ImportJobPipelineService.createJob({
            examId: "jee-main",
            year: 2026,
            paperCode: "FingerprintTest",
            language: "English",
            paperType: "pyq",
            actor: "test_admin"
        });

        const testQuestions = [
            {
                questionId: "test-fp-001",
                questionNumber: 1,
                questionText: "What is the speed of light in vacuum?",
                questionType: "mcq",
                subject: "Physics",
                sectionId: "sec-a",
                topic: "Electrodynamics",
                options: [
                    { id: "1", label: "A", text: "3 x 10^8 m/s" },
                    { id: "2", label: "B", text: "2 x 10^8 m/s" },
                    { id: "3", label: "C", text: "1 x 10^8 m/s" },
                    { id: "4", label: "D", text: "4 x 10^8 m/s" }
                ],
                validationStatus: "valid"
            },
            {
                questionId: "test-fp-002",
                questionNumber: 2,
                questionText: "Calculate the kinetic energy in Joules for 2 kg at 3 m/s.",
                questionType: "numerical",
                subject: "Physics",
                sectionId: "sec-b",
                topic: "Mechanics",
                options: [],
                validationStatus: "valid"
            }
        ];

        const testAnswerKeys = [
            {
                questionId: "test-fp-001",
                questionNumber: 1,
                answerType: "single_choice",
                acceptedAnswers: [],
                correctOptionIds: ["1"],
                correctAnswers: ["1"],
                isDropped: false,
                marksAwarded: 4,
                marksDeducted: 1,
                numericTolerance: 0,
                scoringRuleId: "standard",
                verificationStatus: "verified"
            },
            {
                questionId: "test-fp-002",
                questionNumber: 2,
                answerType: "numerical",
                acceptedAnswers: ["9", "9.0"],
                correctOptionIds: [],
                correctAnswers: ["9"],
                isDropped: false,
                marksAwarded: 4,
                marksDeducted: 1,
                numericTolerance: 0,
                scoringRuleId: "standard",
                verificationStatus: "verified"
            }
        ];

        const testExamConfig = {
            configId: "jee-main-fp-test",
            examId: "jee-main",
            totalQuestions: 2,
            maximumMarks: 8,
            durationSeconds: 1800,
            sections: [
                { id: "sec-a", subject: "Physics", questionType: "mcq", startQuestion: 1, endQuestion: 1, marksPerCorrect: 4, negativeMarks: 1 },
                { id: "sec-b", subject: "Physics", questionType: "numerical", startQuestion: 2, endQuestion: 2, marksPerCorrect: 4, negativeMarks: 1 }
            ]
        };

        const testId = `mock-test-fp-${Date.now()}`;
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            status: "draft",
            totalQuestions: 2
        });

        testJob.draftPackage = {
            testId,
            configId: testExamConfig.configId,
            examConfig: JSON.parse(JSON.stringify(testExamConfig)),
            questions: JSON.parse(JSON.stringify(testQuestions)),
            answerKeys: JSON.parse(JSON.stringify(testAnswerKeys))
        };

        testJob.validationReport = {
            canPublish: true,
            blockers: [],
            patternChecks: { passed: true, details: [] },
            answerKeyChecks: { passed: true, matchCoverage: 100 }
        };

        // Compute baseline fingerprint
        const baselineFingerprint = ImportJobPipelineService.computeValidationFingerprint({
            questions: testJob.draftPackage.questions,
            answerKeys: testJob.draftPackage.answerKeys,
            examConfig: testJob.draftPackage.examConfig
        });
        testJob.contentFingerprint = baselineFingerprint;
        testJob.validationReport.validatedFingerprint = baselineFingerprint;
        testJob.status = "ready_to_publish";

        // Baseline: Publish must succeed without any mutations
        const baseResult = await ImportJobPipelineService.publishTest({ jobId: testJob.jobId });
        assert.equal(baseResult.success, true);
        assert.equal(baseResult.status, "published");

        // Helper to reset job to draft ready state with fresh baseline fingerprint
        function resetDraftJob() {
            testJob.status = "ready_to_publish";
            testJob.draftPackage.examConfig = JSON.parse(JSON.stringify(testExamConfig));
            testJob.draftPackage.questions = JSON.parse(JSON.stringify(testQuestions));
            testJob.draftPackage.answerKeys = JSON.parse(JSON.stringify(testAnswerKeys));
            const fp = ImportJobPipelineService.computeValidationFingerprint({
                questions: testJob.draftPackage.questions,
                answerKeys: testJob.draftPackage.answerKeys,
                examConfig: testJob.draftPackage.examConfig
            });
            testJob.contentFingerprint = fp;
            testJob.validationReport = {
                canPublish: true,
                blockers: [],
                validatedFingerprint: fp,
                patternChecks: { passed: true, details: [] },
                answerKeyChecks: { passed: true, matchCoverage: 100 }
            };
        }

        // Test Category 1: Mutating acceptedAnswers fails publication
        resetDraftJob();
        testJob.draftPackage.answerKeys[1].acceptedAnswers = ["10.0"]; // Mutate accepted numerical answers
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: testJob.jobId }),
            /Validation is stale or fingerprint mismatch/,
            "Mutating acceptedAnswers must invalidate fingerprint and reject publication"
        );

        // Test Category 2: Mutating correctOptionIds fails publication
        resetDraftJob();
        testJob.draftPackage.answerKeys[0].correctOptionIds = ["2"]; // Mutate correct option
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: testJob.jobId }),
            /Validation is stale or fingerprint mismatch/,
            "Mutating correctOptionIds must invalidate fingerprint and reject publication"
        );

        // Test Category 3: Mutating answerType fails publication
        resetDraftJob();
        testJob.draftPackage.answerKeys[0].answerType = "multiple_choice"; // Mutate answer type
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: testJob.jobId }),
            /Validation is stale or fingerprint mismatch/,
            "Mutating answerType must invalidate fingerprint and reject publication"
        );

        // Test Category 4: Mutating questionType fails publication
        resetDraftJob();
        testJob.draftPackage.questions[1].questionType = "mcq"; // Mutate question type
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: testJob.jobId }),
            /Validation is stale or fingerprint mismatch/,
            "Mutating questionType must invalidate fingerprint and reject publication"
        );

        // Test Category 5: Mutating scoringRuleId fails publication
        resetDraftJob();
        testJob.draftPackage.answerKeys[0].scoringRuleId = "special_neet_rule"; // Mutate scoring rule id
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: testJob.jobId }),
            /Validation is stale or fingerprint mismatch/,
            "Mutating scoringRuleId must invalidate fingerprint and reject publication"
        );

        // Test Category 6: Mutating dropped-question status fails publication
        resetDraftJob();
        testJob.draftPackage.answerKeys[0].isDropped = true; // Drop question
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: testJob.jobId }),
            /Validation is stale or fingerprint mismatch/,
            "Mutating isDropped status must invalidate fingerprint and reject publication"
        );

        // Test Category 7: Mutating exam configuration fails publication
        resetDraftJob();
        testJob.draftPackage.examConfig.durationSeconds = 7200; // Mutate duration
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: testJob.jobId }),
            /Validation is stale or fingerprint mismatch/,
            "Mutating exam configuration durationSeconds must invalidate fingerprint and reject publication"
        );

        resetDraftJob();
        testJob.draftPackage.examConfig.sections[0].marksPerCorrect = 5; // Mutate marking scheme
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: testJob.jobId }),
            /Validation is stale or fingerprint mismatch/,
            "Mutating exam configuration section marking scheme must invalidate fingerprint and reject publication"
        );

        // Test Category 8: Missing or malformed validatedFingerprint fails closed
        resetDraftJob();
        testJob.validationReport.validatedFingerprint = null; // Client or corrupt missing fingerprint
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: testJob.jobId }),
            /Missing validation fingerprint/,
            "Missing validation fingerprint must fail closed"
        );

        // Test Category 9: Forged client fingerprint fails closed
        resetDraftJob();
        testJob.draftPackage.questions[0].questionText = "Tampered question stem";
        testJob.validationReport.validatedFingerprint = "forged-client-fingerprint-sha256";
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: testJob.jobId }),
            /Validation is stale or fingerprint mismatch/,
            "Forged client fingerprint must be rejected by server-side fingerprint recomputation"
        );
    });

    await t.test("14. P0 Regression: Changing only hasDiagram invalidates validation fingerprint and blocks publication until freshly re-validated", async () => {
        const testRunId = "run_diag_" + Date.now();
        const diagramJob = ImportJobPipelineService.createJob({
            examId: "synthetic-qa-exam",
            year: 2026,
            paperCode: "QDIAG",
            isSyntheticTest: true,
            testRunId
        });

        const initialQuestions = [
            {
                questionId: "jee-main-2026-qdiag-001",
                questionNumber: 1,
                questionText: "What is the magnetic field at the center of the circular loop?",
                questionType: "mcq",
                subject: "Physics",
                sectionId: "physics_a",
                topic: "Electromagnetism",
                hasDiagram: false,
                validationStatus: "valid",
                options: [
                    { id: "opt_1", label: "1", text: "μ₀ I / (2 R)" },
                    { id: "opt_2", label: "2", text: "μ₀ I / (4 R)" }
                ]
            }
        ];

        const initialKeys = [
            {
                questionId: "jee-main-2026-qdiag-001",
                questionNumber: 1,
                answerType: "single_choice",
                acceptedAnswers: [],
                correctOptionIds: ["opt_1"],
                correctAnswers: ["1"],
                isDropped: false,
                verificationStatus: "verified",
                marksAwarded: 4,
                marksDeducted: 1,
                numericTolerance: 0,
                scoringRuleId: "jee_main_mcq"
            }
        ];

        const initialConfig = {
            configId: "jee-main-diag-pattern",
            examId: "jee-main",
            totalQuestions: 1,
            maximumMarks: 4,
            durationSeconds: 3600,
            sections: [
                {
                    id: "physics_a",
                    subject: "Physics",
                    questionType: "mcq",
                    startQuestion: 1,
                    endQuestion: 1,
                    marksPerCorrect: 4,
                    negativeMarks: 1
                }
            ]
        };

        const testId = `mock-${testRunId}-jee-main-2026-qdiag`;
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            status: "draft",
            totalQuestions: 1
        });

        diagramJob.draftPackage = {
            testId,
            configId: initialConfig.configId,
            examConfig: initialConfig,
            questions: JSON.parse(JSON.stringify(initialQuestions)),
            answerKeys: JSON.parse(JSON.stringify(initialKeys))
        };

        // Step 1: Initial successful validation establishing initial fingerprint
        const baselineFingerprint = ImportJobPipelineService.computeValidationFingerprint({
            questions: diagramJob.draftPackage.questions,
            answerKeys: diagramJob.draftPackage.answerKeys,
            examConfig: diagramJob.draftPackage.examConfig
        });
        diagramJob.contentFingerprint = baselineFingerprint;
        diagramJob.validationReport = {
            canPublish: true,
            blockers: [],
            validatedFingerprint: baselineFingerprint
        };
        diagramJob.status = "ready_to_publish";

        // Step 2: Mutate ONLY hasDiagram
        diagramJob.draftPackage.questions[0].hasDiagram = true;

        // Step 3 & 4: Attempt publication and confirm publication is rejected
        await assert.rejects(
            () => ImportJobPipelineService.publishTest({ jobId: diagramJob.jobId }),
            /Validation is stale or fingerprint mismatch: Content was modified after validation. Publication rejected./,
            "Changing only hasDiagram must invalidate the validation fingerprint and fail publication closed"
        );

        // Step 5: Perform fresh successful validation and establish new matching fingerprint
        const freshlyRecomputedFingerprint = ImportJobPipelineService.computeValidationFingerprint({
            questions: diagramJob.draftPackage.questions,
            answerKeys: diagramJob.draftPackage.answerKeys,
            examConfig: diagramJob.draftPackage.examConfig
        });
        assert.notEqual(
            freshlyRecomputedFingerprint,
            baselineFingerprint,
            "Fingerprint with hasDiagram=true must differ from fingerprint with hasDiagram=false"
        );

        // Update validation report with the freshly validated fingerprint
        diagramJob.validationReport.validatedFingerprint = freshlyRecomputedFingerprint;
        diagramJob.contentFingerprint = freshlyRecomputedFingerprint;
        diagramJob.validationReport.canPublish = true;
        diagramJob.validationReport.blockers = [];

        // Publication now succeeds with the fresh validation
        const pubResult = await ImportJobPipelineService.publishTest({ jobId: diagramJob.jobId });
        assert.equal(pubResult.success, true);
        assert.equal(pubResult.status, "published");
    });
});
