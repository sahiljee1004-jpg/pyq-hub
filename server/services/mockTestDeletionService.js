import { UniversalFirestoreService, UniversalFirestoreClient } from "./admin/universalFirestoreService.js";
import { validateProjectIdFormat } from "./firebaseTokenService.js";
import { StorageVaultService } from "./admin/storageVaultService.js";
import { ImportJobPipelineService } from "./admin/importJobPipelineService.js";

/**
 * VidyarthiAstra — Server-Side Mock Test Deletion Service
 * 
 * Safely, securely, and permanently removes published mock tests throughout the system:
 * 1. Server-authoritative data dependency audit and manifest generation
 * 2. Multi-step confirmation validation (exact test ID or confirmation phrase)
 * 3. Immediate attempt & publication blocking ("deleting" status gate)
 * 4. Cascade cleanup of student attempts, autosaved answers, and evaluated results
 * 5. Cascade cleanup of test-specific answer keys and exclusively owned questions
 * 6. Protection of shared questions, shared assets, and unrelated tests/jobs
 * 7. Clean up of exclusively owned Storage vault assets
 * 8. Reversal of import job published status and recording of minimal audit trail
 * 9. Idempotent execution and resilient stage recovery
 */
export class MockTestDeletionService {
    static _getClient(options = {}) {
        if (options?.client) {
            const client = options.client;

            // 1. Must be a genuine project-bound UniversalFirestoreClient instance
            if (!(client instanceof UniversalFirestoreClient)) {
                throw new Error("SAFETY VIOLATION: MockTestDeletionService requires a genuine project-bound UniversalFirestoreClient instance. Arbitrary objects masquerading as Firestore clients are strictly rejected.");
            }

            // 2. Reject any client that does not have a valid, explicit project ID
            if (!client.projectId) {
                throw new Error("SAFETY VIOLATION: MockTestDeletionService requires a client with an explicit, valid project ID. Supplied client has missing or empty projectId.");
            }
            const clientProj = validateProjectIdFormat(client.projectId, "client.projectId");

            // 3. Reject conflicting options.projectId and client.projectId
            if (options.projectId) {
                const explicitProj = validateProjectIdFormat(options.projectId, "options.projectId");
                if (clientProj !== explicitProj) {
                    throw new Error(`SAFETY VIOLATION: Conflicting project options: client is bound to '${clientProj}' but options.projectId specifies '${explicitProj}'.`);
                }
            }

            return client;
        }

        if (options?.projectId) {
            const validatedProj = validateProjectIdFormat(options.projectId, "options.projectId");
            return UniversalFirestoreService.forProject(validatedProj);
        }

        throw new Error("SAFETY VIOLATION: MockTestDeletionService requires an explicit target project (options.projectId) or bound client (options.client). Silently inferring project from ambient environment variables is strictly forbidden.");
    }

