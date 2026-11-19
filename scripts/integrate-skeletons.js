import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

// Helper to preserve CRLF
function writeWithSameEol(filePath, newContent, originalContent) {
    const isCRLF = originalContent.includes('\r\n');
    const normalized = newContent.replace(/\r\n/g, '\n');
    const finalContent = isCRLF ? normalized.replace(/\n/g, '\r\n') : normalized;
    fs.writeFileSync(filePath, finalContent, 'utf8');
}

// 1. HOME.JS
{
    const file = path.join(root, 'www/js/home.js');
    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes('skeleton-manager.js')) {
        content = content.replace(
            'import { openChatGPT } from "./chatgpt-helper.js";',
            'import { openChatGPT } from "./chatgpt-helper.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );

        // Replace loading in loadExams()
        const oldLoadExamsTarget = `        examGrid.innerHTML = \`
            <div class="loading">
                Loading exams...
            </div>
        \`;`;

        const newLoadExamsReplacement = `        const skeletonHandle = SkeletonManager.mount(
            examGrid,
            () => SkeletonManager.templates.dashboardExams(6),
            { delay: 200, ariaLabel: "Loading available examinations..." }
        );`;

        content = content.replace(oldLoadExamsTarget, newLoadExamsReplacement);

        // Dismiss skeleton when exams are displayed
        const oldDisplayTarget = `        updateExamCount(
            allExams.length
        );


        displayExams(
            allExams
        );`;

        const newDisplayReplacement = `        skeletonHandle.dismiss(() => {
            updateExamCount(allExams.length);
            displayExams(allExams);
        });`;

        content = content.replace(oldDisplayTarget, newDisplayReplacement);

        // Cancel on error
        content = content.replace(
            'console.error("Error loading exams:", error);',
            'console.error("Error loading exams:", error);\n        if (typeof skeletonHandle !== "undefined") skeletonHandle?.cancel();'
        );

        writeWithSameEol(file, content, fs.readFileSync(file, 'utf8'));
        console.log('Successfully integrated SkeletonManager into www/js/home.js');
    }
}

// 2. EXAM.JS
{
    const file = path.join(root, 'www/js/exam.js');
    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes('skeleton-manager.js')) {
        content = content.replace(
            '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";',
            '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );

        const oldLoadYearsTarget = `        yearGrid.innerHTML = \`
            <div class="loading">
                Loading years...
            </div>
        \`;`;

        const newLoadYearsReplacement = `        const skeletonYears = SkeletonManager.mount(
            yearGrid,
            () => SkeletonManager.templates.examYears(4),
            { delay: 200, ariaLabel: "Loading available examination years..." }
        );`;

        content = content.replace(oldLoadYearsTarget, newLoadYearsReplacement);

        // Dismiss in displayYears
        content = content.replace(
            'displayYears(allYears);',
            `skeletonYears.dismiss(() => {\n            displayYears(allYears);\n        });`
        );

        content = content.replace(
            'console.error(\n            "Error loading years:",',
            'if (typeof skeletonYears !== "undefined") skeletonYears?.cancel();\n        console.error(\n            "Error loading years:",'
        );

        writeWithSameEol(file, content, fs.readFileSync(file, 'utf8'));
        console.log('Successfully integrated SkeletonManager into www/js/exam.js');
    }
}

