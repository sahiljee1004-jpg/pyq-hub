import { PaperSearchService } from "./paperSearchService.js";

/**
 * Intent Classification and Mode Routing Service for VidyarthiVerse AI Assistant
 */
export class IntentService {

    /**
     * Classify user message intent and return mode, primary intent, and paper metadata if applicable
     */
    static classifyIntent(userMessage, conversationHistory = [], activeQuestionContext = null) {
        const text = (userMessage || "").trim();
        const lower = text.toLowerCase();

        // 1. Try Parsing Paper Specific Query
        const paperMeta = PaperSearchService.parsePaperQuery(text);

        // Explicit Paper Query Signals:
        // Contains question number (Q13, question 25) OR explicit paper solving phrases
        const hasExplicitPaperSignals = paperMeta && (
            Boolean(paperMeta.questionNumber && (paperMeta.examQuery || paperMeta.year || paperMeta.shift)) ||
            /\b(?:solve\s+question|explain\s+q\d+|solution\s+of\s+q\d+|option\s+[a-d]\s+in\s+question)\b/i.test(lower)
        );

        // 2. Check for Conversational Follow-Up on Previously Retrieved Active Question
        const hasActiveContext = activeQuestionContext && (activeQuestionContext.questionNumber || (activeQuestionContext.question && activeQuestionContext.question.questionNumber));
        const isFollowUp = Boolean(hasActiveContext) && (
            /\b(?:option\s+[a-d]|why\s+is\s+option|explain\s+(?:the\s+)?calculation|step\s+\d+|wrong|incorrect|correct|solve\s+again|explain\s+again)\b/i.test(lower) ||
            (/^\s*(why|how|explain|can you|what about)\b/i.test(lower) && !paperMeta?.questionNumber)
        );

        if (hasExplicitPaperSignals || isFollowUp) {
            return {
                mode: "paper_question",
                intent: "PAPER_QUESTION",
                searchRequired: false,
                isFollowUp: Boolean(isFollowUp && !hasExplicitPaperSignals),
                paperMeta: hasExplicitPaperSignals ? paperMeta : null,
                activeQuestionContext: isFollowUp ? activeQuestionContext : null,
                reasoning: isFollowUp && !hasExplicitPaperSignals
                    ? "User follow-up question referring to active question context."
                    : "Explicit paper-specific question identified."
            };
        }

        // 3. Factual Search / Web News Signals (e.g. latest exam dates, notifications, cutoff news)
        const hasTimeKeywords = /\b(2026|2027|latest|current|today|recently|new|present|this year|upcoming)\b/i.test(lower);
        const hasFactualKeywords = /\b(cutoff|cut off|closing rank|opening rank|pass percentage|percentile|exam date|registration date|result date|counseling|counselling|fees|fee structure|nirf ranking|ranking|seat matrix|director|qualifying marks)\b/i.test(lower);
        const hasOfficialKeywords = /\b(official|nta|josaa|iit|gate 2026|jee main 2026|jee advanced 2026|notification|circular|bulletin)\b/i.test(lower);

        if (hasOfficialKeywords || (hasFactualKeywords && hasTimeKeywords)) {
            return {
                mode: "search",
                intent: "OFFICIAL_INFORMATION",
                searchRequired: true,
                reasoning: "Requires time-sensitive web search for official exam updates."
            };
        }

        // 4. General Study Questions (Default Tutor Mode)
        return {
            mode: "tutor",
            intent: "GENERAL_STUDY",
            searchRequired: false,
            reasoning: "General academic, study planning, or conceptual question."
        };
    }
}
