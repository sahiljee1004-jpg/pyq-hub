// ============================================================
// VIDYARTHIVERSE — SHARED PDF VIEWER ENGINE & DOWNLOAD UTILITIES
// Reused safely by Papers (papers.js) and Study Resources (study-resources.js)
// ============================================================

// Configure PDF.js WorkerSrc if pdfjsLib is present
if (window.pdfjsLib) {
    try {
        const workerUrl = new URL("js/pdf.worker.min.js", window.location.href).href;
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    } catch (e) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "js/pdf.worker.min.js";
    }
}

let currentRenderSessionId = 0;

export function cancelActiveRenderSession() {
    currentRenderSessionId++;
}

export function getCurrentRenderSessionId() {
    return currentRenderSessionId;
}

// Global Zoom & Active PDF State
export const ZOOM_CONFIG = {
    MIN_ZOOM: 0.5,
    MAX_ZOOM: 3.0,
    ZOOM_STEP: 0.25
};

export class PdfViewerController {
    constructor(elements = {}) {
        this.viewerEl = elements.viewerEl || document.getElementById("paperViewer");
        this.titleEl = elements.titleEl || document.getElementById("viewerTitle");
        this.closeBtnEl = elements.closeBtnEl || document.getElementById("closeViewer");
        
        this.pdfZoomOutBtn = elements.pdfZoomOutBtn || document.getElementById("pdfZoomOutBtn");
        this.pdfZoomInBtn = elements.pdfZoomInBtn || document.getElementById("pdfZoomInBtn");
        this.pdfZoomLevelBtn = elements.pdfZoomLevelBtn || document.getElementById("pdfZoomLevelBtn");
        this.pdfZoomFitWidthBtn = elements.pdfZoomFitWidthBtn || document.getElementById("pdfZoomFitWidthBtn") || document.getElementById("pdfZoomFitBtn");
        this.pdfZoomFitPageBtn = elements.pdfZoomFitPageBtn || document.getElementById("pdfZoomFitPageBtn");
        this.pdfZoomFitBtn = elements.pdfZoomFitBtn || document.getElementById("pdfZoomFitBtn") || this.pdfZoomFitWidthBtn;
        
        this.containerEl = elements.containerEl || document.getElementById("pdfCanvasContainer");
        this.loadingEl = elements.loadingEl || document.getElementById("pdfLoading");
        this.errorEl = elements.errorEl || document.getElementById("pdfError");
        this.iframeEl = elements.iframeEl || document.getElementById("pdfFrame");
        this.errorTitleEl = elements.errorTitleEl || document.getElementById("pdfErrorTitle");
        this.errorDescEl = elements.errorDescEl || document.getElementById("pdfErrorDesc");
        this.fallbackBtn = elements.fallbackBtn || document.getElementById("pdfFallbackBtn");
        this.retryBtn = elements.retryBtn || document.getElementById("pdfRetryBtn");

        this.currentZoomScale = 1.0;
        this.fitMode = "width"; // "width" | "page" | "none"
        this.activePdfUrl = null;
        this.activeItemData = null;
        this.activeCardEl = null;
        this.onPage1RenderSuccess = null;
        this.activeRenderTasks = [];
        this.resizeTimeout = null;

        this.initEventListeners();
    }