// 3. MOCK-TEST.JS
{
    const file = path.join(root, 'www/js/mock-test.js');
    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes('skeleton-manager.js')) {
        content = content.replace(
            'import { showAuthModal } from "./auth.js";',
            'import { showAuthModal } from "./auth.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );

        // Integrate in loadCatalog
        const oldLoadCatalogTarget = `    try {
        catalogLoading.innerHTML = "Loading available mock test papers...";
        catalogLoading.style.display = "block";
        catalogEmpty.style.display = "none";
        if (catalogToolbar) catalogToolbar.style.display = "none";
        if (mockCatalogStatsBar) mockCatalogStatsBar.style.display = "none";
        if (catalogNoResults) catalogNoResults.style.display = "none";
        testGrid.style.display = "none";

        const res = await fetch("/api/mock-tests");
        if (!res.ok) throw new Error("Failed to load test series catalog");

        const data = await res.json();
        publishedTests = data.tests || [];

        catalogLoading.style.display = "none";

        if (publishedTests.length === 0) {
            catalogEmpty.style.display = "block";
            return;
        }

        applyCatalogFilters();

    } catch (err) {`;

        const newLoadCatalogReplacement = `    let catalogSkeleton = null;
    try {
        catalogLoading.style.display = "none";
        catalogEmpty.style.display = "none";
        if (catalogToolbar) catalogToolbar.style.display = "none";
        if (mockCatalogStatsBar) mockCatalogStatsBar.style.display = "none";
        if (catalogNoResults) catalogNoResults.style.display = "none";
        testGrid.style.display = "block";

        catalogSkeleton = SkeletonManager.mount(
            testGrid,
            () => SkeletonManager.templates.mockCatalog(6),
            { delay: 200, ariaLabel: "Loading available mock test papers..." }
        );

        const res = await fetch("/api/mock-tests");
        if (!res.ok) throw new Error("Failed to load test series catalog");

        const data = await res.json();
        publishedTests = data.tests || [];

        catalogSkeleton.dismiss(() => {
            if (publishedTests.length === 0) {
                testGrid.style.display = "none";
                catalogEmpty.style.display = "block";
                return;
            }
            applyCatalogFilters();
        });

    } catch (err) {
        catalogSkeleton?.cancel();
        testGrid.style.display = "none";
        catalogLoading.style.display = "block";`;

        content = content.replace(oldLoadCatalogTarget, newLoadCatalogReplacement);

        // Integrate in startTestSession
        const oldStartSessionTarget = `        // 1. Start attempt on server with requested language
        const attemptRes = await fetch(\`/api/mock-tests/\${encodeURIComponent(testId)}/attempts\`, {`;

        const newStartSessionReplacement = `        catalogView.style.display = "none";
        resultView.style.display = "none";
        testView.style.display = "block";
        const testSessionSkeleton = SkeletonManager.mount(
            testView,
            () => SkeletonManager.templates.mockInterface(),
            { delay: 200, ariaLabel: "Preparing mock test session..." }
        );

        // 1. Start attempt on server with requested language
        const attemptRes = await fetch(\`/api/mock-tests/\${encodeURIComponent(testId)}/attempts\`, {`;

        content = content.replace(oldStartSessionTarget, newStartSessionReplacement);

        // Dismiss testSessionSkeleton when test starts
        const oldTestStartFinishTarget = `        // Switch Views
        catalogView.style.display = "none";
        resultView.style.display = "none";
        testView.style.display = "block";
        window.scrollTo({ top: 0, behavior: "smooth" });`;

        const newTestStartFinishReplacement = `        testSessionSkeleton.dismiss(() => {
            // Setup UI and start timer safely
            activeTestTitle.textContent = activeTest.title;
            activeTestMeta.textContent = \`\${(activeTest.examName || activeTest.examId || "").toUpperCase()} | Language: \${activeAttempt.language || language} | \${questions.length} Questions | Max Marks: \${activeTest.maximumMarks}\`;

            currentSection = "all";
            renderSectionTabs();
            renderPalette();
            renderQuestion(currentIndex);
            startTimer(activeAttempt.deadlineAt);

            catalogView.style.display = "none";
            resultView.style.display = "none";
            testView.style.display = "block";
            window.scrollTo({ top: 0, behavior: "smooth" });
        });`;

        content = content.replace(oldTestStartFinishTarget, newTestStartFinishReplacement);

        // And in startTestSession catch:
        content = content.replace(
            `    } catch (err) {\n        alert(\`Could not start test: \${err.message}\`);`,
            `    } catch (err) {\n        if (typeof testSessionSkeleton !== "undefined") testSessionSkeleton?.cancel();\n        testView.style.display = "none";\n        catalogView.style.display = "block";\n        alert(\`Could not start test: \${err.message}\`);`
        );

        // Integrate in submitCurrentTestAttempt
        const oldSubmitTarget = `        const data = await submitRes.json();
        renderResults(data.result);`;

        const newSubmitReplacement = `        const data = await submitRes.json();
        renderResults(data.result);`;

        // Also add result skeleton when submitting
        const oldSubmitStartTarget = `        // 2. Submit Attempt to server`;
        const newSubmitStartReplacement = `        // Show submission evaluation skeleton
        testView.style.display = "none";
        resultView.style.display = "block";
        const resultsSkeleton = SkeletonManager.mount(
            resultView,
            () => SkeletonManager.templates.mockResults(),
            { delay: 200, ariaLabel: "Evaluating test submission..." }
        );

        // 2. Submit Attempt to server`;

        content = content.replace(oldSubmitStartTarget, newSubmitStartReplacement);
        content = content.replace(
            `        const data = await submitRes.json();\n        renderResults(data.result);`,
            `        const data = await submitRes.json();\n        resultsSkeleton.dismiss(() => {\n            renderResults(data.result);\n        });`
        );
        content = content.replace(
            `    } catch (err) {\n        alert(\`Error during test submission: \${err.message}\`);`,
            `    } catch (err) {\n        if (typeof resultsSkeleton !== "undefined") resultsSkeleton?.cancel();\n        resultView.style.display = "none";\n        testView.style.display = "block";\n        alert(\`Error during test submission: \${err.message}\`);`
        );

        writeWithSameEol(file, content, fs.readFileSync(file, 'utf8'));
        console.log('Successfully integrated SkeletonManager into www/js/mock-test.js');
    }
}

