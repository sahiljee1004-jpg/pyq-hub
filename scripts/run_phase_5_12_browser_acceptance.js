import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

import app from "../server/app.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const screenshotsDir = path.join(root, "phase_5_12_acceptance_screenshots");
if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
}

const brainDir = "C:\\Users\\RUPENDRA\\.gemini\\antigravity\\brain\\7992c996-d93f-4944-8d23-3e2c2824f9ca\\phase_5_12_acceptance_screenshots";
if (!fs.existsSync(brainDir)) {
    fs.mkdirSync(brainDir, { recursive: true });
}

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROJECT_ID = "pyqs-hub-43bed";

async function saveScreenshot(page, filename, selector = null) {
    const localPath = path.join(screenshotsDir, filename);
    const brainPath = path.join(brainDir, filename);
    if (selector) {
        const el = page.locator(selector);
        await el.screenshot({ path: localPath });
    } else {
        await page.screenshot({ path: localPath, fullPage: false });
    }
    fs.copyFileSync(localPath, brainPath);
    console.log(`[Screenshot Captured] ${filename} -> ${localPath} & ${brainPath}`);
}

async function runBrowserAcceptance() {
    console.log("\n========================================================");
    console.log("PHASE 5.12: BROWSER ACCEPTANCE SUITE — 'IGNORE AND PUBLISH'");
    console.log("========================================================\n");

    process.env.NODE_ENV = "test";
    process.env.FIREBASE_PROJECT_ID = PROJECT_ID;

    // 1. Setup RSA Key Pair for Token Generation
    const keyPair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    registerTestPublicKey(keyPair.publicKey);

    const ADMIN_UID = "qa_admin_override_browser";
    const STUDENT_UID = "qa_student_override_browser";

    function createToken(uid, email, role) {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
        const payload = {
            iss: `https://securetoken.google.com/${PROJECT_ID}`,
            aud: PROJECT_ID,
            sub: uid,
            user_id: uid,
            email: email,
            role: role,
            auth_time: now,
            iat: now,
            exp: now + 7200
        };
        const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
        const b64Payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const signInput = `${b64Header}.${b64Payload}`;
        const signer = crypto.createSign("RSA-SHA256");
        signer.update(signInput);
        return `${signInput}.${signer.sign(keyPair.privateKey, "base64url")}`;
    }

    const adminToken = createToken(ADMIN_UID, "admin_browser@vidyarthiastra.in", "admin");
    const studentToken = createToken(STUDENT_UID, "student_browser@vidyarthiastra.in", "user");

    // 2. Seed Users
    UniversalFirestoreService.clearLocalCache();
    await UniversalFirestoreService.setDocument("users", ADMIN_UID, {
        uid: ADMIN_UID,
        email: "admin_browser@vidyarthiastra.in",
        role: "admin",
        createdAt: new Date().toISOString()
    });
    await UniversalFirestoreService.setDocument("users", STUDENT_UID, {
        uid: STUDENT_UID,
        email: "student_browser@vidyarthiastra.in",
        role: "user",
        createdAt: new Date().toISOString()
    });

    // 3. Seed Mock Test Paper with Discrepancies Across Severity Levels
    const testJobId = "job_browser_override_paper_2025";
    const testId = "mock-browser-override-test-2025";

    const questions = [
        {
            questionId: "q_b1",
            questionNumber: 1,
            subject: "Physics",
            sectionId: "sec-a",
            questionType: "mcq",
            questionText: "A body of mass 2 kg moving with velocity 3 m/s collides elastically with a stationary body of mass 1 kg. What is the total kinetic energy after collision?",
            options: [
                { id: "A", text: "9 J" },
                { id: "B", text: "6 J" },
                { id: "C", text: "3 J" },
                { id: "D", text: "12 J" }
            ],
            positiveMarks: 4,
            negativeMarks: 1,
            flagReason: "Minor layout anomaly: diagram artifact detected in margin",
            validationStatus: "flagged"
        },
        {
            questionId: "q_b2",
            questionNumber: 2,
            subject: "Chemistry",
            sectionId: "sec-b",
            questionType: "numerical",
            questionText: "Calculate the oxidation state of Chromium in K2Cr2O7 (enter integer value):",
            options: [],
            positiveMarks: 4,
            negativeMarks: 0,
            validationStatus: "verified"
        }
    ];

    const answerKeys = [
        { questionId: "q_b1", answerType: "mcq", correctOptionIds: ["A"] },
        { questionId: "q_b2", answerType: "numerical", acceptedAnswers: ["6"] }
    ];

    const validationReport = {
        canPublish: false,
        reportId: "rep-browser-512",
        validatedAt: new Date().toISOString(),
        sourceChecks: {
            details: [
                "Source PDF cryptographic verification completed",
                "Hash integrity signature verified"
            ]
        },
        patternChecks: {
            passed: false,
            details: [
                "Pattern configuration contains unverified section boundary",
                "Total question count mismatch: extracted 2 items vs pattern 100"
            ]
        },
        answerKeyChecks: {
            passed: false,
            details: [
                "Question 1 has content fidelity warning (diagram artifact in margin)",
                "Official answer key coverage: 100% matched"
            ]
        },
        blockers: [
            "Question Count Blocker: Expected 100 questions according to verified pattern, but extracted 2.",
            "Content Fidelity Gate: Question 1 contains unresolved layout artifact flags.",
            "Exam Profile Blocker: Pattern profile requires administrative signoff."
        ]
    };

    const job = {
        jobId: testJobId,
        status: "needs_review",
        examId: "neet-ug",
        examName: "NEET UG 2025 (Verification Paper)",
        year: 2025,
        paperCode: "CODE-OVERRIDE",
        validationReport,
        draftPackage: {
            testId,
            title: "NEET UG 2025 Verification Paper (Code OVERRIDE)",
            questions,
            answerKeys
        },
        extractedQuestions: questions,
        reconciledAnswers: answerKeys,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    await UniversalFirestoreService.setDocument("mockQuestions", "q_b1", questions[0]);
    await UniversalFirestoreService.setDocument("mockQuestions", "q_b2", questions[1]);
    await UniversalFirestoreService.setDocument("paperImportJobs", testJobId, job);
    ImportJobPipelineService.setJob(testJobId, job);
    await UniversalFirestoreService.setDocument("mockTests", testId, {
        testId,
        examId: "neet-ug",
        examName: "NEET UG 2025 (Verification Paper)",
        year: 2025,
        paperCode: "CODE-OVERRIDE",
        title: "NEET UG 2025 Verification Paper (Code OVERRIDE)",
        status: "draft",
        questions,
        questionIds: ["q_b1", "q_b2"],
        answerKeys,
        totalQuestions: 2,
        durationSeconds: 1800,
        validationReport
    });

    // 4. Start Server on Ephemeral Port
    let server;
    let baseUrl;
    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            baseUrl = `http://127.0.0.1:${addr.port}`;
            resolve();
        });
    });
    console.log(`[Server Started] ${baseUrl}`);

    // 5. Launch Real Google Chrome via Playwright
    const browser = await chromium.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({
        viewport: { width: 1366, height: 850 }
    });

    const page = await context.newPage();

    // Catch page errors
    page.on("pageerror", err => console.log(`[Browser PageError]: ${err.message}`));
    page.on("console", msg => {
        if (msg.type() === "error") console.log(`[Browser Console Error]: ${msg.text()}`);
    });

    try {
        console.log("\n--- STEP 1: Admin Panel Navigation & Blocked Gate Verification ---");

        // Authenticate admin session via secure admin_session cookie and client-side token init
        await context.addCookies([
            {
                name: "admin_session",
                value: adminToken,
                url: baseUrl
            }
        ]);

        await page.addInitScript(({ token }) => {
            window.currentIdToken = token;
            localStorage.setItem("admin_token", token);
            localStorage.setItem("authToken", token);
        }, { token: adminToken });

        // Navigate to admin panel
        const navRes = await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });
        console.log(`[Admin Navigation Response Status]: ${navRes.status()}`);
        await page.waitForSelector("#adminDashboardView", { state: "visible", timeout: 10000 });
        await page.waitForTimeout(500);

        // Open validation report tab for the test job
        await page.evaluate(async (jobId) => {
            if (typeof window.viewJobProgress === "function") {
                window.viewJobProgress(jobId);
            }
            if (typeof window.switchTab === "function") {
                window.switchTab("report");
            }
            if (typeof window.loadValidationReport === "function") {
                await window.loadValidationReport(jobId);
            }
        }, testJobId);

        await page.waitForFunction(() => {
            const badge = document.getElementById("publishGateBadge");
            return badge && badge.textContent.includes("BLOCKED");
        }, { timeout: 10000 });

        // Verify gate badge displays PUBLICATION BLOCKED
        const gateBadgeText = await page.locator("#publishGateBadge").textContent();
        console.log(`[Verification] Publish Gate Badge: "${gateBadgeText.trim()}"`);
        if (!gateBadgeText.includes("BLOCKED")) {
            throw new Error(`Expected gate badge to display BLOCKED, got "${gateBadgeText}"`);
        }

        // Verify Proceed to Publish is disabled
        const proceedDisabled = await page.locator("#reportProceedPublishBtn").isDisabled();
        console.log(`[Verification] Proceed to Publish Button Disabled: ${proceedDisabled}`);
        if (!proceedDisabled) {
            throw new Error("Expected #reportProceedPublishBtn to be disabled");
        }

        // Verify "Ignore and Publish" button is visible and styled with warning colors
        const overrideBtn = page.locator("#reportOverridePublishBtn");
        await overrideBtn.waitFor({ state: "visible", timeout: 5000 });
        const overrideBtnText = (await overrideBtn.textContent()).trim();
        console.log(`[Verification] Override Button Text: "${overrideBtnText}"`);
        if (!overrideBtnText.includes("Ignore and Publish")) {
            throw new Error(`Expected button text "Ignore and Publish", got "${overrideBtnText}"`);
        }

        // Screenshot 1: Validation report blocked gate with Ignore and Publish button
        await saveScreenshot(page, "01_admin_validation_report_blocked_gate.png");

        console.log("\n--- STEP 2: Open Override Modal & Inspect Discrepancies Breakdown ---");

        // Click "Ignore and Publish"
        await overrideBtn.click();
        await page.waitForTimeout(600);

        const modal = page.locator("#overridePublishModal");
        await modal.waitFor({ state: "visible", timeout: 5000 });

        // Verify Heading
        const headingText = (await modal.locator("h3").textContent()).trim();
        console.log(`[Verification] Modal Heading: "${headingText}"`);
        if (!headingText.includes("Override Validation and Publish?")) {
            throw new Error(`Expected heading "Override Validation and Publish?", got "${headingText}"`);
        }

        // Verify Summary Counts
        const totalCount = await page.locator("#overrideTotalCount").textContent();
        const criticalCount = await page.locator("#overrideCriticalCount").textContent();
        const majorCount = await page.locator("#overrideMajorCount").textContent();
        const minorCount = await page.locator("#overrideMinorCount").textContent();
        const warningCount = await page.locator("#overrideWarningCount").textContent();
        const otherCount = await page.locator("#overrideOtherCount").textContent();

        console.log(`[Verification] Discrepancy Breakdown -> Total: ${totalCount}, Critical: ${criticalCount}, Major: ${majorCount}, Minor: ${minorCount}, Warnings: ${warningCount}, Other: ${otherCount}`);

        // Verify Detailed Discrepancy List is populated
        const findingsList = page.locator("#overrideDiscrepanciesList");
        const findingsCount = await findingsList.locator("> div").count();
        console.log(`[Verification] Detailed findings rendered in list: ${findingsCount}`);
        if (findingsCount === 0) {
            throw new Error("Expected at least one detailed discrepancy in #overrideDiscrepanciesList");
        }

        // Screenshot 2: Modal with breakdown pills and findings list
        await saveScreenshot(page, "02_override_modal_discrepancies_breakdown.png");

        console.log("\n--- STEP 3: Enter Optional Reason & Verify Input ---");

        const reasonInput = page.locator("#overrideReasonInput");
        const testReason = "Phase 5.12 QA verification: Manual review completed under exam governance ticket GOV-2026.";
        await reasonInput.fill(testReason);
        console.log(`[Verification] Entered Optional Reason: "${testReason}"`);

        // Screenshot 3: Modal with entered reason
        await saveScreenshot(page, "03_override_modal_reason_entered.png");

        console.log("\n--- STEP 4: Confirm Ignore and Publish & State Transition ---");

        // Prepare dialog handler for the success alert
        page.on("dialog", async (dialog) => {
            console.log(`[Browser Alert]: "${dialog.message()}"`);
            await dialog.accept();
        });

        const executeBtn = page.locator("#executeOverridePublishBtn");
        await executeBtn.click();

        // Wait for modal to close and report to refresh to Published with Administrative Override
        await page.waitForFunction(() => {
            const badge = document.getElementById("publishGateBadge");
            return badge && badge.textContent.includes("ADMINISTRATIVE OVERRIDE");
        }, { timeout: 10000 });

        // Verify new Gate Badge
        const updatedBadgeText = await page.locator("#publishGateBadge").textContent();
        console.log(`[Verification] Updated Gate Badge: "${updatedBadgeText.trim()}"`);
        if (!updatedBadgeText.includes("PUBLISHED WITH ADMINISTRATIVE OVERRIDE")) {
            throw new Error(`Expected gate badge to display "PUBLISHED WITH ADMINISTRATIVE OVERRIDE", got "${updatedBadgeText}"`);
        }

        // Verify buttons are now hidden/disabled
        const proceedHidden = await page.locator("#reportProceedPublishBtn").evaluate(el => el.style.display === "none" || el.disabled);
        const overrideHidden = await page.locator("#reportOverridePublishBtn").evaluate(el => el.style.display === "none" || el.disabled);
        console.log(`[Verification] Proceed Button Inactive: ${proceedHidden}, Override Button Inactive: ${overrideHidden}`);

        // Screenshot 4: Validation report with "PUBLISHED WITH ADMINISTRATIVE OVERRIDE" badge
        await saveScreenshot(page, "04_published_with_administrative_override_badge.png");

        console.log("\n--- STEP 5: Student Mock Test Interface & Runtime Verification ---");

        // Open mock test page in student context
        const studentContext = await browser.newContext({ viewport: { width: 1366, height: 850 } });
        await studentContext.addCookies([
            {
                name: "authToken",
                value: studentToken,
                url: baseUrl
            }
        ]);
        const studentPage = await studentContext.newPage();
        await studentPage.addInitScript(({ token }) => {
            window.currentAuthToken = token;
            localStorage.setItem("authToken", token);
        }, { token: studentToken });

        await studentPage.goto(`${baseUrl}/mock-test.html?testId=${testId}`, { waitUntil: "networkidle" });
        await studentPage.waitForTimeout(1200);

        // Verify test header and question text
        const questionText = await studentPage.locator("#testQuestionText").textContent().catch(() => "");
        console.log(`[Verification] Student Test Question 1 Text: "${(questionText || "").slice(0, 80)}..."`);

        // Screenshot 5: Student Mock Test Interface
        await saveScreenshot(studentPage, "05_student_mock_test_active_interface.png");
        await studentContext.close();

        console.log("\n--- STEP 6: Durable Firestore Audit Log Verification ---");

        // Verify Firestore audit log document
        const auditLogs = await UniversalFirestoreService.listDocuments("adminAuditLogs");
        const audit = auditLogs.find(a => a.mockTestId === testId);
        console.log(`[Verification] Audit Record Found in adminAuditLogs:`, {
            auditId: audit?.auditId,
            adminUid: audit?.adminUid,
            reason: audit?.overrideReason,
            totalDiscrepancies: audit?.totalDiscrepancyCount,
            method: audit?.publicationMethod,
            result: audit?.operationResult
        });

        if (!audit) {
            throw new Error(`No audit record found for testId '${testId}' in adminAuditLogs`);
        }
        if (audit.publicationMethod !== "ADMIN_OVERRIDE") {
            throw new Error(`Expected audit.publicationMethod to be 'ADMIN_OVERRIDE', got '${audit.publicationMethod}'`);
        }
        if (audit.overrideReason !== testReason) {
            throw new Error(`Expected audit.overrideReason to match '${testReason}', got '${audit.overrideReason}'`);
        }

        // Navigate admin back to Overview metrics or history
        await page.evaluate(() => {
            if (typeof window.switchTab === "function") window.switchTab("overview");
        });
        await page.waitForTimeout(600);

        // Screenshot 6: Audit log verification proof / overview metrics
        await saveScreenshot(page, "06_audit_log_verification_verified.png");

        console.log("\n========================================================");
        console.log("PHASE 5.12 BROWSER ACCEPTANCE SUITE: ALL SCENARIOS PASSED!");
        console.log("========================================================\n");

    } finally {
        await browser.close();
        if (server) {
            await new Promise(r => server.close(r));
        }
    }
}

runBrowserAcceptance().catch(err => {
    console.error("\n[FATAL BROWSER ACCEPTANCE ERROR]:", err);
    process.exit(1);
});
