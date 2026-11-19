import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { showAuthModal } from "./auth.js";

// State
let currentIdToken = null;
let currentAdminActor = null;
let currentAdminRole = null;
let activeJobId = null;
let pollingInterval = null;
let currentQuestions = [];
let editingQuestionId = null;

// File Upload State
const uploadFiles = {
    questionPaper: null,
    answerKey: null,
    examPattern: null
};

// ============================================================
// HELPER: AUTHENTICATED FETCH
// ============================================================
async function adminFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    
    // Add Firebase ID token if available
    if (auth.currentUser) {
        try {
            const token = await auth.currentUser.getIdToken();
            headers["Authorization"] = `Bearer ${token}`;
        } catch (e) {
            console.warn("[Admin UI] Could not retrieve ID token:", e.message);
        }
    } else if (currentIdToken) {
        headers["Authorization"] = `Bearer ${currentIdToken}`;
    }

    // Set JSON content-type if not already specified and body is object
    if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, { ...options, headers });
    
    // Immediate revocation check: if an API call returns 401/403, immediately downgrade UI
    if (response.status === 401 || response.status === 403) {
        console.warn("[Admin UI] Received 401/403 from admin API. Downgrading UI access state.");
        const authLoading = document.getElementById("adminAuthLoading");
        const accessDenied = document.getElementById("adminAccessDenied");
        const dashboardView = document.getElementById("adminDashboardView");
        if (authLoading) authLoading.style.display = "none";
        if (dashboardView) dashboardView.style.display = "none";
        if (accessDenied) accessDenied.style.display = "block";
    }

    return response;
}

// ============================================================
// INITIALIZATION & AUTH CHECK
// ============================================================
async function initAdminAuth() {
    const authLoading = document.getElementById("adminAuthLoading");
    const accessDenied = document.getElementById("adminAccessDenied");
    const dashboardView = document.getElementById("adminDashboardView");
    const actorLabel = document.getElementById("adminActorLabel");

    // "Back to Webapp" handlers: record preference so user isn't redirected back in a loop
    const recordBackToWebapp = () => {
        sessionStorage.setItem("adminBrowsingWebapp", "true");
    };
    document.getElementById("backToWebappBtn")?.addEventListener("click", recordBackToWebapp);
    document.getElementById("deniedBackToWebappBtn")?.addEventListener("click", recordBackToWebapp);

    // Sign out handler
    document.getElementById("adminSignOutBtn")?.addEventListener("click", async () => {
        try {
            sessionStorage.removeItem("adminBrowsingWebapp");
            await fetch("/api/auth/logout", { method: "POST" });
            await auth.signOut();
        } catch (e) {
            console.warn("Sign out error:", e);
        }
        window.location.href = "login.html";
    });

    // Login prompt button on access denied view
    document.getElementById("adminLoginBtn")?.addEventListener("click", () => {
        showAuthModal();
    });

    onAuthStateChanged(auth, async (user) => {
        try {
            let res;
            if (user) {
                currentIdToken = await user.getIdToken();
                res = await adminFetch("/api/admin/auth/check");
            } else {
                res = await fetch("/api/admin/auth/check");
            }

            if (res.ok) {
                const data = await res.json();
                currentAdminActor = data.actor || user?.email || "Admin";
                currentAdminRole = data.role || "admin";

                if (actorLabel) {
                    actorLabel.textContent = `Administrator: ${data.email || currentAdminActor}`;
                }

                const usersTabBtn = document.getElementById("usersTabBtn");
                if (usersTabBtn) {
                    usersTabBtn.style.display = "inline-flex";
                }

                authLoading.style.display = "none";
                accessDenied.style.display = "none";
                dashboardView.style.display = "block";

                // Load initial dashboard data
                loadOverviewMetrics();
                loadImportHistory();
                loadAdminUsers();
            } else {
                authLoading.style.display = "none";
                dashboardView.style.display = "none";
                accessDenied.style.display = "block";
            }
        } catch (err) {
            console.warn("[Admin UI] Auth check notice:", err.message);
            authLoading.style.display = "none";
            dashboardView.style.display = "none";
            accessDenied.style.display = "block";
        }
    });
}

// ============================================================
// TAB NAVIGATION
// ============================================================
function setupTabs() {
    const tabs = document.querySelectorAll(".admin-tab-btn");
    console.log("[Admin UI] setupTabs initialized, tab buttons count:", tabs.length);
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            const targetTab = tab.getAttribute("data-tab");
            console.log("[Admin UI] Tab button clicked:", targetTab);
            switchTab(targetTab);
        });
    });
}

function switchTab(tabId) {
    console.log("[Admin UI] switchTab activating:", tabId);
    document.querySelectorAll(".admin-tab-btn").forEach(t => {
        t.classList.toggle("active", t.getAttribute("data-tab") === tabId);
    });

    document.querySelectorAll(".admin-tab-content").forEach(content => {
        const isTarget = content.id === `tab-${tabId}`;
        content.style.display = isTarget ? "block" : "none";
    });

    if (tabId === "overview") loadOverviewMetrics();
    if (tabId === "history") loadImportHistory();
    if (tabId === "report" && activeJobId) loadValidationReport(activeJobId);
    if (tabId === "review" && activeJobId) loadQuestionsForReview(activeJobId);
    if (tabId === "users" && typeof isSuperAdmin !== "undefined" && isSuperAdmin) {
        loadAdminUsers();
        loadAdminAuditLogs();
    }
}
window.switchTab = switchTab;



// ============================================================
// OVERVIEW METRICS & RECENT JOBS
// ============================================================
async function loadOverviewMetrics() {
    try {
        const res = await adminFetch("/api/admin/stats");
        if (res.ok) {
            const { stats } = await res.json();
            document.getElementById("statTotalImports").textContent = stats.totalImports;
            document.getElementById("statProcessing").textContent = stats.processingJobs;
            document.getElementById("statNeedsReview").textContent = stats.needsReviewJobs;
            document.getElementById("statReady").textContent = stats.readyToPublishJobs;
            document.getElementById("statPublished").textContent = stats.publishedPapers;
            document.getElementById("jobsBadge").textContent = stats.totalImports;
        }

        // Load recent jobs
        const jobsRes = await adminFetch("/api/admin/import/jobs");
        if (jobsRes.ok) {
            const { jobs } = await jobsRes.json();
            renderRecentJobs(jobs.slice(0, 5));
        }
    } catch (e) {
        console.warn("[Admin UI] Error loading stats:", e.message);
    }
}

function renderRecentJobs(jobs) {
    const tbody = document.getElementById("recentJobsTableBody");
    if (!tbody) return;

    if (!jobs || jobs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #94a3b8; padding: 24px;">No import jobs yet.</td></tr>`;
        return;
    }

    tbody.innerHTML = jobs.map(j => `
        <tr>
            <td><strong>${escapeHTML(j.jobId.substring(0, 24))}...</strong></td>
            <td>${escapeHTML((j.examId || "").toUpperCase())} (${j.year})</td>
            <td><span class="question-tag">${escapeHTML(j.paperCode || "Q1")}</span></td>
            <td><span class="stage-badge ${getStatusBadgeClass(j.status)}">${formatStatus(j.status)}</span></td>
            <td>${j.extractedQuestionCount || 0}</td>
            <td>${j.verifiedAnswerCount || 0}</td>
            <td>
                <button type="button" class="admin-btn admin-btn-secondary" style="padding: 4px 10px; font-size: 12px;" onclick="window.viewJobProgress('${escapeHTML(j.jobId)}')">
                    View
                </button>
                ${j.status === "published" ? `<a href="mock-test.html" class="admin-btn admin-btn-secondary" style="padding: 4px 10px; font-size: 12px; text-decoration: none; margin-left: 4px; display: inline-block;">Mock Tests</a>` : ''}
            </td>
        </tr>
    `).join("");
}