// 4. PYQ-LIBRARY.JS
{
    const file = path.join(root, 'www/js/pyq-library.js');
    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes('skeleton-manager.js')) {
        content = content.replace(
            'import { PdfViewerController, cleanFileName, escapeHTML, safeURL } from "./pdf-viewer-core.js";',
            'import { PdfViewerController, cleanFileName, escapeHTML, safeURL } from "./pdf-viewer-core.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );

        // In loadAvailableExams
        content = content.replace(
            `async function loadAvailableExams(forceRefresh = false) {
    showExamsState("loading");`,
            `async function loadAvailableExams(forceRefresh = false) {
    if (examsGridEl) examsGridEl.style.display = "grid";
    if (examsLoadingEl) examsLoadingEl.style.display = "none";
    const skeletonExams = SkeletonManager.mount(
        examsGridEl,
        () => SkeletonManager.templates.pyqExams(6),
        { delay: 200, ariaLabel: "Loading examinations directory..." }
    );`
        );

        content = content.replace(
            `            if (filteredExams.length > 0) {
                renderExamCards(filteredExams);
                showExamsState("content");
            } else {
                if (examsEmptyDescEl) {
                    examsEmptyDescEl.textContent = "No examination question papers are currently available. Please check back later.";
                }
                showExamsState("empty");
            }`,
            `            skeletonExams.dismiss(() => {
                if (filteredExams.length > 0) {
                    renderExamCards(filteredExams);
                    showExamsState("content");
                } else {
                    if (examsEmptyDescEl) {
                        examsEmptyDescEl.textContent = "No examination question papers are currently available. Please check back later.";
                    }
                    showExamsState("empty");
                }
            });`
        );

        content = content.replace(
            `    } catch (err) {
        console.error("[PYQ Library] Failed to load available examinations:", err);`,
            `    } catch (err) {
        skeletonExams?.cancel();
        console.error("[PYQ Library] Failed to load available examinations:", err);`
        );

        // In showYearsView
        content = content.replace(
            `    showYearsState("loading");
    try {
        const res = await fetch(\`/api/papers/years?examId=\${encodeURIComponent(exam.id)}\`);`,
            `    if (yearsGridEl) yearsGridEl.style.display = "grid";
    if (yearsLoadingEl) yearsLoadingEl.style.display = "none";
    const skeletonYears = SkeletonManager.mount(
        yearsGridEl,
        () => SkeletonManager.templates.pyqYears(4),
        { delay: 200, ariaLabel: "Loading available examination years..." }
    );
    try {
        const res = await fetch(\`/api/papers/years?examId=\${encodeURIComponent(exam.id)}\`);`
        );

        content = content.replace(
            `        if (data.success && Array.isArray(data.years) && data.years.length > 0) {
            renderYearCards(data.years);
            showYearsState("content");
        } else {
            showYearsState("empty");
        }`,
            `        skeletonYears.dismiss(() => {
            if (data.success && Array.isArray(data.years) && data.years.length > 0) {
                renderYearCards(data.years);
                showYearsState("content");
            } else {
                showYearsState("empty");
            }
        });`
        );

        content = content.replace(
            `    } catch (err) {
        console.error(\`[PYQ Library] Failed to load years for \${exam.id}:\`, err);`,
            `    } catch (err) {
        skeletonYears?.cancel();
        console.error(\`[PYQ Library] Failed to load years for \${exam.id}:\`, err);`
        );

        // In showPapersView
        content = content.replace(
            `    showPapersState("loading");
    isPapersFetching = true;

    try {
        const url = \`/api/papers/by-year?examId=\${encodeURIComponent(exam.id)}&yearId=\${encodeURIComponent(yearObj.year)}&limit=12&cursor=0\`;`,
            `    if (papersGridEl) papersGridEl.style.display = "grid";
    if (papersLoadingEl) papersLoadingEl.style.display = "none";
    const skeletonPapers = SkeletonManager.mount(
        papersGridEl,
        () => SkeletonManager.templates.pyqPapers(6),
        { delay: 200, ariaLabel: "Loading question papers..." }
    );
    isPapersFetching = true;

    try {
        const url = \`/api/papers/by-year?examId=\${encodeURIComponent(exam.id)}&yearId=\${encodeURIComponent(yearObj.year)}&limit=12&cursor=0\`;`
        );

        content = content.replace(
            `        if (data.success && Array.isArray(data.papers) && data.papers.length > 0) {
            renderPaperCards(data.papers, false);
            showPapersState("content");

            currentPapersCursor = data.nextCursor;
            updateLoadMoreButton(data.hasMore);
        } else {
            showPapersState("empty");
        }`,
            `        skeletonPapers.dismiss(() => {
            if (data.success && Array.isArray(data.papers) && data.papers.length > 0) {
                renderPaperCards(data.papers, false);
                showPapersState("content");

                currentPapersCursor = data.nextCursor;
                updateLoadMoreButton(data.hasMore);
            } else {
                showPapersState("empty");
            }
        });`
        );

        content = content.replace(
            `    } catch (err) {
        isPapersFetching = false;
        console.error(\`[PYQ Library] Failed to load papers for \${exam.id}/\${yearObj.year}:\`, err);`,
            `    } catch (err) {
        skeletonPapers?.cancel();
        isPapersFetching = false;
        console.error(\`[PYQ Library] Failed to load papers for \${exam.id}/\${yearObj.year}:\`, err);`
        );

        writeWithSameEol(file, content, fs.readFileSync(file, 'utf8'));
        console.log('Successfully integrated SkeletonManager into www/js/pyq-library.js');
    }
}

