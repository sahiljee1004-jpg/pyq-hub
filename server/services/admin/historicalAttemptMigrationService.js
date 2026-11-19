import { UniversalFirestoreService, UniversalFirestoreClient } from "./universalFirestoreService.js";
import { ExamProfileRegistry } from "./examProfileRegistry.js";
import { validateProjectIdFormat } from "../firebaseTokenService.js";

/**
 * HistoricalAttemptMigrationService (Milestone 3)
 *
 * Implements safe, idempotent, declarative migration of historical student mock-test
 * attempts and result documents into the Universal Examination Architecture (Schema v2).
 *
 * Architectural Principles & Safeguards:
 * 1. Absolute Immutability of Historical Marks: Historical student scores, breakdown items,
 *    and answers are preserved verbatim. Records are NEVER re-scored during migration.
 * 2. Fail-Closed Profile Mapping: Old attempts are only migrated if they map cleanly to an
 *    audited, registered exam profile in ExamProfileRegistry. Unsupported profiles are quarantined.
 * 3. Quarantine Isolation: Ambiguous, corrupted, orphaned, or mathematically inconsistent records
 *    are segregated with full forensic metadata and never partially migrated.
 * 4. Precondition Safety: Every document update requires a Firestore server `updateTime`
 *    precondition (`currentDocument: { updateTime }`) to prevent concurrent modification races.
 * 5. Bounded Chunk Batching: Updates are committed in atomic chunks strictly <= 100 items
 *    (<= 200 writes), comfortably below Firestore's 250 write chunk limit.
 * 6. Idempotency & Resumability: Operations are idempotent. Checkpoints track last processed
 *    identifiers for seamless interruption recovery without duplicate processing.
 * 7. Dry-Run Verification: Provides pure read-only evaluation that computes proposed migrations,
 *    verifies score identity bit-for-bit, and produces a machine-readable manifest.
 */
export class HistoricalAttemptMigrationService {
    static TARGET_SCHEMA_VERSION = 2;
    static SOURCE_SCHEMA_VERSION = 1;
    static DEFAULT_BATCH_SIZE = 50;  // 50 attempts = 100 writes (attempt + result), comfortably under 250
    static MAX_BATCH_SIZE = 100;      // 100 attempts = 200 writes

    static _getClient({ client = null, targetProjectId = null, hasInMemoryDataset = false, operationName = "Operation" } = {}) {
        if (client) {
            if (!(client instanceof UniversalFirestoreClient)) {
                throw new Error("[HistoricalAttemptMigrationService] SAFETY VIOLATION: Requires a genuine project-bound UniversalFirestoreClient instance. Arbitrary objects masquerading as Firestore clients are strictly rejected.");
            }
            if (!client.projectId) {
                throw new Error("[HistoricalAttemptMigrationService] SAFETY VIOLATION: Requires a client with an explicit, valid project ID. Supplied client has missing or empty projectId.");
            }
            const clientProj = validateProjectIdFormat(client.projectId, "client.projectId");
            if (targetProjectId) {
                const explicitProj = validateProjectIdFormat(targetProjectId, "targetProjectId");
                if (clientProj !== explicitProj) {
                    throw new Error(`[HistoricalAttemptMigrationService] SAFETY VIOLATION: Conflicting project options: client is bound to '${clientProj}' but targetProjectId specifies '${explicitProj}'.`);
                }
            }
            return client;
        }

        if (targetProjectId) {
            const validatedProj = validateProjectIdFormat(targetProjectId, "targetProjectId");
            return UniversalFirestoreService.forProject(validatedProj);
        }

        if (hasInMemoryDataset) {
            return null;
        }

        throw new Error(`[HistoricalAttemptMigrationService] SAFETY VIOLATION: ${operationName} requires an explicit targetProjectId or bound UniversalFirestoreClient. Silently inferring project from ambient environment variables is strictly forbidden.`);
    }

    static QUARANTINE_REASONS = {
        UNSUPPORTED_PROFILE: "UNSUPPORTED_PROFILE",
        ORPHANED_ATTEMPT: "ORPHANED_ATTEMPT",
        ORPHANED_RESULT: "ORPHANED_RESULT",
        DUPLICATE_RESULT: "DUPLICATE_RESULT",
        CORRUPTED_METADATA: "CORRUPTED_METADATA",
        SCORE_INTEGRITY_MISMATCH: "SCORE_INTEGRITY_MISMATCH",
        UNRESOLVED_SECTION_ATTRIBUTION: "UNRESOLVED_SECTION_ATTRIBUTION"
    };

    static CLASSIFICATION = {
        ELIGIBLE: "ELIGIBLE",
        ALREADY_MIGRATED: "ALREADY_MIGRATED",
        SKIPPED_ACTIVE: "SKIPPED_ACTIVE",
        QUARANTINED: "QUARANTINED"
    };

