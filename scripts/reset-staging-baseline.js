#!/usr/bin/env node
/**
 * reset-staging-baseline.js
 *
 * Safe Staging Baseline Reset Utility (Milestone 3)
 *
 * Purpose:
 * Prepares an authoritative, clean baseline in an isolated staging Firestore database
 * prior to executing a managed restore (`gcloud firestore import`).
 *
 * Problem Solved:
 * `gcloud firestore import` is an additive upsert operation. It DOES NOT delete documents
 * created after the backup or leftover from interrupted test runs. To prevent post-export
 * data pollution, staging collections must be purged before import.
 *
 * Strict Multi-Layered Safety Constraints:
 * 1. Absolute Production Block: Unconditionally rejects production project (pyqs-hub-43bed).
 * 2. Staging Allowlist: Accepts ONLY allowlisted staging / emulator project IDs.
 * 3. Mandatory Explicit Arguments: Requires explicit --project=<id> and --database=(default).
 * 4. Recovery Export Prerequisite: Verifies that an authoritative, successful recovery export
 *    metadata record exists BEFORE any destructive write occurs.
 * 5. Fixed Targets: Targets ONLY the exact 5 migrated collections. No dynamic collection inputs.
 * 6. Nested Subcollections: Discovers and deletes nested subcollections recursively.
 * 7. Bounded Batches: Processes deletions in bounded chunks.
 * 8. Post-Purge Verification: Queries all 5 collections afterward to prove they are 100% empty.
 * 9. Tamper-Evident Audit Trail: Writes execution audit log and companion .sha256 file.
 * 10. Direct Invocation Guard: Prevents accidental execution by library import.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ALLOWED_STAGING_PROJECTS } from "../server/services/admin/postBackupReconciliationService.js";
import {
    getFirebaseConfigDiagnostics,
    validateProjectIdFormat,
    validateServiceAccountCredentials
} from "../server/services/firebaseTokenService.js";

// Frozen constant of exact collections permitted for reset
export const TARGET_COLLECTIONS = Object.freeze([
    "mockAttempts",
    "mockResults",
    "mockTests",
    "mockQuestions",
    "migrationCheckpoints"
]);

const PROD_PROJECT_ID = "pyqs-hub-43bed";
const PROD_PROJECT_NUMBER = "766070215379";
const EXPECTED_DATABASE = "(default)";
const BATCH_CHUNK_SIZE = 25;

export async function executeStagingReset(options = {}) {
    const {
        project,
        database,
        confirmReset = false,
        recoveryExportMetadataPath = null,
        outputPath = "./artifacts/staging-reset-audit.json",
        allowUnverifiedExportForTesting = false
    } = options;

    const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

    // Safety Gate 1: Mandatory Explicit Project Argument
    if (!project || typeof project !== "string" || project.trim() === "") {
        throw new Error("SAFETY VIOLATION [Gate 1]: Explicit --project=<stagingProjectId> is mandatory. Defaulting to ambient project is forbidden.");
    }
    const targetProject = validateProjectIdFormat(project, "targetProject");

    // Safety Gate 2: Absolute Production Block Across All Environment Sources & Authenticated Credentials
    const diag = getFirebaseConfigDiagnostics(targetProject);
    const blockedProjects = new Set([PROD_PROJECT_ID, PROD_PROJECT_NUMBER]);
    const envSources = [
        targetProject,
        process.env.FIREBASE_PROJECT_ID,
        process.env.GOOGLE_CLOUD_PROJECT,
        process.env.GCLOUD_PROJECT,
        UniversalFirestoreService.projectId,
        diag.serviceAccountProjectId
    ].filter(Boolean);

    for (const src of envSources) {
        if (blockedProjects.has(src) || src.includes("pyqs-hub") || src.includes("prod")) {
            throw new Error(`CRITICAL SAFETY VIOLATION [Gate 2]: Staging baseline reset is STRICTLY FORBIDDEN on production project identifier '${src}'. Never execute against pyqs-hub-43bed.`);
        }
    }

    if (diag.serviceAccountEmail && (diag.serviceAccountEmail.includes("pyqs-hub-43bed") || diag.serviceAccountEmail.includes("766070215379"))) {
        throw new Error(`CRITICAL SAFETY VIOLATION [Gate 2]: Authenticated Google Cloud service account '${diag.serviceAccountEmail}' belongs to PRODUCTION. Production credentials cannot be used during staging reset.`);
    }

    if (process.env.NODE_ENV === "production") {
        throw new Error("CRITICAL SAFETY VIOLATION [Gate 2]: NODE_ENV is 'production'. Reset utility cannot execute in production mode.");
    }

    // Safety Gate 3: Staging Project Allowlist
    if (!ALLOWED_STAGING_PROJECTS.has(targetProject)) {
        throw new Error(`CRITICAL SAFETY VIOLATION [Gate 3]: Project '${targetProject}' is not in allowed staging list (${Array.from(ALLOWED_STAGING_PROJECTS).join(", ")}).`);
    }

    if (!isEmulator && process.env.ALLOW_STAGING_CLOUD_WRITES) {
        if (!diag.hasServiceAccount) {
            throw new Error(`CRITICAL SAFETY VIOLATION [Gate 2]: Live staging reset against real cloud project '${targetProject}' requires explicit credentials via GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT. No valid credentials found.`);
        }
    }

    if (diag.hasServiceAccount) {
        validateServiceAccountCredentials({
            project_id: diag.serviceAccountProjectId,
            client_email: diag.serviceAccountEmail
        }, targetProject);
    }

    // Print safe credential isolation diagnostics without exposing private keys or secrets
    console.log("\n[Credential Isolation Gate] Authenticated Google Cloud identity verified:");
    console.log(`  Target Staging Project : ${targetProject}`);
    console.log(`  Target Firestore DB    : ${EXPECTED_DATABASE}`);
    console.log(`  Emulator Environment   : ${isEmulator ? "ACTIVE (" + process.env.FIRESTORE_EMULATOR_HOST + ")" : "OFFLINE / LIVE CLOUD"}`);
    console.log(`  Has Service Account    : ${diag.hasServiceAccount}`);
    if (diag.hasServiceAccount) {
        console.log(`  Service Account Email  : ${diag.serviceAccountEmail}`);
        console.log(`  Service Account Project: ${diag.serviceAccountProjectId || "(not specified)"}`);
    }

    // Safety Gate 4: Mandatory Explicit Database Argument
    if (!database || typeof database !== "string" || database.trim() !== EXPECTED_DATABASE) {
        throw new Error(`SAFETY VIOLATION [Gate 4]: Explicit --database=${EXPECTED_DATABASE} is mandatory. Provided: '${database || ""}'.`);
    }

    // Safety Gate 5: Confirmation Flag Verification
    if (!confirmReset) {
        throw new Error("SAFETY VIOLATION [Gate 5]: Destructive staging baseline reset requires explicit confirmation flag: --confirm-staging-reset.");
    }

    // Bind project context across all environment variables and verify exact match with initialized Firestore client
    process.env.FIREBASE_PROJECT_ID = targetProject;
    process.env.GOOGLE_CLOUD_PROJECT = targetProject;
    process.env.GCLOUD_PROJECT = targetProject;
    UniversalFirestoreService.setProjectId(targetProject);
    UniversalFirestoreService.ensureProject(targetProject);
    const firestoreClient = UniversalFirestoreService.forProject(targetProject);

    // Safety Gate 6: Real Cloud Write Safeguard
    if (!isEmulator && !process.env.ALLOW_STAGING_CLOUD_WRITES) {
        throw new Error(`CRITICAL SAFETY VIOLATION [Gate 6]: Live reset against real cloud project '${targetProject}' is blocked without FIRESTORE_EMULATOR_HOST or ALLOW_STAGING_CLOUD_WRITES=true.`);
    }

    // Safety Gate 7: Authoritative Recovery Export Verification (Prerequisite before ANY deletion)
    let verifiedExportUri = null;
    let verifiedExportOp = null;

    if (recoveryExportMetadataPath) {
        const resolvedExportMeta = path.resolve(recoveryExportMetadataPath);
        if (!fs.existsSync(resolvedExportMeta)) {
            throw new Error(`SAFETY VIOLATION [Gate 7]: Recovery export metadata file not found at: ${resolvedExportMeta}. Must prove recovery export exists before resetting staging.`);
        }
        let exportMeta = null;
        try {
            exportMeta = JSON.parse(fs.readFileSync(resolvedExportMeta, "utf8"));
        } catch (err) {
            throw new Error(`SAFETY VIOLATION [Gate 7]: Failed to parse recovery export metadata JSON: ${err.message}`);
        }

        const isDone = exportMeta.done === true;
        const opState = exportMeta.metadata?.operationState || (isDone ? "SUCCESSFUL" : "IN_PROGRESS");
        if (!isDone || (opState !== "SUCCESSFUL" && !exportMeta.response)) {
            throw new Error(`SAFETY VIOLATION [Gate 7]: Recovery export did not complete successfully (done: ${exportMeta.done}, state: ${opState}). Aborting reset!`);
        }

        // Verify source project and database
        const opName = exportMeta.name || "";
        if (!opName.includes("projects/pyqs-hub-43bed/") && !opName.includes("projects/766070215379/")) {
            throw new Error(`SAFETY VIOLATION [Gate 7]: Recovery export does not originate from authoritative production project 'pyqs-hub-43bed' (Operation: '${opName}').`);
        }
        if (!opName.includes("/databases/(default)/")) {
            throw new Error(`SAFETY VIOLATION [Gate 7]: Recovery export does not target database '(default)' (Operation: '${opName}').`);
        }

        // Verify expected bucket in outputUriPrefix
        const outUri = exportMeta.response?.outputUriPrefix || exportMeta.metadata?.outputUriPrefix || "";
        if (!outUri.startsWith("gs://pyqs-hub-43bed-backups-asia-south1/")) {
            throw new Error(`SAFETY VIOLATION [Gate 7]: Recovery export URI '${outUri}' does not point to authoritative bucket 'gs://pyqs-hub-43bed-backups-asia-south1/'.`);
        }

        // Verify all 5 collections are included in recovery export
        const exportedCols = exportMeta.metadata?.collectionIds;
        if (Array.isArray(exportedCols)) {
            const expSet = new Set(exportedCols);
            for (const col of TARGET_COLLECTIONS) {
                if (!expSet.has(col)) {
                    throw new Error(`SAFETY VIOLATION [Gate 7]: Recovery export is missing required collection '${col}'. Aborting reset!`);
                }
            }
        }

        verifiedExportUri = outUri;
        verifiedExportOp = opName;
    } else if (!allowUnverifiedExportForTesting) {
        throw new Error("CRITICAL SAFETY VIOLATION [Gate 7]: Refusing destructive staging deletion without verified recovery export metadata (--recovery-export-metadata=<path>). A usable recovery export must be proven before purging staging.");
    }

    const auditLog = {
        resetJobId: `reset_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        targetProject,
        targetDatabase: EXPECTED_DATABASE,
        startedAt: new Date().toISOString(),
        completedAt: null,
        executionOutcome: "IN_PROGRESS",
        isEmulator,
        recoveryExportUri: verifiedExportUri,
        recoveryExportOperation: verifiedExportOp,
        prePurgeCounts: {},
        purgedCounts: {},
        postPurgeVerificationCounts: {},
        survivingDescendantsCount: 0,
        totalPrePurgeDocuments: 0,
        totalPurgedDocuments: 0
    };

    const prePurgeAllDocPaths = [];

    async function discoverAllDescendantDocPaths(docPath, pathsArray) {
        pathsArray.push(docPath);
        const subColIds = await firestoreClient.listSubcollectionIds(docPath);
        for (const subColId of subColIds) {
            const subColPath = `${docPath}/${subColId}`;
            const childDocs = await firestoreClient.listDocuments(subColPath);
            for (const childDoc of childDocs) {
                const childId = childDoc.id || childDoc.name?.split("/").pop();
                if (childId) {
                    await discoverAllDescendantDocPaths(`${subColPath}/${childId}`, pathsArray);
                }
            }
        }
    }

    try {
        // Phase 1: Record Pre-Purge Document Counts & Paths Across All 5 Collections (and all nested descendants)
        for (const col of TARGET_COLLECTIONS) {
            const docs = await firestoreClient.listDocuments(col);
            auditLog.prePurgeCounts[col] = docs.length;
            auditLog.totalPrePurgeDocuments += docs.length;
            auditLog.purgedCounts[col] = 0;
            for (const d of docs) {
                const docId = d.id || d.attemptId || d.resultId || d.testId || d.questionId || d.checkpointId;
                if (docId) {
                    await discoverAllDescendantDocPaths(`${col}/${docId}`, prePurgeAllDocPaths);
                }
            }
        }

        // Phase 2: Execute Bounded Batch Deletions with Subcollection Discovery
        for (const col of TARGET_COLLECTIONS) {
            const docs = await firestoreClient.listDocuments(col);
            for (let i = 0; i < docs.length; i += BATCH_CHUNK_SIZE) {
                const batch = docs.slice(i, i + BATCH_CHUNK_SIZE);
                for (const doc of batch) {
                    const docId = doc.id || doc.attemptId || doc.resultId || doc.testId || doc.questionId || doc.checkpointId;
                    if (docId) {
                        // deleteDocumentAndSubcollections discovers and recursively purges nested subcollections
                        await firestoreClient.deleteDocumentAndSubcollections(col, docId);
                        auditLog.purgedCounts[col]++;
                        auditLog.totalPurgedDocuments++;
                    }
                }
            }
        }

        // Phase 3: Post-Purge Emptiness & Descendant Verification Gate
        let allEmpty = true;
        let survivingDescendantsCount = 0;

        for (const col of TARGET_COLLECTIONS) {
            const remainingDocs = await firestoreClient.listDocuments(col);
            auditLog.postPurgeVerificationCounts[col] = remainingDocs.length;
            if (remainingDocs.length > 0) {
                allEmpty = false;
            }
        }

        // Verify that no subcollections or documents survived for any pre-purge document path
        for (const docPath of prePurgeAllDocPaths) {
            const survivingSubCols = await firestoreClient.listSubcollectionIds(docPath);
            if (survivingSubCols.length > 0) {
                survivingDescendantsCount += survivingSubCols.length;
                allEmpty = false;
            }
            const pathParts = docPath.split("/");
            if (pathParts.length >= 2) {
                const docId = pathParts.pop();
                const colPath = pathParts.join("/");
                const survivingDoc = await firestoreClient.getDocument(colPath, docId);
                if (survivingDoc !== null) {
                    survivingDescendantsCount++;
                    allEmpty = false;
                }
            }
        }
        auditLog.survivingDescendantsCount = survivingDescendantsCount;

        if (!allEmpty) {
            auditLog.executionOutcome = "FAILED_POST_PURGE_VERIFICATION_NOT_EMPTY";
            auditLog.completedAt = new Date().toISOString();
            _writeAuditRecord(outputPath, auditLog);
            throw new Error(`CRITICAL VERIFICATION ERROR: Staging collections or descendants are not completely empty after reset! Verification counts: ${JSON.stringify(auditLog.postPurgeVerificationCounts)}, Surviving descendants: ${survivingDescendantsCount}`);
        }

        auditLog.executionOutcome = "COMPLETED_CLEAN";
        auditLog.completedAt = new Date().toISOString();

        const writtenFiles = _writeAuditRecord(outputPath, auditLog);
        return { auditLog, writtenFiles };

    } catch (err) {
        if (auditLog.executionOutcome === "IN_PROGRESS") {
            auditLog.executionOutcome = `FAILED: ${err.message}`;
            auditLog.completedAt = new Date().toISOString();
            try {
                _writeAuditRecord(outputPath, auditLog);
            } catch (_) {}
        }
        throw err;
    }
}

function _writeAuditRecord(outputPath, auditLog, options = {}) {
    const signingKey = options.signingKey || process.env.ARTIFACT_SIGNING_KEY;
    const trustedLedgerPath = options.trustedLedgerPath || process.env.TRUSTED_HASH_LEDGER_PATH;

    const resolvedOut = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

    // Canonical serialization
    const auditJson = JSON.stringify(auditLog, null, 2);
    const auditSha256 = crypto.createHash("sha256").update(auditJson, "utf8").digest("hex");
    auditLog.auditSha256 = `sha256:${auditSha256}`;

    // Cryptographic HMAC signature if signing key is configured
    if (signingKey) {
        const hmac = crypto.createHmac("sha256", signingKey).update(auditJson, "utf8").digest("hex");
        auditLog.auditHmacSignature = `hmac-sha256:${hmac}`;
    }

    const finalJson = JSON.stringify(auditLog, null, 2);
    fs.writeFileSync(resolvedOut, finalJson, "utf8");

    const diskSha = crypto.createHash("sha256").update(finalJson, "utf8").digest("hex");
    const shaFilePath = `${resolvedOut}.sha256`;
    fs.writeFileSync(shaFilePath, `${diskSha}  ${path.basename(resolvedOut)}\n`, "utf8");

    // Independent HMAC signature file for adversary resistance
    let sigFilePath = null;
    if (signingKey) {
        const diskHmac = crypto.createHmac("sha256", signingKey).update(finalJson, "utf8").digest("hex");
        sigFilePath = `${resolvedOut}.sig`;
        fs.writeFileSync(sigFilePath, `${diskHmac}  ${path.basename(resolvedOut)}\n`, "utf8");
    }

    // Append to independently protected hash ledger if path provided
    if (trustedLedgerPath) {
        const resolvedLedger = path.resolve(trustedLedgerPath);
        fs.mkdirSync(path.dirname(resolvedLedger), { recursive: true });
        const ledgerEntry = JSON.stringify({
            timestamp: new Date().toISOString(),
            jobId: auditLog.resetJobId,
            outcome: auditLog.executionOutcome,
            targetProject: auditLog.targetProject,
            file: path.basename(resolvedOut),
            sha256: diskSha
        }) + "\n";
        fs.appendFileSync(resolvedLedger, ledgerEntry, "utf8");
    }

    return { auditFile: resolvedOut, shaFile: shaFilePath, sigFile: sigFilePath, sha256: diskSha };
}

// Direct Execution CLI Handler
async function main() {
    const args = process.argv.slice(2);

    const projectArg = args.find(a => a.startsWith("--project="));
    const project = projectArg ? projectArg.split("=")[1].trim() : null;

    const databaseArg = args.find(a => a.startsWith("--database="));
    const database = databaseArg ? databaseArg.split("=")[1].trim() : null;

    const confirmReset = args.includes("--confirm-staging-reset");

    const recoveryMetaArg = args.find(a => a.startsWith("--recovery-export-metadata="));
    const recoveryExportMetadataPath = recoveryMetaArg ? recoveryMetaArg.split("=")[1].trim() : null;

    const outputArg = args.find(a => a.startsWith("--output="));
    const outputPath = outputArg ? outputArg.split("=")[1].trim() : "./artifacts/staging-reset-audit.json";

    const allowUnverified = args.includes("--allow-unverified-export-for-testing");

    console.log("================================================================================");
    console.log("           VIDYARTHIASTRA SAFE STAGING BASELINE RESET UTILITY");
    console.log("================================================================================");
    console.log(`Target Project   : ${project || "(NOT SUPPLIED - MANDATORY)"}`);
    console.log(`Target Database  : ${database || "(NOT SUPPLIED - MANDATORY)"}`);
    console.log(`Recovery Export  : ${recoveryExportMetadataPath || (allowUnverified ? "(Unverified Test Override)" : "(NOT SUPPLIED - MANDATORY)")}`);
    console.log(`Output Audit Log : ${outputPath}`);
    console.log("--------------------------------------------------------------------------------\n");

    const { auditLog, writtenFiles } = await executeStagingReset({
        project,
        database,
        confirmReset,
        recoveryExportMetadataPath,
        outputPath,
        allowUnverifiedExportForTesting: allowUnverified
    });

    console.log("================================================================================");
    console.log("Staging baseline purge completed successfully!");
    console.log(`Total Documents Purged : ${auditLog.totalPurgedDocuments}`);
    console.log("Collections Purged     :");
    for (const [col, count] of Object.entries(auditLog.purgedCounts)) {
        console.log(`  - ${col.padEnd(22)}: ${count} documents (post-verification: 0 remaining)`);
    }
    console.log(`Audit Record Written   : ${writtenFiles.auditFile}`);
    console.log(`Audit Checksum File    : ${writtenFiles.shaFile} (${writtenFiles.sha256})`);
    console.log("Staging database is now completely clean and ready for managed cold import.");
    console.log("================================================================================");
}

// Direct Execution Guard: Only execute main() when invoked directly from CLI
const isDirectExecution = process.argv[1] && (
    process.argv[1] === fileURLToPath(import.meta.url) ||
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);

if (isDirectExecution) {
    main().catch(err => {
        console.error("FATAL ERROR in staging baseline reset:", err.message);
        process.exit(1);
    });
}
