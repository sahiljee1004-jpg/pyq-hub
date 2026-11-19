import { createRequire } from "module";
import dotenv from "dotenv";
import { URL } from "url";
import { getFirestoreServerAuthHeaders, getFirestoreBaseUrl, validateProjectIdFormat } from "./firebaseTokenService.js";
import { SubjectNormalizationService } from "./subjectNormalizationService.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

dotenv.config();

function getActiveProjectId(explicitProjectId = null) {
    const raw = explicitProjectId || process.env.FIREBASE_PROJECT_ID;
    if (!raw || typeof raw !== "string" || !raw.trim()) {
        throw new Error("[QuestionExtractionService] FIREBASE_PROJECT_ID is not configured and no explicit projectId was provided. Rejecting operation to prevent ambient production fallback.");
    }
    return validateProjectIdFormat(raw.trim(), "projectId");
}

/**
 * Dedicated Question Extraction Service for VidyarthiVerse
 * 
 * Flow:
 * Paper Upload / Indexing -> PDF Extraction -> Question Parser -> Quality Gate -> Firestore Writer
 */
export class QuestionExtractionService {

    /**
     * SSRF Safe PDF Buffer Retrieval
     * Validates domain and blocks private IP ranges/localhost
     */
    static async fetchPdfBuffer(pdfUrlOrPath) {
        if (!pdfUrlOrPath || typeof pdfUrlOrPath !== "string") {
            throw new Error("No PDF URL or path provided for extraction.");
        }

        const clean = pdfUrlOrPath.trim();

        if (clean.startsWith("http://") || clean.startsWith("https://")) {
            let parsedUrl;
            try {
                parsedUrl = new URL(clean);
            } catch (e) {
                throw new Error("Invalid PDF URL provided.");
            }

            const hostname = parsedUrl.hostname.toLowerCase();

            // Strict SSRF protection: Block private IPs, loopbacks, link-local metadata (169.254.169.254), decimal IPs
            const isPrivateOrLoopback = 
                hostname === "localhost" ||
                hostname === "127.0.0.1" ||
                hostname === "0.0.0.0" ||
                hostname === "::" ||
                hostname === "::1" ||
                hostname.endsWith(".localhost") ||
                hostname.endsWith(".local") ||
                hostname.endsWith(".internal") ||
                /^10\./.test(hostname) ||
                /^192\.168\./.test(hostname) ||
                /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
                /^169\.254\./.test(hostname) ||
                /^127\./.test(hostname) ||
                /^0\./.test(hostname) ||
                /^\d+$/.test(hostname) ||
                /^0x[0-9a-f]+$/i.test(hostname);

            if (isPrivateOrLoopback) {
                throw new Error("Security Error: Access to local, internal, or private network URLs is strictly forbidden.");
            }

            // Enforce HTTPS for remote PDF extraction
            if (parsedUrl.protocol !== "https:") {
                throw new Error("Security Error: Only HTTPS PDF URLs are permitted for remote extraction.");
            }

            const response = await fetch(clean);
            if (!response.ok) {
                throw new Error(`Failed to fetch PDF from URL (HTTP ${response.status})`);
            }
            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } else {
            // Local file path (Server internal use only)
            const fs = await import("fs");
            return fs.readFileSync(clean);
        }
    }

    /**
     * Extract page-by-page text from PDF using pdf-parse
     */
    static async extractTextFromPdfBuffer(pdfBuffer) {
        try {
            const pageTexts = [];
            
            // Custom page render callback to get per-page content
            const options = {
                pagerender: function (pageData) {
                    return pageData.getTextContent().then(function (textContent) {
                        let lastY = null;
                        let text = "";
                        for (let item of textContent.items) {
                            if (lastY === null || Math.abs(lastY - item.transform[5]) < 5) {
                                text += item.str + " ";
                            } else {
                                text += "\n" + item.str + " ";
                            }
                            lastY = item.transform[5];
                        }
                        pageTexts.push(text);
                        return text;
                    });
                }
            };

            const parsed = await pdfParse(pdfBuffer, options);

            return {
                numPages: parsed.numpages,
                fullText: parsed.text,
                pageTexts: pageTexts.length > 0 ? pageTexts : [parsed.text]
            };
        } catch (err) {
            console.error("[QuestionExtractionService] PDF Parse Error:", err.message);
            throw new Error(`PDF parsing failed: ${err.message}`);
        }
    }

