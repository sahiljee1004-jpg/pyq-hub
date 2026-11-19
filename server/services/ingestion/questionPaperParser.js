import { createRequire } from "node:module";
import {
    createExtractionField,
    createQuestionExtraction,
    createSectionExtraction,
    ExtractionStatus,
    DocumentType,
    ExtractionMethod,
    UniversalQuestionType
} from "./extractionSchema.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

export class QuestionPaperParser {

    /**
     * Parse Question Paper from PDF buffer, text, or structured page array
     * @param {Buffer|string|Array<{pageNumber: number, text: string}>} input 
     * @param {object} options
     * @returns {Promise<object>} Extracted structured question paper representation
     */
    static async parse(input, options = {}) {
        let pages = [];
        let isScanned = false;
        let averageCharsPerPage = 0;

        if (Buffer.isBuffer(input)) {
            const isPdf = input.length >= 5 && (input.subarray(0, 5).toString("ascii") === "%PDF-" || input.subarray(0, 1024).toString("latin1").includes("%PDF-"));
            if (!isPdf) {
                input = input.toString("utf8");
            }
        }

        if (Buffer.isBuffer(input)) {
            const extracted = await this.extractPagesFromPdf(input);
            pages = extracted.pages;
            isScanned = extracted.isScanned;
            averageCharsPerPage = extracted.averageCharsPerPage;
        } else if (typeof input === "string") {
            const rawPages = input.split(/\f|\n--- Page \d+ ---\n/);
            pages = rawPages.map((text, idx) => ({
                pageNumber: idx + 1,
                text: text.trim()
            }));
            const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
            averageCharsPerPage = pages.length > 0 ? totalChars / pages.length : 0;
            isScanned = averageCharsPerPage < 50;
        } else if (Array.isArray(input)) {
            pages = input.map((p, idx) => ({
                pageNumber: p.pageNumber || (idx + 1),
                text: String(p.text || "").trim()
            }));
            const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
            averageCharsPerPage = pages.length > 0 ? totalChars / pages.length : 0;
            isScanned = averageCharsPerPage < 50;
        } else {
            throw new Error("[QuestionPaperParser] Invalid input: Expected PDF Buffer, string, or page array.");
        }

        // 1. Scanned Document Processing & Quality Gate
        if (isScanned) {
            let ocrAvailable = false;
            let OcrEngineService = null;
            let LayoutReconstructionService = null;

            try {
                const ocrMod = await import("../ocr/ocrEngineService.js");
                const layoutMod = await import("../ocr/layoutReconstructionService.js");
                OcrEngineService = ocrMod.OcrEngineService;
                LayoutReconstructionService = layoutMod.LayoutReconstructionService;
                ocrAvailable = OcrEngineService && OcrEngineService.isAvailable();
            } catch (e) {
                ocrAvailable = false;
            }

            const shouldRunOcr = options.enableOcr === true || options.maxOcrPages !== undefined || process.env.ENABLE_OCR === "true";

            if (!shouldRunOcr || !ocrAvailable || !Buffer.isBuffer(input)) {
                return {
                    isScanned: true,
                    scanDetection: {
                        isScanned: true,
                        averageCharsPerPage,
                        totalPages: pages.length,
                        ocrExecuted: false,
                        message: "PDF contains little or no extractable digital text (<50 chars/page). Actual OCR pipeline required for image-only papers."
                    },
                    frontMatter: {
                        title: createExtractionField(null, { documentId: DocumentType.QUESTION_PAPER, status: ExtractionStatus.UNKNOWN }),
                        durationSeconds: createExtractionField(null, { documentId: DocumentType.QUESTION_PAPER, status: ExtractionStatus.UNKNOWN }),
                        maximumMarks: createExtractionField(null, { documentId: DocumentType.QUESTION_PAPER, status: ExtractionStatus.UNKNOWN })
                    },
                    sections: [],
                    questions: [],
                    warnings: ["Question paper is scanned or image-only without an extractable text layer."]
                };
            }

            // Execute Layout-Aware OCR Pipeline
            const { DiagramExtractionService } = await import("../admin/diagramExtractionService.js");
            const extractedDiagrams = await DiagramExtractionService.extractDiagrams({
                pdfBuffer: input,
                jobId: options.jobId || "ocr_ingestion"
            });

            const pdfHash = OcrEngineService.computeHash(input);
            const ocrPages = [];
            const maxPages = options.maxOcrPages || pages.length;

            for (let pNum = 1; pNum <= maxPages; pNum++) {
                const raster = await OcrEngineService.extractPageRaster(input, pNum, { jobId: options.jobId });
                if (!raster) continue;
                const ocrResult = await OcrEngineService.recognizePage({
                    imagePath: raster.localPath,
                    pageNumber: pNum,
                    width: raster.width,
                    height: raster.height,
                    pdfHash,
                    languages: options.languages || "eng"
                });
                ocrResult.rasterPath = raster.localPath;
                ocrPages.push(ocrResult);
            }

            const reconstructed = LayoutReconstructionService.reconstructQuestions(ocrPages, extractedDiagrams);
            const totalConfidence = ocrPages.reduce((acc, p) => acc + (p.confidence || 0), 0);
            const averageOcrConfidence = ocrPages.length > 0 ? Math.round(totalConfidence / ocrPages.length) : 0;

            // Automated Diagram Verification & Boundary Association (Phase 4.5.2)
            try {
                const { DiagramVerificationService } = await import("../documentUnderstanding/diagramVerificationService.js");
                DiagramVerificationService.processQuestionsDiagrams({
                    questions: reconstructed.questions,
                    ocrPages,
                    docId: options.jobId || "scanned_doc"
                });
            } catch (dErr) {
                console.warn("[QuestionPaperParser] Diagram verification warning:", dErr.message);
            }

            let finalQuestions = reconstructed.questions;
            let visionManifest = null;

            if (options.enableVision && ocrPages.length > 0) {
                try {
                    const { QuestionReconstructionService } = await import("../documentUnderstanding/questionReconstructionService.js");
                    const { GroqVisionProvider } = await import("../documentUnderstanding/groqVisionProvider.js");

                    if (GroqVisionProvider.isAvailable()) {
                        const visionQuestions = [];
                        for (const op of ocrPages) {
                            if (op.rasterPath && fs.existsSync(op.rasterPath)) {
                                const vResult = await GroqVisionProvider.analyzePageQuestions({
                                    image: op.rasterPath,
                                    pageNumber: op.pageNumber,
                                    ocrText: op.text,
                                    useCache: options.useCache !== false
                                });
                                if (vResult && Array.isArray(vResult.questions)) {
                                    visionQuestions.push(...vResult.questions);
                                }
                            }
                        }
                        if (visionQuestions.length > 0) {
                            finalQuestions = QuestionReconstructionService.enhanceOcrQuestionsWithVision(
                                reconstructed.questions,
                                visionQuestions,
                                extractedDiagrams
                            );
                            visionManifest = {
                                model: GroqVisionProvider.getModel(),
                                questionsProcessed: visionQuestions.length,
                                enhancedCount: finalQuestions.length
                            };
                        }
                    }
                } catch (vErr) {
                    console.warn("[QuestionPaperParser] Vision enhancement warning:", vErr.message);
                }
            }

            return {
                isScanned: true,
                scanDetection: {
                    isScanned: true,
                    averageCharsPerPage,
                    totalPages: pages.length,
                    ocrExecuted: true,
                    ocrPagesProcessed: ocrPages.length,
                    averageOcrConfidence
                },
                ocrManifest: {
                    engine: "tesseract.js",
                    version: "6.0.1",
                    averageConfidence: averageOcrConfidence,
                    requiresAdminReview: true,
                    pagesCount: ocrPages.length,
                    pages: ocrPages.map(p => ({
                        pageNumber: p.pageNumber,
                        confidence: p.confidence,
                        columns: p.layout?.columnsCount || 1,
                        lineCount: p.lineCount
                    }))
                },
                visionManifest,
                frontMatter: reconstructed.frontMatter,
                sections: reconstructed.sections,
                questions: finalQuestions,
                uncertainBoundaries: reconstructed.uncertainBoundaries,
                warnings: [
                    ...reconstructed.warnings,
                    "Document processed via layout-aware OCR. Mandatory administrator verification required before publication."
                ]
            };
        }

        // 2. Extract embedded diagram assets if buffer provided
        let extractedDiagrams = [];
        if (Buffer.isBuffer(input)) {
            try {
                const { DiagramExtractionService } = await import("../admin/diagramExtractionService.js");
                extractedDiagrams = await DiagramExtractionService.extractDiagrams({
                    pdfBuffer: input,
                    jobId: options.jobId || "ingestion"
                });
            } catch (diagErr) {
                // Safe non-blocking fallback if diagram extraction has no images
            }
        }

        // 3. Extract Front-Matter (Instructions, Title, Duration, Marks)
        const frontMatter = this.extractFrontMatter(pages);

        // 4. Extract Sections and Questions using Multi-Signal Boundary Detection
        const { sections, questions, uncertainBoundaries, warnings } = this.extractSectionsAndQuestions(pages, extractedDiagrams);

        return {
            isScanned: false,
            scanDetection: {
                isScanned: false,
                averageCharsPerPage,
                totalPages: pages.length
            },
            frontMatter,
            sections,
            questions,
            uncertainBoundaries,
            warnings
        };
    }