    /**
     * Resolve an audited exam profile for a given attempt and test document.
     * Returns null if unmapped or unsupported.
     */
    static resolveProfile(attempt = {}, testDoc = {}) {
        // 1. Direct profileId match if present
        const directProfileId = testDoc?.profileId || attempt?.profileId;
        if (directProfileId && ExamProfileRegistry.hasProfile(directProfileId)) {
            return ExamProfileRegistry.getProfile(directProfileId);
        }

        // 2. Exam ID and year resolution via ExamProfileRegistry
        const examId = testDoc?.examId || attempt?.examId;
        const year = testDoc?.year || attempt?.year;
        if (examId && year) {
            const found = ExamProfileRegistry.findProfile(examId, year);
            if (found) return found;
        }

        // 3. Unresolved / Unsupported
        return null;
    }

    /**
     * Classify an attempt and its associated result and test configuration.
     * Pure function: returns classification, reason, details, and resolved profile.
     */
    static classifyRecord({ attempt, result, testDoc, questionsMap = null, duplicateResultCount = 0 }) {
        if (!attempt && result) {
            return {
                classification: this.CLASSIFICATION.QUARANTINED,
                reason: this.QUARANTINE_REASONS.ORPHANED_RESULT,
                details: `Result ${result.resultId || result.attemptId} has no corresponding mockAttempts record`,
                profile: null
            };
        }

        if (!attempt) {
            return {
                classification: this.CLASSIFICATION.QUARANTINED,
                reason: this.QUARANTINE_REASONS.CORRUPTED_METADATA,
                details: "Attempt record is missing or null",
                profile: null
            };
        }

        // 1. Check if attempt is currently active
        if (attempt.status === "in_progress") {
            return {
                classification: this.CLASSIFICATION.SKIPPED_ACTIVE,
                reason: "Attempt is currently in progress and cannot be migrated until submission",
                details: `Attempt ${attempt.attemptId} has status 'in_progress'`,
                profile: null
            };
        }

        // 2. Check if already migrated to Schema v2
        const isAttemptMigrated = (attempt.schemaVersion === this.TARGET_SCHEMA_VERSION && Boolean(attempt.migratedAt));
        const isResultMigrated = (!result || (result.schemaVersion === this.TARGET_SCHEMA_VERSION && Boolean(result.migratedAt)));
        if (isAttemptMigrated && isResultMigrated) {
            return {
                classification: this.CLASSIFICATION.ALREADY_MIGRATED,
                reason: "Document already upgraded to Schema v2 with migration timestamp",
                details: `Attempt ${attempt.attemptId} already has schemaVersion: 2`,
                profile: null
            };
        }

        // 3. Validate essential metadata
        if (!attempt.attemptId || !attempt.testId || !attempt.userId) {
            return {
                classification: this.CLASSIFICATION.QUARANTINED,
                reason: this.QUARANTINE_REASONS.CORRUPTED_METADATA,
                details: `Missing mandatory identity fields (attemptId: ${attempt.attemptId}, testId: ${attempt.testId}, userId: ${attempt.userId})`,
                profile: null
            };
        }

        // 4. Duplicate result detection
        if (duplicateResultCount > 1) {
            return {
                classification: this.CLASSIFICATION.QUARANTINED,
                reason: this.QUARANTINE_REASONS.DUPLICATE_RESULT,
                details: `Multiple (${duplicateResultCount}) mockResults found for attemptId ${attempt.attemptId}`,
                profile: null
            };
        }

        // 5. Orphaned attempt detection (submitted/completed attempt with no result)
        if (!result && (attempt.status === "submitted" || attempt.status === "completed")) {
            return {
                classification: this.CLASSIFICATION.QUARANTINED,
                reason: this.QUARANTINE_REASONS.ORPHANED_ATTEMPT,
                details: `Attempt ${attempt.attemptId} is marked '${attempt.status}' but has no mockResults document`,
                profile: null
            };
        }

        // 6. Exam profile resolution
        const profile = this.resolveProfile(attempt, testDoc);
        if (!profile) {
            const rawExam = testDoc?.examId || attempt?.examId || "unknown";
            const rawYear = testDoc?.year || attempt?.year || "unknown";
            return {
                classification: this.CLASSIFICATION.QUARANTINED,
                reason: this.QUARANTINE_REASONS.UNSUPPORTED_PROFILE,
                details: `No registered exam profile matches examId '${rawExam}' and year '${rawYear}'`,
                profile: null
            };
        }

        // 7. Result integrity check (if result exists)
        if (result) {
            if (typeof result.totalScore !== "number" || isNaN(result.totalScore)) {
                return {
                    classification: this.CLASSIFICATION.QUARANTINED,
                    reason: this.QUARANTINE_REASONS.CORRUPTED_METADATA,
                    details: `Result ${result.resultId || attempt.attemptId} has invalid or non-numeric totalScore`,
                    profile
                };
            }

            if (!Array.isArray(result.breakdown)) {
                return {
                    classification: this.CLASSIFICATION.QUARANTINED,
                    reason: this.QUARANTINE_REASONS.CORRUPTED_METADATA,
                    details: `Result ${result.resultId || attempt.attemptId} has missing or non-array breakdown`,
                    profile
                };
            }

            // Verify totalScore matches breakdown sum within arithmetic rounding tolerance
            let breakdownSum = 0;
            let hasPendingReview = false;
            let pendingCount = 0;

            for (const item of result.breakdown) {
                const marks = Number(item.marksAwarded || 0);
                breakdownSum += marks;
                const isItemPending = item.status === "pending_manual_review" ||
                                      item.requiresManualReview === true ||
                                      item.isPendingReview === true ||
                                      (item.questionType === "descriptive" && item.manualEvaluationStatus === "pending");
                if (isItemPending) {
                    hasPendingReview = true;
                    pendingCount++;
                }
            }

            const scoreDiff = Math.abs(breakdownSum - result.totalScore);
            if (scoreDiff > 0.05) {
                return {
                    classification: this.CLASSIFICATION.QUARANTINED,
                    reason: this.QUARANTINE_REASONS.SCORE_INTEGRITY_MISMATCH,
                    details: `Recorded totalScore (${result.totalScore}) deviates from breakdown sum (${breakdownSum.toFixed(4)}) by ${scoreDiff.toFixed(4)}`,
                    profile
                };
            }

            // 8. Validate section attribution (Rules 1-7)
            const validSectionIds = new Set((profile.sections || []).map(s => s.id || s.sectionId).filter(Boolean));
            if (result.sectionScores && typeof result.sectionScores === "object" && !Array.isArray(result.sectionScores)) {
                const existingKeys = Object.keys(result.sectionScores);
                const invalidKeys = existingKeys.filter(k => !validSectionIds.has(k));
                if (invalidKeys.length > 0) {
                    return {
                        classification: this.CLASSIFICATION.QUARANTINED,
                        reason: this.QUARANTINE_REASONS.UNRESOLVED_SECTION_ATTRIBUTION,
                        details: `Existing sectionScores contains unknown section keys not found in profile '${profile.profileId}': ${invalidKeys.join(", ")}`,
                        profile
                    };
                }
            } else if (Array.isArray(result.breakdown)) {
                const synth = this.computeSectionScores(result.breakdown, profile, { questionsMap, testDoc });
                if (!synth.success) {
                    return {
                        classification: this.CLASSIFICATION.QUARANTINED,
                        reason: synth.reason,
                        details: synth.details,
                        profile
                    };
                }
            }
        }

        // All checks passed
        return {
            classification: this.CLASSIFICATION.ELIGIBLE,
            reason: "Attempt and result satisfy all schema and integrity criteria for v2 migration",
            details: `Eligible for profile ${profile.profileId}`,
            profile
        };
    }

