import { UniversalFirestoreService } from "./admin/universalFirestoreService.js";
import { MockTestScoringService } from "./mockTestScoringService.js";
import { SubjectNormalizationService } from "./subjectNormalizationService.js";
import { getFirestoreBaseUrl, getFirestoreServerAuthHeaders } from "./firebaseTokenService.js";

async function listPublishedTestDocuments() {
    if (process.env.NODE_ENV === "test" && !process.env.FIRESTORE_EMULATOR_HOST) {
        return UniversalFirestoreService.listDocuments("mockTests");
    }

    const projectId = UniversalFirestoreService.projectId;
    const url = `${getFirestoreBaseUrl(projectId)}:runQuery`;
    const authHeaders = await getFirestoreServerAuthHeaders(projectId);
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(authHeaders || {})
        },
        body: JSON.stringify({
            structuredQuery: {
                from: [{ collectionId: "mockTests" }],
                where: {
                    fieldFilter: {
                        field: { fieldPath: "status" },
                        op: "EQUAL",
                        value: { stringValue: "published" }
                    }
                }
            }
        })
    });

    if (!response.ok) {
        const errorDetails = await response.text();
        const error = new Error(`Firestore query returned HTTP ${response.status}: ${errorDetails}`);
        error.statusCode = response.status;
        error.code = response.status === 429 ? "RESOURCE_EXHAUSTED" : `HTTP_${response.status}`;
        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get("retry-after") || "30", 10);
            UniversalFirestoreService.recordQuotaExhaustion(retryAfter, errorDetails);
            error.isQuotaExhausted = true;
            error.retryAfter = retryAfter;
        }
        throw error;
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) {
        throw new Error("Firestore published mock-test query returned an invalid response.");
    }

    return rows
        .filter(row => row?.document)
        .map(({ document }) => {
            const id = document.name?.split("/").pop();
            return { id, ...UniversalFirestoreService.fromFirestoreDocument(document) };
        })
        .filter(test => test.status === "published");
}

/**
 * VidyarthiAstra — Student Mock Test Service
 * 
 * Manages the complete student mock-test lifecycle:
 * 1. Published test catalog discovery (draft tests hidden from students)
 * 2. Question retrieval with guaranteed answer-key stripping
 * 3. Server-owned attempt creation with authoritative start and deadline timestamps
 * 4. Incremental answer autosaving with ownership & deadline validation
 * 5. Server-authoritative submission, scoring, and result persistence
 * 6. Ownership-enforced attempt and result retrieval
 */
/**
 * Helper: Extract 4-digit numeric year from year field or text
 */
export function extractNumericYear(val) {
    if (val === null || val === undefined || val === "") return null;
    const num = Number(val);
    if (!isNaN(num) && num > 1900 && num < 2100) return Math.floor(num);
    const match = String(val).match(/\b(19\d\d|20\d\d)\b/);
    if (match) return parseInt(match[1], 10);
    return null;
}

/**
 * Helper: Safe numeric year comparison with stable secondary tie-breaker
 * Place missing/invalid years safely at the end for both 'asc' and 'desc'
 */
export function compareTestsByYear(a, b, sortDirection = "desc") {
    const yearA = extractNumericYear(a.year) ?? extractNumericYear(a.title);
    const yearB = extractNumericYear(b.year) ?? extractNumericYear(b.title);

    const hasA = yearA !== null;
    const hasB = yearB !== null;

    if (hasA && !hasB) return -1;
    if (!hasA && hasB) return 1;
    if (hasA && hasB && yearA !== yearB) {
        return sortDirection === "asc" ? yearA - yearB : yearB - yearA;
    }

    // Secondary stable ordering: examName, shift, paperCode, title, testId
    const examCmp = String(a.examName || a.examId || "").localeCompare(String(b.examName || b.examId || ""));
    if (examCmp !== 0) return examCmp;

    const shiftCmp = String(a.shift || "").localeCompare(String(b.shift || ""));
    if (shiftCmp !== 0) return shiftCmp;

    const paperCmp = String(a.paperCode || "").localeCompare(String(b.paperCode || ""));
    if (paperCmp !== 0) return paperCmp;

    const titleCmp = String(a.title || "").localeCompare(String(b.title || ""));
    if (titleCmp !== 0) return titleCmp;

    return String(a.testId || "").localeCompare(String(b.testId || ""));
}

/**
 * Helper: Multi-field tokenized search match across all mock test metadata
 */
export function matchesSearch(test, query) {
    if (!query || typeof query !== "string" || !query.trim()) return true;
    const trimmed = query.trim().toLowerCase();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;

    // Searchable metadata: examName, examId, title, paperCode, shift, year
    const searchableFields = [
        test.title,
        test.examName,
        test.examId,
        test.paperCode,
        test.shift,
        test.year != null ? String(test.year) : ""
    ].filter(Boolean);

    const haystack = searchableFields.join(" ").toLowerCase();

    // Direct phrase match optimization (e.g. "shift 2" or "jee main")
    if (haystack.includes(trimmed)) {
        return true;
    }

    // Tokenized multi-term match
    return tokens.every(token => {
        // If token is a short number (e.g. "1", "2"), enforce word boundary so it doesn't match digits in 2026 or 10800
        if (/^\d{1,2}$/.test(token)) {
            const regex = new RegExp(`(?:^|[^0-9a-zA-Z])${token}(?:$|[^0-9a-zA-Z])`, "i");
            return regex.test(haystack);
        }
        return haystack.includes(token);
    });
}

function areAnswersEqual(answersA = {}, answersB = {}) {
    if (!answersA && !answersB) return true;
    if (!answersA || !answersB) return false;
    const keysA = Object.keys(answersA);
    const keysB = Object.keys(answersB);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(answersB, key)) return false;
        const valA = answersA[key];
        const valB = answersB[key];
        if (Array.isArray(valA) && Array.isArray(valB)) {
            if (valA.length !== valB.length) return false;
            const sortedA = [...valA].map(String).sort();
            const sortedB = [...valB].map(String).sort();
            if (!sortedA.every((v, i) => v === sortedB[i])) return false;
        } else if (String(valA) !== String(valB)) {
            return false;
        }
    }
    return true;
}

