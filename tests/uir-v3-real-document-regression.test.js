import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UIRTransformationService } from "../server/services/uir/uirTransformationService.js";
import { UIRValidator } from "../server/services/uir/uirValidator.js";
import {
    UIR_SCHEMA_VERSION,
    UIR_APPROVAL_STATUS,
    UIR_QUESTION_TYPES
} from "../server/services/uir/uirSchema.js";
import { UIRToScoringAdapter } from "../server/services/uir/uirAdapters.js";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";

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

describe("Phase 3: Universal Intermediate Representation (UIR v3.0) — Real-Document Regression Suite", () => {

    describe("1. UPSC Prelims 2026 Paper I Real-Document Regression", () => {
        const qpPath = getVaultFile("UPSC_Prelims_2026_Paper_I_Typed.pdf");
        const akPath = getVaultFile("UPSC_Prelims_2026_Paper_I_Answer_Key.pdf");
        const epPath = getVaultFile("UPSC_Prelims_2026_Paper_1_Pattern.pdf");

        let uirDoc = null;

        it("1.1 transforms real UPSC 2026 documents to UIR v3.0 with 100/100 questions and full option fidelity", async () => {
            assert.ok(fs.existsSync(qpPath), "UPSC QP PDF must exist in vault");
            assert.ok(fs.existsSync(akPath), "UPSC AK PDF must exist in vault");
            assert.ok(fs.existsSync(epPath), "UPSC EP PDF must exist in vault");

            const qpBuf = fs.readFileSync(qpPath);
            const akBuf = fs.readFileSync(akPath);
            const epBuf = fs.readFileSync(epPath);

            const result = await UIRTransformationService.transformDocuments({
                questionPaper: qpBuf,
                answerKey: akBuf,
                paperFormat: epBuf
            }, {
                examId: "upsc-prelims-2026",
                approvalStatus: UIR_APPROVAL_STATUS.APPROVED
            });

            assert.ok(result);
            assert.ok(result.uirDocument);
            uirDoc = result.uirDocument;

            assert.equal(uirDoc.questions.length, 100);
            assert.equal(uirDoc.examMetadata.totalQuestions, 100);

            // 100/100 questions must have 4 clean options
            const questionsWith4Options = uirDoc.questions.filter(q => q.options.length === 4);
            assert.equal(questionsWith4Options.length, 100);

            // Enforce schema version and approval
            assert.equal(uirDoc.schemaVersion, UIR_SCHEMA_VERSION);
            assert.equal(uirDoc.examMetadata.approvalStatus, UIR_APPROVAL_STATUS.APPROVED);
        });

        it("1.2 preserves exact rational scoring representation (+2, -2/3)", () => {
            const scoring = uirDoc.scoringConfig;
            assert.equal(scoring.defaultPositiveMarks, 2);
            assert.ok(scoring.defaultNegativeMarks <= -0.65 && scoring.defaultNegativeMarks >= -0.67);

            // Questions inherit exact rational rules
            for (const q of uirDoc.questions) {
                assert.equal(q.scoring.positiveMarks, 2);
                assert.deepEqual(q.scoring.positiveMarksRational, { num: "2", den: "1" });
                assert.deepEqual(q.scoring.negativeMarksRational, { num: "-2", den: "3" });
            }
        });

        it("1.3 passes strict UIR v3.0 schema and relational validation with zero errors", () => {
            const validation = UIRValidator.validate(uirDoc);
            assert.equal(validation.isValid, true);
            assert.deepEqual(validation.errors, []);
            assert.doesNotThrow(() => UIRValidator.validateOrThrow(uirDoc));
        });
    });

    describe("2. BPSC 69th Prelims Real-Document Regression", () => {
        const qpPath = getVaultFile("69TH_PRELIMS_M1.pdf");
        const akPath = getVaultFile("BPSC_69th_Prelims___General_Studies__Booklet_Series_A_Answer_Key.pdf");
        const epPath = getVaultFile("BPSC_Prelims_Exam_Pattern.pdf");

        let uirDoc = null;

        it("2.1 transforms real BPSC 69th documents to UIR v3.0 with 150/150 questions and 100% 4-option resolution", async () => {
            assert.ok(fs.existsSync(qpPath), "BPSC QP PDF must exist in vault");
            assert.ok(fs.existsSync(akPath), "BPSC AK PDF must exist in vault");
            assert.ok(fs.existsSync(epPath), "BPSC EP PDF must exist in vault");

            const qpBuf = fs.readFileSync(qpPath);
            const akBuf = fs.readFileSync(akPath);
            const epBuf = fs.readFileSync(epPath);

            const result = await UIRTransformationService.transformDocuments({
                questionPaper: qpBuf,
                answerKey: akBuf,
                paperFormat: epBuf
            }, {
                examId: "bpsc-69th-prelims",
                approvalStatus: UIR_APPROVAL_STATUS.APPROVED
            });

            assert.ok(result);
            assert.ok(result.uirDocument);
            uirDoc = result.uirDocument;

            assert.equal(uirDoc.questions.length, 150);
            assert.equal(uirDoc.examMetadata.totalQuestions, 150);

            // Resolves the 34 irregular option counts from Phase 2.2: 150/150 must have exactly 4 clean options
            const questionsWith4Options = uirDoc.questions.filter(q => q.options.length === 4);
            assert.equal(questionsWith4Options.length, 150);
        });

        it("2.2 preserves parallel bilingual Hindi text layer for all 150 questions", () => {
            const bilingualQuestions = uirDoc.questions.filter(q => q.languageVariants && q.languageVariants.hi);
            assert.equal(bilingualQuestions.length, 150);

            for (const q of uirDoc.questions) {
                assert.ok(q.languageVariants.hi.stemText && q.languageVariants.hi.stemText.length > 0);
                assert.ok(Array.isArray(q.languageVariants.hi.options));
            }
        });

        it("2.3 preserves exact rational scoring representation (+1, -1/3)", () => {
            const scoring = uirDoc.scoringConfig;
            assert.equal(scoring.defaultPositiveMarks, 1);
            assert.ok(scoring.defaultNegativeMarks <= -0.32 && scoring.defaultNegativeMarks >= -0.34);

            for (const q of uirDoc.questions) {
                assert.equal(q.scoring.positiveMarks, 1);
                assert.deepEqual(q.scoring.positiveMarksRational, { num: "1", den: "1" });
                assert.deepEqual(q.scoring.negativeMarksRational, { num: "-1", den: "3" });
            }
        });

        it("2.4 passes strict UIR v3.0 schema and relational validation with zero errors", () => {
            const validation = UIRValidator.validate(uirDoc);
            assert.equal(validation.isValid, true);
            assert.deepEqual(validation.errors, []);
            assert.doesNotThrow(() => UIRValidator.validateOrThrow(uirDoc));
        });
    });

    describe("3. JEE Main 2026 Shift 1 Real-Document Regression & Content Corruption Gate", () => {
        const qpPath = getVaultFile("JEE_Main_21_Jan_2026_Shift_1.pdf");
        const akPath = getVaultFile("JEE_Main_21_Jan_2026_Shift1_Answer_Key.pdf");
        const epPath = getVaultFile("JEE_Main_2026_Exam_Format.pdf");

        let uirDoc = null;

        it("3.1 transforms real JEE Main 2026 documents to UIR v3.0 extracting 75 questions (60 MCQs + 15 NATs)", async () => {
            assert.ok(fs.existsSync(qpPath), "JEE QP PDF must exist in vault");
            assert.ok(fs.existsSync(akPath), "JEE AK PDF must exist in vault");
            assert.ok(fs.existsSync(epPath), "JEE EP PDF must exist in vault");

            const qpBuf = fs.readFileSync(qpPath);
            const akBuf = fs.readFileSync(akPath);
            const epBuf = fs.readFileSync(epPath);

            const result = await UIRTransformationService.transformDocuments({
                questionPaper: qpBuf,
                answerKey: akBuf,
                paperFormat: epBuf
            }, {
                examId: "jee-main-2026-shift-1"
            });

            assert.ok(result);
            assert.ok(result.uirDocument);
            uirDoc = result.uirDocument;

            assert.equal(uirDoc.questions.length, 75);
            assert.equal(uirDoc.examMetadata.totalQuestions, 75);

            const mcqs = uirDoc.questions.filter(q => q.questionType === UIR_QUESTION_TYPES.SINGLE_CHOICE_MCQ);
            const nats = uirDoc.questions.filter(q => q.questionType === UIR_QUESTION_TYPES.NUMERICAL_NAT);
            assert.equal(mcqs.length, 60);
            assert.equal(nats.length, 15);
        });

        it("3.2 detects PDF font encoding corruption on Questions 29, 64, and 65", () => {
            const q29 = uirDoc.questions.find(q => q.questionNumber === 29);
            const q64 = uirDoc.questions.find(q => q.questionNumber === 64);
            const q65 = uirDoc.questions.find(q => q.questionNumber === 65);

            assert.ok(q29, "Question 29 must exist");
            assert.ok(q64, "Question 64 must exist");
            assert.ok(q65, "Question 65 must exist");

            assert.equal(q29.qualityFlags.contentCorruptionDetected, true);
            assert.equal(q64.qualityFlags.contentCorruptionDetected, true);
            assert.equal(q65.qualityFlags.contentCorruptionDetected, true);
        });

        it("3.3 strictly blocks publication approval if content corruption is unverified", () => {
            const unverifiedDoc = JSON.parse(JSON.stringify(uirDoc));
            unverifiedDoc.examMetadata.approvalStatus = UIR_APPROVAL_STATUS.APPROVED;

            const validation = UIRValidator.validate(unverifiedDoc);
            assert.equal(validation.isValid, false);

            const blockers = validation.errors.filter(e => e.includes("Publication Blocker"));
            assert.equal(blockers.length, 3);
            assert.ok(blockers.some(b => b.includes("q_29")));
            assert.ok(blockers.some(b => b.includes("q_64")));
            assert.ok(blockers.some(b => b.includes("q_65")));
        });

        it("3.4 transitions to approved status when audited human corrections are applied", () => {
            // Apply human corrections with auditor provenance
            UIRTransformationService.applyHumanCorrection(uirDoc, {
                questionNumber: 29,
                modifiedBy: "lead_chemistry_reviewer",
                reason: "Restored chemical formulas: MnO4-, MnO4 2-, MnO2 from official physical paper",
                correctedOptions: [
                    { id: "A", text: "MnO4 2- and MnO2" },
                    { id: "B", text: "MnO4- and MnO2" },
                    { id: "C", text: "MnO4 2- and Mn2+" },
                    { id: "D", text: "MnO2 and Mn2+" }
                ]
            });

            UIRTransformationService.applyHumanCorrection(uirDoc, {
                questionNumber: 64,
                modifiedBy: "lead_math_reviewer",
                reason: "Restored mathematical limits from official physical paper",
                correctedOptions: [
                    { id: "A", text: "lim x->0 (sin x / x) = 1" },
                    { id: "B", text: "lim x->0 (cos x / x) = 0" },
                    { id: "C", text: "lim x->inf (1/x) = 0" },
                    { id: "D", text: "lim x->0 (tan x / x) = 1" }
                ]
            });

            UIRTransformationService.applyHumanCorrection(uirDoc, {
                questionNumber: 65,
                modifiedBy: "lead_math_reviewer",
                reason: "Restored algebraic coordinate expressions from official physical paper",
                correctedOptions: [
                    { id: "A", text: "x^2 + y^2 = r^2" },
                    { id: "B", text: "x^2 - y^2 = a^2" },
                    { id: "C", text: "y^2 = 4ax" },
                    { id: "D", text: "x^2/a^2 + y^2/b^2 = 1" }
                ]
            });

            // Transition to approved
            uirDoc.examMetadata.approvalStatus = UIR_APPROVAL_STATUS.APPROVED;

            // Validate with zero errors
            const validation = UIRValidator.validate(uirDoc);
            assert.equal(validation.isValid, true);
            assert.deepEqual(validation.errors, []);
            assert.doesNotThrow(() => UIRValidator.validateOrThrow(uirDoc));

            // Verify human correction audit trail
            const q29 = uirDoc.questions.find(q => q.questionNumber === 29);
            assert.equal(q29.humanCorrectionHistory.length, 1);
            assert.equal(q29.humanCorrectionHistory[0].modifiedBy, "lead_chemistry_reviewer");
            assert.equal(q29.qualityFlags.manualVerificationCompleted, true);
            assert.equal(q29.qualityFlags.contentCorruptionDetected, false);
        });

        it("3.5 evaluates attempt through UniversalScoringEngine using UIRToScoringAdapter without errors", () => {
            const studentAnswers = {
                "jee-main-2026-shift-1_q_1": "B",
                "jee-main-2026-shift-1_q_21": "1" // NAT Q21
            };

            const payload = UIRToScoringAdapter.toScoringPayload(uirDoc, studentAnswers);
            assert.equal(payload.questions.length, 75);
            assert.equal(payload.answerKeys.length, 75);

            const evalResult = UniversalScoringEngine.evaluateAttempt(payload);
            assert.ok(evalResult);
            assert.equal(evalResult.totalQuestions, 75);
            assert.ok(Number.isFinite(evalResult.totalScore));
        });
    });
});