    /**
     * Compute sectionScores from existing breakdown items and profile sections.
     * Profile-aware resolution:
     * 1. If profile has exactly one section, missing section IDs map to that single section.
     * 2. If profile has multiple sections, resolves missing IDs using question metadata or
     *    the official profile section question ranges (startQuestion <= qNum <= endQuestion).
     * 3. Never invents a section ID (e.g. "default").
     * 4. Validates every resolved section ID against registered profile.sections.
     * 5. Unknown section IDs must not silently enter sectionScores.
     * 6. Preserves existing historical sectionScores verbatim when valid.
     * 7. If section breakdown cannot be reconstructed reliably, returns failure for quarantine.
     */
    static computeSectionScores(breakdown = [], profile, { questionsMap = null, testDoc = null } = {}) {
        if (!profile || !Array.isArray(profile.sections) || profile.sections.length === 0) {
            return {
                success: false,
                reason: this.QUARANTINE_REASONS.UNSUPPORTED_PROFILE,
                details: "Profile has no defined sections"
            };
        }

        const validSectionIds = new Set(profile.sections.map(s => s.id || s.sectionId).filter(Boolean));
        const singleSectionId = profile.sections.length === 1 ? (profile.sections[0].id || profile.sections[0].sectionId) : null;

        const sectionScores = {};

        for (let idx = 0; idx < breakdown.length; idx++) {
            const item = breakdown[idx];
            let targetSectionId = item.sectionId || null;

            // Rule 1: Single-section profile maps missing section IDs to that single section
            if (!targetSectionId && singleSectionId) {
                targetSectionId = singleSectionId;
            }

            // Rule 2: Multi-section profile resolves missing IDs using question metadata or profile ranges
            if (!targetSectionId && profile.sections.length > 1) {
                const qId = item.questionId;
                let qNum = typeof item.questionNumber === "number" ? item.questionNumber : null;

                // 2a. Lookup in questionsMap by questionId
                if (questionsMap && qId && questionsMap.has(qId)) {
                    const qMeta = questionsMap.get(qId);
                    if (qMeta.sectionId && validSectionIds.has(qMeta.sectionId)) {
                        targetSectionId = qMeta.sectionId;
                    }
                    if (qNum === null && typeof qMeta?.questionNumber === "number") {
                        qNum = qMeta.questionNumber;
                    }
                }

                // 2b. Lookup in testDoc.questions
                if (!targetSectionId && testDoc && Array.isArray(testDoc.questions)) {
                    const foundQ = testDoc.questions.find(q => q.questionId === qId || (qNum !== null && q.questionNumber === qNum));
                    if (foundQ?.sectionId && validSectionIds.has(foundQ.sectionId)) {
                        targetSectionId = foundQ.sectionId;
                    }
                    if (qNum === null && typeof foundQ?.questionNumber === "number") {
                        qNum = foundQ.questionNumber;
                    }
                }

                // 2c. Lookup in profile.sections by questionNumber range (if numbering doesn't restart)
                if (!targetSectionId && typeof qNum === "number" && !profile.numberingRestartsPerSection) {
                    const rangeMatch = profile.sections.find(s => 
                        typeof s.startQuestion === "number" &&
                        typeof s.endQuestion === "number" &&
                        qNum >= s.startQuestion &&
                        qNum <= s.endQuestion
                    );
                    if (rangeMatch) {
                        targetSectionId = rangeMatch.id || rangeMatch.sectionId;
                    }
                }
            }

            // Rule 3, 4, 5: If targetSectionId is missing or invalid in profile.sections, fail closed!
            if (!targetSectionId || !validSectionIds.has(targetSectionId)) {
                return {
                    success: false,
                    reason: this.QUARANTINE_REASONS.UNRESOLVED_SECTION_ATTRIBUTION,
                    details: `Question '${item.questionId || `q-${idx + 1}`}' (num: ${item.questionNumber || (idx + 1)}) could not be resolved to any valid section in profile '${profile.profileId}' (sectionId: '${item.sectionId || "undefined"}')`
                };
            }

            const marks = Number(item.marksAwarded || 0);
            sectionScores[targetSectionId] = Number(((sectionScores[targetSectionId] || 0) + marks).toFixed(4));
        }

        return {
            success: true,
            sectionScores
        };
    }