export class MockTestService {
    static areAnswersEqual = areAnswersEqual;

    static extractNumericYear = extractNumericYear;
    static compareTestsByYear = compareTestsByYear;
    static matchesSearch = matchesSearch;

    /**
     * List all published mock tests for student catalog with search, year sorting & pagination
     */
    static async listPublishedTests({ examId = null, search = null, sort = "desc", page = 1, limit = null } = {}) {
        const tests = await listPublishedTestDocuments();

        // 1. Strictly published tests only (hide draft, failed, deleted, etc.)
        const published = tests.filter(t => t.status === "published");

        // 2. Filter by examId if specified
        const filteredByExam = !examId 
            ? published 
            : published.filter(t => t.examId && String(t.examId).toLowerCase() === String(examId).trim().toLowerCase());

        // 3. Map to public allowlist
        const mapped = filteredByExam.map(t => {
            const derivedShift = t.shift || 
                (t.paperCode && /shift/i.test(t.paperCode) ? t.paperCode : "") ||
                (t.title && /shift\s*([0-9]+|[A-Za-z]+)/i.test(t.title) ? (t.title.match(/shift\s*([0-9]+|[A-Za-z]+)/i)?.[0] || "") : "") ||
                null;

            return {
                testId: t.testId,
                examId: t.examId,
                examName: t.examName || t.examId,
                year: t.year ?? null,
                title: t.title || "Untitled Mock Test",
                paperCode: t.paperCode || null,
                shift: derivedShift,
                durationSeconds: t.durationSeconds || 1200,
                totalQuestions: t.totalQuestions || (t.questionIds || []).length,
                maximumMarks: t.maximumMarks || 720,
                availableLanguages: Array.isArray(t.availableLanguages) && t.availableLanguages.length > 0 ? t.availableLanguages : ["English"],
                contentNotice: t.contentNotice || null,
                publishedWithDiscrepancies: Boolean(t.publishedWithDiscrepancies),
                status: "published",
                createdAt: t.createdAt
            };
        });

        // 4. Search filtering (multi-field tokenized match)
        const searched = search ? mapped.filter(t => matchesSearch(t, search)) : mapped;

        // 5. Year sorting (default/desc = newest first, asc = oldest first, missing/invalid at end)
        const sortDirection = String(sort).toLowerCase() === "asc" ? "asc" : "desc";
        const sorted = [...searched].sort((a, b) => compareTestsByYear(a, b, sortDirection));

        // 6. Pagination if limit is requested
        const parsedLimit = (limit !== null && limit !== undefined && limit !== "")
            ? parseInt(limit, 10)
            : null;

        if (parsedLimit && !isNaN(parsedLimit) && parsedLimit > 0) {
            const boundedLimit = Math.max(1, Math.min(100, parsedLimit));
            const parsedPage = Math.max(1, parseInt(page, 10) || 1);
            const total = sorted.length;
            const totalPages = Math.ceil(total / boundedLimit) || 1;
            const startIndex = (parsedPage - 1) * boundedLimit;
            const paged = sorted.slice(startIndex, startIndex + boundedLimit);

            return {
                tests: paged,
                total,
                page: parsedPage,
                limit: boundedLimit,
                totalPages
            };
        }

        return sorted;
    }

    /**
     * Get test details and questions for an active test session
     * CONFIDENTIALITY GUARANTEE: Answer keys are NEVER included in response!
     */
    static async getTestForStudent(testId, { callerRole = "user", language = null } = {}) {
        if (!testId) throw new Error("Missing testId");

        const testDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
        if (!testDoc) {
            return null;
        }

        // Draft tests are strictly hidden from ordinary students
        if (testDoc.status !== "published" && callerRole !== "admin") {
            return null;
        }

        const availableLanguages = Array.isArray(testDoc.availableLanguages) && testDoc.availableLanguages.length > 0
            ? testDoc.availableLanguages
            : ["English"];

        const targetLang = (language || "English").trim();
        const isNonEnglish = targetLang.toLowerCase() !== "english" && targetLang.toLowerCase() !== "en";

        // Fetch question documents
        const allQuestions = await UniversalFirestoreService.listDocuments("mockQuestions");
        const testQuestions = allQuestions
            .filter(q => q.testId === testId || (testDoc.questionIds || []).includes(q.questionId))
            .sort((a, b) => (a.questionNumber || 0) - (b.questionNumber || 0))
            .map(q => {
                let text = q.questionText;
                let opts = (q.options || []).map(opt => ({
                    id: String(opt.id || opt.label),
                    label: String(opt.label || opt.id),
                    text: opt.text || "",
                    diagramUrl: opt.diagramUrl ? opt.diagramUrl.replace('/api/admin/vault/diagrams/', '/api/mock-tests/diagrams/') : null,
                    diagramId: opt.diagramId || null,
                    hasDiagram: Boolean(opt.hasDiagram || opt.diagramUrl)
                }));
                let translationMissing = false;

                if (isNonEnglish) {
                    const transKey = targetLang.toLowerCase();
                    const transObj = q.translations || q.questionTranslations || {};
                    let trans = transObj[targetLang] || transObj[transKey];
                    if (!trans) {
                        const matchingKey = Object.keys(transObj).find(k => k.toLowerCase() === transKey);
                        if (matchingKey) trans = transObj[matchingKey];
                    }

                    if (trans && trans.questionText) {
                        text = trans.questionText;
                        if (Array.isArray(trans.options) && trans.options.length > 0) {
                            const optTransMap = new Map(trans.options.map(o => [String(o.id ?? o.label), o.text]));
                            opts = opts.map(opt => ({
                                ...opt,
                                text: optTransMap.get(String(opt.id)) || optTransMap.get(String(opt.label)) || opt.text
                            }));
                        }
                    } else {
                        translationMissing = true;
                    }
                }

                const normSub = SubjectNormalizationService.normalizeSubject(q.subjectName || q.subject || q.subjectId);
                const diagramUrl = q.diagramUrl ? q.diagramUrl.replace('/api/admin/vault/diagrams/', '/api/mock-tests/diagrams/') : null;
                const media = (q.media || []).map(m => ({
                    ...m,
                    url: m.url ? m.url.replace('/api/admin/vault/diagrams/', '/api/mock-tests/diagrams/') : null
                }));

                return {
                    questionId: q.questionId,
                    testId: q.testId,
                    questionNumber: q.questionNumber,
                    originalNumbering: q.originalNumbering || String(q.questionNumber),
                    questionType: q.questionType || (opts.length === 0 ? "numerical" : "mcq"),
                    sectionId: q.sectionId || null,
                    sectionName: q.sectionName || normSub.subjectName || "General",
                    subject: normSub.subjectName,
                    subjectId: normSub.subjectId,
                    subjectName: normSub.subjectName,
                    topic: q.topic || "",
                    questionText: text,
                    options: opts,
                    hasDiagram: Boolean(q.hasDiagram || diagramUrl || opts.some(o => o.hasDiagram)),
                    diagramUrl,
                    media,
                    sourcePage: q.sourcePage || 1,
                    language: isNonEnglish && !translationMissing ? targetLang : "English",
                    translationMissing: isNonEnglish ? translationMissing : false,
                    fallbackLanguage: translationMissing ? "English" : null,
                    marking: q.marking || q.scoring || q.markingScheme || null,
                    scoring: q.scoring || null,
                    passageText: q.passageText || null,
                    statements: q.statements || [],
                    tableData: q.tableData || null,
                    leftItems: q.leftItems || [],
                    rightItems: q.rightItems || [],
                    subQuestions: q.subQuestions || [],
                    instructions: q.instructions || null
                };
            });

        return {
            test: {
                testId: testDoc.testId,
                examId: testDoc.examId,
                examName: testDoc.examName || testDoc.examId,
                year: testDoc.year,
                title: testDoc.title,
                paperCode: testDoc.paperCode,
                shift: testDoc.shift || null,
                durationSeconds: testDoc.durationSeconds || 1200,
                totalQuestions: testQuestions.length,
                maximumMarks: testDoc.maximumMarks || (testQuestions.length * 4),
                availableLanguages,
                contentNotice: testDoc.contentNotice || null,
                publishedWithDiscrepancies: Boolean(testDoc.publishedWithDiscrepancies),
                sections: testDoc.sections || [],
                scoringConfig: testDoc.scoringConfig || null,
                schemaVersion: testDoc.schemaVersion || "1.0.0",
                instructions: testDoc.instructions || [],
                status: testDoc.status
            },
            questions: testQuestions
        };
    }

