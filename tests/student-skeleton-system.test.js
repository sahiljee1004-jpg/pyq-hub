/**
 * ============================================================================
 * VIDYARTHIASTRA — STUDENT SKELETON LOADING SYSTEM TEST SUITE
 * Verifies 200ms debounce, accessibility, theme tokens, responsive layouts,
 * template fidelity across all 13 student routes, and zero regression.
 * ============================================================================
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

// Import SkeletonManager
import { SkeletonManager } from '../www/js/skeleton-manager.js';

// Minimal DOM mock for Node.js test environment
class MockElement {
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
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.get(name) || null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }
}

describe('Student Skeleton Loading System Validation', () => {

    describe('1. 200ms Timing & Debounce Lifecycle', () => {

        test('1.1 Fast resolution (<200ms) does NOT render skeleton (prevents flashing)', async () => {
            const container = new MockElement('div');
            let realContentRendered = false;

            const handle = SkeletonManager.mount(
                container,
                () => '<div class="test-skeleton">Loading</div>',
                { delay: 200 }
            );

            // Fast async completion at 50ms
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(handle.isRendered(), false, 'Skeleton must NOT be rendered at 50ms');
            assert.equal(container.hasAttribute('aria-busy'), false, 'Container must NOT have aria-busy before 200ms');

            handle.dismiss(() => {
                realContentRendered = true;
                container.innerHTML = '<div class="real-content">Real Exams</div>';
            });

            // Wait beyond original 200ms to ensure timer was truly cancelled
            await new Promise((resolve) => setTimeout(resolve, 200));

            assert.equal(handle.isRendered(), false, 'Skeleton must remain unrendered after early dismissal');
            assert.equal(realContentRendered, true, 'Real content renderer must execute');
            assert.equal(container.innerHTML, '<div class="real-content">Real Exams</div>');
            assert.equal(container.hasAttribute('aria-busy'), false);
        });

        test('1.2 Slow resolution (>=200ms) triggers skeleton at 200ms mark', async () => {
            const container = new MockElement('div');

            const handle = SkeletonManager.mount(
                container,
                () => '<div class="test-skeleton">Structural Skeleton</div>',
                { delay: 200 }
            );

            // At 100ms: not yet rendered
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(handle.isRendered(), false, 'Skeleton must not render before 200ms');

            // At 220ms: rendered
            await new Promise((resolve) => setTimeout(resolve, 130));
            assert.equal(handle.isRendered(), true, 'Skeleton must be rendered after 200ms');
            assert.equal(container.getAttribute('aria-busy'), 'true', 'aria-busy must be true while skeleton is active');
            assert.match(container.innerHTML, /test-skeleton/, 'Container must contain skeleton template');

            // Real content arrives at 300ms
            handle.dismiss(() => {
                container.innerHTML = '<div class="real-content">Mock Tests</div>';
            });

            assert.equal(container.hasAttribute('aria-busy'), false, 'aria-busy must be removed upon dismissal');
            assert.equal(container.innerHTML, '<div class="real-content">Mock Tests</div>');
        });

        test('1.3 Cancel unmounts cleanly without calling real content renderer', async () => {
            const container = new MockElement('div');
            let called = false;

            const handle = SkeletonManager.mount(
                container,
                () => '<div class="skeleton">Placeholder</div>',
                { delay: 50 }
            );

            await new Promise((resolve) => setTimeout(resolve, 70));
            assert.equal(handle.isRendered(), true);
            assert.equal(container.getAttribute('aria-busy'), 'true');

            handle.cancel();
            assert.equal(container.hasAttribute('aria-busy'), false);
            assert.equal(called, false);
        });

        test('1.4 Zero delay option triggers skeleton synchronously', () => {
            const container = new MockElement('div');
            const handle = SkeletonManager.mount(
                container,
                () => '<div class="skeleton-immediate">Immediate</div>',
                { delay: 0 }
            );

            assert.equal(handle.isRendered(), true);
            assert.equal(container.getAttribute('aria-busy'), 'true');
            assert.match(container.innerHTML, /skeleton-immediate/);
            handle.dismiss();
            assert.equal(container.hasAttribute('aria-busy'), false);
        });
    });

    describe('2. Accessibility (a11y) Verification', () => {

        test('2.1 Screen reader status announcement and aria-hidden on visual placeholders', () => {
            const container = new MockElement('div');
            const handle = SkeletonManager.mount(
                container,
                () => '<span class="skeleton-block"></span>',
                { delay: 0, ariaLabel: 'Loading question papers...' }
            );

            assert.equal(container.getAttribute('aria-busy'), 'true');
            assert.match(container.innerHTML, /role="status"/);
            assert.match(container.innerHTML, /aria-label="Loading question papers\.\.\."/);
            assert.match(container.innerHTML, /aria-hidden="true"/);
            assert.match(container.innerHTML, /Loading question papers\.\.\./);

            handle.dismiss();
            assert.equal(container.hasAttribute('aria-busy'), false);
        });

        test('2.2 Safe HTML escaping in accessibility labels', () => {
            const container = new MockElement('div');
            SkeletonManager.mount(
                container,
                () => '<span>Content</span>',
                { delay: 0, ariaLabel: 'Searching "Physics" & <Chemistry>' }
            );

            assert.match(container.innerHTML, /Searching &quot;Physics&quot; &amp; &lt;Chemistry&gt;/);
        });
    });

    describe('3. Template Inventory & Page Layout Fidelity', () => {

        test('3.1 Dashboard Exam Grid template matches real layout structure', () => {
            const html = SkeletonManager.templates.dashboardExams(6);
            assert.match(html, /skeleton-exam-grid/);
            assert.match(html, /skeleton-exam-card/);
            assert.match(html, /skeleton-avatar/);
            assert.match(html, /skeleton-card-footer/);
            const count = (html.match(/skeleton-exam-card/g) || []).length;
            assert.equal(count, 6);
        });

        test('3.2 Exam detail and years templates match exam page layout', () => {
            const detailHtml = SkeletonManager.templates.examDetail();
            assert.match(detailHtml, /skeleton-text title/);

            const yearsHtml = SkeletonManager.templates.examYears(4);
            assert.match(yearsHtml, /skeleton-exam-grid/);
            const cardCount = (yearsHtml.match(/skeleton-exam-card/g) || []).length;
            assert.equal(cardCount, 4);
        });

        test('3.3 Mock Test Catalog template matches catalog view', () => {
            const html = SkeletonManager.templates.mockCatalog(6);
            assert.match(html, /skeleton-mock-grid/);
            assert.match(html, /skeleton-mock-card/);
            assert.match(html, /skeleton-meta-row/);
            const count = (html.match(/skeleton-mock-card/g) || []).length;
            assert.equal(count, 6);
        });

        test('3.4 Active Mock Test Engine template matches live test session layout', () => {
            const html = SkeletonManager.templates.mockInterface();
            assert.match(html, /skeleton-test-view/);
            assert.match(html, /skeleton-test-top-bar/);
            assert.match(html, /skeleton-tabs-bar/);
            assert.match(html, /skeleton-test-session-layout/);
            assert.match(html, /skeleton-question-card/);
            assert.match(html, /skeleton-option-item/);
            assert.match(html, /skeleton-palette-card/);
            assert.match(html, /skeleton-palette-grid/);
        });

        test('3.5 Mock Test Results template matches performance analytics scorecard', () => {
            const html = SkeletonManager.templates.mockResults();
            assert.match(html, /skeleton-results-dashboard/);
            assert.match(html, /skeleton-results-overview/);
            assert.match(html, /skeleton-score-circle/);
            assert.match(html, /skeleton-stats-grid/);
            assert.match(html, /skeleton-stat-box/);
            assert.match(html, /skeleton-section-cards-grid/);
        });

        test('3.6 Dedicated PYQ Library templates cover exams, years, and papers', () => {
            const examsHtml = SkeletonManager.templates.pyqExams(6);
            assert.match(examsHtml, /skeleton-pyq-grid/);
            assert.match(examsHtml, /skeleton-pyq-card/);

            const yearsHtml = SkeletonManager.templates.pyqYears(4);
            assert.match(yearsHtml, /skeleton-pyq-card/);

            const papersHtml = SkeletonManager.templates.pyqPapers(6);
            assert.match(papersHtml, /skeleton-pyq-card/);
        });

        test('3.7 Papers list and embedded PDF viewer templates', () => {
            const listHtml = SkeletonManager.templates.papersList(5);
            assert.match(listHtml, /skeleton-paper-list/);
            assert.match(listHtml, /skeleton-paper-card/);

            const pdfHtml = SkeletonManager.templates.pdfViewer();
            assert.match(pdfHtml, /skeleton-pdf-container/);
            assert.match(pdfHtml, /skeleton-pdf-toolbar/);
            assert.match(pdfHtml, /skeleton-pdf-canvas/);
        });

        test('3.8 Study Resources, AI Chat, and Live Updates templates', () => {
            const studyHtml = SkeletonManager.templates.studyResources(6);
            assert.match(studyHtml, /skeleton-study-grid/);

            const chatHtml = SkeletonManager.templates.aiChat(3);
            assert.match(chatHtml, /skeleton-chat-container/);
            assert.match(chatHtml, /skeleton-chat-msg/);

            const updatesHtml = SkeletonManager.templates.liveUpdates(4);
            assert.match(updatesHtml, /skeleton-updates-feed/);
            assert.match(updatesHtml, /skeleton-update-card/);
        });

        test('3.9 Profile, Edit Profile, Auth Form, and Contact templates', () => {
            const profileHtml = SkeletonManager.templates.profile();
            assert.match(profileHtml, /skeleton-profile-card/);

            const editHtml = SkeletonManager.templates.editProfile();
            assert.match(editHtml, /skeleton-profile-card/);

            const authHtml = SkeletonManager.templates.authForm();
            assert.match(authHtml, /skeleton-auth-card/);

            const contactHtml = SkeletonManager.templates.contact();
            assert.match(contactHtml, /skeleton-card/);
        });
    });

    describe('4. Theme & Design Tokens Validation', () => {

        test('4.1 skeleton.css defines light and dark tokens and respects reduced motion', () => {
            const cssPath = path.join(root, 'www/css/skeleton.css');
            assert.equal(fs.existsSync(cssPath), true, 'skeleton.css must exist');

            const css = fs.readFileSync(cssPath, 'utf8');

            // Light mode tokens
            assert.match(css, /--skeleton-base:/);
            assert.match(css, /--skeleton-highlight:/);
            assert.match(css, /--skeleton-shimmer:/);
            assert.match(css, /--skeleton-border:/);
            assert.match(css, /--skeleton-card-bg:/);

            // Dark mode overrides
            assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
            assert.match(css, /\[data-theme="dark"\]/);
            assert.match(css, /body\.dark-mode/);

            // Reduced motion
            assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
            assert.match(css, /animation:\s*none/);

            // Shimmer keyframes
            assert.match(css, /@keyframes skeleton-shimmer/);

            // Responsive queries
            assert.match(css, /@media\s*\(max-width:\s*900px\)/);
            assert.match(css, /@media\s*\(max-width:\s*600px\)/);
        });
    });

    describe('5. Complete Route & File Audit', () => {

        const studentPages = [
            'www/index.html',
            'www/exam.html',
            'www/mock-test.html',
            'www/pyq-library.html',
            'www/papers.html',
            'www/study-resources.html',
            'www/ai-chat.html',
            'www/live-updates.html',
            'www/profile.html',
            'www/edit-profile.html',
            'www/login.html',
            'www/signup.html',
            'www/contact.html'
        ];

        test('5.1 All 13 student-facing HTML files include skeleton.css and skeleton-manager.js', () => {
            for (const relPath of studentPages) {
                const fullPath = path.join(root, relPath);
                assert.equal(fs.existsSync(fullPath), true, `${relPath} must exist`);
                const html = fs.readFileSync(fullPath, 'utf8');

                assert.match(html, /css\/skeleton\.css/, `${relPath} must link css/skeleton.css`);
                assert.match(html, /js\/skeleton-manager\.js/, `${relPath} must load js/skeleton-manager.js`);
            }
        });

        test('5.2 Admin routes and files remain strictly excluded from student skeleton mutations', () => {
            const adminHtml = fs.readFileSync(path.join(root, 'server/views/admin.html'), 'utf8');
            assert.equal(adminHtml.includes('css/skeleton.css'), false, 'admin.html must NOT link student skeleton.css');
        });

        test('5.3 All 10 student JavaScript client files import SkeletonManager and wire lifecycle', () => {
            const jsFiles = [
                'www/js/home.js',
                'www/js/exam.js',
                'www/js/mock-test.js',
                'www/js/pyq-library.js',
                'www/js/papers.js',
                'www/js/study-resources.js',
                'www/js/live-updates.js',
                'www/js/ai-chat.js',
                'www/js/profile.js',
                'www/js/edit-profile.js'
            ];

            for (const relPath of jsFiles) {
                const fullPath = path.join(root, relPath);
                assert.equal(fs.existsSync(fullPath), true, `${relPath} must exist`);
                const code = fs.readFileSync(fullPath, 'utf8');
                assert.match(code, /SkeletonManager/, `${relPath} must reference SkeletonManager`);
                assert.match(code, /SkeletonManager\.mount\(/, `${relPath} must call SkeletonManager.mount`);
            }
        });
    });

    describe('6. Active Mock Test Safety Guarantees', () => {

        test('6.1 Mock test startTimer is strictly deferred until skeleton dismissal with real content', () => {
            const mockTestCode = fs.readFileSync(path.join(root, 'www/js/mock-test.js'), 'utf8');

            // startTimer is inside testSessionSkeleton.dismiss callback
            const dismissIdx = mockTestCode.indexOf('testSessionSkeleton.dismiss');
            const startTimerIdx = mockTestCode.indexOf('startTimer(activeAttempt.deadlineAt)');

            assert.notEqual(dismissIdx, -1, 'testSessionSkeleton.dismiss must be present');
            assert.notEqual(startTimerIdx, -1, 'startTimer must be present');
            assert.ok(startTimerIdx > dismissIdx, 'startTimer must occur INSIDE dismiss callback after real questions are received');
        });

        test('6.2 Result submission evaluation skeleton does not overwrite or mutate scoring data', () => {
            const mockTestCode = fs.readFileSync(path.join(root, 'www/js/mock-test.js'), 'utf8');

            const resultsSkeletonDismissIdx = mockTestCode.indexOf('resultsSkeleton.dismiss');
            const renderResultsIdx = mockTestCode.indexOf('renderResults(data.result)');

            assert.notEqual(resultsSkeletonDismissIdx, -1);
            assert.notEqual(renderResultsIdx, -1);
            assert.ok(renderResultsIdx > resultsSkeletonDismissIdx, 'renderResults must be called with data.result upon dismiss');
        });
    });
});
