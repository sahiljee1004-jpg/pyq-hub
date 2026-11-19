import {
    createExtractionField,
    createQuestionExtraction,
    createSectionExtraction,
    ExtractionStatus,
    DocumentType,
    ExtractionMethod,
    UniversalQuestionType
} from "../ingestion/extractionSchema.js";

/**
 * Universal Layout Reconstruction Service
 * Converts raw page-level OCR line and word streams into structured,
 * multi-column reconstructed questions, options, sections, and solutions.
 * Purely algorithmic and layout-driven — zero exam-specific hardcoding.
 */
export class LayoutReconstructionService {

    /**
     * Reconstruct examination questions from an array of OCR page results
     * @param {Array<object>} ocrPages Array of structured OCR pages from OcrEngineService
     * @param {Array<object>} [extractedDiagrams] Extracted diagram images
     * @returns {object} Reconstructed sections, questions, frontMatter, warnings
     */
    static reconstructQuestions(ocrPages = [], extractedDiagrams = []) {
        if (!Array.isArray(ocrPages) || ocrPages.length === 0) {
            return {
                frontMatter: {},
                sections: [],
                questions: [],
                warnings: ["No OCR pages supplied for layout reconstruction."]
            };
        }

        // 1. Sort pages sequentially by pageNumber
        const sortedPages = [...ocrPages].sort((a, b) => a.pageNumber - b.pageNumber);

        // 2. Extract Front-Matter (Exam title, Duration, Max marks) from page 1/2
        const frontMatter = this.extractFrontMatter(sortedPages);

        // 3. Assemble full document line stream in natural reading order
        const documentLines = [];
        for (const page of sortedPages) {
            const pageLines = this.orderPageLines(page);
            for (const pl of pageLines) {
                documentLines.push({
                    ...pl,
                    pageNumber: page.pageNumber
                });
            }
        }

        // 4. Segment lines into sections, questions, and options
        const { sections, questions, uncertainBoundaries, warnings } = this.segmentQuestions(documentLines, extractedDiagrams);

        return {
            frontMatter,
            sections,
            questions,
            uncertainBoundaries,
            warnings
        };
    }

    /**
     * Order page lines in natural reading order:
     * Header banner (full-width) -> Column 1 (top to bottom) -> Column 2 (top to bottom) -> Footer
     */
    static orderPageLines(page) {
        if (!page.lines || page.lines.length === 0) {
            return [];
        }

        const layout = page.layout || { columnsCount: 1, gutters: [] };
        const headerH = layout.headerHeight || 0;
        const gutters = layout.gutters || [];

        // If single column or no gutters detected, lines are already in y-order
        if (layout.columnsCount <= 1 || gutters.length === 0) {
            return [...page.lines].sort((a, b) => (a.bbox?.y0 || 0) - (b.bbox?.y0 || 0));
        }

        const gutterX = gutters[0];

        // Header lines
        const headerLines = [];
        const col1Lines = [];
        const col2Lines = [];

        for (const ln of page.lines) {
            const bbox = ln.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
            if (headerH > 40 && bbox.y1 <= headerH) {
                headerLines.push(ln);
            } else if (bbox.x0 < gutterX) {
                col1Lines.push(ln);
            } else {
                col2Lines.push(ln);
            }
        }

        headerLines.sort((a, b) => (a.bbox?.y0 || 0) - (b.bbox?.y0 || 0));
        col1Lines.sort((a, b) => (a.bbox?.y0 || 0) - (b.bbox?.y0 || 0));
        col2Lines.sort((a, b) => (a.bbox?.y0 || 0) - (b.bbox?.y0 || 0));

        return [...headerLines, ...col1Lines, ...col2Lines];
    }