    /**
     * Parse raw text into structured question objects with enhanced boundary matching, option parsing & diagram detection
     */
    static parseQuestionsFromText(extractedData, defaultSubject = "General") {
        const { fullText, pageTexts } = extractedData;
        
        // Quality check for scanned / image-only PDFs
        if (!fullText || fullText.trim().length < 50) {
            return {
                status: "scanned_pdf",
                reason: "PDF contains little to no extractable text (likely scanned or image-only).",
                questions: []
            };
        }

        const questions = [];
        const sourceTexts = pageTexts && pageTexts.length > 0 ? pageTexts : [fullText];

        sourceTexts.forEach((pageText, pageIndex) => {
            const pageNum = pageIndex + 1;
            
            // Look for question blocks: Q1., Q1, Q.1, Q. 1, Q13., 13., 13), Question 13, Question No. 13
            const questionBlocks = pageText.split(/(?=(?:^|\n|\s+)(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*\d{1,3}|\b\d{1,3}\s*[\.\)]))/gi);

            for (const block of questionBlocks) {
                const trimmedBlock = block.trim();
                if (!trimmedBlock) continue;

                // Match question number
                const match = /^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*(\d{1,3})|\b(\d{1,3})\s*[\.\)])/i.exec(trimmedBlock);
                if (!match) continue;

                const qNum = parseInt(match[1] || match[2], 10);
                if (isNaN(qNum) || qNum <= 0 || qNum > 300) continue;

                // Remove question header prefix from question body
                let body = trimmedBlock.replace(/^(?:Q(?:uestion|\.)?\s*(?:No\.?)?\s*\d+|\b\d+\s*[\.\)])[\s:\-]*/i, "").trim();
                if (body.length < 5) continue; // Skip noisy tiny fragments

                // Ignore false numbers (e.g. "2 kg", "2025 year", "9.8 m/s^2", "100 ohms")
                if (/^(?:kg|g|m|cm|mm|m\/s|km\/h|ohms?|v|volts?|hz|j|joules?|w|watts?|days?|years?|months?|chapters?|topics?)\b/i.test(body)) {
                    continue;
                }

                // Check Diagram / Figure Reference
                const hasDiagram = /\b(?:figure|diagram|shown in figure|as shown below|circuit diagram|refer to figure|graph|given figure)\b/i.test(body);

                // Parse Options: (A), (B), (C), (D) or (1), (2), (3), (4) or A., B., C., D. or 1., 2., 3., 4.
                const options = [];
                let questionText = body;
                