// 5. PAPERS.JS
{
    const file = path.join(root, 'www/js/papers.js');
    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes('skeleton-manager.js')) {
        content = content.replace(
            'import { getOrCreateAppSessionId } from "./pdf-viewer-core.js";',
            'import { getOrCreateAppSessionId } from "./pdf-viewer-core.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );

        content = content.replace(
            `async function loadPaperCollection() {
    try {
        const papersRef = collection(db, "exams", examId, "years", yearId, "papers");`,
            `async function loadPaperCollection() {
    const skeletonPapers = SkeletonManager.mount(
        paperList,
        () => SkeletonManager.templates.papersList(5),
        { delay: 200, ariaLabel: "Loading question papers..." }
    );
    try {
        const papersRef = collection(db, "exams", examId, "years", yearId, "papers");`
        );

        content = content.replace(
            `        if (!papers.length) {
            paperList.innerHTML = \`
                <div class="empty-message">
                    <div class="empty-icon">📄</div>
                    <h3>No papers available</h3>
                    <p>Question papers for this year haven't been added yet.</p>
                </div>
            \`;
            return;
        }

        paperList.innerHTML = "";
        papers.forEach((paper, index) => {
            paperList.appendChild(createPaperCard(paper, index));
        });`,
            `        skeletonPapers.dismiss(() => {
            if (!papers.length) {
                paperList.innerHTML = \`
                    <div class="empty-message">
                        <div class="empty-icon">📄</div>
                        <h3>No papers available</h3>
                        <p>Question papers for this year haven't been added yet.</p>
                    </div>
                \`;
                return;
            }

            paperList.innerHTML = "";
            papers.forEach((paper, index) => {
                paperList.appendChild(createPaperCard(paper, index));
            });
        });`
        );

        content = content.replace(
            `    } catch (error) {
        console.error("Paper collection error:", error);`,
            `    } catch (error) {
        skeletonPapers?.cancel();
        console.error("Paper collection error:", error);`
        );

        writeWithSameEol(file, content, fs.readFileSync(file, 'utf8'));
        console.log('Successfully integrated SkeletonManager into www/js/papers.js');
    }
}