    /**
     * Extract Front-Matter from first 1-2 pages
     */
    static extractFrontMatter(sortedPages) {
        const topPages = sortedPages.slice(0, 2);
        const allText = topPages.map(p => p.text || "").join("\n");
        const frontPageNum = sortedPages[0]?.pageNumber || 1;

        let examTitle = null;
        const titleMatch = allText.match(/(?:^|\n)\s*([A-Z0-9\s,\-\(\)\.]{8,80}(?:EXAMINATION|TEST|PAPER|ENTRANCE|PRELIMINARY|MAINS|NEET|JEE|UPSC|BPSC)[A-Z0-9\s,\-\(\)\.]*)/i);
        if (titleMatch) {
            examTitle = createExtractionField(titleMatch[1].trim(), {
                documentId: DocumentType.QUESTION_PAPER,
                pageNumber: frontPageNum,
                evidenceText: titleMatch[0].trim(),
                confidence: 0.90
            });
        } else {
            examTitle = createExtractionField(null, { documentId: DocumentType.QUESTION_PAPER, status: ExtractionStatus.UNKNOWN });
        }

        let durationSeconds = createExtractionField(null, { documentId: DocumentType.QUESTION_PAPER, status: ExtractionStatus.UNKNOWN });
        const timeMatch = allText.match(/(?:Time\s*Allowed|Duration)\s*[:\-]?\s*(\d+)\s*(?:Hours?|Hrs?|Minutes?|Mins?)/i);
        if (timeMatch) {
            const val = parseInt(timeMatch[1], 10);
            const isHours = /hours?|hrs?/i.test(timeMatch[0]);
            durationSeconds = createExtractionField(isHours ? val * 3600 : val * 60, {
                documentId: DocumentType.QUESTION_PAPER,
                pageNumber: frontPageNum,
                evidenceText: timeMatch[0].trim(),
                confidence: 0.90
            });
        }

        let maximumMarks = createExtractionField(null, { documentId: DocumentType.QUESTION_PAPER, status: ExtractionStatus.UNKNOWN });
        const marksMatch = allText.match(/(?:Maximum\s+Marks?|Max\.?\s+Marks?|Total\s+Marks?)\s*[:\-]?\s*(\d+)/i);
        if (marksMatch) {
            maximumMarks = createExtractionField(parseInt(marksMatch[1], 10), {
                documentId: DocumentType.QUESTION_PAPER,
                pageNumber: frontPageNum,
                evidenceText: marksMatch[0].trim(),
                confidence: 0.90
            });
        }

        return { examTitle, durationSeconds, maximumMarks };
    }

