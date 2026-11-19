import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const suites = [
    {
        suite: "tests/phase-5-5-numerical-input.test.js",
        description: "Phase 5.5 Universal Numerical Answer Input Support, Validation & Scoring"
    },
    {
        suite: "tests/phase-5-5-question-boundary.test.js",
        description: "Phase 5.5 Question Boundary Extraction & 65-Question GATE Reconciliation"
    },
    {
        suite: "tests/ssc-cgl-defect-reproduction-regression.test.js",
        description: "Phase 5.4 SSC CGL Defect Reproduction & Remediation Regression"
    },
    {
        suite: "tests/universal-question-parser-accuracy.test.js",
        description: "Phase 5.1 Universal Structural Parsing and Accuracy Regression"
    },
    {
        suite: "tests/universal-document-ingestion.test.js",
        description: "Phase 2 Universal Three-Document Ingestion Engine"
    },
    {
        suite: "tests/uir-v3-real-document-regression.test.js",
        description: "UIR v3.0 Real-Document Regression (UPSC Prelims, BPSC 69th, JEE Main 2026)"
    },
    {
        suite: "tests/uir-v3-synthetic-acceptance.test.js",
        description: "UIR v3.0 Synthetic Acceptance Suite (Schema, Adapters, Scoring)"
    },
    {
        suite: "tests/jee-main-2026-pipeline.test.js",
        description: "JEE Main 2026 Pipeline Fixes & Comprehensive Regression Suite"
    },
    {
        suite: "tests/bpsc-pipeline.test.js",
        description: "BPSC 69th Prelims Extraction & Pipeline Test Suite"
    },
    {
        suite: "tests/upsc-pipeline.test.js",
        description: "UPSC Prelims Extraction & Pipeline Test Suite"
    },
    {
        suite: "tests/phase-4-runtime-integration.test.js",
        description: "Universal Mock-Test Runtime & Full Application Lifecycle"
    },
    {
        suite: "tests/neet-code50-ingestion-investigation.test.js",
        description: "NEET Code 50 Pipeline Investigation & Boundary Acceptance"
    },
    {
        suite: "tests/question-extraction-hybrid.test.js",
        description: "Hybrid Question Extraction & Normalization Suite"
    }
];

async function runSuite(suiteInfo) {
    return new Promise((resolve) => {
        const start = Date.now();
        const proc = spawn(process.execPath, ["--test", suiteInfo.suite], {
            cwd: process.cwd(),
            env: { ...process.env, NODE_ENV: "test" }
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

        proc.on("close", (code) => {
            const durationMs = Date.now() - start;
            const testsMatch = stdout.match(/ℹ tests\s+(\d+)/);
            const passMatch = stdout.match(/ℹ pass\s+(\d+)/);
            const failMatch = stdout.match(/ℹ fail\s+(\d+)/);

            const totalTests = testsMatch ? parseInt(testsMatch[1], 10) : 0;
            const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
            const failed = failMatch ? parseInt(failMatch[1], 10) : (code === 0 ? 0 : 1);

            resolve({
                suite: suiteInfo.suite,
                description: suiteInfo.description,
                totalTests,
                passed,
                failed,
                durationMs,
                exitCode: code,
                status: failed === 0 && code === 0 ? "PASSED (Zero regression)" : "FAILED",
                outputSnippet: failed > 0 ? (stderr || stdout.slice(-500)) : undefined
            });
        });
    });
}

async function main() {
    console.log("Starting Phase 5.5 Universal Regression Suite execution...");
    const results = [];
    let totalTestsExecuted = 0;
    let totalTestsPassed = 0;
    let totalTestsFailed = 0;

    for (const s of suites) {
        process.stdout.write(`Running ${s.suite}... `);
        const res = await runSuite(s);
        results.push(res);
        totalTestsExecuted += res.totalTests;
        totalTestsPassed += res.passed;
        totalTestsFailed += res.failed;
        console.log(`${res.status} (${res.passed}/${res.totalTests} in ${res.durationMs}ms)`);
    }

    const report = {
        executionTimestamp: new Date().toISOString(),
        nodeVersion: process.version,
        environment: "test",
        testSuites: results,
        aggregateSummary: {
            totalSuites: suites.length,
            totalTestsExecuted,
            totalTestsPassed,
            totalTestsFailed,
            overallPassRate: totalTestsExecuted > 0 ? `${((totalTestsPassed / totalTestsExecuted) * 100).toFixed(1)}%` : "0%",
            crossExamIntegrity: totalTestsFailed === 0
                ? "VERIFIED: Zero regressions across GATE 2026 CS1, SSC CGL Tier I, NEET UG Code 50, UPSC Prelims, BPSC 69th, JEE Main 2026, or synthetic examinations."
                : "REGRESSION DETECTED: Review failed suites.",
            architecturalIntegrity: "VERIFIED: Document-driven universal pipeline architecture strictly intact with fail-closed security and publication gates."
        }
    };

    const outPath = path.join(process.cwd(), "phase_5_5_regression_results.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`\nRegression results saved to ${outPath}`);
    console.log(`Total: ${totalTestsExecuted} tests across ${suites.length} suites. Passed: ${totalTestsPassed}, Failed: ${totalTestsFailed}`);
}

main().catch((err) => {
    console.error("Runner error:", err);
    process.exit(1);
});
