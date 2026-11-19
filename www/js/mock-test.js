import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { showAuthModal } from "./auth.js";
import { SkeletonManager } from "./skeleton-manager.js";
import { fetchUserSessionRole } from "./header.js";
import { getApiUrl } from "./api-config.js";

// State Management
let currentUser = null;
let publishedTests = [];
let activeTest = null;
let activeAttempt = null;
let questions = [];
let currentIndex = 0;
let answers = {};
let markedForReview = new Set();
let timerInterval = null;
let autosaveTimeout = null;

// DOM Elements
const catalogView = document.getElementById("catalogView");
const testView = document.getElementById("testView");
const resultView = document.getElementById("resultView");
const submitModal = document.getElementById("submitModal");
const languageModal = document.getElementById("languageModal");
const sessionExpiryModal = document.getElementById("sessionExpiryModal");
const languageOptionsContainer = document.getElementById("languageOptionsContainer");
const langModalBtnCancel = document.getElementById("langModalBtnCancel");
const langModalBtnConfirm = document.getElementById("langModalBtnConfirm");
const btnResumeSession = document.getElementById("btnResumeSession");
let pendingTestId = null;

const catalogLoading = document.getElementById("catalogLoading");
const catalogEmpty = document.getElementById("catalogEmpty");
const testGrid = document.getElementById("testGrid");

const catalogToolbar = document.getElementById("catalogToolbar");
const mockSearchInput = document.getElementById("mockSearchInput");
const mockSearchClearBtn = document.getElementById("mockSearchClearBtn");
const mockYearSortSelect = document.getElementById("mockYearSortSelect");
const mockCatalogStatsBar = document.getElementById("mockCatalogStatsBar");
const mockResultsCount = document.getElementById("mockResultsCount");
const mockResetFiltersBtn = document.getElementById("mockResetFiltersBtn");
const catalogNoResults = document.getElementById("catalogNoResults");
const btnClearSearchNoResults = document.getElementById("btnClearSearchNoResults");
const mockNoResultsText = document.getElementById("mockNoResultsText");

// Catalog Search & Year Sort State
let currentSearchQuery = "";
let currentYearSort = "default";

// Dynamic Test View Element Resolution (prevents DOM element detachment when skeletons mount/unmount)
function getTestDOM() {
    return {
        // Views
        catalogView: document.getElementById("catalogView"),
        testView: document.getElementById("testView"),
        resultView: document.getElementById("resultView"),
        reviewView: document.getElementById("reviewView"),

        // Active Test Session Elements
        activeTestTitle: document.getElementById("activeTestTitle"),
        activeTestMeta: document.getElementById("activeTestMeta"),
        timerText: document.getElementById("timerText"),
        timerDisplay: document.getElementById("timerDisplay"),
        qNumberBadge: document.getElementById("qNumberBadge"),
        qSubjectBadge: document.getElementById("qSubjectBadge"),
        qSectionBadge: document.getElementById("qSectionBadge"),
        qTypeBadge: document.getElementById("qTypeBadge"),
        qMarksInfo: document.getElementById("qMarksInfo"),
        qPassageBox: document.getElementById("qPassageBox"),
        qText: document.getElementById("qText"),
        qStatementsBox: document.getElementById("qStatementsBox"),
        qTablesBox: document.getElementById("qTablesBox"),
        optionsContainer: document.getElementById("optionsContainer"),
        paletteGrid: document.getElementById("paletteGrid"),
        btnPrev: document.getElementById("btnPrev"),
        btnNext: document.getElementById("btnNext"),
        btnClearChoice: document.getElementById("btnClearChoice"),
        btnMarkReview: document.getElementById("btnMarkReview"),
        btnTopSubmit: document.getElementById("btnTopSubmit"),
        sectionTabsBar: document.getElementById("sectionTabsBar"),

        // Submission Modal Elements
        submitModal: document.getElementById("submitModal"),
        modalAnsweredCount: document.getElementById("modalAnsweredCount"),
        modalReviewCount: document.getElementById("modalReviewCount"),
        modalUnansweredCount: document.getElementById("modalUnansweredCount"),
        modalBtnCancel: document.getElementById("modalBtnCancel"),
        modalBtnConfirm: document.getElementById("modalBtnConfirm"),

        // Result View Required Elements
        resTotalScore: document.getElementById("resTotalScore"),
        resMaxScore: document.getElementById("resMaxScore"),
        resPercentage: document.getElementById("resPercentage"),
        resAccuracy: document.getElementById("resAccuracy"),
        resTotalQuestions: document.getElementById("resTotalQuestions"),
        resCorrect: document.getElementById("resCorrect"),
        resIncorrect: document.getElementById("resIncorrect"),
        resUnanswered: document.getElementById("resUnanswered"),
        subjectCardsGrid: document.getElementById("subjectCardsGrid"),
        subjectPerformanceChart: document.getElementById("subjectPerformanceChart"),
        btnReviewExam: document.getElementById("btnReviewExam"),
        btnReturnCatalog: document.getElementById("btnReturnCatalog"),

        // Result View Optional / Conditional Elements
        resDroppedBox: document.getElementById("resDroppedBox"),
        resDropped: document.getElementById("resDropped"),
        resTimeTaken: document.getElementById("resTimeTaken"),
        resPendingReviewBanner: document.getElementById("resPendingReviewBanner"),
        resPendingNotice: document.getElementById("resPendingNotice"),
        resLegacyNotice: document.getElementById("resLegacyNotice"),
        resLegacyNoticeText: document.getElementById("resLegacyNoticeText"),
        sectionAnalysisSection: document.getElementById("sectionAnalysisSection"),
        sectionCardsGrid: document.getElementById("sectionCardsGrid"),

        // Review View Elements
        reviewExamTitle: document.getElementById("reviewExamTitle"),
        revSummaryTotal: document.getElementById("revSummaryTotal"),
        revSummaryCorrect: document.getElementById("revSummaryCorrect"),
        revSummaryIncorrect: document.getElementById("revSummaryIncorrect"),
        revSummaryUnattempted: document.getElementById("revSummaryUnattempted"),
        revSummaryDroppedPill: document.getElementById("revSummaryDroppedPill"),
        revSummaryDropped: document.getElementById("revSummaryDropped"),
        revLegendDropped: document.getElementById("revLegendDropped"),
        reviewSubjectFilters: document.getElementById("reviewSubjectFilters"),
        reviewStatusFilters: document.getElementById("reviewStatusFilters"),
        revPaletteGrid: document.getElementById("revPaletteGrid"),
        revQNumberBadge: document.getElementById("revQNumberBadge"),
        revQSubjectBadge: document.getElementById("revQSubjectBadge"),
        revQStatusBadge: document.getElementById("revQStatusBadge"),
        revQMarksBadge: document.getElementById("revQMarksBadge"),
        revQText: document.getElementById("revQText"),
        revDiagramBox: document.getElementById("revDiagramBox"),
        revSourcePageNum: document.getElementById("revSourcePageNum"),
        revOptionsContainer: document.getElementById("revOptionsContainer"),
        revNumericalDisplay: document.getElementById("revNumericalDisplay"),
        revNumericalValue: document.getElementById("revNumericalValue"),
        revDroppedBox: document.getElementById("revDroppedBox"),
        revCorrectAnswerBox: document.getElementById("revCorrectAnswerBox"),
        revCorrectAnswerText: document.getElementById("revCorrectAnswerText"),
        revCurrentStatusIndicator: document.getElementById("revCurrentStatusIndicator"),
        btnRevPrev: document.getElementById("btnRevPrev"),
        btnRevNext: document.getElementById("btnRevNext"),
        btnBackToAnalysis: document.getElementById("btnBackToAnalysis"),
        btnExitReview: document.getElementById("btnExitReview")
    };
}

// Snapshot initial DOM templates before any skeleton or error modifications
const testViewInitialHTML = testView ? testView.innerHTML : "";
const resultViewInitialHTML = resultView ? resultView.innerHTML : "";
const reviewViewInitialHTML = document.getElementById("reviewView") ? document.getElementById("reviewView").innerHTML : "";

// Phase 5.10 / Phase 5.11 Development Diagnostics Logger
const isDev = typeof window !== "undefined" && (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.protocol === "file:"
);
function logDiag(stage, data = {}) {
    if (!isDev) return;
    try {
        console.log(`[MOCK-TEST-DIAGNOSTICS] [${stage}]`, data);
    } catch (_) { }
}

// Bind interactive session controls to active DOM elements
function bindSessionControls() {
    const dom = getTestDOM();
    if (dom.btnPrev) {
        dom.btnPrev.onclick = () => {
            if (currentIndex > 0) renderQuestion(currentIndex - 1);
        };
    }
    if (dom.btnNext) {
        dom.btnNext.onclick = () => {
            scheduleAutosave();
            if (currentIndex < questions.length - 1) {
                renderQuestion(currentIndex + 1);
            } else {
                openSubmitModal();
            }
        };
    }
    if (dom.btnClearChoice) dom.btnClearChoice.onclick = clearChoice;
    if (dom.btnMarkReview) dom.btnMarkReview.onclick = toggleReview;
    if (dom.btnTopSubmit) dom.btnTopSubmit.onclick = openSubmitModal;
    if (dom.modalBtnCancel) dom.modalBtnCancel.onclick = closeSubmitModal;
    if (dom.modalBtnConfirm) dom.modalBtnConfirm.onclick = executeSubmission;
}

// Restore pristine testView DOM structure and rebind event listeners
function restoreTestViewTemplate() {
    const tv = document.getElementById("testView");
    if (tv && testViewInitialHTML) {
        tv.innerHTML = testViewInitialHTML;
        bindSessionControls();
    }
}

// Bind result screen controls to live DOM elements
function bindResultControls() {
    const dom = getTestDOM();
    if (dom.btnReviewExam) {
        dom.btnReviewExam.onclick = () => {
            const attemptId = lastResult?.attemptId || activeAttempt?.attemptId;
            if (attemptId) {
                openReviewExam(attemptId);
            } else {
                alert("No attempt ID found for review.");
            }
        };
    }
    if (dom.btnReturnCatalog) {
        dom.btnReturnCatalog.onclick = () => {
            const curDom = getTestDOM();
            if (curDom.resultView) curDom.resultView.style.display = "none";
            if (curDom.testView) curDom.testView.style.display = "none";
            if (curDom.reviewView) curDom.reviewView.style.display = "none";
            if (curDom.catalogView) curDom.catalogView.style.display = "block";
            loadCatalog();
        };
    }
}

// Restore pristine resultView DOM structure and rebind event listeners
function restoreResultViewTemplate() {
    const rv = document.getElementById("resultView");
    if (rv && resultViewInitialHTML) {
        rv.innerHTML = resultViewInitialHTML;
        bindResultControls();
    }
}

// Bind review mode controls to live DOM elements
function bindReviewControls() {
    const dom = getTestDOM();
    if (dom.btnBackToAnalysis) {
        dom.btnBackToAnalysis.onclick = () => {
            const curDom = getTestDOM();
            if (curDom.reviewView) curDom.reviewView.style.display = "none";
            if (curDom.resultView) curDom.resultView.style.display = "block";
            window.scrollTo({ top: 0, behavior: "smooth" });
        };
    }
    if (dom.btnExitReview) {
        dom.btnExitReview.onclick = () => {
            const curDom = getTestDOM();
            if (curDom.reviewView) curDom.reviewView.style.display = "none";
            if (curDom.resultView) curDom.resultView.style.display = "none";
            if (curDom.testView) curDom.testView.style.display = "none";
            if (curDom.catalogView) curDom.catalogView.style.display = "block";
            loadCatalog();
        };
    }
    if (dom.btnRevPrev) {
        dom.btnRevPrev.onclick = () => {
            if (currentReviewIndex > 0 && filteredReviewQuestions.length > 0) {
                renderReviewQuestion(currentReviewIndex - 1);
            }
        };
    }
    if (dom.btnRevNext) {
        dom.btnRevNext.onclick = () => {
            if (currentReviewIndex < filteredReviewQuestions.length - 1) {
                renderReviewQuestion(currentReviewIndex + 1);
            }
        };
    }

    // Bind Status Filter Buttons (delegated container click + direct button click)
    const statusContainer = dom.reviewStatusFilters || document.getElementById("reviewStatusFilters");
    if (statusContainer) {
        statusContainer.onclick = (e) => {
            const btn = e.target.closest(".filter-btn");
            if (!btn || !statusContainer.contains(btn)) return;
            const status = btn.getAttribute("data-status");
            if (status) {
                setReviewStatusFilter(status);
            }
        };

        const statusBtns = statusContainer.querySelectorAll(".filter-btn");
        statusBtns.forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const status = btn.getAttribute("data-status");
                if (status) {
                    setReviewStatusFilter(status);
                }
            };
        });
    }
}

// Restore pristine reviewView DOM structure and rebind event listeners
function restoreReviewViewTemplate() {
    const rev = document.getElementById("reviewView");
    if (rev && reviewViewInitialHTML) {
        rev.innerHTML = reviewViewInitialHTML;
        bindReviewControls();
    }
}

const resPendingReviewBanner = document.getElementById("resPendingReviewBanner");
const sectionAnalysisSection = document.getElementById("sectionAnalysisSection");
const sectionCardsGrid = document.getElementById("sectionCardsGrid");
let currentSection = "all";

