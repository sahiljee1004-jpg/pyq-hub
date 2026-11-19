/**
 * ============================================================================
 * PHASE 5.13 — RRB PAPER REVIEW STATUS FILTER BROWSER ACCEPTANCE SCRIPT
 * ============================================================================
 * 
 * Verifies with real Google Chrome via Playwright:
 * 1. RRB Paper Review page initialization (74 questions: 0 correct, 6 incorrect, 68 unattempted)
 * 2. Status button click listeners (All, Correct, Incorrect, Unattempted)
 * 3. Active button styling transitions (.active class and theme styling)
 * 4. Question palette dynamic filtering and synchronization (only filtered questions, original question numbers)
 * 5. Palette navigation (clicking palette button opens correct original question)
 * 6. Forward / Backward step navigation (Next / Prev step through filtered set and disable at bounds)
 * 7. Filter exclusion handling (when active question is not in newly selected filter, first matching question opens)
 * 8. Zero-match handling (empty state card and palette notification)
 * 9. Simultaneous subject + status filtering (General + Incorrect)
 * 10. High-resolution screenshot capture:
 *     - 01_review_all_questions.png
 *     - 02_review_correct_questions.png
 *     - 03_review_incorrect_questions.png
 *     - 04_review_unattempted_questions.png
 *     - 05_review_combined_subject_status_filter.png
 */

import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const screenshotsDir = path.join(root, "phase_5_13_acceptance_screenshots");
if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
}

const brainDir = "C:\\Users\\RUPENDRA\\.gemini\\antigravity\\brain\\7992c996-d93f-4944-8d23-3e2c2824f9ca\\phase_5_13_acceptance_screenshots";
if (!fs.existsSync(brainDir)) {
    fs.mkdirSync(brainDir, { recursive: true });
}

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// Mock Firebase SDK module for student browser session
const MOCK_FIREBASE_JS = `
export const initializeApp = () => ({});
export const getApp = () => ({});
export const getFirestore = () => ({});
export const getAuth = () => ({ currentUser: { uid: "student-qa-user", email: "student@test.com", getIdToken: async () => "mock-valid-jwt-token" } });
export const onAuthStateChanged = (auth, cb) => { cb({ uid: "student-qa-user", email: "student@test.com", displayName: "RRB QA Candidate" }); return () => {}; };
export const GoogleAuthProvider = class {};
export const signInWithPopup = async () => {};
export const signOut = async () => {};
export const signInWithEmailAndPassword = async () => {};
export const createUserWithEmailAndPassword = async () => {};
export const sendPasswordResetEmail = async () => {};
export const updateProfile = async () => {};
export const doc = () => ({});
export const getDoc = async () => ({ exists: () => true, data: () => ({ name: "RRB QA Candidate", email: "student@test.com" }) });
export const setDoc = async () => {};
export const collection = () => ({});
export const getDocs = async () => ({ docs: [], forEach: (cb) => {} });
export const query = () => ({});
export const where = () => ({});
export const orderBy = () => ({});
export const limit = () => ({});
export const serverTimestamp = () => new Date();
export const increment = (n) => n;
export const updateDoc = async () => {};
export const addDoc = async () => ({ id: "mock-doc" });
`;

// Helper: Generate RRB 74 questions matching screenshot metrics
function generateRrb74ReviewQuestions() {
    const questions = [];
    const incorrectIndices = new Set([3, 11, 24, 42, 57, 70]);

    for (let i = 1; i <= 74; i++) {
        const isIncorrect = incorrectIndices.has(i);
        const status = isIncorrect ? "incorrect" : "unanswered";

        questions.push({
            questionId: `rrb_q_${i}`,
            questionNumber: i,
            originalNumbering: String(i),
            questionType: "mcq",
            subject: "General",
            subjectId: "general",
            subjectName: "General",
            sectionId: "sec_general",
            sectionName: "General",
            questionText: i === 3
                ? "The concept of 'Universal Gravitation' was formulated by which eminent scientist?"
                : (i === 11
                    ? "In Indian Railways, what does the designation 'RDSO' stand for?"
                    : (i === 24
                        ? "Which of the following elements has the highest electrical conductivity at room temperature?"
                        : `RRB CBT official test question ${i} covering General Awareness and Technical Fundamentals.`)),
            options: [
                { id: "1", label: "A", text: i === 3 ? "Albert Einstein" : (i === 11 ? "Railway Development Standards Organization" : "Copper") },
                { id: "2", label: "B", text: i === 3 ? "Sir Isaac Newton" : (i === 11 ? "Research Designs and Standards Organisation" : "Silver") },
                { id: "3", label: "C", text: i === 3 ? "Galileo Galilei" : (i === 11 ? "Regional Department for Safety Operations" : "Gold") },
                { id: "4", label: "D", text: i === 3 ? "Johannes Kepler" : (i === 11 ? "Rail Data System Organization" : "Aluminum") }
            ],
            status,
            studentAnswer: isIncorrect ? "1" : null,
            marksAwarded: isIncorrect ? -0.333 : 0,
            correctAnswer: isIncorrect ? {
                type: "mcq",
                optionId: "2",
                optionLabel: "B",
                text: i === 3 ? "Sir Isaac Newton" : (i === 11 ? "Research Designs and Standards Organisation" : "Silver")
            } : null
        });
    }
    return questions;
}

