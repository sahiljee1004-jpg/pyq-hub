// ============================================================
// VIDYARTHIASTRA — DEDICATED PYQ LIBRARY MODULE
// Examination-First Browsing Architecture:
// PYQ Library -> Select Examination -> Select Available Year -> Browse Question Papers -> Preview / Download
// Supports Hybrid Backend API + Direct Firestore Fallback for 100% Reliability
// ============================================================

import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
    collection,
    getDocs,
    doc,
    getDoc,
    updateDoc,
    increment
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { showAuthModal, ensureAuthModal } from "./auth.js";
import { PdfViewerController, downloadPdfFile, cleanFileName, escapeHTML, safeURL } from "./pdf-viewer-core.js";
import { SkeletonManager } from "./skeleton-manager.js";

// Clean inline SVGs (strictly no emojis)
const ICONS = {
    pdf: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`,
    calendar: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`,
    clock: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
    book: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`,
    eye: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
    download: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
    search: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
    examArchive: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
    arrowRight: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`
};

// Global Controller State
let pdfViewerController = null;
let currentViewMode = "exams"; // "exams" | "years" | "papers"
let allAvailableExams = [];
let filteredExams = [];
let selectedExam = null;
let selectedYear = null;
let currentPapersCursor = null;
let isPapersFetching = false;
let displayedPaperIds = new Set();

// Elements — Toolbar & Search
const totalCountNumEl = document.getElementById("totalPyqCountNum");
const searchInputEl = document.getElementById("pyqSearchInput");
const searchClearBtnEl = document.getElementById("pyqClearBtn");
const searchBtnEl = document.getElementById("pyqSearchBtn");

// Elements — Breadcrumbs
const breadcrumbsNavEl = document.getElementById("pyqBreadcrumbsContainer");
const bcHomeBtn = document.getElementById("bcHome");
const bcExamItem = document.getElementById("bcExamItem");
const bcExamBtn = document.getElementById("bcExam");
const bcExamSep = document.getElementById("bcExamSep");
const bcYearItem = document.getElementById("bcYearItem");
const bcYearSpan = document.getElementById("bcYear");
const bcYearSep = document.getElementById("bcYearSep");

// Elements — Section 1: Exams
const examsSectionEl = document.getElementById("examsSection");
const examsGridEl = document.getElementById("examsGrid");
const examsLoadingEl = document.getElementById("examsLoading");
const examsEmptyEl = document.getElementById("examsEmpty");
const examsEmptyDescEl = document.getElementById("examsEmptyDesc");
const examsErrorEl = document.getElementById("examsError");
const examsRetryBtn = document.getElementById("examsRetryBtn");

// Elements — Section 2: Years
const yearsSectionEl = document.getElementById("yearsSection");
const backToExamsBtn = document.getElementById("backToExamsBtn");
const yearsExamTitleEl = document.getElementById("yearsExamTitle");
const yearsExamSubtitleEl = document.getElementById("yearsExamSubtitle");
const yearsGridEl = document.getElementById("yearsGrid");
const yearsLoadingEl = document.getElementById("yearsLoading");
const yearsEmptyEl = document.getElementById("yearsEmpty");
const yearsErrorEl = document.getElementById("yearsError");
const yearsRetryBtn = document.getElementById("yearsRetryBtn");

// Elements — Section 3: Papers
const papersSectionEl = document.getElementById("papersSection");
const backToYearsBtn = document.getElementById("backToYearsBtn");
const papersSectionTitleEl = document.getElementById("papersSectionTitle");
const papersSectionSubtitleEl = document.getElementById("papersSectionSubtitle");
const papersGridEl = document.getElementById("papersGrid");
const papersLoadingEl = document.getElementById("papersLoading");
const papersEmptyEl = document.getElementById("papersEmpty");
const papersErrorEl = document.getElementById("papersError");
const papersRetryBtn = document.getElementById("papersRetryBtn");
const loadMoreContainerEl = document.getElementById("loadMoreContainer");
const loadMoreBtnEl = document.getElementById("loadMoreBtn");

const footerYearEl = document.getElementById("year");
if (footerYearEl) {
    footerYearEl.textContent = new Date().getFullYear();
}

// Category keyword synonym map for intelligent homepage search redirection
const CATEGORY_SYNONYMS = {
    "ssc": ["ssc", "cgl", "chsl", "cpo", "gd", "mts", "steno"],
    "banking": ["banking", "rbi", "sbi", "bank", "clerk", "po"],
    "railway": ["railway", "rrb", "alp", "ntpc"],
    "board": ["board", "class x", "class 10", "10th", "12th"],
    "upsc": ["upsc", "capf", "cds", "cms", "nda", "ifos", "ese", "civil"],
    "state pcs": ["pcs", "bpsc", "jpsc", "state", "police"],
    "pcs": ["pcs", "bpsc", "jpsc", "state"],
    "nda": ["nda"],
    "cds": ["cds"],
    "jee": ["jee", "wbjee", "iit", "engineering", "comedk"],
    "neet": ["neet", "medical", "cms"],
    "gate": ["gate"],
    "cuet": ["cuet", "ugc", "net"]
};

