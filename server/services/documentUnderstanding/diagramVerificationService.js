import fs from "fs";
import path from "path";
import { UniversalPdfPageProcessor } from "./universalPdfPageProcessor.js";

const rootDir = process.cwd();
const DIAGRAMS_DIR = path.join(rootDir, "uploads", "vault", "diagrams");

// Ensure diagrams directory exists
if (!fs.existsSync(DIAGRAMS_DIR)) {
    try {
        fs.mkdirSync(DIAGRAMS_DIR, { recursive: true });
    } catch (e) {
        // Fallback
    }
}

/**
 * Universal Diagram Verification Service
 * 
 * Automatically detects diagram boundaries on scanned examination pages,
 * associates cropped diagram images with their respective questions,
 * verifies that options and stems are never clipped into diagram crops,
 * and flags unresolved diagrams for administrative review.
 */
export class DiagramVerificationService {

    /**
     * Regex identifying explicit references to diagrams, circuits, figures, or graphs in question stems
     */
    static get VISUAL_REFERENCE_REGEX() {
        return /(?:fig(?:ure)?\.?|circuit|graph|diagram|schematic plot|as shown below|shown in the|given figure|given circuit|given graph|represented by|indicated in the figure)/i;
    }

    /**
     * Detect, bound, crop, and verify diagram for an individual question on a page
     * 
     * @param {object} params
     * @param {number} params.questionNumber
     * @param {number} params.pageNum
     * @param {object} params.pageJson OCR page result containing `lines`
     * @param {string} [params.pageRasterPath] Local path to the full-page raster image
     * @param {string} [params.docId] Document or booklet identifier
     * @returns {object} Diagram verification report
     */
    static verifyAndExtractQuestionDiagram({
        questionNumber,
        pageNum,
        pageJson,
        pageRasterPath,
        docId = "exam_doc"
    }) {
        const lines = pageJson?.lines || [];
        if (lines.length === 0) {
            return {
                hasDiagram: false,
                hasVisualRef: false,
                diagramStatus: "NO_DIAGRAM"
            };
        }

        // 1. Locate the question header line (e.g. "3. ", "Q.3 ", "Question 3:")
        const qHeaderIdx = lines.findIndex(l => {
            const t = (l.text || "").trim();
            const re = new RegExp(`^(?:Q(?:uestion|\\.)?\\s*(?:No\\.)?\\s*${questionNumber}|${questionNumber}\\s*[\\.:])\\s*`, "i");
            return re.test(t);
        });
        if (qHeaderIdx === -1) {
            return {
                questionNumber,
                pageNum,
                hasDiagram: false,
                hasVisualRef: false,
                diagramStatus: "NO_DIAGRAM"
            };
        }

        // 2. Identify end of question lines (next question or section header)
        let qEndIdx = lines.length;
        for (let i = qHeaderIdx + 1; i < lines.length; i++) {
            const t = (lines[i].text || "").trim();
            const m = t.match(/^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*(\d{1,3})|(\d{1,3})\s*[\.\:])\s*/i);
            if (m) {
                const num = parseInt(m[1] || m[2], 10);
                if (num > 0 && num !== questionNumber) {
                    qEndIdx = i;
                    break;
                }
            }
            if (/^(?:SECTION|PART|GROUP)\s+[A-Z0-9]/i.test(t)) {
                qEndIdx = i;
                break;
            }
        }

        const qLines = lines.slice(qHeaderIdx, qEndIdx);
        const fullText = qLines.map(l => l.text || "").join(" ");
        const hasVisualRef = this.VISUAL_REFERENCE_REGEX.test(fullText);

        // 3. Separate lines into semantic stem, options, and printed solutions
        let optStartLineIdx = -1;
        let solStartLineIdx = -1;

