// ============================================================
// VIDYARTHIVERSE — STUDY RESOURCES PAGE
// Firestore hierarchy: studyResources/{examId}/subjects/{subjectId}/chapters/{chapterId}
// ============================================================

import { auth, db } from "./firebase.js";

import {
    collection,
    getDocs,
    getDoc,
    doc,
    query,
    where,
    setDoc,
    updateDoc,
    increment
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
    PdfViewerController,
    downloadPdfFile,
    safeURL,
    escapeHTML,
    getOrCreateAppSessionId
} from "./pdf-viewer-core.js";
import { SkeletonManager } from "./skeleton-manager.js";

// SVG Icons (No Emojis)
const EYE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const DOWNLOAD_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
const BOOK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
const PDF_ICON_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;

// Initialize PDF Viewer Controller Instance
let pdfViewerController = null;

// State Management
let exams = [];
let allResources = [];
let currentExam = null;
let currentSubject = null;
let currentChapter = null;
let currentSearchQuery = "";
let isStudyAdmin = false;
let isStudyEditor = false;
const sessionViewedResources = new Set();
const sessionDownloadedResources = new Set();

// DOM Elements
const studyContentArea = document.getElementById("studyContentArea");
const sectionHeading = document.getElementById("sectionHeading");
const sectionSubheading = document.getElementById("sectionSubheading");
const resourceCount = document.getElementById("resourceCount");
const breadcrumbText = document.getElementById("breadcrumbText");
const backBtn = document.getElementById("backBtn");
const searchInput = document.getElementById("searchInput");
const searchButton = document.getElementById("searchButton");
const footerYear = document.getElementById("year");
const studyAdminTools = document.getElementById("studyAdminTools");

if (footerYear) {
    footerYear.textContent = new Date().getFullYear();
}

// Start
document.addEventListener("DOMContentLoaded", () => {
    pdfViewerController = new PdfViewerController();
    setupEventListeners();
    setupAdminControls();
});

function setupEventListeners() {
    if (backBtn) {
        backBtn.addEventListener("click", handleBackClick);
    }
    if (searchButton && searchInput) {
        searchButton.addEventListener("click", () => {
            currentSearchQuery = searchInput.value.trim().toLowerCase();
            renderState();
        });
        searchInput.addEventListener("keyup", (e) => {
            if (e.key === "Enter") {
                currentSearchQuery = searchInput.value.trim().toLowerCase();
                renderState();
            } else if (searchInput.value.trim() === "" && currentSearchQuery !== "") {
                currentSearchQuery = "";
                renderState();
            }
        });
    }
}

// Helper: Get field value with key trimming & case fallback
function getNormalizedFieldValue(obj, ...possibleKeys) {
    if (!obj || typeof obj !== "object") return null;
    const trimmedObj = {};
    Object.keys(obj).forEach((k) => {
        if (typeof k === "string") {
            trimmedObj[k.trim()] = obj[k];
        }
    });
    for (const key of possibleKeys) {
        if (trimmedObj[key] !== undefined && trimmedObj[key] !== null && trimmedObj[key] !== "") {
            return trimmedObj[key];
        }
        const foundKey = Object.keys(trimmedObj).find(k => k.toLowerCase() === key.toLowerCase());
        if (foundKey && trimmedObj[foundKey] !== undefined && trimmedObj[foundKey] !== null && trimmedObj[foundKey] !== "") {
            return trimmedObj[foundKey];
        }
    }
    return null;
}

function sortByOrder(items) {
    return items.sort((left, right) => {
        const leftOrder = Number.isFinite(Number(left.order)) ? Number(left.order) : Number.MAX_SAFE_INTEGER;
        const rightOrder = Number.isFinite(Number(right.order)) ? Number(right.order) : Number.MAX_SAFE_INTEGER;
        const leftLabel = String(left.name || left.title || "");
        const rightLabel = String(right.name || right.title || "");
        return leftOrder - rightOrder || leftLabel.localeCompare(rightLabel) || left.id.localeCompare(right.id);
    });
}

function slugify(value) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function chapterDocument(resource) {
    if (!resource || !resource.examId || !resource.subjectId || !resource.chapterId) return null;
    return doc(db, "studyResources", resource.examId, "subjects", resource.subjectId, "chapters", resource.chapterId);
}

