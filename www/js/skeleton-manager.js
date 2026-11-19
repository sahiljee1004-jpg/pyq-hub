/**
 * ============================================================================
 * VIDYARTHIASTRA — UNIVERSAL SKELETON LOADING MANAGER
 * Provides theme-aware, accessible, 200ms-debounced skeleton loading states
 * across all student-facing pages with zero Cumulative Layout Shift (CLS).
 * ============================================================================
 */

export class SkeletonManager {
    /**
     * Default loading delay threshold in milliseconds.
     * Prevents flashing skeletons for fast responses (<200ms).
     */
    static DEFAULT_DELAY_MS = 200;

    /**
     * Track active mount handles by container element
     */
    static activeHandles = new WeakMap();

    /**
     * Start a debounced skeleton loading session on target container.
     * 
     * @param {HTMLElement|string} target - Container element or CSS selector
     * @param {string|Function} template - HTML string or template generator function
     * @param {Object} [options] - Configuration options
     * @param {number} [options.delay=200] - Milliseconds before skeleton appears
     * @param {string} [options.ariaLabel] - Accessible status label for screen readers
     * @returns {Object} Handle with dismiss() and cancel() methods
     */
    static mount(target, template, options = {}) {
        const container = typeof target === "string" ? document.querySelector(target) : target;
        if (!container) {
            return {
                dismiss: (renderFn) => typeof renderFn === "function" && renderFn(),
                cancel: () => {},
                isRendered: () => false
            };
        }

        // Cancel any existing session on this container
        const existing = this.activeHandles.get(container);
        if (existing) {
            existing.cancel();
        }

        const delay = typeof options.delay === "number" ? options.delay : this.DEFAULT_DELAY_MS;
        const ariaLabel = options.ariaLabel || "Loading content, please wait...";

        let timerId = null;
        let isRendered = false;
        let isDismissed = false;

        const renderSkeleton = () => {
            if (isDismissed) return;
            isRendered = true;

            const html = typeof template === "function" ? template() : template;
            container.setAttribute("aria-busy", "true");
            container.classList.add("is-skeleton-loading");

            // Wrap in an accessible container marked with aria-hidden for visual placeholders
            container.innerHTML = `
                <div class="skeleton-container" role="status" aria-label="${SkeletonManager.escapeHtml(ariaLabel)}">
                    <span class="sr-only" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;">
                        ${SkeletonManager.escapeHtml(ariaLabel)}
                    </span>
                    <div aria-hidden="true">
                        ${html}
                    </div>
                </div>
            `;
        };

        if (delay <= 0) {
            renderSkeleton();
        } else {
            timerId = setTimeout(renderSkeleton, delay);
        }

        const handle = {
            /**
             * Dismiss skeleton and render real content.
             * If response arrived <200ms, timer is cancelled and skeleton is never shown.
             */
            dismiss: (renderRealContentFn) => {
                isDismissed = true;
                if (timerId) {
                    clearTimeout(timerId);
                    timerId = null;
                }
                container.removeAttribute("aria-busy");
                container.classList.remove("is-skeleton-loading");
                SkeletonManager.activeHandles.delete(container);

                if (typeof renderRealContentFn === "function") {
                    renderRealContentFn();
                }
            },
            /**
             * Cancel skeleton without rendering replacement
             */
            cancel: () => {
                isDismissed = true;
                if (timerId) {
                    clearTimeout(timerId);
                    timerId = null;
                }
                container.removeAttribute("aria-busy");
                container.classList.remove("is-skeleton-loading");
                SkeletonManager.activeHandles.delete(container);
            },
            isRendered: () => isRendered
        };

        this.activeHandles.set(container, handle);
        return handle;
    }