// Helper: Escape HTML
function escapeHTML(str) {
    if (str == null) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Helper: Get authenticated Firebase ID token
async function getAuthToken(forceRefresh = false) {
    if (!auth.currentUser) return null;
    try {
        return await auth.currentUser.getIdToken(forceRefresh);
    } catch (err) {
        console.warn("[MockTest] Token retrieval failed:", err.message);
        return null;
    }
}

// Session Expiry Modal Helpers
function showSessionExpiryPrompt() {
    if (sessionExpiryModal) {
        sessionExpiryModal.style.display = "flex";
    }
}

function hideSessionExpiryPrompt() {
    if (sessionExpiryModal) {
        sessionExpiryModal.style.display = "none";
    }
}

// Wire Language Modal Controls
langModalBtnCancel?.addEventListener("click", () => {
    if (languageModal) languageModal.style.display = "none";
    pendingTestId = null;
});

langModalBtnConfirm?.addEventListener("click", () => {
    const selectedRadio = document.querySelector('input[name="testLanguageChoice"]:checked');
    const selectedLanguage = selectedRadio ? selectedRadio.value : "English";
    if (languageModal) languageModal.style.display = "none";
    if (pendingTestId) {
        startTestSession(pendingTestId, selectedLanguage);
    }
});

// Wire Session Expiry Resume Action
btnResumeSession?.addEventListener("click", () => {
    showAuthModal({
        title: "Sign in to Resume Test",
        message: "Your saved progress is preserved on the server. Please sign in to resume your active test session without losing answers."
    });
});

// -------------------------------------------------------------
// 1. Catalog Loading, Search, Year Sorting & Rendering
// -------------------------------------------------------------

function extractNumericYear(val) {
    if (val === null || val === undefined || val === "") return null;
    const num = Number(val);
    if (!isNaN(num) && num > 1900 && num < 2100) return Math.floor(num);
    const match = String(val).match(/\b(19\d\d|20\d\d)\b/);
    if (match) return parseInt(match[1], 10);
    return null;
}

function compareTestsByYear(a, b, sortDirection = "desc") {
    const yearA = extractNumericYear(a.year) ?? extractNumericYear(a.title);
    const yearB = extractNumericYear(b.year) ?? extractNumericYear(b.title);

    const hasA = yearA !== null;
    const hasB = yearB !== null;

    if (hasA && !hasB) return -1;
    if (!hasA && hasB) return 1;
    if (hasA && hasB && yearA !== yearB) {
        return sortDirection === "asc" ? yearA - yearB : yearB - yearA;
    }

    // Secondary stable ordering: examName, shift, paperCode, title, testId
    const examCmp = String(a.examName || a.examId || "").localeCompare(String(b.examName || b.examId || ""));
    if (examCmp !== 0) return examCmp;

    const shiftCmp = String(a.shift || "").localeCompare(String(b.shift || ""));
    if (shiftCmp !== 0) return shiftCmp;

    const paperCmp = String(a.paperCode || "").localeCompare(String(b.paperCode || ""));
    if (paperCmp !== 0) return paperCmp;

    const titleCmp = String(a.title || "").localeCompare(String(b.title || ""));
    if (titleCmp !== 0) return titleCmp;

    return String(a.testId || "").localeCompare(String(b.testId || ""));
}

function matchesSearch(test, query) {
    if (!query || typeof query !== "string" || !query.trim()) return true;
    const trimmed = query.trim().toLowerCase();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;

    // Searchable metadata: examName, examId, title, paperCode, shift, year
    const searchableFields = [
        test.title,
        test.examName,
        test.examId,
        test.paperCode,
        test.shift,
        test.year != null ? String(test.year) : ""
    ].filter(Boolean);

    const haystack = searchableFields.join(" ").toLowerCase();

    // Direct phrase match optimization (e.g. "shift 2" or "jee main")
    if (haystack.includes(trimmed)) {
        return true;
    }

    // Tokenized multi-term match
    return tokens.every(token => {
        // If token is a short number (e.g. "1", "2"), enforce word boundary so it doesn't match digits in 2026 or 10800
        if (/^\d{1,2}$/.test(token)) {
            const regex = new RegExp(`(?:^|[^0-9a-zA-Z])${token}(?:$|[^0-9a-zA-Z])`, "i");
            return regex.test(haystack);
        }
        return haystack.includes(token);
    });
}

function getFilteredAndSortedCatalog() {
    const filtered = currentSearchQuery
        ? publishedTests.filter(t => matchesSearch(t, currentSearchQuery))
        : [...publishedTests];

    const sortDir = currentYearSort === "asc" ? "asc" : "desc";
    filtered.sort((a, b) => compareTestsByYear(a, b, sortDir));
    return filtered;
}

function applyCatalogFilters() {
    if (!publishedTests || publishedTests.length === 0) {
        if (catalogToolbar) catalogToolbar.style.display = "none";
        if (mockCatalogStatsBar) mockCatalogStatsBar.style.display = "none";
        if (testGrid) testGrid.style.display = "none";
        if (catalogNoResults) catalogNoResults.style.display = "none";
        if (catalogEmpty) catalogEmpty.style.display = "block";
        return;
    }

    if (catalogToolbar) catalogToolbar.style.display = "flex";
    if (catalogEmpty) catalogEmpty.style.display = "none";

    const filtered = getFilteredAndSortedCatalog();

    if (mockSearchClearBtn) {
        mockSearchClearBtn.style.display = currentSearchQuery ? "inline-flex" : "none";
    }

    if (mockCatalogStatsBar) {
        mockCatalogStatsBar.style.display = "flex";
        if (mockResultsCount) {
            const count = filtered.length;
            const total = publishedTests.length;
            if (currentSearchQuery) {
                mockResultsCount.textContent = `Showing ${count} of ${total} mock test${total === 1 ? "" : "s"} matching "${currentSearchQuery}"`;
            } else {
                mockResultsCount.textContent = `Showing ${count} mock test${count === 1 ? "" : "s"}`;
            }
        }
        if (mockResetFiltersBtn) {
            const hasActiveFilters = Boolean(currentSearchQuery) || currentYearSort !== "default";
            mockResetFiltersBtn.style.display = hasActiveFilters ? "inline-block" : "none";
        }
    }

    if (filtered.length === 0) {
        if (testGrid) testGrid.style.display = "none";
        if (catalogNoResults) {
            catalogNoResults.style.display = "block";
            const noResultsText = document.getElementById("mockNoResultsText");
            if (noResultsText) {
                noResultsText.textContent = `No published mock tests match "${currentSearchQuery}". Try checking for typos or searching for a broader term like "JEE Main", "NEET", or a specific year.`;
            }
        }
    } else {
        if (catalogNoResults) catalogNoResults.style.display = "none";
        renderCatalogCards(filtered);
    }
}

async function loadCatalog() {
    let catalogSkeleton = null;
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

        const res = await fetch(getApiUrl("/api/mock-tests"));
        if (!res.ok) {
            let errData = null;
            try { errData = await res.json(); } catch (e) {}
            const err = new Error(errData?.error || "Failed to load test series catalog");
            err.statusCode = res.status;
            err.code = errData?.code;
            err.isQuotaExhausted = res.status === 429 || errData?.code === "FIRESTORE_QUOTA_EXHAUSTED";
            err.retryAfter = errData?.retryAfter || 30;
            throw err;
        }

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
        catalogEmpty.style.display = "none";
        catalogLoading.style.display = "block";
        const isQuota = err.isQuotaExhausted || err.statusCode === 429 || (err.message && err.message.toLowerCase().includes("quota"));
        if (isQuota) {
            catalogLoading.innerHTML = `
                <div class="catalog-quota-state" style="padding: 2.5rem 1rem; text-align: center; border: 1.5px solid #f59e0b; background: rgba(245, 158, 11, 0.08); border-radius: 8px;">
                    <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">⚠️</div>
                    <p style="font-weight: 700; font-size: 1.15rem; color: #b45309; margin-bottom: 0.5rem;">Database Read Quota Reached</p>
                    <p style="font-size: 0.95rem; color: #78350f; max-width: 500px; margin: 0 auto 1.25rem auto;">
                        The test catalog is temporarily unavailable due to high database read volume. Please wait a moment while the quota resets.
                    </p>
                    <button type="button" id="btnRetryCatalog" style="padding: 10px 24px; background: #f59e0b; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.95rem;">Retry Catalog</button>
                </div>
            `;
        } else {
            catalogLoading.innerHTML = `
                <div class="catalog-error-state" style="padding: 2.5rem 1rem; color: #ef4444; text-align: center;">
                    <p style="font-weight: 700; font-size: 1.05rem; margin-bottom: 0.5rem;">Failed to load mock tests</p>
                    <p style="font-size: 0.9rem; color: #64748b; margin-bottom: 1.25rem;">${escapeHTML(err.message)}</p>
                    <button type="button" id="btnRetryCatalog" style="padding: 8px 20px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.9rem;">Retry</button>
                </div>
            `;
        }
        document.getElementById("btnRetryCatalog")?.addEventListener("click", loadCatalog);
    }
}

function renderCatalogCards(tests) {
    if (!testGrid) return;
    testGrid.innerHTML = "";
    const isGuest = !currentUser;

    tests.forEach(test => {
        const card = document.createElement("div");
        card.className = "mock-card";
        const durationMin = Math.round((test.durationSeconds || 1200) / 60);
        const languages = Array.isArray(test.availableLanguages) && test.availableLanguages.length > 0
            ? test.availableLanguages.join(", ")
            : "English";
        const yearDisplay = test.year ? String(test.year) : "";
        const shiftDisplay = test.shift || (test.paperCode && /shift/i.test(test.paperCode) ? test.paperCode : "");

        card.innerHTML = `
            <div>
                <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 0.65rem; flex-wrap: wrap;">
                    <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
                        <span class="mock-card-tag">${escapeHTML(test.examName || test.examId || "General")}</span>
                        ${yearDisplay ? `<span class="mock-card-year-badge">${escapeHTML(yearDisplay)}</span>` : ""}
                        ${shiftDisplay ? `<span class="mock-card-shift-badge">${escapeHTML(shiftDisplay)}</span>` : ""}
                    </div>
                    ${isGuest ? `
                        <span class="mock-card-lock-badge" title="Sign in required to attempt">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                            </svg>
                            Login Required
                        </span>
                    ` : ""}
                </div>
                <h3>${escapeHTML(test.title)}</h3>
                <div class="mock-card-meta">
                    <span class="mock-card-meta-item">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        ${durationMin} mins
                    </span>
                    <span class="mock-card-meta-item">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg>
                        ${test.totalQuestions} Questions
                    </span>
                    <span class="mock-card-meta-item">
                        <strong>${test.maximumMarks}</strong> Marks
                    </span>
                    ${test.paperCode && test.paperCode !== shiftDisplay ? `
                        <span class="mock-card-meta-item">
                            Code: <strong>${escapeHTML(test.paperCode)}</strong>
                        </span>
                    ` : ""}
                </div>
                <div class="mock-card-languages">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
                    <span>Languages: <strong>${escapeHTML(languages)}</strong></span>
                </div>
            </div>
            ${isGuest ? `
                <button class="btn-start-test btn-guest-locked" data-testid="${escapeHTML(test.testId)}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; vertical-align: -1px;">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                    </svg>
                    Sign in to Attempt
                </button>
            ` : `
                <button class="btn-start-test" data-testid="${escapeHTML(test.testId)}">Start Mock Test</button>
            `}
        `;
        testGrid.appendChild(card);
    });

    testGrid.style.display = "grid";

    testGrid.querySelectorAll(".btn-start-test").forEach(btn => {
        btn.addEventListener("click", () => {
            const testId = btn.getAttribute("data-testid");
            if (!currentUser) {
                sessionStorage.setItem("pendingMockTestId", testId);
                sessionStorage.setItem("postLoginRedirect", `mock-test.html?test=${encodeURIComponent(testId)}`);
                showAuthModal({
                    title: "Sign in to Attempt Mock Test",
                    message: "Create a free VidyarthiAstra account or log in to attempt this mock test. Your progress and results can then be saved to your account.",
                    postLoginRedirect: `mock-test.html?test=${encodeURIComponent(testId)}`
                });
                return;
            }
            promptLanguageSelection(testId);
        });
    });
}

// Wire Toolbar Event Listeners
let searchDebounceTimer = null;

mockSearchInput?.addEventListener("input", (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
        currentSearchQuery = (e.target.value || "").trim();
        applyCatalogFilters();
    }, 100);
});

mockSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        e.preventDefault();
        mockSearchInput.value = "";
        currentSearchQuery = "";
        applyCatalogFilters();
        mockSearchInput.blur();
    }
});

mockSearchClearBtn?.addEventListener("click", () => {
    if (mockSearchInput) mockSearchInput.value = "";
    currentSearchQuery = "";
    applyCatalogFilters();
    mockSearchInput?.focus();
});

btnClearSearchNoResults?.addEventListener("click", () => {
    if (mockSearchInput) mockSearchInput.value = "";
    currentSearchQuery = "";
    applyCatalogFilters();
    mockSearchInput?.focus();
});

mockYearSortSelect?.addEventListener("change", (e) => {
    currentYearSort = e.target.value || "default";
    applyCatalogFilters();
});

mockResetFiltersBtn?.addEventListener("click", () => {
    if (mockSearchInput) mockSearchInput.value = "";
    currentSearchQuery = "";
    currentYearSort = "default";
    if (mockYearSortSelect) mockYearSortSelect.value = "default";
    applyCatalogFilters();
});