// Load the catalog and display only published PDFs to public users.
async function fetchStudyResources() {
    let skeleton = null;
    if (studyContentArea) {
        skeleton = SkeletonManager.mount(
            studyContentArea,
            () => SkeletonManager.templates.studyResources(6),
            { delay: 200, ariaLabel: "Loading study resources..." }
        );
    }
    try {
        const examSnapshot = await getDocs(collection(db, "studyResources"));
        const examDocuments = examSnapshot.docs.filter((examDoc) => {
            const data = examDoc.data();
            return typeof data.name === "string" && data.name.trim() !== "";
        });
        exams = await Promise.all(examDocuments.map(async (examDoc) => {
            const examData = examDoc.data();
            const subjectSnapshot = await getDocs(collection(db, "studyResources", examDoc.id, "subjects"));
            const subjects = await Promise.all(subjectSnapshot.docs.map(async (subjectDoc) => {
                const subjectData = subjectDoc.data();
                const chapterCollection = collection(db, "studyResources", examDoc.id, "subjects", subjectDoc.id, "chapters");
                const chapterQuery = isStudyEditor
                    ? chapterCollection
                    : query(chapterCollection, where("status", "==", "published"));
                const chapterSnapshot = await getDocs(chapterQuery);
                const chapters = await Promise.all(chapterSnapshot.docs.map(async (chapterDoc) => {
                    const chapterData = chapterDoc.data();
                    const pdfUrl = typeof chapterData.pdfUrl === "string" ? chapterData.pdfUrl.trim() : "";
                    const pdfs = pdfUrl ? [{
                            id: chapterDoc.id,
                            examId: examDoc.id,
                            subjectId: subjectDoc.id,
                            chapterId: chapterDoc.id,
                            exam: examData.name || examData.title || examDoc.id,
                            subject: subjectData.name || subjectData.title || subjectDoc.id,
                            chapter: chapterData.chapterName || chapterData.name || chapterData.title || chapterDoc.id,
                            title: chapterData.title || chapterData.name || "Untitled PDF",
                            pdfUrl,
                            order: chapterData.order,
                            status: chapterData.status || "draft",
                            published: chapterData.status === "published",
                            viewCount: Number(chapterData.viewCount) || 0,
                            downloadCount: Number(chapterData.downloadCount) || 0
                        }] : [];
                    return {
                        id: chapterDoc.id,
                        name: chapterData.chapterName || chapterData.name || chapterData.title || chapterDoc.id,
                        icon: chapterData.icon || "📖",
                        description: chapterData.description || "",
                        order: chapterData.order,
                        pdfs: sortByOrder(pdfs)
                    };
                }));
                return {
                    id: subjectDoc.id,
                    name: subjectData.name || subjectData.title || subjectDoc.id,
                    icon: subjectData.icon || "📖",
                    description: subjectData.description || "",
                    order: subjectData.order,
                    chapters: sortByOrder(chapters)
                };
            }));
            return {
                id: examDoc.id,
                name: examData.name || examData.title || examDoc.id,
                icon: examData.icon || "📚",
                description: examData.description || "",
                order: examData.order,
                subjects: sortByOrder(subjects)
            };
        }));
        sortByOrder(exams);
        allResources = [];
        exams.forEach((exam) => exam.subjects.forEach((subject) => subject.chapters.forEach((chapter) => allResources.push(...chapter.pdfs))));

        skeleton?.dismiss(() => {
            renderState();
        });
    } catch (error) {
        skeleton?.cancel();
        console.error("Error fetching study resources:", error);
        const message = error?.code === "permission-denied"
            ? "Firestore denied access to chapters. Publish rules that allow studyResources/{examId}/subjects/{subjectId}/chapters/{chapterId} reads for published documents."
            : "Unable to load study resources. Please try again later.";
        showError(message);
    }
}

// Main Render Dispatcher
function renderState() {
    if (!studyContentArea) return;

    if (currentSearchQuery) {
        renderSearchResults();
        return;
    }

    if (!currentExam) {
        renderExamsList();
    } else if (!currentSubject) {
        renderSubjectsList();
    } else if (!currentChapter) {
        renderChaptersList();
    } else {
        renderNotesList();
    }
}

