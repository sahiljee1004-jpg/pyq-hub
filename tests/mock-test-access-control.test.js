import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import app from "../server/server.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";

/**
 * Mock Test Access Control & Guest Guard Integration Test Suite
 * 
 * Verifies strict registration-based access control across:
 * 1. Public catalog access for unauthenticated guests (sanitized metadata only)
 * 2. Complete 401 rejection for unauthenticated guests accessing protected routes
 * 3. Guessing test IDs does not bypass guest authentication
 * 4. Authenticated registered user permissions (questions without answer keys, attempts, scoring)
 * 5. Attempt and result ownership boundaries (403 Forbidden on mismatch)
 * 6. Unpublished/draft test protection against students
 * 7. Token validation (invalid/expired tokens rejected)
 * 8. Non-admin student blocked from admin endpoints
 */
describe("Mock Test Access Control & Authorization Security Suite", () => {
    let keyPair;
    let server;
    let baseUrl;

    const STUDENT_A_UID = "test_auth_student_a_001";
    const STUDENT_B_UID = "test_auth_student_b_002";
    const ADMIN_UID = "test_auth_admin_001";

    const PUBLISHED_TEST_ID = "mock-neet-2024-test-published";
    const DRAFT_TEST_ID = "mock-neet-2025-test-draft";

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
            if (server.closeAllConnections) server.closeAllConnections();
            server.close();
        }
    });

    beforeEach(async () => {
        UniversalFirestoreService.clearLocalCache();

        // 1. Seed Users
        await UniversalFirestoreService.setDocument("users", STUDENT_A_UID, {
            uid: STUDENT_A_UID,
            email: "studentA@test.vidyarthiastra.in",
            name: "Student Alpha",
            role: "user"
        });

        await UniversalFirestoreService.setDocument("users", STUDENT_B_UID, {
            uid: STUDENT_B_UID,
            email: "studentB@test.vidyarthiastra.in",
            name: "Student Beta",
            role: "user"
        });

        await UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@vidyarthiastra.in",
            name: "Admin User",
            role: "admin"
        });

        // 2. Seed Published Test
        await UniversalFirestoreService.setDocument("mockTests", PUBLISHED_TEST_ID, {
            testId: PUBLISHED_TEST_ID,
            examId: "neet-ug",
            examName: "NEET (UG)",
            year: 2024,
            title: "NEET 2024 All India Mock Examination",
            paperCode: "Q1",
            durationSeconds: 1200,
            totalQuestions: 2,
            maximumMarks: 8,
            availableLanguages: ["English", "Hindi"],
            status: "published",
            adminNotes: "CONFIDENTIAL_ADMIN_NOTE_DO_NOT_LEAK",
            sourcePdfUrl: "https://vault.internal/private/neet2024.pdf",
            scoringConfig: { correctMarks: 4, negativeMarks: -1 },
            createdAt: new Date().toISOString()
        });

        // 3. Seed Draft Test (Unpublished)
        await UniversalFirestoreService.setDocument("mockTests", DRAFT_TEST_ID, {
            testId: DRAFT_TEST_ID,
            examId: "neet-ug",
            examName: "NEET (UG)",
            year: 2025,
            title: "NEET 2025 Draft Mock Test",
            paperCode: "D1",
            durationSeconds: 1200,
            status: "draft",
            createdAt: new Date().toISOString()
        });

        // 4. Seed Questions
        await UniversalFirestoreService.setDocument("mockQuestions", `${PUBLISHED_TEST_ID}-q1`, {
            questionId: `${PUBLISHED_TEST_ID}-q1`,
            testId: PUBLISHED_TEST_ID,
            questionNumber: 1,
            subject: "Physics",
            questionText: "What is the SI unit of electric potential?",
            options: [
                { id: "1", label: "A", text: "Volt" },
                { id: "2", label: "B", text: "Watt" },
                { id: "3", label: "C", text: "Joule" },
                { id: "4", label: "D", text: "Ampere" }
            ],
            translations: {
                hindi: {
                    questionText: "विद्युत विभव का SI मात्रक क्या है?",
                    options: [
                        { id: "1", text: "वोल्ट" },
                        { id: "2", text: "वाट" },
                        { id: "3", text: "जूल" },
                        { id: "4", text: "एम्पीयर" }
                    ]
                }
            }
        });

        await UniversalFirestoreService.setDocument("mockQuestions", `${PUBLISHED_TEST_ID}-q2`, {
            questionId: `${PUBLISHED_TEST_ID}-q2`,
            testId: PUBLISHED_TEST_ID,
            questionNumber: 2,
            subject: "Chemistry",
            questionText: "Which gas is evolved when zinc reacts with dilute sulfuric acid?",
            options: [
                { id: "1", label: "A", text: "Oxygen" },
                { id: "2", label: "B", text: "Hydrogen" },
                { id: "3", label: "C", text: "Nitrogen" },
                { id: "4", label: "D", text: "Carbon Dioxide" }
            ]
        });

        // 5. Seed Answer Keys (Confidential)
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${PUBLISHED_TEST_ID}-key-q1`, {
            answerKeyId: `${PUBLISHED_TEST_ID}-key-q1`,
            testId: PUBLISHED_TEST_ID,
            questionId: `${PUBLISHED_TEST_ID}-q1`,
            questionNumber: 1,
            correctAnswers: ["1"],
            marksAwarded: 4,
            negativeMarks: -1
        });

        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${PUBLISHED_TEST_ID}-key-q2`, {
            answerKeyId: `${PUBLISHED_TEST_ID}-key-q2`,
            testId: PUBLISHED_TEST_ID,
            questionId: `${PUBLISHED_TEST_ID}-q2`,
            questionNumber: 2,
            correctAnswers: ["2"],
            marksAwarded: 4,
            negativeMarks: -1
        });
    });

    // -------------------------------------------------------------------------
    // 1. Guest Access to Public Catalog
    // -------------------------------------------------------------------------
    test("1. Unauthenticated guest can access public catalog with sanitized metadata only", async () => {
        const res = await fetch(`${baseUrl}/api/mock-tests`);
        assert.equal(res.status, 200);

        const data = await res.json();
        assert.equal(data.success, true);
        assert.ok(Array.isArray(data.tests));
        assert.equal(data.tests.length, 1); // Draft test is excluded

        const testMeta = data.tests[0];
        assert.equal(testMeta.testId, PUBLISHED_TEST_ID);
        assert.equal(testMeta.title, "NEET 2024 All India Mock Examination");
        assert.equal(testMeta.durationSeconds, 1200);
        assert.equal(testMeta.totalQuestions, 2);
        assert.equal(testMeta.maximumMarks, 8);
        assert.deepEqual(testMeta.availableLanguages, ["English", "Hindi"]);

        // Strictly verify sensitive fields are NOT exposed
        assert.equal(testMeta.adminNotes, undefined, "Admin notes must not leak");
        assert.equal(testMeta.sourcePdfUrl, undefined, "Source PDF URL must not leak");
        assert.equal(testMeta.scoringConfig, undefined, "Internal scoring config must not leak");
        assert.equal(testMeta.correctAnswers, undefined, "Correct answers must not leak");
        assert.equal(testMeta.questions, undefined, "Questions must not leak in catalog");
    });

    // -------------------------------------------------------------------------
    // 2. Guest Rejection on Protected Test Endpoints (401 Unauthorized)
    // -------------------------------------------------------------------------
    test("2. Guest is rejected with 401 when attempting to retrieve test questions", async () => {
        const res = await fetch(`${baseUrl}/api/mock-tests/${PUBLISHED_TEST_ID}`);
        assert.equal(res.status, 401);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /Authentication required/i);
    });

    test("3. Guest is rejected with 401 when attempting to start an attempt", async () => {
        const res = await fetch(`${baseUrl}/api/mock-tests/${PUBLISHED_TEST_ID}/attempts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ language: "English" })
        });
        assert.equal(res.status, 401);
    });

    test("4. Guest is rejected with 401 when attempting to retrieve an attempt", async () => {
        const res = await fetch(`${baseUrl}/api/mock-tests/attempts/any-attempt-id`);
        assert.equal(res.status, 401);
    });

    test("5. Guest is rejected with 401 when attempting to autosave answers", async () => {
        const res = await fetch(`${baseUrl}/api/mock-tests/attempts/any-attempt-id`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ answers: { q1: "1" } })
        });
        assert.equal(res.status, 401);
    });

    test("6. Guest is rejected with 401 when attempting to submit an attempt", async () => {
        const res = await fetch(`${baseUrl}/api/mock-tests/attempts/any-attempt-id/submit`, {
            method: "POST"
        });
        assert.equal(res.status, 401);
    });

    test("7. Guest is rejected with 401 when attempting to view results", async () => {
        const res = await fetch(`${baseUrl}/api/mock-tests/results/any-result-id`);
        assert.equal(res.status, 401);
    });

    test("8. Guest is rejected with 401 when attempting to retrieve attempt history", async () => {
        const res = await fetch(`${baseUrl}/api/mock-tests/user/attempts`);
        assert.equal(res.status, 401);

        const res2 = await fetch(`${baseUrl}/api/mock-tests/${PUBLISHED_TEST_ID}/user-attempts`);
        assert.equal(res2.status, 401);
    });

    test("9. Guessing test ID or crafting requests without token does not bypass authentication", async () => {
        const guessedIds = ["random-test-id", "neet-2024", "../admin", "mock-neet-2024-test-published"];
        for (const testId of guessedIds) {
            const res = await fetch(`${baseUrl}/api/mock-tests/${encodeURIComponent(testId)}`);
            assert.equal(res.status, 401, `Accessing test '${testId}' must require auth`);
        }
    });

    // -------------------------------------------------------------------------
    // 3. Authenticated Student Access
    // -------------------------------------------------------------------------
    test("10. Registered student can retrieve test questions with answer keys strictly stripped", async () => {
        const token = createToken(STUDENT_A_UID);
        const res = await fetch(`${baseUrl}/api/mock-tests/${PUBLISHED_TEST_ID}`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        assert.equal(res.status, 200);

        const data = await res.json();
        assert.equal(data.success, true);
        assert.ok(data.test);
        assert.equal(data.test.testId, PUBLISHED_TEST_ID);
        assert.ok(Array.isArray(data.questions));
        assert.equal(data.questions.length, 2);

        // Verify question details are present
        const q1 = data.questions[0];
        assert.equal(q1.questionText, "What is the SI unit of electric potential?");
        assert.equal(q1.options.length, 4);

        // CRITICAL SECURITY ASSERTION: Answer keys are NEVER in payload!
        for (const q of data.questions) {
            assert.equal(q.correctAnswers, undefined, "correctAnswers must be stripped");
            assert.equal(q.correctAnswer, undefined, "correctAnswer must be stripped");
            assert.equal(q.answerKeyId, undefined, "answerKeyId must be stripped");
            assert.equal(q.acceptedAnswers, undefined, "acceptedAnswers must be stripped");
            assert.equal(q.answerKey, undefined, "answerKey must be stripped");
            for (const opt of q.options) {
                assert.equal(opt.isCorrect, undefined, "Option isCorrect must not exist");
            }
        }
    });

    test("11. Registered student can retrieve questions in requested language (Hindi translation)", async () => {
        const token = createToken(STUDENT_A_UID);
        const res = await fetch(`${baseUrl}/api/mock-tests/${PUBLISHED_TEST_ID}?language=Hindi`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        assert.equal(res.status, 200);

        const data = await res.json();
        const q1 = data.questions.find(q => q.questionNumber === 1);
        assert.equal(q1.questionText, "विद्युत विभव का SI मात्रक क्या है?");
        assert.equal(q1.language, "Hindi");
        assert.equal(q1.translationMissing, false);

        // Q2 has no Hindi translation: verified fallback to English with disclosure notice
        const q2 = data.questions.find(q => q.questionNumber === 2);
        assert.equal(q2.translationMissing, true);
        assert.equal(q2.fallbackLanguage, "English");
    });

    test("12. Complete authenticated student lifecycle: start attempt, autosave, submit, and view results", async () => {
        const token = createToken(STUDENT_A_UID);

        // A. Start Attempt
        const startRes = await fetch(`${baseUrl}/api/mock-tests/${PUBLISHED_TEST_ID}/attempts`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ language: "English" })
        });
        assert.equal(startRes.status, 201);
        const startData = await startRes.json();
        assert.equal(startData.success, true);
        const attempt = startData.attempt;
        assert.equal(attempt.userId, STUDENT_A_UID);
        assert.equal(attempt.testId, PUBLISHED_TEST_ID);
        assert.equal(attempt.status, "in_progress");
        assert.ok(attempt.deadlineAt);

        // B. Autosave answers
        const autosaveRes = await fetch(`${baseUrl}/api/mock-tests/attempts/${attempt.attemptId}`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({
                answers: {
                    [`${PUBLISHED_TEST_ID}-q1`]: "1", // Correct (+4)
                    [`${PUBLISHED_TEST_ID}-q2`]: "1"  // Incorrect: chose Oxygen instead of Hydrogen (-1)
                },
                markedForReview: [`${PUBLISHED_TEST_ID}-q2`]
            })
        });
        assert.equal(autosaveRes.status, 200);
        const autosaveData = await autosaveRes.json();
        assert.equal(autosaveData.success, true);
        assert.equal(autosaveData.savedCount, 2);
        assert.equal(autosaveData.markedCount, 1);

        // C. Submit Attempt (Server evaluates score: +4 - 1 = 3 marks)
        const submitRes = await fetch(`${baseUrl}/api/mock-tests/attempts/${attempt.attemptId}/submit`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}` }
        });
        assert.equal(submitRes.status, 200);
        const submitData = await submitRes.json();
        assert.equal(submitData.success, true);
        const result = submitData.result;
        assert.equal(result.totalScore, 3);
        assert.equal(result.correctCount, 1);
        assert.equal(result.incorrectCount, 1);
        assert.equal(result.unansweredCount, 0);
        assert.equal(result.maximumMarks, 8);
        assert.equal(result.userId, STUDENT_A_UID);

        // D. Retrieve Result
        const getResultRes = await fetch(`${baseUrl}/api/mock-tests/results/${result.resultId}`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        assert.equal(getResultRes.status, 200);
        const getResultData = await getResultRes.json();
        assert.equal(getResultData.result.totalScore, 3);

        // E. Retrieve User Attempt History
        const historyRes = await fetch(`${baseUrl}/api/mock-tests/user/attempts`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        assert.equal(historyRes.status, 200);
        const historyData = await historyRes.json();
        assert.equal(historyData.count, 1);
        assert.equal(historyData.attempts[0].attemptId, attempt.attemptId);
        assert.equal(historyData.attempts[0].status, "submitted");
    });

    // -------------------------------------------------------------------------
    // 4. Authorization & Ownership Boundaries
    // -------------------------------------------------------------------------
    test("13. Student B cannot access, autosave, submit, or view Student A's attempt or results (403)", async () => {
        const tokenA = createToken(STUDENT_A_UID);
        const tokenB = createToken(STUDENT_B_UID);

        // Create attempt for Student A
        const startRes = await fetch(`${baseUrl}/api/mock-tests/${PUBLISHED_TEST_ID}/attempts`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenA}`
            },
            body: JSON.stringify({ language: "English" })
        });
        const { attempt } = await startRes.json();

        // 1. Student B attempts to read Student A's attempt
        const readRes = await fetch(`${baseUrl}/api/mock-tests/attempts/${attempt.attemptId}`, {
            headers: { "Authorization": `Bearer ${tokenB}` }
        });
        assert.equal(readRes.status, 403, "Reading another user's attempt must return 403 Forbidden");

        // 2. Student B attempts to autosave answers to Student A's attempt
        const writeRes = await fetch(`${baseUrl}/api/mock-tests/attempts/${attempt.attemptId}`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${tokenB}`
            },
            body: JSON.stringify({ answers: { [`${PUBLISHED_TEST_ID}-q1`]: "4" } })
        });
        assert.equal(writeRes.status, 403, "Modifying another user's attempt must return 403 Forbidden");

        // 3. Student B attempts to submit Student A's attempt
        const submitRes = await fetch(`${baseUrl}/api/mock-tests/attempts/${attempt.attemptId}/submit`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${tokenB}` }
        });
        assert.equal(submitRes.status, 403, "Submitting another user's attempt must return 403 Forbidden");

        // Submit legitimately as Student A
        const validSubmitRes = await fetch(`${baseUrl}/api/mock-tests/attempts/${attempt.attemptId}/submit`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${tokenA}` }
        });
        const { result } = await validSubmitRes.json();

        // 4. Student B attempts to read Student A's result
        const resultRes = await fetch(`${baseUrl}/api/mock-tests/results/${result.resultId}`, {
            headers: { "Authorization": `Bearer ${tokenB}` }
        });
        assert.equal(resultRes.status, 403, "Reading another user's result must return 403 Forbidden");
    });

    test("14. Draft and unpublished mock tests return 404 for student accounts", async () => {
        const studentToken = createToken(STUDENT_A_UID);

        // Student tries to fetch questions for draft test
        const testRes = await fetch(`${baseUrl}/api/mock-tests/${DRAFT_TEST_ID}`, {
            headers: { "Authorization": `Bearer ${studentToken}` }
        });
        assert.equal(testRes.status, 404);

        // Student tries to start attempt on draft test
        const attemptRes = await fetch(`${baseUrl}/api/mock-tests/${DRAFT_TEST_ID}/attempts`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${studentToken}`
            },
            body: JSON.stringify({ language: "English" })
        });
        assert.equal(attemptRes.status, 400);
        const err = await attemptRes.json();
        assert.match(err.error, /not available for attempts/i);
    });

    test("15. Student account cannot access admin endpoints (HTTP 403 Forbidden)", async () => {
        const studentToken = createToken(STUDENT_A_UID);
        const res = await fetch(`${baseUrl}/api/admin/mock-tests`, {
            headers: { "Authorization": `Bearer ${studentToken}` }
        });
        assert.equal(res.status, 403, "Student must not have access to admin routes");
    });

    test("16. Expired, invalid, or malformed tokens are rejected with HTTP 401 Unauthorized", async () => {
        // Expired token (negative expiry)
        const expiredToken = createToken(STUDENT_A_UID, "user", -3600);
        const resExpired = await fetch(`${baseUrl}/api/mock-tests/${PUBLISHED_TEST_ID}`, {
            headers: { "Authorization": `Bearer ${expiredToken}` }
        });
        assert.equal(resExpired.status, 401);

        // Malformed token
        const resMalformed = await fetch(`${baseUrl}/api/mock-tests/${PUBLISHED_TEST_ID}`, {
            headers: { "Authorization": "Bearer not-a-valid-token-string" }
        });
        assert.equal(resMalformed.status, 401);
    });
});
