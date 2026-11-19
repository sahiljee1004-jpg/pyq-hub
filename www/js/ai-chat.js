import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
    collection,
    addDoc,
    getDocs,
    query,
    orderBy,
    limit,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { AI_ASSISTANT_ENABLED } from "./brand-config.js";
import { openChatGPT } from "./chatgpt-helper.js";
import { SkeletonManager } from "./skeleton-manager.js";

// ============================================================
// CENTRALIZED CHATBOT API CONFIGURATION
// ============================================================
const CONFIG = {
    // USB Development URL (Requires 'adb reverse tcp:3000 tcp:3000')
    USB_DEV_URL: "/api/chat"
};

// Active Development Endpoint
const CHAT_API_URL = CONFIG.USB_DEV_URL;

// State Tracking
let currentUser = null;
let conversationHistory = []; // Array of { role: 'user'|'assistant', content: string }
let activeQuestionContext = null; // Active paper question context for conversational follow-ups
let isSending = false;
let eventListenersInitialized = false;

// DOM Elements
const chatContainer = document.getElementById("chatContainer");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const clearChatBtn = document.getElementById("clearChatBtn");
const suggestionChips = document.querySelectorAll(".ai-suggestion-chip");
const aiSuggestionsContainer = document.getElementById("aiSuggestionsContainer");
const aiInputArea = document.getElementById("aiInputArea");
const aiLockedContainer = document.getElementById("aiLockedContainer");
const askGptLockedBtn = document.getElementById("askGptLockedBtn");

// Initialize Page with Feature Flag Check
document.addEventListener("DOMContentLoaded", () => {
    const isEnabled =
        typeof window !== "undefined" && window.AI_ASSISTANT_ENABLED !== undefined
            ? window.AI_ASSISTANT_ENABLED
            : AI_ASSISTANT_ENABLED;

    if (!isEnabled) {
        renderLockedScreen();
        setupCapacitorBackButton();
        return;
    }

    if (aiLockedContainer) aiLockedContainer.style.display = "none";
    setupAuthListener();
    setupEventListeners();
});

// Render Locked AI Assistant Screen ("Coming Soon")
function renderLockedScreen() {
    if (chatContainer) chatContainer.style.display = "none";
    if (aiSuggestionsContainer) aiSuggestionsContainer.style.display = "none";
    if (aiInputArea) aiInputArea.style.display = "none";
    if (clearChatBtn) clearChatBtn.style.display = "none";

    if (aiLockedContainer) {
        aiLockedContainer.style.display = "flex";
    }

    if (askGptLockedBtn) {
        askGptLockedBtn.addEventListener("click", (e) => {
            e.preventDefault();
            openChatGPT();
        });
    }
}

// Setup Native Capacitor Back Button Navigation
function setupCapacitorBackButton() {
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

// Setup Auth & History Loading
function setupAuthListener() {
    onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        if (currentUser) {
            const chatSkeleton = chatContainer ? SkeletonManager.mount(
                chatContainer,
                () => SkeletonManager.templates.aiChat(3),
                { delay: 200, ariaLabel: "Loading chat conversation..." }
            ) : null;
            await loadSavedChatHistory(currentUser.uid);
            chatSkeleton?.dismiss();
        } else {
            renderWelcomeMessage();
        }
    });
}

// Event Listeners (Guarded against duplicate bindings)
function setupEventListeners() {
    if (eventListenersInitialized) return;
    eventListenersInitialized = true;

    sendButton?.addEventListener("click", (e) => {
        e.preventDefault();
        sendMessage();
    });

    messageInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    clearChatBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        clearChat();
    });

    suggestionChips.forEach((chip) => {
        chip.addEventListener("click", (e) => {
            e.preventDefault();
            const question = chip.getAttribute("data-question");
            if (question && messageInput && !isSending) {
                messageInput.value = question;
                sendMessage();
            }
        });
    });

    // Native Capacitor Back Button
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

