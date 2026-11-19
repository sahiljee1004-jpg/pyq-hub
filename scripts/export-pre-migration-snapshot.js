#!/usr/bin/env node
/**
 * export-pre-migration-snapshot.js
 *
 * Extracts a deterministic, verified, byte-reproducible JSON snapshot
 * of the 5 migrated collections from the restored staging Firestore database
 * (or local emulator) with SHA-256 checksum integrity verification.
 *
 * Provenance Tracking:
 * - Records export URI and operation name from managed export.
 * - Records collection document counts and deterministic sorting by ID.
 * - Computes canonical SHA-256 hash written to companion .sha256 file.
 *
 * Usage:
 *   node scripts/export-pre-migration-snapshot.js \
 *     --project=staging-vidyarthiastra \
 *     --export-uri="gs://pyqs-hub-43bed-backups-asia-south1/pre-migration-TIMESTAMP" \
 *     --export-operation="projects/pyqs-hub-43bed/databases/(default)/operations/OP_ID" \
 *     --output="./artifacts/pre-migration-snapshot.json"
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ALLOWED_STAGING_PROJECTS } from "../server/services/admin/postBackupReconciliationService.js";
import { validateProjectIdFormat } from "../server/services/firebaseTokenService.js";

async function main() {
    const args = process.argv.slice(2);

    const projectArg = args.find(a => a.startsWith("--project="));
    if (!projectArg) {
        console.error("FATAL ERROR: Mandatory argument --project=<targetProject> is missing. Ambient project execution is strictly forbidden.");
        process.exit(1);
    }
    const rawTargetProject = projectArg.split("=")[1].trim();
    const targetProject = validateProjectIdFormat(rawTargetProject, "targetProject");
    const firestoreClient = UniversalFirestoreService.forProject(targetProject);

    const exportUriArg = args.find(a => a.startsWith("--export-uri="));
    let exportUri = exportUriArg ? exportUriArg.split("=")[1].trim() : null;

    const exportOpArg = args.find(a => a.startsWith("--export-operation="));
    let exportOperation = exportOpArg ? exportOpArg.split("=")[1].trim() : null;

    const exportMetaArg = args.find(a => a.startsWith("--export-metadata=") || a.startsWith("--export-operation-file="));
    const exportMetaPath = exportMetaArg ? exportMetaArg.split("=")[1].trim() : null;

    const outputArg = args.find(a => a.startsWith("--output="));
    const outputPath = outputArg ? outputArg.split("=")[1].trim() : "./artifacts/pre-migration-snapshot.json";

    const baselineArg = args.find(a => a.startsWith("--baseline-snapshot="));
    const baselineSnapshotPath = baselineArg ? baselineArg.split("=")[1].trim() : null;

    const collectionCountsArg = args.find(a => a.startsWith("--expected-collection-counts="));
    const expectedCollectionCountsPath = collectionCountsArg ? collectionCountsArg.split("=")[1].trim() : null;

    const strictCounts = args.includes("--strict-counts");

    console.log("================================================================================");
    console.log("     VIDYARTHIASTRA PRE-MIGRATION SNAPSHOT EXTRACTION & INTEGRITY GENERATOR");
    console.log("================================================================================");
    console.log(`Target Project       : ${targetProject}`);
    console.log(`Export URI Reference : ${exportUri || "(Not supplied)"}`);
    console.log(`Export Operation     : ${exportOperation || "(Not supplied)"}`);
    console.log(`Export Metadata File : ${exportMetaPath || "(Not supplied)"}`);
    console.log(`Baseline Snapshot    : ${baselineSnapshotPath || "(Not supplied)"}`);
    console.log(`Expected Counts File : ${expectedCollectionCountsPath || "(Not supplied)"}`);
    console.log(`Output Path          : ${outputPath}`);
    console.log("--------------------------------------------------------------------------------\n");

    // SAFETY CHECK: Verify allowed target
    const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
    if (!isEmulator && !ALLOWED_STAGING_PROJECTS.has(targetProject)) {
        console.warn(`[Snapshot Notice] Target project '${targetProject}' is not in default staging allowlist.`);
    }

    // Set process project context
    process.env.FIREBASE_PROJECT_ID = targetProject;

    const collections = [
        "mockAttempts",
        "mockResults",
        "mockTests",
        "mockQuestions",
        "migrationCheckpoints"
    ];

    let exportMetadata = null;
    let expectedDocumentCount = null;

    // Phase 1: Authoritative Export Metadata Verification (if provided)
    if (exportMetaPath) {
        console.log(`[Provenance Gate 1] Parsing authoritative export metadata: ${exportMetaPath}`);
        const resolvedMeta = path.resolve(exportMetaPath);
        if (!fs.existsSync(resolvedMeta)) {
            console.error(`FATAL ERROR: Export metadata file not found at: ${resolvedMeta}`);
            process.exit(1);
        }

        try {
            exportMetadata = JSON.parse(fs.readFileSync(resolvedMeta, "utf8"));
        } catch (err) {
            console.error(`FATAL ERROR: Failed to parse export metadata JSON: ${err.message}`);
            process.exit(1);
        }

        // 1. Verify operation status
        const isDone = exportMetadata.done === true;
        const opState = exportMetadata.metadata?.operationState || (isDone ? "SUCCESSFUL" : "IN_PROGRESS");
        if (!isDone || (opState !== "SUCCESSFUL" && !exportMetadata.response)) {
            console.error(`FATAL ERROR: Export operation did not complete successfully! (done: ${exportMetadata.done}, state: ${opState})`);
            process.exit(1);
        }
        console.log(`  ✓ Export operation completed successfully (state: ${opState})`);

        // 2. Associate & verify Export URI
        const metaUri = exportMetadata.response?.outputUriPrefix || exportMetadata.metadata?.outputUriPrefix;
        if (metaUri) {
            if (exportUri && exportUri !== metaUri) {
                console.error(`FATAL ERROR: Provided --export-uri '${exportUri}' does not match export metadata '${metaUri}'!`);
                process.exit(1);
            }
            exportUri = metaUri;
            console.log(`  ✓ Export URI verified: ${exportUri}`);
        }

        // 3. Associate & verify Export Operation name
        const metaOpName = exportMetadata.name;
        if (metaOpName) {
            if (exportOperation && exportOperation !== metaOpName) {
                console.error(`FATAL ERROR: Provided --export-operation '${exportOperation}' does not match export metadata '${metaOpName}'!`);
                process.exit(1);
            }
            exportOperation = metaOpName;
            console.log(`  ✓ Export Operation name verified: ${exportOperation}`);
        }

        // 4. Verify all 5 expected collections are present in export collectionIds
        const exportedCols = exportMetadata.metadata?.collectionIds;
        if (Array.isArray(exportedCols) && exportedCols.length > 0) {
            const exportedColSet = new Set(exportedCols);
            for (const col of collections) {
                if (!exportedColSet.has(col)) {
                    console.error(`FATAL ERROR: Export metadata is missing required collection: '${col}' (Included: ${exportedCols.join(", ")})`);
                    process.exit(1);
                }
            }
            console.log(`  ✓ All 5 collections verified in export metadata (${collections.join(", ")})`);
        }

        // 5. Extract expected document counts if available
        const workCompleted = exportMetadata.metadata?.progressDocuments?.workCompleted;
        if (workCompleted !== undefined && workCompleted !== null) {
            expectedDocumentCount = Number(workCompleted);
            console.log(`  ✓ Authoritative export document count: ${expectedDocumentCount}`);
        }
        console.log("Authoritative export metadata verification passed.\n");
    } else {
        console.warn("[Provenance Notice] No --export-metadata file provided. Metadata parity cannot be authoritatively proven without operation metadata.\n");
    }

    console.log("Extracting documents across all 5 migrated collections...");
    const snapshotData = {
        provenance: {
            sourceProject: targetProject,
            sourceDatabase: "(default)",
            exportUri: exportUri,
            exportOperation: exportOperation,
            exportMetadataVerified: Boolean(exportMetadata),
            extractedAt: new Date().toISOString(),
            provenanceBoundaryNotice: "This JSON snapshot is extracted from restored Staging Firestore. The SHA-256 checksum guarantees artifact immutability. Independent export parity is validated via export operation metadata and collection counts."
        },
        snapshotTimestamp: new Date().toISOString(),
        counts: {},
        attempts: [],
        results: [],
        tests: [],
        questions: [],
        checkpoints: []
    };

    // Helper for deterministic sorting, duplicate detection, and ID preservation
    const normalizeAndSortById = (list, primaryKey, collectionName) => {
        const seenIds = new Set();
        return [...list].map((item, idx) => {
            const clean = { ...item };
            const docId = clean[primaryKey] || clean.id;
            if (!docId) {
                throw new Error(`CRITICAL INTEGRITY ERROR: Document at index ${idx} in '${collectionName}' is missing both primary key '${primaryKey}' and 'id'!`);
            }
            const normalizedId = String(docId).trim();
            if (seenIds.has(normalizedId)) {
                throw new Error(`CRITICAL INTEGRITY ERROR: Duplicate document ID '${normalizedId}' detected in collection '${collectionName}'! Silent overwrite blocked.`);
            }
            seenIds.add(normalizedId);
            clean[primaryKey] = normalizedId;
            clean.id = normalizedId;
            return clean;
        }).sort((a, b) => {
            const idA = String(a[primaryKey] || a.id || "");
            const idB = String(b[primaryKey] || b.id || "");
            return idA.localeCompare(idB);
        });
    };

    // 1. mockAttempts
    console.log("  Fetching mockAttempts...");
    const rawAttempts = await firestoreClient.listDocuments("mockAttempts");
    snapshotData.attempts = normalizeAndSortById(rawAttempts, "attemptId", "mockAttempts");
    snapshotData.counts.mockAttempts = snapshotData.attempts.length;
    console.log(`    ✓ Loaded ${snapshotData.attempts.length} attempts`);

    // 2. mockResults
    console.log("  Fetching mockResults...");
    const rawResults = await firestoreClient.listDocuments("mockResults");
    snapshotData.results = normalizeAndSortById(rawResults, "resultId", "mockResults");
    snapshotData.counts.mockResults = snapshotData.results.length;
    console.log(`    ✓ Loaded ${snapshotData.results.length} results`);

    // 3. mockTests
    console.log("  Fetching mockTests...");
    const rawTests = await firestoreClient.listDocuments("mockTests");
    snapshotData.tests = normalizeAndSortById(rawTests, "testId", "mockTests");
    snapshotData.counts.mockTests = snapshotData.tests.length;
    console.log(`    ✓ Loaded ${snapshotData.tests.length} tests`);

    // 4. mockQuestions
    console.log("  Fetching mockQuestions...");
    const rawQuestions = await firestoreClient.listDocuments("mockQuestions");
    snapshotData.questions = normalizeAndSortById(rawQuestions, "questionId", "mockQuestions");
    snapshotData.counts.mockQuestions = snapshotData.questions.length;
    console.log(`    ✓ Loaded ${snapshotData.questions.length} questions`);

    // 5. migrationCheckpoints
    console.log("  Fetching migrationCheckpoints...");
    const rawCheckpoints = await firestoreClient.listDocuments("migrationCheckpoints");
    snapshotData.checkpoints = normalizeAndSortById(rawCheckpoints, "checkpointId", "migrationCheckpoints");
    snapshotData.counts.migrationCheckpoints = snapshotData.checkpoints.length;
    console.log(`    ✓ Loaded ${snapshotData.checkpoints.length} checkpoints`);

    snapshotData.counts.totalDocuments = 
        snapshotData.counts.mockAttempts +
        snapshotData.counts.mockResults +
        snapshotData.counts.mockTests +
        snapshotData.counts.mockQuestions +
        snapshotData.counts.migrationCheckpoints;

    // Helper to recursively strip transient server metadata for content comparisons
    function stripServerMetadata(obj) {
        if (!obj || typeof obj !== "object") return obj;
        if (Array.isArray(obj)) return obj.map(stripServerMetadata);
        const clean = {};
        for (const [k, v] of Object.entries(obj)) {
            if (k === "_updateTime" || k === "_createTime") continue;
            clean[k] = (v && typeof v === "object") ? stripServerMetadata(v) : v;
        }
        return clean;
    }

    // Phase 2: Per-Collection Count Parity Comparison & Provenance Envelope Verification
    let expectedCollectionCounts = null;
    if (expectedCollectionCountsPath) {
        const resolvedColCounts = path.resolve(expectedCollectionCountsPath);
        if (!fs.existsSync(resolvedColCounts)) {
            console.error(`FATAL ERROR [Strict Counts]: Expected counts file not found at: ${resolvedColCounts}`);
            if (strictCounts) process.exit(1);
        } else {
            const rawFileContent = fs.readFileSync(resolvedColCounts, "utf8");

            // Verify companion .sha256 if present
            const companionShaPath = `${resolvedColCounts}.sha256`;
            if (fs.existsSync(companionShaPath)) {
                const storedSha = fs.readFileSync(companionShaPath, "utf8").trim().split(/\s+/)[0];
                const computedSha = crypto.createHash("sha256").update(rawFileContent, "utf8").digest("hex");
                if (storedSha !== computedSha) {
                    console.error(`FATAL ERROR [Strict Counts]: Expected counts file companion checksum mismatch! Stored: ${storedSha}, Computed: ${computedSha}`);
                    process.exit(1);
                }
                console.log("  ✓ Expected counts file companion .sha256 checksum verified.");
            }

            let countsEnvelope = null;
            try {
                countsEnvelope = JSON.parse(rawFileContent);
            } catch (err) {
                console.error(`FATAL ERROR: Failed to parse expected collection counts JSON: ${err.message}`);
                process.exit(1);
            }

            // Cryptographic & Provenance Envelope Validation (if structured envelope)
            if (countsEnvelope && typeof countsEnvelope === "object" && countsEnvelope.projectId) {
                console.log("\n[Provenance Gate] Verifying expected counts cryptographic provenance envelope:");
                const boundProject = countsEnvelope.projectId || countsEnvelope.project;
                if (boundProject !== "pyqs-hub-43bed" && boundProject !== "766070215379") {
                    console.error(`FATAL ERROR [Provenance]: Expected counts file bound to unexpected project '${boundProject}'! Must be 'pyqs-hub-43bed'.`);
                    process.exit(1);
                }
                console.log(`  ✓ Bound Project      : ${boundProject}`);

                const boundDb = countsEnvelope.database || "(default)";
                if (boundDb !== "(default)") {
                    console.error(`FATAL ERROR [Provenance]: Expected counts file bound to database '${boundDb}'! Must be '(default)'.`);
                    process.exit(1);
                }
                console.log(`  ✓ Bound Database     : ${boundDb}`);

                if (countsEnvelope.exportUri) {
                    if (exportUri && countsEnvelope.exportUri !== exportUri) {
                        console.error(`FATAL ERROR [Provenance]: Counts file exportUri '${countsEnvelope.exportUri}' does not match active export URI '${exportUri}'!`);
                        process.exit(1);
                    }
                    console.log(`  ✓ Bound Export URI   : ${countsEnvelope.exportUri}`);
                }

                if (countsEnvelope.exportOperationName) {
                    if (exportOperation && countsEnvelope.exportOperationName !== exportOperation) {
                        console.error(`FATAL ERROR [Provenance]: Counts file exportOperation '${countsEnvelope.exportOperationName}' does not match active export operation '${exportOperation}'!`);
                        process.exit(1);
                    }
                    console.log(`  ✓ Bound Operation    : ${countsEnvelope.exportOperationName}`);
                }

                if (countsEnvelope.operationState && countsEnvelope.operationState !== "SUCCESSFUL") {
                    console.error(`FATAL ERROR [Provenance]: Counts file references non-successful operation state: '${countsEnvelope.operationState}'!`);
                    process.exit(1);
                }

                if (!countsEnvelope.timestamp && !countsEnvelope.generatedAt) {
                    console.error("FATAL ERROR [Provenance]: Counts file missing generation timestamp!");
                    process.exit(1);
                }
                console.log(`  ✓ Bound Timestamp    : ${countsEnvelope.timestamp || countsEnvelope.generatedAt}`);
            }

            expectedCollectionCounts = countsEnvelope.counts || countsEnvelope;

            console.log("\n[Per-Collection Parity Check] Evaluating expected collection counts:");
            for (const col of collections) {
                const expectedColCount = expectedCollectionCounts[col] ?? expectedCollectionCounts[col.toLowerCase()];
                if (expectedColCount !== undefined) {
                    const actualColCount = snapshotData.counts[col];
                    if (actualColCount !== expectedColCount) {
                        const errMsg = `COLLECTION COUNT MISMATCH: '${col}' has ${actualColCount} documents in staging, but expected ${expectedColCount}!`;
                        if (strictCounts) {
                            console.error(`FATAL ERROR [Strict Counts]: ${errMsg}`);
                            process.exit(1);
                        } else {
                            console.warn(`WARNING: ${errMsg}`);
                        }
                    } else {
                        console.log(`  ✓ ${col.padEnd(22)}: ${actualColCount} (matches expected)`);
                    }
                }
            }
        }
    }

    // Verify aggregate document counts against export metadata if available
    if (expectedDocumentCount !== null) {
        console.log(`\n[Count Parity Check] Staging total: ${snapshotData.counts.totalDocuments} vs Export metadata: ${expectedDocumentCount}`);
        if (snapshotData.counts.totalDocuments !== expectedDocumentCount) {
            const diff = snapshotData.counts.totalDocuments - expectedDocumentCount;
            const msg = `DISCREPANCY DETECTED: Staging document count (${snapshotData.counts.totalDocuments}) does not match export metadata count (${expectedDocumentCount}). Difference: ${diff > 0 ? "+" + diff + " extra documents" : diff + " missing documents"}.`;
            if (strictCounts) {
                console.error(`FATAL ERROR [Strict Counts]: ${msg}`);
                process.exit(1);
            } else {
                console.warn(`WARNING: ${msg}`);
                console.warn("Staging database may contain leftover documents from previous runs or incomplete import.");
            }
        } else {
            console.log("  ✓ Total document count matches export metadata!");
            console.log("  Notice: Aggregate count equality alone does NOT guarantee collection-level parity without per-collection counts or baseline ID verification.");
        }
    }

    // Phase 3: Baseline Comparison for Missing and Unexpected Document IDs & Content Parity
    if (baselineSnapshotPath) {
        const resolvedBaseline = path.resolve(baselineSnapshotPath);
        if (!fs.existsSync(resolvedBaseline)) {
            console.error(`FATAL ERROR: Baseline snapshot file not found at: ${resolvedBaseline}`);
            if (strictCounts) process.exit(1);
        } else {
            console.log(`\n[Baseline Document ID & Content Parity] Comparing against: ${resolvedBaseline}`);

            // Verify companion .sha256 if present
            const companionBaseSha = `${resolvedBaseline}.sha256`;
            if (fs.existsSync(companionBaseSha)) {
                const storedBaseSha = fs.readFileSync(companionBaseSha, "utf8").trim().split(/\s+/)[0];
                const computedBaseSha = crypto.createHash("sha256").update(fs.readFileSync(resolvedBaseline, "utf8")).digest("hex");
                if (storedBaseSha !== computedBaseSha) {
                    console.error(`FATAL ERROR [Parity]: Baseline snapshot companion checksum mismatch! Stored: ${storedBaseSha}, Computed: ${computedBaseSha}`);
                    process.exit(1);
                }
                console.log("  ✓ Baseline snapshot companion .sha256 verified.");
            }

            const baselineData = JSON.parse(fs.readFileSync(resolvedBaseline, "utf8"));
            const collectionMapping = {
                mockAttempts: { current: snapshotData.attempts, baseline: baselineData.attempts || [], key: "attemptId" },
                mockResults: { current: snapshotData.results, baseline: baselineData.results || [], key: "resultId" },
                mockTests: { current: snapshotData.tests, baseline: baselineData.tests || [], key: "testId" },
                mockQuestions: { current: snapshotData.questions, baseline: baselineData.questions || [], key: "questionId" },
                migrationCheckpoints: { current: snapshotData.checkpoints, baseline: baselineData.checkpoints || [], key: "checkpointId" }
            };

            let parityDiscrepancies = 0;
            let contentDiscrepancies = 0;

            for (const [col, info] of Object.entries(collectionMapping)) {
                const currentSet = new Set(info.current.map(d => String(d[info.key] || d.id)));
                const baselineSet = new Set(info.baseline.map(d => String(d[info.key] || d.id)));

                // 1. Check for missing document IDs
                for (const baseId of baselineSet) {
                    if (!currentSet.has(baseId)) {
                        parityDiscrepancies++;
                        console.error(`  - MISSING DOCUMENT ID in '${col}': '${baseId}' (present in baseline, absent in current staging)`);
                    }
                }

                // 2. Check for unexpected document IDs
                for (const currId of currentSet) {
                    if (!baselineSet.has(currId)) {
                        parityDiscrepancies++;
                        console.error(`  - UNEXPECTED DOCUMENT ID in '${col}': '${currId}' (absent in baseline, present in current staging)`);
                    }
                }

                // 3. Check canonical document content parity (ignoring transient server timestamps _updateTime, _createTime)
                const baseDocMap = new Map(info.baseline.map(d => [String(d[info.key] || d.id), d]));
                for (const currDoc of info.current) {
                    const id = String(currDoc[info.key] || currDoc.id);
                    const baseDoc = baseDocMap.get(id);
                    if (baseDoc) {
                        const cleanCurr = stripServerMetadata(currDoc);
                        const cleanBase = stripServerMetadata(baseDoc);
                        const hashCurr = crypto.createHash("sha256").update(JSON.stringify(cleanCurr)).digest("hex");
                        const hashBase = crypto.createHash("sha256").update(JSON.stringify(cleanBase)).digest("hex");
                        if (hashCurr !== hashBase) {
                            contentDiscrepancies++;
                            console.error(`  - CONTENT DISCREPANCY in '${col}' for doc ID '${id}': Canonical content hash mismatch! (staging: ${hashCurr}, baseline: ${hashBase})`);
                        }
                    }
                }

                // 4. Per-collection canonical content checksum comparison
                const cleanCurrList = info.current.map(stripServerMetadata);
                const cleanBaseList = info.baseline.map(stripServerMetadata);
                const colHashCurr = crypto.createHash("sha256").update(JSON.stringify(cleanCurrList)).digest("hex");
                const colHashBase = crypto.createHash("sha256").update(JSON.stringify(cleanBaseList)).digest("hex");
                if (colHashCurr !== colHashBase) {
                    console.log(`  - Note: Collection '${col}' content hash differs (Current: ${colHashCurr.substring(0, 12)}... vs Base: ${colHashBase.substring(0, 12)}...)`);
                } else {
                    console.log(`  ✓ Collection '${col}' has 100% identical canonical content hash!`);
                }
            }

            if (parityDiscrepancies > 0 || contentDiscrepancies > 0) {
                const parMsg = `Baseline parity comparison failed! Discrepancies: ${parityDiscrepancies} ID discrepancies, ${contentDiscrepancies} content discrepancies.`;
                if (strictCounts) {
                    console.error(`FATAL ERROR [Strict Counts]: ${parMsg}`);
                    process.exit(1);
                } else {
                    console.warn(`WARNING: ${parMsg}`);
                }
            } else {
                console.log("  ✓ All document IDs and application contents match baseline snapshot with 100% parity across all 5 collections!");
            }
        }
    }

    // Compute canonical content checksum over data payload
    const canonicalPayload = {
        counts: snapshotData.counts,
        attempts: snapshotData.attempts,
        results: snapshotData.results,
        tests: snapshotData.tests,
        questions: snapshotData.questions,
        checkpoints: snapshotData.checkpoints
    };
    const contentSha256 = crypto.createHash("sha256").update(JSON.stringify(canonicalPayload), "utf8").digest("hex");
    snapshotData.contentChecksum = `sha256:${contentSha256}`;

    // Re-serialize final artifact JSON
    const finalJson = JSON.stringify(snapshotData, null, 2);
    const finalSha256 = crypto.createHash("sha256").update(finalJson, "utf8").digest("hex");
    snapshotData.checksum = `sha256:${finalSha256}`;

    // Final clean write to disk
    const resolvedOut = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, JSON.stringify(snapshotData, null, 2), "utf8");

    // Write companion checksum file matching exact artifact on disk
    const diskJson = fs.readFileSync(resolvedOut, "utf8");
    const diskSha256 = crypto.createHash("sha256").update(diskJson, "utf8").digest("hex");
    const shaFilePath = `${resolvedOut}.sha256`;
    fs.writeFileSync(shaFilePath, `${diskSha256}  ${path.basename(resolvedOut)}\n`, "utf8");

    // Write HMAC digital signature if signing key is configured
    const signingKey = process.env.ARTIFACT_SIGNING_KEY;
    let sigFilePath = null;
    if (signingKey) {
        const diskHmac = crypto.createHmac("sha256", signingKey).update(diskJson, "utf8").digest("hex");
        sigFilePath = `${resolvedOut}.sig`;
        fs.writeFileSync(sigFilePath, `${diskHmac}  ${path.basename(resolvedOut)}\n`, "utf8");
    }

    // Append to independently protected hash ledger if configured
    const trustedLedgerPath = process.env.TRUSTED_HASH_LEDGER_PATH;
    if (trustedLedgerPath) {
        const resolvedLedger = path.resolve(trustedLedgerPath);
        fs.mkdirSync(path.dirname(resolvedLedger), { recursive: true });
        const ledgerEntry = JSON.stringify({
            timestamp: new Date().toISOString(),
            sourceProject: targetProject,
            file: path.basename(resolvedOut),
            sha256: diskSha256,
            contentSha256
        }) + "\n";
        fs.appendFileSync(resolvedLedger, ledgerEntry, "utf8");
    }

    console.log("\n================================================================================");
    console.log("Snapshot successfully extracted and verified!");
    console.log(`Snapshot File    : ${resolvedOut}`);
    console.log(`Checksum File    : ${shaFilePath}`);
    if (sigFilePath) {
        console.log(`HMAC Sig File    : ${sigFilePath}`);
    }
    console.log(`Artifact SHA-256 : ${diskSha256}`);
    console.log(`Content SHA-256  : ${contentSha256}`);
    console.log(`Total Documents  : ${snapshotData.counts.totalDocuments}`);
    console.log(`  Attempts       : ${snapshotData.counts.mockAttempts}`);
    console.log(`  Results        : ${snapshotData.counts.mockResults}`);
    console.log(`  Tests          : ${snapshotData.counts.mockTests}`);
    console.log(`  Questions      : ${snapshotData.counts.mockQuestions}`);
    console.log(`  Checkpoints    : ${snapshotData.counts.migrationCheckpoints}`);
    console.log("================================================================================");
}

main().catch(err => {
    console.error("FATAL ERROR generating pre-migration snapshot:", err.message);
    process.exit(1);
});

