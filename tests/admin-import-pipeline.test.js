import test, { describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { AdminAuthService } from "../server/services/admin/adminAuthService.js";
import { StorageVaultService } from "../server/services/admin/storageVaultService.js";
import { MetadataExtractionService } from "../server/services/admin/metadataExtractionService.js";
import { ExamPatternService } from "../server/services/admin/examPatternService.js";
import { QuestionNormalizationService } from "../server/services/admin/questionNormalizationService.js";
import { AnswerKeyReconciliationService } from "../server/services/admin/answerKeyReconciliationService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { generateNeetUgFixtures, buildSimplePdf } from "./fixtures/createSyntheticPdfs.js";

describe("Admin Dashboard & Automated PYQ Import Pipeline Test Suite", () => {
    let originalEnv;
    let fixtures;
    let keyPair;

    function createTestToken(uid) {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
        const payload = {
            iss: "https://securetoken.google.com/pyqs-hub-43bed",
            aud: "pyqs-hub-43bed",
            sub: uid,
            user_id: uid,
            auth_time: now,
            iat: now,
            exp: now + 3600
        };
        const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
        const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signInput = `${b64Header}.${b64Payload}`;
        const signer = crypto.createSign("RSA-SHA256");
        signer.update(signInput);
        const signature = signer.sign(keyPair.privateKey, "base64url");
        return `${signInput}.${signature}`;
    }

    before(() => {
        fixtures = generateNeetUgFixtures();
        keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        registerTestPublicKey(keyPair.publicKey);
    });

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";
        process.env.NODE_ENV = "test";
        UniversalFirestoreService.clearLocalCache();
        UniversalFirestoreService.setDocument("users", "test_admin_uid_123", {
            uid: "test_admin_uid_123",
            email: "admin@vidyarthiastra.in",
            role: "admin"
        });
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    // ============================================================
    // 1. ADMIN AUTHORIZATION & SECURITY
    // ============================================================
    test("1A. Denies access when no authorization header provided", async () => {
        const mockReq = {
            headers: {}
        };
        const result = await AdminAuthService.verifyAdmin(mockReq);
        assert.equal(result.authorized, false);
        assert.equal(result.statusCode, 401);
    });

    test("1B. Rejects access via legacy X-Admin-Key (shared secrets retired)", async () => {
        const mockReq = {
            headers: {
                "x-admin-key": "test_super_secret_admin_key_7788"
            }
        };
        const result = await AdminAuthService.verifyAdmin(mockReq);
        assert.equal(result.authorized, false);
        assert.equal(result.statusCode, 401);
    });

    test("1C. Authorizes admin via Bearer token with Firestore role 'admin'", async () => {
        const token = createTestToken("test_admin_uid_123");
        const mockReq = {
            headers: {
                authorization: `Bearer ${token}`
            }
        };
        const result = await AdminAuthService.verifyAdmin(mockReq);
        assert.equal(result.authorized, true);
        assert.equal(result.statusCode, 200);
        assert.equal(result.user.role, "admin");
    });

    // ============================================================
    // 2. DOCUMENT VALIDATION & MAGIC BYTES
    // ============================================================
    test("2A. Accepts valid PDF buffer with %PDF- header and calculates SHA-256", () => {
        const validBuffer = fs.readFileSync(fixtures.qpPath);
        const validation = StorageVaultService.validatePdfBuffer(validBuffer, "paper.pdf");
        assert.equal(validation.valid, true);

        const hash = StorageVaultService.computeHash(validBuffer);
        assert.equal(typeof hash, "string");
        assert.equal(hash.length, 64); // SHA-256 hex length
    });

    test("2B. Rejects invalid file missing %PDF- magic bytes", () => {
        const fakeBuffer = Buffer.alloc(128, "X");
        const validation = StorageVaultService.validatePdfBuffer(fakeBuffer, "fake.pdf");
        assert.equal(validation.valid, false);
        assert.match(validation.error, /magic byte signature/i);
    });

    test("2C. Rejects empty buffer", () => {
        const emptyBuffer = Buffer.alloc(0);
        const validation = StorageVaultService.validatePdfBuffer(emptyBuffer, "empty.pdf");
        assert.equal(validation.valid, false);
    });

    // ============================================================
    // 3. METADATA EXTRACTION & PROVENANCE
    // ============================================================
    test("3A. Extracts Booklet Code Q1, Year 2024, duration and marking scheme with provenance", async () => {
        const qpBuffer = fs.readFileSync(fixtures.qpPath);
        const akBuffer = fs.readFileSync(fixtures.akPath);
        const epBuffer = fs.readFileSync(fixtures.patternPath);

        const extracted = await MetadataExtractionService.extractAllMetadata({
            questionPaperBuffer: qpBuffer,
            answerKeyBuffer: akBuffer,
            examPatternBuffer: epBuffer,
            userHints: { examId: "neet-ug", year: 2024 }
        });

        assert.equal(extracted.paperCode.value, "Q1");
        assert.equal(extracted.paperCode.provenance, "question_paper_header");
        assert.equal(extracted.year.value, 2024);
        assert.equal(extracted.durationSeconds.value, 12000); // 200 minutes = 12000s
        assert.equal(extracted.markingScheme.correct.value, 4);
        assert.equal(extracted.markingScheme.incorrect.value, -1);
    });

    test("3B. Detects paper code mismatch between Question Paper and Answer Key", async () => {
        const qpBuffer = fs.readFileSync(fixtures.qpPath); // Code Q1
        const mismatchedAkBuffer = fs.readFileSync(fixtures.mismatchedAkPath); // Code R1
        const epBuffer = fs.readFileSync(fixtures.patternPath);

        const extracted = await MetadataExtractionService.extractAllMetadata({
            questionPaperBuffer: qpBuffer,
            answerKeyBuffer: mismatchedAkBuffer,
            examPatternBuffer: epBuffer
        });

        assert.ok(extracted.warnings.length > 0);
        assert.match(extracted.warnings[0], /Paper code mismatch/i);
    });

    // ============================================================
    // 4. QUESTION NORMALIZATION & DIAGRAM TRACKING
    // ============================================================
    test("4A. Normalizes questions into structured schema and detects diagrams", async () => {
        const qpBuffer = fs.readFileSync(fixtures.qpPath);
        const result = await QuestionNormalizationService.extractAndNormalizeQuestions({
            pdfBuffer: qpBuffer,
            examId: "neet-ug",
            year: 2024,
            paperCode: "Q1"
        });

        assert.ok(result.totalExtracted >= 5);
        const q1 = result.questions.find(q => q.questionNumber === 1);
        assert.ok(q1);
        assert.equal(q1.questionId, "neet-ug-2024-Q1-001");
        assert.equal(q1.options.length, 4);
        assert.equal(q1.options[0].id, "1");

        // Q3 contains diagram reference
        const q3 = result.questions.find(q => q.questionNumber === 3);
        assert.ok(q3);
        assert.equal(q3.hasDiagram, true);
        assert.ok(q3.media.length > 0);
    });

    test("4B. Preserves confidentiality: mockQuestions does NOT leak correct answers", async () => {
        const qpBuffer = fs.readFileSync(fixtures.qpPath);
        const result = await QuestionNormalizationService.extractAndNormalizeQuestions({
            pdfBuffer: qpBuffer,
            examId: "neet-ug",
            year: 2024,
            paperCode: "Q1"
        });

        for (const q of result.questions) {
            assert.equal(q.correctAnswer, undefined);
            assert.equal(q.correctOptionId, undefined);
            assert.equal(q.answerKey, undefined);
        }
    });

    // ============================================================
    // 5. OFFICIAL ANSWER KEY RECONCILIATION & GATES
    // ============================================================
    test("5A. Reconciles single, multiple-choice, and dropped bonus answers", async () => {
        const akBuffer = fs.readFileSync(fixtures.akPath);
        const parsedAk = await AnswerKeyReconciliationService.parseAnswerKeyDocument(akBuffer, { paperCode: "Q1" });

        assert.equal(parsedAk.answers.get(1).correctOptionIds[0], "2");
        assert.equal(parsedAk.answers.get(2).correctOptionIds[0], "1");
        assert.equal(parsedAk.answers.get(3).correctOptionIds[0], "4");

        // Multiple options: "2 or 4"
        const q4Ans = parsedAk.answers.get(4);
        assert.equal(q4Ans.answerType, "multiple_choice");
        assert.deepEqual(q4Ans.correctOptionIds, ["2", "4"]);

        // Dropped / Bonus
        const q5Ans = parsedAk.answers.get(5);
        assert.equal(q5Ans.answerType, "dropped");
        assert.equal(q5Ans.isDropped, true);
    });

    test("5B. Mandatory Scored-Test Gate BLOCKS publication if answer key is incomplete", async () => {
        const qpBuffer = fs.readFileSync(fixtures.qpPath);
        const extractedQuestions = await QuestionNormalizationService.extractAndNormalizeQuestions({
            pdfBuffer: qpBuffer,
            examId: "neet-ug",
            year: 2024,
            paperCode: "Q1"
        });

        // Use missing answers answer key (omits Q5)
        const missingAkBuffer = fs.readFileSync(fixtures.missingAkPath);
        const parsedAk = await AnswerKeyReconciliationService.parseAnswerKeyDocument(missingAkBuffer, { paperCode: "Q1" });

        const reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
            questions: extractedQuestions.questions,
            answerMap: parsedAk.answers
        });

        // Gate must FAIL
        assert.equal(reconciliation.gatePassed, false);
        assert.ok(reconciliation.missingAnswers.includes(5));
        assert.ok(reconciliation.matchCoveragePercent < 100);
    });

    // ============================================================
    // 6. FIRESTORE UNIVERSAL DATA MODEL & BATCH LIMITS
    // ============================================================
    test("6A. Universal Firestore service serializes complex nested values properly", () => {
        const testObj = {
            title: "NEET UG 2024",
            duration: 12000,
            negativeMarking: true,
            sections: ["Physics", "Chemistry"],
            metadata: { code: "Q1", version: 1 }
        };

        const fields = UniversalFirestoreService.toFirestoreFields(testObj);
        assert.equal(fields.title.stringValue, "NEET UG 2024");
        assert.equal(fields.duration.integerValue, "12000");
        assert.equal(fields.negativeMarking.booleanValue, true);
        assert.equal(fields.sections.arrayValue.values.length, 2);

        // Deserializes back symmetrically
        const restored = UniversalFirestoreService.fromFirestoreDocument({ fields });
        assert.equal(restored.title, testObj.title);
        assert.equal(restored.duration, testObj.duration);
        assert.equal(restored.negativeMarking, true);
        assert.deepEqual(restored.sections, testObj.sections);
    });

    // ============================================================
    // 7. FULL END-TO-END IMPORT PIPELINE & PUBLISH GATE
    // ============================================================
    test("7. Full End-to-End Pipeline: Ingests 3 PDFs, executes stages, passes gates, and publishes", async () => {
        const qpBuffer = fs.readFileSync(fixtures.qpPath);
        const akBuffer = fs.readFileSync(fixtures.akPath);
        const epBuffer = fs.readFileSync(fixtures.patternPath);

        // Store into vault
        const storedQp = await StorageVaultService.storeDocument({
            buffer: qpBuffer,
            originalFilename: "neet_2024_qp.pdf",
            docType: "question_paper"
        });
        const storedAk = await StorageVaultService.storeDocument({
            buffer: akBuffer,
            originalFilename: "neet_2024_ak.pdf",
            docType: "answer_key"
        });
        const storedEp = await StorageVaultService.storeDocument({
            buffer: epBuffer,
            originalFilename: "neet_2024_pattern.pdf",
            docType: "exam_pattern"
        });

        // Create and execute job
        const job = ImportJobPipelineService.createJob({
            examId: "neet-ug",
            year: 2024,
            paperType: "sample",
            language: "English",
            paperCode: "Q1",
            actor: "test_admin"
        });

        await ImportJobPipelineService.attachDocuments(job.jobId, {
            questionPaper: storedQp,
            answerKey: storedAk,
            examPattern: storedEp
        });

        const completedJob = await ImportJobPipelineService.runPipeline(job.jobId);

        // Verify status & gates
        assert.equal(completedJob.extractedQuestionCount, 5);
        assert.equal(completedJob.verifiedAnswerCount, 5);
        assert.equal(completedJob.validationReport.answerKeyChecks.matchCoverage, 100);
        assert.equal(completedJob.validationReport.canPublish, true);
        assert.equal(completedJob.status, "ready_to_publish");

        // Verify publication
        const publishResult = await ImportJobPipelineService.publishTest({
            jobId: completedJob.jobId,
            actor: "test_admin"
        });

        assert.equal(publishResult.success, true);
        assert.equal(publishResult.status, "published");

        const finalJob = await ImportJobPipelineService.getJob(completedJob.jobId);
        assert.equal(finalJob.status, "published");
    });
});
