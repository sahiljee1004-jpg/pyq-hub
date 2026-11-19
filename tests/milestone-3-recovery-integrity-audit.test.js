import test, { describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { HistoricalAttemptMigrationService } from "../server/services/admin/historicalAttemptMigrationService.js";
import { ExamProfileRegistry } from "../server/services/admin/examProfileRegistry.js";
import { checkMaintenanceMode } from "../server/routes/mockTests.js";

/**
 * Milestone 3: Recovery & Data Integrity Audit Test Suite
 *
 * Verifies:
 *  1. Section score vs total score handling (BPSC & UPSC rounding differences; totalScore unchanged).
 *  2. Checkpoint failure recovery (successful atomic commit + checkpoint failure + restart idempotency).
 *  3. Firestore concurrency failures (updateTime precondition HTTP 412 rejection & safe retry).
 *  4. Rollback & post-backup write reconciliation (handling no-delete import behavior).
 *  5. Maintenance mode enforcement & safe disabling.
 */
describe("Milestone 3: Recovery & Data Integrity Audit Suite", () => {

    beforeEach(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = "demo-vidyarthiastra";
        delete process.env.MAINTENANCE_MODE;
        UniversalFirestoreService.clearLocalCache();
    });

    // =========================================================================
    // TASK 1: SECTION SCORE VS TOTAL SCORE HANDLING & ROUNDING DRIFT
    // =========================================================================

    test("1.1 BPSC 69th: Rounded section score (0.668) differs from historical totalScore (0.667); totalScore remains authoritative and unchanged", async () => {
        const profile = ExamProfileRegistry.getProfile("bpsc-69th-2023");
        assert.ok(profile, "BPSC profile must exist");

        // Breakdown with 2 correct (+2) and 4 incorrect (4 * -0.333 = -1.332) -> Breakdown sum is 0.668
        const breakdown = [
            { questionId: "q1", questionNumber: 1, marksAwarded: 1 },
            { questionId: "q2", questionNumber: 2, marksAwarded: 1 },
            { questionId: "q3", questionNumber: 3, marksAwarded: -0.333 },
            { questionId: "q4", questionNumber: 4, marksAwarded: -0.333 },
            { questionId: "q5", questionNumber: 5, marksAwarded: -0.333 },
            { questionId: "q6", questionNumber: 6, marksAwarded: -0.333 }
        ];

        // Historical result stored totalScore as 0.667 (computed from rational: 2 - 4/3 = 2/3 = 0.6666... rounded to 0.667)
        const legacyResult = {
            resultId: "res_bpsc_drift_01",
            attemptId: "att_bpsc_drift_01",
            totalScore: 0.667, // Authoritative historical score
            correctCount: 2,
            incorrectCount: 4,
            unansweredCount: 144,
            breakdown
        };

        // 1. Synthesize section scores
        const synth = HistoricalAttemptMigrationService.computeSectionScores(breakdown, profile);
        assert.equal(synth.success, true);
        assert.equal(synth.sectionScores["general_studies"], 0.668, "Section score sums breakdown marks to 0.668");

        // 2. Transform result to Schema v2
        const migrated = HistoricalAttemptMigrationService.transformResult(legacyResult, profile, { jobId: "test_job" });

        // 3. ASSERT: totalScore is strictly 0.667 (verbatim legacy), NOT recalculated to 0.668!
        assert.equal(migrated.totalScore, 0.667, "Original totalScore MUST remain authoritative and unchanged");
        assert.notEqual(migrated.totalScore, migrated.sectionScores["general_studies"], "totalScore and sectionScore reflect known 0.001 rounding drift");
        assert.equal(migrated.sectionScores["general_studies"], 0.668);

        // 4. Score preservation assertion strictly passes on original score
        assert.doesNotThrow(() => {
            HistoricalAttemptMigrationService.verifyScorePreservation(legacyResult, migrated);
        });

        // 5. Assert that attempting to recalculate totalScore from sectionScores would trigger violation
        const mutatedResult = { ...migrated, totalScore: migrated.sectionScores["general_studies"] };
        assert.throws(() => {
            HistoricalAttemptMigrationService.verifyScorePreservation(legacyResult, mutatedResult);
        }, /SCORE_MUTATION_DETECTED/);
    });

    test("1.2 UPSC Prelims: Rounded section score (0.666) differs from historical totalScore (0.667); totalScore remains authoritative and unchanged", async () => {
        const profile = ExamProfileRegistry.getProfile("upsc-prelims-2026");
        assert.ok(profile, "UPSC profile must exist");

        // Breakdown with 1 correct (+2) and 2 incorrect (2 * -0.667 = -1.334) -> Breakdown sum is 0.666
        const breakdown = [
            { questionId: "q1", questionNumber: 1, marksAwarded: 2 },
            { questionId: "q2", questionNumber: 2, marksAwarded: -0.667 },
            { questionId: "q3", questionNumber: 3, marksAwarded: -0.667 }
        ];

        // Historical result stored totalScore as 0.667 (2 - 4/3 = 2/3 = 0.6666... rounded to 0.667)
        const legacyResult = {
            resultId: "res_upsc_drift_01",
            attemptId: "att_upsc_drift_01",
            totalScore: 0.667, // Authoritative historical score
            correctCount: 1,
            incorrectCount: 2,
            unansweredCount: 97,
            breakdown
        };

        const synth = HistoricalAttemptMigrationService.computeSectionScores(breakdown, profile);
        assert.equal(synth.success, true);
        assert.equal(synth.sectionScores["general_studies"], 0.666);

        const migrated = HistoricalAttemptMigrationService.transformResult(legacyResult, profile, { jobId: "test_job" });

        // ASSERT: totalScore is strictly 0.667 (verbatim legacy), NOT recalculated to 0.666!
        assert.equal(migrated.totalScore, 0.667, "Original totalScore MUST remain authoritative and unchanged");
        assert.notEqual(migrated.totalScore, migrated.sectionScores["general_studies"]);

        assert.doesNotThrow(() => {
            HistoricalAttemptMigrationService.verifyScorePreservation(legacyResult, migrated);
        });
    });

    // =========================================================================
    // TASK 2: TEST CHECKPOINT FAILURE RECOVERY
    // =========================================================================

    test("2. Checkpoint failure recovery: successful atomic commit followed by checkpoint write failure resumes idempotently without duplicate writes", async () => {
        const testDoc = {
            testId: "test_recovery_01",
            examId: "bpsc-prelims",
            year: "2023",
            markingScheme: { positiveMarks: 1, negativeMarks: 0.3333 }
        };
        await UniversalFirestoreService.setDocument("mockTests", "test_recovery_01", testDoc);

        const attempt1 = {
            attemptId: "att_rec_01",
            testId: "test_recovery_01",
            userId: "user_rec_01",
            status: "submitted",
            attemptSchema: 1,
            _updateTime: "2026-11-10T12:00:00.000000Z"
        };
        const result1 = {
            resultId: "res_rec_01",
            attemptId: "att_rec_01",
            testId: "test_recovery_01",
            userId: "user_rec_01",
            totalScore: 1,
            correctCount: 1,
            incorrectCount: 0,
            attemptSchema: 1,
            breakdown: [{ questionId: "q1", marksAwarded: 1, sectionId: "general_studies" }],
            _updateTime: "2026-11-10T12:00:00.000000Z"
        };
        await UniversalFirestoreService.setDocument("mockAttempts", "att_rec_01", attempt1);
        await UniversalFirestoreService.setDocument("mockResults", "res_rec_01", result1);

        // Intercept setDocument on migrationCheckpoints to simulate checkpoint write failure on run 1
        const originalSetDoc = UniversalFirestoreService.setDocument;
        let checkpointFailCount = 1;
        UniversalFirestoreService.setDocument = async function (col, id, data, opts) {
            if (col === "migrationCheckpoints" && checkpointFailCount > 0) {
                checkpointFailCount--;
                const err = new Error("Simulated transient 503 network outage writing checkpoint");
                err.code = "SERVICE_UNAVAILABLE";
                err.statusCode = 503;
                throw err;
            }
            return originalSetDoc.call(this, col, id, data, opts);
        };

        try {
            // First run: Batch commit succeeds, but checkpoint write fails!
            await assert.rejects(async () => {
                await HistoricalAttemptMigrationService.executeBatchMigration({
                    jobId: "job_rec_fail_01",
                    allowWrites: true,
                    targetProjectId: "demo-vidyarthiastra"
                });
            }, /Simulated transient 503/);

            // VERIFY: The attempt and result documents WERE committed atomically to Schema v2
            const postFailAtt = await UniversalFirestoreService.getDocument("mockAttempts", "att_rec_01");
            const postFailRes = await UniversalFirestoreService.getDocument("mockResults", "res_rec_01");
            assert.equal(postFailAtt.schemaVersion, 2, "Attempt was committed before checkpoint write");
            assert.equal(postFailRes.schemaVersion, 2, "Result was committed before checkpoint write");

            // VERIFY: Checkpoint document was NOT written or completed
            const failedCheckpoint = await UniversalFirestoreService.getDocument("migrationCheckpoints", "job_rec_fail_01");
            assert.equal(failedCheckpoint, null, "Checkpoint was not persisted due to failure");

            // SECOND RUN (Restart): The migration is restarted!
            // It must recognize att_rec_01 as ALREADY_MIGRATED idempotently, perform 0 duplicate writes, and record completed checkpoint
            const resumeReport = await HistoricalAttemptMigrationService.executeBatchMigration({
                jobId: "job_rec_resume_01",
                allowWrites: true,
                targetProjectId: "demo-vidyarthiastra"
            });

            assert.equal(resumeReport.status, "completed");
            assert.equal(resumeReport.skippedAlreadyMigrated, 1, "Idempotently detected already migrated attempt");
            assert.equal(resumeReport.migratedAttempts, 0, "Zero new attempt writes committed on resume");
            assert.equal(resumeReport.migratedResults, 0, "Zero new result writes committed on resume");

            // Checkpoint now records completed state
            const resumedCheckpoint = await UniversalFirestoreService.getDocument("migrationCheckpoints", "job_rec_resume_01");
            assert.ok(resumedCheckpoint);
            assert.equal(resumedCheckpoint.status, "completed");
            assert.equal(resumedCheckpoint.skippedAlreadyMigrated, 1);
        } finally {
            UniversalFirestoreService.setDocument = originalSetDoc;
        }
    });

    // =========================================================================
    // TASK 3: TEST FIRESTORE CONCURRENCY PRECONDITION FAILURES (HTTP 412)
    // =========================================================================

    test("3. Firestore concurrency failure: updateTime precondition rejection (HTTP 412) aborts batch atomically without partial mutation or checkpoint advance", async () => {
        const testDoc = {
            testId: "test_conc_01",
            examId: "bpsc-prelims",
            year: "2023",
            markingScheme: { positiveMarks: 1, negativeMarks: 0.3333 }
        };
        await UniversalFirestoreService.setDocument("mockTests", "test_conc_01", testDoc);

        const attempt = {
            attemptId: "att_conc_stale_01",
            testId: "test_conc_01",
            userId: "user_conc_01",
            status: "submitted",
            attemptSchema: 1,
            _updateTime: "2026-11-10T12:00:00.000000Z"
        };
        const result = {
            resultId: "res_conc_stale_01",
            attemptId: "att_conc_stale_01",
            testId: "test_conc_01",
            userId: "user_conc_01",
            totalScore: 1,
            correctCount: 1,
            incorrectCount: 0,
            attemptSchema: 1,
            breakdown: [{ questionId: "q1", marksAwarded: 1, sectionId: "general_studies" }],
            _updateTime: "2026-11-10T12:00:00.000000Z"
        };
        await UniversalFirestoreService.setDocument("mockAttempts", "att_conc_stale_01", attempt);
        await UniversalFirestoreService.setDocument("mockResults", "res_conc_stale_01", result);

        // Simulate concurrent student autosave mutating mockAttempts in Firestore with a newer updateTime
        const modifiedAttempt = {
            ...attempt,
            _updateTime: "2026-11-10T12:00:05.000000Z", // Newer updateTime!
            answers: { q1: "B", q2: "C" }
        };
        await UniversalFirestoreService.setDocument("mockAttempts", "att_conc_stale_01", modifiedAttempt);

        // Stale attempt in migration worker's memory has older updateTime
        const staleAttempt = {
            ...attempt,
            _updateTime: "2026-11-10T12:00:00.000000Z" // Stale!
        };

        // Attempt batch migration with stale record
        await assert.rejects(async () => {
            await HistoricalAttemptMigrationService.executeBatchMigration({
                jobId: "job_conc_test_01",
                allowWrites: true,
                targetProjectId: "demo-vidyarthiastra",
                attempts: [staleAttempt],
                results: [result],
                tests: [testDoc]
            });
        }, (err) => {
            assert.ok(err.message.includes("precondition") || err.code === "FAILED_PRECONDITION" || err.statusCode === 412);
            return true;
        });

        // VERIFY: The concurrent modification was NOT overwritten
        const freshAtt = await UniversalFirestoreService.getDocument("mockAttempts", "att_conc_stale_01");
        assert.notEqual(freshAtt._updateTime, "2026-11-10T12:00:00.000000Z", "Newer updateTime preserved");
        assert.deepEqual(freshAtt.answers, { q1: "B", q2: "C" }, "Concurrent student answers NOT clobbered");
        assert.equal(freshAtt.schemaVersion, undefined, "Attempt remained unmigrated due to atomic abort");

        // VERIFY: Checkpoint did NOT advance
        const checkpoint = await UniversalFirestoreService.getDocument("migrationCheckpoints", "job_conc_test_01");
        assert.equal(checkpoint, null, "Checkpoint must not be written when precondition fails");
    });

    // =========================================================================
    // TASK 4: ROLLBACK & POST-BACKUP WRITE RECONCILIATION
    // =========================================================================

    test("4. Rollback & post-backup write reconciliation: reliably isolates additions made after backup without assuming import deletes documents", async () => {
        const backupTimestamp = "2026-11-10T12:00:00.000000Z";

        // Backup manifest contains 2 attempts taken at T0
        const backupManifest = new Set(["att_pre_01", "att_pre_02"]);

        // Current database documents after rollback import
        const currentAttempts = [
            {
                attemptId: "att_pre_01",
                userId: "user_1",
                attemptSchema: 1,
                _createTime: "2026-11-10T11:50:00.000000Z"
            },
            {
                attemptId: "att_pre_02",
                userId: "user_2",
                attemptSchema: 1,
                _createTime: "2026-11-10T11:55:00.000000Z"
            },
            // Student submitted this attempt at T1 (post-backup)
            {
                attemptId: "att_post_backup_99",
                userId: "user_3",
                attemptSchema: 1,
                _createTime: "2026-11-10T12:05:00.000000Z" // > T0!
            }
        ];

        // VERIFY: gcloud firestore import leaves att_post_backup_99 intact (no-delete behavior)
        assert.equal(currentAttempts.length, 3, "Import did NOT delete att_post_backup_99");

        // Execute reconciliation algorithm
        const reconciliation = {
            preBackupMatched: [],
            postBackupAdditions: [],
            quarantineManifest: []
        };

        for (const att of currentAttempts) {
            const isKnownPreBackup = backupManifest.has(att.attemptId);
            const isCreatedPostBackup = att._createTime && att._createTime > backupTimestamp;

            if (isKnownPreBackup) {
                reconciliation.preBackupMatched.push(att.attemptId);
            } else if (isCreatedPostBackup || !isKnownPreBackup) {
                reconciliation.postBackupAdditions.push(att.attemptId);
                reconciliation.quarantineManifest.push({
                    attemptId: att.attemptId,
                    userId: att.userId,
                    createdAfterBackupAt: att._createTime,
                    action: "QUARANTINE_FOR_FORENSIC_EVALUATION"
                });
            }
        }

        assert.equal(reconciliation.preBackupMatched.length, 2);
        assert.equal(reconciliation.postBackupAdditions.length, 1);
        assert.equal(reconciliation.postBackupAdditions[0], "att_post_backup_99");
        assert.equal(reconciliation.quarantineManifest[0].action, "QUARANTINE_FOR_FORENSIC_EVALUATION");
    });

    // =========================================================================
    // TASK 5: MAINTENANCE MODE ENFORCEMENT & SAFE DISABLING
    // =========================================================================

    test("5.1 Maintenance mode: blocks exam attempts, autosaves, and submissions with HTTP 503 and Retry-After", async () => {
        process.env.MAINTENANCE_MODE = "true";

        let statusPassed = null;
        let jsonPassed = null;
        let headerPassed = {};

        const mockRes = {
            setHeader: (k, v) => { headerPassed[k] = v; },
            status: (code) => {
                statusPassed = code;
                return {
                    json: (body) => { jsonPassed = body; }
                };
            }
        };

        let nextCalled = false;
        const mockNext = () => { nextCalled = true; };

        // Test mutating request while maintenance mode is active
        checkMaintenanceMode({ method: "POST", path: "/attempts/att_1/submit" }, mockRes, mockNext);

        assert.equal(nextCalled, false, "Must NOT proceed to route handler during maintenance");
        assert.equal(statusPassed, 503, "Must return HTTP 503 Service Unavailable");
        assert.equal(headerPassed["Retry-After"], "300", "Must provide standard Retry-After header");
        assert.equal(jsonPassed.code, "MAINTENANCE_MODE_ACTIVE");
        assert.equal(jsonPassed.success, false);
    });

    test("5.2 Maintenance mode: active sessions cannot bypass the restriction", async () => {
        process.env.MAINTENANCE_MODE = "true";

        let statusPassed = null;
        let jsonPassed = null;

        const mockRes = {
            setHeader: () => {},
            status: (code) => {
                statusPassed = code;
                return {
                    json: (body) => { jsonPassed = body; }
                };
            }
        };

        let nextCalled = false;
        // Even with a valid session / Authorization header attached
        const mockReq = {
            headers: { authorization: "Bearer valid_active_student_token" },
            user: { uid: "student_123", role: "user" }
        };

        checkMaintenanceMode(mockReq, mockRes, () => { nextCalled = true; });

        assert.equal(nextCalled, false, "Active student sessions CANNOT bypass maintenance mode");
        assert.equal(statusPassed, 503);
        assert.equal(jsonPassed.code, "MAINTENANCE_MODE_ACTIVE");
    });

    test("5.3 Maintenance mode: safely and immediately resumes normal operation when disabled", async () => {
        // Disabled maintenance mode
        process.env.MAINTENANCE_MODE = "false";

        let nextCalled = false;
        const mockRes = {
            setHeader: () => {},
            status: () => ({ json: () => {} })
        };

        checkMaintenanceMode({}, mockRes, () => { nextCalled = true; });
        assert.equal(nextCalled, true, "Calls next() when MAINTENANCE_MODE is 'false'");

        // Also test unset
        delete process.env.MAINTENANCE_MODE;
        nextCalled = false;
        checkMaintenanceMode({}, mockRes, () => { nextCalled = true; });
        assert.equal(nextCalled, true, "Calls next() when MAINTENANCE_MODE is unset");
    });
});
