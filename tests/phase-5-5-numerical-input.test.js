import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { MockTestService } from "../server/services/mockTestService.js";
import { MockTestScoringService } from "../server/services/mockTestScoringService.js";
import { UniversalScoringEngine } from "../server/services/scoring/universalScoringEngine.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ExamProfileRegistry } from "../server/services/admin/examProfileRegistry.js";

describe("Phase 5.5 — Numerical Answer Input Support & Validation Suite", () => {
    process.env.NODE_ENV = "test";
    delete process.env.FIRESTORE_EMULATOR_HOST;
    process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";
    UniversalFirestoreService.clearLocalCache();

    const testId = "test_phase_5_5_nat_verification";
    const natQId1 = "q_nat_32";
    const natQId2 = "q_nat_33";
    const mcqQId = "q_mcq_1";
    const studentUid = "student_gate_nat_test";
    const attemptId = "attempt_gate_nat_test_001";

    const questions = [
        {
            questionId: mcqQId,
            testId,
            questionNumber: 1,
            questionType: "mcq",
            sectionId: "ga_section",
            subjectName: "General Aptitude",
            questionText: "Which word best completes the sentence?",
            options: [
                { id: "A", label: "A", text: "Alpha" },
                { id: "B", label: "B", text: "Beta" },
                { id: "C", label: "C", text: "Gamma" },
                { id: "D", label: "D", text: "Delta" }
            ],
            marking: { positiveMarks: 1, negativeMarks: 1 / 3 }
        },
        {
            questionId: natQId1,
            testId,
            questionNumber: 32,
            questionType: "numerical_nat",
            sectionId: "core_section",
            subjectName: "Computer Science & IT",
            questionText: "Consider a pipelined processor. Calculate the total clock cycles.",
            options: [],
            marking: { positiveMarks: 1, negativeMarks: 0 }
        },
        {
            questionId: natQId2,
            testId,
            questionNumber: 33,
            questionType: "numerical",
            sectionId: "core_section",
            subjectName: "Computer Science & IT",
            questionText: "Calculate the value of X (rounded off to 2 decimal places).",
            options: [],
            marking: { positiveMarks: 2, negativeMarks: 0 }
        }
    ];

    const answerKeys = [
        {
            questionId: mcqQId,
            testId,
            questionNumber: 1,
            questionType: "mcq",
            sectionId: "ga_section",
            correctOptionId: "B",
            acceptedAnswers: ["B"],
            marksAwarded: 1,
            marksDeducted: 1 / 3
        },
        {
            questionId: natQId1,
            testId,
            questionNumber: 32,
            questionType: "numerical_nat",
            sectionId: "core_section",
            answerType: "numerical_value",
            numericValue: 3,
            acceptedAnswers: ["3"],
            marksAwarded: 1,
            marksDeducted: 0
        },
        {
            questionId: natQId2,
            testId,
            questionNumber: 33,
            questionType: "numerical",
            sectionId: "core_section",
            answerType: "numerical_value",
            numericValue: 3.14,
            numericRange: { min: 3.12, max: 3.16 },
            acceptedAnswers: ["3.14"],
            marksAwarded: 2,
            marksDeducted: 0
        }
    ];

    test("1.1 Strict numerical regex validation: accepts valid non-negative integers and decimals", () => {
        const validValues = ["0", "42", "100", "0.5", "3.14", "12.3456", "999999"];
        const numericRegex = /^\d+(?:\.\d+)?$/;

        for (const val of validValues) {
            assert.strictEqual(numericRegex.test(val), true, `Expected valid: ${val}`);
        }
    });

    test("1.2 Strict numerical regex validation: rejects alphabets, signs, spaces, commas, exponents", () => {
        const invalidValues = [
            "12a", "abc", "-15", "+5", "3,4", "1.2.3", "1e5", " 12 ",
            "12 ", " 12", "12..3", "NaN", "Infinity", "0x12"
        ];
        const numericRegex = /^\d+(?:\.\d+)?$/;

        for (const val of invalidValues) {
            assert.strictEqual(numericRegex.test(val), false, `Expected invalid: ${val}`);
        }
    });

    test("2.1 MockTestService._sanitizeAndValidateAnswers accepts valid numerical answers", () => {
        const input = {
            [mcqQId]: "B",
            [natQId1]: "3",
            [natQId2]: "3.14"
        };
        const sanitized = MockTestService._sanitizeAndValidateAnswers(input, {}, questions);

        assert.strictEqual(sanitized[mcqQId], "B");
        assert.strictEqual(sanitized[natQId1], "3");
        assert.strictEqual(sanitized[natQId2], "3.14");
    });

    test("2.2 MockTestService._sanitizeAndValidateAnswers rejects malformed numerical answers with 400", () => {
        const malformedInputs = [
            { [natQId1]: "12a" },
            { [natQId1]: "-15" },
            { [natQId1]: "+5" },
            { [natQId1]: "3.1.4" },
            { [natQId1]: "3,14" },
            { [natQId1]: " 3 " }
        ];

        for (const input of malformedInputs) {
            assert.throws(() => {
                MockTestService._sanitizeAndValidateAnswers(input, {}, questions);
            }, (err) => {
                return err.statusCode === 400 && err.code === "MALFORMED_NUMERICAL_ANSWER";
            });
        }
    });

    test("2.3 MockTestService._sanitizeAndValidateAnswers removes empty answers and does not convert to 0", () => {
        const existing = {
            [mcqQId]: "A",
            [natQId1]: "5",
            [natQId2]: "10.5"
        };

        const update = {
            [natQId1]: "",
            [natQId2]: null
        };

        const sanitized = MockTestService._sanitizeAndValidateAnswers(update, existing, questions);

        assert.strictEqual(sanitized[mcqQId], "A");
        assert.strictEqual(sanitized[natQId1], undefined, "Cleared NAT answer must be deleted");
        assert.strictEqual(sanitized[natQId2], undefined, "Null NAT answer must be deleted");
        assert.strictEqual("0" in sanitized, false);
    });

    test("3.1 MockTestService autosave and submit lifecycle with Firestore", async () => {
        // Seed test and questions
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "gate",
            title: "GATE CS NAT Audit Test",
            status: "published",
            questionIds: questions.map(q => q.questionId),
            schemaVersion: 2
        });

        for (const q of questions) {
            await UniversalFirestoreService.setDocument("mockQuestions", q.questionId, q);
        }
        for (const ak of answerKeys) {
            await UniversalFirestoreService.setDocument("mockAnswerKeys", ak.questionId, ak);
        }

        // Create attempt
        const attempt = await MockTestService.startAttempt({
            testId,
            userId: studentUid,
            language: "English"
        });

        // 3.1.1 Autosave with valid numerical answers
        const autosaveResult = await MockTestService.autosaveAttempt({
            attemptId: attempt.attemptId,
            userId: studentUid,
            answers: {
                [mcqQId]: "B",
                [natQId1]: "3",
                [natQId2]: "3.14"
            }
        });
        assert.strictEqual(autosaveResult.success, true);
        assert.strictEqual(autosaveResult.savedCount, 3);

        // 3.1.2 Autosave with malformed numerical answer rejected with 400
        await assert.rejects(async () => {
            await MockTestService.autosaveAttempt({
                attemptId: attempt.attemptId,
                userId: studentUid,
                answers: {
                    [natQId1]: "3abc"
                }
            });
        }, (err) => err.statusCode === 400 && err.code === "MALFORMED_NUMERICAL_ANSWER");

        // 3.1.3 Submission with malformed numerical answer rejected with 400
        await assert.rejects(async () => {
            await MockTestService.submitAttempt({
                attemptId: attempt.attemptId,
                userId: studentUid,
                answers: {
                    [natQId2]: "-12.5"
                }
            });
        }, (err) => err.statusCode === 400 && err.code === "MALFORMED_NUMERICAL_ANSWER");

        // 3.1.4 Successful submission with valid responses
        const submissionResult = await MockTestService.submitAttempt({
            attemptId: attempt.attemptId,
            userId: studentUid,
            answers: {
                [mcqQId]: "B",
                [natQId1]: "3",
                [natQId2]: "3.14"
            }
        });

        assert.ok(submissionResult);
        assert.strictEqual(submissionResult.correctCount, 3);
        assert.strictEqual(submissionResult.incorrectCount, 0);
        assert.strictEqual(submissionResult.totalScore, 4); // 1 + 1 + 2 = 4 marks
    });

    test("4.1 Student Confidentiality: getTestForStudent never exposes answer keys or acceptedAnswers", async () => {
        const studentView = await MockTestService.getTestForStudent(testId, { callerRole: "user" });

        assert.ok(studentView);
        assert.strictEqual(studentView.test.testId, testId);
        assert.strictEqual(studentView.questions.length, 3);

        for (const q of studentView.questions) {
            assert.strictEqual(q.correctAnswer, undefined, `correctAnswer must not leak in ${q.questionId}`);
            assert.strictEqual(q.correctOptionId, undefined, `correctOptionId must not leak in ${q.questionId}`);
            assert.strictEqual(q.acceptedAnswers, undefined, `acceptedAnswers must not leak in ${q.questionId}`);
            assert.strictEqual(q.correctAnswers, undefined, `correctAnswers must not leak in ${q.questionId}`);
            assert.strictEqual(q.answerKey, undefined, `answerKey must not leak in ${q.questionId}`);

            if (q.questionType.includes("nat") || q.questionType.includes("numerical")) {
                assert.strictEqual(q.options.length, 0, "Numerical question must have empty options array");
            }
        }
    });

    test("5.1 UniversalScoringEngine evaluates numerical exact, range, tolerance and zero penalty", () => {
        const gateProfile = ExamProfileRegistry.getProfile("gate-cs-2026");
        assert.ok(gateProfile, "gate-cs-2026 profile must exist");

        // Case 1: Exact correct answer
        const evalExact = UniversalScoringEngine.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: {
                [natQId1]: "3",
                [natQId2]: "3.14"
            },
            examProfile: "gate-cs-2026"
        });

        const q1Result = evalExact.breakdown.find(r => r.questionId === natQId1);
        const q2Result = evalExact.breakdown.find(r => r.questionId === natQId2);
        assert.strictEqual(q1Result.status, "correct");
        assert.strictEqual(q1Result.marksAwarded, 1);
        assert.strictEqual(q2Result.status, "correct");
        assert.strictEqual(q2Result.marksAwarded, 2);

        // Case 2: Range match for Q33 (range: [3.12, 3.16])
        const evalRange = UniversalScoringEngine.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: {
                [natQId2]: "3.15" // within [3.12, 3.16]
            },
            examProfile: "gate-cs-2026"
        });
        const q2RangeResult = evalRange.breakdown.find(r => r.questionId === natQId2);
        assert.strictEqual(q2RangeResult.status, "correct");
        assert.strictEqual(q2RangeResult.marksAwarded, 2);

        // Case 3: Incorrect numerical answer incurs ZERO penalty in GATE
        const evalWrong = UniversalScoringEngine.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: {
                [natQId1]: "99",
                [natQId2]: "50.0"
            },
            examProfile: "gate-cs-2026"
        });

        const q1Wrong = evalWrong.breakdown.find(r => r.questionId === natQId1);
        const q2Wrong = evalWrong.breakdown.find(r => r.questionId === natQId2);
        assert.strictEqual(q1Wrong.status, "incorrect");
        assert.strictEqual(q1Wrong.marksAwarded, 0, "GATE NAT incorrect must get 0 marks (no negative penalty)");
        assert.strictEqual(q2Wrong.status, "incorrect");
        assert.strictEqual(q2Wrong.marksAwarded, 0, "GATE NAT incorrect must get 0 marks (no negative penalty)");
    });
});