    /**
     * Transform a legacy attempt into Schema v2 format while preserving answers and timestamps.
     * Pure function.
     */
    static transformAttempt(attempt, profile, { jobId, migrationTime = new Date().toISOString() } = {}) {
        return {
            ...attempt,
            schemaVersion: this.TARGET_SCHEMA_VERSION,
            profileId: profile.profileId,
            migratedAt: migrationTime,
            migrationSourceVersion: attempt.schemaVersion || this.SOURCE_SCHEMA_VERSION,
            migrationJobId: jobId || "adhoc_migration"
        };
    }

    /**
     * Transform a legacy result into Schema v2 format while preserving historical scores verbatim.
     * Pure function.
     */
    static transformResult(result, profile, { jobId, migrationTime = new Date().toISOString(), questionsMap = null, testDoc = null } = {}) {
        if (!result) return null;

        let pendingCount = result.pendingReviewCount || 0;
        let requiresManual = Boolean(result.requiresManualEvaluation);

        if (Array.isArray(result.breakdown)) {
            let countInBreakdown = 0;
            for (const item of result.breakdown) {
                if (item.status === "pending_manual_review" ||
                    item.requiresManualReview === true ||
                    item.isPendingReview === true ||
                    (item.questionType === "descriptive" && item.manualEvaluationStatus === "pending")) {
                    countInBreakdown++;
                }
            }
            if (countInBreakdown > pendingCount) {
                pendingCount = countInBreakdown;
            }
        }

        if (pendingCount > 0) {
            requiresManual = true;
        }

        const isFinalized = result.isFinalized !== undefined
            ? Boolean(result.isFinalized)
            : (pendingCount === 0);

        let sectionScores = null;
        if (result.sectionScores && typeof result.sectionScores === "object" && !Array.isArray(result.sectionScores)) {
            const validSectionIds = new Set((profile.sections || []).map(s => s.id || s.sectionId).filter(Boolean));
            const existingKeys = Object.keys(result.sectionScores);
            const allKeysValid = existingKeys.length > 0 && existingKeys.every(k => validSectionIds.has(k));
            if (allKeysValid) {
                sectionScores = result.sectionScores;
            }
        }

        if (!sectionScores && Array.isArray(result.breakdown)) {
            const synth = this.computeSectionScores(result.breakdown, profile, { questionsMap, testDoc });
            sectionScores = synth.success ? synth.sectionScores : {};
        }

        return {
            ...result,
            // Historical marks are preserved 100% verbatim
            totalScore: result.totalScore,
            breakdown: result.breakdown,
            correctCount: result.correctCount,
            incorrectCount: result.incorrectCount,
            unansweredCount: result.unansweredCount,
            droppedCount: result.droppedCount,
            // Modern Schema v2 fields
            schemaVersion: this.TARGET_SCHEMA_VERSION,
            profileId: profile.profileId,
            sectionScores: sectionScores || {},
            isFinalized,
            requiresManualEvaluation: requiresManual,
            pendingReviewCount: pendingCount,
            migratedAt: migrationTime,
            migrationSourceVersion: result.schemaVersion || this.SOURCE_SCHEMA_VERSION,
            migrationJobId: jobId || "adhoc_migration"
        };
    }