// ============================================================
// INITIALIZATION
// ============================================================

export function initPyqLibrary() {
    pdfViewerController = new PdfViewerController();
    ensureAuthModal();

    loadTotalCount();
    loadAvailableExams();

    setupSearchEvents();
    setupNavigationEvents();
    setupAuthListeners();
}

// ============================================================
// TOTAL PYQ COUNTER
// ============================================================

async function loadTotalCount() {
    if (!totalCountNumEl) return;
    try {
        const res = await fetch("/api/papers/stats");
        if (res.ok) {
            const data = await res.json();
            if (data.success && typeof data.totalPapers === "number" && data.totalPapers > 0) {
                totalCountNumEl.textContent = Number(data.totalPapers).toLocaleString();
                return;
            }
        }
    } catch (err) {
        // Fallback below
    }
    // Default verified count from Firestore (34 exams, 100 years, 515+ question papers)
    totalCountNumEl.textContent = "515+";
}

// ============================================================
// SECTION 1: EXAMINATIONS DIRECTORY
// ============================================================

async function fetchExamsFromFirestore() {
    try {
        const examsRef = collection(db, "exams");
        const snapshot = await getDocs(examsRef);
        const exams = [];
        
        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            const id = docSnap.id;
            const name = (data.name || data.title || id).trim();
            exams.push({
                id: id,
                name: name,
                description: data.description || "",
                icon: data.icon || "🎓",
                paperCount: data.paperCount || 0,
                yearCount: data.yearCount || 0,
                yearRange: data.yearRange || ""
            });
        });

        // Alphabetical sort by clean name
        exams.sort((a, b) => a.name.localeCompare(b.name));
        return exams;
    } catch (err) {
        console.error("[PYQ Library] Firestore fetchExams error:", err);
        return [];
    }
}

async function loadAvailableExams(forceRefresh = false) {
    if (examsGridEl) examsGridEl.style.display = "grid";
    if (examsLoadingEl) examsLoadingEl.style.display = "none";
    const skeletonExams = SkeletonManager.mount(
        examsGridEl,
        () => SkeletonManager.templates.pyqExams(6),
        { delay: 200, ariaLabel: "Loading examinations directory..." }
    );

    let exams = [];

    // 1. Try Express backend API
    try {
        const res = await fetch(`/api/papers/exams${forceRefresh ? "?refresh=true" : ""}`);
        if (res.ok) {
            const data = await res.json();
            if (data.success && Array.isArray(data.exams) && data.exams.length > 0) {
                exams = data.exams;
            }
        }
    } catch (apiErr) {
        console.warn("[PYQ Library] API exams fetch failed, trying direct Firestore fallback:", apiErr.message);
    }

    // 2. Fallback to direct client-side Firestore
    if (!exams || exams.length === 0) {
        exams = await fetchExamsFromFirestore();
    }

    if (exams && exams.length > 0) {
        allAvailableExams = exams;
        filteredExams = [...allAvailableExams];

        skeletonExams.dismiss(() => {
            const urlParams = new URLSearchParams(window.location.search);
            const query = urlParams.get("search") || urlParams.get("exam");
            if (query) {
                if (searchInputEl) searchInputEl.value = query;
                if (searchClearBtnEl) searchClearBtnEl.style.display = "flex";
                applyExamFilter(query);
            } else if (filteredExams.length > 0) {
                renderExamCards(filteredExams);
                showExamsState("content");
            } else {
                if (examsEmptyDescEl) {
                    examsEmptyDescEl.textContent = "No examination question papers are currently available. Please check back later.";
                }
                showExamsState("empty");
            }
        });
    } else {
        skeletonExams?.cancel();
        console.error("[PYQ Library] Failed to load available examinations from both API and Firestore.");
        showExamsState("error");
    }
}