function handleBackClick() {
    if (currentSearchQuery) {
        currentSearchQuery = "";
        if (searchInput) searchInput.value = "";
    } else if (currentChapter) {
        currentChapter = null;
    } else if (currentSubject) {
        currentSubject = null;
    } else if (currentExam) {
        currentExam = null;
    }
    renderState();
}

// 1. Render Exams View
function renderExamsList() {
    if (backBtn) {
        backBtn.hidden = true;
        backBtn.classList.add("hidden");
    }
    if (breadcrumbText) breadcrumbText.textContent = "Study Resources";
    if (sectionHeading) sectionHeading.textContent = "Available Exams";
    if (sectionSubheading) sectionSubheading.textContent = "Select an exam to view subjects and notes";

    const examsList = exams;

    if (resourceCount) {
        resourceCount.textContent = `${examsList.length} ${examsList.length === 1 ? 'Exam' : 'Exams'}`;
    }

    if (examsList.length === 0) {
        studyContentArea.innerHTML = `
            <div class="empty-message">
                <div class="empty-icon">📝</div>
                <h3>No study resources available</h3>
                <p>Study notes for exams will appear here once added.</p>
            </div>
        `;
        return;
    }

    const grid = document.createElement("div");
    grid.className = "study-grid";

    examsList.forEach((exam) => {
        const count = exam.subjects.reduce((total, subject) => total + subject.chapters.reduce((chapterTotal, chapter) => chapterTotal + chapter.pdfs.length, 0), 0);
        const card = document.createElement("div");
        card.className = "study-card";
        card.innerHTML = `
            <div>
                <div class="study-card-icon">${escapeHTML(exam.icon)}</div>
                <h3 class="study-card-title">${escapeHTML(exam.name)}</h3>
                ${exam.description ? `<div class="study-card-meta">${escapeHTML(exam.description)}</div>` : ""}
                <div class="study-card-meta">${count} ${count === 1 ? 'Note' : 'Notes'} Available</div>
            </div>
        `;
        card.addEventListener("click", () => {
            currentExam = exam;
            renderState();
        });
        grid.appendChild(card);
    });

    studyContentArea.innerHTML = "";
    studyContentArea.appendChild(grid);
}

// 2. Render Subjects View
function renderSubjectsList() {
    if (backBtn) {
        backBtn.hidden = false;
        backBtn.classList.remove("hidden");
    }
    if (breadcrumbText) breadcrumbText.textContent = `Study Resources → ${currentExam.name}`;
    if (sectionHeading) sectionHeading.textContent = `${currentExam.name} Subjects`;
    if (sectionSubheading) sectionSubheading.textContent = "Select a subject to view its chapters";

    const subjectsList = currentExam.subjects;

    if (resourceCount) {
        resourceCount.textContent = `${subjectsList.length} ${subjectsList.length === 1 ? 'Subject' : 'Subjects'}`;
    }

    if (subjectsList.length === 0) {
        studyContentArea.innerHTML = `
            <div class="empty-message">
                <div class="empty-icon">📚</div>
                <h3>No subjects found</h3>
                <p>No study notes available for ${escapeHTML(currentExam.name)}.</p>
            </div>
        `;
        return;
    }

    const grid = document.createElement("div");
    grid.className = "study-grid";

    subjectsList.forEach((subject) => {
        const count = subject.chapters.length;
        const card = document.createElement("div");
        card.className = "study-card";
        card.innerHTML = `
            <div>
                <div class="study-card-icon">${escapeHTML(subject.icon)}</div>
                <h3 class="study-card-title">${escapeHTML(subject.name)}</h3>
                ${subject.description ? `<div class="study-card-meta">${escapeHTML(subject.description)}</div>` : ""}
                <div class="study-card-meta">${count} ${count === 1 ? 'Chapter' : 'Chapters'}</div>
            </div>
        `;
        card.addEventListener("click", () => {
            currentSubject = subject;
            renderState();
        });
        grid.appendChild(card);
    });

    studyContentArea.innerHTML = "";
    studyContentArea.appendChild(grid);
}

