import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfjsLib = require("pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js");

import { QuestionNormalizationService } from "../server/services/admin/questionNormalizationService.js";
import { AnswerKeyReconciliationService } from "../server/services/admin/answerKeyReconciliationService.js";
import { ExamPatternService } from "../server/services/admin/examPatternService.js";
import { MetadataExtractionService } from "../server/services/admin/metadataExtractionService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
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

const qpPath = getVaultFile("UPSC_Prelims_2026_Paper_I_Typed.pdf");
const akPath = getVaultFile("UPSC_Prelims_2026_Paper_I_Answer_Key.pdf");
const epPath = getVaultFile("UPSC_Prelims_2026_Paper_1_Pattern.pdf");

test("UPSC 2026 Final Independent Verification & Production Gate Audit", async (t) => {
    process.env.NODE_ENV = "test";
    process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

    const qpBuf = fs.readFileSync(qpPath);
    const akBuf = fs.readFileSync(akPath);
    const epBuf = fs.readFileSync(epPath);

    const pattern = ExamPatternService.getVerifiedPattern({ examId: "upsc-prelims", year: 2026 });

    // 1. Question Normalization Execution
    const normResult = await QuestionNormalizationService.extractAndNormalizeQuestions({
        pdfBuffer: qpBuf,
        examId: "upsc-prelims",
        year: 2026,
        paperCode: "A",
        language: "en",
        pattern
    });

    const questions = normResult.questions;

    // SECTION 1: Question Sequence Integrity
    await t.test("1. Question Sequence Integrity: Exactly Q1-Q100, No Skips, No Duplicates, No Merged Questions", () => {
        assert.equal(questions.length, 100, `Must have exactly 100 questions, got ${questions.length}`);
        
        const qNums = questions.map(q => q.questionNumber);
        const expected = Array.from({ length: 100 }, (_, i) => i + 1);
        assert.deepEqual(qNums, expected, "Question numbers must be contiguous integers 1..100");

        // Verify uniqueness
        const numSet = new Set(qNums);
        assert.equal(numSet.size, 100, "All 100 question numbers must be distinct");

        // Verify no numbered statements became questions
        for (const q of questions) {
            assert.ok(q.questionText && q.questionText.trim().length > 15, `Q${q.questionNumber} text too short or empty`);
            for (const opt of q.options) {
                assert.ok(!/^\d+\.\s+[A-Z]/.test(opt.text), `Q${q.questionNumber} option ${opt.label} looks like a question stem: ${opt.text}`);
            }
        }

        // Verify page boundary continuity: check that questions don't end with dangling hyphen
        for (const q of questions) {
            const trimmed = q.questionText.trim();
            assert.ok(!trimmed.endsWith("-"), `Q${q.questionNumber} ends with dangling hyphen at page boundary: "${trimmed.slice(-30)}"`);
        }
    });

    // SECTION 2: Option Integrity
    await t.test("2. Option Integrity: 100 Questions with exactly 4 options (a), (b), (c), (d)", () => {
        let totalOptions = 0;
        const defects = [];

        for (const q of questions) {
            if (!Array.isArray(q.options) || q.options.length !== 4) {
                defects.push({ qNum: q.questionNumber, reason: `Invalid option count: ${q.options ? q.options.length : 0}` });
                continue;
            }
            totalOptions += q.options.length;

            const labels = q.options.map(o => o.label);
            const ids = q.options.map(o => o.id);
            if (JSON.stringify(labels) !== JSON.stringify(["A", "B", "C", "D"])) {
                defects.push({ qNum: q.questionNumber, reason: `Unexpected labels: ${labels.join(",")}` });
            }
            if (JSON.stringify(ids) !== JSON.stringify(["1", "2", "3", "4"])) {
                defects.push({ qNum: q.questionNumber, reason: `Unexpected ids: ${ids.join(",")}` });
            }

            // Check non-empty text
            for (const opt of q.options) {
                if (!opt.text || opt.text.trim().length === 0) {
                    defects.push({ qNum: q.questionNumber, reason: `Option ${opt.label} is empty` });
                }
            }

            // Check duplicate options within the same question
            const optTexts = q.options.map(o => o.text.trim().toLowerCase());
            const uniqueOptTexts = new Set(optTexts);
            if (uniqueOptTexts.size < 4) {
                defects.push({ qNum: q.questionNumber, reason: `Duplicate options detected: ${JSON.stringify(optTexts)}` });
            }

            // Check bleeding: option text should not contain the next question header (e.g. "Q2." or "2. ")
            const nextQNum = q.questionNumber + 1;
            if (nextQNum <= 100) {
                for (const opt of q.options) {
                    const regex = new RegExp(`(^|\\n)\\s*${nextQNum}\\.\\s+[A-Z]`);
                    if (regex.test(opt.text)) {
                        defects.push({ qNum: q.questionNumber, reason: `Option ${opt.label} bleeds into Q${nextQNum}` });
                    }
                }
            }
        }

        assert.equal(totalOptions, 400, "Must have exactly 400 options across all 100 questions");
        assert.equal(defects.length, 0, `Option defects found: ${JSON.stringify(defects, null, 2)}`);
    });

    // SECTION 3: Source PDF Direct Inspection & Sample Comparison
    await t.test("3. Source Comparison: Deep Inspection against UPSC_Prelims_2026_Paper_I_Typed.pdf", async () => {
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(qpBuf) });
        const doc = await loadingTask.promise;
        assert.equal(doc.numPages, 29, `Question paper must have 29 pages, found ${doc.numPages}`);

        // Q1: Music question on Page 1
        const q1 = questions[0];
        assert.equal(q1.questionNumber, 1);
        assert.ok(q1.questionText.includes("Carnatic music") || q1.questionText.includes("Bilawal"), `Q1 stem missing key phrase: ${q1.questionText}`);
        assert.ok(q1.options.some(o => o.text.includes("Shankarabharanam")), "Q1 options must contain Shankarabharanam");

        // Q2: Economy question on Page 1
        const q2 = questions[1];
        assert.equal(q2.questionNumber, 2);
        assert.ok(q2.questionText.includes("Hilton-Young Commission") || q2.questionText.includes("rupee-sterling"), `Q2 stem missing key phrase: ${q2.questionText}`);

        // Q3: Ancient History (Pali texts & punch-marked coins)
        const q3 = questions.find(q => q.questionNumber === 3);
        assert.ok(q3, "Q3 must exist");
        assert.ok(q3.questionText.includes("Pali texts"), "Q3 must retain Statement I");
        assert.ok(q3.questionText.includes("punch-marked coins"), "Q3 must retain Statement II");

        // Q4: Architecture (Temples)
        const q4 = questions.find(q => q.questionNumber === 4);
        assert.ok(q4, "Q4 must exist");
        assert.ok(q4.questionText.includes("Malegitti Shivalaya") && q4.questionText.includes("Virupaksha Temple"), "Q4 must retain temple list");

        // Q50: Intermediate question
        const q50 = questions.find(q => q.questionNumber === 50);
        assert.ok(q50, "Q50 must exist");
        assert.equal(q50.options.length, 4);
        assert.ok(q50.questionText.trim().length > 20);

        // Q75: Intermediate question
        const q75 = questions.find(q => q.questionNumber === 75);
        assert.ok(q75, "Q75 must exist");
        assert.equal(q75.options.length, 4);

        // Q99: Penultimate question
        const q99 = questions.find(q => q.questionNumber === 99);
        assert.ok(q99, "Q99 must exist");
        assert.equal(q99.options.length, 4);

        // Q100: Final question on Page 29 (Multidimensional Poverty Index)
        const q100 = questions.find(q => q.questionNumber === 100);
        assert.ok(q100, "Q100 must exist");
        assert.equal(q100.questionNumber, 100);
        assert.equal(q100.options.length, 4);
        assert.ok(q100.questionText.includes("Multidimensional Poverty Index") || q100.questionText.includes("Alkire-Foster"), `Q100 stem: ${q100.questionText}`);
        assert.ok(q100.options[0].text.includes("1 and 2 only"), "Q100 option A must be '1 and 2 only'");

        // Verify statement-based questions count
        const statementQuestions = questions.filter(q => 
            q.questionText.includes("Statement") || 
            q.questionText.includes("Consider the following") ||
            q.questionText.includes("Which of the statements given above")
        );
        assert.ok(statementQuestions.length >= 20, `Expected at least 20 statement-type questions in UPSC GS-1, found ${statementQuestions.length}`);
    });

    // SECTION 4: Independent Answer Key Parsing & Mapping
    await t.test("4. Independent Answer-Key Parsing: Parse PDF independently & Compare with Service", async () => {
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(akBuf) });
        const akDoc = await loadingTask.promise;
        assert.equal(akDoc.numPages, 2, `Answer key PDF must have 2 pages, got ${akDoc.numPages}`);

        // Independent custom extraction of answer key table
        let fullText = "";
        for (let p = 1; p <= akDoc.numPages; p++) {
            const page = await akDoc.getPage(p);
            const content = await page.getTextContent();
            fullText += content.items.map(item => item.str).join(" ") + "\n";
        }

        const seriesMatch = fullText.match(/(?:Test\s+Booklet\s+Series|Booklet\s+Series|Series)\s*[:\-]?\s*(?:SET\s*)?([A-D])\b/i);
        const codeMatch = fullText.match(/(?:Test\s+Booklet\s+Code|Booklet\s+Code)\s*[:\-]?\s*([A-Z0-9\-]+)/i);

        const seriesFound = seriesMatch ? seriesMatch[1].toUpperCase() : null;
        const codeFound = codeMatch ? codeMatch[1].toUpperCase() : null;

        assert.equal(seriesFound, "A", "Independent parser must find Series A");
        assert.equal(codeFound, "TDMN-A-ASO", "Independent parser must find Booklet Code TDMN-A-ASO");

        const matches = [...fullText.matchAll(/(?:^|\s)(\d{1,3})\s*[\(\[]\s*([a-dA-D])\s*[\)\]]/g)];
        const independentAnswers = new Map();
        for (const m of matches) {
            const qn = parseInt(m[1], 10);
            if (qn >= 1 && qn <= 100) {
                independentAnswers.set(qn, m[2].toUpperCase());
            }
        }

        assert.equal(independentAnswers.size, 100, `Independent parser must find all 100 answers, found ${independentAnswers.size}`);

        // Compare against AnswerKeyReconciliationService
        const serviceResult = await AnswerKeyReconciliationService.parseAnswerKeyDocument(akBuf);
        assert.equal(serviceResult.totalParsed, 100);
        assert.equal(serviceResult.keyMetadata.bookletSeries, "A");
        assert.equal(serviceResult.keyMetadata.bookletCode, "TDMN-A-ASO");

        const letterToId = { "A": "1", "B": "2", "C": "3", "D": "4" };
        const mismatches = [];

        for (let qn = 1; qn <= 100; qn++) {
            const expectedLetter = independentAnswers.get(qn);
            const expectedId = letterToId[expectedLetter];
            const serviceAnswer = serviceResult.answers.get(qn);

            if (!serviceAnswer) {
                mismatches.push({ qn, error: "Missing in service result" });
            } else if (serviceAnswer.correctOptionIds[0] !== expectedId) {
                mismatches.push({
                    qn,
                    expectedLetter,
                    expectedId,
                    serviceId: serviceAnswer.correctOptionIds[0]
                });
            }
        }

        assert.equal(mismatches.length, 0, `Answer key reconciliation mismatches: ${JSON.stringify(mismatches)}`);
    });

    // SECTION 5: Scoring Verification
    await t.test("5. Deterministic Scoring Verification: +2, -2/3, 0 across diverse scenarios", () => {
        const questions = normResult.questions;
        const answerKeys = questions.map(q => ({
            questionId: q.questionId,
            questionNumber: q.questionNumber,
            correctOptionIds: ["1"]
        }));

        // Scenario 1: All 100 correct => 100 * 2 = 200
        const allCorrect = {};
        questions.forEach(q => { allCorrect[q.questionId] = "1"; });
        const sc1 = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: allCorrect,
            examConfig: { examId: "upsc-prelims" }
        });
        assert.equal(sc1.totalScore, 200);
        assert.equal(sc1.maximumMarks, 200);
        assert.equal(sc1.correctCount, 100);
        assert.equal(sc1.incorrectCount, 0);
        assert.equal(sc1.unansweredCount, 0);
        assert.equal(sc1.percentageScore, 100);

        // Scenario 2: All 100 incorrect => 100 * (-2/3) = -66.667
        const allIncorrect = {};
        questions.forEach(q => { allIncorrect[q.questionId] = "2"; });
        const sc2 = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: allIncorrect,
            examConfig: { examId: "upsc-prelims" }
        });
        assert.equal(sc2.correctCount, 0);
        assert.equal(sc2.incorrectCount, 100);
        assert.equal(sc2.unansweredCount, 0);
        assert.ok(Math.abs(sc2.totalScore - (-200 / 3)) < 1e-2, `Score must be -66.667, got ${sc2.totalScore}`);

        // Scenario 3: 50 correct, 30 incorrect, 20 unanswered
        // 50 * 2 = 100; 30 * (-2/3) = -20; net = 80.0
        const mixedAnswers = {};
        for (let i = 0; i < 50; i++) mixedAnswers[questions[i].questionId] = "1";
        for (let i = 50; i < 80; i++) mixedAnswers[questions[i].questionId] = "2";
        const sc3 = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: mixedAnswers,
            examConfig: { examId: "upsc-prelims" }
        });
        assert.equal(sc3.correctCount, 50);
        assert.equal(sc3.incorrectCount, 30);
        assert.equal(sc3.unansweredCount, 20);
        assert.ok(Math.abs(sc3.totalScore - 80) < 1e-6);
        assert.equal(sc3.percentageScore, 40);

        // Scenario 4: Negative Score: 2 correct, 10 incorrect, 88 unanswered
        // 2 * 2 = 4; 10 * (-2/3) = -6.667; net = -2.667
        const negAnswers = {};
        negAnswers[questions[0].questionId] = "1";
        negAnswers[questions[1].questionId] = "1";
        for (let i = 2; i < 12; i++) negAnswers[questions[i].questionId] = "2";
        const sc4 = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: negAnswers,
            examConfig: { examId: "upsc-prelims" }
        });
        assert.equal(sc4.correctCount, 2);
        assert.equal(sc4.incorrectCount, 10);
        assert.equal(sc4.unansweredCount, 88);
        const expectedNeg = 4 - (20 / 3);
        assert.ok(Math.abs(sc4.totalScore - expectedNeg) < 1e-2, `Score must be -2.667, got ${sc4.totalScore}`);
    });

    // SECTION 6: Publication Gate Negative Testing
    await t.test("6. Publication Gate Security: Discrepancy & Missing Data Hard Blocking", async () => {
        // Test Case 6.1: Missing question count (e.g. 99 questions instead of 100)
        const jobMissingQ = ImportJobPipelineService.createJob({
            examName: "UPSC Test Missing Q",
            examId: "upsc-prelims",
            year: 2026,
            actor: "admin_test"
        });
        jobMissingQ.extractedQuestions = questions.slice(0, 99);
        jobMissingQ.answerKeys = questions.slice(0, 99).map(q => ({ questionId: q.questionId, correctOptionIds: ["1"] }));
        
        await assert.rejects(
            async () => {
                await ImportJobPipelineService.publishTest({ jobId: jobMissingQ.jobId, actor: "admin_test" });
            },
            /Cannot publish test: Authoritative publication gate rejected publication/i,
            "Publication must reject a test with missing questions"
        );

        // Test Case 6.2: Duplicate question numbers
        const jobDupQ = ImportJobPipelineService.createJob({
            examName: "UPSC Test Dup Q",
            examId: "upsc-prelims",
            year: 2026,
            actor: "admin_test"
        });
        const dupQuestions = JSON.parse(JSON.stringify(questions));
        dupQuestions[1].questionNumber = 1; // Duplicate Q1
        jobDupQ.extractedQuestions = dupQuestions;
        jobDupQ.answerKeys = dupQuestions.map(q => ({ questionId: q.questionId, correctOptionIds: ["1"] }));

        await assert.rejects(
            async () => {
                await ImportJobPipelineService.publishTest({ jobId: jobDupQ.jobId, actor: "admin_test" });
            },
            /Cannot publish test: Authoritative publication gate rejected publication/i,
            "Publication must reject a test with duplicate question numbers"
        );

        // Test Case 6.3: Missing option on a question (e.g. Q5 has only 3 options)
        const jobMissingOpt = ImportJobPipelineService.createJob({
            examName: "UPSC Test Missing Option",
            examId: "upsc-prelims",
            year: 2026,
            actor: "admin_test"
        });
        const missingOptQuestions = JSON.parse(JSON.stringify(questions));
        missingOptQuestions[4].options = missingOptQuestions[4].options.slice(0, 3);
        jobMissingOpt.extractedQuestions = missingOptQuestions;
        jobMissingOpt.answerKeys = missingOptQuestions.map(q => ({ questionId: q.questionId, correctOptionIds: ["1"] }));

        await assert.rejects(
            async () => {
                await ImportJobPipelineService.publishTest({ jobId: jobMissingOpt.jobId, actor: "admin_test" });
            },
            /Cannot publish test: Authoritative publication gate rejected publication/i,
            "Publication must reject a test with missing options"
        );

        // Test Case 6.4: Missing answer key (e.g. Q42 has no answer key)
        const jobMissingKey = ImportJobPipelineService.createJob({
            examName: "UPSC Test Missing Key",
            examId: "upsc-prelims",
            year: 2026,
            actor: "admin_test"
        });
        jobMissingKey.extractedQuestions = questions;
        jobMissingKey.answerKeys = questions.filter(q => q.questionNumber !== 42).map(q => ({ questionId: q.questionId, correctOptionIds: ["1"] }));

        await assert.rejects(
            async () => {
                await ImportJobPipelineService.publishTest({ jobId: jobMissingKey.jobId, actor: "admin_test" });
            },
            /Cannot publish test: Authoritative publication gate rejected publication/i,
            "Publication must reject a test with missing answer keys"
        );

        // Test Case 6.5: Booklet code mismatch detection in MetadataExtractionService
        const testExtracted = {
            paperCode: { value: "A", provenance: "question_paper_header" },
            warnings: []
        };
        MetadataExtractionService.extractFromAnswerKeyText(
            "Test Booklet Series: SET B\nTest Booklet Code: TDMN-B-ASO\n1(a) 2(b)",
            testExtracted
        );
        assert.ok(
            testExtracted.warnings.some(w => w.includes("Paper code mismatch")),
            `MetadataExtractionService must flag paper code mismatch warning when QP is A and AK is B. Warnings: ${JSON.stringify(testExtracted.warnings)}`
        );

        // Test Case 6.6: Exam Pattern Configuration Gate Validation
        const patternCheckMissing = ExamPatternService.validateQuestionsAgainstPattern(questions.slice(0, 99), pattern);
        assert.equal(patternCheckMissing.valid, false, "Pattern check must fail when question count is 99 instead of 100");
        assert.ok(patternCheckMissing.issues.some(i => i.includes("Missing 1 questions")), "Must report missing question");

        const dupQuestionsList = [...questions];
        dupQuestionsList[1] = { ...dupQuestionsList[0], questionNumber: 1 };
        const patternCheckDup = ExamPatternService.validateQuestionsAgainstPattern(dupQuestionsList, pattern);
        assert.equal(patternCheckDup.valid, false, "Pattern check must fail when duplicate questions exist");
        assert.ok(patternCheckDup.issues.some(i => i.includes("Duplicate question number")), "Must report duplicate question");

        // Test Case 6.7: Option Conflict detection in Scored-Test Gate
        const conflictingAnswers = new Map([
            [1, { questionNumber: 1, correctOptionIds: ["5"] }],
            [questions[0].questionId, { questionNumber: 1, correctOptionIds: ["5"] }]
        ]);
        const reconConflict = AnswerKeyReconciliationService.reconcileAnswerKeys({
            questions,
            answerMap: conflictingAnswers,
            sourceReference: "Conflicting Key"
        });
        assert.equal(reconConflict.gatePassed, false, "Scored-Test Gate must fail on answer option conflict");
        assert.ok(reconConflict.conflicts.length > 0, "Conflicts must be populated");
        assert.ok(reconConflict.conflicts[0].reason.includes("Answer key declares option 5"), "Must explicitly identify conflicting option");
    });
});
