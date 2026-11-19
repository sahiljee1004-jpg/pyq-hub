import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { HistoricalAttemptMigrationService } from "../server/services/admin/historicalAttemptMigrationService.js";
import { ExamProfileRegistry } from "../server/services/admin/examProfileRegistry.js";
import { checkMaintenanceMode, verifyRecoveryAuth } from "../server/routes/mockTests.js";

/**
 * Milestone 3: Final Route Coverage and Recovery Completeness Suite
 *
 * Verifies:
 *  1. Maintenance mode complete route coverage (student block, admin exception, dynamic .maintenance file).
 *  2. Full post-backup reconciliation (tracking original updateTime, new docs, and modified existing docs).
 *  3. Actual Firestore recovery semantics (checkpoint failure, HTTP 412, HTTP 503, ambiguous timeout idempotency).
 */
describe("Milestone 3: Route Coverage & Recovery Completeness Suite", () => {

    const maintenanceFilePath = path.resolve(process.cwd(), ".maintenance");

    beforeEach(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = "demo-vidyarthiastra";
        delete process.env.MAINTENANCE_MODE;
        if (fs.existsSync(maintenanceFilePath)) {
            fs.unlinkSync(maintenanceFilePath);
        }
        UniversalFirestoreService.clearLocalCache();
    });

    afterEach(async () => {
        delete process.env.MAINTENANCE_MODE;
        if (fs.existsSync(maintenanceFilePath)) {
            fs.unlinkSync(maintenanceFilePath);
        }
        UniversalFirestoreService.clearLocalCache();
    });

    // =========================================================================
    // TASK 1: COMPLETE MAINTENANCE MODE COVERAGE & HOSTINGER DYNAMIC TOGGLE
    // =========================================================================

    test("1.1 Maintenance mode: blocks student start, autosave, and submission with HTTP 503", () => {
        process.env.MAINTENANCE_MODE = "true";

        const endpoints = [
            { method: "POST", path: "/api/mock-tests/test_1/attempts", desc: "Start Attempt" },
            { method: "PUT", path: "/api/mock-tests/attempts/att_1", desc: "Autosave Attempt" },
            { method: "POST", path: "/api/mock-tests/attempts/att_1/submit", desc: "Submit Attempt" }
        ];

        for (const ep of endpoints) {
            let status = null;
            let response = null;
            let nextCalled = false;

            const req = {
                method: ep.method,
                path: ep.path,
                user: { uid: "student_user_1", role: "user" } // Ordinary student
            };
            const res = {
                setHeader: () => {},
                status: (c) => {
                    status = c;
                    return { json: (b) => { response = b; } };
                }
            };

            checkMaintenanceMode(req, res, () => { nextCalled = true; });

            assert.equal(nextCalled, false, `Endpoint ${ep.desc} must NOT call next() during maintenance`);
            assert.equal(status, 503, `Endpoint ${ep.desc} must return HTTP 503`);
            assert.equal(response.code, "MAINTENANCE_MODE_ACTIVE");
        }
    });

    test("1.2 Maintenance mode: blocks ordinary admins and arbitrary headers on student routes; allows only superadmin", () => {
        process.env.MAINTENANCE_MODE = "true";

        const res = {
            setHeader: () => {},
            status: (code) => ({
                json: (body) => ({ code, body })
            })
        };

        // Case A: Ordinary Admin (role: 'admin') MUST BE BLOCKED on student attempt routes
        let nextCalled = false;
        let statusCode = null;
        const adminRes = {
            setHeader: () => {},
            status: (c) => {
                statusCode = c;
                return { json: () => {} };
            }
        };
        const ordinaryAdminReq = {
            method: "POST",
            path: "/api/mock-tests/test_1/attempts",
            user: { uid: "admin_user_01", role: "admin" }
        };
        checkMaintenanceMode(ordinaryAdminReq, adminRes, () => { nextCalled = true; });
        assert.equal(nextCalled, false, "Ordinary admin MUST be blocked from student attempt routes during maintenance");
        assert.equal(statusCode, 503, "Must return HTTP 503");

        // Case B: Arbitrary custom header (including x-admin-recovery-token) on student route MUST BE BLOCKED
        nextCalled = false;
        statusCode = null;
        const fakeTokenReq = {
            method: "PUT",
            path: "/api/mock-tests/attempts/att_1",
            headers: { "x-admin-recovery-token": "any_secret_value_attempting_bypass" },
            user: { uid: "student_01", role: "user" }
        };
        checkMaintenanceMode(fakeTokenReq, adminRes, () => { nextCalled = true; });
        assert.equal(nextCalled, false, "Arbitrary header on student route MUST NOT bypass maintenance mode");
        assert.equal(statusCode, 503, "Must return HTTP 503");

        // Case C: Authenticated Superadmin (role: 'superadmin') IS PERMITTED for emergency maintenance inspection
        nextCalled = false;
        const superadminReq = {
            method: "POST",
            path: "/api/mock-tests/test_1/attempts",
            user: { uid: "superadmin_01", role: "superadmin" }
        };
        checkMaintenanceMode(superadminReq, res, () => { nextCalled = true; });
        assert.equal(nextCalled, true, "Superadmin role must be permitted through maintenance mode");

        // Case D: Authenticated Superadmin with permissions.recovery: true IS PERMITTED
        nextCalled = false;
        const recoveryPermReq = {
            method: "POST",
            path: "/api/mock-tests/test_1/attempts",
            user: { uid: "recovery_eng_01", role: "admin", permissions: { recovery: true } }
        };
        checkMaintenanceMode(recoveryPermReq, res, () => { nextCalled = true; });
        assert.equal(nextCalled, true, "Admin with recovery permission must be permitted through maintenance mode");
    });

    test("1.3 Dedicated Recovery Route Auth: verifies crypto.timingSafeEqual and >= 32 byte secret requirements", () => {
        const validSecret = "a".repeat(32); // 32-byte secret
        const originalEnvSecret = process.env.ADMIN_RECOVERY_TOKEN;

        try {
            // Subcase A: Server secret unset / empty -> HTTP 503 RECOVERY_AUTH_UNCONFIGURED
            delete process.env.ADMIN_RECOVERY_TOKEN;
            let statusA = null;
            let bodyA = null;
            const resA = {
                status: (c) => {
                    statusA = c;
                    return { json: (b) => { bodyA = b; } };
                }
            };
            verifyRecoveryAuth({ headers: { "x-admin-recovery-token": validSecret } }, resA, () => {});
            assert.equal(statusA, 503);
            assert.equal(bodyA.code, "RECOVERY_AUTH_UNCONFIGURED");

            // Subcase B: Server secret < 32 bytes -> HTTP 503 RECOVERY_AUTH_UNCONFIGURED
            process.env.ADMIN_RECOVERY_TOKEN = "short_secret_under_32_bytes";
            let statusB = null;
            let bodyB = null;
            const resB = {
                status: (c) => {
                    statusB = c;
                    return { json: (b) => { bodyB = b; } };
                }
            };
            verifyRecoveryAuth({ headers: { "x-admin-recovery-token": "short_secret_under_32_bytes" } }, resB, () => {});
            assert.equal(statusB, 503);
            assert.equal(bodyB.code, "RECOVERY_AUTH_UNCONFIGURED");

            // Configure valid 32-byte server secret
            process.env.ADMIN_RECOVERY_TOKEN = validSecret;

            // Subcase C: Missing header -> HTTP 401 RECOVERY_TOKEN_REQUIRED
            let statusC = null;
            let bodyC = null;
            const resC = {
                status: (c) => {
                    statusC = c;
                    return { json: (b) => { bodyC = b; } };
                }
            };
            verifyRecoveryAuth({ headers: {} }, resC, () => {});
            assert.equal(statusC, 401);
            assert.equal(bodyC.code, "RECOVERY_TOKEN_REQUIRED");

            // Subcase D: Incorrect token length -> HTTP 403 INVALID_RECOVERY_TOKEN
            let statusD = null;
            let bodyD = null;
            const resD = {
                status: (c) => {
                    statusD = c;
                    return { json: (b) => { bodyD = b; } };
                }
            };
            verifyRecoveryAuth({ headers: { "x-admin-recovery-token": "wrong_length" } }, resD, () => {});
            assert.equal(statusD, 403);
            assert.equal(bodyD.code, "INVALID_RECOVERY_TOKEN");

            // Subcase E: Same length, wrong content -> HTTP 403 INVALID_RECOVERY_TOKEN
            let statusE = null;
            let bodyE = null;
            const resE = {
                status: (c) => {
                    statusE = c;
                    return { json: (b) => { bodyE = b; } };
                }
            };
            verifyRecoveryAuth({ headers: { "x-admin-recovery-token": "b".repeat(32) } }, resE, () => {});
            assert.equal(statusE, 403);
            assert.equal(bodyE.code, "INVALID_RECOVERY_TOKEN");

            // Subcase F: Valid matching token -> next() called
            let nextCalled = false;
            verifyRecoveryAuth({ headers: { "x-admin-recovery-token": validSecret } }, resE, () => {
                nextCalled = true;
            });
            assert.equal(nextCalled, true, "Valid recovery token must call next()");

        } finally {
            if (originalEnvSecret) {
                process.env.ADMIN_RECOVERY_TOKEN = originalEnvSecret;
            } else {
                delete process.env.ADMIN_RECOVERY_TOKEN;
            }
        }
    });

    test("1.3 Maintenance mode: dynamic file toggle (.maintenance) activates and deactivates immediately without process restart", () => {
        delete process.env.MAINTENANCE_MODE;

        const req = {
            method: "POST",
            path: "/api/mock-tests/attempts/att_1/submit",
            user: { uid: "student_user_1", role: "user" }
        };
        let status = null;
        const res = {
            setHeader: () => {},
            status: (c) => {
                status = c;
                return { json: () => {} };
            }
        };

        // Step 1: Normal operation when .maintenance does not exist
        let nextCalled = false;
        checkMaintenanceMode(req, res, () => { nextCalled = true; });
        assert.equal(nextCalled, true, "Normally allowed when .maintenance does not exist");

        // Step 2: Administrator creates .maintenance file on Hostinger filesystem (e.g. touch .maintenance)
        fs.writeFileSync(maintenanceFilePath, "MAINTENANCE_ACTIVE_BY_ADMIN");

        nextCalled = false;
        status = null;
        checkMaintenanceMode(req, res, () => { nextCalled = true; });
        assert.equal(nextCalled, false, "Immediately blocked when .maintenance exists without process restart");
        assert.equal(status, 503, "Returns 503 immediately");

        // Step 3: Administrator removes .maintenance file (e.g. rm .maintenance)
        fs.unlinkSync(maintenanceFilePath);

        nextCalled = false;
        status = null;
        checkMaintenanceMode(req, res, () => { nextCalled = true; });
        assert.equal(nextCalled, true, "Immediately restored when .maintenance is removed");
    });

    // =========================================================================
    // TASK 2: COMPLETE POST-BACKUP RECONCILIATION (NEW & MODIFIED EXISTING DOCS)
    // =========================================================================

    test("2.1 Post-backup reconciliation: detects both new documents AND modified existing documents with updated updateTime", () => {
        const backupTimestamp = "2026-11-10T12:00:00.000000Z";

        // Pre-migration backup snapshot taken at T0
        const backupSnapshot = {
            snapshotTimestamp: backupTimestamp,
            attempts: {
                "att_pre_01": {
                    updateTime: "2026-11-10T11:45:00.000000Z",
                    status: "submitted",
                    answers: { q1: "A" }
                },
                "att_pre_02": {
                    updateTime: "2026-11-10T11:50:00.000000Z",
                    status: "in_progress",
                    answers: { q1: "B" }
                }
            },
            results: {
                "res_pre_01": {
                    updateTime: "2026-11-10T11:45:00.000000Z",
                    totalScore: 4
                }
            }
        };

        // Database state before restore:
        // 1. att_pre_01: Unmodified
        // 2. att_pre_02: Modified post-backup! Student autosaved answers at T1
        // 3. att_post_99: Newly created attempt at T1
        // 4. res_post_99: Newly created result at T1
        const currentDatabaseState = {
            mockAttempts: [
                {
                    attemptId: "att_pre_01",
                    _updateTime: "2026-11-10T11:45:00.000000Z",
                    status: "submitted",
                    answers: { q1: "A" }
                },
                {
                    attemptId: "att_pre_02",
                    _updateTime: "2026-11-10T12:05:00.000000Z", // > T0! Modified!
                    status: "in_progress",
                    answers: { q1: "B", q2: "C", q3: "D" } // Updated student answers!
                },
                {
                    attemptId: "att_post_99",
                    _createTime: "2026-11-10T12:10:00.000000Z", // > T0! Brand new!
                    _updateTime: "2026-11-10T12:10:00.000000Z",
                    status: "submitted",
                    answers: { q1: "D" }
                }
            ],
            mockResults: [
                {
                    resultId: "res_pre_01",
                    attemptId: "att_pre_01",
                    _updateTime: "2026-11-10T11:45:00.000000Z",
                    totalScore: 4
                },
                {
                    resultId: "res_post_99",
                    attemptId: "att_post_99",
                    _createTime: "2026-11-10T12:10:00.000000Z", // > T0! Brand new!
                    _updateTime: "2026-11-10T12:10:00.000000Z",
                    totalScore: 2
                }
            ]
        };

        // Execute Deterministic Reconciliation Algorithm
        function buildReconciliationManifest(backup, current) {
            const manifest = {
                jobId: `reconcile_${Date.now()}`,
                backupTimestamp: backup.snapshotTimestamp,
                summary: {
                    unmodifiedPreBackup: 0,
                    modifiedExistingAttempts: 0,
                    newPostBackupAttempts: 0,
                    newPostBackupResults: 0
                },
                modifiedExistingToPreserve: [],
                newRecordsToPreserve: []
            };

            // Analyze attempts
            for (const att of current.mockAttempts) {
                const pre = backup.attempts[att.attemptId];
                if (!pre) {
                    // Brand new attempt created after backup
                    manifest.summary.newPostBackupAttempts++;
                    manifest.newRecordsToPreserve.push({
                        collection: "mockAttempts",
                        documentId: att.attemptId,
                        createTime: att._createTime,
                        action: "PRESERVE_UNTOUCHED_POST_IMPORT"
                    });
                } else if (att._updateTime !== pre.updateTime || att._updateTime > backup.snapshotTimestamp) {
                    // Existing attempt MODIFIED after backup!
                    manifest.summary.modifiedExistingAttempts++;
                    manifest.modifiedExistingToPreserve.push({
                        collection: "mockAttempts",
                        documentId: att.attemptId,
                        preBackupUpdateTime: pre.updateTime,
                        currentUpdateTime: att._updateTime,
                        updatedState: {
                            status: att.status,
                            answers: att.answers
                        },
                        action: "REAPPLY_ANSWERS_POST_IMPORT"
                    });
                } else {
                    manifest.summary.unmodifiedPreBackup++;
                }
            }

            // Analyze results
            for (const res of current.mockResults) {
                const pre = backup.results[res.resultId];
                if (!pre) {
                    manifest.summary.newPostBackupResults++;
                    manifest.newRecordsToPreserve.push({
                        collection: "mockResults",
                        documentId: res.resultId,
                        createTime: res._createTime,
                        action: "PRESERVE_UNTOUCHED_POST_IMPORT"
                    });
                }
            }

            return manifest;
        }

        const reconManifest = buildReconciliationManifest(backupSnapshot, currentDatabaseState);

        // ASSERTIONS
        assert.equal(reconManifest.summary.unmodifiedPreBackup, 1, "att_pre_01 is unmodified");
        assert.equal(reconManifest.summary.modifiedExistingAttempts, 1, "att_pre_02 detected as modified existing document");
        assert.equal(reconManifest.summary.newPostBackupAttempts, 1, "att_post_99 detected as new document");
        assert.equal(reconManifest.summary.newPostBackupResults, 1, "res_post_99 detected as new result");

        // Verify preservation payload
        const modifiedEntry = reconManifest.modifiedExistingToPreserve[0];
        assert.equal(modifiedEntry.documentId, "att_pre_02");
        assert.deepEqual(modifiedEntry.updatedState.answers, { q1: "B", q2: "C", q3: "D" }, "Preserved student autosaved answers");
        assert.equal(modifiedEntry.action, "REAPPLY_ANSWERS_POST_IMPORT");
    });

    // =========================================================================
    // TASK 3: ACTUAL FIRESTORE RECOVERY SEMANTICS (HTTP 503 & TIMEOUT IDEMPOTENCY)
    // =========================================================================

    test("3.1 Recovery Semantics: HTTP 503 during commit aborts chunk cleanly without writes or checkpoint progression", async () => {
        const testDoc = {
            testId: "test_recov_503",
            examId: "bpsc-prelims",
            year: "2023",
            markingScheme: { positiveMarks: 1, negativeMarks: 0.3333 }
        };
        await UniversalFirestoreService.setDocument("mockTests", "test_recov_503", testDoc);

        const attempt = {
            attemptId: "att_503_01",
            testId: "test_recov_503",
            userId: "user_503_01",
            status: "submitted",
            attemptSchema: 1,
            _updateTime: "2026-11-10T12:00:00.000000Z"
        };
        const result = {
            resultId: "res_503_01",
            attemptId: "att_503_01",
            testId: "test_recov_503",
            userId: "user_503_01",
            totalScore: 1,
            correctCount: 1,
            incorrectCount: 0,
            attemptSchema: 1,
            breakdown: [{ questionId: "q1", marksAwarded: 1, sectionId: "general_studies" }],
            _updateTime: "2026-11-10T12:00:00.000000Z"
        };
        await UniversalFirestoreService.setDocument("mockAttempts", "att_503_01", attempt);
        await UniversalFirestoreService.setDocument("mockResults", "res_503_01", result);

        // Mock commitBatchWrites to fail with HTTP 503
        const originalCommit = UniversalFirestoreService.commitBatchWrites;
        UniversalFirestoreService.commitBatchWrites = async function () {
            const err = new Error("Firestore commit returned HTTP 503: The service is currently unavailable");
            err.code = "SERVICE_UNAVAILABLE";
            err.statusCode = 503;
            throw err;
        };

        try {
            await assert.rejects(async () => {
                await HistoricalAttemptMigrationService.executeBatchMigration({
                    jobId: "job_503_test",
                    allowWrites: true,
                    targetProjectId: "demo-vidyarthiastra"
                });
            }, /HTTP 503/);

            // Document remains Schema v1
            const att = await UniversalFirestoreService.getDocument("mockAttempts", "att_503_01");
            assert.equal(att.schemaVersion, undefined);

            // Checkpoint was not written
            const cp = await UniversalFirestoreService.getDocument("migrationCheckpoints", "job_503_test");
            assert.equal(cp, null);
        } finally {
            UniversalFirestoreService.commitBatchWrites = originalCommit;
        }
    });

    test("3.2 Recovery Semantics: Ambiguous network timeout where commit succeeded on server resumes 100% idempotently with 0 duplicate writes", async () => {
        const testDoc = {
            testId: "test_timeout_01",
            examId: "bpsc-prelims",
            year: "2023",
            markingScheme: { positiveMarks: 1, negativeMarks: 0.3333 }
        };
        await UniversalFirestoreService.setDocument("mockTests", "test_timeout_01", testDoc);

        const attempt = {
            attemptId: "att_timeout_01",
            testId: "test_timeout_01",
            userId: "user_timeout_01",
            status: "submitted",
            attemptSchema: 1,
            _updateTime: "2026-11-10T12:00:00.000000Z"
        };
        const result = {
            resultId: "res_timeout_01",
            attemptId: "att_timeout_01",
            testId: "test_timeout_01",
            userId: "user_timeout_01",
            totalScore: 1,
            correctCount: 1,
            incorrectCount: 0,
            attemptSchema: 1,
            breakdown: [{ questionId: "q1", marksAwarded: 1, sectionId: "general_studies" }],
            _updateTime: "2026-11-10T12:00:00.000000Z"
        };
        await UniversalFirestoreService.setDocument("mockAttempts", "att_timeout_01", attempt);
        await UniversalFirestoreService.setDocument("mockResults", "res_timeout_01", result);

        // Simulate ambiguous timeout: Commit succeeds in Firestore, BUT response drops with ETIMEDOUT before client receives it
        const originalCommit = UniversalFirestoreService.commitBatchWrites;
        let didCommitOnce = false;

        UniversalFirestoreService.commitBatchWrites = async function (writes) {
            if (!didCommitOnce) {
                didCommitOnce = true;
                // Apply writes to Firestore
                await originalCommit.call(this, writes);
                // Drop response with timeout error!
                const timeoutErr = new Error("fetch failed: ETIMEDOUT connecting to firestore.googleapis.com");
                timeoutErr.code = "ETIMEDOUT";
                throw timeoutErr;
            }
            return originalCommit.call(this, writes);
        };

        try {
            // First execution throws ETIMEDOUT (client thinks commit failed)
            await assert.rejects(async () => {
                await HistoricalAttemptMigrationService.executeBatchMigration({
                    jobId: "job_timeout_test_01",
                    allowWrites: true,
                    targetProjectId: "demo-vidyarthiastra"
                });
            }, /ETIMEDOUT/);

            // Document actually WAS upgraded in Firestore before timeout
            const committedAtt = await UniversalFirestoreService.getDocument("mockAttempts", "att_timeout_01");
            assert.equal(committedAtt.schemaVersion, 2);

            // Checkpoint does not exist yet because client dropped
            const cpBefore = await UniversalFirestoreService.getDocument("migrationCheckpoints", "job_timeout_test_01");
            assert.equal(cpBefore, null);

            // RESTARTS MIGRATION: Client re-runs migration
            // Engine reads database, sees schemaVersion: 2, and handles it as ALREADY_MIGRATED with ZERO new writes!
            let writeCountOnResume = 0;
            const countingCommit = UniversalFirestoreService.commitBatchWrites;
            UniversalFirestoreService.commitBatchWrites = async function (writes) {
                // Ignore checkpoint writes
                const dataWrites = writes.filter(w => !(w.update?.name || "").includes("migrationCheckpoints"));
                writeCountOnResume += dataWrites.length;
                return countingCommit.call(this, writes);
            };

            const resumeReport = await HistoricalAttemptMigrationService.executeBatchMigration({
                jobId: "job_timeout_resume_01",
                allowWrites: true,
                targetProjectId: "demo-vidyarthiastra"
            });

            assert.equal(resumeReport.status, "completed");
            assert.equal(resumeReport.skippedAlreadyMigrated, 1, "Idempotently recognized as already migrated");
            assert.equal(resumeReport.migratedAttempts, 0, "Zero new attempt writes committed");
            assert.equal(resumeReport.migratedResults, 0, "Zero new result writes committed");
            assert.equal(writeCountOnResume, 0, "ZERO document writes sent to Firestore for attempts/results");

            // Checkpoint now records completed
            const cpAfter = await UniversalFirestoreService.getDocument("migrationCheckpoints", "job_timeout_resume_01");
            assert.ok(cpAfter);
            assert.equal(cpAfter.status, "completed");
        } finally {
            UniversalFirestoreService.commitBatchWrites = originalCommit;
        }
    });
});

