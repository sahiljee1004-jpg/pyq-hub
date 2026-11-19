import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import app from "../server/server.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { MockTestDeletionService } from "../server/services/mockTestDeletionService.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";

/**
 * Step 6 Emulator-Backed Regression Test Suite
 * 
 * Verifies all 10 scenarios requested for deletion resilience:
 * 1. Normal deletion when the test document exists.
 * 2. Parent test document absent, but attempts/results remain.
 * 3. Parent test document absent, but question/answer-key records remain.
 * 4. Parent test document absent, but test-exclusive Storage files remain.
 * 5. Parent document already deleted and all cleanup stages complete (NOTHING_TO_DELETE).
 * 6. Import job still exists after test deletion (unlinking association).
 * 7. Multi-test job preserves sibling tests and shared data.
 * 8. Retry after a simulated mid-deletion failure.
 * 9. Unauthenticated and non-admin deletion requests are rejected.
 * 10. History refresh reflects the actual remaining import jobs.
 */
describe("Step 6 — Emulator-Backed Mock Test Deletion Resilience Suite", () => {
    let server;
    let baseUrl;
    let adminToken;
    let studentToken;
    let keyPair;

    const PROJECT_ID = "demo-vidyarthiastra";
    const ADMIN_UID = "resilience_test_admin_uid";
    const STUDENT_UID = "resilience_test_student_uid";
    const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
    const BUCKET = `${PROJECT_ID}.appspot.com`;

    // Helper to upload synthetic files to Storage emulator
    const uploadStorageFile = async (key, content = "TEST_STORAGE_CONTENT", contentType = "image/png") => {
        const url = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o?name=${encodeURIComponent(key)}`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: Buffer.from(content)
        });
        assert.ok(res.ok, `Failed to upload test file ${key} to storage emulator: ${res.status}`);
    };

    // Helper to verify existence of Storage file
    const storageFileExists = async (key) => {
        const url = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o/${encodeURIComponent(key)}`;
        const res = await fetch(url);
        return res.status === 200;
    };

    before(async () => {
        assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must be set");
        process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
        process.env.FIREBASE_STORAGE_EMULATOR_HOST = STORAGE_HOST;
        process.env.NODE_ENV = "test";

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
        // Clean up remaining documents seeded during tests to maintain emulator idempotency
        try {
            await UniversalFirestoreService.deleteDocument("mockTests", "mock-scen10-rem");
            await UniversalFirestoreService.deleteDocument("paperImportJobs", "job_resilience_scen10_remaining");
            await UniversalFirestoreService.deleteDocument("paperImportJobs", "job_resilience_scen10_draft");
            await UniversalFirestoreService.deleteDocument("paperImportJobs", "job_resilience_scen6");
            await UniversalFirestoreService.deleteDocument("users", ADMIN_UID);
            await UniversalFirestoreService.deleteDocument("users", STUDENT_UID);
            UniversalFirestoreService.clearLocalCache();
        } catch (_) {}
    });

    // =========================================================================
    // SCENARIO 1: Normal deletion when the test document exists
    // =========================================================================
    test("Scenario 1: Normal deletion when the test document exists", async () => {
        const testId = "mock-resilience-scen1-target";
        const jobId = "job_resilience_scen1";
        const storageKey = `tests/${testId}/diagram_scen1.png`;

        await uploadStorageFile(storageKey, "DIAGRAM_SCENARIO_1");
        assert.equal(await storageFileExists(storageKey), true);

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "neet",
            year: 2024,
            paperCode: "Q1",
            title: "Scenario 1 Normal Deletion Test",
            questionIds: ["q_scen1_1", "q_scen1_2"],
            status: "published"
        });

        await UniversalFirestoreService.setDocument("mockQuestions", "q_scen1_1", {
            questionId: "q_scen1_1",
            testId,
            firebaseStoragePath: `gs://${BUCKET}/${storageKey}`,
            questionText: "Question 1 Scenario 1"
        });
        await UniversalFirestoreService.setDocument("mockQuestions", "q_scen1_2", {
            questionId: "q_scen1_2",
            testId,
            questionText: "Question 2 Scenario 1"
        });

        await UniversalFirestoreService.setDocument("mockAnswerKeys", "ak_scen1_1", {
            answerKeyId: "ak_scen1_1",
            testId,
            answers: { "1": "A" }
        });

        await UniversalFirestoreService.setDocument("mockAttempts", "att_scen1_1", {
            attemptId: "att_scen1_1",
            testId,
            userId: STUDENT_UID
        });

        await UniversalFirestoreService.setDocument("mockResults", "res_scen1_1", {
            resultId: "res_scen1_1",
            testId,
            score: 100
        });

        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, {
            jobId,
            examId: "neet",
            year: 2024,
            paperCode: "Q1",
            publishedMockTestId: testId,
            status: "published"
        });

        // Execute deletion
        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: testId,
                jobId,
                reason: "Scenario 1 normal deletion test"
            })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.status, "COMPLETED");

        // Verify Firestore records null
        assert.equal(await UniversalFirestoreService.getDocument("mockTests", testId), null);
        assert.equal(await UniversalFirestoreService.getDocument("mockQuestions", "q_scen1_1"), null);
        assert.equal(await UniversalFirestoreService.getDocument("mockQuestions", "q_scen1_2"), null);
        assert.equal(await UniversalFirestoreService.getDocument("mockAnswerKeys", "ak_scen1_1"), null);
        assert.equal(await UniversalFirestoreService.getDocument("mockAttempts", "att_scen1_1"), null);
        assert.equal(await UniversalFirestoreService.getDocument("mockResults", "res_scen1_1"), null);

        // Verify Storage file deleted
        assert.equal(await storageFileExists(storageKey), false);
    });

    // =========================================================================
    // SCENARIO 2: Parent test document absent, but attempts/results remain
    // =========================================================================
    test("Scenario 2: Parent test document absent, but attempts/results remain", async () => {
        const testId = "mock-resilience-scen2-missing";
        const jobId = "job_resilience_scen2";

        // mockTests document deliberately NOT seeded
        assert.equal(await UniversalFirestoreService.getDocument("mockTests", testId), null);

        await UniversalFirestoreService.setDocument("mockAttempts", "att_scen2_1", {
            attemptId: "att_scen2_1",
            testId,
            userId: STUDENT_UID,
            status: "submitted"
        });

        await UniversalFirestoreService.setDocument("mockResults", "res_scen2_1", {
            resultId: "res_scen2_1",
            testId,
            attemptId: "att_scen2_1",
            score: 85
        });

        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, {
            jobId,
            examId: "jee_main",
            year: 2024,
            paperCode: "S1",
            publishedMockTestId: testId,
            status: "published"
        });

        // Generate manifest preview - must succeed and detect parentDocumentMissing
        const manifestRes = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/deletion-manifest?jobId=${jobId}`, {
            headers: { "Authorization": `Bearer ${adminToken}` }
        });
        assert.equal(manifestRes.status, 200);
        const manifestData = await manifestRes.json();
        assert.equal(manifestData.success, true);
        assert.equal(manifestData.manifest.parentDocumentMissing, true);
        assert.equal(manifestData.manifest.counts.attempts, 1);
        assert.equal(manifestData.manifest.counts.results, 1);

        // Execute deletion
        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: testId,
                jobId,
                reason: "Scenario 2 missing parent cleanup"
            })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.status, "COMPLETED");
        assert.equal(data.parentDocumentMissing, true);
        assert.equal(data.deletedCounts.attempts, 1);
        assert.equal(data.deletedCounts.results, 1);

        // Verify attempts and results deleted
        assert.equal(await UniversalFirestoreService.getDocument("mockAttempts", "att_scen2_1"), null);
        assert.equal(await UniversalFirestoreService.getDocument("mockResults", "res_scen2_1"), null);
    });

    // =========================================================================
    // SCENARIO 3: Parent test document absent, but question/answer-key records remain
    // =========================================================================
    test("Scenario 3: Parent test document absent, but question/answer-key records remain", async () => {
        const testId = "mock-resilience-scen3-missing";
        const jobId = "job_resilience_scen3";

        // mockTests document deliberately NOT seeded
        assert.equal(await UniversalFirestoreService.getDocument("mockTests", testId), null);

        await UniversalFirestoreService.setDocument("mockQuestions", "q_scen3_1", {
            questionId: "q_scen3_1",
            testId,
            questionNumber: 1,
            questionText: "Orphaned Question Scenario 3"
        });

        await UniversalFirestoreService.setDocument("mockAnswerKeys", "ak_scen3_1", {
            answerKeyId: "ak_scen3_1",
            testId,
            answers: { "1": "C" }
        });

        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, {
            jobId,
            examId: "gate",
            year: 2024,
            paperCode: "CS",
            publishedMockTestId: testId,
            status: "published"
        });

        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: testId,
                jobId,
                reason: "Scenario 3 questions cleanup"
            })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.status, "COMPLETED");
        assert.equal(data.parentDocumentMissing, true);
        assert.equal(data.deletedCounts.questions, 1);
        assert.equal(data.deletedCounts.answerKeys, 1);

        // Verify questions and keys removed from emulator
        assert.equal(await UniversalFirestoreService.getDocument("mockQuestions", "q_scen3_1"), null);
        assert.equal(await UniversalFirestoreService.getDocument("mockAnswerKeys", "ak_scen3_1"), null);
    });

    // =========================================================================
    // SCENARIO 4: Parent test document absent, but test-exclusive Storage files remain
    // =========================================================================
    test("Scenario 4: Parent test document absent, but test-exclusive Storage files remain", async () => {
        const testId = "mock-resilience-scen4-missing";
        const jobId = "job_resilience_scen4";
        const storageKey = `tests/${testId}/exclusive_figure_scen4.png`;

        await uploadStorageFile(storageKey, "FIGURE_SCENARIO_4");
        assert.equal(await storageFileExists(storageKey), true);

        // mockTests document deliberately NOT seeded
        assert.equal(await UniversalFirestoreService.getDocument("mockTests", testId), null);

        await UniversalFirestoreService.setDocument("mockQuestions", "q_scen4_1", {
            questionId: "q_scen4_1",
            testId,
            firebaseStoragePath: `gs://${BUCKET}/${storageKey}`,
            questionText: "Question referencing storage asset"
        });

        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, {
            jobId,
            examId: "neet",
            year: 2024,
            paperCode: "Q3",
            publishedMockTestId: testId,
            status: "published"
        });

        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: testId,
                jobId,
                reason: "Scenario 4 storage asset cleanup"
            })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.status, "COMPLETED");

        // Verify storage file deleted
        assert.equal(await storageFileExists(storageKey), false);
        assert.equal(await UniversalFirestoreService.getDocument("mockQuestions", "q_scen4_1"), null);
    });

    // =========================================================================
    // SCENARIO 5: Parent document already deleted and all cleanup stages complete
    // =========================================================================
    test("Scenario 5: Parent document already deleted and all cleanup stages complete", async () => {
        const testId = "mock-resilience-scen5-empty";
        const jobId = "job_resilience_scen5";

        // Seed a job that references this testId as draftPackage but has no publishedMockTestId or live records
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, {
            jobId,
            examId: "neet",
            year: 2024,
            paperCode: "Q4",
            status: "needs_review",
            draftPackage: {
                testId
            }
        });

        // Request deletion manifest
        const manifestRes = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/deletion-manifest?jobId=${jobId}`, {
            headers: { "Authorization": `Bearer ${adminToken}` }
        });
        assert.equal(manifestRes.status, 200);
        const manifestData = await manifestRes.json();
        assert.equal(manifestData.success, true);
        assert.equal(manifestData.manifest.parentDocumentMissing, true);

        // Execute deletion
        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: testId,
                jobId,
                reason: "Scenario 5 empty deletion"
            })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.ok(data.status === "COMPLETED" || data.status === "NOTHING_TO_DELETE");

        // Second call directly detects NOTHING_TO_DELETE
        const secondRes = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: testId,
                jobId,
                reason: "Scenario 5 idempotent re-call"
            })
        });

        assert.equal(secondRes.status, 200);
        const secondData = await secondRes.json();
        assert.equal(secondData.success, true);
    });

    // =========================================================================
    // SCENARIO 6: Import job still exists after test deletion (unlinking association)
    // =========================================================================
    test("Scenario 6: Import job still exists after test deletion (preserves draft & source docs)", async () => {
        const testId = "mock-resilience-scen6-target";
        const jobId = "job_resilience_scen6";

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "upsc",
            year: 2024,
            paperCode: "GS1",
            title: "UPSC GS1 Prelims",
            status: "published"
        });

        // Seed import job with draft questions and source document
        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, {
            jobId,
            examId: "upsc",
            year: 2024,
            paperCode: "GS1",
            status: "published",
            publishedMockTestId: testId,
            sourceDocuments: {
                questionPaper: {
                    storagePath: `vault/${jobId}/upsc_paper.pdf`
                }
            },
            draftPackage: {
                questions: [{ id: "draft_upsc_1", text: "Draft UPSC question" }]
            }
        });

        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: testId,
                jobId,
                reason: "Scenario 6 test deletion unlinking job"
            })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.status, "COMPLETED");

        // Verify mock test deleted
        assert.equal(await UniversalFirestoreService.getDocument("mockTests", testId), null);

        // Verify import job STILL EXISTS and has publication unlinked
        const jobAfter = await UniversalFirestoreService.getDocument("paperImportJobs", jobId);
        assert.ok(jobAfter, "Import job must not be deleted because it retains source documents and drafts");
        assert.equal(jobAfter.publishedMockTestId, undefined, "publishedMockTestId must be removed");
        assert.equal(jobAfter.status, "needs_review", "Job status should revert from published");
        assert.ok(Array.isArray(jobAfter.auditLog), "Audit log must be updated");
        assert.equal(jobAfter.auditLog[jobAfter.auditLog.length - 1].action, "MOCK_TEST_DELETED");
    });

    // =========================================================================
    // SCENARIO 7: Multi-test job preserves sibling tests and shared data
    // =========================================================================
    test("Scenario 7: Multi-test job preserves sibling tests and shared data", async () => {
        const targetTestId = "mock-resilience-scen7-target";
        const siblingTestId = "mock-resilience-scen7-sibling";
        const sharedKey = "shared_assets/physics_diagram_scen7.png";
        const exclusiveKey = `tests/${targetTestId}/exclusive_diagram_scen7.png`;

        await uploadStorageFile(sharedKey, "SHARED_PHYSICS_DIAGRAM");
        await uploadStorageFile(exclusiveKey, "EXCLUSIVE_TARGET_DIAGRAM");

        // Target test
        await UniversalFirestoreService.setDocument("mockTests", targetTestId, {
            testId: targetTestId,
            examId: "neet",
            year: 2024,
            paperCode: "Q7",
            title: "Target Test Scenario 7",
            questionIds: ["q_scen7_excl", "q_scen7_shared"],
            status: "published"
        });

        // Sibling test
        await UniversalFirestoreService.setDocument("mockTests", siblingTestId, {
            testId: siblingTestId,
            examId: "neet",
            year: 2024,
            paperCode: "Q7",
            title: "Sibling Test Preserved Scenario 7",
            questionIds: ["q_scen7_sibling_excl", "q_scen7_shared"],
            status: "published"
        });

        // Questions
        await UniversalFirestoreService.setDocument("mockQuestions", "q_scen7_excl", {
            questionId: "q_scen7_excl",
            testId: targetTestId,
            firebaseStoragePath: `gs://${BUCKET}/${exclusiveKey}`,
            questionText: "Target Exclusive Question"
        });

        await UniversalFirestoreService.setDocument("mockQuestions", "q_scen7_shared", {
            questionId: "q_scen7_shared",
            testId: targetTestId,
            sharedReferenceIds: [targetTestId, siblingTestId],
            firebaseStoragePath: `gs://${BUCKET}/${sharedKey}`,
            questionText: "Shared Question across tests"
        });

        await UniversalFirestoreService.setDocument("mockQuestions", "q_scen7_sibling_excl", {
            questionId: "q_scen7_sibling_excl",
            testId: siblingTestId,
            questionText: "Sibling Exclusive Question"
        });

        // Delete target test only
        const res = await fetch(`${baseUrl}/api/admin/mock-tests/${targetTestId}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: targetTestId,
                reason: "Scenario 7 multi-test sibling preservation"
            })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.sharedPreserved.questions, 1, "Shared question must be preserved");

        // Verify target deleted, exclusive question deleted, exclusive storage deleted
        assert.equal(await UniversalFirestoreService.getDocument("mockTests", targetTestId), null);
        assert.equal(await UniversalFirestoreService.getDocument("mockQuestions", "q_scen7_excl"), null);
        assert.equal(await storageFileExists(exclusiveKey), false);

        // Verify sibling test PRESERVED, shared question PRESERVED, shared storage PRESERVED
        assert.ok(await UniversalFirestoreService.getDocument("mockTests", siblingTestId));
        assert.ok(await UniversalFirestoreService.getDocument("mockQuestions", "q_scen7_shared"));
        assert.ok(await UniversalFirestoreService.getDocument("mockQuestions", "q_scen7_sibling_excl"));
        assert.equal(await storageFileExists(sharedKey), true);
    });

    // =========================================================================
    // SCENARIO 8: Retry after a simulated mid-deletion failure
    // =========================================================================
    test("Scenario 8: Retry after a simulated mid-deletion failure", async () => {
        const testId = "mock-resilience-scen8-target";

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "jee_adv",
            year: 2024,
            title: "Simulated Mid-Deletion Failure Target",
            status: "published"
        });

        await UniversalFirestoreService.setDocument("mockQuestions", "q_scen8_1", {
            questionId: "q_scen8_1",
            testId,
            questionText: "Question Scenario 8"
        });

        // Generate manifest
        const manifest = await MockTestDeletionService.generateDeletionManifest({
            testId,
            adminUid: ADMIN_UID,
            reason: "Simulate mid-deletion failure",
            options: { projectId: "demo-vidyarthiastra" }
        });

        // Simulate interruption at deleteQuestionsAndKeys
        manifest.status = "FAILED";
        manifest.currentStage = "deleteQuestionsAndKeys";
        manifest.errors.push({
            stage: "deleteQuestionsAndKeys",
            error: "Simulated connection drop during question cleanup",
            timestamp: new Date().toISOString()
        });
        await UniversalFirestoreService.setDocument("mockTestDeletionOperations", manifest.operationId, manifest);

        // Call retry endpoint
        const retryRes = await fetch(`${baseUrl}/api/admin/mock-tests/deletions/${manifest.operationId}/retry`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            }
        });

        assert.equal(retryRes.status, 200);
        const retryData = await retryRes.json();
        assert.equal(retryData.success, true);
        assert.equal(retryData.status, "COMPLETED");

        // Verify test and question are now fully deleted
        assert.equal(await UniversalFirestoreService.getDocument("mockTests", testId), null);
        assert.equal(await UniversalFirestoreService.getDocument("mockQuestions", "q_scen8_1"), null);

        // Verify operation status in Firestore
        const finalOp = await UniversalFirestoreService.getDocument("mockTestDeletionOperations", manifest.operationId);
        assert.equal(finalOp.status, "COMPLETED");
        assert.equal(finalOp.retryCount, 1);
    });

    // =========================================================================
    // SCENARIO 9: Unauthenticated and non-admin deletion requests are rejected
    // =========================================================================
    test("Scenario 9: Unauthenticated and non-admin deletion requests are rejected", async () => {
        const testId = "mock-resilience-scen9-target";

        // 1. DELETE without auth -> 401
        const unauthDel = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmation: testId })
        });
        assert.equal(unauthDel.status, 401);

        // 2. DELETE with student token -> 403
        const nonAdminDel = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${studentToken}`
            },
            body: JSON.stringify({ confirmation: testId })
        });
        assert.equal(nonAdminDel.status, 403);

        // 3. GET manifest without auth -> 401
        const unauthManifest = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/deletion-manifest`);
        assert.equal(unauthManifest.status, 401);

        // 4. GET manifest with student token -> 403
        const nonAdminManifest = await fetch(`${baseUrl}/api/admin/mock-tests/${testId}/deletion-manifest`, {
            headers: { "Authorization": `Bearer ${studentToken}` }
        });
        assert.equal(nonAdminManifest.status, 403);

        // 5. POST retry without auth -> 401
        const unauthRetry = await fetch(`${baseUrl}/api/admin/mock-tests/deletions/del_op_fake/retry`, {
            method: "POST"
        });
        assert.equal(unauthRetry.status, 401);

        // 6. POST retry with student token -> 403
        const nonAdminRetry = await fetch(`${baseUrl}/api/admin/mock-tests/deletions/del_op_fake/retry`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${studentToken}` }
        });
        assert.equal(nonAdminRetry.status, 403);
    });

    // =========================================================================
    // SCENARIO 10: History refresh reflects the actual remaining import jobs
    // =========================================================================
    test("Scenario 10: History refresh reflects the actual remaining import jobs", async () => {
        const deletedTestId = "mock-resilience-scen10-deleted";
        const deletedJobId = "job_resilience_scen10_deleted";
        const remainingJobId = "job_resilience_scen10_remaining";
        const draftJobId = "job_resilience_scen10_draft";

        // Seed 3 jobs
        // 1. Single-test job that will be deleted entirely
        await UniversalFirestoreService.setDocument("mockTests", deletedTestId, {
            testId: deletedTestId,
            examId: "neet",
            year: 2024,
            paperCode: "D1",
            title: "To Be Deleted Test",
            status: "published"
        });
        await UniversalFirestoreService.setDocument("paperImportJobs", deletedJobId, {
            jobId: deletedJobId,
            examId: "neet",
            year: 2024,
            paperCode: "D1",
            status: "published",
            publishedMockTestId: deletedTestId
        });

        // 2. Active published sibling job that should remain
        await UniversalFirestoreService.setDocument("mockTests", "mock-scen10-rem", {
            testId: "mock-scen10-rem",
            examId: "neet",
            year: 2024,
            paperCode: "D2",
            title: "Remaining Active Test",
            status: "published"
        });
        await UniversalFirestoreService.setDocument("paperImportJobs", remainingJobId, {
            jobId: remainingJobId,
            examId: "neet",
            year: 2024,
            paperCode: "D2",
            status: "published",
            publishedMockTestId: "mock-scen10-rem"
        });

        // 3. Draft verification pending job that should remain
        await UniversalFirestoreService.setDocument("paperImportJobs", draftJobId, {
            jobId: draftJobId,
            examId: "gate",
            year: 2024,
            paperCode: "EE",
            status: "verification_pending",
            extractedQuestionCount: 5
        });

        // Sync pipeline in-memory cache
        await ImportJobPipelineService.syncJobsFromFirestore();

        // Check history before deletion
        const beforeRes = await fetch(`${baseUrl}/api/admin/import/jobs`, {
            headers: { "Authorization": `Bearer ${adminToken}` }
        });
        assert.equal(beforeRes.status, 200);
        const beforeData = await beforeRes.json();
        const beforeJobIds = beforeData.jobs.map(j => j.jobId);
        assert.ok(beforeJobIds.includes(deletedJobId));
        assert.ok(beforeJobIds.includes(remainingJobId));
        assert.ok(beforeJobIds.includes(draftJobId));

        // Delete test for deletedJobId
        const delRes = await fetch(`${baseUrl}/api/admin/mock-tests/${deletedTestId}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminToken}`
            },
            body: JSON.stringify({
                confirmation: deletedTestId,
                jobId: deletedJobId,
                reason: "Scenario 10 history refresh test"
            })
        });
        assert.equal(delRes.status, 200);

        // Fetch history after deletion
        const afterRes = await fetch(`${baseUrl}/api/admin/import/jobs`, {
            headers: { "Authorization": `Bearer ${adminToken}` }
        });
        assert.equal(afterRes.status, 200);
        const afterData = await afterRes.json();
        const afterJobIds = afterData.jobs.map(j => j.jobId);

        // Verify deletedJobId was cleanly evicted from history
        assert.equal(afterJobIds.includes(deletedJobId), false, "Deleted job must not appear in history list");
        assert.ok(afterJobIds.includes(remainingJobId), "Active sibling job must remain in history list");
        assert.ok(afterJobIds.includes(draftJobId), "Draft job must remain in history list");
    });
});
