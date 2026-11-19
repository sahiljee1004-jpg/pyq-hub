import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import app from "../server/server.js";
import { UniversalFirestoreService } from "../server/services/admin/universalFirestoreService.js";
import { registerTestPublicKey } from "../server/services/firebaseTokenService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/**
 * Playwright Browser E2E Test Suite for Mock Test Access Control
 * 
 * Verifies:
 * 1. A guest sees the public mock-test catalog with lock indicators and "Sign in to Attempt"
 * 2. Clicking a locked test opens the VidyarthiAstra signup/login modal with custom message
 * 3. Successful login/registration returns the user to the selected test and opens language selector
 * 4. An already authenticated user sees "Start Mock Test" and starts without seeing the guest gate
 * 5. Language selector allows choosing language and starting attempt
 * 6. Questions can be answered, autosaved, submitted, and results displayed
 * 7. Guest direct API calls in browser are rejected with 401
 * 8. Study resources and existing guest guards continue working normally
 */
describe("Mock Test Access Control — Browser E2E Suite", () => {
    let server;
    let baseUrl;
    let browser;
    let studentToken;
    let keyPair;

    const STUDENT_UID = "qa_student_e2e_8899";
    const TEST_ID = "mock-browser-test-2024-sec";

    before(async () => {
        process.env.NODE_ENV = "test";
        process.env.FIREBASE_PROJECT_ID = "pyqs-hub-43bed";

        keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" }
        });
        registerTestPublicKey(keyPair.publicKey);

        function createToken(uid) {
            const now = Math.floor(Date.now() / 1000);
            const header = { alg: "RS256", typ: "JWT", kid: "test-rsa-key" };
            const payload = {
                iss: "https://securetoken.google.com/pyqs-hub-43bed",
                aud: "pyqs-hub-43bed",
                sub: uid,
                user_id: uid,
                email: "student@vidyarthiastra.in",
                role: "user",
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

        studentToken = createToken(STUDENT_UID);

        server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        browser = await chromium.launch({
            executablePath: CHROME_PATH,
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        });
    });

    after(async () => {
        if (browser) await browser.close();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    beforeEach(async () => {
        UniversalFirestoreService.clearLocalCache();

        await UniversalFirestoreService.setDocument("users", STUDENT_UID, {
            uid: STUDENT_UID,
            email: "student@vidyarthiastra.in",
            name: "QA Student",
            role: "user"
        });

        // Seed published test
        await UniversalFirestoreService.setDocument("mockTests", TEST_ID, {
            testId: TEST_ID,
            examId: "jee-main",
            examName: "JEE Main 2024",
            year: 2024,
            title: "JEE Main 2024 Secure Full Mock Test",
            paperCode: "Shift-1",
            durationSeconds: 1800,
            totalQuestions: 1,
            maximumMarks: 4,
            availableLanguages: ["English", "Hindi"],
            status: "published",
            createdAt: new Date().toISOString()
        });

        // Seed question
        await UniversalFirestoreService.setDocument("mockQuestions", `${TEST_ID}-q1`, {
            questionId: `${TEST_ID}-q1`,
            testId: TEST_ID,
            questionNumber: 1,
            subject: "Mathematics",
            questionText: "What is the derivative of sin(x)?",
            options: [
                { id: "1", label: "A", text: "cos(x)" },
                { id: "2", label: "B", text: "-cos(x)" },
                { id: "3", label: "C", text: "tan(x)" },
                { id: "4", label: "D", text: "sec(x)" }
            ],
            translations: {
                hindi: {
                    questionText: "sin(x) का अवकलज (derivative) क्या है?",
                    options: [
                        { id: "1", text: "cos(x)" },
                        { id: "2", text: "-cos(x)" },
                        { id: "3", text: "tan(x)" },
                        { id: "4", text: "sec(x)" }
                    ]
                }
            }
        });

        // Seed answer key
        await UniversalFirestoreService.setDocument("mockAnswerKeys", `${TEST_ID}-key-q1`, {
            answerKeyId: `${TEST_ID}-key-q1`,
            testId: TEST_ID,
            questionId: `${TEST_ID}-q1`,
            questionNumber: 1,
            correctAnswers: ["1"],
            marksAwarded: 4,
            negativeMarks: -1
        });
    });

    // Helper to configure complete Firebase stubs
    function setupFirebaseRoutes(context, initialUser = null) {
        context.route("**/js/firebase.js", async (route) => {
            const firebaseJs = `
                let savedUser = null;
                try {
                    const raw = sessionStorage.getItem("mock_persisted_user");
                    if (raw) savedUser = JSON.parse(raw);
                } catch (e) {}

                export const auth = {
                    currentUser: savedUser || (${initialUser ? JSON.stringify(initialUser) : "null"}),
                    onAuthStateChangedCallbacks: [],
                    signInWithEmailAndPassword: async (auth, email, password) => {
                        const user = {
                            uid: "${STUDENT_UID}",
                            email: email || "student@vidyarthiastra.in",
                            displayName: "QA Student"
                        };
                        try {
                            sessionStorage.setItem("mock_persisted_user", JSON.stringify(user));
                        } catch (e) {}
                        user.getIdToken = async () => "${studentToken}";
                        window.auth.currentUser = user;
                        for (const cb of (window.auth.onAuthStateChangedCallbacks || [])) {
                            try { cb(user); } catch (e) {}
                        }
                        return { user };
                    }
                };
                if (auth.currentUser) {
                    auth.currentUser.getIdToken = async () => "${studentToken}";
                }
                export const db = {};
                export const googleProvider = {};
                if (typeof window !== "undefined") {
                    window.auth = auth;
                }
            `;
            await route.fulfill({ status: 200, contentType: "application/javascript", body: firebaseJs });
        });

        context.route("https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js", async (route) => {
            const fakeAuthSdk = `
                export function onAuthStateChanged(auth, cb) {
                    if (window.auth) {
                        window.auth.onAuthStateChangedCallbacks = window.auth.onAuthStateChangedCallbacks || [];
                        window.auth.onAuthStateChangedCallbacks.push(cb);
                    }
                    if (typeof cb === "function") {
                        cb(window.auth ? window.auth.currentUser : null);
                    }
                }
                export function getAuth() { return window.auth; }
                export class GoogleAuthProvider {}
                export async function createUserWithEmailAndPassword(auth, email, password) {
                    return window.auth.signInWithEmailAndPassword(auth, email, password);
                }
                export async function signInWithEmailAndPassword(auth, email, password) {
                    return window.auth.signInWithEmailAndPassword(auth, email, password);
                }
                export function sendPasswordResetEmail() { return Promise.resolve(); }
                export async function signInWithPopup(auth) {
                    return window.auth.signInWithEmailAndPassword(auth, "student@vidyarthiastra.in", "pass");
                }
            `;
            await route.fulfill({ status: 200, contentType: "application/javascript", body: fakeAuthSdk });
        });

        context.route("https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js", async (route) => {
            const fakeFirestoreSdk = `
                export function collection() { return {}; }
                export function getDocs() { return Promise.resolve({ empty: true, docs: [] }); }
                export function getDoc() { return Promise.resolve({ exists: () => false, data: () => ({}) }); }
                export function doc() { return {}; }
                export function query() { return {}; }
                export function where() { return {}; }
                export function setDoc() { return Promise.resolve(); }
                export function updateDoc() { return Promise.resolve(); }
                export function increment() { return 1; }
                export function serverTimestamp() { return new Date(); }
            `;
            await route.fulfill({ status: 200, contentType: "application/javascript", body: fakeFirestoreSdk });
        });
    }

    async function createGuestContext() {
        const context = await browser.newContext();
        setupFirebaseRoutes(context, null);
        return context;
    }

    async function createStudentContext() {
        const context = await browser.newContext();
        setupFirebaseRoutes(context, {
            uid: STUDENT_UID,
            email: "student@vidyarthiastra.in",
            displayName: "QA Student"
        });
        return context;
    }

    // -------------------------------------------------------------------------
    // Scenario 1: Guest views public catalog with lock badge & "Sign in to Attempt"
    // -------------------------------------------------------------------------
    test("1. Guest sees public mock-test catalog with lock badge and 'Sign in to Attempt' button", async () => {
        const context = await createGuestContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/mock-test.html`, { waitUntil: "domcontentloaded" });

        // Wait for catalog grid to appear
        await page.waitForSelector("#testGrid .mock-card", { state: "visible", timeout: 10000 });

        // Verify lock badge is present
        const lockBadge = page.locator(".mock-card-lock-badge");
        assert.equal(await lockBadge.isVisible(), true, "Lock badge must be visible to guest");
        assert.ok((await lockBadge.textContent()).includes("Login Required"));

        // Verify button text and class
        const startBtn = page.locator(`button[data-testid="${TEST_ID}"]`);
        assert.equal(await startBtn.isVisible(), true);
        assert.ok((await startBtn.textContent()).includes("Sign in to Attempt"));
        assert.ok(await startBtn.evaluate(el => el.classList.contains("btn-guest-locked")));

        // Verify catalog metadata is visible to guest
        const cardText = await page.locator(".mock-card").textContent();
        assert.ok(cardText.includes("JEE Main 2024"));
        assert.ok(cardText.includes("30 mins"));
        assert.ok(cardText.includes("1 Questions"));
        assert.ok(cardText.includes("4 Marks"));
        assert.ok(cardText.includes("English, Hindi"));

        await context.close();
    });

    // -------------------------------------------------------------------------
    // Scenario 2: Clicking locked test opens auth modal with requested message
    // -------------------------------------------------------------------------
    test("2. Clicking locked test opens auth modal with custom mock-test message without losing place", async () => {
        const context = await createGuestContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/mock-test.html`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#testGrid .mock-card", { state: "visible", timeout: 10000 });

        // Click "Sign in to Attempt"
        const startBtn = page.locator(`button[data-testid="${TEST_ID}"]`);
        await startBtn.click();

        // Verify auth modal opened
        await page.waitForSelector("#authModal.show", { state: "visible", timeout: 5000 });

        // Verify modal title
        const modalTitle = await page.textContent("#authModalTitle");
        assert.equal(modalTitle.trim(), "Sign in to Attempt Mock Test");

        // Verify custom message
        const modalSubtitle = await page.textContent("#authModalSubtitle");
        assert.equal(
            modalSubtitle.trim(),
            "Create a free VidyarthiAstra account or log in to attempt this mock test. Your progress and results can then be saved to your account."
        );

        // Verify pending mock test ID was stored
        const pendingTestId = await page.evaluate(() => sessionStorage.getItem("pendingMockTestId"));
        assert.equal(pendingTestId, TEST_ID);

        // Verify safe postLoginRedirect was stored
        const postLoginRedirect = await page.evaluate(() => sessionStorage.getItem("postLoginRedirect"));
        assert.equal(postLoginRedirect, `mock-test.html?test=${encodeURIComponent(TEST_ID)}`);

        // Close modal and verify user remains on catalog without disruption
        await page.click("#closeAuthModal");
        await page.waitForSelector("#authModal.show", { state: "hidden" });
        assert.equal(await page.locator("#testGrid").isVisible(), true);

        await context.close();
    });

    // -------------------------------------------------------------------------
    // Scenario 3: Login/Registration returns user to test and opens language selector
    // -------------------------------------------------------------------------
    test("3. Successful authentication returns user to selected test and opens language selection modal", async () => {
        const context = await createGuestContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/mock-test.html`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#testGrid .mock-card", { state: "visible", timeout: 10000 });

        // Click locked test
        await page.click(`button[data-testid="${TEST_ID}"]`);
        await page.waitForSelector("#authModal.show", { state: "visible", timeout: 5000 });

        // Fill credentials in login form and submit
        await page.fill("#loginEmail", "student@vidyarthiastra.in");
        await page.fill("#loginPassword", "CorrectPassword123!");
        await page.click('#loginForm button[type="submit"]');

        // Modal closes upon successful login
        await page.waitForSelector("#authModal.show", { state: "hidden", timeout: 5000 });

        // Language selection modal opens automatically for the pending test
        await page.waitForSelector("#languageModal", { state: "visible", timeout: 10000 });
        const langTitle = await page.textContent("#languageModal h3");
        assert.equal(langTitle.trim(), "Choose your test language");

        // Verify supported languages are present
        const englishRadio = page.locator('input[value="English"]');
        const hindiRadio = page.locator('input[value="Hindi"]');
        assert.equal(await englishRadio.isVisible(), true);
        assert.equal(await hindiRadio.isVisible(), true);

        await context.close();
    });

    // -------------------------------------------------------------------------
    // Scenario 4: Authenticated student sees unlocked cards and starts test directly
    // -------------------------------------------------------------------------
    test("4. Authenticated student sees 'Start Mock Test' without lock badge and starts directly", async () => {
        const context = await createStudentContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/mock-test.html`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#testGrid .mock-card", { state: "visible", timeout: 10000 });

        // Verify lock badge is ABSENT
        const lockCount = await page.locator(".mock-card-lock-badge").count();
        assert.equal(lockCount, 0, "Lock badge must NOT appear for authenticated student");

        // Verify button says "Start Mock Test" without locked style
        const startBtn = page.locator(`button[data-testid="${TEST_ID}"]`);
        assert.equal((await startBtn.textContent()).trim(), "Start Mock Test");
        assert.equal(await startBtn.evaluate(el => el.classList.contains("btn-guest-locked")), false);

        // Click Start -> opens language modal directly without auth gate
        await startBtn.click();
        await page.waitForSelector("#languageModal", { state: "visible", timeout: 5000 });
        assert.equal(await page.locator("#authModal.show").count(), 0, "Auth modal must NOT open");

        // Select Hindi
        await page.locator('input[value="Hindi"]').check();

        // Confirm & Start Test
        await page.click("#langModalBtnConfirm");

        // Verify active test engine view is displayed
        await page.waitForSelector("#testView", { state: "visible", timeout: 10000 });
        await page.waitForSelector("#qText", { state: "visible", timeout: 5000 });

        // Verify Hindi question text is loaded
        const questionText = await page.textContent("#qText");
        assert.ok(questionText.includes("sin(x) का अवकलज"));

        // Select option A (cos(x))
        await page.click('input[value="1"]');

        // Submit test
        await page.click("#btnTopSubmit");
        await page.waitForSelector("#submitModal", { state: "visible", timeout: 5000 });
        await page.click("#modalBtnConfirm");

        // Verify result view
        await page.waitForSelector("#resultView", { state: "visible", timeout: 10000 });
        const totalScore = await page.textContent("#resTotalScore");
        assert.equal(totalScore.trim(), "4"); // 1 correct = 4 marks

        await context.close();
    });

    // -------------------------------------------------------------------------
    // Scenario 5: Guest cannot bypass UI by directly executing fetch in browser
    // -------------------------------------------------------------------------
    test("5. Guest cannot bypass UI by directly calling protected APIs in browser context", async () => {
        const context = await createGuestContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/mock-test.html`, { waitUntil: "domcontentloaded" });

        // Directly call protected question API without token
        const fetchStatus = await page.evaluate(async (testId) => {
            const res = await fetch(`/api/mock-tests/${testId}`);
            return res.status;
        }, TEST_ID);
        assert.equal(fetchStatus, 401, "Direct API call without token must return 401");

        // Directly call start attempt API without token
        const attemptStatus = await page.evaluate(async (testId) => {
            const res = await fetch(`/api/mock-tests/${testId}/attempts`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ language: "English" })
            });
            return res.status;
        }, TEST_ID);
        assert.equal(attemptStatus, 401, "Direct attempt API call without token must return 401");

        await context.close();
    });

    // -------------------------------------------------------------------------
    // Scenario 6: Study Resources and other auth gates continue to work
    // -------------------------------------------------------------------------
    test("6. Study resources and existing guest guards continue working as expected", async () => {
        const context = await createGuestContext();
        const page = await context.newPage();
        await page.goto(`${baseUrl}/study-resources.html`, { waitUntil: "domcontentloaded" });

        // Clicking search button triggers guest guard
        await page.waitForSelector("#searchButton", { state: "visible", timeout: 10000 });
        await page.click("#searchButton");
        await page.waitForSelector("#authModal.show", { state: "visible", timeout: 5000 });
        assert.equal(await page.locator("#authModal").isVisible(), true);

        await context.close();
    });
});