// ============================================================
// UPLOAD WORKFLOW & SHA-256 INTEGRITY
// ============================================================
async function handleFileSelection(file, type) {
    if (!file) return;

    // Check extension
    if (!file.name.toLowerCase().endsWith(".pdf")) {
        alert("Please upload a valid PDF document (.pdf extension required).");
        return;
    }

    const arrayBuffer = await file.arrayBuffer();

    // Verify PDF Magic Bytes: %PDF-
    const headerBytes = new Uint8Array(arrayBuffer.slice(0, 5));
    const headerStr = String.fromCharCode(...headerBytes);
    if (headerStr !== "%PDF-") {
        alert("Security Warning: The selected file is not a valid PDF (Missing %PDF- header).");
        return;
    }

    // Compute SHA-256 hash using Web Crypto API
    const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

    // Convert to Base64
    let binary = "";
    const bytes = new Uint8Array(arrayBuffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    uploadFiles[type] = {
        name: file.name,
        size: file.size,
        hash: hashHex,
        base64: base64
    };

    // Update UI
    const metaTagId = type === "questionPaper" ? "qpMetaTag" : type === "answerKey" ? "akMetaTag" : "epMetaTag";
    const dropzoneId = type === "questionPaper" ? "dropzoneQp" : type === "answerKey" ? "dropzoneAk" : "dropzoneEp";
    const removeBtnId = type === "questionPaper" ? "qpRemoveBtn" : type === "answerKey" ? "akRemoveBtn" : "epRemoveBtn";

    const metaTag = document.getElementById(metaTagId);
    const dropzone = document.getElementById(dropzoneId);
    const removeBtn = document.getElementById(removeBtnId);

    if (metaTag && dropzone) {
        metaTag.textContent = `${file.name} (${Math.round(file.size / 1024)} KB) - SHA: ${hashHex.substring(0, 8)}...`;
        metaTag.style.display = "block";
        dropzone.classList.add("has-file");
    }

    if (removeBtn) {
        removeBtn.style.display = "inline-block";
    }

    checkAllFilesReady();
}

async function handleFileRemoval(type) {
    const typeLabel = type === "questionPaper" ? "Question Paper" : type === "answerKey" ? "Answer Key" : "Pattern Document";

    // If active job exists on server, request removal from draft
    if (activeJobId) {
        const confirmed = confirm(`Are you sure you want to remove the ${typeLabel} from the current draft import?`);
        if (!confirmed) return;

        try {
            const res = await adminFetch(`/api/admin/import/jobs/${activeJobId}/documents/${type}`, {
                method: "DELETE"
            });
            if (!res.ok) {
                const errData = await res.json();
                alert(`Cannot remove document: ${errData.error || errData.message}`);
                return;
            }
        } catch (err) {
            alert(`Error removing document: ${err.message}`);
            return;
        }
    }

    // Clear local state
    uploadFiles[type] = null;

    // Reset native input so the same file can be selected again
    const inputId = type === "questionPaper" ? "fileInputQp" : type === "answerKey" ? "fileInputAk" : "fileInputEp";
    const metaTagId = type === "questionPaper" ? "qpMetaTag" : type === "answerKey" ? "akMetaTag" : "epMetaTag";
    const dropzoneId = type === "questionPaper" ? "dropzoneQp" : type === "answerKey" ? "dropzoneAk" : "dropzoneEp";
    const removeBtnId = type === "questionPaper" ? "qpRemoveBtn" : type === "answerKey" ? "akRemoveBtn" : "epRemoveBtn";

    const input = document.getElementById(inputId);
    if (input) input.value = "";

    const metaTag = document.getElementById(metaTagId);
    if (metaTag) {
        metaTag.textContent = "";
        metaTag.style.display = "none";
    }

    const removeBtn = document.getElementById(removeBtnId);
    if (removeBtn) removeBtn.style.display = "none";

    const dropzone = document.getElementById(dropzoneId);
    if (dropzone) dropzone.classList.remove("has-file");

    checkAllFilesReady();
}

function checkAllFilesReady() {
    const isReady = uploadFiles.questionPaper && uploadFiles.answerKey && uploadFiles.examPattern;
    const startBtn = document.getElementById("startImportPipelineBtn");
    if (startBtn) {
        startBtn.disabled = !isReady;
    }
}

function setupUploadDropzones() {
    const dropzones = [
        { dropzoneId: "dropzoneQp", inputId: "fileInputQp", removeBtnId: "qpRemoveBtn", type: "questionPaper" },
        { dropzoneId: "dropzoneAk", inputId: "fileInputAk", removeBtnId: "akRemoveBtn", type: "answerKey" },
        { dropzoneId: "dropzoneEp", inputId: "fileInputEp", removeBtnId: "epRemoveBtn", type: "examPattern" }
    ];

    dropzones.forEach(({ dropzoneId, inputId, removeBtnId, type }) => {
        const dropzone = document.getElementById(dropzoneId);
        const input = document.getElementById(inputId);
        const removeBtn = document.getElementById(removeBtnId);

        if (!dropzone || !input) return;

        input.addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (file) handleFileSelection(file, type);
        });

        removeBtn?.addEventListener("click", (e) => {
            e.stopPropagation();
            handleFileRemoval(type);
        });

        dropzone.addEventListener("dragover", (e) => {
            e.preventDefault();
            dropzone.classList.add("dragover");
        });

        dropzone.addEventListener("dragleave", () => {
            dropzone.classList.remove("dragover");
        });

        dropzone.addEventListener("drop", (e) => {
            e.preventDefault();
            dropzone.classList.remove("dragover");
            const file = e.dataTransfer.files[0];
            if (file) handleFileSelection(file, type);
        });
    });

    // Real-time inline validation for exam name input
    const examInputEl = document.getElementById("examInput");
    const examErrorEl = document.getElementById("examInputError");
    examInputEl?.addEventListener("input", () => {
        const raw = examInputEl.value;
        const trimmed = raw.trim();
        if (examErrorEl) {
            if (raw.length > 150) {
                examErrorEl.textContent = "Exam name must be 150 characters or fewer.";
                examErrorEl.style.display = "block";
            } else if (trimmed.length > 0) {
                examErrorEl.style.display = "none";
                examErrorEl.textContent = "";
            }
        }
    });

    examInputEl?.addEventListener("blur", () => {
        const trimmed = examInputEl.value.trim();
        if (examErrorEl) {
            if (!trimmed) {
                examErrorEl.textContent = "Target Exam name is required.";
                examErrorEl.style.display = "block";
            }
        }
    });

    const startBtn = document.getElementById("startImportPipelineBtn");
    startBtn?.addEventListener("click", executeUploadAndPipeline);
}

async function executeUploadAndPipeline() {
    const startBtn = document.getElementById("startImportPipelineBtn");
    const statusMsg = document.getElementById("uploadStatusMsg");

    try {
        const examInputEl = document.getElementById("examInput");
        const examSelectEl = document.getElementById("examSelect");
        const examErrorEl = document.getElementById("examInputError");
        const rawExamName = (examInputEl ? examInputEl.value : (examSelectEl ? examSelectEl.value : "")).trim();

        if (examErrorEl) {
            examErrorEl.style.display = "none";
            examErrorEl.textContent = "";
        }

        if (!rawExamName) {
            if (examErrorEl) {
                examErrorEl.textContent = "Please enter an exam name.";
                examErrorEl.style.display = "block";
            }
            examInputEl?.focus();
            throw new Error("Target Exam name cannot be empty.");
        }
        if (rawExamName.length > 150) {
            if (examErrorEl) {
                examErrorEl.textContent = "Exam name must be 150 characters or fewer.";
                examErrorEl.style.display = "block";
            }
            examInputEl?.focus();
            throw new Error("Exam name exceeds maximum length of 150 characters.");
        }

        startBtn.disabled = true;
        startBtn.textContent = "Uploading & Validating Hashes...";
        statusMsg.textContent = "Uploading 3 verified source documents to security vault...";
        statusMsg.style.color = "#635bff";

        const year = document.getElementById("yearInput").value;
        const paperType = document.getElementById("paperTypeSelect").value;

        // 1. Upload Documents
        const uploadRes = await adminFetch("/api/admin/import/upload", {
            method: "POST",
            body: {
                examName: rawExamName,
                year,
                paperType,
                questionPaperFile: uploadFiles.questionPaper,
                answerKeyFile: uploadFiles.answerKey,
                examPatternFile: uploadFiles.examPattern
            }
        });

        if (!uploadRes.ok) {
            const errData = await uploadRes.json();
            throw new Error(errData.error || errData.message || "Document upload failed");
        }

        const uploadData = await uploadRes.json();
        activeJobId = uploadData.jobId;

        // 2. Start Asynchronous Pipeline
        statusMsg.textContent = "Documents stored. Launching universal document-driven pipeline...";
        const startRes = await adminFetch(`/api/admin/import/jobs/${activeJobId}/universal-start`, {
            method: "POST"
        });

        if (!startRes.ok) {
            const errData = await startRes.json();
            throw new Error(errData.error || "Failed to trigger pipeline");
        }

        // Show Progress Tab and start polling
        document.getElementById("progressTabBtn").style.display = "inline-flex";
        switchTab("progress");
        startPollingJob(activeJobId);

    } catch (err) {
        console.error("[Admin UI] Upload error:", err.message);
        statusMsg.textContent = `Error: ${err.message}`;
        statusMsg.style.color = "#ef4444";
        startBtn.disabled = false;
        startBtn.textContent = "Start Automated Import Pipeline";
    }
}

// ============================================================
// REAL-TIME JOB PROGRESS POLLING
// ============================================================
function startPollingJob(jobId) {
    if (pollingInterval) clearInterval(pollingInterval);

    document.getElementById("progressJobId").textContent = jobId;
    pollJobStatus(jobId);

    pollingInterval = setInterval(() => {
        pollJobStatus(jobId);
    }, 1500);
}

async function pollJobStatus(jobId) {
    try {
        const res = await adminFetch(`/api/admin/import/jobs/${jobId}`);
        if (!res.ok) return;

        const { job } = await res.json();
        if (!job) return;

        // Update progress UI
        const fillBar = document.getElementById("progressFillBar");
        const percentText = document.getElementById("progressPercentText");
        const stageText = document.getElementById("progressStageText");
        const badge = document.getElementById("progressStatusBadge");

        fillBar.style.width = `${job.progressPercent || 0}%`;
        percentText.textContent = `${job.progressPercent || 0}%`;
        stageText.textContent = job.stage || "Processing...";

        badge.className = `stage-badge ${getStatusBadgeClass(job.status)}`;
        badge.textContent = formatStatus(job.status);

        document.getElementById("progressPaperCode").textContent = job.paperCode || "Q1";
        document.getElementById("progressQuestionsCount").textContent = job.extractedQuestionCount || 0;
        document.getElementById("progressVerifiedCount").textContent = job.verifiedAnswerCount || 0;
        document.getElementById("progressFlaggedCount").textContent = job.flaggedQuestionCount || 0;

        // When processing finishes, enable report and review tabs
        if (["ready_to_publish", "needs_review", "published", "failed"].includes(job.status)) {
            clearInterval(pollingInterval);
            pollingInterval = null;

            document.getElementById("reportTabBtn").style.display = "inline-flex";
            document.getElementById("reviewTabBtn").style.display = "inline-flex";

            loadValidationReport(jobId);
        }
    } catch (e) {
        console.warn("[Admin UI] Polling error:", e.message);
    }
}

// ============================================================
// VALIDATION REPORT VIEW
// ============================================================
window.setActiveJobId = function(id) {
    activeJobId = id;
    window.activeJobId = id;
};

