import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getApiUrl } from "./api-config.js";
import { safeURL } from "./pdf-viewer-core.js";
import { SkeletonManager } from "./skeleton-manager.js";

function getLiveUpdatesEndpoint(subpath = "") {
    return getApiUrl(`/api/live-updates${subpath}`);
}

// State Tracking
let isFetching = false;
let currentQuery = "";
let currentUser = null;

// DOM Elements
const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const validationContainer = document.getElementById("validationContainer");
const searchContextBar = document.getElementById("searchContextBar");
const contextQueryText = document.getElementById("contextQueryText");
const contextCountText = document.getElementById("contextCountText");
const initialStateText = document.getElementById("initialStateText");
const updatesFeed = document.getElementById("updatesFeed");
const errorContainer = document.getElementById("errorContainer");

// Initialize Page
document.addEventListener("DOMContentLoaded", () => {
    setupAuthListener();
    setupEventListeners();
    // Intentionally DO NOT auto-fetch any updates on page open
});

function setupAuthListener() {
    onAuthStateChanged(auth, (user) => {
        currentUser = user;
    });
}

function setupEventListeners() {
    // Search Button Click
    searchBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        executeSearch();
    });

    // Enter Key in Search Input
    searchInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            executeSearch();
        }
    });

    // Clear validation message when typing
    searchInput?.addEventListener("input", () => {
        clearValidation();
    });

    // Native Capacitor Back Button Handling
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        window.Capacitor.Plugins.App.addListener("backButton", () => {
            if (window.history.length > 1) {
                window.history.back();
            } else {
                window.location.href = "index.html";
            }
        });
    }
}

/**
 * Execute Search Query for Specific Exam
 */
async function executeSearch() {
    if (!searchInput) return;

    const query = searchInput.value.trim();
    if (!query) {
        showValidation("Please enter an exam name.");
        return;
    }

    if (isFetching) return;
    isFetching = true;

    clearValidation();
    clearError();

    if (initialStateText) initialStateText.style.display = "none";
    if (searchContextBar) searchContextBar.style.display = "none";

    setSearchButtonLoading(true);
    let skeletonUpdates = null;
    if (updatesFeed) {
        updatesFeed.innerHTML = "";
        skeletonUpdates = SkeletonManager.mount(
            updatesFeed,
            () => SkeletonManager.templates.liveUpdates(4),
            { delay: 200, ariaLabel: `Searching latest updates for "${query}"...` }
        );
    }

    currentQuery = query;

    try {
        const response = await fetch(getLiveUpdatesEndpoint("/search"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, q: query })
        });

        if (!response.ok) {
            throw new Error(`Search request failed with status HTTP ${response.status}`);
        }

        const data = await response.json();

        skeletonUpdates?.dismiss(() => {
            if (data.success && Array.isArray(data.updates) && data.updates.length > 0) {
                showSearchContext(query, data.updates.length);
                renderUpdatesFeed(data.updates);
            } else {
                if (searchContextBar) searchContextBar.style.display = "none";
                renderEmptyState(`No recent updates found for "${query}". Try searching with a broader exam name.`);
            }
        });

    } catch (err) {
        skeletonUpdates?.cancel();
        console.error("[Live Updates Search Exception]:", err);
        if (searchContextBar) searchContextBar.style.display = "none";
        renderErrorState("Unable to load updates right now. Please try again.");
    } finally {
        isFetching = false;
        setSearchButtonLoading(false);
    }
}

/**
 * Search Button Loading State Toggle
 */
function setSearchButtonLoading(loading) {
    if (!searchBtn) return;
    if (loading) {
        searchBtn.disabled = true;
        searchBtn.textContent = "Searching...";
    } else {
        searchBtn.disabled = false;
        searchBtn.textContent = "Search";
    }
}

/**
 * Show Search Context Bar
 */
function showSearchContext(query, count) {
    if (!searchContextBar) return;
    if (contextQueryText) contextQueryText.textContent = query;
    if (contextCountText) contextCountText.textContent = `${count} ${count === 1 ? 'update' : 'updates'} found`;
    searchContextBar.style.display = "flex";
}

/**
 * Render Feed Cards
 */
function renderUpdatesFeed(updates) {
    if (!updatesFeed) return;
    updatesFeed.innerHTML = "";

    updates.forEach((item) => {
        const cardEl = createUpdateCard(item);
        updatesFeed.appendChild(cardEl);
    });
}

/**
 * Create DOM element for an Update Card
 */
function createUpdateCard(item) {
    const card = document.createElement("div");
    card.className = "live-card";

    const isOfficial = item.source?.type === "official";
    const sourceDomain = item.source?.domain || "official";

    const dateBoxHtml = item.importantDate
        ? `<div class="live-card-date-box">Deadline / Event: ${escapeHtml(item.importantDate)}</div>`
        : "";

    const statusClass = (item.status || "active").toLowerCase();
    const statusText = (item.status || "active").replace("_", " ").toUpperCase();

    card.innerHTML = `
        <div class="live-card-top">
            <span class="live-card-category">${escapeHtml(item.category || "EXAM")}</span>
            <span class="live-card-status ${statusClass}">${escapeHtml(statusText)}</span>
        </div>
        <p class="live-card-exam">${escapeHtml(item.examName || "Competitive Exam")}</p>
        <h3 class="live-card-title">${escapeHtml(item.title || "Latest Exam Announcement")}</h3>
        <p class="live-card-summary">${escapeHtml(item.summary || "")}</p>
        ${dateBoxHtml}
        <div class="live-card-footer">
            <div class="live-card-source-name">
                ${escapeHtml(item.source?.title || sourceDomain)}
                ${isOfficial ? '<span class="live-card-official-badge">OFFICIAL</span>' : ""}
            </div>
            <a href="${escapeHtml(safeURL(item.source?.url || "#"))}" target="_blank" rel="noopener noreferrer" class="live-card-source-link">
                View Official Source →
            </a>
        </div>
    `;

    return card;
}

/**
 * Render Loading State
 */
function renderLoadingState(message = "Searching latest exam updates...") {
    if (!updatesFeed) return;
    updatesFeed.innerHTML = `
        <div class="live-loading-box">
            <div class="live-spinner"></div>
            <div class="live-loading-text">${escapeHtml(message)}</div>
            <div class="live-loading-subtext">Searching official exam portals & verified notifications...</div>
        </div>
    `;
}

/**
 * Render Empty State
 */
function renderEmptyState(message) {
    if (!updatesFeed) return;
    updatesFeed.innerHTML = `
        <div class="live-empty-box">
            <div class="live-empty-title">No Updates Found</div>
            <div class="live-empty-desc">${escapeHtml(message)}</div>
        </div>
    `;
}

/**
 * Render Error State
 */
function renderErrorState(message) {
    if (!updatesFeed) return;
    updatesFeed.innerHTML = `
        <div class="live-empty-box">
            <div class="live-empty-title">Unable to Load Updates</div>
            <div class="live-empty-desc">${escapeHtml(message)}</div>
        </div>
    `;
}

/**
 * Show Validation Message
 */
function showValidation(message) {
    if (!validationContainer) return;
    validationContainer.innerHTML = `<p class="live-validation-msg">${escapeHtml(message)}</p>`;
}

function clearValidation() {
    if (validationContainer) validationContainer.innerHTML = "";
}

function clearError() {
    if (errorContainer) errorContainer.innerHTML = "";
}

/**
 * XSS Helper
 */
function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
