import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import { GroqVisionProvider } from "./groqVisionProvider.js";
import { encodePng } from "../admin/diagramExtractionService.js";
import { OcrEngineService } from "../ocr/ocrEngineService.js";

const rootDir = process.cwd();
const DIAGRAMS_DIR = path.join(rootDir, "uploads", "vault", "diagrams");

function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

/**
 * Universal PDF Page Processor
 * Handles page raster rendering, pure-JS PNG decoding and sub-region cropping,
 * and bounded-concurrency execution with Groq Vision and OCR.
 */
export class UniversalPdfPageProcessor {

    /**
     * Pure-JS PNG decoder (RGBA, RGB, Grayscale)
     * Handles filter types 0-4 without external native binary dependencies.
     */
    static decodePng(buf) {
        if (!Buffer.isBuffer(buf) || buf.length < 24) {
            throw new Error("[UniversalPdfPageProcessor] Invalid PNG buffer.");
        }

        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        const bitDepth = buf.readUInt8(24);
        const colorType = buf.readUInt8(25);

        let channels = 4;
        if (colorType === 2) channels = 3;
        else if (colorType === 0) channels = 1;
        else if (colorType === 6) channels = 4;

        let offset = 8;
        const idatChunks = [];
        while (offset < buf.length) {
            const len = buf.readUInt32BE(offset);
            const type = buf.slice(offset + 4, offset + 8).toString("ascii");
            if (type === "IDAT") {
                idatChunks.push(buf.slice(offset + 8, offset + 8 + len));
            }
            offset += 12 + len;
        }

        const decompressed = zlib.inflateSync(Buffer.concat(idatChunks));
        const bpp = channels;
        const rowBytes = width * bpp;
        const rawData = Buffer.alloc(width * height * channels);

        let prevRow = Buffer.alloc(rowBytes);
        for (let y = 0; y < height; y++) {
            const filter = decompressed[y * (rowBytes + 1)];
            const srcRow = decompressed.slice(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
            const currRow = Buffer.alloc(rowBytes);

            for (let x = 0; x < rowBytes; x++) {
                const a = x >= bpp ? currRow[x - bpp] : 0;
                const b = prevRow[x];
                const c = x >= bpp ? prevRow[x - bpp] : 0;
                let val = srcRow[x];

                if (filter === 0) {
                    // None
                } else if (filter === 1) {
                    val = (val + a) & 0xff;
                } else if (filter === 2) {
                    val = (val + b) & 0xff;
                } else if (filter === 3) {
                    val = (val + Math.floor((a + b) / 2)) & 0xff;
                } else if (filter === 4) {
                    val = (val + paethPredictor(a, b, c)) & 0xff;
                }
                currRow[x] = val;
            }

            currRow.copy(rawData, y * rowBytes);
            prevRow = currRow;
        }

        return { width, height, channels, rawData };
    }

    /**
     * Crops a bounding box from an image buffer or file.
     * Ensures minimum dimension >= 32px (Qwen Vision constraint) by expanding bounds.
     * 
     * @param {Buffer|string} imageInput File path or image Buffer
     * @param {Array<number>|object} bbox [x0, y0, x1, y1] or { x, y, width, height }
     * @returns {{ width: number, height: number, buffer: Buffer, base64: string }}
     */
    static cropImage(imageInput, bbox) {
        let inputBuf;
        if (typeof imageInput === "string") {
            inputBuf = fs.readFileSync(imageInput);
        } else if (Buffer.isBuffer(imageInput)) {
            inputBuf = imageInput;
        } else {
            throw new Error("[UniversalPdfPageProcessor] Invalid imageInput: expected string path or Buffer.");
        }

        const decoded = this.decodePng(inputBuf);
        let x0 = 0, y0 = 0, x1 = decoded.width, y1 = decoded.height;

        if (Array.isArray(bbox) && bbox.length >= 4) {
            x0 = Math.round(bbox[0]);
            y0 = Math.round(bbox[1]);
            x1 = Math.round(bbox[2]);
            y1 = Math.round(bbox[3]);
        } else if (bbox && typeof bbox === "object") {
            x0 = Math.round(bbox.x || 0);
            y0 = Math.round(bbox.y || 0);
            x1 = x0 + Math.round(bbox.width || 0);
            y1 = y0 + Math.round(bbox.height || 0);
        }

        // Clamp to image boundaries
        x0 = Math.max(0, Math.min(x0, decoded.width - 1));
        y0 = Math.max(0, Math.min(y0, decoded.height - 1));
        x1 = Math.max(x0 + 1, Math.min(x1, decoded.width));
        y1 = Math.max(y0 + 1, Math.min(y1, decoded.height));

        // Enforce minimum 32x32 pixels for Groq Vision compatibility
        let cropW = x1 - x0;
        let cropH = y1 - y0;

        if (cropW < 32) {
            const diff = 32 - cropW;
            const padL = Math.floor(diff / 2);
            const padR = diff - padL;
            x0 = Math.max(0, x0 - padL);
            x1 = Math.min(decoded.width, x1 + padR);
            cropW = x1 - x0;
        }

        if (cropH < 32) {
            const diff = 32 - cropH;
            const padT = Math.floor(diff / 2);
            const padB = diff - padT;
            y0 = Math.max(0, y0 - padT);
            y1 = Math.min(decoded.height, y1 + padB);
            cropH = y1 - y0;
        }

        const channels = decoded.channels;
        const cropData = Buffer.alloc(cropW * cropH * channels);

        for (let row = 0; row < cropH; row++) {
            const srcY = y0 + row;
            if (srcY >= decoded.height) break;
            const srcOffset = (srcY * decoded.width + x0) * channels;
            const dstOffset = (row * cropW) * channels;
            const bytesToCopy = cropW * channels;
            decoded.rawData.copy(cropData, dstOffset, srcOffset, srcOffset + bytesToCopy);
        }

        const croppedBuffer = encodePng(cropW, cropH, cropData, channels);
        return {
            width: cropW,
            height: cropH,
            buffer: croppedBuffer,
            base64: croppedBuffer.toString("base64")
        };
    }

    /**
     * Extract page raster images from PDF buffer
     */
    static async extractPageRasters(pdfBuffer, options = {}) {
        if (!Buffer.isBuffer(pdfBuffer)) {
            throw new Error("[UniversalPdfPageProcessor] Invalid PDF buffer.");
        }

        const classification = await OcrEngineService.classifyPdfPages(pdfBuffer);
        const totalPages = classification.totalPages;
        const maxPages = options.maxPages || totalPages;
        const rasters = [];

        for (let pNum = 1; pNum <= maxPages; pNum++) {
            const raster = await OcrEngineService.extractPageRaster(pdfBuffer, pNum, {
                jobId: options.jobId || "page_proc"
            });
            if (raster) {
                rasters.push(raster);
            }
        }

        return rasters;
    }

    /**
     * Process a page with Groq Vision
     */
    static async processPageWithVision({ image, pageNumber, ocrText = "", useCache = true }) {
        if (!GroqVisionProvider.isAvailable()) {
            throw new Error("[UniversalPdfPageProcessor] Groq Vision is not available or configured.");
        }

        return await GroqVisionProvider.analyzePageQuestions({
            image,
            pageNumber,
            ocrText,
            useCache
        });
    }

    /**
     * Process targeted crop for an ambiguous question / 2x2 option grid
     */
    static async processCropWithVision({
        image,
        questionNumber,
        bbox = null,
        promptGoal = "Recover the 4 individual options from this option grid",
        useCache = true
    }) {
        let cropBuffer = image;
        if (bbox) {
            const cropped = this.cropImage(image, bbox);
            cropBuffer = cropped.buffer;
        }

        return await GroqVisionProvider.analyzeTargetedCrop({
            image: cropBuffer,
            questionNumber,
            promptGoal,
            useCache
        });
    }

    /**
     * Bounded-concurrency processing of multiple tasks
     * 
     * @param {Array<Function>} taskFns Array of async functions
     * @param {number} [concurrency=2] Max concurrent operations
     * @param {Function} [onProgress] Callback for tracking progress (completed, total)
     * @returns {Promise<Array<any>>}
     */
    static async executeBatch(taskFns, concurrency = 2, onProgress = null) {
        const results = new Array(taskFns.length);
        let nextIndex = 0;
        let completed = 0;

        async function worker() {
            while (nextIndex < taskFns.length) {
                const current = nextIndex++;
                try {
                    results[current] = await taskFns[current]();
                } catch (err) {
                    results[current] = { error: err.message };
                } finally {
                    completed++;
                    if (typeof onProgress === "function") {
                        onProgress(completed, taskFns.length);
                    }
                }
            }
        }

        const workers = [];
        const actualConcurrency = Math.min(concurrency, taskFns.length);
        for (let i = 0; i < actualConcurrency; i++) {
            workers.push(worker());
        }

        await Promise.all(workers);
        return results;
    }
}

