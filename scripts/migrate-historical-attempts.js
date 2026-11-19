#!/usr/bin/env node
/**
 * migrate-historical-attempts.js
 *
 * Operational CLI script for Historical Student Attempt Migration into Universal Examination Architecture (Schema v2).
 *
 * Default mode is STRICT DRY-RUN (read-only, 0 writes).
 * To run in execution mode requires explicit flags: --execute --confirm-production-writes
 *
 * Usage:
 *   node scripts/migrate-historical-attempts.js --dry-run
 *   node scripts/migrate-historical-attempts.js --dry-run --limit=50
 *   node scripts/migrate-historical-attempts.js --execute --confirm-production-writes --batch-size=50
 */

import { HistoricalAttemptMigrationService } from "../server/services/admin/historicalAttemptMigrationService.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { validateProjectIdFormat } from "../server/services/firebaseTokenService.js";
import fs from "fs";
import path from "path";

async function main() {
    const args = process.argv.slice(2);
    const isDryRun = !args.includes("--execute");
    const confirmWrites = args.includes("--confirm-production-writes");
    const limitArg = args.find(a => a.startsWith("--limit="));
    const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
    const batchArg = args.find(a => a.startsWith("--batch-size="));
    const batchSize = batchArg ? parseInt(batchArg.split("=")[1], 10) : 50;
    const resumeArg = args.find(a => a.startsWith("--resume-after="));
    const resumeAfterAttemptId = resumeArg ? resumeArg.split("=")[1] : null;
    const reportArg = args.find(a => a.startsWith("--report="));
    const reportPath = reportArg ? reportArg.split("=")[1] : null;
    const datasetArg = args.find(a => a.startsWith("--dataset="));
    const datasetPath = datasetArg ? datasetArg.split("=")[1] : null;

    const projectArg = args.find(a => a.startsWith("--project="));
    if (!projectArg && !datasetPath) {
        console.error("FATAL ERROR: Mandatory argument --project=<targetProjectId> is missing when executing against live Firestore. Ambient project execution is strictly forbidden.");
        process.exit(1);
    }
    const rawTargetProject = projectArg ? projectArg.split("=")[1].trim() : null;
    const targetProject = rawTargetProject ? validateProjectIdFormat(rawTargetProject, "targetProject") : null;
    const firestoreClient = targetProject ? UniversalFirestoreService.forProject(targetProject) : null;

    console.log("================================================================================");
    console.log("       VIDYARTHIASTRA UNIVERSAL EXAMINATION ARCHITECTURE (SCHEMA V2)");
    console.log("              HISTORICAL ATTEMPT MIGRATION PIPELINE");
    console.log("================================================================================");
    console.log(`Execution Mode       : ${isDryRun ? "STRICT DRY-RUN (Read-Only, 0 Writes)" : "LIVE WRITE MIGRATION"}`);
    console.log(`Batch Size           : ${batchSize}`);
    console.log(`Record Limit         : ${limit || "Unlimited"}`);
    console.log(`Resume After Attempt : ${resumeAfterAttemptId || "None (from beginning)"}`);
    console.log(`Dataset Source       : ${datasetPath ? datasetPath : "Live Firestore Collections"}`);
    console.log("--------------------------------------------------------------------------------\n");

    let datasetRecords = null;
    if (datasetPath) {
        const fullDatasetPath = path.resolve(datasetPath);
        if (!fs.existsSync(fullDatasetPath)) {
            console.error(`ERROR: Dataset file not found at: ${fullDatasetPath}`);
            process.exit(1);
        }
        datasetRecords = JSON.parse(fs.readFileSync(fullDatasetPath, "utf8"));
        console.log(`Loaded dataset from ${fullDatasetPath}:`);
        console.log(`  Tests    : ${datasetRecords.tests?.length || 0}`);
        console.log(`  Attempts : ${datasetRecords.attempts?.length || 0}`);
        console.log(`  Results  : ${datasetRecords.results?.length || 0}\n`);
    }

    if (!isDryRun && !confirmWrites) {
        console.error("ERROR: Live execution requires explicit confirmation flag: --confirm-production-writes");
        console.error("Aborting without modifying database.");
        process.exit(1);
    }

    if (isDryRun) {
        console.log("Initiating Read-Only Discovery and Dry-Run Verification...\n");
        const dryRunResult = await HistoricalAttemptMigrationService.executeDryRun({
            attempts: datasetRecords?.attempts || null,
            results: datasetRecords?.results || null,
            tests: datasetRecords?.tests || null,
            limit,
            targetProjectId: targetProject,
            client: firestoreClient
        });

        console.log("DRY-RUN EXECUTION SUMMARY:");
        console.log(`  Total Attempts Scanned      : ${dryRunResult.summary.totalScanned}`);
        console.log(`  Eligible for v2 Migration   : ${dryRunResult.summary.eligible}`);
        console.log(`  Already Upgraded (v2)       : ${dryRunResult.summary.alreadyMigrated}`);
        console.log(`  Active in Progress (Skipped): ${dryRunResult.summary.skippedActive}`);
        console.log(`  Quarantined (Non-migrated)  : ${dryRunResult.summary.quarantined}`);
        console.log(`  Score Discrepancies Detected: ${dryRunResult.summary.scoreDiscrepanciesDetected}`);
        console.log(`  Total Writes Committed      : ${dryRunResult.totalWritesPerformed} (Pure Read-Only)\n`);

        console.log("QUARANTINE CLASSIFICATION BREAKDOWN:");
        for (const [reason, count] of Object.entries(dryRunResult.quarantineBreakdown)) {
            console.log(`  - ${reason.padEnd(26)}: ${count}`);
        }
        console.log("");

        console.log("RESOLVED EXAM PROFILE DISTRIBUTION:");
        for (const [profileId, count] of Object.entries(dryRunResult.profileDistribution)) {
            console.log(`  - ${profileId.padEnd(28)}: ${count}`);
        }
        console.log("");

        if (dryRunResult.samples.length > 0) {
            console.log("REPRESENTATIVE BEFORE / AFTER SAMPLES (VERIFIED 100% SCORE IDENTICAL):");
            console.log(JSON.stringify(dryRunResult.samples, null, 2));
            console.log("");
        }

        if (dryRunResult.quarantinedItems.length > 0) {
            console.log("SAMPLE QUARANTINED RECORDS (ISOLATED WITH FORENSIC REASONS):");
            console.log(JSON.stringify(dryRunResult.quarantinedItems, null, 2));
            console.log("");
        }

        if (reportPath) {
            const outPath = path.resolve(reportPath);
            fs.writeFileSync(outPath, JSON.stringify(dryRunResult, null, 2), "utf8");
            console.log(`Migration manifest saved to: ${outPath}`);
        }

        console.log("Dry-run completed successfully. Database unchanged.");
        return;
    }

    // Live Write Migration
    console.log("Initiating LIVE MIGRATION with updateTime preconditions and bounded chunks...\n");
    const migrationResult = await HistoricalAttemptMigrationService.executeBatchMigration({
        batchSize,
        resumeAfterAttemptId,
        allowWrites: true,
        targetProjectId: targetProject,
        client: firestoreClient
    });

    console.log("MIGRATION COMPLETED SUCCESSFULLY:");
    console.log(`  Job ID                     : ${migrationResult.jobId}`);
    console.log(`  Status                     : ${migrationResult.status}`);
    console.log(`  Attempts Migrated          : ${migrationResult.migratedAttempts}`);
    console.log(`  Results Migrated           : ${migrationResult.migratedResults}`);
    console.log(`  Already Migrated (Skipped) : ${migrationResult.skippedAlreadyMigrated}`);
    console.log(`  Quarantined Records        : ${migrationResult.quarantined}`);
    console.log(`  Batches Committed          : ${migrationResult.batchesExecuted}`);
    console.log(`  Last Processed Attempt ID  : ${migrationResult.lastProcessedAttemptId}`);
}

main().catch(err => {
    console.error("FATAL: Migration pipeline encountered an unhandled error:", err);
    process.exit(1);
});
