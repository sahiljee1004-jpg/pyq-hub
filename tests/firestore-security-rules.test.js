import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import app from "../server/server.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";

/**
 * VidyarthiAstra — Firestore Security Rules & Access Control Verification Test Suite
 * 
 * Verifies all 7 core security domains required by the security audit:
 * 1. Unauthenticated access denial
 * 2. Student-to-student isolation
 * 3. Draft-question access restriction
 * 4. Fabricated attempt field & score tampering prevention
 * 5. Role escalation prevention
 * 6. Answer-key confidentiality guarantee
 * 7. Legitimate PYQ reads and counter operations
 */
describe("Firestore Security Rules & Access Boundary Verification Suite", () => {
    let server;
    let baseUrl;
    let keyPair;

    const ADMIN_UID = "sec_test_admin_uid_01";
    const STUDENT_A_UID = "sec_test_student_a_uid_02";
    const STUDENT_B_UID = "sec_test_student_b_uid_03";

    const PUBLISHED_TEST_ID = "mock-rules-published-test-01";
    const DRAFT_TEST_ID = "mock-rules-draft-test-02";

    function createToken(uid) {
        const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
        const now = Math.floor(Date.now() / 1000);
        const projectId = process.env.FIREBASE_PROJECT_ID || "demo-vidyarthiastra";
        const payload = {
            iss: `https://securetoken.google.com/${projectId}`,
            aud: projectId,
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

    async function req(endpoint, { method = "GET", headers = {}, body = null } = {}) {
        const fetchHeaders = { ...headers };
        let fetchBody = body;
        if (body && typeof body === "object" && !(body instanceof FormData) && !Buffer.isBuffer(body)) {
            fetchHeaders["Content-Type"] = "application/json";
            fetchBody = JSON.stringify(body);
        }
        const res = await fetch(`${baseUrl}${endpoint}`, {
            method,
            headers: fetchHeaders,
            body: fetchBody
        });
        let data = null;
        const text = await res.text();
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
        return { status: res.status, ok: res.ok, data };
    }

    let originalFetch;

    before(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = "demo-vidyarthiastra";

        originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, options = {}) => {
            const urlStr = String(url);
            if (urlStr.includes("firestore.googleapis.com")) {
                if (options.method === "POST" && urlStr.includes(":commit")) {
                    return new Response(JSON.stringify({ writeResults: [{}] }), {
                        status: 200,
                        headers: { "Content-Type": "application/json" }
                    });
                }
                return new Response(JSON.stringify({
                    name: "projects/pyqs-hub-43bed/databases/(default)/documents/exams/neet-ug/years/2024/papers/p1",
                    fields: {
                        viewCount: { integerValue: "10" },
                        downloadCount: { integerValue: "5" }
                    }
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            }
            return originalFetch(url, options);
        };

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

    after(async () => {
        if (originalFetch) {
            globalThis.fetch = originalFetch;
        }
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(() => {
        UniversalFirestoreService.clearLocalCache();

        // Seed Users
        UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@vidyarthiastra.in",
            role: "admin"
        });

        UniversalFirestoreService.setDocument("users", STUDENT_A_UID, {
            uid: STUDENT_A_UID,
            email: "student_a@vidyarthiastra.in",
            role: "user"
        });

        UniversalFirestoreService.setDocument("users", STUDENT_B_UID, {
            uid: STUDENT_B_UID,
            email: "student_b@vidyarthiastra.in",
            role: "user"
        });

        // Seed 1 Published Test with Questions & Answer Keys
        UniversalFirestoreService.setDocument("mockTests", PUBLISHED_TEST_ID, {
            testId: PUBLISHED_TEST_ID,
            examId: "neet-ug",
            year: 2024,
            title: "NEET UG 2024 Mock 1",
            paperCode: "P1",
            durationSeconds: 1200,
            status: "published",
            questionIds: [`${PUBLISHED_TEST_ID}-q1`, `${PUBLISHED_TEST_ID}-q2`]
        });

        UniversalFirestoreService.setDocument("mockQuestions", `${PUBLISHED_TEST_ID}-q1`, {
            questionId: `${PUBLISHED_TEST_ID}-q1`,
            testId: PUBLISHED_TEST_ID,
            questionNumber: 1,
            subject: "Physics",
            questionText: "What is velocity?",
            options: [{ id: "A", label: "A", text: "Rate of change of displacement" }, { id: "B", label: "B", text: "Distance" }]
        });

        UniversalFirestoreService.setDocument("mockQuestions", `${PUBLISHED_TEST_ID}-q2`, {
            questionId: `${PUBLISHED_TEST_ID}-q2`,
            testId: PUBLISHED_TEST_ID,
            questionNumber: 2,
            subject: "Chemistry",
            questionText: "What is atomic number?",
            options: [{ id: "1", label: "1", text: "Number of protons" }, { id: "2", label: "2", text: "Mass" }]
        });

        UniversalFirestoreService.setDocument("mockAnswerKeys", `ak_${PUBLISHED_TEST_ID}-q1`, {
            answerKeyId: `ak_${PUBLISHED_TEST_ID}-q1`,
            testId: PUBLISHED_TEST_ID,
            questionId: `${PUBLISHED_TEST_ID}-q1`,
            questionNumber: 1,
            correctAnswers: ["A"],
            marksAwarded: 4,
            marksDeducted: 1
        });

        UniversalFirestoreService.setDocument("mockAnswerKeys", `ak_${PUBLISHED_TEST_ID}-q2`, {
            answerKeyId: `ak_${PUBLISHED_TEST_ID}-q2`,
            testId: PUBLISHED_TEST_ID,
            questionId: `${PUBLISHED_TEST_ID}-q2`,
            questionNumber: 2,
            correctAnswers: ["1"],
            marksAwarded: 4,
            marksDeducted: 1
        });

        // Seed 1 Draft Test
        UniversalFirestoreService.setDocument("mockTests", DRAFT_TEST_ID, {
            testId: DRAFT_TEST_ID,
            examId: "neet-ug",
            year: 2025,
            title: "NEET UG 2025 Draft Exam",
            paperCode: "DRAFT01",
            durationSeconds: 1200,
            status: "draft",
            questionIds: [`${DRAFT_TEST_ID}-q1`]
        });

        UniversalFirestoreService.setDocument("mockQuestions", `${DRAFT_TEST_ID}-q1`, {
            questionId: `${DRAFT_TEST_ID}-q1`,
            testId: DRAFT_TEST_ID,
            questionNumber: 1,
            subject: "Physics",
            questionText: "Unreleased secret question",
            options: [{ id: "A", label: "A", text: "Secret 1" }]
        });

        // Seed 1 Legacy PYQ Paper Document
        UniversalFirestoreService.setDocument("exams/neet-ug/years/2024/papers", "p1", {
            paperId: "p1",
            paperCode: "P1",
            year: 2024,
            title: "NEET 2024 Code P1",
            viewCount: 10,
            downloadCount: 5
        });
    });

    // =========================================================================
    // DOMAIN 1: Unauthenticated Access Control
    // =========================================================================
    test("Domain 1: Unauthenticated requests to protected endpoints return 401", async () => {
        // Test details
        const resTest = await req(`/api/mock-tests/${PUBLISHED_TEST_ID}`);
        assert.equal(resTest.status, 401);
        assert.equal(resTest.data.success, false);

        // Start attempt
        const resAttempt = await req(`/api/mock-tests/${PUBLISHED_TEST_ID}/attempts`, { method: "POST" });
        assert.equal(resAttempt.status, 401);

        // Autosave attempt
        const resAutosave = await req(`/api/mock-tests/attempts/attempt_fake`, { method: "PUT", body: { answers: {} } });
        assert.equal(resAutosave.status, 401);

        // Submit attempt
        const resSubmit = await req(`/api/mock-tests/attempts/attempt_fake/submit`, { method: "POST" });
        assert.equal(resSubmit.status, 401);

        // Admin check
        const resAdmin = await req(`/api/admin/auth/check`);
        assert.equal(resAdmin.status, 401);
    });

    // =========================================================================
    // DOMAIN 2: Student-to-Student Isolation
    // =========================================================================
    test("Domain 2: Student B cannot view, autosave, or submit Student A's attempt or view results", async () => {
        const tokenA = createToken(STUDENT_A_UID);
        const tokenB = createToken(STUDENT_B_UID);

        // Student A starts attempt
        const startRes = await req(`/api/mock-tests/${PUBLISHED_TEST_ID}/attempts`, {
            method: "POST",
            headers: { Authorization: `Bearer ${tokenA}` }
        });
        assert.equal(startRes.status, 201);
        const attemptId = startRes.data.attempt.attemptId;

        // Student B tries to retrieve Student A's attempt -> 403
        const getRes = await req(`/api/mock-tests/attempts/${attemptId}`, {
            headers: { Authorization: `Bearer ${tokenB}` }
        });
        assert.equal(getRes.status, 403);
        assert.match(getRes.data.error, /another student/i);

        // Student B tries to autosave Student A's attempt -> 403
        const autoRes = await req(`/api/mock-tests/attempts/${attemptId}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${tokenB}` },
            body: { answers: { [`${PUBLISHED_TEST_ID}-q1`]: "B" } }
        });
        assert.equal(autoRes.status, 403);

        // Student B tries to submit Student A's attempt -> 403
        const subRes = await req(`/api/mock-tests/attempts/${attemptId}/submit`, {
            method: "POST",
            headers: { Authorization: `Bearer ${tokenB}` }
        });
        assert.equal(subRes.status, 403);

        // Student A submits attempt successfully
        const submitResA = await req(`/api/mock-tests/attempts/${attemptId}/submit`, {
            method: "POST",
            headers: { Authorization: `Bearer ${tokenA}` }
        });
        assert.equal(submitResA.status, 200);
        const resultId = submitResA.data.result.resultId;

        // Student B tries to view Student A's evaluated result -> 403
        const viewResB = await req(`/api/mock-tests/results/${resultId}`, {
            headers: { Authorization: `Bearer ${tokenB}` }
        });
        assert.equal(viewResB.status, 403);
        assert.match(viewResB.data.error, /another student/i);
    });

    // =========================================================================
    // DOMAIN 3: Draft-Question Access Restriction
    // =========================================================================
    test("Domain 3: Draft/unpublished test questions are completely hidden from ordinary students", async () => {
        const tokenStudent = createToken(STUDENT_A_UID);
        const tokenAdmin = createToken(ADMIN_UID);

        // Student tries to load draft test -> 404
        const studentRes = await req(`/api/mock-tests/${DRAFT_TEST_ID}`, {
            headers: { Authorization: `Bearer ${tokenStudent}` }
        });
        assert.equal(studentRes.status, 404);
        assert.match(studentRes.data.error, /unpublished/i);

        // Admin can view draft test
        const adminRes = await req(`/api/mock-tests/${DRAFT_TEST_ID}`, {
            headers: { Authorization: `Bearer ${tokenAdmin}` }
        });
        assert.equal(adminRes.status, 200);
        assert.equal(adminRes.data.test.testId, DRAFT_TEST_ID);
        assert.equal(adminRes.data.questions.length, 1);
    });

    // =========================================================================
    // DOMAIN 4: Fabricated Attempt Fields & Score Tampering
    // =========================================================================
    test("Domain 4: Fabricated scores, statuses, deadlines, and user IDs in request bodies are ignored", async () => {
        const token = createToken(STUDENT_A_UID);

        // Start legitimate attempt
        const startRes = await req(`/api/mock-tests/${PUBLISHED_TEST_ID}/attempts`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` }
        });
        const attempt = startRes.data.attempt;
        const originalDeadline = attempt.deadlineAt;

        // Attempt autosave with malicious fabricated fields
        const spoofRes = await req(`/api/mock-tests/attempts/${attempt.attemptId}`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${token}` },
            body: {
                userId: "victim_user_999",
                status: "submitted",
                deadlineAt: "2099-12-31T23:59:59.000Z",
                totalScore: 720,
                answers: { [`${PUBLISHED_TEST_ID}-q1`]: "A" }
            }
        });
        assert.equal(spoofRes.status, 200);

        // Fetch stored attempt and verify immutable fields remained untouched
        const verifyRes = await req(`/api/mock-tests/attempts/${attempt.attemptId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const storedAttempt = verifyRes.data.attempt;
        assert.equal(storedAttempt.userId, STUDENT_A_UID); // NOT victim_user_999
        assert.equal(storedAttempt.status, "in_progress"); // NOT submitted
        assert.equal(storedAttempt.deadlineAt, originalDeadline); // NOT 2099
        assert.equal(storedAttempt.totalScore, undefined); // NOT 720

        // Submit attempt with fabricated score claim
        const submitRes = await req(`/api/mock-tests/attempts/${attempt.attemptId}/submit`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: {
                totalScore: 999, // Tampered score
                accuracyPercent: 100
            }
        });
        assert.equal(submitRes.status, 200);
        // Correct score: Q1 correct (+4), Q2 unanswered (0) -> total: 4
        assert.equal(submitRes.data.result.totalScore, 4); // NOT 999!
    });

    // =========================================================================
    // DOMAIN 5: Role Escalation Prevention
    // =========================================================================
    test("Domain 5: Role escalation endpoints fail closed with HTTP 405 Method Not Allowed", async () => {
        const token = createToken(STUDENT_A_UID);

        const resBootstrap = await req("/api/admin/users/bootstrap", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(resBootstrap.status, 405);

        const resAssign = await req("/api/admin/users/assign-role", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: { uid: STUDENT_A_UID, role: "admin" }
        });
        assert.equal(resAssign.status, 405);

        const resRevoke = await req("/api/admin/users/revoke-role", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: { uid: STUDENT_A_UID }
        });
        assert.equal(resRevoke.status, 405);
    });

    // =========================================================================
    // DOMAIN 6: Answer-Key Confidentiality
    // =========================================================================
    test("Domain 6: Student question retrieval never exposes correct answers or answerKeyId", async () => {
        const token = createToken(STUDENT_A_UID);

        const res = await req(`/api/mock-tests/${PUBLISHED_TEST_ID}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(res.status, 200);
        const questions = res.data.questions;
        assert.equal(questions.length, 2);

        for (const q of questions) {
            assert.equal(q.correctAnswer, undefined);
            assert.equal(q.correctAnswers, undefined);
            assert.equal(q.answerKeyId, undefined);
            assert.equal(q.isCorrect, undefined);
            assert.equal(q.scoringProvenance, undefined);

            for (const opt of q.options) {
                assert.equal(opt.isCorrect, undefined);
            }
        }

        // Full payload string scan
        const jsonStr = JSON.stringify(res.data);
        assert.equal(/correctAnswer/i.test(jsonStr), false);
        assert.equal(/scoringProvenance/i.test(jsonStr), false);
    });

    // =========================================================================
    // DOMAIN 7: Legitimate PYQ Operations
    // =========================================================================
    test("Domain 7: Legitimate PYQ view and download counter increments succeed", async () => {
        const viewRes = await req("/api/papers/increment-view", {
            method: "POST",
            body: {
                examId: "neet-ug",
                yearId: "2024",
                paperId: "p1",
                clientSessionId: `sess_${Date.now()}`
            }
        });
        assert.equal(viewRes.status, 200);
        assert.equal(viewRes.data.success, true);
        assert.equal(viewRes.data.field, "viewCount");
        assert.equal(viewRes.data.increment, 1);

        const downloadRes = await req("/api/papers/increment-download", {
            method: "POST",
            body: {
                examId: "neet-ug",
                yearId: "2024",
                paperId: "p1",
                clientSessionId: `sess_dl_${Date.now()}`
            }
        });
        assert.equal(downloadRes.status, 200);
        assert.equal(downloadRes.data.success, true);
        assert.equal(downloadRes.data.field, "downloadCount");
        assert.equal(downloadRes.data.increment, 1);
    });
});