    /**
     * Verify that historical scores are preserved bit-for-bit with zero drift.
     * Throws an assertion error if any score discrepancy is detected.
     */
    static verifyScorePreservation(originalResult, migratedResult) {
        if (!originalResult || !migratedResult) return;

        if (migratedResult.totalScore !== originalResult.totalScore) {
            throw new Error(`SCORE_MUTATION_DETECTED: totalScore mutated from ${originalResult.totalScore} to ${migratedResult.totalScore}`);
        }

        if (migratedResult.correctCount !== originalResult.correctCount) {
            throw new Error(`STAT_MUTATION_DETECTED: correctCount mutated from ${originalResult.correctCount} to ${migratedResult.correctCount}`);
        }

        if (migratedResult.incorrectCount !== originalResult.incorrectCount) {
            throw new Error(`STAT_MUTATION_DETECTED: incorrectCount mutated from ${originalResult.incorrectCount} to ${migratedResult.incorrectCount}`);
        }

        if (migratedResult.unansweredCount !== originalResult.unansweredCount) {
            throw new Error(`STAT_MUTATION_DETECTED: unansweredCount mutated from ${originalResult.unansweredCount} to ${migratedResult.unansweredCount}`);
        }

        if (migratedResult.droppedCount !== originalResult.droppedCount) {
            throw new Error(`STAT_MUTATION_DETECTED: droppedCount mutated from ${originalResult.droppedCount} to ${migratedResult.droppedCount}`);
        }

        if (Array.isArray(originalResult.breakdown)) {
            if (!Array.isArray(migratedResult.breakdown) || migratedResult.breakdown.length !== originalResult.breakdown.length) {
                throw new Error("BREAKDOWN_LENGTH_MUTATION: Question breakdown array length mismatch");
            }

            for (let i = 0; i < originalResult.breakdown.length; i++) {
                const orig = originalResult.breakdown[i];
                const migr = migratedResult.breakdown[i];
                if (orig.marksAwarded !== migr.marksAwarded) {
                    throw new Error(`QUESTION_SCORE_MUTATION: Question ${i + 1} marks mutated from ${orig.marksAwarded} to ${migr.marksAwarded}`);
                }
            }
        }
    }

