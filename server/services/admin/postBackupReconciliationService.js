import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { UniversalFirestoreService } from "./universalFirestoreService.js";
import { validateProjectIdFormat } from "../firebaseTokenService.js";

/**
 * Allowlisted staging / emulator project IDs permitted for live state reapplication.
 * Production project IDs and unlisted cloud projects are strictly forbidden.
 */
export const ALLOWED_STAGING_PROJECTS = new Set([
    "demo-vidyarthiastra",
    "staging-vidyarthiastra",
    "staging-pyqs-hub"
]);

/**
 * Post-Backup Reconciliation Service (Milestone 3)
 *
 * Responsibilities:
 * 1. Capture complete pre- and post-backup attempt & result state across all active fields:
 *    - attempts: answers, status, markedForReview, questionTimes, lastActiveQuestion,
 *                clientTimestamps, isFinalized, schemaVersion, updateTime, createTime.
 *    - results:  breakdown, totalScore, correctCount, incorrectCount, unattemptedCount,
 *                sectionScores, schemaVersion, updateTime, createTime.
 * 2. Multi-dimensional classification:
 *    - New documents created post-backup (not present in pre-backup image).
 *    - Modified existing documents (updateTime > pre-backup updateTime or state modified).
 *    - Unmodified documents (state and timestamps unchanged).
 * 3. Strict Precondition & Quarantine Handling:
 *    - Reapplication uses exact updateTime preconditions.
 *    - If target document was modified again after reconciliation manifest generation,
 *      do NOT overwrite newer student data. Quarantine and flag conflict.
 * 4. Production Execution Gate:
 *    - Refuses automatic production reapplication (throws explicit safety exception).
 *    - Requires allowWrites: true and staging environment authorization.
 */
export class PostBackupReconciliationService {