function renderChaptersList() {
    if (backBtn) {
        backBtn.hidden = false;
        backBtn.classList.remove("hidden");
    }
    if (breadcrumbText) breadcrumbText.textContent = `Study Resources → ${currentExam.name} → ${currentSubject.name}`;
    if (sectionHeading) sectionHeading.textContent = `${currentSubject.name} Chapters`;
    if (sectionSubheading) sectionSubheading.textContent = "Select a chapter to view its PDFs";

    const chapters = currentSubject.chapters;
    if (resourceCount) resourceCount.textContent = `${chapters.length} ${chapters.length === 1 ? "Chapter" : "Chapters"}`;
    studyContentArea.innerHTML = "";
    if (!chapters.length) {
        studyContentArea.innerHTML = `<div class="empty-message"><h3>No chapters available</h3><p>No chapters have been added to ${escapeHTML(currentSubject.name)}.</p></div>`;
        renderChapterAdminForm();
        return;
    }

    const grid = document.createElement("div");
    grid.className = "study-grid";
    chapters.forEach((chapter) => {
        const card = document.createElement("div");
        card.className = "study-card";
        card.innerHTML = `<div><div class="study-card-icon">${escapeHTML(chapter.icon)}</div><h3 class="study-card-title">${escapeHTML(chapter.name)}</h3>${chapter.description ? `<div class="study-card-meta">${escapeHTML(chapter.description)}</div>` : ""}<div class="study-card-meta">${chapter.pdfs.length} published ${chapter.pdfs.length === 1 ? "PDF" : "PDFs"}</div></div>`;
        card.addEventListener("click", () => {
            currentChapter = chapter;
            renderState();
        });
        grid.appendChild(card);
    });
    studyContentArea.appendChild(grid);
    renderChapterAdminForm();
}

// 4. Render published PDF list
function renderNotesList() {
    if (backBtn) {
        backBtn.hidden = false;
        backBtn.classList.remove("hidden");
    }
    if (breadcrumbText) breadcrumbText.textContent = `Study Resources → ${currentExam.name} → ${currentSubject.name} → ${currentChapter.name}`;
    if (sectionHeading) sectionHeading.textContent = `${currentChapter.name} PDFs`;
    if (sectionSubheading) sectionSubheading.textContent = `Published PDFs for ${currentSubject.name}`;

    const notes = currentChapter.pdfs;

    if (resourceCount) {
        resourceCount.textContent = `${notes.length} ${notes.length === 1 ? 'Note' : 'Notes'}`;
    }

    if (notes.length === 0) {
        studyContentArea.innerHTML = `
            <div class="empty-message">
                <div class="empty-icon">📄</div>
                <h3>No notes available</h3>
                <p>No notes found for ${escapeHTML(currentSubject.name)}.</p>
            </div>
        `;
        return;
    }

    const list = document.createElement("div");
    list.className = "study-notes-list";

    notes.forEach((note, index) => {
        list.appendChild(createNoteCard(note, index));
    });

    studyContentArea.innerHTML = "";
    studyContentArea.appendChild(list);
}

