import { SearchService } from "../services/searchService.js";
import { IntentService } from "../services/intentService.js";
import { GroqService } from "../services/groqService.js";
import { ResponseService } from "../services/responseService.js";
import { PaperSearchService } from "../services/paperSearchService.js";
import { verifyFirebaseIdToken } from "../services/firebaseTokenService.js";

// In-memory daily usage tracking per user UID (Reset daily)
const userDailyUsage = new Map();
let currentDayKey = new Date().toISOString().split("T")[0];

function checkAndResetDailyUsage() {
    const today = new Date().toISOString().split("T")[0];
    if (today !== currentDayKey) {
        currentDayKey = today;
        userDailyUsage.clear();
        console.log(`[AI Server] Daily message limits reset for date: ${currentDayKey}`);
    }
}

/**
 * Handle POST /api/chat and POST /api/ai-chat requests
 */
export async function chatHandler(req, res) {
    console.log(`[AI SERVER] POST ${req.path} received`);
    checkAndResetDailyUsage();

    // 1. Authenticate Request
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        console.log(`[AI SERVER] Response status: 401 (Missing/Invalid Bearer Header)`);
        const errRes = ResponseService.buildErrorResponse("Authentication required. Please log in to use VidyarthiAstra AI Assistant.", 401);
        return res.status(errRes.statusCode).json(errRes.payload);
    }

    const idToken = authHeader.split("Bearer ")[1];
    const claims = await verifyFirebaseIdToken(idToken);
    const uid = claims?.sub;

    if (!uid) {
        console.log(`[AI SERVER] Response status: 401 (Token Parsing Failed)`);
        const errRes = ResponseService.buildErrorResponse("Invalid or expired login session. Please log in again.", 401);
        return res.status(errRes.statusCode).json(errRes.payload);
    }

    // 2. Validate Message Body
    const { message, conversationHistory, activeQuestionContext } = req.body || {};
    if (!message || typeof message !== "string" || message.trim().length === 0) {
        console.log(`[AI SERVER] Response status: 400 (Empty Message)`);
        const errRes = ResponseService.buildErrorResponse("Please enter a question.", 400);
        return res.status(errRes.statusCode).json(errRes.payload);
    }

    const trimmedMessage = message.trim();
    const maxLen = parseInt(process.env.MAX_MESSAGE_LENGTH || "1000", 10);
    if (trimmedMessage.length > maxLen) {
        console.log(`[AI SERVER] Response status: 400 (Message Too Long)`);
        const errRes = ResponseService.buildErrorResponse(`Message is too long. Maximum allowed length is ${maxLen} characters.`, 400);
        return res.status(errRes.statusCode).json(errRes.payload);
    }

    // 3. Daily Rate Limit Check
    const dailyLimit = parseInt(process.env.DAILY_MESSAGE_LIMIT || "20", 10);
    const userCount = userDailyUsage.get(uid) || 0;
    if (userCount >= dailyLimit) {
        console.log(`[AI SERVER] Response status: 429 (Daily Limit Reached for UID: ${uid})`);
        const errRes = ResponseService.buildErrorResponse(`Daily limit of ${dailyLimit} messages reached for today. Please try again tomorrow!`, 429);
        return res.status(errRes.statusCode).json(errRes.payload);
    }

    // 4. Classify Intent & Decide Operating Mode
    const classification = IntentService.classifyIntent(trimmedMessage, conversationHistory, activeQuestionContext);
    console.log(`[AI SERVER] Detected intent: ${classification.intent} | Selected mode: ${classification.mode}`);

    // ============================================================
    // A. PAPER-SPECIFIC QUESTION FLOW
    // ============================================================
    if (classification.mode === "paper_question") {
        let targetContext = null;

        if (classification.isFollowUp && classification.activeQuestionContext) {
            targetContext = classification.activeQuestionContext;
        } else if (classification.paperMeta) {
            const searchRes = await PaperSearchService.findPaperAndQuestion(classification.paperMeta);
            
            if (searchRes.requiresClarification || searchRes.type === "AMBIGUOUS_PAPER" || searchRes.type === "MISSING_YEAR" || searchRes.type === "MISSING_EXAM") {
                userDailyUsage.set(uid, userCount + 1);
                return res.json({
                    success: true,
                    mode: "paper_question",
                    intent: "PAPER_CLARIFICATION",
                    answer: searchRes.message,
                    requiresClarification: true
                });
            }

            if (searchRes.type === "PAPER_NOT_FOUND") {
                userDailyUsage.set(uid, userCount + 1);
                return res.json({
                    success: true,
                    mode: "paper_question",
                    intent: "PAPER_NOT_FOUND",
                    answer: searchRes.message,
                    paperFound: false
                });
            }

            if (searchRes.type === "QUESTION_NOT_EXTRACTED") {
                userDailyUsage.set(uid, userCount + 1);
                return res.json({
                    success: true,
                    mode: "paper_question",
                    intent: "QUESTION_NOT_EXTRACTED",
                    answer: searchRes.message,
                    paperFound: true,
                    questionFound: false,
                    paperMeta: searchRes.paper
                });
            }

            if (searchRes.type === "SUCCESS" && searchRes.question) {
                targetContext = {
                    paper: searchRes.paper,
                    question: searchRes.question
                };
            }
        }

        if (targetContext && targetContext.question) {
            try {
                console.log(`[AI SERVER] Generating paper question solution for Q${targetContext.question.questionNumber}...`);
                const rawAiAnswer = await GroqService.generateResponse({
                    mode: "paper_question",
                    intent: classification.intent,
                    userMessage: trimmedMessage,
                    conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
                    paperContext: targetContext
                });

                userDailyUsage.set(uid, userCount + 1);

                return res.json({
                    success: true,
                    mode: "paper_question",
                    intent: "PAPER_QUESTION",
                    answer: rawAiAnswer,
                    paperMeta: targetContext.paper,
                    questionMeta: targetContext.question,
                    activeQuestionContext: targetContext
                });

            } catch (err) {
                console.error(`[AI SERVER Paper Exception]:`, err.message);
                const errRes = ResponseService.buildErrorResponse("Unable to solve paper question right now. Please try again shortly.", 500);
                return res.status(errRes.statusCode).json(errRes.payload);
            }
        }
    }

    // ============================================================
    // B. GENERAL STUDY / SEARCH FLOW
    // ============================================================
    let searchEvidence = null;
    let sources = [];

    if (classification.searchRequired) {
        const searchQuery = SearchService.buildSearchQuery(trimmedMessage);
        console.log(`[AI SERVER] Searching with query: "${searchQuery}"`);

        const searchResult = await SearchService.searchWeb(searchQuery, { num: 5 });

        if (searchResult.success && searchResult.results.length > 0) {
            sources = searchResult.results.slice(0, 4);
            searchEvidence = sources;
        }
    }

    try {
        console.log(`[AI SERVER] Calling Groq LLM for ${classification.mode} mode...`);
        const rawAiAnswer = await GroqService.generateResponse({
            mode: classification.mode,
            intent: classification.intent,
            userMessage: trimmedMessage,
            conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
            searchEvidence: searchEvidence
        });

        userDailyUsage.set(uid, userCount + 1);

        const responseData = ResponseService.buildResponse({
            mode: classification.mode,
            intent: classification.intent,
            rawText: rawAiAnswer,
            sources: sources,
            reasoning: classification.reasoning
        });

        return res.json(responseData);

    } catch (err) {
        console.error(`[AI SERVER Exception]:`, err.message);

        let safeMsg = "The AI service is temporarily unavailable. Please try again shortly.";
        let statusCode = 500;

        if (err.message.includes("rate limit")) {
            safeMsg = "AI service rate limit reached. Please wait a moment and try again.";
            statusCode = 429;
        } else if (err.message.includes("timed out")) {
            safeMsg = "Request timed out waiting for AI response. Please try again.";
            statusCode = 504;
        } else if (err.message.includes("API Key")) {
            safeMsg = "AI service is unconfigured. Please verify GROQ_API_KEY / AI_API_KEY in backend .env file.";
            statusCode = 503;
        }

        const errRes = ResponseService.buildErrorResponse(safeMsg, statusCode);
        return res.status(errRes.statusCode).json(errRes.payload);
    }
}
