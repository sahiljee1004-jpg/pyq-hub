import {
    UniversalQuestionType,
    DocumentType,
    ExtractionMethod
} from "../ingestion/extractionSchema.js";
import { GroqVisionProvider } from "./groqVisionProvider.js";

/**
 * Universal Question Reconstruction Service
 * 
 * Combines visual perception from Groq Qwen Vision with OCR tokens and spatial layout.
 * Resolves 2x2 horizontal option grids, inline options, complex LaTeX formulas,
 * isolates solution derivations into solutionText, and computes multi-component confidence.
 */
export class QuestionReconstructionService {

    /**
     * Map numeric or alphabetic option labels to canonical option IDs (A, B, C, D)
     */
    static normalizeOptionId(labelOrId, index = 0) {
        if (!labelOrId) {
            return String.fromCharCode(65 + index); // A, B, C, D fallback
        }
        const clean = String(labelOrId).trim().replace(/[\(\)\[\]\.\:\s]/g, "");
        if (/^[1-4]$/.test(clean)) {
            const num = parseInt(clean, 10);
            return String.fromCharCode(64 + num); // 1 -> A, 2 -> B, 3 -> C, 4 -> D
        }
        if (/^[A-Da-d]$/.test(clean)) {
            return clean.toUpperCase();
        }
        return String.fromCharCode(65 + index);
    }

    /**
     * Format option label cleanly e.g. "(1)", "(2)", "(A)", etc.
     */
    static formatOptionLabel(label, id) {
        if (label && /\([1-4A-D]\)/.test(label)) {
            return label.trim();
        }
        return `(${id})`;
    }

    /**
     * Clean leading question numbering prefixes from stems (e.g. "1. ", "Q.1 ", "Question 1: ")
     */
    static cleanStemPrefix(text, qNum) {
        if (!text) return "";
        let clean = text.trim();
        const prefixRegex = new RegExp(`^(?:Q(?:uestion|\\.)?\\s*(?:No\\.?)?\\s*${qNum}|${qNum}\\s*[\\.\\:\\)])\\s*`, "i");
        clean = clean.replace(prefixRegex, "");
        return clean.trim();
    }

    /**
     * Separate solution/derivation blocks from stem if present
     */
    static extractSolutionFromStem(stemText) {
        if (!stemText) return { cleanStem: "", solutionText: null };

        const solRegex = /(?:\n|^)\s*(?:Ans(?:wer)?|Sol(?:ution)?|Explanation)\s*[:\.\-]\s*([\s\S]*)$/i;
        const match = stemText.match(solRegex);
        if (match) {
            const cleanStem = stemText.substring(0, match.index).trim();
            const solutionText = match[1].trim();
            return { cleanStem, solutionText };
        }
        return { cleanStem: stemText.trim(), solutionText: null };
    }

