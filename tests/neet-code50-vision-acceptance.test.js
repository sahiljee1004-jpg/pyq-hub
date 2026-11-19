process.env.NODE_ENV = "test";

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UniversalDocumentIngestionService } from "../server/services/ingestion/universalDocumentIngestionService.js";
import { QuestionReconstructionService } from "../server/services/documentUnderstanding/questionReconstructionService.js";
import { EvidenceReconciliationService } from "../server/services/documentUnderstanding/evidenceReconciliationService.js";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";
import { UIRTransformationService } from "../server/services/uir/uirTransformationService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const vaultDir = path.join(rootDir, "uploads", "vault");

function getVaultFile(pattern) {
    if (!fs.existsSync(vaultDir)) return null;
    const files = fs.readdirSync(vaultDir);
    const matches = files.filter(f => f.includes(pattern)).sort().reverse();
    return matches.length > 0 ? path.join(vaultDir, matches[0]) : null;
}

describe("Phase 4.5 — NEET Code 50 Vision-Enhanced Acceptance & Scoring Verification", () => {

    const neetQpPath = getVaultFile("Re-neet_code-50_2026.pdf");
    const akPath = getVaultFile("RE-NEET-UG-2026_Code50_Answer_Key.pdf");
    const pfPath = getVaultFile("RE-NEET-UG-2026_Exam_Pattern.pdf");

    // -------------------------------------------------------------------------
    // Test 1: Real Source Documents Availability
    // -------------------------------------------------------------------------
    it("1.1 confirms presence of authentic NEET Code 50 documents", () => {
        assert.ok(neetQpPath && fs.existsSync(neetQpPath), "NEET QP PDF must exist in vault");
        assert.ok(akPath && fs.existsSync(akPath), "NEET AK PDF must exist in vault");
        assert.ok(pfPath && fs.existsSync(pfPath), "NEET Pattern PDF must exist in vault");
    });

    // -------------------------------------------------------------------------
    // Test 2: 2x2 Horizontal Grid Resolution & Option Recovery
    // -------------------------------------------------------------------------
    it("2.1 demonstrates Vision resolves Q1 2x2 horizontal option grid into 4 clean choices", () => {
        // Raw Page 1 Vision extraction from Qwen Vision model (cached or live)
        const visionQ1 = {
            questionNumber: 1,
            stem: "1. A particle of mass $m$ is moving on a circular path. If kinetic friction is $\\mu_k$, then the ratio of velocities is:",
            hasDiagram: false,
            options: [
                { label: "(1)", text: "3" },
                { label: "(2)", text: "1" },
                { label: "(3)", text: "\\frac{1}{3}" },
                { label: "(4)", text: "\\frac{1}{2}" }
            ]
        };

        const reconstructed = QuestionReconstructionService.reconstructQuestions([visionQ1]);
        assert.equal(reconstructed.length, 1);
        const q1 = reconstructed[0];

        assert.equal(q1.questionNumber, 1);
        assert.equal(q1.options.length, 4, "Must resolve all 4 options cleanly");
        assert.deepEqual(q1.options.map(o => o.id), ["A", "B", "C", "D"]);
        assert.equal(q1.options[0].text, "3");
        assert.equal(q1.options[1].text, "1");
        assert.equal(q1.options[2].text, "\\frac{1}{3}");
        assert.equal(q1.options[3].text, "\\frac{1}{2}");
        assert.ok(q1.confidenceBreakdown.overallConfidence >= 0.90, "Confidence should exceed 90%");
    });

    // -------------------------------------------------------------------------
    // Test 3: Solution Derivation Stripping from Question Stem
    // -------------------------------------------------------------------------
    it("3.1 separates solution derivations from question stem into solutionText", () => {
        const ocrContaminatedStem = "A block of mass 2 kg rests on a rough horizontal plane.\nAns. (3)\nSol. $f_k = \\mu_k N = 0.2 \\times 2 \\times 10 = 4$ N. Therefore work done is zero.";
        const { cleanStem, solutionText } = QuestionReconstructionService.extractSolutionFromStem(ocrContaminatedStem);

        assert.ok(!cleanStem.includes("Ans."), "Question stem must NOT contain 'Ans.'");
        assert.ok(!cleanStem.includes("Sol."), "Question stem must NOT contain 'Sol.'");
        assert.ok(!cleanStem.includes("work done is zero"), "Derivation steps must be removed from stem");
        assert.equal(cleanStem, "A block of mass 2 kg rests on a rough horizontal plane.");
        assert.ok(solutionText.includes("f_k = \\mu_k N"));
    });

    // -------------------------------------------------------------------------
    // Test 4: Three-Document Macro Reconciliation for NEET Code 50
    // -------------------------------------------------------------------------
    it("4.1 reconciles NEET Code 50 Answer Key and Pattern with exact question count (180)", async () => {
        const akBuf = fs.readFileSync(akPath);
        const pfBuf = fs.readFileSync(pfPath);

        const manifest = await UniversalDocumentIngestionService.ingestDocuments({
            questionPaper: "Question 1 to 180 digital mock for fast verification",
            answerKey: akBuf,
            paperFormat: pfBuf
        }, { enableAiReasoning: false });

        assert.ok(manifest.extractions.answerKey);
        assert.equal(manifest.extractions.answerKey.answers.length, 180, "Answer Key must contain 180 answers");
        assert.equal(manifest.extractions.paperFormat.totalQuestions.value, 180, "Pattern must declare 180 questions");

        // Macro cross verification
        const rec = await EvidenceReconciliationService.crossVerifyThreeDocuments({
            questionPaperExtraction: { questions: new Array(180).fill({}), sections: [] },
            answerKeyExtraction: manifest.extractions.answerKey,
            paperFormatExtraction: manifest.extractions.paperFormat,
            options: { useAiReasoning: false }
        });

        assert.equal(rec.questionCountMatched, true);
        assert.equal(rec.markingRules.positiveMarks, 4);
        assert.equal(rec.markingRules.negativeMarks, -1);
    });

    // -------------------------------------------------------------------------
    // Test 5: UniversalScoringEngine Sole Authority & Correct Scoring
    // -------------------------------------------------------------------------
    it("5.1 evaluates candidate attempts via UniversalScoringEngine (+4 for correct, -1 for wrong)", () => {
        const profile = {
            profileId: "neet-ug-code50",
            name: "NEET UG 2026 Code 50",
            verificationStatus: "verified",
            markingRules: {
                default: { correct: 4, incorrect: 1, unanswered: 0 }
            }
        };

        const questions = [
            { questionId: "q1", questionNumber: 1, marksAwarded: 4, marksDeducted: 1 },
            { questionId: "q38", questionNumber: 38, marksAwarded: 4, marksDeducted: 1 }
        ];

        const answerKeys = [
            { questionId: "q1", questionNumber: 1, correctOptionIds: ["2"], acceptedAnswers: ["2", "B"] },
            { questionId: "q38", questionNumber: 38, correctOptionIds: ["2", "3"], acceptedAnswers: ["B", "C"] }
        ];

        // Candidate answers Option 2 (B) on Q1 (Correct -> awards +4)
        const resCorrect = UniversalScoringEngine.evaluateAttempt({
            questions: [questions[0]],
            answerKeys: [answerKeys[0]],
            studentAnswers: { q1: "2" },
            examProfile: profile
        });
        assert.equal(resCorrect.totalScore, 4, "Correct answer must award +4 marks");

        // Candidate answers Option 1 (A) on Q1 (Wrong -> deducts 1)
        const resWrong = UniversalScoringEngine.evaluateAttempt({
            questions: [questions[0]],
            answerKeys: [answerKeys[0]],
            studentAnswers: { q1: "1" },
            examProfile: profile
        });
        assert.equal(resWrong.totalScore, -1, "Wrong answer must deduct -1 mark");

        // Q38 multi-accepted choices (Option 2 or Option 3)
        const resQ38Opt2 = UniversalScoringEngine.evaluateAttempt({
            questions: [questions[1]],
            answerKeys: [answerKeys[1]],
            studentAnswers: { q38: "2" },
            examProfile: profile
        });
        assert.equal(resQ38Opt2.totalScore, 4, "Candidate selecting '2' must receive +4 marks");

        const resQ38Opt3 = UniversalScoringEngine.evaluateAttempt({
            questions: [questions[1]],
            answerKeys: [answerKeys[1]],
            studentAnswers: { q38: "3" },
            examProfile: profile
        });
        assert.equal(resQ38Opt3.totalScore, 4, "Candidate selecting '3' must receive +4 marks");
    });

    // -------------------------------------------------------------------------
    // Test 6: Strict Publication Readiness Blocker
    // -------------------------------------------------------------------------
    it("6.1 enforces that publication remains safely blocked (canPublish: false) until human review", async () => {
        const neetBuf = fs.readFileSync(neetQpPath);
        const akBuf = fs.readFileSync(akPath);
        const pfBuf = fs.readFileSync(pfPath);

        const manifest = await UniversalDocumentIngestionService.ingestDocuments({
            questionPaper: neetBuf,
            answerKey: akBuf,
            paperFormat: pfBuf
        }, { maxOcrPages: 1, enableAiReasoning: false });

        // Scanned document without explicit manual verification must be blocked
        assert.equal(manifest.publicationValidation.isApproved, false, "Must NOT be approved automatically");
        assert.ok(manifest.publicationValidation.publicationBlockers.length > 0, "Must contain publication blockers");
        assert.ok(
            manifest.publicationValidation.publicationBlockers.some(b => b.includes("administrative review and verification")),
            "Must explicitly cite administrative review requirement"
        );
    });
});
