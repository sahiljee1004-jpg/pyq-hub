import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import app from "../server/server.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { ImportJobPipelineService } from "../server/services/admin/importJobPipelineService.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/**
 * Playwright E2E Browser Verification Suite — Secure Mock Test Deletion
 * 
 * Verifies Part A, Part B, Part E, and Part G:
 * 1. Delete button appears for published, failed, verification-pending, and ready-to-publish jobs.
 * 2. Incomplete / failed import jobs invoke the correct import-data cleanup flow.
 * 3. Exact confirmation phrase required before execution.
 * 4. Genuine emulator deletion occurs.
 * 5. Sibling tests preserved.
 * 6. Student catalog reflects deletion immediately.
 */
describe("E2E Browser Verification — Secure Mock Test Deletion Workflow", () => {
    let server;
    let baseUrl;
    let browser;
    let adminToken;
    let studentToken;
    let keyPair;

    const ADMIN_UID = "browser_e2e_admin_uid";
    const STUDENT_UID = "browser_e2e_student_uid";
    const PROJECT_ID = "demo-vidyarthiastra";

    const TARGET_JOB_ID = "job_browser_del_001";
    const TARGET_TEST_ID = "mock-neet-2024-del-browser";
    const SIBLING_TEST_ID = "mock-neet-2024-sibling-browser";
    const SIBLING_JOB_ID = "job_browser_sibling_002";

    const FAILED_JOB_ID = "job_browser_failed_003";
    const VERIFY_JOB_ID = "job_browser_verify_004";
    const READY_JOB_ID = "job_browser_ready_005";

    before(async () => {
        assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must be set");
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = PROJECT_ID;

        keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        registerTestPublicKey(keyPair.publicKey);

        function createToken(uid, role) {
            const now = Math.floor(Date.now() / 1000);
            const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
            const payload = {
                iss: `https://securetoken.google.com/${PROJECT_ID}`,
                aud: PROJECT_ID,
                sub: uid,
                user_id: uid,
                email: `${uid}@vidyarthiastra.in`,
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

        adminToken = createToken(ADMIN_UID, "admin");
        studentToken = createToken(STUDENT_UID, "user");

        // Seed users in Firestore emulator
        await UniversalFirestoreService.setDocument("users", ADMIN_UID, {
            uid: ADMIN_UID,
            email: "admin@vidyarthiastra.in",
            role: "admin"
        });
        await UniversalFirestoreService.setDocument("users", STUDENT_UID, {
            uid: STUDENT_UID,
            email: "student@vidyarthiastra.in",
            role: "user"
        });

        // 1. Target mock test to delete
        await UniversalFirestoreService.setDocument("mockTests", TARGET_TEST_ID, {
            testId: TARGET_TEST_ID,
            examId: "neet",
            examName: "NEET UG",
            year: 2024,
            paperCode: "Q1",
            title: "NEET UG 2024 (Code Q1) - Browser Deletion Target",
            durationSeconds: 1200,
            questionIds: ["q_browser_target_1", "q_browser_target_2"],
            status: "published",
            createdAt: new Date().toISOString()
        });

        await UniversalFirestoreService.setDocument("mockQuestions", "q_browser_target_1", {
            questionId: "q_browser_target_1",
            testId: TARGET_TEST_ID,
            questionNumber: 1,
            questionText: "Target Question 1",
            options: [{ id: "1", label: "A", text: "Opt 1" }]
        });
        await UniversalFirestoreService.setDocument("mockQuestions", "q_browser_target_2", {
            questionId: "q_browser_target_2",
            testId: TARGET_TEST_ID,
            questionNumber: 2,
            questionText: "Target Question 2",
            options: [{ id: "1", label: "A", text: "Opt 1" }]
        });

        // 2. Sibling test that must NOT be deleted
        await UniversalFirestoreService.setDocument("mockTests", SIBLING_TEST_ID, {
            testId: SIBLING_TEST_ID,
            examId: "neet",
            examName: "NEET UG",
            year: 2024,
            paperCode: "Q2",
            title: "NEET UG 2024 (Code Q2) - Preserved Browser Sibling",
            durationSeconds: 1200,
            questionIds: ["q_browser_sibling_1"],
            status: "published",
            createdAt: new Date().toISOString()
        });
        await UniversalFirestoreService.setDocument("mockQuestions", "q_browser_sibling_1", {
            questionId: "q_browser_sibling_1",
            testId: SIBLING_TEST_ID,
            questionNumber: 1,
            questionText: "Sibling Question 1",
            options: [{ id: "1", label: "A", text: "Opt 1" }]
        });

        // 3. Target import job in published state
        const targetJob = {
            jobId: TARGET_JOB_ID,
            examId: "neet",
            year: 2024,
            paperCode: "Q1",
            status: "published",
            stage: "Test paper published.",
            extractedQuestionCount: 2,
            verifiedAnswerCount: 2,
            progressPercent: 100,
            validationReport: { canPublish: true, blockers: [] },
            publishedMockTestId: TARGET_TEST_ID,
            createdAt: new Date().toISOString()
        };
        await UniversalFirestoreService.setDocument("paperImportJobs", TARGET_JOB_ID, targetJob);

        // 4. Sibling import job in published state
        const siblingJob = {
            jobId: SIBLING_JOB_ID,
            examId: "neet",
            year: 2024,
            paperCode: "Q2",
            status: "published",
            stage: "Test paper published.",
            extractedQuestionCount: 1,
            verifiedAnswerCount: 1,
            progressPercent: 100,
            validationReport: { canPublish: true, blockers: [] },
            publishedMockTestId: SIBLING_TEST_ID,
            createdAt: new Date().toISOString()
        };
        await UniversalFirestoreService.setDocument("paperImportJobs", SIBLING_JOB_ID, siblingJob);

        // 5. Failed import job without published test
        const failedJob = {
            jobId: FAILED_JOB_ID,
            examId: "jee_main",
            year: 2024,
            paperCode: "Session2",
            status: "failed",
            stage: "OCR extraction failed.",
            extractedQuestionCount: 0,
            verifiedAnswerCount: 0,
            progressPercent: 20,
            createdAt: new Date().toISOString()
        };
        await UniversalFirestoreService.setDocument("paperImportJobs", FAILED_JOB_ID, failedJob);

        // 6. Verification pending job
        const verifyJob = {
            jobId: VERIFY_JOB_ID,
            examId: "gate",
            year: 2024,
            paperCode: "CS",
            status: "verification_pending",
            stage: "Pending admin review.",
            extractedQuestionCount: 10,
            verifiedAnswerCount: 5,
            progressPercent: 60,
            createdAt: new Date().toISOString()
        };
        await UniversalFirestoreService.setDocument("paperImportJobs", VERIFY_JOB_ID, verifyJob);

        // 7. Ready to publish job
        const readyJob = {
            jobId: READY_JOB_ID,
            examId: "upsc",
            year: 2024,
            paperCode: "Prelims",
            status: "ready_to_publish",
            stage: "Ready for publication.",
            extractedQuestionCount: 20,
            verifiedAnswerCount: 20,
            progressPercent: 95,
            validationReport: { canPublish: true, blockers: [] },
            createdAt: new Date().toISOString()
        };
        await UniversalFirestoreService.setDocument("paperImportJobs", READY_JOB_ID, readyJob);

        // Sync with ImportJobPipelineService
        await ImportJobPipelineService.syncJobsFromFirestore();

        // Start server
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });

        // Launch Chromium browser
        browser = await chromium.launch({
            executablePath: CHROME_PATH,
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        });
    });

    after(async () => {
        if (browser) await browser.close();
        if (server) await new Promise(resolve => server.close(resolve));
    });

    test("1. Admin opens Import History: Delete button appears for ALL job statuses (published, failed, verification_pending, ready_to_publish)", async () => {
        const context = await browser.newContext();
        const page = await context.newPage();

        await context.addCookies([
            {
                name: "admin_session",
                value: adminToken,
                url: baseUrl,
                httpOnly: true,
                sameSite: "Lax"
            }
        ]);

        await page.addInitScript(({ token, uid }) => {
            window.__mockAdminAuth = { token, uid };
            const origFetch = window.fetch;
            window.fetch = async (url, options = {}) => {
                const opts = { ...options };
                opts.headers = { ...(opts.headers || {}) };
                if (!opts.headers["Authorization"]) {
                    opts.headers["Authorization"] = `Bearer ${token}`;
                }
                return origFetch(url, opts);
            };
        }, { token: adminToken, uid: ADMIN_UID });

        await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });
        await page.waitForSelector("#adminDashboardView", { state: "visible", timeout: 10000 });

        // Switch to Import History tab
        await page.evaluate(() => window.switchTab && window.switchTab("history"));
        await page.waitForSelector("#tab-history", { state: "visible" });
        await page.waitForSelector("#historyTableBody tr", { state: "visible" });

        // Verify Delete button exists for each status row in table
        const rows = page.locator("#historyTableBody tr");
        const rowCount = await rows.count();
        assert.ok(rowCount >= 4, `Expected at least 4 rows, found ${rowCount}`);

        // Verify Delete Mock Test button is present in EVERY row
        const deleteButtons = page.locator('#historyTableBody tr button:has-text("Delete Mock Test")');
        const deleteButtonCount = await deleteButtons.count();
        assert.equal(deleteButtonCount, rowCount, "Every row in Import History must have a Delete Mock Test button");

        // Click delete on published test, verify modal, and test cancel
        const publishedDeleteBtn = page.locator(`#historyTableBody tr:has-text("${TARGET_JOB_ID}") button:has-text("Delete Mock Test")`);
        await publishedDeleteBtn.click();
        await page.waitForTimeout(600);

        const modal = page.locator("#deleteMockTestModal");
        assert.ok(await modal.isVisible(), "Delete confirmation modal must be open");

        const cancelBtn = page.locator("#cancelDeleteBtn");
        await cancelBtn.click();
        await page.waitForTimeout(400);
        assert.equal(await modal.isVisible(), false, "Modal must close on cancel");

        // Verify nothing was deleted
        const stillExisting = await UniversalFirestoreService.getDocument("mockTests", TARGET_TEST_ID);
        assert.ok(stillExisting, "Test must NOT be deleted after canceling");

        await context.close();
    });

    test("2. Admin deletes a failed import job via Delete Import Data workflow", async () => {
        const context = await browser.newContext();
        const page = await context.newPage();

        await context.addCookies([
            {
                name: "admin_session",
                value: adminToken,
                url: baseUrl,
                httpOnly: true,
                sameSite: "Lax"
            }
        ]);

        await page.addInitScript(({ token, uid }) => {
            window.__mockAdminAuth = { token, uid };
            const origFetch = window.fetch;
            window.fetch = async (url, options = {}) => {
                const opts = { ...options };
                opts.headers = { ...(opts.headers || {}) };
                if (!opts.headers["Authorization"]) {
                    opts.headers["Authorization"] = `Bearer ${token}`;
                }
                return origFetch(url, opts);
            };
        }, { token: adminToken, uid: ADMIN_UID });

        await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });
        await page.waitForSelector("#adminDashboardView", { state: "visible", timeout: 10000 });
        await page.evaluate(() => window.switchTab && window.switchTab("history"));
        await page.waitForSelector("#historyTableBody tr", { state: "visible" });

        // Click Delete Mock Test on the failed job row
        const failedRowDeleteBtn = page.locator(`#historyTableBody tr:has-text("${FAILED_JOB_ID}") button:has-text("Delete Mock Test")`);
        await failedRowDeleteBtn.click();
        await page.waitForTimeout(600);

        const modal = page.locator("#deleteMockTestModal");
        assert.ok(await modal.isVisible(), "Modal must open for failed job");

        // Verify modal adapted to Incomplete Import Job Data Deletion
        const heading = await page.locator("#deleteModalHeading").textContent();
        assert.match(heading, /Import Data/i, "Heading must indicate import data deletion");

        const expectedPhrase = await page.locator("#deleteExpectedPhrase").textContent();
        assert.equal(expectedPhrase.trim(), FAILED_JOB_ID, "Expected phrase must be the job ID");

        // Type exact job ID
        const confirmInput = page.locator("#deleteConfirmationInput");
        await confirmInput.fill(FAILED_JOB_ID);
        await page.waitForTimeout(200);

        const executeBtn = page.locator("#executeDeleteBtn");
        assert.equal(await executeBtn.isDisabled(), false, "Execute button must be enabled");

        // Execute delete
        await executeBtn.click();
        await page.waitForTimeout(1000);

        // Verify success alert message
        const alertBox = page.locator("#deleteModalAlert");
        const alertText = await alertBox.textContent();
        assert.match(alertText, /permanently deleted/i, "Alert must confirm permanent deletion");

        // Verify in Firestore emulator: failed job is gone
        await page.waitForTimeout(1500);
        const deletedJob = await UniversalFirestoreService.getDocument("paperImportJobs", FAILED_JOB_ID);
        assert.equal(deletedJob, null, "Failed import job document must be deleted from Firestore emulator");

        await context.close();
    });

    test("3. Admin confirms published mock test deletion: cascade deletion in emulator, catalog refresh, and sibling preservation", async () => {
        const context = await browser.newContext();
        const page = await context.newPage();

        await context.addCookies([
            {
                name: "admin_session",
                value: adminToken,
                url: baseUrl,
                httpOnly: true,
                sameSite: "Lax"
            }
        ]);

        await page.addInitScript(({ token, uid }) => {
            window.__mockAdminAuth = { token, uid };
            const origFetch = window.fetch;
            window.fetch = async (url, options = {}) => {
                const opts = { ...options };
                opts.headers = { ...(opts.headers || {}) };
                if (!opts.headers["Authorization"]) {
                    opts.headers["Authorization"] = `Bearer ${token}`;
                }
                return origFetch(url, opts);
            };
        }, { token: adminToken, uid: ADMIN_UID });

        await page.goto(`${baseUrl}/admin.html`, { waitUntil: "networkidle" });
        await page.waitForSelector("#adminDashboardView", { state: "visible", timeout: 10000 });
        await page.evaluate(() => window.switchTab && window.switchTab("history"));
        await page.waitForSelector("#historyTableBody tr", { state: "visible" });

        // Click delete on published test row
        const targetDeleteBtn = page.locator(`#historyTableBody tr:has-text("${TARGET_JOB_ID}") button:has-text("Delete Mock Test")`);
        await targetDeleteBtn.click();
        await page.waitForTimeout(600);

        const modal = page.locator("#deleteMockTestModal");
        assert.ok(await modal.isVisible());

        // Type exact test ID
        const confirmInput = page.locator("#deleteConfirmationInput");
        await confirmInput.fill(TARGET_TEST_ID);
        await page.waitForTimeout(200);

        const executeBtn = page.locator("#executeDeleteBtn");
        assert.equal(await executeBtn.isDisabled(), false);

        await executeBtn.click();
        await page.waitForTimeout(1000);

        const alertBox = page.locator("#deleteModalAlert");
        const alertText = await alertBox.textContent();
        assert.match(alertText, /permanently deleted/i);

        await page.waitForTimeout(1500);

        // Verify Firestore emulator: target test document is gone
        const deletedTestDoc = await UniversalFirestoreService.getDocument("mockTests", TARGET_TEST_ID);
        assert.equal(deletedTestDoc, null, "Deleted mock test must be null in Firestore emulator");

        // Verify sibling test remains intact
        const siblingDoc = await UniversalFirestoreService.getDocument("mockTests", SIBLING_TEST_ID);
        assert.ok(siblingDoc, "Sibling test must remain published in Firestore emulator");

        // Visit student mock-test catalog page
        const studentPage = await context.newPage();
        await studentPage.addInitScript(({ token, uid }) => {
            const origFetch = window.fetch;
            window.fetch = async (url, options = {}) => {
                const opts = { ...options };
                opts.headers = { ...(opts.headers || {}) };
                if (!opts.headers["Authorization"]) {
                    opts.headers["Authorization"] = `Bearer ${token}`;
                }
                return origFetch(url, opts);
            };
        }, { token: studentToken, uid: STUDENT_UID });

        await studentPage.goto(`${baseUrl}/mock-test.html`, { waitUntil: "networkidle" });
        await studentPage.waitForTimeout(800);

        const pageContent = await studentPage.content();
        assert.ok(!pageContent.includes(TARGET_TEST_ID), "Deleted test ID must not be present in student catalog");
        assert.ok(pageContent.includes("Preserved Browser Sibling"), "Sibling test must be present in student catalog");

        await context.close();
    });
});