    /**
     * Start a new test attempt for an authenticated student
     * Enforces server-authoritative timer deadline.
     */
    static async startAttempt({ testId, userId, language = "English" }) {
        if (!testId || !userId) {
            throw new Error("testId and authenticated userId are required to start an attempt");
        }

        const testDoc = await UniversalFirestoreService.getDocument("mockTests", testId);
        if (!testDoc) {
            const err = new Error(`Test ${testId} is not available for attempts (not published or does not exist)`);
            err.statusCode = 404;
            throw err;
        }
        if (testDoc.status !== "published") {
            const err = new Error(`Test ${testId} is not available for attempts (not published or does not exist)`);
            err.statusCode = 400;
            throw err;
        }

        const availableLanguages = Array.isArray(testDoc.availableLanguages) && testDoc.availableLanguages.length > 0
            ? testDoc.availableLanguages
            : ["English"];

        const requestedLang = (language || "English").trim();
        const matchedLanguage = availableLanguages.find(l => l.toLowerCase() === requestedLang.toLowerCase());
        if (!matchedLanguage) {
            throw new Error(`Language '${requestedLang}' is not supported for test '${testId}'. Available languages: ${availableLanguages.join(', ')}`);
        }

        // Check if student already has an active in_progress attempt
        const existingAttempts = await UniversalFirestoreService.listDocuments("mockAttempts");
        const activeAttempt = existingAttempts.find(a => 
            a.testId === testId && 
            a.userId === userId && 
            a.status === "in_progress" &&
            Date.now() < new Date(a.deadlineAt).getTime()
        );

        if (activeAttempt) {
            return activeAttempt;
        }

        const durationSeconds = Number(testDoc.durationSeconds) || 1200;
        const now = Date.now();
        const startedAt = new Date(now).toISOString();
        const deadlineAt = new Date(now + durationSeconds * 1000).toISOString();
        const attemptId = `attempt_${testId}_${userId}_${now}`;

        const attempt = {
            attemptId,
            testId,
            userId,
            language: matchedLanguage,
            status: "in_progress",
            startedAt,
            deadlineAt,
            durationSeconds,
            answers: {},
            markedForReview: [],
            createdAt: startedAt,
            updatedAt: startedAt
        };

        await UniversalFirestoreService.setDocument("mockAttempts", attemptId, attempt, { createOnly: true });
        return attempt;
    }