async function loadValidationReport(jobId) {
    if (!jobId) jobId = activeJobId;
    else activeJobId = jobId;
    try {
        const res = await adminFetch(`/api/admin/import/jobs/${jobId}/report`);
        if (!res.ok) return;

        const data = await res.json();
        const report = data.validationReport;

        document.getElementById("reportQuestionCount").textContent = data.extractedMetadata?.totalQuestions?.value || 200;
        document.getElementById("reportMatchCoverage").textContent = `${report?.answerKeyChecks?.matchCoverage || 0}%`;
        document.getElementById("reportPatternStatus").textContent = report?.patternChecks?.passed ? "Verified" : "Discrepancy";
        document.getElementById("reportUnverifiedCount").textContent = report?.answerKeyChecks?.unverifiedCount || 0;

        const gateBadge = document.getElementById("publishGateBadge");
        const overrideBtn = document.getElementById("reportOverridePublishBtn");
        const discrepancy = data.discrepancyClassification;

        const isPublished = data.status === "published";
        const isOverridePublished = Boolean(data.publishedWithValidationOverride || data.publicationMode === "override" || data.publicationMethod === "ADMIN_OVERRIDE");

        if (isPublished) {
            document.getElementById("reportProceedPublishBtn").disabled = true;
            document.getElementById("reportProceedPublishBtn").style.display = "none";
            if (overrideBtn) {
                overrideBtn.style.display = "none";
                overrideBtn.disabled = true;
            }

            if (isOverridePublished) {
                gateBadge.className = "stage-badge";
                gateBadge.style.cssText = "background: #fffbeb; color: #92400e; border: 1.5px solid #fde68a; font-weight: 700; padding: 6px 12px; border-radius: 6px;";
                gateBadge.textContent = "PUBLISHED WITH ADMINISTRATIVE OVERRIDE";
            } else {
                gateBadge.className = "stage-badge ready";
                gateBadge.textContent = "PUBLISHED";
            }
        } else {
            document.getElementById("reportProceedPublishBtn").style.display = "inline-flex";
            if (report?.canPublish) {
                gateBadge.className = "stage-badge ready";
                gateBadge.textContent = "CAN PUBLISH";
                document.getElementById("reportProceedPublishBtn").disabled = false;
                if (overrideBtn) {
                    overrideBtn.style.display = "inline-flex";
                    overrideBtn.disabled = false;
                }
            } else {
                gateBadge.className = "stage-badge review";
                gateBadge.textContent = "PUBLICATION BLOCKED";
                document.getElementById("reportProceedPublishBtn").disabled = true;

                if (overrideBtn) {
                    overrideBtn.style.display = "inline-flex";
                    overrideBtn.disabled = false;
                }
            }
        }

        // Checklist items
        const checklist = document.getElementById("reportChecklistContainer");
        checklist.innerHTML = `
            <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
                <div style="font-weight: 700; color: #1e293b; margin-bottom: 6px;">1. Source Document Integrity</div>
                ${(report?.sourceChecks?.details || []).map(d => `<div style="font-size: 13px; color: #166534;">&#10003; ${escapeHTML(d)}</div>`).join("")}
            </div>
            <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
                <div style="font-weight: 700; color: #1e293b; margin-bottom: 6px;">2. Exam Pattern Verification</div>
                ${(report?.patternChecks?.details || []).map(d => `<div style="font-size: 13px; color: ${report.patternChecks.passed ? '#166534' : '#b91c1c'};">${report.patternChecks.passed ? '&#10003;' : '&#9888;'} ${escapeHTML(d)}</div>`).join("")}
            </div>
            <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
                <div style="font-weight: 700; color: #1e293b; margin-bottom: 6px;">3. Official Answer Key Reconciliation</div>
                ${(report?.answerKeyChecks?.details || []).map(d => `<div style="font-size: 13px; color: ${report.answerKeyChecks.passed ? '#166534' : '#b91c1c'};">${report.answerKeyChecks.passed ? '&#10003;' : '&#9888;'} ${escapeHTML(d)}</div>`).join("")}
            </div>
            ${report?.blockers?.length > 0 ? `
            <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px;">
                <div style="font-weight: 700; color: #991b1b; margin-bottom: 6px;">Publication Blockers:</div>
                ${report.blockers.map(b => `<div style="font-size: 13px; color: #b91c1c;">&#10007; ${escapeHTML(b)}</div>`).join("")}
            </div>` : ''}
        `;
    } catch (e) {
        console.warn("[Admin UI] Error loading report:", e.message);
    }
}
window.loadValidationReport = loadValidationReport;

// ============================================================
// QUESTION REVIEW & MANUAL AUDIT EDIT
// ============================================================
async function loadQuestionsForReview(jobId, flaggedOnly = false) {
    const container = document.getElementById("questionsListContainer");
    container.innerHTML = `<p style="text-align: center; color: #94a3b8; padding: 30px;">Loading questions...</p>`;

    try {
        const url = `/api/admin/import/jobs/${jobId}/questions${flaggedOnly ? '?flaggedOnly=true' : ''}`;
        const res = await adminFetch(url);
        if (!res.ok) return;

        const data = await res.json();
        currentQuestions = data.questions || [];

        if (currentQuestions.length === 0) {
            container.innerHTML = `<div style="text-align: center; padding: 40px; color: #10b981; font-weight: 600;">No flagged questions! All extracted items passed structural validation.</div>`;
            return;
        }

        container.innerHTML = currentQuestions.map(q => `
            <div class="question-item-card ${q.validationStatus}" id="qcard-${escapeHTML(q.questionId)}">
                <div class="question-meta-bar">
                    <div>
                        <span class="question-tag">Q${q.questionNumber}</span>
                        <span class="question-tag subject">${escapeHTML(q.subject || 'General')}</span>
                        <span class="question-tag">${escapeHTML(q.sectionId || 'Section A')}</span>
                        ${q.questionType === 'numerical' ? '<span class="question-tag" style="background:#e0f2fe; color:#0369a1; font-weight:700;">NUMERICAL</span>' : '<span class="question-tag" style="background:#f1f5f9; color:#475569;">MCQ</span>'}
                        ${q.sourcePage ? `<span class="question-tag" style="background:#f8fafc; color:#64748b; border:1px solid #e2e8f0;">Page ${q.sourcePage}</span>` : ''}
                        ${q.hasDiagram ? '<span class="question-tag" style="background:#fef3c7; color:#92400e;">Diagram / Media</span>' : ''}
                    </div>
                    <button type="button" class="admin-btn admin-btn-secondary" style="padding: 4px 10px; font-size: 12px;" onclick="window.openQuestionEditModal('${escapeHTML(q.questionId)}')">
                        Edit &amp; Correct
                    </button>
                </div>
                <div style="font-size: 14px; font-weight: 500; color: #1e293b; margin: 10px 0; line-height: 1.6; white-space: pre-wrap;">${escapeHTML(q.questionText)}</div>
                ${q.hasDiagram && q.diagramUrl ? `
                    <div style="margin: 8px 0; max-width: 320px; max-height: 140px; overflow: hidden; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; padding: 4px;">
                        <img src="${escapeHTML(q.diagramUrl)}" alt="Question Diagram" style="max-height: 130px; max-width: 100%; object-fit: contain; display: block; margin: 0 auto;" onerror="this.parentElement.style.display='none';">
                    </div>
                ` : ''}
                ${q.questionType === 'numerical' ? `
                    <div style="font-size: 13px; color: #0369a1; background: #f0f9ff; border: 1px solid #e0f2fe; border-radius: 6px; padding: 8px 12px; margin-top: 6px; font-weight: 500;">
                        Numerical Question — Student enters integer or floating value; no MCQ options required.
                    </div>
                ` : `
                    <div class="question-options-list">
                        ${(q.options && q.options.length > 0) ? q.options.map(opt => `
                            <div class="option-pill" style="min-width: 140px;">
                                <strong>(${escapeHTML(opt.label || opt.id)})</strong> ${escapeHTML(opt.text)}
                            </div>
                        `).join("") : `
                            <div style="font-size: 13px; color: #b91c1c; font-style: italic; padding: 6px 0;">
                                No options parsed. Diagram or image inspection required.
                            </div>
                        `}
                    </div>
                `}
                ${q.flagReason ? `
                    <div class="flag-alert-box" style="margin-top: 10px;">
                        <span>&#9888;</span>
                        <span>${escapeHTML(q.flagReason)}</span>
                    </div>
                ` : ''}
            </div>
        `).join("");

    } catch (e) {
        console.warn("[Admin UI] Error loading questions:", e.message);
    }
}

// Global modal triggers
window.openQuestionEditModal = function(questionId) {
    const question = currentQuestions.find(q => q.questionId === questionId);
    if (!question) return;

    editingQuestionId = questionId;

    // Badges & metadata
    const questionBadge = document.getElementById("editModalQuestionBadge");
    const typeBadge = document.getElementById("editModalTypeBadge");
    if (questionBadge) questionBadge.textContent = `Q${question.questionNumber || '?'}`;
    if (typeBadge) {
        typeBadge.textContent = (question.questionType || "mcq").toUpperCase();
        if (question.questionType === "numerical") {
            typeBadge.style.background = "#fef3c7";
            typeBadge.style.color = "#92400e";
        } else {
            typeBadge.style.background = "#e0e7ff";
            typeBadge.style.color = "#3730a3";
        }
    }

    // Set Classification Dropdown & Diagram Toggle
    const typeSelect = document.getElementById("editQuestionType");
    if (typeSelect) {
        typeSelect.value = question.questionType || "mcq";
    }
    const diagramCheck = document.getElementById("editHasDiagram");
    if (diagramCheck) {
        diagramCheck.checked = Boolean(question.hasDiagram);
    }

    // Question body, subject, topic
    document.getElementById("editQuestionText").value = question.questionText || "";
    document.getElementById("editSubject").value = question.subjectName || question.subject || "";
    const topicInput = document.getElementById("editTopic");
    if (topicInput) topicInput.value = question.topic || "";
    document.getElementById("editAuditReason").value = "";

    const alertBox = document.getElementById("editModalAlert");
    if (alertBox) {
        alertBox.style.display = "none";
        alertBox.textContent = "";
    }

    // Render Options Helper
    window.renderEditOptionRows = function(type, options) {
        const optionsContainer = document.getElementById("editOptionsContainer");
        const optionsNotice = document.getElementById("editOptionsNotice");
        const addBtn = document.getElementById("addOptionBtn");

        if (!optionsContainer) return;

        if (type === "numerical") {
            if (optionsNotice) optionsNotice.textContent = "Numerical value (no options)";
            if (addBtn) addBtn.style.display = "none";
            optionsContainer.innerHTML = `
                <div style="background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; padding: 12px; font-size: 13px; color: #475569;">
                    <strong>Numerical Value Question (NAT):</strong> This question evaluates numerical answers directly against accepted values. No MCQ options are required.
                </div>
            `;
        } else {
            if (addBtn) addBtn.style.display = "inline-block";
            const opts = Array.isArray(options) ? options : [];
            if (optionsNotice) optionsNotice.textContent = `${opts.length} options`;

            if (opts.length === 0) {
                optionsContainer.innerHTML = `
                    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 10px; font-size: 13px; color: #92400e;">
                        No options currently defined. Click "+ Add Option" above to insert options.
                    </div>
                `;
            } else {
                optionsContainer.innerHTML = opts.map(opt => `
                    <div class="edit-option-row" data-option-id="${escapeHTML(opt.id)}" data-option-label="${escapeHTML(opt.label || opt.id)}" style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-weight: 700; width: 32px; text-align: center; background: #e2e8f0; border-radius: 4px; padding: 7px 0; font-size: 13px; color: #1e293b; flex-shrink: 0;">${escapeHTML(opt.label || opt.id)}</span>
                            <input type="text" class="edit-option-input" value="${escapeHTML(opt.text || '')}" placeholder="Option ${escapeHTML(opt.label || opt.id)} text..." style="flex: 1; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; font-family: inherit;">
                            <button type="button" class="admin-btn admin-btn-secondary" style="padding: 4px 8px; font-size: 12px; color: #ef4444;" onclick="this.closest('.edit-option-row').remove();">✕</button>
                        </div>
                        ${opt.diagramUrl ? `
                            <div style="margin-left: 40px; display: flex; align-items: center; gap: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 10px;">
                                <img src="${escapeHTML(opt.diagramUrl)}" alt="Option ${escapeHTML(opt.label || opt.id)} Diagram" style="max-height: 70px; max-width: 200px; object-fit: contain; border-radius: 4px; border: 1px solid #cbd5e1; background: #fff;" />
                                <span style="font-size: 11px; color: #64748b; font-weight: 500;">Visual Structure for Option (${escapeHTML(opt.label || opt.id)})</span>
                            </div>
                        ` : (opt.isDiagramOption || (opt.text || '').includes('[Diagram / Structure') ? `
                            <div style="margin-left: 40px; font-size: 11px; color: #d97706; background: #fffbeb; border: 1px dashed #fde68a; border-radius: 4px; padding: 5px 8px;">
                                ⚠ Visual diagram choice detected in source PDF. Verify against source page on the left.
                            </div>
                        ` : '')}
                    </div>
                `).join("");
            }
        }
    };

    renderEditOptionRows(question.questionType || "mcq", question.options || []);

    // Source Page & Diagram Asset Preview
    const sourcePage = question.sourcePage || (question.media && question.media[0]?.page) || 1;
    const pageBadge = document.getElementById("sourcePageBadge");
    if (pageBadge) pageBadge.textContent = `Page ${sourcePage}`;

    const previewUrl = `/api/admin/import/jobs/${activeJobId}/source-preview?page=${sourcePage}&docType=questionPaper#page=${sourcePage}`;
    const iframe = document.getElementById("sourcePreviewIframe");
    const directLink = document.getElementById("sourcePreviewDirectLink");
    const fallbackLink = document.getElementById("sourcePreviewFallbackLink");
    const fallbackBox = document.getElementById("sourcePreviewFallback");
    const diagramBox = document.getElementById("diagramAssetContainer");
    const diagramImg = document.getElementById("sourceDiagramPreviewImg");
    const toggleDiagBtn = document.getElementById("toggleViewDiagramBtn");

    if (iframe) {
        iframe.src = previewUrl;
        iframe.onerror = () => {
            if (fallbackBox) fallbackBox.style.display = "flex";
        };
    }
    if (directLink) directLink.href = previewUrl;
    if (fallbackLink) fallbackLink.href = previewUrl;
    if (fallbackBox) fallbackBox.style.display = "none";

    // Handle diagram asset display
    const diagramMedia = (question.media || []).find(m => m.type === "diagram" && m.url);
    const diagramUrl = question.diagramUrl || (diagramMedia ? diagramMedia.url : null);
    if (diagramUrl && diagramBox && diagramImg) {
        diagramImg.src = diagramUrl;
        diagramBox.style.display = "block";
        if (toggleDiagBtn) toggleDiagBtn.style.display = "inline-block";
    } else {
        if (diagramBox) diagramBox.style.display = "none";
        if (toggleDiagBtn) toggleDiagBtn.style.display = "none";
    }

    // Handle OCR Provenance display (Phase 4.4)
    const ocrBox = document.getElementById("ocrProvenanceContainer");
    const ocrBadge = document.getElementById("ocrConfidenceBadge");
    const ocrEngine = document.getElementById("ocrEngineText");
    const ocrMethod = document.getElementById("ocrMethodText");
    const ocrRawText = document.getElementById("ocrRawText");

    const prov = question.provenance;
    const isOcr = prov && (prov.ocrEngine || prov.extractionMethod === "ocr_layout_reconstruction" || prov.extractionMethod === "ocr");

    if (ocrBox && isOcr) {
        ocrBox.style.display = "block";
        const confPct = Math.round((prov.confidence !== undefined ? prov.confidence : 0.8) * (prov.confidence <= 1.0 ? 100 : 1));
        if (ocrBadge) {
            ocrBadge.textContent = `Conf: ${confPct}%`;
            if (confPct >= 80) {
                ocrBadge.style.background = "#dcfce7";
                ocrBadge.style.color = "#15803d";
            } else if (confPct >= 65) {
                ocrBadge.style.background = "#fef3c7";
                ocrBadge.style.color = "#92400e";
            } else {
                ocrBadge.style.background = "#fee2e2";
                ocrBadge.style.color = "#b91c1c";
            }
        }
        if (ocrEngine) ocrEngine.textContent = `${prov.ocrEngine || "tesseract.js"} ${prov.ocrVersion || "v6.0.1"}`;
        if (ocrMethod) ocrMethod.textContent = prov.extractionMethod || "ocr_layout_reconstruction";
        if (ocrRawText) ocrRawText.textContent = prov.originalOcrText || question.questionText || "";
    } else if (ocrBox) {
        ocrBox.style.display = "none";
    }

    // Handle AI Vision Provenance display (Phase 4.5)
    const visionBox = document.getElementById("visionProvenanceContainer");
    const visionBadge = document.getElementById("visionConfidenceBadge");
    const visionModel = document.getElementById("visionModelText");
    const visionAutoVerified = document.getElementById("visionAutoVerifiedBadge");

    const isVision = prov && (prov.visionModel || prov.extractionMethod === "vision_layout_reconstruction" || prov.extractionMethod === "hybrid_ocr_vision");

    if (visionBox && isVision) {
        visionBox.style.display = "block";
        const vConfPct = Math.round((prov.visionConfidence || prov.confidence || 0.9) * 100);
        if (visionBadge) {
            visionBadge.textContent = `Conf: ${vConfPct}%`;
        }
        if (visionModel) {
            visionModel.textContent = prov.visionModel || "qwen/qwen3.8-27b";
        }
        if (visionAutoVerified) {
            const isVerified = question.autoVerified || question.verificationStatus === "VERIFIED" || prov.crossModelAgreement;
            visionAutoVerified.textContent = isVerified ? "Auto-Verified" : "Needs Inspection";
            visionAutoVerified.style.color = isVerified ? "#15803d" : "#b45309";
        }
    } else if (visionBox) {
        visionBox.style.display = "none";
    }

    document.getElementById("editQuestionModal").classList.add("show");
};

function setupEditModal() {
    const modal = document.getElementById("editQuestionModal");
    const closeBtn = document.getElementById("closeEditModalBtn");
    const cancelBtn = document.getElementById("cancelEditBtn");
    const saveBtn = document.getElementById("saveQuestionEditBtn");
    const alertBox = document.getElementById("editModalAlert");
    const typeSelect = document.getElementById("editQuestionType");
    const addOptionBtn = document.getElementById("addOptionBtn");
    const toggleSourceBtn = document.getElementById("toggleViewSourceBtn");
    const toggleDiagBtn = document.getElementById("toggleViewDiagramBtn");
    const sourceContainer = document.getElementById("sourcePreviewContainer");
    const diagramContainer = document.getElementById("diagramAssetContainer");

    closeBtn?.addEventListener("click", () => modal.classList.remove("show"));
    cancelBtn?.addEventListener("click", () => modal.classList.remove("show"));

    // View toggle listeners
    toggleSourceBtn?.addEventListener("click", () => {
        if (sourceContainer) sourceContainer.style.display = "block";
        if (diagramContainer) diagramContainer.style.display = "none";
    });
    toggleDiagBtn?.addEventListener("click", () => {
        if (sourceContainer) sourceContainer.style.display = "none";
        if (diagramContainer) diagramContainer.style.display = "block";
    });

    // Handle Question Classification change
    typeSelect?.addEventListener("change", () => {
        const targetType = typeSelect.value;
        const currentRows = document.querySelectorAll("#editOptionsContainer .edit-option-row");
        const existingOpts = [];
        for (const row of currentRows) {
            const id = row.getAttribute("data-option-id");
            const label = row.getAttribute("data-option-label") || id;
            const input = row.querySelector(".edit-option-input");
            existingOpts.push({ id, label, text: input ? input.value : "" });
        }

        if (targetType === "numerical") {
            window.renderEditOptionRows("numerical", []);
        } else {
            const optsToRender = existingOpts.length > 0 ? existingOpts : [
                { id: "1", label: "A", text: "" },
                { id: "2", label: "B", text: "" },
                { id: "3", label: "C", text: "" },
                { id: "4", label: "D", text: "" }
            ];
            window.renderEditOptionRows(targetType, optsToRender);
        }
    });

    // Handle Add Option button
    addOptionBtn?.addEventListener("click", () => {
        const rows = document.querySelectorAll("#editOptionsContainer .edit-option-row");
        const letters = ["A", "B", "C", "D", "E", "F"];
        const nextIdx = rows.length;
        const nextLabel = letters[nextIdx] || String(nextIdx + 1);
        const nextId = String(nextIdx + 1);

        const container = document.getElementById("editOptionsContainer");
        const row = document.createElement("div");
        row.className = "edit-option-row";
        row.setAttribute("data-option-id", nextId);
        row.setAttribute("data-option-label", nextLabel);
        row.style.cssText = "display: flex; align-items: center; gap: 8px;";
        row.innerHTML = `
            <span style="font-weight: 700; width: 32px; text-align: center; background: #e2e8f0; border-radius: 4px; padding: 7px 0; font-size: 13px; color: #1e293b; flex-shrink: 0;">${nextLabel}</span>
            <input type="text" class="edit-option-input" value="" placeholder="Option ${nextLabel} text..." style="flex: 1; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; font-family: inherit;">
            <button type="button" class="admin-btn admin-btn-secondary" style="padding: 4px 8px; font-size: 12px; color: #ef4444;" onclick="this.closest('.edit-option-row').remove();">✕</button>
        `;
        container.appendChild(row);

        const notice = document.getElementById("editOptionsNotice");
        if (notice) notice.textContent = `${rows.length + 1} options`;
    });

    saveBtn?.addEventListener("click", async () => {
        const question = currentQuestions.find(q => q.questionId === editingQuestionId);
        if (!question) return;

        const text = document.getElementById("editQuestionText").value.trim();
        const subject = document.getElementById("editSubject").value.trim();
        const topic = document.getElementById("editTopic") ? document.getElementById("editTopic").value.trim() : "";
        const reason = document.getElementById("editAuditReason").value.trim();
        const targetType = typeSelect ? typeSelect.value : (question.questionType || "mcq");
        const hasDiagram = document.getElementById("editHasDiagram") ? document.getElementById("editHasDiagram").checked : Boolean(question.hasDiagram);

        if (alertBox) alertBox.style.display = "none";

        if (!reason || reason.length < 5) {
            if (alertBox) {
                alertBox.style.display = "block";
                alertBox.style.background = "#fef2f2";
                alertBox.style.border = "1px solid #fecaca";
                alertBox.style.color = "#991b1b";
                alertBox.textContent = "An audit reason of at least 5 characters is required for accountability.";
            } else {
                alert("An audit reason of at least 5 characters is required.");
            }
            return;
        }

        // Build updates payload
        const updates = {
            questionText: text,
            questionType: targetType,
            hasDiagram,
            subject,
            subjectName: subject,
            topic
        };

        // If MCQ/MSQ, extract options
        if (targetType === "numerical") {
            updates.options = [];
        } else {
            const rows = document.querySelectorAll("#editOptionsContainer .edit-option-row");
            const updatedOptions = [];
            for (const row of rows) {
                const id = row.getAttribute("data-option-id");
                const label = row.getAttribute("data-option-label") || id;
                const input = row.querySelector(".edit-option-input");
                const optText = input ? input.value.trim() : "";
                if (!optText) {
                    if (alertBox) {
                        alertBox.style.display = "block";
                        alertBox.style.background = "#fef2f2";
                        alertBox.style.border = "1px solid #fecaca";
                        alertBox.style.color = "#991b1b";
                        alertBox.textContent = `Option ${label} cannot have empty text.`;
                    } else {
                        alert(`Option ${label} cannot have empty text.`);
                    }
                    return;
                }
                const existingOpt = (question.options || []).find(o => String(o.id) === String(id));
                updatedOptions.push({
                    id,
                    label,
                    text: optText,
                    diagramUrl: existingOpt?.diagramUrl,
                    diagramId: existingOpt?.diagramId,
                    hasDiagram: existingOpt?.hasDiagram,
                    isDiagramOption: existingOpt?.isDiagramOption
                });
            }

            if (updatedOptions.length < 2) {
                if (alertBox) {
                    alertBox.style.display = "block";
                    alertBox.style.background = "#fef2f2";
                    alertBox.style.border = "1px solid #fecaca";
                    alertBox.style.color = "#991b1b";
                    alertBox.textContent = "Multiple-choice questions must have at least 2 options.";
                } else {
                    alert("Multiple-choice questions must have at least 2 options.");
                }
                return;
            }

            updates.options = updatedOptions;
        }

        try {
            saveBtn.disabled = true;
            saveBtn.textContent = "Saving & Revalidating...";

            const res = await adminFetch(`/api/admin/import/jobs/${activeJobId}/questions/${editingQuestionId}`, {
                method: "PUT",
                body: {
                    updates,
                    reason
                }
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || "Failed to update question");
            }

            // Only close and report success AFTER backend confirms
            modal.classList.remove("show");
            saveBtn.disabled = false;
            saveBtn.textContent = "Save Correction";

            // Refresh questions & validation report
            await loadQuestionsForReview(activeJobId);
            if (typeof loadValidationReport === "function") {
                loadValidationReport(activeJobId);
            }
        } catch (err) {
            if (alertBox) {
                alertBox.style.display = "block";
                alertBox.style.background = "#fef2f2";
                alertBox.style.border = "1px solid #fecaca";
                alertBox.style.color = "#991b1b";
                alertBox.textContent = `Correction Failed: ${err.message}`;
            } else {
                alert(`Error: ${err.message}`);
            }
            saveBtn.disabled = false;
            saveBtn.textContent = "Save Correction";
        }
    });
}

function setupPublishModal() {
    const modal = document.getElementById("publishConfirmModal");
    const proceedBtn = document.getElementById("reportProceedPublishBtn");
    const closeBtn = document.getElementById("closePublishModalBtn");
    const cancelBtn = document.getElementById("cancelPublishBtn");
    const executeBtn = document.getElementById("executePublishBtn");

    proceedBtn?.addEventListener("click", () => {
        if (proceedBtn.disabled || proceedBtn.hasAttribute("disabled")) {
            console.warn("[Admin UI] Proceed to publish blocked: publication gates have not passed.");
            return;
        }
        modal.classList.add("show");
    });

    closeBtn?.addEventListener("click", () => modal.classList.remove("show"));
    cancelBtn?.addEventListener("click", () => modal.classList.remove("show"));

    executeBtn?.addEventListener("click", async () => {
        try {
            executeBtn.disabled = true;
            executeBtn.textContent = "Publishing...";

            const res = await adminFetch(`/api/admin/import/jobs/${activeJobId}/publish`, {
                method: "POST"
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || "Publication failed");
            }

            modal.classList.remove("show");
            alert("Success! The paper has been published and is now live for student practice.");
            executeBtn.disabled = false;
            executeBtn.textContent = "Confirm & Publish Paper";

            loadOverviewMetrics();
            switchTab("overview");
        } catch (err) {
            alert(`Publication Error: ${err.message}`);
            executeBtn.disabled = false;
            executeBtn.textContent = "Confirm & Publish Paper";
        }
    });
}

// ============================================================
// PUBLISH OVERRIDE CONFIRMATION MODAL & ACTION
// ============================================================
// ============================================================
// PHASE 5.12: PUBLISH OVERRIDE CONFIRMATION MODAL & ACTION
// ============================================================
function setupOverrideModal() {
    const overrideModal = document.getElementById("overridePublishModal");
    const openBtn = document.getElementById("reportOverridePublishBtn");
    const closeBtn = document.getElementById("closeOverrideModalBtn");
    const cancelBtn = document.getElementById("cancelOverrideBtn");
    const executeBtn = document.getElementById("executeOverridePublishBtn");
    const reasonInput = document.getElementById("overrideReasonInput");
    const alertBox = document.getElementById("overrideModalAlert");
    const discrepanciesList = document.getElementById("overrideDiscrepanciesList");

    closeBtn?.addEventListener("click", () => overrideModal.classList.remove("show"));
    cancelBtn?.addEventListener("click", () => overrideModal.classList.remove("show"));

    openBtn?.addEventListener("click", async () => {
        if (!activeJobId) return;

        if (alertBox) {
            alertBox.style.display = "none";
            alertBox.textContent = "";
        }
        if (reasonInput) reasonInput.value = "";
        if (executeBtn) {
            executeBtn.disabled = true;
            executeBtn.innerHTML = `Loading discrepancies...`;
        }
        if (discrepanciesList) {
            discrepanciesList.innerHTML = `<p style="text-align: center; color: #94a3b8; font-size: 13px; padding: 12px; margin: 0;">Loading validation findings...</p>`;
        }

        overrideModal.classList.add("show");

        try {
            let res = await adminFetch(`/api/admin/import/jobs/${activeJobId}/discrepancies`);
            if (!res.ok) {
                res = await adminFetch(`/api/admin/mock-tests/${activeJobId}/discrepancies`);
            }
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || errData.message || "Failed to fetch discrepancies");
            }

            const data = await res.json();
            const classification = data.discrepancyClassification || data;
            const counts = classification.counts || {
                total: classification.totalDiscrepancies || 0,
                critical: (classification.criticalErrors || classification.fatalBlockers || []).length,
                major: (classification.majorErrors || []).length,
                minor: (classification.minorErrors || []).length,
                warning: (classification.warnings || classification.eligibleWarnings || []).length,
                other: (classification.otherFindings || []).length
            };

            // Summary counts (6 categories)
            const totalEl = document.getElementById("overrideTotalCount");
            const critEl = document.getElementById("overrideCriticalCount");
            const majEl = document.getElementById("overrideMajorCount");
            const minEl = document.getElementById("overrideMinorCount");
            const warnEl = document.getElementById("overrideWarningCount");
            const othEl = document.getElementById("overrideOtherCount");

            if (totalEl) totalEl.textContent = counts.total ?? 0;
            if (critEl) critEl.textContent = counts.critical ?? 0;
            if (majEl) majEl.textContent = counts.major ?? 0;
            if (minEl) minEl.textContent = counts.minor ?? 0;
            if (warnEl) warnEl.textContent = counts.warning ?? 0;
            if (othEl) othEl.textContent = counts.other ?? 0;

            // Render detailed findings
            const allFindings = classification.allDiscrepancies || classification.findings || [];
            if (discrepanciesList) {
                if (allFindings.length === 0) {
                    discrepanciesList.innerHTML = `
                        <div style="text-align: center; padding: 16px; color: #166534; background: #f0fdf4; border-radius: 6px; font-weight: 600; font-size: 13px;">
                            No unresolved discrepancies found in this report.
                        </div>
                    `;
                } else {
                    const badgeStyles = {
                        critical: "background: #fee2e2; color: #991b1b; border: 1px solid #fecaca;",
                        fatal: "background: #fee2e2; color: #991b1b; border: 1px solid #fecaca;",
                        major: "background: #ffedd5; color: #9a3412; border: 1px solid #fed7aa;",
                        minor: "background: #fef9c3; color: #854d0e; border: 1px solid #fef08a;",
                        warning: "background: #fef3c7; color: #92400e; border: 1px solid #fde68a;",
                        other: "background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0;"
                    };

                    discrepanciesList.innerHTML = allFindings.map((f, idx) => {
                        const sev = String(f.severity || "warning").toLowerCase();
                        const badgeStyle = badgeStyles[sev] || badgeStyles.other;
                        const qRef = f.questionNumber ? `Question ${f.questionNumber}` : (f.questionId || (f.sectionId ? `Section ${f.sectionId}` : ""));

                        return `
                            <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; font-size: 13px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px;">
                                    <span style="font-weight: 700; color: #1e293b;">
                                        ${idx + 1}. ${escapeHTML(f.title || f.category || "Validation Discrepancy")}
                                    </span>
                                    <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 9999px; ${badgeStyle}">
                                        ${escapeHTML(sev.toUpperCase())}
                                    </span>
                                </div>
                                <div style="color: #475569; line-height: 1.45; margin-bottom: 4px;">
                                    ${escapeHTML(f.description || f.message || "Discrepancy detected during validation pipeline.")}
                                </div>
                                ${qRef ? `<div style="font-size: 11px; color: #64748b; font-weight: 600;">Reference: ${escapeHTML(qRef)}</div>` : ""}
                                ${f.diagnosticInfo ? `<div style="font-size: 11px; color: #dc2626; font-family: monospace; margin-top: 2px;">Details: ${escapeHTML(typeof f.diagnosticInfo === "object" ? JSON.stringify(f.diagnosticInfo) : f.diagnosticInfo)}</div>` : ""}
                            </div>
                        `;
                    }).join("");
                }
            }

            // Enable confirmation button
            if (executeBtn) {
                executeBtn.disabled = false;
                executeBtn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                    Confirm Ignore and Publish
                `;
            }

        } catch (e) {
            console.warn("[Admin UI] Error opening override modal:", e.message);
            if (alertBox) {
                alertBox.style.display = "block";
                alertBox.style.background = "#fef2f2";
                alertBox.style.border = "1px solid #fecaca";
                alertBox.style.color = "#991b1b";
                alertBox.textContent = `Could not fetch discrepancy details: ${e.message}`;
            }
            if (executeBtn) {
                executeBtn.disabled = false;
                executeBtn.innerHTML = `Confirm Ignore and Publish`;
            }
        }
    });

    executeBtn?.addEventListener("click", async () => {
        if (!activeJobId) return;

        try {
            executeBtn.disabled = true;
            executeBtn.innerHTML = `Publishing with Override...`;

            if (alertBox) {
                alertBox.style.display = "none";
                alertBox.textContent = "";
            }

            const reason = (reasonInput?.value || "").trim();

            const res = await adminFetch(`/api/admin/import/jobs/${activeJobId}/override-publish`, {
                method: "POST",
                body: { reason }
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || errData.message || "Publication override failed");
            }

            const resData = await res.json();
            overrideModal.classList.remove("show");
            
            alert("Success! The mock test has been published with administrative validation override.");
            
            executeBtn.disabled = false;
            executeBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                Confirm Ignore and Publish
            `;

            // Reload report to reflect published state and update metrics
            await loadValidationReport(activeJobId);
            loadOverviewMetrics();

        } catch (err) {
            console.error("[Admin UI] Error executing override publish:", err);
            if (alertBox) {
                alertBox.style.display = "block";
                alertBox.style.background = "#fef2f2";
                alertBox.style.border = "1px solid #fecaca";
                alertBox.style.color = "#991b1b";
                alertBox.textContent = `Override Denied: ${err.message}`;
            } else {
                alert(`Override Denied: ${err.message}`);
            }
            executeBtn.disabled = false;
            executeBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                Confirm Ignore and Publish
            `;
        }
    });
}

// ============================================================
// IMPORT HISTORY VIEW
// ============================================================
async function loadImportHistory() {
    const tbody = document.getElementById("historyTableBody");
    if (!tbody) return;

    try {
        const search = document.getElementById("historySearchInput")?.value || "";
        const status = document.getElementById("historyStatusFilter")?.value || "";

        const query = new URLSearchParams();
        if (search) query.append("search", search);
        if (status) query.append("status", status);

        const res = await adminFetch(`/api/admin/import/jobs?${query.toString()}`);
        if (!res.ok) return;

        const { jobs } = await res.json();
        if (jobs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #94a3b8; padding: 24px;">No matching import jobs found.</td></tr>`;
            return;
        }

        tbody.innerHTML = jobs.map(j => `
            <tr>
                <td><strong>${escapeHTML(j.jobId)}</strong></td>
                <td>${escapeHTML((j.examId || "").toUpperCase())}</td>
                <td>${j.year}</td>
                <td><span class="question-tag">${escapeHTML(j.paperCode || "Q1")}</span></td>
                <td><span class="stage-badge ${getStatusBadgeClass(j.status)}">${formatStatus(j.status)}</span></td>
                <td>${j.extractedQuestionCount || 0}</td>
                <td>${j.verifiedAnswerCount || 0}</td>
                <td>
                    <div class="admin-table-actions">
                        <button type="button" class="admin-btn admin-btn-secondary" onclick="window.viewJobProgress('${escapeHTML(j.jobId)}')">
                            Open Job
                        </button>
                        <button type="button" class="admin-btn admin-btn-danger" style="background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; cursor: pointer; font-weight: 600;" onclick="window.confirmDeleteMockTest('${escapeHTML(j.testId || '')}', '${escapeHTML(j.jobId)}')">
                            Delete Mock Test
                        </button>
                    </div>
                </td>
            </tr>
        `).join("");

    } catch (e) {
        console.warn("[Admin UI] Error loading history:", e.message);
    }
}

window.viewJobProgress = function(jobId) {
    activeJobId = jobId;
    document.getElementById("progressTabBtn").style.display = "inline-flex";
    document.getElementById("reportTabBtn").style.display = "inline-flex";
    document.getElementById("reviewTabBtn").style.display = "inline-flex";
    switchTab("progress");
    startPollingJob(jobId);
};

// Quick action button
document.getElementById("startNewImportBtn")?.addEventListener("click", () => {
    switchTab("upload");
});

document.getElementById("viewReportBtn")?.addEventListener("click", () => {
    switchTab("report");
});

document.getElementById("reviewQuestionsBtn")?.addEventListener("click", () => {
    switchTab("review");
});

document.getElementById("reportToReviewBtn")?.addEventListener("click", () => {
    switchTab("review");
});

document.getElementById("filterAllQuestionsBtn")?.addEventListener("click", () => {
    loadQuestionsForReview(activeJobId, false);
});

document.getElementById("filterFlaggedQuestionsBtn")?.addEventListener("click", () => {
    loadQuestionsForReview(activeJobId, true);
});

document.getElementById("historySearchInput")?.addEventListener("input", () => {
    loadImportHistory();
});

document.getElementById("historyStatusFilter")?.addEventListener("change", () => {
    loadImportHistory();
});

document.getElementById("adminLoginBtn")?.addEventListener("click", () => {
    showAuthModal();
});

// Formatters
function getStatusBadgeClass(status) {
    if (status === "published" || status === "ready_to_publish") return "ready";
    if (status === "needs_review") return "review";
    if (status === "failed") return "failed";
    return "processing";
}

function formatStatus(status) {
    if (!status) return "Unknown";
    return status.replace(/_/g, " ").toUpperCase();
}

function escapeHTML(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, (m) => {
        const chars = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return chars[m];
    });
}