    /**
     * Build a deterministic, machine-readable reconciliation manifest
     *
     * @param {object} params
     * @param {object} params.backupSnapshot - { snapshotTimestamp, attempts, results }
     * @param {Array|object} params.currentAttempts - Array or map of current attempts in Firestore
     * @param {Array|object} params.currentResults - Array or map of current results in Firestore
     * @returns {object} Reconciliation Manifest
     */
    static buildManifest({ backupSnapshot, currentAttempts = [], currentResults = [] }) {
        if (!backupSnapshot || !backupSnapshot.snapshotTimestamp) {
            throw new Error("Invalid backupSnapshot: snapshotTimestamp is required");
        }

        const snapshotTimestamp = backupSnapshot.snapshotTimestamp;
        const backupAttemptsMap = this._normalizeToMap(backupSnapshot.attempts, "attemptId");
        const backupResultsMap = this._normalizeToMap(backupSnapshot.results, "resultId");

        const normalizedCurrentAttempts = this._normalizeToArray(currentAttempts, "attemptId");
        const normalizedCurrentResults = this._normalizeToArray(currentResults, "resultId");

        const manifest = {
            jobId: `recon_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            generatedAt: new Date().toISOString(),
            backupSnapshotTimestamp: snapshotTimestamp,
            backupSnapshotChecksum: backupSnapshot.checksum || null,
            backupExportUri: backupSnapshot.provenance?.exportUri || backupSnapshot.exportUri || null,
            summary: {
                totalCurrentAttempts: normalizedCurrentAttempts.length,
                totalCurrentResults: normalizedCurrentResults.length,
                unmodifiedPreBackup: 0,
                modifiedExistingAttempts: 0,
                modifiedExistingResults: 0,
                newPostBackupAttempts: 0,
                newPostBackupResults: 0,
                quarantinedConflicts: 0
            },
            items: []
        };

        // 1. Classify Attempts
        for (const att of normalizedCurrentAttempts) {
            const docId = att.attemptId;
            const preAtt = backupAttemptsMap.get(docId);

            if (!preAtt) {
                // New attempt created after backup was taken
                manifest.summary.newPostBackupAttempts++;
                manifest.items.push({
                    collection: "mockAttempts",
                    documentId: docId,
                    classification: "NEW_ATTEMPT_POST_BACKUP",
                    action: "PRESERVE_NEW_DOCUMENT",
                    createTime: att._createTime || null,
                    currentUpdateTime: att._updateTime || null,
                    capturedState: this._extractAttemptState(att)
                });
            } else {
                const preUpdateTime = preAtt.updateTime || preAtt._updateTime;
                const currUpdateTime = att._updateTime || att.updateTime;
                // Only genuine application document state differences constitute a modification.
                // Restored documents must NOT be classified as modified solely because server-assigned metadata differs.
                const isModified = this._hasAttemptStateChanged(preAtt, att);

                if (isModified) {
                    manifest.summary.modifiedExistingAttempts++;
                    manifest.items.push({
                        collection: "mockAttempts",
                        documentId: docId,
                        classification: "MODIFIED_EXISTING_ATTEMPT",
                        action: "REAPPLY_ATTEMPT_STATE",
                        preBackupUpdateTime: preUpdateTime,
                        reconcileCapturedUpdateTime: currUpdateTime,
                        capturedState: this._extractAttemptState(att)
                    });
                } else {
                    manifest.summary.unmodifiedPreBackup++;
                }
            }
        }

        // 2. Classify Results
        for (const res of normalizedCurrentResults) {
            const docId = res.resultId;
            const preRes = backupResultsMap.get(docId);

            if (!preRes) {
                // New result created after backup was taken
                manifest.summary.newPostBackupResults++;
                manifest.items.push({
                    collection: "mockResults",
                    documentId: docId,
                    classification: "NEW_RESULT_POST_BACKUP",
                    action: "PRESERVE_NEW_DOCUMENT",
                    createTime: res._createTime || null,
                    currentUpdateTime: res._updateTime || null,
                    capturedState: this._extractResultState(res)
                });
            } else {
                const preUpdateTime = preRes.updateTime || preRes._updateTime;
                const currUpdateTime = res._updateTime || res.updateTime;
                // Only genuine application document state differences constitute a modification.
                // Restored documents must NOT be classified as modified solely because server-assigned metadata differs.
                const isModified = this._hasResultStateChanged(preRes, res);

                if (isModified) {
                    manifest.summary.modifiedExistingResults++;
                    manifest.items.push({
                        collection: "mockResults",
                        documentId: docId,
                        classification: "MODIFIED_EXISTING_RESULT",
                        action: "REAPPLY_RESULT_STATE",
                        preBackupUpdateTime: preUpdateTime,
                        reconcileCapturedUpdateTime: currUpdateTime,
                        capturedState: this._extractResultState(res)
                    });
                } else {
                    manifest.summary.unmodifiedPreBackup++;
                }
            }
        }

        // Sort items deterministically by collection, action, documentId
        manifest.items.sort((a, b) => {
            const colComp = a.collection.localeCompare(b.collection);
            if (colComp !== 0) return colComp;
            return a.documentId.localeCompare(b.documentId);
        });

        return manifest;
    }

    /**
     * Reapply post-backup state to target environment with strict precondition & safety checks
     *
     * @param {object} params
     * @param {object} params.manifest - Output from buildManifest()
     * @param {boolean} params.allowWrites - Must be explicitly true to perform mutations
     * @param {string} params.targetEnvironment - "staging" or "local". Strictly forbids "production".
     * @returns {Promise<object>} Reapplication Execution Report
     */
    static async executeReconciliation({ manifest, allowWrites = false, targetEnvironment = "staging", targetProjectId = null, client = null }) {
        if (!manifest || !Array.isArray(manifest.items)) {
            throw new Error("Invalid manifest: items array is required");
        }

        const explicitProject = client ? client.projectId : (targetProjectId || (process.env.FIREBASE_PROJECT_ID || null));
        if (!explicitProject) {
            throw new Error("SAFETY VIOLATION: executeReconciliation requires an explicit targetProjectId or bound UniversalFirestoreClient. Ambient project execution is forbidden.");
        }
        const effectiveProjectId = validateProjectIdFormat(explicitProject, "targetProjectId");
        if (targetProjectId) {
            UniversalFirestoreService.ensureProject(targetProjectId);
        }
        const firestoreClient = client || UniversalFirestoreService.forProject(effectiveProjectId);
        const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

        // 1. ABSOLUTE PRODUCTION BLOCK: Block production reapplication regardless of CLI flags or arguments
        if (targetEnvironment === "production" || process.env.NODE_ENV === "production" || effectiveProjectId === "pyqs-hub-43bed") {
            throw new Error(`CRITICAL SAFETY VIOLATION: Automatic production state reapplication is strictly forbidden (Target: ${targetEnvironment}, Project: ${effectiveProjectId}, Emulator: ${isEmulator}). Any disaster recovery restore must follow manual operator verification.`);
        }

        // 2. LIVE WRITE ISOLATION: When allowWrites is true, require explicitly allowlisted staging project
        if (allowWrites) {
            if (!ALLOWED_STAGING_PROJECTS.has(effectiveProjectId)) {
                throw new Error(`CRITICAL SAFETY VIOLATION: Live reapplication is restricted to allowlisted staging projects (${Array.from(ALLOWED_STAGING_PROJECTS).join(", ")}). Project '${effectiveProjectId}' is not allowlisted.`);
            }

            // 3. FAIL CLOSED ON ALL REAL CLOUD PROJECTS: If not running under emulator, block real cloud writes
            if (!isEmulator && !process.env.ALLOW_STAGING_CLOUD_WRITES) {
                throw new Error(`CRITICAL SAFETY VIOLATION: Live reapplication against real cloud project '${effectiveProjectId}' is blocked without FIRESTORE_EMULATOR_HOST or ALLOW_STAGING_CLOUD_WRITES=true.`);
            }
        }

        const report = {
            jobId: manifest.jobId,
            status: allowWrites ? "completed" : "dry_run",
            executedAt: new Date().toISOString(),
            targetEnvironment,
            allowWrites,
            totalItems: manifest.items.length,
            appliedCount: 0,
            skippedCount: 0,
            quarantinedCount: 0,
            conflicts: [],
            appliedWrites: []
        };

        if (!allowWrites) {
            // Dry run: inspect documents and verify whether preconditions would hold
            for (const item of manifest.items) {
                const targetDoc = await firestoreClient.getDocument(item.collection, item.documentId);
                const dryRunItem = {
                    collection: item.collection,
                    documentId: item.documentId,
                    action: item.action,
                    simulatedResult: "WOULD_APPLY"
                };

                if (item.action === "REAPPLY_ATTEMPT_STATE" || item.action === "REAPPLY_RESULT_STATE") {
                    if (!targetDoc) {
                        dryRunItem.simulatedResult = "CONFLICT_TARGET_MISSING";
                        report.quarantinedCount++;
                        report.conflicts.push({
                            documentId: item.documentId,
                            collection: item.collection,
                            reason: "TARGET_DOCUMENT_MISSING_FOR_UPDATE"
                        });
                    } else if (targetDoc._updateTime && item.reconcileCapturedUpdateTime && targetDoc._updateTime > item.reconcileCapturedUpdateTime) {
                        dryRunItem.simulatedResult = "CONFLICT_TARGET_NEWER_THAN_MANIFEST";
                        report.quarantinedCount++;
                        report.conflicts.push({
                            documentId: item.documentId,
                            collection: item.collection,
                            reason: "TARGET_DOCUMENT_MODIFIED_SINCE_MANIFEST",
                            targetUpdateTime: targetDoc._updateTime,
                            manifestCapturedUpdateTime: item.reconcileCapturedUpdateTime
                        });
                    } else {
                        report.appliedCount++;
                    }
                } else if (item.action === "PRESERVE_NEW_DOCUMENT") {
                    if (targetDoc) {
                        dryRunItem.simulatedResult = "ALREADY_PRESENT";
                        report.skippedCount++;
                    } else {
                        report.appliedCount++;
                    }
                }
                report.appliedWrites.push(dryRunItem);
            }
            return report;
        }

        // Live execution on Staging / Local
        for (const item of manifest.items) {
            const targetDoc = await firestoreClient.getDocument(item.collection, item.documentId);

            if (item.action === "PRESERVE_NEW_DOCUMENT") {
                if (targetDoc) {
                    // Document already exists; do not overwrite
                    report.skippedCount++;
                    report.appliedWrites.push({
                        collection: item.collection,
                        documentId: item.documentId,
                        action: item.action,
                        status: "SKIPPED_ALREADY_EXISTS"
                    });
                    continue;
                }

                try {
                    await firestoreClient.setDocument(
                        item.collection,
                        item.documentId,
                        item.capturedState,
                        { createOnly: true }
                    );
                    report.appliedCount++;
                    report.appliedWrites.push({
                        collection: item.collection,
                        documentId: item.documentId,
                        action: item.action,
                        status: "CREATED_PRESERVED_DOCUMENT"
                    });
                } catch (err) {
                    report.quarantinedCount++;
                    report.conflicts.push({
                        documentId: item.documentId,
                        collection: item.collection,
                        reason: `CREATE_FAILED: ${err.message}`
                    });
                }

            } else if (item.action === "REAPPLY_ATTEMPT_STATE" || item.action === "REAPPLY_RESULT_STATE") {
                if (!targetDoc) {
                    report.quarantinedCount++;
                    report.conflicts.push({
                        documentId: item.documentId,
                        collection: item.collection,
                        reason: "TARGET_DOCUMENT_MISSING_CANNOT_REAPPLY"
                    });
                    continue;
                }

                // PRECONDITION SAFETY CHECK: Has the target document been updated since the manifest snapshot?
                if (targetDoc._updateTime && item.reconcileCapturedUpdateTime && targetDoc._updateTime > item.reconcileCapturedUpdateTime) {
                    report.quarantinedCount++;
                    report.conflicts.push({
                        documentId: item.documentId,
                        collection: item.collection,
                        reason: "DOCUMENT_MODIFIED_SINCE_RECONCILIATION_MANIFEST",
                        targetUpdateTime: targetDoc._updateTime,
                        manifestCapturedUpdateTime: item.reconcileCapturedUpdateTime
                    });
                    continue;
                }

                // Prepare atomic update with precondition
                try {
                    const precondition = targetDoc._updateTime ? { updateTime: targetDoc._updateTime } : { exists: true };
                    await firestoreClient.setDocument(
                        item.collection,
                        item.documentId,
                        item.capturedState,
                        { precondition }
                    );
                    report.appliedCount++;
                    report.appliedWrites.push({
                        collection: item.collection,
                        documentId: item.documentId,
                        action: item.action,
                        status: "REAPPLIED_STATE_WITH_PRECONDITION"
                    });
                } catch (err) {
                    report.quarantinedCount++;
                    report.conflicts.push({
                        documentId: item.documentId,
                        collection: item.collection,
                        reason: `REAPPLY_PRECONDITION_FAILED: ${err.message}`
                    });
                }
            }
        }

        if (report.quarantinedCount > 0) {
            report.status = "completed_with_quarantines";
        }

        return report;
    }

    /**
     * Extract exhaustive state from an attempt document, preserving ALL document fields
     * while stripping internal transient Firestore metadata (_updateTime, _createTime).
     */
    static _extractAttemptState(att) {
        if (!att || typeof att !== "object") return {};
        const state = JSON.parse(JSON.stringify(att));
        delete state._updateTime;
        delete state.updateTime;
        delete state._createTime;
        delete state.createTime;
        return state;
    }

    /**
     * Extract exhaustive state from a result document, preserving ALL document fields
     * while stripping internal transient Firestore metadata (_updateTime, _createTime).
     */
    static _extractResultState(res) {
        if (!res || typeof res !== "object") return {};
        const state = JSON.parse(JSON.stringify(res));
        delete state._updateTime;
        delete state.updateTime;
        delete state._createTime;
        delete state.createTime;
        return state;
    }

    static _sortObject(val) {
        if (val === null || typeof val !== "object") {
            return val;
        }
        if (Array.isArray(val)) {
            return val.map(item => this._sortObject(item));
        }
        const sorted = {};
        for (const key of Object.keys(val).sort()) {
            sorted[key] = this._sortObject(val[key]);
        }
        return sorted;
    }

    static _hasAttemptStateChanged(pre, curr) {
        const cleanPre = this._sortObject(this._extractAttemptState(pre));
        const cleanCurr = this._sortObject(this._extractAttemptState(curr));
        return JSON.stringify(cleanPre) !== JSON.stringify(cleanCurr);
    }

    static _hasResultStateChanged(pre, curr) {
        const cleanPre = this._sortObject(this._extractResultState(pre));
        const cleanCurr = this._sortObject(this._extractResultState(curr));
        return JSON.stringify(cleanPre) !== JSON.stringify(cleanCurr);
    }

    /**
     * Validate referential integrity across restored or staging collections.
     *
     * Validates:
     * 1. Attempt -> user existence (when users collection is provided).
     * 2. Result -> user existence (when users collection is provided).
     * 3. Result -> attempt -> test consistency (result.testId === attempt.testId).
     * 4. Question ownership & test-question relationship consistency.
     * 5. Checkpoint phase, processed IDs, failure-offset, and status consistency.
     * 6. Duplicate or orphaned references across all five migrated collections.
     *
     * @param {object} params
     * @param {Array|object} [params.attempts]
     * @param {Array|object} [params.results]
     * @param {Array|object} [params.tests]
     * @param {Array|object} [params.questions]
     * @param {Array|object} [params.checkpoints]
     * @param {Array|object} [params.users]
     * @returns {object} Validation report { isValid, summary, violations }
     */
    static validateReferentialIntegrity({
        attempts = [],
        results = [],
        tests = [],
        questions = [],
        checkpoints = [],
        users = null
    } = {}) {
        const isUsersSupplied = users !== null && users !== undefined;
        const attemptMap = this._normalizeToMap(attempts, "attemptId");
        const testMap = this._normalizeToMap(tests, "testId");
        const questionMap = this._normalizeToMap(questions, "questionId");
        const userMap = isUsersSupplied ? this._normalizeToMap(users, "uid") : new Map();

        const normalizedAttempts = this._normalizeToArray(attempts, "attemptId");
        const normalizedResults = this._normalizeToArray(results, "resultId");
        const normalizedTests = this._normalizeToArray(tests, "testId");
        const normalizedQuestions = this._normalizeToArray(questions, "questionId");
        const normalizedCheckpoints = this._normalizeToArray(checkpoints, "checkpointId");

        const report = {
            isValid: true,
            summary: {
                totalAttempts: normalizedAttempts.length,
                totalResults: normalizedResults.length,
                totalTests: normalizedTests.length,
                totalQuestions: normalizedQuestions.length,
                totalCheckpoints: normalizedCheckpoints.length,
                totalUsers: isUsersSupplied ? userMap.size : null,
                usersValidationStatus: isUsersSupplied ? "CHECKED" : "NOT_SUPPLIED",
                errorsCount: 0,
                warningsCount: 0
            },
            violations: []
        };

        const addViolation = (type, severity, message, details = {}) => {
            if (severity === "ERROR") {
                report.isValid = false;
                report.summary.errorsCount++;
            } else {
                report.summary.warningsCount++;
            }
            report.violations.push({ type, severity, message, ...details });
        };

        // Note users collection supply status
        if (!isUsersSupplied) {
            addViolation(
                "USERS_COLLECTION_NOT_SUPPLIED",
                "WARNING",
                "Authoritative users collection was not supplied in snapshot; foreign-key user existence check skipped. Attempt and result userId agreement was strictly validated.",
                { usersValidationStatus: "NOT_SUPPLIED" }
            );
        }

        // 1. Identify duplicate results pointing to the same attempt
        const attemptResultCount = new Map();
        for (const res of normalizedResults) {
            const attId = res.attemptId;
            if (attId) {
                const count = (attemptResultCount.get(attId) || 0) + 1;
                attemptResultCount.set(attId, count);
                if (count > 1) {
                    addViolation("DUPLICATE_RESULT_FOR_ATTEMPT", "ERROR",
                        `Duplicate result detected: Multiple results reference attempt '${attId}'`,
                        { resultId: res.resultId, attemptId: attId });
                }
            } else {
                addViolation("RESULT_MISSING_ATTEMPT_ID", "ERROR",
                    `Result '${res.resultId}' is missing mandatory attemptId`,
                    { resultId: res.resultId });
            }
        }

        // 2. Result -> attempt & Result -> test & User ID agreement
        for (const res of normalizedResults) {
            const attId = res.attemptId;
            if (!attId) continue;
            const parentAttempt = attemptMap.get(attId);
            if (!parentAttempt) {
                addViolation("ORPHANED_RESULT", "ERROR",
                    `Result '${res.resultId}' references non-existent attempt '${attId}'`,
                    { resultId: res.resultId, attemptId: attId });
            } else {
                // Check user IDs agree between result and attempt
                const resultUserId = res.userId || res.studentId;
                const attemptUserId = parentAttempt.userId || parentAttempt.studentId;
                if (resultUserId && attemptUserId && resultUserId !== attemptUserId) {
                    addViolation("USER_ID_MISMATCH", "ERROR",
                        `User ID mismatch: Result '${res.resultId}' has user '${resultUserId}' but attempt '${attId}' has user '${attemptUserId}'`,
                        { resultId: res.resultId, attemptId: attId, resultUserId, attemptUserId });
                }

                // Check test consistency: result.testId must match attempt.testId
                if (res.testId && parentAttempt.testId && res.testId !== parentAttempt.testId) {
                    addViolation("RESULT_ATTEMPT_TEST_MISMATCH", "ERROR",
                        `Test ID mismatch: Result '${res.resultId}' references test '${res.testId}' but attempt '${attId}' references test '${parentAttempt.testId}'`,
                        { resultId: res.resultId, attemptId: attId, resultTestId: res.testId, attemptTestId: parentAttempt.testId });
                }
            }

            // Result -> user existence (when users collection supplied)
            const rUid = res.userId || res.studentId;
            if (isUsersSupplied && rUid && !userMap.has(rUid)) {
                addViolation("ORPHANED_RESULT_USER", "ERROR",
                    `Result '${res.resultId}' references non-existent user '${rUid}'`,
                    { resultId: res.resultId, userId: rUid });
            }
        }

        // 3. Attempt -> test existence & Attempt -> user existence
        for (const att of normalizedAttempts) {
            const tId = att.testId;
            if (!tId) {
                addViolation("ATTEMPT_MISSING_TEST_ID", "ERROR",
                    `Attempt '${att.attemptId}' is missing mandatory testId`,
                    { attemptId: att.attemptId });
            } else if (testMap.size > 0 && !testMap.has(tId)) {
                addViolation("ORPHANED_ATTEMPT", "ERROR",
                    `Attempt '${att.attemptId}' references non-existent test '${tId}'`,
                    { attemptId: att.attemptId, testId: tId });
            }

            // Attempt -> user existence (when users collection supplied)
            const aUid = att.userId || att.studentId;
            if (isUsersSupplied && aUid && !userMap.has(aUid)) {
                addViolation("ORPHANED_ATTEMPT_USER", "ERROR",
                    `Attempt '${att.attemptId}' references non-existent user '${aUid}'`,
                    { attemptId: att.attemptId, userId: aUid });
            }
        }

        // 4. Test -> Question resolution & Question ownership consistency
        const testQuestionRegistry = new Map(); // testId -> Set of questionIds
        for (const test of normalizedTests) {
            const qIds = new Set();
            if (Array.isArray(test.questionIds)) {
                for (const qId of test.questionIds) qIds.add(qId);
            }
            if (Array.isArray(test.sections)) {
                for (const sec of test.sections) {
                    if (Array.isArray(sec.questionIds)) {
                        for (const qId of sec.questionIds) qIds.add(qId);
                    }
                }
            }
            testQuestionRegistry.set(test.testId, qIds);

            // Test -> Questions must resolve
            if (questionMap.size > 0 && qIds.size > 0) {
                for (const qId of qIds) {
                    if (!questionMap.has(qId)) {
                        addViolation("UNRESOLVED_QUESTION_REFERENCE", "ERROR",
                            `Test '${test.testId}' references non-existent question '${qId}'`,
                            { testId: test.testId, questionId: qId });
                    }
                }
            }
        }

        // Question ownership consistency: If question declares testId, it must exist in tests and match
        for (const q of normalizedQuestions) {
            if (q.testId && testMap.size > 0) {
                if (!testMap.has(q.testId)) {
                    addViolation("ORPHANED_QUESTION", "ERROR",
                        `Question '${q.questionId}' references non-existent owner test '${q.testId}'`,
                        { questionId: q.questionId, testId: q.testId });
                } else {
                    const testQIds = testQuestionRegistry.get(q.testId);
                    if (testQIds && !testQIds.has(q.questionId)) {
                        addViolation("QUESTION_OWNERSHIP_MISMATCH", "ERROR",
                            `Question '${q.questionId}' claims ownership by test '${q.testId}', but test does not include this question in questionIds or sections`,
                            { questionId: q.questionId, testId: q.testId });
                    }
                }
            }
        }

        // 5. Migration Checkpoint consistency (phase, processed IDs, failure-offset, status)
        const VALID_CHECKPOINT_STATUSES = new Set(["in_progress", "completed", "interrupted"]);
        for (const cp of normalizedCheckpoints) {
            const cpId = cp.checkpointId || cp.jobId || cp.id;

            // Status validation
            if (cp.status && !VALID_CHECKPOINT_STATUSES.has(cp.status)) {
                addViolation("CHECKPOINT_INVALID_STATUS", "ERROR",
                    `Checkpoint '${cpId}' has invalid status '${cp.status}' (expected: in_progress, completed, interrupted)`,
                    { checkpointId: cpId, status: cp.status });
            }

            // Failure offset consistency
            if (typeof cp.failureOffset === "number") {
                if (cp.failureOffset < 0) {
                    addViolation("CHECKPOINT_OFFSET_INCONSISTENCY", "ERROR",
                        `Checkpoint '${cpId}' has negative failureOffset: ${cp.failureOffset}`,
                        { checkpointId: cpId, failureOffset: cp.failureOffset });
                }
                if (cp.status === "completed" && cp.failureOffset > 0) {
                    addViolation("CHECKPOINT_OFFSET_INCONSISTENCY", "ERROR",
                        `Checkpoint '${cpId}' is marked 'completed' but has non-zero failureOffset: ${cp.failureOffset}`,
                        { checkpointId: cpId, failureOffset: cp.failureOffset });
                }
            }

            // Phase validation (if present)
            if (cp.phase !== undefined && (typeof cp.phase !== "string" || cp.phase.trim() === "")) {
                addViolation("CHECKPOINT_INVALID_PHASE", "ERROR",
                    `Checkpoint '${cpId}' has invalid phase: ${JSON.stringify(cp.phase)}`,
                    { checkpointId: cpId, phase: cp.phase });
            }

            // Last processed attempt validation
            if (cp.lastProcessedAttemptId && attemptMap.size > 0 && !attemptMap.has(cp.lastProcessedAttemptId)) {
                addViolation("CHECKPOINT_ATTEMPT_NOT_FOUND", "ERROR",
                    `Checkpoint '${cpId}' lastProcessedAttemptId '${cp.lastProcessedAttemptId}' not present in attempts`,
                    { checkpointId: cpId, attemptId: cp.lastProcessedAttemptId });
            }

            // Processed attempt IDs array validation
            if (Array.isArray(cp.processedAttemptIds)) {
                for (const attId of cp.processedAttemptIds) {
                    if (attemptMap.size > 0 && !attemptMap.has(attId)) {
                        addViolation("CHECKPOINT_ATTEMPT_NOT_FOUND", "ERROR",
                            `Checkpoint '${cpId}' references attempt '${attId}' not present in attempts`,
                            { checkpointId: cpId, attemptId: attId });
                    }
                }
            }
        }

        return report;
    }

    static _normalizeToMap(source, idKey) {
        const map = new Map();
        if (!source) return map;
        if (Array.isArray(source)) {
            for (const item of source) {
                const id = item[idKey] || item.id;
                if (id) {
                    // Strict privacy protection: when indexing user documents, retain ONLY the identifier
                    if (idKey === "uid") {
                        map.set(id, { uid: id });
                    } else {
                        map.set(id, item);
                    }
                }
            }
        } else if (typeof source === "object") {
            for (const [key, val] of Object.entries(source)) {
                const id = val[idKey] || val.id || key;
                if (id) {
                    if (idKey === "uid") {
                        map.set(id, { uid: id });
                    } else {
                        map.set(id, val);
                    }
                }
            }
        }
        return map;
    }

    static _normalizeToArray(source, idKey) {
        if (!source) return [];
        if (Array.isArray(source)) return source;
        if (typeof source === "object") {
            return Object.entries(source).map(([k, v]) => {
                if (typeof v === "object" && v !== null) {
                    if (!v[idKey] && !v.id) v[idKey] = k;
                    return v;
                }
                return { [idKey]: k, value: v };
            });
        }
        return [];
    }

    /**
     * Save manifest to JSON file along with a companion .sha256 checksum file
     */
    static writeManifestToFile(manifest, filePath, options = {}) {
        const { signingKey = process.env.ARTIFACT_SIGNING_KEY, trustedLedgerPath = process.env.TRUSTED_HASH_LEDGER_PATH } = options;
        const resolved = path.resolve(filePath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        const jsonStr = JSON.stringify(manifest, null, 2);
        fs.writeFileSync(resolved, jsonStr, "utf8");
        const checksum = crypto.createHash("sha256").update(jsonStr, "utf8").digest("hex");
        fs.writeFileSync(`${resolved}.sha256`, `${checksum}  ${path.basename(resolved)}\n`, "utf8");

        let sigFile = null;
        if (signingKey) {
            const hmac = crypto.createHmac("sha256", signingKey).update(jsonStr, "utf8").digest("hex");
            sigFile = `${resolved}.sig`;
            fs.writeFileSync(sigFile, `${hmac}  ${path.basename(resolved)}\n`, "utf8");
        }

        if (trustedLedgerPath) {
            const resolvedLedger = path.resolve(trustedLedgerPath);
            fs.mkdirSync(path.dirname(resolvedLedger), { recursive: true });
            const entry = JSON.stringify({
                timestamp: new Date().toISOString(),
                file: path.basename(resolved),
                sha256: checksum
            }) + "\n";
            fs.appendFileSync(resolvedLedger, entry, "utf8");
        }

        return resolved;
    }

    /**
     * Read manifest from JSON file and verify companion .sha256 checksum, HMAC signature, or trusted ledger
     */
    static readManifestFromFile(filePath, { verifyChecksum = false, signingKey = process.env.ARTIFACT_SIGNING_KEY, trustedLedgerPath = process.env.TRUSTED_HASH_LEDGER_PATH } = {}) {
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) {
            throw new Error(`Manifest file not found: ${resolved}`);
        }
        const raw = fs.readFileSync(resolved, "utf8");
        const actualHash = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

        const shaPath = `${resolved}.sha256`;
        if (fs.existsSync(shaPath) || verifyChecksum) {
            if (!fs.existsSync(shaPath)) {
                throw new Error(`Integrity verification failed: Checksum file '${shaPath}' not found for manifest '${resolved}'.`);
            }
            const expectedHash = fs.readFileSync(shaPath, "utf8").trim().split(/\s+/)[0];
            if (expectedHash !== actualHash) {
                throw new Error(`Integrity violation: Manifest checksum mismatch for '${resolved}'. Expected ${expectedHash}, computed ${actualHash}.`);
            }
        }

        // HMAC signature verification for adversary-resistant trust
        const sigPath = `${resolved}.sig`;
        if (signingKey || fs.existsSync(sigPath)) {
            if (!signingKey) {
                throw new Error(`Integrity verification failed: Artifact signature file '${sigPath}' exists, but no ARTIFACT_SIGNING_KEY provided to verify it!`);
            }
            if (!fs.existsSync(sigPath)) {
                throw new Error(`Integrity verification failed: Signing key provided, but signature file '${sigPath}' not found!`);
            }
            const expectedHmac = fs.readFileSync(sigPath, "utf8").trim().split(/\s+/)[0];
            const actualHmac = crypto.createHmac("sha256", signingKey).update(raw, "utf8").digest("hex");
            if (!crypto.timingSafeEqual(Buffer.from(expectedHmac, "hex"), Buffer.from(actualHmac, "hex"))) {
                throw new Error(`Adversarial integrity violation: HMAC signature mismatch for '${resolved}'! Artifact was modified without authorized signing key.`);
            }
        }

        // Trusted ledger verification if configured
        if (trustedLedgerPath && fs.existsSync(path.resolve(trustedLedgerPath))) {
            const ledgerContent = fs.readFileSync(path.resolve(trustedLedgerPath), "utf8");
            const baseName = path.basename(resolved);
            const matches = ledgerContent.split("\n").filter(line => line.includes(baseName));
            if (matches.length > 0) {
                const latestEntry = JSON.parse(matches[matches.length - 1]);
                if (latestEntry.sha256 !== actualHash) {
                    throw new Error(`Ledger integrity violation: Hash in trusted ledger (${latestEntry.sha256}) does not match current file (${actualHash}) for '${resolved}'!`);
                }
            }
        }

        return JSON.parse(raw);
    }
}

