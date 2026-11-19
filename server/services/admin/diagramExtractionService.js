import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { StorageVaultService } from "./storageVaultService.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const PDFJS = require("pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js");

const rootDir = process.cwd();
const DIAGRAMS_DIR = path.join(rootDir, "uploads", "vault", "diagrams");

// Ensure diagrams directory exists
if (!fs.existsSync(DIAGRAMS_DIR)) {
    try {
        fs.mkdirSync(DIAGRAMS_DIR, { recursive: true });
    } catch (e) {
        // Safe directory creation fallback
    }
}

// CRC32 table for pure-JS PNG encoder
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c;
}

function computeCrc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}

function makePngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const payload = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(computeCrc32(payload), 0);
    return Buffer.concat([len, payload, crc]);
}

/**
 * Pure-JS PNG Encoder
 * Converts raw pixel data (RGBA, RGB, or Grayscale) to standard PNG format
 * without native C++ compilation or external binary dependencies.
 */
export function encodePng(width, height, rawData, channels = 4) {
    if (!width || !height || width <= 0 || height <= 0) {
        throw new Error(`Invalid dimensions for PNG encoding: ${width}x${height}`);
    }

    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    // Color type: 6 = RGBA, 2 = RGB, 0 = Grayscale
    const colorType = channels === 4 ? 6 : (channels === 3 ? 2 : 0);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // Bit depth: 8-bit per channel
    ihdr[9] = colorType;
    ihdr[10] = 0; // Compression method (deflate)
    ihdr[11] = 0; // Filter method (standard)
    ihdr[12] = 0; // Interlace method (none)

    const ihdrChunk = makePngChunk("IHDR", ihdr);

    const rowBytes = width * channels;
    const scanlines = Buffer.alloc(height * (rowBytes + 1));
    const srcBuf = Buffer.isBuffer(rawData)
        ? rawData
        : Buffer.from(rawData.buffer, rawData.byteOffset || 0, rawData.byteLength || rawData.length);

    for (let y = 0; y < height; y++) {
        scanlines[y * (rowBytes + 1)] = 0; // Filter byte 0 = None
        const srcOffset = y * rowBytes;
        const dstOffset = y * (rowBytes + 1) + 1;
        const bytesToCopy = Math.min(rowBytes, srcBuf.length - srcOffset);
        if (bytesToCopy > 0) {
            srcBuf.copy(scanlines, dstOffset, srcOffset, srcOffset + bytesToCopy);
        }
    }

    const compressed = zlib.deflateSync(scanlines, { level: 6 });
    const idatChunk = makePngChunk("IDAT", compressed);
    const iendChunk = makePngChunk("IEND", Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Diagram & Image Extraction Service
 * Identifies, extracts, renders, and associates diagrams, circuits, figures,
 * graphs, and tables with examination questions.
 */
export class DiagramExtractionService {

    /**
     * Extract raster and vector diagram assets from PDF buffer
     * @param {Object} params
     * @param {Buffer} params.pdfBuffer - Raw PDF buffer
     * @param {string} [params.jobId] - Optional import job identifier
     * @returns {Promise<Array<Object>>} Extracted diagrams metadata
     */
    static async extractDiagrams({ pdfBuffer, jobId = "job" }) {
        if (!Buffer.isBuffer(pdfBuffer) && !(pdfBuffer instanceof Uint8Array)) {
            return [];
        }

        const safeJobId = String(jobId || "job").replace(/[^a-zA-Z0-9_-]/g, "_");
        const diagrams = [];

        try {
            const cleanData = new Uint8Array(pdfBuffer);
            const doc = await PDFJS.getDocument({ data: cleanData }).promise;
            const totalPages = doc.numPages || 1;

            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                const page = await doc.getPage(pageNum);
                const viewport = page.getViewport({ scale: 1.0 });
                const ops = await page.getOperatorList();

                let currentTransform = [1, 0, 0, 1, 0, 0];
                const transformStack = [];
                let imageIndex = 0;
                let vectorOpsCount = 0;
                const pageVectorPaths = [];
                const pageHeight = Math.round(viewport.height || 792);

                for (let opIdx = 0; opIdx < ops.fnArray.length; opIdx++) {
                    const fn = ops.fnArray[opIdx];
                    const args = ops.argsArray[opIdx];

                    // Track graphic state transforms
                    if (fn === PDFJS.OPS.save) {
                        transformStack.push([...currentTransform]);
                    } else if (fn === PDFJS.OPS.restore) {
                        if (transformStack.length > 0) {
                            currentTransform = transformStack.pop();
                        }
                    } else if (fn === PDFJS.OPS.transform) {
                        if (args && args.length >= 6) {
                            currentTransform = args;
                        }
                    } else if (fn === PDFJS.OPS.constructPath) {
                        vectorOpsCount++;
                        if (args && args[0] && args[1]) {
                            const opList = args[0];
                            const coords = args[1];
                            let cIdx = 0;
                            let d = "";
                            for (const op of opList) {
                                if (op === 13 && cIdx + 1 < coords.length) {
                                    const x = coords[cIdx++];
                                    const y = pageHeight - coords[cIdx++];
                                    d += ` M ${x.toFixed(1)} ${y.toFixed(1)}`;
                                } else if (op === 14 && cIdx + 1 < coords.length) {
                                    const x = coords[cIdx++];
                                    const y = pageHeight - coords[cIdx++];
                                    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
                                } else if (op === 15 && cIdx + 5 < coords.length) {
                                    const x1 = coords[cIdx++]; const y1 = pageHeight - coords[cIdx++];
                                    const x2 = coords[cIdx++]; const y2 = pageHeight - coords[cIdx++];
                                    const x = coords[cIdx++]; const y = pageHeight - coords[cIdx++];
                                    d += ` C ${x1.toFixed(1)} ${y1.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
                                } else if (op === 18) {
                                    d += " Z";
                                } else if (op === 19 && cIdx + 3 < coords.length) {
                                    const x = coords[cIdx++];
                                    const y = pageHeight - (coords[cIdx++] + coords[cIdx + 1]);
                                    const w = coords[cIdx++];
                                    const h = coords[cIdx++];
                                    // Ignore full-page borders
                                    if (w < (viewport.width || 612) * 0.95 || h < (viewport.height || 792) * 0.95) {
                                        d += ` M ${x.toFixed(1)} ${y.toFixed(1)} h ${w.toFixed(1)} v ${h.toFixed(1)} h -${w.toFixed(1)} Z`;
                                    }
                                }
                            }
                            if (d.trim()) {
                                pageVectorPaths.push(`<path d="${d.trim()}" />`);
                            }
                        }
                    } else if (fn === PDFJS.OPS.stroke || fn === PDFJS.OPS.fill || fn === PDFJS.OPS.eoFill) {
                        vectorOpsCount++;
                    }

                    // Check for embedded raster images
                    if (fn === PDFJS.OPS.paintImageXObject || fn === PDFJS.OPS.paintInlineImageXObject) {
                        imageIndex++;
                        const imgName = args ? args[0] : null;
                        const diagramId = `diag_${safeJobId}_p${pageNum}_img${imageIndex}`;
                        const filename = `${diagramId}.png`;
                        const localPath = path.join(DIAGRAMS_DIR, filename);

                        let imgObj = null;
                        if (fn === PDFJS.OPS.paintInlineImageXObject && typeof imgName === "object" && imgName.data) {
                            imgObj = imgName;
                        } else if (imgName && page.objs) {
                            try {
                                imgObj = await new Promise((resolve) => {
                                    if (typeof page.objs.get === "function") {
                                        page.objs.get(imgName, (obj) => resolve(obj));
                                        // Timeout fallback in case callback isn't fired
                                        setTimeout(() => resolve(null), 100);
                                    } else {
                                        resolve(null);
                                    }
                                });
                            } catch (e) {
                                imgObj = null;
                            }
                        }

                        let pngBuffer = null;
                        let imgWidth = 300;
                        let imgHeight = 200;

                        if (imgObj && imgObj.data && imgObj.width && imgObj.height) {
                            imgWidth = imgObj.width;
                            imgHeight = imgObj.height;
                            const dataLen = imgObj.data.length;
                            const totalPixels = imgWidth * imgHeight;

                            try {
                                if (dataLen === totalPixels * 4) {
                                    pngBuffer = encodePng(imgWidth, imgHeight, imgObj.data, 4);
                                } else if (dataLen === totalPixels * 3) {
                                    pngBuffer = encodePng(imgWidth, imgHeight, imgObj.data, 3);
                                } else if (dataLen === totalPixels) {
                                    // Grayscale to RGBA
                                    const rgba = Buffer.alloc(totalPixels * 4);
                                    for (let p = 0; p < totalPixels; p++) {
                                        const v = imgObj.data[p];
                                        rgba[p * 4] = v;
                                        rgba[p * 4 + 1] = v;
                                        rgba[p * 4 + 2] = v;
                                        rgba[p * 4 + 3] = 255;
                                    }
                                    pngBuffer = encodePng(imgWidth, imgHeight, rgba, 4);
                                }
                            } catch (err) {
                                console.warn(`[DiagramExtractionService] PNG encoding warning for ${diagramId}:`, err.message);
                            }
                        }

                        // Save PNG file to vault if buffer generated
                        if (pngBuffer) {
                            try {
                                fs.writeFileSync(localPath, pngBuffer);
                            } catch (wErr) {
                                console.warn(`[DiagramExtractionService] Could not save diagram to ${localPath}:`, wErr.message);
                            }
                        }

                        // Try Cloudinary upload if configured
                        let remoteUrl = null;
                        if (pngBuffer && StorageVaultService.isCloudinaryConfigured && StorageVaultService.isCloudinaryConfigured()) {
                            try {
                                const uploadResult = await StorageVaultService.uploadToCloudinary(pngBuffer, filename, "vidyarthiastra/diagrams");
                                if (uploadResult && uploadResult.secureUrl) {
                                    remoteUrl = uploadResult.secureUrl;
                                }
                            } catch (cErr) {
                                // Graceful fallback to local vault
                            }
                        }

                        // Bounding box from current transform matrix: [x, y, width, height]
                        const bbox = [
                            Math.round(currentTransform[4] || 0),
                            Math.round(currentTransform[5] || 0),
                            Math.round(Math.abs(currentTransform[0]) || imgWidth),
                            Math.round(Math.abs(currentTransform[3]) || imgHeight)
                        ];

                        diagrams.push({
                            diagramId,
                            id: diagramId,
                            pageNumber: pageNum,
                            type: "raster_image",
                            width: imgWidth,
                            height: imgHeight,
                            bbox,
                            filename,
                            localPath: fs.existsSync(localPath) ? localPath : null,
                            remoteUrl,
                            hasBuffer: Boolean(pngBuffer)
                        });
                    }
                }

                // If page has substantial vector artwork (e.g. geometric figures, circuits, curves, graphs)
                // extract and render vector SVG diagram asset to vault
                if (vectorOpsCount > 15 && pageVectorPaths.length > 0) {
                    const diagramId = `diag_${safeJobId}_p${pageNum}_vec1`;
                    const filename = `${diagramId}.svg`;
                    const localPath = path.join(DIAGRAMS_DIR, filename);
                    const svgWidth = Math.round(viewport.width || 612);
                    const svgHeight = Math.round(viewport.height || 792);

                    const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}">
  <rect width="100%" height="100%" fill="#ffffff" />
  <g fill="none" stroke="#111827" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    ${pageVectorPaths.join("\n    ")}
  </g>
</svg>`;

                    try {
                        fs.writeFileSync(localPath, Buffer.from(svgContent, "utf8"));
                    } catch (wErr) {
                        console.warn(`[DiagramExtractionService] Could not save vector diagram to ${localPath}:`, wErr.message);
                    }

                    diagrams.push({
                        diagramId,
                        id: diagramId,
                        pageNumber: pageNum,
                        type: "vector_diagram",
                        width: svgWidth,
                        height: svgHeight,
                        bbox: [0, 0, svgWidth, svgHeight],
                        filename,
                        localPath: fs.existsSync(localPath) ? localPath : null,
                        remoteUrl: null,
                        hasBuffer: fs.existsSync(localPath),
                        vectorOpsCount
                    });
                }
            }
        } catch (err) {
            console.warn("[DiagramExtractionService] PDF diagram extraction notice:", err.message);
        }

        return diagrams;
    }

    /**
     * Associate extracted diagrams with parsed questions based on page numbers,
     * textual references, diagram options, and question layout.
     * @param {Object} params
     * @param {Array<Object>} params.questions - Parsed question objects
     * @param {Array<Object>} params.diagrams - Extracted diagrams metadata
     * @param {string} [params.jobId] - Import job ID
     * @returns {Array<Object>} Enriched questions with diagram metadata
     */
    static associateDiagramsWithQuestions({ questions, diagrams = [], jobId = "job" }) {
        if (!Array.isArray(questions)) return [];

        const diagramsByPage = new Map();
        for (const diag of diagrams) {
            const p = diag.pageNumber;
            if (!diagramsByPage.has(p)) {
                diagramsByPage.set(p, []);
            }
            diagramsByPage.get(p).push(diag);
        }

        const diagramKeywordRegex = /\b(?:figure|fig\.?|diagram|circuit|graph|shown below|as shown|structure|schematic|illustration|plot|curve|table|given below|reaction sequence)\b/i;

        // Group questions by page
        const questionsByPage = new Map();
        for (const q of questions) {
            const p = q.sourcePage || q.pageNumber || 1;
            if (!questionsByPage.has(p)) questionsByPage.set(p, []);
            questionsByPage.get(p).push(q);
        }

        return questions.map(q => {
            const page = q.sourcePage || q.pageNumber || 1;
            const textHasKeyword = diagramKeywordRegex.test(q.questionText || "");
            const hasDiagramFlag = Boolean(q.hasDiagram || textHasKeyword);
            const pageDiagrams = diagramsByPage.get(page) || [];

            const options = Array.isArray(q.options) ? q.options.map(o => ({ ...o })) : [];
            const media = Array.isArray(q.media) ? [...q.media] : [];

            // Detect if question has diagram-only options
            const hasDiagramOptions = options.some(o => o.isDiagramOption || (o.text || "").includes("[Diagram / Structure"));

            if (hasDiagramOptions && pageDiagrams.length > 0) {
                // Find all questions on this page that have diagram options
                const pageDiagQuestions = (questionsByPage.get(page) || []).filter(pq =>
                    Array.isArray(pq.options) && pq.options.some(o => o.isDiagramOption || (o.text || "").includes("[Diagram / Structure"))
                );
                const qIdx = pageDiagQuestions.findIndex(pq => pq.questionNumber === q.questionNumber);

                // Option diagrams are raster images with height < 200 or width < 450
                const candidateOptionDiags = pageDiagrams.filter(d => d.type === "raster_image" && d.height < 200);

                const chunkSize = options.length > 0 ? options.length : 4;
                const startIdx = qIdx >= 0 ? qIdx * chunkSize : 0;
                const assignedOptionDiags = candidateOptionDiags.slice(startIdx, startIdx + chunkSize);

                options.forEach((opt, idx) => {
                    if (opt.isDiagramOption || (opt.text || "").includes("[Diagram / Structure")) {
                        const diag = assignedOptionDiags[idx];
                        if (diag) {
                            opt.diagramUrl = diag.remoteUrl || `/api/admin/vault/diagrams/${diag.filename}`;
                            opt.diagramId = diag.diagramId;
                            opt.hasDiagram = true;

                            const optMediaIdx = media.findIndex(m => m.type === "option_diagram" && String(m.optionId) === String(opt.id));
                            const optMediaItem = {
                                type: "option_diagram",
                                optionId: opt.id,
                                optionLabel: opt.label || opt.id,
                                diagramId: diag.diagramId,
                                url: opt.diagramUrl,
                                localPath: diag.localPath,
                                width: diag.width,
                                height: diag.height
                            };
                            if (optMediaIdx >= 0) media[optMediaIdx] = optMediaItem;
                            else media.push(optMediaItem);
                        } else {
                            opt.diagramUrl = null;
                            opt.hasDiagram = true;
                        }
                    }
                });
            }

            // Stem diagram selection
            let assignedDiagram = null;
            if (pageDiagrams.length > 0 && hasDiagramFlag) {
                // Prefer stem raster diagrams (height >= 150) or vector diagrams
                const stemCandidate = pageDiagrams.find(d => (d.type === "raster_image" && d.height >= 150) || d.type === "vector_diagram");
                assignedDiagram = stemCandidate || pageDiagrams[0];
            }

            if (assignedDiagram) {
                const diagramUrl = assignedDiagram.remoteUrl || `/api/admin/vault/diagrams/${assignedDiagram.filename}`;
                const existingIndex = media.findIndex(m => m.type === "diagram" || m.type === "diagram_reference");
                const diagramMediaItem = {
                    type: "diagram",
                    diagramId: assignedDiagram.diagramId,
                    page: assignedDiagram.pageNumber,
                    url: diagramUrl,
                    localPath: assignedDiagram.localPath,
                    width: assignedDiagram.width,
                    height: assignedDiagram.height,
                    bbox: assignedDiagram.bbox
                };

                if (existingIndex >= 0) {
                    media[existingIndex] = diagramMediaItem;
                } else {
                    media.unshift(diagramMediaItem);
                }

                return {
                    ...q,
                    options,
                    hasDiagram: true,
                    diagramId: assignedDiagram.diagramId,
                    diagramUrl,
                    media
                };
            } else if (hasDiagramFlag || hasDiagramOptions) {
                const previewUrl = `/api/admin/import/jobs/${jobId}/source-preview?page=${page}&docType=questionPaper#page=${page}`;
                const existingIndex = media.findIndex(m => m.type === "diagram" || m.type === "diagram_reference" || m.type === "source_page_evidence");
                const evidenceItem = {
                    type: "source_diagram_region",
                    page,
                    url: previewUrl,
                    note: "Diagram or schematic referenced on source page. Visual review enabled."
                };

                if (existingIndex >= 0) {
                    media[existingIndex] = evidenceItem;
                } else {
                    media.unshift(evidenceItem);
                }

                return {
                    ...q,
                    options,
                    hasDiagram: true,
                    diagramUrl: previewUrl,
                    media
                };
            }

            return {
                ...q,
                options,
                media
            };
        });
    }
}