// ============================================================
// ADMIN USER MANAGEMENT & ROLE ASSIGNMENT
// ============================================================

async function checkBootstrapStatus() {
    try {
        const res = await fetch("/api/admin/users/bootstrap-status");
        if (res.ok) {
            const data = await res.json();
            const banner = document.getElementById("bootstrapBanner");
            if (banner) {
                banner.style.display = data.bootstrapAvailable ? "block" : "none";
            }
        }
    } catch (e) {
        console.warn("[Admin UI] Error checking bootstrap status:", e.message);
    }
}

async function loadAdminUsers() {
    const tableBody = document.getElementById("adminUsersTableBody");
    if (!tableBody) return;

    try {
        const res = await adminFetch("/api/admin/users");
        if (!res.ok) {
            if (res.status === 403) {
                tableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #ef4444; padding: 20px;">Access Denied: Administrator permissions required.</td></tr>`;
            }
            return;
        }

        const data = await res.json();
        const users = data.users || [];

        const statTotal = document.getElementById("statAdminUsersTotal");
        const badge = document.getElementById("adminUsersCountBadge");

        if (statTotal) statTotal.textContent = users.length;
        if (badge) badge.textContent = users.length;

        if (users.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #94a3b8; padding: 24px;">No administrator accounts registered in Firestore yet.</td></tr>`;
            return;
        }

        tableBody.innerHTML = "";
        users.forEach(u => {
            const tr = document.createElement("tr");

            tr.innerHTML = `
                <td>
                    <div style="font-weight: 700; color: #1e293b;">${escapeHTML(u.name || u.email || "Administrator")}</div>
                    <div style="font-size: 12px; color: #64748b;">${escapeHTML(u.email || "")}</div>
                </td>
                <td>
                    <code style="font-size: 12px; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${escapeHTML(u.uid)}</code>
                </td>
                <td>
                    <span class="role-badge admin" style="background: #eef2ff; color: #4338ca; padding: 4px 10px; border-radius: 9999px; font-weight: 700; font-size: 12px;">admin</span>
                </td>
                <td>
                    <span class="status-pill active" style="background: #ecfdf5; color: #047857; padding: 3px 8px; border-radius: 6px; font-size: 12px; font-weight: 600;">Active (Firestore)</span>
                </td>
                <td>
                    <code style="font-size: 12px; color: #475569;">users/${escapeHTML(u.uid)}</code>
                </td>
            `;

            tableBody.appendChild(tr);
        });

    } catch (err) {
        console.error("[Admin UI] Error loading admin users:", err.message);
        tableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #ef4444; padding: 20px;">Failed to load administrators.</td></tr>`;
    }
}