// Render Welcome Message
function renderWelcomeMessage() {
    if (!chatContainer) return;
    chatContainer.innerHTML = "";

    const welcomeHtml = `
        <div class="ai-welcome-card">
            <h3>Welcome to VidyarthiAstra AI Assistant</h3>
            <p>Ask paper-specific questions (e.g., <em>"solve question 13 from JEE Main 2025 Shift 2"</em>) or general study questions (e.g., <em>"Explain Newton's second law"</em>).</p>
        </div>
    `;
    chatContainer.innerHTML = welcomeHtml;
    scrollToBottom();
}

// Load Chat History from Firestore
async function loadSavedChatHistory(uid) {
    renderWelcomeMessage();
    if (!db) return;

    try {
        const messagesRef = collection(db, "users", uid, "aiChats", "default", "messages");
        const q = query(messagesRef, orderBy("createdAt", "asc"), limit(20));
        const snapshot = await getDocs(q);

        if (!snapshot.empty) {
            conversationHistory = [];
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                if (data.role && data.content) {
                    appendMessageUI(data.role, data.content, data.metadata || null);
                    conversationHistory.push({
                        role: data.role,
                        content: data.content
                    });
                }
            });
            if (conversationHistory.length > 10) {
                conversationHistory = conversationHistory.slice(-10);
            }
        }
    } catch (err) {
        console.warn("[AI Chat] Could not load saved history from Firestore:", err);
    }
}

