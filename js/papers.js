// ============================================================
// PYQs HUB — PAPERS PAGE
// Firestore:
// exams → exam → years → year → papers
// ============================================================

import { db } from "./firebase.js";

import {
    doc,
    getDoc,
    collection,
    onSnapshot,
    updateDoc,
    increment
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import { sortPapers } from "./sorting.js";


// ============================================================
// ELEMENTS
// ============================================================

const papersTitle =
    document.getElementById("papersTitle");

const papersDescription =
    document.getElementById("papersDescription");

const paperList =
    document.getElementById("paperList");

const paperCount =
    document.getElementById("paperCount");

const backLink =
    document.getElementById("backLink");

const footerYear =
    document.getElementById("year");

const paperViewer =
    document.getElementById("paperViewer");

const pdfFrame =
    document.getElementById("pdfFrame");

const viewerTitle =
    document.getElementById("viewerTitle");

const viewOriginal =
    document.getElementById("viewOriginal");

const closeViewer =
    document.getElementById("closeViewer");


// ============================================================
// FOOTER YEAR
// ============================================================

if (footerYear) {
    footerYear.textContent =
        new Date().getFullYear();
}


// ============================================================
// URL
// ============================================================

const params =
    new URLSearchParams(
        window.location.search
    );

const examId =
    params.get("exam");

const yearId =
    params.get("year");


// ============================================================
// CHECK URL
// ============================================================

if (!examId || !yearId) {

    showError(
        "Exam or year was not selected."
    );

} else {

    if (backLink) {

        backLink.href =
            `exam.html?id=${encodeURIComponent(examId)}`;

    }

    loadPapers();
}


// ============================================================
// LOAD EXAM + YEAR + PAPERS
// ============================================================

async function loadPapers() {

    try {

        // ----------------------------------------------------
        // EXAM
        // ----------------------------------------------------

        const examRef =
            doc(
                db,
                "exams",
                examId
            );

        const examSnapshot =
            await getDoc(examRef);


        if (!examSnapshot.exists()) {

            showError("Exam not found.");
            return;

        }


        const exam =
            examSnapshot.data();


        const examName =
            exam.name ||
            exam.title ||
            exam.examName ||
            formatName(examId);


        // ----------------------------------------------------
        // YEAR
        // ----------------------------------------------------

        const yearRef =
            doc(
                db,
                "exams",
                examId,
                "years",
                yearId
            );

        const yearSnapshot =
            await getDoc(yearRef);


        if (!yearSnapshot.exists()) {

            showError(
                "This year is not available."
            );

            return;

        }


        const year =
            yearSnapshot.data();


        const yearName =
            year.year ||
            year.name ||
            yearId;


        // ----------------------------------------------------
        // HEADER
        // ----------------------------------------------------

        if (papersTitle) {

            papersTitle.textContent =
                `${examName} — ${yearName}`;

        }


        if (papersDescription) {

            papersDescription.textContent =
                "Previous year question papers";

        }


        // ----------------------------------------------------
        // PAPERS
        // ----------------------------------------------------

        await loadPaperCollection();

    } catch (error) {

        console.error(
            "Papers loading error:",
            error
        );

        showError(
            "Unable to load question papers."
        );

    }

}


// ============================================================
// LOAD PAPERS COLLECTION
// ============================================================

async function loadPaperCollection() {

    try {

        const papersRef =
            collection(
                db,
                "exams",
                examId,
                "years",
                yearId,
                "papers"
            );


        onSnapshot(
            papersRef,
            (snapshot) => {
                const papers = sortPapers(
                    snapshot.docs.map((paperDoc) => ({
                        id: paperDoc.id,
                        ...paperDoc.data()
                    }))
                );


        // ----------------------------------------------------
        // COUNT
        // ----------------------------------------------------

        if (paperCount) {

            paperCount.textContent =
                `${papers.length} ${
                    papers.length === 1
                        ? "Paper"
                        : "Papers"
                }`;

        }


        // ----------------------------------------------------
        // EMPTY
        // ----------------------------------------------------

        if (!papers.length) {

            paperList.innerHTML = `

                <div class="empty-message">

                    <div class="empty-icon">
                        📄
                    </div>

                    <h3>
                        No papers available
                    </h3>

                    <p>
                        Question papers for this year
                        haven't been added yet.
                    </p>

                </div>

            `;

            return;

        }


        // ----------------------------------------------------
        // DISPLAY
        // ----------------------------------------------------

        paperList.innerHTML = "";


        papers.forEach(
            (paper, index) => {

                paperList.appendChild(
                    createPaperCard(
                        paper,
                        index
                    )
                );

            }
                );
            },
            (error) => {
                console.error("Paper collection error:", error);
                showError("Unable to load question papers.");
            }
        );

    } catch (error) {

        console.error(
            "Paper collection error:",
            error
        );

        showError(
            "Unable to load question papers."
        );

    }

}


// ============================================================
// CREATE PAPER CARD
// ============================================================

function createPaperCard(
    paper,
    index
) {

    const card =
        document.createElement("article");


    card.className =
        "paper-card";


    // --------------------------------------------------------
    // DATA
    // --------------------------------------------------------

    const title =
        paper.title ||
        paper.name ||
        (
            paper.date && paper.shift
                ? `${paper.date} — ${paper.shift}`
                : paper.id
        );


    const date =
        paper.date || "";


    const shift =
        paper.shift || "";


    const subject =
        paper.subject || "";


    const downloads =
        Number(
            paper.downloadCount ??
            paper.downloads ??
            0
        );


    const views =
        Number(
            paper.viewCount ??
            paper.views ??
            0
        );


    const pdfUrl =
        paper.pdfUrl ||
        paper.pdfurl ||
        paper.url ||
        "";


    const paperRef =
        doc(
            db,
            "exams",
            examId,
            "years",
            yearId,
            "papers",
            paper.id
        );


    // --------------------------------------------------------
    // CARD
    // --------------------------------------------------------

    card.innerHTML = `

        <div class="paper-number">
            ${String(index + 1).padStart(2, "0")}
        </div>


        <div class="paper-icon">
            📄
        </div>


        <div class="paper-info">

            <h3>
                ${escapeHTML(title)}
            </h3>


            <div class="paper-meta">

                ${
                    date
                        ? `
                            <span>
                                📅 ${escapeHTML(date)}
                            </span>
                          `
                        : ""
                }


                ${
                    shift
                        ? `
                            <span>
                                🕐 ${escapeHTML(shift)}
                            </span>
                          `
                        : ""
                }


                ${
                    subject
                        ? `
                            <span>
                                📚 ${escapeHTML(subject)}
                            </span>
                          `
                        : ""
                }

            </div>


            <div class="paper-stats">

                <span class="paper-stat" data-stat="views" aria-label="Views">

                <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    focusable="false"
                >
                    <path d="M2.06 12.35a1 1 0 0 1 0-.7C3.48 7.56 7.48 4.5 12 4.5s8.52 3.06 9.94 7.15a1 1 0 0 1 0 .7C20.52 16.44 16.52 19.5 12 19.5s-8.52-3.06-9.94-7.15Z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                </svg>

                    ${views.toLocaleString()} views

                </span>


                <span class="paper-stat" data-stat="downloads" aria-label="Downloads">

                    <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        focusable="false"
                    >
                        <path d="M12 3v12"></path>
                        <path d="m7 10 5 5 5-5"></path>
                        <path d="M5 21h14"></path>
                    </svg>

                    ${downloads.toLocaleString()} downloads

                </span>

            </div>

        </div>


        <div class="paper-actions">

            ${
                pdfUrl
                    ? `

                        <button
                            type="button"
                            class="btn primary view-paper-btn"
                        >
                            View PDF
                        </button>


                        <button
                            type="button"
                            class="btn download-paper-btn"
                        >
                            Download
                        </button>

                      `
                    : `

                        <span class="pdf-unavailable">
                            PDF unavailable
                        </span>

                      `
            }

        </div>

    `;


    // --------------------------------------------------------
    // VIEW
    // --------------------------------------------------------

    const viewButton =
        card.querySelector(
            ".view-paper-btn"
        );


    if (viewButton && pdfUrl) {

        viewButton.addEventListener(
            "click",
            () => {

                openPaperViewer(
                    pdfUrl,
                    title,
                    paperRef,
                    card,
                    views
                );

            }
        );

    }


    // --------------------------------------------------------
    // DOWNLOAD
    // --------------------------------------------------------

    const downloadButton =
        card.querySelector(
            ".download-paper-btn"
        );


    if (downloadButton && pdfUrl) {

        downloadButton.addEventListener(
            "click",
            () => {

                downloadPaper(
                    pdfUrl,
                    title,
                    downloadButton,
                    paperRef,
                    card,
                    downloads
                );

            }
        );

    }


    return card;

}


// ============================================================
// OPEN PDF INSIDE PYQs HUB
// ============================================================

function openPaperViewer(
    pdfUrl,
    title,
    paperRef,
    card,
    currentViews
) {

    if (!paperViewer || !pdfFrame) {

        console.error(
            "PDF viewer HTML is missing."
        );

        return;

    }


    const safePdfURL =
        safeURL(pdfUrl);


    if (safePdfURL === "#") {

        alert(
            "Invalid PDF URL."
        );

        return;

    }


    // --------------------------------------------------------
    // SET PDF
    // --------------------------------------------------------

    pdfFrame.src =
        safePdfURL;


    // --------------------------------------------------------
    // TITLE
    // --------------------------------------------------------

    if (viewerTitle) {

        viewerTitle.textContent =
            title;

    }


    // --------------------------------------------------------
    // ORIGINAL
    // --------------------------------------------------------

    if (viewOriginal) {

        viewOriginal.href =
            safePdfURL;

    }


    // --------------------------------------------------------
    // SHOW
    // --------------------------------------------------------

    paperViewer.classList.remove(
        "hidden"
    );


    void recordPaperMetric(
        paperRef,
        "views",
        card,
        currentViews
    );


    document.body.classList.add(
        "viewer-open"
    );


    // --------------------------------------------------------
    // TOP
    // --------------------------------------------------------

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

}


// ============================================================
// CLOSE VIEWER
// ============================================================

function closePaperViewer() {

    if (!paperViewer) {
        return;
    }


    paperViewer.classList.add(
        "hidden"
    );


    document.body.classList.remove(
        "viewer-open"
    );


    if (pdfFrame) {

        pdfFrame.src =
            "about:blank";

    }

}


// ============================================================
// CLOSE BUTTON
// ============================================================

if (closeViewer) {

    closeViewer.addEventListener(
        "click",
        closePaperViewer
    );

}


// ============================================================
// ESCAPE KEY
// ============================================================

document.addEventListener(
    "keydown",
    (event) => {

        if (
            event.key === "Escape" &&
            paperViewer &&
            !paperViewer.classList.contains("hidden")
        ) {

            closePaperViewer();

        }

    }
);


// ============================================================
// DOWNLOAD
// ============================================================

async function downloadPaper(
    pdfUrl,
    title,
    button,
    paperRef,
    card,
    currentDownloads
) {

    const safePdfURL =
        safeURL(pdfUrl);


    if (safePdfURL === "#") {

        alert(
            "Invalid PDF URL."
        );

        return;

    }


    const oldText =
        button.textContent;


    try {

        button.disabled = true;

        button.textContent =
            "Downloading...";


        const response =
            await fetch(
                safePdfURL
            );


        if (!response.ok) {

            throw new Error(
                `HTTP ${response.status}`
            );

        }


        const blob =
            await response.blob();


        if (!blob.size) {

            throw new Error(
                "Empty PDF"
            );

        }


        const blobURL =
            URL.createObjectURL(blob);


        const link =
            document.createElement("a");


        link.href =
            blobURL;


        link.download =
            `${cleanFileName(title)}.pdf`;


        document.body.appendChild(
            link
        );


        link.click();


        void recordPaperMetric(
            paperRef,
            "downloads",
            card,
            currentDownloads
        );


        link.remove();


        setTimeout(
            () => {

                URL.revokeObjectURL(
                    blobURL
                );

            },
            1000
        );


    } catch (error) {

        console.error(
            "Download failed:",
            error
        );


        alert(
            "Download failed. Please try again."
        );


    } finally {

        button.disabled = false;

        button.textContent =
            oldText;

    }

}


// ============================================================
// SAFE URL
// ============================================================

function safeURL(url) {

    try {

        const parsed =
            new URL(
                url,
                window.location.href
            );


        if (
            parsed.protocol === "https:" ||
            parsed.protocol === "http:"
        ) {

            return parsed.href;

        }

    } catch (error) {

        console.error(
            "Invalid URL:",
            url
        );

    }


    return "#";

}


// ============================================================
// CLEAN FILE NAME
// ============================================================

function cleanFileName(value) {

    return String(value)
        .replace(
            /[<>:"/\\|?*]/g,
            ""
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim()
        .substring(
            0,
            150
        );

}


// ============================================================
// ESCAPE HTML
// ============================================================

function escapeHTML(value) {

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

}


// ============================================================
// FORMAT NAME
// ============================================================

function formatName(id) {

    return String(id)
        .replace(
            /[-_]+/g,
            " "
        )
        .replace(
            /\b\w/g,
            char =>
                char.toUpperCase()
        );

}


// ============================================================
// ERROR
// ============================================================

function showError(message) {

    if (papersTitle) {

        papersTitle.textContent =
            "Something went wrong";

    }


    if (papersDescription) {

        papersDescription.textContent =
            message;

    }


    if (paperCount) {

        paperCount.textContent = "";

    }


    if (paperList) {

        paperList.innerHTML = `

            <div class="empty-message">

                <div class="empty-icon">
                    ⚠️
                </div>

                <h3>
                    Unable to load papers
                </h3>

                <p>
                    ${escapeHTML(message)}
                </p>

            </div>

        `;

    }

}


// ============================================================
// RECORD PAPER ACTIVITY
// ============================================================

async function recordPaperMetric(
    paperRef,
    metric,
    card,
    currentValue
) {

    try {

        const firestoreMetric =
            metric === "views"
                ? "viewCount"
                : "downloadCount";

        await updateDoc(
            paperRef,
            {
                [firestoreMetric]: increment(1)
            }
        );


        const stat =
            card.querySelector(
                `[data-stat="${metric}"]`
            );


        if (stat) {

            stat.lastChild.textContent =
                ` ${Number(currentValue + 1).toLocaleString()} ${metric}`;

        }

    } catch (error) {

        console.error(
            `Unable to record paper ${metric}:`,
            error
        );

    }

}