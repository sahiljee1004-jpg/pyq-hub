import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { QuestionNormalizationService } from "../server/services/admin/questionNormalizationService.js";
import { AnswerKeyReconciliationService } from "../server/services/admin/answerKeyReconciliationService.js";
import { ExamPatternService } from "../server/services/admin/examPatternService.js";
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

const qpPath = getVaultFile("69TH_PRELIMS_M1.pdf") || path.join(rootDir, "uploads/vault/bccf870fe0e43692_1794055005642_69TH_PRELIMS_M1.pdf");
const akPath = getVaultFile("BPSC_69th_Prelims___General_Studies__Booklet_Series_A_Answer_Key.pdf") || path.join(rootDir, "uploads/vault/f8ced7dbe950d7fa_1794055005643_BPSC_69th_Prelims___General_Studies__Booklet_Series_A_Answer_Key.pdf");
const epPath = getVaultFile("BPSC_Prelims_Exam_Pattern.pdf") || path.join(rootDir, "uploads/vault/8ff2a8ae4f7fc037_1794055007173_BPSC_Prelims_Exam_Pattern.pdf");

test("BPSC 69th Prelims Question Extraction & Complete Pipeline Test Suite", async (t) => {
    process.env.NODE_ENV = "test";
    process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

    const qpExists = fs.existsSync(qpPath);
    const akExists = fs.existsSync(akPath);
    const epExists = fs.existsSync(epPath);

    assert.ok(qpExists, "BPSC Question Paper PDF must exist in vault");
    assert.ok(akExists, "BPSC Answer Key PDF must exist in vault");
    assert.ok(epExists, "BPSC Exam Pattern PDF must exist in vault");

    const qpBuf = fs.readFileSync(qpPath);
    const akBuf = fs.readFileSync(akPath);

    let pattern = null;
    let normResult = null;
    let akResult = null;
    let reconciled = null;

    await t.test("1. Exam Identity Resolution and Authoritative Exam Pattern Registration", () => {
        const identity = ExamPatternService.resolveExamIdentity("BPSC 69th Prelims");
        assert.equal(identity.examId, "bpsc");
        assert.equal(identity.isKnown, true);

        pattern = ExamPatternService.getVerifiedPattern({ examId: "bpsc", year: 2023 });
        assert.equal(pattern.examId, "bpsc");
        assert.equal(pattern.totalQuestions, 150);
        assert.equal(pattern.durationSeconds, 7200);
        assert.equal(pattern.maximumMarks, 150);
        assert.equal(pattern.sections.length, 1);
        assert.equal(pattern.sections[0].id, "general_studies");
        assert.equal(pattern.sections[0].markingScheme.correct, 1);
        assert.ok(Math.abs(pattern.sections[0].markingScheme.incorrect - (-1 / 3)) < 1e-6);
        assert.equal(pattern.sections[0].markingScheme.unanswered, 0);
    });

    await t.test("2. Question Normalization extracts exactly 150 questions (Q1 to Q150) with 0 omissions", async () => {
        normResult = await QuestionNormalizationService.extractAndNormalizeQuestions({
            pdfBuffer: qpBuf,
            examId: "bpsc",
            year: 2023,
            paperCode: "M1",
            language: "en",
            pattern
        });

        assert.equal(normResult.totalExtracted, 150, "Must extract exactly 150 questions");
        assert.equal(normResult.questions.length, 150);

        const qNums = normResult.questions.map(q => q.questionNumber);
        const expectedNums = Array.from({ length: 150 }, (_, i) => i + 1);
        assert.deepEqual(qNums, expectedNums, "Questions must be sequential from 1 to 150 without gaps");
    });

    await t.test("3. All 150 questions have exactly 4 options parsed with ZERO missing-option defects", () => {
        const zeroOptQuestions = normResult.questions.filter(q => q.options.length === 0);
        assert.equal(zeroOptQuestions.length, 0, `Expected 0 questions with 0 options, found ${zeroOptQuestions.length}`);

        const nonFourOpt = normResult.questions.filter(q => q.options.length !== 4);
        assert.equal(nonFourOpt.length, 0, `Expected all 150 questions to have exactly 4 options, found ${nonFourOpt.length} exceptions`);

        for (const q of normResult.questions) {
            const labels = q.options.map(o => o.label);
            assert.deepEqual(labels, ["A", "B", "C", "D"], `Q${q.questionNumber} must have options labeled A, B, C, D`);
            for (const opt of q.options) {
                assert.ok(opt.text && opt.text.trim().length > 0, `Q${q.questionNumber} option ${opt.label} must have non-empty text`);
            }
        }
    });

    await t.test("4. Target questions verification: numbered statements, matching questions, assertion disambiguation", () => {
        // Q1: 5G mobile communication networks with 1, 2, 3 statements
        const q1 = normResult.questions.find(q => q.questionNumber === 1);
        assert.ok(q1, "Q1 must exist");
        const q1TextNorm = q1.questionText.replace(/\s+/g, " ");
        assert.ok(q1TextNorm.includes("5G mobile communication"), "Q1 stem must contain 5G question");
        assert.ok(q1TextNorm.includes("Internet of Things") && q1TextNorm.includes("Edge Computing"), "Q1 must contain numbered statements");
        assert.equal(q1.options.length, 4);
        assert.ok(q1.options[0].text.replace(/\s+/g, " ").includes("Only 1 and 2"));
        assert.ok(q1.options[3].text.replace(/\s+/g, " ").includes("1, 2 and 3"));

        // Q3: Match List-I with List-II (Cloth / Origin)
        const q3 = normResult.questions.find(q => q.questionNumber === 3);
        assert.ok(q3, "Q3 must exist");
        const q3TextNorm = q3.questionText.replace(/\s+/g, " ");
        assert.ok(q3TextNorm.includes("Match") && q3TextNorm.includes("List"), "Q3 must be matching question");
        assert.ok(q3TextNorm.includes("Linen"), "Q3 stem must contain Linen");
        assert.equal(q3.options.length, 4);

        // Q5: Computer languages with 1. Cobra, 2. Python, 3. Squirrel, 4. Java
        const q5 = normResult.questions.find(q => q.questionNumber === 5);
        assert.ok(q5, "Q5 must exist");
        const q5TextNorm = q5.questionText.replace(/\s+/g, " ");
        assert.ok(q5TextNorm.includes("computer languages"), "Q5 stem must contain computer languages");
        assert.ok(q5TextNorm.includes("Cobra") && q5TextNorm.includes("Python"), "Q5 must contain statements");
        assert.equal(q5.options.length, 4);
        assert.ok(q5.options[0].text.replace(/\s+/g, " ").includes("Only 1 and 2"));
        assert.ok(q5.options[3].text.replace(/\s+/g, " ").includes("All of the above"));

        // Q9: Pulsars
        const q9 = normResult.questions.find(q => q.questionNumber === 9);
        assert.ok(q9, "Q9 must exist");
        const q9TextNorm = q9.questionText.replace(/\s+/g, " ");
        assert.ok(q9TextNorm.includes("pulsars"), "Q9 stem must contain pulsars");
        assert.equal(q9.options.length, 4);
        assert.ok(q9.options[0].text.replace(/\s+/g, " ").includes("A group of stars"));

        // Q10: Lab-grown diamonds (LGDs)
        const q10 = normResult.questions.find(q => q.questionNumber === 10);
        assert.ok(q10, "Q10 must exist");
        const q10TextNorm = q10.questionText.replace(/\s+/g, " ");
        assert.ok(q10TextNorm.includes("diamonds") || q10TextNorm.includes("LGDs"), "Q10 stem must contain LGDs");
        assert.equal(q10.options.length, 4);
        assert.ok(q10.options[2].text.replace(/\s+/g, " ").includes("Graphite"));

        // Q32: G20 members
        const q32 = normResult.questions.find(q => q.questionNumber === 32);
        assert.ok(q32, "Q32 must exist");
        const q32TextNorm = q32.questionText.replace(/\s+/g, " ");
        assert.ok(q32TextNorm.includes("G20"), "Q32 stem must contain G20");
        assert.equal(q32.options.length, 4);

        // Q38: White House statements
        const q38 = normResult.questions.find(q => q.questionNumber === 38);
        assert.ok(q38, "Q38 must exist");
        const q38TextNorm = q38.questionText.replace(/\s+/g, " ");
        assert.ok(q38TextNorm.includes("White House"), "Q38 stem must contain White House");
        assert.equal(q38.options.length, 4);

        // Q63: Vikramshila University
        const q63 = normResult.questions.find(q => q.questionNumber === 63);
        assert.ok(q63, "Q63 must exist");
        const q63TextNorm = q63.questionText.replace(/\s+/g, " ");
        assert.ok(q63TextNorm.includes("Vikramshila University"), "Q63 stem must contain Vikramshila University");
        assert.equal(q63.options.length, 4);

        // Q68: Fa-Hien and Hiuen Tsang statements
        const q68 = normResult.questions.find(q => q.questionNumber === 68);
        assert.ok(q68, "Q68 must exist");
        const q68TextNorm = q68.questionText.replace(/\s+/g, " ");
        assert.ok(q68TextNorm.includes("Fa-Hien"), "Q68 stem must contain Fa-Hien");
        assert.equal(q68.options.length, 4);

        // Q81: Lake Victoria statements
        const q81 = normResult.questions.find(q => q.questionNumber === 81);
        assert.ok(q81, "Q81 must exist");
        const q81TextNorm = q81.questionText.replace(/\s+/g, " ");
        assert.ok(q81TextNorm.includes("Lake Victoria"), "Q81 stem must contain Lake Victoria");
        assert.equal(q81.options.length, 4);

        // Q101: Collegium system
        const q101 = normResult.questions.find(q => q.questionNumber === 101);
        assert.ok(q101, "Q101 must exist");
        const q101TextNorm = q101.questionText.replace(/\s+/g, " ");
        assert.ok(q101TextNorm.includes("collegium system"), "Q101 stem must contain collegium system");
        assert.equal(q101.options.length, 4);

        // Q111: Foreign Exchange Reserves (FER)
        const q111 = normResult.questions.find(q => q.questionNumber === 111);
        assert.ok(q111, "Q111 must exist");
        const q111TextNorm = q111.questionText.replace(/\s+/g, " ");
        assert.ok(q111TextNorm.includes("Foreign Exchange Reserves"), "Q111 stem must contain FER");
        assert.equal(q111.options.length, 4);

        // Q129: India's Freedom Struggle chronological order
        const q129 = normResult.questions.find(q => q.questionNumber === 129);
        assert.ok(q129, "Q129 must exist");
        const q129TextNorm = q129.questionText.replace(/\s+/g, " ");
        assert.ok(q129TextNorm.includes("Freedom Struggle"), "Q129 stem must contain Freedom Struggle");
        assert.equal(q129.options.length, 4);
    });

    await t.test("5. Official Answer Key Parsing & Mandatory Scored-Test Gate", async () => {
        akResult = await AnswerKeyReconciliationService.parseAnswerKeyDocument(akBuf);
        assert.equal(akResult.totalParsed, 150, "Answer key must parse all 150 questions");

        reconciled = AnswerKeyReconciliationService.reconcileAnswerKeys({
            questions: normResult.questions,
            answerMap: akResult.answers,
            keyMetadata: akResult.keyMetadata
        });

        assert.equal(reconciled.gatePassed, true, "Mandatory Scored-Test Gate must pass");
        assert.equal(reconciled.totalQuestions, 150);
        assert.equal(reconciled.verifiedCount, 150);
        assert.equal(reconciled.missingAnswers.length, 0);
        assert.equal(reconciled.conflicts.length, 0);
        assert.equal(reconciled.matchCoveragePercent, 100);
        assert.equal(reconciled.reconciledKeys.length, 150);
    });

    await t.test("6. Deterministic Examination Scoring: +1 mark, -1/3 deduction, 0 unattempted", () => {
        const studentAnswers = {};
        // First 60 questions: answered correctly
        for (let i = 1; i <= 60; i++) {
            const keyObj = reconciled.reconciledKeys.find(k => k.questionNumber === i);
            const q = normResult.questions.find(x => x.questionNumber === i);
            studentAnswers[q.questionId] = keyObj.correctOptionIds[0];
        }
        // Next 30 questions: answered incorrectly
        for (let i = 61; i <= 90; i++) {
            const q = normResult.questions.find(x => x.questionNumber === i);
            studentAnswers[q.questionId] = "99";
        }
        // Remaining 60 questions: unattempted

        const scoreResult = MockTestScoringService.evaluateAttempt({
            questions: normResult.questions,
            answerKeys: reconciled.reconciledKeys,
            studentAnswers,
            examConfig: { examId: "bpsc", totalMarks: 150 }
        });

        assert.equal(scoreResult.correctCount, 60, "Must have exactly 60 correct answers");
        assert.equal(scoreResult.incorrectCount, 30, "Must have exactly 30 incorrect answers");
        assert.equal(scoreResult.unansweredCount, 60, "Must have exactly 60 unanswered questions");
        // Score: 60 * 1 - 30 * (1/3) = 60 - 10 = 50.0
        assert.ok(Math.abs(scoreResult.totalScore - 50.0) < 1e-4, `Score must be 50.0, got ${scoreResult.totalScore}`);
    });
});
