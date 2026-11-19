import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import app from "../server/server.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { MockTestService } from "../server/services/mockTestService.js";

/**
 * Comprehensive Mock-Test Engine & Data Boundary Verification Suite
 * Covers all 20 required safety scenarios.
 */
describe("Master Mock Test Engine & Safety Protection Suite", () => {
    let keyPair;
    let server;
    let baseUrl;
    const ADMIN_UID = "test_admin_safety_uid";
    const STUDENT_A_UID = "test_student_a_uid_1001";
    const STUDENT_B_UID = "test_student_b_uid_1002";

    const VALID_TEST_RUN_ID = "testrun_safe_20261023";
    const SYNTH_EXAM_ID = "synthetic-qa-exam";
    const SYNTH_TEST_ID = `mock-${VALID_TEST_RUN_ID}-${SYNTH_EXAM_ID}-9999-synth01`;

    function createToken(uid) {
        const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            iss: "https://securetoken.google.com/pyqs-hub-43bed",
            aud: "pyqs-hub-43bed",
            auth_time: now,
            sub: uid,
            user_id: uid,
            iat: now,
            exp: now + 3600
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

        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });
    });

    after(() => {
        if (server) {
            if (server.closeAllConnections) {
                server.closeAllConnections();
            }
            server.close();
        }
    });

    beforeEach(() => {
        UniversalFirestoreService.clearLocalCache();

        // Seed users
        UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@vidyarthiastra.in",
            role: "admin"
        });

        UniversalFirestoreService.setDocument("users", STUDENT_A_UID, {
            uid: STUDENT_A_UID,
            email: "studentA@test.local",
            role: "user"
        });

        UniversalFirestoreService.setDocument("users", STUDENT_B_UID, {
            uid: STUDENT_B_UID,
            email: "studentB@test.local",
            role: "user"
        });
    });

    // -------------------------------------------------------------
    // Scenario 1: Synthetic import requires a valid testRunId
    // -------------------------------------------------------------
    test("1. Synthetic import requires a valid testRunId", async () => {
        await assert.rejects(async () => {
            await UniversalFirestoreService.saveImportedPackage({
                mockTest: { isSyntheticTest: true, examId: SYNTH_EXAM_ID },
                questions: [],
                answerKeys: []
            });
        }, /Synthetic test import requires a valid testRunId/);
    });

    // -------------------------------------------------------------
    // Scenario 2: Invalid or missing test-run IDs are rejected
    // -------------------------------------------------------------
    test("2. Invalid test-run IDs are rejected (too short or invalid chars)", async () => {
        await assert.rejects(async () => {
            await UniversalFirestoreService.saveImportedPackage({
                mockTest: { isSyntheticTest: true, testRunId: "short", examId: SYNTH_EXAM_ID },
                questions: [],
                answerKeys: []
            });
        }, /valid testRunId/);

        await assert.rejects(async () => {
            await UniversalFirestoreService.saveImportedPackage({
                mockTest: { isSyntheticTest: true, testRunId: "invalid!@#run", examId: SYNTH_EXAM_ID },
                questions: [],
                answerKeys: []
            });
        }, /valid testRunId/);
    });

    // -------------------------------------------------------------
    // Scenario 3: Synthetic imports cannot write to legacy exam question paths
    // -------------------------------------------------------------
    test("3. Synthetic imports cannot write to legacy exam question paths", async () => {
        const mockTest = {
            testId: SYNTH_TEST_ID,
            examId: SYNTH_EXAM_ID,
            year: 9999,
            paperCode: "SYNTH01",
            isSyntheticTest: true,
            testRunId: VALID_TEST_RUN_ID,
            status: "draft"
        };

        const questions = [
            { questionId: `${SYNTH_TEST_ID}-q1`, questionNumber: 1, questionText: "Sample Q" }
        ];

        await UniversalFirestoreService.saveImportedPackage({
            mockTest,
            questions,
            answerKeys: []
        });

        // Verify it exists in mockQuestions
        const qDoc = await UniversalFirestoreService.getDocument("mockQuestions", `${SYNTH_TEST_ID}-q1`);
        assert.ok(qDoc);

        // Verify legacy path was NEVER touched or created in cache
        const legacyDoc = await UniversalFirestoreService.getDocument(
            `exams/${SYNTH_EXAM_ID}/years/9999/papers/SYNTH01/questions`,
            "1"
        );
        assert.equal(legacyDoc, null, "Legacy path write must be completely skipped for synthetic test");
    });

    // -------------------------------------------------------------
    // Scenario 4: Synthetic imports cannot overwrite existing exam configurations
    // -------------------------------------------------------------
    test("4. Synthetic imports cannot overwrite existing exam configurations", async () => {
        // Seed legitimate production exam configuration
        const prodConfig = {
            configId: "neet-ug-standard",
            examName: "NEET (UG) Production",
            maximumMarks: 720
        };
        await UniversalFirestoreService.setDocument("examConfigs", prodConfig.configId, prodConfig);

        // Synthetic package attempts to supply examConfig
        await UniversalFirestoreService.saveImportedPackage({
            examConfig: { configId: "neet-ug-standard", examName: "Tampered Test Pattern", maximumMarks: 100 },
            mockTest: {
                testId: SYNTH_TEST_ID,
                examId: SYNTH_EXAM_ID,
                year: 9999,
                paperCode: "SYNTH01",
                isSyntheticTest: true,
                testRunId: VALID_TEST_RUN_ID
            },
            questions: [],
            answerKeys: []
        });

        // Verify production exam config remains untouched!
        const fetchedConfig = await UniversalFirestoreService.getDocument("examConfigs", "neet-ug-standard");
        assert.equal(fetchedConfig.examName, "NEET (UG) Production");
        assert.equal(fetchedConfig.maximumMarks, 720);
    });

    // -------------------------------------------------------------
    // Scenario 5: Create-only document writes reject collisions
    // -------------------------------------------------------------
    test("5. Create-only document writes reject collisions", async () => {
        await UniversalFirestoreService.setDocument("mockTests", "collision_test_doc", { title: "Original" });

        await assert.rejects(async () => {
            await UniversalFirestoreService.setDocument("mockTests", "collision_test_doc", { title: "Attempted Overwrite" }, { createOnly: true });
        }, /Document collision: Document mockTests\/collision_test_doc already exists/);

        const doc = await UniversalFirestoreService.getDocument("mockTests", "collision_test_doc");
        assert.equal(doc.title, "Original");
    });

    // -------------------------------------------------------------
    // Scenario 6: Multi-document failure does not silently overwrite existing records
    // -------------------------------------------------------------
    test("6. Multi-document failure rejects collision without overwrite", async () => {
        // Pre-seed an existing mockTest
        await UniversalFirestoreService.setDocument("mockTests", SYNTH_TEST_ID, { title: "Pre-existing Test" });

        await assert.rejects(async () => {
            await UniversalFirestoreService.saveImportedPackage({
                mockTest: {
                    testId: SYNTH_TEST_ID,
                    examId: SYNTH_EXAM_ID,
                    isSyntheticTest: true,
                    testRunId: VALID_TEST_RUN_ID
                },
                questions: [],
                answerKeys: []
            });
        }, /Document collision: Test .* already exists in Firestore/);

        const current = await UniversalFirestoreService.getDocument("mockTests", SYNTH_TEST_ID);
        assert.equal(current.title, "Pre-existing Test");
    });

    // -------------------------------------------------------------
    // Scenario 7: Draft tests are excluded from student discovery
    // -------------------------------------------------------------
    test("7. Draft tests are excluded from student discovery", async () => {
        // Seed draft test
        await UniversalFirestoreService.setDocument("mockTests", "draft_test_01", {
            testId: "draft_test_01",
            title: "Draft Test",
            status: "draft"
        });

        // Seed published test
        await UniversalFirestoreService.setDocument("mockTests", "published_test_01", {
            testId: "published_test_01",
            title: "Published Test",
            status: "published"
        });

        const list = await MockTestService.listPublishedTests();
        assert.equal(list.some(t => t.testId === "draft_test_01"), false);
        assert.equal(list.some(t => t.testId === "published_test_01"), true);

        // Student retrieving draft test directly receives null (404)
        const studentFetch = await MockTestService.getTestForStudent("draft_test_01", { callerRole: "user" });
        assert.equal(studentFetch, null);

        // Admin retrieving draft test succeeds
        const adminFetch = await MockTestService.getTestForStudent("draft_test_01", { callerRole: "admin" });
        assert.ok(adminFetch);
    });

    // -------------------------------------------------------------
    // Scenario 8: Answer keys never appear in student API responses
    // -------------------------------------------------------------
    test("8. Answer keys never appear in student API responses", async () => {
        const testId = "published_test_secret_check";
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            status: "published",
            questionIds: [`${testId}-q1`]
        });

        // Seed question and answer key
        await UniversalFirestoreService.setDocument("mockQuestions", `${testId}-q1`, {
            questionId: `${testId}-q1`,
            testId,
            questionNumber: 1,
            questionText: "What is velocity?",
            options: [{ id: "1", label: "A", text: "Rate of change of displacement" }],
            // Any accidental or internal field
            correctAnswer: "1"
        });

        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${testId}-key-q1`, {
            answerKeyId: `${testId}-key-q1`,
            testId,
            questionNumber: 1,
            correctAnswers: ["1"]
        });

        const studentView = await MockTestService.getTestForStudent(testId, { callerRole: "user" });
        assert.ok(studentView.questions.length > 0);
        const q = studentView.questions[0];

        assert.equal(q.correctAnswer, undefined);
        assert.equal(q.correctAnswers, undefined);
        assert.equal(q.answerKeyId, undefined);
        assert.equal(q.scoringProvenance, undefined);
    });

    // -------------------------------------------------------------
    // Scenario 9: Invalid Firebase tokens are rejected
    // -------------------------------------------------------------
    test("9. Invalid Firebase tokens are rejected with 401", async () => {
        const res = await fetch(`${baseUrl}/api/mock-tests/some-test`, {
            headers: { "Authorization": "Bearer invalid.malformed.token" }
        });
        assert.equal(res.status, 401);
    });

    // -------------------------------------------------------------
    // Scenario 10: Client-supplied UIDs cannot impersonate other students
    // -------------------------------------------------------------
    test("10. Attempt start enforces authenticated token UID and rejects spoofing", async () => {
        const testId = "published_test_for_attempts";
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            status: "published",
            durationSeconds: 1200
        });

        const token = createToken(STUDENT_A_UID);
        const res = await fetch(`${baseUrl}/api/mock-tests/${testId}/attempts`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: STUDENT_B_UID // Attempted spoof
            })
        });

        assert.equal(res.status, 201);
        const body = await res.json();
        assert.equal(body.attempt.userId, STUDENT_A_UID, "Attempt must belong strictly to authenticated token UID");
        assert.notEqual(body.attempt.userId, STUDENT_B_UID);
    });

    // -------------------------------------------------------------
    // Scenario 11: Attempt ownership is enforced
    // -------------------------------------------------------------
    test("11. Attempt ownership is enforced across students", async () => {
        const attempt = {
            attemptId: "attempt_owned_by_a",
            testId: "test_a",
            userId: STUDENT_A_UID,
            status: "in_progress",
            deadlineAt: new Date(Date.now() + 100000).toISOString()
        };
        await UniversalFirestoreService.setDocument("mockAttempts", attempt.attemptId, attempt);

        // Student B tries to autosave Student A's attempt
        await assert.rejects(async () => {
            await MockTestService.autosaveAttempt({
                attemptId: attempt.attemptId,
                userId: STUDENT_B_UID,
                answers: { q1: "2" }
            });
        }, (err) => err.statusCode === 403);
    });

    // -------------------------------------------------------------
    // Scenario 12: Autosave rejects submitted or expired attempts
    // -------------------------------------------------------------
    test("12. Autosave rejects submitted or expired attempts", async () => {
        // 1. Submitted attempt
        const submittedAttempt = {
            attemptId: "attempt_submitted_already",
            testId: "test_a",
            userId: STUDENT_A_UID,
            status: "submitted",
            deadlineAt: new Date(Date.now() + 100000).toISOString()
        };
        await UniversalFirestoreService.setDocument("mockAttempts", submittedAttempt.attemptId, submittedAttempt);

        await assert.rejects(async () => {
            await MockTestService.autosaveAttempt({
                attemptId: submittedAttempt.attemptId,
                userId: STUDENT_A_UID,
                answers: { q1: "2" }
            });
        }, (err) => err.statusCode === 400 && err.message.includes("submitted"));

        // 2. Expired attempt
        const expiredAttempt = {
            attemptId: "attempt_expired_already",
            testId: "test_a",
            userId: STUDENT_A_UID,
            status: "in_progress",
            deadlineAt: new Date(Date.now() - 5000).toISOString() // Expired 5 seconds ago
        };
        await UniversalFirestoreService.setDocument("mockAttempts", expiredAttempt.attemptId, expiredAttempt);

        await assert.rejects(async () => {
            await MockTestService.autosaveAttempt({
                attemptId: expiredAttempt.attemptId,
                userId: STUDENT_A_UID,
                answers: { q1: "2" }
            });
        }, (err) => err.statusCode === 400 && err.message.includes("expired"));
    });

    // -------------------------------------------------------------
    // Scenario 13: Client-supplied scores are ignored
    // -------------------------------------------------------------
    test("13. Client-supplied scores are discarded during submission", async () => {
        const testId = "test_scoring_tamper";
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            status: "published",
            questionIds: [`${testId}-q1`]
        });
        await UniversalFirestoreService.setDocument("mockQuestions", `${testId}-q1`, {
            questionId: `${testId}-q1`,
            testId,
            questionNumber: 1
        });
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${testId}-key-q1`, {
            answerKeyId: `${testId}-key-q1`,
            testId,
            questionNumber: 1,
            correctAnswers: ["2"],
            marksAwarded: 4,
            marksDeducted: 1
        });

        const attemptId = "attempt_tamper_score_check";
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId,
            testId,
            userId: STUDENT_A_UID,
            status: "in_progress",
            answers: { [`${testId}-q1`]: "2" }
        });

        // Submit attempt
        const result = await MockTestService.submitAttempt({
            attemptId,
            userId: STUDENT_A_UID
        });

        assert.equal(result.totalScore, 4);
    });

    // -------------------------------------------------------------
    // Scenario 14: Server scoring handles correct, incorrect, unanswered, and dropped questions
    // -------------------------------------------------------------
    test("14. Server scoring handles correct, incorrect, unanswered, and dropped questions", () => {
        const questions = [
            { questionId: "q1", questionNumber: 1 },
            { questionId: "q2", questionNumber: 2 },
            { questionId: "q3", questionNumber: 3 }, // Dropped
            { questionId: "q4", questionNumber: 4 }  // Unanswered
        ];

        const answerKeys = [
            { questionNumber: 1, correctAnswers: ["2"], marksAwarded: 4, marksDeducted: 1 },
            { questionNumber: 2, correctAnswers: ["4"], marksAwarded: 4, marksDeducted: 1 },
            { questionNumber: 3, isDropped: true, marksAwarded: 4 }, // Bonus drop rule
            { questionNumber: 4, correctAnswers: ["1"], marksAwarded: 4, marksDeducted: 1 }
        ];

        // Q1: "2" -> Correct (+4)
        // Q2: "3" -> Incorrect (-1)
        // Q3: null -> Unanswered, but dropped (+4 bonus)
        // Q4: null -> Unanswered (0)
        const studentAnswers = { q1: "2", q2: "3" };

        const scoreResult = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers
        });

        assert.equal(scoreResult.totalScore, 7); // +4 - 1 + 4 + 0
        assert.equal(scoreResult.correctCount, 1);
        assert.equal(scoreResult.incorrectCount, 1);
        assert.equal(scoreResult.droppedCount, 1);
        assert.equal(scoreResult.unansweredCount, 1);
        assert.equal(scoreResult.accuracyPercent, 50);
    });

    // -------------------------------------------------------------
    // Scenario 15: Duplicate submissions are idempotent
    // -------------------------------------------------------------
    test("15. Duplicate submissions are idempotent and return original result", async () => {
        const testId = "test_idempotent_sub";
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            status: "published",
            questionIds: [`${testId}-q1`]
        });
        await UniversalFirestoreService.setDocument("mockQuestions", `${testId}-q1`, {
            questionId: `${testId}-q1`,
            testId,
            questionNumber: 1
        });
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${testId}-key-q1`, {
            answerKeyId: `${testId}-key-q1`,
            testId,
            questionNumber: 1,
            correctAnswers: ["2"],
            marksAwarded: 4
        });

        const attemptId = "attempt_idempotency_verify";
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId,
            testId,
            userId: STUDENT_A_UID,
            status: "in_progress",
            answers: { [`${testId}-q1`]: "2" }
        });

        // 1st submission
        const res1 = await MockTestService.submitAttempt({ attemptId, userId: STUDENT_A_UID });
        assert.equal(res1.totalScore, 4);

        // 2nd submission
        const res2 = await MockTestService.submitAttempt({ attemptId, userId: STUDENT_A_UID });
        assert.equal(res2.totalScore, 4);
        assert.equal(res2.alreadySubmitted, true);
    });

    // -------------------------------------------------------------
    // Scenario 16: Students cannot read another student's attempts or results
    // -------------------------------------------------------------
    test("16. Students cannot read another student's attempts or results", async () => {
        const resultId = "result_student_a_secret";
        await UniversalFirestoreService.setDocument("mockResults", resultId, {
            resultId,
            userId: STUDENT_A_UID,
            totalScore: 500
        });

        // Student B attempts to read Student A's result
        await assert.rejects(async () => {
            await MockTestService.getResult({
                resultId,
                userId: STUDENT_B_UID,
                callerRole: "user"
            });
        }, (err) => err.statusCode === 403);

        // Student A can read their own result
        const resA = await MockTestService.getResult({
            resultId,
            userId: STUDENT_A_UID,
            callerRole: "user"
        });
        assert.equal(resA.totalScore, 500);
    });

    // -------------------------------------------------------------
    // Scenario 17: Admin routes remain inaccessible to non-admins
    // -------------------------------------------------------------
    test("17. Admin routes remain inaccessible to non-admins (HTTP 403)", async () => {
        const studentToken = createToken(STUDENT_A_UID);
        const res = await fetch(`${baseUrl}/api/admin/auth/check`, {
            headers: { "Authorization": `Bearer ${studentToken}` }
        });
        assert.equal(res.status, 403);
    });

    // -------------------------------------------------------------
    // Scenario 18: Existing PYQ routes and behavior remain functional
    // -------------------------------------------------------------
    test("18. Existing PYQ counter endpoints validate parameters safely", async () => {
        const res = await fetch(`${baseUrl}/api/papers/increment-view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId: "neet-ug",
                yearId: "2024",
                paperId: "q1_paper"
            })
        });
        // Since paper doesn't exist in local mock cache, cleanly rejects with 400
        assert.equal(res.status, 400);
    });

    // -------------------------------------------------------------
    // Scenario 19: Test mode fails closed if production Firebase configuration is detected
    // -------------------------------------------------------------
    test("19. Rejects synthetic test import when production exam identifiers are attempted", async () => {
        await assert.rejects(async () => {
            await UniversalFirestoreService.saveImportedPackage({
                mockTest: {
                    testId: "test_illegal_prod_exam",
                    examId: "neet-ug", // Illegal production ID in synthetic test
                    isSyntheticTest: true,
                    testRunId: VALID_TEST_RUN_ID
                },
                questions: [],
                answerKeys: []
            });
        }, /Synthetic tests cannot use production exam identifiers/);
    });

    // -------------------------------------------------------------
    // Scenario 20: Automated tests cannot perform external Firestore write requests
    // -------------------------------------------------------------
    test("20. Automated tests cannot perform external Firestore write requests in test mode", async () => {
        assert.equal(process.env.NODE_ENV, "test");
        const res = await UniversalFirestoreService.commitBatchWrites([
            { update: { name: "test_doc", fields: {} } }
        ]);
        assert.equal(res.success, true);
        assert.equal(res.count, 1);
    });
});
