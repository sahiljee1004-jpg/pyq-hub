import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import app from "../server/server.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { ExamPatternService } from "../server/services/admin/examPatternService.js";
import { MockTestService } from "../server/services/mockTestService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { StorageVaultService } from "../server/services/admin/storageVaultService.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ID = "pyqs-hub-43bed";

const VALID_DUMMY_PDF = Buffer.from(
    "%PDF-1.4\n" +
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
    "3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n" +
    "trailer\n<< /Root 1 0 R >>\n%%EOF"
);

describe("VidyarthiAstra — Admin Pipeline UX, Language Selection & Publication Override Test Suite", () => {
    let server;
    let baseUrl;
    let adminToken;
    let studentToken;
    let keyPair;

    const ADMIN_UID = "qa_extended_admin_uid";
    const STUDENT_UID = "qa_extended_student_uid";

    before(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = PROJECT_ID;

        // Setup local RSA key pair for test token signing
        keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        registerTestPublicKey(keyPair.publicKey);

        function createToken(uid, email, role) {
            const now = Math.floor(Date.now() / 1000);
            const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
            const payload = {
                iss: `https://securetoken.google.com/${PROJECT_ID}`,
                aud: PROJECT_ID,
                sub: uid,
                user_id: uid,
                email: email,
                role: role,
                auth_time: now,
                iat: now,
                exp: now + 7200
            };
            const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
            const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
            const signInput = `${b64Header}.${b64Payload}`;
            const signer = crypto.createSign("RSA-SHA256");
            signer.update(signInput);
            return `${signInput}.${signer.sign(keyPair.privateKey, "base64url")}`;
        }

        adminToken = createToken(ADMIN_UID, "admin@vidyarthiastra.in", "admin");
        studentToken = createToken(STUDENT_UID, "student@vidyarthiastra.in", "user");

        // Seed users
        UniversalFirestoreService.clearLocalCache();
        await UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@vidyarthiastra.in",
            name: "Extended QA Admin",
            role: "admin",
            createdAt: new Date().toISOString()
        });
        await UniversalFirestoreService.setDocument("users", STUDENT_UID, {
            uid: STUDENT_UID,
            email: "student@vidyarthiastra.in",
            name: "Extended QA Student",
            role: "user",
            createdAt: new Date().toISOString()
        });

        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    // =========================================================================
    // TASK 1: Writable Target Exam Field & Backend Identity Resolution
    // =========================================================================
    describe("Task 1 — Target Exam Writable Field & Safe Identity Resolution", () => {
        test("1.1 Resolves standard known exams to stable canonical IDs", () => {
            const neet = ExamPatternService.resolveExamIdentity("NEET UG");
            assert.strictEqual(neet.examId, "neet-ug");
            assert.strictEqual(neet.examName, "NEET UG");

            const jee = ExamPatternService.resolveExamIdentity("   JEE Main 2024   ");
            assert.strictEqual(jee.examId, "jee-main");
            assert.strictEqual(jee.examName, "JEE Main 2024");

            const gate = ExamPatternService.resolveExamIdentity("GATE CS");
            assert.strictEqual(gate.examId, "gate");
            assert.strictEqual(gate.examName, "GATE CS");
        });

        test("1.2 Safely derives deterministic slug + hash for custom exam names", () => {
            const custom = ExamPatternService.resolveExamIdentity("Olympiad Biology 2026");
            assert.ok(custom.examId.startsWith("olympiad-biology-2026-"));
            assert.strictEqual(custom.examName, "Olympiad Biology 2026");

            // Same input produces identical ID
            const customRepeat = ExamPatternService.resolveExamIdentity("  Olympiad Biology 2026  ");
            assert.strictEqual(custom.examId, customRepeat.examId);
            assert.strictEqual(custom.examName, customRepeat.examName);
        });

        test("1.3 Rejects empty, whitespace-only, and excessively long exam names (>150 chars)", () => {
            assert.throws(() => ExamPatternService.resolveExamIdentity(""), /empty|required/);
            assert.throws(() => ExamPatternService.resolveExamIdentity("   "), /empty|required/);
            assert.throws(() => ExamPatternService.resolveExamIdentity(null), /string|required/);

            const overlong = "A".repeat(151);
            assert.throws(() => ExamPatternService.resolveExamIdentity(overlong), /150/);
        });

        test("1.4 Rejects path traversal and dangerous characters in exam name", () => {
            assert.throws(() => ExamPatternService.resolveExamIdentity("../../../etc/passwd"), /invalid characters/);
            assert.throws(() => ExamPatternService.resolveExamIdentity("Exam\0Name"), /invalid characters/);
        });

        test("1.5 API accepts custom examName in POST /api/admin/import/upload", async () => {
            const base64Pdf = VALID_DUMMY_PDF.toString("base64");
            const hash = crypto.createHash("sha256").update(VALID_DUMMY_PDF).digest("hex");

            const payload = {
                examName: "CLAT Entrance Exam 2024",
                year: 2024,
                paperType: "pyq",
                questionPaperFile: { name: "qp.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf },
                answerKeyFile: { name: "ak.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf },
                examPatternFile: { name: "ep.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf }
            };

            const res = await fetch(`${baseUrl}/api/admin/import/upload`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify(payload)
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.ok(data.jobId);
            assert.strictEqual(data.examName, "CLAT Entrance Exam 2024");
            assert.ok(data.examId.startsWith("clat-entrance-exam-2024-"));
        });

        test("1.6 API rejects empty or overlong examName with 400 Bad Request", async () => {
            const base64Pdf = VALID_DUMMY_PDF.toString("base64");
            const hash = crypto.createHash("sha256").update(VALID_DUMMY_PDF).digest("hex");

            const payload = {
                examName: "   ",
                year: 2024,
                paperType: "pyq",
                questionPaperFile: { name: "qp.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf },
                answerKeyFile: { name: "ak.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf },
                examPatternFile: { name: "ep.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf }
            };

            const res = await fetch(`${baseUrl}/api/admin/import/upload`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify(payload)
            });

            assert.strictEqual(res.status, 400);
            const err = await res.json();
            assert.ok(err.error.includes("Target Exam name"));
        });
    });

    // =========================================================================
    // TASK 2: Student Language Selection & Translation Integrity
    // =========================================================================
    describe("Task 2 — Student Language Selection & Attempt Localization", () => {
        let multiLangTestId;

        before(async () => {
            // Seed a test with English and Hindi translations
            multiLangTestId = `test_multilang_${Date.now()}`;
            const testDoc = {
                testId: multiLangTestId,
                title: "Bilingual Practice Test 2024",
                examId: "neet-ug",
                examName: "NEET UG",
                status: "published",
                isPublished: true,
                availableLanguages: ["English", "Hindi"],
                durationSeconds: 3600,
                totalQuestions: 2,
                maximumMarks: 8,
                createdAt: new Date().toISOString()
            };
            await UniversalFirestoreService.setDocument("mockTests", multiLangTestId, testDoc);

            // Seed questions with translations
            await UniversalFirestoreService.setDocument("mockQuestions", `${multiLangTestId}_q1`, {
                testId: multiLangTestId,
                questionId: "q1",
                questionNumber: 1,
                subject: "Physics",
                questionType: "mcq",
                questionText: "What is the unit of force?",
                options: [
                    { id: 1, label: "A", text: "Newton" },
                    { id: 2, label: "B", text: "Joule" },
                    { id: 3, label: "C", text: "Watt" },
                    { id: 4, label: "D", text: "Pascal" }
                ],
                translations: {
                    Hindi: {
                        questionText: "बल का मात्रक क्या है?",
                        options: [
                            { id: 1, label: "A", text: "न्यूटन" },
                            { id: 2, label: "B", text: "जूल" },
                            { id: 3, label: "C", text: "वाट" },
                            { id: 4, label: "D", text: "पास्कल" }
                        ]
                    }
                }
            });

            // Seed second question without Hindi translation (to test transparent fallback)
            await UniversalFirestoreService.setDocument("mockQuestions", `${multiLangTestId}_q2`, {
                testId: multiLangTestId,
                questionId: "q2",
                questionNumber: 2,
                subject: "Chemistry",
                questionType: "mcq",
                questionText: "What is the pH of pure water at 25°C?",
                options: [
                    { id: 1, label: "A", text: "7" },
                    { id: 2, label: "B", text: "1" },
                    { id: 3, label: "C", text: "14" },
                    { id: 4, label: "D", text: "0" }
                ]
            });

            // Seed authoritative answer key
            await UniversalFirestoreService.setDocument("mockAnswerKeys", multiLangTestId, {
                testId: multiLangTestId,
                keys: {
                    q1: { correctOptionId: 1, marksCorrect: 4, marksIncorrect: -1 },
                    q2: { correctOptionId: 1, marksCorrect: 4, marksIncorrect: -1 }
                }
            });
        });

        test("2.1 Student starts attempt specifying Hindi; language is persisted on attempt", async () => {
            const res = await fetch(`${baseUrl}/api/mock-tests/${multiLangTestId}/attempts`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${studentToken}`
                },
                body: JSON.stringify({ language: "Hindi" })
            });

            assert.strictEqual(res.status, 201);
            const data = await res.json();
            assert.ok(data.attempt);
            assert.strictEqual(data.attempt.language, "Hindi");
        });

        test("2.2 Rejects attempt creation when requesting unsupported language with 400", async () => {
            const res = await fetch(`${baseUrl}/api/mock-tests/${multiLangTestId}/attempts`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${studentToken}`
                },
                body: JSON.stringify({ language: "Tamil" })
            });

            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes("not supported"));
        });

        test("2.3 GET test questions with language=Hindi delivers localized text", async () => {
            const res = await fetch(`${baseUrl}/api/mock-tests/${multiLangTestId}?language=Hindi`, {
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.questions.length, 2);

            const q1 = data.questions[0];
            assert.strictEqual(q1.questionText, "बल का मात्रक क्या है?");
            assert.strictEqual(q1.options[0].text, "न्यूटन");
            assert.strictEqual(q1.questionId, "q1"); // Canonical ID preserved
            assert.strictEqual(q1.options[0].id, "1");  // Canonical option ID preserved
            assert.strictEqual(q1.translationMissing, false);
        });

        test("2.4 Transparent fallback to canonical English when translation is missing", async () => {
            const res = await fetch(`${baseUrl}/api/mock-tests/${multiLangTestId}?language=Hindi`, {
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            const data = await res.json();
            const q2 = data.questions[1];
            assert.strictEqual(q2.translationMissing, true);
            assert.strictEqual(q2.fallbackLanguage, "English");
            assert.strictEqual(q2.questionText, "What is the pH of pure water at 25°C?");
            assert.strictEqual(q2.options[0].text, "7");
        });

        test("2.5 Answer keys are NEVER leaked in student test payload", async () => {
            const res = await fetch(`${baseUrl}/api/mock-tests/${multiLangTestId}?language=Hindi`, {
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            const data = await res.json();
            data.questions.forEach(q => {
                assert.strictEqual(q.correctOptionId, undefined);
                assert.strictEqual(q.correctAnswer, undefined);
                assert.strictEqual(q.acceptedValues, undefined);
            });
        });

        test("2.6 Scoring is 100% invariant across attempt languages", () => {
            const questions = [
                { questionId: "q1", questionNumber: 1, questionType: "mcq" },
                { questionId: "q2", questionNumber: 2, questionType: "mcq" }
            ];
            const answerKeys = [
                { questionId: "q1", questionNumber: 1, correctOptionId: 1, marksAwarded: 4, marksDeducted: 1 },
                { questionId: "q2", questionNumber: 2, correctOptionId: 1, marksAwarded: 4, marksDeducted: 1 }
            ];

            const studentAnswers = { q1: "1", q2: "2" };

            // English attempt score
            const scoreEng = MockTestScoringService.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers
            });

            // Hindi attempt score with exact same answers
            const scoreHin = MockTestScoringService.evaluateAttempt({
                questions,
                answerKeys,
                studentAnswers
            });

            assert.strictEqual(scoreEng.totalScore, scoreHin.totalScore);
            assert.strictEqual(scoreEng.correctCount, 1);
            assert.strictEqual(scoreEng.incorrectCount, 1);
            assert.strictEqual(scoreEng.totalScore, 3); // 4 - 1 = 3
        });
    });

    // =========================================================================
    // TASK 3: Independent PDF Removal with Safe Lifecycle Handling
    // =========================================================================
    describe("Task 3 — Independent PDF Removal & Draft Lifecycle", () => {
        let testJob;

        before(async () => {
            const base64Pdf = VALID_DUMMY_PDF.toString("base64");
            const hash = crypto.createHash("sha256").update(VALID_DUMMY_PDF).digest("hex");

            testJob = await ImportJobPipelineService.createJob({
                examName: "Test Removal Exam",
                year: 2024,
                paperType: "pyq",
                actor: "QA Admin",
                files: {
                    questionPaper: { name: "qp.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf },
                    answerKey: { name: "ak.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf },
                    examPattern: { name: "ep.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf }
                }
            });

            await ImportJobPipelineService.attachDocuments(testJob.jobId, {
                questionPaper: { originalFilename: "qp.pdf", hash, localVaultPath: "vault_qp.pdf" },
                answerKey: { originalFilename: "ak.pdf", hash, localVaultPath: "vault_ak.pdf" },
                examPattern: { originalFilename: "ep.pdf", hash, localVaultPath: "vault_ep.pdf" }
            });
        });

        test("3.1 Independent removal of Question Paper preserves Answer Key and Exam Pattern", async () => {
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${testJob.jobId}/documents/questionPaper`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${adminToken}` }
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.docType, "questionPaper");

            const job = await ImportJobPipelineService.getJob(testJob.jobId);
            assert.strictEqual(job.sourceDocuments.questionPaper, null);
            assert.ok(job.sourceDocuments.answerKey);
            assert.ok(job.sourceDocuments.examPattern);
        });

        test("3.2 Rejects removal of files while import pipeline is actively processing", async () => {
            testJob.status = "processing";
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${testJob.jobId}/documents/answerKey`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${adminToken}` }
            });

            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes("actively processing"));
        });

        test("3.3 Rejects removal of source files from already published mock tests", async () => {
            testJob.status = "published";
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${testJob.jobId}/documents/answerKey`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${adminToken}` }
            });

            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes("published"));
        });

        test("3.4 Rejects unauthorized removal requests with 401 or 403", async () => {
            testJob.status = "draft";
            // Unauthenticated
            const resNoAuth = await fetch(`${baseUrl}/api/admin/import/jobs/${testJob.jobId}/documents/answerKey`, {
                method: "DELETE"
            });
            assert.strictEqual(resNoAuth.status, 401);

            // Student caller (non-admin)
            const resStudent = await fetch(`${baseUrl}/api/admin/import/jobs/${testJob.jobId}/documents/answerKey`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${studentToken}` }
            });
            assert.strictEqual(resStudent.status, 403);
        });
    });

    // =========================================================================
    // TASK 4: Controlled “Publish Ignoring Discrepancy” Option
    // =========================================================================
    describe("Task 4 — Controlled Publication Override & Audit Trail", () => {
        let overrideJobId;

        before(async () => {
            const base64Pdf = VALID_DUMMY_PDF.toString("base64");
            const hash = crypto.createHash("sha256").update(VALID_DUMMY_PDF).digest("hex");

            const job = await ImportJobPipelineService.createJob({
                examName: "Override Test Paper",
                year: 2024,
                paperType: "pyq",
                actor: "QA Admin",
                files: {
                    questionPaper: { name: "qp.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf },
                    answerKey: { name: "ak.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf },
                    examPattern: { name: "ep.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf }
                }
            });

            overrideJobId = job.jobId;

            // Seed questions: Q1 has a content warning (diagram/layout artifact), Q2 is clean
            job.extractedQuestions = [
                {
                    questionId: "q1",
                    questionNumber: 1,
                    subject: "Physics",
                    questionType: "mcq",
                    questionText: "What is the speed of light in vacuum?",
                    options: [
                        { id: 1, label: "A", text: "3 x 10^8 m/s" },
                        { id: 2, label: "B", text: "2 x 10^8 m/s" },
                        { id: 3, label: "C", text: "1.5 x 10^8 m/s" },
                        { id: 4, label: "D", text: "Infinite" }
                    ],
                    flagReason: "Minor layout anomaly: diagram artifact detected in margin",
                    validationStatus: "flagged"
                },
                {
                    questionId: "q2",
                    questionNumber: 2,
                    subject: "Physics",
                    questionType: "mcq",
                    questionText: "Which particle carries negative charge?",
                    options: [
                        { id: 1, label: "A", text: "Electron" },
                        { id: 2, label: "B", text: "Proton" },
                        { id: 3, label: "C", text: "Neutron" },
                        { id: 4, label: "D", text: "Photon" }
                    ],
                    validationStatus: "verified"
                }
            ];

            job.reconciledAnswers = [
                { questionId: "q1", correctOptionIds: [1], confidence: "high", verificationStatus: "verified" },
                { questionId: "q2", correctOptionIds: [1], confidence: "high", verificationStatus: "verified" }
            ];

            job.verifiedPattern = {
                patternId: "test-pattern",
                totalQuestions: 2,
                scoringRules: { correct: 4, incorrect: -1 }
            };

            job.sourceDocuments = {
                questionPaper: { originalFilename: "qp.pdf", hash },
                answerKey: { originalFilename: "ak.pdf", hash },
                examPattern: { originalFilename: "ep.pdf", hash }
            };

            job.sourceHashes = {
                questionPaper: hash,
                answerKey: hash,
                examPattern: hash
            };

            job.validationFingerprint = ImportJobPipelineService.computeValidationFingerprint({
                questions: job.extractedQuestions,
                answerKeys: job.reconciledAnswers,
                examConfig: job.verifiedPattern
            });

            job.status = "needs_review";
            job.validationReport = {
                canPublish: false,
                validatedFingerprint: job.validationFingerprint,
                blockers: ["Question 1 has content warnings"]
            };

            // Associate draft mockTest document
            await UniversalFirestoreService.setDocument("mockTests", overrideJobId, {
                testId: overrideJobId,
                examId: job.examId,
                examName: job.examName,
                year: job.year,
                title: "Override Test Paper 2024",
                status: "draft",
                totalQuestions: 2
            });
            job.draftPackage = {
                testId: overrideJobId,
                questions: job.extractedQuestions,
                answerKeys: job.reconciledAnswers,
                examConfig: job.verifiedPattern
            };
        });

        test("4.1 Server-authoritative classification separates fatal blockers from eligible warnings", async () => {
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${overrideJobId}/discrepancies`, {
                headers: { "Authorization": `Bearer ${adminToken}` }
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            const classification = data.discrepancyClassification || data;

            assert.strictEqual(classification.fatalBlockers.length, 0);
            assert.strictEqual(classification.eligibleWarnings.length, 1);
            assert.strictEqual(classification.canOverride, true);
            assert.strictEqual(classification.eligibleWarnings[0].id, "disc_q1");
        });

        test("4.2 Standard publish endpoint rejects import with discrepancies (canPublish = false)", async () => {
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${overrideJobId}/publish`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${adminToken}` }
            });

            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes("rejected") || data.error.includes("blocked") || data.error.includes("canPublish") || data.error.includes("gate") || data.error.includes("Gate") || data.error.includes("flags"));
        });

        test("4.3 Override publication rejects missing or too-short reason (< 10 chars)", async () => {
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${overrideJobId}/publish-override`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({
                    reason: "too short",
                    confirmationText: "PUBLISH WITH DISCREPANCIES",
                    acknowledgedDiscrepancyIds: ["disc_q1"]
                })
            });

            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes("at least 10 characters"));
        });

        test("4.4 Override publication rejects unacknowledged discrepancies", async () => {
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${overrideJobId}/publish-override`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({
                    reason: "Reviewed diagram artifact in margin; question stem is fully intact and verified.",
                    confirmationText: "PUBLISH WITH DISCREPANCIES",
                    acknowledgedDiscrepancyIds: [] // Missing acknowledgement
                })
            });

            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes("acknowledged") || data.error.includes("Missing"));
        });

        test("4.5 Override publication rejects invalid confirmation phrase", async () => {
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${overrideJobId}/publish-override`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({
                    reason: "Reviewed diagram artifact in margin; question stem is fully intact and verified.",
                    confirmationText: "yes publish",
                    acknowledgedDiscrepancyIds: ["disc_q1"]
                })
            });

            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes("PUBLISH WITH DISCREPANCIES"));
        });

        test("4.6 Override publication strictly rejects if fatal blocker is introduced (e.g. stale fingerprint)", async () => {
            const job = await ImportJobPipelineService.getJob(overrideJobId);
            const originalFingerprint = job.validationFingerprint;

            // Invalidate fingerprint
            job.validationFingerprint = "stale_fingerprint_hash_12345";
            job.validationReport.validatedFingerprint = "stale_fingerprint_hash_12345";

            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${overrideJobId}/publish-override`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({
                    reason: "Reviewed diagram artifact in margin; question stem is fully intact and verified.",
                    confirmationText: "PUBLISH WITH DISCREPANCIES",
                    acknowledgedDiscrepancyIds: ["disc_q1"]
                })
            });

            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes("Mandatory") || data.error.includes("fatal") || data.error.includes("STALE_FINGERPRINT") || data.error.includes("fingerprint"));

            // Restore valid fingerprint
            job.validationFingerprint = originalFingerprint;
            job.validationReport.validatedFingerprint = originalFingerprint;
        });

        test("4.7 Successful publication override records audit event, metadata, and publishes test", async () => {
            const reason = "Reviewed diagram artifact in margin; question stem is fully intact and verified.";
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${overrideJobId}/publish-override`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({
                    reason,
                    confirmationText: "PUBLISH WITH DISCREPANCIES",
                    acknowledgedDiscrepancyIds: ["disc_q1"]
                })
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.status, "published");

            // Verify in-memory and Firestore state
            const job = await ImportJobPipelineService.getJob(overrideJobId);
            assert.strictEqual(job.status, "published");
            assert.strictEqual(job.publishedWithDiscrepancies, true);
            assert.strictEqual(job.publicationMode, "override");

            // Verify audit log entry in job
            const auditEntry = job.auditLog.find(e => e.action === "TEST_PUBLISHED_OVERRIDE");
            assert.ok(auditEntry);
            assert.strictEqual(auditEntry.reason, reason);
            assert.deepStrictEqual(auditEntry.acknowledgedDiscrepancyIds, ["disc_q1"]);

            // Verify published mock test record has metadata
            const publishedTest = await UniversalFirestoreService.getDocument("mockTests", overrideJobId);
            assert.ok(publishedTest);
            assert.strictEqual(publishedTest.publishedWithDiscrepancies, true);
            assert.strictEqual(publishedTest.publicationMode, "override");
            assert.strictEqual(publishedTest.overrideReason, reason);
        });

        test("4.8 Duplicate publication override attempts are rejected", async () => {
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${overrideJobId}/publish-override`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({
                    reason: "Attempting duplicate override submission",
                    confirmationText: "PUBLISH WITH DISCREPANCIES",
                    acknowledgedDiscrepancyIds: ["disc_q1"]
                })
            });

            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes("already published"));
        });
    });
});