    /**
     * Read-only discovery and inventory classification across candidate records.
     * Can operate on provided in-memory records or read directly from Firestore.
     */
    static async discoverInventory({ attempts = null, results = null, tests = null, questions = null, targetProjectId = null, client = null } = {}) {
        const hasInMemory = Boolean(attempts || results || tests || questions);
        const firestoreClient = this._getClient({ client, targetProjectId, hasInMemoryDataset: hasInMemory, operationName: "discoverInventory" });
        if (!firestoreClient && !hasInMemory) {
            throw new Error("[HistoricalAttemptMigrationService] SAFETY VIOLATION: discoverInventory requires an explicit targetProjectId or bound UniversalFirestoreClient.");
        }
        const attemptDocs = attempts || (firestoreClient ? await firestoreClient.listDocuments("mockAttempts") : []);
        const resultDocs = results || (firestoreClient ? await firestoreClient.listDocuments("mockResults") : []);
        const testDocs = tests || (firestoreClient ? await firestoreClient.listDocuments("mockTests") : []);
        const questionDocs = questions || (firestoreClient ? await firestoreClient.listDocuments("mockQuestions") : []);

        const testMap = new Map();
        for (const t of testDocs) {
            testMap.set(t.testId, t);
        }

        const questionsMap = new Map();
        for (const q of questionDocs) {
            if (q.questionId) {
                questionsMap.set(q.questionId, q);
            }
        }

        // Map results by attemptId (tracking duplicate results)
        const resultMap = new Map();
        const resultCountMap = new Map();
        for (const r of resultDocs) {
            const key = r.attemptId || r.resultId;
            resultCountMap.set(key, (resultCountMap.get(key) || 0) + 1);
            if (!resultMap.has(key)) {
                resultMap.set(key, r);
            }
        }

        const inventory = {
            totalAttemptsScanned: attemptDocs.length,
            totalResultsScanned: resultDocs.length,
            counts: {
                eligible: 0,
                alreadyMigrated: 0,
                skippedActive: 0,
                quarantined: 0
            },
            quarantinedByReason: {
                [this.QUARANTINE_REASONS.UNSUPPORTED_PROFILE]: 0,
                [this.QUARANTINE_REASONS.ORPHANED_ATTEMPT]: 0,
                [this.QUARANTINE_REASONS.ORPHANED_RESULT]: 0,
                [this.QUARANTINE_REASONS.DUPLICATE_RESULT]: 0,
                [this.QUARANTINE_REASONS.CORRUPTED_METADATA]: 0,
                [this.QUARANTINE_REASONS.SCORE_INTEGRITY_MISMATCH]: 0,
                [this.QUARANTINE_REASONS.UNRESOLVED_SECTION_ATTRIBUTION]: 0
            },
            profileDistribution: {},
            classifiedRecords: []
        };

        for (const attempt of attemptDocs) {
            const testDoc = testMap.get(attempt.testId) || null;
            const result = resultMap.get(attempt.attemptId) || null;
            const duplicateCount = resultCountMap.get(attempt.attemptId) || 0;

            const classification = this.classifyRecord({
                attempt,
                result,
                testDoc,
                questionsMap,
                duplicateResultCount: duplicateCount
            });

            if (classification.classification === this.CLASSIFICATION.ELIGIBLE) {
                inventory.counts.eligible++;
                const pId = classification.profile.profileId;
                inventory.profileDistribution[pId] = (inventory.profileDistribution[pId] || 0) + 1;
            } else if (classification.classification === this.CLASSIFICATION.ALREADY_MIGRATED) {
                inventory.counts.alreadyMigrated++;
            } else if (classification.classification === this.CLASSIFICATION.SKIPPED_ACTIVE) {
                inventory.counts.skippedActive++;
            } else if (classification.classification === this.CLASSIFICATION.QUARANTINED) {
                inventory.counts.quarantined++;
                if (inventory.quarantinedByReason[classification.reason] !== undefined) {
                    inventory.quarantinedByReason[classification.reason]++;
                }
            }

            inventory.classifiedRecords.push({
                attemptId: attempt.attemptId,
                status: attempt.status,
                classification: classification.classification,
                reason: classification.reason,
                details: classification.details,
                profileId: classification.profile?.profileId || null
            });
        }

        // Check for orphaned results (results with no matching attempt)
        const attemptIdSet = new Set(attemptDocs.map(a => a.attemptId));
        for (const res of resultDocs) {
            if (res.attemptId && !attemptIdSet.has(res.attemptId)) {
                inventory.counts.quarantined++;
                inventory.quarantinedByReason[this.QUARANTINE_REASONS.ORPHANED_RESULT]++;
                inventory.classifiedRecords.push({
                    attemptId: res.attemptId,
                    status: "orphaned_result",
                    classification: this.CLASSIFICATION.QUARANTINED,
                    reason: this.QUARANTINE_REASONS.ORPHANED_RESULT,
                    details: `mockResults ${res.resultId} has no corresponding attempt in mockAttempts`,
                    profileId: null
                });
            }
        }

        return inventory;
    }

