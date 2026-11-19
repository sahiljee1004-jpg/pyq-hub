// ============================================================
// VIDYARTHIVERSE — PAPERS PAGE
// Firestore:
// exams → exam → years → year → papers
// ============================================================

import { db } from "./firebase.js";

import {
    doc,
    getDoc,
    collection,
    getDocs,
    updateDoc,
    increment
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
    PdfViewerController,
    downloadPdfFile,
    safeURL,
    cleanFileName,
    escapeHTML,
    getOrCreateAppSessionId
} from "./pdf-viewer-core.js";
import { SkeletonManager } from "./skeleton-manager.js";

// SVG Icons (No Emojis)
const EYE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const DOWNLOAD_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
const CALENDAR_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;
const CLOCK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
const BOOK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
const PDF_ICON_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;

// Initialize PDF Viewer Controller Instance
let pdfViewerController = null;
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        pdfViewerController = new PdfViewerController();
    });
} else {
    pdfViewerController = new PdfViewerController();
}

// ============================================================
// ELEMENTS
// ============================================================

const papersTitle = document.getElementById("papersTitle");
const papersDescription = document.getElementById("papersDescription");
const paperList = document.getElementById("paperList");
const paperCount = document.getElementById("paperCount");
const backLink = document.getElementById("backLink");
const footerYear = document.getElementById("year");

if (footerYear) {
    footerYear.textContent = new Date().getFullYear();
}

const params = new URLSearchParams(window.location.search);
const examId = params.get("exam");
const yearId = params.get("year");

if (!examId || !yearId) {
    showError("Exam or year was not selected.");
} else {
    if (backLink) {
        backLink.href = `exam.html?id=${encodeURIComponent(examId)}`;
    }
    loadPapers();
}

async function loadPapers() {
    try {
        const examRef = doc(db, "exams", examId);
        const examSnapshot = await getDoc(examRef);

        if (!examSnapshot.exists()) {
            showError("Exam not found.");
            return;
        }

        const exam = examSnapshot.data();
        const examName = exam.name || exam.title || exam.examName || formatName(examId);

        const yearRef = doc(db, "exams", examId, "years", yearId);
        const yearSnapshot = await getDoc(yearRef);

        if (!yearSnapshot.exists()) {
            showError("This year is not available.");
            return;
        }

        const year = yearSnapshot.data();
        const yearName = year.year || year.name || yearId;

        if (papersTitle) {
            papersTitle.textContent = `${examName} — ${yearName}`;
        }
        if (papersDescription) {
            papersDescription.textContent = "Previous year question papers";
        }

        await loadPaperCollection();
    } catch (error) {
        console.error("Papers loading error:", error);
        showError("Unable to load question papers.");
    }
}

async function loadPaperCollection() {
    let skeletonPapers = null;
    if (paperList) {
        skeletonPapers = SkeletonManager.mount(
            paperList,
            () => SkeletonManager.templates.papersList(5),
            { delay: 200, ariaLabel: "Loading question papers..." }
        );
    }
    try {
        const papersRef = collection(db, "exams", examId, "years", yearId, "papers");
        const snapshot = await getDocs(papersRef);
        const papers = [];

        snapshot.forEach((paperDoc) => {
            papers.push({
                id: paperDoc.id,
                ...paperDoc.data()
            });
        });

        papers.sort((a, b) => {
            const dateA = new Date(a.date || "");
            const dateB = new Date(b.date || "");
            const dateDifference = dateA.getTime() - dateB.getTime();
            if (dateDifference !== 0) return dateDifference;

            const shiftA = Number(String(a.shift || "").match(/\d+/)?.[0] || 999);
            const shiftB = Number(String(b.shift || "").match(/\d+/)?.[0] || 999);
            return shiftA - shiftB;
        });

        if (paperCount) {
            paperCount.textContent = `${papers.length} ${papers.length === 1 ? "Paper" : "Papers"}`;
        }

        skeletonPapers?.dismiss(() => {
            if (!papers.length) {
                paperList.innerHTML = `
                    <div class="empty-message">
                        <div class="empty-icon">📄</div>
                        <h3>No papers available</h3>
                        <p>Question papers for this year haven't been added yet.</p>
                    </div>
                `;
                return;
            }

            paperList.innerHTML = "";
            papers.forEach((paper, index) => {
                paperList.appendChild(createPaperCard(paper, index));
            });
        });
    } catch (error) {
        skeletonPapers?.cancel();
        console.error("Paper collection error:", error);
        showError("Unable to load question papers.");
    }
}

// Paper View & Download Counters
const sessionViewedPapers = new Set();