function renderExamCards(exams) {
    if (!examsGridEl) return;
    examsGridEl.innerHTML = "";

    exams.forEach(exam => {
        const card = document.createElement("article");
        card.className = "pyq-exam-card";
        card.dataset.examId = exam.id;

        const paperCount = exam.paperCount || 0;
        const yearCount = exam.yearCount || 0;
        const yearRange = exam.yearRange || (yearCount > 0 ? `${yearCount} Years` : "Available Years");

        card.innerHTML = `
            <div>
                <div class="pyq-exam-card-header">
                    <div class="pyq-exam-icon">
                        ${ICONS.examArchive}
                    </div>
                    <div class="pyq-exam-title-wrap">
                        <h3 class="pyq-exam-title">${escapeHTML(exam.name || exam.id)}</h3>
                        <div class="pyq-exam-meta-pills">
                            <span class="pyq-exam-pill pyq-exam-pill-papers">
                                ${paperCount > 0 ? `${paperCount} Question Paper${paperCount === 1 ? "" : "s"}` : "PYQs & Solutions"}
                            </span>
                            <span class="pyq-exam-pill pyq-exam-pill-years">
                                ${escapeHTML(yearRange)}
                            </span>
                        </div>
                    </div>
                </div>
                ${exam.description ? `<p style="font-size:0.85rem; color:#64748b; margin:10px 0 0 0; line-height:1.4;">${escapeHTML(exam.description)}</p>` : ""}
            </div>
            <div class="pyq-card-actions">
                <button type="button" class="pyq-btn pyq-btn-primary pyq-browse-exam-btn" style="width: 100%;">
                    <span>Browse Papers</span> ${ICONS.arrowRight}
                </button>
            </div>
        `;

        const triggerAction = () => showYearsView(exam);
        const btn = card.querySelector(".pyq-browse-exam-btn");
        if (btn) btn.addEventListener("click", (e) => {
            e.stopPropagation();
            triggerAction();
        });
        card.addEventListener("click", triggerAction);

        examsGridEl.appendChild(card);
    });
}

function showExamsState(state) {
    if (!examsGridEl) return;
    examsGridEl.style.display = state === "content" ? "grid" : "none";
    if (examsLoadingEl) examsLoadingEl.style.display = state === "loading" ? "block" : "none";
    if (examsEmptyEl) examsEmptyEl.style.display = state === "empty" ? "block" : "none";
    if (examsErrorEl) examsErrorEl.style.display = state === "error" ? "block" : "none";
}

if (examsRetryBtn) {
    examsRetryBtn.addEventListener("click", () => loadAvailableExams(true));
}

// ============================================================
// SECTION 2: AVAILABLE YEARS SELECTION
// ============================================================

async function showYearsView(exam) {
    selectedExam = exam;
    selectedYear = null;
    currentViewMode = "years";

    // Switch section visibility
    if (examsSectionEl) examsSectionEl.style.display = "none";
    if (papersSectionEl) papersSectionEl.style.display = "none";
    if (yearsSectionEl) yearsSectionEl.style.display = "block";

    // Update Breadcrumbs
    updateBreadcrumbs();

    // Update section titles
    if (yearsExamTitleEl) {
        yearsExamTitleEl.textContent = `${exam.name || exam.id} — Select Year`;
    }
    if (yearsExamSubtitleEl) {
        yearsExamSubtitleEl.textContent = `Select an examination year to browse available question papers`;
    }

    // Scroll to top of section smoothly
    yearsSectionEl.scrollIntoView({ behavior: "smooth", block: "start" });

    // Fetch years for selected exam
    if (yearsGridEl) yearsGridEl.style.display = "grid";
    if (yearsLoadingEl) yearsLoadingEl.style.display = "none";
    const skeletonYears = SkeletonManager.mount(
        yearsGridEl,
        () => SkeletonManager.templates.pyqYears(4),
        { delay: 200, ariaLabel: "Loading available examination years..." }
    );

    let years = [];

    // 1. Try API
    try {
        const res = await fetch(`/api/papers/years?examId=${encodeURIComponent(exam.id)}`);
        if (res.ok) {
            const data = await res.json();
            if (data.success && Array.isArray(data.years) && data.years.length > 0) {
                years = data.years;
            }
        }
    } catch (apiErr) {
        console.warn(`[PYQ Library] API years failed for ${exam.id}, falling back to Firestore:`, apiErr.message);
    }

    // 2. Direct Firestore Fallback
    if (!years || years.length === 0) {
        try {
            const yearsRef = collection(db, "exams", exam.id, "years");
            const snapshot = await getDocs(yearsRef);
            const yearsList = [];

            for (const docSnap of snapshot.docs) {
                const yData = docSnap.data();
                const yearVal = yData.year || yData.years || docSnap.id;

                let pCount = yData.paperCount || 0;
                try {
                    const papersRef = collection(db, "exams", exam.id, "years", docSnap.id, "papers");
                    const pSnap = await getDocs(papersRef);
                    pCount = pSnap.size;
                } catch (e) {}

                yearsList.push({
                    year: yearVal,
                    yearId: docSnap.id,
                    paperCount: pCount
                });
            }

            // Sort descending: e.g. 2026, 2025, 2024...
            yearsList.sort((a, b) => String(b.year).localeCompare(String(a.year)));
            years = yearsList;
        } catch (fsErr) {
            console.error(`[PYQ Library] Firestore years failed for ${exam.id}:`, fsErr);
        }
    }

    skeletonYears.dismiss(() => {
        if (years && years.length > 0) {
            renderYearCards(years);
            showYearsState("content");
        } else {
            showYearsState("empty");
        }
    });
}

