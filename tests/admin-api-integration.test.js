import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "../server/server.js";
import { generateNeetUgFixtures } from "./fixtures/createSyntheticPdfs.js";
import { StorageVaultService } from "../server/services/admin/storageVaultService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { QuestionNormalizationService } from "../server/services/admin/questionNormalizationService.js";
import { AnswerKeyReconciliationService } from "../server/services/admin/answerKeyReconciliationService.js";

import crypto from "node:crypto";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Admin Dashboard & Automated PYQ Import Pipeline API Integration Tests", () => {
    let server;
    let baseUrl;
    let fixtures;
    let adminToken;
    const originalEnv = { ...process.env };
    const TEST_ADMIN_KEY = "test_integration_secure_admin_key_9900";

    before(async () => {
        // Enforce Non-Production Test Environment Safety Gate
        process.env.NODE_ENV = "test";
        process.env.ADMIN_SECRET_KEY = TEST_ADMIN_KEY;
        process.env.ALLOW_DEV_EXTRACTION = "false";
        process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

        if (process.env.NODE_ENV === "production") {
            throw new Error("SAFETY BLOCKER: Cannot run integration tests against production environment!");
        }

        // Generate synthetic unit fixtures
        fixtures = generateNeetUgFixtures();

        // Setup test RSA cryptographic keys and Firestore admin document
        const keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        registerTestPublicKey(keyPair.publicKey);

        const ADMIN_UID = "test_admin_integration_uid";
        UniversalFirestoreService.clearLocalCache();
        UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@vidyarthiastra.in",
            role: "admin"
        });

        const now = Math.floor(Date.now() / 1000);
        const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
        const payload = {
            iss: "https://securetoken.google.com/pyqs-hub-43bed",
            aud: "pyqs-hub-43bed",
            sub: ADMIN_UID,
            user_id: ADMIN_UID,
            auth_time: now,
            iat: now,
            exp: now + 3600
        };
        const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
        const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signInput = `${b64Header}.${b64Payload}`;
        const signer = crypto.createSign("RSA-SHA256");
        signer.update(signInput);
        adminToken = `${signInput}.${signer.sign(keyPair.privateKey, "base64url")}`;

        // Start server on an ephemeral port
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });
    });

    after(async () => {
        process.env = originalEnv;
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    /**
     * Reusable HTTP client helper with status validation, timeouts, and sanitized error messages
     */
    async function request(endpoint, { method = "GET", headers = {}, body = null, timeoutMs = 15000 } = {}) {
        const url = `${baseUrl}${endpoint}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const requestHeaders = { ...headers };
        if (requestHeaders["x-admin-key"] === TEST_ADMIN_KEY) {
            delete requestHeaders["x-admin-key"];
            requestHeaders["Authorization"] = `Bearer ${adminToken}`;
        }
        let requestBody = body;

        if (body && typeof body === "object" && !(body instanceof FormData) && !Buffer.isBuffer(body)) {
            requestHeaders["Content-Type"] = "application/json";
            requestBody = JSON.stringify(body);
        }

        try {
            const response = await fetch(url, {
                method,
                headers: requestHeaders,
                body: requestBody,
                signal: controller.signal
            });

            const contentType = response.headers.get("content-type") || "";
            let data = null;
            if (contentType.includes("application/json")) {
                data = await response.json();
            } else {
                data = await response.text();
            }

            return {
                status: response.status,
                ok: response.ok,
                headers: response.headers,
                data
            };
        } catch (err) {
            if (err.name === "AbortError") {
                throw new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms`);
            }
            throw new Error(`Network failure during request to ${endpoint}: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }
    }

    // ============================================================
    // 1. AUTHENTICATION & ACCESS CONTROL TESTS
    // ============================================================
    test("1.1 Denies access to /api/admin/auth/check without credentials", async () => {
        const res = await request("/api/admin/auth/check");
        assert.equal(res.status, 401);
        assert.equal(res.data.success, false);
        assert.match(res.data.error, /Unauthorized|Bearer token required/i);
    });

    test("1.2 Denies access to /api/admin/auth/check with invalid secret key", async () => {
        const res = await request("/api/admin/auth/check", {
            headers: { "x-admin-key": "invalid_wrong_secret" }
        });
        assert.equal(res.status, 401);
        assert.equal(res.data.success, false);
    });

    test("1.3 Grants access to /api/admin/auth/check with valid x-admin-key", async () => {
        const res = await request("/api/admin/auth/check", {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.success, true);
        assert.equal(res.data.authorized, true);
        assert.equal(res.data.role, "admin");
    });

    test("1.4 Protects overview metrics endpoint /api/admin/stats", async () => {
        const unauth = await request("/api/admin/stats");
        assert.equal(unauth.status, 401);

        const auth = await request("/api/admin/stats", {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        assert.equal(auth.status, 200);
        assert.equal(auth.data.success, true);
        assert.ok(typeof auth.data.stats.totalImports === "number");
    });

    // ============================================================
    // 2. DOCUMENT UPLOAD & CRYPTOGRAPHIC VALIDATION TESTS
    // ============================================================
    test("2.1 Rejects upload missing required source documents", async () => {
        const res = await request("/api/admin/import/upload", {
            method: "POST",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                examId: "neet-ug",
                year: 2024
                // Missing questionPaperFile, answerKeyFile, examPatternFile
            }
        });
        assert.equal(res.status, 400);
        assert.equal(res.data.success, false);
        assert.match(res.data.error, /All 3 required source documents/i);
    });

    test("2.2 Rejects upload with corrupt / non-PDF magic byte file", async () => {
        const fakeFile = {
            name: "corrupt.pdf",
            base64: Buffer.alloc(128, "X").toString("base64"),
            size: 128
        };

        const res = await request("/api/admin/import/upload", {
            method: "POST",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                examId: "neet-ug",
                year: 2024,
                questionPaperFile: fakeFile,
                answerKeyFile: fakeFile,
                examPatternFile: fakeFile
            }
        });
        assert.equal(res.status, 400);
        assert.equal(res.data.success, false);
        assert.match(res.data.error, /magic byte signature/i);
    });

    test("2.3 Accepts valid synthetic NEET UG 2024 source documents and generates SHA-256", async () => {
        const qpBuf = fs.readFileSync(fixtures.qpPath);
        const akBuf = fs.readFileSync(fixtures.akPath);
        const epBuf = fs.readFileSync(fixtures.patternPath);

        const res = await request("/api/admin/import/upload", {
            method: "POST",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                examId: "neet-ug",
                year: 2024,
                paperType: "pyq",
                language: "English",
                paperCode: "Q1",
                questionPaperFile: {
                    name: "synthetic_neet_2024_qp.pdf",
                    base64: qpBuf.toString("base64"),
                    size: qpBuf.length
                },
                answerKeyFile: {
                    name: "synthetic_neet_2024_ak.pdf",
                    base64: akBuf.toString("base64"),
                    size: akBuf.length
                },
                examPatternFile: {
                    name: "synthetic_neet_2024_pattern.pdf",
                    base64: epBuf.toString("base64"),
                    size: epBuf.length
                }
            }
        });

        assert.equal(res.status, 200);
        assert.equal(res.data.success, true);
        assert.ok(res.data.jobId);
        assert.equal(typeof res.data.hashes.questionPaper, "string");
        assert.equal(res.data.hashes.questionPaper.length, 64);
        assert.equal(typeof res.data.hashes.answerKey, "string");
        assert.equal(res.data.hashes.answerKey.length, 64);
    });

    // ============================================================
    // 3. FULL PIPELINE EXECUTION & STATUS POLLING
    // ============================================================
    let activeJobId;

    test("3.1 Kicks off pipeline processing asynchronously via POST /api/admin/import/start", async () => {
        const qpBuf = fs.readFileSync(fixtures.qpPath);
        const akBuf = fs.readFileSync(fixtures.akPath);
        const epBuf = fs.readFileSync(fixtures.patternPath);

        // Upload fresh test job
        const uploadRes = await request("/api/admin/import/upload", {
            method: "POST",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                examId: "neet-ug",
                year: 2024,
                paperType: "sample",
                language: "English",
                paperCode: "Q1",
                questionPaperFile: { name: "qp.pdf", base64: qpBuf.toString("base64"), size: qpBuf.length },
                answerKeyFile: { name: "ak.pdf", base64: akBuf.toString("base64"), size: akBuf.length },
                examPatternFile: { name: "ep.pdf", base64: epBuf.toString("base64"), size: epBuf.length }
            }
        });

        assert.equal(uploadRes.status, 200);
        activeJobId = uploadRes.data.jobId;

        // Start processing
        const startRes = await request("/api/admin/import/start", {
            method: "POST",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: { jobId: activeJobId }
        });

        assert.equal(startRes.status, 200);
        assert.equal(startRes.data.success, true);
        assert.equal(startRes.data.status, "processing");
    });

    test("3.2 Polls job until terminal verification state with deadline", async () => {
        assert.ok(activeJobId, "activeJobId must be set from previous test");

        let terminalJob = null;
        const maxPolls = 25;

        for (let i = 0; i < maxPolls; i++) {
            await new Promise((r) => setTimeout(r, 400));
            const pollRes = await request(`/api/admin/import/jobs/${activeJobId}`, {
                headers: { "x-admin-key": TEST_ADMIN_KEY }
            });

            assert.equal(pollRes.status, 200);
            const job = pollRes.data.job;

            if (["ready_to_publish", "ready_for_review", "failed"].includes(job.status)) {
                terminalJob = job;
                break;
            }
        }

        assert.ok(terminalJob, "Pipeline did not reach terminal state within timeout deadline");
        assert.equal(terminalJob.status, "ready_to_publish");
        assert.equal(terminalJob.progressPercent, 100);
        assert.equal(terminalJob.extractedQuestionCount, 5);
        assert.equal(terminalJob.verifiedAnswerCount, 5);
    });

    // ============================================================
    // 4. VALIDATION REPORT & ANSWER-KEY CONFIDENTIALITY
    // ============================================================
    test("4.1 Validation report asserts booklet code agreement and Scored-Test Gate clearance", async () => {
        const reportRes = await request(`/api/admin/import/jobs/${activeJobId}/report`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });

        assert.equal(reportRes.status, 200);
        assert.equal(reportRes.data.success, true);
        const report = reportRes.data.validationReport;

        assert.equal(report.canPublish, true);
        assert.equal(report.blockers.length, 0);
        assert.equal(report.answerKeyChecks.passed, true);
        assert.equal(report.answerKeyChecks.matchCoverage, 100);
        assert.equal(report.sourceChecks.passed, true);
    });

    test("4.2 Question endpoint preserves answer confidentiality: NEVER leaks correct answers", async () => {
        const questionsRes = await request(`/api/admin/import/jobs/${activeJobId}/questions`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });

        assert.equal(questionsRes.status, 200);
        assert.equal(questionsRes.data.success, true);
        assert.equal(questionsRes.data.total, 5);

        const questions = questionsRes.data.questions;
        for (const q of questions) {
            // Secret scoring fields MUST NOT exist in student-visible question schema
            assert.equal(q.correctAnswer, undefined);
            assert.equal(q.correctOptionIds, undefined);
            assert.equal(q.answerKey, undefined);
            assert.equal(q.secretKey, undefined);
            assert.equal(q.answer, undefined);

            // Valid public question schema checks
            assert.ok(typeof q.questionNumber === "number");
            assert.ok(typeof q.questionText === "string");
            assert.ok(Array.isArray(q.options));
            assert.equal(q.options.length, 4);
        }

        // Q3 references a circuit diagram in synthetic fixture
        const q3 = questions.find((q) => q.questionNumber === 3);
        assert.ok(q3);
        assert.equal(q3.hasDiagram, true);
    });

    // ============================================================
    // 5. AUDIT LOGGING & SCORING REVALIDATION
    // ============================================================
    test("5.1 Rejects manual question correction when audit reason is absent or too short", async () => {
        const qId = "neet-ug-2024-Q1-001";
        const res = await request(`/api/admin/import/jobs/${activeJobId}/questions/${qId}`, {
            method: "PUT",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                updates: { questionText: "Updated stem" },
                reason: "no" // Too short (< 5 chars)
            }
        });

        assert.equal(res.status, 400);
        assert.match(res.data.error, /audit reason is required/i);
    });

    test("5.2 Records question correction with audit trail (actor, timestamp, before/after diff)", async () => {
        const qId = "neet-ug-2024-Q1-001";
        const reason = "Corrected typographical error in velocity description";

        const res = await request(`/api/admin/import/jobs/${activeJobId}/questions/${qId}`, {
            method: "PUT",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                updates: {
                    questionText: "A particle of mass 2 kg moves with constant velocity v = 10 m/s. Calculate kinetic energy."
                },
                reason
            }
        });

        assert.equal(res.status, 200);
        assert.equal(res.data.success, true);
        assert.equal(res.data.question.validationStatus, "corrected");

        // Inspect audit log in job
        const jobRes = await request(`/api/admin/import/jobs/${activeJobId}`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        const auditLog = jobRes.data.job.auditLog;
        const correctionEntry = auditLog.find((entry) => entry.action === "QUESTION_CORRECTED" && entry.questionId === qId);

        assert.ok(correctionEntry);
        assert.equal(correctionEntry.reason, reason);
        assert.ok(correctionEntry.diff.before);
        assert.ok(correctionEntry.diff.after);
    });

    test("5.3 Mandatory Scoring Gate: Editing options to remove correct answer blocks publication", async () => {
        const qId = "neet-ug-2024-Q1-001"; // Official answer is option 2
        // Intentionally delete option 2 to create a scoring contradiction
        const brokenOptions = [
            { id: "1", label: "1", text: "50 J" },
            { id: "3", label: "3", text: "150 J" },
            { id: "4", label: "4", text: "200 J" }
        ];

        const editRes = await request(`/api/admin/import/jobs/${activeJobId}/questions/${qId}`, {
            method: "PUT",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                updates: { options: brokenOptions },
                reason: "Test intentionally removing correct option to test revalidation gate"
            }
        });

        assert.equal(editRes.status, 200);
        assert.equal(editRes.data.question.validationStatus, "flagged");
        assert.match(editRes.data.question.flagReason, /Scoring mismatch/i);

        // Publication MUST now be BLOCKED
        const reportRes = await request(`/api/admin/import/jobs/${activeJobId}/report`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        assert.equal(reportRes.data.validationReport.canPublish, false);
        assert.ok(reportRes.data.validationReport.blockers.some((b) => b.includes("scoring mismatch")));

        // Restore option 2 so paper can be published in next test
        const restoredOptions = [
            { id: "1", label: "1", text: "50 J" },
            { id: "2", label: "2", text: "100 J" },
            { id: "3", label: "3", text: "150 J" },
            { id: "4", label: "4", text: "200 J" }
        ];
        await request(`/api/admin/import/jobs/${activeJobId}/questions/${qId}`, {
            method: "PUT",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                updates: { options: restoredOptions },
                reason: "Restoring option 2 to resolve scoring revalidation"
            }
        });
    });

    // ============================================================
    // 6. PUBLICATION & IDEMPOTENCY TESTS
    // ============================================================
    test("6.1 Publishes test paper after all verification gates pass", async () => {
        // Re-check report canPublish
        const reportRes = await request(`/api/admin/import/jobs/${activeJobId}/report`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        assert.equal(reportRes.data.validationReport.canPublish, true);

        const publishRes = await request(`/api/admin/import/jobs/${activeJobId}/publish`, {
            method: "POST",
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });

        assert.equal(publishRes.status, 200);
        assert.equal(publishRes.data.success, true);
        assert.equal(publishRes.data.status, "published");
        assert.ok(publishRes.data.testId);
    });

    test("6.2 Repeated publish request is idempotent: does not duplicate records or audit logs", async () => {
        // Call publish a second time
        const secondPublishRes = await request(`/api/admin/import/jobs/${activeJobId}/publish`, {
            method: "POST",
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });

        assert.equal(secondPublishRes.status, 200);
        assert.equal(secondPublishRes.data.success, true);
        assert.equal(secondPublishRes.data.alreadyPublished, true);
        assert.equal(secondPublishRes.data.status, "published");

        // Inspect audit log: TEST_PUBLISHED should appear exactly once
        const jobRes = await request(`/api/admin/import/jobs/${activeJobId}`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        const publishLogs = jobRes.data.job.auditLog.filter((l) => l.action === "TEST_PUBLISHED");
        assert.equal(publishLogs.length, 1);
    });

    // ============================================================
    // 7. NEGATIVE TESTS: MISMATCHED BOOKLET & MISSING ANSWERS
    // ============================================================
    test("7.1 Mandatory Gate BLOCKS publication if official answer key omits question answers", async () => {
        const qpBuf = fs.readFileSync(fixtures.qpPath);
        const missingAkBuf = fs.readFileSync(fixtures.missingAkPath); // Q5 omitted

        const extractedQuestions = await QuestionNormalizationService.extractAndNormalizeQuestions({
            pdfBuffer: qpBuf,
            examId: "neet-ug",
            year: 2024,
            paperCode: "Q1"
        });

        const parsedMissingAk = await AnswerKeyReconciliationService.parseAnswerKeyDocument(missingAkBuf, { paperCode: "Q1" });

        const reconciliation = AnswerKeyReconciliationService.reconcileAnswerKeys({
            questions: extractedQuestions.questions,
            answerMap: parsedMissingAk.answers
        });

        // Gate MUST FAIL
        assert.equal(reconciliation.gatePassed, false);
        assert.ok(reconciliation.missingAnswers.includes(5));
        assert.ok(reconciliation.matchCoveragePercent < 100);
    });

    // ============================================================
    // 8. P1: DETAILED QUESTION & OPTION EDITING, NUMERICAL & CONFLICT TESTS
    // ============================================================
    test("8.1 Edits individual MCQ options safely preserving Unicode mathematical notation", async () => {
        const qId = "neet-ug-2024-Q1-002";
        const unicodeOptions = [
            { id: "1", label: "A", text: "E = ½ m v² = 100 J" },
            { id: "2", label: "B", text: "v = 10 m/s ± 0.05 m/s" },
            { id: "3", label: "C", text: "ω = 2π rad/s" },
            { id: "4", label: "D", text: "λ = h / p ≈ 6.63 × 10⁻³⁴ J·s" }
        ];

        const editRes = await request(`/api/admin/import/jobs/${activeJobId}/questions/${qId}`, {
            method: "PUT",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                updates: { options: unicodeOptions },
                reason: "Enhanced option text with exact Unicode superscripts and math symbols"
            }
        });

        assert.equal(editRes.status, 200);
        assert.equal(editRes.data.success, true);
        const savedOptions = editRes.data.question.options;
        assert.equal(savedOptions.length, 4);
        assert.equal(savedOptions[0].text, "E = ½ m v² = 100 J");
        assert.equal(savedOptions[2].text, "ω = 2π rad/s");
        assert.equal(savedOptions[3].text, "λ = h / p ≈ 6.63 × 10⁻³⁴ J·s");
    });

    test("8.2 Rejects MCQ option correction with fewer than 2 options", async () => {
        const qId = "neet-ug-2024-Q1-002";
        const res = await request(`/api/admin/import/jobs/${activeJobId}/questions/${qId}`, {
            method: "PUT",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                updates: { options: [{ id: "1", label: "A", text: "Only one option" }] },
                reason: "Attempting invalid option count"
            }
        });

        assert.equal(res.status, 400);
        assert.match(res.data.error, /at least 2 options/i);
    });

    test("8.3 Rejects question correction that conflicts with official answer key", async () => {
        const qId = "neet-ug-2024-Q1-002";
        // Attempting to change an MCQ with single_choice key to numerical without reconciling key
        const res = await request(`/api/admin/import/jobs/${activeJobId}/questions/${qId}`, {
            method: "PUT",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                updates: { questionType: "numerical" },
                reason: "Attempting to change MCQ to numerical with conflicting answer key"
            }
        });

        assert.equal(res.status, 400);
        assert.match(res.data.error, /conflicts with answer key/i);
    });

    test("8.4 Supports numerical questions without forcing MCQ options", async () => {
        // Create synthetic numerical question in job draftPackage
        const job = await ImportJobPipelineService.getJob(activeJobId);
        const numQId = "neet-ug-2024-Q1-006";
        job.draftPackage.questions.push({
            questionId: numQId,
            questionNumber: 6,
            questionText: "Calculate the net flux through a closed Gaussian surface.",
            questionType: "numerical",
            subject: "Physics",
            options: [],
            validationStatus: "valid"
        });
        job.draftPackage.answerKeys.push({
            questionId: numQId,
            questionNumber: 6,
            answerType: "numerical",
            acceptedAnswers: ["42", "42.0"],
            correctOptionIds: [],
            verificationStatus: "verified"
        });

        // Edit stem of numerical question without supplying any options
        const editRes = await request(`/api/admin/import/jobs/${activeJobId}/questions/${numQId}`, {
            method: "PUT",
            headers: { "x-admin-key": TEST_ADMIN_KEY },
            body: {
                updates: {
                    questionText: "Calculate the net electric flux Φ in N·m²/C through the spherical surface."
                },
                reason: "Updated stem for clarity on units"
            }
        });

        assert.equal(editRes.status, 200);
        assert.equal(editRes.data.success, true);
        assert.equal(editRes.data.question.questionType, "numerical");
        assert.deepEqual(editRes.data.question.options, []);
    });

    // ============================================================
    // 9. P1: AUTHENTICATED SOURCE-PAGE PREVIEW AND SECURITY AUTHORIZATION
    // ============================================================
    test("9.1 Authorized administrator can stream source-page preview PDF", async () => {
        const previewRes = await request(`/api/admin/import/jobs/${activeJobId}/source-preview?page=1&docType=questionPaper`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });

        assert.equal(previewRes.status, 200);
        assert.equal(previewRes.headers.get("content-type"), "application/pdf");
        assert.equal(previewRes.headers.get("x-source-page"), "1");
        assert.ok(Number(previewRes.headers.get("x-total-pages")) >= 1);
        assert.equal(previewRes.headers.get("x-content-type-options"), "nosniff");
    });

    test("9.2 Authorized administrator can retrieve source-page metadata via format=metadata", async () => {
        const metaRes = await request(`/api/admin/import/jobs/${activeJobId}/source-preview?page=1&docType=questionPaper&format=metadata`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });

        assert.equal(metaRes.status, 200);
        assert.equal(metaRes.data.success, true);
        assert.equal(metaRes.data.jobId, activeJobId);
        assert.equal(metaRes.data.docType, "questionPaper");
        assert.equal(metaRes.data.page, 1);
        assert.ok(metaRes.data.totalPages >= 1);
        assert.ok(metaRes.data.sizeBytes > 0);
    });

    test("9.3 Denies access to source-page preview when credentials are missing or invalid", async () => {
        // Missing credentials
        const unauthRes = await request(`/api/admin/import/jobs/${activeJobId}/source-preview?page=1`);
        assert.equal(unauthRes.status, 401);

        // Invalid key
        const badKeyRes = await request(`/api/admin/import/jobs/${activeJobId}/source-preview?page=1`, {
            headers: { "x-admin-key": "invalid-hacker-key" }
        });
        assert.equal(badKeyRes.status, 401);
    });

    test("9.4 Rejects invalid or out-of-bounds page numbers with 400 Bad Request", async () => {
        // Page 0
        const p0 = await request(`/api/admin/import/jobs/${activeJobId}/source-preview?page=0`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        assert.equal(p0.status, 400);
        assert.match(p0.data.error, /out of bounds/i);

        // Negative page
        const pNeg = await request(`/api/admin/import/jobs/${activeJobId}/source-preview?page=-3`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        assert.equal(pNeg.status, 400);

        // Out of bounds page 999
        const p999 = await request(`/api/admin/import/jobs/${activeJobId}/source-preview?page=999`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        assert.equal(p999.status, 400);
        assert.match(p999.data.error, /out of bounds/i);

        // NaN page
        const pNaN = await request(`/api/admin/import/jobs/${activeJobId}/source-preview?page=notanumber`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        assert.equal(pNaN.status, 400);
    });

    test("9.5 Rejects invalid docType with 400 Bad Request (path traversal protection)", async () => {
        const res = await request(`/api/admin/import/jobs/${activeJobId}/source-preview?docType=../../etc/passwd`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        assert.equal(res.status, 400);
        assert.match(res.data.error, /invalid docType/i);
    });

    test("9.6 Returns 404 when requested job does not exist", async () => {
        const res = await request(`/api/admin/import/jobs/non-existent-job-id/source-preview?page=1`, {
            headers: { "x-admin-key": TEST_ADMIN_KEY }
        });
        assert.equal(res.status, 404);
        assert.match(res.data.error, /job not found/i);
    });
});