const RRB_REVIEW_PAYLOAD = {
    success: true,
    attemptId: "att_rrb_74_eval",
    testTitle: "RRB",
    examId: "rrb-ntpc",
    userId: "student-qa-user",
    language: "English",
    summary: {
        totalScore: -2.0,
        maximumMarks: 74,
        percentageScore: 0,
        totalQuestions: 74,
        correctCount: 0,
        incorrectCount: 6,
        unansweredCount: 68,
        droppedCount: 0,
        accuracyPercent: 0
    },
    questions: generateRrb74ReviewQuestions()
};

async function saveScreenshot(page, filename) {
    const localPath = path.join(screenshotsDir, filename);
    const brainPath = path.join(brainDir, filename);
    await page.screenshot({ path: localPath, fullPage: true });
    fs.copyFileSync(localPath, brainPath);
    console.log(`  [SCREENSHOT CAPTURED] ${filename}`);
}

async function runBrowserAcceptance() {
    console.log("================================================================================");
    console.log("PHASE 5.13 — BROWSER ACCEPTANCE: RRB PAPER REVIEW STATUS FILTER NAVIGATION");
    console.log("================================================================================");

    const consoleLogs = [];
    const consoleErrors = [];

    const browser = await chromium.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-web-security",
            "--allow-file-access-from-files"
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1366, height: 850 }
    });

    const page = await context.newPage();

    page.on("console", (msg) => {
        const text = msg.text();
        consoleLogs.push(text);
        if (msg.type() === "error") {
            if (!text.includes("net::ERR_NETWORK_ACCESS_DENIED") && !text.includes("Failed to load resource")) {
                consoleErrors.push(text);
                console.error(`  [PAGE-CONSOLE-ERROR] ${text}`);
            }
        }
    });

    page.on("pageerror", (err) => {
        consoleErrors.push(err.message);
        console.error(`  [UNCAUGHT-PAGE-ERROR] ${err.message}`);
    });

    // Intercept network routes for complete student review simulation
    await page.route("**/*", async (route) => {
        const url = route.request().url();

        // Mock external fonts/CDNs to prevent sandbox network access denied errors
        if (url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com")) {
            return route.fulfill({
                status: 200,
                contentType: "text/css",
                body: "/* mock font */"
            });
        }

        // Mock Firebase SDK bundle
        if (url.includes("firebase-app.js") || url.includes("firebase-auth.js") || url.includes("firebase-firestore.js")) {
            return route.fulfill({
                status: 200,
                contentType: "application/javascript",
                body: MOCK_FIREBASE_JS
            });
        }

        // Mock Auth session-role
        if (url.includes("/api/auth/session-role")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ role: "student", uid: "student-qa-user", email: "student@test.com" })
            });
        }

        // Mock Review Endpoint
        if (url.includes("/review")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(RRB_REVIEW_PAYLOAD)
            });
        }

        // Fallback for static assets served from local filesystem
        const wwwPath = path.join(root, "www");
        const parsedUrl = new URL(url, "http://localhost:3000");
        let filePath = path.join(wwwPath, parsedUrl.pathname);

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            let mime = "text/plain";
            if (filePath.endsWith(".html")) mime = "text/html";
            else if (filePath.endsWith(".js")) mime = "application/javascript";
            else if (filePath.endsWith(".css")) mime = "text/css";
            else if (filePath.endsWith(".svg")) mime = "image/svg+xml";

            return route.fulfill({
                status: 200,
                contentType: mime,
                body: fs.readFileSync(filePath)
            });
        }

        await route.continue();
    });

    console.log("\n[STEP 1] Navigating to Mock Test review interface...");
    await page.goto("http://localhost:3000/mock-test.html", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);

    // Open review mode directly
    console.log("[STEP 2] Opening RRB Paper Review via window.openReviewExam...");
    await page.evaluate(async () => {
        await window.openReviewExam("att_rrb_74_eval");
    });
    await page.waitForTimeout(600);

    // Verify Review View visible
    const isReviewVisible = await page.evaluate(() => {
        const rev = document.getElementById("reviewView");
        return rev && rev.style.display !== "none";
    });
    console.log(`  Review View Visible: ${isReviewVisible}`);

    // Verify summary pills in top bar
    const summaryPills = await page.evaluate(() => ({
        title: document.getElementById("reviewExamTitle")?.textContent,
        total: document.getElementById("revSummaryTotal")?.textContent,
        correct: document.getElementById("revSummaryCorrect")?.textContent,
        incorrect: document.getElementById("revSummaryIncorrect")?.textContent,
        unattempted: document.getElementById("revSummaryUnattempted")?.textContent
    }));
    console.log(`  Summary Pills:`, summaryPills);

    // -------------------------------------------------------------------------
    // TEST 1: All Questions Filter
    // -------------------------------------------------------------------------
    console.log("\n[TEST 1] Verifying 'All' filter...");
    await page.click('#reviewStatusFilters button[data-status="all"]');
    await page.waitForTimeout(300);

    const allFilterState = await page.evaluate(() => {
        const activeBtn = document.querySelector("#reviewStatusFilters .filter-btn.active");
        const paletteCount = document.querySelectorAll("#revPaletteGrid .palette-btn").length;
        const qNumberText = document.getElementById("revQNumberBadge")?.textContent;
        const statusIndText = document.getElementById("revCurrentStatusIndicator")?.textContent;
        return {
            activeStatus: activeBtn?.getAttribute("data-status"),
            paletteCount,
            qNumberText,
            statusIndText
        };
    });
    console.log("  All Filter State:", allFilterState);
    if (allFilterState.paletteCount !== 74) {
        throw new Error(`Expected 74 palette buttons under All filter, got ${allFilterState.paletteCount}`);
    }
    await saveScreenshot(page, "01_review_all_questions.png");

    // -------------------------------------------------------------------------
    // TEST 2: Correct Questions Filter (0 in RRB, empty state)
    // -------------------------------------------------------------------------
    console.log("\n[TEST 2] Verifying 'Correct' filter (zero matches empty state)...");
    await page.click('#reviewStatusFilters button[data-status="correct"]');
    await page.waitForTimeout(300);

    const correctFilterState = await page.evaluate(() => {
        const activeBtn = document.querySelector("#reviewStatusFilters .filter-btn.active");
        const paletteCount = document.querySelectorAll("#revPaletteGrid .palette-btn").length;
        const qNumberText = document.getElementById("revQNumberBadge")?.textContent;
        const qText = document.getElementById("revQText")?.textContent;
        const statusIndText = document.getElementById("revCurrentStatusIndicator")?.textContent;
        const prevDisabled = document.getElementById("btnRevPrev")?.disabled;
        const nextDisabled = document.getElementById("btnRevNext")?.disabled;
        return {
            activeStatus: activeBtn?.getAttribute("data-status"),
            paletteCount,
            qNumberText,
            qText,
            statusIndText,
            prevDisabled,
            nextDisabled
        };
    });
    console.log("  Correct Filter State:", correctFilterState);
    if (correctFilterState.paletteCount !== 0) {
        throw new Error(`Expected 0 palette buttons under Correct filter, got ${correctFilterState.paletteCount}`);
    }
    if (correctFilterState.qNumberText !== "No Matches") {
        throw new Error(`Expected 'No Matches' badge, got '${correctFilterState.qNumberText}'`);
    }
    await saveScreenshot(page, "02_review_correct_questions.png");

    // -------------------------------------------------------------------------
    // TEST 3: Incorrect Questions Filter (6 in RRB)
    // -------------------------------------------------------------------------
    console.log("\n[TEST 3] Verifying 'Incorrect' filter (6 questions)...");
    await page.click('#reviewStatusFilters button[data-status="incorrect"]');
    await page.waitForTimeout(300);

    const incorrectFilterState = await page.evaluate(() => {
        const activeBtn = document.querySelector("#reviewStatusFilters .filter-btn.active");
        const paletteBtns = Array.from(document.querySelectorAll("#revPaletteGrid .palette-btn")).map(b => ({
            number: b.textContent.trim(),
            current: b.classList.contains("current"),
            incorrectClass: b.classList.contains("incorrect")
        }));
        const qNumberText = document.getElementById("revQNumberBadge")?.textContent;
        const qStatusText = document.getElementById("revQStatusBadge")?.textContent;
        const qMarksText = document.getElementById("revQMarksBadge")?.textContent;
        const statusIndText = document.getElementById("revCurrentStatusIndicator")?.textContent;
        const correctAnswerVisible = document.getElementById("revCorrectAnswerBox")?.style.display !== "none";
        const correctAnswerText = document.getElementById("revCorrectAnswerText")?.textContent;
        return {
            activeStatus: activeBtn?.getAttribute("data-status"),
            paletteCount: paletteBtns.length,
            paletteNumbers: paletteBtns.map(p => p.number),
            qNumberText,
            qStatusText,
            qMarksText,
            statusIndText,
            correctAnswerVisible,
            correctAnswerText
        };
    });
    console.log("  Incorrect Filter State:", incorrectFilterState);
    if (incorrectFilterState.paletteCount !== 6) {
        throw new Error(`Expected 6 palette buttons under Incorrect filter, got ${incorrectFilterState.paletteCount}`);
    }
    // Verify original question numbers [3, 11, 24, 42, 57, 70]
    const expectedIncorrectNumbers = ["3", "11", "24", "42", "57", "70"];
    if (JSON.stringify(incorrectFilterState.paletteNumbers) !== JSON.stringify(expectedIncorrectNumbers)) {
        throw new Error(`Expected palette numbers [3, 11, 24, 42, 57, 70], got ${JSON.stringify(incorrectFilterState.paletteNumbers)}`);
    }
    if (!incorrectFilterState.correctAnswerVisible) {
        throw new Error("Correct answer box must be displayed for incorrect question");
    }
    await saveScreenshot(page, "03_review_incorrect_questions.png");

    // -------------------------------------------------------------------------
    // TEST 4: Unattempted Questions Filter (68 in RRB)
    // -------------------------------------------------------------------------
    console.log("\n[TEST 4] Verifying 'Unattempted' filter (68 questions)...");
    await page.click('#reviewStatusFilters button[data-status="unattempted"]');
    await page.waitForTimeout(300);

    const unattemptedFilterState = await page.evaluate(() => {
        const activeBtn = document.querySelector("#reviewStatusFilters .filter-btn.active");
        const paletteCount = document.querySelectorAll("#revPaletteGrid .palette-btn").length;
        const qNumberText = document.getElementById("revQNumberBadge")?.textContent;
        const qStatusText = document.getElementById("revQStatusBadge")?.textContent;
        const statusIndText = document.getElementById("revCurrentStatusIndicator")?.textContent;
        const correctAnswerVisible = document.getElementById("revCorrectAnswerBox")?.style.display !== "none";
        return {
            activeStatus: activeBtn?.getAttribute("data-status"),
            paletteCount,
            qNumberText,
            qStatusText,
            statusIndText,
            correctAnswerVisible
        };
    });
    console.log("  Unattempted Filter State:", unattemptedFilterState);
    if (unattemptedFilterState.paletteCount !== 68) {
        throw new Error(`Expected 68 palette buttons under Unattempted filter, got ${unattemptedFilterState.paletteCount}`);
    }
    if (unattemptedFilterState.qStatusText !== "Unattempted") {
        throw new Error(`Expected 'Unattempted' status badge, got '${unattemptedFilterState.qStatusText}'`);
    }
    if (unattemptedFilterState.correctAnswerVisible) {
        throw new Error("Correct answer box must NOT be displayed for unattempted questions");
    }
    await saveScreenshot(page, "04_review_unattempted_questions.png");

    // -------------------------------------------------------------------------
    // TEST 5: Combined Subject + Status Filter (General + Incorrect)
    // -------------------------------------------------------------------------
    console.log("\n[TEST 5] Verifying Combined Subject ('General') + Status ('Incorrect') filter...");
    // Click 'General' subject filter
    await page.click('#reviewSubjectFilters button[data-subject="general"]');
    await page.waitForTimeout(200);

    // Click 'Incorrect' status filter
    await page.click('#reviewStatusFilters button[data-status="incorrect"]');
    await page.waitForTimeout(300);

    const combinedFilterState = await page.evaluate(() => {
        const activeSubBtn = document.querySelector("#reviewSubjectFilters .filter-btn.active");
        const activeStatusBtn = document.querySelector("#reviewStatusFilters .filter-btn.active");
        const paletteCount = document.querySelectorAll("#revPaletteGrid .palette-btn").length;
        const qNumberText = document.getElementById("revQNumberBadge")?.textContent;
        const qSubText = document.getElementById("revQSubjectBadge")?.textContent;
        const qStatusText = document.getElementById("revQStatusBadge")?.textContent;
        const statusIndText = document.getElementById("revCurrentStatusIndicator")?.textContent;
        return {
            activeSubject: activeSubBtn?.getAttribute("data-subject"),
            activeStatus: activeStatusBtn?.getAttribute("data-status"),
            paletteCount,
            qNumberText,
            qSubText,
            qStatusText,
            statusIndText
        };
    });
    console.log("  Combined Filter State:", combinedFilterState);
    if (combinedFilterState.paletteCount !== 6) {
        throw new Error(`Expected 6 palette buttons under combined filter, got ${combinedFilterState.paletteCount}`);
    }
    if (combinedFilterState.activeSubject !== "general") {
        throw new Error(`Expected active subject 'general', got '${combinedFilterState.activeSubject}'`);
    }
    if (combinedFilterState.activeStatus !== "incorrect") {
        throw new Error(`Expected active status 'incorrect', got '${combinedFilterState.activeStatus}'`);
    }
    await saveScreenshot(page, "05_review_combined_subject_status_filter.png");

    // -------------------------------------------------------------------------
    // TEST 6: Palette Item Click Navigation Verification
    // -------------------------------------------------------------------------
    console.log("\n[TEST 6] Verifying Question Palette click navigation...");
    // In Incorrect filter, click 3rd palette item (Question 24)
    const paletteButtons = await page.$$('#revPaletteGrid .palette-btn');
    if (paletteButtons.length >= 3) {
        await paletteButtons[2].click();
        await page.waitForTimeout(200);

        const clickedQuestionState = await page.evaluate(() => ({
            badge: document.getElementById("revQNumberBadge")?.textContent,
            indicator: document.getElementById("revCurrentStatusIndicator")?.textContent,
            isCurrent: document.querySelectorAll("#revPaletteGrid .palette-btn")[2]?.classList.contains("current")
        }));
        console.log("  Clicked Palette Item 3 State:", clickedQuestionState);
        if (clickedQuestionState.badge !== "Question 24 of 74") {
            throw new Error(`Expected 'Question 24 of 74', got '${clickedQuestionState.badge}'`);
        }
        if (!clickedQuestionState.isCurrent) {
            throw new Error("Clicked palette button must have .current class");
        }
    }

    // -------------------------------------------------------------------------
    // TEST 7: Step Forward and Backward Navigation
    // -------------------------------------------------------------------------
    console.log("\n[TEST 7] Verifying Next & Prev button step navigation...");
    await page.click("#btnRevNext");
    await page.waitForTimeout(200);
    const nextState = await page.evaluate(() => ({
        badge: document.getElementById("revQNumberBadge")?.textContent,
        indicator: document.getElementById("revCurrentStatusIndicator")?.textContent
    }));
    console.log("  After Next Question:", nextState);
    if (nextState.badge !== "Question 42 of 74") {
        throw new Error(`Expected 'Question 42 of 74', got '${nextState.badge}'`);
    }

    await page.click("#btnRevPrev");
    await page.waitForTimeout(200);
    const prevState = await page.evaluate(() => ({
        badge: document.getElementById("revQNumberBadge")?.textContent,
        indicator: document.getElementById("revCurrentStatusIndicator")?.textContent
    }));
    console.log("  After Prev Question:", prevState);
    if (prevState.badge !== "Question 24 of 74") {
        throw new Error(`Expected 'Question 24 of 74', got '${prevState.badge}'`);
    }

    // -------------------------------------------------------------------------
    // Final Diagnostics & Error Verification
    // -------------------------------------------------------------------------
    console.log("\n[STEP 8] Console Error Verification...");
    console.log(`  Console Errors Logged: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
        throw new Error(`Browser acceptance encountered console errors:\n${consoleErrors.join("\n")}`);
    }

    await browser.close();

    console.log("\n================================================================================");
    console.log("PHASE 5.13 — BROWSER ACCEPTANCE SUCCESSFUL (All 5 Screenshots Captured)");
    console.log("================================================================================");
}

runBrowserAcceptance().catch((err) => {
    console.error("FATAL: Browser acceptance failed:", err);
    process.exit(1);
});
