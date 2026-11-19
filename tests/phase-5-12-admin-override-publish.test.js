import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import app from "../server/server.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";

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

describe("PHASE 5.12 — Admin Validation Override: 'Ignore and Publish' Test Suite", () => {
    let server;
    let baseUrl;
    let adminToken;
    let studentToken;
    let keyPair;

    const ADMIN_UID = "qa_override_admin_512";
    const STUDENT_UID = "qa_override_student_512";

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

        adminToken = createToken(ADMIN_UID, "admin512@vidyarthiastra.in", "admin");
        studentToken = createToken(STUDENT_UID, "student512@vidyarthiastra.in", "user");

        // Seed users
        UniversalFirestoreService.clearLocalCache();
        await UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin512@vidyarthiastra.in",
            role: "admin",
            createdAt: new Date().toISOString()
        });
        await UniversalFirestoreService.setDocument("users", STUDENT_UID, {
            uid: STUDENT_UID,
            email: "student512@vidyarthiastra.in",
            role: "user",
            createdAt: new Date().toISOString()
        });

        // Start server on ephemeral port
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", () => {
                const addr = server.address();
                baseUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    // =========================================================================
    // 1. ACCESS CONTROL & AUTHORIZATION
    // =========================================================================
    describe("1. Centralized Authorization & Route Protection", () => {
        const dummyTestId = "test-auth-guard-512";

        test("Unauthenticated requests receive HTTP 401 Unauthorized", async () => {
            const res = await fetch(`${baseUrl}/api/admin/mock-tests/${dummyTestId}/override-publish`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason: "Unauthorized attempt" })
            });
            assert.strictEqual(res.status, 401);
        });

        test("Student accounts receive HTTP 403 Forbidden", async () => {
            const res = await fetch(`${baseUrl}/api/admin/mock-tests/${dummyTestId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${studentToken}`
                },
                body: JSON.stringify({ reason: "Student attempt" })
            });
            assert.strictEqual(res.status, 403);
        });

        test("Job-based override endpoint also rejects non-admin callers with 403", async () => {
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/some-job/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${studentToken}`
                },
                body: JSON.stringify({ reason: "Student attempt" })
            });
            assert.strictEqual(res.status, 403);
        });
    });

    // =========================================================================
    // 2. NORMAL PUBLISH STRICTNESS VS. OVERRIDE PUBLISH
    // =========================================================================
    describe("2. Standard Publish Gate Preserves Strictness", () => {
        let strictJobId;
        const testId = "mock-strict-gate-512";

        before(async () => {
            const base64Pdf = VALID_DUMMY_PDF.toString("base64");
            const hash = crypto.createHash("sha256").update(VALID_DUMMY_PDF).digest("hex");

            const job = await ImportJobPipelineService.createJob({
                examName: "Strict Validation Paper",
                year: 2025,
                paperType: "pyq",
                actor: "QA Admin",
                files: {
                    questionPaper: { name: "qp.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf },
                    answerKey: { name: "ak.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf },
                    examPattern: { name: "ep.pdf", size: VALID_DUMMY_PDF.length, hash, base64: base64Pdf }
                }
            });

            strictJobId = job.jobId;
            job.status = "needs_review";
            job.validationReport = {
                canPublish: false,
                blockers: [
                    "Question Count Blocker: Expected 100 questions according to verified pattern, but extracted 98.",
                    "Fidelity Gate: 3 questions contain unverified text artifacts."
                ]
            };
            job.draftPackage = {
                testId,
                title: "Strict Validation Mock Test (2025)",
                questions: [{ questionId: "q1", questionNumber: 1, questionText: "Sample question?" }],
                answerKeys: [{ questionId: "q1", correctOptionIds: ["A"] }]
            };
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                title: "Strict Validation Mock Test (2025)",
                questions: job.draftPackage.questions
            });
            await UniversalFirestoreService.setDocument("paperImportJobs", strictJobId, job);
        });

        test("Standard publish endpoint refuses publication when validation blockers exist", async () => {
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${strictJobId}/publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                }
            });
            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.strictEqual(data.success, false);
            assert.match(data.error || "", /rejected publication|cannot publish/i);
        });

        test("Override publish endpoint successfully publishes despite validation blockers", async () => {
            const res = await fetch(`${baseUrl}/api/admin/import/jobs/${strictJobId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: "Deliberate QA verification override" })
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.status, "published");
            assert.strictEqual(data.publicationMethod, "ADMIN_OVERRIDE");
            assert.strictEqual(data.publishedWithValidationOverride, true);
        });
    });

    // =========================================================================
    // 3. UNIVERSAL OVERRIDE ELIGIBILITY ACROSS ALL DISCREPANCY SEVERITIES
    // =========================================================================
    describe("3. Universal Discrepancy Eligibility (Critical, Major, Minor, Warnings)", () => {
        test("Override succeeds for CRITICAL errors (e.g. missing document hashes / fatal blockers)", async () => {
            const testId = "mock-critical-override-512";
            const job = {
                jobId: "job-critical-512",
                status: "needs_review",
                examId: "neet-ug",
                examName: "NEET UG Critical Discrepancy",
                year: 2025,
                sourceDocuments: {}, // Missing all source documents!
                validationReport: {
                    canPublish: false,
                    blockers: [
                        "Missing source document: Question Paper is missing or tampered.",
                        "Fatal Integrity: Document checksum mismatch."
                    ]
                },
                draftPackage: {
                    testId,
                    title: "NEET UG Critical Mock Test",
                    questions: [{ questionId: "crit_q1", questionNumber: 1, questionText: "Critical test question?" }],
                    answerKeys: [{ questionId: "crit_q1", correctOptionIds: ["1"] }]
                }
            };
            await UniversalFirestoreService.setDocument("paperImportJobs", job.jobId, job);
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                title: "NEET UG Critical Mock Test",
                questions: job.draftPackage.questions
            });

            // Admin calls override-publish
            const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: "Admin override of critical document mismatch" })
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.publishedWithValidationOverride, true);

            // Verify stored test document
            const testDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
            assert.strictEqual(testDoc.status, "published");
            assert.strictEqual(testDoc.publicationMethod, "ADMIN_OVERRIDE");
            assert.strictEqual(testDoc.publishedWithValidationOverride, true);
            assert.strictEqual(testDoc.publishedWithDiscrepancies, true);
        });

        test("Override succeeds for MAJOR errors (e.g. UIR schema failure, section mismatch)", async () => {
            const testId = "mock-major-override-512";
            const job = {
                jobId: "job-major-512",
                status: "needs_review",
                examId: "gate-cs",
                examName: "GATE CS Major Discrepancy",
                year: 2025,
                uirValidation: {
                    approvalStatus: "rejected",
                    blockers: [
                        "UIR Schema Error: Section 'Engineering Mathematics' does not match defined pattern boundaries.",
                        "Section mapping mismatch: 15 questions missing required section tag."
                    ]
                },
                validationReport: {
                    canPublish: false,
                    blockers: ["UIR Validation Rejected: Structural section mapping discrepancy"]
                },
                draftPackage: {
                    testId,
                    title: "GATE CS Major Mock Test",
                    questions: [{ questionId: "maj_q1", questionNumber: 1, questionText: "Major test question?" }],
                    answerKeys: [{ questionId: "maj_q1", correctOptionIds: ["2"] }]
                }
            };
            await UniversalFirestoreService.setDocument("paperImportJobs", job.jobId, job);
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                title: "GATE CS Major Mock Test"
            });

            const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: "Approved via manual syllabus alignment review" })
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.publishedWithValidationOverride, true);
        });

        test("Override succeeds for MINOR errors and WARNINGS (e.g. content fidelity artifacts)", async () => {
            const testId = "mock-minor-override-512";
            const job = {
                jobId: "job-minor-512",
                status: "needs_review",
                examId: "ssc-cgl",
                examName: "SSC CGL Minor Warning Paper",
                year: 2025,
                validationReport: {
                    canPublish: false,
                    blockers: [
                        "Content Fidelity Gate: Question 12 contains diagram artifact.",
                        "Answer Key Notice: Question 34 has low OCR confidence score 62%."
                    ]
                },
                draftPackage: {
                    testId,
                    title: "SSC CGL Minor Mock Test",
                    questions: [{ questionId: "min_q1", questionNumber: 1, questionText: "Minor test question?" }],
                    answerKeys: [{ questionId: "min_q1", correctOptionIds: ["B"] }]
                }
            };
            await UniversalFirestoreService.setDocument("paperImportJobs", job.jobId, job);
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                title: "SSC CGL Minor Mock Test"
            });

            const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: "Diagram manually verified by subject lead" })
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
        });
    });

    // =========================================================================
    // 4. OPTIONAL REASON FIELD HANDLING
    // =========================================================================
    describe("4. Optional Reason Handling", () => {
        test("Override publish succeeds when reason is omitted or empty", async () => {
            const testId = "mock-empty-reason-512";
            const job = {
                jobId: "job-empty-reason-512",
                status: "needs_review",
                examId: "neet-ug",
                year: 2025,
                draftPackage: {
                    testId,
                    title: "NEET Empty Reason Test",
                    questions: [{ questionId: "q_er1", questionNumber: 1, questionText: "Reason test question?" }]
                }
            };
            await UniversalFirestoreService.setDocument("paperImportJobs", job.jobId, job);
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                title: "NEET Empty Reason Test"
            });

            // Call with empty body {}
            const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({})
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);

            const testDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
            assert.strictEqual(testDoc.status, "published");
            assert.strictEqual(testDoc.overrideReason, "");
        });

        test("Override publish records custom administrator reason when provided", async () => {
            const testId = "mock-custom-reason-512";
            const customReason = "Emergency operational release approved by exam director under ticket INC-8821.";
            const job = {
                jobId: "job-custom-reason-512",
                status: "needs_review",
                examId: "gate-cs",
                year: 2025,
                draftPackage: {
                    testId,
                    title: "GATE Custom Reason Test",
                    questions: [{ questionId: "q_cr1", questionNumber: 1, questionText: "Reason test question 2?" }]
                }
            };
            await UniversalFirestoreService.setDocument("paperImportJobs", job.jobId, job);
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                title: "GATE Custom Reason Test"
            });

            const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: customReason })
            });

            assert.strictEqual(res.status, 200);
            const testDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
            assert.strictEqual(testDoc.overrideReason, customReason);
        });
    });

    // =========================================================================
    // 5. DATA & SCORING INTEGRITY GUARANTEES (ZERO AUTOMATIC MODIFICATIONS)
    // =========================================================================
    describe("5. Complete Data & Scoring Rule Immutability", () => {
        test("Questions, answer keys, scoring rules, and UIR records remain 100% UNCHANGED", async () => {
            const testId = "mock-data-integrity-512";

            const originalQuestions = [
                {
                    questionId: "int_q1",
                    questionNumber: 1,
                    subject: "Physics",
                    sectionId: "sec-a",
                    questionType: "mcq",
                    questionText: "What is Planck's constant?",
                    options: [
                        { id: "A", text: "6.626 x 10^-34 J s" },
                        { id: "B", text: "3.00 x 10^8 m/s" }
                    ],
                    positiveMarks: 4,
                    negativeMarks: 1
                },
                {
                    questionId: "int_q2",
                    questionNumber: 2,
                    subject: "Chemistry",
                    sectionId: "sec-b",
                    questionType: "numerical",
                    questionText: "Calculate the molarity (numerical integer value):",
                    options: [],
                    positiveMarks: 2,
                    negativeMarks: 0
                }
            ];

            const originalAnswerKeys = [
                { questionId: "int_q1", answerType: "mcq", correctOptionIds: ["A"] },
                { questionId: "int_q2", answerType: "numerical", acceptedAnswers: ["5"] }
            ];

            const originalUirDocument = {
                version: "3.0",
                testId,
                examMetadata: { examId: "neet-ug", year: 2025 },
                sections: [
                    { sectionId: "sec-a", scoringRules: { positiveMarks: 4, negativeMarks: -1 } },
                    { sectionId: "sec-b", scoringRules: { positiveMarks: 2, negativeMarks: 0 } }
                ],
                items: originalQuestions
            };

            const job = {
                jobId: "job-data-integrity-512",
                status: "needs_review",
                examId: "neet-ug",
                year: 2025,
                uirDocument: originalUirDocument,
                validationReport: {
                    canPublish: false,
                    blockers: ["Integrity check blocker: simulated discrepancy"]
                },
                draftPackage: {
                    testId,
                    title: "Data Integrity Protected Test",
                    questions: JSON.parse(JSON.stringify(originalQuestions)),
                    answerKeys: JSON.parse(JSON.stringify(originalAnswerKeys))
                }
            };

            // Seed questions in Firestore
            for (const q of originalQuestions) {
                await UniversalFirestoreService.setDocument("mockQuestions", q.questionId, q);
            }
            await UniversalFirestoreService.setDocument("paperImportJobs", job.jobId, job);
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                title: "Data Integrity Protected Test",
                questions: originalQuestions,
                answerKeys: originalAnswerKeys,
                uirDocument: originalUirDocument
            });

            // Execute override publish
            const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: "Integrity verification publish" })
            });

            assert.strictEqual(res.status, 200);

            // Fetch stored records and verify question and scoring identity
            const afterTest = await UniversalFirestoreService.getDocument("mockTests", testId);
            const afterQ1 = await UniversalFirestoreService.getDocument("mockQuestions", "int_q1");
            const afterQ2 = await UniversalFirestoreService.getDocument("mockQuestions", "int_q2");

            assert.deepStrictEqual(afterTest.questions, originalQuestions);
            assert.deepStrictEqual(afterTest.answerKeys, originalAnswerKeys);
            assert.deepStrictEqual(afterTest.uirDocument, originalUirDocument);
            assert.strictEqual(afterQ1.questionId, originalQuestions[0].questionId);
            assert.strictEqual(afterQ1.questionText, originalQuestions[0].questionText);
            assert.deepStrictEqual(afterQ1.options, originalQuestions[0].options);
            assert.strictEqual(afterQ1.positiveMarks, originalQuestions[0].positiveMarks);
            assert.strictEqual(afterQ1.negativeMarks, originalQuestions[0].negativeMarks);

            assert.strictEqual(afterQ2.questionId, originalQuestions[1].questionId);
            assert.strictEqual(afterQ2.questionText, originalQuestions[1].questionText);
            assert.strictEqual(afterQ2.positiveMarks, originalQuestions[1].positiveMarks);
            assert.strictEqual(afterQ2.negativeMarks, originalQuestions[1].negativeMarks);

            // UniversalScoringEngine verification: scoring logic remains 100% authoritative and unaltered
            const studentAnswers = {
                "int_q1": "A", // Correct (+4)
                "int_q2": "5"  // Correct (+2)
            };
            const scored = UniversalScoringEngine.evaluateAttempt({
                questions: afterTest.questions,
                answerKeys: afterTest.answerKeys,
                studentAnswers,
                options: { allowUnverified: true, defaultCorrectMarks: 4, defaultIncorrectMarks: 1 }
            });
            assert.strictEqual(scored.totalScore, 8);
            assert.strictEqual(scored.correctCount, 2);
            assert.strictEqual(scored.maximumMarks, 8);
        });

        test("Original validation discrepancies are NOT marked resolved; they remain recorded", async () => {
            const testId = "mock-preserved-discrepancies-512";
            const originalBlockers = [
                "Discrepancy 1: Answer key conflict in Question 5",
                "Discrepancy 2: Section question quota discrepancy"
            ];
            const job = {
                jobId: "job-preserved-discrepancies-512",
                status: "needs_review",
                examId: "ssc-cgl",
                year: 2025,
                validationReport: {
                    canPublish: false,
                    blockers: originalBlockers
                },
                draftPackage: {
                    testId,
                    title: "Preserved Discrepancies Mock Test",
                    questions: [{ questionId: "q_pd1", questionNumber: 1, questionText: "Preserved test question?" }]
                }
            };
            await UniversalFirestoreService.setDocument("paperImportJobs", job.jobId, job);
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                title: "Preserved Discrepancies Mock Test"
            });

            await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: "Acknowledged discrepancies retained" })
            });

            const testDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
            assert.strictEqual(testDoc.publishedWithDiscrepancies, true);
            assert.strictEqual(testDoc.publishedWithValidationOverride, true);
            assert.ok(Array.isArray(testDoc.overriddenDiscrepancies));
            assert.ok(testDoc.overriddenDiscrepancies.length >= 2);
            const descriptions = testDoc.overriddenDiscrepancies.map(d => `${d.description || ""} ${d.title || ""}`);
            assert.ok(descriptions.some(d => d.includes("Answer key conflict")));
            assert.ok(descriptions.some(d => d.includes("Section question quota")));
        });
    });

    // =========================================================================
    // 6. DURABLE AUDIT LOGGING IN FIRESTORE
    // =========================================================================
    describe("6. Durable Audit Logging in Firestore adminAuditLogs", () => {
        test("Creates an immutable audit log record with discrepancy summary, admin ID, and findings snapshot", async () => {
            const testId = "mock-audit-log-512";
            const testJobId = "job-audit-log-512";
            const overrideReason = "Audit verification run by QA Security Lead";

            const job = {
                jobId: testJobId,
                status: "needs_review",
                examId: "gate-cs",
                examName: "GATE Computer Science 2025",
                year: 2025,
                validationReport: {
                    canPublish: false,
                    reportId: "val-rep-8812",
                    validatedAt: "2026-11-17T10:00:00.000Z",
                    blockers: [
                        "Critical: Missing checksum on exam pattern file",
                        "Major: Incomplete numerical answer tolerance boundary",
                        "Warning: Layout artifact in question 4"
                    ]
                },
                draftPackage: {
                    testId,
                    title: "GATE Computer Science Audit Test",
                    questions: [{ questionId: "q_aud1", questionNumber: 1, questionText: "Audit test question?" }]
                }
            };
            await UniversalFirestoreService.setDocument("paperImportJobs", testJobId, job);
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                title: "GATE Computer Science Audit Test"
            });

            const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: overrideReason })
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            const auditId = data.overrideAuditId;
            assert.ok(auditId, "Expected overrideAuditId in response");

            // Query Firestore adminAuditLogs collection
            const auditDoc = await UniversalFirestoreService.getDocument("adminAuditLogs", auditId);
            assert.ok(auditDoc, "Expected audit document in adminAuditLogs collection");
            assert.strictEqual(auditDoc.auditId, auditId);
            assert.strictEqual(auditDoc.mockTestId, testId);
            assert.strictEqual(auditDoc.adminUid, ADMIN_UID);
            assert.strictEqual(auditDoc.adminEmail, "admin512@vidyarthiastra.in");
            assert.strictEqual(auditDoc.overrideReason, overrideReason);
            assert.strictEqual(auditDoc.publicationMethod, "ADMIN_OVERRIDE");
            assert.strictEqual(auditDoc.previousPublicationStatus, "draft");
            assert.strictEqual(auditDoc.newPublicationStatus, "published");
            assert.strictEqual(auditDoc.operationResult, "SUCCESS");
            assert.ok(auditDoc.totalDiscrepancyCount >= 1);
            assert.ok(Array.isArray(auditDoc.findingsSnapshot));

            // Verify dedicated audit query endpoint
            const auditQueryRes = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-audit`, {
                headers: { "Authorization": `Bearer ${adminToken}` }
            });
            assert.strictEqual(auditQueryRes.status, 200);
            const auditQueryData = await auditQueryRes.json();
            assert.strictEqual(auditQueryData.success, true);
            assert.strictEqual(auditQueryData.audit.publishedWithValidationOverride, true);
            assert.strictEqual(auditQueryData.audit.overrideReason, overrideReason);
        });
    });

    // =========================================================================
    // 7. CONCURRENCY & IDEMPOTENCY PROTECTION
    // =========================================================================
    describe("7. Concurrency Mutex & Publication Idempotency", () => {
        test("Already-published test fails closed with HTTP 400", async () => {
            const testId = "mock-idempotency-512";
            const job = {
                jobId: "job-idempotency-512",
                status: "draft",
                examId: "neet-ug",
                year: 2025,
                draftPackage: {
                    testId,
                    title: "Idempotency Test Paper",
                    questions: [{ questionId: "q_idem", questionNumber: 1, questionText: "Idempotency?" }]
                }
            };
            await UniversalFirestoreService.setDocument("paperImportJobs", job.jobId, job);
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                title: "Idempotency Test Paper"
            });

            // 1st call: succeeds
            const res1 = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: "First publication attempt" })
            });
            assert.strictEqual(res1.status, 200);

            // 2nd call: rejected because already published
            const res2 = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: "Duplicate second attempt" })
            });
            assert.strictEqual(res2.status, 400);
            const errData = await res2.json();
            assert.strictEqual(errData.success, false);
            assert.match(errData.error, /already published/i);
        });
    });

    // =========================================================================
    // 8. STUDENT RUNTIME INTEGRATION
    // =========================================================================
    describe("8. Student Runtime Availability & Attempt Workflow", () => {
        test("Override-published mock test is immediately available for student attempts", async () => {
            const testId = "mock-student-flow-512";
            const questions = [
                {
                    questionId: "q_stud1",
                    questionNumber: 1,
                    subject: "Physics",
                    sectionId: "sec-a",
                    questionType: "mcq",
                    questionText: "What is the SI unit of force?",
                    options: [
                        { id: "A", text: "Newton" },
                        { id: "B", text: "Joule" },
                        { id: "C", text: "Watt" },
                        { id: "D", text: "Pascal" }
                    ],
                    positiveMarks: 4,
                    negativeMarks: 1
                }
            ];

            const job = {
                jobId: "job-student-flow-512",
                status: "needs_review",
                examId: "neet-ug",
                year: 2025,
                validationReport: {
                    canPublish: false,
                    blockers: ["Simulation blocker for student runtime test"]
                },
                draftPackage: {
                    testId,
                    title: "NEET UG Student Workflow Test",
                    questions
                }
            };

            await UniversalFirestoreService.setDocument("mockQuestions", "q_stud1", questions[0]);
            await UniversalFirestoreService.setDocument("paperImportJobs", job.jobId, job);
            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                status: "draft",
                examId: "neet-ug",
                title: "NEET UG Student Workflow Test",
                questions,
                questionIds: ["q_stud1"]
            });

            // Publish via admin override
            const pubRes = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/override-publish`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason: "Student catalog availability verification" })
            });
            assert.strictEqual(pubRes.status, 200);

            // Student requests the mock test
            const studTestRes = await fetch(`${baseUrl}/api/mock-tests/${testId}`, {
                headers: { "Authorization": `Bearer ${studentToken}` }
            });
            assert.strictEqual(studTestRes.status, 200);
            const studTestData = await studTestRes.json();
            assert.strictEqual(studTestData.success, true);
            assert.strictEqual(studTestData.test.testId, testId);
            assert.strictEqual(studTestData.test.status, "published");

            // Student creates an attempt
            const attemptRes = await fetch(`${baseUrl}/api/mock-tests/${testId}/attempts`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${studentToken}`
                },
                body: JSON.stringify({ language: "English" })
            });
            assert.strictEqual(attemptRes.status, 201);
            const attemptData = await attemptRes.json();
            assert.strictEqual(attemptData.success, true);
            assert.ok(attemptData.attempt.attemptId, "Attempt ID must be generated");
            assert.strictEqual(attemptData.attempt.testId, testId);
        });
    });
});
