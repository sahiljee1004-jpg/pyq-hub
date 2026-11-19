import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import app from "../server/server.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { StorageVaultService } from "../server/services/admin/storageVaultService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { MockTestService } from "../server/services/mockTestService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { ExamPatternService } from "../server/services/admin/examPatternService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

describe("BPSC 69th Prelims Mock Test — Complete End-to-End Functional Verification Suite", () => {
    let keyPair;
    let server;
    let pipePath;

    const ADMIN_UID = "test_admin_bpsc_999";
    const STUDENT_A_UID = "test_student_bpsc_001";
    const STUDENT_B_UID = "test_student_bpsc_002";

    function getVaultFile(pattern) {
        const vaultDir = path.join(rootDir, "uploads/vault");
        if (!fs.existsSync(vaultDir)) return null;
        const files = fs.readdirSync(vaultDir);
        const matches = files.filter(f => f.includes(pattern)).sort().reverse();
        return matches.length > 0 ? path.join(vaultDir, matches[0]) : null;
    }

    const qpPath = getVaultFile("69TH_PRELIMS_M1.pdf") || path.join(rootDir, "uploads/vault/bccf870fe0e43692_1794074300304_69TH_PRELIMS_M1.pdf");
    const akPath = getVaultFile("BPSC_69th_Prelims") || path.join(rootDir, "uploads/vault/f8ced7dbe950d7fa_1794074300306_BPSC_69th_Prelims___General_Studies__Booklet_Series_A_Answer_Key.pdf");
    const epPath = getVaultFile("BPSC_Prelims") || path.join(rootDir, "uploads/vault/8ff2a8ae4f7fc037_1794074302761_BPSC_Prelims_Exam_Pattern.pdf");

    let bpscJobId = null;
    let publishedTestId = null;
    let testAttemptId = null;

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

    function apiRequest({ method = "GET", path = "/", headers = {}, body = null }) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                socketPath: pipePath,
                path,
                method,
                headers: {
                    ...(body ? { "Content-Type": "application/json" } : {}),
                    ...headers
                }
            }, (res) => {
                let data = "";
                res.on("data", chunk => data += chunk);
                res.on("end", () => {
                    let json = null;
                    try {
                        json = JSON.parse(data);
                    } catch {}
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        text: data,
                        json
                    });
                });
            });
            req.on("error", reject);
            if (body) {
                req.write(typeof body === "string" ? body : JSON.stringify(body));
            }
            req.end();
        });
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

        pipePath = `\\\\.\\pipe\\mock-bpsc-e2e-${Date.now()}`;
        await new Promise((resolve) => {
            server = app.listen(pipePath, () => {
                resolve();
            });
        });

        // Initialize Firestore users
        UniversalFirestoreService.clearLocalCache();
        await UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@vidyarthiastra.in",
            role: "admin"
        });
        await UniversalFirestoreService.setDocument("users", STUDENT_A_UID, {
            uid: STUDENT_A_UID,
            email: "studentA@test.local",
            role: "user"
        });
        await UniversalFirestoreService.setDocument("users", STUDENT_B_UID, {
            uid: STUDENT_B_UID,
            email: "studentB@test.local",
            role: "user"
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

    // =========================================================================
    // PILLAR 1: ADMIN PUBLICATION WORKFLOW
    // =========================================================================
    describe("Pillar 1: Admin Publication Workflow", () => {

        test("1.1 Attach source documents and execute pipeline for BPSC 69th Prelims", async () => {
            assert.ok(fs.existsSync(qpPath), "Question paper PDF must exist");
            assert.ok(fs.existsSync(akPath), "Answer key PDF must exist");
            assert.ok(fs.existsSync(epPath), "Exam pattern PDF must exist");

            const qpDoc = await StorageVaultService.storeDocument({
                buffer: fs.readFileSync(qpPath),
                originalFilename: "69TH_PRELIMS_M1.pdf",
                docType: "question_paper"
            });
            const akDoc = await StorageVaultService.storeDocument({
                buffer: fs.readFileSync(akPath),
                originalFilename: "BPSC_69th_Prelims_AK.pdf",
                docType: "answer_key"
            });
            const epDoc = await StorageVaultService.storeDocument({
                buffer: fs.readFileSync(epPath),
                originalFilename: "BPSC_Prelims_EP.pdf",
                docType: "exam_pattern"
            });

            const job = ImportJobPipelineService.createJob({
                examName: "BPSC",
                examId: "bpsc",
                year: 2023,
                paperCode: "M1",
                paperType: "pyq",
                language: "English"
            });
            bpscJobId = job.jobId;

            await ImportJobPipelineService.attachDocuments(job.jobId, {
                questionPaper: qpDoc,
                answerKey: akDoc,
                examPattern: epDoc
            });

            const completedJob = await ImportJobPipelineService.runPipeline(job.jobId);

            assert.equal(completedJob.status, "ready_to_publish", "Job status must transition to ready_to_publish");
            assert.equal(completedJob.extractedQuestionCount, 150, "Extracted question count must be exactly 150");
            assert.equal(completedJob.verifiedAnswerCount, 150, "Verified answer key count must be exactly 150");
            assert.equal(completedJob.flaggedQuestionCount, 0, "Flagged questions count must be 0");
            assert.equal(completedJob.validationReport.canPublish, true, "canPublish must be true");
            assert.equal(completedJob.validationReport.blockers.length, 0, "Must have zero publication blockers");
        });

        test("1.2 Admin review endpoint returns all 150 questions with options and review metadata", async () => {
            const adminToken = createToken(ADMIN_UID, "admin");
            const res = await apiRequest({
                method: "GET",
                path: `/api/admin/import/jobs/${bpscJobId}/questions`,
                headers: { "Authorization": `Bearer ${adminToken}` }
            });

            assert.equal(res.status, 200);
            assert.equal(res.json.success, true);
            assert.equal(res.json.total, 150);
            assert.equal(res.json.questions.length, 150);

            // Verify sequential question numbers 1..150
            const qNums = res.json.questions.map(q => q.questionNumber);
            const expectedNums = Array.from({ length: 150 }, (_, i) => i + 1);
            assert.deepEqual(qNums, expectedNums);

            // Verify all questions have exactly 4 options with non-empty text
            for (const q of res.json.questions) {
                assert.equal(q.options.length, 4, `Q${q.questionNumber} must have exactly 4 options`);
                for (const opt of q.options) {
                    assert.ok(opt.text && opt.text.trim().length > 0, `Q${q.questionNumber} option ${opt.label} must have text`);
                }
            }
        });

        test("1.3 Non-admin user cannot publish the import job (Authorization Gate)", async () => {
            const studentToken = createToken(STUDENT_A_UID, "user");
            const res = await apiRequest({
                method: "POST",
                path: `/api/admin/import/jobs/${bpscJobId}/publish`,
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            assert.equal(res.status, 403, "Non-admin student must be rejected with 403 Forbidden");
            assert.equal(res.json.success, false);
        });

        test("1.4 Unauthenticated request cannot publish the import job (Authentication Gate)", async () => {
            const res = await apiRequest({
                method: "POST",
                path: `/api/admin/import/jobs/${bpscJobId}/publish`
            });

            assert.equal(res.status, 401, "Unauthenticated request must be rejected with 401 Unauthorized");
            assert.equal(res.json.success, false);
        });

        test("1.5 Authenticated admin publishes the BPSC mock test through normal workflow", async () => {
            const adminToken = createToken(ADMIN_UID, "admin");
            const res = await apiRequest({
                method: "POST",
                path: `/api/admin/import/jobs/${bpscJobId}/publish`,
                headers: { "Authorization": `Bearer ${adminToken}` }
            });

            assert.equal(res.status, 200);
            assert.equal(res.json.success, true);
            assert.equal(res.json.status, "published");
            assert.ok(res.json.testId, "Must return published testId");

            publishedTestId = res.json.testId;

            // Verify job in database is now published
            const job = await ImportJobPipelineService.getJob(bpscJobId);
            assert.equal(job.status, "published");

            // Verify testDoc in database is now published
            const testDoc = await UniversalFirestoreService.getDocument("mockTests", publishedTestId);
            assert.equal(testDoc.status, "published");
            assert.equal(testDoc.publishedBy, ADMIN_UID);
        });

        test("1.6 Idempotency: repeated publish requests return existing published state safely", async () => {
            const adminToken = createToken(ADMIN_UID, "admin");
            const res = await apiRequest({
                method: "POST",
                path: `/api/admin/import/jobs/${bpscJobId}/publish`,
                headers: { "Authorization": `Bearer ${adminToken}` }
            });

            assert.equal(res.status, 200);
            assert.equal(res.json.success, true);
            assert.equal(res.json.status, "published");
            assert.equal(res.json.alreadyPublished, true);
        });
    });

    // =========================================================================
    // PILLAR 2: STUDENT-FACING TEST ACCESSIBILITY & RENDERING
    // =========================================================================
    describe("Pillar 2: Student-Facing Test Rendering & Navigation", () => {

        test("2.1 Published BPSC test appears in student mock test catalog", async () => {
            const res = await apiRequest({
                method: "GET",
                path: "/api/mock-tests"
            });

            assert.equal(res.status, 200);
            assert.equal(res.json.success, true);
            const found = res.json.tests.find(t => t.testId === publishedTestId);
            assert.ok(found, "Published test must appear in student catalog");
            assert.equal(found.totalQuestions, 150);
            assert.equal(found.durationSeconds, 7200, "120-minute timer must be 7200 seconds");
            assert.equal(found.maximumMarks, 150);
        });

        test("2.2 Unauthenticated student cannot access test details", async () => {
            const res = await apiRequest({
                method: "GET",
                path: `/api/mock-tests/${publishedTestId}`
            });

            assert.equal(res.status, 401, "Unauthenticated student access must return 401 Unauthorized");
        });

        test("2.3 Authenticated student accesses all 150 questions and verifies 4 options per question", async () => {
            const studentToken = createToken(STUDENT_A_UID, "user");
            const res = await apiRequest({
                method: "GET",
                path: `/api/mock-tests/${publishedTestId}`,
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            assert.equal(res.status, 200);
            assert.equal(res.json.success, true);
            assert.equal(res.json.test.durationSeconds, 7200, "120 minutes = 7200 seconds");
            assert.equal(res.json.test.totalQuestions, 150);
            assert.equal(res.json.test.maximumMarks, 150);

            assert.equal(res.json.questions.length, 150, "Student payload must contain all 150 questions");

            // Verify all questions have exactly 4 options
            for (const q of res.json.questions) {
                assert.equal(q.options.length, 4, `Q${q.questionNumber} must have exactly 4 options`);
                const labels = q.options.map(o => o.label);
                assert.deepEqual(labels, ["A", "B", "C", "D"], `Q${q.questionNumber} options must be labeled A, B, C, D`);
            }
        });

        test("2.4 Verify target question formats: numbered statements, matching, assertion-reason", async () => {
            const studentToken = createToken(STUDENT_A_UID, "user");
            const res = await apiRequest({
                method: "GET",
                path: `/api/mock-tests/${publishedTestId}`,
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            const questions = res.json.questions;

            // Q1: Numbered statements (5G mobile communication)
            const q1 = questions.find(q => q.questionNumber === 1);
            assert.ok(q1, "Q1 must exist");
            const q1Text = q1.questionText.replace(/\s+/g, " ");
            assert.ok(q1Text.includes("5G mobile communication"));
            assert.ok(q1Text.includes("1. Internet of Things"));
            assert.ok(q1Text.includes("2. Edge Computing"));
            assert.ok(q1Text.includes("3. Network Slicing"));
            assert.equal(q1.options.length, 4);

            // Q3: Matching question List-I and List-II (Cloth / Origin)
            const q3 = questions.find(q => q.questionNumber === 3);
            assert.ok(q3, "Q3 must exist");
            const q3Text = q3.questionText.replace(/\s+/g, " ");
            assert.ok(q3Text.includes("Match") && q3Text.includes("List"));
            assert.ok(q3Text.includes("Linen") && q3Text.includes("Flax plant"));
            assert.equal(q3.options.length, 4);

            // Q38: Numbered statements (White House)
            const q38 = questions.find(q => q.questionNumber === 38);
            assert.ok(q38, "Q38 must exist");
            const q38Text = q38.questionText.replace(/\s+/g, " ");
            assert.ok(q38Text.includes("White House"));
            assert.ok(q38Text.includes("1800 Pennsylvania Avenue"));
            assert.equal(q38.options.length, 4);

            // Q68: Historical statements (Fa-Hien and Hiuen Tsang)
            const q68 = questions.find(q => q.questionNumber === 68);
            assert.ok(q68, "Q68 must exist");
            const q68Text = q68.questionText.replace(/\s+/g, " ");
            assert.ok(q68Text.includes("Fa-Hien") && q68Text.includes("Hiuen Tsang"));
            assert.equal(q68.options.length, 4);

            // Q129: Chronological order matching (Freedom Struggle)
            const q129 = questions.find(q => q.questionNumber === 129);
            assert.ok(q129, "Q129 must exist");
            const q129Text = q129.questionText.replace(/\s+/g, " ");
            assert.ok(q129Text.includes("Freedom Struggle"));
            assert.ok(q129Text.includes("Surat Split") && q129Text.includes("Kheda Satyagraha"));
            assert.equal(q129.options.length, 4);
        });

        test("2.5 Student starts attempt: Server sets 120-minute (7200s) authoritative timer deadline", async () => {
            const studentToken = createToken(STUDENT_A_UID, "user");
            const res = await apiRequest({
                method: "POST",
                path: `/api/mock-tests/${publishedTestId}/attempts`,
                headers: { "Authorization": `Bearer ${studentToken}` },
                body: { language: "English" }
            });

            assert.equal(res.status, 201);
            assert.equal(res.json.success, true);
            const attempt = res.json.attempt;
            assert.ok(attempt.attemptId);
            assert.equal(attempt.testId, publishedTestId);
            assert.equal(attempt.userId, STUDENT_A_UID);
            assert.equal(attempt.status, "in_progress");
            assert.equal(attempt.durationSeconds, 7200);

            testAttemptId = attempt.attemptId;

            // Verify deadline calculation: deadlineAt - startedAt = 7200 seconds
            const startMs = new Date(attempt.startedAt).getTime();
            const deadlineMs = new Date(attempt.deadlineAt).getTime();
            assert.equal(Math.round((deadlineMs - startMs) / 1000), 7200);
        });

        test("2.6 Student autosaves answers, navigates questions, and marks questions for review", async () => {
            const studentToken = createToken(STUDENT_A_UID, "user");

            // Fetch questions to get real question IDs
            const testDetails = await MockTestService.getTestForStudent(publishedTestId, { callerRole: "user" });
            const q1 = testDetails.questions.find(q => q.questionNumber === 1);
            const q2 = testDetails.questions.find(q => q.questionNumber === 2);
            const q3 = testDetails.questions.find(q => q.questionNumber === 3);

            const answers = {
                [q1.questionId]: "1", // selected option A (id 1)
                [q2.questionId]: "2"  // selected option B (id 2)
            };
            const markedForReview = [q2.questionId, q3.questionId];

            const res = await apiRequest({
                method: "PUT",
                path: `/api/mock-tests/attempts/${testAttemptId}`,
                headers: { "Authorization": `Bearer ${studentToken}` },
                body: { answers, markedForReview }
            });

            assert.equal(res.status, 200);
            assert.equal(res.json.success, true);
            assert.equal(res.json.savedCount, 2);
            assert.equal(res.json.markedCount, 2);

            // Retrieve active attempt and assert persistence
            const getRes = await apiRequest({
                method: "GET",
                path: `/api/mock-tests/attempts/${testAttemptId}`,
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            assert.equal(getRes.status, 200);
            assert.equal(getRes.json.attempt.answers[q1.questionId], "1");
            assert.equal(getRes.json.attempt.answers[q2.questionId], "2");
            assert.deepEqual(getRes.json.attempt.markedForReview, [q2.questionId, q3.questionId]);
        });
    });

    // =========================================================================
    // PILLAR 3: SUBMISSION, SCORING & REVIEW EXAM MODE
    // =========================================================================
    describe("Pillar 3: Submission, Authoritative Scoring & Review Exam Mode", () => {

        test("3.1 Controlled submission: 60 correct, 30 incorrect, 60 unattempted", async () => {
            const studentToken = createToken(STUDENT_A_UID, "user");

            // Fetch test questions and answer keys from backend
            const studentTest = await MockTestService.getTestForStudent(publishedTestId, { callerRole: "user" });
            const allAKs = await UniversalFirestoreService.listDocuments("mockAnswerKeys");
            const qIdSet = new Set(studentTest.questions.map(q => q.questionId));
            const testAKs = allAKs.filter(k => qIdSet.has(k.questionId));

            const controlledAnswers = {};
            const markedForReview = [];

            // 1 to 60: Answered correctly
            for (let i = 1; i <= 60; i++) {
                const q = studentTest.questions.find(x => x.questionNumber === i);
                const ak = testAKs.find(k => k.questionId === q.questionId);
                controlledAnswers[q.questionId] = ak.correctOptionIds[0];
                if (i <= 10) markedForReview.push(q.questionId);
            }

            // 61 to 90: Answered incorrectly
            for (let i = 61; i <= 90; i++) {
                const q = studentTest.questions.find(x => x.questionNumber === i);
                const ak = testAKs.find(k => k.questionId === q.questionId);
                const correctOpt = ak.correctOptionIds[0];
                const wrongOpt = q.options.find(o => String(o.id) !== String(correctOpt)) || { id: "99" };
                controlledAnswers[q.questionId] = String(wrongOpt.id);
            }

            // 91 to 150: Unattempted (not in controlledAnswers map)

            // Autosave answers before submission
            await apiRequest({
                method: "PUT",
                path: `/api/mock-tests/attempts/${testAttemptId}`,
                headers: { "Authorization": `Bearer ${studentToken}` },
                body: { answers: controlledAnswers, markedForReview }
            });

            // Submit attempt
            const submitRes = await apiRequest({
                method: "POST",
                path: `/api/mock-tests/attempts/${testAttemptId}/submit`,
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            assert.equal(submitRes.status, 200);
            assert.equal(submitRes.json.success, true);
            const result = submitRes.json.result;

            assert.equal(result.totalQuestions, 150);
            assert.equal(result.maximumMarks, 150);
            assert.equal(result.correctCount, 60, "Must have exactly 60 correct answers");
            assert.equal(result.incorrectCount, 30, "Must have exactly 30 incorrect answers");
            assert.equal(result.unansweredCount, 60, "Must have exactly 60 unanswered questions");
            assert.equal(result.attemptedCount, 90);

            // BPSC Scoring Formula: 60 * 1 - 30 * (1/3) = 60 - 10 = 50.0 marks
            assert.ok(Math.abs(result.totalScore - 50.0) < 1e-4, `Expected totalScore 50.0, got ${result.totalScore}`);
            assert.ok(Math.abs(result.accuracyPercent - 66.67) < 0.1, `Expected accuracy 66.67%, got ${result.accuracyPercent}`);

            // Subject Analysis: General Studies
            const sub = result.subjectAnalysis.general;
            assert.ok(sub, "General Studies section analysis must exist");
            assert.equal(sub.totalQuestions, 150);
            assert.equal(sub.maximumMarks, 150);
            assert.equal(sub.correct, 60);
            assert.equal(sub.incorrect, 30);
            assert.equal(sub.unattempted, 60);
            assert.ok(Math.abs(sub.score - 50.0) < 1e-4);
        });

        test("3.2 Idempotency: repeated submissions return existing evaluated result safely", async () => {
            const studentToken = createToken(STUDENT_A_UID, "user");
            const res = await apiRequest({
                method: "POST",
                path: `/api/mock-tests/attempts/${testAttemptId}/submit`,
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            assert.equal(res.status, 200);
            assert.equal(res.json.success, true);
            assert.equal(res.json.result.alreadySubmitted, true);
            assert.ok(Math.abs(res.json.result.totalScore - 50.0) < 1e-4);
        });

        test("3.3 Review Exam Mode: Correct answer exposed ONLY for incorrect questions", async () => {
            const studentToken = createToken(STUDENT_A_UID, "user");
            const res = await apiRequest({
                method: "GET",
                path: `/api/mock-tests/attempts/${testAttemptId}/review`,
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            assert.equal(res.status, 200);
            assert.equal(res.json.success, true);
            assert.equal(res.json.questions.length, 150);

            // Q1: Correct question (1..60) -> correctAnswer MUST BE null
            const q1 = res.json.questions.find(q => q.questionNumber === 1);
            assert.equal(q1.status, "correct");
            assert.equal(q1.marksAwarded, 1);
            assert.equal(q1.correctAnswer, null, "Correct answer must NOT be exposed for correctly answered questions");

            // Q61: Incorrect question (61..90) -> correctAnswer MUST BE populated
            const q61 = res.json.questions.find(q => q.questionNumber === 61);
            assert.equal(q61.status, "incorrect");
            assert.ok(Math.abs(q61.marksAwarded - (-0.333)) < 1e-3, "Marks awarded must be -0.333 penalty");
            assert.ok(q61.correctAnswer, "Correct answer MUST be exposed for incorrectly answered questions");
            assert.equal(q61.correctAnswer.type, "mcq");
            assert.ok(q61.correctAnswer.optionId);
            assert.ok(q61.correctAnswer.optionLabel);

            // Q100: Unanswered question (91..150) -> correctAnswer MUST BE null
            const q100 = res.json.questions.find(q => q.questionNumber === 100);
            assert.equal(q100.status, "unanswered");
            assert.equal(q100.marksAwarded, 0);
            assert.equal(q100.correctAnswer, null, "Correct answer must NOT be exposed for unanswered questions");
        });
    });

    // =========================================================================
    // PILLAR 4: SECURITY & DATA INTEGRITY
    // =========================================================================
    describe("Pillar 4: Security & Data Integrity", () => {

        test("4.1 Answer keys are strictly stripped from student-facing question endpoints before submission", async () => {
            const studentToken = createToken(STUDENT_A_UID, "user");
            const res = await apiRequest({
                method: "GET",
                path: `/api/mock-tests/${publishedTestId}`,
                headers: { "Authorization": `Bearer ${studentToken}` }
            });

            const questions = res.json.questions;
            for (const q of questions) {
                assert.equal(q.correctAnswer, undefined, "correctAnswer must not exist in student question payload");
                assert.equal(q.correctOptionIds, undefined, "correctOptionIds must not exist in student question payload");
                assert.equal(q.acceptedAnswers, undefined, "acceptedAnswers must not exist in student question payload");
                assert.equal(q.correctAnswers, undefined, "correctAnswers must not exist in student question payload");
                assert.equal(q.correctOptionId, undefined, "correctOptionId must not exist in student question payload");
                for (const opt of q.options) {
                    assert.equal(opt.isCorrect, undefined, "isCorrect must not exist on options");
                }
            }
        });

        test("4.2 Tamper Resistance: Client-supplied scores are discarded; server authoritative scoring is enforced", async () => {
            // Student B starts a new attempt
            const studentBToken = createToken(STUDENT_B_UID, "user");
            const startRes = await apiRequest({
                method: "POST",
                path: `/api/mock-tests/${publishedTestId}/attempts`,
                headers: { "Authorization": `Bearer ${studentBToken}` },
                body: { language: "English" }
            });
            const attemptBId = startRes.json.attempt.attemptId;

            // Student B attempts to submit with fabricated score payload
            const fakePayload = {
                totalScore: 150,
                correctCount: 150,
                incorrectCount: 0,
                accuracyPercent: 100,
                maximumMarks: 150
            };

            const submitRes = await apiRequest({
                method: "POST",
                path: `/api/mock-tests/attempts/${attemptBId}/submit`,
                headers: { "Authorization": `Bearer ${studentBToken}` },
                body: fakePayload
            });

            assert.equal(submitRes.status, 200);
            const result = submitRes.json.result;
            // Since Student B answered 0 questions, server must evaluate totalScore = 0, NOT 150!
            assert.equal(result.totalScore, 0, "Server must discard client-supplied totalScore");
            assert.equal(result.correctCount, 0, "Server must discard client-supplied correctCount");
            assert.equal(result.unansweredCount, 150);
        });

        test("4.3 Cross-User Isolation: Student B cannot access or modify Student A's attempt", async () => {
            const studentBToken = createToken(STUDENT_B_UID, "user");

            // Student B tries to retrieve Student A's attempt
            const getRes = await apiRequest({
                method: "GET",
                path: `/api/mock-tests/attempts/${testAttemptId}`,
                headers: { "Authorization": `Bearer ${studentBToken}` }
            });
            assert.equal(getRes.status, 403, "Access to another student's attempt must be rejected with 403 Forbidden");

            // Student B tries to autosave Student A's attempt
            const putRes = await apiRequest({
                method: "PUT",
                path: `/api/mock-tests/attempts/${testAttemptId}`,
                headers: { "Authorization": `Bearer ${studentBToken}` },
                body: { answers: { "q1": "1" } }
            });
            assert.equal(putRes.status, 403, "Autosave on another student's attempt must be rejected with 403 Forbidden");

            // Student B tries to submit Student A's attempt
            const postRes = await apiRequest({
                method: "POST",
                path: `/api/mock-tests/attempts/${testAttemptId}/submit`,
                headers: { "Authorization": `Bearer ${studentBToken}` }
            });
            assert.equal(postRes.status, 403, "Submission of another student's attempt must be rejected with 403 Forbidden");
        });

        test("4.4 Cross-User Isolation: Student B cannot access Student A's result or review", async () => {
            const studentBToken = createToken(STUDENT_B_UID, "user");
            const resultAId = `result_${testAttemptId}`;

            // Student B tries to get Student A's result
            const resResult = await apiRequest({
                method: "GET",
                path: `/api/mock-tests/results/${resultAId}`,
                headers: { "Authorization": `Bearer ${studentBToken}` }
            });
            assert.equal(resResult.status, 403, "Access to another student's result must be rejected with 403 Forbidden");

            // Student B tries to get Student A's review
            const resReview = await apiRequest({
                method: "GET",
                path: `/api/mock-tests/attempts/${testAttemptId}/review`,
                headers: { "Authorization": `Bearer ${studentBToken}` }
            });
            assert.equal(resReview.status, 403, "Access to another student's review must be rejected with 403 Forbidden");
        });
    });
});