function setupUserManagement() {
    // Refresh button for admin list
    document.getElementById("refreshAdminUsersBtn")?.addEventListener("click", () => {
        loadAdminUsers();
    });
}

// ============================================================
// PERMANENT MOCK TEST DELETION CONTROLLER
// ============================================================
const currentDeleteTarget = {
    mode: "test", // "test" or "job"
    testId: null,
    jobId: null,
    operationId: null
};

window.confirmDeleteMockTest = async function(initialTestId, jobId) {
    const modal = document.getElementById("deleteMockTestModal");
    const alertBox = document.getElementById("deleteModalAlert");
    const confirmInput = document.getElementById("deleteConfirmationInput");
    const reasonInput = document.getElementById("deleteReasonInput");
    const executeBtn = document.getElementById("executeDeleteBtn");
    const retryBtn = document.getElementById("retryDeleteBtn");
    const multiContainer = document.getElementById("deleteMultiTestSelectorContainer");
    const selectElem = document.getElementById("deleteSpecificTestSelect");

    if (!modal) return;

    if (alertBox) {
        alertBox.style.display = "none";
        alertBox.textContent = "";
    }
    if (confirmInput) confirmInput.value = "";
    if (reasonInput) reasonInput.value = "";
    if (retryBtn) retryBtn.style.display = "none";
    if (executeBtn) {
        executeBtn.disabled = true;
        executeBtn.style.opacity = "0.5";
        executeBtn.style.cursor = "not-allowed";
        executeBtn.textContent = "Permanently Delete Mock Test";
    }

    currentDeleteTarget.jobId = jobId;
    currentDeleteTarget.testId = initialTestId;
    currentDeleteTarget.operationId = null;
    currentDeleteTarget.mode = "test";

    let targetTestId = initialTestId;
    let jobTests = [];

    // Check if job contains multiple tests or resolve testId if missing
    if (jobId) {
        try {
            const res = await adminFetch(`/api/admin/import/jobs/${encodeURIComponent(jobId)}/mock-tests`);
            if (res.ok) {
                const data = await res.json();
                jobTests = data.tests || [];
                if (jobTests.length > 1) {
                    if (multiContainer && selectElem) {
                        multiContainer.style.display = "block";
                        selectElem.innerHTML = jobTests.map(t => `
                            <option value="${escapeHTML(t.testId)}" ${t.testId === initialTestId ? 'selected' : ''}>
                                ${escapeHTML(t.title || t.testId)} (${escapeHTML(t.paperCode || '')}) [${t.status}]
                            </option>
                        `).join("") + `
                            <option value="__ALL_JOB_DATA__">Delete Entire Import Job & All Data (${escapeHTML(jobId)})</option>
                        `;
                        targetTestId = selectElem.value;
                    }
                } else if (jobTests.length === 1) {
                    targetTestId = jobTests[0].testId;
                    if (multiContainer) multiContainer.style.display = "none";
                } else {
                    // jobTests.length === 0: No published test document exists in Firestore for this job!
                    targetTestId = null;
                    if (multiContainer) multiContainer.style.display = "none";
                }
            }
        } catch (e) {
            console.warn("[Admin UI] Notice resolving job tests:", e.message);
        }
    }

    // If no published test exists, switch to Incomplete Import Job Data Deletion workflow
    if (!targetTestId || targetTestId === "__ALL_JOB_DATA__") {
        if (!jobId) {
            alert("No test or import job ID could be identified for deletion.");
            return;
        }
        await populateJobDeleteModalManifest(jobId);
        modal.style.display = "flex";
        return;
    }

    // Published test deletion workflow
    currentDeleteTarget.mode = "test";
    currentDeleteTarget.testId = targetTestId;
    await populateDeleteModalManifest(targetTestId);
    modal.style.display = "flex";
};

