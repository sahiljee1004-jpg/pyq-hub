import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const PDFJS = require("pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js");

const rootDir = process.cwd();
const OCR_CACHE_DIR = path.join(rootDir, "uploads", "vault", "ocr_cache");

// Ensure cache directory exists
if (!fs.existsSync(OCR_CACHE_DIR)) {
    try {
        fs.mkdirSync(OCR_CACHE_DIR, { recursive: true });
    } catch (e) {
        // Safe creation fallback
    }
}

/**
 * Universal OCR Engine Service
 * Provides robust, offline, Node.js/WASM-based optical character recognition
 * with page-level raster extraction, layout column detection, and caching.
 */
export class OcrEngineService {
    static _worker = null;
    static _workerLang = null;

    /**
     * Check if OCR engine is available locally
     */
    static isAvailable() {
        try {
            const hasTesseract = fs.existsSync(path.join(rootDir, "node_modules", "tesseract.js"));
            const hasEngData = fs.existsSync(path.join(rootDir, "eng.traineddata"));
            return hasTesseract && hasEngData;
        } catch (e) {
            return false;
        }
    }

    /**
     * Get or initialize a reusable Tesseract worker instance
     * @param {string|string[]} languages e.g. 'eng' or ['eng', 'hin']
     */
    static async getWorker(languages = "eng") {
        const langKey = Array.isArray(languages) ? languages.join("+") : languages;
        if (this._worker && this._workerLang === langKey) {
            return this._worker;
        }

        if (this._worker) {
            try {
                await this._worker.terminate();
            } catch (tErr) {
                // Ignore termination warning
            }
            this._worker = null;
        }

        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker(languages, 1, {
            cachePath: rootDir,
            logger: () => {}
        });

        this._worker = worker;
        this._workerLang = langKey;
        return worker;
    }

    /**
     * Terminate the active worker instance
     */
    static async terminate() {
        if (this._worker) {
            try {
                await this._worker.terminate();
            } catch (e) {
                // Ignore cleanup error
            }
            this._worker = null;
            this._workerLang = null;
        }
    }

    /**
     * Classifies PDF pages into digital vs scanned streams.
     * Never runs OCR on pages that have clean, searchable digital text (> 50 chars).
     * @param {Buffer} pdfBuffer 
     * @returns {Promise<{totalPages: number, isScanned: boolean, isMixed: boolean, pageMap: Array<{pageNumber: number, type: 'digital'|'scanned', charCount: number, text?: string}>}>}
     */
    static async classifyPdfPages(pdfBuffer) {
        if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
            throw new Error("[OcrEngineService] Invalid PDF buffer provided for classification.");
        }

        const cleanBuffer = new Uint8Array(pdfBuffer);
        const pageMap = [];

        try {
            const doc = await PDFJS.getDocument({ data: cleanBuffer }).promise;
            const totalPages = doc.numPages || 1;

            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                const page = await doc.getPage(pageNum);
                const textContent = await page.getTextContent();
                let pageText = "";
                let lastY = null;

                for (const item of textContent.items) {
                    if (lastY === null || Math.abs(lastY - item.transform[5]) < 4) {
                        pageText += item.str + " ";
                    } else {
                        pageText += "\n" + item.str + " ";
                    }
                    lastY = item.transform[5];
                }

                pageText = pageText.trim();
                const charCount = pageText.length;
                // A page with >= 50 characters of non-whitespace is classified as digital
                const isDigital = charCount >= 50;

                pageMap.push({
                    pageNumber: pageNum,
                    type: isDigital ? "digital" : "scanned",
                    charCount,
                    text: isDigital ? pageText : ""
                });
            }

            const scannedCount = pageMap.filter(p => p.type === "scanned").length;
            const digitalCount = pageMap.filter(p => p.type === "digital").length;
            const isScanned = scannedCount === totalPages;
            const isMixed = scannedCount > 0 && digitalCount > 0;