function renderYearCards(years) {
    if (!yearsGridEl) return;
    yearsGridEl.innerHTML = "";

    years.forEach(yearObj => {
        const card = document.createElement("article");
        card.className = "pyq-year-card";
        card.dataset.year = yearObj.year;

        const count = yearObj.paperCount || 0;

        card.innerHTML = `
            <div class="pyq-year-header">
                <h3 class="pyq-year-number">${escapeHTML(yearObj.year)}</h3>
                <span class="pyq-year-count-badge">
                    ${count > 0 ? `${count} Paper${count === 1 ? "" : "s"}` : "Papers Available"}
                </span>
            </div>
            <div>
                <button type="button" class="pyq-btn pyq-btn-secondary pyq-select-year-btn" style="width: 100%;">
                    <span>View Papers</span> ${ICONS.arrowRight}
                </button>
            </div>
        `;

        const triggerAction = () => showPapersView(selectedExam, yearObj);
        const btn = card.querySelector(".pyq-select-year-btn");
        if (btn) btn.addEventListener("click", (e) => {
            e.stopPropagation();
            triggerAction();
        });
        card.addEventListener("click", triggerAction);

        yearsGridEl.appendChild(card);
    });
}

function showYearsState(state) {
    if (!yearsGridEl) return;
    yearsGridEl.style.display = state === "content" ? "grid" : "none";
    if (yearsLoadingEl) yearsLoadingEl.style.display = state === "loading" ? "block" : "none";
    if (yearsEmptyEl) examsEmptyEl && (yearsEmptyEl.style.display = state === "empty" ? "block" : "none");
    if (yearsErrorEl) yearsErrorEl.style.display = state === "error" ? "block" : "none";
}

if (yearsRetryBtn) {
    yearsRetryBtn.addEventListener("click", () => {
        if (selectedExam) showYearsView(selectedExam);
    });
}

// ============================================================
// SECTION 3: QUESTION PAPERS VIEW
// ============================================================

async function showPapersView(exam, yearObj) {
    selectedExam = exam;
    selectedYear = yearObj;
    currentViewMode = "papers";
    currentPapersCursor = null;
    displayedPaperIds.clear();

    // Switch section visibility
    if (examsSectionEl) examsSectionEl.style.display = "none";
    if (yearsSectionEl) yearsSectionEl.style.display = "none";
    if (papersSectionEl) papersSectionEl.style.display = "block";
    if (loadMoreContainerEl) loadMoreContainerEl.style.display = "none";

    // Update Breadcrumbs
    updateBreadcrumbs();

    const yearKey = yearObj.yearId || yearObj.year;

    // Update section titles
    if (papersSectionTitleEl) {
        papersSectionTitleEl.textContent = `${exam.name || exam.id} — ${yearObj.year} Question Papers`;
    }
    if (papersSectionSubtitleEl) {
        papersSectionSubtitleEl.textContent = `Showing all question papers for ${exam.name || exam.id} (${yearObj.year})`;
    }

    papersSectionEl.scrollIntoView({ behavior: "smooth", block: "start" });

    if (papersGridEl) papersGridEl.style.display = "grid";
    if (papersLoadingEl) papersLoadingEl.style.display = "none";
    const skeletonPapers = SkeletonManager.mount(
        papersGridEl,
        () => SkeletonManager.templates.pyqPapers(6),
        { delay: 200, ariaLabel: "Loading question papers..." }
    );
    isPapersFetching = true;

    let papers = [];
    let hasMore = false;
    let nextCursor = null;

    // 1. Try API
    try {
        const url = `/api/papers/by-year?examId=${encodeURIComponent(exam.id)}&yearId=${encodeURIComponent(yearKey)}&limit=24&cursor=0`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (data.success && Array.isArray(data.papers) && data.papers.length > 0) {
                papers = data.papers;
                hasMore = Boolean(data.hasMore);
                nextCursor = data.nextCursor;
            }
        }
    } catch (apiErr) {
        console.warn(`[PYQ Library] API papers failed for ${exam.id}/${yearKey}, falling back to Firestore:`, apiErr.message);
    }

    // 2. Direct Firestore Fallback
    if (!papers || papers.length === 0) {
        try {
            const papersRef = collection(db, "exams", exam.id, "years", yearKey, "papers");
            const snapshot = await getDocs(papersRef);
            const papersList = [];

            snapshot.forEach(docSnap => {
                const data = docSnap.data();
                const rawPdfUrl = data.pdfUrl || data.pdfurl || data.url || "";
                const rawTitle = data.title || data["title "] || docSnap.id;

                papersList.push({
                    id: docSnap.id,
                    paperId: docSnap.id,
                    examId: exam.id,
                    examName: exam.name || exam.id,
                    yearId: yearKey,
                    year: yearObj.year,
                    title: rawTitle.trim() || (data.date && data.shift ? `${data.date} — ${data.shift}` : docSnap.id),
                    pdfUrl: rawPdfUrl,
                    hasPdf: Boolean(rawPdfUrl),
                    date: data.date || "",
                    shift: data.shift || "",
                    subject: data.subject || "",
                    viewCount: Number(data.viewCount) || 0,
                    downloadCount: Number(data.downloadCount) || 0
                });
            });

            // Sort deterministically: date DESC -> shift ASC -> title ASC
            papersList.sort((a, b) => {
                const dateA = a.date || "";
                const dateB = b.date || "";
                const dDiff = dateB.localeCompare(dateA);
                if (dDiff !== 0) return dDiff;

                const shiftA = Number(String(a.shift || "").match(/\d+/)?.[0] || 999);
                const shiftB = Number(String(b.shift || "").match(/\d+/)?.[0] || 999);
                if (shiftA !== shiftB) return shiftA - shiftB;

                return (a.title || "").localeCompare(b.title || "");
            });

            papers = papersList;
            hasMore = false;
            nextCursor = null;
        } catch (fsErr) {
            console.error(`[PYQ Library] Firestore papers failed for ${exam.id}/${yearKey}:`, fsErr);
        }
    }

    isPapersFetching = false;

    skeletonPapers.dismiss(() => {
        if (papers && papers.length > 0) {
            renderPaperCards(papers, false);
            showPapersState("content");

            currentPapersCursor = nextCursor;
            updateLoadMoreButton(hasMore);
        } else {
            showPapersState("empty");
        }
    });
}