async function populateDeleteModalManifest(testId) {
    currentDeleteTarget.mode = "test";
    currentDeleteTarget.testId = testId;

    const headingElem = document.getElementById("deleteModalHeading");
    const targetLabel = document.getElementById("deleteModalTargetLabel");
    const titleElem = document.getElementById("deleteModalTestTitle");
    const idLabel = document.getElementById("deleteModalIdLabel");
    const idElem = document.getElementById("deleteModalTestId");
    const examElem = document.getElementById("deleteModalExam");
    const yearElem = document.getElementById("deleteModalYear");
    const codeElem = document.getElementById("deleteModalPaperCode");
    const count1Label = document.getElementById("deleteModalCount1Label");
    const qCountElem = document.getElementById("deleteModalQuestionCount");
    const count2Label = document.getElementById("deleteModalCount2Label");
    const aCountElem = document.getElementById("deleteModalAttemptCount");
    const phraseElem = document.getElementById("deleteExpectedPhrase");
    const alertBox = document.getElementById("deleteModalAlert");
    const executeBtn = document.getElementById("executeDeleteBtn");
    const impactList = document.getElementById("deleteModalImpactList");

    if (headingElem) {
        headingElem.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg> Permanent Mock Test Deletion`;
    }
    if (targetLabel) targetLabel.textContent = "Target Published Mock Test";
    if (idLabel) idLabel.textContent = "Test ID:";
    if (count1Label) count1Label.textContent = "Questions:";
    if (count2Label) count2Label.textContent = "Student Attempts:";
    if (executeBtn) executeBtn.textContent = "Permanently Delete Mock Test";
    if (titleElem) titleElem.textContent = "Loading test manifest...";
    if (phraseElem) phraseElem.textContent = testId;
    if (impactList) {
        impactList.innerHTML = `
            <li>The test will immediately vanish from the student mock test catalog.</li>
            <li>All existing student attempts, autosaved answers, and scoring results will be permanently removed.</li>
            <li>Test-specific answer keys and exclusively owned questions will be deleted.</li>
            <li>Shared questions and source PDFs referenced by other tests/jobs will remain intact.</li>
        `;
    }

    try {
        const jobParam = currentDeleteTarget.jobId ? `?jobId=${encodeURIComponent(currentDeleteTarget.jobId)}` : "";
        const res = await adminFetch(`/api/admin/mock-tests/${encodeURIComponent(testId)}/deletion-manifest${jobParam}`);
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${res.status}`);
        }
        const { manifest } = await res.json();
        currentDeleteTarget.operationId = manifest.operationId;
        const s = manifest.testSummary || {};
        const c = manifest.counts || {};

        if (titleElem) titleElem.textContent = s.title || testId;
        if (idElem) idElem.textContent = testId;
        if (examElem) examElem.textContent = (s.examName || s.examId || "-").toUpperCase();
        if (yearElem) yearElem.textContent = s.year || "-";
        if (codeElem) codeElem.textContent = s.paperCode || "-";
        if (qCountElem) qCountElem.textContent = `${c.questionsExclusive || 0} exclusive (${c.questionsShared || 0} shared preserved)`;
        if (aCountElem) aCountElem.textContent = `${c.attempts || 0} (${c.results || 0} evaluated)`;
        if (phraseElem) phraseElem.textContent = testId;

        if (manifest.status === "NOTHING_TO_DELETE" || manifest.nothingToDelete) {
            if (alertBox) {
                alertBox.style.display = "block";
                alertBox.style.background = "#eff6ff";
                alertBox.style.color = "#1e40af";
                alertBox.style.border = "1px solid #bfdbfe";
                alertBox.textContent = "Nothing to delete: Backend verified that no relevant test or job-owned data remains.";
            }
        } else if (manifest.parentDocumentMissing || s.parentDocumentMissing) {
            if (alertBox) {
                alertBox.style.display = "block";
                alertBox.style.background = "#fffbeb";
                alertBox.style.color = "#92400e";
                alertBox.style.border = "1px solid #fde68a";
                alertBox.textContent = "Test document missing; recovery required: The parent mock test document is absent, but associated records or import job were discovered. Recovery cleanup will proceed upon confirmation.";
            }
        }

    } catch (err) {
        console.error("[Admin UI] Failed to load test manifest:", err.message);
        if (alertBox) {
            alertBox.style.display = "block";
            alertBox.style.background = "#fef2f2";
            alertBox.style.color = "#991b1b";
            alertBox.style.border = "1px solid #fecaca";
            alertBox.textContent = `Error loading test manifest: ${err.message}`;
        }
    }
}

