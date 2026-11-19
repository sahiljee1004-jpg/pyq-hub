import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

// 1. Fix home.js
{
    const file = path.join(root, 'www/js/home.js');
    let content = fs.readFileSync(file, 'utf8');
    const isCRLF = content.includes('\r\n');
    const norm = content.replace(/\r\n/g, '\n');

    let updated = norm;

    // Ensure import is present
    if (!updated.includes('import { SkeletonManager }')) {
        updated = updated.replace(
            'import { openChatGPT } from "./chatgpt-helper.js";',
            'import { openChatGPT } from "./chatgpt-helper.js";\nimport { SkeletonManager } from "./skeleton-manager.js";'
        );
    }

    // Replace examGrid.innerHTML = `<div class="loading">...</div>`;
    const oldLoading = `        examGrid.innerHTML = \`
            <div class="loading">
                Loading exams...
            </div>
        \`;`;

    const newLoading = `        const skeletonHandle = SkeletonManager.mount(
            examGrid,
            () => SkeletonManager.templates.dashboardExams(6),
            { delay: 200, ariaLabel: "Loading available examinations..." }
        );`;

    updated = updated.replace(oldLoading, newLoading);

    // Replace updateExamCount and displayExams
    const oldDisplay = `        updateExamCount(
            allExams.length
        );


        displayExams(
            allExams
        );`;

    const newDisplay = `        skeletonHandle.dismiss(() => {
            updateExamCount(allExams.length);
            displayExams(allExams);
        });`;

    updated = updated.replace(oldDisplay, newDisplay);

    const finalContent = isCRLF ? updated.replace(/\n/g, '\r\n') : updated;
    fs.writeFileSync(file, finalContent, 'utf8');
    console.log('Fixed www/js/home.js');
}

// 2. Fix mock-test.js
{
    const file = path.join(root, 'www/js/mock-test.js');
    let content = fs.readFileSync(file, 'utf8');
    const isCRLF = content.includes('\r\n');
    const norm = content.replace(/\r\n/g, '\n');

    let updated = norm;

    // Target the duplicated section in startTestSession
    const duplicateTarget = `        // Setup UI
        activeTestTitle.textContent = activeTest.title;
        activeTestMeta.textContent = \`\${(activeTest.examName || activeTest.examId || "").toUpperCase()} | Language: \${activeAttempt.language || language} | \${questions.length} Questions | Max Marks: \${activeTest.maximumMarks}\`;

        currentSection = "all";
        renderSectionTabs();
        renderPalette();
        renderQuestion(currentIndex);
        startTimer(activeAttempt.deadlineAt);

        testSessionSkeleton.dismiss(() => {`;

    const cleanReplacement = `        testSessionSkeleton.dismiss(() => {`;

    updated = updated.replace(duplicateTarget, cleanReplacement);

    const finalContent = isCRLF ? updated.replace(/\n/g, '\r\n') : updated;
    fs.writeFileSync(file, finalContent, 'utf8');
    console.log('Fixed www/js/mock-test.js');
}

// 3. Fix MockElement in tests/student-skeleton-system.test.js
{
    const file = path.join(root, 'tests/student-skeleton-system.test.js');
    let content = fs.readFileSync(file, 'utf8');
    const isCRLF = content.includes('\r\n');
    const norm = content.replace(/\r\n/g, '\n');

    const oldMockClass = `class MockElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.attributes = new Map();
        this.classList = new Set();
        this.classList.add = (c) => this.classList.add(c);
        this.classList.remove = (c) => this.classList.delete(c);
        this.classList.contains = (c) => this.classList.has(c);
        this.innerHTML = '';
        this.style = {};
    }`;

    const newMockClass = `class MockElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.attributes = new Map();
        const classes = new Set();
        this.classList = {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c)
        };
        this.innerHTML = '';
        this.style = {};
    }`;

    const updated = norm.replace(oldMockClass, newMockClass);
    const finalContent = isCRLF ? updated.replace(/\n/g, '\r\n') : updated;
    fs.writeFileSync(file, finalContent, 'utf8');
    console.log('Fixed tests/student-skeleton-system.test.js');
}
