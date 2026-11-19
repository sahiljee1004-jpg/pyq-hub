import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "../server/server.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { MockTestDeletionService } from "../server/services/mockTestDeletionService.js";
import { MockTestService } from "../server/services/mockTestService.js";
import { StorageVaultService } from "../server/services/admin/storageVaultService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VAULT_DIR = path.resolve(__dirname, "../uploads/vault");

/**
 * VidyarthiAstra — Mock Test Permanent Deletion Test Suite
 * 
 * Verifies:
 * 1. Non-admin and unauthenticated rejection (401/403)
 * 2. Confirmation phrase validation (mismatches rejected with 400)
 * 3. Server-authoritative manifest generation & dependency discovery
 * 4. Full cascade deletion of mockTests, exclusive questions, answer keys, attempts, results
 * 5. Protection & preservation of shared questions and shared assets
 * 6. Protection of other tests in multi-test import jobs
 * 7. Storage vault exclusive asset cleanup & preservation of shared source PDFs
 * 8. User-facing eradication: dropped from student catalog, 404 on direct access, blocked attempts
 * 9. Recoverable failure & idempotent retry
 * 10. Integrity of unrelated published tests and attempt engine
 */
describe("Mock Test Permanent Deletion & Cascade Safety Suite", () => {
    let keyPair;
    let server;
    let baseUrl;

    const ADMIN_UID = "admin_del_test_001";
    const STUDENT_UID = "student_del_test_001";

    const TARGET_TEST_ID = "mock-neet-2024-del-target";
    const SIBLING_TEST_ID = "mock-neet-2024-del-sibling";
    const SHARED_QUESTION_ID = "q_del_shared_001";
    const EXCLUSIVE_QUESTION_ID = "q_del_exclusive_002";
    const SIBLING_QUESTION_ID = "q_del_sibling_003";
    const PRIMARY_JOB_ID = "job_del_test_001";

    let testVaultFile1 = null;
    let testVaultFileShared = null;

    function createToken(uid, role = "user", expiresInSeconds = 3600) {
        const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            iss: "https://securetoken.google.com/pyqs-hub-43bed",
            aud: "pyqs-hub-43bed",
            auth_time: now,
            sub: uid,
            user_id: uid,
            email: `${uid}@test.vidyarthiastra.in`,
            role: role,
            iat: now,
            exp: now + expiresInSeconds
        };
        const sHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
        const sPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signature = crypto.sign("RSA-SHA256", Buffer.from(`${sHeader}.${sPayload}`), keyPair.privateKey).toString("base64url");
        return `${sHeader}.${sPayload}.${signature}`;
    }

    before(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

        keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        registerTestPublicKey(keyPair.publicKey);

        // Ensure vault directory exists
        StorageVaultService.init();
        testVaultFile1 = path.join(VAULT_DIR, `test_exclusive_diagram_${Date.now()}.pdf`);
        testVaultFileShared = path.join(VAULT_DIR, `test_shared_source_${Date.now()}.pdf`);
        fs.writeFileSync(testVaultFile1, "%PDF-1.4 dummy exclusive");
        fs.writeFileSync(testVaultFileShared, "%PDF-1.4 dummy shared source");

        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });
    });

    after(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        // Clean up test vault files if still present
        if (fs.existsSync(testVaultFile1)) {
            try { fs.unlinkSync(testVaultFile1); } catch (e) {}
        }
        if (fs.existsSync(testVaultFileShared)) {
            try { fs.unlinkSync(testVaultFileShared); } catch (e) {}
        }
    });

    beforeEach(async () => {
        UniversalFirestoreService.clearLocalCache();

        // Register admin and student in users collection
        await UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@test.vidyarthiastra.in",
            role: "admin"
        });
        await UniversalFirestoreService.setDocument("users", STUDENT_UID, {
            uid: STUDENT_UID,
            email: "student@test.vidyarthiastra.in",
            role: "user"
        });

        // 1. Primary target mock test (to be deleted)
        await UniversalFirestoreService.setDocument("mockTests", TARGET_TEST_ID, {
            testId: TARGET_TEST_ID,
            examId: "neet",
            examName: "NEET UG",
            year: 2024,
            paperCode: "Q1",
            title: "NEET UG 2024 (Code Q1) - Target For Deletion",
            durationSeconds: 1200,
            questionIds: [SHARED_QUESTION_ID, EXCLUSIVE_QUESTION_ID],
            status: "published",
            createdAt: new Date().toISOString()
        });

        // 2. Sibling mock test (must NOT be deleted; shares SHARED_QUESTION_ID)
        await UniversalFirestoreService.setDocument("mockTests", SIBLING_TEST_ID, {
            testId: SIBLING_TEST_ID,
            examId: "neet",
            examName: "NEET UG",
            year: 2024,
            paperCode: "Q2",
            title: "NEET UG 2024 (Code Q2) - Preserved Sibling",
            durationSeconds: 1200,
            questionIds: [SHARED_QUESTION_ID, SIBLING_QUESTION_ID],
            status: "published",
            createdAt: new Date().toISOString()
        });

        // 3. Shared question (used by both TARGET and SIBLING)
        await UniversalFirestoreService.setDocument("mockQuestions", SHARED_QUESTION_ID, {
            questionId: SHARED_QUESTION_ID,
            testId: TARGET_TEST_ID,
            questionNumber: 1,
            questionText: "Shared Physics Question across tests",
            options: [
                { id: "1", label: "A", text: "Option A" },
                { id: "2", label: "B", text: "Option B" }
            ],
            localVaultPath: testVaultFileShared
        });

        // 4. Exclusive question (only used by TARGET)
        await UniversalFirestoreService.setDocument("mockQuestions", EXCLUSIVE_QUESTION_ID, {
            questionId: EXCLUSIVE_QUESTION_ID,
            testId: TARGET_TEST_ID,
            questionNumber: 2,
            questionText: "Exclusive Chemistry Question for Target Test",
            options: [
                { id: "1", label: "A", text: "Option 1" },
                { id: "2", label: "B", text: "Option 2" }
            ],
            localVaultPath: testVaultFile1
        });

        // 5. Sibling question
        await UniversalFirestoreService.setDocument("mockQuestions", SIBLING_QUESTION_ID, {
            questionId: SIBLING_QUESTION_ID,
            testId: SIBLING_TEST_ID,
            questionNumber: 1,
            questionText: "Sibling question",
            options: [{ id: "1", label: "A", text: "Opt" }]
        });

        // 6. Answer keys
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `ak_${TARGET_TEST_ID}_1`, {
            answerKeyId: `ak_${TARGET_TEST_ID}_1`,
            testId: TARGET_TEST_ID,
            questionId: EXCLUSIVE_QUESTION_ID,
            correctOptionIds: ["1"]
        });

        // 7. Student attempts and results for target test
        const targetAttemptId = `attempt_${TARGET_TEST_ID}_${STUDENT_UID}_001`;
        await UniversalFirestoreService.setDocument("mockAttempts", targetAttemptId, {
            attemptId: targetAttemptId,
            testId: TARGET_TEST_ID,
            userId: STUDENT_UID,
            status: "submitted",
            answers: { [EXCLUSIVE_QUESTION_ID]: "1" },
            startedAt: new Date().toISOString(),
            deadlineAt: new Date(Date.now() + 3600000).toISOString()
        });

        const targetResultId = `result_${targetAttemptId}`;
        await UniversalFirestoreService.setDocument("mockResults", targetResultId, {
            resultId: targetResultId,
            attemptId: targetAttemptId,
            testId: TARGET_TEST_ID,
            userId: STUDENT_UID,
            totalScore: 4,
            submittedAt: new Date().toISOString()
        });

        // 8. Associated import job
        await UniversalFirestoreService.setDocument("paperImportJobs", PRIMARY_JOB_ID, {
            jobId: PRIMARY_JOB_ID,
            examId: "neet",
            year: 2024,
            paperCode: "Q1",
            status: "published",
            validationReport: {
                canPublish: true
            },
            draftPackage: {
                testId: TARGET_TEST_ID
            },
            sourceDocuments: {
                questionPaper: {
                    localVaultPath: testVaultFileShared,
                    originalFilename: "neet_2024_q1.pdf"
                }
            },
            auditLog: []
        });
    });

    test("1. Unauthenticated request to delete a mock test is rejected with 401", async () => {
        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${TARGET_TEST_ID}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmation: TARGET_TEST_ID })
        });

        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.success, false);
    });

    test("2. Non-admin student request to delete a mock test is rejected with 403", async () => {
        const studentToken = createToken(STUDENT_UID, "user");
        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${TARGET_TEST_ID}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${studentToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ confirmation: TARGET_TEST_ID })
        });

        assert.equal(res.status, 403);
        const body = await res.json();
        assert.equal(body.success, false);
    });

    test("3. Missing or mismatched confirmation phrase is rejected with 400", async () => {
        const adminToken = createToken(ADMIN_UID, "admin");

        // Missing confirmation
        const res1 = await fetch(`${baseUrl}/api/admin/mock-tests/${TARGET_TEST_ID}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${adminToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ confirmation: "" })
        });
        assert.equal(res1.status, 400);

        // Wrong phrase
        const res2 = await fetch(`${baseUrl}/api/admin/mock-tests/${TARGET_TEST_ID}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${adminToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ confirmation: "DELETE WRONG_ID" })
        });
        assert.equal(res2.status, 400);
        const body = await res2.json();
        assert.match(body.error, /confirmation/i);
    });

    test("4. Server-authoritative manifest correctly detects exclusive vs shared dependencies", async () => {
        const adminToken = createToken(ADMIN_UID, "admin");
        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${TARGET_TEST_ID}/deletion-manifest`, {
            headers: { "Authorization": `Bearer ${adminToken}` }
        });

        assert.equal(res.status, 200);
        const { manifest } = await res.json();

        assert.equal(manifest.testId, TARGET_TEST_ID);
        assert.equal(manifest.jobId, PRIMARY_JOB_ID);
        assert.equal(manifest.counts.attempts, 1);
        assert.equal(manifest.counts.results, 1);
        assert.equal(manifest.counts.questionsExclusive, 1);
        assert.equal(manifest.counts.questionsShared, 1);

        // Exclusive question scheduled for deletion
        assert.ok(manifest.records.exclusiveQuestions.includes(EXCLUSIVE_QUESTION_ID));
        // Shared question protected and preserved
        assert.ok(manifest.records.sharedQuestionsPreserved.includes(SHARED_QUESTION_ID));
        // Exclusive vault file scheduled for deletion
        assert.ok(manifest.records.storageFilesToDelete.includes(testVaultFile1));
        // Shared source vault file preserved
        assert.ok(manifest.records.storageFilesPreserved.includes(testVaultFileShared));
    });

    test("5. Full cascade deletion permanently deletes test, exclusive questions, answer keys, attempts, results, and exclusive storage assets", async () => {
        const adminToken = createToken(ADMIN_UID, "admin");

        // Execute deletion
        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${TARGET_TEST_ID}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${adminToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                confirmation: TARGET_TEST_ID,
                reason: "Automated regression test deletion"
            })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.status, "COMPLETED");
        assert.equal(data.deletedCounts.attempts, 1);
        assert.equal(data.deletedCounts.results, 1);
        assert.equal(data.deletedCounts.questions, 1);
        assert.equal(data.sharedPreserved.questions, 1);

        // Verify Firestore documents
        const deletedTest = await UniversalFirestoreService.getDocument("mockTests", TARGET_TEST_ID);
        assert.equal(deletedTest, null, "Canonical mockTest document must be deleted");

        const deletedQuestion = await UniversalFirestoreService.getDocument("mockQuestions", EXCLUSIVE_QUESTION_ID);
        assert.equal(deletedQuestion, null, "Exclusive question document must be deleted");

        const deletedAnswerKey = await UniversalFirestoreService.getDocument("mockAnswerKeys", `ak_${TARGET_TEST_ID}_1`);
        assert.equal(deletedAnswerKey, null, "Test-specific answer key must be deleted");

        const deletedAttempt = await UniversalFirestoreService.getDocument("mockAttempts", `attempt_${TARGET_TEST_ID}_${STUDENT_UID}_001`);
        assert.equal(deletedAttempt, null, "Student attempt document must be deleted");

        const deletedResult = await UniversalFirestoreService.getDocument("mockResults", `result_attempt_${TARGET_TEST_ID}_${STUDENT_UID}_001`);
        assert.equal(deletedResult, null, "Student result document must be deleted");

        // Verify exclusive storage file unlinked
        assert.equal(fs.existsSync(testVaultFile1), false, "Exclusive vault file must be removed");

        // Verify SHARED question was PRESERVED
        const preservedQuestion = await UniversalFirestoreService.getDocument("mockQuestions", SHARED_QUESTION_ID);
        assert.ok(preservedQuestion, "Shared question must NOT be deleted");

        // Verify SHARED vault source file was PRESERVED
        assert.equal(fs.existsSync(testVaultFileShared), true, "Shared source PDF must NOT be removed");

        // Verify SIBLING test was PRESERVED
        const siblingTest = await UniversalFirestoreService.getDocument("mockTests", SIBLING_TEST_ID);
        assert.ok(siblingTest, "Sibling test must NOT be affected");
        assert.equal(siblingTest.status, "published");

        // Verify primary import job audit log updated without student PII
        const updatedJob = await UniversalFirestoreService.getDocument("paperImportJobs", PRIMARY_JOB_ID);
        assert.ok(updatedJob);
        assert.equal(updatedJob.status, "ready_to_publish", "Job status must revert from published");
        assert.ok(Array.isArray(updatedJob.auditLog));
        const delEntry = updatedJob.auditLog.find(e => e.action === "MOCK_TEST_DELETED");
        assert.ok(delEntry, "Import job must record MOCK_TEST_DELETED in audit log");
        assert.equal(delEntry.testId, TARGET_TEST_ID);
        assert.equal(delEntry.actor, ADMIN_UID);
        // Verify no sensitive PII or question stems in audit log
        assert.equal(delEntry.studentAnswers, undefined);
        assert.equal(delEntry.questionText, undefined);
    });

    test("6. Deleted test vanishes from student catalog, returns 404 for student lookup, and blocks attempts", async () => {
        const adminToken = createToken(ADMIN_UID, "admin");
        const studentToken = createToken(STUDENT_UID, "user");

        // First execute deletion
        const delRes = await fetch(`${baseUrl}/api/admin/mock-tests/${TARGET_TEST_ID}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${adminToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ confirmation: TARGET_TEST_ID })
        });
        assert.equal(delRes.status, 200);

        // Verify Sibling test is still present in catalog
        const published = await MockTestService.listPublishedTests();
        const testIds = published.map(t => t.testId);
        assert.ok(!testIds.includes(TARGET_TEST_ID), "Deleted test must not be in published catalog");
        assert.ok(testIds.includes(SIBLING_TEST_ID), "Sibling test must still be in published catalog");

        // Direct student getTestForStudent request returns null (404)
        const studentTestView = await MockTestService.getTestForStudent(TARGET_TEST_ID, { callerRole: "user" });
        assert.equal(studentTestView, null, "Student test lookup must return null for deleted test");

        // Attempt creation rejects
        await assert.rejects(
            MockTestService.startAttempt({ testId: TARGET_TEST_ID, userId: STUDENT_UID }),
            /not available for attempts/i
        );

        // Direct HTTP route returns 404
        const httpRes = await fetch(`${baseUrl}/api/mock-tests/${TARGET_TEST_ID}`, {
            headers: { "Authorization": `Bearer ${studentToken}` }
        });
        assert.equal(httpRes.status, 404);
    });

    test("7. Sibling test and ordinary attempt flow continue to operate smoothly", async () => {
        const studentToken = createToken(STUDENT_UID, "user");

        // Start attempt on sibling test
        const res = await fetch(`${baseUrl}/api/mock-tests/${SIBLING_TEST_ID}/attempts`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${studentToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ language: "English" })
        });

        assert.equal(res.status, 201);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.attempt.testId, SIBLING_TEST_ID);
    });

    test("8. Deletion operation inspection and idempotent retry work as expected", async () => {
        const adminToken = createToken(ADMIN_UID, "admin");

        // Create disposable test for failure simulation
        const RETRY_TEST_ID = "mock-neet-retry-test";
        await UniversalFirestoreService.setDocument("mockTests", RETRY_TEST_ID, {
            testId: RETRY_TEST_ID,
            examId: "neet",
            year: 2024,
            paperCode: "Q3",
            title: "NEET UG 2024 (Code Q3) - Retry Test",
            status: "published"
        });

        // Generate manifest
        const manifest = await MockTestDeletionService.generateDeletionManifest({
            testId: RETRY_TEST_ID,
            adminUid: ADMIN_UID,
            options: { projectId: "demo-vidyarthiastra" }
        });

        // Simulate simulated partial progress
        manifest.stages.blockAccess.status = "completed";
        manifest.status = "FAILED";
        manifest.currentStage = "deleteAttemptsAndResults";
        manifest.errors.push({ stage: "deleteAttemptsAndResults", error: "Simulated transient error" });
        await UniversalFirestoreService.setDocument("mockTestDeletionOperations", manifest.operationId, manifest);

        // Inspect operation via API
        const inspectRes = await fetch(`${baseUrl}/api/admin/mock-tests/deletions/${manifest.operationId}`, {
            headers: { "Authorization": `Bearer ${adminToken}` }
        });
        assert.equal(inspectRes.status, 200);
        const inspectData = await inspectRes.json();
        assert.equal(inspectData.operation.status, "FAILED");

        // Retry via API
        const retryRes = await fetch(`${baseUrl}/api/admin/mock-tests/deletions/${manifest.operationId}/retry`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${adminToken}` }
        });
        assert.equal(retryRes.status, 200);
        const retryData = await retryRes.json();
        assert.equal(retryData.status, "COMPLETED");

        // Verify test is now completely gone
        const afterRetryDoc = await UniversalFirestoreService.getDocument("mockTests", RETRY_TEST_ID);
        assert.equal(afterRetryDoc, null);
    });
});