async function incrementPaperView(paper, cardEl) {
    if (!paper || !paper.id || sessionViewedPapers.has(paper.id)) {
        return;
    }
    sessionViewedPapers.add(paper.id);

    paper.viewCount = (Number(paper.viewCount) || 0) + 1;
    if (cardEl) {
        const viewNumEl = cardEl.querySelector(".view-count-num");
        const viewTextEl = cardEl.querySelector(".view-count-text");
        if (viewNumEl) viewNumEl.textContent = paper.viewCount;
        if (viewTextEl) viewTextEl.textContent = paper.viewCount === 1 ? "view" : "views";
    }

    try {
        const headers = { "Content-Type": "application/json" };
        if (window.auth && window.auth.currentUser) {
            try {
                const token = await window.auth.currentUser.getIdToken();
                headers["Authorization"] = `Bearer ${token}`;
            } catch (tErr) {}
        }

        const apiRes = await fetch("/api/papers/increment-view", {
            method: "POST",
            headers: headers,
            body: JSON.stringify({
                examId,
                yearId,
                paperId: paper.id,
                clientSessionId: getOrCreateAppSessionId()
            })
        });
        if (apiRes.ok) return;
    } catch (apiErr) {}

    // Direct Firestore Atomic Increment Fallback
    try {
        if (examId && yearId && paper.id) {
            const paperDocRef = doc(db, "exams", examId, "years", yearId, "papers", paper.id);
            await updateDoc(paperDocRef, {
                viewCount: increment(1)
            });
        }
    } catch (err) {}
}

async function incrementPaperDownload(paper, cardEl) {
    if (!paper || !paper.id) return;

    paper.downloadCount = (Number(paper.downloadCount) || 0) + 1;
    if (cardEl) {
        const downloadNumEl = cardEl.querySelector(".download-count-num");
        const downloadTextEl = cardEl.querySelector(".download-count-text");
        if (downloadNumEl) downloadNumEl.textContent = paper.downloadCount;
        if (downloadTextEl) downloadTextEl.textContent = paper.downloadCount === 1 ? "download" : "downloads";
    }

    try {
        const headers = { "Content-Type": "application/json" };
        if (window.auth && window.auth.currentUser) {
            try {
                const token = await window.auth.currentUser.getIdToken();
                headers["Authorization"] = `Bearer ${token}`;
            } catch (tErr) {}
        }

        const apiRes = await fetch("/api/papers/increment-download", {
            method: "POST",
            headers: headers,
            body: JSON.stringify({
                examId,
                yearId,
                paperId: paper.id,
                clientSessionId: getOrCreateAppSessionId()
            })
        });
        if (apiRes.ok) return;
    } catch (apiErr) {}

    // Direct Firestore Atomic Increment Fallback
    try {
        if (examId && yearId && paper.id) {
            const paperDocRef = doc(db, "exams", examId, "years", yearId, "papers", paper.id);
            await updateDoc(paperDocRef, {
                downloadCount: increment(1)
            });
        }
    } catch (err) {}
}

function createPaperCard(paper, index) {
    const card = document.createElement("article");
    card.className = "paper-card";

    const title = paper.title || paper.name || (paper.date && paper.shift ? `${paper.date} — ${paper.shift}` : paper.id);
    const date = paper.date || "";
    const shift = paper.shift || "";
    const subject = paper.subject || "";
    const pdfUrl = paper.pdfUrl || paper.pdfurl || paper.url || "";
    const viewCount = Number(paper.viewCount) || 0;
    const downloadCount = Number(paper.downloadCount) || 0;

    card.innerHTML = `
        <div class="paper-number">${String(index + 1).padStart(2, "0")}</div>
        <div class="paper-icon">${PDF_ICON_SVG}</div>
        <div class="paper-info">
            <h3>${escapeHTML(title)}</h3>
            <div class="paper-meta">
                ${date ? `<span class="paper-meta-item">${CALENDAR_SVG} ${escapeHTML(date)}</span>` : ""}
                ${shift ? `<span class="paper-meta-item">${CLOCK_SVG} ${escapeHTML(shift)}</span>` : ""}
                ${subject ? `<span class="paper-meta-item">${BOOK_SVG} ${escapeHTML(subject)}</span>` : ""}
                <span class="paper-stat-item">${EYE_SVG} <span class="view-count-num">${viewCount}</span> <span class="view-count-text">${viewCount === 1 ? 'view' : 'views'}</span></span>
                <span class="paper-stat-item">${DOWNLOAD_SVG} <span class="download-count-num">${downloadCount}</span> <span class="download-count-text">${downloadCount === 1 ? 'download' : 'downloads'}</span></span>
            </div>
        </div>
        <div class="paper-actions">
            ${pdfUrl ? `
                <button type="button" class="btn primary view-paper-btn">View PDF</button>
                <button type="button" class="btn download-paper-btn">Download</button>
            ` : `<span class="pdf-unavailable">PDF unavailable</span>`}
        </div>
    `;

    const viewButton = card.querySelector(".view-paper-btn");
    if (viewButton && pdfUrl) {
        viewButton.addEventListener("click", () => {
            if (!pdfViewerController) {
                pdfViewerController = new PdfViewerController();
            }
            pdfViewerController.open(pdfUrl, title, paper, card, incrementPaperView);
        });
    }

    const downloadButton = card.querySelector(".download-paper-btn");
    if (downloadButton && pdfUrl) {
        downloadButton.addEventListener("click", () => {
            downloadPdfFile(pdfUrl, title, downloadButton, paper, card, incrementPaperDownload);
        });
    }

    return card;
}


