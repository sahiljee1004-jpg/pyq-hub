import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { PostBackupReconciliationService } from "../server/services/admin/postBackupReconciliationService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";

describe("Milestone 3: Data Serialization & Type Fidelity Audit", () => {

    test("1. Date Object: JSON serialization converts to ISO string matching Firestore REST convention", () => {
        const dateObj = new Date("2026-11-10T15:30:00.123Z");
        const attempt = {
            attemptId: "att_date_test",
            status: "submitted",
            startedAt: dateObj
        };

        const state = PostBackupReconciliationService._extractAttemptState(attempt);
        assert.equal(typeof state.startedAt, "string");
        assert.equal(state.startedAt, "2026-11-10T15:30:00.123Z");

        // Verify UniversalFirestoreService accepts this ISO string and serializes correctly
        const fields = UniversalFirestoreService.toFirestoreFields(state);
        assert.equal(fields.startedAt.stringValue, "2026-11-10T15:30:00.123Z");
    });

    test("2. Firestore Timestamp: handles both REST timestamp strings and SDK Timestamp objects", () => {
        // Case A: REST timestamp string (standard across this codebase)
        const restTimestamp = "2026-11-10T12:00:00.000000Z";
        const attemptA = {
            attemptId: "att_ts_rest",
            submittedAt: restTimestamp
        };
        const stateA = PostBackupReconciliationService._extractAttemptState(attemptA);
        assert.equal(stateA.submittedAt, restTimestamp);

        // Case B: SDK Timestamp object { seconds, nanoseconds }
        const sdkTimestamp = {
            seconds: 1794312000,
            nanoseconds: 500000000,
            toDate() { return new Date(this.seconds * 1000); }
        };
        const attemptB = {
            attemptId: "att_ts_sdk",
            sdkTime: sdkTimestamp
        };
        const stateB = PostBackupReconciliationService._extractAttemptState(attemptB);
        assert.deepEqual(stateB.sdkTime, { seconds: 1794312000, nanoseconds: 500000000 });
        assert.equal(typeof stateB.sdkTime.toDate, "undefined", "Methods are stripped during JSON cloning");
    });

    test("3. BigInt: Throws TypeError if unhandled, but application exclusively uses Number", () => {
        const attemptWithBigInt = {
            attemptId: "att_bigint",
            largeCounter: 9007199254740991n
        };

        assert.throws(() => {
            PostBackupReconciliationService._extractAttemptState(attemptWithBigInt);
        }, /Do not know how to serialize a BigInt/);

        // Verify standard safe integers (up to Number.MAX_SAFE_INTEGER) serialize cleanly
        const attemptWithNumber = {
            attemptId: "att_number",
            timestampMillis: 1794312000123,
            maxSafe: Number.MAX_SAFE_INTEGER
        };
        const stateNum = PostBackupReconciliationService._extractAttemptState(attemptWithNumber);
        assert.equal(stateNum.timestampMillis, 1794312000123);
        assert.equal(stateNum.maxSafe, 9007199254740991);
    });

    test("4. Nested Arrays and Objects: Deep clone preserves full hierarchy without mutation", () => {
        const original = {
            attemptId: "att_nested",
            answers: {
                q1: "A",
                q2: ["B", "C"],
                q3: { selected: "D", confidence: 0.95 }
            },
            breakdown: [
                { questionId: "q1", marksAwarded: 4, rubrics: { correct: true } },
                { questionId: "q2", marksAwarded: -1, rubrics: { correct: false } }
            ]
        };

        const state = PostBackupReconciliationService._extractAttemptState(original);
        assert.deepEqual(state, original);

        // Verify deep cloning: mutating original does not mutate extracted state
        original.answers.q2.push("X");
        original.breakdown[0].rubrics.correct = false;
        assert.deepEqual(state.answers.q2, ["B", "C"]);
        assert.equal(state.breakdown[0].rubrics.correct, true);
    });

    test("5. Null vs Undefined: Null is preserved, undefined is stripped (matching Firestore REST conventions)", () => {
        const attempt = {
            attemptId: "att_null_undef",
            validNullField: null,
            optionalUndefField: undefined,
            emptyNotes: null
        };

        const state = PostBackupReconciliationService._extractAttemptState(attempt);
        assert.equal(state.validNullField, null);
        assert.equal(state.emptyNotes, null);
        assert.equal("optionalUndefField" in state, false, "Undefined keys must be omitted");

        const fields = UniversalFirestoreService.toFirestoreFields(state);
        assert.deepEqual(fields.validNullField, { nullValue: null });
        assert.deepEqual(fields.emptyNotes, { nullValue: null });
        assert.equal(fields.optionalUndefField, undefined);
    });

    test("6. Custom Application Metadata: Preserves unlisted arbitrary fields", () => {
        const customPayload = {
            attemptId: "att_custom_meta",
            status: "submitted",
            customBatchTag: "batch_2026_special",
            proctorVerification: { verifiedBy: "operator_01", confidence: 0.99 },
            clientTelemetry: { browser: "Chrome 122", latencyMs: 42 }
        };

        const state = PostBackupReconciliationService._extractAttemptState(customPayload);
        assert.deepEqual(state, customPayload);
    });

    test("7. Actual Firestore REST Document Ingestion: parses real wire types into application model and roundtrips", () => {
        // Real Firestore REST document as returned by Google Cloud Firestore endpoint
        const rawRestDocument = {
            name: "projects/pyqs-hub-43bed/databases/(default)/documents/mockAttempts/attempt_real_001",
            fields: {
                attemptId: { stringValue: "attempt_real_001" },
                testId: { stringValue: "test_bpsc_70th" },
                userId: { stringValue: "student_live_99" },
                status: { stringValue: "submitted" },
                startedAt: { timestampValue: "2026-11-10T12:00:00.000000Z" },
                submittedAt: { timestampValue: "2026-11-10T14:00:00.000000Z" },
                durationSeconds: { integerValue: "7200" },
                totalScore: { doubleValue: 104.667 }, // Rational fractional calculation stored as IEEE double
                negativeDeductions: { doubleValue: -0.333 },
                isFinalized: { booleanValue: true },
                markedForReview: {
                    arrayValue: {
                        values: [{ stringValue: "q2" }, { stringValue: "q15" }]
                    }
                },
                answers: {
                    mapValue: {
                        fields: {
                            q1: { stringValue: "B" },
                            q2: { stringValue: "D" }
                        }
                    }
                },
                notes: { nullValue: null }
            },
            createTime: "2026-11-10T12:00:01.555000Z",
            updateTime: "2026-11-10T14:00:02.888000Z"
        };

        // 1. Ingest via UniversalFirestoreService.fromFirestoreDocument
        const parsed = UniversalFirestoreService.fromFirestoreDocument(rawRestDocument);

        // Verify Category A: Persisted JSON-compatible values
        assert.equal(parsed.attemptId, "attempt_real_001");
        assert.equal(parsed.durationSeconds, 7200);
        assert.equal(typeof parsed.durationSeconds, "number");
        assert.equal(parsed.totalScore, 104.667);
        assert.equal(typeof parsed.totalScore, "number");
        assert.equal(parsed.negativeDeductions, -0.333);
        assert.equal(parsed.isFinalized, true);
        assert.deepEqual(parsed.markedForReview, ["q2", "q15"]);
        assert.deepEqual(parsed.answers, { q1: "B", q2: "D" });
        assert.equal(parsed.notes, null);

        // Verify Category B: Firestore REST timestamp strings
        assert.equal(parsed.startedAt, "2026-11-10T12:00:00.000000Z");
        assert.equal(parsed.submittedAt, "2026-11-10T14:00:00.000000Z");

        // Verify Category C: Transient Firestore metadata
        assert.equal(parsed._createTime, "2026-11-10T12:00:01.555000Z");
        assert.equal(parsed._updateTime, "2026-11-10T14:00:02.888000Z");

        // 2. Extract state in PostBackupReconciliationService
        const extractedState = PostBackupReconciliationService._extractAttemptState(parsed);
        assert.equal(extractedState._createTime, undefined, "Transient _createTime must be stripped");
        assert.equal(extractedState._updateTime, undefined, "Transient _updateTime must be stripped");
        assert.equal(extractedState.totalScore, 104.667, "Score must be preserved");

        // 3. Serialize back via UniversalFirestoreService.toFirestoreFields
        const serialized = UniversalFirestoreService.toFirestoreFields(extractedState);
        assert.equal(serialized._createTime, undefined);
        assert.equal(serialized._updateTime, undefined);
        assert.deepEqual(serialized.totalScore, { doubleValue: 104.667 });
        assert.deepEqual(serialized.durationSeconds, { integerValue: "7200" });
        assert.deepEqual(serialized.startedAt, { stringValue: "2026-11-10T12:00:00.000000Z" });
        assert.deepEqual(serialized.notes, { nullValue: null });
    });

    test("8. Exhaustive Attempt State Extraction: covers all 22 persisted attempt fields and excludes transient metadata", () => {
        const fullAttempt = {
            attemptId: "att_exhaustive_001",
            testId: "test_upsc_prelims",
            userId: "student_user_101",
            language: "English",
            status: "submitted",
            startedAt: "2026-11-10T10:00:00.000Z",
            deadlineAt: "2026-11-10T12:00:00.000Z",
            durationSeconds: 7200,
            answers: { q1: "A", q2: ["B", "C"], q3: "D" },
            markedForReview: ["q2", "q5"],
            createdAt: "2026-11-10T10:00:00.000Z",
            updatedAt: "2026-11-10T11:45:00.000Z",
            submittedAt: "2026-11-10T11:45:00.000Z",
            timeTakenSeconds: 6300,
            isFinalized: true,
            requiresManualEvaluation: false,
            pendingReviewCount: 0,
            questionTimes: { q1: 45, q2: 90, q3: 60 },
            clientTimestamps: { startedAt: 1794300000000, submittedAt: 1794306300000 },
            schemaVersion: 2,
            profileId: "upsc-prelims-gs1",
            migratedAt: "2026-11-10T11:45:01.000Z",
            optionalNullNote: null,
            optionalUndefField: undefined,
            // Transient Firestore server metadata to be stripped:
            _createTime: "2026-11-10T10:00:01.000000Z",
            _updateTime: "2026-11-10T11:45:02.000000Z",
            createTime: "2026-11-10T10:00:01.000000Z",
            updateTime: "2026-11-10T11:45:02.000000Z"
        };

        const extracted = PostBackupReconciliationService._extractAttemptState(fullAttempt);

        // Verify transient metadata is stripped
        assert.equal(extracted._createTime, undefined);
        assert.equal(extracted._updateTime, undefined);
        assert.equal(extracted.createTime, undefined);
        assert.equal(extracted.updateTime, undefined);

        // Verify undefined fields are omitted
        assert.equal("optionalUndefField" in extracted, false);

        // Verify explicit null is preserved
        assert.equal(extracted.optionalNullNote, null);

        // Verify all persisted application fields are 100% retained
        assert.equal(extracted.attemptId, "att_exhaustive_001");
        assert.equal(extracted.testId, "test_upsc_prelims");
        assert.equal(extracted.userId, "student_user_101");
        assert.equal(extracted.language, "English");
        assert.equal(extracted.status, "submitted");
        assert.equal(extracted.startedAt, "2026-11-10T10:00:00.000Z");
        assert.equal(extracted.deadlineAt, "2026-11-10T12:00:00.000Z");
        assert.equal(extracted.durationSeconds, 7200);
        assert.deepEqual(extracted.answers, { q1: "A", q2: ["B", "C"], q3: "D" });
        assert.deepEqual(extracted.markedForReview, ["q2", "q5"]);
        assert.equal(extracted.createdAt, "2026-11-10T10:00:00.000Z");
        assert.equal(extracted.updatedAt, "2026-11-10T11:45:00.000Z");
        assert.equal(extracted.submittedAt, "2026-11-10T11:45:00.000Z");
        assert.equal(extracted.timeTakenSeconds, 6300);
        assert.equal(extracted.isFinalized, true);
        assert.equal(extracted.requiresManualEvaluation, false);
        assert.equal(extracted.pendingReviewCount, 0);
        assert.deepEqual(extracted.questionTimes, { q1: 45, q2: 90, q3: 60 });
        assert.deepEqual(extracted.clientTimestamps, { startedAt: 1794300000000, submittedAt: 1794306300000 });
        assert.equal(extracted.schemaVersion, 2);
        assert.equal(extracted.profileId, "upsc-prelims-gs1");
        assert.equal(extracted.migratedAt, "2026-11-10T11:45:01.000Z");
    });

    test("9. Exhaustive Result State Extraction: covers all 24 persisted result fields and excludes transient metadata", () => {
        const fullResult = {
            resultId: "res_exhaustive_001",
            attemptId: "att_exhaustive_001",
            testId: "test_upsc_prelims",
            userId: "student_user_101",
            totalScore: 98.667,
            maximumMarks: 200,
            percentageScore: 49.33,
            totalQuestions: 100,
            correctCount: 52,
            incorrectCount: 16,
            unansweredCount: 32,
            droppedCount: 0,
            attemptedCount: 68,
            pendingReviewCount: 0,
            requiresManualEvaluation: false,
            isFinalized: true,
            accuracyPercent: 76.47,
            timeTakenSeconds: 6300,
            subjectAnalysis: {
                history: { correct: 20, incorrect: 5, score: 36.667 },
                polity: { correct: 32, incorrect: 11, score: 62.0 }
            },
            breakdown: [
                { questionId: "q1", marksAwarded: 2.0, status: "correct" },
                { questionId: "q2", marksAwarded: -0.667, status: "incorrect" }
            ],
            sectionScores: { "sec_gs1": 98.667 },
            submittedAt: "2026-11-10T11:45:00.000Z",
            schemaVersion: 2,
            profileId: "upsc-prelims-gs1",
            notes: null,
            _createTime: "2026-11-10T11:45:02.000000Z",
            _updateTime: "2026-11-10T11:45:02.000000Z",
            createTime: "2026-11-10T11:45:02.000000Z",
            updateTime: "2026-11-10T11:45:02.000000Z"
        };

        const extracted = PostBackupReconciliationService._extractResultState(fullResult);

        // Verify transient metadata is stripped
        assert.equal(extracted._createTime, undefined);
        assert.equal(extracted._updateTime, undefined);
        assert.equal(extracted.createTime, undefined);
        assert.equal(extracted.updateTime, undefined);

        // Verify null is preserved
        assert.equal(extracted.notes, null);

        // Verify all persisted result fields are 100% retained
        assert.equal(extracted.resultId, "res_exhaustive_001");
        assert.equal(extracted.attemptId, "att_exhaustive_001");
        assert.equal(extracted.testId, "test_upsc_prelims");
        assert.equal(extracted.userId, "student_user_101");
        assert.equal(extracted.totalScore, 98.667);
        assert.equal(extracted.maximumMarks, 200);
        assert.equal(extracted.percentageScore, 49.33);
        assert.equal(extracted.totalQuestions, 100);
        assert.equal(extracted.correctCount, 52);
        assert.equal(extracted.incorrectCount, 16);
        assert.equal(extracted.unansweredCount, 32);
        assert.equal(extracted.droppedCount, 0);
        assert.equal(extracted.attemptedCount, 68);
        assert.equal(extracted.pendingReviewCount, 0);
        assert.equal(extracted.requiresManualEvaluation, false);
        assert.equal(extracted.isFinalized, true);
        assert.equal(extracted.accuracyPercent, 76.47);
        assert.equal(extracted.timeTakenSeconds, 6300);
        assert.deepEqual(extracted.subjectAnalysis.history, { correct: 20, incorrect: 5, score: 36.667 });
        assert.deepEqual(extracted.breakdown[0], { questionId: "q1", marksAwarded: 2.0, status: "correct" });
        assert.deepEqual(extracted.sectionScores, { "sec_gs1": 98.667 });
        assert.equal(extracted.submittedAt, "2026-11-10T11:45:00.000Z");
        assert.equal(extracted.schemaVersion, 2);
        assert.equal(extracted.profileId, "upsc-prelims-gs1");
    });

    test("10. Internal Rational Calculation: uses native BigInt for exact fractions and converts to Number before Firestore", async () => {
        const { Rational } = await import("../server/services/scoring/rational.js");

        // Verify Rational uses native BigInt internally
        const r1 = new Rational(2, 3); // 2/3
        const r2 = new Rational(1, 3); // 1/3
        assert.equal(typeof r1.num, "bigint", "Rational numerator must be native BigInt");
        assert.equal(typeof r1.den, "bigint", "Rational denominator must be native BigInt");
        assert.equal(r1.num, 2n);
        assert.equal(r1.den, 3n);

        // Arithmetic with zero floating point drift
        const diff = r1.sub(r2); // 2/3 - 1/3 = 1/3
        assert.equal(diff.num, 1n);
        assert.equal(diff.den, 3n);

        // Conversion to IEEE 754 Number rounded to 3 decimal places for persistence
        const persistedScore = diff.toNumber(3); // 0.333
        assert.equal(typeof persistedScore, "number", "Persisted value must be converted to standard JS number");
        assert.equal(persistedScore, 0.333);

        // Verify persisted value passes cleanly into UniversalFirestoreService
        const fields = UniversalFirestoreService.toFirestoreFields({ score: persistedScore });
        assert.deepEqual(fields.score, { doubleValue: 0.333 });
    });
});