async function populateJobDeleteModalManifest(jobId) {
    currentDeleteTarget.mode = "job";
    currentDeleteTarget.jobId = jobId;
    currentDeleteTarget.testId = null;

    const headingElem = document.getElementById("deleteModalHeading");
    const targetLabel = document.getElementById("deleteModalTargetLabel");
    const titleElem = document.getElementById("deleteModalTestTitle");
    const idLabel = document.getElementById("deleteModalIdLabel");
    const idElem = document.getElementById("deleteModalTestId");
    const examElem = document.getElementById("deleteModalExam");
    const yearElem = document.getElementById("deleteModalYear");
    const codeElem = document.getElementById("deleteModalPaperCode");
    const count1Label = document.getElementById("deleteModalCount1Label");
    const qCountElem = document.getElementById("deleteModalQuestionCount");
    const count2Label = document.getElementById("deleteModalCount2Label");
    const aCountElem = document.getElementById("deleteModalAttemptCount");
    const phraseElem = document.getElementById("deleteExpectedPhrase");
    const alertBox = document.getElementById("deleteModalAlert");
    const executeBtn = document.getElementById("executeDeleteBtn");
    const impactList = document.getElementById("deleteModalImpactList");

    if (headingElem) {
        headingElem.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg> Delete Incomplete Import Data & Drafts`;
    }
    if (targetLabel) targetLabel.textContent = "Target Incomplete Import Job";
    if (idLabel) idLabel.textContent = "Job ID:";
    if (count1Label) count1Label.textContent = "Draft Questions:";
    if (count2Label) count2Label.textContent = "Draft Keys / Files:";
    if (executeBtn) executeBtn.textContent = "Permanently Delete Import Data";
    if (titleElem) titleElem.textContent = "Loading import job manifest...";
    if (phraseElem) phraseElem.textContent = jobId;
    if (impactList) {
        impactList.innerHTML = `
            <li>Draft extracted questions and partially normalized questions will be deleted.</li>
            <li>Draft answer keys and verification records will be removed.</li>
            <li>Job-exclusive uploaded source PDFs and intermediate files will be purged.</li>
            <li>The import job record will be permanently deleted from Firestore.</li>
            <li>Shared assets and sibling tests/jobs will remain intact.</li>
        `;
    }

    try {
        const res = await adminFetch(`/api/admin/import/jobs/${encodeURIComponent(jobId)}/deletion-manifest`);
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${res.status}`);
        }
        const { manifest } = await res.json();
        currentDeleteTarget.operationId = manifest.operationId;
        const s = manifest.jobSummary || {};
        const c = manifest.counts || {};

        if (titleElem) titleElem.textContent = `${(s.examName || s.examId || "Import").toUpperCase()} ${s.year || ""} (${s.paperCode || "-"}) [${(s.status || "").toUpperCase()}]`;
        if (idElem) idElem.textContent = jobId;
        if (examElem) examElem.textContent = (s.examName || s.examId || "-").toUpperCase();
        if (yearElem) yearElem.textContent = s.year || "-";
        if (codeElem) codeElem.textContent = s.paperCode || "-";
        if (qCountElem) qCountElem.textContent = `${c.draftQuestions || 0} draft questions`;
        if (aCountElem) aCountElem.textContent = `${c.draftAnswerKeys || 0} keys (${c.storageFilesToDelete || 0} vault files)`;
        if (phraseElem) phraseElem.textContent = jobId;

    } catch (err) {
        console.error("[Admin UI] Failed to load job deletion manifest:", err.message);
        if (alertBox) {
            alertBox.style.display = "block";
            alertBox.style.background = "#fef2f2";
            alertBox.style.color = "#991b1b";
            alertBox.style.border = "1px solid #fecaca";
            alertBox.textContent = `Error loading job deletion manifest: ${err.message}`;
        }
    }
}