// ============================================================
// OPEN PDF INSIDE VIDYARTHIVERSE
// ================================================// Global Zoom & Active Paper Session State
let currentZoomScale = 1.0;
let isFitMode = true;
let activePdfUrl = null;
let activePaperData = null;
let activePaperCardEl = null;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.0;
const ZOOM_STEP = 0.25;

const pdfZoomOutBtn = document.getElementById("pdfZoomOutBtn");
const pdfZoomInBtn = document.getElementById("pdfZoomInBtn");
const pdfZoomLevelBtn = document.getElementById("pdfZoomLevelBtn");
const pdfZoomFitBtn = document.getElementById("pdfZoomFitBtn");

function updateZoomToolbarUI() {
    if (pdfZoomLevelBtn) {
        pdfZoomLevelBtn.textContent = `${Math.round(currentZoomScale * 100)}%`;
    }
    if (pdfZoomOutBtn) {
        pdfZoomOutBtn.disabled = currentZoomScale <= MIN_ZOOM;
    }
    if (pdfZoomInBtn) {
        pdfZoomInBtn.disabled = currentZoomScale >= MAX_ZOOM;
    }
    if (pdfZoomFitBtn) {
        pdfZoomFitBtn.style.opacity = isFitMode ? "1" : "0.75";
        pdfZoomFitBtn.style.fontWeight = isFitMode ? "800" : "600";
    }
}

function setZoomScale(newScale, fit = false) {
    if (!activePdfUrl) return;
    const clampedScale = Math.min(Math.max(newScale, MIN_ZOOM), MAX_ZOOM);
    isFitMode = fit;
    currentZoomScale = clampedScale;
    updateZoomToolbarUI();

    const containerEl = document.getElementById("pdfCanvasContainer");
    let scrollRatioY = 0;
    let scrollRatioX = 0;

    if (containerEl && containerEl.scrollHeight > 0) {
        scrollRatioY = containerEl.scrollTop / containerEl.scrollHeight;
        scrollRatioX = containerEl.scrollLeft / containerEl.scrollWidth;
    }

    renderPdfWithPdfJs(activePdfUrl, currentZoomScale, isFitMode).then(() => {
        if (containerEl && containerEl.scrollHeight > 0) {
            containerEl.scrollTop = Math.round(scrollRatioY * containerEl.scrollHeight);
            containerEl.scrollLeft = Math.round(scrollRatioX * containerEl.scrollWidth);
        }
    });
}

if (pdfZoomOutBtn) {
    pdfZoomOutBtn.addEventListener("click", () => setZoomScale(currentZoomScale - ZOOM_STEP, false));
}
if (pdfZoomInBtn) {
    pdfZoomInBtn.addEventListener("click", () => setZoomScale(currentZoomScale + ZOOM_STEP, false));
}
if (pdfZoomLevelBtn) {
    pdfZoomLevelBtn.addEventListener("click", () => setZoomScale(1.0, false));
}
if (pdfZoomFitBtn) {
    pdfZoomFitBtn.addEventListener("click", () => setZoomScale(1.0, true));
}

// Pinch-to-Zoom Touch Handler
let touchStartDist = 0;
let touchStartScale = 1.0;
let isPinching = false;

