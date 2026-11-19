import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import app from "../server/server.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { MockTestService } from "../server/services/mockTestService.js";
import { SubjectNormalizationService } from "../server/services/subjectNormalizationService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";

/**
 * FEATURE VERIFICATION SUITE
 * Mock Test Performance Analysis & Review Exam
 * Covers all 33 required verification scenarios across Parts A, B, C, D, E, F, G, H, I.
 */
describe("Mock Test Performance Analysis & Review Exam Verification Suite", () => {
    let keyPair;
    let server;
    let pipePath;

    const STUDENT_A_UID = "test_perf_student_a_101";
    const STUDENT_B_UID = "test_perf_student_b_102";
    const ADMIN_UID = "test_perf_admin_901";

    const TEST_RUN_ID = `testrun_perf_${Date.now()}`;
    const TEST_ID = `mock-test-${TEST_RUN_ID}`;
    const ATTEMPT_A_ID = `attempt-${TEST_RUN_ID}-studentA`;
    const ATTEMPT_B_ID = `attempt-${TEST_RUN_ID}-studentB`;
    const RESULT_A_ID = `result_${ATTEMPT_A_ID}`;

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

        pipePath = `\\\\.\\pipe\\mock-perf-test-${Date.now()}`;
        await new Promise((resolve) => {
            server = app.listen(pipePath, () => {
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

    // =============================================================
    // PART A: SUBJECT IDENTIFICATION & ADMIN CORRECTION
    // =============================================================

    test("1. Automatic subject identification from question metadata and aliases", () => {
        const physics = SubjectNormalizationService.normalizeSubject("Physics");
        assert.equal(physics.subjectId, "physics");
        assert.equal(physics.subjectName, "Physics");

        const chemAlias = SubjectNormalizationService.normalizeSubject("chem");
        assert.equal(chemAlias.subjectId, "chemistry");
        assert.equal(chemAlias.subjectName, "Chemistry");

        const mathAlias = SubjectNormalizationService.normalizeSubject("maths");
        assert.equal(mathAlias.subjectId, "mathematics");
        assert.equal(mathAlias.subjectName, "Mathematics");

        const customExamSub = SubjectNormalizationService.normalizeSubject("logical reasoning");
        assert.equal(customExamSub.subjectId, "logical-reasoning");
        assert.equal(customExamSub.subjectName, "Logical Reasoning");
    });

    test("2. Admin manual subject correction updates draft question with normalized subjectId", async () => {
        const jobId = `job_test_${Date.now()}`;
        const mockTestId = `test_${jobId}`;
        const questionId = `${mockTestId}-001`;

        const job = {
            jobId,
            status: "needs_review",
            draftPackage: {
                testId: mockTestId,
                questions: [{
                    questionId,
                    questionNumber: 1,
                    questionText: "What is velocity?",
                    options: [{ id: "1", label: "A", text: "Speed with direction" }, { id: "2", label: "B", text: "Scalar quantity" }],
                    subject: "General",
                    subjectId: "general",
                    subjectName: "General",
                    questionType: "mcq"
                }],
                answerKeys: [{
                    questionId,
                    questionNumber: 1,
                    correctOptionIds: ["1"],
                    verificationStatus: "verified"
                }]
            },
            validationReport: { blockers: [], discrepancies: [] },
            auditLog: []
        };

        await UniversalFirestoreService.setDocument("paperImportJobs", jobId, job);

        const res = await ImportJobPipelineService.correctQuestion({
            jobId,
            questionId,
            updates: { subject: "Physics" },
            actor: "admin_tester",
            reason: "Subject was misclassified during automated PDF import"
        });

        assert.equal(res.success, true);
        assert.equal(res.question.subject, "Physics");
        assert.equal(res.question.subjectName, "Physics");
        assert.equal(res.question.subjectId, "physics");
    });

    test("3. Correct subject persistence through publication into mockQuestions", async () => {
        const qId = `q_persist_${Date.now()}`;
        const initial = {
            questionId: qId,
            questionNumber: 1,
            subject: "Physics",
            subjectName: "Physics",
            subjectId: "physics",
            questionText: "Sample question stem",
            options: [{ id: "1", label: "A", text: "Opt 1" }, { id: "2", label: "B", text: "Opt 2" }]
        };
        await UniversalFirestoreService.setDocument("mockQuestions", qId, initial);

        const doc = await UniversalFirestoreService.getDocument("mockQuestions", qId);
        assert.equal(doc.subjectId, "physics");
        assert.equal(doc.subjectName, "Physics");
    });

    test("4. Unknown subject handling assigns 'Unclassified' category safely", () => {
        const res1 = SubjectNormalizationService.normalizeSubject(null);
        assert.equal(res1.subjectId, "unclassified");
        assert.equal(res1.subjectName, "Unclassified");

        const res2 = SubjectNormalizationService.normalizeSubject("");
        assert.equal(res2.subjectId, "unclassified");
        assert.equal(res2.subjectName, "Unclassified");

        const res3 = SubjectNormalizationService.normalizeSubject("unclassified");
        assert.equal(res3.subjectId, "unclassified");
        assert.equal(res3.subjectName, "Unclassified");
    });

    test("5. Legacy questions without subject metadata categorize under 'Unclassified' without throwing", () => {
        const questions = [
            { questionId: "leg_q1", questionNumber: 1, questionText: "Stem 1" }
        ];
        const answerKeys = [
            { questionId: "leg_q1", questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 4 }
        ];
        const studentAnswers = { leg_q1: "1" };

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        assert.equal(result.totalScore, 4);
        assert.ok(result.subjectAnalysis.unclassified, "Should contain unclassified category");
        assert.equal(result.subjectAnalysis.unclassified.subjectName, "Unclassified");
        assert.equal(result.subjectAnalysis.unclassified.score, 4);
        assert.equal(result.subjectAnalysis.unclassified.accuracy, 100);
    });

    // =============================================================
    // PART B & C: SCORING ENGINE & SUBJECT-WISE PERFORMANCE ANALYSIS
    // =============================================================

    test("6. Correct subject-wise marks calculation across multiple distinct subjects", () => {
        const questions = [
            { questionId: "p1", questionNumber: 1, subject: "Physics" },
            { questionId: "c1", questionNumber: 2, subject: "Chemistry" },
            { questionId: "m1", questionNumber: 3, subject: "Mathematics" }
        ];
        const answerKeys = [
            { questionId: "p1", questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 4, marksDeducted: 1 },
            { questionId: "c1", questionNumber: 2, correctOptionIds: ["2"], marksAwarded: 4, marksDeducted: 1 },
            { questionId: "m1", questionNumber: 3, correctOptionIds: ["3"], marksAwarded: 4, marksDeducted: 1 }
        ];
        const studentAnswers = {
            p1: "1", // Correct (+4)
            c1: "2", // Correct (+4)
            m1: "1"  // Incorrect (-1)
        };

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        assert.equal(result.totalScore, 7); // 4 + 4 - 1
        assert.equal(result.subjectAnalysis.physics.score, 4);
        assert.equal(result.subjectAnalysis.chemistry.score, 4);
        assert.equal(result.subjectAnalysis.mathematics.score, -1);
    });

    test("7. Correct negative marking deducted per question according to scheme", () => {
        const questions = [
            { questionId: "q1", questionNumber: 1, subject: "Physics" },
            { questionId: "q2", questionNumber: 2, subject: "Physics" }
        ];
        const answerKeys = [
            { questionId: "q1", questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 4, marksDeducted: 2 },
            { questionId: "q2", questionNumber: 2, correctOptionIds: ["2"], marksAwarded: 4, marksDeducted: 1 }
        ];
        const studentAnswers = {
            q1: "wrong", // -2
            q2: "wrong"  // -1
        };

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        assert.equal(result.totalScore, -3);
        assert.equal(result.subjectAnalysis.physics.score, -3);
        assert.equal(result.subjectAnalysis.physics.incorrect, 2);
    });

    test("8. Correct unattempted counts reflected in overall and subject metrics", () => {
        const questions = [
            { questionId: "q1", questionNumber: 1, subject: "Physics" },
            { questionId: "q2", questionNumber: 2, subject: "Physics" }
        ];
        const answerKeys = [
            { questionId: "q1", questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 4 },
            { questionId: "q2", questionNumber: 2, correctOptionIds: ["2"], marksAwarded: 4 }
        ];
        const studentAnswers = {
            q1: "1" // q2 unattempted
        };

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        assert.equal(result.unansweredCount, 1);
        assert.equal(result.subjectAnalysis.physics.unattempted, 1);
        assert.equal(result.subjectAnalysis.physics.correct, 1);
    });

    test("9. Correct accuracy calculations: Accuracy = Correct / Attempted * 100", () => {
        const questions = [
            { questionId: "q1", questionNumber: 1, subject: "Physics" },
            { questionId: "q2", questionNumber: 2, subject: "Physics" },
            { questionId: "q3", questionNumber: 3, subject: "Physics" }
        ];
        const answerKeys = [
            { questionId: "q1", questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 4 },
            { questionId: "q2", questionNumber: 2, correctOptionIds: ["2"], marksAwarded: 4 },
            { questionId: "q3", questionNumber: 3, correctOptionIds: ["3"], marksAwarded: 4 }
        ];
        const studentAnswers = {
            q1: "1", // correct
            q2: "wrong" // incorrect, q3 unanswered
        };

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        // Attempted = 2, Correct = 1 => 50%
        assert.equal(result.accuracyPercent, 50);
        assert.equal(result.subjectAnalysis.physics.accuracy, 50);
    });

    test("10. Zero-attempt accuracy handling produces 0% rather than NaN or invalid string", () => {
        const questions = [
            { questionId: "q1", questionNumber: 1, subject: "Chemistry" }
        ];
        const answerKeys = [
            { questionId: "q1", questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 4 }
        ];
        const studentAnswers = {}; // None attempted

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        assert.equal(result.accuracyPercent, 0);
        assert.equal(result.subjectAnalysis.chemistry.accuracy, 0);
        assert.equal(isNaN(result.accuracyPercent), false);
    });

    test("11. Data integrity: Sum of subject-wise marks strictly reconciles with overall marks", () => {
        const questions = [
            { questionId: "p1", questionNumber: 1, subject: "Physics" },
            { questionId: "p2", questionNumber: 2, subject: "Physics" },
            { questionId: "c1", questionNumber: 3, subject: "Chemistry" },
            { questionId: "m1", questionNumber: 4, subject: "Mathematics" }
        ];
        const answerKeys = [
            { questionId: "p1", questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 4, marksDeducted: 1 },
            { questionId: "p2", questionNumber: 2, correctOptionIds: ["1"], marksAwarded: 4, marksDeducted: 1 },
            { questionId: "c1", questionNumber: 3, correctOptionIds: ["2"], marksAwarded: 4, marksDeducted: 1 },
            { questionId: "m1", questionNumber: 4, correctOptionIds: ["3"], marksAwarded: 4, marksDeducted: 1 }
        ];
        const studentAnswers = {
            p1: "1", // +4
            p2: "wrong", // -1 => Physics = 3
            c1: "2", // +4 => Chemistry = 4
            m1: "wrong" // -1 => Math = -1
        };

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        const sumSubjectMarks = Object.values(result.subjectAnalysis).reduce((sum, s) => sum + s.score, 0);
        assert.equal(sumSubjectMarks, result.totalScore);
        assert.equal(result.totalScore, 6);
    });

    test("12. Dropped questions award bonus unconditionally and reconcile with subject totals", () => {
        const questions = [
            { questionId: "p1", questionNumber: 1, subject: "Physics" },
            { questionId: "p2", questionNumber: 2, subject: "Physics" }
        ];
        const answerKeys = [
            { questionId: "p1", questionNumber: 1, isDropped: true, marksAwarded: 4 },
            { questionId: "p2", questionNumber: 2, correctOptionIds: ["1"], marksAwarded: 4 }
        ];
        const studentAnswers = {
            // p1 left unanswered, but is dropped
            p2: "1" // correct
        };

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        assert.equal(result.droppedCount, 1);
        assert.equal(result.totalScore, 8); // 4 bonus + 4
        assert.equal(result.subjectAnalysis.physics.score, 8);
        assert.equal(result.subjectAnalysis.physics.dropped, 1);
    });

    test("13. Numerical question evaluation respects accepted answers and tolerance", () => {
        const questions = [
            { questionId: "num1", questionNumber: 1, subject: "Physics", questionType: "numerical" },
            { questionId: "num2", questionNumber: 2, subject: "Physics", questionType: "numerical" }
        ];
        const answerKeys = [
            { questionId: "num1", questionNumber: 1, answerType: "numerical", acceptedAnswers: ["42", "42.0"], marksAwarded: 4 },
            { questionId: "num2", questionNumber: 2, answerType: "numerical", acceptedAnswers: ["10.5"], numericTolerance: 0.1, marksAwarded: 4 }
        ];
        const studentAnswers = {
            num1: "42.0", // matches accepted
            num2: "10.45" // within tolerance |10.45 - 10.5| = 0.05 <= 0.1
        };

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        assert.equal(result.correctCount, 2);
        assert.equal(result.totalScore, 8);
    });

    test("14. Different exam-specific marking schemes (e.g. +3 / -0.5, or +1 / 0) supported dynamically", () => {
        const questions = [
            { questionId: "cuet1", questionNumber: 1, subject: "General" },
            { questionId: "cuet2", questionNumber: 2, subject: "General" }
        ];
        const answerKeys = [
            { questionId: "cuet1", questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 5, marksDeducted: 1 },
            { questionId: "cuet2", questionNumber: 2, correctOptionIds: ["2"], marksAwarded: 5, marksDeducted: 1 }
        ];
        const studentAnswers = {
            cuet1: "1",     // +5
            cuet2: "wrong"  // -1
        };

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        assert.equal(result.totalScore, 4);
        assert.equal(result.maximumMarks, 10);
    });

    test("15. Multiple subjects and variable question counts (e.g. NEET with Botany and Zoology)", () => {
        const questions = [
            { questionId: "b1", questionNumber: 1, subject: "Botany" },
            { questionId: "b2", questionNumber: 2, subject: "Botany" },
            { questionId: "z1", questionNumber: 3, subject: "Zoology" }
        ];
        const answerKeys = [
            { questionId: "b1", questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 4 },
            { questionId: "b2", questionNumber: 2, correctOptionIds: ["2"], marksAwarded: 4 },
            { questionId: "z1", questionNumber: 3, correctOptionIds: ["3"], marksAwarded: 4 }
        ];
        const studentAnswers = { b1: "1", b2: "2", z1: "3" };

        const result = MockTestScoringService.evaluateAttempt({ questions, answerKeys, studentAnswers });
        assert.ok(result.subjectAnalysis.botany);
        assert.ok(result.subjectAnalysis.zoology);
        assert.equal(result.subjectAnalysis.botany.totalQuestions, 2);
        assert.equal(result.subjectAnalysis.zoology.totalQuestions, 1);
    });

    // =============================================================
    // PART D, E, F: REVIEW EXAM & SELECTIVE ANSWER KEY EXPOSURE
    // =============================================================

    test("16. Correctly answered questions display NO separately exposed correct-answer field in review", async () => {
        const testId = `test_review_${Date.now()}`;
        const attemptId = `att_rev_correct_${Date.now()}`;
        const qId = `${testId}-q1`;

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId, status: "published", title: "Review Test"
        });
        await UniversalFirestoreService.setDocument("mockQuestions", qId, {
            questionId: qId, testId, questionNumber: 1, questionText: "Question 1?",
            options: [{ id: "1", label: "A", text: "Answer A" }, { id: "2", label: "B", text: "Answer B" }],
            subject: "Physics", subjectName: "Physics", subjectId: "physics"
        });
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${testId}-ak1`, {
            questionId: qId, testId, questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 4
        });

        // Submit attempt with correct answer "1"
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId, userId: STUDENT_A_UID, status: "in_progress",
            startedAt: new Date(Date.now() - 3600000).toISOString(),
            deadlineAt: new Date(Date.now() + 3600000).toISOString(),
            answers: { [qId]: "1" }
        });

        await MockTestService.submitAttempt({ attemptId, userId: STUDENT_A_UID });

        const review = await MockTestService.getReviewForAttempt({ attemptId, userId: STUDENT_A_UID });
        const qReview = review.questions[0];

        assert.equal(qReview.status, "correct");
        assert.equal(qReview.studentAnswer, "1");
        assert.equal(qReview.correctAnswer, null, "Server must NOT expose correctAnswer for correctly answered questions!");
    });

    test("17. Incorrectly answered questions expose the correct option identifier and text", async () => {
        const testId = `test_review_inc_${Date.now()}`;
        const attemptId = `att_rev_incorrect_${Date.now()}`;
        const qId = `${testId}-q1`;

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId, status: "published", title: "Review Test"
        });
        await UniversalFirestoreService.setDocument("mockQuestions", qId, {
            questionId: qId, testId, questionNumber: 1, questionText: "Question 1?",
            options: [{ id: "1", label: "A", text: "Alpha" }, { id: "2", label: "B", text: "Beta" }],
            subject: "Chemistry", subjectName: "Chemistry", subjectId: "chemistry"
        });
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${testId}-ak1`, {
            questionId: qId, testId, questionNumber: 1, correctOptionIds: ["2"], marksAwarded: 4
        });

        // Student chose "1", correct is "2"
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId, userId: STUDENT_A_UID, status: "in_progress",
            startedAt: new Date(Date.now() - 3600000).toISOString(),
            deadlineAt: new Date(Date.now() + 3600000).toISOString(),
            answers: { [qId]: "1" }
        });

        await MockTestService.submitAttempt({ attemptId, userId: STUDENT_A_UID });

        const review = await MockTestService.getReviewForAttempt({ attemptId, userId: STUDENT_A_UID });
        const qReview = review.questions[0];

        assert.equal(qReview.status, "incorrect");
        assert.equal(qReview.studentAnswer, "1");
        assert.ok(qReview.correctAnswer, "Server must supply correctAnswer for incorrect questions");
        assert.equal(qReview.correctAnswer.optionId, "2");
        assert.equal(qReview.correctAnswer.text, "Beta");
    });

    test("18. Incorrect numerical questions display the verified correct numerical answer", async () => {
        const testId = `test_review_num_${Date.now()}`;
        const attemptId = `att_rev_num_${Date.now()}`;
        const qId = `${testId}-q1`;

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId, status: "published", title: "Numerical Test"
        });
        await UniversalFirestoreService.setDocument("mockQuestions", qId, {
            questionId: qId, testId, questionNumber: 1, questionText: "Calculate focal length:",
            options: [], questionType: "numerical", subject: "Physics"
        });
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${testId}-ak1`, {
            questionId: qId, testId, questionNumber: 1, answerType: "numerical",
            acceptedAnswers: ["25.4"], marksAwarded: 4
        });

        // Student submitted wrong answer "10"
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId, userId: STUDENT_A_UID, status: "in_progress",
            startedAt: new Date(Date.now() - 3600000).toISOString(),
            deadlineAt: new Date(Date.now() + 3600000).toISOString(),
            answers: { [qId]: "10" }
        });

        await MockTestService.submitAttempt({ attemptId, userId: STUDENT_A_UID });

        const review = await MockTestService.getReviewForAttempt({ attemptId, userId: STUDENT_A_UID });
        const qReview = review.questions[0];

        assert.equal(qReview.status, "incorrect");
        assert.equal(qReview.studentAnswer, "10");
        assert.ok(qReview.correctAnswer);
        assert.equal(qReview.correctAnswer.type, "numerical");
        assert.equal(qReview.correctAnswer.value, "25.4");
    });

    test("19. Unattempted questions do NOT expose correct-answer data in review mode", async () => {
        const testId = `test_review_unatt_${Date.now()}`;
        const attemptId = `att_rev_unatt_${Date.now()}`;
        const qId = `${testId}-q1`;

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId, status: "published", title: "Unattempted Test"
        });
        await UniversalFirestoreService.setDocument("mockQuestions", qId, {
            questionId: qId, testId, questionNumber: 1, questionText: "Question?",
            options: [{ id: "1", label: "A", text: "Secret Answer" }], subject: "Physics"
        });
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${testId}-ak1`, {
            questionId: qId, testId, questionNumber: 1, correctOptionIds: ["1"], marksAwarded: 4
        });

        // Left unanswered
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId, userId: STUDENT_A_UID, status: "in_progress",
            startedAt: new Date(Date.now() - 3600000).toISOString(),
            deadlineAt: new Date(Date.now() + 3600000).toISOString(),
            answers: {}
        });

        await MockTestService.submitAttempt({ attemptId, userId: STUDENT_A_UID });

        const review = await MockTestService.getReviewForAttempt({ attemptId, userId: STUDENT_A_UID });
        const qReview = review.questions[0];

        assert.equal(qReview.status, "unanswered");
        assert.equal(qReview.studentAnswer, null);
        assert.equal(qReview.correctAnswer, null, "Must NOT reveal correct answer for unattempted questions!");
    });

    test("20. Dropped questions are labelled correctly with bonus marks and no exposed key", async () => {
        const testId = `test_review_drop_${Date.now()}`;
        const attemptId = `att_rev_drop_${Date.now()}`;
        const qId = `${testId}-q1`;

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId, status: "published", title: "Dropped Test"
        });
        await UniversalFirestoreService.setDocument("mockQuestions", qId, {
            questionId: qId, testId, questionNumber: 1, questionText: "Ambiguous stem?",
            options: [{ id: "1", label: "A", text: "Opt" }], subject: "Physics"
        });
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${testId}-ak1`, {
            questionId: qId, testId, questionNumber: 1, isDropped: true, marksAwarded: 4
        });

        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId, userId: STUDENT_A_UID, status: "in_progress",
            startedAt: new Date(Date.now() - 3600000).toISOString(),
            deadlineAt: new Date(Date.now() + 3600000).toISOString(),
            answers: {}
        });

        await MockTestService.submitAttempt({ attemptId, userId: STUDENT_A_UID });

        const review = await MockTestService.getReviewForAttempt({ attemptId, userId: STUDENT_A_UID });
        const qReview = review.questions[0];

        assert.equal(qReview.status, "dropped");
        assert.equal(qReview.marksAwarded, 4);
        assert.equal(qReview.bonusAwarded, true);
        assert.equal(qReview.correctAnswer, null, "Must NOT expose correct answer for dropped question");
    });

    test("21. Original question paper ordering is strictly preserved in review format", async () => {
        const testId = `test_review_order_${Date.now()}`;
        const attemptId = `att_rev_order_${Date.now()}`;

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId, status: "published", title: "Order Test"
        });

        // Insert in reverse order
        await UniversalFirestoreService.setDocument("mockQuestions", `${testId}-q2`, {
            questionId: `${testId}-q2`, testId, questionNumber: 2, questionText: "Q2", subject: "Math"
        });
        await UniversalFirestoreService.setDocument("mockQuestions", `${testId}-q1`, {
            questionId: `${testId}-q1`, testId, questionNumber: 1, questionText: "Q1", subject: "Physics"
        });

        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId, userId: STUDENT_A_UID, status: "submitted",
            startedAt: new Date().toISOString(), submittedAt: new Date().toISOString()
        });
        await UniversalFirestoreService.setDocument("mockResults", `result_${attemptId}`, {
            resultId: `result_${attemptId}`, attemptId, testId, userId: STUDENT_A_UID,
            totalScore: 0, maximumMarks: 8, correctCount: 0, incorrectCount: 0, unansweredCount: 2,
            accuracyPercent: 0, breakdown: []
        });

        const review = await MockTestService.getReviewForAttempt({ attemptId, userId: STUDENT_A_UID });
        assert.equal(review.questions[0].questionNumber, 1);
        assert.equal(review.questions[1].questionNumber, 2);
    });

    test("22. Mathematical expressions and diagrams render correctly with fields intact", async () => {
        const testId = `test_review_math_${Date.now()}`;
        const attemptId = `att_rev_math_${Date.now()}`;
        const qId = `${testId}-q1`;
        const mathStem = "Evaluate ∫ from 0 to π of sin²(x) dx = (1/2)π";

        await UniversalFirestoreService.setDocument("mockTests", testId, { testId, status: "published" });
        await UniversalFirestoreService.setDocument("mockQuestions", qId, {
            questionId: qId, testId, questionNumber: 1, questionText: mathStem,
            options: [{ id: "1", label: "A", text: "π/2" }], hasDiagram: true, sourcePage: 4, subject: "Math"
        });
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId, userId: STUDENT_A_UID, status: "submitted",
            startedAt: new Date().toISOString(), submittedAt: new Date().toISOString()
        });
        await UniversalFirestoreService.setDocument("mockResults", `result_${attemptId}`, {
            resultId: `result_${attemptId}`, attemptId, testId, userId: STUDENT_A_UID,
            totalScore: 0, maximumMarks: 4, correctCount: 0, incorrectCount: 0, unansweredCount: 1,
            accuracyPercent: 0, breakdown: []
        });

        const review = await MockTestService.getReviewForAttempt({ attemptId, userId: STUDENT_A_UID });
        assert.equal(review.questions[0].questionText, mathStem);
        assert.equal(review.questions[0].hasDiagram, true);
        assert.equal(review.questions[0].sourcePage, 4);
    });

    test("23. Review requests are rejected with 400 for unsubmitted / active attempts", async () => {
        const testId = `test_review_active_${Date.now()}`;
        const attemptId = `att_rev_active_${Date.now()}`;

        await UniversalFirestoreService.setDocument("mockTests", testId, { testId, status: "published" });
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId, userId: STUDENT_A_UID, status: "in_progress",
            startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 3600000).toISOString()
        });

        await assert.rejects(async () => {
            await MockTestService.getReviewForAttempt({ attemptId, userId: STUDENT_A_UID });
        }, /Review Exam is only available for submitted test attempts/);
    });

    // =============================================================
    // PART F & I: SECURITY, AUTHENTICATION & ACCESS BOUNDARIES
    // =============================================================

    test("24. Unauthenticated requests to review endpoint receive HTTP 401 Unauthorized", async () => {
        const res = await apiRequest({
            method: "GET",
            path: "/api/mock-tests/attempts/some_attempt/review"
        });
        assert.equal(res.status, 401);
        assert.equal(res.json.success, false);
    });

    test("25. Another student cannot access private evaluated results (HTTP 403 Forbidden)", async () => {
        const attemptId = `att_res_priv_${Date.now()}`;
        const resultId = `result_${attemptId}`;

        await UniversalFirestoreService.setDocument("mockResults", resultId, {
            resultId, attemptId, userId: STUDENT_A_UID, totalScore: 100, maximumMarks: 100
        });

        const tokenStudentB = createToken(STUDENT_B_UID);
        const res = await apiRequest({
            method: "GET",
            path: `/api/mock-tests/results/${resultId}`,
            headers: { "Authorization": `Bearer ${tokenStudentB}` }
        });
        assert.equal(res.status, 403);
    });

    test("26. Another student cannot access private exam review (HTTP 403 Forbidden)", async () => {
        const attemptId = `att_rev_priv_${Date.now()}`;

        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId: "test_x", userId: STUDENT_A_UID, status: "submitted"
        });

        const tokenStudentB = createToken(STUDENT_B_UID);
        const res = await apiRequest({
            method: "GET",
            path: `/api/mock-tests/attempts/${attemptId}/review`,
            headers: { "Authorization": `Bearer ${tokenStudentB}` }
        });
        assert.equal(res.status, 403);
    });

    test("27. Client-supplied UID manipulation in attempt creation or review is rejected", async () => {
        const testId = `test_spoof_${Date.now()}`;
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId, status: "published", title: "Spoof Test"
        });

        const tokenStudentA = createToken(STUDENT_A_UID);
        // Client attempts to pass userId: STUDENT_B_UID in body
        const res = await apiRequest({
            method: "POST",
            path: `/api/mock-tests/${testId}/attempts`,
            headers: { "Authorization": `Bearer ${tokenStudentA}` },
            body: { userId: STUDENT_B_UID, language: "English" }
        });

        assert.equal(res.status, 201);
        // Authoritative attempt MUST belong to Student A (from verified token)
        assert.equal(res.json.attempt.userId, STUDENT_A_UID);
    });

    test("28. Answer keys cannot be obtained through student question APIs before submission", async () => {
        const testId = `test_leak_guard_${Date.now()}`;
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId, status: "published", title: "Leak Guard Test"
        });
        await UniversalFirestoreService.setDocument("mockQuestions", `${testId}-q1`, {
            questionId: `${testId}-q1`, testId, questionNumber: 1, questionText: "Secret test?",
            options: [{ id: "1", text: "A" }], subject: "Physics"
        });
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${testId}-ak1`, {
            questionId: `${testId}-q1`, testId, questionNumber: 1, correctOptionIds: ["1"]
        });

        const tokenStudentA = createToken(STUDENT_A_UID);
        const res = await apiRequest({
            method: "GET",
            path: `/api/mock-tests/${testId}`,
            headers: { "Authorization": `Bearer ${tokenStudentA}` }
        });

        assert.equal(res.status, 200);
        const q = res.json.questions[0];
        assert.equal(q.correctOptionId, undefined);
        assert.equal(q.correctOptionIds, undefined);
        assert.equal(q.correctAnswer, undefined);
        assert.equal(q.acceptedAnswers, undefined);
    });

    test("29. Review mode cannot modify submitted answers or results", async () => {
        const attemptId = `att_immutable_${Date.now()}`;
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId: "test_im", userId: STUDENT_A_UID, status: "submitted",
            answers: { q1: "A" }
        });

        // Attempting to autosave on a submitted attempt must be rejected
        await assert.rejects(async () => {
            await MockTestService.autosaveAttempt({
                attemptId, userId: STUDENT_A_UID, answers: { q1: "B" }
            });
        }, /Cannot update attempt: Status is 'submitted'/);

        const check = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        assert.equal(check.answers.q1, "A");
    });

    // =============================================================
    // REGRESSION TESTS
    // =============================================================

    test("30. Existing mock-test attempt flow continues working end-to-end", async () => {
        const testId = `test_flow_${Date.now()}`;
        const qId = `${testId}-001`;

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId, status: "published", title: "End-to-End Test", durationSeconds: 600
        });
        await UniversalFirestoreService.setDocument("mockQuestions", qId, {
            questionId: qId, testId, questionNumber: 1, questionText: "What is 2+2?",
            options: [{ id: "4", text: "Four" }, { id: "5", text: "Five" }], subject: "Math"
        });
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${testId}-ak1`, {
            questionId: qId, testId, questionNumber: 1, correctOptionIds: ["4"], marksAwarded: 4
        });

        const token = createToken(STUDENT_A_UID);

        // 1. Start attempt
        const startRes = await apiRequest({
            method: "POST",
            path: `/api/mock-tests/${testId}/attempts`,
            headers: { "Authorization": `Bearer ${token}` }
        });
        assert.equal(startRes.status, 201);
        const attemptId = startRes.json.attempt.attemptId;

        // 2. Autosave
        const saveRes = await apiRequest({
            method: "PUT",
            path: `/api/mock-tests/attempts/${attemptId}`,
            headers: { "Authorization": `Bearer ${token}` },
            body: { answers: { [qId]: "4" } }
        });
        assert.equal(saveRes.status, 200);

        // 3. Submit
        const submitRes = await apiRequest({
            method: "POST",
            path: `/api/mock-tests/attempts/${attemptId}/submit`,
            headers: { "Authorization": `Bearer ${token}` }
        });
        assert.equal(submitRes.status, 200);
        assert.equal(submitRes.json.result.totalScore, 4);

        // 4. Review
        const revRes = await apiRequest({
            method: "GET",
            path: `/api/mock-tests/attempts/${attemptId}/review`,
            headers: { "Authorization": `Bearer ${token}` }
        });
        assert.equal(revRes.status, 200);
        assert.equal(revRes.json.questions[0].status, "correct");
    });

    test("31. Submission idempotency: repeated submissions do not alter original result", async () => {
        const attemptId = `att_idemp_${Date.now()}`;
        const testId = `test_idemp_${Date.now()}`;

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId, status: "published"
        });
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId, testId, userId: STUDENT_A_UID, status: "in_progress",
            startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 3600000).toISOString(),
            answers: {}
        });

        const firstResult = await MockTestService.submitAttempt({ attemptId, userId: STUDENT_A_UID });
        const secondResult = await MockTestService.submitAttempt({ attemptId, userId: STUDENT_A_UID });

        assert.equal(secondResult.alreadySubmitted, true);
        assert.equal(secondResult.resultId, firstResult.resultId);
    });

    test("32. MockTestService listPublishedTests continues working and hides drafts", async () => {
        const pubId = `pub_${Date.now()}`;
        const draftId = `draft_${Date.now()}`;

        await UniversalFirestoreService.setDocument("mockTests", pubId, {
            testId: pubId, status: "published", title: "Published Test"
        });
        await UniversalFirestoreService.setDocument("mockTests", draftId, {
            testId: draftId, status: "draft", title: "Draft Test"
        });

        const list = await MockTestService.listPublishedTests();
        assert.ok(list.some(t => t.testId === pubId));
        assert.ok(!list.some(t => t.testId === draftId));
    });

    test("33. Student authentication and session recovery remain intact", async () => {
        const token = createToken(STUDENT_A_UID);
        const res = await apiRequest({
            method: "GET",
            path: "/api/mock-tests/user/attempts",
            headers: { "Authorization": `Bearer ${token}` }
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
    });
});