// Search published PDFs across all hierarchy levels.
function renderSearchResults() {
    if (backBtn) {
        backBtn.hidden = false;
        backBtn.classList.remove("hidden");
    }
    if (breadcrumbText) breadcrumbText.textContent = `Search Results: "${currentSearchQuery}"`;
    if (sectionHeading) sectionHeading.textContent = "Search Results";
    if (sectionSubheading) sectionSubheading.textContent = `Showing resources matching "${currentSearchQuery}"`;

    const filtered = allResources.filter(res => {
        const examMatch = res.exam.toLowerCase().includes(currentSearchQuery);
        const subjectMatch = res.subject.toLowerCase().includes(currentSearchQuery);
        const titleMatch = res.title.toLowerCase().includes(currentSearchQuery);
        const chapterMatch = res.chapter.toLowerCase().includes(currentSearchQuery);
        return examMatch || subjectMatch || titleMatch || chapterMatch;
    });

    if (resourceCount) {
        resourceCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'Resource' : 'Resources'}`;
    }

    if (filtered.length === 0) {
        studyContentArea.innerHTML = `
            <div class="empty-message">
                <div class="empty-icon">🔍</div>
                <h3>No resources match your search</h3>
                <p>Try searching for a different exam or subject name.</p>
            </div>
        `;
        return;
    }

    const list = document.createElement("div");
    list.className = "study-notes-list";

    sortByOrder(filtered).forEach((note, index) => {
        list.appendChild(createNoteCard(note, index));
    });

    studyContentArea.innerHTML = "";
    studyContentArea.appendChild(list);
}

function setupAdminControls() {
    onAuthStateChanged(auth, async (user) => {
        isStudyAdmin = false;
        isStudyEditor = false;
        if (user) {
            try {
                const profile = await getDoc(doc(db, "users", user.uid));
                const role = profile.exists() ? profile.data().role : "user";
                isStudyAdmin = role === "admin";
                isStudyEditor = isStudyAdmin || role === "editor";
            } catch (error) {
                console.warn("Unable to read Study Resources role:", error);
            }
        }
        if (!isStudyAdmin && studyAdminTools) {
            studyAdminTools.remove();
        } else if (studyAdminTools) {
            studyAdminTools.classList.toggle("hidden", !isStudyAdmin);
        }
        await fetchStudyResources();
    });

    document.getElementById("seedStudyCatalog")?.addEventListener("click", seedStudyCatalog);
    document.getElementById("importLegacyResources")?.addEventListener("click", importLegacyResources);
}

async function writeAdminDocument(path, metadata) {
    await setDoc(doc(db, ...path), { ...metadata, updatedAt: new Date().toISOString() }, { merge: true });
}

async function createAdminDocumentIfMissing(path, metadata) {
    const reference = doc(db, ...path);
    const existing = await getDoc(reference);
    if (!existing.exists()) {
        await setDoc(reference, { ...metadata, updatedAt: new Date().toISOString() });
    }
}

async function seedStudyCatalog() {
    if (!isStudyAdmin) return;
    const examId = "competitive-exam-gs";
    await writeAdminDocument(["studyResources", examId], { name: "Competitive Exam GS", order: 0 });

    const subjects = [
        ["history", "History"], ["geography", "Geography"], ["economics", "Economics"],
        ["polity", "Polity"], ["environment", "Environment"], ["science-and-technology", "Science and Technology"]
    ];
    for (const [index, [subjectId, name]] of subjects.entries()) {
        await writeAdminDocument(["studyResources", examId, "subjects", subjectId], { name, order: index });
    }
    await fetchStudyResources();
}

async function importLegacyResources() {
    if (!isStudyAdmin || !window.confirm("Copy legacy Study Resources into the nested hierarchy? Existing documents will be kept.")) return;
    const legacySnapshot = await getDocs(collection(db, "studyResources"));
    for (const legacyDoc of legacySnapshot.docs) {
        const data = legacyDoc.data();
        const examName = getNormalizedFieldValue(data, "exam", "examName", "category") || "General";
        const subjectName = getNormalizedFieldValue(data, "subject", "subjectName") || "General";
        const title = getNormalizedFieldValue(data, "title", "name", "noteTitle") || "Untitled PDF";
        const chapterName = getNormalizedFieldValue(data, "chapter", "chapterName", "topic", "topicName") || title;
        const pdfUrl = getNormalizedFieldValue(data, "pdfUrl", "pdfURL", "pdfurl", "url");
        if (typeof pdfUrl !== "string" || !pdfUrl.trim()) continue;

        const examId = /jee\s*mains?/i.test(examName) ? "jee-mains" : slugify(examName) || "general";
        const subjectId = slugify(subjectName) || "general";
        let chapterId = slugify(chapterName) || slugify(title) || `pdf-${slugify(legacyDoc.id)}`;
        await createAdminDocumentIfMissing(["studyResources", examId], { name: examName, order: 1000 });
        await createAdminDocumentIfMissing(["studyResources", examId, "subjects", subjectId], { name: subjectName, order: 1000 });
        let chapterRef = doc(db, "studyResources", examId, "subjects", subjectId, "chapters", chapterId);
        let existingChapter = await getDoc(chapterRef);
        if (existingChapter.exists() && existingChapter.data().pdfUrl && existingChapter.data().migratedFrom !== legacyDoc.id) {
            chapterId = `${chapterId}-${slugify(legacyDoc.id) || "legacy"}`;
            chapterRef = doc(db, "studyResources", examId, "subjects", subjectId, "chapters", chapterId);
            existingChapter = await getDoc(chapterRef);
        }
        if (existingChapter.exists() && existingChapter.data().migratedFrom === legacyDoc.id) continue;
        await setDoc(chapterRef, {
            title,
            chapterName,
            pdfUrl: pdfUrl.trim(),
            order: Number(data.order) || 0,
            status: "published",
            viewCount: Number(data.viewCount) || 0,
            downloadCount: Number(data.downloadCount) || 0,
            migratedFrom: legacyDoc.id
        }, { merge: true });
    }
    await fetchStudyResources();
}

function renderChapterAdminForm() {
    if (!isStudyEditor) return;
    const form = document.createElement("form");
    form.className = "study-admin-form";
    form.innerHTML = `<h3>Add chapter PDF</h3><label>PDF title<input name="title" required maxlength="180"></label><label>Chapter ID<input name="id" placeholder="mathematics-in-physics" required maxlength="128"></label><label>PDF URL<input name="pdfUrl" type="url" placeholder="https://res.cloudinary.com/..." required></label><label>Order<input name="order" type="number" value="0"></label><label class="study-admin-checkbox"><input name="published" type="checkbox" checked> Published</label><button class="btn primary" type="submit">Save chapter PDF</button>`;
    form.elements.title.addEventListener("input", () => {
        if (!form.elements.id.value.trim()) form.elements.id.value = slugify(form.elements.title.value);
    });
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const title = form.elements.title.value.trim();
        const pdfUrl = form.elements.pdfUrl.value.trim();
        let parsedUrl;
        try { parsedUrl = new URL(pdfUrl); } catch { return; }
        if (parsedUrl.protocol !== "https:") return;
        const id = slugify(form.elements.id.value);
        if (!id) return;
        const chapterRef = doc(db, "studyResources", currentExam.id, "subjects", currentSubject.id, "chapters", id);
        const existingChapter = await getDoc(chapterRef);
        if (existingChapter.exists() && existingChapter.data().pdfUrl) {
            window.alert("A PDF already exists for this chapter ID.");
            return;
        }
        await setDoc(chapterRef, {
            title,
            pdfUrl,
            order: Number(form.elements.order.value) || 0,
            status: form.elements.published.checked ? "published" : "draft",
            viewCount: Number(existingChapter.data()?.viewCount) || 0,
            downloadCount: Number(existingChapter.data()?.downloadCount) || 0
        }, { merge: true });
        await refreshSelectedCatalog();
    });
    studyContentArea.appendChild(form);
}

async function refreshSelectedCatalog() {
    const examId = currentExam?.id;
    const subjectId = currentSubject?.id;
    const chapterId = currentChapter?.id;
    await fetchStudyResources();
    currentExam = exams.find((exam) => exam.id === examId) || null;
    currentSubject = currentExam?.subjects.find((subject) => subject.id === subjectId) || null;
    currentChapter = currentSubject?.chapters.find((chapter) => chapter.id === chapterId) || null;
    renderState();
}

// Create Note Card
function createNoteCard(note, index) {
    const card = document.createElement("article");
    card.className = "paper-card";

    const title = note.title || "Study Note";
    const exam = note.exam || "";
    const subject = note.subject || "";
    const chapter = note.chapter || "";
    const pdfUrl = note.pdfUrl || "";
    const viewCount = Number(note.viewCount) || 0;
    const downloadCount = Number(note.downloadCount) || 0;

    card.innerHTML = `
        <div class="paper-number">${String(index + 1).padStart(2, "0")}</div>
        <div class="paper-icon">${PDF_ICON_SVG}</div>
        <div class="paper-info">
            <h3>${escapeHTML(title)}</h3>
            <div class="paper-meta">
                ${exam ? `<span class="paper-meta-item">🎯 ${escapeHTML(exam)}</span>` : ""}
                ${subject ? `<span class="paper-meta-item">${BOOK_SVG} ${escapeHTML(subject)}</span>` : ""}
                ${chapter ? `<span class="paper-meta-item">🏷️ ${escapeHTML(chapter)}</span>` : ""}
                <span class="paper-stat-item">${EYE_SVG} <span class="view-count-num">${viewCount}</span> <span class="view-count-text">${viewCount === 1 ? 'view' : 'views'}</span></span>
                <span class="paper-stat-item">${DOWNLOAD_SVG} <span class="download-count-num">${downloadCount}</span> <span class="download-count-text">${downloadCount === 1 ? 'download' : 'downloads'}</span></span>
            </div>
        </div>
        <div class="paper-actions">
            ${pdfUrl ? `
                <button type="button" class="btn primary view-note-btn">View PDF</button>
                <button type="button" class="btn download-note-btn">Download</button>
            ` : `<span class="pdf-unavailable">PDF unavailable</span>`}
        </div>
    `;

    const viewButton = card.querySelector(".view-note-btn");
    if (viewButton && pdfUrl) {
        viewButton.addEventListener("click", () => {
            if (!pdfViewerController) {
                pdfViewerController = new PdfViewerController();
            }
            pdfViewerController.open(pdfUrl, title, note, card, incrementResourceView);
        });
    }

    const downloadButton = card.querySelector(".download-note-btn");
    if (downloadButton && pdfUrl) {
        downloadButton.addEventListener("click", () => {
            downloadPdfFile(pdfUrl, title, downloadButton, note, card, incrementResourceDownload);
        });
    }

    return card;
}

// Helper: Get API URL depending on environment
function getApiUrl(endpoint) {
    const isCapacitorNative = window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform();
    const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    if (isCapacitorNative || window.location.protocol === "file:" || (isLocalhost && window.location.port !== "3000")) {
        return `http://127.0.0.1:3000${endpoint}`;
    }
    return endpoint;
}