const canvasContainerEl = document.getElementById("pdfCanvasContainer");
if (canvasContainerEl) {
    canvasContainerEl.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
            isPinching = true;
            touchStartDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            touchStartScale = currentZoomScale;
        }
    }, { passive: true });

    canvasContainerEl.addEventListener("touchmove", (e) => {
        if (isPinching && e.touches.length === 2) {
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            if (touchStartDist > 0) {
                const factor = dist / touchStartDist;
                const tempScale = Math.min(Math.max(touchStartScale * factor, MIN_ZOOM), MAX_ZOOM);
                // Fast visual hardware-accelerated transform during gesture
                canvasContainerEl.style.transform = `scale(${factor})`;
                canvasContainerEl.style.transformOrigin = "center top";
                if (pdfZoomLevelBtn) {
                    pdfZoomLevelBtn.textContent = `${Math.round(tempScale * 100)}%`;
                }
            }
        }
    }, { passive: true });

    canvasContainerEl.addEventListener("touchend", (e) => {
        if (isPinching && e.touches.length < 2) {
            isPinching = false;
            canvasContainerEl.style.transform = "";
            canvasContainerEl.style.transformOrigin = "";
            const finalScale = Number(pdfZoomLevelBtn.textContent.replace("%", "")) / 100 || currentZoomScale;
            setZoomScale(finalScale, false);
        }
    }, { passive: true });
}

// Global Render Session Management
let currentRenderSessionId = 0;

function cancelActiveRenderSession() {
    currentRenderSessionId++;
    console.log(`[PDF.js Diagnostic] Active render session cancelled. Current Session ID: #${currentRenderSessionId}`);
}

// Configure PDF.js WorkerSrc if pdfjsLib is present
if (window.pdfjsLib) {
    console.log(`[PDF.js Diagnostic Log 2/16] PDF.js library detected. Version: ${window.pdfjsLib.version || "unknown"}`);
    try {
        const workerUrl = new URL("js/pdf.worker.min.js", window.location.href).href;
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
        console.log(`[PDF.js Diagnostic Log 3/16] WorkerSrc set to: ${workerUrl}`);
    } catch (e) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "js/pdf.worker.min.js";
        console.warn(`[PDF.js Diagnostic Log 3/16 Fallback] WorkerSrc set to: js/pdf.worker.min.js`);
    }
} else {
    console.error("[PDF.js Diagnostic Log 2/16 Error] window.pdfjsLib is NOT defined! Check script tag in papers.html");
}

async function renderPdfWithPdfJs(url, zoomFactor = 1.0, fitMode = true) {
    const sessionId = ++currentRenderSessionId;
    console.log(`[PDF.js Diagnostic Log 1/16] PDF render session #${sessionId} started for URL: ${url} (Zoom: ${zoomFactor}, Fit: ${fitMode})`);

    const loadingEl = document.getElementById("pdfLoading");
    const errorEl = document.getElementById("pdfError");
    const containerEl = document.getElementById("pdfCanvasContainer");
    const iframeEl = document.getElementById("pdfFrame");
    const errorTitleEl = document.getElementById("pdfErrorTitle");
    const errorDescEl = document.getElementById("pdfErrorDesc");
    const fallbackBtn = document.getElementById("pdfFallbackBtn");
    const retryBtn = document.getElementById("pdfRetryBtn");

    // Reset DOM Elements & State Messages
    if (containerEl) containerEl.innerHTML = "";
    if (iframeEl) iframeEl.classList.add("hidden");
    if (errorEl) errorEl.classList.add("hidden");
    if (loadingEl) loadingEl.classList.remove("hidden");

    const updateLoadingText = (text) => {
        if (loadingEl) {
            const p = loadingEl.querySelector("p");
            if (p) p.textContent = text;
        }
    };
    updateLoadingText("Initializing PDF engine...");

    // Bind Action Buttons
    if (fallbackBtn) {
        fallbackBtn.onclick = (e) => {
            e.preventDefault();
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
                window.Capacitor.Plugins.Browser.open({ url: url });
            } else {
                window.open(url, "_system");
            }
        };
    }

    if (retryBtn) {
        retryBtn.onclick = (e) => {
            e.preventDefault();
            renderPdfWithPdfJs(url, zoomFactor, fitMode);
        };
    }

    try {
        if (!window.pdfjsLib) {
            throw new Error("PDF.js library (window.pdfjsLib) is not loaded on page.");
        }
        if (pdfViewerController) {
            await pdfViewerController.renderPdf(url, zoomFactor, fitMode);
        }
    } catch (error) {
        console.error("[PDF.js Error]", error);
    }
}

function formatName(id) {
    return String(id)
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, char => char.toUpperCase());
}

function showError(message) {
    if (papersTitle) {
        papersTitle.textContent = "Something went wrong";
    }
    if (papersDescription) {
        papersDescription.textContent = message;
    }
    if (paperCount) {
        paperCount.textContent = "";
    }
    if (paperList) {
        paperList.innerHTML = `
            <div class="empty-message">
                <div class="empty-icon">⚠️</div>
                <h3>Unable to load papers</h3>
                <p>${escapeHTML(message)}</p>
            </div>
        `;
    }
}