            return {
                totalPages,
                isScanned,
                isMixed,
                scannedCount,
                digitalCount,
                pageMap
            };
        } catch (err) {
            return {
                totalPages: 1,
                isScanned: true,
                isMixed: false,
                scannedCount: 1,
                digitalCount: 0,
                pageMap: [{ pageNumber: 1, type: "scanned", charCount: 0, text: "" }]
            };
        }
    }

    /**
     * Extract or render the page raster image from PDF buffer.
     * In scanned examination documents, each page is stored as an embedded raster image.
     */
    static async extractPageRaster(pdfBuffer, pageNumber, options = {}) {
        const { DiagramExtractionService } = await import("../admin/diagramExtractionService.js");
        const diagrams = await DiagramExtractionService.extractDiagrams({
            pdfBuffer,
            jobId: options.jobId || "ocr_page"
        });

        const pageImages = diagrams.filter(d => d.pageNumber === pageNumber && d.width > 200);
        if (pageImages.length === 0) {
            return null;
        }

        // The primary page image is the largest raster object on that page
        pageImages.sort((a, b) => (b.width * b.height) - (a.width * a.height));
        const primary = pageImages[0];

        return {
            pageNumber,
            width: primary.width,
            height: primary.height,
            localPath: primary.localPath,
            filename: primary.filename,
            bbox: primary.bbox,
            allPageImages: pageImages
        };
    }

    /**
     * Compute SHA-256 hash for caching
     */
    static computeHash(buffer) {
        return crypto.createHash("sha256").update(buffer).digest("hex").substring(0, 16);
    }

    /**
     * Detect layout columns and gutters on a page image using horizontal darkness projection
     * @param {string} imagePath Local image path
     * @param {number} width Image width
     * @param {number} height Image height
     * @returns {Promise<{columnsCount: number, gutters: number[], headerHeight: number}>}
     */
    static async detectLayoutColumns(imagePath, width, height) {
        // Default single column fallback
        if (!width || !height || width < 400) {
            return { columnsCount: 1, gutters: [], headerHeight: 0 };
        }

        try {
            // Read image buffer and check dimensions
            const imgBuf = fs.readFileSync(imagePath);
            // Check for PNG header
            if (imgBuf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
                return { columnsCount: 1, gutters: [], headerHeight: 0 };
            }

            // Decompress IDAT chunk to inspect grayscale projection
            const zlib = (await import("node:zlib")).default;
            let offset = 8;
            const idatChunks = [];
            while (offset < imgBuf.length) {
                const len = imgBuf.readUInt32BE(offset);
                const type = imgBuf.subarray(offset + 4, offset + 8).toString("ascii");
                if (type === "IDAT") {
                    idatChunks.push(imgBuf.subarray(offset + 8, offset + 8 + len));
                }
                offset += 12 + len;
            }

            if (idatChunks.length === 0) {
                return { columnsCount: 1, gutters: [], headerHeight: 0 };
            }

            const rawData = zlib.inflateSync(Buffer.concat(idatChunks));
            // Standard RGBA or RGB scanlines
            const rowBytes = rawData.length / height;
            const bytesPerPixel = Math.floor((rowBytes - 1) / width);

            if (bytesPerPixel < 1) {
                return { columnsCount: 1, gutters: [], headerHeight: 0 };
            }

            // Project darkness vertically between 15% and 85% of height
            const startY = Math.floor(height * 0.15);
            const endY = Math.floor(height * 0.85);
            const sampleHeight = endY - startY;
            const darkCount = new Int32Array(width);

            for (let y = startY; y < endY; y++) {
                const rowStart = y * rowBytes + 1;
                for (let x = 0; x < width; x++) {
                    const px = rowStart + (x * bytesPerPixel);
                    let val = 255;
                    if (bytesPerPixel === 1) {
                        val = rawData[px];
                    } else if (bytesPerPixel >= 3) {
                        val = (rawData[px] + rawData[px + 1] + rawData[px + 2]) / 3;
                    }
                    if (val < 160) {
                        darkCount[x]++;
                    }
                }
            }

            // Search for dividing line or gutter between 42% and 58% of page width
            const minX = Math.floor(width * 0.42);
            const maxX = Math.floor(width * 0.58);
            let bestGutterX = -1;
            let minGutterDark = 999999;
            let maxLineDark = 0;
            let dividingLineX = -1;

            for (let x = minX; x <= maxX; x++) {
                if (darkCount[x] < minGutterDark) {
                    minGutterDark = darkCount[x];
                    bestGutterX = x;
                }
                if (darkCount[x] > maxLineDark) {
                    maxLineDark = darkCount[x];
                    dividingLineX = x;
                }
            }

            const gutterX = dividingLineX !== -1 && maxLineDark > sampleHeight * 0.35 ? dividingLineX : bestGutterX;
            const hasMultiColumn = (maxLineDark > sampleHeight * 0.35) || (minGutterDark < sampleHeight * 0.05);

            if (!hasMultiColumn || gutterX < minX || gutterX > maxX) {
                return { columnsCount: 1, gutters: [], headerHeight: 0 };
            }

            // Check if page has a top header banner spanning across the gutter
            let headerHeight = 0;
            const checkZone = 12;
            for (let y = 40; y < Math.floor(height * 0.30); y += 20) {
                let crossCount = 0;
                for (let dy = 0; dy < 20; dy++) {
                    const rowStart = (y + dy) * rowBytes + 1;
                    for (let x = gutterX - checkZone; x <= gutterX + checkZone; x++) {
                        const px = rowStart + (x * bytesPerPixel);
                        const val = (rawData[px] + rawData[px + 1] + rawData[px + 2]) / 3;
                        if (val < 160) crossCount++;
                    }
                }
                // High density in gutter zone indicates spanning text
                if (crossCount > 60) {
                    headerHeight = y + 25;
                }
            }

            return {
                columnsCount: 2,
                gutters: [gutterX],
                headerHeight
            };
        } catch (e) {
            // Safe heuristic fallback for standard multi-column layouts
            const defaultGutter = Math.floor(width * 0.50);
            return { columnsCount: 2, gutters: [defaultGutter], headerHeight: 0 };
        }
    }

    /**
     * Perform layout-aware OCR on a single scanned page
     * @param {object} params
     * @param {string} params.imagePath
     * @param {number} params.pageNumber
     * @param {number} params.width
     * @param {number} params.height
     * @param {string} [params.pdfHash]
     * @param {string|string[]} [params.languages]
     * @returns {Promise<object>} Structured OCR page result
     */
    static async recognizePage({ imagePath, pageNumber, width, height, pdfHash = "default", languages = "eng" }) {
        // 1. Check persistent cache
        const cacheDir = path.join(OCR_CACHE_DIR, pdfHash);
        const cacheFile = path.join(cacheDir, `page_${pageNumber}.json`);

        if (fs.existsSync(cacheFile)) {
            try {
                const cachedData = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
                return cachedData;
            } catch (cErr) {
                // If cache corrupted, re-run OCR
            }
        }

        // 2. Detect column structure
        const layout = await this.detectLayoutColumns(imagePath, width, height);
        const worker = await this.getWorker(languages);

        let lines = [];
        let words = [];
        let fullText = "";
        let totalConfidence = 0;
        let lineCount = 0;

        if (layout.columnsCount === 2 && layout.gutters.length > 0) {
            const gutterX = layout.gutters[0];
            const headerH = layout.headerHeight || 0;

            const processResult = (res, colIdx) => {
                if (!res.data) return;
                const blockText = (res.data.text || "").trim();
                if (blockText) {
                    fullText += (fullText ? "\n\n" : "") + blockText;
                }

                if (res.data.blocks) {
                    for (const blk of res.data.blocks) {
                        if (!blk.paragraphs) continue;
                        for (const par of blk.paragraphs) {
                            if (!par.lines) continue;
                            for (const ln of par.lines) {
                                lineCount++;
                                totalConfidence += (ln.confidence || 0);

                                const bbox = {
                                    x0: ln.bbox.x0 || 0,
                                    y0: ln.bbox.y0 || 0,
                                    x1: ln.bbox.x1 || 0,
                                    y1: ln.bbox.y1 || 0
                                };

                                lines.push({
                                    text: ln.text.trim(),
                                    confidence: ln.confidence || 0,
                                    column: colIdx,
                                    bbox,
                                    words: (ln.words || []).map(w => ({
                                        text: w.text,
                                        confidence: w.confidence || 0,
                                        bbox: {
                                            x0: w.bbox.x0 || 0,
                                            y0: w.bbox.y0 || 0,
                                            x1: w.bbox.x1 || 0,
                                            y1: w.bbox.y1 || 0
                                        }
                                    }))
                                });
                            }
                        }
                    }
                }
            };

            // 1. Recognize Header Banner across full width if detected
            if (headerH > 40) {
                const headerRes = await worker.recognize(imagePath, {
                    rectangle: { top: 0, left: 0, width, height: headerH }
                }, { blocks: true });
                processResult(headerRes, 0);
            }

            // 2. Recognize Column 1 (Left)
            const leftRes = await worker.recognize(imagePath, {
                rectangle: { top: headerH, left: 0, width: gutterX, height: height - headerH }
            }, { blocks: true });
            processResult(leftRes, 1);

            // 3. Recognize Column 2 (Right)
            const rightRes = await worker.recognize(imagePath, {
                rectangle: { top: headerH, left: gutterX, width: width - gutterX, height: height - headerH }
            }, { blocks: true });
            processResult(rightRes, 2);
        } else {
            // Single column recognition
            const res = await worker.recognize(imagePath, {}, { blocks: true });
            fullText = (res.data.text || "").trim();

            if (res.data.blocks) {
                for (const blk of res.data.blocks) {
                    if (!blk.paragraphs) continue;
                    for (const par of blk.paragraphs) {
                        if (!par.lines) continue;
                        for (const ln of par.lines) {
                            lineCount++;
                            totalConfidence += (ln.confidence || 0);

                            lines.push({
                                text: ln.text.trim(),
                                confidence: ln.confidence || 0,
                                column: 1,
                                bbox: ln.bbox,
                                words: (ln.words || []).map(w => ({
                                    text: w.text,
                                    confidence: w.confidence || 0,
                                    bbox: w.bbox
                                }))
                            });
                        }
                    }
                }
            }
        }

        const avgConfidence = lineCount > 0 ? Math.round(totalConfidence / lineCount) : 0;

        const pageResult = {
            pageNumber,
            width,
            height,
            isScanned: true,
            confidence: avgConfidence,
            engine: "tesseract.js",
            version: "6.0.1",
            layout: {
                columnsCount: layout.columnsCount,
                gutters: layout.gutters
            },
            lineCount,
            text: fullText,
            lines,
            timestamp: new Date().toISOString()
        };

        // 3. Persist to cache
        try {
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            fs.writeFileSync(cacheFile, JSON.stringify(pageResult, null, 2), "utf8");
        } catch (saveErr) {
            console.warn(`[OcrEngineService] Could not write cache file ${cacheFile}:`, saveErr.message);
        }

        return pageResult;
    }
}