    /**
     * Autosave student answers and review marks
     * Validates attempt ownership, active status, and server timer deadline.
     * DEF-CONC-01: Guaranteed optimistic concurrency with genuine updateTime precondition.
     */
    static async autosaveAttempt({ attemptId, userId, answers = {}, markedForReview = [], expectedUpdateTime }) {
        if (!attemptId || !userId) {
            throw new Error("attemptId and userId are required");
        }

        const attempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        if (!attempt) {
            const err = new Error("Attempt not found");
            err.statusCode = 404;
            throw err;
        }

        if (attempt.userId !== userId) {
            const err = new Error("Access Denied: Attempt belongs to another student");
            err.statusCode = 403;
            throw err;
        }

        // Terminal state rejection: Never accept autosave on submitted or completed attempts
        if (attempt.status === "submitted" || attempt.status === "completed") {
            const err = new Error(`Cannot update attempt: Status is '${attempt.status}'`);
            err.statusCode = 409;
            err.code = "ATTEMPT_ALREADY_SUBMITTED";
            throw err;
        }

        if (attempt.status !== "in_progress") {
            const err = new Error(`Cannot update attempt: Status is '${attempt.status}'`);
            err.statusCode = 400;
            throw err;
        }

        // Check server-authoritative timer expiration
        if (Date.now() > new Date(attempt.deadlineAt).getTime()) {
            attempt.status = "expired";
            attempt.updatedAt = new Date().toISOString();
            try {
                await UniversalFirestoreService.setDocument("mockAttempts", attemptId, attempt, {
                    precondition: attempt._updateTime ? { updateTime: attempt._updateTime } : undefined
                });
            } catch (e) {}
            const err = new Error("Test attempt duration has expired");
            err.statusCode = 400;
            throw err;
        }

        // Check explicit expectedUpdateTime if supplied by caller
        if (expectedUpdateTime && attempt._updateTime && attempt._updateTime !== expectedUpdateTime) {
            const err = new Error(`Conflict: Stale autosave rejected (expected ${expectedUpdateTime}, current is ${attempt._updateTime})`);
            err.statusCode = 409;
            err.code = "STALE_AUTOSAVE";
            throw err;
        }

        // Fetch questions for questionType checking
        const testDoc = await UniversalFirestoreService.getDocument("mockTests", attempt.testId);
        const allQuestions = await UniversalFirestoreService.listDocuments("mockQuestions");
        const questions = allQuestions.filter(q => 
            q.testId === attempt.testId || (testDoc?.questionIds || []).includes(q.questionId)
        );

        // Sanitize and strictly validate answers
        const cleanAnswers = MockTestService._sanitizeAndValidateAnswers(answers, attempt.answers, questions);

        // Sanitize markedForReview (array of questionId strings)
        let cleanMarked = Array.isArray(attempt.markedForReview) ? [...attempt.markedForReview] : [];
        if (Array.isArray(markedForReview)) {
            cleanMarked = markedForReview
                .filter(id => typeof id === "string" && id.length <= 128);
        }

        const nowIso = new Date().toISOString();
        const updatedAttempt = {
            ...attempt,
            answers: cleanAnswers,
            markedForReview: cleanMarked,
            updatedAt: nowIso
        };

        // Write with genuine Firestore updateTime precondition
        const precondition = attempt._updateTime
            ? { updateTime: attempt._updateTime }
            : { exists: true };

        try {
            await UniversalFirestoreService.setDocument("mockAttempts", attemptId, updatedAttempt, {
                precondition
            });
        } catch (err) {
            const isConflict = err.code === "FAILED_PRECONDITION" || 
                               err.statusCode === 409 || 
                               err.statusCode === 412 || 
                               /precondition/i.test(err.message || "") ||
                               /conflict/i.test(err.message || "");

            if (isConflict) {
                const freshAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
                if (freshAttempt && (freshAttempt.status === "submitted" || freshAttempt.status === "completed")) {
                    const conflictErr = new Error(`Cannot update attempt: Status is '${freshAttempt.status}'`);
                    conflictErr.statusCode = 400;
                    conflictErr.code = "ATTEMPT_ALREADY_SUBMITTED";
                    throw conflictErr;
                }
                const conflictErr = new Error("Conflict: Attempt was modified concurrently by another request");
                conflictErr.statusCode = 409;
                conflictErr.code = "CONCURRENT_MODIFICATION";
                throw conflictErr;
            }
            throw err;
        }

        return {
            success: true,
            attemptId,
            savedCount: Object.keys(cleanAnswers).length,
            markedCount: cleanMarked.length,
            updatedAt: nowIso
        };
    }