    /**
     * Extract page texts from PDF buffer using pdf-parse with coordinate/line preservation
     */
    static async extractPagesFromPdf(pdfBuffer) {
        if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
            throw new Error("[QuestionPaperParser] Empty or invalid PDF buffer supplied.");
        }

        const pages = [];
        try {
            const cleanBuffer = new Uint8Array(pdfBuffer);
            const options = {
                version: "v2.0.550",
                pagerender: function (pageData) {
                    return pageData.getTextContent().then(function (textContent) {
                        let lastY = null;
                        let text = "";
                        for (const item of textContent.items) {
                            if (lastY === null || Math.abs(lastY - item.transform[5]) < 4) {
                                text += item.str + " ";
                            } else {
                                text += "\n" + item.str + " ";
                            }
                            lastY = item.transform[5];
                        }
                        pages.push({
                            pageNumber: pageData.pageIndex + 1,
                            text: text.trim()
                        });
                        return text;
                    });
                }
            };

            const parsed = await pdfParse(cleanBuffer, options);
            if (pages.length === 0 && parsed.text) {
                pages.push({ pageNumber: 1, text: parsed.text.trim() });
            }

            const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
            const averageCharsPerPage = pages.length > 0 ? (totalChars / pages.length) : 0;
            const isScanned = averageCharsPerPage < 50;

            return { pages, isScanned, averageCharsPerPage };
        } catch (err) {
            return {
                pages: [{ pageNumber: 1, text: "" }],
                isScanned: true,
                averageCharsPerPage: 0
            };
        }
    }

    /**
     * Extract Front-Matter (Exam title, Duration, Max marks) from top pages
     */
    static extractFrontMatter(pages) {
        const firstPagesText = pages.slice(0, 2).map(p => p.text).join("\n\n");
        const frontPageNum = pages[0]?.pageNumber || 1;

        // Title / Exam Name pattern
        let examTitle = null;
        const titleMatch = firstPagesText.match(/(?:^|\n)\s*([A-Z0-9\s,\-\(\)\.]{10,80}(?:EXAMINATION|TEST|PAPER|ENTRANCE|PRELIMINARY|MAINS)[A-Z0-9\s,\-\(\)\.]*)/i);
        if (titleMatch) {
            examTitle = createExtractionField(titleMatch[1].trim(), {
                documentId: DocumentType.QUESTION_PAPER,
                pageNumber: frontPageNum,
                evidenceText: titleMatch[0].trim(),
                extractionMethod: ExtractionMethod.TOKEN_PATTERN,
                confidence: 0.92
            });
        } else {
            examTitle = createExtractionField(null, { documentId: DocumentType.QUESTION_PAPER, status: ExtractionStatus.UNKNOWN });
        }

        // Duration pattern
        let durationSeconds = null;
        const compoundDurationMatch = firstPagesText.match(/(?:Duration|Time(?:\s+Allowed)?)\s*[:\-]?\s*(\d+)\s*(?:Hours?|Hrs?)\s*(?:and\s*)?(\d+)\s*(?:Minutes?|Mins?)/i);
        const singleHoursMatch = firstPagesText.match(/(?:Duration|Time(?:\s+Allowed)?)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:Hours?|Hrs?)/i);
        const minutesMatch = firstPagesText.match(/(?:Duration|Time(?:\s+Allowed)?)\s*[:\-]?\s*(\d+)\s*(?:Minutes?|Mins?)/i);

        if (compoundDurationMatch) {
            const hrs = parseInt(compoundDurationMatch[1], 10);
            const mins = parseInt(compoundDurationMatch[2], 10);
            durationSeconds = createExtractionField((hrs * 3600) + (mins * 60), {
                documentId: DocumentType.QUESTION_PAPER,
                pageNumber: frontPageNum,
                evidenceText: compoundDurationMatch[0].trim(),
                confidence: 0.95
            });
        } else if (minutesMatch) {
            const mins = parseInt(minutesMatch[1], 10);
            durationSeconds = createExtractionField(mins * 60, {
                documentId: DocumentType.QUESTION_PAPER,
                pageNumber: frontPageNum,
                evidenceText: minutesMatch[0].trim(),
                confidence: 0.95
            });
        } else if (singleHoursMatch) {
            const hrs = parseFloat(singleHoursMatch[1]);
            durationSeconds = createExtractionField(Math.round(hrs * 3600), {
                documentId: DocumentType.QUESTION_PAPER,
                pageNumber: frontPageNum,
                evidenceText: singleHoursMatch[0].trim(),
                confidence: 0.95
            });
        } else {
            durationSeconds = createExtractionField(null, { documentId: DocumentType.QUESTION_PAPER, status: ExtractionStatus.UNKNOWN });
        }

        // Maximum Marks pattern
        let maximumMarks = null;
        const marksMatch = firstPagesText.match(/(?:Maximum\s+Marks?|Max\.?\s+Marks?|Total\s+Marks?)\s*[:\-]?\s*(\d+)/i);
        if (marksMatch) {
            maximumMarks = createExtractionField(parseInt(marksMatch[1], 10), {
                documentId: DocumentType.QUESTION_PAPER,
                pageNumber: frontPageNum,
                evidenceText: marksMatch[0].trim(),
                confidence: 0.95
            });
        } else {
            maximumMarks = createExtractionField(null, { documentId: DocumentType.QUESTION_PAPER, status: ExtractionStatus.UNKNOWN });
        }

        return {
            examTitle,
            durationSeconds,
            maximumMarks
        };
    }

    /**
     * Multi-Signal Question Boundary Detection & Section Aggregation
     * Automatically detects and handles interleaved bilingual dual-stream documents
     */
    static extractSectionsAndQuestions(pages, extractedDiagrams = []) {
        // Step 1: Detect whether pages follow an interleaved bilingual layout pattern
        const pageFirstQ = [];
        for (const p of pages) {
            // Ignore cover page when identifying starting question sequences
            if (p.pageNumber === 1 && /(?:IMPORTANT\s+INSTRUCTIONS|INSTRUCTIONS\s+TO\s+CANDIDATES|Read\s+the\s+following\s+instructions)/i.test(p.text)) {
                continue;
            }
            const lines = p.text.split("\n");
            for (const l of lines) {
                const m = l.trim().match(/^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*(\d{1,3})|(\d{1,3})\s*[\.\)])\s*(.*)/i);
                if (m) {
                    const num = parseInt(m[1] || m[2], 10);
                    if (num > 0 && num <= 300) {
                        pageFirstQ.push({ pageNumber: p.pageNumber, firstQ: num });
                        break;
                    }
                }
            }
        }

        let matchCount = 0;
        for (let i = 0; i < pageFirstQ.length - 1; i++) {
            if (pageFirstQ[i].firstQ === pageFirstQ[i + 1].firstQ) {
                matchCount++;
            }
        }
        const isInterleaved = matchCount >= 2;

        if (isInterleaved && pageFirstQ.length > 0) {
            // Split alternating page streams (even vs odd)
            const streamEven = pages.filter(p => p.pageNumber % 2 === 0);
            const streamOdd = pages.filter(p => p.pageNumber % 2 === 1);

            const countEnglishWords = (pList) => {
                let score = 0;
                for (const p of pList) {
                    const matches = p.text.match(/\b(?:Which|Consider|Select|following|statements?|correct|answer|Match|below|The)\b/gi);
                    if (matches) score += matches.length;
                }
                return score;
            };

            const primaryPages = countEnglishWords(streamEven) >= countEnglishWords(streamOdd) ? streamEven : streamOdd;
            const parallelPages = primaryPages === streamEven ? streamOdd : streamEven;

            const primaryRes = this._parsePageStream(primaryPages, extractedDiagrams);
            const parallelRes = this._parsePageStream(parallelPages, extractedDiagrams);

            const questions = primaryRes.questions.map(q => {
                const parallelMatch = parallelRes.questions.find(pq => pq.questionNumber === q.questionNumber);
                if (parallelMatch) {
                    return {
                        ...q,
                        bilingual: {
                            parallelStem: parallelMatch.stem?.text || "",
                            parallelOptions: parallelMatch.options || [],
                            parallelNumbering: parallelMatch.originalNumbering || null
                        }
                    };
                }
                return q;
            });

            return {
                sections: primaryRes.sections,
                questions,
                uncertainBoundaries: [...primaryRes.uncertainBoundaries, ...parallelRes.uncertainBoundaries],
                warnings: primaryRes.warnings
            };
        }

        return this._parsePageStream(pages, extractedDiagrams);
    }

    /**
     * Detect and filter repeated document metadata, running headers, and footers at page boundaries
     * Generic, exam-agnostic detection based on positional boundaries and cross-page pattern repetition.
     */
    static detectAndFilterPageHeadersFooters(pages) {
        if (!Array.isArray(pages) || pages.length === 0) return pages;

        // Sample candidate lines from top and bottom of each page to identify repeating layout patterns
        const patternFrequency = new Map();
        for (const p of pages) {
            const rawLines = (p.text || "").split("\n").map(l => l.trim()).filter(Boolean);
            if (rawLines.length === 0) continue;

            const candidates = [];
            if (rawLines.length > 0) candidates.push(rawLines[0]);
            if (rawLines.length > 1) candidates.push(rawLines[1]);
            if (rawLines.length > 2) candidates.push(rawLines[rawLines.length - 1]);

            for (const cand of candidates) {
                // Normalize digits and page numbers to find repeated templates
                const normalized = cand.replace(/\b\d+\b/g, "#").replace(/\s+/g, " ").trim();
                patternFrequency.set(normalized, (patternFrequency.get(normalized) || 0) + 1);
            }
        }

        // Repeating templates across >= 2 pages in multi-page documents (or matching standard header/footer tokens)
        const repeatingTemplates = new Set();
        for (const [tpl, count] of patternFrequency.entries()) {
            if (count >= 2 && /(?:Page|Paper|Code|Exam|Test|Booklet|Series|Shift|Date|Time)/i.test(tpl)) {
                repeatingTemplates.add(tpl);
            }
        }

        return pages.map(p => {
            const lines = (p.text || "").split("\n");
            const filteredLines = lines.filter((l, idx) => {
                const trimmed = l.trim();
                if (!trimmed) return true;

                // Never treat an explicit question marker as a header/footer
                if (/^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*\d{1,3}|\d{1,3}\s*[\.\)])\s+[A-Za-z]/i.test(trimmed)) {
                    return true;
                }

                // Check lines near top (first 3) or bottom (last 3) of page
                const isNearBoundary = (idx < 3 || idx >= lines.length - 3);
                if (isNearBoundary) {
                    const normalized = trimmed.replace(/\b\d+\b/g, "#").replace(/\s+/g, " ").trim();
                    if (repeatingTemplates.has(normalized)) {
                        return false;
                    }
                    if (/^(?:Page\s*[:–-]?\s*\d+|Paper\s+Page\s+\d+|\d+\s*\/\s*\d+|RE-NEET.*Page\s*\d+|UPSC\s+Civil|General\s+Studies\s+Paper|19–C\/FI\/CC|Candidate’s|Question\s+Booklet|CONFIDENTIAL|COPYRIGHT|SPACE\s+FOR\s+ROUGH\s+WORK|ROUGH\s+WORK)/i.test(trimmed)) {
                        return false;
                    }
                    if (/(?:Page\s+\d+|Code\s*\d+).*Page\s+\d+/i.test(trimmed) || /–\s*Page\s+\d+\s*–/i.test(trimmed)) {
                        return false;
                    }
                }
                return true;
            });

            return {
                ...p,
                text: filteredLines.join("\n")
            };
        });
    }

    /**
     * Parses a sequential single-language page stream
     */
    static _parsePageStream(pages, extractedDiagrams = []) {
        const sections = [];
        const questions = [];
        const warnings = [];
        const uncertainBoundaries = [];

        let currentSection = null;
        let currentQ = null;
        let sectionCount = 0;
        let lastQNumInSection = 0;
        let lastSubStatementNum = 0;
        const activeWeightageRanges = [];

        const cleanPages = this.detectAndFilterPageHeadersFooters(pages);

        for (let pIdx = 0; pIdx < cleanPages.length; pIdx++) {
            const page = cleanPages[pIdx];
            const pageNum = page.pageNumber;
            const lines = page.text.split("\n");

            // Filter non-question pages (cover instructions, back-cover instructions, and rough work pages)
            const pageText = page.text;
            const isFirstOrLastPages = (pIdx <= 1 || pIdx >= cleanPages.length - 2);
            const isInstructionsPage = isFirstOrLastPages && (
                /(?:IMPORTANT\s+INSTRUCTIONS|INSTRUCTIONS\s+TO\s+CANDIDATES|Read\s+the\s+following\s+instructions|_hŒdnyU©\s+AZwXoe|महत्वपूर्ण\s+निर्देश|instructions\s+is\s+printed\s+on\s+the\s+First\s+Page)/i.test(pageText)
            ) && !/(?:Which\s+of\s+the\s+following|Choose\s+the\s+correct|Consider\s+the\s+following)/i.test(pageText);

            const isRoughWorkPage = /(?:SPACE\s+FOR\s+ROUGH\s+WORK|ROUGH\s+WORK|रफ\s+कार्य|aμ\\?\$?\s*H\$?m`©)/i.test(pageText) && !/(?:Which\s+of\s+the\s+following|Choose\s+the\s+correct|Consider\s+the\s+following)/i.test(pageText);

            if (isInstructionsPage || isRoughWorkPage) {
                continue;
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                // Ignore document watermarks, running headers, and booklet registration codes
                if (/^(?:Page\s*[:–-]?\s*\d+|Paper\s+Page\s+\d+|RE-NEET.*Page\s*\d+|UPSC\s+Civil|General\s+Studies\s+Paper|19–C\/FI\/CC|Candidate’s|Question\s+Booklet|CONFIDENTIAL|COPYRIGHT|ROUGH\s+WORK)/i.test(line)) {
                    continue;
                }

                // Weightage Notice Signal: e.g. "Q.1 – Q.5 Carry ONE mark Each"
                const weightageMatch = line.match(/^Q\.?\s*(\d{1,3})\s*[-–—]\s*Q?\.?\s*(\d{1,3})\s+Carry\s+([A-Za-z0-9]+)\s+marks?\s+Each/i);
                if (weightageMatch) {
                    const startQ = parseInt(weightageMatch[1], 10);
                    const endQ = parseInt(weightageMatch[2], 10);
                    const wordToNum = { one: 1, two: 2, three: 3, four: 4, five: 5 };
                    const markVal = wordToNum[weightageMatch[3].toLowerCase()] || parseFloat(weightageMatch[3]);
                    if (Number.isFinite(markVal)) {
                        activeWeightageRanges.push({ startQ, endQ, positiveMarks: markVal });
                    }
                    continue;
                }

                // Signal A: Section Boundary Check (must be standalone header)
                const secMatch = line.match(/^(?:SECTION|PART|GROUP|PAPER)\s+([A-Z0-9]{1,3}|[IVXLCDM]{1,4})(?:\s*[:–-]\s*([^\n]+))?$/i)
                    || line.match(/^(?:SECTION|PART|GROUP|PAPER)\s*[-:–]\s*([A-Z0-9]{1,3}|[IVXLCDM]{1,4})(?:\s*[:–-]\s*([^\n]+))?$/i)
                    || line.match(/^SUBJECT\s*[:–-]\s*([^\n]+)$/i)
                    || line.match(/^(?:Mathematics|Math|Physics|Phy|Chemistry|Chem|Botany|Zoology)\s*[-:–]?\s*(?:Section|Sec)\s*([0-9ABIVX]+)/i)
                    || line.match(/^(?:PHYSICS|CHEMISTRY|BIOLOGY|BOTANY|ZOOLOGY|MATHEMATICS)\s*(?:\(.*\)|[-:–].*)?$/i)
                    || line.match(/^(?:General\s+Aptitude(?:\s*\(GA\))?|Technical(?:\s*\(.*\))?)$/i);

                if (secMatch) {
                    if (currentQ) {
                        questions.push(this.compileExtractedQuestion(currentQ, currentSection, extractedDiagrams, activeWeightageRanges));
                        currentQ = null;
                    }
                    sectionCount++;
                    const sName = line;
                    currentSection = createSectionExtraction({
                        sectionId: `sec_${sectionCount}`,
                        sectionName: sName,
                        provenance: createExtractionField(sName, {
                            documentId: DocumentType.QUESTION_PAPER,
                            pageNumber: pageNum,
                            evidenceText: line,
                            extractionMethod: ExtractionMethod.LAYOUT_SPATIAL,
                            confidence: 0.95
                        })
                    });
                    sections.push(currentSection);
                    // Section header declared -> permits numbering restart if next question is 1
                    lastQNumInSection = 0;
                    lastSubStatementNum = 0;
                    continue;
                }

                // Signal B: Question Header Boundary Check
                // Explicit question header: requires punctuation [.:\-)], end-of-line, or whitespace followed by stem text (excluding range dashes like 'Q.1 - Q.5' or list commas)
                const qHeaderMatch = line.match(/^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*(\d{1,3})(?:[.:\-)]|(?:\s+(?![–\-]\s*(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*)?\d+)(?=[^\s,\-\/]))|\s*$)|(\d{1,3})\s*[.)])\s*(.*)/i);
                if (qHeaderMatch) {
                    const isExplicitQ = /^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*\d{1,3})(?:[.:\-)]|(?:\s+(?![–\-]\s*(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*)?\d+)(?=[^\s,\-\/]))|\s*$)/i.test(line);
                    const rawNum = parseInt(qHeaderMatch[1] || qHeaderMatch[2], 10);
                    const remainder = qHeaderMatch[3] ? qHeaderMatch[3].trim() : "";

                    let isNewQuestion = false;

                    if (rawNum > 0 && rawNum <= 300) {
                        const currentText = currentQ ? currentQ.lines.join("\n") : "";
                        const currentHasOptions = currentQ ? (
                            /(?:\([a-eA-E1-5]\)|\b[A-E]\s*[\.\:\)])/i.test(currentText)
                        ) : false;

                        if (!currentQ) {
                            // If no active question is currently open (at document start or right after a section header)
                            if (questions.length === 0 && rawNum === 1) {
                                isNewQuestion = true;
                            } else if (questions.length > 0 && (rawNum === questions[questions.length - 1].questionNumber + 1 || rawNum === 1)) {
                                isNewQuestion = true;
                            } else if (currentSection && rawNum > 0) {
                                isNewQuestion = true;
                            } else if (isExplicitQ) {
                                isNewQuestion = true;
                            }
                        } else if (currentQ) {
                            if (rawNum <= currentQ.num) {
                                // Monotonic rule: an explicit or implicit candidate number that is <= current question cannot begin a new question in the same section
                                isNewQuestion = false;
                                if (!currentHasOptions) {
                                    lastSubStatementNum = rawNum;
                                }
                            } else if (currentHasOptions) {
                                if (rawNum === currentQ.num + 1 || (rawNum > currentQ.num && rawNum <= currentQ.num + 3) || isExplicitQ) {
                                    isNewQuestion = true;
                                }
                            } else {
                                // Multi-Signal Rule: inside a question without options yet
                                if (lastSubStatementNum > 0 && rawNum === lastSubStatementNum + 1) {
                                    // Monotonic progression of sub-statements (e.g. '2. Edge Computing' after '1. Internet of Things')
                                    isNewQuestion = false;
                                    lastSubStatementNum = rawNum;
                                } else if (rawNum === currentQ.num + 1) {
                                    // Natural question progression without active sub-statements
                                    isNewQuestion = true;
                                } else if (isExplicitQ && rawNum > currentQ.num && rawNum <= currentQ.num + 3) {
                                    isNewQuestion = true;
                                } else {
                                    uncertainBoundaries.push({
                                        line,
                                        candidateNumber: rawNum,
                                        currentQuestionNumber: currentQ.num,
                                        pageNumber: pageNum,
                                        reason: "Out-of-sequence candidate number inside question body"
                                    });
                                }
                            }
                        }
                    }

                    if (isNewQuestion) {
                        if (currentQ) {
                            questions.push(this.compileExtractedQuestion(currentQ, currentSection, extractedDiagrams, activeWeightageRanges));
                        }
                        currentQ = {
                            num: rawNum,
                            markerLine: line,
                            lines: [remainder],
                            page: pageNum,
                            lineIndex: i,
                            section: currentSection ? currentSection.sectionName : null
                        };
                        lastQNumInSection = rawNum;
                        lastSubStatementNum = 0;

                        if (currentSection) {
                            if (currentSection.startQuestion === null || rawNum < currentSection.startQuestion) {
                                currentSection.startQuestion = rawNum;
                            }
                            if (currentSection.endQuestion === null || rawNum > currentSection.endQuestion) {
                                currentSection.endQuestion = rawNum;
                            }
                            currentSection.questionCount++;
                        }
                        continue;
                    }
                }

                if (currentQ) {
                    currentQ.lines.push(line);
                }
            }
        }

        if (currentQ) {
            questions.push(this.compileExtractedQuestion(currentQ, currentSection, extractedDiagrams, activeWeightageRanges));
        }

        if (questions.length === 0) {
            warnings.push("No structured questions identified in document. Verify layout formatting or question marker patterns.");
        }

        return { sections, questions, uncertainBoundaries, warnings };
    }

    /**
     * Compiles an extracted question block into a normalized QuestionExtraction object
     */
    static compileExtractedQuestion(qData, currentSection, extractedDiagrams = [], activeWeightageRanges = []) {
        const rawBlock = qData.lines.join("\n").trim();
        const qNum = qData.num;
        const pageNum = qData.page;
        const lineIndex = qData.lineIndex;

        // Question Weightage resolution from explicit notice ranges (e.g. Q.1-Q.5 1 mark, Q.6-Q.10 2 marks)
        let marksAwarded = null;
        let marksDeducted = null;
        if (Array.isArray(activeWeightageRanges) && activeWeightageRanges.length > 0) {
            const rangeRule = activeWeightageRanges.find(r => qNum >= r.startQ && qNum <= r.endQ);
            if (rangeRule) {
                marksAwarded = rangeRule.positiveMarks;
                if (marksAwarded === 1) marksDeducted = 1 / 3;
                else if (marksAwarded === 2) marksDeducted = 2 / 3;
            }
        }

        // 1. Detect Diagrams and Figures (Text References)
        const diagrams = [];
        const diagramMatches = rawBlock.matchAll(/(?:(?:refer\s+to\s+)?\b(?:Figure|Fig\b\.?|Diagram|Graph)\b\s*([0-9A-Z]+)?|\[(?:Diagram|Figure|Image|Graph)\]|as\s+shown\s+below|shown\s+in\s+the\s+(?:graph|figure)|in\s+the\s+diagram)/gi);
        for (const dm of diagramMatches) {
            diagrams.push({
                reference: dm[0],
                label: dm[1] || "Figure",
                pageNumber: pageNum
            });
        }

        // Link any physical raster/vector diagrams on this page from DiagramExtractionService
        if (Array.isArray(extractedDiagrams) && extractedDiagrams.length > 0) {
            const pageDiagrams = extractedDiagrams.filter(d => d.pageNumber === pageNum);
            for (const pd of pageDiagrams) {
                if (!diagrams.some(d => d.diagramId === pd.diagramId)) {
                    diagrams.push(pd);
                }
            }
        }

        // 2. Detect Formulas & LaTeX
        const formulas = [];
        const formulaMatches = rawBlock.matchAll(/(\$[^\$]+\$|\\\[.+?\\\]|[a-zA-Z0-9_]+(?:\^[0-9a-zA-Z]+|_[0-9a-zA-Z]+)|\b\d+\s*(?:m\/s|kg|ohms?|J|Hz|N|Pa|V|W|K|mol|cm)\b)/g);
        for (const fm of formulaMatches) {
            formulas.push(fm[0]);
        }

        // 3. Detect Tables
        const tables = [];
        const tableLines = rawBlock.split("\n").filter(l => l.includes("|") || /\t/.test(l));
        if (tableLines.length >= 2) {
            tables.push({
                rawTable: tableLines.join("\n"),
                rowsCount: tableLines.length
            });
        }

        // 4. Split Stem from Options with Universal Structural Disambiguation
        const { stem: stemText, options } = this.extractOptionsAndStem(rawBlock);

        // 5. Determine Question Type
        let questionType = UniversalQuestionType.SINGLE_CHOICE_MCQ;
        if (/assertion\s*\(?A\)?[\s\S]*reason\s*\(?R\)?/i.test(stemText) || (/assertion/i.test(stemText) && /reason/i.test(stemText) && !/reason\s+for/i.test(stemText))) {
            questionType = UniversalQuestionType.ASSERTION_REASON;
        } else if (/match\s+the\s+following|column\s*I[\s\S]*column\s*II|list\s*I[\s\S]*list\s*II/i.test(stemText)) {
            questionType = UniversalQuestionType.MATCH_FOLLOWING;
        } else if (/choose\s+one\s+or\s+more|one\s+or\s+more\s+than\s+one/i.test(stemText)) {
            questionType = UniversalQuestionType.MULTIPLE_CHOICE_MSQ;
        } else if (options.length === 0) {
            if (/describe|derive|explain\s+in\s+detail|essay|subjective/i.test(stemText)) {
                questionType = UniversalQuestionType.DESCRIPTIVE_MANUAL;
            } else {
                questionType = UniversalQuestionType.NUMERICAL_NAT;
            }
        }

        // 6. Quality Checks: detect unreadable or truncated questions
        const isUnreadable = (!stemText || stemText.length < 5 || stemText.includes("\uFFFD"));
        let unreadableReason = null;
        if (isUnreadable) {
            unreadableReason = stemText.includes("\uFFFD")
                ? "Corrupted text contains unmapped font glyphs or replacement characters."
                : "Question stem is empty or truncated (< 5 characters).";
        }

        return createQuestionExtraction({
            questionNumber: qNum,
            originalNumbering: qData.markerLine.split(/\s+/)[0],
            sectionId: currentSection?.sectionId || null,
            sectionName: currentSection?.sectionName || null,
            questionType,
            marksAwarded,
            marksDeducted,
            stem: {
                text: stemText,
                format: "markdown_latex",
                diagrams,
                tables,
                formulas
            },
            options,
            hasDiagram: diagrams.length > 0,
            diagrams,
            tables,
            formulas,
            sourceReference: {
                documentId: DocumentType.QUESTION_PAPER,
                pageNumber: pageNum,
                lineIndex
            },
            isUnreadable,
            unreadableReason,
            confidence: isUnreadable ? 0.2 : (options.length >= 2 ? 0.98 : 0.85)
        });
    }

    /**
     * Universal Option & Stem Extraction with Multi-Statement Disambiguation
     * 
     * Distinguishes:
     * - Question stem body
     * - Lettered sub-statements (a)-(e) or Roman sub-items (i)-(v)
     * - Final selectable answer choices (both numeric 1-5 and alphabetic A-E)
     * - Continuation lines for complex multi-line options
     * - Embedded diagrams and formula blocks [Figure: ...]
     */
    static extractOptionsAndStem(rawBlock) {
        const lines = rawBlock.split("\n");

        const lineOptRegex = /^\s*(?:\(([1-5A-Ea-e])\)|\[([1-5A-Ea-e])\]|([1-5A-Ea-e])[\.\:\)])\s+(.*)$/;

        function getTokenVal(tok) {
            if (/^[1-5]$/.test(tok)) return { val: parseInt(tok, 10), kind: "NUM" };
            const upper = tok.toUpperCase();
            const isLower = tok === tok.toLowerCase();
            const code = upper.charCodeAt(0) - 64; // A->1, B->2
            return { val: code, kind: isLower ? "LOWER" : "UPPER" };
        }

        const lineMatches = lines.map((l, idx) => {
            if (/^\s*(?:Assertion|Reason|Both|Statement)\b/i.test(l)) return null;
            const m = l.match(lineOptRegex);
            if (!m) return null;
            const tok = m[1] || m[2] || m[3];
            const { val, kind } = getTokenVal(tok);
            return { lineIdx: idx, tok, val, kind, text: m[4].trim(), fullLine: l };
        });

        // Find all valid monotonic line chains starting at val === 1
        const lineChains = [];
        for (let i = 0; i < lineMatches.length; i++) {
            const item = lineMatches[i];
            if (item && item.val === 1) {
                const chain = [item];
                let expectedVal = 2;
                for (let j = i + 1; j < lineMatches.length; j++) {
                    const nextItem = lineMatches[j];
                    if (nextItem && nextItem.kind === item.kind && nextItem.val === expectedVal) {
                        chain.push(nextItem);
                        expectedVal++;
                    }
                }
                if (chain.length >= 2) {
                    lineChains.push(chain);
                }
            }
        }

        // When multiple candidate line chains exist (e.g. statements (a)-(d) and choices (1)-(4)):
        // Prioritize the trailing complete chain that concludes the question block.
        let chosenLineChain = null;
        if (lineChains.length > 0) {
            const completeChains = lineChains.filter(c => c.length >= 4);
            if (completeChains.length > 0) {
                chosenLineChain = completeChains[completeChains.length - 1];
            } else {
                chosenLineChain = lineChains[lineChains.length - 1];
            }
        }

        if (chosenLineChain && chosenLineChain.length >= 2) {
            const firstLineIdx = chosenLineChain[0].lineIdx;
            const stemText = lines.slice(0, firstLineIdx).join("\n").trim();

            const options = [];
            for (let i = 0; i < chosenLineChain.length; i++) {
                const cur = chosenLineChain[i];
                const next = chosenLineChain[i + 1];
                const startIdx = cur.lineIdx;
                const endIdx = next ? next.lineIdx : lines.length;

                const optLines = [cur.text];
                for (let lIdx = startIdx + 1; lIdx < endIdx; lIdx++) {
                    const contLine = lines[lIdx].trim();
                    if (!contLine) continue;
                    // Do not append instruction notices, question range headers or section markers to option text
                    if (/^(?:Q(?:uestion|\.)?\s*\d+\s*[–\-]\s*Q(?:uestion|\.)?\s*\d+|Carry\s+\w+\s+marks?|SECTION|PART|GROUP)\b/i.test(contLine)) {
                        continue;
                    }
                    optLines.push(contLine);
                }

                let canonicalId = cur.tok.toUpperCase();
                if (/^[1-5]$/.test(cur.tok)) {
                    canonicalId = String.fromCharCode(64 + parseInt(cur.tok, 10)); // 1->A, 2->B, etc.
                }

                const fullOptText = optLines.join("\n")
                    .replace(/\n\s*Q(?:uestion|\.)?\s*\d+\s*[–\-]\s*Q(?:uestion|\.)?\s*\d+.*$/i, "")
                    .trim();
                options.push({
                    id: canonicalId,
                    label: `(${cur.tok})`,
                    text: fullOptText,
                    formulas: fullOptText.match(/(\$[^\$]+\$|[a-zA-Z0-9_]+\^[0-9]+)/g) || [],
                    diagramUrl: null
                });
            }

            return { stem: stemText, options };
        }

        // Strategy B: Inline / Horizontal options scanning
        // Mask bracketed figure/diagram annotations [Figure: ...] so internal numbers are ignored
        const bracketRanges = [];
        const bracketRegex = /\[(?:Figure|Fig|Diagram|Graph)[^\]]*\]/gi;
        let bMatch;
        while ((bMatch = bracketRegex.exec(rawBlock)) !== null) {
            bracketRanges.push({ start: bMatch.index, end: bMatch.index + bMatch[0].length });
        }

        function isInsideBracket(idx) {
            return bracketRanges.some(r => idx >= r.start && idx < r.end);
        }

        function hasUnclosedParen(textBefore) {
            let depth = 0;
            for (const c of textBefore) {
                if (c === '(') depth++;
                else if (c === ')') depth = Math.max(0, depth - 1);
            }
            return depth > 0;
        }

        const inlineRegex = /(?<=^|\s)(?:\(([1-5A-Ea-e])\)|\[([1-5A-Ea-e])\]|([1-5A-Ea-e])[\.\:\)])(?:\s+|$)/g;
        const allInlineMatches = [];
        let im;
        while ((im = inlineRegex.exec(rawBlock)) !== null) {
            if (!isInsideBracket(im.index)) {
                // If single closing parenthesis delimiter like '1)', reject if closing an unclosed parenthesis in mathematical expression (e.g. 'Pr(X = 1)')
                if (im[3] && hasUnclosedParen(rawBlock.substring(0, im.index))) {
                    continue;
                }
                const tok = im[1] || im[2] || im[3];
                const { val, kind } = getTokenVal(tok);
                allInlineMatches.push({
                    index: im.index,
                    fullMatch: im[0],
                    tok,
                    val,
                    kind
                });
            }
        }

        const inlineChains = [];
        for (let i = 0; i < allInlineMatches.length; i++) {
            const item = allInlineMatches[i];
            if (item.val === 1) {
                const chain = [item];
                let expectedVal = 2;
                for (let j = i + 1; j < allInlineMatches.length; j++) {
                    const nextItem = allInlineMatches[j];
                    if (nextItem.kind === item.kind && nextItem.val === expectedVal) {
                        chain.push(nextItem);
                        expectedVal++;
                    }
                }
                if (chain.length >= 2) inlineChains.push(chain);
            }
        }

        if (inlineChains.length > 0) {
            const completeChains = inlineChains.filter(c => c.length >= 4);
            const chosen = completeChains.length > 0
                ? completeChains[completeChains.length - 1]
                : inlineChains[inlineChains.length - 1];

            const firstPos = chosen[0].index;
            const stemText = rawBlock.substring(0, firstPos).trim();
            const options = [];
            let isValidOptionChain = true;

            for (let i = 0; i < chosen.length; i++) {
                const cur = chosen[i];
                const next = chosen[i + 1];
                const startPos = cur.index + cur.fullMatch.length;
                const endPos = next ? next.index : rawBlock.length;
                const optText = rawBlock.substring(startPos, endPos).trim();

                // Rejection criteria for false mathematical options:
                // 1. Unparenthesized numeric chain where option starts with an equality operator (e.g. '1) = Pr(X =')
                // 2. Trailing option swallows NAT prompt / blank instructions: e.g. 'is equal to _______' or '(rounded off to'
                if (cur.kind === "NUM" && /^[=≠]/.test(optText)) {
                    isValidOptionChain = false;
                    break;
                }
                if (i === chosen.length - 1 && /(?:rounded\s+off\s+to|answer\s+in\s+integer|is\s+equal\s+to\s*_{2,})/i.test(optText)) {
                    isValidOptionChain = false;
                    break;
                }

                let canonicalId = cur.tok.toUpperCase();
                if (/^[1-5]$/.test(cur.tok)) {
                    canonicalId = String.fromCharCode(64 + parseInt(cur.tok, 10));
                }

                options.push({
                    id: canonicalId,
                    label: `(${cur.tok})`,
                    text: optText,
                    formulas: optText.match(/(\$[^\$]+\$|[a-zA-Z0-9_]+\^[0-9]+)/g) || [],
                    diagramUrl: null
                });
            }

            if (isValidOptionChain && options.length >= 2) {
                return { stem: stemText, options };
            }
        }

        return { stem: rawBlock, options: [] };
    }

    /**
     * Standalone single question parser for unit tests and fixtures
     */
    static parseSingleQuestion(qNum, markerLine, rawBlock, context = {}) {
        return this.compileExtractedQuestion({
            num: qNum,
            markerLine,
            lines: [rawBlock],
            page: context.pageNum || 1,
            lineIndex: context.lineIndex || null
        }, context.currentSection);
    }
}