function updateCardViewCount(resource, cardEl) {
    if (cardEl) {
        const viewNumEl = cardEl.querySelector(".view-count-num");
        const viewTextEl = cardEl.querySelector(".view-count-text");
        if (viewNumEl) viewNumEl.textContent = resource.viewCount;
        if (viewTextEl) viewTextEl.textContent = resource.viewCount === 1 ? "view" : "views";
    }
}

function updateCardDownloadCount(resource, cardEl) {
    if (cardEl) {
        const downloadNumEl = cardEl.querySelector(".download-count-num");
        const downloadTextEl = cardEl.querySelector(".download-count-text");
        if (downloadNumEl) downloadNumEl.textContent = resource.downloadCount;
        if (downloadTextEl) downloadTextEl.textContent = resource.downloadCount === 1 ? "download" : "downloads";
    }
}

// View Counter Trigger
async function incrementResourceView(resource, cardEl) {
    if (!resource || !resource.id || !resource.examId || !resource.subjectId || !resource.chapterId) return;
    const resourceKey = `${resource.examId}/${resource.subjectId}/${resource.chapterId}/${resource.id}`;
    if (sessionViewedResources.has(resourceKey)) return;
    sessionViewedResources.add(resourceKey);

    // Optimistically update UI card & local state
    const previousViewCount = Number(resource.viewCount) || 0;
    resource.viewCount = previousViewCount + 1;
    updateCardViewCount(resource, cardEl);

    let persisted = false;

    // 1. Try Backend Endpoint
    try {
        const headers = { "Content-Type": "application/json" };
        const activeAuth = auth || (typeof window !== "undefined" ? window.auth : null);
        if (activeAuth && activeAuth.currentUser) {
            try {
                const token = await activeAuth.currentUser.getIdToken();
                if (token) {
                    headers["Authorization"] = `Bearer ${token}`;
                }
            } catch (tErr) {
                console.warn("[StudyResources] Error obtaining user ID token:", tErr.message);
            }
        }

        const endpoint = getApiUrl("/api/study-resources/increment-view");
        const apiRes = await fetch(endpoint, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({
                examId: resource.examId,
                subjectId: resource.subjectId,
                chapterId: resource.chapterId,
                clientSessionId: getOrCreateAppSessionId()
            })
        });

        if (apiRes.ok) {
            const resData = await apiRes.json();
            if (resData && resData.success) {
                if (resData.deduplicated) {
                    // Event was deduplicated by backend in session window
                    resource.viewCount = previousViewCount;
                    updateCardViewCount(resource, cardEl);
                    console.log(`[StudyResources] viewCount deduplicated by backend for document [${resource.id}]`);
                } else {
                    persisted = true;
                    if (typeof resData.storedCount === "number") {
                        resource.viewCount = resData.storedCount;
                        updateCardViewCount(resource, cardEl);
                    }
                    console.log(`[StudyResources] viewCount increment persisted via backend API for document [${resource.id}]`);
                }
                return;
            }
        }
    } catch (apiErr) {
        console.warn(`[StudyResources] Backend API view increment failed (${apiErr.message}). Invoking direct Firestore fallback...`);
    }

    // 2. Fallback: Direct Firestore atomic increment
    try {
        const docRef = chapterDocument(resource);
        if (docRef) {
            await updateDoc(docRef, {
                viewCount: increment(1)
            });
            persisted = true;
            console.log(`[StudyResources] viewCount increment persisted via direct Firestore SDK for document [${resource.id}]`);
        }
    } catch (err) {
        console.error(`[StudyResources] Direct Firestore SDK view increment failed:`, err);
    }

    if (!persisted) {
        // Revert optimistic count on persistence failure
        resource.viewCount = previousViewCount;
        updateCardViewCount(resource, cardEl);
        sessionViewedResources.delete(resourceKey);
        console.error(`[StudyResources] Failed to persist viewCount for document [${resource.id}]`);
    }
}