    /**
     * Submit an attempt, evaluate results server-side, and persist immutable score
     * Idempotent: repeated submissions with identical payloads return existing result.
     * DEF-CONC-01: Atomic batch commit with updateTime precondition on attempt and exists:false on result.
     */
    static async submitAttempt({ attemptId, userId, answers }) {
        if (!attemptId || !userId) {
            throw new Error("attemptId and userId are required");
        }

        const attempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        if (!attempt) {
            const err = new Error("Attempt not found");
            err.statusCode = 404;
            throw err;
        }

        if (attempt.userId !== userId) {
            const err = new Error("Access Denied: Attempt belongs to another student");
            err.statusCode = 403;
            throw err;
        }

        const resultId = `result_${attemptId}`;

        // IDEMPOTENCY / TERMINAL STATE GUARD:
        if (attempt.status === "completed") {
            const existingResult = await UniversalFirestoreService.getDocument("mockResults", resultId);
            if (answers && typeof answers === "object") {
                const match = areAnswersEqual(answers, attempt.answers || {});
                if (!match) {
                    const err = new Error("Conflict: Attempt has already been submitted with different answers");
                    err.statusCode = 409;
                    err.code = "SUBMISSION_PAYLOAD_CONFLICT";
                    throw err;
                }
            }
            if (existingResult) {
                return {
                    ...existingResult,
                    alreadySubmitted: true
                };
            }
            const err = new Error("Conflict: Attempt is already completed and cannot be re-submitted");
            err.statusCode = 409;
            throw err;
        }

        if (attempt.status === "submitted") {
            const existingResult = await UniversalFirestoreService.getDocument("mockResults", resultId);
            if (answers && typeof answers === "object") {
                const match = areAnswersEqual(answers, attempt.answers || {});
                if (!match) {
                    const err = new Error("Conflict: Attempt has already been submitted with different answers");
                    err.statusCode = 409;
                    err.code = "SUBMISSION_PAYLOAD_CONFLICT";
                    throw err;
                }
            }
            if (existingResult) {
                return {
                    ...existingResult,
                    alreadySubmitted: true
                };
            }
            // Recovery path for interrupted states: If attempt is already marked submitted
            // but mockResults document was not created, proceed below to evaluate and persist mockResults.
        } else if (attempt.status !== "in_progress") {
            const err = new Error(`Cannot submit attempt: Status is '${attempt.status}'`);
            err.statusCode = 400;
            throw err;
        }

        // Check server-authoritative timer expiration
        if (Date.now() > new Date(attempt.deadlineAt).getTime()) {
            attempt.status = "expired";
            attempt.updatedAt = new Date().toISOString();
            try {
                await UniversalFirestoreService.setDocument("mockAttempts", attemptId, attempt, {
                    precondition: attempt._updateTime ? { updateTime: attempt._updateTime } : undefined
                });
            } catch (e) {}
            const err = new Error("Test attempt duration has expired");
            err.statusCode = 400;
            throw err;
        }

        // Fetch questions and protected answer keys
        const testDoc = await UniversalFirestoreService.getDocument("mockTests", attempt.testId);
        const allQuestions = await UniversalFirestoreService.listDocuments("mockQuestions");
        const questions = allQuestions.filter(q => 
            q.testId === attempt.testId || (testDoc?.questionIds || []).includes(q.questionId)
        );

        // Merge / sanitize and strictly validate answers
        const candidateAnswers = MockTestService._sanitizeAndValidateAnswers(answers, attempt.answers, questions);

        const allAnswerKeys = await UniversalFirestoreService.listDocuments("mockAnswerKeys");
        const answerKeys = allAnswerKeys.filter(ak => 
            ak.testId === attempt.testId || (questions.map(q => q.questionId).includes(ak.questionId))
        );

        // Evaluate server score
        const scoreResult = MockTestScoringService.evaluateAttempt({
            questions,
            answerKeys,
            studentAnswers: candidateAnswers,
            examConfig: testDoc
        });

        const submittedAt = new Date().toISOString();
        const startedAtMs = new Date(attempt.startedAt).getTime();
        const submittedAtMs = new Date(submittedAt).getTime();
        const timeTakenSeconds = (!isNaN(startedAtMs) && !isNaN(submittedAtMs))
            ? Math.max(0, Math.round((submittedAtMs - startedAtMs) / 1000))
            : null;

        const isFinalized = scoreResult.isFinalized ?? (scoreResult.pendingReviewCount === 0);
        const requiresManualEvaluation = scoreResult.requiresManualEvaluation ?? ((scoreResult.pendingReviewCount || 0) > 0);
        const pendingReviewCount = scoreResult.pendingReviewCount || 0;

        // Update attempt status and review metadata (DEFECT 01)
        const updatedAttempt = {
            ...attempt,
            answers: candidateAnswers,
            status: "submitted",
            submittedAt,
            updatedAt: submittedAt,
            timeTakenSeconds,
            isFinalized,
            requiresManualEvaluation,
            pendingReviewCount
        };

        // Create immutable result record
        const maximumMarks = scoreResult.maximumMarks || testDoc?.maximumMarks || (questions.length * 4);
        const resultRecord = {
            resultId,
            attemptId,
            testId: attempt.testId,
            userId,
            totalScore: scoreResult.totalScore,
            maximumMarks,
            percentageScore: scoreResult.percentageScore,
            totalQuestions: scoreResult.totalQuestions,
            correctCount: scoreResult.correctCount,
            incorrectCount: scoreResult.incorrectCount,
            unansweredCount: scoreResult.unansweredCount,
            droppedCount: scoreResult.droppedCount,
            attemptedCount: scoreResult.attemptedCount,
            pendingReviewCount,
            requiresManualEvaluation,
            isFinalized,
            accuracyPercent: scoreResult.accuracyPercent,
            timeTakenSeconds,
            subjectAnalysis: scoreResult.subjectAnalysis,
            sectionScores: scoreResult.sectionScores || null,
            sectionAnalysis: scoreResult.sectionAnalysis ? (Array.isArray(scoreResult.sectionAnalysis) ? scoreResult.sectionAnalysis : Object.values(scoreResult.sectionAnalysis)) : null,
            breakdown: scoreResult.breakdown,
            submittedAt
        };

        // Atomic batch commit for attempt status update and immutable result record (DEF-CONC-01)
        const attemptDocPath = UniversalFirestoreService.getDocumentPath("mockAttempts", attemptId);
        const resultDocPath = UniversalFirestoreService.getDocumentPath("mockResults", resultId);

        const writeAttempt = {
            update: {
                name: attemptDocPath,
                fields: UniversalFirestoreService.toFirestoreFields(updatedAttempt)
            },
            currentDocument: attempt._updateTime
                ? { updateTime: attempt._updateTime }
                : { exists: true }
        };

        const writeResult = {
            update: {
                name: resultDocPath,
                fields: UniversalFirestoreService.toFirestoreFields(resultRecord)
            },
            currentDocument: { exists: false }
        };

        try {
            await UniversalFirestoreService.commitBatchWrites([writeAttempt, writeResult]);
        } catch (err) {
            const isConflict = err.code === "ALREADY_EXISTS" || 
                               err.code === "FAILED_PRECONDITION" || 
                               err.statusCode === 409 || 
                               err.statusCode === 412 || 
                               /already exists/i.test(err.message || "") ||
                               /precondition/i.test(err.message || "") ||
                               /collision/i.test(err.message || "");

            if (isConflict) {
                const freshAttempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
                const existingResult = await UniversalFirestoreService.getDocument("mockResults", resultId);

                if (freshAttempt && (freshAttempt.status === "submitted" || freshAttempt.status === "completed") && existingResult) {
                    const match = areAnswersEqual(candidateAnswers, freshAttempt.answers || {});
                    if (match) {
                        return {
                            ...existingResult,
                            alreadySubmitted: true
                        };
                    }
                    const conflictErr = new Error("Conflict: Attempt has already been submitted with different answers");
                    conflictErr.statusCode = 409;
                    conflictErr.code = "SUBMISSION_PAYLOAD_CONFLICT";
                    throw conflictErr;
                }

                const conflictErr = new Error("Conflict: Attempt was modified concurrently during submission. Please retry.");
                conflictErr.statusCode = 409;
                conflictErr.code = "CONCURRENT_MODIFICATION";
                throw conflictErr;
            }
            throw err;
        }

        return resultRecord;
    }

    /**
     * Retrieve an attempt with authorization check
     */
    static async getAttempt({ attemptId, userId, callerRole = "user" }) {
        if (!attemptId) throw new Error("Missing attemptId");
        const attempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        if (!attempt) return null;

        if (attempt.userId !== userId && callerRole !== "admin") {
            const err = new Error("Access Denied: You cannot view another student's attempt");
            err.statusCode = 403;
            throw err;
        }

        return attempt;
    }