    /**
     * Build an authoritative server-side deletion manifest.
     * Traces all dependencies, owned records, shared assets, attempts, and results.
     * Resilient to missing canonical mockTests document — recovers dependencies
     * from persisted manifests, import jobs, and independently verified related records.
     */
    static async generateDeletionManifest({ testId, jobId = null, adminUid, reason = "", options = {} }) {
        if (!testId || typeof testId !== "string") {
            throw new Error("A valid testId is required to generate a deletion manifest.");
        }
        if (!adminUid) {
            throw new Error("Admin authentication is required to generate a deletion manifest.");
        }

        const client = this._getClient(options);

        // 1. Resolve canonical mockTest document (if it exists)
        const testDoc = await client.getDocument("mockTests", testId);

        // Check for previously persisted deletion operations for this test
        const allOps = await client.listDocuments("mockTestDeletionOperations");
        const matchingOps = allOps.filter(o => o.testId === testId).sort((a, b) => {
            const timeA = new Date(b.updatedAt || b.requestedAt || 0).getTime();
            const timeB = new Date(a.updatedAt || a.requestedAt || 0).getTime();
            return timeA - timeB;
        });
        const existingManifest = matchingOps[0] || null;

        // 2. Resolve associated import job(s)
        const allJobs = await client.listDocuments("paperImportJobs");
        const matchingJobs = allJobs.filter(j => 
            j.draftPackage?.testId === testId ||
            j.publishedMockTestId === testId ||
            j.mockTestId === testId ||
            j.testId === testId ||
            (jobId && j.jobId === jobId) ||
            (testDoc && j.examId === testDoc.examId && String(j.year) === String(testDoc.year) && j.paperCode === testDoc.paperCode)
        );

        const primaryJob = matchingJobs[0] || (jobId ? allJobs.find(j => j.jobId === jobId) : null);

        // 3. Resolve questions and detect shared references
        const allQuestions = await client.listDocuments("mockQuestions");
        const testQuestionIds = new Set([
            ...(testDoc && Array.isArray(testDoc.questionIds) ? testDoc.questionIds : []),
            ...(existingManifest?.records?.exclusiveQuestions || []),
            ...(primaryJob?.draftPackage?.questions ? primaryJob.draftPackage.questions.map(q => q.questionId || q.id) : [])
        ].filter(Boolean));

        const candidateQuestions = allQuestions.filter(q => 
            q.testId === testId || testQuestionIds.has(q.questionId) || testQuestionIds.has(q.id)
        );

        // 4. Resolve answer keys
        const allAnswerKeys = await client.listDocuments("mockAnswerKeys");
        const prevKeyIds = new Set(existingManifest?.records?.exclusiveAnswerKeys || []);
        const candidateKeys = allAnswerKeys.filter(ak => 
            ak.testId === testId || testQuestionIds.has(ak.questionId) || prevKeyIds.has(ak.answerKeyId || ak.id || ak.questionId)
        );

        // 5. Resolve student attempts
        const allAttempts = await client.listDocuments("mockAttempts");
        const testAttempts = allAttempts.filter(a => a.testId === testId);
        const attemptIds = Array.from(new Set([
            ...testAttempts.map(a => a.attemptId || a.id),
            ...(existingManifest?.records?.attemptIds || [])
        ]));

        // 6. Resolve student results
        const attemptIdSet = new Set(attemptIds);
        const allResults = await client.listDocuments("mockResults");
        const testResults = allResults.filter(r => r.testId === testId || attemptIdSet.has(r.attemptId));
        const resultIds = Array.from(new Set([
            ...testResults.map(r => r.resultId || r.id),
            ...(existingManifest?.records?.resultIds || [])
        ]));

        // Fail-safe verification guard: Do NOT blindly delete based on an unverified test ID
        const isVerifiedTarget = Boolean(
            testDoc ||
            existingManifest ||
            primaryJob ||
            candidateQuestions.length > 0 ||
            candidateKeys.length > 0 ||
            attemptIds.length > 0 ||
            resultIds.length > 0
        );

        if (!isVerifiedTarget) {
            const err = new Error(`Mock test '${testId}' was not found in Firestore and has no verifiable job or dependency records.`);
            err.statusCode = 404;
            err.unverified = true;
            throw err;
        }

        // Check if the associated job is linked to multiple tests
        const jobOtherTests = [];
        const allTests = await client.listDocuments("mockTests");
        if (primaryJob) {
            for (const t of allTests) {
                if (t.testId !== testId) {
                    if (primaryJob.draftPackage?.testId === t.testId ||
                        primaryJob.publishedMockTestId === t.testId ||
                        primaryJob.mockTestId === t.testId ||
                        (t.examId === primaryJob.examId && String(t.year) === String(primaryJob.year) && t.paperCode === primaryJob.paperCode)) {
                        jobOtherTests.push({
                            testId: t.testId,
                            title: t.title || t.testId,
                            status: t.status
                        });
                    }
                }
            }
        }

        // Check other mock tests for shared question IDs
        const otherTests = allTests.filter(t => t.testId !== testId);
        const otherTestQuestionIds = new Set();
        for (const ot of otherTests) {
            if (Array.isArray(ot.questionIds)) {
                for (const qid of ot.questionIds) {
                    otherTestQuestionIds.add(qid);
                }
            }
        }

        const exclusiveQuestions = [];
        const exclusiveQuestionsData = [];
        const sharedQuestionsPreserved = [];

        for (const q of candidateQuestions) {
            const qId = q.questionId || q.id;
            const isShared = otherTestQuestionIds.has(qId) || (q.testId && q.testId !== testId);
            if (isShared) {
                sharedQuestionsPreserved.push(qId);
            } else {
                exclusiveQuestions.push(qId);
                exclusiveQuestionsData.push({
                    questionId: qId,
                    questionNumber: q.questionNumber || null
                });
            }
        }

        const exclusiveAnswerKeys = [];
        const sharedAnswerKeysPreserved = [];

        for (const ak of candidateKeys) {
            const keyId = ak.answerKeyId || ak.id || ak.questionId;
            const isShared = ak.testId && ak.testId !== testId && otherTests.some(ot => ot.testId === ak.testId);
            if (isShared) {
                sharedAnswerKeysPreserved.push(keyId);
            } else {
                exclusiveAnswerKeys.push(keyId);
            }
        }

        // 7. Resolve exclusively owned storage assets
        const storageFilesToDelete = [];
        const storageFilesPreserved = [];

        // Check diagrams and media attached to candidate questions
        for (const q of candidateQuestions) {
            const qId = q.questionId || q.id;
            const isExclusive = exclusiveQuestions.includes(qId);

            const qPaths = [
                q.localVaultPath,
                q.storagePath,
                q.firebaseStoragePath,
                q.diagramUrl,
                q.diagramStoragePath
            ].filter(p => typeof p === "string" && p.trim().length > 0);

            for (const p of qPaths) {
                if (isExclusive) {
                    storageFilesToDelete.push(p);
                } else {
                    storageFilesPreserved.push(p);
                }
            }

            if (Array.isArray(q.media)) {
                for (const m of q.media) {
                    if (m) {
                        const mPaths = [m.localVaultPath, m.storagePath, m.firebaseStoragePath, m.url].filter(p => typeof p === "string" && p.trim().length > 0);
                        for (const mp of mPaths) {
                            if (isExclusive) {
                                storageFilesToDelete.push(mp);
                            } else {
                                storageFilesPreserved.push(mp);
                            }
                        }
                    }
                }
            }
        }

        // Preserved source documents from import job (must not delete shared raw PDFs)
        if (primaryJob && primaryJob.sourceDocuments) {
            for (const [docType, docRef] of Object.entries(primaryJob.sourceDocuments)) {
                if (docRef) {
                    const refPath = docRef.localVaultPath || docRef.storagePath;
                    if (refPath) {
                        storageFilesPreserved.push(refPath);
                    }
                }
            }
        }

        // Deduplicate file lists
        const uniqueFilesToDelete = Array.from(new Set(storageFilesToDelete));
        const uniqueFilesPreserved = Array.from(new Set(storageFilesPreserved));

        // 8. Generate safe Operation ID & Manifest
        const sanitizedTestId = testId.replace(/[^a-zA-Z0-9_\-]/g, "_");
        const operationId = `del_op_${sanitizedTestId}_${Date.now()}`;

        const parentDocumentMissing = !testDoc;
        const prevSummary = existingManifest?.testSummary || {};
        const testSummary = {
            testId: testDoc?.testId || testId,
            title: testDoc?.title || prevSummary.title || (primaryJob ? `${primaryJob.examName || primaryJob.examId || 'Mock Test'} (${primaryJob.year || ''}) [${primaryJob.paperCode || ''}]` : `Mock Test (${testId})`),
            examId: testDoc?.examId || prevSummary.examId || primaryJob?.examId || null,
            examName: testDoc?.examName || prevSummary.examName || primaryJob?.examName || primaryJob?.examId || null,
            year: testDoc?.year || prevSummary.year || primaryJob?.year || null,
            paperCode: testDoc?.paperCode || prevSummary.paperCode || primaryJob?.paperCode || null,
            totalQuestions: (testDoc?.questionIds || []).length || prevSummary.totalQuestions || candidateQuestions.length,
            status: testDoc?.status || (existingManifest?.status === "COMPLETED" ? "already_deleted" : "missing_parent"),
            parentDocumentMissing,
            recoveredFrom: parentDocumentMissing ? (existingManifest ? "manifest" : (primaryJob ? "job" : "records")) : null
        };

        const nothingToDelete = Boolean(
            parentDocumentMissing &&
            candidateQuestions.length === 0 &&
            candidateKeys.length === 0 &&
            attemptIds.length === 0 &&
            resultIds.length === 0 &&
            uniqueFilesToDelete.length === 0 &&
            (!primaryJob || (
                !primaryJob.publishedMockTestId &&
                !primaryJob.mockTestId &&
                primaryJob.testId !== testId &&
                primaryJob.draftPackage?.testId !== testId
            ))
        );

        const manifest = {
            operationId,
            testId,
            jobId: primaryJob ? primaryJob.jobId : null,
            jobHasOtherTests: jobOtherTests.length > 0,
            otherTestsInJob: jobOtherTests,
            parentDocumentMissing,
            nothingToDelete,
            testSummary,
            counts: {
                questionsTotal: candidateQuestions.length,
                questionsExclusive: exclusiveQuestions.length,
                questionsShared: sharedQuestionsPreserved.length,
                answerKeysExclusive: exclusiveAnswerKeys.length,
                attempts: attemptIds.length,
                results: resultIds.length,
                storageFilesToDelete: uniqueFilesToDelete.length,
                storageFilesPreserved: uniqueFilesPreserved.length
            },
            records: {
                mockTestPath: `mockTests/${testId}`,
                exclusiveQuestions,
                exclusiveQuestionsData,
                sharedQuestionsPreserved,
                exclusiveAnswerKeys,
                sharedAnswerKeysPreserved,
                attemptIds,
                resultIds,
                storageFilesToDelete: uniqueFilesToDelete,
                storageFilesPreserved: uniqueFilesPreserved
            },
            requestedBy: adminUid,
            requestedAt: new Date().toISOString(),
            reason: reason || "Administrative test deletion",
            status: nothingToDelete ? "NOTHING_TO_DELETE" : "MANIFEST_GENERATED",
            currentStage: null,
            stages: {
                blockAccess: {
                    status: parentDocumentMissing ? "completed" : "pending",
                    completedAt: parentDocumentMissing ? new Date().toISOString() : null,
                    note: parentDocumentMissing ? "Parent document already absent" : null
                },
                deleteAttemptsAndResults: { status: "pending", completedAt: null, count: 0 },
                deleteQuestionsAndKeys: { status: "pending", completedAt: null, questionsCount: 0, keysCount: 0 },
                deleteStorageAssets: { status: "pending", completedAt: null, filesCount: 0 },
                deleteTestDocument: {
                    status: parentDocumentMissing ? "completed" : "pending",
                    completedAt: parentDocumentMissing ? new Date().toISOString() : null,
                    note: parentDocumentMissing ? "Parent document already absent" : null
                },
                updateJobAndAudit: { status: "pending", completedAt: null },
                verifyCleanup: { status: "pending", completedAt: null }
            },
            errors: [],
            retryCount: 0,
            completedAt: null
        };

        // Persist manifest in Firestore for audit & recoverable execution
        await client.setDocument("mockTestDeletionOperations", operationId, manifest);

        return manifest;
    }