// -------------------------------------------------------------
// 2. Language Selection Step (Student Pre-Attempt)
// -------------------------------------------------------------
function promptLanguageSelection(testId) {
    if (!currentUser) {
        sessionStorage.setItem("pendingMockTestId", testId);
        sessionStorage.setItem("postLoginRedirect", `mock-test.html?test=${encodeURIComponent(testId)}`);
        showAuthModal({
            title: "Sign in to Attempt Mock Test",
            message: "Create a free VidyarthiAstra account or log in to attempt this mock test. Your progress and results can then be saved to your account.",
            postLoginRedirect: `mock-test.html?test=${encodeURIComponent(testId)}`
        });
        return;
    }

    const test = publishedTests.find(t => t.testId === testId);
    if (!test) {
        startTestSession(testId, "English");
        return;
    }

    pendingTestId = testId;
    const availableLanguages = (test.availableLanguages && test.availableLanguages.length > 0)
        ? test.availableLanguages
        : ["English"];

    if (languageOptionsContainer) {
        languageOptionsContainer.innerHTML = availableLanguages.map((lang, idx) => `
            <label class="lang-option-label" style="display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 2px solid ${idx === 0 ? '#2563eb' : '#e2e8f0'}; border-radius: 8px; cursor: pointer; background: ${idx === 0 ? '#eff6ff' : '#ffffff'}; transition: all 0.15s ease;">
                <input type="radio" name="testLanguageChoice" value="${escapeHTML(lang)}" ${idx === 0 ? 'checked' : ''} style="width: 16px; height: 16px; accent-color: #2563eb;">
                <span style="font-weight: 600; font-size: 0.95rem; color: #1e293b;">${escapeHTML(lang)}</span>
            </label>
        `).join("");

        const labels = languageOptionsContainer.querySelectorAll(".lang-option-label");
        const radios = languageOptionsContainer.querySelectorAll('input[name="testLanguageChoice"]');
        radios.forEach((radio, rIdx) => {
            radio.addEventListener("change", () => {
                labels.forEach((lbl, lIdx) => {
                    const isChecked = lIdx === rIdx;
                    lbl.style.borderColor = isChecked ? "#2563eb" : "#e2e8f0";
                    lbl.style.background = isChecked ? "#eff6ff" : "#ffffff";
                });
            });
        });
    }

    if (languageModal) {
        languageModal.style.display = "flex";
    }
}

// -------------------------------------------------------------
// 3. Start Test Session & Error Recovery
// -------------------------------------------------------------
function renderTestSessionError(testId, language, err) {
    catalogView.style.display = "none";
    resultView.style.display = "none";
    testView.style.display = "block";

    const isQuota = err.statusCode === 429 || err.code === "FIRESTORE_QUOTA_EXHAUSTED" || (err.message && err.message.toLowerCase().includes("quota"));
    const title = isQuota ? "Database Read Quota Reached" : "Unable to Start Mock Test";
    const desc = isQuota
        ? "The database is currently experiencing high load or read limits. Your authenticated session is active. Please wait a moment and click Retry."
        : (err.message || "An unexpected error occurred while preparing your mock test session.");

    testView.innerHTML = `
        <div class="mock-session-error-card" role="alert" style="max-width: 600px; margin: 4rem auto; padding: 2.5rem 2rem; background: var(--bg-card, #ffffff); border: 1.5px solid ${isQuota ? '#f59e0b' : '#ef4444'}; border-radius: 12px; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
            <div style="font-size: 3rem; margin-bottom: 1rem;">${isQuota ? '⏳' : '⚠️'}</div>
            <h2 style="font-size: 1.35rem; font-weight: 700; color: var(--text-primary, #0f172a); margin-bottom: 0.75rem;">${escapeHTML(title)}</h2>
            <p style="color: var(--text-secondary, #64748b); font-size: 0.95rem; line-height: 1.55; margin-bottom: 1.75rem;">${escapeHTML(desc)}</p>
            <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
                <button type="button" id="btnRetryStartSession" style="padding: 10px 24px; background: #2563eb; color: #fff; font-weight: 600; border: none; border-radius: 6px; cursor: pointer; font-size: 0.95rem;">Retry</button>
                <button type="button" id="btnReturnFromSessionError" style="padding: 10px 20px; background: transparent; color: #64748b; font-weight: 600; border: 1px solid #cbd5e1; border-radius: 6px; cursor: pointer; font-size: 0.95rem;">Back to Catalog</button>
            </div>
        </div>
    `;

    let retrying = false;
    document.getElementById("btnRetryStartSession")?.addEventListener("click", async () => {
        if (retrying) return;
        retrying = true;
        const btn = document.getElementById("btnRetryStartSession");
        if (btn) {
            btn.disabled = true;
            btn.textContent = "Retrying...";
            btn.style.opacity = "0.7";
        }
        await startTestSession(testId, language);
    });

    document.getElementById("btnReturnFromSessionError")?.addEventListener("click", () => {
        restoreTestViewTemplate();
        testView.style.display = "none";
        resultView.style.display = "none";
        catalogView.style.display = "block";
        loadCatalog();
    });
}

// Canonical Question Normalizer: Maps API responses across all exam profiles to standardized UIR frontend representation
function normalizeQuestionRecord(rawQ, idx = 0) {
    if (!rawQ || typeof rawQ !== "object") return null;

    const questionId = String(rawQ.questionId || rawQ.id || `q_${idx + 1}`);
    const questionNumber = Number(rawQ.questionNumber || rawQ.number || idx + 1);
    const originalNumbering = rawQ.originalNumbering || String(questionNumber);

    // Resolve question stem text across all schema variations (questionText, text, content.question, question)
    let text = rawQ.questionText || rawQ.text || rawQ.content?.question || rawQ.question || "";
    if (typeof text !== "string") {
        text = String(text || "");
    }

    // Resolve options across all formats (strings, objects, choices)
    const rawOptions = Array.isArray(rawQ.options)
        ? rawQ.options
        : (Array.isArray(rawQ.choices)
            ? rawQ.choices
            : (Array.isArray(rawQ.content?.options) ? rawQ.content.options : []));

    const options = rawOptions.map((opt, oIdx) => {
        if (typeof opt === "string" || typeof opt === "number") {
            const strVal = String(opt);
            return {
                id: String(oIdx + 1),
                label: String.fromCharCode(65 + oIdx),
                text: strVal,
                diagramUrl: null,
                hasDiagram: false
            };
        }
        const optId = String(opt.id ?? opt.label ?? (oIdx + 1));
        const optLabel = String(opt.label ?? opt.id ?? String.fromCharCode(65 + oIdx));
        const optText = String(opt.text ?? opt.content ?? "");
        return {
            id: optId,
            label: optLabel,
            text: optText,
            diagramUrl: opt.diagramUrl || null,
            diagramId: opt.diagramId || null,
            hasDiagram: Boolean(opt.hasDiagram || opt.diagramUrl)
        };
    });

    // Resolve question type
    const rawType = (rawQ.questionType || (options.length === 0 ? "numerical" : "mcq")).toLowerCase();

    return {
        ...rawQ,
        questionId,
        questionNumber,
        originalNumbering,
        questionText: text,
        options,
        questionType: rawType,
        subject: rawQ.subject || rawQ.subjectName || "General",
        sectionId: rawQ.sectionId != null ? String(rawQ.sectionId) : null,
        sectionName: rawQ.sectionName || null,
        marking: rawQ.marking || rawQ.scoring || rawQ.markingScheme || null,
        passageText: typeof rawQ.passageText === "string" ? rawQ.passageText : null,
        statements: Array.isArray(rawQ.statements) ? rawQ.statements : [],
        leftItems: Array.isArray(rawQ.leftItems) ? rawQ.leftItems : [],
        rightItems: Array.isArray(rawQ.rightItems) ? rawQ.rightItems : [],
        tableData: rawQ.tableData || null,
        diagramUrl: rawQ.diagramUrl || null,
        hasDiagram: Boolean(rawQ.hasDiagram || rawQ.diagramUrl || options.some(o => o.hasDiagram))
    };
}

let isStartingSession = false;

async function startTestSession(testId, language = "English") {
    if (isStartingSession) {
        logDiag("CONCURRENT_START_BLOCKED", { testId });
        return;
    }
    isStartingSession = true;

    if (!currentUser) {
        isStartingSession = false;
        sessionStorage.setItem("pendingMockTestId", testId);
        sessionStorage.setItem("postLoginRedirect", `mock-test.html?test=${encodeURIComponent(testId)}`);
        showAuthModal({
            title: "Sign in to Attempt Mock Test",
            message: "Create a free VidyarthiAstra account or log in to attempt this mock test. Your progress and results can then be saved to your account.",
            postLoginRedirect: `mock-test.html?test=${encodeURIComponent(testId)}`
        });
        return;
    }

    logDiag("REQUEST_START", { testId, language });

    let testSessionSkeleton = null;

    try {
        const token = await getAuthToken();
        if (!token) throw new Error("Authentication token unavailable. Please sign in again.");

        catalogView.style.display = "none";
        resultView.style.display = "none";
        testView.style.display = "block";
        testSessionSkeleton = SkeletonManager.mount(
            testView,
            () => SkeletonManager.templates.mockInterface(),
            { delay: 200, ariaLabel: "Preparing mock test session..." }
        );

        // 0. Authoritative Session Role Verification (cached and single-flight deduplicated)
        logDiag("VERIFYING_ROLE");
        let roleData = null;
        if (typeof fetchUserSessionRole === "function" && currentUser) {
            roleData = await fetchUserSessionRole(currentUser);
        } else {
            const roleRes = await fetch(getApiUrl("/api/auth/session-role"), {
                headers: { "Authorization": `Bearer ${token}` }
            });
            if (!roleRes.ok) {
                const errData = await roleRes.json().catch(() => ({}));
                const err = new Error(errData.error || `Session verification failed (HTTP ${roleRes.status})`);
                err.statusCode = roleRes.status;
                err.code = errData.code;
                err.retryAfter = errData.retryAfter;
                throw err;
            }
            roleData = await roleRes.json();
        }
        if (!roleData || !roleData.authenticated) {
            throw new Error("Authentication session is unverified. Please sign in again.");
        }
        logDiag("ROLE_VERIFIED", { role: roleData.role });

        // 1. Start attempt on server with requested language (strictly once)
        logDiag("CREATING_ATTEMPT");
        const attemptRes = await fetch(getApiUrl(`/api/mock-tests/${encodeURIComponent(testId)}/attempts`), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ language })
        });

        if (!attemptRes.ok) {
            const errData = await attemptRes.json().catch(() => ({}));
            const err = new Error(errData.error || "Failed to start test attempt");
            err.statusCode = attemptRes.status;
            err.code = errData.code;
            err.retryAfter = errData.retryAfter;
            throw err;
        }

        const attemptData = await attemptRes.json();
        activeAttempt = attemptData.attempt;
        logDiag("ATTEMPT_CREATED", { attemptId: activeAttempt.attemptId, status: attemptRes.status });

        // 2. Fetch test questions localized to the selected language (answer keys strictly excluded)
        logDiag("FETCHING_QUESTIONS");
        const testRes = await fetch(getApiUrl(`/api/mock-tests/${encodeURIComponent(testId)}?language=${encodeURIComponent(language)}`), {
            headers: { "Authorization": `Bearer ${token}` }
        });

        if (!testRes.ok) {
            const errData = await testRes.json().catch(() => ({}));
            const err = new Error(errData.error || "Failed to load test questions");
            err.statusCode = testRes.status;
            err.code = errData.code;
            err.retryAfter = errData.retryAfter;
            throw err;
        }

        const testDetails = await testRes.json();
        logDiag("QUESTIONS_RECEIVED", {
            status: testRes.status,
            topLevelKeys: Object.keys(testDetails),
            testTitle: testDetails.test?.title || testDetails.title
        });

        activeTest = testDetails.test || testDetails.data?.test || testDetails;
        const rawQuestions = Array.isArray(testDetails.questions)
            ? testDetails.questions
            : (Array.isArray(testDetails.data?.questions)
                ? testDetails.data.questions
                : (Array.isArray(testDetails.test?.questions) ? testDetails.test.questions : []));

        logDiag("RAW_QUESTIONS_COUNT", { count: rawQuestions.length });

        if (rawQuestions.length === 0) {
            throw new Error("This test currently has no questions loaded.");
        }

        // 3. Normalize question records across all archetypes
        let rejectedCount = 0;
        const normalized = [];
        rawQuestions.forEach((q, idx) => {
            const norm = normalizeQuestionRecord(q, idx);
            if (norm) {
                normalized.push(norm);
            } else {
                rejectedCount++;
            }
        });

        if (normalized.length === 0) {
            throw new Error("No valid question records could be extracted from the test data.");
        }

        questions = normalized;
        logDiag("QUESTIONS_NORMALIZED", {
            normalizedCount: questions.length,
            rejectedCount,
            firstQuestionId: questions[0]?.questionId,
            firstQuestionType: questions[0]?.questionType
        });

        // Initialize state
        answers = { ...(activeAttempt.answers || {}) };
        markedForReview = new Set(activeAttempt.markedForReview || []);
        currentIndex = 0;
        logDiag("STATE_STORED", { storedQuestionsCount: questions.length, answersCount: Object.keys(answers).length });

        // Dismiss skeleton and transition to live test
        testSessionSkeleton.dismiss(() => {
            // Restore pristine DOM structure and rebind event listeners
            restoreTestViewTemplate();

            // Populate test headers
            const dom = getTestDOM();
            if (dom.activeTestTitle) dom.activeTestTitle.textContent = activeTest.title;
            if (dom.activeTestMeta) {
                dom.activeTestMeta.textContent = `${(activeTest.examName || activeTest.examId || "").toUpperCase()} | Language: ${activeAttempt.language || language} | ${questions.length} Questions | Max Marks: ${activeTest.maximumMarks}`;
            }

            currentSection = "all";
            renderSectionTabs();
            renderPalette();
            renderQuestion(currentIndex);
            startTimer(activeAttempt.deadlineAt);

            catalogView.style.display = "none";
            resultView.style.display = "none";
            testView.style.display = "block";
            window.scrollTo({ top: 0, behavior: "smooth" });

            logDiag("RENDER_COMPLETE", {
                currentIndex,
                currentQuestionId: questions[currentIndex]?.questionId,
                paletteItemCount: questions.length
            });
        });

    } catch (err) {
        logDiag("ERROR", { message: err.message, stack: err.stack });
        testSessionSkeleton?.cancel();
        renderTestSessionError(testId, language, err);
    } finally {
        isStartingSession = false;
    }
}