    /**
     * Retrieve evaluated results with authorization check
     */
    static async getResult({ resultId, userId, callerRole = "user" }) {
        if (!resultId) throw new Error("Missing resultId");
        const result = await UniversalFirestoreService.getDocument("mockResults", resultId);
        if (!result) return null;

        if (result.userId !== userId && callerRole !== "admin") {
            const err = new Error("Access Denied: You cannot view another student's result");
            err.statusCode = 403;
            throw err;
        }

        // Backward compatibility: enrich legacy result with percentageScore and subjectAnalysis if missing
        const enriched = { ...result };
        if (enriched.percentageScore === undefined && enriched.maximumMarks > 0) {
            enriched.percentageScore = Number(((enriched.totalScore / enriched.maximumMarks) * 100).toFixed(2));
        }
        if (!enriched.subjectAnalysis) {
            if (Array.isArray(enriched.breakdown) && enriched.breakdown.length > 0) {
                const subMap = {};
                for (const item of enriched.breakdown) {
                    const norm = SubjectNormalizationService.normalizeSubject(item.subjectName || item.subject || item.subjectId);
                    if (!subMap[norm.subjectId]) {
                        subMap[norm.subjectId] = {
                            subjectId: norm.subjectId,
                            subjectName: norm.subjectName,
                            score: 0,
                            maximumMarks: 0,
                            totalQuestions: 0,
                            correct: 0,
                            incorrect: 0,
                            unattempted: 0,
                            dropped: 0,
                            attemptedCount: 0,
                            accuracy: 0
                        };
                    }
                    const sub = subMap[norm.subjectId];
                    sub.totalQuestions++;
                    const marks = item.marksAwarded ?? 0;
                    sub.score += marks;
                    sub.maximumMarks += 4;
                    if (item.status === "correct") { sub.correct++; sub.attemptedCount++; }
                    else if (item.status === "incorrect") { sub.incorrect++; sub.attemptedCount++; }
                    else if (item.status === "unanswered") { sub.unattempted++; }
                    else if (item.status === "dropped") { sub.dropped++; }
                }
                for (const s of Object.values(subMap)) {
                    s.accuracy = s.attemptedCount > 0 ? Number(((s.correct / s.attemptedCount) * 100).toFixed(2)) : 0;
                }
                enriched.subjectAnalysis = subMap;
            } else {
                enriched.subjectAnalysis = {
                    unclassified: {
                        subjectId: "unclassified",
                        subjectName: "Unclassified",
                        score: enriched.totalScore,
                        maximumMarks: enriched.maximumMarks,
                        totalQuestions: enriched.totalQuestions || (enriched.correctCount + enriched.incorrectCount + enriched.unansweredCount),
                        correct: enriched.correctCount,
                        incorrect: enriched.incorrectCount,
                        unattempted: enriched.unansweredCount,
                        dropped: enriched.droppedCount || 0,
                        accuracy: enriched.accuracyPercent,
                        legacyNotice: "Detailed subject-wise breakdown is not available for this legacy attempt."
                    }
                };
            }
        }

        return enriched;
    }

