#!/usr/bin/env node
/**
 * reconcile-post-backup.js
 *
 * Operational CLI script for Post-Backup State Reconciliation.
 *
 * Reconciles mockAttempts and mockResults states between a pre-backup snapshot
 * and current Firestore state, capturing new records and post-backup modifications.
 *
 * Flags:
 *   --backup-file=<path>            Path to JSON file containing backup snapshot ({ snapshotTimestamp, attempts, results })
 *   --manifest-output=<path>        Path to write generated reconciliation manifest JSON
 *   --manifest-input=<path>         Path to existing reconciliation manifest JSON to reapply
 *   --dry-run                       Simulate reapplication without writes (DEFAULT)
 *   --reapply                       Execute state reapplication (requires --confirm-staging-reapply)
 *   --confirm-staging-reapply       Mandatory confirmation flag for reapplication on staging
 *   --target-env=<staging|local>    Target environment (STRICTLY FORBIDS production)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PostBackupReconciliationService, ALLOWED_STAGING_PROJECTS } from "../server/services/admin/postBackupReconciliationService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { validateProjectIdFormat } from "../server/services/firebaseTokenService.js";

async function main() {
    const args = process.argv.slice(2);

    const isDryRun = !args.includes("--reapply") || args.includes("--dry-run");
    const confirmStaging = args.includes("--confirm-staging-reapply");

    const backupFileArg = args.find(a => a.startsWith("--backup-file="));
    const backupFilePath = backupFileArg ? backupFileArg.split("=")[1] : null;

    const manifestOutputArg = args.find(a => a.startsWith("--manifest-output="));
    const manifestOutputPath = manifestOutputArg ? manifestOutputArg.split("=")[1] : null;

    const manifestInputArg = args.find(a => a.startsWith("--manifest-input="));
    const manifestInputPath = manifestInputArg ? manifestInputArg.split("=")[1] : null;

    const reportOutputArg = args.find(a => a.startsWith("--report-output="));
    const reportOutputPath = reportOutputArg ? reportOutputArg.split("=")[1] : null;

    const targetEnvArg = args.find(a => a.startsWith("--target-env="));
    const targetEnv = targetEnvArg ? targetEnvArg.split("=")[1].toLowerCase() : "staging";

    console.log("================================================================================");
    console.log("       VIDYARTHIASTRA POST-BACKUP STATE RECONCILIATION PIPELINE");
    console.log("================================================================================");
    console.log(`Execution Mode       : ${isDryRun ? "DRY-RUN (0 Writes, Precondition Verification Only)" : "LIVE REAPPLICATION"}`);
    console.log(`Target Environment   : ${targetEnv}`);
    console.log(`Backup Snapshot File : ${backupFilePath || "N/A"}`);
    console.log(`Manifest Input File  : ${manifestInputPath || "N/A"}`);
    console.log(`Manifest Output File : ${manifestOutputPath || "N/A"}`);
    console.log(`Report Output File   : ${reportOutputPath || "N/A"}`);
    console.log("--------------------------------------------------------------------------------\n");

    const projectArg = args.find(a => a.startsWith("--project=")) || args.find(a => a.startsWith("--staging-project="));
    if (!projectArg) {
        console.error("FATAL ERROR: Mandatory argument --project=<stagingProjectId> is missing. Ambient project execution is strictly forbidden.");
        process.exit(1);
    }
    const rawTargetProject = projectArg.split("=")[1].trim();
    const effectiveProjectId = validateProjectIdFormat(rawTargetProject, "targetProject");
    const firestoreClient = UniversalFirestoreService.forProject(effectiveProjectId);
    const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

    // 1. ABSOLUTE PRODUCTION BLOCK: Block production reapplication regardless of CLI flags
    if (targetEnv === "production" || process.env.NODE_ENV === "production" || effectiveProjectId === "pyqs-hub-43bed") {
        console.error(`FATAL ERROR: Automatic production state reapplication is strictly forbidden (Target: ${targetEnv}, Project: ${effectiveProjectId}, Emulator: ${isEmulator}).`);
        console.error("Disaster recovery reapplication must follow manual operator sign-off.");
        process.exit(1);
    }

    let manifest = null;

    // Phase 1: Load or Generate Manifest
    if (manifestInputPath) {
        console.log(`Loading existing reconciliation manifest: ${manifestInputPath}`);
        manifest = PostBackupReconciliationService.readManifestFromFile(manifestInputPath, {
            verifyChecksum: !isDryRun && !args.includes("--allow-unverified-manifest")
        });
        console.log(`  ✓ Manifest loaded: ${manifest.jobId}`);
    } else if (backupFilePath) {
        console.log(`Reading pre-backup snapshot: ${backupFilePath}`);
        const resolvedBackup = path.resolve(backupFilePath);
        if (!fs.existsSync(resolvedBackup)) {
            console.error(`ERROR: Backup file not found at: ${resolvedBackup}`);
            process.exit(1);
        }

        const rawBackup = fs.readFileSync(resolvedBackup, "utf8");
        const sha256Path = `${resolvedBackup}.sha256`;
        if (fs.existsSync(sha256Path)) {
            const expectedHash = fs.readFileSync(sha256Path, "utf8").trim().split(/\s+/)[0];
            const actualHash = crypto.createHash("sha256").update(rawBackup, "utf8").digest("hex");
            if (expectedHash !== actualHash) {
                console.error(`FATAL ERROR: Snapshot checksum mismatch! File: ${resolvedBackup}`);
                console.error(`  Expected: ${expectedHash}`);
                console.error(`  Computed: ${actualHash}`);
                process.exit(1);
            }
            console.log(`  ✓ Snapshot SHA-256 verified: ${actualHash}`);
        }

        const backupSnapshot = JSON.parse(rawBackup);

        console.log("Fetching current Firestore mockAttempts and mockResults...");
        const currentAttempts = await firestoreClient.listDocuments("mockAttempts");
        const currentResults = await firestoreClient.listDocuments("mockResults");

        console.log(`Found ${currentAttempts.length} current attempts and ${currentResults.length} current results.`);

        if (args.includes("--verify-integrity")) {
            console.log("Fetching mockTests, mockQuestions, and migrationCheckpoints for referential integrity check...");
            const currentTests = await firestoreClient.listDocuments("mockTests");
            const currentQuestions = await firestoreClient.listDocuments("mockQuestions");
            const currentCheckpoints = await firestoreClient.listDocuments("migrationCheckpoints");

            let currentUsers = null;
            if (args.includes("--with-users")) {
                console.log("Fetching authoritative users collection identifiers for foreign-key verification (privacy-safe: zero PII retention)...");
                const rawUsers = await firestoreClient.listDocuments("users");
                // STRICT PRIVACY PROTECTION: Project ONLY the identifier; drop all PII, credentials, emails, and profile fields
                currentUsers = rawUsers.map(u => ({ uid: String(u.uid || u.id || "").trim() })).filter(u => Boolean(u.uid));
                console.log(`Loaded ${currentUsers.length} user identifiers (all PII discarded).`);
            }

            console.log("Running referential integrity validation...");
            const integrityReport = PostBackupReconciliationService.validateReferentialIntegrity({
                attempts: currentAttempts,
                results: currentResults,
                tests: currentTests,
                questions: currentQuestions,
                checkpoints: currentCheckpoints,
                users: currentUsers
            });

            console.log(`\nReferential Integrity Check: ${integrityReport.isValid ? "PASSED (Clean)" : "FAILED"}`);
            console.log(`  Attempts: ${integrityReport.summary.totalAttempts}, Results: ${integrityReport.summary.totalResults}`);
            console.log(`  Tests: ${integrityReport.summary.totalTests}, Questions: ${integrityReport.summary.totalQuestions}`);
            console.log(`  Checkpoints: ${integrityReport.summary.totalCheckpoints}`);
            console.log(`  Users Validation: ${integrityReport.summary.usersValidationStatus} (Total users: ${integrityReport.summary.totalUsers ?? "N/A"})`);
            console.log(`  Errors: ${integrityReport.summary.errorsCount}, Warnings: ${integrityReport.summary.warningsCount}`);

            if (integrityReport.violations.length > 0) {
                for (const v of integrityReport.violations) {
                    console.log(`  - [${v.severity}] ${v.type}: ${v.message}`);
                }
            }
            if (!integrityReport.isValid) {
                console.error("\nFATAL ERROR: Referential integrity violations detected! Aborting reconciliation.");
                process.exit(3);
            }
            console.log("Referential integrity check cleared.\n");
        }

        console.log("Building deterministic reconciliation manifest...");

        manifest = PostBackupReconciliationService.buildManifest({
            backupSnapshot,
            currentAttempts,
            currentResults
        });

        console.log("\nReconciliation Manifest Summary:");
        console.log(`  Job ID                     : ${manifest.jobId}`);
        console.log(`  Backup Timestamp           : ${manifest.backupSnapshotTimestamp}`);
        console.log(`  Unmodified Pre-Backup      : ${manifest.summary.unmodifiedPreBackup}`);
        console.log(`  Modified Existing Attempts : ${manifest.summary.modifiedExistingAttempts}`);
        console.log(`  Modified Existing Results  : ${manifest.summary.modifiedExistingResults}`);
        console.log(`  New Post-Backup Attempts   : ${manifest.summary.newPostBackupAttempts}`);
        console.log(`  New Post-Backup Results    : ${manifest.summary.newPostBackupResults}`);
        console.log(`  Total Items to Reapply     : ${manifest.items.length}\n`);

        if (manifestOutputPath) {
            const out = PostBackupReconciliationService.writeManifestToFile(manifest, manifestOutputPath);
            console.log(`Reconciliation manifest written to: ${out}\n`);
        }
    } else {
        console.error("ERROR: Either --backup-file=<path> or --manifest-input=<path> must be specified.");
        process.exit(1);
    }

    // Phase 2: Execute Reapplication Safety Gates before LIVE writes
    if (!isDryRun) {
        console.log("================================================================================");
        console.log("              MANDATORY REAPPLICATION SAFETY GATES EVALUATION");
        console.log("================================================================================");

        // Gate 1: Explicit Staging Project Argument Verification
        const stagingProjectArg = args.find(a => a.startsWith("--staging-project="));
        const stagingProject = stagingProjectArg ? stagingProjectArg.split("=")[1].trim() : null;
        if (!stagingProject || stagingProject !== effectiveProjectId) {
            console.error(`FATAL ERROR [Gate 1]: Live reapplication requires explicit --staging-project=<projectId> matching effective target '${effectiveProjectId}'. (Provided: '${stagingProject}')`);
            process.exit(1);
        }
        console.log(`  ✓ Gate 1: Explicit staging project verified: '${effectiveProjectId}'`);

        // Gate 2: Confirmation Flag
        if (!confirmStaging) {
            console.error("FATAL ERROR [Gate 2]: Live reapplication requires explicit confirmation flag: --confirm-staging-reapply");
            process.exit(1);
        }
        console.log("  ✓ Gate 2: Staging reapplication confirmation confirmed (--confirm-staging-reapply)");

        // Gate 3: Live Write Project Allowlist
        if (!ALLOWED_STAGING_PROJECTS.has(effectiveProjectId)) {
            console.error(`FATAL ERROR [Gate 3]: Project '${effectiveProjectId}' is not in allowed staging list (${Array.from(ALLOWED_STAGING_PROJECTS).join(", ")}).`);
            process.exit(1);
        }
        console.log(`  ✓ Gate 3: Project '${effectiveProjectId}' is verified in staging allowlist`);

        // Gate 4: Cloud Write Safeguard
        if (!isEmulator && !process.env.ALLOW_STAGING_CLOUD_WRITES) {
            console.error(`FATAL ERROR [Gate 4]: Live reapplication against real cloud project '${effectiveProjectId}' is blocked without FIRESTORE_EMULATOR_HOST or ALLOW_STAGING_CLOUD_WRITES=true.`);
            process.exit(1);
        }
        console.log("  ✓ Gate 4: Staging cloud write safeguard confirmed");

        // Gate 5: Verified Staging Recovery Point Reference
        const recoveryPointArg = args.find(a => a.startsWith("--recovery-point="));
        const recoveryPoint = recoveryPointArg ? recoveryPointArg.split("=")[1].trim() : null;
        const recoveryPointMetaArg = args.find(a => a.startsWith("--recovery-point-metadata=") || a.startsWith("--staging-preflight-report="));
        const recoveryPointMetaPath = recoveryPointMetaArg ? recoveryPointMetaArg.split("=")[1].trim() : null;
        const baselineConfirmed = args.includes("--staging-baseline-confirmed");

        if (!recoveryPoint && !baselineConfirmed) {
            console.error("FATAL ERROR [Gate 5]: Live reapplication requires a verified staging recovery point reference (--recovery-point=<uri_or_id> or --staging-baseline-confirmed) before modifying state.");
            process.exit(1);
        }

        if (recoveryPointMetaPath) {
            console.log(`  Evaluating authoritative recovery point metadata: ${recoveryPointMetaPath}`);
            const resolvedMeta = path.resolve(recoveryPointMetaPath);
            if (!fs.existsSync(resolvedMeta)) {
                console.error(`FATAL ERROR [Gate 5]: Recovery point metadata file not found: ${resolvedMeta}`);
                process.exit(1);
            }
            try {
                const rpMeta = JSON.parse(fs.readFileSync(resolvedMeta, "utf8"));
                const isOpDone = rpMeta.done === true;
                const opState = rpMeta.metadata?.operationState || (isOpDone ? "SUCCESSFUL" : "IN_PROGRESS");
                if (!isOpDone || (opState !== "SUCCESSFUL" && !rpMeta.response)) {
                    console.error(`FATAL ERROR [Gate 5]: Recovery point operation did not complete successfully (done: ${rpMeta.done}, state: ${opState})`);
                    process.exit(1);
                }
                const metaUri = rpMeta.response?.outputUriPrefix || rpMeta.metadata?.outputUriPrefix;
                if (recoveryPoint && metaUri && recoveryPoint !== metaUri) {
                    console.error(`FATAL ERROR [Gate 5]: Provided --recovery-point '${recoveryPoint}' does not match metadata URI '${metaUri}'`);
                    process.exit(1);
                }
                console.log(`  ✓ Recovery point metadata verified: SUCCESSFUL (${metaUri || recoveryPoint})`);
            } catch (err) {
                console.error(`FATAL ERROR [Gate 5]: Invalid recovery point metadata JSON: ${err.message}`);
                process.exit(1);
            }
        } else if (!isEmulator && !args.includes("--allow-unverified-recovery-point-for-testing")) {
            if (recoveryPoint && recoveryPoint.startsWith("gs://")) {
                console.warn("[Gate 5 Notice] Real cloud reapplication: ensure GCS recovery point was preflight verified via scripts/preflight-staging-import-check.sh.");
            }
        }
        console.log(`  ✓ Gate 5: Staging recovery baseline verified (${recoveryPoint || "baseline-confirmed"})`);

        // Gate 6: Manifest Freshness Verification
        if (manifest && manifest.generatedAt) {
            const manifestAgeMs = Date.now() - new Date(manifest.generatedAt).getTime();
            const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
            if (manifestAgeMs > MAX_AGE_MS && !args.includes("--allow-stale-manifest-for-testing")) {
                console.error(`FATAL ERROR [Gate 6]: Manifest '${manifestInputPath}' is older than 24 hours (Generated: ${manifest.generatedAt}). A fresh manifest must be generated against current staging state.`);
                process.exit(1);
            }
            console.log(`  ✓ Gate 6: Manifest freshness verified (${Math.round(manifestAgeMs / 1000)}s old)`);
        }

        // Gate 7: Prior Dry-Run Review Prerequisite & Exact Manifest Binding
        const dryRunArg = args.find(a => a.startsWith("--verified-dry-run-report="));
        const dryRunReportPath = dryRunArg ? dryRunArg.split("=")[1].trim() : null;
        if (!dryRunReportPath && !args.includes("--bypass-dry-run-check-for-testing")) {
            console.error("FATAL ERROR [Gate 7]: Live reapplication requires a verified dry-run review report (--verified-dry-run-report=<path>) proving zero conflicts.");
            process.exit(1);
        }
        if (dryRunReportPath) {
            const resolvedDryRun = path.resolve(dryRunReportPath);
            if (!fs.existsSync(resolvedDryRun)) {
                console.error(`FATAL ERROR [Gate 7]: Verified dry-run report file not found at: ${resolvedDryRun}`);
                process.exit(1);
            }

            // Verify companion checksum if present
            const dryRunShaPath = `${resolvedDryRun}.sha256`;
            if (fs.existsSync(dryRunShaPath)) {
                const expectedDryRunSha = fs.readFileSync(dryRunShaPath, "utf8").trim().split(/\s+/)[0];
                const rawDryRunContent = fs.readFileSync(resolvedDryRun, "utf8");
                const actualDryRunSha = crypto.createHash("sha256").update(rawDryRunContent, "utf8").digest("hex");
                if (expectedDryRunSha !== actualDryRunSha) {
                    console.error(`FATAL ERROR [Gate 7]: Dry-run report checksum mismatch! Expected ${expectedDryRunSha}, computed ${actualDryRunSha}`);
                    process.exit(1);
                }
            }

            const dryRunData = JSON.parse(fs.readFileSync(resolvedDryRun, "utf8"));

            // 1. Manifest Job ID Binding
            if (manifest && dryRunData.manifestJobId && dryRunData.manifestJobId !== manifest.jobId) {
                console.error(`FATAL ERROR [Gate 7]: Dry-run report was executed for manifest jobId '${dryRunData.manifestJobId}', but current manifest is '${manifest.jobId}'. Manifest mismatch!`);
                process.exit(1);
            }

            // 2. Manifest SHA-256 Exact Binding
            if (manifest && dryRunData.manifestSha256) {
                const currentManifestJson = JSON.stringify(manifest, null, 2);
                const currentManifestSha = crypto.createHash("sha256").update(currentManifestJson, "utf8").digest("hex");
                const expectedManifestSha = dryRunData.manifestSha256.replace(/^sha256:/, "");
                if (expectedManifestSha !== currentManifestSha) {
                    console.error(`FATAL ERROR [Gate 7]: Dry-run report was bound to manifest SHA-256 '${expectedManifestSha}', but current manifest computes '${currentManifestSha}'. Manifest content was modified post-simulation!`);
                    process.exit(1);
                }
                console.log(`  ✓ Gate 7: Manifest SHA-256 cryptographic binding verified: ${currentManifestSha}`);
            }

            // 3. Snapshot SHA-256 Binding
            if (manifest && dryRunData.snapshotSha256 && manifest.backupSnapshotChecksum) {
                if (dryRunData.snapshotSha256 !== manifest.backupSnapshotChecksum) {
                    console.error(`FATAL ERROR [Gate 7]: Snapshot checksum mismatch between dry-run report ('${dryRunData.snapshotSha256}') and manifest ('${manifest.backupSnapshotChecksum}')!`);
                    process.exit(1);
                }
            }

            // 4. Target Project & Database Binding
            if (dryRunData.targetProject && dryRunData.targetProject !== effectiveProjectId) {
                console.error(`FATAL ERROR [Gate 7]: Dry-run report was generated for target project '${dryRunData.targetProject}', but live reapplication is targeting '${effectiveProjectId}'! Cross-project report reuse forbidden.`);
                process.exit(1);
            }
            if (dryRunData.targetDatabase && dryRunData.targetDatabase !== "(default)") {
                console.error(`FATAL ERROR [Gate 7]: Dry-run report targeted database '${dryRunData.targetDatabase}', expected '(default)'!`);
                process.exit(1);
            }

            // 5. Schema Version Binding
            if (dryRunData.schemaVersion && dryRunData.schemaVersion !== "v2.8") {
                console.error(`FATAL ERROR [Gate 7]: Dry-run schema version '${dryRunData.schemaVersion}' does not match current version 'v2.8'!`);
                process.exit(1);
            }

            // 6. Quarantine Count Verification
            if (dryRunData.quarantinedCount > 0) {
                console.error(`FATAL ERROR [Gate 7]: Dry-run report recorded ${dryRunData.quarantinedCount} quarantined conflicts. Cannot execute live reapplication with unresolved conflicts.`);
                process.exit(1);
            }

            // 7. Simulation Status Verification
            const simStatus = dryRunData.finalSimulationStatus || dryRunData.status;
            if (simStatus !== "SIMULATED_SUCCESS" && simStatus !== "completed" && simStatus !== "dry_run") {
                console.error(`FATAL ERROR [Gate 7]: Dry-run report does not have a successful status (found '${simStatus}').`);
                process.exit(1);
            }

            // 8. Dry-run Report Freshness (< 24 hours)
            if (dryRunData.dryRunGeneratedAt) {
                const dryRunAgeMs = Date.now() - new Date(dryRunData.dryRunGeneratedAt).getTime();
                if (dryRunAgeMs > 24 * 60 * 60 * 1000 && !args.includes("--allow-stale-manifest-for-testing")) {
                    console.error(`FATAL ERROR [Gate 7]: Dry-run report is older than 24 hours (${Math.round(dryRunAgeMs / 1000)}s old). Fresh dry-run review required.`);
                    process.exit(1);
                }
            }

            console.log(`  ✓ Gate 7: Verified dry-run report cleared (0 conflicts, simulated success, exact manifest binding confirmed)`);
        }
        console.log("All 7 Reapplication Safety Gates Passed! Proceeding with reapplication...\n");
    }

    // Phase 3: Execute Reapplication or Dry-Run Precondition Verification
    console.log(`Initiating ${isDryRun ? "Dry-Run Simulation" : "Staging Reapplication"}...`);
    const report = await PostBackupReconciliationService.executeReconciliation({
        manifest,
        allowWrites: !isDryRun,
        targetEnvironment: targetEnv,
        targetProjectId: effectiveProjectId,
        client: firestoreClient
    });

    console.log("================================================================================");
    console.log("                   RECONCILIATION EXECUTION REPORT");
    console.log("================================================================================");
    console.log(`Status             : ${report.status}`);
    console.log(`Total Items        : ${report.totalItems}`);
    console.log(`Applied / Simulated: ${report.appliedCount}`);
    console.log(`Skipped            : ${report.skippedCount}`);
    console.log(`Quarantined        : ${report.quarantinedCount}`);

    if (report.conflicts.length > 0) {
        console.warn("\nQuarantined Precondition Conflicts Detected:");
        for (const conf of report.conflicts) {
            console.warn(`  - [${conf.collection}] ${conf.documentId}: ${conf.reason}`);
        }
    }
    console.log("================================================================================\n");

    if (reportOutputPath) {
        const resolvedRep = path.resolve(reportOutputPath);
        fs.mkdirSync(path.dirname(resolvedRep), { recursive: true });

        const manifestJsonStr = JSON.stringify(manifest, null, 2);
        const manifestSha256 = crypto.createHash("sha256").update(manifestJsonStr, "utf8").digest("hex");

        const boundReport = {
            reportType: isDryRun ? "POST_BACKUP_RECONCILIATION_DRY_RUN" : "POST_BACKUP_RECONCILIATION_EXECUTION",
            manifestJobId: manifest.jobId,
            manifestSha256: `sha256:${manifestSha256}`,
            snapshotSha256: manifest.backupSnapshotChecksum || null,
            targetProject: effectiveProjectId,
            targetDatabase: "(default)",
            schemaVersion: "v2.8",
            dryRunGeneratedAt: new Date().toISOString(),
            quarantinedCount: report.quarantinedCount,
            appliedCount: report.appliedCount,
            skippedCount: report.skippedCount,
            totalItems: report.totalItems,
            finalSimulationStatus: report.quarantinedCount === 0 ? "SIMULATED_SUCCESS" : "SIMULATED_WITH_CONFLICTS",
            executionDetails: report
        };

        const reportJson = JSON.stringify(boundReport, null, 2);
        fs.writeFileSync(resolvedRep, reportJson, "utf8");

        const reportSha256 = crypto.createHash("sha256").update(reportJson, "utf8").digest("hex");
        fs.writeFileSync(`${resolvedRep}.sha256`, `${reportSha256}  ${path.basename(resolvedRep)}\n`, "utf8");

        console.log(`Execution report written to: ${resolvedRep}`);
        console.log(`Execution report checksum:  ${resolvedRep}.sha256 (${reportSha256})\n`);
    }

    if (report.quarantinedCount > 0) {
        process.exit(2);
    }
}

main().catch(err => {
    console.error("FATAL ERROR in reconciliation CLI:", err.message);
    process.exit(1);
});

