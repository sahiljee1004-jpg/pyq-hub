import test, { describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { HistoricalAttemptMigrationService } from "../server/services/admin/historicalAttemptMigrationService.js";
import { PostBackupReconciliationService } from "../server/services/admin/postBackupReconciliationService.js";

/**
 * Milestone 3: Real Firestore Emulator Recovery & Precondition Validation Suite
 *
 * This test suite MUST run against an isolated Firestore Emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8088
 *   FIREBASE_PROJECT_ID=demo-vidyarthiastra
 *
 * It exercises:
 *  1. Real HTTP REST request serialization and Firestore response parsing.
 *  2. Real Firestore server updateTime and createTime assignment.
 *  3. Real updateTime precondition enforcement (HTTP 412 FAILED_PRECONDITION).
 *  4. Real atomic batch rejection: when 1 write fails precondition, 0 writes commit.
 *  5. Real ambiguous network timeout recovery and migration idempotency against emulator storage.
 *  6. Real PostBackupReconciliationService conflict quarantining against emulator data.
 */
describe("Firestore Emulator Recovery & Precondition Validation", () => {

    before(() => {
        // Explicitly align with the Firebase emulator project
        process.env.FIREBASE_PROJECT_ID = "demo-vidyarthiastra";

        // Assert emulator environment is configured
        assert.ok(
            process.env.FIRESTORE_EMULATOR_HOST,
            "FIRESTORE_EMULATOR_HOST must be set (e.g. 127.0.0.1:8088). Run via 'firebase emulators:exec'."
        );
        assert.equal(UniversalFirestoreService.projectId, "demo-vidyarthiastra", "Project ID must be demo-vidyarthiastra");
        console.log(`[EMULATOR TEST] Connected to Firestore Emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`);
        console.log(`[EMULATOR TEST] Effective Project ID: ${UniversalFirestoreService.projectId}`);
    });

    beforeEach(() => {
        UniversalFirestoreService.clearLocalCache();
    });

    test("1. Real Emulator REST: serializes complex types and receives server updateTime/createTime", async () => {
        const docId = `emu_type_test_${Date.now()}`;
        const payload = {
            stringVal: "UPSE_Prelims_2024",
            intVal: 150,
            doubleVal: 0.66667,
            boolVal: true,
            arrayVal: ["paper1", "paper2"],
            mapVal: {
                section: "general_studies",
                weight: 2
            }
        };

        // Write document to emulator
        await UniversalFirestoreService.setDocument("mockTests", docId, payload);

        // Clear local cache to force a genuine HTTP GET over REST from emulator
        UniversalFirestoreService.clearLocalCache();

        const fetched = await UniversalFirestoreService.getDocument("mockTests", docId);
        assert.ok(fetched, "Document must exist in emulator");
        assert.equal(fetched.stringVal, "UPSE_Prelims_2024");
        assert.equal(fetched.intVal, 150);
        assert.ok(Math.abs(fetched.doubleVal - 0.66667) < 1e-6);
        assert.equal(fetched.boolVal, true);
        assert.deepEqual(fetched.arrayVal, ["paper1", "paper2"]);
        assert.deepEqual(fetched.mapVal, { section: "general_studies", weight: 2 });

        // Assert server assigned monotonic timestamps
        assert.ok(fetched._createTime, "Server must assign _createTime");
        assert.ok(fetched._updateTime, "Server must assign _updateTime");
        assert.match(fetched._createTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        assert.match(fetched._updateTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    test("2. Real Emulator Preconditions: stale updateTime triggers HTTP 412 FAILED_PRECONDITION", async () => {
        const docId = `emu_precond_${Date.now()}`;
        
        // Write initial document -> T1
        await UniversalFirestoreService.setDocument("mockAttempts", docId, {
            attemptId: docId,
            status: "in_progress",
            counter: 1
        });

        UniversalFirestoreService.clearLocalCache();
        const docT1 = await UniversalFirestoreService.getDocument("mockAttempts", docId);
        const updateTimeT1 = docT1._updateTime;
        assert.ok(updateTimeT1, "T1 updateTime must exist");

        // Update document -> T2
        await UniversalFirestoreService.setDocument("mockAttempts", docId, {
            attemptId: docId,
            status: "in_progress",
            counter: 2
        });

        UniversalFirestoreService.clearLocalCache();
        const docT2 = await UniversalFirestoreService.getDocument("mockAttempts", docId);
        const updateTimeT2 = docT2._updateTime;
        assert.notEqual(updateTimeT1, updateTimeT2, "T2 updateTime must be newer than T1");

        // Attempt write with STALE precondition (updateTimeT1)
        await assert.rejects(async () => {
            await UniversalFirestoreService.setDocument(
                "mockAttempts",
                docId,
                { attemptId: docId, counter: 99 },
                { precondition: { updateTime: updateTimeT1 } }
            );
        }, (err) => {
            assert.ok(
                err.statusCode === 412 || err.code === "FAILED_PRECONDITION" || (err.message && err.message.includes("412")),
                `Expected HTTP 412 / FAILED_PRECONDITION from Firestore emulator, got: ${err.message}`
            );
            return true;
        });

        // Verify document was NOT modified to 99
        UniversalFirestoreService.clearLocalCache();
        const finalDoc = await UniversalFirestoreService.getDocument("mockAttempts", docId);
        assert.equal(finalDoc.counter, 2, "Document counter must remain at 2; stale write was rejected");
    });

    test("3. Real Emulator Atomic Batch Rollback: when 1 write in batch fails HTTP 412, 0 writes commit", async () => {
        const docIdGood = `emu_batch_good_${Date.now()}`;
        const docIdFail = `emu_batch_fail_${Date.now()}`;

        // Initialize docIdFail so it has a known updateTime
        await UniversalFirestoreService.setDocument("mockAttempts", docIdFail, {
            attemptId: docIdFail,
            state: "initial"
        });

        UniversalFirestoreService.clearLocalCache();
        const preFailDoc = await UniversalFirestoreService.getDocument("mockAttempts", docIdFail);
        const genuineUpdateTime = preFailDoc._updateTime;

        // Construct atomic batch:
        // Write 1: Create docIdGood (valid)
        // Write 2: Update docIdFail with deliberately incorrect updateTime precondition (fails)
        const fakeStaleTime = "2020-01-01T00:00:00.000000Z";
        const writes = [
            {
                update: {
                    name: UniversalFirestoreService.getDocumentPath("mockAttempts", docIdGood),
                    fields: UniversalFirestoreService.toFirestoreFields({
                        attemptId: docIdGood,
                        state: "should_not_commit"
                    })
                }
            },
            {
                update: {
                    name: UniversalFirestoreService.getDocumentPath("mockAttempts", docIdFail),
                    fields: UniversalFirestoreService.toFirestoreFields({
                        attemptId: docIdFail,
                        state: "corrupted_update"
                    })
                },
                currentDocument: { updateTime: fakeStaleTime } // Precondition failure!
            }
        ];

        // Send batch commit directly to emulator
        await assert.rejects(async () => {
            await UniversalFirestoreService.commitBatchWrites(writes);
        }, (err) => {
            assert.ok(
                err.statusCode === 412 || err.code === "FAILED_PRECONDITION" || (err.message && err.message.includes("412")),
                `Batch should be rejected with 412, got: ${err.message}`
            );
            return true;
        });

        // ATOMICITY VERIFICATION:
        // 1. docIdGood must NOT exist in the emulator database!
        UniversalFirestoreService.clearLocalCache();
        const goodCheck = await UniversalFirestoreService.getDocument("mockAttempts", docIdGood);
        assert.equal(goodCheck, null, "docIdGood must NOT have been created because batch failed atomically");

        // 2. docIdFail must remain in initial state
        const failCheck = await UniversalFirestoreService.getDocument("mockAttempts", docIdFail);
        assert.equal(failCheck.state, "initial", "docIdFail state must remain 'initial'");
        assert.equal(failCheck._updateTime, genuineUpdateTime, "docIdFail updateTime must remain unchanged");
    });

    test("4. Real Emulator Timeout Recovery: ambiguous timeout where emulator commits but client drops resumes with 0 duplicate writes", async () => {
        const testId = `emu_timeout_test_${Date.now()}`;
        const attId = `emu_timeout_att_${Date.now()}`;
        const resId = `emu_timeout_res_${Date.now()}`;

        // Seed legacy test, attempt, and result in Emulator
        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "bpsc-prelims",
            year: "2023",
            markingScheme: { positiveMarks: 1, negativeMarks: 0.3333 }
        });

        await UniversalFirestoreService.setDocument("mockAttempts", attId, {
            attemptId: attId,
            testId,
            userId: "student_emu_01",
            status: "submitted",
            attemptSchema: 1
        });

        await UniversalFirestoreService.setDocument("mockResults", resId, {
            resultId: resId,
            attemptId: attId,
            testId,
            userId: "student_emu_01",
            totalScore: 1,
            correctCount: 1,
            incorrectCount: 0,
            attemptSchema: 1,
            breakdown: [{ questionId: "q1", marksAwarded: 1, sectionId: "general_studies" }]
        });

        // Step 1: Hook commitBatchWrites so that it COMMITS to the emulator, but then client drops with ETIMEDOUT
        const origCommit = UniversalFirestoreService.commitBatchWrites;
        let didCommitOnce = false;
        UniversalFirestoreService.commitBatchWrites = async function (writes) {
            if (!didCommitOnce) {
                didCommitOnce = true;
                // Actually commit writes to the genuine Firestore Emulator!
                const commitResult = await origCommit.call(this, writes);
                // Simulate client network drop before checkpoint is written!
                const timeoutErr = new Error("fetch failed: ETIMEDOUT connecting to firestore.googleapis.com");
                timeoutErr.code = "ETIMEDOUT";
                throw timeoutErr;
            }
            return origCommit.call(this, writes);
        };

        try {
            await assert.rejects(async () => {
                await HistoricalAttemptMigrationService.executeBatchMigration({
                    jobId: `job_emu_timeout_${Date.now()}`,
                    allowWrites: true
                });
            }, /ETIMEDOUT/);

            // Step 2: Clear local cache to force a real GET query to the emulator!
            UniversalFirestoreService.clearLocalCache();
            const committedAtt = await UniversalFirestoreService.getDocument("mockAttempts", attId);
            assert.equal(committedAtt.schemaVersion, 2, "Attempt was actually upgraded in emulator storage before timeout");
            const updateTimeAfterCommit = committedAtt._updateTime;

            // Step 3: Resume Migration against the Emulator
            let writesSentOnResume = 0;
            UniversalFirestoreService.commitBatchWrites = async function (writes) {
                const dataWrites = writes.filter(w => !(w.update?.name || "").includes("migrationCheckpoints"));
                writesSentOnResume += dataWrites.length;
                return origCommit.call(this, writes);
            };

            const resumeReport = await HistoricalAttemptMigrationService.executeBatchMigration({
                jobId: `job_emu_resume_${Date.now()}`,
                allowWrites: true
            });

            assert.equal(resumeReport.status, "completed");
            assert.equal(resumeReport.migratedAttempts, 0, "Zero new attempt migrations on resume");
            assert.equal(resumeReport.migratedResults, 0, "Zero new result migrations on resume");
            assert.equal(writesSentOnResume, 0, "ZERO document writes sent to emulator for attempts/results");

            // Verify updateTime in emulator is completely untouched
            UniversalFirestoreService.clearLocalCache();
            const attAfterResume = await UniversalFirestoreService.getDocument("mockAttempts", attId);
            assert.equal(attAfterResume._updateTime, updateTimeAfterCommit, "Document updateTime was not mutated on resume");
        } finally {
            UniversalFirestoreService.commitBatchWrites = origCommit;
        }
    });

    test("4b. Real Emulator Checkpoint Failure: data commit succeeds in emulator but checkpoint write fails; restart resumes idempotently", async () => {
        const testId = `emu_cpfail_test_${Date.now()}`;
        const attId = `emu_cpfail_att_${Date.now()}`;
        const resId = `emu_cpfail_res_${Date.now()}`;

        await UniversalFirestoreService.setDocument("mockTests", testId, {
            testId,
            examId: "bpsc-prelims",
            year: "2023",
            markingScheme: { positiveMarks: 1, negativeMarks: 0.3333 }
        });

        await UniversalFirestoreService.setDocument("mockAttempts", attId, {
            attemptId: attId,
            testId,
            userId: "student_emu_cp",
            status: "submitted",
            attemptSchema: 1
        });

        await UniversalFirestoreService.setDocument("mockResults", resId, {
            resultId: resId,
            attemptId: attId,
            testId,
            userId: "student_emu_cp",
            totalScore: 1,
            correctCount: 1,
            incorrectCount: 0,
            attemptSchema: 1,
            breakdown: [{ questionId: "q1", marksAwarded: 1, sectionId: "general_studies" }]
        });

        const origCommit = UniversalFirestoreService.commitBatchWrites;
        let failCheckpoint = true;
        UniversalFirestoreService.commitBatchWrites = async function (writes) {
            const isCheckpoint = writes.some(w => (w.update?.name || "").includes("migrationCheckpoints"));
            if (isCheckpoint && failCheckpoint) {
                failCheckpoint = false;
                throw new Error("Simulated checkpoint write failure to Firestore (HTTP 503)");
            }
            return origCommit.call(this, writes);
        };

        try {
            const cpJobId = `job_emu_cpfail_${Date.now()}`;
            await assert.rejects(async () => {
                await HistoricalAttemptMigrationService.executeBatchMigration({
                    jobId: cpJobId,
                    allowWrites: true
                });
            }, /checkpoint write failure/);

            // Data commit succeeded on emulator
            UniversalFirestoreService.clearLocalCache();
            const committedAtt = await UniversalFirestoreService.getDocument("mockAttempts", attId);
            assert.equal(committedAtt.schemaVersion, 2, "Attempt was committed to emulator");

            // Restart migration with same jobId
            let writesSentOnResume = 0;
            UniversalFirestoreService.commitBatchWrites = async function (writes) {
                const dataWrites = writes.filter(w => !(w.update?.name || "").includes("migrationCheckpoints"));
                writesSentOnResume += dataWrites.length;
                return origCommit.call(this, writes);
            };

            const resumeReport = await HistoricalAttemptMigrationService.executeBatchMigration({
                jobId: cpJobId,
                allowWrites: true
            });

            assert.equal(resumeReport.status, "completed");
            assert.equal(resumeReport.migratedAttempts, 0, "Zero new attempt migrations on restart");
            assert.equal(writesSentOnResume, 0, "ZERO data writes sent to emulator");

            // Verify checkpoint was now written to emulator
            UniversalFirestoreService.clearLocalCache();
            const finalCp = await UniversalFirestoreService.getDocument("migrationCheckpoints", cpJobId);
            assert.ok(finalCp, "Checkpoint document exists in emulator");
            assert.equal(finalCp.status, "completed");
        } finally {
            UniversalFirestoreService.commitBatchWrites = origCommit;
        }
    });

    test("5. Real Emulator Post-Backup Reconciliation: detects conflicts when student updates document after manifest", async () => {
        const attId = `emu_recon_${Date.now()}`;

        // Student attempt exists in emulator -> T1
        await UniversalFirestoreService.setDocument("mockAttempts", attId, {
            attemptId: attId,
            status: "in_progress",
            answers: { q1: "A" }
        });

        UniversalFirestoreService.clearLocalCache();
        const docT1 = await UniversalFirestoreService.getDocument("mockAttempts", attId);
        const updateTimeT1 = docT1._updateTime;

        // Reconciliation manifest captures T1 state
        const manifest = {
            jobId: `recon_emu_${Date.now()}`,
            items: [
                {
                    collection: "mockAttempts",
                    documentId: attId,
                    action: "REAPPLY_ATTEMPT_STATE",
                    reconcileCapturedUpdateTime: updateTimeT1,
                    capturedState: {
                        attemptId: attId,
                        status: "in_progress",
                        answers: { q1: "A" }
                    }
                }
            ]
        };

        // Student makes progress and autosaves -> T2 in emulator (T2 > T1)
        await UniversalFirestoreService.setDocument("mockAttempts", attId, {
            attemptId: attId,
            status: "submitted",
            answers: { q1: "A", q2: "B", q3: "C" }
        });

        UniversalFirestoreService.clearLocalCache();
        const docT2 = await UniversalFirestoreService.getDocument("mockAttempts", attId);
        assert.notEqual(docT2._updateTime, updateTimeT1, "T2 must be newer than T1");

        // Attempt reconciliation reapplication targeting T1
        const reconReport = await PostBackupReconciliationService.executeReconciliation({
            manifest,
            allowWrites: true,
            targetEnvironment: "staging"
        });

        // Verify quarantine conflict detected
        assert.equal(reconReport.quarantinedCount, 1, "Must quarantine conflict");
        assert.equal(reconReport.appliedCount, 0, "Must NOT overwrite newer student data");
        assert.equal(reconReport.conflicts[0].reason, "DOCUMENT_MODIFIED_SINCE_RECONCILIATION_MANIFEST");

        // Verify student's T2 answers were NOT overwritten in emulator
        UniversalFirestoreService.clearLocalCache();
        const docCheck = await UniversalFirestoreService.getDocument("mockAttempts", attId);
        assert.equal(docCheck.status, "submitted");
        assert.deepEqual(docCheck.answers, { q1: "A", q2: "B", q3: "C" });
    });

    test("8. Real Emulator Deeply Nested Subcollections: discovers, purges recursively, and verifies emptiness across 3+ levels", async () => {
        const rootDocId = `emu_nested_root_${Date.now()}`;
        const rootCol = "mockTests";
        const rootDocPath = `${rootCol}/${rootDocId}`;

        // 1. Create 3 levels of nested subcollections in the real Firestore Emulator:
        // Level 0: mockTests/emu_nested_root_...
        // Level 1: mockTests/emu_nested_root_.../sections/sec_emu_1
        // Level 2: mockTests/emu_nested_root_.../sections/sec_emu_1/questions/q_emu_1
        // Level 3: mockTests/emu_nested_root_.../sections/sec_emu_1/questions/q_emu_1/auditHistory/hist_emu_1
        await UniversalFirestoreService.setDocument(rootCol, rootDocId, { title: "Root Emu Test" });
        await UniversalFirestoreService.setDocument(`${rootDocPath}/sections`, "sec_emu_1", { name: "Section 1" });
        await UniversalFirestoreService.setDocument(`${rootDocPath}/sections/sec_emu_1/questions`, "q_emu_1", { prompt: "Question 1" });
        await UniversalFirestoreService.setDocument(`${rootDocPath}/sections/sec_emu_1/questions/q_emu_1/auditHistory`, "hist_emu_1", { action: "created" });

        // Force genuine emulator query
        UniversalFirestoreService.clearLocalCache();

        // 2. Verify subcollection discovery at each level in emulator
        const subColsL0 = await UniversalFirestoreService.listSubcollectionIds(rootDocPath);
        assert.ok(subColsL0.includes("sections"), "L0 must discover 'sections'");

        const subColsL1 = await UniversalFirestoreService.listSubcollectionIds(`${rootDocPath}/sections/sec_emu_1`);
        assert.ok(subColsL1.includes("questions"), "L1 must discover 'questions'");

        const subColsL2 = await UniversalFirestoreService.listSubcollectionIds(`${rootDocPath}/sections/sec_emu_1/questions/q_emu_1`);
        assert.ok(subColsL2.includes("auditHistory"), "L2 must discover 'auditHistory'");

        // 3. Test failure propagation: simulated disruption during deepest deletion aborts parent deletion
        const origDelete = UniversalFirestoreService.deleteDocument;
        try {
            UniversalFirestoreService.deleteDocument = async (col, id) => {
                if (id === "hist_emu_1") {
                    throw new Error("EMULATOR_LEVEL_3_SIMULATED_DELETION_FAILURE");
                }
                return origDelete.call(UniversalFirestoreService, col, id);
            };

            await assert.rejects(async () => {
                await UniversalFirestoreService.deleteDocumentAndSubcollections(rootCol, rootDocId);
            }, /EMULATOR_LEVEL_3_SIMULATED_DELETION_FAILURE/);

            // Proves parent documents survived in emulator
            UniversalFirestoreService.clearLocalCache();
            const parentSurvives = await UniversalFirestoreService.getDocument(rootCol, rootDocId);
            assert.ok(parentSurvives !== null, "Parent document must remain untouched in emulator when child deletion fails");

        } finally {
            UniversalFirestoreService.deleteDocument = origDelete;
        }

        // 4. Now execute clean recursive purge across all levels in emulator
        await UniversalFirestoreService.deleteDocumentAndSubcollections(rootCol, rootDocId);

        // 5. Verify all levels are completely purged from the emulator
        UniversalFirestoreService.clearLocalCache();
        assert.equal(await UniversalFirestoreService.getDocument(rootCol, rootDocId), null);
        assert.equal(await UniversalFirestoreService.getDocument(`${rootDocPath}/sections`, "sec_emu_1"), null);
        assert.equal(await UniversalFirestoreService.getDocument(`${rootDocPath}/sections/sec_emu_1/questions`, "q_emu_1"), null);
        assert.equal(await UniversalFirestoreService.getDocument(`${rootDocPath}/sections/sec_emu_1/questions/q_emu_1/auditHistory`, "hist_emu_1"), null);

        // Verify subcollection endpoints report empty
        const remainingSubCols = await UniversalFirestoreService.listSubcollectionIds(rootDocPath);
        assert.equal(remainingSubCols.length, 0, "No subcollections must remain under purged document");
    });

    after(async () => {
        try {
            UniversalFirestoreService.clearLocalCache();
        } catch (_) {}
    });
});