    /**
     * Retrieve authenticated student's submitted paper in review format
     * SECURITY & CONFIDENTIALITY:
     * - Only submitted attempts can be reviewed (in-progress/active attempts rejected)
     * - Enforces ownership (student can only review their own attempt)
     * - Selective correct answer exposure:
     *   - Incorrect questions: includes correctAnswer (option identifier and text, or numerical value)
     *   - Correct questions: NO separate correctAnswer field exposed!
     *   - Unattempted questions: NO correctAnswer field exposed!
     *   - Dropped questions: NO correctAnswer field exposed!
     */
    static async getReviewForAttempt({ attemptId, userId, callerRole = "user" }) {
        if (!attemptId || !userId) {
            throw new Error("attemptId and userId are required to review an attempt");
        }

        const attempt = await UniversalFirestoreService.getDocument("mockAttempts", attemptId);
        if (!attempt) {
            const err = new Error("Attempt not found");
            err.statusCode = 404;
            throw err;
        }

        if (attempt.userId !== userId && callerRole !== "admin") {
            const err = new Error("Access Denied: You cannot view another student's test review");
            err.statusCode = 403;
            throw err;
        }

        if (attempt.status !== "submitted") {
            const err = new Error("Review Exam is only available for submitted test attempts.");
            err.statusCode = 400;
            throw err;
        }

        const resultId = `result_${attemptId}`;
        const resultDoc = await this.getResult({ resultId, userId, callerRole });

        const testDoc = await UniversalFirestoreService.getDocument("mockTests", attempt.testId);
        const allQuestions = await UniversalFirestoreService.listDocuments("mockQuestions");
        const rawQuestions = allQuestions
            .filter(q => q.testId === attempt.testId || (testDoc?.questionIds || []).includes(q.questionId))
            .sort((a, b) => (a.questionNumber || 0) - (b.questionNumber || 0));

        const allAnswerKeys = await UniversalFirestoreService.listDocuments("mockAnswerKeys");
        const answerKeys = allAnswerKeys.filter(ak =>
            ak.testId === attempt.testId || rawQuestions.some(q => q.questionId === ak.questionId)
        );

        const breakdownMap = new Map();
        if (resultDoc && Array.isArray(resultDoc.breakdown)) {
            for (const b of resultDoc.breakdown) {
                breakdownMap.set(b.questionId || String(b.questionNumber), b);
            }
        }

        const targetLang = (attempt.language || "English").trim();
        const isNonEnglish = targetLang.toLowerCase() !== "english" && targetLang.toLowerCase() !== "en";

        const reviewQuestions = rawQuestions.map(q => {
            const key = answerKeys.find(k =>
                (k.questionId && k.questionId === q.questionId) ||
                (k.questionNumber && k.questionNumber === q.questionNumber)
            );

            const b = breakdownMap.get(q.questionId) || breakdownMap.get(String(q.questionNumber)) || {};
            const status = b.status || (attempt.answers?.[q.questionId] ? "incorrect" : "unanswered");
            const marksAwarded = b.marksAwarded ?? 0;
            const normSub = SubjectNormalizationService.normalizeSubject(q.subjectName || q.subject || q.subjectId);

            let text = q.questionText;
            let opts = (q.options || []).map(opt => ({
                id: String(opt.id || opt.label),
                label: String(opt.label || opt.id),
                text: opt.text || "",
                diagramUrl: opt.diagramUrl ? opt.diagramUrl.replace('/api/admin/vault/diagrams/', '/api/mock-tests/diagrams/') : null,
                diagramId: opt.diagramId || null,
                hasDiagram: Boolean(opt.hasDiagram || opt.diagramUrl)
            }));

            if (isNonEnglish) {
                const transKey = targetLang.toLowerCase();
                const transObj = q.translations || q.questionTranslations || {};
                let trans = transObj[targetLang] || transObj[transKey];
                if (!trans) {
                    const matchingKey = Object.keys(transObj).find(k => k.toLowerCase() === transKey);
                    if (matchingKey) trans = transObj[matchingKey];
                }

                if (trans && trans.questionText) {
                    text = trans.questionText;
                    if (Array.isArray(trans.options) && trans.options.length > 0) {
                        const optTransMap = new Map(trans.options.map(o => [String(o.id ?? o.label), o.text]));
                        opts = opts.map(opt => ({
                            ...opt,
                            text: optTransMap.get(String(opt.id)) || optTransMap.get(String(opt.label)) || opt.text
                        }));
                    }
                }
            }

            // CRITICAL SERVER-SIDE ENFORCEMENT:
            // Selectively expose correct answer ONLY for incorrectly answered questions.
            let correctAnswer = null;
            if (status === "incorrect") {
                const isNumerical = q.questionType === "numerical" || key?.answerType === "numerical";
                if (isNumerical) {
                    const accepted = (
                        (Array.isArray(key?.acceptedAnswers) && key.acceptedAnswers.length > 0)
                            ? key.acceptedAnswers
                            : (Array.isArray(key?.correctAnswers) && key.correctAnswers.length > 0)
                                ? key.correctAnswers
                                : (Array.isArray(key?.correctOptionIds) && key.correctOptionIds.length > 0)
                                    ? key.correctOptionIds
                                    : []
                    );
                    const primaryVal = accepted.length > 0 ? String(accepted[0]).trim() : "";
                    correctAnswer = {
                        type: "numerical",
                        value: primaryVal,
                        acceptedAnswers: accepted.map(a => String(a).trim())
                    };
                } else if (q.questionType === "msq" || key?.answerType === "msq") {
                    const correctOptionIds = (
                        (Array.isArray(key?.correctOptionIds) && key.correctOptionIds.length > 0)
                            ? key.correctOptionIds
                            : (Array.isArray(key?.correctAnswers) && key.correctAnswers.length > 0)
                                ? key.correctAnswers
                                : key?.correctOptionId != null ? [key.correctOptionId] : []
                    ).map(a => String(a).trim());
                    correctAnswer = {
                        type: "msq",
                        correctOptionIds,
                        optionLabels: correctOptionIds.join(", "),
                        text: correctOptionIds.map(cid => {
                            const matchedOpt = opts.find(o => String(o.id).trim() === cid || String(o.label).trim() === cid);
                            return matchedOpt ? `${matchedOpt.label}: ${matchedOpt.text}` : cid;
                        }).join("; ")
                    };
                } else {
                    const correctOptionIds = (
                        (Array.isArray(key?.correctOptionIds) && key.correctOptionIds.length > 0)
                            ? key.correctOptionIds
                            : key?.correctOptionId != null
                                ? [key.correctOptionId]
                                : (Array.isArray(key?.correctAnswers) && key.correctAnswers.length > 0)
                                    ? key.correctAnswers
                                    : (Array.isArray(key?.acceptedAnswers) ? key.acceptedAnswers : [])
                    ).map(a => String(a).trim());

                    const primaryOptionId = correctOptionIds[0] || "";
                    const matchedOpt = opts.find(o => String(o.id).trim() === primaryOptionId || String(o.label).trim() === primaryOptionId);
                    correctAnswer = {
                        type: "mcq",
                        optionId: primaryOptionId,
                        optionLabel: matchedOpt?.label || primaryOptionId,
                        text: matchedOpt?.text || ""
                    };
                }
            }

            const diagramUrl = q.diagramUrl ? q.diagramUrl.replace('/api/admin/vault/diagrams/', '/api/mock-tests/diagrams/') : null;
            const media = (q.media || []).map(m => ({
                ...m,
                url: m.url ? m.url.replace('/api/admin/vault/diagrams/', '/api/mock-tests/diagrams/') : null
            }));

            return {
                questionId: q.questionId,
                testId: q.testId,
                questionNumber: q.questionNumber,
                subject: normSub.subjectName,
                subjectId: normSub.subjectId,
                subjectName: normSub.subjectName,
                topic: q.topic || "",
                questionType: q.questionType,
                sectionId: q.sectionId || null,
                sectionName: q.sectionName || normSub.subjectName || "General",
                passageText: q.passageText || null,
                statements: q.statements || [],
                tableData: q.tableData || null,
                leftItems: q.leftItems || [],
                rightItems: q.rightItems || [],
                questionText: text,
                options: opts,
                diagramUrl,
                media,
                hasDiagram: Boolean(q.hasDiagram || diagramUrl),
                sourcePage: q.sourcePage || 1,
                status,
                studentAnswer: attempt.answers?.[q.questionId] !== undefined ? attempt.answers[q.questionId] : null,
                marksAwarded,
                bonusAwarded: Boolean(b.bonusAwarded),
                correctAnswer // null for correct, unanswered, and dropped questions!
            };
        });

        return {
            attemptId,
            testId: attempt.testId,
            testTitle: testDoc?.title || "Mock Test",
            examId: testDoc?.examId || "",
            userId: attempt.userId,
            language: attempt.language || "English",
            startedAt: attempt.startedAt,
            submittedAt: attempt.submittedAt,
            timeTakenSeconds: attempt.timeTakenSeconds || null,
            summary: {
                totalScore: resultDoc?.totalScore ?? 0,
                maximumMarks: resultDoc?.maximumMarks ?? 0,
                percentageScore: resultDoc?.percentageScore ?? 0,
                totalQuestions: resultDoc?.totalQuestions ?? reviewQuestions.length,
                correctCount: resultDoc?.correctCount ?? 0,
                incorrectCount: resultDoc?.incorrectCount ?? 0,
                unansweredCount: resultDoc?.unansweredCount ?? 0,
                droppedCount: resultDoc?.droppedCount ?? 0,
                accuracyPercent: resultDoc?.accuracyPercent ?? 0
            },
            subjectAnalysis: resultDoc?.subjectAnalysis || {},
            questions: reviewQuestions
        };
    }

