#!/usr/bin/env node
/**
 * VidyarthiAstra — Dry-Run Test Cleanup Manifest Generator
 * 
 * Generates an auditable, deterministic dry-run manifest of test documents
 * associated with a specific testRunId.
 * 
 * MANDATORY SAFETY CONSTRAINTS:
 * 1. This script performs READ-ONLY planning and dry-run inventory generation.
 * 2. It DOES NOT execute any Firestore delete, update, or write operations.
 * 3. Human administrative review is MANDATORY before any cleanup action.
 * 4. Wildcard or broad collection deletions are strictly forbidden.
 */

function parseArgs() {
    const args = process.argv.slice(2);
    let testRunId = null;
    let format = "json"; // json | text

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--testRunId" || args[i] === "-t") {
            testRunId = args[++i];
        } else if (args[i] === "--format" || args[i] === "-f") {
            format = args[++i];
        } else if (!args[i].startsWith("--") && !testRunId) {
            testRunId = args[i];
        }
    }

    return { testRunId, format };
}

export function generateTestManifest(testRunId, options = {}) {
    if (!testRunId || typeof testRunId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(testRunId.trim())) {
        throw new Error("Invalid or missing testRunId. Must be 8-64 alphanumeric characters, underscores, or hyphens.");
    }

    const cleanRunId = testRunId.trim();
    const generatedAt = new Date().toISOString();
    const questionCount = Number(options.questionCount) || 4;

    const manifest = {
        manifestVersion: 1,
        testRunId: cleanRunId,
        generatedAt,
        policy: "MANUAL_HUMAN_REVIEW_REQUIRED",
        safetyNotice: "DRY-RUN ONLY: No documents were modified or deleted. Deletion requires explicit manual human verification.",
        summary: {
            totalIdentifiedPaths: 0,
            verifiedPathsCount: 0,
            inferredPathsCount: 0,
            collectionsCovered: [
                "paperImportJobs",
                "mockTests",
                "mockQuestions",
                "mockAnswerKeys",
                "mockAttempts",
                "mockResults"
            ]
        },
        documents: []
    };

    // 1. Import Job record (Verified pattern)
    manifest.documents.push({
        collection: "paperImportJobs",
        pattern: `job_test_${cleanRunId}_*`,
        detection: "verified_prefix",
        pathExample: `paperImportJobs/job_test_${cleanRunId}_synthetic-qa-exam_9999_SYNTH01`,
        description: "Audit record of the synthetic paper import pipeline job"
    });

    // 2. Mock Test document
    const expectedTestId = `mock-${cleanRunId}-synthetic-qa-exam-9999-synth01`;
    manifest.documents.push({
        collection: "mockTests",
        documentId: expectedTestId,
        path: `mockTests/${expectedTestId}`,
        detection: "deterministic_id",
        status: "draft",
        description: "Root synthetic mock test metadata document"
    });

    // 3. Questions and Answer Keys
    for (let i = 1; i <= questionCount; i++) {
        manifest.documents.push({
            collection: "mockQuestions",
            documentId: `${expectedTestId}-q${i}`,
            path: `mockQuestions/${expectedTestId}-q${i}`,
            detection: "deterministic_id",
            description: `Synthetic question #${i}`
        });

        manifest.documents.push({
            collection: "mockAnswerKeys",
            documentId: `${expectedTestId}-key-q${i}`,
            path: `mockAnswerKeys/${expectedTestId}-key-q${i}`,
            detection: "deterministic_id",
            description: `Protected answer key #${i}`
        });
    }

    // 4. Student Attempt and Result Records (Inferred by testRunId / testId pattern)
    manifest.documents.push({
        collection: "mockAttempts",
        pathPattern: `mockAttempts/attempt_${expectedTestId}_*`,
        detection: "inferred_test_reference",
        description: "Student attempt records linked to this synthetic test"
    });

    manifest.documents.push({
        collection: "mockResults",
        pathPattern: `mockResults/result_attempt_${expectedTestId}_*`,
        detection: "inferred_test_reference",
        description: "Evaluated student result documents linked to this synthetic test"
    });

    manifest.summary.totalIdentifiedPaths = manifest.documents.length;
    manifest.summary.verifiedPathsCount = manifest.documents.filter(d => d.detection === "deterministic_id" || d.detection === "verified_prefix").length;
    manifest.summary.inferredPathsCount = manifest.documents.filter(d => d.detection === "inferred_test_reference").length;

    return manifest;
}

function main() {
    const { testRunId, format } = parseArgs();

    if (!testRunId) {
        console.error(`
Usage:
  node scripts/generate-test-manifest.js --testRunId <testRunId> [--format json|text]

Example:
  node scripts/generate-test-manifest.js --testRunId testrun_1729634820_safe
`);
        process.exit(1);
    }

    try {
        const manifest = generateTestManifest(testRunId);

        if (format === "json") {
            console.log(JSON.stringify(manifest, null, 2));
        } else {
            console.log("========================================================================");
            console.log(`VIDYARTHIASTRA — TEST CLEANUP MANIFEST (${manifest.testRunId})`);
            console.log("========================================================================");
            console.log(`Generated At: ${manifest.generatedAt}`);
            console.log(`Policy:       ${manifest.policy}`);
            console.log(`Notice:       ${manifest.safetyNotice}\n`);
            console.log("Identified Documents for Administrative Review:");
            for (const doc of manifest.documents) {
                console.log(`  - [${doc.collection}] ${doc.path || doc.pathPattern || doc.pathExample} (${doc.description})`);
            }
            console.log("========================================================================");
        }
    } catch (err) {
        console.error(`Error generating manifest: ${err.message}`);
        process.exit(1);
    }
}

// Execute when invoked directly
if (process.argv[1] && process.argv[1].endsWith("generate-test-manifest.js")) {
    main();
}
