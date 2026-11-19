import test, { describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { HistoricalAttemptMigrationService } from "../server/services/admin/historicalAttemptMigrationService.js";
import { ExamProfileRegistry } from "../server/services/admin/examProfileRegistry.js";

/**
 * Milestone 3 Test Suite: Historical Student Attempt Migration Pipeline
 *
 * Verifies all 12 mandatory specifications:
 *  1. Valid legacy attempt -> successfully migrates to Schema v2.
 *  2. Already migrated attempt -> skipped idempotently.
 *  3. Unsupported exam profile -> quarantined.
 *  4. Missing scoring metadata -> quarantined.
 *  5. Descriptive/manual-review attempt -> requiresManualEvaluation preserved, isFinalized false.
 *  6. Duplicate result -> quarantined as DUPLICATE_RESULT.
 *  7. Orphaned attempt -> quarantined as ORPHANED_ATTEMPT / ORPHANED_RESULT.
 *  8. Stale updateTime -> rejected via precondition, aborted safely.
 *  9. Interrupted migration and resume -> checkpoint resumes cleanly.
 * 10. Repeated execution and idempotency -> zero drift, identical outcome across multiple runs.
 * 11. Historical score preservation -> bit-for-bit assertion on historical marks.
 * 12. Partial batch failure -> atomic chunk safety verified.
 */
describe("Milestone 3: Historical Student Attempt Migration Pipeline", () => {
    const targetProjectId = "demo-vidyarthiastra";

    beforeEach(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = targetProjectId;
        UniversalFirestoreService.clearLocalCache();
    });

    // -------------------------------------------------------------------------
    // Scenario 1: Valid legacy attempt -> successfully migrates to Schema v2
    // -------------------------------------------------------------------------
    test("Scenario 1: Valid legacy attempt upgrades to Schema v2 while preserving historical marks", async () => {
        const testId = "test_legacy_jee_01";
        const attemptId = "attempt_legacy_001";
        const resultId = "attempt_legacy_001";
        const userId = "student_jee_101";

        // Seed test definition (legacy schema v1)
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "jee-main",
            year: 2024,
            title: "JEE Main 2024 Historical Paper",
            durationMinutes: 180,
            maximumMarks: 8
        });

        // Seed legacy attempt
        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId,
            testId,
            userId,
            status: "submitted",
            startedAt: "2024-05-10T10:00:00.000Z",
            submittedAt: "2024-05-10T12:30:00.000Z",
            timeTakenSeconds: 9000,
            answers: { q1: "A", q2: "B" }
        });

        // Seed legacy result
        await UniversalFirestoreService.setDocument("mockResults", resultId, {
            resultId,
            attemptId,
            testId,
            userId,
            totalScore: 3,
            maximumMarks: 8,
            percentageScore: 37.5,
            totalQuestions: 2,
            correctCount: 1,
            incorrectCount: 1,
            unansweredCount: 0,
            droppedCount: 0,
            attemptedCount: 2,
            accuracyPercent: 50.0,
            breakdown: [
                { questionId: "q1", marksAwarded: 4, isCorrect: true, sectionId: "physics_a" },
                { questionId: "q2", marksAwarded: -1, isCorrect: false, sectionId: "physics_a" }
            ],
            submittedAt: "2024-05-10T12:30:00.000Z"
        });

        const migrationReport = await HistoricalAttemptMigrationService.executeBatchMigration({
            batchSize: 10,
            allowWrites: true,
            targetProjectId
        });

        assert.equal(migrationReport.status, "completed");
        assert.equal(migrationReport.migratedAttempts, 1);
        assert.equal(migrationReport.migratedResults, 1);

        // Fetch migrated documents
        const migratedAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        const migratedResult = await UniversalFirestoreService.getDocument("mockResults", resultId);

        // Assert Schema v2 transformation
        assert.equal(migratedAttempt.schemaVersion, 2);
        assert.equal(migratedAttempt.profileId, "jee-main-2024");
        assert.ok(migratedAttempt.migratedAt);
        assert.equal(migratedAttempt.migrationSourceVersion, 1);

        assert.equal(migratedResult.schemaVersion, 2);
        assert.equal(migratedResult.profileId, "jee-main-2024");
        assert.ok(migratedResult.migratedAt);
        assert.equal(migratedResult.sectionScores["physics_a"], 3);

        // Assert 100% score immutability
        assert.equal(migratedResult.totalScore, 3);
        assert.equal(migratedResult.correctCount, 1);
        assert.equal(migratedResult.incorrectCount, 1);
        assert.equal(migratedResult.breakdown[0].marksAwarded, 4);
        assert.equal(migratedResult.breakdown[1].marksAwarded, -1);
    });

    // -------------------------------------------------------------------------
    // Scenario 2: Already migrated attempt -> skipped idempotently
    // -------------------------------------------------------------------------
    test("Scenario 2: Already migrated attempt is skipped idempotently without modification", async () => {
        const testId = "test_already_v2";
        const attemptId = "attempt_already_v2";
        const userId = "student_v2_202";

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "upsc-prelims",
            year: 2024,
            profileId: "upsc-prelims-2024",
            schemaVersion: 2
        });

        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId,
            testId,
            userId,
            status: "submitted",
            schemaVersion: 2,
            profileId: "upsc-prelims-2024",
            migratedAt: "2026-11-01T10:00:00.000Z"
        });

        await UniversalFirestoreService.setDocument("mockResults", attemptId, {
            resultId: attemptId,
            attemptId,
            testId,
            userId,
            totalScore: 98.67,
            correctCount: 52,
            incorrectCount: 16,
            schemaVersion: 2,
            profileId: "upsc-prelims-2024",
            migratedAt: "2026-11-01T10:00:00.000Z",
            breakdown: []
        });

        const initialAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);

        const migrationReport = await HistoricalAttemptMigrationService.executeBatchMigration({
            allowWrites: true,
            targetProjectId
        });

        assert.equal(migrationReport.migratedAttempts, 0);
        assert.equal(migrationReport.skippedAlreadyMigrated, 1);

        const postAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        assert.equal(postAttempt._updateTime, initialAttempt._updateTime, "UpdateTime must remain untouched for skipped documents");
    });

    // -------------------------------------------------------------------------
    // Scenario 3: Unsupported exam profile -> quarantined
    // -------------------------------------------------------------------------
    test("Scenario 3: Attempt referencing unmapped exam family is quarantined", async () => {
        const testId = "test_unknown_sat";
        const attemptId = "attempt_unsupported_001";
        const userId = "student_sat_303";

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "sat-general-2015",
            year: 2015
        });

        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId,
            testId,
            userId,
            status: "submitted",
            answers: { q1: "A" }
        });

        await UniversalFirestoreService.setDocument("mockResults", attemptId, {
            resultId: attemptId,
            attemptId,
            testId,
            userId,
            totalScore: 1200,
            breakdown: [{ questionId: "q1", marksAwarded: 1200 }]
        });

        const inventory = await HistoricalAttemptMigrationService.discoverInventory({ targetProjectId });
        assert.equal(inventory.counts.quarantined, 1);
        assert.equal(inventory.quarantinedByReason[HistoricalAttemptMigrationService.QUARANTINE_REASONS.UNSUPPORTED_PROFILE], 1);

        const report = await HistoricalAttemptMigrationService.executeBatchMigration({
            allowWrites: true,
            targetProjectId
        });
        assert.equal(report.quarantined, 1);
        assert.equal(report.migratedAttempts, 0);

        // Document must NOT have schemaVersion: 2
        const attemptDoc = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        assert.notEqual(attemptDoc.schemaVersion, 2);
    });

    // -------------------------------------------------------------------------
    // Scenario 4: Missing scoring metadata -> quarantined
    // -------------------------------------------------------------------------
    test("Scenario 4: Attempt with corrupted metadata or missing fields is quarantined", async () => {
        // Missing userId in attempt
        const testId = "test_corrupted_jee";
        const attemptId = "attempt_corrupted_001";

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "jee-main",
            year: 2024
        });

        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId,
            testId,
            // userId missing!
            status: "submitted"
        });

        await UniversalFirestoreService.setDocument("mockResults", attemptId, {
            resultId: attemptId,
            attemptId,
            testId,
            totalScore: "INVALID_SCORE", // non-numeric
            breakdown: null              // missing breakdown
        });

        const inventory = await HistoricalAttemptMigrationService.discoverInventory({ targetProjectId });
        assert.equal(inventory.quarantinedByReason[HistoricalAttemptMigrationService.QUARANTINE_REASONS.CORRUPTED_METADATA], 1);
    });

    // -------------------------------------------------------------------------
    // Scenario 5: Descriptive / manual-review attempt -> review flags preserved
    // -------------------------------------------------------------------------
    test("Scenario 5: Descriptive attempt preserves manual evaluation lifecycle and 0 penalty", async () => {
        const testId = "test_upsc_descriptive";
        const attemptId = "attempt_desc_001";
        const userId = "student_desc_505";

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "upsc-prelims",
            year: 2024
        });

        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId,
            testId,
            userId,
            status: "submitted",
            answers: { q1: "A", q2: "Essay response text..." }
        });

        await UniversalFirestoreService.setDocument("mockResults", attemptId, {
            resultId: attemptId,
            attemptId,
            testId,
            userId,
            totalScore: 2,
            correctCount: 1,
            incorrectCount: 0,
            unansweredCount: 0,
            droppedCount: 0,
            pendingReviewCount: 1,
            requiresManualEvaluation: true,
            isFinalized: false,
            breakdown: [
                { questionId: "q1", marksAwarded: 2, isCorrect: true, questionType: "mcq" },
                {
                    questionId: "q2",
                    marksAwarded: 0,
                    questionType: "descriptive",
                    status: "pending_manual_review",
                    requiresManualReview: true
                }
            ]
        });

        await HistoricalAttemptMigrationService.executeBatchMigration({ allowWrites: true, targetProjectId });

        const migratedResult = await UniversalFirestoreService.getDocument("mockResults", attemptId);
        assert.equal(migratedResult.schemaVersion, 2);
        assert.equal(migratedResult.requiresManualEvaluation, true);
        assert.equal(migratedResult.isFinalized, false);
        assert.equal(migratedResult.pendingReviewCount, 1);
        assert.equal(migratedResult.totalScore, 2);
        assert.equal(migratedResult.breakdown[1].marksAwarded, 0, "Pending descriptive question must not receive negative or arbitrary marks");
    });

    // -------------------------------------------------------------------------
    // Scenario 6: Duplicate result -> quarantined as DUPLICATE_RESULT
    // -------------------------------------------------------------------------
    test("Scenario 6: Duplicate result records for single attempt are quarantined", async () => {
        const testId = "test_dup_neet";
        const attemptId = "attempt_dup_001";
        const userId = "student_dup_606";

        const testDoc = { testId, examId: "neet-ug", year: 2024 };
        const attemptDoc = { attemptId, testId, userId, status: "submitted" };
        const resultDoc1 = { resultId: "res_dup_1", attemptId, testId, userId, totalScore: 720, breakdown: [] };
        const resultDoc2 = { resultId: "res_dup_2", attemptId, testId, userId, totalScore: 680, breakdown: [] };

        const inventory = await HistoricalAttemptMigrationService.discoverInventory({
            attempts: [attemptDoc],
            results: [resultDoc1, resultDoc2],
            tests: [testDoc]
        });

        assert.equal(inventory.counts.quarantined, 1);
        assert.equal(inventory.quarantinedByReason[HistoricalAttemptMigrationService.QUARANTINE_REASONS.DUPLICATE_RESULT], 1);
    });

    // -------------------------------------------------------------------------
    // Scenario 7: Orphaned attempt -> quarantined as ORPHANED_ATTEMPT / RESULT
    // -------------------------------------------------------------------------
    test("Scenario 7: Orphaned attempt with no result and orphaned result with no attempt are quarantined", async () => {
        const testId = "test_orphans";
        const testDoc = { testId, examId: "gate", year: 2024 };

        // Attempt 1: Orphaned attempt (submitted but no result exists)
        const orphanAttempt = {
            attemptId: "orphan_attempt_701",
            testId,
            userId: "student_gate_701",
            status: "submitted"
        };

        // Result 2: Orphaned result (result exists but attempt is missing)
        const orphanResult = {
            resultId: "orphan_result_702",
            attemptId: "non_existent_attempt_702",
            testId,
            userId: "student_gate_702",
            totalScore: 45,
            breakdown: []
        };

        const inventory = await HistoricalAttemptMigrationService.discoverInventory({
            attempts: [orphanAttempt],
            results: [orphanResult],
            tests: [testDoc]
        });

        assert.equal(inventory.quarantinedByReason[HistoricalAttemptMigrationService.QUARANTINE_REASONS.ORPHANED_ATTEMPT], 1);
        assert.equal(inventory.quarantinedByReason[HistoricalAttemptMigrationService.QUARANTINE_REASONS.ORPHANED_RESULT], 1);
    });

    // -------------------------------------------------------------------------
    // Scenario 8: Stale updateTime -> rejected via precondition, aborted safely
    // -------------------------------------------------------------------------
    test("Scenario 8: Stale updateTime precondition triggers safe fail-closed rejection", async () => {
        const testId = "test_stale_precondition";
        const attemptId = "attempt_stale_801";
        const userId = "student_stale_801";

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "bpsc",
            year: 2023
        });

        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId,
            testId,
            userId,
            status: "submitted"
        });

        await UniversalFirestoreService.setDocument("mockResults", attemptId, {
            resultId: attemptId,
            attemptId,
            testId,
            userId,
            totalScore: 10,
            breakdown: [{ questionId: "q1", marksAwarded: 10 }]
        });

        // Fetch fresh document to get real updateTime
        const currentAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);

        // Intentionally corrupt updateTime to simulate a concurrent write
        const staleAttempt = { ...currentAttempt, _updateTime: "2020-01-01T00:00:00.000Z" };

        await assert.rejects(
            async () => {
                await HistoricalAttemptMigrationService.executeBatchMigration({
                    allowWrites: true,
                    attempts: [staleAttempt],
                    targetProjectId
                });
            },
            /precondition|updateTime mismatch/i
        );
    });

    // -------------------------------------------------------------------------
    // Scenario 9: Interrupted migration and resume
    // -------------------------------------------------------------------------
    test("Scenario 9: Interrupted migration cleanly resumes after lastProcessedAttemptId", async () => {
        const testId = "test_resume_bpsc";
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "bpsc",
            year: 2023
        });

        // Seed 4 attempts: attempt_01, attempt_02, attempt_03, attempt_04
        for (let i = 1; i <= 4; i++) {
            const attId = `attempt_resume_${String(i).padStart(2, "0")}`;
            await UniversalFirestoreService.setDocument("mockAttempts", attId, {
                attemptId: attId,
                testId,
                userId: `student_${i}`,
                status: "submitted"
            });
            await UniversalFirestoreService.setDocument("mockResults", attId, {
                resultId: attId,
                attemptId: attId,
                testId,
                userId: `student_${i}`,
                totalScore: 5,
                breakdown: [{ questionId: "q1", marksAwarded: 5 }]
            });
        }

        // Run batch 1 with batchSize = 2 (migrates attempt_resume_01 and attempt_resume_02)
        const run1 = await HistoricalAttemptMigrationService.executeBatchMigration({
            batchSize: 2,
            allowWrites: true,
            targetProjectId
        });

        assert.equal(run1.migratedAttempts, 4); // All 4 processed across 2 chunks of 2
        assert.equal(run1.batchesExecuted, 2);

        // Now test explicitly resuming after attempt_resume_02
        // Clear documents 3 and 4 back to unmigrated
        await UniversalFirestoreService.setDocument("mockAttempts", "attempt_resume_03", {
            attemptId: "attempt_resume_03",
            testId,
            userId: "student_3",
            status: "submitted"
        });
        await UniversalFirestoreService.setDocument("mockAttempts", "attempt_resume_04", {
            attemptId: "attempt_resume_04",
            testId,
            userId: "student_4",
            status: "submitted"
        });

        const resumeRun = await HistoricalAttemptMigrationService.executeBatchMigration({
            batchSize: 2,
            resumeAfterAttemptId: "attempt_resume_02",
            allowWrites: true,
            targetProjectId
        });

        assert.equal(resumeRun.migratedAttempts, 2, "Should only migrate the remaining 2 attempts");
        assert.equal(resumeRun.lastProcessedAttemptId, "attempt_resume_04");
    });

    // -------------------------------------------------------------------------
    // Scenario 10: Repeated execution and idempotency
    // -------------------------------------------------------------------------
    test("Scenario 10: Repeated execution produces identical outcome with 0 additional mutations", async () => {
        const testId = "test_idempotency_ssc";
        const attemptId = "attempt_idem_101";

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "ssc-cgl",
            year: 2024
        });

        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
            attemptId,
            testId,
            userId: "student_ssc_101",
            status: "submitted"
        });

        await UniversalFirestoreService.setDocument("mockResults", attemptId, {
            resultId: attemptId,
            attemptId,
            testId,
            userId: "student_ssc_101",
            totalScore: 50,
            breakdown: [{ questionId: "q1", marksAwarded: 50, sectionId: "general_intelligence" }]
        });

        // First execution
        const run1 = await HistoricalAttemptMigrationService.executeBatchMigration({ allowWrites: true, targetProjectId });
        assert.equal(run1.migratedAttempts, 1);
        assert.equal(run1.skippedAlreadyMigrated, 0);

        const docAfterRun1 = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);

        // Second execution
        const run2 = await HistoricalAttemptMigrationService.executeBatchMigration({ allowWrites: true, targetProjectId });
        assert.equal(run2.migratedAttempts, 0);
        assert.equal(run2.skippedAlreadyMigrated, 1);

        const docAfterRun2 = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        assert.equal(docAfterRun2._updateTime, docAfterRun1._updateTime);
        assert.deepEqual(docAfterRun2, docAfterRun1);
    });

    // -------------------------------------------------------------------------
    // Scenario 11: Historical score preservation across diverse exam profiles
    // -------------------------------------------------------------------------
    test("Scenario 11: Bit-for-bit assertion of historical marks across diverse exam profiles", async () => {
        const testCases = [
            { examId: "upsc-prelims", year: 2024, score: 98.6667, breakdown: [{ questionId: "q1", marksAwarded: 2 }, { questionId: "q2", marksAwarded: -0.6667 }, { questionId: "q3", marksAwarded: 97.3334 }] },
            { examId: "jee-main", year: 2024, score: 120, breakdown: [{ questionId: "q1", marksAwarded: 4, sectionId: "math_a" }, { questionId: "q2", marksAwarded: -1, sectionId: "math_a" }, { questionId: "q3", marksAwarded: 117, sectionId: "math_a" }] },
            { examId: "neet-ug", year: 2024, score: 650, breakdown: [{ questionId: "q1", marksAwarded: 4, sectionId: "physics_a" }, { questionId: "q2", marksAwarded: 4, sectionId: "physics_a" }, { questionId: "q3", marksAwarded: 642, sectionId: "physics_a" }] },
            { examId: "gate", year: 2024, score: 65.3333, breakdown: [{ questionId: "q1", marksAwarded: 1, sectionId: "ga_section" }, { questionId: "q2", marksAwarded: -0.3333, sectionId: "ga_section" }, { questionId: "q3", marksAwarded: 64.6666, sectionId: "ga_section" }] },
            { examId: "ssc-cgl", year: 2024, score: 140, breakdown: [{ questionId: "q1", marksAwarded: 2, sectionId: "general_intelligence" }, { questionId: "q2", marksAwarded: -0.5, sectionId: "general_intelligence" }, { questionId: "q3", marksAwarded: 138.5, sectionId: "general_intelligence" }] }
        ];

        for (let idx = 0; idx < testCases.length; idx++) {
            const tc = testCases[idx];
            const testId = `test_score_preservation_${idx}`;
            const attemptId = `attempt_score_preservation_${idx}`;

            await UniversalFirestoreService.setDocument("mockTests", testId, {
                testId,
                examId: tc.examId,
                year: tc.year
            });

            await UniversalFirestoreService.setDocument("mockAttempts", attemptId, {
                attemptId,
                testId,
                userId: `student_preserve_${idx}`,
                status: "submitted"
            });

            await UniversalFirestoreService.setDocument("mockResults", attemptId, {
                resultId: attemptId,
                attemptId,
                testId,
                userId: `student_preserve_${idx}`,
                totalScore: tc.score,
                correctCount: 2,
                incorrectCount: 1,
                unansweredCount: 0,
                droppedCount: 0,
                breakdown: tc.breakdown
            });
        }

        // Execute Dry-run first and verify scoreDiscrepanciesDetected is 0
        const dryRun = await HistoricalAttemptMigrationService.executeDryRun({ targetProjectId });
        assert.equal(dryRun.summary.scoreDiscrepanciesDetected, 0);
        assert.equal(dryRun.summary.eligible, 5);

        // Execute live migration
        const liveRun = await HistoricalAttemptMigrationService.executeBatchMigration({ allowWrites: true, targetProjectId });
        assert.equal(liveRun.migratedAttempts, 5);

        // Assert score preservation on every document
        for (let idx = 0; idx < testCases.length; idx++) {
            const tc = testCases[idx];
            const attemptId = `attempt_score_preservation_${idx}`;
            const res = await UniversalFirestoreService.getDocument("mockResults", attemptId);

            assert.equal(res.totalScore, tc.score);
            assert.equal(res.breakdown.length, tc.breakdown.length);
            for (let bIdx = 0; bIdx < tc.breakdown.length; bIdx++) {
                assert.equal(res.breakdown[bIdx].marksAwarded, tc.breakdown[bIdx].marksAwarded);
            }
        }
    });

    // -------------------------------------------------------------------------
    // Scenario 12: Partial batch failure -> atomic chunk safety verified
    // -------------------------------------------------------------------------
    test("Scenario 12: Precondition failure on one item aborts the chunk atomically without partial writes", async () => {
        const testId = "test_atomic_chunk";
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "jee-main",
            year: 2024
        });

        // Item 1: Valid attempt
        await UniversalFirestoreService.setDocument("mockAttempts", "att_chunk_01", {
            attemptId: "att_chunk_01",
            testId,
            userId: "student_chunk_01",
            status: "submitted"
        });
        await UniversalFirestoreService.setDocument("mockResults", "att_chunk_01", {
            resultId: "att_chunk_01",
            attemptId: "att_chunk_01",
            testId,
            userId: "student_chunk_01",
            totalScore: 4,
            breakdown: [{ questionId: "q1", marksAwarded: 4, sectionId: "math_a" }]
        });

        // Item 2: Valid attempt initially
        await UniversalFirestoreService.setDocument("mockAttempts", "att_chunk_02", {
            attemptId: "att_chunk_02",
            testId,
            userId: "student_chunk_02",
            status: "submitted"
        });
        await UniversalFirestoreService.setDocument("mockResults", "att_chunk_02", {
            resultId: "att_chunk_02",
            attemptId: "att_chunk_02",
            testId,
            userId: "student_chunk_02",
            totalScore: 4,
            breakdown: [{ questionId: "q1", marksAwarded: 4, sectionId: "math_a" }]
        });

        const doc1 = await UniversalFirestoreService.getDocument("mockAttempts", "att_chunk_01");
        const doc2 = await UniversalFirestoreService.getDocument("mockAttempts", "att_chunk_02");

        // Corrupt doc2 updateTime so batch write fails
        const corruptedDoc2 = { ...doc2, _updateTime: "1999-01-01T00:00:00.000Z" };

        await assert.rejects(
            async () => {
                await HistoricalAttemptMigrationService.executeBatchMigration({
                    batchSize: 2,
                    allowWrites: true,
                    attempts: [doc1, corruptedDoc2],
                    targetProjectId
                });
            },
            /precondition|updateTime mismatch/i
        );

        // Verify that Item 1 was NOT updated in Firestore (chunk rolled back atomically)
        const checkDoc1 = await UniversalFirestoreService.getDocument("mockAttempts", "att_chunk_01");
        assert.equal(checkDoc1.schemaVersion, undefined, "Item 1 must NOT be partially updated if batch chunk fails");
    });
});

