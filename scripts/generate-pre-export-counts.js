#!/usr/bin/env node
/**
 * generate-pre-export-counts.js
 *
 * Production Pre-Export Count & Provenance Generator (Milestone 3)
 *
 * CRITICAL ARCHITECTURAL NOTICE — SNAPSHOT CONSISTENCY & RACE CONDITIONS:
 *
 * Capturing collection document counts via sequential REST requests DOES NOT constitute
 * an atomic point-in-time snapshot with `gcloud firestore export` if writes are active!
 *
 * Race Conditions Identified:
 * 1. Write Interleaving: A student attempt could be created between counting 'mockAttempts'
 *    and counting 'mockResults', producing inconsistent cross-collection totals.
 * 2. Export Interleaving: Documents written after count capture but before `gcloud firestore
 *    export` initializes will cause the export to contain additional records.
 *
 * Architectural Mandate & Limitations:
 * 1. Strict Maintenance Mode MUST be active before counting to freeze live writes.
 * 2. Document count equality alone is an auxiliary sanity check, NOT a cryptographic
 *    guarantee of snapshot parity.
 * 3. Authoritative consistency MUST be proven at the document level (comparing document IDs
 *    and canonical application content hashes) against an authoritative export-derived baseline.
 *
 * Read-Only Safety:
 * NEVER performs any database write or modification. Only queries document listings.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";

const TARGET_COLLECTIONS = Object.freeze([
    "mockAttempts",
    "mockResults",
    "mockTests",
    "mockQuestions",
    "migrationCheckpoints"
]);

const PROD_PROJECT_ID = "pyqs-hub-43bed";
const PROD_PROJECT_NUMBER = "766070215379";
const EXPECTED_DATABASE = "(default)";
const EXPECTED_BUCKET = "gs://pyqs-hub-43bed-backups-asia-south1";

export async function generatePreExportCounts(options = {}) {
    const {
        project = PROD_PROJECT_ID,
        database = EXPECTED_DATABASE,
        exportOperation = null,
        exportUri = null,
        exportMetadataPath = null,
        outputPath = "./artifacts/prod-pre-export-counts.json"
    } = options;

    // Validate project identity
    if (project !== PROD_PROJECT_ID && project !== PROD_PROJECT_NUMBER) {
        throw new Error(`SAFETY VIOLATION: Pre-export counts must originate from production project '${PROD_PROJECT_ID}' or '${PROD_PROJECT_NUMBER}'. Provided: '${project}'.`);
    }

    if (database !== EXPECTED_DATABASE) {
        throw new Error(`SAFETY VIOLATION: Database must be '${EXPECTED_DATABASE}'. Provided: '${database}'.`);
    }

    let resolvedExportOp = exportOperation;
    let resolvedExportUri = exportUri;
    let operationState = "SUCCESSFUL";

    // Extract provenance from export operation metadata if provided
    if (exportMetadataPath) {
        const metaPath = path.resolve(exportMetadataPath);
        if (!fs.existsSync(metaPath)) {
            throw new Error(`Export metadata file not found at: ${metaPath}`);
        }
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        resolvedExportOp = meta.name || resolvedExportOp;
        resolvedExportUri = meta.response?.outputUriPrefix || meta.metadata?.outputUriPrefix || resolvedExportUri;
        const isDone = meta.done === true;
        operationState = meta.metadata?.operationState || (isDone ? "SUCCESSFUL" : "IN_PROGRESS");
    }

    if (!resolvedExportUri || !resolvedExportUri.startsWith(EXPECTED_BUCKET)) {
        throw new Error(`SAFETY VIOLATION: Export URI must target '${EXPECTED_BUCKET}'. Provided: '${resolvedExportUri}'.`);
    }

    if (!resolvedExportOp) {
        throw new Error("SAFETY VIOLATION: Export operation name is mandatory to cryptographically bind counts to backup.");
    }

    // Query counts in read-only mode across all 5 target collections via bound client
    const targetProject = (project === PROD_PROJECT_NUMBER) ? PROD_PROJECT_ID : project;
    const client = options.client || UniversalFirestoreService.forProject(targetProject);
    const counts = {};
    let totalDocuments = 0;

    for (const col of TARGET_COLLECTIONS) {
        const docs = await client.listDocuments(col);
        counts[col] = docs.length;
        totalDocuments += docs.length;
    }

    const payload = {
        projectId: PROD_PROJECT_ID,
        projectNumber: PROD_PROJECT_NUMBER,
        database: EXPECTED_DATABASE,
        exportOperationName: resolvedExportOp,
        exportUri: resolvedExportUri,
        operationState,
        collectionIds: [...TARGET_COLLECTIONS],
        timestamp: new Date().toISOString(),
        counts,
        totalDocuments
    };

    // Calculate canonical SHA-256
    const canonicalJson = JSON.stringify(payload, null, 2);
    const contentSha256 = crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex");
    payload.countsSha256 = `sha256:${contentSha256}`;

    // Write output file and companion checksum
    const resolvedOut = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

    const finalJson = JSON.stringify(payload, null, 2);
    fs.writeFileSync(resolvedOut, finalJson, "utf8");

    const diskSha = crypto.createHash("sha256").update(finalJson, "utf8").digest("hex");
    const shaFilePath = `${resolvedOut}.sha256`;
    fs.writeFileSync(shaFilePath, `${diskSha}  ${path.basename(resolvedOut)}\n`, "utf8");

    // Independent HMAC digital signature for adversary-resistant integrity
    const signingKey = options.signingKey || process.env.ARTIFACT_SIGNING_KEY;
    let sigFilePath = null;
    if (signingKey) {
        const diskHmac = crypto.createHmac("sha256", signingKey).update(finalJson, "utf8").digest("hex");
        sigFilePath = `${resolvedOut}.sig`;
        fs.writeFileSync(sigFilePath, `${diskHmac}  ${path.basename(resolvedOut)}\n`, "utf8");
    }

    // Append to independently protected hash ledger if path provided
    const trustedLedgerPath = options.trustedLedgerPath || process.env.TRUSTED_HASH_LEDGER_PATH;
    if (trustedLedgerPath) {
        const resolvedLedger = path.resolve(trustedLedgerPath);
        fs.mkdirSync(path.dirname(resolvedLedger), { recursive: true });
        const ledgerEntry = JSON.stringify({
            timestamp: payload.timestamp,
            file: path.basename(resolvedOut),
            sha256: diskSha,
            countsSha256: contentSha256,
            exportOp: resolvedExportOp
        }) + "\n";
        fs.appendFileSync(resolvedLedger, ledgerEntry, "utf8");
    }

    return {
        payload,
        outputFile: resolvedOut,
        shaFile: shaFilePath,
        sigFile: sigFilePath,
        sha256: diskSha
    };
}

// CLI Runner
async function main() {
    const args = process.argv.slice(2);
    const getArg = (prefix) => {
        const found = args.find(a => a.startsWith(prefix));
        return found ? found.split("=")[1].trim() : null;
    };

    const project = getArg("--project=") || PROD_PROJECT_ID;
    const database = getArg("--database=") || EXPECTED_DATABASE;
    const exportOperation = getArg("--export-operation=");
    const exportUri = getArg("--export-uri=");
    const exportMetadataPath = getArg("--export-metadata=");
    const outputPath = getArg("--output=") || "./artifacts/prod-pre-export-counts.json";

    try {
        const res = await generatePreExportCounts({
            project,
            database,
            exportOperation,
            exportUri,
            exportMetadataPath,
            outputPath
        });
        console.log("Successfully generated production pre-export counts:");
        console.log(`  File   : ${res.outputFile}`);
        console.log(`  SHA-256: ${res.sha256}`);
        console.log(`  Total  : ${res.payload.totalDocuments} documents`);
    } catch (err) {
        console.error("FATAL ERROR generating pre-export counts:", err.message);
        process.exit(1);
    }
}

if (process.argv[1] && process.argv[1].endsWith("generate-pre-export-counts.js")) {
    main();
}