    /**
     * Detect Universal Question Type from stem and options structure
     */
    static detectQuestionType(stem, options = []) {
        const text = stem || "";

        // Assertion and Reason
        if (/assertion\s*[\(\:A]/i.test(text) && /reason\s*[\(\:R]/i.test(text)) {
            return UniversalQuestionType.ASSERTION_REASON || "assertion_reason";
        }

        // Match the Following (List I / List II or Column I / Column II)
        if (/(?:List\s*[-–I1]|Column\s*[-–I1]).*(?:List\s*[-–II2]|Column\s*[-–II2])/is.test(text)) {
            return UniversalQuestionType.MATCH_FOLLOWING || "match_following";
        }

        // Numerical / NAT (no options, or prompt asks for integer value)
        if ((!options || options.length === 0) && /(?:calculate|find the value|nearest integer|integer answer)/i.test(text)) {
            return UniversalQuestionType.NUMERICAL_NAT || "numerical_nat";
        }

        // Default to Single Choice MCQ
        return UniversalQuestionType.SINGLE_CHOICE_MCQ || "single_choice_mcq";
    }

    /**
     * Compute multi-component confidence score
     * Evaluates:
     * - stemConfidence (clarity, minimal corruption, non-empty)
     * - optionsConfidence (4 complete distinct options)
     * - mathConfidence (LaTeX syntax fidelity)
     * - diagramConfidence (diagram reference corroborated)
     */
    static computeMultiComponentConfidence({ stem, options = [], hasDiagram = false, linkedDiagram = null }) {
        // 1. Stem Confidence (35%)
        let stemConf = 0.5;
        if (stem && stem.length >= 20) {
            stemConf = 0.90;
            // Deduct for suspicious non-ASCII garble
            const nonAsciiCount = (stem.match(/[^\x20-\x7E\u0900-\u097F\n\r\t]/g) || []).length;
            if (nonAsciiCount > 10) {
                stemConf -= 0.20;
            }
        } else if (stem && stem.length > 5) {
            stemConf = 0.70;
        }

        // 2. Options Confidence (35%)
        let optConf = 0.0;
        const validOptions = (options || []).filter(o => o && o.text && o.text.trim().length > 0);
        if (validOptions.length === 4) {
            optConf = 0.98;
            // Check for duplicate option texts
            const uniqueTexts = new Set(validOptions.map(o => o.text.trim().toLowerCase()));
            if (uniqueTexts.size < 4) {
                optConf -= 0.30;
            }
        } else if (validOptions.length === 3) {
            optConf = 0.65;
        } else if (validOptions.length === 2) {
            optConf = 0.40;
        } else if (validOptions.length === 1) {
            optConf = 0.20;
        }

        // 3. Math Confidence (15%)
        let mathConf = 0.90;
        const hasMathDelimiters = /\$[^$]+\$|\\[\(\)\[\]]|\\frac|\\sqrt|\^|_\{/.test(stem);
        if (hasMathDelimiters) {
            // Check balanced math delimiters
            const singleDollars = (stem.match(/(?<!\\)\$/g) || []).length;
            if (singleDollars % 2 === 0) {
                mathConf = 0.98;
            } else {
                mathConf = 0.75; // unbalanced dollar
            }
        }

        // 4. Diagram Confidence (15%)
        let diagConf = 0.95;
        const refersToFigure = /(?:given figure|shown in figure|refer to the graph|circuit diagram|in the diagram)/i.test(stem);
        if (refersToFigure) {
            if (hasDiagram || linkedDiagram) {
                diagConf = 0.95;
            } else {
                diagConf = 0.50; // Mentions diagram but not yet linked
            }
        }

        const overall = Math.round((0.35 * stemConf + 0.35 * optConf + 0.15 * mathConf + 0.15 * diagConf) * 100) / 100;

        return {
            stemConfidence: Math.round(stemConf * 100) / 100,
            optionsConfidence: Math.round(optConf * 100) / 100,
            mathConfidence: Math.round(mathConf * 100) / 100,
            diagramConfidence: Math.round(diagConf * 100) / 100,
            overallConfidence: Math.min(1.0, Math.max(0.1, overall))
        };
    }

    /**
     * Reconstruct structured questions from Vision page extractions,
     * reconciling with OCR tokens and extracted diagrams.
     * 
     * @param {Array<object>} visionQuestions Array of raw questions from GroqVisionProvider
     * @param {Array<object>} [ocrQuestions=[]] Optional OCR questions for corroboration & bounding boxes
     * @param {Array<object>} [diagrams=[]] Optional diagram assets
     * @returns {Array<object>} Canonical question objects with complete provenance
     */
    static reconstructQuestions(visionQuestions = [], ocrQuestions = [], diagrams = []) {
        if (!Array.isArray(visionQuestions) || visionQuestions.length === 0) {
            return [];
        }

        const ocrMap = new Map();
        for (const oq of ocrQuestions) {
            if (oq.questionNumber) {
                ocrMap.set(oq.questionNumber, oq);
            }
        }

        const reconstructed = [];

        for (const vq of visionQuestions) {
            const qNum = parseInt(vq.questionNumber, 10);
            if (!Number.isInteger(qNum) || qNum <= 0) continue;

            const matchingOcr = ocrMap.get(qNum);

            // Reconcile and clean stem text
            const rawStem = vq.stem || (matchingOcr ? matchingOcr.questionText : "");
            const { cleanStem, solutionText: solFromStem } = this.extractSolutionFromStem(rawStem);
            const finalStem = this.cleanStemPrefix(cleanStem, qNum);
            const solutionText = solFromStem || vq.solutionText || (matchingOcr ? matchingOcr.solutionText : null);

            // Reconcile options: resolve 2x2 grids from Vision
            let options = [];
            if (Array.isArray(vq.options) && vq.options.length > 0) {
                options = vq.options.map((opt, idx) => {
                    const optId = this.normalizeOptionId(opt.id || opt.label, idx);
                    const optLabel = this.formatOptionLabel(opt.label, optId);
                    return {
                        id: optId,
                        label: optLabel,
                        text: String(opt.text || "").trim(),
                        confidence: 0.95
                    };
                });
            } else if (matchingOcr && Array.isArray(matchingOcr.options) && matchingOcr.options.length > 0) {
                // Fallback to OCR options if vision had none
                options = matchingOcr.options.map((opt, idx) => {
                    const optId = this.normalizeOptionId(opt.id || opt.label, idx);
                    return {
                        id: optId,
                        label: `(${optId})`,
                        text: String(opt.text || "").trim(),
                        confidence: opt.confidence || 0.75
                    };
                });
            }

            // Deduplicate and ensure standard sort (A, B, C, D)
            options.sort((a, b) => a.id.localeCompare(b.id));

            // Diagrams association
            let linkedDiagram = null;
            if (matchingOcr && matchingOcr.diagram) {
                linkedDiagram = matchingOcr.diagram;
            } else if (diagrams && diagrams.length > 0) {
                const pageNum = vq.pageNumber || (matchingOcr ? matchingOcr.provenance?.originalPdfPage : 1);
                linkedDiagram = diagrams.find(d => d.pageNumber === pageNum && d.width < 800) || null;
            }

            // Determine question type
            const qType = vq.questionType || this.detectQuestionType(finalStem, options);

            // Multi-component confidence
            const confidenceBreakdown = this.computeMultiComponentConfidence({
                stem: finalStem,
                options,
                hasDiagram: Boolean(vq.hasDiagram),
                linkedDiagram
            });

            // Cross-model agreement check
            let crossModelAgreement = null;
            if (matchingOcr) {
                const stemLenDiff = Math.abs(finalStem.length - (matchingOcr.questionText || "").length);
                const optionsLenMatch = options.length === (matchingOcr.options || []).length;
                crossModelAgreement = stemLenDiff < 50 || optionsLenMatch;
            }

            // Spatial Bounding Box & Page Reference from OCR or Vision
            const originalPdfPage = vq.pageNumber || (matchingOcr ? matchingOcr.provenance?.originalPdfPage : 1);
            const bbox = matchingOcr ? matchingOcr.provenance?.bbox : (vq.bbox || null);

            reconstructed.push({
                questionNumber: qNum,
                questionText: finalStem,
                questionType: qType,
                options,
                sectionId: vq.sectionId || (matchingOcr ? matchingOcr.sectionId : "sec_default"),
                sectionName: vq.sectionName || (matchingOcr ? matchingOcr.sectionName : "General"),
                solutionText: solutionText || null,
                diagram: linkedDiagram,
                confidenceBreakdown,
                provenance: {
                    sourceDocId: DocumentType.QUESTION_PAPER,
                    originalPdfPage,
                    ocrPageNumber: originalPdfPage,
                    bbox,
                    ocrEngine: matchingOcr ? "tesseract.js" : null,
                    ocrVersion: matchingOcr ? "6.0.1" : null,
                    visionModel: GroqVisionProvider.getModel(),
                    visionConfidence: confidenceBreakdown.overallConfidence,
                    crossModelAgreement,
                    confidence: confidenceBreakdown.overallConfidence,
                    extractionMethod: matchingOcr ? "hybrid_ocr_vision" : "vision_layout_reconstruction",
                    originalOcrText: matchingOcr ? matchingOcr.questionText : null,
                    normalizedText: finalStem,
                    humanCorrectionHistory: []
                }
            });
        }

        reconstructed.sort((a, b) => a.questionNumber - b.questionNumber);
        return reconstructed;
    }

    /**
     * Enhance an existing array of OCR questions using Vision page results.
     * Replaces 1-3 option questions (from 2x2 grids) with cleanly separated 4-option Vision questions.
     */
    static enhanceOcrQuestionsWithVision(ocrQuestions = [], visionQuestions = [], diagrams = []) {
        if (!visionQuestions || visionQuestions.length === 0) {
            return ocrQuestions;
        }

        const visionReconstructed = this.reconstructQuestions(visionQuestions, ocrQuestions, diagrams);
        const visionMap = new Map();
        for (const vq of visionReconstructed) {
            visionMap.set(vq.questionNumber, vq);
        }

        const enhanced = [];
        for (const oq of ocrQuestions) {
            const vq = visionMap.get(oq.questionNumber);
            if (!vq) {
                enhanced.push(oq);
                continue;
            }

            // If OCR had < 4 options (e.g. 2x2 grid) or lower confidence, use Vision's 4 clean options
            const ocrOptCount = (oq.options || []).length;
            const visOptCount = (vq.options || []).length;

            if (visOptCount === 4 && ocrOptCount < 4) {
                // Adopt vision question with OCR's spatial bbox and verified diagram
                enhanced.push({
                    ...vq,
                    diagram: oq.diagram || vq.diagram,
                    sectionId: oq.sectionId || vq.sectionId,
                    sectionName: oq.sectionName || vq.sectionName,
                    provenance: {
                        ...vq.provenance,
                        bbox: oq.provenance?.bbox || vq.provenance?.bbox,
                        extractionMethod: "hybrid_ocr_vision"
                    }
                });
            } else if (vq.confidenceBreakdown?.overallConfidence > (oq.provenance?.confidence || 0.70)) {
                enhanced.push({
                    ...vq,
                    diagram: oq.diagram || vq.diagram,
                    sectionId: oq.sectionId || vq.sectionId,
                    sectionName: oq.sectionName || vq.sectionName
                });
            } else {
                // Keep OCR question but attach vision provenance
                enhanced.push({
                    ...oq,
                    diagram: oq.diagram || vq.diagram,
                    provenance: {
                        ...oq.provenance,
                        visionModel: GroqVisionProvider.getModel(),
                        visionConfidence: vq.confidenceBreakdown?.overallConfidence || 0.90,
                        crossModelAgreement: true
                    }
                });
            }
        }

        // Add any vision questions that OCR completely missed
        for (const vq of visionReconstructed) {
            if (!ocrQuestions.some(oq => oq.questionNumber === vq.questionNumber)) {
                enhanced.push(vq);
            }
        }

        enhanced.sort((a, b) => a.questionNumber - b.questionNumber);
        return enhanced;
    }
}
