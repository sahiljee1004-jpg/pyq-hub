import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getFirestoreBaseUrl, validateProjectIdFormat } from "./firebaseTokenService.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE_PATH = path.join(__dirname, "../data/questionsData.json");

function getActiveProjectId(explicitProjectId = null) {
    const raw = explicitProjectId || process.env.FIREBASE_PROJECT_ID;
    if (!raw || typeof raw !== "string" || !raw.trim()) {
        throw new Error("[PaperSearchService] FIREBASE_PROJECT_ID is not configured and no explicit projectId was provided. Rejecting operation to prevent ambient production fallback.");
    }
    return validateProjectIdFormat(raw.trim(), "projectId");
}

// In-memory cache for Firestore exam hierarchy to speed up paper lookups
let examsCache = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

/**
 * Service to parse natural language paper queries and match against Firestore database.
 */
export class PaperSearchService {

    /**
     * Read local questions fallback data from server/data/questionsData.json
     * 
     * PRODUCTION BEHAVIOR:
     * Firestore is the single authoritative source of truth in production.
     * The local JSON dataset is GATED and ONLY used if QUESTION_DATA_FALLBACK_ENABLED="true" (for dev/testing).
     */
    static isFallbackEnabled() {
        return process.env.QUESTION_DATA_FALLBACK_ENABLED === "true";
    }

    static getLocalQuestionsData() {
        if (!this.isFallbackEnabled()) {
            return {};
        }
        try {
            if (fs.existsSync(DATA_FILE_PATH)) {
                const content = fs.readFileSync(DATA_FILE_PATH, "utf-8");
                return JSON.parse(content);
            }
        } catch (e) {
            console.warn("[PaperSearchService] Error reading local questions data:", e.message);
        }
        return {};
    }