                const optionSplitRegex = /(?:\n|\s+)(?:\(([A-D1-4])\)|([A-D1-4])[\.\)])\s+/g;
                const matches = [...body.matchAll(optionSplitRegex)];

                if (matches.length >= 2) {
                    const firstOptionIdx = matches[0].index;
                    questionText = body.substring(0, firstOptionIdx).trim();
                    
                    for (let i = 0; i < matches.length; i++) {
                        const start = matches[i].index + matches[i][0].length;
                        const end = (i + 1 < matches.length) ? matches[i + 1].index : body.length;
                        const optText = body.substring(start, end).trim();
                        if (optText) {
                            const optLabel = matches[i][1] || matches[i][2];
                            options.push(`(${optLabel}) ${optText}`);
                        }
                    }
                }

                // Determine Question Type
                let questionType = "mcq";
                if (options.length === 0) {
                    if (/numerical|integer|find the value|calculate|enter the answer/i.test(questionText)) {
                        questionType = "numerical";
                    } else {
                        questionType = "subjective";
                    }
                } else if (options.length === 5) {
                    questionType = "mcq_5_option";
                }

                // Avoid duplicate question numbers in same paper extraction run
                if (!questions.some(q => q.questionNumber === qNum)) {
                    questions.push({
                        questionNumber: qNum,
                        questionText: questionText,
                        options: options,
                        subject: SubjectNormalizationService.normalizeSubject(defaultSubject).subjectName,
                        subjectId: SubjectNormalizationService.normalizeSubject(defaultSubject).subjectId,
                        subjectName: SubjectNormalizationService.normalizeSubject(defaultSubject).subjectName,
                        topic: "",
                        questionType: questionType,
                        pageNumber: pageNum,
                        hasDiagram: hasDiagram,
                        extractionStatus: "success",
                        createdAt: new Date().toISOString()
                    });
                }
            }
        });

        if (questions.length === 0) {
            return {
                status: "failed",
                reason: "Could not structure individual questions from extracted PDF text.",
                questions: []
            };
        }

        // Sort by question number
        questions.sort((a, b) => a.questionNumber - b.questionNumber);

        return {
            status: "success",
            totalExtracted: questions.length,
            questions: questions
        };
    }

    /**
     * Write extracted question documents into Firestore subcollection using Firestore REST API
     * Target path: exams/{examId}/years/{yearId}/papers/{paperId}/questions/{questionNumber}
     */
    static async writeQuestionsToFirestore(examId, yearId, paperId, questions, options = {}) {
        if (!examId || !yearId || !paperId || !Array.isArray(questions) || questions.length === 0) {
            return { success: false, writtenCount: 0, error: "Missing required parameters or empty questions list." };
        }

        const projectId = getActiveProjectId(options?.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);

        console.log(`[QuestionExtractionService] Writing ${questions.length} questions to Firestore under exams/${examId}/years/${yearId}/papers/${paperId}/questions/... (projectId: ${projectId})`);

        let writtenCount = 0;
        const errors = [];

        for (const q of questions) {
            const docId = String(q.questionNumber); // Deterministic document ID
            
            // Build Firestore REST Document payload
            const firestorePayload = {
                fields: {
                    questionNumber: { integerValue: String(q.questionNumber) },
                    questionText: { stringValue: q.questionText || "" },
                    options: {
                        arrayValue: {
                            values: (q.options || []).map(opt => ({ stringValue: String(opt) }))
                        }
                    },
                    questionType: { stringValue: q.questionType || "mcq" },
                    subject: { stringValue: q.subject || "" },
                    topic: { stringValue: q.topic || "" },
                    pageNumber: { integerValue: String(q.pageNumber || 1) },
                    hasDiagram: { booleanValue: Boolean(q.hasDiagram) },
                    extractionStatus: { stringValue: q.extractionStatus || "success" },
                    createdAt: { stringValue: q.createdAt || new Date().toISOString() }
                }
            };

            try {
                const authHeaders = (await getFirestoreServerAuthHeaders(projectId)) || {};
                // Use PATCH for deterministic UPSERT on document ID
                const setUrl = `${baseUrl}/exams/${encodeURIComponent(examId)}/years/${encodeURIComponent(yearId)}/papers/${encodeURIComponent(paperId)}/questions/${docId}`;
                
                const response = await fetch(setUrl, {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json",
                        ...authHeaders
                    },
                    body: JSON.stringify(firestorePayload)
                });

                if (response.ok) {
                    writtenCount++;
                } else {
                    const errBody = await response.text();
                    console.warn(`[QuestionExtractionService] Failed to write Q${docId}:`, errBody);
                    errors.push(`Q${docId}: ${errBody}`);
                }
            } catch (err) {
                console.error(`[QuestionExtractionService] Network error writing Q${docId}:`, err.message);
                errors.push(`Q${docId}: ${err.message}`);
            }
        }

        // Update paper extraction status in paper document
        await this.updatePaperExtractionMetadata(examId, yearId, paperId, {
            status: writtenCount > 0 ? "success" : "failed",
            count: writtenCount,
            error: errors.length > 0 ? errors.join("; ") : null
        }, { projectId });

        return {
            success: writtenCount > 0,
            writtenCount: writtenCount,
            total: questions.length,
            errors: errors
        };
    }

    /**
     * Update paper document with questionExtractionStatus metadata
     */
    static async updatePaperExtractionMetadata(examId, yearId, paperId, { status, count, error }, options = {}) {
        try {
            const projectId = getActiveProjectId(options?.projectId);
            const baseUrl = getFirestoreBaseUrl(projectId);
            const setUrl = `${baseUrl}/exams/${encodeURIComponent(examId)}/years/${encodeURIComponent(yearId)}/papers/${encodeURIComponent(paperId)}?updateMask.fieldPaths=questionExtractionStatus&updateMask.fieldPaths=questionCount&updateMask.fieldPaths=questionExtractionUpdatedAt${error ? '&updateMask.fieldPaths=questionExtractionError' : ''}`;

            const fields = {
                questionExtractionStatus: { stringValue: status },
                questionCount: { integerValue: String(count || 0) },
                questionExtractionUpdatedAt: { stringValue: new Date().toISOString() }
            };
            if (error) {
                fields.questionExtractionError = { stringValue: String(error) };
            }

            const authHeaders = (await getFirestoreServerAuthHeaders(projectId)) || {};
            await fetch(setUrl, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    ...authHeaders
                },
                body: JSON.stringify({ fields })
            });
        } catch (e) {
            console.warn("[QuestionExtractionService] Could not update paper extraction metadata:", e.message);
        }
    }

    /**
     * Main entry point to extract questions from a paper PDF and save them to Firestore
     */
    static async processPaperExtraction({ examId, yearId, paperId, pdfUrl, subject = "General", projectId = null }) {
        console.log(`[QuestionExtractionService] Starting extraction pipeline for paper: [${paperId}] (${pdfUrl})`);
        
        try {
            const pdfBuffer = await this.fetchPdfBuffer(pdfUrl);
            const extractedTextData = await this.extractTextFromPdfBuffer(pdfBuffer);
            const parseResult = this.parseQuestionsFromText(extractedTextData, subject);

            if (parseResult.status !== "success" || parseResult.questions.length === 0) {
                console.warn(`[QuestionExtractionService] Extraction resulted in status "${parseResult.status}": ${parseResult.reason}`);
                await this.updatePaperExtractionMetadata(examId, yearId, paperId, {
                    status: parseResult.status,
                    count: 0,
                    error: parseResult.reason
                }, { projectId });

                return {
                    success: false,
                    status: parseResult.status,
                    reason: parseResult.reason,
                    writtenCount: 0
                };
            }

            const writeResult = await this.writeQuestionsToFirestore(examId, yearId, paperId, parseResult.questions, { projectId });
            
            return {
                success: writeResult.success,
                status: "success",
                extractedCount: parseResult.questions.length,
                writtenCount: writeResult.writtenCount,
                errors: writeResult.errors
            };

        } catch (err) {
            console.error(`[QuestionExtractionService] Pipeline exception for paper ${paperId}:`, err.message);
            await this.updatePaperExtractionMetadata(examId, yearId, paperId, {
                status: "failed",
                count: 0,
                error: err.message
            }, { projectId });

            return {
                success: false,
                status: "failed",
                reason: err.message,
                writtenCount: 0
            };
        }
    }
}