// -------------------------------------------------------------
// 3b. Section Navigation & Tabs
// -------------------------------------------------------------
function renderSectionTabs() {
    const dom = getTestDOM();
    if (!dom.sectionTabsBar) return;

    const sections = Array.isArray(activeTest?.sections) ? activeTest.sections : [];
    if (sections.length <= 1) {
        dom.sectionTabsBar.style.display = "none";
        return;
    }

    dom.sectionTabsBar.style.display = "flex";
    const allCount = questions.length;

    let html = `<button type="button" class="section-tab-btn ${currentSection === 'all' ? 'active' : ''}" data-sec="all">
        All Questions <span class="tab-count">${allCount}</span>
    </button>`;

    sections.forEach(sec => {
        const secId = String(sec.sectionId || sec.id);
        const secName = sec.sectionName || sec.name || secId;
        const secQuestions = questions.filter(q => String(q.sectionId) === secId || String(q.sectionName) === secName);
        const count = secQuestions.length || sec.questionCount || 0;
        html += `<button type="button" class="section-tab-btn ${currentSection === secId ? 'active' : ''}" data-sec="${escapeHTML(secId)}">
            ${escapeHTML(secName)} <span class="tab-count">${count}</span>
        </button>`;
    });

    dom.sectionTabsBar.innerHTML = html;

    dom.sectionTabsBar.querySelectorAll(".section-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const secId = btn.getAttribute("data-sec");
            currentSection = secId;
            renderSectionTabs();
            if (secId !== "all") {
                const targetIdx = questions.findIndex(q => String(q.sectionId) === secId || String(q.sectionName) === secId);
                if (targetIdx !== -1) {
                    renderQuestion(targetIdx);
                }
            }
            renderPalette();
        });
    });
}

// -------------------------------------------------------------
// 4. Universal Question Rendering & Navigation
// -------------------------------------------------------------
function renderQuestion(index) {
    if (index < 0 || index >= questions.length) return;
    currentIndex = index;

    const dom = getTestDOM();
    const q = questions[index];
    if (!q) return;

    try {
        if (dom.qNumberBadge) {
            dom.qNumberBadge.textContent = `Question ${index + 1} of ${questions.length}`;
        }
        if (dom.qSubjectBadge) {
            dom.qSubjectBadge.textContent = q.subject || "General";
        }

        // Section Badge
        if (dom.qSectionBadge) {
            const sName = q.sectionName || (activeTest?.sections?.find(s => s.sectionId === q.sectionId || s.id === q.sectionId)?.sectionName) || null;
            if (sName) {
                dom.qSectionBadge.style.display = "inline-block";
                dom.qSectionBadge.textContent = sName;
            } else {
                dom.qSectionBadge.style.display = "none";
            }
        }

        // Resolve Question Type
        const rawType = (q.questionType || (q.options?.length === 0 ? "numerical" : "mcq")).toLowerCase();
        let qType = "mcq";
        let qTypeLabel = "Multiple Choice";
        if (rawType.includes("nat") || rawType.includes("numerical")) {
            qType = "numerical";
            qTypeLabel = "Numerical (NAT)";
        } else if (rawType.includes("msq") || rawType.includes("multiple_choice_msq")) {
            qType = "msq";
            qTypeLabel = "Multiple Select (MSQ)";
        } else if (rawType.includes("descriptive") || rawType.includes("subjective") || rawType.includes("manual")) {
            qType = "descriptive";
            qTypeLabel = "Descriptive / Subjective";
        } else if (rawType.includes("fill_in") || rawType.includes("blank")) {
            qType = "fill_in_blanks";
            qTypeLabel = "Fill in the Blanks";
        } else if (rawType.includes("matrix")) {
            qType = "matrix_matching";
            qTypeLabel = "Matrix Matching";
        } else if (rawType.includes("matching")) {
            qType = "matching";
            qTypeLabel = "Matching List";
        } else if (rawType.includes("assertion")) {
            qType = "assertion_reason";
            qTypeLabel = "Assertion-Reason";
        } else if (rawType.includes("passage")) {
            qType = "passage";
            qTypeLabel = "Comprehension / Passage";
        } else if (rawType === "mcq" || rawType === "single_choice_mcq" || rawType === "single_choice" || rawType.includes("single_choice")) {
            qType = "mcq";
            qTypeLabel = "Multiple Choice";
        }

        if (dom.qTypeBadge) {
            dom.qTypeBadge.textContent = qTypeLabel;
        }

        // Marks Info
        if (dom.qMarksInfo) {
            const m = q.marking || q.scoring || q.markingScheme;
            if (m) {
                const pos = m.positiveMarks !== undefined ? m.positiveMarks : (m.correct !== undefined ? m.correct : 4);
                const neg = m.negativeMarks !== undefined ? m.negativeMarks : (m.incorrect !== undefined ? m.incorrect : 1);
                dom.qMarksInfo.textContent = Number(neg) === 0 ? `+${pos} / 0 Marks` : `+${pos} / -${Math.abs(neg)} Marks`;
            } else {
                dom.qMarksInfo.textContent = "+4 / -1 Marks";
            }
        }

        // Reading Passage Box (Comprehension / Passage Child)
        if (dom.qPassageBox) {
            if (typeof q.passageText === "string" && q.passageText.trim().length > 0) {
                dom.qPassageBox.style.display = "block";
                dom.qPassageBox.innerHTML = `
                    <div class="passage-box-header">&#128214; Reading Passage / Context</div>
                    <div>${escapeHTML(q.passageText)}</div>
                `;
            } else {
                dom.qPassageBox.style.display = "none";
            }
        }

        // Question body & translation disclosure notice
        if (dom.qText) {
            if (q.translationMissing) {
                dom.qText.innerHTML = `
                    <div style="margin-bottom: 8px;">
                        <span class="translation-fallback-notice" style="display: inline-block; font-size: 11px; background: #fef3c7; color: #92400e; padding: 3px 8px; border-radius: 4px; font-weight: 600; border: 1px solid #fde68a;">
                            &#9888; Translation unavailable: Displaying canonical verified English text
                        </span>
                    </div>
                    <div>${escapeHTML(q.questionText)}</div>
                `;
            } else {
                dom.qText.textContent = q.questionText || "[No question text available]";
            }
        }

        // Statements / Assertion-Reason Box
        if (dom.qStatementsBox) {
            if (Array.isArray(q.statements) && q.statements.length > 0) {
                dom.qStatementsBox.style.display = "block";
                dom.qStatementsBox.innerHTML = q.statements.map((s, sIdx) => {
                    const lbl = typeof s === "object" ? (s.label || s.number || `Statement ${sIdx + 1}`) : `Statement ${sIdx + 1}`;
                    const txt = typeof s === "object" ? (s.text || "") : String(s);
                    return `<div class="statement-item"><span class="statement-label">${escapeHTML(lbl)}:</span> ${escapeHTML(txt)}</div>`;
                }).join("");
            } else {
                dom.qStatementsBox.style.display = "none";
            }
        }

        // Tables / Matching Pair Box
        if (dom.qTablesBox) {
            if (Array.isArray(q.leftItems) && q.leftItems.length > 0 && Array.isArray(q.rightItems) && q.rightItems.length > 0) {
                dom.qTablesBox.style.display = "block";
                const maxRows = Math.max(q.leftItems.length, q.rightItems.length);
                let rowsHtml = "";
                for (let r = 0; r < maxRows; r++) {
                    const left = q.leftItems[r] ? `${q.leftItems[r].label || (r + 1)}. ${q.leftItems[r].text || q.leftItems[r]}` : "";
                    const right = q.rightItems[r] ? `${q.rightItems[r].label || String.fromCharCode(65 + r)}. ${q.rightItems[r].text || q.rightItems[r]}` : "";
                    rowsHtml += `<tr><td>${escapeHTML(left)}</td><td>${escapeHTML(right)}</td></tr>`;
                }
                dom.qTablesBox.innerHTML = `
                    <div class="matching-table-container">
                        <table class="matching-table">
                            <thead><tr><th>List I</th><th>List II</th></tr></thead>
                            <tbody>${rowsHtml}</tbody>
                        </table>
                    </div>
                `;
            } else {
                dom.qTablesBox.style.display = "none";
            }
        }

        // Render question diagram if available
        const existingDiag = document.getElementById("qDiagramBox");
        if (existingDiag) existingDiag.remove();

        if (q.diagramUrl && dom.qText && dom.optionsContainer) {
            const diagBox = document.createElement("div");
            diagBox.id = "qDiagramBox";
            diagBox.style.cssText = "margin: 1rem 0; text-align: center; background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 12px;";
            diagBox.innerHTML = `
                <img src="${escapeHTML(q.diagramUrl)}" alt="Question Diagram" style="max-width: 100%; max-height: 380px; object-fit: contain; border-radius: 4px; background: #ffffff;" />
                <div style="margin-top: 6px; font-size: 0.8rem; color: #64748b;">Refer to figure above for Question ${index + 1}</div>
            `;
            dom.qText.parentNode.insertBefore(diagBox, dom.optionsContainer);
        }

        // Render options / input controls
        if (dom.optionsContainer) {
            dom.optionsContainer.innerHTML = "";
            const selectedChoice = answers[q.questionId];

            if (qType === "numerical") {
                const natCard = document.createElement("div");
                natCard.className = "nat-answer-card";
                natCard.style.cssText = "margin: 1.25rem 0; padding: 1.25rem; background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 8px;";
                natCard.innerHTML = `
                    <label for="natAnswerInput" style="display: block; font-weight: 700; color: #0f172a; margin-bottom: 8px; font-size: 0.95rem;">
                        Numerical Answer (NAT):
                    </label>
                    <div style="display: flex; align-items: center; gap: 10px; max-width: 420px;">
                        <input type="text" 
                               id="natAnswerInput" 
                               inputmode="decimal"
                               autocomplete="off"
                               spellcheck="false"
                               value="${escapeHTML(selectedChoice || '')}" 
                               placeholder="Enter numerical value (e.g. 42 or 3.14)" 
                               style="flex: 1; padding: 10px 14px; font-size: 1.15rem; border: 2px solid #3b82f6; border-radius: 6px; font-family: monospace; font-weight: 700; color: #0f172a; background: #ffffff;" />
                        <button type="button" 
                                id="natClearBtn" 
                                class="btn btn-secondary" 
                                style="padding: 10px 16px; font-size: 0.9rem; font-weight: 600; cursor: pointer; border-radius: 6px; border: 1px solid #cbd5e1; background: #f1f5f9; color: #475569;">
                            Clear
                        </button>
                    </div>
                    <div id="natValidationError" style="display: none; margin-top: 8px; color: #dc2626; font-size: 0.85rem; font-weight: 600;">
                        Invalid input: only digits (0-9) and a single decimal point (.) are allowed.
                    </div>
                    <span style="display: block; margin-top: 8px; font-size: 0.8rem; color: #64748b;">
                        Enter your numerical answer using digits and at most one decimal point. No options required.
                    </span>
                `;
                dom.optionsContainer.appendChild(natCard);

                const natInput = document.getElementById("natAnswerInput");
                const natClearBtn = document.getElementById("natClearBtn");
                const natErr = document.getElementById("natValidationError");

                const validateNumericString = (val) => {
                    if (!val) return true;
                    return /^\d+(?:\.\d+)?$/.test(val);
                };

                const updateNatValue = (val) => {
                    const trimmed = val.trim();
                    if (!trimmed) {
                        if (natErr) natErr.style.display = "none";
                        natInput.style.borderColor = "#3b82f6";
                        delete answers[q.questionId];
                        updatePaletteState();
                        scheduleAutosave();
                        return;
                    }

                    if (validateNumericString(trimmed)) {
                        if (natErr) natErr.style.display = "none";
                        natInput.style.borderColor = "#10b981";
                        answers[q.questionId] = trimmed;
                        updatePaletteState();
                        scheduleAutosave();
                    } else {
                        if (natErr) {
                            natErr.style.display = "block";
                            natErr.textContent = "Invalid numerical input: only digits (0-9) and at most one decimal point (.) are allowed.";
                        }
                        natInput.style.borderColor = "#dc2626";
                        delete answers[q.questionId];
                        updatePaletteState();
                        scheduleAutosave();
                    }
                };

                if (natInput) {
                    natInput.addEventListener("keydown", (e) => {
                        if (["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Tab", "Enter", "Home", "End"].includes(e.key)) {
                            return;
                        }
                        if (e.ctrlKey || e.metaKey) return;

                        if (e.key >= "0" && e.key <= "9") {
                            return;
                        }

                        if (e.key === ".") {
                            if (natInput.value.includes(".")) {
                                e.preventDefault();
                                if (natErr) {
                                    natErr.style.display = "block";
                                    natErr.textContent = "Only a single decimal point (.) is permitted.";
                                }
                            }
                            return;
                        }

                        e.preventDefault();
                        if (natErr) {
                            natErr.style.display = "block";
                            natErr.textContent = "Only digits (0-9) and a single decimal point (.) are allowed.";
                        }
                    });

                    natInput.addEventListener("paste", (e) => {
                        const pastedText = (e.clipboardData || window.clipboardData)?.getData("text") || "";
                        const clean = pastedText.trim();
                        const currentValue = natInput.value;
                        const selStart = natInput.selectionStart ?? 0;
                        const selEnd = natInput.selectionEnd ?? 0;
                        const proposed = currentValue.slice(0, selStart) + clean + currentValue.slice(selEnd);

                        if (!/^\d*(?:\.\d*)?$/.test(proposed.trim())) {
                            e.preventDefault();
                            if (natErr) {
                                natErr.style.display = "block";
                                natErr.textContent = "Pasted content rejected: only digits and a single decimal point are permitted.";
                            }
                        }
                    });

                    natInput.addEventListener("input", (e) => {
                        updateNatValue(e.target.value);
                    });
                }

                if (natClearBtn && natInput) {
                    natClearBtn.addEventListener("click", () => {
                        natInput.value = "";
                        if (natErr) natErr.style.display = "none";
                        natInput.style.borderColor = "#3b82f6";
                        delete answers[q.questionId];
                        updatePaletteState();
                        scheduleAutosave();
                        natInput.focus();
                    });
                }
            } else if (qType === "fill_in_blanks") {
                const blankCard = document.createElement("div");
                blankCard.style.cssText = "margin: 1.25rem 0; padding: 1.25rem; background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 8px;";
                blankCard.innerHTML = `
                    <label for="blankAnswerInput" style="display: block; font-weight: 700; color: #0f172a; margin-bottom: 8px; font-size: 0.95rem;">
                        Your Answer:
                    </label>
                    <div style="display: flex; align-items: center; gap: 10px; max-width: 400px;">
                        <input type="text" id="blankAnswerInput" value="${escapeHTML(selectedChoice || '')}" placeholder="Type your answer here..." style="flex: 1; padding: 10px 14px; font-size: 1.05rem; border: 1.5px solid #3b82f6; border-radius: 6px;" />
                    </div>
                `;
                dom.optionsContainer.appendChild(blankCard);

                const blankInput = document.getElementById("blankAnswerInput");
                if (blankInput) {
                    blankInput.addEventListener("input", (e) => {
                        const val = e.target.value.trim();
                        if (val) {
                            answers[q.questionId] = val;
                        } else {
                            delete answers[q.questionId];
                        }
                        updatePaletteState();
                        scheduleAutosave();
                    });
                }
            } else if (qType === "descriptive") {
                const descCard = document.createElement("div");
                descCard.className = "descriptive-card";
                const textVal = String(selectedChoice || "");
                const words = textVal.trim() ? textVal.trim().split(/\s+/).length : 0;
                descCard.innerHTML = `
                    <label for="descAnswerTextarea" style="display: block; font-weight: 700; color: #0f172a; margin-bottom: 8px; font-size: 0.95rem;">
                        Subjective / Descriptive Answer:
                    </label>
                    <textarea id="descAnswerTextarea" class="descriptive-textarea" placeholder="Type your detailed steps, formulas, derivations, or explanation here...">${escapeHTML(textVal)}</textarea>
                    <div class="descriptive-meta-bar">
                        <span id="descWordCount">${words} word(s) | ${textVal.length} character(s)</span>
                        <span>Provisional score; requires manual evaluation</span>
                    </div>
                `;
                dom.optionsContainer.appendChild(descCard);

                const descTextarea = document.getElementById("descAnswerTextarea");
                const countEl = document.getElementById("descWordCount");
                if (descTextarea) {
                    descTextarea.addEventListener("input", (e) => {
                        const val = e.target.value;
                        const curWords = val.trim() ? val.trim().split(/\s+/).length : 0;
                        if (countEl) countEl.textContent = `${curWords} word(s) | ${val.length} character(s)`;
                        if (val.trim()) {
                            answers[q.questionId] = val;
                        } else {
                            delete answers[q.questionId];
                        }
                        updatePaletteState();
                        scheduleAutosave();
                    });
                }
            } else if (qType === "msq") {
                const msqNotice = document.createElement("div");
                msqNotice.style.cssText = "margin-bottom: 10px; font-size: 0.85rem; font-weight: 600; color: #2563eb; background: #eff6ff; padding: 6px 12px; border-radius: 6px;";
                msqNotice.innerHTML = "&#9432; Multiple Select Question (MSQ): One or more options may be correct.";
                dom.optionsContainer.appendChild(msqNotice);

                const currentChoices = Array.isArray(selectedChoice)
                    ? selectedChoice.map(String)
                    : (selectedChoice ? String(selectedChoice).split(/[,\s|]+/) : []);

                (q.options || []).forEach((opt) => {
                    const isSelected = currentChoices.includes(String(opt.id)) || currentChoices.includes(String(opt.label));
                    const optEl = document.createElement("label");
                    optEl.className = `option-item ${isSelected ? "selected" : ""}`;
                    optEl.style.cssText = "display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; cursor: pointer;";
                    optEl.innerHTML = `
                        <input type="checkbox" name="optChoice" value="${escapeHTML(opt.id)}" class="option-checkbox" ${isSelected ? "checked" : ""} style="margin-top: 4px;">
                        <span class="option-label">${escapeHTML(opt.label || opt.id)}</span>
                        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                            ${opt.text && !opt.text.includes("[Diagram / Structure") ? `<span class="option-text">${escapeHTML(opt.text)}</span>` : ""}
                            ${opt.diagramUrl ? `<img src="${escapeHTML(opt.diagramUrl)}" alt="Option ${escapeHTML(opt.label || opt.id)}" style="max-height: 110px; max-width: 250px; object-fit: contain; border-radius: 4px; border: 1px solid #cbd5e1; background: #fff; padding: 4px;" />` : ""}
                        </div>
                    `;

                    optEl.addEventListener("click", (e) => {
                        if (e.target.tagName !== "INPUT") {
                            e.preventDefault();
                        }
                        selectMsqOption(q.questionId, String(opt.id));
                    });

                    dom.optionsContainer.appendChild(optEl);
                });
            } else if (qType === "mcq" || qType === "assertion_reason" || qType === "matching" || qType === "matrix_matching" || qType === "passage") {
                // Standard Choice-based questions (MCQ, Single Choice, Assertion-Reason, Matching)
                (q.options || []).forEach((opt) => {
                    const isSelected = selectedChoice === String(opt.id) || selectedChoice === String(opt.label);
                    const optEl = document.createElement("label");
                    optEl.className = `option-item ${isSelected ? "selected" : ""}`;
                    optEl.style.cssText = "display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; cursor: pointer;";
                    optEl.innerHTML = `
                        <input type="radio" name="optChoice" value="${escapeHTML(opt.id)}" class="option-radio" ${isSelected ? "checked" : ""} style="margin-top: 4px;">
                        <span class="option-label">${escapeHTML(opt.label || opt.id)}</span>
                        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                            ${opt.text && !opt.text.includes("[Diagram / Structure") ? `<span class="option-text">${escapeHTML(opt.text)}</span>` : ""}
                            ${opt.diagramUrl ? `<img src="${escapeHTML(opt.diagramUrl)}" alt="Option ${escapeHTML(opt.label || opt.id)}" style="max-height: 110px; max-width: 250px; object-fit: contain; border-radius: 4px; border: 1px solid #cbd5e1; background: #fff; padding: 4px;" />` : ""}
                        </div>
                    `;

                    optEl.addEventListener("click", () => {
                        selectOption(q.questionId, String(opt.id));
                    });

                    dom.optionsContainer.appendChild(optEl);
                });
            } else {
                // Explicit diagnostic notice for unsupported / manual questions
                dom.optionsContainer.innerHTML = `
                    <div class="unsupported-question-type-card" style="padding: 1.25rem; border: 1.5px solid #f59e0b; background: #fffbeb; border-radius: 8px; color: #b45309; margin: 1rem 0;">
                        <h4 style="margin: 0 0 0.5rem 0; font-size: 1rem; font-weight: 700;">Question Type Notice</h4>
                        <p style="margin: 0; font-size: 0.9rem; line-height: 1.5;">This question has type "<code>${escapeHTML(rawType)}</code>" and cannot be answered automatically. It has been marked for manual review.</p>
                    </div>
                `;
            }
        }

        // Review button state
        if (dom.btnMarkReview) {
            if (markedForReview.has(q.questionId)) {
                dom.btnMarkReview.classList.add("active");
                dom.btnMarkReview.textContent = "Marked for Review";
            } else {
                dom.btnMarkReview.classList.remove("active");
                dom.btnMarkReview.textContent = "Mark for Review";
            }
        }

        // Prev / Next button state
        if (dom.btnPrev) {
            dom.btnPrev.disabled = currentIndex === 0;
        }
        if (dom.btnNext) {
            dom.btnNext.textContent = currentIndex === questions.length - 1 ? "Save" : "Save & Next";
        }

        updatePaletteState();

        logDiag("RENDER_QUESTION", {
            index,
            questionId: q.questionId,
            questionType: qType,
            hasText: Boolean(q.questionText),
            optionsCount: (q.options || []).length
        });

    } catch (renderErr) {
        logDiag("RENDER_ERROR", { index, message: renderErr.message });
        if (dom.qText) {
            dom.qText.innerHTML = `
                <div style="color: #ef4444; padding: 1rem; border: 1.5px solid #fecaca; background: #fef2f2; border-radius: 8px;">
                    <strong>Rendering Error:</strong> Unable to render Question #${index + 1} (${escapeHTML(renderErr.message)}).
                </div>
            `;
        }
    }
}

