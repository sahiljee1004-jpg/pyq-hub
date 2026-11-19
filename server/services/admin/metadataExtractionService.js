import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

/**
 * Service to extract and reconcile metadata from Question Paper, Answer Key, and Exam Pattern documents
 */
export class MetadataExtractionService {

    static async parseWithTimeout(promise, timeoutMs = 25000, errorMsg = "PDF parsing operation timed out") {
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(errorMsg)), timeoutMs);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
    }

    /**
     * Parse text from PDF buffer
     */
    static async extractText(pdfBuffer) {
        if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
            throw new Error("Invalid or empty PDF buffer supplied to metadata extractor");
        }
        try {
            const cleanBuffer = new Uint8Array(pdfBuffer);
            const options = {
                version: "v2.0.550",
                pagerender: function (pageData) {
                    return pageData.getTextContent().then(function (textContent) {
                        let text = "";
                        let lastY = null;
                        for (const item of textContent.items) {
                            if (lastY === null || Math.abs(lastY - item.transform[5]) < 4) {
                                text += item.str + " ";
                            } else {
                                text += "\n" + item.str + " ";
                            }
                            lastY = item.transform[5];
                        }
                        return text;
                    });
                }
            };
            const data = await this.parseWithTimeout(pdfParse(cleanBuffer, options));
            if (data.numpages > 100) {
                throw new Error(`PDF exceeds maximum supported page limit of 100 pages (detected ${data.numpages})`);
            }
            return {
                text: data.text || "",
                numPages: data.numpages || 1
            };
        } catch (err) {
            console.warn("[MetadataExtractionService] PDF text extraction warning:", err.message);
            if (err.message.includes("exceeds maximum supported page limit") || err.message.includes("timed out")) {
                throw err;
            }
            return {
                text: "",
                numPages: 1
            };
        }
    }

    /**
     * Extract metadata from all 3 source documents
     */
    static async extractAllMetadata({ questionPaperBuffer, answerKeyBuffer, examPatternBuffer, userHints = {} }) {
        const qpParsed = await this.extractText(questionPaperBuffer);
        const akParsed = await this.extractText(answerKeyBuffer);
        const epParsed = await this.extractText(examPatternBuffer);

        const extracted = {
            examId: { value: userHints.examId || "neet-ug", provenance: "user_hint", confidence: 0.95 },
            examName: { value: "NEET UG", provenance: "default", confidence: 0.9 },
            year: { value: Number(userHints.year) || 2024, provenance: "user_hint", confidence: 0.95 },
            paperType: { value: userHints.paperType || "pyq", provenance: "user_hint", confidence: 0.95 },
            language: { value: userHints.language || "English", provenance: "user_hint", confidence: 0.95 },
            paperCode: userHints.paperCode
                ? { value: String(userHints.paperCode).toUpperCase(), provenance: "user_hint", confidence: 0.95 }
                : { value: null, provenance: "unresolved", confidence: 0 },
            answerKeyVersion: { value: null, provenance: "unresolved", confidence: 0 },
            durationSeconds: { value: null, provenance: "unresolved", confidence: 0 },
            totalQuestions: { value: null, provenance: "unresolved", confidence: 0 },
            maximumMarks: { value: null, provenance: "unresolved", confidence: 0 },
            markingScheme: {
                correct: { value: null, provenance: "unresolved" },
                incorrect: { value: null, provenance: "unresolved" }
            },
            bookletIdentity: {
                paperSeries: null,
                paperCode: userHints.paperCode ? String(userHints.paperCode).toUpperCase() : null,
                answerKeySeries: null,
                answerKeyCode: null,
                status: "missing_identity",
                mismatchReason: null
            },
            sections: [],
            warnings: []
        };

        // 1. Analyze Question Paper Header / Text
        this.extractFromQuestionPaperText(qpParsed.text, extracted);

        // 2. Analyze Answer Key Header / Text
        this.extractFromAnswerKeyText(akParsed.text, extracted);

        // 3. Analyze Exam Pattern Document Text
        this.extractFromExamPatternText(epParsed.text, extracted);

        // 4. Fallbacks / Standard validation for NEET UG 2024 if authoritative text confirmed
        this.reconcileDefaults(extracted, userHints);

        return extracted;
    }

    /**
     * Inspect Question Paper text
     */
    static extractFromQuestionPaperText(text, extracted) {
        if (!text) return;

        // Check for NEET UG in QP
        if (/NEET\s*\(UG\)|NATIONAL\s+ELIGIBILITY\s+CUM\s+ENTRANCE\s+TEST/i.test(text)) {
            extracted.examName = {
                value: "National Eligibility Cum Entrance Test (NEET UG)",
                provenance: "question_paper_header",
                confidence: 0.98
            };
            if (!extracted.examId.value || extracted.examId.provenance === "default") {
                extracted.examId = { value: "neet-ug", provenance: "question_paper_header", confidence: 0.98 };
            }
        } else if (/JEE\s*\(?MAIN\)?|JOINT\s+ENTRANCE\s+EXAMINATION/i.test(text)) {
            extracted.examName = {
                value: "Joint Entrance Examination (JEE Main)",
                provenance: "question_paper_header",
                confidence: 0.98
            };
            extracted.examId = { value: "jee-main", provenance: "question_paper_header", confidence: 0.98 };
        } else if (/UPSC|UNION\s+PUBLIC\s+SERVICE\s+COMMISSION|CIVIL\s+SERVICES.*PRELIM/i.test(text)) {
            extracted.examName = {
                value: "Union Public Service Commission (UPSC Civil Services Preliminary)",
                provenance: "question_paper_header",
                confidence: 0.98
            };
            extracted.examId = { value: "upsc-prelims", provenance: "question_paper_header", confidence: 0.98 };
        }

        // Check for Year in QP
        const yearMatch = text.match(/\b(202[0-9])\b/);
        if (yearMatch) {
            extracted.year = {
                value: parseInt(yearMatch[1], 10),
                provenance: "question_paper_header",
                confidence: 0.95
            };
        }

        // Check for Booklet / Paper Code / Shift (e.g. Shift 1, Q1, Q2, R1, R2, S1, S2, T1, T2)
        const shiftMatch = text.match(/\bShift\s*([12])\b/i);
        const setMatch = text.match(/\b(?:Set|Booklet\s+Series|Series)\s*[:\-]?\s*([A-D])\b/i);
        const codeMatch = text.match(/(?:Booklet\s+Code|Paper\s+Code|Test\s+Booklet\s+Code)\s*[:\-]?\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)/i)
            || text.match(/\bCode\s*[:\-]\s*([Q-T][1-6]|[A-Z][0-9]?|[0-9]{2,4})\b/i)
            || text.match(/\b([Q-T][1-6])\b/);

        if (setMatch) {
            extracted.bookletIdentity.paperSeries = setMatch[1].toUpperCase();
        }
        if (codeMatch) {
            extracted.bookletIdentity.paperCode = codeMatch[1].toUpperCase();
        }

        if (shiftMatch) {
            extracted.paperCode = {
                value: `Shift${shiftMatch[1]}`,
                provenance: "question_paper_header",
                confidence: 0.95
            };
        } else if (setMatch) {
            extracted.paperCode = {
                value: setMatch[1].toUpperCase(),
                provenance: "question_paper_header",
                confidence: 0.95
            };
        } else if (codeMatch) {
            extracted.paperCode = {
                value: codeMatch[1].toUpperCase(),
                provenance: "question_paper_header",
                confidence: 0.92
            };
        }

        // Check Duration (e.g. "3 Hours 20 Minutes" or "200 Minutes" or "3 hrs 20 mins")
        if (/3\s*Hours?\s*20\s*Minutes?|200\s*Minutes?/i.test(text)) {
            extracted.durationSeconds = {
                value: 200 * 60, // 12000 seconds
                provenance: "question_paper_instructions",
                confidence: 0.95
            };
        } else if (/3\s*Hours?/i.test(text)) {
            extracted.durationSeconds = {
                value: 180 * 60,
                provenance: "question_paper_instructions",
                confidence: 0.9
            };
        } else if (/2\s*Hours?|120\s*Minutes?/i.test(text)) {
            extracted.durationSeconds = {
                value: 120 * 60, // 7200 seconds
                provenance: "question_paper_instructions",
                confidence: 0.95
            };
        }

        // Check Marking Scheme in Instructions (+4 and -1)
        const marksMatch = text.match(/(?:four|4)\s*marks?\s*(?:for\s+each\s+correct)?.*?minus\s*(?:one|1)|(?:\+4|\b4\b)\s*marks?.*?(?:-1|\b1\b)\s*mark/is);
        if (marksMatch) {
            extracted.markingScheme.correct = { value: 4, provenance: "question_paper_instructions" };
            extracted.markingScheme.incorrect = { value: -1, provenance: "question_paper_instructions" };
        }
    }

    /**
     * Inspect Answer Key text
     */
    static extractFromAnswerKeyText(text, extracted) {
        if (!text) return;

        // Check for Answer Key Status (Final Answer Key, Provisional, Revised)
        if (/FINAL\s+ANSWER\s+KEY/i.test(text)) {
            extracted.answerKeyVersion = {
                value: "Official Final Answer Key",
                provenance: "answer_key_header",
                confidence: 0.98
            };
        } else if (/PROVISIONAL\s+ANSWER\s+KEY/i.test(text)) {
            extracted.answerKeyVersion = {
                value: "Provisional Answer Key",
                provenance: "answer_key_header",
                confidence: 0.95
            };
        } else if (/REVISED\s+ANSWER\s+KEY/i.test(text)) {
            extracted.answerKeyVersion = {
                value: "Revised Final Answer Key",
                provenance: "answer_key_header",
                confidence: 0.98
            };
        }

        // Check if Answer Key confirms paper code or series
        const akSeriesMatch = text.match(/(?:Booklet\s+Series|Test\s+Booklet\s+Series|Series)\s*[:\-]?\s*(?:SET\s*)?([A-D])\b/i);
        const akCodeMatch = text.match(/(?:Test\s+Booklet\s+Code|Booklet\s+Code|Paper\s+Code)\s*[:\-]?\s*([A-Za-z0-9\-]+?)(?=\s*(?:Total|Subject|Maximum|Negative|Page|\r|\n|$))/i)
            || text.match(/\bCode\s*[:\-\s]\s*([A-Za-z0-9\-]+)\b/i);
        const detectedCode = akSeriesMatch ? akSeriesMatch[1].toUpperCase() : (akCodeMatch ? akCodeMatch[1].toUpperCase() : null);

        if (!extracted.bookletIdentity) {
            extracted.bookletIdentity = {
                paperSeries: null,
                paperCode: null,
                answerKeySeries: null,
                answerKeyCode: null,
                status: "missing_identity",
                mismatchReason: null
            };
        }

        if (akSeriesMatch) extracted.bookletIdentity.answerKeySeries = akSeriesMatch[1].toUpperCase();
        if (akCodeMatch) extracted.bookletIdentity.answerKeyCode = akCodeMatch[1].toUpperCase();

        const qpSeries = extracted.bookletIdentity.paperSeries || extracted.paperCode?.value;
        const qpCode = extracted.bookletIdentity.paperCode || extracted.paperCode?.value;
        const akSeries = extracted.bookletIdentity.answerKeySeries;
        const akCode = extracted.bookletIdentity.answerKeyCode;

        // Evaluate mismatch
        const seriesMismatch = Boolean(qpSeries && akSeries && qpSeries !== akSeries);
        const codeMismatch = Boolean(qpCode && akCode && qpCode !== akCode && !qpCode.includes(akCode) && !akCode.includes(qpCode));

        const isCbtExam = extracted.examId?.value === "jee-main" || 
                          extracted.examId?.value === "gate" || 
                          String(extracted.paperCode?.value || "").toLowerCase().startsWith("shift");

        if (isCbtExam) {
            extracted.bookletIdentity.status = "matched";
        } else if (seriesMismatch || codeMismatch) {
            extracted.bookletIdentity.status = "mismatched";
            extracted.bookletIdentity.mismatchReason = seriesMismatch
                ? `Question paper indicates Series ${qpSeries}, but Answer Key indicates Series ${akSeries}`
                : `Question paper indicates Code ${qpCode}, but Answer Key indicates Code ${akCode}`;
            extracted.warnings.push(`Paper code mismatch: ${extracted.bookletIdentity.mismatchReason}`);
        } else if ((!qpSeries && !qpCode) || (!akSeries && !akCode)) {
            extracted.bookletIdentity.status = "missing_identity";
            extracted.bookletIdentity.mismatchReason = "Booklet series or code could not be detected on question paper or answer key";
        } else {
            extracted.bookletIdentity.status = "matched";
        }

        if (detectedCode) {
            if (extracted.paperCode.value && extracted.paperCode.value !== detectedCode) {
                const isSeriesMatch = extracted.paperCode.value.includes(detectedCode) || detectedCode.includes(extracted.paperCode.value);
                if (!isSeriesMatch && !extracted.warnings.some(w => w.includes("Paper code mismatch"))) {
                    extracted.warnings.push(
                        `Paper code mismatch: Question paper indicates ${extracted.paperCode.value}, but Answer Key indicates ${detectedCode}`
                    );
                }
            } else if (!extracted.paperCode.value) {
                extracted.paperCode = {
                    value: detectedCode,
                    provenance: "answer_key_header",
                    confidence: 0.9
                };
            }
        }
    }

    /**
     * Inspect Exam Pattern text
     */
    static extractFromExamPatternText(text, extracted) {
        if (!text) return;

        // Total questions & marks
        const qCountMatch = text.match(/(?:Total\s*(?:No\.?\s*of)?\s*Questions?|Questions?)\s*[:\-]?\s*(\d{1,4})\b/i);
        if (qCountMatch) {
            extracted.totalQuestions = {
                value: parseInt(qCountMatch[1], 10),
                provenance: "exam_pattern_document",
                confidence: 0.96
            };
        }

        const maxMarksMatch = text.match(/(?:Maximum\s*Marks?|Total\s*Marks?)\s*[:\-]?\s*(\d{1,4})\b/i);
        if (maxMarksMatch) {
            extracted.maximumMarks = {
                value: parseInt(maxMarksMatch[1], 10),
                provenance: "exam_pattern_document",
                confidence: 0.96
            };
        }

        const epCodeMatch = text.match(/(?:Test\s+Booklet\s+Code|Booklet\s+Code|Paper\s+Code)\s*[:\-]?\s*([A-Za-z0-9\-]+)/i)
            || text.match(/\bCode\s*[:\-\s]\s*([A-Za-z0-9\-]+)\b/i);
        if (epCodeMatch) {
            const detectedCode = epCodeMatch[1].toUpperCase();
            if (!extracted.paperCode?.value || extracted.paperCode?.provenance === "unresolved") {
                extracted.paperCode = {
                    value: detectedCode,
                    provenance: "exam_pattern_document",
                    confidence: 0.95
                };
            }
            if (!extracted.bookletIdentity.paperCode) {
                extracted.bookletIdentity.paperCode = detectedCode;
            }
        }

        // Extract sections from exam pattern if table format
        const lines = text.split("\n");
        const tableSecs = [];
        for (const line of lines) {
            const tableRowMatch = line.trim().match(/^([A-Za-z\s\(\)\+]+?)\s+(\d{1,3})\s+(?:\d{1,4}\s+)?(\d{1,3})\s*[-–—]\s*(\d{1,3})$/);
            if (tableRowMatch) {
                const rawName = tableRowMatch[1].trim();
                if (!/^(?:Total|Overall|Grand\s*Total|Sum)$/i.test(rawName)) {
                    tableSecs.push({
                        id: rawName.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
                        name: rawName,
                        subject: rawName,
                        questionCount: parseInt(tableRowMatch[2], 10),
                        startQ: parseInt(tableRowMatch[3], 10),
                        endQ: parseInt(tableRowMatch[4], 10)
                    });
                }
            }
        }
        if (tableSecs.length > 0) {
            extracted.sections = tableSecs;
        }
    }

    /**
     * Reconcile known defaults when authoritative indicators align
     */
    static reconcileDefaults(extracted, userHints) {
        // If NEET UG is detected or selected:
        if ((extracted.year.value === 2024 || userHints.examId === "neet-ug") && (/neet/i.test(extracted.examId.value) || /neet/i.test(extracted.examName.value))) {
            if (!extracted.durationSeconds.value) {
                extracted.durationSeconds = {
                    value: 200 * 60, // 200 minutes = 12000s
                    provenance: "nta_neet_ug_2024_official_bulletin",
                    confidence: 0.95
                };
            }
            if (!extracted.totalQuestions.value) {
                extracted.totalQuestions = {
                    value: 200,
                    provenance: "nta_neet_ug_2024_official_bulletin",
                    confidence: 0.98
                };
            }
            if (!extracted.maximumMarks.value) {
                extracted.maximumMarks = {
                    value: 720,
                    provenance: "nta_neet_ug_2024_official_bulletin",
                    confidence: 0.98
                };
            }
            if (!extracted.markingScheme.correct.value) {
                extracted.markingScheme.correct = { value: 4, provenance: "official_bulletin" };
            }
            if (!extracted.markingScheme.incorrect.value) {
                extracted.markingScheme.incorrect = { value: -1, provenance: "official_bulletin" };
            }

            // NEET UG Official Sections - only apply 2024 archetype if sections were not already extracted and totalQuestions is 200
            if (extracted.sections.length === 0 && (!extracted.totalQuestions.value || extracted.totalQuestions.value === 200)) {
                extracted.sections = [
                    { id: "physics_a", name: "Physics - Section A", subject: "Physics", questionCount: 35, requiredCount: 35, startQ: 1, endQ: 35, marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                    { id: "physics_b", name: "Physics - Section B", subject: "Physics", questionCount: 15, requiredCount: 10, startQ: 36, endQ: 50, marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                    { id: "chemistry_a", name: "Chemistry - Section A", subject: "Chemistry", questionCount: 35, requiredCount: 35, startQ: 51, endQ: 85, marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                    { id: "chemistry_b", name: "Chemistry - Section B", subject: "Chemistry", questionCount: 15, requiredCount: 10, startQ: 86, endQ: 100, marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                    { id: "botany_a", name: "Botany - Section A", subject: "Botany", questionCount: 35, requiredCount: 35, startQ: 101, endQ: 135, marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                    { id: "botany_b", name: "Botany - Section B", subject: "Botany", questionCount: 15, requiredCount: 10, startQ: 136, endQ: 150, marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                    { id: "zoology_a", name: "Zoology - Section A", subject: "Zoology", questionCount: 35, requiredCount: 35, startQ: 151, endQ: 185, marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                    { id: "zoology_b", name: "Zoology - Section B", subject: "Zoology", questionCount: 15, requiredCount: 10, startQ: 186, endQ: 200, marking: { correct: 4, incorrect: -1, unanswered: 0 } }
                ];
            }
        } else if (/jee/i.test(extracted.examId.value) || /jee/i.test(extracted.examName.value)) {
            // JEE Main Official Structure
            if (!extracted.durationSeconds.value) {
                extracted.durationSeconds = {
                    value: 180 * 60, // 3 hours = 10800s
                    provenance: "nta_jee_main_official_bulletin",
                    confidence: 0.98
                };
            }
            if (!extracted.totalQuestions.value) {
                extracted.totalQuestions = {
                    value: 75,
                    provenance: "nta_jee_main_official_bulletin",
                    confidence: 0.98
                };
            }
            if (!extracted.maximumMarks.value) {
                extracted.maximumMarks = {
                    value: 300,
                    provenance: "nta_jee_main_official_bulletin",
                    confidence: 0.98
                };
            }
            if (!extracted.markingScheme.correct.value) {
                extracted.markingScheme.correct = { value: 4, provenance: "official_bulletin" };
            }
            if (!extracted.markingScheme.incorrect.value) {
                extracted.markingScheme.incorrect = { value: -1, provenance: "official_bulletin" };
            }

            extracted.sections = [
                { id: "math_a", name: "Mathematics - Section A", subject: "Mathematics", questionCount: 20, requiredCount: 20, startQ: 1, endQ: 20, questionType: "mcq", marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                { id: "math_b", name: "Mathematics - Section B", subject: "Mathematics", questionCount: 5, requiredCount: 5, startQ: 21, endQ: 25, questionType: "numerical", marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                { id: "physics_a", name: "Physics - Section A", subject: "Physics", questionCount: 20, requiredCount: 20, startQ: 26, endQ: 45, questionType: "mcq", marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                { id: "physics_b", name: "Physics - Section B", subject: "Physics", questionCount: 5, requiredCount: 5, startQ: 46, endQ: 50, questionType: "numerical", marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                { id: "chemistry_a", name: "Chemistry - Section A", subject: "Chemistry", questionCount: 20, requiredCount: 20, startQ: 51, endQ: 70, questionType: "mcq", marking: { correct: 4, incorrect: -1, unanswered: 0 } },
                { id: "chemistry_b", name: "Chemistry - Section B", subject: "Chemistry", questionCount: 5, requiredCount: 5, startQ: 71, endQ: 75, questionType: "numerical", marking: { correct: 4, incorrect: -1, unanswered: 0 } }
            ];
        } else if (/upsc/i.test(extracted.examId.value) || /upsc/i.test(extracted.examName.value)) {
            if (!extracted.durationSeconds.value) {
                extracted.durationSeconds = {
                    value: 120 * 60, // 2 hours = 7200s
                    provenance: "upsc_cse_official_blueprint",
                    confidence: 0.98
                };
            }
            if (!extracted.totalQuestions.value) {
                extracted.totalQuestions = {
                    value: 100,
                    provenance: "upsc_cse_official_blueprint",
                    confidence: 0.98
                };
            }
            if (!extracted.maximumMarks.value) {
                extracted.maximumMarks = {
                    value: 200,
                    provenance: "upsc_cse_official_blueprint",
                    confidence: 0.98
                };
            }
            if (!extracted.markingScheme.correct.value) {
                extracted.markingScheme.correct = { value: 2, provenance: "official_blueprint" };
            }
            if (!extracted.markingScheme.incorrect.value) {
                extracted.markingScheme.incorrect = { value: -2 / 3, provenance: "official_blueprint" };
            }

            extracted.sections = [
                {
                    id: "general_studies",
                    name: "General Studies Paper I",
                    subject: "General Studies",
                    questionCount: 100,
                    requiredCount: 100,
                    startQ: 1,
                    endQ: 100,
                    questionType: "mcq",
                    marking: { correct: 2, incorrect: -2 / 3, unanswered: 0 }
                }
            ];
        }

        // Fallback default booklet code if completely undetected in test document
        if (!extracted.paperCode.value) {
            extracted.paperCode = {
                value: userHints.paperCode || (extracted.examId.value === "jee-main" ? "Shift1" : "Q1"),
                provenance: userHints.paperCode ? "user_specified" : "default_code",
                confidence: userHints.paperCode ? 0.9 : 0.5
            };
        }
    }
}