// Send Message Flow
async function sendMessage() {
    if (isSending || !messageInput) return;

    const text = messageInput.value.trim();
    if (!text) return;

    if (text.length > 1000) {
        showErrorBanner("Message length exceeds maximum limit of 1000 characters.", "");
        return;
    }

    // Lock UI state to prevent duplicate submissions
    isSending = true;
    messageInput.value = "";
    messageInput.disabled = true;
    if (sendButton) sendButton.disabled = true;

    // Remove existing error banners
    removeErrorBanners();

    // Append User Message to UI
    appendMessageUI("user", text);
    scrollToBottom();

    // Append Typing Indicator
    const typingIndicatorEl = appendTypingIndicator();
    scrollToBottom();

    try {
        // Fetch Firebase Auth ID Token
        let idToken = "";
        if (currentUser) {
            try {
                idToken = await currentUser.getIdToken();
            } catch (tokenErr) {
                console.warn("[AI Chat] Token retrieval warning:", tokenErr);
            }
        }

        if (!idToken) {
            typingIndicatorEl.remove();
            showErrorBanner("Authentication required. Please log in to use VidyarthiAstra AI Assistant.", text);
            resetInputState();
            return;
        }

        console.log(`[AI Chat Client] Sending request to ${CHAT_API_URL}...`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 28000); // 28s timeout

        const response = await fetch(CHAT_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${idToken}`
            },
            body: JSON.stringify({
                message: text,
                conversationHistory: conversationHistory.slice(-10),
                activeQuestionContext: activeQuestionContext
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        typingIndicatorEl.remove();

        const data = await response.json().catch(() => null);

        const answerText = data?.answer || data?.reply || data?.message || data?.error;
        const serverMsg = data?.message || data?.error || data?.answer || data?.reply;

        if (response.ok && data && data.success && answerText) {
            
            // Update active question context if server returned a new one
            if (data.activeQuestionContext) {
                activeQuestionContext = data.activeQuestionContext;
            }

            // Append Assistant Message to UI
            appendMessageUI("assistant", answerText, {
                mode: data.mode || "tutor",
                intent: data.intent || "",
                sources: data.sources || [],
                paperMeta: data.paperMeta || (data.activeQuestionContext ? data.activeQuestionContext.paper : null),
                questionMeta: data.questionMeta || (data.activeQuestionContext ? data.activeQuestionContext.question : null),
                paperFound: data.paperFound,
                questionFound: data.questionFound
            });

            // Save to memory state
            conversationHistory.push({ role: "user", content: text });
            conversationHistory.push({ role: "assistant", content: answerText });
            if (conversationHistory.length > 10) {
                conversationHistory = conversationHistory.slice(-10);
            }

            // Save to Firestore if user logged in
            if (currentUser && db) {
                saveMessageToFirestore(currentUser.uid, "user", text);
                saveMessageToFirestore(currentUser.uid, "assistant", answerText, {
                    mode: data.mode || "tutor",
                    paperMeta: data.paperMeta || null,
                    questionMeta: data.questionMeta || null
                });
            }
        } else if (response.ok && data && serverMsg) {
            // HTTP 200 with structured user-facing message (e.g., Paper not found / Question not extracted)
            appendMessageUI("assistant", serverMsg, {
                mode: data.mode || "paper_question",
                paperMeta: data.paperMeta || null,
                questionMeta: data.questionMeta || null
            });
        } else {
            // Handle Specific HTTP Failure Reasons (4xx / 5xx)
            let errorMessage = serverMsg || "Unable to process request.";
            if (!serverMsg) {
                if (response.status === 401) {
                    errorMessage = "Authentication session expired. Please log in again.";
                } else if (response.status === 429) {
                    errorMessage = "Daily limit reached for today. Please try again tomorrow!";
                } else if (response.status === 502 || response.status === 503) {
                    errorMessage = "AI service provider is temporarily busy or unconfigured. Please retry shortly.";
                } else if (response.status === 504) {
                    errorMessage = "Request timed out. The AI backend took too long to respond.";
                } else {
                    errorMessage = `Server error (HTTP ${response.status}). Please try again.`;
                }
            }

            showErrorBanner(errorMessage, text);
        }

    } catch (err) {
        console.error("[AI Chat Client Error]:", err);
        typingIndicatorEl.remove();

        if (err.name === "AbortError") {
            showErrorBanner("Request timed out. Please check backend connection and retry.", text);
        } else {
            showErrorBanner(
                "Backend server unreachable. Ensure backend server is running on port 3000.",
                text
            );
        }
    } finally {
        resetInputState();
        scrollToBottom();
    }
}

// Save Message to Firestore
async function saveMessageToFirestore(uid, role, content, metadata = null) {
    try {
        const messagesRef = collection(db, "users", uid, "aiChats", "default", "messages");
        const docPayload = {
            role: role,
            content: content,
            createdAt: serverTimestamp()
        };
        if (metadata) docPayload.metadata = metadata;
        await addDoc(messagesRef, docPayload);
    } catch (err) {
        console.warn("[AI Chat] Firestore save warning:", err);
    }
}

// Append Message UI Bubble
function appendMessageUI(role, content, metadata = null) {
    if (!chatContainer) return;

    const row = document.createElement("div");
    row.className = `ai-message-row ${role}`;

    const avatar = document.createElement("div");
    avatar.className = `ai-avatar ${role === "user" ? "user-avatar" : ""}`;
    avatar.textContent = role === "user" ? "You" : "AI";

    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";

    let innerHtml = "";

    // Paper Question Header Badge & Metadata Box
    if (role === "assistant" && metadata && metadata.paperMeta) {
        const p = metadata.paperMeta;
        const q = metadata.questionMeta;
        
        innerHtml += `
            <div class="ai-paper-header-badge">
                <span class="ai-paper-title">${escapeHtml(p.title || p.paperId || "Exam Paper")}</span>
                ${q ? `<span class="ai-question-num">Question ${q.questionNumber}</span>` : ""}
            </div>
        `;

        if (q && q.questionText) {
            innerHtml += `
                <div class="ai-paper-question-box">
                    <div class="ai-question-text">${escapeHtml(q.questionText)}</div>
                    ${Array.isArray(q.options) && q.options.length > 0 ? `
                        <div class="ai-question-options">
                            ${q.options.map(opt => `<div class="ai-option-item">${escapeHtml(opt)}</div>`).join("")}
                        </div>
                    ` : ""}
                </div>
            `;
        }
    } else if (role === "assistant" && metadata && metadata.mode && metadata.mode !== "paper_question") {
        const modeLabel = metadata.mode === "search"
            ? "Web Search"
            : metadata.mode === "mixed"
            ? "Search + AI Tutor"
            : "AI Tutor";
        innerHtml += `<div class="ai-mode-badge">${modeLabel}</div>`;
    }

    innerHtml += formatMarkdown(content);

    // Subtle View Paper Button if PDF URL present
    if (role === "assistant" && metadata && metadata.paperMeta) {
        const p = metadata.paperMeta;
        if (p.examId && p.yearId) {
            innerHtml += `
                <div class="ai-paper-action-bar">
                    <a href="papers.html?exam=${encodeURIComponent(p.examId)}&year=${encodeURIComponent(p.yearId)}" class="ai-view-paper-btn">
                        View Full Paper PDF →
                    </a>
                </div>
            `;
        }
    }

    // Render Sources if present
    if (role === "assistant" && metadata && Array.isArray(metadata.sources) && metadata.sources.length > 0) {
        innerHtml += `
            <div class="ai-sources-container">
                <div class="ai-sources-title">Verified Sources</div>
                <div class="ai-sources-list">
                    ${metadata.sources.map(s => `
                        <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" class="ai-source-pill">
                            <span>${escapeHtml(s.title)}</span>
                            <span class="ai-source-domain">${escapeHtml(s.domain || "web")}</span>
                        </a>
                    `).join('')}
                </div>
            </div>
        `;
    }

    bubble.innerHTML = innerHtml;

    row.appendChild(avatar);
    row.appendChild(bubble);
    chatContainer.appendChild(row);
}

// Append Typing Loading Indicator
function appendTypingIndicator() {
    const row = document.createElement("div");
    row.className = "ai-message-row assistant";
    row.id = "typingIndicatorRow";

    const avatar = document.createElement("div");
    avatar.className = "ai-avatar";
    avatar.textContent = "AI";

    const indicator = document.createElement("div");
    indicator.className = "ai-typing-indicator";
    indicator.innerHTML = "<span></span><span></span><span></span>";

    row.appendChild(avatar);
    row.appendChild(indicator);
    chatContainer.appendChild(row);
    return row;
}

// Show Error Banner in Chat
function showErrorBanner(errorMessage, failedText = "") {
    if (!chatContainer) return;
    removeErrorBanners();

    const banner = document.createElement("div");
    banner.className = "ai-error-banner";
    banner.innerHTML = `
        <span>${escapeHtml(errorMessage)}</span>
        ${failedText ? `<button class="ai-retry-btn">Retry</button>` : ""}
    `;

    if (failedText) {
        const retryBtn = banner.querySelector(".ai-retry-btn");
        retryBtn?.addEventListener("click", (e) => {
            e.preventDefault();
            banner.remove();
            if (messageInput) messageInput.value = failedText;
            sendMessage();
        });
    }

    chatContainer.appendChild(banner);
    scrollToBottom();
}

// Remove Existing Error Banners
function removeErrorBanners() {
    if (!chatContainer) return;
    const oldBanners = chatContainer.querySelectorAll(".ai-error-banner");
    oldBanners.forEach((b) => b.remove());
}

// Clear Chat Memory & UI
function clearChat() {
    conversationHistory = [];
    activeQuestionContext = null;
    renderWelcomeMessage();
}

// Reset Input Locks
function resetInputState() {
    isSending = false;
    if (messageInput) {
        messageInput.disabled = false;
        messageInput.focus();
    }
    if (sendButton) sendButton.disabled = false;
}

// Scroll Container to Bottom
function scrollToBottom() {
    if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
}

// Lightweight Markdown Formatter
function formatMarkdown(text) {
    if (!text) return "";
    let html = escapeHtml(text);

    // Code blocks
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // Headers
    html = html.replace(/^### (.*$)/gim, '<strong>$1</strong>');
    html = html.replace(/^## (.*$)/gim, '<strong>$1</strong>');
    html = html.replace(/^# (.*$)/gim, '<strong>$1</strong>');

    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Bullet lists
    html = html.replace(/^\s*[-*]\s+(.*$)/gim, '<ul><li>$1</li></ul>');
    html = html.replace(/<\/ul>\s*<ul>/g, '');

    // Line breaks
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    return `<p>${html}</p>`;
}

// HTML Escaper
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