async function fetchMorePapers() {
    if (!selectedExam || !selectedYear || currentPapersCursor === null || isPapersFetching) return;

    isPapersFetching = true;
    if (loadMoreBtnEl) {
        loadMoreBtnEl.disabled = true;
        loadMoreBtnEl.innerHTML = `<span class="pyq-spinner" style="width:14px;height:14px;"></span> Loading more papers...`;
    }

    const yearKey = selectedYear.yearId || selectedYear.year;

    try {
        const url = `/api/papers/by-year?examId=${encodeURIComponent(selectedExam.id)}&yearId=${encodeURIComponent(yearKey)}&limit=24&cursor=${currentPapersCursor}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        isPapersFetching = false;

        if (data.success && Array.isArray(data.papers)) {
            renderPaperCards(data.papers, true);
            currentPapersCursor = data.nextCursor;
            updateLoadMoreButton(data.hasMore);
        } else {
            updateLoadMoreButton(false);
        }
    } catch (err) {
        isPapersFetching = false;
        console.error("[PYQ Library] Load more papers error:", err);
        if (loadMoreBtnEl) {
            loadMoreBtnEl.disabled = false;
            loadMoreBtnEl.textContent = "Retry Loading More";
        }
    }
}

function renderPaperCards(papers, appendMode = false) {
    if (!papersGridEl) return;
    if (!appendMode) {
        papersGridEl.innerHTML = "";
    }

    papers.forEach(paper => {
        if (!displayedPaperIds.has(paper.id)) {
            displayedPaperIds.add(paper.id);
            const card = createPaperCard(paper);
            papersGridEl.appendChild(card);
        }
    });
}

function updateLoadMoreButton(hasMore) {
    if (!loadMoreContainerEl || !loadMoreBtnEl) return;
    if (hasMore) {
        loadMoreContainerEl.style.display = "block";
        loadMoreBtnEl.disabled = false;
        loadMoreBtnEl.innerHTML = `<span>Load More Papers</span>`;
    } else {
        loadMoreContainerEl.style.display = "none";
    }
}

function showPapersState(state) {
    if (!papersGridEl) return;
    papersGridEl.style.display = state === "content" ? "grid" : "none";
    if (papersLoadingEl) papersLoadingEl.style.display = state === "loading" ? "block" : "none";
    if (papersEmptyEl) papersEmptyEl.style.display = state === "empty" ? "block" : "none";
    if (papersErrorEl) papersErrorEl.style.display = state === "error" ? "block" : "none";
}

if (papersRetryBtn) {
    papersRetryBtn.addEventListener("click", () => {
        if (selectedExam && selectedYear) showPapersView(selectedExam, selectedYear);
    });
}

if (loadMoreBtnEl) {
    loadMoreBtnEl.addEventListener("click", () => {
        fetchMorePapers();
    });
}

// ============================================================
// PAPER CARD CREATION & ACTION BINDINGS
// ============================================================

function createPaperCard(paper) {
    const card = document.createElement("article");
    card.className = "pyq-card";
    card.dataset.paperId = paper.id;
    card.dataset.examId = paper.examId || (selectedExam ? selectedExam.id : "");
    card.dataset.yearId = paper.yearId || paper.year || (selectedYear ? selectedYear.year : "");

    const title = paper.title || paper.id;
    const examName = paper.examName || (selectedExam ? selectedExam.name : formatExamName(paper.examId));
    const date = paper.date || "";
    const shift = paper.shift || "";
    const subject = paper.subject || "";
    const year = paper.year || paper.yearId || (selectedYear ? selectedYear.year : "");

    const viewCount = Number(paper.viewCount) || 0;
    const downloadCount = Number(paper.downloadCount) || 0;
    const pdfUrl = paper.pdfUrl || paper.pdfurl || paper.url || "";
    const hasPdf = Boolean(paper.hasPdf || pdfUrl);

    card.innerHTML = `
        <div>
            <div class="pyq-card-header">
                <div class="pyq-card-icon">${ICONS.pdf}</div>
                <div class="pyq-card-title-wrap">
                    <div class="pyq-card-badges">
                        <span class="pyq-card-exam-badge">${escapeHTML(examName)}</span>
                        ${year ? `<span class="pyq-card-year-badge">${escapeHTML(year)}</span>` : ""}
                        ${shift ? `<span class="pyq-card-shift-badge">${escapeHTML(shift)}</span>` : ""}
                    </div>
                    <h3 class="pyq-card-title">${escapeHTML(title)}</h3>
                    <div class="pyq-card-meta">
                        ${date ? `<span class="pyq-meta-item">${ICONS.calendar} ${escapeHTML(date)}</span>` : ""}
                        ${subject ? `<span class="pyq-meta-item">${ICONS.book} ${escapeHTML(subject)}</span>` : ""}
                        <span class="pyq-meta-item">${ICONS.eye} <span class="view-count-val">${viewCount}</span></span>
                        <span class="pyq-meta-item">${ICONS.download} <span class="download-count-val">${downloadCount}</span></span>
                    </div>
                </div>
            </div>
        </div>
        <div class="pyq-card-actions">
            ${hasPdf ? `
                <button type="button" class="pyq-btn pyq-btn-secondary view-pyq-btn">
                    ${ICONS.eye} View PDF
                </button>
                <button type="button" class="pyq-btn pyq-btn-primary download-pyq-btn">
                    ${ICONS.download} Download
                </button>
            ` : `<span style="color:#94a3b8; font-size:0.85rem;">PDF Unavailable</span>`}
        </div>
    `;

    // View PDF Action — Safe inline viewing via PDF Viewer
    const viewBtn = card.querySelector(".view-pyq-btn");
    if (viewBtn && hasPdf) {
        viewBtn.addEventListener("click", () => {
            if (!pdfViewerController) {
                pdfViewerController = new PdfViewerController();
            }
            // Use direct pdfUrl if present, otherwise server preview route
            const previewTarget = pdfUrl || `/api/papers/preview?examId=${encodeURIComponent(card.dataset.examId)}&yearId=${encodeURIComponent(card.dataset.yearId)}&paperId=${encodeURIComponent(paper.id)}`;
            pdfViewerController.open(previewTarget, title, paper, card, incrementViewCounter);
        });
    }

    // Download PDF Action — Handled via secure server or authenticated client
    const downloadBtn = card.querySelector(".download-pyq-btn");
    if (downloadBtn && hasPdf) {
        downloadBtn.addEventListener("click", () => {
            handleDownloadClick(paper, downloadBtn, card);
        });
    }

    return card;
}

function formatExamName(id) {
    if (!id) return "";
    return id.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ============================================================
// NAVIGATION & BREADCRUMBS MANAGEMENT
// ============================================================

function showExamsView() {
    currentViewMode = "exams";
    selectedExam = null;
    selectedYear = null;

    if (yearsSectionEl) yearsSectionEl.style.display = "none";
    if (papersSectionEl) papersSectionEl.style.display = "none";
    if (examsSectionEl) examsSectionEl.style.display = "block";

    updateBreadcrumbs();

    examsSectionEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateBreadcrumbs() {
    if (!breadcrumbsNavEl) return;

    if (currentViewMode === "exams") {
        breadcrumbsNavEl.style.display = "none";
        return;
    }

    breadcrumbsNavEl.style.display = "block";

    if (currentViewMode === "years") {
        if (bcExamSep) bcExamSep.style.display = "inline";
        if (bcExamItem) bcExamItem.style.display = "inline";
        if (bcExamBtn) bcExamBtn.textContent = selectedExam ? (selectedExam.name || selectedExam.id) : "Examination";
        if (bcYearSep) bcYearSep.style.display = "none";
        if (bcYearItem) bcYearItem.style.display = "none";
    } else if (currentViewMode === "papers") {
        if (bcExamSep) bcExamSep.style.display = "inline";
        if (bcExamItem) bcExamItem.style.display = "inline";
        if (bcExamBtn) bcExamBtn.textContent = selectedExam ? (selectedExam.name || selectedExam.id) : "Examination";
        if (bcYearSep) bcYearSep.style.display = "inline";
        if (bcYearItem) bcYearItem.style.display = "inline";
        if (bcYearSpan) bcYearSpan.textContent = selectedYear ? selectedYear.year : "Year";
    }
}

function setupNavigationEvents() {
    if (bcHomeBtn) {
        bcHomeBtn.addEventListener("click", () => showExamsView());
    }
    if (bcExamBtn) {
        bcExamBtn.addEventListener("click", () => {
            if (selectedExam) showYearsView(selectedExam);
        });
    }
    if (backToExamsBtn) {
        backToExamsBtn.addEventListener("click", () => showExamsView());
    }
    if (backToYearsBtn) {
        backToYearsBtn.addEventListener("click", () => {
            if (selectedExam) showYearsView(selectedExam);
        });
    }
}

// ============================================================
// SEARCH BEHAVIOR (EXAMINATIONS FILTER)
// ============================================================

let searchDebounceTimer = null;

function setupSearchEvents() {
    if (searchInputEl) {
        searchInputEl.addEventListener("input", () => {
            const query = searchInputEl.value.trim();
            if (searchClearBtnEl) {
                searchClearBtnEl.style.display = query.length > 0 ? "flex" : "none";
            }
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                applyExamFilter(query);
            }, 150);
        });

        searchInputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                clearTimeout(searchDebounceTimer);
                applyExamFilter(searchInputEl.value.trim());
            } else if (e.key === "Escape") {
                clearSearch();
            }
        });
    }

    if (searchBtnEl) {
        searchBtnEl.addEventListener("click", () => {
            clearTimeout(searchDebounceTimer);
            applyExamFilter(searchInputEl?.value.trim() || "");
        });
    }

    if (searchClearBtnEl) {
        searchClearBtnEl.addEventListener("click", () => {
            clearSearch();
            searchInputEl?.focus();
        });
    }
}

function applyExamFilter(query) {
    const clean = (query || "").trim().toLowerCase();

    // If searching while in years or papers view, automatically switch back to exams directory
    if (currentViewMode !== "exams") {
        showExamsView();
    }

    if (!clean) {
        filteredExams = [...allAvailableExams];
        renderExamCards(filteredExams);
        showExamsState("content");
        return;
    }

    // Resolve category synonyms (e.g. "banking" -> rbi, sbi)
    const synonymTokens = CATEGORY_SYNONYMS[clean] || [clean];

    filteredExams = allAvailableExams.filter(exam => {
        const id = (exam.id || "").toLowerCase();
        const name = (exam.name || "").toLowerCase();
        const desc = (exam.description || "").toLowerCase();

        return synonymTokens.some(token => {
            return id.includes(token) || name.includes(token) || desc.includes(token);
        });
    });

    if (filteredExams.length > 0) {
        renderExamCards(filteredExams);
        showExamsState("content");
    } else {
        if (examsEmptyDescEl) {
            examsEmptyDescEl.textContent = `No examinations found matching "${escapeHTML(query)}". Please try another examination name.`;
        }
        showExamsState("empty");
    }
}

function clearSearch() {
    if (searchInputEl) searchInputEl.value = "";
    if (searchClearBtnEl) searchClearBtnEl.style.display = "none";
    applyExamFilter("");
}

// ============================================================
// DOWNLOAD HANDLER (AUTHENTICATION + RELIABLE FALLBACK)
// ============================================================

async function handleDownloadClick(paper, buttonEl, cardEl) {
    const currentUser = auth.currentUser;

    if (!currentUser) {
        // Unauthenticated visitor: Store requested paper in session and display login modal
        sessionStorage.setItem("pendingPyqDownload", JSON.stringify({
            examId: paper.examId || (selectedExam ? selectedExam.id : ""),
            yearId: paper.yearId || paper.year || (selectedYear ? selectedYear.year : ""),
            paperId: paper.id,
            title: paper.title,
            pdfUrl: paper.pdfUrl || paper.pdfurl || paper.url || ""
        }));

        const localAuthModal = document.getElementById("authRequiredModal");
        if (localAuthModal) {
            localAuthModal.classList.remove("hidden");
            const closeBtn = document.getElementById("authModalCloseBtn");
            const backdrop = document.getElementById("authModalBackdrop");
            const closeModal = () => localAuthModal.classList.add("hidden");
            if (closeBtn) closeBtn.onclick = closeModal;
            if (backdrop) backdrop.onclick = closeModal;
        } else {
            showAuthModal({
                title: "Sign in to Download",
                message: "Create a free VidyarthiAstra account or log in to download previous year question papers.",
                defaultTab: "login"
            });
        }
        return;
    }

    // Authenticated user: Execute secure download
    await executeAuthenticatedDownload(paper, buttonEl, cardEl);
}

async function executeAuthenticatedDownload(paper, buttonEl, cardEl) {
    const oldText = buttonEl ? buttonEl.innerHTML : "";
    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.innerHTML = `<span class="pyq-spinner" style="width:14px;height:14px;border-width:2px;border-top-color:#ffffff;"></span> Downloading...`;
    }

    try {
        const currentUser = auth.currentUser;
        const examId = encodeURIComponent(paper.examId || (selectedExam ? selectedExam.id : ""));
        const yearId = encodeURIComponent(paper.yearId || paper.year || (selectedYear ? selectedYear.year : ""));
        const paperId = encodeURIComponent(paper.id);
        const pdfUrl = paper.pdfUrl || paper.pdfurl || paper.url;

        let downloadedViaApi = false;

        // Attempt 1: Try server API download with authorization token
        if (currentUser) {
            try {
                const idToken = await currentUser.getIdToken();
                const downloadUrl = `/api/papers/download?examId=${examId}&yearId=${yearId}&paperId=${paperId}`;
                const response = await fetch(downloadUrl, {
                    method: "GET",
                    headers: {
                        "Authorization": `Bearer ${idToken}`
                    }
                });

                if (response.ok) {
                    const blob = await response.blob();
                    if (blob && blob.size > 0) {
                        const fileName = `${cleanFileName(paper.title)}.pdf`;
                        const blobUrl = window.URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = blobUrl;
                        link.download = fileName;
                        document.body.appendChild(link);
                        link.click();
                        link.remove();

                        setTimeout(() => window.URL.revokeObjectURL(blobUrl), 3000);
                        incrementDownloadCounter(paper, cardEl);
                        downloadedViaApi = true;
                    }
                }
            } catch (apiErr) {
                console.warn("[PYQ Library] API download failed, falling back to direct download:", apiErr.message);
            }
        }

        // Attempt 2: Direct download fallback via pdf-viewer-core downloadPdfFile
        if (!downloadedViaApi) {
            if (pdfUrl) {
                await downloadPdfFile(pdfUrl, paper.title, buttonEl, paper, cardEl, incrementDownloadCounter);
            } else {
                throw new Error("PDF file URL is not available for this question paper.");
            }
        }

    } catch (err) {
        console.error("[PYQ Library] Download execution error:", err);
        alert(`Download failed: ${err.message || "Please check your network and try again."}`);
    } finally {
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.innerHTML = oldText;
        }
    }
}

// ============================================================
// AUTH & RESUME PENDING DOWNLOAD
// ============================================================

function setupAuthListeners() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const pendingRaw = sessionStorage.getItem("pendingPyqDownload");
            if (pendingRaw) {
                try {
                    const pending = JSON.parse(pendingRaw);
                    sessionStorage.removeItem("pendingPyqDownload");

                    const card = document.querySelector(`[data-paper-id="${pending.paperId}"]`);
                    const downloadBtn = card?.querySelector(".download-pyq-btn");

                    alert(`Welcome back! Starting your download for: ${pending.title || "Question Paper"}`);
                    await executeAuthenticatedDownload(pending, downloadBtn, card);
                } catch (e) {
                    sessionStorage.removeItem("pendingPyqDownload");
                }
            }
        }
    });
}

// ============================================================
// COUNTERS (VIEW & DOWNLOAD)
// ============================================================

const viewedPaperSet = new Set();

async function incrementViewCounter(paper, cardEl) {
    if (!paper || !paper.id || viewedPaperSet.has(paper.id)) return;
    viewedPaperSet.add(paper.id);

    paper.viewCount = (Number(paper.viewCount) || 0) + 1;
    if (cardEl) {
        const viewEl = cardEl.querySelector(".view-count-val");
        if (viewEl) viewEl.textContent = paper.viewCount;
    }

    const examId = paper.examId || (selectedExam ? selectedExam.id : "");
    const yearId = paper.yearId || paper.year || (selectedYear ? selectedYear.year : "");

    try {
        await fetch("/api/papers/increment-view", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId,
                yearId,
                paperId: paper.id
            })
        });
    } catch (apiErr) {
        // Direct Firestore atomic increment fallback
        try {
            if (examId && yearId && paper.id) {
                const paperRef = doc(db, "exams", examId, "years", yearId, "papers", paper.id);
                await updateDoc(paperRef, { viewCount: increment(1) });
            }
        } catch (fsErr) {}
    }
}

async function incrementDownloadCounter(paper, cardEl) {
    if (!paper || !paper.id) return;

    paper.downloadCount = (Number(paper.downloadCount) || 0) + 1;
    if (cardEl) {
        const dlEl = cardEl.querySelector(".download-count-val");
        if (dlEl) dlEl.textContent = paper.downloadCount;
    }

    const examId = paper.examId || (selectedExam ? selectedExam.id : "");
    const yearId = paper.yearId || paper.year || (selectedYear ? selectedYear.year : "");

    try {
        await fetch("/api/papers/increment-download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                examId,
                yearId,
                paperId: paper.id
            })
        });
    } catch (apiErr) {
        // Direct Firestore atomic increment fallback
        try {
            if (examId && yearId && paper.id) {
                const paperRef = doc(db, "exams", examId, "years", yearId, "papers", paper.id);
                await updateDoc(paperRef, { downloadCount: increment(1) });
            }
        } catch (fsErr) {}
    }
}

// Auto-run on DOM ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPyqLibrary);
} else {
    initPyqLibrary();
}