// 6. STUDY-RESOURCES.JS
{
    const file = path.join(root, 'www/js/study-resources.js');
    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes('skeleton-manager.js')) {
        content = content.replace(
            'import { getOrCreateAppSessionId } from "./pdf-viewer-core.js";',
            'import { getOrCreateAppSessionId } from "./pdf-viewer-core.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );

        content = content.replace(
            `async function fetchStudyResources() {
    try {
        const examSnapshot = await getDocs(collection(db, "studyResources"));`,
            `async function fetchStudyResources() {
    const skeleton = SkeletonManager.mount(
        studyContentArea,
        () => SkeletonManager.templates.studyResources(6),
        { delay: 200, ariaLabel: "Loading study resources..." }
    );
    try {
        const examSnapshot = await getDocs(collection(db, "studyResources"));`
        );

        content = content.replace(
            `        renderState();
    } catch (error) {`,
            `        skeleton.dismiss(() => {
            renderState();
        });
    } catch (error) {
        skeleton?.cancel();`
        );

        writeWithSameEol(file, content, fs.readFileSync(file, 'utf8'));
        console.log('Successfully integrated SkeletonManager into www/js/study-resources.js');
    }
}

// 7. LIVE-UPDATES.JS
{
    const file = path.join(root, 'www/js/live-updates.js');
    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes('skeleton-manager.js')) {
        content = content.replace(
            'import { safeURL } from "./pdf-viewer-core.js";',
            'import { safeURL } from "./pdf-viewer-core.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );

        content = content.replace(
            `    setSearchButtonLoading(true);
    renderLoadingState(\`Searching latest updates for "\${query}"...\`);

    currentQuery = query;`,
            `    setSearchButtonLoading(true);
    if (updatesFeed) updatesFeed.innerHTML = "";
    const skeletonUpdates = SkeletonManager.mount(
        updatesFeed,
        () => SkeletonManager.templates.liveUpdates(4),
        { delay: 200, ariaLabel: \`Searching latest updates for "\${query}"...\` }
    );

    currentQuery = query;`
        );

        content = content.replace(
            `        if (data.success && Array.isArray(data.updates) && data.updates.length > 0) {
            showSearchContext(query, data.updates.length);
            renderUpdatesFeed(data.updates);
        } else {
            if (searchContextBar) searchContextBar.style.display = "none";
            renderEmptyState(\`No recent updates found for "\${query}". Try searching with a broader exam name.\`);
        }`,
            `        skeletonUpdates.dismiss(() => {
            if (data.success && Array.isArray(data.updates) && data.updates.length > 0) {
                showSearchContext(query, data.updates.length);
                renderUpdatesFeed(data.updates);
            } else {
                if (searchContextBar) searchContextBar.style.display = "none";
                renderEmptyState(\`No recent updates found for "\${query}". Try searching with a broader exam name.\`);
            }
        });`
        );

        content = content.replace(
            `    } catch (err) {
        console.error("[Live Updates Search Exception]:", err);`,
            `    } catch (err) {
        skeletonUpdates?.cancel();
        console.error("[Live Updates Search Exception]:", err);`
        );

        writeWithSameEol(file, content, fs.readFileSync(file, 'utf8'));
        console.log('Successfully integrated SkeletonManager into www/js/live-updates.js');
    }
}