    /**
     * Save question to local fallback file (development/testing helper)
     */
    static saveToLocalQuestionsData(examId, yearId, paperId, questionObj) {
        try {
            const data = this.getLocalQuestionsData();
            if (!data[examId]) data[examId] = {};
            if (!data[examId][yearId]) data[examId][yearId] = {};
            if (!data[examId][yearId][paperId]) data[examId][yearId][paperId] = {};
            data[examId][yearId][paperId][String(questionObj.questionNumber)] = questionObj;

            const dir = path.dirname(DATA_FILE_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
        } catch (e) {
            console.warn("[PaperSearchService] Error writing to local questions data:", e.message);
        }
    }

    /**
     * Parse natural language query to extract exam, year, session, shift, and question number
     */
    static parsePaperQuery(text) {
        if (!text || typeof text !== "string") return null;

        const cleanText = text.trim();

        // 1. Extract Question Number cleanly
        // Disambiguate against false positive counts like "13 chapters", "15 days", "2025 year"
        if (/\b\d{1,3}\s+(?:chapters?|days?|weeks?|months?|years?|topics?|books?|hours?|marks?)\b/i.test(cleanText)) {
            // Text is talking about duration/quantity, not a paper question number unless explicit Q prefix exists
        }

        const qMatch = /\b(?:q(?:uestion|\.)?\s*|q#?\s*|#\s*|q_?|qn_?)(\d{1,3})\b/i.exec(cleanText) ||
                       /\bquestion\s+(?:no\.?|number\s+)?(\d{1,3})\b/i.exec(cleanText) ||
                       /\b(\d{1,3})(?:st|nd|rd|th)?\s+question\b/i.exec(cleanText);
        
        const questionNumber = qMatch ? parseInt(qMatch[1], 10) : null;

        // 2. Extract Year (e.g. 1990-2099)
        const yearMatch = /\b((?:19|20)\d{2})\b/.exec(cleanText);
        const year = yearMatch ? yearMatch[1] : null;

        // 3. Extract Shift (Shift 1, Shift 2, Shift-1, Shift-2, Morning, Evening, S1, S2)
        let shift = null;
        if (/\b(?:shift\s*[-:_]?\s*1|s1|morning)\b/i.test(cleanText)) {
            shift = "Shift 1";
        } else if (/\b(?:shift\s*[-:_]?\s*2|s2|evening)\b/i.test(cleanText)) {
            shift = "Shift 2";
        } else if (/\b(?:shift\s*[-:_]?\s*3|s3)\b/i.test(cleanText)) {
            shift = "Shift 3";
        }

        // 4. Extract Session (Session 1, Session 2, Jan, April, etc.)
        let session = null;
        if (/\b(?:session\s*[-:_]?\s*1|jan(?:uary)?\s*session)\b/i.test(cleanText)) {
            session = "Session 1";
        } else if (/\b(?:session\s*[-:_]?\s*2|apr(?:il)?\s*session)\b/i.test(cleanText)) {
            session = "Session 2";
        }

        // 5. Extract Exam Name
        let examQuery = null;
        if (/\b(?:jee\s*main[s]?|jee-main)\b/i.test(cleanText)) {
            examQuery = "jee-main";
        } else if (/\b(?:jee\s*advanced)\b/i.test(cleanText)) {
            examQuery = "JEE Advanced";
        } else if (/\b(?:gate\s*(?:cs|cse)?)\b/i.test(cleanText)) {
            examQuery = "Gate";
        } else if (/\b(?:neet)\b/i.test(cleanText)) {
            examQuery = "NEET";
        } else if (/\b(?:wbjee)\b/i.test(cleanText)) {
            examQuery = "WBJEE";
        } else if (/\b(?:ssc\s*cgl)\b/i.test(cleanText)) {
            examQuery = "ssc cgl";
        } else if (/\b(?:ssc\s*chsl)\b/i.test(cleanText)) {
            examQuery = "SSC CHSL";
        } else if (/\b(?:upsc)\b/i.test(cleanText)) {
            examQuery = "upsc";
        } else if (/\b(?:bpsc)\b/i.test(cleanText)) {
            examQuery = "BPSC";
        } else if (/\b(?:comedk)\b/i.test(cleanText)) {
            examQuery = "comedk";
        } else if (/\b(?:nda)\b/i.test(cleanText)) {
            examQuery = "NDA";
        } else {
            // Candidate exam extraction from "from <ExamName> [Year]" or "in <ExamName> [Year]"
            const candidateMatch = /(?:from|in|of)\s+([A-Za-z0-9_\s-]+?)(?:\s+shift|\s+session|\s+q\d+|$)/i.exec(cleanText);
            if (candidateMatch && candidateMatch[1].trim()) {
                const rawExamCandidate = candidateMatch[1].replace(/\b\d{4}\b/g, "").trim();
                if (rawExamCandidate) {
                    examQuery = rawExamCandidate;
                }
            }
        }

        return {
            rawText: cleanText,
            questionNumber,
            year,
            shift,
            session,
            examQuery
        };
    }

    /**
     * Helper to fetch exams collection from Firestore
     */
    static async fetchExamsFromFirestore(options = {}) {
        const now = Date.now();
        if (!options?.forceRefresh && examsCache && (now - lastCacheTime < CACHE_TTL_MS)) {
            return examsCache;
        }

        const projectId = getActiveProjectId(options?.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);

        try {
            const url = `${baseUrl}/exams`;
            const res = await fetch(url);
            if (!res.ok) return [];

            const data = await res.json();
            const docs = data.documents || [];

            const exams = docs.map(doc => {
                const parts = doc.name.split("/");
                const id = parts[parts.length - 1].trim();
                const fields = doc.fields || {};
                const name = fields.name ? fields.name.stringValue : id;
                return { id, name, fullPath: doc.name };
            });

            examsCache = exams;
            lastCacheTime = now;
            return exams;
        } catch (err) {
            console.error("[PaperSearchService] Error fetching exams from Firestore:", err.message);
            return [];
        }
    }

    /**
     * Map natural language exam query to Firestore exam document ID
     */
    static async resolveExamId(examQuery, options = {}) {
        if (!examQuery) return null;
        const exams = await this.fetchExamsFromFirestore(options);
        const normQuery = examQuery.toLowerCase().replace(/[-_\s]+/g, "");

        for (const e of exams) {
            const normId = e.id.toLowerCase().replace(/[-_\s]+/g, "");
            const normName = e.name.toLowerCase().replace(/[-_\s]+/g, "");
            if (normId === normQuery || normName === normQuery) {
                return e.id;
            }
        }
        
        // Partial match
        for (const e of exams) {
            const normId = e.id.toLowerCase().replace(/[-_\s]+/g, "");
            const normName = e.name.toLowerCase().replace(/[-_\s]+/g, "");
            if (normId.includes(normQuery) || normQuery.includes(normId) || normName.includes(normQuery)) {
                return e.id;
            }
        }

        return examQuery;
    }

    /**
     * Search paper in Firestore using extracted metadata
     */
    static async findPaperAndQuestion(metadata, options = {}) {
        const { examQuery, year, shift, session, questionNumber } = metadata;

        if (!questionNumber) {
            return {
                type: "MISSING_QUESTION_NUMBER",
                message: "Please specify a question number (e.g., 'question 13')."
            };
        }

        if (!examQuery) {
            return {
                type: "MISSING_EXAM",
                message: "Which exam paper are you looking for? (e.g., JEE Main, GATE, NEET)."
            };
        }

        const projectId = getActiveProjectId(options?.projectId || metadata?.projectId);
        const baseUrl = getFirestoreBaseUrl(projectId);

        const examId = await this.resolveExamId(examQuery, { projectId });
        if (!examId) {
            return {
                type: "PAPER_NOT_FOUND",
                message: "I couldn't find that paper in VidyarthiAstra."
            };
        }

        if (!year) {
            return {
                type: "MISSING_YEAR",
                message: `Which year do you mean for ${examId.toUpperCase()}?`
            };
        }

        // Fetch papers for target exam and year from Firestore
        const papersUrl = `${baseUrl}/exams/${encodeURIComponent(examId)}/years/${encodeURIComponent(year)}/papers`;
        let papersRes;
        let paperDocs = [];

        try {
            papersRes = await fetch(papersUrl);
            if (papersRes.ok) {
                const papersData = await papersRes.json();
                paperDocs = papersData.documents || [];
            }
        } catch (e) {}

        // Fallback to local questions dataset ONLY IF EXPLICITLY ENABLED
        const localData = this.isFallbackEnabled() ? this.getLocalQuestionsData() : {};
        const localExam = localData[examId] || localData[examQuery];
        const localYear = localExam ? localExam[year] : null;

        if (paperDocs.length === 0 && !localYear) {
            return {
                type: "PAPER_NOT_FOUND",
                message: "I couldn't find that paper in VidyarthiAstra."
            };
        }

        // Parse paper documents from Firestore
        let parsedPapers = paperDocs.map(doc => {
            const parts = doc.name.split("/");
            const paperId = parts[parts.length - 1];
            const fields = doc.fields || {};
            return {
                paperId,
                title: fields.title ? fields.title.stringValue : paperId,
                shift: fields.shift ? fields.shift.stringValue : "",
                date: fields.date ? fields.date.stringValue : "",
                pdfUrl: fields.pdfUrl ? fields.pdfUrl.stringValue : ""
            };
        });

        // Merge local paper IDs if fallback is enabled
        if (localYear) {
            Object.keys(localYear).forEach(pId => {
                if (!parsedPapers.some(p => p.paperId === pId)) {
                    parsedPapers.push({
                        paperId: pId,
                        title: pId,
                        shift: pId.includes("Shift 2") ? "Shift 2" : (pId.includes("Shift 1") ? "Shift 1" : ""),
                        date: "",
                        pdfUrl: ""
                    });
                }
            });
        }

        if (parsedPapers.length === 0) {
            return {
                type: "PAPER_NOT_FOUND",
                message: "I couldn't find that paper in VidyarthiAstra."
            };
        }

        // Filter papers by shift if provided
        let matchedPapers = parsedPapers;

        if (shift) {
            const normShift = shift.toLowerCase().replace(/[\s-_]+/g, "");
            matchedPapers = parsedPapers.filter(p => {
                const pShift = (p.shift || p.title || p.paperId).toLowerCase().replace(/[\s-_]+/g, "");
                return pShift.includes(normShift);
            });
        }

        // If multiple candidate papers remain, match rawText against paper title/ID keywords (e.g. 'Mathematics', 'GAT')
        if (matchedPapers.length > 1) {
            const rawTextNorm = (metadata.rawText || "").toLowerCase();
            const titleMatched = matchedPapers.filter(p => {
                const titleNorm = (p.title || "").toLowerCase();
                const paperIdNorm = (p.paperId || "").toLowerCase();
                const keywords = titleNorm.split(/[\s-_]+/)
                    .concat(paperIdNorm.split(/[\s-_]+/))
                    .filter(k => k.length > 2 && k !== examId.toLowerCase());
                return keywords.some(k => rawTextNorm.includes(k));
            });
            if (titleMatched.length > 0) {
                matchedPapers = titleMatched;
            }
        }

        // Check Ambiguity: Multiple matching papers and no shift or title keyword match
        if (matchedPapers.length > 1 && !shift) {
            const shiftsAvailable = parsedPapers
                .map(p => p.shift || p.title || p.paperId)
                .filter(Boolean);
            
            const uniqueShifts = [...new Set(shiftsAvailable)];

            return {
                type: "AMBIGUOUS_PAPER",
                requiresClarification: true,
                message: `Which shift do you mean for ${examId.toUpperCase()} ${year}? ${uniqueShifts.length > 0 ? `(Available: ${uniqueShifts.join(", ")})` : ""}`
            };
        }

        if (matchedPapers.length === 0) {
            return {
                type: "PAPER_NOT_FOUND",
                message: "I couldn't find that paper in VidyarthiAstra."
            };
        }

        const targetPaper = matchedPapers[0];

        // 1. Try Firestore Question Document Lookup (Primary Production Source)
        const questionUrl = `${baseUrl}/exams/${encodeURIComponent(examId)}/years/${encodeURIComponent(year)}/papers/${encodeURIComponent(targetPaper.paperId)}/questions/${questionNumber}`;
        
        try {
            const qRes = await fetch(questionUrl);
            if (qRes.ok) {
                const qDoc = await qRes.json();
                const fields = qDoc.fields || {};

                const optionsValues = fields.options && fields.options.arrayValue && fields.options.arrayValue.values
                    ? fields.options.arrayValue.values.map(v => v.stringValue || "")
                    : [];

                const questionObj = {
                    questionNumber: fields.questionNumber ? parseInt(fields.questionNumber.integerValue || fields.questionNumber.stringValue, 10) : questionNumber,
                    questionText: fields.questionText ? fields.questionText.stringValue : "",
                    options: optionsValues,
                    subject: fields.subject ? fields.subject.stringValue : "General",
                    questionType: fields.questionType ? fields.questionType.stringValue : "mcq",
                    pageNumber: fields.pageNumber ? parseInt(fields.pageNumber.integerValue || "1", 10) : 1,
                    hasDiagram: fields.hasDiagram ? fields.hasDiagram.booleanValue === true : false
                };

                return {
                    type: "SUCCESS",
                    paperFound: true,
                    questionFound: true,
                    paper: {
                        examId,
                        yearId: year,
                        paperId: targetPaper.paperId,
                        title: targetPaper.title,
                        pdfUrl: targetPaper.pdfUrl
                    },
                    question: questionObj
                };
            }
        } catch (qErr) {}

        // 2. Try Gated Local Questions Data Fallback (Dev/Testing Only)
        if (this.isFallbackEnabled() && localYear && localYear[targetPaper.paperId] && localYear[targetPaper.paperId][String(questionNumber)]) {
            const localQ = localYear[targetPaper.paperId][String(questionNumber)];
            return {
                type: "SUCCESS",
                paperFound: true,
                questionFound: true,
                paper: {
                    examId,
                    yearId: year,
                    paperId: targetPaper.paperId,
                    title: targetPaper.title,
                    pdfUrl: targetPaper.pdfUrl
                },
                question: localQ
            };
        }

        // 3. Question not extracted yet
        return {
            type: "QUESTION_NOT_EXTRACTED",
            paperFound: true,
            questionFound: false,
            paper: {
                examId,
                yearId: year,
                paperId: targetPaper.paperId,
                title: targetPaper.title,
                pdfUrl: targetPaper.pdfUrl
            },
            questionNumber,
            message: `I found the paper (${targetPaper.title}), but question ${questionNumber} isn't available in the extracted question data yet.`
        };
    }
}
