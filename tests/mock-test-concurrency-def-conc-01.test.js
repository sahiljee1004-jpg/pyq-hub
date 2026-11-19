import test, { describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { MockTestService } from "../server/services/mockTestService.js";

/**
 * DEF-CONC-01 Verification Suite: Firestore Concurrency & State Transitions
 *
 * Covers all 10 required concurrency scenarios:
 *  1. Autosave completes before submission.
 *  2. Submission completes before delayed autosave.
 *  3. Autosave and submission execute concurrently.
 *  4. Two concurrent submissions with different answers.
 *  5. Two identical submissions.
 *  6. Two concurrent autosaves with different answers.
 *  7. Attempt already submitted.
 *  8. Attempt already completed.
 *  9. Stale update-time precondition.
 * 10. Batch failure leaves neither partial attempt update nor partial result creation.
 */
describe("DEF-CONC-01: Firestore Concurrency & State Transition Suite", () => {
    const TEST_ID = "test-conc-exam-01";
    const USER_ID = "student_conc_101";

    beforeEach(async () => {
        process.env.NODE_ENV = "test";
        UniversalFirestoreService.clearLocalCache();

        // Seed test configuration
        await UniversalFirestoreService.setDocument("mockTests", TEST_ID, {
            testId: TEST_ID,
            examId: "jee-main",
            year: 2024,
            profileId: "jee-main-2024",
            schemaVersion: 2,
            title: "Concurrency Test Exam",
            durationSeconds: 3600,
            maximumMarks: 8,
            questionIds: ["q1", "q2"]
        });

        // Seed questions
        await UniversalFirestoreService.setDocument("mockQuestions", "q1", {
            questionId: "q1",
            testId: TEST_ID,
            questionNumber: 1,
            questionText: "What is 2 + 2?",
            questionType: "mcq",
            options: [
                { id: "opt1", text: "4" },
                { id: "opt2", text: "5" }
            ]
        });

        await UniversalFirestoreService.setDocument("mockQuestions", "q2", {
            questionId: "q2",
            testId: TEST_ID,
            questionNumber: 2,
            questionText: "What is 3 + 3?",
            questionType: "mcq",
            options: [
                { id: "opt1", text: "5" },
                { id: "opt2", text: "6" }
            ]
        });

        // Seed answer keys (+4 correct, -1 incorrect)
        await UniversalFirestoreService.setDocument("mockAnswerKeys", "ak1", {
            answerKeyId: "ak1",
            testId: TEST_ID,
            questionId: "q1",
            correctOptionId: "opt1",
            correctAnswers: ["opt1"],
            positiveMarks: 4,
            negativeMarks: -1
        });

        await UniversalFirestoreService.setDocument("mockAnswerKeys", "ak2", {
            answerKeyId: "ak2",
            testId: TEST_ID,
            questionId: "q2",
            correctOptionId: "opt2",
            correctAnswers: ["opt2"],
            positiveMarks: 4,
            negativeMarks: -1
        });
    });

    async function createInProgressAttempt(attemptId) {
        const now = Date.now();
        const startedAt = new Date(now).toISOString();
        const deadlineAt = new Date(now + 3600 * 1000).toISOString();
        const attempt = {
            attemptId,
            testId: TEST_ID,
            userId: USER_ID,
            status: "in_progress",
            startedAt,
            deadlineAt,
            durationSeconds: 3600,
            answers: {},
            markedForReview: [],
            createdAt: startedAt,
            updatedAt: startedAt
        };
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, attempt, { createOnly: true });
        return await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
    }

    // -------------------------------------------------------------
    // Scenario 1: Autosave completes before submission
    // -------------------------------------------------------------
    test("1. Autosave completes before submission", async () => {
        const attemptId = "attempt_sc1";
        await createInProgressAttempt(attemptId);

        // 1. Autosave answers
        const saveRes = await MockTestService.autosaveAttempt({
            attemptId,
            userId: USER_ID,
            answers: { q1: "opt1" }
        });
        assert.equal(saveRes.success, true);
        assert.equal(saveRes.savedCount, 1);

        // 2. Submit attempt
        const submitRes = await MockTestService.submitAttempt({
            attemptId,
            userId: USER_ID
        });

        assert.equal(submitRes.totalScore, 4); // q1 correct (+4), q2 unattempted (0)
        assert.equal(submitRes.correctCount, 1);

        const freshAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        assert.equal(freshAttempt.status, "submitted");
        assert.equal(freshAttempt.answers.q1, "opt1");
    });

    // -------------------------------------------------------------
    // Scenario 2: Submission completes before delayed autosave
    // -------------------------------------------------------------
    test("2. Submission completes before delayed autosave", async () => {
        const attemptId = "attempt_sc2";
        const initialAttempt = await createInProgressAttempt(attemptId);
        const staleUpdateTime = initialAttempt._updateTime;

        // 1. Submit attempt first
        const submitRes = await MockTestService.submitAttempt({
            attemptId,
            userId: USER_ID
        });
        assert.ok(submitRes.resultId);

        const submittedAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        assert.equal(submittedAttempt.status, "submitted");

        // 2. Delayed autosave arrives afterwards with stale expectation or after submission
        await assert.rejects(
            async () => {
                await MockTestService.autosaveAttempt({
                    attemptId,
                    userId: USER_ID,
                    answers: { q1: "opt2" },
                    expectedUpdateTime: staleUpdateTime
                });
            },
            (err) => {
                assert.ok(err.statusCode === 400 || err.statusCode === 409);
                assert.ok(err.message.includes("submitted") || err.message.includes("Stale autosave"));
                return true;
            }
        );

        // Verify status and answers remain untampered
        const verifyAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        assert.equal(verifyAttempt.status, "submitted");
        assert.notEqual(verifyAttempt.answers?.q1, "opt2");
    });

    // -------------------------------------------------------------
    // Scenario 3: Autosave and submission execute concurrently
    // -------------------------------------------------------------
    test("3. Autosave and submission execute concurrently", async () => {
        const attemptId = "attempt_sc3";
        await createInProgressAttempt(attemptId);

        // Launch autosave and submission concurrently
        const [saveResult, submitResult] = await Promise.allSettled([
            MockTestService.autosaveAttempt({
                attemptId,
                userId: USER_ID,
                answers: { q1: "opt1", q2: "opt2" }
            }),
            MockTestService.submitAttempt({
                attemptId,
                userId: USER_ID
            })
        ]);

        // State must remain strictly consistent and collision-free
        if (submitResult.status === "fulfilled") {
            // Submit won the race: status is submitted, autosave was rejected with 409
            const finalAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
            assert.equal(finalAttempt.status, "submitted");
            if (saveResult.status === "rejected") {
                assert.equal(saveResult.reason.statusCode, 409);
            }
        } else {
            // Autosave won the race: submit was rejected with 409 CONCURRENT_MODIFICATION
            assert.equal(submitResult.reason.statusCode, 409);
            assert.equal(saveResult.status, "fulfilled");
            const midAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
            assert.equal(midAttempt.status, "in_progress");
            assert.equal(midAttempt.answers.q1, "opt1");
            assert.equal(midAttempt.answers.q2, "opt2");

            // Subsequent submission retry successfully processes the autosaved answers
            const retryRes = await MockTestService.submitAttempt({
                attemptId,
                userId: USER_ID
            });
            assert.equal(retryRes.totalScore, 8);
            const finalAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
            assert.equal(finalAttempt.status, "submitted");
        }
    });

    // -------------------------------------------------------------
    // Scenario 4: Two concurrent submissions with different answers
    // -------------------------------------------------------------
    test("4. Two concurrent submissions with different answers", async () => {
        const attemptId = "attempt_sc4";
        await createInProgressAttempt(attemptId);

        // Submission A has answers { q1: "opt1" } (+4)
        // Submission B has answers { q1: "opt2" } (-1)
        const [resA, resB] = await Promise.allSettled([
            MockTestService.submitAttempt({
                attemptId,
                userId: USER_ID,
                answers: { q1: "opt1" }
            }),
            MockTestService.submitAttempt({
                attemptId,
                userId: USER_ID,
                answers: { q1: "opt2" }
            })
        ]);

        // Exactly one must succeed, and the conflicting payload must be rejected with 409
        const fulfilled = [resA, resB].filter(r => r.status === "fulfilled");
        const rejected = [resA, resB].filter(r => r.status === "rejected");

        assert.equal(fulfilled.length, 1, "Exactly one submission must succeed");
        assert.equal(rejected.length, 1, "Conflicting submission must be rejected");
        assert.equal(rejected[0].reason.statusCode, 409);
        assert.ok(
            rejected[0].reason.message.includes("different answers") ||
            rejected[0].reason.message.includes("concurrently")
        );
    });

    // -------------------------------------------------------------
    // Scenario 5: Two identical submissions
    // -------------------------------------------------------------
    test("5. Two identical submissions", async () => {
        const attemptId = "attempt_sc5";
        await createInProgressAttempt(attemptId);

        const identicalAnswers = { q1: "opt1" };
        const [res1, res2] = await Promise.allSettled([
            MockTestService.submitAttempt({
                attemptId,
                userId: USER_ID,
                answers: identicalAnswers
            }),
            MockTestService.submitAttempt({
                attemptId,
                userId: USER_ID,
                answers: identicalAnswers
            })
        ]);

        assert.equal(res1.status, "fulfilled");
        assert.equal(res2.status, "fulfilled");

        // Both return valid results with same total score and resultId
        assert.equal(res1.value.resultId, `result_${attemptId}`);
        assert.equal(res2.value.resultId, `result_${attemptId}`);
        assert.equal(res1.value.totalScore, res2.value.totalScore);
        assert.ok(res1.value.alreadySubmitted || res2.value.alreadySubmitted);
    });

    // -------------------------------------------------------------
    // Scenario 6: Two concurrent autosaves with different answers
    // -------------------------------------------------------------
    test("6. Two concurrent autosaves with different answers", async () => {
        const attemptId = "attempt_sc6";
        const initialAttempt = await createInProgressAttempt(attemptId);
        const baseUpdateTime = initialAttempt._updateTime;

        // Both autosaves pretend to have started from baseUpdateTime
        const [save1, save2] = await Promise.allSettled([
            MockTestService.autosaveAttempt({
                attemptId,
                userId: USER_ID,
                answers: { q1: "opt1" },
                expectedUpdateTime: baseUpdateTime
            }),
            MockTestService.autosaveAttempt({
                attemptId,
                userId: USER_ID,
                answers: { q1: "opt2" },
                expectedUpdateTime: baseUpdateTime
            })
        ]);

        // One succeeds, the other is rejected due to concurrent modification / precondition failure
        const fulfilled = [save1, save2].filter(r => r.status === "fulfilled");
        const rejected = [save1, save2].filter(r => r.status === "rejected");

        assert.equal(fulfilled.length, 1, "Only one concurrent autosave can succeed");
        assert.equal(rejected.length, 1, "Second concurrent autosave must fail precondition");
        assert.equal(rejected[0].reason.statusCode, 409);
    });

    // -------------------------------------------------------------
    // Scenario 7: Attempt already submitted
    // -------------------------------------------------------------
    test("7. Attempt already submitted", async () => {
        const attemptId = "attempt_sc7";
        await createInProgressAttempt(attemptId);

        // Submit the attempt
        await MockTestService.submitAttempt({ attemptId, userId: USER_ID, answers: { q1: "opt1" } });

        // Autosave must be rejected
        await assert.rejects(
            async () => {
                await MockTestService.autosaveAttempt({
                    attemptId,
                    userId: USER_ID,
                    answers: { q1: "opt2" }
                });
            },
            (err) => {
                assert.ok(err.statusCode === 400 || err.statusCode === 409);
                assert.equal(err.code, "ATTEMPT_ALREADY_SUBMITTED");
                return true;
            }
        );

        // Submitting different answers must also be rejected with 409
        await assert.rejects(
            async () => {
                await MockTestService.submitAttempt({
                    attemptId,
                    userId: USER_ID,
                    answers: { q1: "opt2" }
                });
            },
            (err) => {
                assert.equal(err.statusCode, 409);
                assert.equal(err.code, "SUBMISSION_PAYLOAD_CONFLICT");
                return true;
            }
        );
    });

    // -------------------------------------------------------------
    // Scenario 8: Attempt already completed
    // -------------------------------------------------------------
    test("8. Attempt already completed", async () => {
        const attemptId = "attempt_sc8";
        const attempt = await createInProgressAttempt(attemptId);

        // Mark status as completed
        attempt.status = "completed";
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, attempt, {
            precondition: { updateTime: attempt._updateTime }
        });

        // Autosave rejected
        await assert.rejects(
            async () => {
                await MockTestService.autosaveAttempt({
                    attemptId,
                    userId: USER_ID,
                    answers: { q1: "opt1" }
                });
            },
            (err) => {
                assert.ok(err.statusCode === 400 || err.statusCode === 409);
                assert.equal(err.code, "ATTEMPT_ALREADY_SUBMITTED");
                return true;
            }
        );

        // Submit rejected
        await assert.rejects(
            async () => {
                await MockTestService.submitAttempt({
                    attemptId,
                    userId: USER_ID
                });
            },
            (err) => {
                assert.equal(err.statusCode, 409);
                return true;
            }
        );
    });

    // -------------------------------------------------------------
    // Scenario 9: Stale update-time precondition
    // -------------------------------------------------------------
    test("9. Stale update-time precondition", async () => {
        const attemptId = "attempt_sc9";
        const attempt = await createInProgressAttempt(attemptId);

        // Advance the update time by saving an update
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            ...attempt,
            answers: { q1: "opt1" }
        }, {
            precondition: { updateTime: attempt._updateTime }
        });

        // Attempt write with original stale updateTime
        await assert.rejects(
            async () => {
                await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
                    ...attempt,
                    answers: { q1: "stale" }
                }, {
                    precondition: { updateTime: attempt._updateTime }
                });
            },
            (err) => {
                assert.equal(err.statusCode, 412);
                assert.equal(err.code, "FAILED_PRECONDITION");
                return true;
            }
        );

        // Ensure database state still has opt1, not stale
        const current = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        assert.equal(current.answers.q1, "opt1");
    });

    // -------------------------------------------------------------
    // Scenario 10: Batch failure leaves neither partial attempt update nor partial result creation
    // -------------------------------------------------------------
    test("10. Batch failure leaves neither partial attempt update nor partial result creation", async () => {
        const attemptId = "attempt_sc10";
        const attempt = await createInProgressAttempt(attemptId);
        const resultId = `result_${attemptId}`;

        // Pre-create the result record so writeResult with exists: false will FAIL
        await UniversalFirestoreService.setDocument("mockResults", resultId, {
            resultId,
            totalScore: 0,
            dummy: true
        });

        const attemptDocPath = UniversalFirestoreService.getDocumentPath("mockAttempts", attemptId);
        const resultDocPath = UniversalFirestoreService.getDocumentPath("mockResults", resultId);

        const writeAttempt = {
            update: {
                name: attemptDocPath,
                fields: UniversalFirestoreService.toFirestoreFields({
                    ...attempt,
                    status: "submitted",
                    tampered: true
                })
            },
            currentDocument: { updateTime: attempt._updateTime }
        };

        const writeResult = {
            update: {
                name: resultDocPath,
                fields: UniversalFirestoreService.toFirestoreFields({
                    resultId,
                    totalScore: 100
                })
            },
            currentDocument: { exists: false } // WILL FAIL because result already exists!
        };

        await assert.rejects(
            async () => {
                await UniversalFirestoreService.commitBatchWrites([writeAttempt, writeResult]);
            },
            (err) => {
                assert.equal(err.code, "ALREADY_EXISTS");
                return true;
            }
        );

        // Verify ATOMICTY: attempt is STILL in_progress, NOT modified
        const freshAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        assert.equal(freshAttempt.status, "in_progress");
        assert.equal(freshAttempt.tampered, undefined);

        // Verify result is STILL original dummy record
        const freshResult = await UniversalFirestoreService.getDocument("mockResults", resultId);
        assert.equal(freshResult.dummy, true);
        assert.equal(freshResult.totalScore, 0);
    });
});