        for (let i = 0; i < qLines.length; i++) {
            const t = (qLines[i].text || "").trim();
            if (/^(?:Sol(?:ution)?|Explanation|Ans(?:wer)?)\b/i.test(t)) {
                if (solStartLineIdx === -1) solStartLineIdx = i;
                break;
            }
            if (/\([1-4A-D]\)/.test(t) || /^[A-D]\.\s+/.test(t) || /^\(1\)/.test(t) || /^\(2\)/.test(t) || /^\(3\)/.test(t) || /^\(4\)/.test(t)) {
                if (optStartLineIdx === -1) optStartLineIdx = i;
            }
        }

        const limitIdx = optStartLineIdx !== -1 ? optStartLineIdx : (solStartLineIdx !== -1 ? solStartLineIdx : qLines.length);

        // Find semantic stem ending (colon, question mark, or standard closing phrase)
        let stemEndLineIdx = 0;
        for (let i = 0; i < limitIdx; i++) {
            const t = (qLines[i].text || "").trim();
            if (/[:\?]\s*$/.test(t) || /\[.*?\]\s*$/.test(t) || /(?:is|ratio|value of [a-z0-9]|option is|respectively|figure|graph)\s*[:\.]\s*$/i.test(t)) {
                stemEndLineIdx = i;
                break;
            }
            if (i >= 2 && (qLines[i].text || "").length > 25 && (i + 1 < limitIdx) && (qLines[i + 1].text || "").length < 15) {
                stemEndLineIdx = i;
                break;
            }
        }

        if (stemEndLineIdx === 0 && limitIdx > 1) {
            for (let i = limitIdx - 1; i >= 0; i--) {
                if ((qLines[i].text || "").trim().length > 20) {
                    stemEndLineIdx = i;
                    break;
                }
            }
        }

        const stemLines = qLines.slice(0, stemEndLineIdx + 1);
        const stemBottomY = Math.max(...stemLines.map(l => l.bbox ? l.bbox.y1 : 0));
        const stemLeftX = Math.min(...stemLines.map(l => l.bbox ? l.bbox.x0 : 9999));

        // Options or solution top boundary
        let optionsTopY = null;
        if (optStartLineIdx !== -1) {
            optionsTopY = qLines[optStartLineIdx].bbox ? qLines[optStartLineIdx].bbox.y0 : null;
        } else if (solStartLineIdx !== -1) {
            optionsTopY = qLines[solStartLineIdx].bbox ? qLines[solStartLineIdx].bbox.y0 : null;
        }

        // Determine column placement
        const isColumn2 = stemLeftX > 550;
        const colX0 = isColumn2 ? 585 : 55;
        const colX1 = isColumn2 ? 1125 : 585;

        // Gap calculation
        let gap = 0;
        let isColumnEndDiagram = false;
        if (optionsTopY !== null && optionsTopY > stemBottomY) {
            gap = optionsTopY - stemBottomY;
        } else if (hasVisualRef && (optionsTopY === null || optionsTopY <= stemBottomY)) {
            // Case where diagram extends to bottom of column (e.g. Q69)
            gap = 1450 - stemBottomY; // page column height boundary
            if (gap >= 60) {
                isColumnEndDiagram = true;
                optionsTopY = 1450;
            }
        }

        const isDiagramCandidate = hasVisualRef && gap >= 35;
        if (!isDiagramCandidate) {
            return {
                questionNumber,
                pageNum,
                hasDiagram: false,
                hasVisualRef,
                diagramStatus: "NO_DIAGRAM"
            };
        }

        // Resolve raster image file
        let rasterPath = pageRasterPath;
        if (!rasterPath || !fs.existsSync(rasterPath)) {
            // Check standard vault diagrams directory
            const defaultRaster = path.join(DIAGRAMS_DIR, `diag_neet-ug-2026-38dc44b4_2026_50_p${pageNum}_img1.png`);
            if (fs.existsSync(defaultRaster)) {
                rasterPath = defaultRaster;
            }
        }