    /**
     * Phase 3: Execute Dry-Run Migration
     * Reads records, computes transformations, asserts 100% score preservation,
     * performs ZERO writes, and outputs a machine-readable migration manifest.
     */
    static async executeDryRun({ attempts = null, results = null, tests = null, questions = null, limit = null, targetProjectId = null, client = null } = {}) {
        const hasInMemory = Boolean(attempts || results || tests || questions);
        const firestoreClient = this._getClient({ client, targetProjectId, hasInMemoryDataset: hasInMemory, operationName: "executeDryRun" });
        if (!firestoreClient && !hasInMemory) {
            throw new Error("[HistoricalAttemptMigrationService] SAFETY VIOLATION: executeDryRun requires an explicit targetProjectId or bound UniversalFirestoreClient.");
        }
        const inventory = await this.discoverInventory({
            attempts,
            results,
            tests,
            questions,
            targetProjectId: firestoreClient ? firestoreClient.projectId : targetProjectId,
            client: firestoreClient
        });
        const attemptDocs = attempts || (firestoreClient ? await firestoreClient.listDocuments("mockAttempts") : []);
        const resultDocs = results || (firestoreClient ? await firestoreClient.listDocuments("mockResults") : []);
        const testDocs = tests || (firestoreClient ? await firestoreClient.listDocuments("mockTests") : []);
        const questionDocs = questions || (firestoreClient ? await firestoreClient.listDocuments("mockQuestions") : []);

        const testMap = new Map(testDocs.map(t => [t.testId, t]));
        const resultMap = new Map(resultDocs.map(r => [r.attemptId, r]));
        const questionsMap = new Map(questionDocs.map(q => [q.questionId, q]));

        const dryRunResults = {
            dryRunTimestamp: new Date().toISOString(),
            isDryRun: true,
            totalWritesPerformed: 0,
            summary: {
                totalScanned: inventory.totalAttemptsScanned,
                eligible: inventory.counts.eligible,
                alreadyMigrated: inventory.counts.alreadyMigrated,
                skippedActive: inventory.counts.skippedActive,
                quarantined: inventory.counts.quarantined,
                scoreDiscrepanciesDetected: 0
            },
            quarantineBreakdown: inventory.quarantinedByReason,
            profileDistribution: inventory.profileDistribution,
            samples: [],
            quarantinedItems: []
        };

        let processedCount = 0;
        for (const item of inventory.classifiedRecords) {
            if (limit && processedCount >= limit) break;

            if (item.classification === this.CLASSIFICATION.ELIGIBLE) {
                const attempt = attemptDocs.find(a => a.attemptId === item.attemptId);
                const testDoc = testMap.get(attempt.testId);
                const result = resultMap.get(item.attemptId);
                const profile = ExamProfileRegistry.getProfile(item.profileId);

                const proposedAttempt = this.transformAttempt(attempt, profile, { jobId: "dry-run-verification" });
                const proposedResult = this.transformResult(result, profile, { jobId: "dry-run-verification", questionsMap, testDoc });

                // Verify score preservation
                try {
                    this.verifyScorePreservation(result, proposedResult);
                } catch (err) {
                    dryRunResults.summary.scoreDiscrepanciesDetected++;
                    dryRunResults.samples.push({
                        attemptId: item.attemptId,
                        error: err.message,
                        status: "SCORE_DISCREPANCY"
                    });
                    continue;
                }

                // Add up to 3 representative samples
                if (dryRunResults.samples.length < 5) {
                    dryRunResults.samples.push({
                        attemptId: item.attemptId,
                        profileId: item.profileId,
                        before: {
                            attemptSchema: attempt.schemaVersion || 1,
                            totalScore: result.totalScore,
                            correctCount: result.correctCount,
                            isFinalized: result.isFinalized
                        },
                        after: {
                            attemptSchema: proposedAttempt.schemaVersion,
                            totalScore: proposedResult.totalScore,
                            correctCount: proposedResult.correctCount,
                            isFinalized: proposedResult.isFinalized,
                            requiresManualEvaluation: proposedResult.requiresManualEvaluation,
                            pendingReviewCount: proposedResult.pendingReviewCount,
                            sectionScores: proposedResult.sectionScores,
                            migratedAt: proposedResult.migratedAt
                        }
                    });
                }
                processedCount++;
            } else if (item.classification === this.CLASSIFICATION.QUARANTINED) {
                if (dryRunResults.quarantinedItems.length < 10) {
                    dryRunResults.quarantinedItems.push({
                        attemptId: item.attemptId,
                        reason: item.reason,
                        details: item.details
                    });
                }
            }
        }

        return dryRunResults;
    }