    /**
     * List attempt history for an authenticated student
     * Ownership: only returns attempts matching the authenticated userId
     */
    static async listUserAttempts({ userId, testId = null }) {
        if (!userId) {
            throw new Error("userId is required to list attempt history");
        }

        const allAttempts = await UniversalFirestoreService.listDocuments("mockAttempts");
        return allAttempts
            .filter(a => a.userId === userId)
            .filter(a => !testId || a.testId === testId)
            .sort((a, b) => new Date(b.startedAt || b.createdAt).getTime() - new Date(a.startedAt || a.createdAt).getTime())
            .map(a => ({
                attemptId: a.attemptId,
                testId: a.testId,
                userId: a.userId,
                language: a.language || "English",
                status: a.status,
                startedAt: a.startedAt,
                deadlineAt: a.deadlineAt,
                submittedAt: a.submittedAt || null,
                durationSeconds: a.durationSeconds
            }));
    }

    /**
     * Helper to sanitize and strictly validate submitted student answers.
     * Enforces numerical answer rules: only digits and a single decimal point (0-9 and .).
     * Rejects alphabets, commas, operators (+/-), spaces, exponents.
     * Throws 400 Bad Request with code MALFORMED_NUMERICAL_ANSWER on violations.
     * Empties/nulls are removed, not converted to 0.
     */
    static _sanitizeAndValidateAnswers(incomingAnswers, existingAnswers = {}, questions = []) {
        const questionMap = new Map((questions || []).map(q => [q.questionId, q]));
        const cleanAnswers = { ...(existingAnswers || {}) };
        const NUMERICAL_TYPES = new Set(["numerical", "nat", "numerical_nat"]);

        if (incomingAnswers && typeof incomingAnswers === "object") {
            for (const [qId, optId] of Object.entries(incomingAnswers)) {
                if (typeof qId !== "string" || qId.length > 128) continue;

                if (optId === null || optId === undefined || optId === "") {
                    delete cleanAnswers[qId];
                    continue;
                }

                const targetQ = questionMap.get(qId);
                const qTypeLower = String(targetQ?.questionType || "").toLowerCase();
                const isDescriptive = Boolean(
                    targetQ?.isDescriptive ||
                    qTypeLower.includes("descriptive") ||
                    qTypeLower.includes("subjective") ||
                    qTypeLower.includes("manual")
                );
                const isFillIn = qTypeLower.includes("fill_in") || qTypeLower.includes("blank");
                const isNumerical = !isDescriptive && !isFillIn && targetQ && (
                    NUMERICAL_TYPES.has(qTypeLower) ||
                    (Array.isArray(targetQ.options) && targetQ.options.length === 0)
                );

                if (isNumerical) {
                    if (typeof optId !== "string" && typeof optId !== "number") {
                        const err = new Error(`Malformed numerical answer for question ${qId}: input must be numeric`);
                        err.statusCode = 400;
                        err.code = "MALFORMED_NUMERICAL_ANSWER";
                        throw err;
                    }
                    const valStr = String(optId);
                    if (!/^\d+(?:\.\d+)?$/.test(valStr)) {
                        const err = new Error(`Malformed numerical answer for question ${qId}: only digits and a single decimal point are allowed (received "${valStr}")`);
                        err.statusCode = 400;
                        err.code = "MALFORMED_NUMERICAL_ANSWER";
                        throw err;
                    }
                    cleanAnswers[qId] = valStr;
                } else if (isDescriptive || isFillIn) {
                    if (typeof optId === "string" && optId.length <= 10000) {
                        cleanAnswers[qId] = optId;
                    }
                } else if (typeof optId === "string" && optId.length <= 64) {
                    cleanAnswers[qId] = optId;
                } else if (Array.isArray(optId)) {
                    cleanAnswers[qId] = optId.filter(o => typeof o === "string" && o.length <= 64);
                }
            }
        }

        // Final verification pass across all stored answers against questions
        for (const [qId, optVal] of Object.entries(cleanAnswers)) {
            const targetQ = questionMap.get(qId);
            const qTypeLower = String(targetQ?.questionType || "").toLowerCase();
            const isDescriptive = Boolean(
                targetQ?.isDescriptive ||
                qTypeLower.includes("descriptive") ||
                qTypeLower.includes("subjective") ||
                qTypeLower.includes("manual")
            );
            const isFillIn = qTypeLower.includes("fill_in") || qTypeLower.includes("blank");
            const isNumerical = !isDescriptive && !isFillIn && targetQ && (
                NUMERICAL_TYPES.has(qTypeLower) ||
                (Array.isArray(targetQ.options) && targetQ.options.length === 0)
            );
            if (isNumerical) {
                if (optVal === null || optVal === undefined || optVal === "") {
                    delete cleanAnswers[qId];
                } else if (!/^\d+(?:\.\d+)?$/.test(String(optVal))) {
                    const err = new Error(`Malformed numerical answer for question ${qId}: only digits and a single decimal point are allowed (received "${optVal}")`);
                    err.statusCode = 400;
                    err.code = "MALFORMED_NUMERICAL_ANSWER";
                    throw err;
                }
            }
        }

        return cleanAnswers;
    }
}