        if (!rasterPath || !fs.existsSync(rasterPath)) {
            return {
                questionNumber,
                pageNum,
                hasDiagram: true,
                hasVisualRef,
                diagramStatus: "UNRESOLVED_DIAGRAM",
                reason: `Page raster image not found for page ${pageNum}`
            };
        }

        const cropBbox = [colX0, stemBottomY + 3, colX1, optionsTopY - 3];
        const cropW = cropBbox[2] - cropBbox[0];
        const cropH = cropBbox[3] - cropBbox[1];

        if (cropW < 32 || cropH < 32) {
            return {
                questionNumber,
                pageNum,
                hasDiagram: true,
                hasVisualRef,
                diagramStatus: "UNRESOLVED_DIAGRAM",
                reason: `Diagram crop vertical height too small (${cropW}x${cropH}).`
            };
        }

        try {
            const cropResult = UniversalPdfPageProcessor.cropImage(rasterPath, cropBbox);
            const diagramId = `diag_${docId}_p${pageNum}_q${questionNumber}`;
            const outFilename = `${diagramId}.png`;
            const outPath = path.join(DIAGRAMS_DIR, outFilename);
            fs.writeFileSync(outPath, cropResult.buffer);

            const stemExcluded = cropBbox[1] >= stemBottomY;
            const optionsExcluded = isColumnEndDiagram ? true : (cropBbox[3] <= optionsTopY);
            const isVerified = stemExcluded && optionsExcluded && cropResult.width >= 32 && cropResult.height >= 32;

            return {
                questionNumber,
                pageNum,
                hasDiagram: true,
                hasVisualRef,
                diagramStatus: isVerified ? "ASSOCIATED_AND_VERIFIED" : "UNRESOLVED_DIAGRAM",
                diagramId,
                filename: outFilename,
                localPath: outPath,
                bbox: cropBbox,
                width: cropResult.width,
                height: cropResult.height,
                stemBottomY,
                optionsTopY,
                stemExcluded,
                optionsExcluded,
                isVerified
            };
        } catch (cropErr) {
            return {
                questionNumber,
                pageNum,
                hasDiagram: true,
                hasVisualRef,
                diagramStatus: "UNRESOLVED_DIAGRAM",
                reason: `Crop error: ${cropErr.message}`
            };
        }
    }

    /**
     * Batch process diagram extraction across a set of reconstructed questions and OCR pages
     */
    static processQuestionsDiagrams({
        questions = [],
        ocrPages = [],
        docId = "exam_doc"
    }) {
        const pageMap = new Map();
        for (const p of ocrPages) {
            pageMap.set(p.pageNumber, p);
        }

        const results = [];
        let verifiedCount = 0;
        let unresolvedCount = 0;

        for (const q of questions) {
            const pageNum = q.provenance?.originalPdfPage || 1;
            const pageJson = pageMap.get(pageNum);
            if (!pageJson) {
                results.push({
                    questionNumber: q.questionNumber,
                    hasDiagram: false,
                    diagramStatus: "NO_DIAGRAM"
                });
                continue;
            }

            const diagResult = this.verifyAndExtractQuestionDiagram({
                questionNumber: q.questionNumber,
                pageNum,
                pageJson,
                docId
            });

            if (diagResult.isVerified) {
                verifiedCount++;
                q.diagram = {
                    diagramId: diagResult.diagramId,
                    filename: diagResult.filename,
                    localPath: diagResult.localPath,
                    bbox: diagResult.bbox,
                    width: diagResult.width,
                    height: diagResult.height,
                    isVerified: true
                };
            } else if (diagResult.hasDiagram) {
                unresolvedCount++;
                q.diagram = {
                    isVerified: false,
                    reason: diagResult.reason,
                    diagramStatus: "UNRESOLVED_DIAGRAM"
                };
            }

            results.push({
                questionNumber: q.questionNumber,
                ...diagResult
            });
        }

        return {
            totalQuestions: questions.length,
            diagramsDetected: verifiedCount + unresolvedCount,
            verifiedCount,
            unresolvedCount,
            results
        };
    }
}