    initEventListeners() {
        if (this.pdfZoomOutBtn) {
            this.pdfZoomOutBtn.onclick = () => this.setZoomScale(this.currentZoomScale - ZOOM_CONFIG.ZOOM_STEP, "none");
        }
        if (this.pdfZoomInBtn) {
            this.pdfZoomInBtn.onclick = () => this.setZoomScale(this.currentZoomScale + ZOOM_CONFIG.ZOOM_STEP, "none");
        }
        if (this.pdfZoomLevelBtn) {
            this.pdfZoomLevelBtn.onclick = () => this.setZoomScale(1.0, "none");
        }
        if (this.pdfZoomFitWidthBtn) {
            this.pdfZoomFitWidthBtn.onclick = () => this.setZoomScale(1.0, "width");
        }
        if (this.pdfZoomFitPageBtn) {
            this.pdfZoomFitPageBtn.onclick = () => this.setZoomScale(1.0, "page");
        }
        if (this.pdfZoomFitBtn && this.pdfZoomFitBtn !== this.pdfZoomFitWidthBtn) {
            this.pdfZoomFitBtn.onclick = () => this.setZoomScale(1.0, "width");
        }
        if (this.closeBtnEl) {
            this.closeBtnEl.onclick = () => this.close();
        }

        // Keydown Escape
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && this.viewerEl && !this.viewerEl.classList.contains("hidden")) {
                this.close();
            }
        });

        // Window resize debounced listener for responsive document fitting
        window.addEventListener("resize", () => {
            if (!this.viewerEl || this.viewerEl.classList.contains("hidden") || !this.activePdfUrl) return;
            if (this.fitMode === "none") return;
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = setTimeout(() => {
                this.renderPdf(this.activePdfUrl, this.currentZoomScale, this.fitMode);
            }, 150);
        });

        // Pinch Zoom Support
        this.setupPinchZoom();
    }

    setupPinchZoom() {
        if (!this.containerEl) return;
        let touchStartDist = 0;
        let touchStartScale = 1.0;
        let isPinching = false;

        this.containerEl.addEventListener("touchstart", (e) => {
            if (e.touches.length === 2) {
                isPinching = true;
                touchStartDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                touchStartScale = this.currentZoomScale;
            }
        }, { passive: true });

        this.containerEl.addEventListener("touchmove", (e) => {
            if (isPinching && e.touches.length === 2) {
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                if (touchStartDist > 0) {
                    const factor = dist / touchStartDist;
                    const tempScale = Math.min(Math.max(touchStartScale * factor, ZOOM_CONFIG.MIN_ZOOM), ZOOM_CONFIG.MAX_ZOOM);
                    this.containerEl.style.transform = `scale(${factor})`;
                    this.containerEl.style.transformOrigin = "center top";
                    if (this.pdfZoomLevelBtn) {
                        this.pdfZoomLevelBtn.textContent = `${Math.round(tempScale * 100)}%`;
                    }
                }
            }
        }, { passive: true });

        this.containerEl.addEventListener("touchend", (e) => {
            if (isPinching && e.touches.length < 2) {
                isPinching = false;
                this.containerEl.style.transform = "";
                this.containerEl.style.transformOrigin = "";
                const finalScale = Number(this.pdfZoomLevelBtn.textContent.replace("%", "")) / 100 || this.currentZoomScale;
                this.setZoomScale(finalScale, "none");
            }
        }, { passive: true });
    }

    cancelAllRenderTasks() {
        for (const task of this.activeRenderTasks) {
            try {
                task.cancel();
            } catch (e) {}
        }
        this.activeRenderTasks = [];
    }

    updateZoomToolbarUI() {
        if (this.pdfZoomLevelBtn) {
            this.pdfZoomLevelBtn.textContent = `${Math.round(this.currentZoomScale * 100)}%`;
        }
        if (this.pdfZoomOutBtn) {
            this.pdfZoomOutBtn.disabled = this.currentZoomScale <= ZOOM_CONFIG.MIN_ZOOM;
        }
        if (this.pdfZoomInBtn) {
            this.pdfZoomInBtn.disabled = this.currentZoomScale >= ZOOM_CONFIG.MAX_ZOOM;
        }

        const isFitWidth = this.fitMode === "width";
        const isFitPage = this.fitMode === "page";

        if (this.pdfZoomFitWidthBtn) {
            this.pdfZoomFitWidthBtn.classList.toggle("active", isFitWidth);
            this.pdfZoomFitWidthBtn.style.opacity = isFitWidth ? "1" : "0.75";
            this.pdfZoomFitWidthBtn.style.fontWeight = isFitWidth ? "700" : "500";
        }
        if (this.pdfZoomFitPageBtn) {
            this.pdfZoomFitPageBtn.classList.toggle("active", isFitPage);
            this.pdfZoomFitPageBtn.style.opacity = isFitPage ? "1" : "0.75";
            this.pdfZoomFitPageBtn.style.fontWeight = isFitPage ? "700" : "500";
        }
        if (this.pdfZoomFitBtn && this.pdfZoomFitBtn !== this.pdfZoomFitWidthBtn) {
            this.pdfZoomFitBtn.classList.toggle("active", isFitWidth);
            this.pdfZoomFitBtn.style.opacity = isFitWidth ? "1" : "0.75";
            this.pdfZoomFitBtn.style.fontWeight = isFitWidth ? "700" : "500";
        }
    }

    setZoomScale(newScale, fitMode = "none") {
        if (!this.activePdfUrl) return;
        const clampedScale = Math.min(Math.max(newScale, ZOOM_CONFIG.MIN_ZOOM), ZOOM_CONFIG.MAX_ZOOM);
        this.fitMode = fitMode;
        this.currentZoomScale = clampedScale;
        this.updateZoomToolbarUI();

        let scrollRatioY = 0;
        let scrollRatioX = 0;
        if (this.containerEl && this.containerEl.scrollHeight > 0) {
            scrollRatioY = this.containerEl.scrollTop / this.containerEl.scrollHeight;
            scrollRatioX = this.containerEl.scrollLeft / this.containerEl.scrollWidth;
        }

        this.renderPdf(this.activePdfUrl, this.currentZoomScale, this.fitMode).then(() => {
            if (this.containerEl && this.containerEl.scrollHeight > 0) {
                this.containerEl.scrollTop = Math.round(scrollRatioY * this.containerEl.scrollHeight);
                this.containerEl.scrollLeft = Math.round(scrollRatioX * this.containerEl.scrollWidth);
            }
        });
    }

    open(pdfUrl, title, itemData = null, cardEl = null, onRenderSuccess = null) {
        if (!this.viewerEl) {
            console.error("PDF viewer HTML is missing.");
            return;
        }
        const safePdfURL = safeURL(pdfUrl);
        if (safePdfURL === "#") {
            alert("Invalid PDF URL.");
            return;
        }

        this.activePdfUrl = safePdfURL;
        this.activeItemData = itemData;
        this.activeCardEl = cardEl;
        this.onPage1RenderSuccess = onRenderSuccess;

        this.currentZoomScale = 1.0;
        this.fitMode = "width";
        this.updateZoomToolbarUI();

        if (this.titleEl) {
            this.titleEl.textContent = title;
        }

        this.viewerEl.classList.remove("hidden");
        document.body.classList.add("viewer-open");

        window.scrollTo({ top: 0, behavior: "smooth" });

        this.renderPdf(safePdfURL, this.currentZoomScale, this.fitMode);
    }

    close() {
        cancelActiveRenderSession();
        this.cancelAllRenderTasks();

        this.activePdfUrl = null;
        this.activeItemData = null;
        this.activeCardEl = null;
        this.onPage1RenderSuccess = null;

        if (!this.viewerEl) return;

        this.viewerEl.classList.add("hidden");
        document.body.classList.remove("viewer-open");

        if (this.containerEl) {
            this.containerEl.innerHTML = "";
            this.containerEl.style.transform = "";
        }
        if (this.iframeEl) {
            this.iframeEl.src = "about:blank";
            this.iframeEl.classList.add("hidden");
        }
        if (this.loadingEl) {
            this.loadingEl.classList.add("hidden");
        }
        if (this.errorEl) {
            this.errorEl.classList.add("hidden");
        }
    }

    async renderPdf(url, zoomFactor = 1.0, fitMode = "width") {
        const sessionId = ++currentRenderSessionId;
        this.cancelAllRenderTasks();

        let normalizedFitMode = fitMode;
        if (normalizedFitMode === true) normalizedFitMode = "width";
        else if (normalizedFitMode === false) normalizedFitMode = "none";
        this.fitMode = normalizedFitMode;

        if (this.containerEl) this.containerEl.innerHTML = "";
        if (this.iframeEl) this.iframeEl.classList.add("hidden");
        if (this.errorEl) this.errorEl.classList.add("hidden");
        if (this.loadingEl) this.loadingEl.classList.remove("hidden");

        const updateLoadingText = (text) => {
            if (this.loadingEl) {
                const p = this.loadingEl.querySelector("p");
                if (p) p.textContent = text;
            }
        };
        updateLoadingText("Initializing PDF engine...");

        if (this.fallbackBtn) {
            this.fallbackBtn.onclick = (e) => {
                e.preventDefault();
                if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
                    window.Capacitor.Plugins.Browser.open({ url: url });
                } else {
                    window.open(url, "_system");
                }
            };
        }

        if (this.retryBtn) {
            this.retryBtn.onclick = (e) => {
                e.preventDefault();
                this.renderPdf(url, zoomFactor, normalizedFitMode);
            };
        }

        try {
            if (!window.pdfjsLib) {
                throw new Error("PDF.js library (window.pdfjsLib) is not loaded on page.");
            }

            updateLoadingText("Fetching PDF data...");

            let arrayBuffer = null;
            let httpStatus = 0;

            try {
                const response = await fetch(url);
                httpStatus = response.status;

                if (!response.ok) {
                    throw new Error(`HTTP ${httpStatus} ${response.statusText}`);
                }

                arrayBuffer = await response.arrayBuffer();
            } catch (fetchErr) {
                console.warn(`[PDF Engine] Direct fetch warning: ${fetchErr.message}. Attempting direct URL parse...`, fetchErr);
            }

            if (sessionId !== currentRenderSessionId) return;

            if (arrayBuffer) {
                const byteLength = arrayBuffer.byteLength;
                if (byteLength < 100) {
                    throw new Error(`Downloaded PDF file is truncated or empty (${byteLength} bytes).`);
                }

                const headBytes = new Uint8Array(arrayBuffer, 0, Math.min(byteLength, 20));
                let headerStr = "";
                for (let i = 0; i < headBytes.length; i++) {
                    headerStr += String.fromCharCode(headBytes[i]);
                }

                if (!headerStr.includes("%PDF")) {
                    if (headerStr.includes("<html") || headerStr.includes("<!DOC") || headerStr.includes("<HTML")) {
                        throw new Error("Server returned an HTML web page instead of a PDF document.");
                    }
                    throw new Error("File header does not contain %PDF signature.");
                }
            }

            updateLoadingText("Parsing PDF document...");
            const getDocumentParams = arrayBuffer ? { data: arrayBuffer } : { url: url };
            const loadingTask = window.pdfjsLib.getDocument(getDocumentParams);

            loadingTask.onProgress = (progress) => {
                if (sessionId !== currentRenderSessionId) return;
                if (progress.total > 0 && this.loadingEl) {
                    const percent = Math.round((progress.loaded / progress.total) * 100);
                    updateLoadingText(`Loading PDF (${percent}%)...`);
                }
            };

            const pdf = await loadingTask.promise;
            const totalPages = pdf.numPages;

            if (sessionId !== currentRenderSessionId) return;

            if (this.loadingEl) this.loadingEl.classList.add("hidden");

            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                if (sessionId !== currentRenderSessionId) return;

                const page = await pdf.getPage(pageNum);
                const containerWidth = (this.containerEl && this.containerEl.clientWidth > 0)
                    ? this.containerEl.clientWidth
                    : (window.innerWidth || 360);
                const containerHeight = (this.containerEl && this.containerEl.clientHeight > 0)
                    ? this.containerEl.clientHeight
                    : (window.innerHeight - 56 || 600);
                
                const unscaledViewport = page.getViewport({ scale: 1.0 });
                
                let scale;
                if (normalizedFitMode === "width") {
                    const availableWidth = Math.max(containerWidth - 32, 280);
                    const baseScale = availableWidth / unscaledViewport.width;
                    scale = baseScale * zoomFactor;
                } else if (normalizedFitMode === "page") {
                    const availableWidth = Math.max(containerWidth - 32, 280);
                    const availableHeight = Math.max(containerHeight - 48, 280);
                    const baseScale = Math.min(availableWidth / unscaledViewport.width, availableHeight / unscaledViewport.height);
                    scale = baseScale * zoomFactor;
                } else {
                    scale = zoomFactor;
                }
                scale = Math.max(scale, 0.35);

                const viewport = page.getViewport({ scale: scale });
                const pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
                const canvas = document.createElement("canvas");
                canvas.className = "pdf-page-canvas";

                const renderWidth = Math.ceil(viewport.width * pixelRatio);
                const renderHeight = Math.ceil(viewport.height * pixelRatio);
                const displayWidth = Math.ceil(viewport.width);
                const displayHeight = Math.ceil(viewport.height);

                canvas.width = renderWidth;
                canvas.height = renderHeight;
                canvas.style.width = `${displayWidth}px`;
                canvas.style.height = `${displayHeight}px`;
                canvas.style.display = "block";
                canvas.style.aspectRatio = "auto";

                const context = canvas.getContext("2d", { alpha: false });
                const renderTask = page.render({
                    canvasContext: context,
                    viewport: viewport,
                    transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : null
                });
                this.activeRenderTasks.push(renderTask);

                try {
                    await renderTask.promise;
                } catch (renderErr) {
                    if (renderErr && (renderErr.name === "RenderingCancelledException" || String(renderErr).includes("RenderingCancelledException"))) {
                        return;
                    }
                    throw renderErr;
                } finally {
                    const idx = this.activeRenderTasks.indexOf(renderTask);
                    if (idx !== -1) {
                        this.activeRenderTasks.splice(idx, 1);
                    }
                }

                if (sessionId !== currentRenderSessionId) return;

                const pageWrapper = document.createElement("div");
                pageWrapper.className = "pdf-page-wrapper";
                pageWrapper.style.width = `${displayWidth}px`;
                pageWrapper.style.minHeight = `${displayHeight}px`;
                pageWrapper.appendChild(canvas);

                if (totalPages > 1) {
                    const pageNumBadge = document.createElement("div");
                    pageNumBadge.className = "pdf-page-number";
                    pageNumBadge.textContent = `Page ${pageNum} of ${totalPages}`;
                    pageWrapper.appendChild(pageNumBadge);
                }

                if (this.containerEl) {
                    this.containerEl.appendChild(pageWrapper);
                }

                // Page 1 Success Trigger (fired once per open session)
                if (pageNum === 1 && typeof this.onPage1RenderSuccess === "function") {
                    const callback = this.onPage1RenderSuccess;
                    this.onPage1RenderSuccess = null;
                    callback(this.activeItemData, this.activeCardEl);
                }
            }
        } catch (error) {
            console.error(`[PDF Engine] Render error:`, error);
            if (sessionId !== currentRenderSessionId) return;

            if (this.loadingEl) this.loadingEl.classList.add("hidden");
            if (this.containerEl) this.containerEl.innerHTML = "";

            const isCapacitorNative =
                window.Capacitor &&
                typeof window.Capacitor.isNativePlatform === "function" &&
                window.Capacitor.isNativePlatform();

            if (!isCapacitorNative && this.iframeEl) {
                this.iframeEl.src = url;
                this.iframeEl.classList.remove("hidden");
                return;
            }

            if (this.errorEl) {
                if (this.errorTitleEl) this.errorTitleEl.textContent = "Unable to render PDF preview";
                if (this.errorDescEl) this.errorDescEl.textContent = error.message || "An error occurred while loading or parsing the PDF.";
                this.errorEl.classList.remove("hidden");
            }
        }
    }
}