// 8. AI-CHAT.JS
{
    const file = path.join(root, 'www/js/ai-chat.js');
    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes('skeleton-manager.js')) {
        content = content.replace(
            'import { openChatGPT } from "./chatgpt-helper.js";',
            'import { openChatGPT } from "./chatgpt-helper.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );

        content = content.replace(
            `function setupAuthListener() {
    onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        if (currentUser) {
            await loadSavedChatHistory(currentUser.uid);
        } else {
            renderWelcomeMessage();
        }
    });
}`,
            `function setupAuthListener() {
    onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        if (currentUser) {
            const chatSkeleton = SkeletonManager.mount(
                chatContainer,
                () => SkeletonManager.templates.aiChat(3),
                { delay: 200, ariaLabel: "Loading chat conversation..." }
            );
            await loadSavedChatHistory(currentUser.uid);
            chatSkeleton.dismiss();
        } else {
            renderWelcomeMessage();
        }
    });
}`
        );

        writeWithSameEol(file, content, fs.readFileSync(file, 'utf8'));
        console.log('Successfully integrated SkeletonManager into www/js/ai-chat.js');
    }
}

// 9. PROFILE.JS
{
    const file = path.join(root, 'www/js/profile.js');
    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes('skeleton-manager.js')) {
        content = content.replace(
            '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";',
            '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );

        content = content.replace(
            `        // ====================================================
        // LOAD FIRESTORE PROFILE
        // ====================================================

        try {

            const userRef =
                doc(
                    db,
                    "users",
                    user.uid
                );


            const snapshot =
                await getDoc(userRef);`,
            `        // ====================================================
        // LOAD FIRESTORE PROFILE
        // ====================================================

        const profileCardEl = document.querySelector(".profile-card");
        const profileSkeleton = profileCardEl ? SkeletonManager.mount(
            profileCardEl,
            () => SkeletonManager.templates.profile(),
            { delay: 200, ariaLabel: "Loading user profile..." }
        ) : null;

        try {

            const userRef =
                doc(
                    db,
                    "users",
                    user.uid
                );


            const snapshot =
                await getDoc(userRef);`
        );

        content = content.replace(
            `            if (snapshot.exists()) {

                displayProfile(
                    user,
                    snapshot.data()
                );

            }`,
            `            profileSkeleton?.dismiss(() => {
                if (snapshot.exists()) {
                    displayProfile(
                        user,
                        snapshot.data()
                    );
                }
            });`
        );

        content = content.replace(
            `        } catch (error) {

            console.error(
                "Profile loading error:",
                error
            );`,
            `        } catch (error) {
            profileSkeleton?.cancel();
            console.error(
                "Profile loading error:",
                error
            );`
        );

        writeWithSameEol(file, content, fs.readFileSync(file, 'utf8'));
        console.log('Successfully integrated SkeletonManager into www/js/profile.js');
    }
}

// 10. EDIT-PROFILE.JS
{
    const file = path.join(root, 'www/js/edit-profile.js');
    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes('skeleton-manager.js')) {
        content = content.replace(
            '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";',
            '} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );

        content = content.replace(
            `        let name =
            user.displayName || "";


        try {

            const userRef =
                doc(
                    db,
                    "users",
                    user.uid
                );


            const snapshot =
                await getDoc(userRef);`,
            `        let name =
            user.displayName || "";

        const formCardEl = document.querySelector(".auth-card, .edit-profile-card, form#editProfileForm");
        const editSkeleton = formCardEl ? SkeletonManager.mount(
            formCardEl,
            () => SkeletonManager.templates.editProfile(),
            { delay: 200, ariaLabel: "Loading profile data..." }
        ) : null;

        try {

            const userRef =
                doc(
                    db,
                    "users",
                    user.uid
                );


            const snapshot =
                await getDoc(userRef);`
        );

        content = content.replace(
            `        // ----------------------------------------------------
        // DISPLAY
        // ----------------------------------------------------

        nameInput.value =
            name;


        updateAvatar(
            name,
            user.email
        );`,
            `        // ----------------------------------------------------
        // DISPLAY
        // ----------------------------------------------------

        editSkeleton?.dismiss(() => {
            nameInput.value = name;
            updateAvatar(name, user.email);
        });`
        );

        content = content.replace(
            `        } catch (error) {

            console.error(
                "Profile loading error:",
                error
            );`,
            `        } catch (error) {
            editSkeleton?.cancel();
            console.error(
                "Profile loading error:",
                error
            );`
        );

        writeWithSameEol(file, content, fs.readFileSync(file, 'utf8'));
        console.log('Successfully integrated SkeletonManager into www/js/edit-profile.js');
    }
}