function selectOption(questionId, optionId) {
    answers[questionId] = optionId;
    renderQuestion(currentIndex);
    scheduleAutosave();
}

function selectMsqOption(questionId, optionId) {
    const current = answers[questionId];
    let arr = Array.isArray(current)
        ? [...current]
        : (current ? String(current).split(/[,\s|]+/).filter(Boolean) : []);
    const strOpt = String(optionId);
    if (arr.includes(strOpt)) {
        arr = arr.filter(o => o !== strOpt);
    } else {
        arr.push(strOpt);
    }
    arr.sort();
    if (arr.length > 0) {
        answers[questionId] = arr;
    } else {
        delete answers[questionId];
    }
    renderQuestion(currentIndex);
    scheduleAutosave();
}

function clearChoice() {
    const q = questions[currentIndex];
    if (q && answers[q.questionId]) {
        delete answers[q.questionId];
        renderQuestion(currentIndex);
        scheduleAutosave();
    }
}

function toggleReview() {
    const q = questions[currentIndex];
    if (q) {
        if (markedForReview.has(q.questionId)) {
            markedForReview.delete(q.questionId);
        } else {
            markedForReview.add(q.questionId);
        }
        renderQuestion(currentIndex);
        scheduleAutosave();
    }
}

// -------------------------------------------------------------
// 5. Question Palette
// -------------------------------------------------------------
function renderPalette() {
    const dom = getTestDOM();
    if (!dom.paletteGrid) return;
    dom.paletteGrid.innerHTML = "";

    questions.forEach((q, idx) => {
        const btn = document.createElement("button");
        btn.className = "palette-btn";
        btn.id = `palette-btn-${idx}`;
        btn.textContent = idx + 1;
        btn.addEventListener("click", () => {
            renderQuestion(idx);
        });
        dom.paletteGrid.appendChild(btn);
    });

    updatePaletteState();
    logDiag("PALETTE_RENDERED", { paletteItemCount: questions.length, currentIndex });
}

function updatePaletteState() {
    questions.forEach((q, idx) => {
        const btn = document.getElementById(`palette-btn-${idx}`);
        if (!btn) return;

        btn.className = "palette-btn";
        if (idx === currentIndex) {
            btn.classList.add("current");
        }

        const isAnswered = Boolean(answers[q.questionId]);
        const isReviewed = markedForReview.has(q.questionId);

        if (isReviewed && isAnswered) {
            btn.classList.add("reviewed-answered");
        } else if (isReviewed) {
            btn.classList.add("reviewed");
        } else if (isAnswered) {
            btn.classList.add("answered");
        } else if (idx < currentIndex) {
            btn.classList.add("unanswered");
        }
    });
}

// -------------------------------------------------------------
// 6. Timer & Autosave Engine
// -------------------------------------------------------------
function startTimer(deadlineAt) {
    if (timerInterval) clearInterval(timerInterval);

    const targetTime = new Date(deadlineAt).getTime();

    function update() {
        const now = Date.now();
        const diff = Math.max(0, targetTime - now);

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        const dom = getTestDOM();
        if (dom.timerText) {
            dom.timerText.textContent = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
        }

        if (diff <= 300000) { // < 5 mins
            if (dom.timerDisplay) dom.timerDisplay.classList.add("urgent");
        } else {
            if (dom.timerDisplay) dom.timerDisplay.classList.remove("urgent");
        }

        if (diff <= 0) {
            clearInterval(timerInterval);
            alert("Time limit reached! Your test is being automatically submitted.");
            executeSubmission();
        }
    }

    update();
    timerInterval = setInterval(update, 1000);
}

function scheduleAutosave() {
    if (autosaveTimeout) clearTimeout(autosaveTimeout);
    autosaveTimeout = setTimeout(performAutosave, 500);
}