// Download PDF Helper Function
export async function downloadPdfFile(pdfUrl, title, buttonEl, itemData = null, cardEl = null, onDownloadSuccess = null) {
    const safePdfURL = safeURL(pdfUrl);
    if (safePdfURL === "#") {
        alert("Invalid PDF URL.");
        return;
    }

    if (buttonEl && buttonEl.disabled) return;
    const oldText = buttonEl ? buttonEl.textContent : "";

    try {
        if (buttonEl) {
            buttonEl.disabled = true;
            buttonEl.textContent = "Downloading...";
        }

        const cleanTitle = cleanFileName(title) || "Document";
        const fileName = `${cleanTitle}.pdf`;

        const isCapacitorNative =
            window.Capacitor &&
            typeof window.Capacitor.isNativePlatform === "function" &&
            window.Capacitor.isNativePlatform();

        if (isCapacitorNative && window.Capacitor.Plugins) {
            const { Filesystem, Browser } = window.Capacitor.Plugins;

            if (Filesystem && typeof Filesystem.downloadFile === "function") {
                try {
                    const downloadRes = await Filesystem.downloadFile({
                        url: safePdfURL,
                        path: fileName,
                        directory: "DOCUMENTS",
                        recursive: true
                    });

                    if (downloadRes && downloadRes.path) {
                        alert(`PDF Downloaded Successfully!\nSaved to: Documents/${fileName}`);
                        if (typeof onDownloadSuccess === "function") {
                            onDownloadSuccess(itemData, cardEl);
                        }
                        return;
                    }
                } catch (fsError) {
                    console.warn("Filesystem native download failed, trying browser fallback...", fsError);
                }
            }

            if (Browser && typeof Browser.open === "function") {
                await Browser.open({ url: safePdfURL });
                alert("Opening PDF in browser for native download...");
                if (typeof onDownloadSuccess === "function") {
                    onDownloadSuccess(itemData, cardEl);
                }
                return;
            } else {
                window.open(safePdfURL, "_system");
                if (typeof onDownloadSuccess === "function") {
                    onDownloadSuccess(itemData, cardEl);
                }
                return;
            }
        }

        // Web Download
        const response = await fetch(safePdfURL);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const blob = await response.blob();
        if (!blob.size) {
            throw new Error("Empty PDF");
        }

        const blobURL = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobURL;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => {
            URL.revokeObjectURL(blobURL);
        }, 2000);

        if (typeof onDownloadSuccess === "function") {
            onDownloadSuccess(itemData, cardEl);
        }

        alert(`Download started for ${fileName}`);
    } catch (error) {
        console.error("Download failed:", error);
        const isCapacitorNative =
            window.Capacitor &&
            typeof window.Capacitor.isNativePlatform === "function" &&
            window.Capacitor.isNativePlatform();

        if (isCapacitorNative) {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
                try {
                    await window.Capacitor.Plugins.Browser.open({ url: safePdfURL });
                } catch (e) {
                    window.open(safePdfURL, "_system");
                }
            } else {
                window.open(safePdfURL, "_system");
            }
            alert("Opening PDF in system browser...");
        } else {
            alert(`Unable to download PDF directly (${error.message || "CORS/Network error"}). Opening link...`);
        }
    } finally {
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.textContent = oldText;
        }
    }
}

// Helpers
export function safeURL(url) {
    try {
        const parsed = new URL(url, window.location.href);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
            return parsed.href;
        }
    } catch (e) {}
    return "#";
}

export function cleanFileName(value) {
    return String(value)
        .replace(/[<>:"/\\|?*]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 150);
}

export function escapeHTML(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function getOrCreateAppSessionId() {
    let sid = localStorage.getItem("pyqs_session_id");
    if (!sid) {
        sid = "sess_" + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
        try {
            localStorage.setItem("pyqs_session_id", sid);
        } catch (e) {}
    }
    return sid;
}