function setupDeleteModal() {
    const modal = document.getElementById("deleteMockTestModal");
    const closeBtn = document.getElementById("closeDeleteModalBtn");
    const cancelBtn = document.getElementById("cancelDeleteBtn");
    const retryBtn = document.getElementById("retryDeleteBtn");
    const confirmInput = document.getElementById("deleteConfirmationInput");
    const executeBtn = document.getElementById("executeDeleteBtn");
    const reasonInput = document.getElementById("deleteReasonInput");
    const alertBox = document.getElementById("deleteModalAlert");
    const selectElem = document.getElementById("deleteSpecificTestSelect");

    const closeModal = () => {
        if (modal) modal.style.display = "none";
        if (retryBtn) retryBtn.style.display = "none";
    };

    closeBtn?.addEventListener("click", closeModal);
    cancelBtn?.addEventListener("click", closeModal);

    // If multi-test selector changes
    selectElem?.addEventListener("change", async (e) => {
        const selectedVal = e.target.value;
        if (confirmInput) confirmInput.value = "";
        if (executeBtn) {
            executeBtn.disabled = true;
            executeBtn.style.opacity = "0.5";
            executeBtn.style.cursor = "not-allowed";
        }
        if (selectedVal === "__ALL_JOB_DATA__") {
            await populateJobDeleteModalManifest(currentDeleteTarget.jobId);
        } else {
            await populateDeleteModalManifest(selectedVal);
        }
    });

    // Confirmation input typing verification
    confirmInput?.addEventListener("input", (e) => {
        const val = e.target.value.trim();
        const expected = (currentDeleteTarget.mode === "job" ? currentDeleteTarget.jobId : currentDeleteTarget.testId) || "";
        const expectedTrimmed = expected.trim();
        const expectedPrefixed = `DELETE ${expectedTrimmed}`;
        const isValid = val === expectedTrimmed || val.toUpperCase() === expectedPrefixed.toUpperCase();

        if (isValid && expectedTrimmed.length > 0) {
            executeBtn.disabled = false;
            executeBtn.style.opacity = "1";
            executeBtn.style.cursor = "pointer";
        } else {
            executeBtn.disabled = true;
            executeBtn.style.opacity = "0.5";
            executeBtn.style.cursor = "not-allowed";
        }
    });

    // Retry button click handler
    retryBtn?.addEventListener("click", async () => {
        const opId = currentDeleteTarget.operationId;
        if (!opId) return;

        retryBtn.disabled = true;
        retryBtn.style.opacity = "0.6";
        retryBtn.textContent = "Retrying...";

        if (alertBox) {
            alertBox.style.display = "block";
            alertBox.style.background = "#eff6ff";
            alertBox.style.color = "#1e40af";
            alertBox.style.border = "1px solid #bfdbfe";
            alertBox.textContent = `Resuming deletion operation '${opId}'...`;
        }

        try {
            const res = await adminFetch(`/api/admin/mock-tests/deletions/${encodeURIComponent(opId)}/retry`, {
                method: "POST"
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }

            if (alertBox) {
                alertBox.style.background = "#ecfdf5";
                alertBox.style.color = "#065f46";
                alertBox.style.border = "1px solid #a7f3d0";
                alertBox.textContent = `✓ Deletion operation resumed and completed successfully.`;
            }

            retryBtn.style.display = "none";
            await loadImportHistory();
            setTimeout(() => {
                closeModal();
            }, 1800);

        } catch (err) {
            console.error("[Admin UI] Retry error:", err.message);
            if (alertBox) {
                alertBox.style.background = "#fef2f2";
                alertBox.style.color = "#991b1b";
                alertBox.style.border = "1px solid #fecaca";
                alertBox.textContent = `Retry error: ${err.message}.`;
            }
            retryBtn.disabled = false;
            retryBtn.style.opacity = "1";
            retryBtn.textContent = "Retry Deletion";
        }
    });

    // Execute delete button click
    executeBtn?.addEventListener("click", async () => {
        if (executeBtn.disabled) return;

        const isJobMode = currentDeleteTarget.mode === "job";
        const targetId = isJobMode ? currentDeleteTarget.jobId : currentDeleteTarget.testId;
        if (!targetId) return;

        const confirmation = confirmInput?.value.trim() || "";
        const reason = reasonInput?.value.trim() || "";

        executeBtn.disabled = true;
        executeBtn.style.opacity = "0.6";
        executeBtn.textContent = "Deleting permanently...";

        if (alertBox) {
            alertBox.style.display = "block";
            alertBox.style.background = "#eff6ff";
            alertBox.style.color = "#1e40af";
            alertBox.style.border = "1px solid #bfdbfe";
            alertBox.textContent = isJobMode 
                ? "Processing permanent deletion of import job and exclusive draft data..."
                : "Processing cascade deletion across Firestore collections and Storage vault...";
        }

        try {
            const url = isJobMode
                ? `/api/admin/import/jobs/${encodeURIComponent(targetId)}`
                : `/api/admin/mock-tests/${encodeURIComponent(targetId)}`;

            const payload = isJobMode
                ? { confirmation, reason, operationId: currentDeleteTarget.operationId }
                : { confirmation, reason, operationId: currentDeleteTarget.operationId, jobId: currentDeleteTarget.jobId };

            const res = await adminFetch(url, {
                method: "DELETE",
                body: payload
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (data.operationId) {
                    currentDeleteTarget.operationId = data.operationId;
                }
                throw new Error(data.error || `HTTP ${res.status}`);
            }

            if (alertBox) {
                if (data.status === "NOTHING_TO_DELETE" || data.nothingToDelete) {
                    alertBox.style.background = "#eff6ff";
                    alertBox.style.color = "#1e40af";
                    alertBox.style.border = "1px solid #bfdbfe";
                    alertBox.textContent = `✓ Nothing to delete: Backend verified that no relevant test or job-owned data remains.`;
                } else {
                    alertBox.style.background = "#ecfdf5";
                    alertBox.style.color = "#065f46";
                    alertBox.style.border = "1px solid #a7f3d0";
                    if (isJobMode) {
                        alertBox.textContent = `✓ Deletion completed: Import job '${targetId}' and all draft records permanently deleted.`;
                    } else {
                        alertBox.textContent = `✓ Deletion completed: Mock test '${targetId}' and all exclusive records permanently deleted. Attempts removed: ${data.deletedCounts?.attempts || 0}, Questions removed: ${data.deletedCounts?.questions || 0}.`;
                    }
                }
            }

            executeBtn.textContent = "Deleted";

            // Refresh history table from backend
            await loadImportHistory();

            setTimeout(() => {
                closeModal();
            }, 1800);

        } catch (err) {
            console.error("[Admin UI] Deletion error:", err.message);
            if (alertBox) {
                alertBox.style.background = "#fef2f2";
                alertBox.style.color = "#991b1b";
                alertBox.style.border = "1px solid #fecaca";
                const opNotice = currentDeleteTarget.operationId ? ` (Operation ID: ${currentDeleteTarget.operationId})` : "";
                
                if (err.message && err.message.includes("recovery")) {
                    alertBox.textContent = `Test document missing; recovery required: ${err.message}${opNotice}.`;
                } else {
                    alertBox.textContent = `Cleanup incomplete: ${err.message}${opNotice}. One or more stages failed. You may retry safely.`;
                }
            }
            if (currentDeleteTarget.operationId && retryBtn) {
                retryBtn.style.display = "inline-flex";
            }
            executeBtn.disabled = false;
            executeBtn.style.opacity = "1";
            executeBtn.textContent = "Retry Deletion";
        }
    });
}

// DOM Ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        initAdminAuth();
        setupTabs();
        setupUploadDropzones();
        setupEditModal();
        setupPublishModal();
        setupOverrideModal();
        setupDeleteModal();
        setupUserManagement();
    });
} else {
    initAdminAuth();
    setupTabs();
    setupUploadDropzones();
    setupEditModal();
    setupPublishModal();
    setupOverrideModal();
    setupDeleteModal();
    setupUserManagement();
}