async function performAutosave() {
    if (!activeAttempt) return;
    try {
        let token = await getAuthToken();
        if (!token) {
            token = await getAuthToken(true);
        }
        if (!token) {
            showSessionExpiryPrompt();
            return;
        }

        const res = await fetch(getApiUrl(`/api/mock-tests/attempts/${encodeURIComponent(activeAttempt.attemptId)}`), {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({
                answers,
                markedForReview: Array.from(markedForReview)
            })
        });

        if (res.status === 401) {
            // Attempt token refresh on 401
            const freshToken = await getAuthToken(true);
            if (freshToken) {
                await fetch(getApiUrl(`/api/mock-tests/attempts/${encodeURIComponent(activeAttempt.attemptId)}`), {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${freshToken}`
                    },
                    body: JSON.stringify({
                        answers,
                        markedForReview: Array.from(markedForReview)
                    })
                });
                return;
            }
            showSessionExpiryPrompt();
        }
    } catch (e) {
        console.warn("[MockTest Client] Autosave notice:", e.message);
    }
}

// -------------------------------------------------------------
// 7. Test Submission & Scoring
// -------------------------------------------------------------
function openSubmitModal() {
    const dom = getTestDOM();
    const answeredCount = Object.keys(answers).length;
    const reviewCount = markedForReview.size;
    const unansweredCount = questions.length - answeredCount;

    if (dom.modalAnsweredCount) dom.modalAnsweredCount.textContent = answeredCount;
    if (dom.modalReviewCount) dom.modalReviewCount.textContent = reviewCount;
    if (dom.modalUnansweredCount) dom.modalUnansweredCount.textContent = Math.max(0, unansweredCount);

    if (dom.submitModal) {
        dom.submitModal.style.display = "flex";
    }
}

function closeSubmitModal() {
    const dom = getTestDOM();
    if (dom.submitModal) {
        dom.submitModal.style.display = "none";
    }
}

let isSubmitting = false;

async function executeSubmission() {
    if (isSubmitting) {
        logDiag("CONCURRENT_SUBMIT_BLOCKED", { attemptId: activeAttempt?.attemptId });
        return;
    }
    isSubmitting = true;

    closeSubmitModal();
    if (timerInterval) clearInterval(timerInterval);

    logDiag("SUBMISSION_START", { attemptId: activeAttempt?.attemptId });

    const dom = getTestDOM();
    if (dom.testView) dom.testView.style.display = "none";
    if (dom.resultView) dom.resultView.style.display = "block";

    let resultsSkeleton = null;
    try {
        resultsSkeleton = SkeletonManager.mount(
            dom.resultView || document.getElementById("resultView"),
            () => SkeletonManager.templates.mockResults(),
            { delay: 200, ariaLabel: "Evaluating test results..." }
        );
    } catch (_) { }

    try {
        let token = await getAuthToken();
        if (!token) {
            token = await getAuthToken(true);
        }
        if (!token) {
            showSessionExpiryPrompt();
            throw new Error("Authentication session expired. Please sign in to submit your test.");
        }

        // First flush latest autosave
        await performAutosave();

        logDiag("SUBMITTING_ATTEMPT", { attemptId: activeAttempt?.attemptId, answersCount: Object.keys(answers).length });

        let submitRes = await fetch(getApiUrl(`/api/mock-tests/attempts/${encodeURIComponent(activeAttempt.attemptId)}/submit`), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ answers })
        });

        if (submitRes.status === 401) {
            const freshToken = await getAuthToken(true);
            if (freshToken) {
                submitRes = await fetch(getApiUrl(`/api/mock-tests/attempts/${encodeURIComponent(activeAttempt.attemptId)}/submit`), {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${freshToken}`
                    },
                    body: JSON.stringify({ answers })
                });
            } else {
                showSessionExpiryPrompt();
                throw new Error("Authentication session expired. Please sign in to submit your test.");
            }
        }

        if (!submitRes.ok) {
            const errData = await submitRes.json().catch(() => ({}));
            throw new Error(errData.error || `Submission evaluation failed (HTTP ${submitRes.status})`);
        }

        const data = await submitRes.json();
        logDiag("SUBMISSION_EVALUATION_SUCCESS", { totalScore: data.result?.totalScore, maximumMarks: data.result?.maximumMarks });

        if (resultsSkeleton) {
            resultsSkeleton.dismiss(() => {
                restoreResultViewTemplate();
                renderResults(data.result);
                logDiag("RESULT_RENDER_COMPLETE", { resultId: data.result?.resultId, totalScore: data.result?.totalScore });
            });
        } else {
            restoreResultViewTemplate();
            renderResults(data.result);
            logDiag("RESULT_RENDER_COMPLETE", { resultId: data.result?.resultId, totalScore: data.result?.totalScore });
        }

    } catch (err) {
        logDiag("SUBMISSION_ERROR", { message: err.message });
        resultsSkeleton?.cancel();

        const curDom = getTestDOM();
        if (curDom.resultView) curDom.resultView.style.display = "none";
        if (curDom.testView) {
            restoreTestViewTemplate();
            curDom.testView.style.display = "block";
            renderQuestion(currentIndex);
            if (activeAttempt?.deadlineAt) {
                startTimer(activeAttempt.deadlineAt);
            }
        }
        alert(`Error during test submission: ${err.message}`);
    } finally {
        isSubmitting = false;
    }
}

// Result & Review State
let lastResult = null;
let reviewExamData = null;
let reviewQuestions = [];
let filteredReviewQuestions = [];
let currentReviewIndex = 0;
let currentReviewQuestionId = null;
let selectedReviewSubject = "all";
let selectedReviewStatus = "all";

const reviewView = document.getElementById("reviewView");
const btnReviewExam = document.getElementById("btnReviewExam");
const btnBackToAnalysis = document.getElementById("btnBackToAnalysis");
const btnExitReview = document.getElementById("btnExitReview");
const btnRevPrev = document.getElementById("btnRevPrev");
const btnRevNext = document.getElementById("btnRevNext");

// Helper: Format elapsed duration (seconds -> readable string)
function formatTimeTaken(seconds) {
    if (seconds == null || isNaN(seconds) || seconds < 0) return "-";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0) {
        return `${hrs}h ${mins}m ${secs}s`;
    }
    return `${mins}m ${secs}s`;
}