    /**
     * Validate two-step confirmation phrase against canonical test/job ID.
     */
    static validateConfirmationPhrase(targetId, confirmationText) {
        if (!targetId || !confirmationText || typeof confirmationText !== "string") {
            return false;
        }
        const cleanConfirm = confirmationText.trim();
        const expectedExact = targetId.trim();
        const expectedPrefixed = `DELETE ${targetId}`.trim();
        return cleanConfirm === expectedExact || cleanConfirm.toUpperCase() === expectedPrefixed.toUpperCase();
    }

    /**
     * Execute permanent deletion workflow safely and stage by stage.
     * Retries are idempotent and will resume from incomplete stages.
     * Resilient to missing canonical test document.
     */
    static async executeDeletion({
        operationId = null,
        testId,
        jobId = null,
        confirmation,
        adminUid,
        reason = "",
        options = {}
    }) {
        if (!adminUid) {
            throw new Error("Admin authentication required for deletion.");
        }
        if (!testId) {
            throw new Error("Missing canonical testId for deletion.");
        }

        const client = this._getClient(options);

        // 1. Validate confirmation phrase independently on the server
        if (!this.validateConfirmationPhrase(testId, confirmation)) {
            const err = new Error(`Confirmation mismatch: Please type the exact test ID '${testId}' or 'DELETE ${testId}' to confirm deletion.`);
            err.statusCode = 400;
            throw err;
        }

        // 2. Load or generate deletion manifest
        let manifest = null;
        if (operationId) {
            manifest = await client.getDocument("mockTestDeletionOperations", operationId);
        }

        if (!manifest || manifest.testId !== testId) {
            manifest = await this.generateDeletionManifest({ testId, jobId, adminUid, reason, options: { ...options, client } });
            operationId = manifest.operationId;
        }

        if (manifest.status === "COMPLETED" || (manifest.nothingToDelete && manifest.status === "NOTHING_TO_DELETE")) {
            return {
                success: true,
                alreadyCompleted: true,
                operationId,
                testId,
                status: manifest.status,
                nothingToDelete: Boolean(manifest.nothingToDelete),
                completedAt: manifest.completedAt
            };
        }

        manifest.status = "IN_PROGRESS";
        manifest.updatedAt = new Date().toISOString();
        if (reason) manifest.reason = reason;

        try {
            // ----------------------------------------------------
            // STAGE 1: BLOCK ACCESS & MARK DELETING
            // ----------------------------------------------------
            if (manifest.stages.blockAccess.status !== "completed") {
                manifest.currentStage = "blockAccess";
                const testDoc = await client.getDocument("mockTests", testId);
                if (testDoc) {
                    testDoc.status = "deleting";
                    testDoc.deletionBlockedAt = new Date().toISOString();
                    testDoc.deletionOperationId = operationId;
                    testDoc.updatedAt = testDoc.deletionBlockedAt;
                    await client.setDocument("mockTests", testId, testDoc);
                }
                manifest.stages.blockAccess.status = "completed";
                manifest.stages.blockAccess.completedAt = new Date().toISOString();
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // ----------------------------------------------------
            // STAGE 2: DELETE ATTEMPTS & RESULTS (Bounded batching)
            // ----------------------------------------------------
            if (manifest.stages.deleteAttemptsAndResults.status !== "completed") {
                manifest.currentStage = "deleteAttemptsAndResults";
                const attemptIds = manifest.records.attemptIds || [];
                const resultIds = manifest.records.resultIds || [];

                // Delete results first
                for (const rId of resultIds) {
                    await client.deleteDocument("mockResults", rId);
                }

                // Delete attempts
                for (const aId of attemptIds) {
                    await client.deleteDocument("mockAttempts", aId);
                }

                manifest.stages.deleteAttemptsAndResults.status = "completed";
                manifest.stages.deleteAttemptsAndResults.completedAt = new Date().toISOString();
                manifest.stages.deleteAttemptsAndResults.count = attemptIds.length + resultIds.length;
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // ----------------------------------------------------
            // STAGE 3: DELETE EXCLUSIVE QUESTIONS & ANSWER KEYS
            // ----------------------------------------------------
            if (manifest.stages.deleteQuestionsAndKeys.status !== "completed") {
                manifest.currentStage = "deleteQuestionsAndKeys";
                const exclusiveQuestions = manifest.records.exclusiveQuestions || [];
                const exclusiveQuestionsData = manifest.records.exclusiveQuestionsData || [];
                const exclusiveKeys = manifest.records.exclusiveAnswerKeys || [];

                for (const qId of exclusiveQuestions) {
                    await client.deleteDocument("mockQuestions", qId);
                }

                // Also delete legacy questions if present
                if (manifest.testSummary.examId) {
                    const legacyColShort = `exams/${manifest.testSummary.examId}/questions`;
                    for (const qItem of exclusiveQuestionsData) {
                        if (qItem && qItem.questionNumber) {
                            try {
                                await client.deleteDocument(legacyColShort, String(qItem.questionNumber));
                            } catch (e) {}
                        }
                        if (qItem && qItem.questionId) {
                            try {
                                await client.deleteDocument(legacyColShort, qItem.questionId);
                            } catch (e) {}
                        }
                    }
                }

                if (manifest.testSummary.examId && manifest.testSummary.year && manifest.testSummary.paperCode) {
                    const legacyCol = `exams/${manifest.testSummary.examId}/years/${manifest.testSummary.year}/papers/${manifest.testSummary.paperCode}/questions`;
                    for (const qItem of exclusiveQuestionsData) {
                        if (qItem && qItem.questionNumber) {
                            try {
                                await client.deleteDocument(legacyCol, String(qItem.questionNumber));
                            } catch (e) {}
                        }
                        if (qItem && qItem.questionId) {
                            try {
                                await client.deleteDocument(legacyCol, qItem.questionId);
                            } catch (e) {}
                        }
                    }
                }

                for (const keyId of exclusiveKeys) {
                    await client.deleteDocument("mockAnswerKeys", keyId);
                }

                manifest.stages.deleteQuestionsAndKeys.status = "completed";
                manifest.stages.deleteQuestionsAndKeys.completedAt = new Date().toISOString();
                manifest.stages.deleteQuestionsAndKeys.questionsCount = exclusiveQuestions.length;
                manifest.stages.deleteQuestionsAndKeys.keysCount = exclusiveKeys.length;
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // ----------------------------------------------------
            // STAGE 4: CLEAN UP EXCLUSIVE STORAGE VAULT ASSETS
            // ----------------------------------------------------
            if (manifest.stages.deleteStorageAssets.status !== "completed") {
                manifest.currentStage = "deleteStorageAssets";
                const filesToDelete = manifest.records.storageFilesToDelete || [];
                let deletedFilesCount = 0;

                for (const filePath of filesToDelete) {
                    try {
                        const removed = await StorageVaultService.removeDraftFile(filePath);
                        if (removed) deletedFilesCount++;
                    } catch (fileErr) {
                        console.warn(`[MockTestDeletionService] Notice cleaning asset ${filePath}:`, fileErr.message);
                        manifest.errors.push({
                            stage: "deleteStorageAssets",
                            file: filePath,
                            message: fileErr.message,
                            timestamp: new Date().toISOString()
                        });
                    }
                }

                manifest.stages.deleteStorageAssets.status = "completed";
                manifest.stages.deleteStorageAssets.completedAt = new Date().toISOString();
                manifest.stages.deleteStorageAssets.filesCount = deletedFilesCount;
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // ----------------------------------------------------
            // STAGE 5: DELETE CANONICAL mockTests DOCUMENT & SUBCOLLECTIONS
            // ----------------------------------------------------
            if (manifest.stages.deleteTestDocument.status !== "completed") {
                manifest.currentStage = "deleteTestDocument";
                await client.deleteDocumentAndSubcollections("mockTests", testId);
                manifest.stages.deleteTestDocument.status = "completed";
                manifest.stages.deleteTestDocument.completedAt = new Date().toISOString();
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // ----------------------------------------------------
            // STAGE 6: UPDATE IMPORT JOB ASSOCIATION & AUDIT LOGS
            // ----------------------------------------------------
            if (manifest.stages.updateJobAndAudit.status !== "completed") {
                manifest.currentStage = "updateJobAndAudit";
                const targetJobId = manifest.jobId || jobId;

                if (targetJobId) {
                    const job = await client.getDocument("paperImportJobs", targetJobId);
                    if (job) {
                        // Remove published test associations
                        if (job.publishedMockTestId === testId) {
                            delete job.publishedMockTestId;
                        }
                        if (job.mockTestId === testId) {
                            delete job.mockTestId;
                        }
                        if (job.testId === testId) {
                            delete job.testId;
                        }
                        if (job.draftPackage?.testId === testId) {
                            delete job.draftPackage.testId;
                        }

                        const jobHasOtherTests = Boolean(manifest.jobHasOtherTests);
                        const hasRemainingDraft = (job.draftPackage?.questions && job.draftPackage.questions.length > 0) ||
                            (job.extractedQuestions && job.extractedQuestions.length > 0);
                        const hasSourceDocs = Boolean(job.sourceDocuments && Object.keys(job.sourceDocuments).length > 0);

                        // If the job is exclusively for this test and no draft/source data remains,
                        // apply the project's established deletion lifecycle for that job
                        const shouldDeleteJobEntirely = !jobHasOtherTests && !hasRemainingDraft && !hasSourceDocs;

                        if (shouldDeleteJobEntirely) {
                            await client.deleteDocumentAndSubcollections("paperImportJobs", targetJobId);
                            ImportJobPipelineService.deleteJobFromMemory(targetJobId);
                        } else {
                            // Retain job and update its status appropriately
                            if (!jobHasOtherTests) {
                                job.status = job.validationReport?.canPublish ? "ready_to_publish" : "needs_review";
                                job.stage = "Test paper unpublished; ready for review or re-publication.";
                            }

                            if (!Array.isArray(job.auditLog)) job.auditLog = [];
                            job.auditLog.push({
                                action: "MOCK_TEST_DELETED",
                                testId,
                                operationId,
                                actor: adminUid,
                                reason: manifest.reason,
                                timestamp: new Date().toISOString(),
                                deletedCounts: manifest.counts
                            });
                            job.updatedAt = new Date().toISOString();

                            await client.setDocument("paperImportJobs", targetJobId, job);
                            await ImportJobPipelineService.syncJobsFromFirestore();
                        }
                    }
                }

                if (process.env.NODE_ENV !== "test") {
                    UniversalFirestoreService.clearLocalCache();
                }

                manifest.stages.updateJobAndAudit.status = "completed";
                manifest.stages.updateJobAndAudit.completedAt = new Date().toISOString();
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // ----------------------------------------------------
            // STAGE 7: VERIFY COMPLETE CLEANUP
            // ----------------------------------------------------
            if (manifest.stages.verifyCleanup && manifest.stages.verifyCleanup.status !== "completed") {
                manifest.currentStage = "verifyCleanup";
                const verifyDoc = await client.getDocument("mockTests", testId);
                if (verifyDoc) {
                    throw new Error(`Verification failed: Mock test document 'mockTests/${testId}' still exists in Firestore after deletion.`);
                }

                // Check remaining attempts
                const allAttempts = await client.listDocuments("mockAttempts");
                const remainingAttempts = allAttempts.filter(a => a.testId === testId);
                if (remainingAttempts.length > 0) {
                    throw new Error(`Verification failed: ${remainingAttempts.length} student attempt(s) still exist for test '${testId}'.`);
                }

                // Check remaining results
                const allResults = await client.listDocuments("mockResults");
                const remainingResults = allResults.filter(r => r.testId === testId);
                if (remainingResults.length > 0) {
                    throw new Error(`Verification failed: ${remainingResults.length} student result(s) still exist for test '${testId}'.`);
                }

                // Check remaining exclusive questions
                const allQuestions = await client.listDocuments("mockQuestions");
                const exclusiveQSet = new Set(manifest.records.exclusiveQuestions || []);
                const remainingQuestions = allQuestions.filter(q => exclusiveQSet.has(q.questionId || q.id));
                if (remainingQuestions.length > 0) {
                    throw new Error(`Verification failed: ${remainingQuestions.length} exclusive question(s) still exist in Firestore.`);
                }

                // Check remaining exclusive answer keys
                const allKeys = await client.listDocuments("mockAnswerKeys");
                const exclusiveKSet = new Set(manifest.records.exclusiveAnswerKeys || []);
                const remainingKeys = allKeys.filter(ak => exclusiveKSet.has(ak.answerKeyId || ak.id || ak.questionId));
                if (remainingKeys.length > 0) {
                    throw new Error(`Verification failed: ${remainingKeys.length} exclusive answer key(s) still exist in Firestore.`);
                }

                manifest.stages.verifyCleanup.status = "completed";
                manifest.stages.verifyCleanup.completedAt = new Date().toISOString();
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // Mark entire deletion operation COMPLETED or NOTHING_TO_DELETE
            manifest.status = manifest.nothingToDelete ? "NOTHING_TO_DELETE" : "COMPLETED";
            manifest.currentStage = "completed";
            manifest.completedAt = new Date().toISOString();
            await client.setDocument("mockTestDeletionOperations", operationId, manifest);

            // Invalidate PYQ Library caches
            try {
                const { PyqLibraryService } = await import("./pyqLibraryService.js");
                PyqLibraryService.invalidateAllCaches();
            } catch (e) {}

            return {
                success: true,
                operationId,
                testId,
                status: manifest.status,
                nothingToDelete: Boolean(manifest.nothingToDelete),
                parentDocumentMissing: Boolean(manifest.parentDocumentMissing),
                jobId: manifest.jobId,
                jobHasOtherTests: manifest.jobHasOtherTests,
                deletedCounts: {
                    attempts: manifest.records.attemptIds.length,
                    results: manifest.records.resultIds.length,
                    questions: manifest.records.exclusiveQuestions.length,
                    answerKeys: manifest.records.exclusiveAnswerKeys.length,
                    storageFiles: manifest.stages.deleteStorageAssets?.filesCount || 0
                },
                sharedPreserved: {
                    questions: manifest.records.sharedQuestionsPreserved.length,
                    storageFiles: manifest.records.storageFilesPreserved.length
                },
                completedAt: manifest.completedAt
            };

        } catch (err) {
            console.error(`[MockTestDeletionService] Deletion interrupted at stage '${manifest.currentStage}':`, err.message);
            manifest.status = "FAILED";
            manifest.errors.push({
                stage: manifest.currentStage,
                error: err.message,
                timestamp: new Date().toISOString()
            });
            await client.setDocument("mockTestDeletionOperations", operationId, manifest).catch(() => {});
            
            const recoverableErr = new Error(`Deletion operation failed during stage '${manifest.currentStage}': ${err.message}. Operation ID: ${operationId}. Can be retried.`);
            recoverableErr.operationId = operationId;
            recoverableErr.currentStage = manifest.currentStage;
            recoverableErr.statusCode = 500;
            throw recoverableErr;
        }
    }

    /**
     * Build an authoritative server-side deletion manifest for an import job and its draft data.
     * Used when an import job is failed, incomplete, awaiting verification, or ready-to-publish without a published test.
     */
    static async generateJobDeletionManifest({ jobId, adminUid, reason = "", options = {} }) {
        if (!jobId || typeof jobId !== "string") {
            throw new Error("A valid jobId is required to generate an import job deletion manifest.");
        }
        if (!adminUid) {
            throw new Error("Admin authentication is required to generate a deletion manifest.");
        }

        const client = this._getClient(options);

        // 1. Resolve canonical job document
        let jobDoc = await client.getDocument("paperImportJobs", jobId);
        if (!jobDoc) {
            jobDoc = await ImportJobPipelineService.getJob(jobId);
        }
        if (!jobDoc) {
            const err = new Error(`Import job '${jobId}' was not found in Firestore.`);
            err.statusCode = 404;
            throw err;
        }

        // 2. Resolve any published mock tests associated with this job
        const allTests = await client.listDocuments("mockTests");
        const matchingTests = allTests.filter(t => 
            t.testId === jobDoc.draftPackage?.testId ||
            t.testId === jobDoc.publishedMockTestId ||
            t.testId === jobDoc.mockTestId ||
            t.testId === jobDoc.testId ||
            (t.examId === jobDoc.examId && String(t.year) === String(jobDoc.year) && t.paperCode === jobDoc.paperCode)
        ).map(t => ({
            testId: t.testId,
            title: t.title || t.testId,
            status: t.status
        }));

        // 3. Resolve other import jobs to protect shared files
        const allJobs = await client.listDocuments("paperImportJobs");
        const otherJobs = allJobs.filter(oj => oj.jobId !== jobId);
        const otherJobVaultFiles = new Set();
        for (const oj of otherJobs) {
            if (oj.sourceDocuments) {
                for (const docRef of Object.values(oj.sourceDocuments)) {
                    if (docRef?.localVaultPath) otherJobVaultFiles.add(docRef.localVaultPath);
                    if (docRef?.storagePath) otherJobVaultFiles.add(docRef.storagePath);
                }
            }
        }

        // 4. Trace exclusive source vault files to delete
        const storageFilesToDelete = [];
        const storageFilesPreserved = [];

        if (jobDoc.sourceDocuments) {
            for (const [docType, docRef] of Object.entries(jobDoc.sourceDocuments)) {
                if (docRef) {
                    const filePath = docRef.localVaultPath || docRef.storagePath;
                    if (filePath) {
                        if (otherJobVaultFiles.has(filePath)) {
                            storageFilesPreserved.push(filePath);
                        } else {
                            storageFilesToDelete.push(filePath);
                        }
                    }
                }
            }
        }

        // 5. Trace draft questions and answer keys
        const allQuestions = await client.listDocuments("mockQuestions");
        const draftTestId = jobDoc.draftPackage?.testId;
        const matchingQuestions = allQuestions.filter(q =>
            (draftTestId && q.testId === draftTestId) ||
            q.jobId === jobId
        );
        const draftQuestionIds = matchingQuestions.map(q => q.questionId || q.id);

        const allAnswerKeys = await client.listDocuments("mockAnswerKeys");
        const matchingAnswerKeys = allAnswerKeys.filter(ak =>
            (draftTestId && ak.testId === draftTestId) ||
            ak.jobId === jobId
        );
        const draftAnswerKeyIds = matchingAnswerKeys.map(ak => ak.answerKeyId || ak.id);

        for (const q of matchingQuestions) {
            const qPaths = [q.localVaultPath, q.storagePath, q.firebaseStoragePath, q.diagramUrl].filter(Boolean);
            for (const p of qPaths) {
                if (otherJobVaultFiles.has(p)) {
                    storageFilesPreserved.push(p);
                } else {
                    storageFilesToDelete.push(p);
                }
            }
        }

        const uniqueFilesToDelete = Array.from(new Set(storageFilesToDelete));
        const uniqueFilesPreserved = Array.from(new Set(storageFilesPreserved));

        const sanitizedJobId = jobId.replace(/[^a-zA-Z0-9_\-]/g, "_");
        const operationId = `del_job_${sanitizedJobId}_${Date.now()}`;

        const manifest = {
            operationId,
            jobId,
            testId: matchingTests.length === 1 ? matchingTests[0].testId : null,
            isJobDeletion: true,
            hasPublishedTests: matchingTests.some(t => t.status === "published"),
            matchingTests,
            jobSummary: {
                jobId: jobDoc.jobId,
                examId: jobDoc.examId,
                examName: jobDoc.examName || jobDoc.examId,
                year: jobDoc.year,
                paperCode: jobDoc.paperCode,
                status: jobDoc.status,
                stage: jobDoc.stage || "Incomplete import",
                extractedQuestionCount: jobDoc.extractedQuestionCount || draftQuestionIds.length,
                verifiedAnswerCount: jobDoc.verifiedAnswerCount || 0
            },
            counts: {
                draftQuestions: draftQuestionIds.length,
                draftAnswerKeys: draftAnswerKeyIds.length,
                storageFilesToDelete: uniqueFilesToDelete.length,
                storageFilesPreserved: uniqueFilesPreserved.length,
                publishedTests: matchingTests.filter(t => t.status === "published").length
            },
            records: {
                jobDocPath: `paperImportJobs/${jobId}`,
                draftQuestionIds,
                draftAnswerKeyIds,
                storageFilesToDelete: uniqueFilesToDelete,
                storageFilesPreserved: uniqueFilesPreserved,
                matchingTests
            },
            requestedBy: adminUid,
            requestedAt: new Date().toISOString(),
            reason: reason || "Administrative import job and draft data deletion",
            status: "MANIFEST_GENERATED",
            currentStage: null,
            stages: {
                blockJob: { status: "pending", completedAt: null },
                deletePublishedTests: { status: "pending", completedAt: null, testsCount: 0 },
                deleteDraftRecords: { status: "pending", completedAt: null, questionsCount: 0, keysCount: 0 },
                deleteJobStorageAssets: { status: "pending", completedAt: null, filesCount: 0 },
                deleteJobDocument: { status: "pending", completedAt: null },
                verifyJobCleanup: { status: "pending", completedAt: null }
            },
            errors: [],
            retryCount: 0,
            completedAt: null
        };

        await client.setDocument("mockTestDeletionOperations", operationId, manifest);
        return manifest;
    }

    /**
     * Execute deletion of an import job and its exclusive draft data
     */
    static async executeJobDeletion({
        operationId = null,
        jobId,
        confirmation,
        adminUid,
        reason = "",
        options = {}
    }) {
        if (!adminUid) {
            throw new Error("Admin authentication required for import job deletion.");
        }
        if (!jobId) {
            throw new Error("Missing canonical jobId for deletion.");
        }

        if (!this.validateConfirmationPhrase(jobId, confirmation)) {
            const err = new Error(`Confirmation mismatch: Please type the exact job ID '${jobId}' or 'DELETE ${jobId}' to confirm deletion.`);
            err.statusCode = 400;
            throw err;
        }

        const client = this._getClient(options);

        let manifest = null;
        if (operationId) {
            manifest = await client.getDocument("mockTestDeletionOperations", operationId);
        }

        if (!manifest || manifest.jobId !== jobId) {
            manifest = await this.generateJobDeletionManifest({ jobId, adminUid, reason, options: { ...options, client } });
            operationId = manifest.operationId;
        }

        manifest.status = "IN_PROGRESS";
        manifest.updatedAt = new Date().toISOString();
        if (reason) manifest.reason = reason;

        try {
            // STAGE 1: BLOCK JOB & MARK DELETING
            if (manifest.stages.blockJob.status !== "completed") {
                manifest.currentStage = "blockJob";
                const jobDoc = await client.getDocument("paperImportJobs", jobId);
                if (jobDoc) {
                    jobDoc.status = "deleting";
                    jobDoc.stage = "Import job undergoing permanent administrative deletion.";
                    jobDoc.deletionBlockedAt = new Date().toISOString();
                    jobDoc.deletionOperationId = operationId;
                    await client.setDocument("paperImportJobs", jobId, jobDoc);
                }
                manifest.stages.blockJob.status = "completed";
                manifest.stages.blockJob.completedAt = new Date().toISOString();
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // STAGE 2: CASCADE DELETE ANY PUBLISHED TESTS IF PRESENT
            if (manifest.stages.deletePublishedTests && manifest.stages.deletePublishedTests.status !== "completed") {
                manifest.currentStage = "deletePublishedTests";
                const tests = manifest.records.matchingTests || [];
                for (const t of tests) {
                    if (t.testId) {
                        try {
                            await this.executeDeletion({
                                testId: t.testId,
                                jobId,
                                confirmation: t.testId,
                                adminUid,
                                reason: `Cascade deletion from job ${jobId}`,
                                options: { ...options, client }
                            });
                        } catch (tErr) {
                            console.warn(`[MockTestDeletionService] Notice deleting test ${t.testId} for job ${jobId}:`, tErr.message);
                        }
                    }
                }
                manifest.stages.deletePublishedTests.status = "completed";
                manifest.stages.deletePublishedTests.completedAt = new Date().toISOString();
                manifest.stages.deletePublishedTests.testsCount = tests.length;
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // STAGE 3: DELETE DRAFT QUESTIONS & ANSWER KEYS
            if (manifest.stages.deleteDraftRecords.status !== "completed") {
                manifest.currentStage = "deleteDraftRecords";
                const qIds = manifest.records.draftQuestionIds || [];
                const akIds = manifest.records.draftAnswerKeyIds || [];

                for (const qId of qIds) {
                    await client.deleteDocument("mockQuestions", qId);
                }
                for (const akId of akIds) {
                    await client.deleteDocument("mockAnswerKeys", akId);
                }

                manifest.stages.deleteDraftRecords.status = "completed";
                manifest.stages.deleteDraftRecords.completedAt = new Date().toISOString();
                manifest.stages.deleteDraftRecords.questionsCount = qIds.length;
                manifest.stages.deleteDraftRecords.keysCount = akIds.length;
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // STAGE 3: DELETE EXCLUSIVE VAULT / STORAGE ASSETS
            if (manifest.stages.deleteJobStorageAssets.status !== "completed") {
                manifest.currentStage = "deleteJobStorageAssets";
                const filesToDelete = manifest.records.storageFilesToDelete || [];
                let deletedCount = 0;

                for (const filePath of filesToDelete) {
                    try {
                        const removed = await StorageVaultService.removeDraftFile(filePath);
                        if (removed) deletedCount++;
                    } catch (fileErr) {
                        console.warn(`[MockTestDeletionService] Notice cleaning job file ${filePath}:`, fileErr.message);
                        manifest.errors.push({
                            stage: "deleteJobStorageAssets",
                            file: filePath,
                            message: fileErr.message,
                            timestamp: new Date().toISOString()
                        });
                    }
                }

                manifest.stages.deleteJobStorageAssets.status = "completed";
                manifest.stages.deleteJobStorageAssets.completedAt = new Date().toISOString();
                manifest.stages.deleteJobStorageAssets.filesCount = deletedCount;
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // STAGE 4: DELETE CANONICAL paperImportJobs DOCUMENT & IN-MEMORY MAP
            if (manifest.stages.deleteJobDocument.status !== "completed") {
                manifest.currentStage = "deleteJobDocument";
                await client.deleteDocumentAndSubcollections("paperImportJobs", jobId);
                ImportJobPipelineService.deleteJobFromMemory(jobId);

                manifest.stages.deleteJobDocument.status = "completed";
                manifest.stages.deleteJobDocument.completedAt = new Date().toISOString();
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            // STAGE 5: VERIFY CLEANUP
            if (manifest.stages.verifyJobCleanup.status !== "completed") {
                manifest.currentStage = "verifyJobCleanup";
                const verifyDoc = await client.getDocument("paperImportJobs", jobId);
                if (verifyDoc) {
                    throw new Error(`Verification failed: Import job document 'paperImportJobs/${jobId}' still exists in Firestore after deletion.`);
                }
                manifest.stages.verifyJobCleanup.status = "completed";
                manifest.stages.verifyJobCleanup.completedAt = new Date().toISOString();
                await client.setDocument("mockTestDeletionOperations", operationId, manifest);
            }

            if (process.env.NODE_ENV !== "test") {
                UniversalFirestoreService.clearLocalCache();
            }

            manifest.status = "COMPLETED";
            manifest.currentStage = "completed";
            manifest.completedAt = new Date().toISOString();
            await client.setDocument("mockTestDeletionOperations", operationId, manifest);

            return {
                success: true,
                operationId,
                jobId,
                status: "COMPLETED",
                isJobDeletion: true,
                deletedCounts: {
                    draftQuestions: manifest.records.draftQuestionIds.length,
                    draftAnswerKeys: manifest.records.draftAnswerKeyIds.length,
                    storageFiles: manifest.stages.deleteJobStorageAssets.filesCount,
                    jobs: 1
                },
                sharedPreserved: {
                    storageFiles: manifest.records.storageFilesPreserved.length
                },
                completedAt: manifest.completedAt
            };

        } catch (err) {
            console.error(`[MockTestDeletionService] Job deletion interrupted at stage '${manifest.currentStage}':`, err.message);
            manifest.status = "FAILED";
            manifest.errors.push({
                stage: manifest.currentStage,
                error: err.message,
                timestamp: new Date().toISOString()
            });
            await client.setDocument("mockTestDeletionOperations", operationId, manifest).catch(() => {});

            const recoverableErr = new Error(`Job deletion failed during stage '${manifest.currentStage}': ${err.message}. Operation ID: ${operationId}. Can be retried.`);
            recoverableErr.operationId = operationId;
            recoverableErr.currentStage = manifest.currentStage;
            recoverableErr.statusCode = 500;
            throw recoverableErr;
        }
    }

    /**
     * Inspect status of a deletion operation
     */
    static async getDeletionOperation(operationId, options = {}) {
        if (!operationId) throw new Error("Missing operationId");
        const client = this._getClient(options);
        const op = await client.getDocument("mockTestDeletionOperations", operationId);
        if (!op) {
            const err = new Error(`Deletion operation '${operationId}' not found.`);
            err.statusCode = 404;
            throw err;
        }
        return op;
    }

    /**
     * Retry an interrupted or failed deletion operation
     */
    static async retryDeletion({ operationId, adminUid, options = {} }) {
        if (!operationId) throw new Error("Missing operationId for retry");
        if (!adminUid) throw new Error("Admin authentication required to retry deletion");

        const client = this._getClient(options);
        const manifest = await this.getDeletionOperation(operationId, { ...options, client });
        if (manifest.status === "COMPLETED") {
            return {
                success: true,
                alreadyCompleted: true,
                operationId,
                testId: manifest.testId || null,
                jobId: manifest.jobId || null,
                status: "COMPLETED",
                completedAt: manifest.completedAt
            };
        }

        manifest.retryCount = (manifest.retryCount || 0) + 1;
        manifest.updatedAt = new Date().toISOString();
        await client.setDocument("mockTestDeletionOperations", operationId, manifest);

        if (manifest.isJobDeletion) {
            return this.executeJobDeletion({
                operationId,
                jobId: manifest.jobId,
                confirmation: manifest.jobId,
                adminUid,
                reason: `${manifest.reason} (Retry #${manifest.retryCount})`,
                options: { ...options, client }
            });
        }

        return this.executeDeletion({
            operationId,
            testId: manifest.testId,
            jobId: manifest.jobId,
            confirmation: manifest.testId,
            adminUid,
            reason: `${manifest.reason} (Retry #${manifest.retryCount})`,
            options: { ...options, client }
        });
    }
}
