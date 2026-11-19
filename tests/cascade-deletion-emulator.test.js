import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

import app from "../server/server.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { MockTestDeletionService } from "../server/services/mockTestDeletionService.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";

/**
 * Cascade Deletion Emulator Verification Suite
 * 
 * Verifies real emulator-backed cascade deletion across:
 * - Firestore Emulator (127.0.0.1:8088)
 * - Firebase Storage Emulator (127.0.0.1:9199)
 * - Auth Emulator (127.0.0.1:9099)
 * 
 * Target project: demo-vidyarthiastra (strictly isolated from production)
 */
describe("Real Firebase Cascade Deletion — Emulator Verification", () => {
    let server;
    let baseUrl;
    let adminToken;
    let studentToken;
    let keyPair;

    const PROJECT_ID = "demo-vidyarthiastra";
    const ADMIN_UID = "cascade_test_admin_uid";
    const STUDENT_UID = "cascade_test_student_uid";

    const TARGET_TEST_ID = "mock-cascade-del-target-001";
    const SIBLING_TEST_ID = "mock-cascade-del-sibling-002";
    const TARGET_JOB_ID = "job_cascade_del_001";
    const FAILED_JOB_ID = "job_failed_cleanup_002";

    const STORAGE_HOST = "127.0.0.1:9199";
    const BUCKET = `${PROJECT_ID}.appspot.com`;

    before(async () => {
        // Enforce safety constraints
        assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must be set");
        process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
        assert.equal(process.env.FIREBASE_PROJECT_ID, PROJECT_ID, "Target must be demo-vidyarthiastra");
        process.env.NODE_ENV = "test";

        // Setup RSA keypair for token authentication
        keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        registerTestPublicKey(keyPair.publicKey);

        function createToken(uid, role) {
            const now = Math.floor(Date.now() / 1000);
            const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
            const payload = {
                iss: `https://securetoken.google.com/${PROJECT_ID}`,
                aud: PROJECT_ID,
                sub: uid,
                user_id: uid,
                email: `${uid}@vidyarthiastra.in`,
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

        adminToken = createToken(ADMIN_UID, "admin");
        studentToken = createToken(STUDENT_UID, "user");

        // Seed users in Firestore emulator
        await UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@vidyarthiastra.in",
            role: "admin"
        });
        await UniversalFirestoreService.setDocument("users", STUDENT_UID, {
            uid: STUDENT_UID,
            email: "student@vidyarthiastra.in",
            role: "user"
        });

        // Start server on dynamic port
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    after(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        // Clean up emulator documents seeded by this suite to ensure test isolation
        try {
            await UniversalFirestoreService.deleteDocument("mockTests", SIBLING_TEST_ID);
            await UniversalFirestoreService.deleteDocument("mockQuestions", "q_sibling_201");
            await UniversalFirestoreService.deleteDocument("mockQuestions", "q_shared_001");
            await UniversalFirestoreService.deleteDocument("mockAnswerKeys", "ak_shared_001");
            await UniversalFirestoreService.deleteDocument("users", ADMIN_UID);
            await UniversalFirestoreService.deleteDocument("users", STUDENT_UID);
            UniversalFirestoreService.clearLocalCache();
        } catch (_) {}
    });

    test("1. Unauthenticated request to delete mock test returns 401", async () => {
        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${TARGET_TEST_ID}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmation: TARGET_TEST_ID })
        });
        assert.equal(res.status, 401, "Unauthenticated request must return 401");
    });

    test("2. Non-admin request to delete mock test returns 403", async () => {
        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${TARGET_TEST_ID}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${studentToken}`
            },
            body: JSON.stringify({ confirmation: TARGET_TEST_ID })
        });
        assert.equal(res.status, 403, "Non-admin request must return 403");
    });

    test("3. Genuine Firestore & Storage emulator cascade deletion of published test with subcollections and shared resource preservation", async () => {
        const exclusiveStorageKey = `tests/${TARGET_TEST_ID}/exclusive_diagram.png`;
        const sharedStorageKey = `shared_assets/biology_cell_diagram.png`;

        // 1. Upload assets to Storage emulator
        const uploadFile = async (key, content) => {
            const url = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o?name=${encodeURIComponent(key)}`;
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "image/png" },
                body: Buffer.from(content)
            });
            assert.ok(res.ok, `Failed to upload test file ${key} to storage emulator`);
        };

        await uploadFile(exclusiveStorageKey, "FAKE_IMAGE_DATA_EXCLUSIVE");
        await uploadFile(sharedStorageKey, "FAKE_IMAGE_DATA_SHARED");

        // Verify storage files exist
        const checkStorage = async (key) => {
            const url = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o/${encodeURIComponent(key)}`;
            const res = await fetch(url);
            return res.status === 200;
        };

        assert.equal(await checkStorage(exclusiveStorageKey), true, "Exclusive storage file must exist initially");
        assert.equal(await checkStorage(sharedStorageKey), true, "Shared storage file must exist initially");

        // 2. Seed published test in Firestore emulator
        await UniversalFirestoreService.setDocument("mockTests", TARGET_TEST_ID, {
            testId: TARGET_TEST_ID,
            examId: "neet",
            examName: "NEET UG",
            year: 2024,
            paperCode: "Q1",
            title: "NEET UG 2024 Target Deletion",
            questionIds: ["q_target_101", "q_target_102", "q_shared_001"],
            status: "published",
            createdAt: new Date().toISOString()
        });

        // 3. Seed nested subcollection in mockTests/{TARGET_TEST_ID}/sections/section1
        await UniversalFirestoreService.setDocument(`mockTests/${TARGET_TEST_ID}/sections`, "section1", {
            sectionId: "section1",
            name: "Physics Section A",
            questionCount: 35
        });

        // 4. Seed sibling test in Firestore emulator (shares q_shared_001 and sharedStorageKey)
        await UniversalFirestoreService.setDocument("mockTests", SIBLING_TEST_ID, {
            testId: SIBLING_TEST_ID,
            examId: "neet",
            examName: "NEET UG",
            year: 2024,
            paperCode: "Q2",
            title: "NEET UG 2024 Sibling Preserved",
            questionIds: ["q_sibling_201", "q_shared_001"],
            status: "published",
            createdAt: new Date().toISOString()
        });

        // 5. Seed exclusive questions and shared question
        await UniversalFirestoreService.setDocument("mockQuestions", "q_target_101", {
            questionId: "q_target_101",
            testId: TARGET_TEST_ID,
            questionNumber: 1,
            questionText: "Target Question 101",
            firebaseStoragePath: `gs://${BUCKET}/${exclusiveStorageKey}`
        });

        await UniversalFirestoreService.setDocument("mockQuestions", "q_target_102", {
            questionId: "q_target_102",
            testId: TARGET_TEST_ID,
            questionNumber: 2,
            questionText: "Target Question 102"
        });

        await UniversalFirestoreService.setDocument("mockQuestions", "q_shared_001", {
            questionId: "q_shared_001",
            testId: TARGET_TEST_ID,
            questionNumber: 3,
            questionText: "Shared Question across tests",
            sharedReferenceIds: [TARGET_TEST_ID, SIBLING_TEST_ID],
            firebaseStoragePath: `gs://${BUCKET}/${sharedStorageKey}`
        });

        await UniversalFirestoreService.setDocument("mockQuestions", "q_sibling_201", {
            questionId: "q_sibling_201",
            testId: SIBLING_TEST_ID,
            questionNumber: 1,
            questionText: "Sibling Question 201"
        });

        // Seed legacy question path
        await UniversalFirestoreService.setDocument("exams/neet/questions", "1", {
            questionNumber: 1,
            examId: "neet",
            testId: TARGET_TEST_ID
        });

        // Seed attempts and results
        await UniversalFirestoreService.setDocument("mockAttempts", "att_target_1", {
            attemptId: "att_target_1",
            testId: TARGET_TEST_ID,
            userId: STUDENT_UID,
            status: "submitted"
        });

        await UniversalFirestoreService.setDocument("mockResults", "res_target_1", {
            resultId: "res_target_1",
            testId: TARGET_TEST_ID,
            attemptId: "att_target_1",
            score: 120
        });

        // Seed paper import job
        await UniversalFirestoreService.setDocument("paperImportJobs", TARGET_JOB_ID, {
            jobId: TARGET_JOB_ID,
            examId: "neet",
            year: 2024,
            paperCode: "Q1",
            status: "published",
            publishedMockTestId: TARGET_TEST_ID
        });

        // 6. Execute Delete Mock Test via HTTP API
        const deleteRes = await fetch(`${baseUrl}/api/admin/mock-tests/${TARGET_TEST_ID}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: TARGET_TEST_ID,
                reason: "Administrative permanent deletion verification"
            })
        });

        assert.equal(deleteRes.status, 200, "Deletion API must return 200 OK");
        const deleteData = await deleteRes.json();
        assert.equal(deleteData.success, true);
        assert.equal(deleteData.status, "COMPLETED");
        assert.equal(deleteData.deletedCounts.questions, 2, "2 exclusive questions must be deleted");
        assert.equal(deleteData.sharedPreserved.questions, 1, "1 shared question must be preserved");

        // 7. Verify Firestore Emulator Document State
        const testDoc = await UniversalFirestoreService.getDocument("mockTests", TARGET_TEST_ID);
        assert.equal(testDoc, null, "mockTests document must be null in Firestore emulator");

        const subDoc = await UniversalFirestoreService.getDocument(`mockTests/${TARGET_TEST_ID}/sections`, "section1");
        assert.equal(subDoc, null, "Nested subcollection mockTests/sections must be deleted");

        const q1 = await UniversalFirestoreService.getDocument("mockQuestions", "q_target_101");
        assert.equal(q1, null, "Exclusive question 101 must be deleted");

        const q2 = await UniversalFirestoreService.getDocument("mockQuestions", "q_target_102");
        assert.equal(q2, null, "Exclusive question 102 must be deleted");

        const legacyQ = await UniversalFirestoreService.getDocument("exams/neet/questions", "1");
        assert.equal(legacyQ, null, "Legacy question path document must be deleted");

        const att = await UniversalFirestoreService.getDocument("mockAttempts", "att_target_1");
        assert.equal(att, null, "Attempt document must be deleted");

        const resDoc = await UniversalFirestoreService.getDocument("mockResults", "res_target_1");
        assert.equal(resDoc, null, "Result document must be deleted");

        // 8. Verify Exclusive Storage Asset was deleted from Storage emulator
        assert.equal(await checkStorage(exclusiveStorageKey), false, "Exclusive storage asset must be deleted from storage emulator");

        // 9. Verify Shared Resources & Sibling Test are PRESERVED
        const sharedQ = await UniversalFirestoreService.getDocument("mockQuestions", "q_shared_001");
        assert.ok(sharedQ, "Shared question must be preserved");

        const siblingDoc = await UniversalFirestoreService.getDocument("mockTests", SIBLING_TEST_ID);
        assert.ok(siblingDoc, "Sibling test must be preserved");

        assert.equal(await checkStorage(sharedStorageKey), true, "Shared storage asset must be preserved in storage emulator");
    });

    test("4. Delete Incomplete / Failed Import Data cleans up draft records and exclusive files", async () => {
        const failedVaultKey = `vault/${FAILED_JOB_ID}/source_paper.pdf`;
        const uploadUrl = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o?name=${encodeURIComponent(failedVaultKey)}`;
        await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": "application/pdf" },
            body: Buffer.from("FAKE_PDF_FAILED_IMPORT")
        });

        // Seed failed import job with draft questions & draft answer key
        await UniversalFirestoreService.setDocument("paperImportJobs", FAILED_JOB_ID, {
            jobId: FAILED_JOB_ID,
            examId: "jee_main",
            year: 2024,
            paperCode: "Session1",
            status: "failed",
            stage: "Extraction failed due to corrupt OCR",
            extractedQuestionCount: 2,
            sourceDocuments: {
                questionPaper: {
                    storagePath: failedVaultKey
                }
            }
        });

        await UniversalFirestoreService.setDocument("mockQuestions", "draft_q_failed_1", {
            questionId: "draft_q_failed_1",
            jobId: FAILED_JOB_ID,
            questionText: "Draft question from failed import"
        });

        await UniversalFirestoreService.setDocument("mockAnswerKeys", "draft_ak_failed_1", {
            answerKeyId: "draft_ak_failed_1",
            jobId: FAILED_JOB_ID,
            answers: { "1": "B" }
        });

        // Execute DELETE /api/admin/import/jobs/:jobId
        const res = await fetch(`${baseUrl}/api/admin/import/jobs/${FAILED_JOB_ID}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: FAILED_JOB_ID,
                reason: "Administrative cleanup of failed import"
            })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.isJobDeletion, true);
        assert.equal(data.deletedCounts.draftQuestions, 1);

        // Verify job and drafts deleted from emulator
        const jobAfter = await UniversalFirestoreService.getDocument("paperImportJobs", FAILED_JOB_ID);
        assert.equal(jobAfter, null, "Failed import job document must be deleted");

        const qAfter = await UniversalFirestoreService.getDocument("mockQuestions", "draft_q_failed_1");
        assert.equal(qAfter, null, "Draft question must be deleted");

        const akAfter = await UniversalFirestoreService.getDocument("mockAnswerKeys", "draft_ak_failed_1");
        assert.equal(akAfter, null, "Draft answer key must be deleted");

        // Verify storage file deleted
        const fileRes = await fetch(`http://${STORAGE_HOST}/v0/b/${BUCKET}/o/${encodeURIComponent(failedVaultKey)}`);
        assert.equal(fileRes.status, 404, "Draft file must be deleted from storage emulator");
    });

    test("5. Cleanup failures never produce false success and can be retried safely", async () => {
        const FAILING_TEST_ID = "mock-failing-test-001";
        await UniversalFirestoreService.setDocument("mockTests", FAILING_TEST_ID, {
            testId: FAILING_TEST_ID,
            examId: "gate",
            year: 2024,
            title: "Failing Test Simulation",
            status: "published"
        });

        // Generate manifest
        const manifest = await MockTestDeletionService.generateDeletionManifest({
            testId: FAILING_TEST_ID,
            adminUid: ADMIN_UID,
            reason: "Retry test",
            options: { projectId: "demo-vidyarthiastra" }
        });

        // Simulate an interrupted operation at stage 'deleteAttemptsAndResults'
        manifest.status = "FAILED";
        manifest.currentStage = "deleteAttemptsAndResults";
        manifest.errors.push({
            stage: "deleteAttemptsAndResults",
            error: "Simulated transient network timeout",
            timestamp: new Date().toISOString()
        });
        await UniversalFirestoreService.setDocument("mockTestDeletionOperations", manifest.operationId, manifest);

        // Verify retry completes the deletion
        const retryRes = await fetch(`${baseUrl}/api/admin/mock-tests/deletions/${manifest.operationId}/retry`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            }
        });

        assert.equal(retryRes.status, 200, "Retry endpoint must return 200");
        const retryData = await retryRes.json();
        assert.equal(retryData.success, true);
        assert.equal(retryData.status, "COMPLETED");

        // Verify post-retry document is gone
        const docAfterRetry = await UniversalFirestoreService.getDocument("mockTests", FAILING_TEST_ID);
        assert.equal(docAfterRetry, null, "Test must be deleted after retry completes");
    });

    test("6. Deleted test cannot be opened or attempted via student API", async () => {
        // Attempt to fetch deleted target test
        const getRes = await fetch(`${baseUrl}/api/mock-tests/${TARGET_TEST_ID}`, {
            headers: { "Authorization": `Bearer ${studentToken}` }
        });
        assert.equal(getRes.status, 404, "Deleted test must return 404 from getTest");

        // Attempt to create attempt for deleted test
        const attRes = await fetch(`${baseUrl}/api/mock-tests/${TARGET_TEST_ID}/attempts`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${studentToken}`
            },
            body: JSON.stringify({})
        });
        assert.equal(attRes.status, 404, "Creating attempt on deleted test must return 404");

        // List published tests only returns surviving sibling
        const listRes = await fetch(`${baseUrl}/api/mock-tests`);
        const listData = await listRes.json();
        const testIds = listData.tests.map(t => t.testId);
        assert.ok(!testIds.includes(TARGET_TEST_ID), "Deleted test must not appear in published catalog");
        assert.ok(testIds.includes(SIBLING_TEST_ID), "Sibling test must appear in published catalog");
    });
});