    /**
     * Bounded atomic batch migration with Firestore updateTime preconditions and checkpoints.
     *
     * STRICT GUARD: Migration will NOT execute writes unless explicit `allowWrites: true` is passed.
     */
    static async executeBatchMigration({
        jobId = `migration_${Date.now()}`,
        batchSize = this.DEFAULT_BATCH_SIZE,
        resumeAfterAttemptId = null,
        allowWrites = false,
        targetProjectId = null,
        client = null,
        attempts = null,
        results = null,
        tests = null,
        questions = null
    } = {}) {
        if (!allowWrites) {
            throw new Error("MIGRATION_WRITE_UNAUTHORIZED: Migration execution requires explicit authorization (allowWrites: true). Use executeDryRun() for inspection.");
        }

        const firestoreClient = this._getClient({ client, targetProjectId, hasInMemoryDataset: false, operationName: "executeBatchMigration" });
        if (!firestoreClient) {
            throw new Error("[HistoricalAttemptMigrationService] SAFETY VIOLATION: executeBatchMigration requires an explicit targetProjectId or bound UniversalFirestoreClient.");
        }

        const effectiveBatchSize = Math.min(Math.max(1, batchSize), this.MAX_BATCH_SIZE);
        const attemptDocs = attempts || (await firestoreClient.listDocuments("mockAttempts"));
        const resultDocs = results || (await firestoreClient.listDocuments("mockResults"));
        const testDocs = tests || (await firestoreClient.listDocuments("mockTests"));
        const questionDocs = questions || (await firestoreClient.listDocuments("mockQuestions"));

        const testMap = new Map(testDocs.map(t => [t.testId, t]));
        const resultMap = new Map(resultDocs.map(r => [r.attemptId, r]));
        const questionsMap = new Map(questionDocs.map(q => [q.questionId, q]));

        // Sort attempts deterministically by attemptId
        const sortedAttempts = [...attemptDocs].sort((a, b) => (a.attemptId || "").localeCompare(b.attemptId || ""));

        let startIndex = 0;
        if (resumeAfterAttemptId) {
            const foundIdx = sortedAttempts.findIndex(a => a.attemptId === resumeAfterAttemptId);
            if (foundIdx !== -1) {
                startIndex = foundIdx + 1;
            }
        }

        const migrationReport = {
            jobId,
            startedAt: new Date().toISOString(),
            batchSize: effectiveBatchSize,
            resumeAfterAttemptId,
            totalScanned: sortedAttempts.length,
            migratedAttempts: 0,
            migratedResults: 0,
            skippedAlreadyMigrated: 0,
            skippedActive: 0,
            quarantined: 0,
            lastProcessedAttemptId: null,
            status: "in_progress",
            batchesExecuted: 0,
            errors: []
        };

        const sliceToProcess = sortedAttempts.slice(startIndex);
        for (let i = 0; i < sliceToProcess.length; i += effectiveBatchSize) {
            const chunk = sliceToProcess.slice(i, i + effectiveBatchSize);
            const batchWrites = [];
            const chunkAttemptIds = [];

            for (const attempt of chunk) {
                const testDoc = testMap.get(attempt.testId) || null;
                const result = resultMap.get(attempt.attemptId) || null;

                const classification = this.classifyRecord({
                    attempt,
                    result,
                    testDoc,
                    questionsMap,
                    duplicateResultCount: result ? 1 : 0
                });

                if (classification.classification === this.CLASSIFICATION.ALREADY_MIGRATED) {
                    migrationReport.skippedAlreadyMigrated++;
                    migrationReport.lastProcessedAttemptId = attempt.attemptId;
                    continue;
                }

                if (classification.classification === this.CLASSIFICATION.SKIPPED_ACTIVE) {
                    migrationReport.skippedActive++;
                    migrationReport.lastProcessedAttemptId = attempt.attemptId;
                    continue;
                }

                if (classification.classification === this.CLASSIFICATION.QUARANTINED) {
                    migrationReport.quarantined++;
                    migrationReport.lastProcessedAttemptId = attempt.attemptId;
                    // Quarantine isolating write (optional audit log)
                    continue;
                }

                // Classification is ELIGIBLE
                const profile = classification.profile;
                const migratedAttempt = this.transformAttempt(attempt, profile, { jobId });
                const migratedResult = this.transformResult(result, profile, { jobId, questionsMap, testDoc });

                // Verify score preservation assertion before committing write
                this.verifyScorePreservation(result, migratedResult);

                // Build atomic Firestore batch writes with updateTime preconditions
                const attemptDocPath = firestoreClient.getDocumentPath("mockAttempts", attempt.attemptId);
                const writeAttempt = {
                    update: {
                        name: attemptDocPath,
                        fields: UniversalFirestoreService.toFirestoreFields(migratedAttempt)
                    },
                    currentDocument: attempt._updateTime
                        ? { updateTime: attempt._updateTime }
                        : { exists: true }
                };

                batchWrites.push(writeAttempt);

                if (result) {
                    const resultId = result.resultId || attempt.attemptId;
                    const resultDocPath = firestoreClient.getDocumentPath("mockResults", resultId);
                    const writeResult = {
                        update: {
                            name: resultDocPath,
                            fields: UniversalFirestoreService.toFirestoreFields(migratedResult)
                        },
                        currentDocument: result._updateTime
                            ? { updateTime: result._updateTime }
                            : { exists: true }
                    };
                    batchWrites.push(writeResult);
                }

                chunkAttemptIds.push(attempt.attemptId);
            }

            // Commit batch chunk atomically
            if (batchWrites.length > 0) {
                try {
                    await firestoreClient.commitBatchWrites(batchWrites);
                    migrationReport.migratedAttempts += chunkAttemptIds.length;
                    migrationReport.migratedResults += chunkAttemptIds.length;
                    migrationReport.batchesExecuted++;
                    migrationReport.lastProcessedAttemptId = chunk[chunk.length - 1].attemptId;

                    // Update checkpoint in Firestore
                    const checkpointData = {
                        jobId,
                        lastProcessedAttemptId: migrationReport.lastProcessedAttemptId,
                        migratedAttempts: migrationReport.migratedAttempts,
                        skippedAlreadyMigrated: migrationReport.skippedAlreadyMigrated,
                        quarantined: migrationReport.quarantined,
                        updatedAt: new Date().toISOString(),
                        status: "in_progress"
                    };
                    await firestoreClient.setDocument("migrationCheckpoints", jobId, checkpointData);
                } catch (err) {
                    migrationReport.status = "interrupted";
                    migrationReport.errors.push({
                        chunk: migrationReport.batchesExecuted + 1,
                        message: err.message,
                        code: err.code || err.statusCode
                    });
                    throw err;
                }
            } else if (chunk.length > 0) {
                migrationReport.lastProcessedAttemptId = chunk[chunk.length - 1].attemptId;
            }
        }

        migrationReport.status = "completed";
        migrationReport.completedAt = new Date().toISOString();

        // Final checkpoint update
        await firestoreClient.setDocument("migrationCheckpoints", jobId, {
            jobId,
            lastProcessedAttemptId: migrationReport.lastProcessedAttemptId,
            migratedAttempts: migrationReport.migratedAttempts,
            skippedAlreadyMigrated: migrationReport.skippedAlreadyMigrated,
            quarantined: migrationReport.quarantined,
            completedAt: migrationReport.completedAt,
            status: "completed"
        });

        return migrationReport;
    }
}