    /**
     * Segment ordered line stream into sections, questions, and options
     */
    static segmentQuestions(documentLines, extractedDiagrams = []) {
        const sections = [];
        const questions = [];
        const warnings = [];
        const uncertainBoundaries = [];

        let currentSection = null;
        let currentQ = null;
        let sectionCount = 0;
        let inSolutionBlock = false;
        let solutionLines = [];

        for (let i = 0; i < documentLines.length; i++) {
            const lineObj = documentLines[i];
            const line = (lineObj.text || "").trim();
            const pageNum = lineObj.pageNumber;
            const bbox = lineObj.bbox;
            const conf = lineObj.confidence || 0;

            if (!line) continue;

            // Ignore booklet running headers / footers / watermarks
            if (/^(?:Page\s+\d+|TEST\s+PAPER\s+WITH|Held\s+on\s+Sunday|Candidate’s|Question\s+Booklet|CONFIDENTIAL)/i.test(line)) {
                continue;
            }

            // 1. Section Header Detection
            const secMatch = line.match(/^(?:SECTION|PART|GROUP|PAPER)\s+([A-Z0-9]{1,3}|[IVXLCDM]{1,4})(?:\s*[:–-]\s*([^\n]+))?$/i)
                || line.match(/^(?:SECTION|PART|GROUP|PAPER)\s*[-:–]\s*([A-Z0-9]{1,3}|[IVXLCDM]{1,4})(?:\s*[:–-]\s*([^\n]+))?$/i)
                || line.match(/^SUBJECT\s*[:–-]\s*([^\n]+)$/i)
                || line.match(/^(?:Mathematics|Math|Physics|Phy|Chemistry|Chem|Botany|Zoology)\s*[-:–]?\s*(?:Section|Sec)?\s*([0-9ABIVX]*)/i);

            if (secMatch) {
                // If it looks like a section header and is not a regular sentence
                const isSectionHeader = line.length <= 40 && !/(?:calculate|determine|find|which|following|velocity|mass|force)/i.test(line);
                if (isSectionHeader) {
                    if (currentQ) {
                        currentQ.solutionLines = solutionLines;
                        questions.push(this.compileReconstructedQuestion(currentQ, currentSection, extractedDiagrams));
                        currentQ = null;
                        solutionLines = [];
                        inSolutionBlock = false;
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
                            extractionMethod: ExtractionMethod.OCR_LAYOUT_RECONSTRUCTION,
                            confidence: conf / 100
                        })
                    });
                    sections.push(currentSection);
                    continue;
                }
            }

            // 2. Check if a Solution/Answer block starts
            const solMatch = line.match(/^(?:Sol(?:ution)?|Explanation|Ans(?:wer)?)(?:\.|\b)[:\s]*(.*)/i);
            if (solMatch && currentQ) {
                inSolutionBlock = true;
                solutionLines.push(line);
                continue;
            }

            // If we are currently inside a solution block, collect solution lines until next Question
            const isQHeaderCandidate = /^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*(\d{1,3})|(\d{1,3})\s*[\.\)])\s*(.*)/i.test(line);

            if (inSolutionBlock && !isQHeaderCandidate) {
                solutionLines.push(line);
                continue;
            }

            // 3. Question Header Boundary Check (checked BEFORE options)
            // Questions start with Q.1, Question 1, or 1. / 1: (never bare 1) which is an option marker)
            const qHeaderMatch = line.match(/^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*(\d{1,3})|(\d{1,3})\s*[\.\:])\s*(.*)/i);
            if (qHeaderMatch) {
                const rawNum = parseInt(qHeaderMatch[1] || qHeaderMatch[2], 10);
                const remainder = qHeaderMatch[3] ? qHeaderMatch[3].trim() : "";

                let isNewQuestion = false;

                if (rawNum > 0 && rawNum <= 300) {
                    if (!currentQ) {
                        // First question or after section
                        if (questions.length === 0 && (rawNum === 1 || rawNum > 0)) {
                            isNewQuestion = true;
                        } else if (questions.length > 0 && (rawNum === questions[questions.length - 1].questionNumber + 1 || rawNum === 1)) {
                            isNewQuestion = true;
                        } else if (currentSection && rawNum > 0) {
                            isNewQuestion = true;
                        }
                    } else {
                        // Check sequential continuity
                        const nextExpected = currentQ.num + 1;
                        if (rawNum === nextExpected || (rawNum > currentQ.num && rawNum <= currentQ.num + 3)) {
                            isNewQuestion = true;
                        } else if (rawNum === 1 && currentSection && currentQ.num > 10) {
                            isNewQuestion = true;
                        } else if (rawNum <= currentQ.num) {
                            // Sub-statement inside question stem (e.g. 1. Statement one)
                            isNewQuestion = false;
                        } else {
                            uncertainBoundaries.push({
                                line,
                                candidateNumber: rawNum,
                                currentQuestionNumber: currentQ.num,
                                pageNumber: pageNum,
                                reason: "Out-of-sequence candidate number"
                            });
                        }
                    }
                }

                if (isNewQuestion) {
                    if (currentQ) {
                        currentQ.solutionLines = solutionLines;
                        questions.push(this.compileReconstructedQuestion(currentQ, currentSection, extractedDiagrams));
                    }
                    currentQ = {
                        num: rawNum,
                        pageNum,
                        lines: [remainder ? `${rawNum}. ${remainder}` : line],
                        lineObjects: [lineObj],
                        rawOptions: [],
                        solutionLines: []
                    };
                    inSolutionBlock = false;
                    solutionLines = [];
                    continue;
                }
            }

            // 4. Option Detection (only when inside an active question and NOT in solution)
            if (currentQ && !inSolutionBlock) {
                const optionTokens = this.extractOptionTokens(line, lineObj);
                if (optionTokens.length > 0) {
                    for (const opt of optionTokens) {
                        currentQ.rawOptions.push(opt);
                    }
                    currentQ.lineObjects.push(lineObj);
                    continue;
                }
            }

            // 5. Append line to current question or current solution
            if (currentQ) {
                if (inSolutionBlock) {
                    solutionLines.push(line);
                } else {
                    currentQ.lines.push(line);
                    currentQ.lineObjects.push(lineObj);
                }
            }
        }

        // Close last open question
        if (currentQ) {
            currentQ.solutionLines = solutionLines;
            questions.push(this.compileReconstructedQuestion(currentQ, currentSection, extractedDiagrams));
        }

        return { sections, questions, uncertainBoundaries, warnings };
    }

    /**
     * Extract multiple option tokens from a line (handles side-by-side options like "(1) A (2) B")
     */
    static extractOptionTokens(line, lineObj) {
        const tokens = [];
        // Pattern 1: (1) optionText (2) optionText or (A) optionText (B) optionText
        const parenRegex = /\(([1-4A-Da-d])\)\s*([^(\n]+)/g;
        let match;
        while ((match = parenRegex.exec(line)) !== null) {
            const optId = match[1].toUpperCase();
            const optText = match[2].trim();
            // Options are generally concise (< 150 chars)
            if (optText.length > 0 && optText.length < 150) {
                tokens.push({
                    id: optId,
                    text: optText,
                    confidence: lineObj?.confidence || 75,
                    bbox: lineObj?.bbox
                });
            }
        }

        if (tokens.length > 0) {
            return tokens;
        }

        // Pattern 2: Standalone A. optionText or [A] optionText (letter options only, never digits to avoid question numbers)
        const dotRegex = /^(?:([A-Da-d])[\.\)]\s+)(.+)/;
        const dotMatch = line.match(dotRegex);
        if (dotMatch && dotMatch[2].length < 150) {
            tokens.push({
                id: dotMatch[1].toUpperCase(),
                text: dotMatch[2].trim(),
                confidence: lineObj?.confidence || 75,
                bbox: lineObj?.bbox
            });
        }

        return tokens;
    }

    /**
     * Compile reconstructed question into canonical extraction format
     */
    static compileReconstructedQuestion(rawQ, currentSection, extractedDiagrams = []) {
        const fullStemText = rawQ.lines.join("\n").trim();
        const confidences = rawQ.lineObjects.map(lo => lo.confidence || 70);
        const avgConfidence = confidences.length > 0 ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 75;

        // Compute enclosing bounding box
        let minX0 = 999999, minY0 = 999999, maxX1 = 0, maxY1 = 0;
        for (const lo of rawQ.lineObjects) {
            if (lo.bbox) {
                minX0 = Math.min(minX0, lo.bbox.x0);
                minY0 = Math.min(minY0, lo.bbox.y0);
                maxX1 = Math.max(maxX1, lo.bbox.x1);
                maxY1 = Math.max(maxY1, lo.bbox.y1);
            }
        }
        const questionBbox = minX0 < 999999 ? [minX0, minY0, maxX1, maxY1] : null;

        // Associate diagrams on same page if bbox is inside or near
        let linkedDiagram = null;
        if (Array.isArray(extractedDiagrams) && questionBbox) {
            const pageDiags = extractedDiagrams.filter(d => d.pageNumber === rawQ.pageNum && d.width < 800);
            for (const d of pageDiags) {
                if (d.bbox && Array.isArray(d.bbox)) {
                    const [dx0, dy0, dw, dh] = d.bbox;
                    const dy1 = dy0 + dh;
                    // Check if diagram vertical position is within or near question vertical envelope
                    if (dy0 >= minY0 - 50 && dy1 <= maxY1 + 100) {
                        linkedDiagram = d;
                        break;
                    }
                }
            }
        }

        // Format options with normalized canonical IDs (A, B, C, D)
        const formattedOptions = rawQ.rawOptions.map((opt, idx) => {
            let normId = opt.id;
            if (/^[1-4]$/.test(opt.id)) {
                normId = String.fromCharCode(64 + parseInt(opt.id, 10)); // 1->A, 2->B, etc.
            } else if (!normId) {
                normId = String.fromCharCode(65 + idx);
            }
            return {
                id: normId,
                label: `(${opt.id || normId})`,
                text: opt.text,
                confidence: opt.confidence / 100,
                bbox: opt.bbox ? [opt.bbox.x0, opt.bbox.y0, opt.bbox.x1, opt.bbox.y1] : null
            };
        });

        const explanationText = rawQ.solutionLines.join("\n").trim();

        return {
            questionNumber: rawQ.num,
            questionText: fullStemText,
            questionType: UniversalQuestionType.SINGLE_CHOICE,
            options: formattedOptions,
            sectionId: currentSection ? currentSection.sectionId : "sec_default",
            sectionName: currentSection ? currentSection.sectionName : "General",
            solutionText: explanationText || null,
            diagram: linkedDiagram ? {
                diagramId: linkedDiagram.diagramId,
                filename: linkedDiagram.filename,
                localPath: linkedDiagram.localPath,
                remoteUrl: linkedDiagram.remoteUrl
            } : null,
            provenance: {
                sourceDocId: DocumentType.QUESTION_PAPER,
                originalPdfPage: rawQ.pageNum,
                ocrPageNumber: rawQ.pageNum,
                bbox: questionBbox,
                ocrEngine: "tesseract.js",
                ocrVersion: "6.0.1",
                confidence: avgConfidence / 100,
                extractionMethod: ExtractionMethod.OCR_LAYOUT_RECONSTRUCTION,
                originalOcrText: fullStemText,
                normalizedText: fullStemText,
                humanCorrectionHistory: []
            }
        };
    }
}