// Download Counter Trigger
async function incrementResourceDownload(resource, cardEl) {
    if (!resource || !resource.id || !resource.examId || !resource.subjectId || !resource.chapterId) return;
    const resourceKey = `${resource.examId}/${resource.subjectId}/${resource.chapterId}/${resource.id}`;
    if (sessionDownloadedResources.has(resourceKey)) return;
    sessionDownloadedResources.add(resourceKey);

    // Optimistically update UI card & local state
    const previousDownloadCount = Number(resource.downloadCount) || 0;
    resource.downloadCount = previousDownloadCount + 1;
    updateCardDownloadCount(resource, cardEl);

    let persisted = false;

    // 1. Try Backend Endpoint
    try {
        const headers = { "Content-Type": "application/json" };
        const activeAuth = auth || (typeof window !== "undefined" ? window.auth : null);
        if (activeAuth && activeAuth.currentUser) {
            try {
                const token = await activeAuth.currentUser.getIdToken();
                if (token) {
                    headers["Authorization"] = `Bearer ${token}`;
                }
            } catch (tErr) {
                console.warn("[StudyResources] Error obtaining user ID token:", tErr.message);
            }
        }

        const endpoint = getApiUrl("/api/study-resources/increment-download");
        const apiRes = await fetch(endpoint, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({
                examId: resource.examId,
                subjectId: resource.subjectId,
                chapterId: resource.chapterId,
                clientSessionId: getOrCreateAppSessionId()
            })
        });

        if (apiRes.ok) {
            const resData = await apiRes.json();
            if (resData && resData.success) {
                if (resData.deduplicated) {
                    // Event was deduplicated by backend in session window
                    resource.downloadCount = previousDownloadCount;
                    updateCardDownloadCount(resource, cardEl);
                    console.log(`[StudyResources] downloadCount deduplicated by backend for document [${resource.id}]`);
                } else {
                    persisted = true;
                    if (typeof resData.storedCount === "number") {
                        resource.downloadCount = resData.storedCount;
                        updateCardDownloadCount(resource, cardEl);
                    }
                    console.log(`[StudyResources] downloadCount increment persisted via backend API for document [${resource.id}]`);
                }
                return;
            }
        }
    } catch (apiErr) {
        console.warn(`[StudyResources] Backend API download increment failed (${apiErr.message}). Invoking direct Firestore fallback...`);
    }

    // 2. Fallback: Direct Firestore atomic increment
    try {
        const docRef = chapterDocument(resource);
        if (docRef) {
            await updateDoc(docRef, {
                downloadCount: increment(1)
            });
            persisted = true;
            console.log(`[StudyResources] downloadCount increment persisted via direct Firestore SDK for document [${resource.id}]`);
        }
    } catch (err) {
        console.error(`[StudyResources] Direct Firestore SDK download increment failed:`, err);
    }

    if (!persisted) {
        // Revert optimistic count on persistence failure
        resource.downloadCount = previousDownloadCount;
        updateCardDownloadCount(resource, cardEl);
        sessionDownloadedResources.delete(resourceKey);
        console.error(`[StudyResources] Failed to persist downloadCount for document [${resource.id}]`);
    }
}

function showError(message) {
    if (sectionHeading) sectionHeading.textContent = "Something went wrong";
    if (sectionSubheading) sectionSubheading.textContent = message;
    if (resourceCount) resourceCount.textContent = "";
    if (studyContentArea) {
        studyContentArea.innerHTML = `
            <div class="empty-message">
                <div class="empty-icon">⚠️</div>
                <h3>Unable to load study resources</h3>
                <p>${escapeHTML(message)}</p>
            </div>
        `;
    }
}