// Helper: Render Subject-wise SVG Performance Chart
function renderSubjectPerformanceChart(subjectAnalysis) {
    const dom = getTestDOM();
    const container = dom.subjectPerformanceChart || document.getElementById("subjectPerformanceChart");
    if (!container) return;

    const subjects = Object.values(subjectAnalysis || {});
    if (subjects.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 2rem;">No subject data available.</div>';
        return;
    }

    let maxSubjectMarks = 0;
    let minMarks = 0;
    subjects.forEach(s => {
        if (s.maximumMarks > maxSubjectMarks) maxSubjectMarks = s.maximumMarks;
        if (s.score < minMarks) minMarks = s.score;
    });

    if (maxSubjectMarks <= 0) maxSubjectMarks = 100;
    const upperLimit = Math.ceil(maxSubjectMarks / 20) * 20;
    const lowerLimit = minMarks < 0 ? Math.floor(minMarks / 10) * 10 : 0;
    const range = Math.max(10, upperLimit - lowerLimit);

    const width = 680;
    const height = 280;
    const padding = { top: 30, right: 30, bottom: 60, left: 55 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const getY = (val) => {
        const normalized = (val - lowerLimit) / range;
        return padding.top + chartHeight * (1 - normalized);
    };

    const zeroY = getY(0);

    const gridStep = range <= 60 ? 10 : (range <= 150 ? 25 : 50);
    const gridLines = [];
    for (let val = lowerLimit; val <= upperLimit; val += gridStep) {
        gridLines.push(val);
    }

    const numBars = subjects.length;
    const slotWidth = chartWidth / numBars;
    const barWidth = Math.min(64, slotWidth * 0.55);

    let svg = `<svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: auto; font-family: inherit; overflow: visible;" role="img" aria-label="Subject performance chart">`;

    // Horizontal Grid Lines & Y-axis scale
    for (const val of gridLines) {
        const y = getY(val);
        const isZero = val === 0;
        svg += `
            <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="${isZero ? '#94a3b8' : '#f1f5f9'}" stroke-width="${isZero ? '1.5' : '1'}" />
            <text x="${padding.left - 10}" y="${y + 4}" fill="#64748b" font-size="11" font-weight="600" text-anchor="end">${val}</text>
        `;
    }

    // Bars
    subjects.forEach((s, idx) => {
        const centerX = padding.left + (idx + 0.5) * slotWidth;
        const x = centerX - barWidth / 2;
        const score = s.score;
        const maxMarks = s.maximumMarks;

        const maxRefY = getY(maxMarks);
        const scoreY = getY(score);

        // Maximum Marks Reference (Dashed Outline Box)
        const maxBarHeight = Math.max(0, zeroY - maxRefY);
        if (maxBarHeight > 0) {
            svg += `
                <rect x="${x}" y="${maxRefY}" width="${barWidth}" height="${maxBarHeight}" rx="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="3 3" />
            `;
        }

        // Score Bar
        let barY, barH, barColor;
        if (score >= 0) {
            barY = scoreY;
            barH = Math.max(2, zeroY - scoreY);
            barColor = score >= maxMarks * 0.75 ? '#16a34a' : (score >= maxMarks * 0.4 ? '#2563eb' : '#f59e0b');
        } else {
            barY = zeroY;
            barH = Math.max(2, scoreY - zeroY);
            barColor = '#dc2626';
        }

        svg += `
            <rect x="${x}" y="${barY}" width="${barWidth}" height="${barH}" rx="5" fill="${barColor}">
                <title>${escapeHTML(s.subjectName)}: ${score} / ${maxMarks} Marks (${s.accuracy}% Accuracy)</title>
            </rect>
        `;

        // Value Label above/below bar
        const labelY = score >= 0 ? Math.max(padding.top + 12, barY - 6) : barY + barH + 14;
        svg += `
            <text x="${centerX}" y="${labelY}" fill="#0f172a" font-size="12" font-weight="700" text-anchor="middle">${score}</text>
        `;

        // Max Reference Label
        if (maxBarHeight > 24 && score < maxMarks) {
            svg += `
                <text x="${centerX}" y="${maxRefY - 4}" fill="#94a3b8" font-size="10" font-weight="600" text-anchor="middle">Max ${maxMarks}</text>
            `;
        }

        // Subject Name below axis
        svg += `
            <text x="${centerX}" y="${height - padding.bottom + 20}" fill="#1e293b" font-size="12" font-weight="700" text-anchor="middle">${escapeHTML(s.subjectName)}</text>
            <text x="${centerX}" y="${height - padding.bottom + 36}" fill="#64748b" font-size="10" font-weight="500" text-anchor="middle">${s.accuracy}% Accuracy</text>
        `;
    });

    svg += '</svg>';
    container.innerHTML = svg;
}

// Helper: Render Subject Cards Grid
function renderSubjectCards(subjectAnalysis) {
    const dom = getTestDOM();
    const container = dom.subjectCardsGrid || document.getElementById("subjectCardsGrid");
    if (!container) return;

    const subjects = Object.values(subjectAnalysis || {});
    if (subjects.length === 0) {
        container.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: #64748b; padding: 2rem;">No subject breakdown available.</div>';
        return;
    }

    let html = "";
    for (const sub of subjects) {
        const accuracy = sub.accuracy != null ? sub.accuracy : 0;
        const totalMarks = sub.maximumMarks > 0 ? sub.maximumMarks : 0;
        const score = sub.score;

        html += `
            <div class="subject-card">
                <div class="subject-card-header">
                    <h4 class="subject-card-title">${escapeHTML(sub.subjectName)}</h4>
                    <span class="subject-badge">${escapeHTML(sub.subjectId)}</span>
                </div>
                <div class="subject-card-score-row">
                    <div>
                        <span class="subject-score-val">${score}</span>
                        <span class="subject-score-max">/ ${totalMarks} Marks</span>
                    </div>
                    <div style="text-align: right;">
                        <span style="font-size: 1.25rem; font-weight: 800; color: #2563eb;">${accuracy}%</span>
                        <div style="font-size: 0.75rem; color: #64748b; font-weight: 600;">Accuracy</div>
                    </div>
                </div>
                <table class="subject-stats-table">
                    <tr>
                        <td>Total Questions</td>
                        <td>${sub.totalQuestions}</td>
                    </tr>
                    <tr>
                        <td>Correct Answers</td>
                        <td style="color: #16a34a;">${sub.correct}</td>
                    </tr>
                    <tr>
                        <td>Incorrect Answers</td>
                        <td style="color: #dc2626;">${sub.incorrect}</td>
                    </tr>
                    <tr>
                        <td>Unattempted</td>
                        <td>${sub.unattempted}</td>
                    </tr>
                    ${sub.dropped > 0 ? `
                    <tr>
                        <td>Dropped (Bonus)</td>
                        <td style="color: #d97706;">${sub.dropped}</td>
                    </tr>
                    ` : ""}
                </table>
            </div>
        `;
    }

    container.innerHTML = html;
}

// -------------------------------------------------------------
// 7. Performance Analysis & Review Rendering
// -------------------------------------------------------------
function renderResults(result) {
    if (!result || typeof result !== "object") {
        throw new Error("Invalid submission result payload: result object is missing or null.");
    }
    lastResult = result;

    const dom = getTestDOM();
    if (dom.testView) dom.testView.style.display = "none";
    if (dom.reviewView) dom.reviewView.style.display = "none";
    if (dom.resultView) dom.resultView.style.display = "block";

    // Validate Required Result DOM Elements
    const requiredKeys = [
        "resTotalScore",
        "resMaxScore",
        "resPercentage",
        "resAccuracy",
        "resTotalQuestions",
        "resCorrect",
        "resIncorrect",
        "resUnanswered"
    ];
    const missingKeys = requiredKeys.filter(k => !dom[k]);
    if (missingKeys.length > 0) {
        const missingIds = missingKeys.map(k => `#${k}`).join(", ");
        logDiag("RESULT_DOM_VALIDATION_FAILED", { missingIds });
        throw new Error(`Cannot render test results: missing required DOM elements (${missingIds}).`);
    }

    // Overall Score & Percentage
    dom.resTotalScore.textContent = result.totalScore;
    dom.resMaxScore.textContent = `out of ${result.maximumMarks}`;

    const percentage = result.percentageScore != null
        ? result.percentageScore
        : (result.maximumMarks > 0 ? Number(((result.totalScore / result.maximumMarks) * 100).toFixed(2)) : 0);
    dom.resPercentage.textContent = `${percentage}%`;

    // Overview Stats
    dom.resAccuracy.textContent = `${result.accuracyPercent}%`;
    dom.resTotalQuestions.textContent = result.totalQuestions || (result.correctCount + result.incorrectCount + result.unansweredCount);
    dom.resCorrect.textContent = result.correctCount;
    dom.resIncorrect.textContent = result.incorrectCount;
    dom.resUnanswered.textContent = result.unansweredCount;

    // Dropped Questions (Conditional)
    const droppedCount = result.droppedCount || 0;
    if (dom.resDroppedBox) {
        dom.resDroppedBox.style.display = droppedCount > 0 ? "block" : "none";
        if (dom.resDropped) dom.resDropped.textContent = droppedCount;
    }

    // Time Taken (Conditional)
    if (dom.resTimeTaken) {
        dom.resTimeTaken.textContent = formatTimeTaken(result.timeTakenSeconds);
    }

    // Pending Manual Evaluation Notice Handling (DEFECT 01)
    let pendingNoticeEl = dom.resPendingNotice;
    if (!pendingNoticeEl && dom.resultView) {
        pendingNoticeEl = document.createElement("div");
        pendingNoticeEl.id = "resPendingNotice";
        pendingNoticeEl.style.cssText = "display: none; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 2rem; color: #92400e; font-size: 0.9rem;";
        const legacyEl = dom.resLegacyNotice;
        if (legacyEl && legacyEl.parentNode) {
            legacyEl.parentNode.insertBefore(pendingNoticeEl, legacyEl);
        }
    }
    const isPendingReview = Boolean(result.requiresManualEvaluation || result.isFinalized === false || (result.pendingReviewCount && result.pendingReviewCount > 0));
    if (pendingNoticeEl) {
        if (isPendingReview) {
            pendingNoticeEl.style.display = "block";
            const reviewCount = result.pendingReviewCount || 1;
            pendingNoticeEl.innerHTML = `<strong>Evaluation In Progress:</strong> This examination contains ${reviewCount} descriptive/subjective question${reviewCount > 1 ? "s" : ""} awaiting manual evaluation. Scores shown represent objective components only and are provisional.`;
            if (dom.resMaxScore) {
                dom.resMaxScore.textContent = `out of ${result.maximumMarks} (Provisional)`;
            }
        } else {
            pendingNoticeEl.style.display = "none";
        }
    }

    // Legacy Notice Handling
    const legacyNotice = result.subjectAnalysis?.unclassified?.legacyNotice;
    if (dom.resLegacyNotice && dom.resLegacyNoticeText) {
        if (legacyNotice) {
            dom.resLegacyNotice.style.display = "block";
            dom.resLegacyNoticeText.textContent = legacyNotice;
        } else {
            dom.resLegacyNotice.style.display = "none";
        }
    }

    // Render Subject-wise Score Cards
    renderSubjectCards(result.subjectAnalysis || {});

    // Render Section-wise Score Cards
    renderSectionCards(result.sectionAnalysis || result.sectionScores || result.sections || (result.sectionBreakdown ? Object.values(result.sectionBreakdown) : null));

    // Render Subject-wise Performance Chart
    renderSubjectPerformanceChart(result.subjectAnalysis || {});

    window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderSectionCards(sectionScores) {
    const dom = getTestDOM();
    const container = dom.sectionCardsGrid || document.getElementById("sectionCardsGrid");
    const sectionSection = dom.sectionAnalysisSection || document.getElementById("sectionAnalysisSection");
    if (!container || !sectionSection) return;

    let sections = [];
    if (Array.isArray(sectionScores)) {
        sections = sectionScores;
    } else if (sectionScores && typeof sectionScores === "object") {
        for (const [key, val] of Object.entries(sectionScores)) {
            if (typeof val === "number") {
                sections.push({
                    sectionId: key,
                    sectionName: key,
                    score: val
                });
            } else if (val && typeof val === "object") {
                sections.push(val);
            }
        }
    }

    if (sections.length === 0) {
        sectionSection.style.display = "none";
        return;
    }

    sectionSection.style.display = "block";
    let html = "";
    for (const sec of sections) {
        const secName = sec.sectionName || sec.name || sec.sectionId || sec.id || "Section";
        const score = Number.isFinite(sec.score) ? sec.score : (sec.scoreRational ? sec.scoreRational.toNumber(2) : 0);
        const attempted = sec.attemptedCount || sec.attempted || 0;
        const totalQ = sec.totalQuestions || 0;
        const correct = sec.correctCount || sec.correct || 0;
        const incorrect = sec.incorrectCount || sec.incorrect || 0;
        const maxMarks = Number.isFinite(sec.maximumMarks) ? sec.maximumMarks : (Number.isFinite(sec.maximumPossibleMarks) ? sec.maximumPossibleMarks : null);

        html += `
            <div class="subject-card">
                <div class="subject-card-header">
                    <h4 class="subject-card-title">${escapeHTML(secName)}</h4>
                    <span class="subject-badge">${escapeHTML(sec.sectionId || sec.id || "Section")}</span>
                </div>
                <div class="subject-stats-row">
                    <div class="subject-stat">
                        <span class="subject-stat-val">${score}${maxMarks !== null ? ` / ${maxMarks}` : ""}</span>
                        <span class="subject-stat-lbl">Score (Marks)</span>
                    </div>
                    <div class="subject-stat">
                        <span class="subject-stat-val" style="color: #16a34a;">${correct}</span>
                        <span class="subject-stat-lbl">Correct</span>
                    </div>
                    <div class="subject-stat">
                        <span class="subject-stat-val" style="color: #dc2626;">${incorrect}</span>
                        <span class="subject-stat-lbl">Incorrect</span>
                    </div>
                    <div class="subject-stat">
                        <span class="subject-stat-val">${attempted} / ${totalQ}</span>
                        <span class="subject-stat-lbl">Attempted (Questions)</span>
                    </div>
                </div>
            </div>
        `;
    }
    container.innerHTML = html;
}

// -------------------------------------------------------------
// 7b. Open Review Exam Mode
// -------------------------------------------------------------
async function openReviewExam(attemptId) {
    if (!attemptId) {
        alert("No attempt ID found for review.");
        return;
    }

    try {
        let token = await getAuthToken();
        if (!token) {
            showSessionExpiryPrompt();
            throw new Error("You must be signed in to review this examination.");
        }

        const dom = getTestDOM();
        if (dom.btnReviewExam) {
            dom.btnReviewExam.disabled = true;
            dom.btnReviewExam.textContent = "Loading Review...";
        }

        const res = await fetch(getApiUrl(`/api/mock-tests/attempts/${encodeURIComponent(attemptId)}/review`), {
            headers: { "Authorization": `Bearer ${token}` }
        });

        const currentDom = getTestDOM();
        if (currentDom.btnReviewExam) {
            currentDom.btnReviewExam.disabled = false;
            currentDom.btnReviewExam.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                Review Exam
            `;
        }

        if (res.status === 401) {
            token = await getAuthToken(true);
            if (token) {
                return openReviewExam(attemptId);
            } else {
                showSessionExpiryPrompt();
                throw new Error("Your session has expired. Please sign in to view the review.");
            }
        }

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `Failed to fetch review (HTTP ${res.status})`);
        }

        const data = await res.json();
        reviewExamData = data;
        reviewQuestions = data.questions || [];

        // Switch to Review View
        restoreReviewViewTemplate();
        const activeDom = getTestDOM();
        if (activeDom.resultView) activeDom.resultView.style.display = "none";
        if (activeDom.testView) activeDom.testView.style.display = "none";
        if (activeDom.catalogView) activeDom.catalogView.style.display = "none";
        if (activeDom.reviewView) activeDom.reviewView.style.display = "block";
        window.scrollTo({ top: 0, behavior: "smooth" });

        // Populate Header & Summary Pills
        if (activeDom.reviewExamTitle) activeDom.reviewExamTitle.textContent = `${data.testTitle || "Mock Test"} — Paper Review`;
        if (activeDom.revSummaryTotal) activeDom.revSummaryTotal.textContent = data.summary.totalQuestions;
        if (activeDom.revSummaryCorrect) activeDom.revSummaryCorrect.textContent = data.summary.correctCount;
        if (activeDom.revSummaryIncorrect) activeDom.revSummaryIncorrect.textContent = data.summary.incorrectCount;
        if (activeDom.revSummaryUnattempted) activeDom.revSummaryUnattempted.textContent = data.summary.unansweredCount;

        if (activeDom.revSummaryDroppedPill) {
            if (data.summary.droppedCount > 0) {
                activeDom.revSummaryDroppedPill.style.display = "inline-flex";
                if (activeDom.revSummaryDropped) activeDom.revSummaryDropped.textContent = data.summary.droppedCount;
            } else {
                activeDom.revSummaryDroppedPill.style.display = "none";
            }
        }

        if (activeDom.revLegendDropped) {
            activeDom.revLegendDropped.style.display = data.summary.droppedCount > 0 ? "flex" : "none";
        }

        // Initialize Filter Buttons & State
        selectedReviewSubject = "all";
        selectedReviewStatus = "all";
        currentReviewQuestionId = null;
        currentReviewIndex = 0;
        renderReviewSubjectFilters();

        const statusBtns = document.querySelectorAll("#reviewStatusFilters .filter-btn");
        statusBtns.forEach(b => {
            const bStatus = normalizeReviewStatus(b.getAttribute("data-status"));
            b.classList.toggle("active", bStatus === "all");
        });

        // Filter and Render Question 0
        filterReviewQuestions();
        renderReviewQuestion(0);

    } catch (err) {
        alert(`Error opening review: ${err.message}`);
    }
}

// Normalize status identifiers across variations (canonical lowercase: 'all', 'correct', 'incorrect', 'unattempted', 'dropped')
function normalizeReviewStatus(status) {
    if (!status) return "all";
    const s = String(status).toLowerCase().trim();
    if (s === "all") return "all";
    if (s === "correct") return "correct";
    if (s === "incorrect" || s === "wrong") return "incorrect";
    if (s === "unattempted" || s === "unanswered" || s === "not_attempted") return "unattempted";
    if (s === "dropped") return "dropped";
    if (s === "pending_manual_review") return "pending_manual_review";
    if (s === "manually_graded") return "manually_graded";
    return s;
}

// Set active status filter and re-render questions and palette
function setReviewStatusFilter(rawStatus) {
    const norm = normalizeReviewStatus(rawStatus);
    selectedReviewStatus = norm;

    // Update active class on status buttons
    const container = document.getElementById("reviewStatusFilters");
    if (container) {
        container.querySelectorAll(".filter-btn").forEach(b => {
            const bStatus = normalizeReviewStatus(b.getAttribute("data-status"));
            b.classList.toggle("active", bStatus === norm);
        });
    }

    // Apply filtering pipeline
    filterReviewQuestions();

    // Preserve current question if it still matches the newly filtered set; otherwise jump to 0
    let nextIndex = 0;
    if (currentReviewQuestionId && filteredReviewQuestions.length > 0) {
        const existingIdx = filteredReviewQuestions.findIndex(q => q.questionId === currentReviewQuestionId);
        if (existingIdx !== -1) {
            nextIndex = existingIdx;
        }
    }
    renderReviewQuestion(nextIndex);
}

// Render dynamic Subject Filter Buttons in Review Mode
function renderReviewSubjectFilters() {
    const container = document.getElementById("reviewSubjectFilters");
    if (!container || !reviewQuestions) return;

    const subSet = new Map();
    for (const q of reviewQuestions) {
        const sId = q.subjectId || (q.subject ? q.subject.toLowerCase().replace(/\s+/g, "_") : "general");
        const sName = q.subjectName || q.subject || "General";
        if (sId && !subSet.has(sId)) {
            subSet.set(sId, sName);
        }
    }

    let html = `<button type="button" class="filter-btn ${selectedReviewSubject === "all" ? "active" : ""}" data-subject="all">All Subjects</button>`;
    for (const [sId, sName] of subSet.entries()) {
        const isActive = (selectedReviewSubject.toLowerCase() === sId.toLowerCase());
        html += `<button type="button" class="filter-btn ${isActive ? "active" : ""}" data-subject="${escapeHTML(sId)}">${escapeHTML(sName)}</button>`;
    }
    container.innerHTML = html;

    container.querySelectorAll(".filter-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            container.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            selectedReviewSubject = btn.getAttribute("data-subject") || "all";
            filterReviewQuestions();

            let nextIndex = 0;
            if (currentReviewQuestionId && filteredReviewQuestions.length > 0) {
                const existingIdx = filteredReviewQuestions.findIndex(q => q.questionId === currentReviewQuestionId);
                if (existingIdx !== -1) {
                    nextIndex = existingIdx;
                }
            }
            renderReviewQuestion(nextIndex);
        });
    });
}

// Filter Review Questions based on Subject & Status (Predictable Pipeline: Dataset -> Subject -> Status)
function filterReviewQuestions() {
    const normFilterStatus = normalizeReviewStatus(selectedReviewStatus);
    const normFilterSubject = (selectedReviewSubject || "all").trim();

    filteredReviewQuestions = reviewQuestions.filter(q => {
        // 1. Subject filter
        let matchesSubject = true;
        if (normFilterSubject !== "all") {
            const qSubId = String(q.subjectId || "").toLowerCase();
            const qSubName = String(q.subjectName || "").toLowerCase();
            const qSub = String(q.subject || "").toLowerCase();
            const filterSub = normFilterSubject.toLowerCase();
            matchesSubject = (qSubId === filterSub || qSubName === filterSub || qSub === filterSub);
        }

        // 2. Status filter
        let matchesStatus = true;
        if (normFilterStatus !== "all") {
            const qStatus = normalizeReviewStatus(q.status);
            matchesStatus = (qStatus === normFilterStatus);
        }

        return matchesSubject && matchesStatus;
    });

    renderReviewPalette();
}

// Render Review Question Palette (Synchronized with filteredReviewQuestions)
function renderReviewPalette() {
    const grid = document.getElementById("revPaletteGrid");
    if (!grid) return;
    grid.innerHTML = "";

    if (!filteredReviewQuestions || filteredReviewQuestions.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1 / -1; padding: 1.5rem; text-align: center; color: #94a3b8; font-size: 0.85rem;">No questions match this filter.</div>`;
        return;
    }

    filteredReviewQuestions.forEach((q, fIdx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        const normStatus = normalizeReviewStatus(q.status);
        btn.className = `palette-btn ${normStatus}`;
        btn.textContent = q.questionNumber;
        btn.setAttribute("data-filtered-index", String(fIdx));
        btn.setAttribute("data-question-id", String(q.questionId));
        btn.setAttribute("data-question-number", String(q.questionNumber));

        if (fIdx === currentReviewIndex) {
            btn.classList.add("current");
        }

        btn.addEventListener("click", () => {
            renderReviewQuestion(fIdx);
        });

        grid.appendChild(btn);
    });
}

// Render Review Question Card
function renderReviewQuestion(index) {
    if (!filteredReviewQuestions || filteredReviewQuestions.length === 0) {
        currentReviewIndex = -1;
        currentReviewQuestionId = null;
        const dom = getTestDOM();
        if (dom.revQNumberBadge) dom.revQNumberBadge.textContent = "No Matches";
        if (dom.revQSubjectBadge) dom.revQSubjectBadge.textContent = "-";
        if (dom.revQStatusBadge) {
            dom.revQStatusBadge.textContent = "-";
            dom.revQStatusBadge.className = "q-badge";
        }
        if (dom.revQMarksBadge) dom.revQMarksBadge.textContent = "-";
        if (dom.revQText) dom.revQText.textContent = "No questions match the currently selected subject and status filter criteria.";
        if (dom.revOptionsContainer) dom.revOptionsContainer.innerHTML = "";
        if (dom.revNumericalDisplay) dom.revNumericalDisplay.style.display = "none";
        if (dom.revDroppedBox) dom.revDroppedBox.style.display = "none";
        if (dom.revCorrectAnswerBox) dom.revCorrectAnswerBox.style.display = "none";
        if (dom.revDiagramBox) dom.revDiagramBox.style.display = "none";
        if (dom.revCurrentStatusIndicator) dom.revCurrentStatusIndicator.textContent = "0 of 0";
        if (dom.btnRevPrev) dom.btnRevPrev.disabled = true;
        if (dom.btnRevNext) dom.btnRevNext.disabled = true;
        return;
    }

    if (index < 0) index = 0;
    if (index >= filteredReviewQuestions.length) index = filteredReviewQuestions.length - 1;
    currentReviewIndex = index;

    const q = filteredReviewQuestions[index];
    currentReviewQuestionId = q ? q.questionId : null;

    const dom = getTestDOM();

    // Badges: Show Question X of Total (all review questions)
    const totalQCount = reviewQuestions.length;
    if (dom.revQNumberBadge) dom.revQNumberBadge.textContent = `Question ${q.questionNumber} of ${totalQCount}`;
    if (dom.revQSubjectBadge) dom.revQSubjectBadge.textContent = q.subjectName || q.subject || "General";

    const normStatus = normalizeReviewStatus(q.status);
    if (dom.revQStatusBadge) {
        dom.revQStatusBadge.className = `q-badge status-${normStatus}`;
        if (normStatus === "correct") {
            dom.revQStatusBadge.textContent = "Correct";
        } else if (normStatus === "incorrect") {
            dom.revQStatusBadge.textContent = "Incorrect";
        } else if (normStatus === "dropped") {
            dom.revQStatusBadge.textContent = "Dropped (Bonus)";
        } else if (normStatus === "pending_manual_review") {
            dom.revQStatusBadge.textContent = "Pending Evaluation";
            dom.revQStatusBadge.className = "q-badge status-pending-review";
        } else if (normStatus === "manually_graded") {
            dom.revQStatusBadge.textContent = "Manually Graded";
            dom.revQStatusBadge.className = "q-badge status-manually-graded";
        } else {
            dom.revQStatusBadge.textContent = "Unattempted";
        }
    }

    if (dom.revQMarksBadge) {
        if (normStatus === "dropped") {
            dom.revQMarksBadge.textContent = `+${q.marksAwarded} Bonus`;
            dom.revQMarksBadge.style.color = "#d97706";
        } else if (normStatus === "correct" || (normStatus === "manually_graded" && (q.marksAwarded || 0) > 0)) {
            dom.revQMarksBadge.textContent = `+${q.marksAwarded} Marks`;
            dom.revQMarksBadge.style.color = "#16a34a";
        } else if (normStatus === "incorrect") {
            dom.revQMarksBadge.textContent = `${q.marksAwarded} Marks`;
            dom.revQMarksBadge.style.color = "#dc2626";
        } else if (normStatus === "pending_manual_review") {
            dom.revQMarksBadge.textContent = "Pending Review";
            dom.revQMarksBadge.style.color = "#d97706";
        } else {
            dom.revQMarksBadge.textContent = "0 Marks";
            dom.revQMarksBadge.style.color = "#64748b";
        }
    }

    // Stem
    if (dom.revQText) dom.revQText.textContent = q.questionText || "";

    // Diagram reference
    const diagramBox = dom.revDiagramBox || document.getElementById("revDiagramBox");
    if (diagramBox) {
        if (q.diagramUrl || q.hasDiagram) {
            diagramBox.style.display = "block";
            let diagHtml = "";
            if (q.diagramUrl) {
                diagHtml += `<div style="text-align: center; margin-bottom: 8px;">
                    <img src="${escapeHTML(q.diagramUrl)}" alt="Question Diagram" style="max-width: 100%; max-height: 380px; object-fit: contain; border-radius: 4px; background: #ffffff;" />
                </div>`;
            }
            diagHtml += `<div><strong>Source Reference:</strong> Diagram / Figure referenced in source paper (Page <span id="revSourcePageNum">${escapeHTML(String(q.sourcePage || 1))}</span>).</div>`;
            diagramBox.innerHTML = diagHtml;
        } else {
            diagramBox.style.display = "none";
        }
    }

    // Dropped Question Notice
    const droppedBox = dom.revDroppedBox || document.getElementById("revDroppedBox");
    if (droppedBox) {
        droppedBox.style.display = (normStatus === "dropped") ? "block" : "none";
    }

    // Options Container & Numerical Display
    const optionsContainer = dom.revOptionsContainer || document.getElementById("revOptionsContainer");
    const numericalDisplay = dom.revNumericalDisplay || document.getElementById("revNumericalDisplay");
    const numericalValue = dom.revNumericalValue || document.getElementById("revNumericalValue");

    const isNumerical = q.questionType === "numerical";

    if (isNumerical) {
        if (optionsContainer) {
            optionsContainer.style.display = "none";
            optionsContainer.innerHTML = "";
        }
        if (numericalDisplay) numericalDisplay.style.display = "block";
        if (numericalValue) {
            numericalValue.textContent = (q.studentAnswer !== null && q.studentAnswer !== undefined && q.studentAnswer !== "")
                ? (typeof q.studentAnswer === "object" ? JSON.stringify(q.studentAnswer) : q.studentAnswer)
                : "No numerical response submitted (Unattempted)";
            if (normStatus === "correct") {
                numericalValue.style.color = "#16a34a";
            } else if (normStatus === "incorrect") {
                numericalValue.style.color = "#dc2626";
            } else {
                numericalValue.style.color = "#64748b";
            }
        }
    } else {
        if (numericalDisplay) numericalDisplay.style.display = "none";
        if (optionsContainer) {
            optionsContainer.style.display = "flex";
            optionsContainer.innerHTML = "";

            const studentAns = (q.studentAnswer !== null && q.studentAnswer !== undefined) ? (Array.isArray(q.studentAnswer) ? q.studentAnswer.map(s => String(s).trim()) : [String(q.studentAnswer).trim()]) : [];

            (q.options || []).forEach(opt => {
                const optId = String(opt.id || opt.label).trim();
                const optLabel = String(opt.label || opt.id).trim();
                const isStudentSelection = (studentAns.length > 0 && (studentAns.includes(optId) || studentAns.includes(optLabel)));

                let optClass = "option-item review-option-item";
                if (isStudentSelection) {
                    if (normStatus === "correct") {
                        optClass += " student-correct";
                    } else if (normStatus === "incorrect") {
                        optClass += " student-incorrect";
                    }
                }

                const itemDiv = document.createElement("div");
                itemDiv.className = optClass;

                const labelSpan = document.createElement("span");
                labelSpan.className = "option-label";
                labelSpan.textContent = optLabel;

                const textSpan = document.createElement("span");
                textSpan.className = "option-text";
                textSpan.textContent = opt.text || "";

                itemDiv.appendChild(labelSpan);
                itemDiv.appendChild(textSpan);

                if (opt.diagramUrl) {
                    const optImg = document.createElement("img");
                    optImg.src = opt.diagramUrl;
                    optImg.alt = `Option ${optLabel} diagram`;
                    optImg.style.cssText = "max-height: 90px; max-width: 180px; object-fit: contain; vertical-align: middle; margin-left: 8px; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff;";
                    itemDiv.appendChild(optImg);
                }

                if (isStudentSelection) {
                    const tagSpan = document.createElement("span");
                    tagSpan.style.fontSize = "0.78rem";
                    tagSpan.style.fontWeight = "700";
                    tagSpan.style.marginLeft = "auto";
                    tagSpan.style.padding = "2px 8px";
                    tagSpan.style.borderRadius = "4px";

                    if (normStatus === "correct") {
                        tagSpan.style.background = "#dcfce7";
                        tagSpan.style.color = "#15803d";
                        tagSpan.textContent = "Your Answer (Correct)";
                    } else {
                        tagSpan.style.background = "#fee2e2";
                        tagSpan.style.color = "#991b1b";
                        tagSpan.textContent = "Your Answer (Incorrect)";
                    }
                    itemDiv.appendChild(tagSpan);
                }

                optionsContainer.appendChild(itemDiv);
            });
        }
    }

    // Correct Answer Box (only for incorrect questions)
    const correctBox = dom.revCorrectAnswerBox || document.getElementById("revCorrectAnswerBox");
    const correctText = dom.revCorrectAnswerText || document.getElementById("revCorrectAnswerText");

    if (normStatus === "incorrect" && q.correctAnswer) {
        if (correctBox) correctBox.style.display = "block";
        if (correctText) {
            if (q.correctAnswer.type === "numerical") {
                correctText.textContent = q.correctAnswer.value;
            } else if (q.correctAnswer.type === "msq") {
                correctText.textContent = q.correctAnswer.text || `Options: ${q.correctAnswer.optionLabels}`;
            } else {
                correctText.textContent = `Option ${q.correctAnswer.optionLabel}: ${q.correctAnswer.text}`;
            }
        }
    } else {
        if (correctBox) correctBox.style.display = "none";
        if (correctText) correctText.textContent = "";
    }

    // Counter & Navigation State
    if (dom.revCurrentStatusIndicator) dom.revCurrentStatusIndicator.textContent = `Question ${index + 1} of ${filteredReviewQuestions.length}`;
    if (dom.btnRevPrev) dom.btnRevPrev.disabled = (index === 0);
    if (dom.btnRevNext) dom.btnRevNext.disabled = (index === filteredReviewQuestions.length - 1);

    // Update Palette active class
    const paletteBtns = document.querySelectorAll("#revPaletteGrid .palette-btn");
    paletteBtns.forEach((btn, pIdx) => {
        btn.classList.toggle("current", pIdx === index);
    });
}

// -------------------------------------------------------------
// 8. Event Listeners & Auth State Lifecycle
// -------------------------------------------------------------
// Initial bind of session, result, and review controls to DOM elements
bindSessionControls();
bindResultControls();
bindReviewControls();

// Initialize on DOM Ready with auth state listener
function initMockTestCatalog() {
    onAuthStateChanged(auth, (user) => {
        const prevUser = currentUser;
        currentUser = user;

        // Re-render catalog cards with appropriate lock badge or Start button (preserving current search/sort)
        if (catalogView && catalogView.style.display !== "none" && publishedTests.length > 0) {
            applyCatalogFilters();
        }

        // Handle session recovery if session expiry modal was open
        if (user && activeAttempt && activeAttempt.userId === user.uid) {
            hideSessionExpiryPrompt();
            performAutosave();
        }

        // If user transitioned from unauthenticated to authenticated, check pending test ID
        if (!prevUser && user) {
            const pendingId = sessionStorage.getItem("pendingMockTestId");
            if (pendingId) {
                sessionStorage.removeItem("pendingMockTestId");
                promptLanguageSelection(pendingId);
            } else {
                const urlParams = new URLSearchParams(window.location.search);
                const paramTestId = urlParams.get("test");
                if (paramTestId) {
                    window.history.replaceState({}, document.title, window.location.pathname);
                    promptLanguageSelection(paramTestId);
                }
            }
        }
    });

    loadCatalog();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMockTestCatalog);
} else {
    initMockTestCatalog();
}

// Refresh catalog when page is revisited or tab gains visibility/focus
window.addEventListener("pageshow", () => {
    if (catalogView && catalogView.style.display !== "none") {
        loadCatalog();
    }
});

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && catalogView && catalogView.style.display !== "none") {
        loadCatalog();
    }
});

window.addEventListener("focus", () => {
    if (catalogView && catalogView.style.display !== "none") {
        loadCatalog();
    }
});

// Expose session lifecycle helpers for testing and external trigger
window.startTestSession = startTestSession;
window.promptLanguageSelection = promptLanguageSelection;

// Phase 5.13 — Expose review mode functions for testability and verification
window.openReviewExam = openReviewExam;
window.setReviewStatusFilter = setReviewStatusFilter;
window.normalizeReviewStatus = normalizeReviewStatus;
window.filterReviewQuestions = filterReviewQuestions;
window.renderReviewPalette = renderReviewPalette;
window.renderReviewQuestion = renderReviewQuestion;
window.getFilteredReviewQuestions = () => filteredReviewQuestions;
window.getReviewQuestions = () => reviewQuestions;
window.getSelectedReviewStatus = () => selectedReviewStatus;
window.getSelectedReviewSubject = () => selectedReviewSubject;