    /**
     * Helper to safely escape strings in attributes
     */
    static escapeHtml(str) {
        if (str == null) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * ========================================================================
     * STANDARDIZED TEMPLATES FOR EVERY STUDENT PAGE
     * ========================================================================
     */
    static templates = {
        /**
         * 1. Student Dashboard & Home Page (Exam Cards Grid)
         */
        dashboardExams(count = 6) {
            let cards = "";
            for (let i = 0; i < count; i++) {
                cards += `
                    <div class="skeleton-exam-card">
                        <div>
                            <div class="skeleton-card-header">
                                <span class="skeleton-block skeleton-avatar"></span>
                                <div style="flex:1;">
                                    <span class="skeleton-block skeleton-text lg w-60"></span>
                                    <span class="skeleton-block skeleton-text sm w-40"></span>
                                </div>
                            </div>
                            <span class="skeleton-block skeleton-text w-90"></span>
                            <span class="skeleton-block skeleton-text w-75"></span>
                        </div>
                        <div class="skeleton-card-footer">
                            <span class="skeleton-block skeleton-pill"></span>
                            <span class="skeleton-block skeleton-btn" style="height:32px;width:96px;"></span>
                        </div>
                    </div>
                `;
            }
            return `<div class="skeleton-exam-grid">${cards}</div>`;
        },

        /**
         * 2. Exam Detail Banner & Years
         */
        examDetail() {
            return `
                <div style="margin-bottom: 2rem;">
                    <span class="skeleton-block skeleton-text title" style="width: 45%; height: 2.2rem; margin-bottom: 1rem;"></span>
                    <span class="skeleton-block skeleton-text lg w-75"></span>
                    <span class="skeleton-block skeleton-text w-60"></span>
                </div>
            `;
        },

        examYears(count = 4) {
            let cards = "";
            for (let i = 0; i < count; i++) {
                cards += `
                    <div class="skeleton-exam-card" style="min-height: 160px;">
                        <div>
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 0.75rem;">
                                <span class="skeleton-block skeleton-pill md"></span>
                                <span class="skeleton-block skeleton-badge"></span>
                            </div>
                            <span class="skeleton-block skeleton-text w-85"></span>
                        </div>
                        <span class="skeleton-block skeleton-btn block" style="height: 36px;"></span>
                    </div>
                `;
            }
            return `<div class="skeleton-exam-grid">${cards}</div>`;
        },

        /**
         * 3. Mock Test Catalog
         */
        mockCatalog(count = 6) {
            let cards = "";
            for (let i = 0; i < count; i++) {
                cards += `
                    <div class="skeleton-mock-card">
                        <div>
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                                <div style="display: flex; gap: 6px;">
                                    <span class="skeleton-block skeleton-badge" style="width: 70px;"></span>
                                    <span class="skeleton-block skeleton-badge" style="width: 45px;"></span>
                                </div>
                                <span class="skeleton-block skeleton-badge" style="width: 80px;"></span>
                            </div>
                            <span class="skeleton-block skeleton-text lg w-90" style="margin-bottom: 0.85rem;"></span>
                            <div class="skeleton-meta-row">
                                <span class="skeleton-block skeleton-text sm w-25"></span>
                                <span class="skeleton-block skeleton-text sm w-25"></span>
                                <span class="skeleton-block skeleton-text sm w-25"></span>
                            </div>
                            <div style="margin-top: 0.75rem;">
                                <span class="skeleton-block skeleton-text sm w-40"></span>
                            </div>
                        </div>
                        <div style="margin-top: 1.5rem;">
                            <span class="skeleton-block skeleton-btn block"></span>
                        </div>
                    </div>
                `;
            }
            return `<div class="skeleton-mock-grid">${cards}</div>`;
        },

        /**
         * 4. Active Mock Test Live Engine (Session view)
         */
        mockInterface() {
            let tabs = "";
            for (let i = 0; i < 4; i++) {
                tabs += `<span class="skeleton-block skeleton-pill md" style="height: 34px; width: 100px;"></span>`;
            }

            let options = "";
            for (let i = 0; i < 4; i++) {
                options += `
                    <div class="skeleton-option-item">
                        <span class="skeleton-block skeleton-radio-circle"></span>
                        <span class="skeleton-block skeleton-text w-${80 - i * 10}"></span>
                    </div>
                `;
            }

            let paletteCells = "";
            for (let i = 0; i < 25; i++) {
                paletteCells += `<span class="skeleton-block skeleton-palette-cell"></span>`;
            }

            return `
                <div class="skeleton-test-view">
                    <!-- Top Status Bar -->
                    <div class="skeleton-test-top-bar">
                        <div style="flex: 1;">
                            <span class="skeleton-block skeleton-text title" style="width: 35%; margin-bottom: 0.35rem;"></span>
                            <span class="skeleton-block skeleton-text sm w-25"></span>
                        </div>
                        <div style="display: flex; gap: 1rem; align-items: center;">
                            <span class="skeleton-block skeleton-pill md" style="height: 38px; width: 110px;"></span>
                            <span class="skeleton-block skeleton-btn" style="height: 38px; width: 110px;"></span>
                        </div>
                    </div>

                    <!-- Section Tabs Bar -->
                    <div class="skeleton-tabs-bar">
                        ${tabs}
                    </div>

                    <!-- Two-column Layout -->
                    <div class="skeleton-test-session-layout">
                        <!-- Left Question Card -->
                        <div class="skeleton-question-card">
                            <div class="skeleton-q-header">
                                <div style="display: flex; gap: 8px;">
                                    <span class="skeleton-block skeleton-pill"></span>
                                    <span class="skeleton-block skeleton-pill"></span>
                                    <span class="skeleton-block skeleton-badge"></span>
                                </div>
                                <span class="skeleton-block skeleton-badge" style="width: 75px;"></span>
                            </div>

                            <!-- Question Stem Lines -->
                            <div style="margin-bottom: 1.5rem;">
                                <span class="skeleton-block skeleton-text lg w-100"></span>
                                <span class="skeleton-block skeleton-text lg w-90"></span>
                                <span class="skeleton-block skeleton-text lg w-75"></span>
                                <span class="skeleton-block skeleton-text lg w-50"></span>
                            </div>

                            <!-- Options -->
                            <div style="margin-bottom: 1.75rem;">
                                ${options}
                            </div>

                            <!-- Action Bar -->
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: auto; padding-top: 1rem; border-top: 1px solid var(--skeleton-border);">
                                <div style="display: flex; gap: 0.5rem;">
                                    <span class="skeleton-block skeleton-btn" style="width: 110px;"></span>
                                    <span class="skeleton-block skeleton-btn" style="width: 120px;"></span>
                                </div>
                                <div style="display: flex; gap: 0.5rem;">
                                    <span class="skeleton-block skeleton-btn" style="width: 90px;"></span>
                                    <span class="skeleton-block skeleton-btn" style="width: 110px;"></span>
                                </div>
                            </div>
                        </div>

                        <!-- Right Palette -->
                        <div class="skeleton-palette-card">
                            <span class="skeleton-block skeleton-text title" style="width: 70%; margin-bottom: 1rem;"></span>
                            <div class="skeleton-palette-grid">
                                ${paletteCells}
                            </div>
                            <div style="margin-top: 1.25rem; display: flex; flex-direction: column; gap: 0.5rem;">
                                <span class="skeleton-block skeleton-text sm w-60"></span>
                                <span class="skeleton-block skeleton-text sm w-50"></span>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        },

        /**
         * 5. Mock Test Results & Performance Analytics
         */
        mockResults() {
            let sectionCards = "";
            for (let i = 0; i < 3; i++) {
                sectionCards += `
                    <div class="skeleton-card" style="padding: 1.25rem;">
                        <span class="skeleton-block skeleton-text lg w-50" style="margin-bottom: 0.5rem;"></span>
                        <span class="skeleton-block skeleton-text sm w-75"></span>
                        <div style="margin-top: 1rem; height: 8px; width: 100%;" class="skeleton-block"></div>
                    </div>
                `;
            }

            return `
                <div class="skeleton-results-dashboard">
                    <div>
                        <span class="skeleton-block skeleton-text title" style="width: 35%; height: 2rem;"></span>
                        <span class="skeleton-block skeleton-text sm w-50"></span>
                    </div>

                    <!-- Scorecard Overview -->
                    <div class="skeleton-results-overview">
                        <div style="text-align: center;">
                            <span class="skeleton-block skeleton-score-circle"></span>
                            <div style="margin-top: 1rem;">
                                <span class="skeleton-block skeleton-pill md"></span>
                            </div>
                        </div>
                        <div class="skeleton-stats-grid">
                            <div class="skeleton-stat-box">
                                <span class="skeleton-block skeleton-text title w-40"></span>
                                <span class="skeleton-block skeleton-text sm w-60"></span>
                            </div>
                            <div class="skeleton-stat-box">
                                <span class="skeleton-block skeleton-text title w-40"></span>
                                <span class="skeleton-block skeleton-text sm w-60"></span>
                            </div>
                            <div class="skeleton-stat-box">
                                <span class="skeleton-block skeleton-text title w-40"></span>
                                <span class="skeleton-block skeleton-text sm w-60"></span>
                            </div>
                            <div class="skeleton-stat-box">
                                <span class="skeleton-block skeleton-text title w-40"></span>
                                <span class="skeleton-block skeleton-text sm w-60"></span>
                            </div>
                        </div>
                    </div>

                    <!-- Subject Breakdown -->
                    <div>
                        <span class="skeleton-block skeleton-text title w-25" style="margin-bottom: 1rem;"></span>
                        <div class="skeleton-section-cards-grid">
                            ${sectionCards}
                        </div>
                    </div>
                </div>
            `;
        },

        /**
         * 6. Dedicated PYQ Library (Exams, Years, Papers)
         */
        pyqExams(count = 6) {
            let cards = "";
            for (let i = 0; i < count; i++) {
                cards += `
                    <div class="skeleton-pyq-card">
                        <div>
                            <div style="display:flex; gap:12px; align-items:center; margin-bottom:1rem;">
                                <span class="skeleton-block skeleton-avatar" style="border-radius: 8px;"></span>
                                <div style="flex:1;">
                                    <span class="skeleton-block skeleton-text lg w-75"></span>
                                    <div style="display:flex; gap:6px;">
                                        <span class="skeleton-block skeleton-badge"></span>
                                        <span class="skeleton-block skeleton-badge"></span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <span class="skeleton-block skeleton-btn block" style="height:38px;"></span>
                    </div>
                `;
            }
            return `<div class="skeleton-pyq-grid">${cards}</div>`;
        },

        pyqYears(count = 4) {
            let cards = "";
            for (let i = 0; i < count; i++) {
                cards += `
                    <div class="skeleton-pyq-card" style="min-height: 140px;">
                        <div>
                            <span class="skeleton-block skeleton-pill md" style="margin-bottom: 0.75rem;"></span>
                            <span class="skeleton-block skeleton-text sm w-50"></span>
                        </div>
                        <span class="skeleton-block skeleton-btn block" style="height:36px;"></span>
                    </div>
                `;
            }
            return `<div class="skeleton-pyq-grid">${cards}</div>`;
        },

        pyqPapers(count = 6) {
            let cards = "";
            for (let i = 0; i < count; i++) {
                cards += `
                    <div class="skeleton-pyq-card" style="min-height: 190px;">
                        <div>
                            <div style="display: flex; gap: 10px; align-items: flex-start; margin-bottom: 0.75rem;">
                                <span class="skeleton-block skeleton-icon" style="width: 28px; height: 28px;"></span>
                                <div style="flex: 1;">
                                    <span class="skeleton-block skeleton-text lg w-85"></span>
                                    <div style="display: flex; gap: 6px; margin-top: 4px;">
                                        <span class="skeleton-block skeleton-badge"></span>
                                        <span class="skeleton-block skeleton-badge"></span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div style="display: flex; gap: 8px; margin-top: 1rem;">
                            <span class="skeleton-block skeleton-btn" style="flex: 1; height: 36px;"></span>
                            <span class="skeleton-block skeleton-btn" style="width: 44px; height: 36px;"></span>
                        </div>
                    </div>
                `;
            }
            return `<div class="skeleton-pyq-grid">${cards}</div>`;
        },

        /**
         * 7. Papers List Page
         */
        papersList(count = 5) {
            let items = "";
            for (let i = 0; i < count; i++) {
                items += `
                    <div class="skeleton-paper-card">
                        <div style="flex: 1;">
                            <div style="display: flex; gap: 12px; align-items: center;">
                                <span class="skeleton-block skeleton-icon" style="width: 32px; height: 32px; border-radius: 6px;"></span>
                                <div style="flex: 1;">
                                    <span class="skeleton-block skeleton-text lg w-75" style="margin-bottom: 0.35rem;"></span>
                                    <div style="display: flex; gap: 8px;">
                                        <span class="skeleton-block skeleton-badge" style="width: 65px;"></span>
                                        <span class="skeleton-block skeleton-badge" style="width: 85px;"></span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div style="display: flex; gap: 10px;">
                            <span class="skeleton-block skeleton-btn" style="width: 100px; height: 38px;"></span>
                            <span class="skeleton-block skeleton-btn" style="width: 110px; height: 38px;"></span>
                        </div>
                    </div>
                `;
            }
            return `<div class="skeleton-paper-list">${items}</div>`;
        },

        /**
         * 8. Embedded PDF Viewer Skeleton
         */
        pdfViewer() {
            return `
                <div class="skeleton-pdf-container">
                    <div class="skeleton-pdf-toolbar">
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <span class="skeleton-block skeleton-btn" style="width: 60px; height: 28px;"></span>
                            <span class="skeleton-block skeleton-text sm" style="width: 70px; margin-bottom: 0;"></span>
                        </div>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <span class="skeleton-block skeleton-icon"></span>
                            <span class="skeleton-block skeleton-icon"></span>
                            <span class="skeleton-block skeleton-icon"></span>
                        </div>
                        <span class="skeleton-block skeleton-btn" style="width: 90px; height: 28px;"></span>
                    </div>
                    <div class="skeleton-pdf-canvas">
                        <span class="skeleton-block skeleton-text title w-60" style="margin-bottom: 1.5rem;"></span>
                        <span class="skeleton-block skeleton-text w-100"></span>
                        <span class="skeleton-block skeleton-text w-90"></span>
                        <span class="skeleton-block skeleton-text w-95"></span>
                        <span class="skeleton-block skeleton-text w-75"></span>
                        <div style="height: 140px; margin: 1.5rem 0;" class="skeleton-block w-100"></div>
                        <span class="skeleton-block skeleton-text w-100"></span>
                        <span class="skeleton-block skeleton-text w-85"></span>
                    </div>
                </div>
            `;
        },

        /**
         * 9. Study Resources Library
         */
        studyResources(count = 6) {
            let cards = "";
            for (let i = 0; i < count; i++) {
                cards += `
                    <div class="skeleton-card" style="min-height: 170px;">
                        <div>
                            <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 0.75rem;">
                                <span class="skeleton-block skeleton-avatar" style="border-radius: 8px;"></span>
                                <div style="flex: 1;">
                                    <span class="skeleton-block skeleton-text lg w-75"></span>
                                    <span class="skeleton-block skeleton-text sm w-40"></span>
                                </div>
                            </div>
                            <span class="skeleton-block skeleton-text w-90"></span>
                        </div>
                        <div style="margin-top: 1rem; display: flex; justify-content: space-between; align-items: center;">
                            <span class="skeleton-block skeleton-pill"></span>
                            <span class="skeleton-block skeleton-btn" style="width: 80px; height: 32px;"></span>
                        </div>
                    </div>
                `;
            }
            return `<div class="skeleton-study-grid">${cards}</div>`;
        },

        /**
         * 10. AI Chat Assistant
         */
        aiChat(count = 3) {
            let messages = "";
            for (let i = 0; i < count; i++) {
                messages += `
                    <div class="skeleton-chat-msg">
                        <span class="skeleton-block skeleton-avatar" style="width: 36px; height: 36px;"></span>
                        <div class="skeleton-chat-bubble">
                            <span class="skeleton-block skeleton-text w-90"></span>
                            <span class="skeleton-block skeleton-text w-75"></span>
                            <span class="skeleton-block skeleton-text w-50"></span>
                        </div>
                    </div>
                    <div class="skeleton-chat-msg user">
                        <div class="skeleton-chat-bubble" style="background: var(--skeleton-pill-bg);">
                            <span class="skeleton-block skeleton-text w-70"></span>
                        </div>
                    </div>
                `;
            }
            return `<div class="skeleton-chat-container">${messages}</div>`;
        },

        /**
         * 11. Live Updates News Feed
         */
        liveUpdates(count = 4) {
            let cards = "";
            for (let i = 0; i < count; i++) {
                cards += `
                    <div class="skeleton-update-card">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span class="skeleton-block skeleton-badge" style="width: 80px;"></span>
                            <span class="skeleton-block skeleton-text sm" style="width: 90px; margin-bottom: 0;"></span>
                        </div>
                        <span class="skeleton-block skeleton-text lg w-85"></span>
                        <span class="skeleton-block skeleton-text w-100"></span>
                        <span class="skeleton-block skeleton-text w-60"></span>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem; padding-top: 0.75rem; border-top: 1px solid var(--skeleton-border);">
                            <span class="skeleton-block skeleton-text sm w-30" style="margin-bottom: 0;"></span>
                            <span class="skeleton-block skeleton-btn" style="width: 90px; height: 30px;"></span>
                        </div>
                    </div>
                `;
            }
            return `<div class="skeleton-updates-feed">${cards}</div>`;
        },

        /**
         * 12. Student Profile
         */
        profile() {
            return `
                <div class="skeleton-profile-card">
                    <span class="skeleton-block skeleton-avatar xl"></span>
                    <span class="skeleton-block skeleton-text title" style="width: 50%; height: 1.8rem;"></span>
                    <span class="skeleton-block skeleton-text w-40"></span>
                    
                    <div style="width: 100%; display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-top: 1.5rem;">
                        <div class="skeleton-stat-box" style="text-align: center;">
                            <span class="skeleton-block skeleton-text lg w-50" style="margin: 0 auto 0.35rem auto;"></span>
                            <span class="skeleton-block skeleton-text sm w-70" style="margin: 0 auto;"></span>
                        </div>
                        <div class="skeleton-stat-box" style="text-align: center;">
                            <span class="skeleton-block skeleton-text lg w-50" style="margin: 0 auto 0.35rem auto;"></span>
                            <span class="skeleton-block skeleton-text sm w-70" style="margin: 0 auto;"></span>
                        </div>
                        <div class="skeleton-stat-box" style="text-align: center;">
                            <span class="skeleton-block skeleton-text lg w-50" style="margin: 0 auto 0.35rem auto;"></span>
                            <span class="skeleton-block skeleton-text sm w-70" style="margin: 0 auto;"></span>
                        </div>
                    </div>

                    <div style="width: 100%; display: flex; gap: 1rem; margin-top: 1.5rem;">
                        <span class="skeleton-block skeleton-btn block" style="height: 42px;"></span>
                        <span class="skeleton-block skeleton-btn block" style="height: 42px;"></span>
                    </div>
                </div>
            `;
        },

        /**
         * 13. Edit Profile Form
         */
        editProfile() {
            return `
                <div class="skeleton-profile-card">
                    <span class="skeleton-block skeleton-avatar lg"></span>
                    <div style="width: 100%; margin-top: 1rem;">
                        <span class="skeleton-block skeleton-text sm w-25"></span>
                        <div class="skeleton-block w-100" style="height: 44px; margin-bottom: 1.25rem;"></div>
                        
                        <span class="skeleton-block skeleton-text sm w-25"></span>
                        <div class="skeleton-block w-100" style="height: 44px; margin-bottom: 1.5rem;"></div>

                        <span class="skeleton-block skeleton-btn block" style="height: 44px;"></span>
                    </div>
                </div>
            `;
        },

        /**
         * 14. Auth Form (Login / Signup)
         */
        authForm() {
            return `
                <div class="skeleton-auth-card">
                    <div style="text-align: center; margin-bottom: 1rem;">
                        <span class="skeleton-block skeleton-avatar" style="border-radius: 8px; margin: 0 auto 1rem auto;"></span>
                        <span class="skeleton-block skeleton-text title" style="width: 60%; margin: 0 auto 0.5rem auto;"></span>
                        <span class="skeleton-block skeleton-text sm w-80" style="margin: 0 auto;"></span>
                    </div>
                    <div>
                        <span class="skeleton-block skeleton-text sm w-30"></span>
                        <div class="skeleton-block w-100" style="height: 44px; margin-bottom: 1.25rem;"></div>
                        
                        <span class="skeleton-block skeleton-text sm w-30"></span>
                        <div class="skeleton-block w-100" style="height: 44px; margin-bottom: 1.5rem;"></div>

                        <span class="skeleton-block skeleton-btn block" style="height: 44px;"></span>
                    </div>
                </div>
            `;
        },

        /**
         * 15. Contact / Support Page
         */
        contact() {
            return `
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 2rem; width: 100%;">
                    <div class="skeleton-card">
                        <span class="skeleton-block skeleton-text title w-50" style="margin-bottom: 1rem;"></span>
                        <span class="skeleton-block skeleton-text w-90"></span>
                        <span class="skeleton-block skeleton-text w-80"></span>
                        <div style="margin-top: 1.5rem; display: flex; flex-direction: column; gap: 1rem;">
                            <div style="display: flex; gap: 12px; align-items: center;">
                                <span class="skeleton-block skeleton-icon"></span>
                                <span class="skeleton-block skeleton-text w-60" style="margin-bottom: 0;"></span>
                            </div>
                            <div style="display: flex; gap: 12px; align-items: center;">
                                <span class="skeleton-block skeleton-icon"></span>
                                <span class="skeleton-block skeleton-text w-70" style="margin-bottom: 0;"></span>
                            </div>
                        </div>
                    </div>
                    <div class="skeleton-card">
                        <span class="skeleton-block skeleton-text sm w-25"></span>
                        <div class="skeleton-block w-100" style="height: 42px; margin-bottom: 1rem;"></div>
                        <span class="skeleton-block skeleton-text sm w-25"></span>
                        <div class="skeleton-block w-100" style="height: 42px; margin-bottom: 1rem;"></div>
                        <span class="skeleton-block skeleton-text sm w-25"></span>
                        <div class="skeleton-block w-100" style="height: 100px; margin-bottom: 1.25rem;"></div>
                        <span class="skeleton-block skeleton-btn block" style="height: 44px;"></span>
                    </div>
                </div>
            `;
        }
    };
}

// Attach globally for browser runtime access (both module and script-tag friendly)
if (typeof window !== "undefined") {
    window.SkeletonManager = SkeletonManager;
}

export default SkeletonManager;
